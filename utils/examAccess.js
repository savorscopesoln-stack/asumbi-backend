const sql = require("mssql");

/* =========================================================================
   E-ASSESSMENT TRAINEE ACCESS + OPEN/CLOSE WINDOW

   Rules (checked server-side, in this order):
     1. The student's account must be active (Students.status = 'active';
        a blank status counts as active so legacy rows aren't locked out).
     2. If the assessment is restricted (restrict_students = 1), the student
        must be in e_assessment_allowed_students. Default (0) = every active
        student in the assessment's class / year of study may sit it.
     3. If available_from / available_until are set, "now" must be inside
        the window.

   TIMEZONE: same convention as the main-exam scheduler (utils/examScheduler.js).
   The admin types East Africa Time wall-clock digits; they are stored as a
   "labelled UTC" DATETIME, and "now" is relabelled the same way in Node
   (never GETDATE(), whose timezone depends on the DB server).
========================================================================= */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const nowAsSchoolWallClock = () => new Date(Date.now() + EAT_OFFSET_MS);

// "2026-10-14T09:00" (bare, as typed) -> Date whose UTC digits are those digits.
const toWallClock = (v) => {
  if (!v) return null;
  const s = String(v);
  const isBare = s.includes("T") && !/Z$|[+-]\d\d:\d\d$/.test(s);
  const d = new Date(isBare ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const fmtWall = (d) =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (EAT)`;

const isActiveStudent = (status) => {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "" || s === "active";
};

// Pure decision function (unit-tested). `row` = { student_status,
// restrict_students, is_allowed, available_from, available_until }.
function evaluateAccess(row, now = nowAsSchoolWallClock()) {
  if (!isActiveStudent(row.student_status)) {
    return { allowed: false, code: "STUDENT_INACTIVE", message: "Your account isn't active, so you can't take this assessment. Please contact the school office." };
  }
  if (row.is_deactivated) {
    return { allowed: false, code: "DEACTIVATED", message: "Your e-assessment access has been deactivated. Please contact your teacher or the school office." };
  }
  if (row.restrict_students && !row.is_allowed) {
    return { allowed: false, code: "NOT_ALLOWED", message: "You haven't been permitted to sit this assessment. If you think this is a mistake, please contact your teacher or the school office." };
  }
  const from = row.available_from ? new Date(row.available_from) : null;
  const until = row.available_until ? new Date(row.available_until) : null;
  if (from && !Number.isNaN(from.getTime()) && now < from) {
    return { allowed: false, code: "NOT_OPEN_YET", message: `This assessment opens on ${fmtWall(from)}.` };
  }
  if (until && !Number.isNaN(until.getTime()) && now >= until) {
    return { allowed: false, code: "CLOSED", message: `This assessment closed on ${fmtWall(until)}.` };
  }
  return { allowed: true };
}

// DB-backed check. skipWindow: a student already mid-exam keeps their own
// timer even if the closing time passes (same rule as the main-exam scheduler).
async function checkStudentAccess(pool, assessmentId, studentId, { skipWindow = false } = {}) {
  let r;
  try {
    r = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`
        SELECT ISNULL(ea.restrict_students, 0) AS restrict_students,
               ea.available_from, ea.available_until, st.status AS student_status,
               CASE WHEN EXISTS (
                 SELECT 1 FROM e_assessment_allowed_students al
                 WHERE al.e_assessment_id = ea.id AND al.student_id = st.id
               ) THEN 1 ELSE 0 END AS is_allowed,
               CASE WHEN EXISTS (
                 SELECT 1 FROM e_assessment_blocked_students dz
                 WHERE dz.student_id = st.id
               ) THEN 1 ELSE 0 END AS is_deactivated
        FROM e_assessments ea
        INNER JOIN Students st ON st.id = @sid
        WHERE ea.id = @aid
      `);
  } catch (err) {
    // 207/208 = column/table missing: schema not migrated yet -> don't lock everyone out.
    if (err && (err.number === 207 || err.number === 208)) {
      console.warn("examAccess: access columns not migrated yet, allowing:", err.message);
      return { allowed: true };
    }
    throw err;
  }
  const row = r.recordset[0];
  if (!row) return { allowed: true }; // unknown student/assessment: other checks report it
  return evaluateAccess(skipWindow ? { ...row, available_from: null, available_until: null } : row);
}

// Active students who may sit this assessment (class/year match + restriction).
async function getPermittedStudents(pool, assessmentId) {
  const r = await pool.request().input("aid", sql.Int, assessmentId).query(`
    SELECT st.id, st.name, st.username, st.studentClass
    FROM e_assessments ea
    INNER JOIN Students st ON (
         st.studentClass IN (SELECT c.name FROM Classes c WHERE c.id = ea.class_id)
      OR (ea.year_of_study IS NOT NULL AND st.yearOfStudy = ea.year_of_study)
    )
    WHERE ea.id = @aid
      AND (st.status IS NULL OR LTRIM(RTRIM(st.status)) = '' OR LOWER(st.status) = 'active')
      AND (ISNULL(ea.restrict_students, 0) = 0
           OR EXISTS (SELECT 1 FROM e_assessment_allowed_students al
                      WHERE al.e_assessment_id = ea.id AND al.student_id = st.id))
      AND NOT EXISTS (SELECT 1 FROM e_assessment_blocked_students dz
                      WHERE dz.student_id = st.id)
    ORDER BY st.name
  `);
  return r.recordset || [];
}

const LINKED_TO_MAIN_EXAM = `
  EXISTS (SELECT 1 FROM exam_subject_sessions ess
          WHERE ess.e_assessment_id = e_assessments.id AND ess.status <> 'draft')`;

// Scheduler tick (called from utils/examScheduler.js): opens an approved
// assessment when available_from arrives and closes it at available_until.
// Edge-triggered via schedule_opened_at / schedule_closed_at so a manual
// Stop/Start is never overridden. Assessments owned by a Main Examination
// schedule are skipped (that scheduler owns their active_status).
async function applyScheduledOpenClose(pool, tenantKey, notify) {
  const now = nowAsSchoolWallClock();

  const opened = await pool.request().input("now", sql.DateTime, now).query(`
    UPDATE e_assessments
    SET active_status = 'Active', schedule_opened_at = @now,
        started_at = DATEADD(SECOND, DATEDIFF(SECOND, @now, available_from), GETDATE())
    OUTPUT INSERTED.id, INSERTED.title
    WHERE available_from IS NOT NULL AND available_from <= @now
      AND (available_until IS NULL OR available_until > @now)
      AND schedule_opened_at IS NULL
      AND status = 'approved'
      AND NOT ${LINKED_TO_MAIN_EXAM}
  `);
  for (const row of opened.recordset || []) {
    console.log(`🟢 E-assessment #${row.id} (${row.title}) auto-opened (tenant "${tenantKey}")`);
    if (notify) {
      try {
        const students = await getPermittedStudents(pool, row.id);
        await notify(pool, students.map((s) => ({ id: s.id, source: "Students" })), {
          title: "Assessment Now Open",
          message: `"${row.title}" is now open — you can take it from your E-Assessments page.`,
          type: "exam",
        });
      } catch (e) {
        console.error(`⚠️ Open notification failed for e-assessment #${row.id}:`, e.message);
      }
    }
  }

  const closed = await pool.request().input("now", sql.DateTime, now).query(`
    UPDATE e_assessments
    SET active_status = 'Inactive', schedule_closed_at = @now
    OUTPUT INSERTED.id, INSERTED.title
    WHERE available_until IS NOT NULL AND available_until <= @now
      AND schedule_closed_at IS NULL
      AND NOT ${LINKED_TO_MAIN_EXAM}
  `);
  for (const row of closed.recordset || []) {
    console.log(`🔴 E-assessment #${row.id} (${row.title}) auto-closed (tenant "${tenantKey}")`);
  }
}

module.exports = {
  nowAsSchoolWallClock, toWallClock, fmtWall, isActiveStudent,
  evaluateAccess, checkStudentAccess, getPermittedStudents, applyScheduledOpenClose,
};
