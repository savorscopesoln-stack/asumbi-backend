const sql = require("mssql");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const { PDFDocument } = require("pdf-lib");
const { notifyUsers, notifyOne } = require("../utils/notify");
const { withTransientRetry, isTransientDbError } = require("../utils/transientDbRetry");
const { coverPageUrlFor, deleteCoverPageByUrl } = require("../middleware/coverPageUpload");
const { QUESTION_IMAGES_DIR, questionImageUrlFor, deleteQuestionImageByUrl } = require("../middleware/questionImageUpload");
const { saveViolationPhoto, violationPhotoUrlFor } = require("../middleware/violationPhotoUpload");
const { getPool, listTenantKeys } = require("../config/db");
const { persistAttempt, FINALIZE_GRACE_MINUTES } = require("../utils/examAttempts");
const { clockStartSql, secondsLeftSql } = require("../utils/examClock");
const { queryActivityLog } = require("../utils/eAssessmentActivityLog");
const { generateAttendancePdf } = require("../utils/eAssessmentAttendance");
const assignmentEngine = require("../utils/assignmentEngine");

/* A teacher may open a submission when it was assigned to them as a whole OR
   when some of its answered questions were allocated to them (the
   "more teachers than submissions" split — utils/assignmentEngine.js).
   Alias `s` = e_assessment_submissions, parameter @teacherId. */
const TEACHER_SUB_ACCESS = `(
  EXISTS (SELECT 1 FROM e_assessment_submission_assignments aa WHERE aa.submission_id = s.id AND aa.teacher_id = @teacherId)
  OR EXISTS (SELECT 1 FROM e_assessment_answer_assignments ax0 INNER JOIN e_assessment_answers an0 ON an0.id = ax0.answer_id
             WHERE an0.submission_id = s.id AND ax0.teacher_id = @teacherId))`;
/* Which answers of such a submission the teacher sees: the ones allocated to
   them; essay answers nobody was allocated stay with a whole-submission
   assignee; auto-marked (non-essay) answers are always visible for context.
   Aliases: a = answers, q = questions, ax = answer assignment (LEFT JOIN). */
const TEACHER_ANSWER_VISIBLE = `(
  ax.teacher_id = @teacherId
  OR (ax.id IS NULL AND (
        ISNULL(q.question_type, 'mcq') NOT IN ('essay', 'descriptive')
        OR EXISTS (SELECT 1 FROM e_assessment_submission_assignments aa2 WHERE aa2.submission_id = a.submission_id AND aa2.teacher_id = @teacherId))))`;

/* ACTIVE vs UPCOMING (what a student sees on their list).
   Active   = Start/Stop switch is on.
   Upcoming = not active yet, but an opening time (available_from) is scheduled
              and the scheduler hasn't opened or closed it yet.
   Upcoming exams are listed but can't be entered: examLogin still requires
   active_status = 'Active'. Alias `ea` = e_assessments. */
const SQL_IS_ACTIVE = `(ea.active_status = 'Active')`;
const SQL_IS_UPCOMING = `(ISNULL(ea.active_status, 'Inactive') <> 'Active'
  AND ea.available_from IS NOT NULL
  AND ea.schedule_opened_at IS NULL
  AND ea.schedule_closed_at IS NULL)`;
const SQL_ACTIVE_OR_UPCOMING = `(${SQL_IS_ACTIVE} OR ${SQL_IS_UPCOMING})`;
const SQL_SCHEDULE_STATE = `CASE WHEN ${SQL_IS_ACTIVE} THEN 'active' WHEN ${SQL_IS_UPCOMING} THEN 'upcoming' ELSE 'closed' END`;

// A student with an admin-granted resit / replay that hasn't been started yet.
// Such a student may enter even though the paper is closed (Inactive, or outside
// its open/close window) — that is the whole point of a replay.
const hasPendingResit = async (pool, assessmentId, studentId) => {
  try {
    const r = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`SELECT 1 AS ok FROM e_assessment_exam_sessions
              WHERE e_assessment_id = @aid AND student_id = @sid AND resit_allowed = 1 AND status = 'issued'`);
    return r.recordset.length > 0;
  } catch (e) {
    if (e && (e.number === 207 || e.number === 208)) return false; // resit columns not migrated
    throw e;
  }
};

// History must never break the real action it describes.
const safeRecord = async (pool, args) => { try { return await assignmentEngine.recordBatch(pool, args); } catch (e) { console.error("ASSIGNMENT HISTORY ERROR:", e.message); return null; } };
const { sendPdfBuffer } = require("../utils/reportExport");
const { checkSeb, sendSebBlocked, parseKeys: parseSebKeys, invalidateSebCache } = require("../utils/sebRestriction");
const { checkStudentAccess, getPermittedStudents, toWallClock, isActiveStudent } = require("../utils/examAccess");
const { checkDesktopOnly, sendBlocked, invalidateDesktopOnlyCache, invalidateDeviceAccessCache } = require("../utils/deviceRestriction");

/* =========================================================================
   HELPERS
========================================================================= */
const toInt = (v) => {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
};

// Used only by examLogin (see section on load-test hardening): turns a
// transient DB/pool error — the pool was momentarily saturated and
// withTransientRetry's one retry didn't clear it — into a controlled,
// diagnosable 503 instead of a generic 500. This is the "pool
// temporarily busy → client can retry shortly" behavior, as opposed to
// the connection-reset-style failures seen under the original 900-VU
// login burst. Any non-transient error still falls through to the
// normal 500 handler below.
function respondDbBusy(res, err) {
  if (isTransientDbError(err)) {
    console.error("⚠️ EXAM LOGIN — DB pool busy:", err.message);
    res.set("Retry-After", "2");
    return res.status(503).json({
      success: false,
      code: "DB_BUSY",
      message: "The system is under heavy load right now. Please try again in a few seconds.",
    });
  }
  console.error("EXAM LOGIN ERROR:", err);
  return res.status(500).json({ success: false, message: "Server error" });
}

// 6-char token, uppercase letters + digits, ambiguous chars (0,O,1,I) removed
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const generateToken = () => {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
};

/* =========================================================================
   CORE ASSESSMENT CRUD
========================================================================= */
const createEAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const { title, subject, class_id, year_of_study, duration_minutes, instructions, total_marks, exam_password, questions_deadline, question_setter_teacher_ids } = req.body;
    const teacher_id = req.user?.id || null;
    // A paper whose subject is Music is identified automatically; the teacher
    // can still send music_paper explicitly (true/false) to override it.
    const musicPaper = typeof req.body.music_paper === "boolean" ? req.body.music_paper : /music/i.test(String(subject || ""));

    if (!title || !subject || !class_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const yearOfStudyVal = toInt(year_of_study) || null;

    const result = await pool.request()
      .input("title", sql.NVarChar, title)
      .input("subject", sql.NVarChar, subject)
      .input("class_id", sql.Int, class_id)
      .input("year_of_study", sql.Int, yearOfStudyVal)
      .input("teacher_id", sql.Int, teacher_id)
      .input("duration_minutes", sql.Int, duration_minutes || 30)
      .input("total_marks", sql.Int, total_marks || 100)
      .input("instructions", sql.NVarChar, instructions || "")
      .input("exam_password", sql.NVarChar, (exam_password || "").trim() || null)
      .input("questions_deadline", sql.DateTime, questions_deadline ? new Date(questions_deadline) : null)
      .input("music_paper", sql.Bit, musicPaper ? 1 : 0)
      .query(`
        INSERT INTO e_assessments
          (title, subject, class_id, year_of_study, teacher_id, duration_minutes, total_marks, instructions, status, active_status, exam_password, questions_deadline, music_paper)
        OUTPUT INSERTED.id
        VALUES
          (@title, @subject, @class_id, @year_of_study, @teacher_id, @duration_minutes, @total_marks, @instructions, 'pending', 'Inactive', @exam_password, @questions_deadline, @music_paper)
      `);
    // active_status starts explicitly 'Inactive' (never left NULL) so the
    // admin's Start/Stop button and the isActive check on the frontend
    // (a.active_status === "Active") always agree on a freshly-created
    // assessment's state — previously this was left NULL, which the
    // frontend read as "active" but the toggle endpoint read as
    // "inactive", so the very first click looked like it did nothing.

    const assessmentId = result.recordset[0].id;

    if (Array.isArray(question_setter_teacher_ids)) {
      for (const tId of question_setter_teacher_ids) {
        const tid = toInt(tId);
        if (!tid) continue;
        await pool.request()
          .input("e_assessment_id", sql.Int, assessmentId)
          .input("teacher_id", sql.Int, tid)
          .query(`
            INSERT INTO e_assessment_question_setters (e_assessment_id, teacher_id)
            VALUES (@e_assessment_id, @teacher_id)
          `);
      }
    }

    res.status(201).json({ success: true, assessment_id: assessmentId });
  } catch (err) {
    console.error("CREATE E-ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Create assessment failed" });
  }
};
const updateEAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { title, subject, class_id, year_of_study, duration_minutes, instructions, total_marks, exam_password, questions_deadline, question_setter_teacher_ids } = req.body;

    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    if (!title || !subject || !class_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const yearOfStudyVal = toInt(year_of_study) || null;

    const existing = await pool.request().input("id", sql.Int, id)
      .query(`SELECT id FROM e_assessments WHERE id = @id`);
    if (!existing.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    await pool.request()
      .input("id", sql.Int, id)
      .input("title", sql.NVarChar, title)
      .input("subject", sql.NVarChar, subject)
      .input("class_id", sql.Int, class_id)
      .input("year_of_study", sql.Int, yearOfStudyVal)
      .input("duration_minutes", sql.Int, duration_minutes || 30)
      .input("total_marks", sql.Int, total_marks || 100)
      .input("instructions", sql.NVarChar, instructions || "")
      .input("exam_password", sql.NVarChar, (exam_password || "").trim() || null)
      .input("questions_deadline", sql.DateTime, questions_deadline ? new Date(questions_deadline) : null)
      .query(`
        UPDATE e_assessments
        SET title = @title,
            subject = @subject,
            class_id = @class_id,
            year_of_study = @year_of_study,
            duration_minutes = @duration_minutes,
            total_marks = @total_marks,
            instructions = @instructions,
            exam_password = @exam_password,
            questions_deadline = @questions_deadline
        WHERE id = @id
      `);

    // Only touch the music-paper flag when the caller explicitly sent it.
    if (typeof req.body.music_paper === "boolean") {
      await pool.request()
        .input("id", sql.Int, id)
        .input("v", sql.Bit, req.body.music_paper ? 1 : 0)
        .query(`UPDATE e_assessments SET music_paper = @v WHERE id = @id`);
    }

    // Only touch the setter list when the caller explicitly sent one —
    // an array (including empty, to clear it) replaces the list; omitting
    // the field entirely leaves the existing assignments untouched.
    if (Array.isArray(question_setter_teacher_ids)) {
      await pool.request().input("id", sql.Int, id)
        .query(`DELETE FROM e_assessment_question_setters WHERE e_assessment_id = @id`);
      for (const tId of question_setter_teacher_ids) {
        const tid = toInt(tId);
        if (!tid) continue;
        await pool.request()
          .input("e_assessment_id", sql.Int, id)
          .input("teacher_id", sql.Int, tid)
          .query(`
            INSERT INTO e_assessment_question_setters (e_assessment_id, teacher_id)
            VALUES (@e_assessment_id, @teacher_id)
          `);
      }
    }

    res.json({ success: true, message: "Assessment updated successfully" });
  } catch (err) {
    console.error("UPDATE E-ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Update failed", error: err.message });
  }
};

/* =========================================================================
   COVER PAGE (per-exam PDF)
   ─────────────────────────
   Each assessment can carry its own cover page — shown to students
   before they start that specific exam (see TakeEAssessment.jsx's
   "reveal" screen). Uploaded/replaced/removed independently of the
   title/subject/etc. fields above since it's a file, not a form field.
========================================================================= */
const uploadCoverPage = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    if (!req.file) return res.status(400).json({ message: "No PDF uploaded" });

    const permission = await canManageAssessmentQuestions(pool, req, id);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    const existing = await pool.request().input("id", sql.Int, id)
      .query(`SELECT cover_page_url FROM e_assessments WHERE id = @id`);
    if (!existing.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    const newUrl = coverPageUrlFor(req.file.filename);

    // Read page 1's own size (points) straight off the uploaded PDF so the
    // student-facing preview can be sized to this exact cover page's shape
    // instead of a fixed generic box — see cover_page_width/height in
    // ensureSchema.js. Best-effort: a malformed/unreadable PDF still saves
    // fine, it just falls back to the frontend's default A4 ratio.
    let pageWidth = null;
    let pageHeight = null;
    try {
      const pdfDoc = await PDFDocument.load(fs.readFileSync(req.file.path));
      const firstPage = pdfDoc.getPage(0);
      const size = firstPage.getSize();
      pageWidth = size.width;
      pageHeight = size.height;
    } catch (dimErr) {
      console.error("COVER PAGE DIMENSION READ ERROR:", dimErr.message);
    }

    await pool.request()
      .input("id", sql.Int, id)
      .input("cover_page_url", sql.NVarChar(500), newUrl)
      .input("cover_page_width", sql.Float, pageWidth)
      .input("cover_page_height", sql.Float, pageHeight)
      .query(`
        UPDATE e_assessments
        SET cover_page_url = @cover_page_url,
            cover_page_width = @cover_page_width,
            cover_page_height = @cover_page_height
        WHERE id = @id
      `);

    // Replacing an existing cover page — clean up the old file now that
    // the DB row points at the new one.
    const oldUrl = existing.recordset[0].cover_page_url;
    if (oldUrl && oldUrl !== newUrl) deleteCoverPageByUrl(oldUrl);

    res.json({ success: true, cover_page_url: newUrl, cover_page_width: pageWidth, cover_page_height: pageHeight });
  } catch (err) {
    console.error("UPLOAD COVER PAGE ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Cover page upload failed" });
  }
};

const deleteCoverPage = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });

    const permission = await canManageAssessmentQuestions(pool, req, id);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    const existing = await pool.request().input("id", sql.Int, id)
      .query(`SELECT cover_page_url FROM e_assessments WHERE id = @id`);
    if (!existing.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    await pool.request().input("id", sql.Int, id)
      .query(`
        UPDATE e_assessments
        SET cover_page_url = NULL, cover_page_width = NULL, cover_page_height = NULL
        WHERE id = @id
      `);

    const oldUrl = existing.recordset[0].cover_page_url;
    if (oldUrl) deleteCoverPageByUrl(oldUrl);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE COVER PAGE ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Cover page removal failed" });
  }
};

// Students (including exam-only sessions) never receive exam_password or
// correct_answer in a payload — only admin/teacher accounts managing the
// assessment need to see either of those.
const STAFF_ROLES = ["admin", "sub_admin", "sub_admin_2", "module_admin", "teacher"];
const redactForRole = (row, role) => {
  if (STAFF_ROLES.includes(role)) return row;
  const { exam_password, seb_keys, ...rest } = row; // never send secrets to students
  return rest;
};

const getEAssessments = async (req, res) => {
  try {
    const pool = req.pool;

    // A teacher must see: (a) assessments THEY created/own
    // (e_assessments.teacher_id, set from req.user.id in createEAssessment),
    // (b) assessments they didn't create but where an admin (or another
    // teacher) has assigned them one or more submissions to mark, via
    // e_assessment_submission_assignments, AND (c) assessments where the
    // admin picked them as a permitted question-setter (e_assessment_
    // question_setters) — this is the case that matters BEFORE any
    // submissions exist yet, since a teacher can't be assigned a
    // submission for an exam nobody has taken. Without (b)/(c) a teacher
    // who isn't the creator has no way to ever find the assessment.
    // Admin and sub_admin still see everything (needed for review/
    // approval). A student sees only assessments that actually target
    // them: either their own class directly (ea.class_id, matched via
    // Classes.name = Students.studentClass — the same name-matching
    // already used for the "assessment now open" notification), or a
    // whole-year assessment (ea.year_of_study matching their own
    // Students.yearOfStudy — see the ClassMultiSelect/year-of-study
    // work on the admin side) — AND only ones that are currently Active
    // (ea.active_status = 'Active') or UPCOMING (scheduled to open later,
    // see SQL_IS_UPCOMING; listed but not enterable). Approval status no
    // longer decides what a student sees; the Start/Stop toggle and the
    // schedule do.
    const isTeacher = req.user?.role === "teacher";
    const isStudent = req.user?.role === "student";

    const request = pool.request();
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));
    if (isStudent) request.input("studentId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT ea.*, t.name AS teacher_name, c.name AS class_name,
        ${isTeacher ? "CASE WHEN ea.teacher_id = @teacherId THEN 0 ELSE 1 END" : "0"} AS assigned_only,
        (SELECT COUNT(*) FROM e_assessment_questions eq WHERE eq.e_assessment_id = ea.id) AS question_count,
        (SELECT COUNT(*) FROM e_assessment_submissions es WHERE es.e_assessment_id = ea.id) AS submission_count,
        (SELECT COUNT(*) FROM e_assessment_allowed_students al2 WHERE al2.e_assessment_id = ea.id) AS allowed_count
        ${isStudent ? `,
        sub.id AS my_submission_id, sub.status AS my_submission_status,
        sub.score AS my_score, sub.submitted_at AS my_submitted_at,
        ISNULL(mysess.resit_allowed, 0) AS my_resit_allowed,
        ISNULL(mysess.attempt_no, 1) AS my_attempt_no` : ""}
        ,${SQL_SCHEDULE_STATE} AS schedule_state
      FROM e_assessments ea
      LEFT JOIN Teachers t ON ea.teacher_id = t.id
      LEFT JOIN Classes c ON ea.class_id = c.id
      ${isStudent ? `
      LEFT JOIN e_assessment_submissions sub
        ON sub.e_assessment_id = ea.id AND sub.student_id = @studentId
      LEFT JOIN e_assessment_exam_sessions mysess
        ON mysess.e_assessment_id = ea.id AND mysess.student_id = @studentId` : ""}
      ${isTeacher ? `
      WHERE ea.teacher_id = @teacherId
         OR EXISTS (
              SELECT 1
              FROM e_assessment_submissions s
              INNER JOIN e_assessment_submission_assignments aa
                ON aa.submission_id = s.id AND aa.teacher_id = @teacherId
              WHERE s.e_assessment_id = ea.id
            )
         OR EXISTS (
              SELECT 1 FROM e_assessment_answer_assignments axl
              WHERE axl.e_assessment_id = ea.id AND axl.teacher_id = @teacherId
            )
         OR EXISTS (
              SELECT 1 FROM e_assessment_question_setters qs
              WHERE qs.e_assessment_id = ea.id AND qs.teacher_id = @teacherId
            )` : isStudent ? `
      WHERE (
              ea.class_id IN (
                SELECT c2.id FROM Classes c2
                JOIN Students st ON st.studentClass = c2.name
                WHERE st.id = @studentId
              )
              OR ea.year_of_study = (SELECT yearOfStudy FROM Students WHERE id = @studentId)
            )
        AND (${SQL_ACTIVE_OR_UPCOMING}
             OR (ISNULL(mysess.resit_allowed, 0) = 1 AND mysess.status = 'issued'))
        AND (ISNULL(ea.restrict_students, 0) = 0
             OR EXISTS (SELECT 1 FROM e_assessment_allowed_students al
                        WHERE al.e_assessment_id = ea.id AND al.student_id = @studentId))
        AND NOT EXISTS (SELECT 1 FROM e_assessment_blocked_students dz
                        WHERE dz.student_id = @studentId)` : ""}
      ORDER BY ${isStudent ? `CASE WHEN ${SQL_IS_ACTIVE} THEN 0 ELSE 1 END, ea.available_from ASC, ` : ""}ea.id DESC
    `);
    const rows = (result.recordset || []).map((r) => redactForRole(r, req.user?.role));

    // Attach each assessment's permitted question-setter teacher ids
    // (admin/sub_admin only need this — it's what pre-fills the "Teachers
    // allowed to add questions" picker when they reopen Edit) — plus their
    // names, so the assessment card's "Teacher" row can show who's actually
    // assigned to add questions instead of always reading "Not assigned"
    // (ea.teacher_id, which teacher_name above comes from, is the exam's
    // *owner/creator* and is usually blank for an admin-created assessment
    // — a completely separate thing from who was picked as a question setter).
    if (rows.length && ["admin", "sub_admin", "sub_admin_2", "module_admin"].includes(req.user?.role)) {
      const setterResult = await pool.request().query(`
        SELECT qs.e_assessment_id, qs.teacher_id, t.name AS teacher_name
        FROM e_assessment_question_setters qs
        LEFT JOIN Teachers t ON t.id = qs.teacher_id
      `);
      const idsByAssessment = {};
      const namesByAssessment = {};
      for (const s of setterResult.recordset || []) {
        (idsByAssessment[s.e_assessment_id] ||= []).push(s.teacher_id);
        (namesByAssessment[s.e_assessment_id] ||= []).push(s.teacher_name || `Teacher #${s.teacher_id}`);
      }
      for (const r of rows) {
        r.question_setter_teacher_ids = idsByAssessment[r.id] || [];
        r.question_setter_names = namesByAssessment[r.id] || [];
      }
    }

    res.json(rows);
  } catch (err) {
    console.error("GET ASSESSMENTS ERROR:", err);
    res.status(500).json([]);
  }
};

// Public (no-auth) list for the /take-assessment picker. Returns
// { active: [...], upcoming: [...] }. Every currently Active or Upcoming
// assessment is listed (cover page optional). Times are sent as "seconds
// from now", computed by the database, so the browser's timezone never
// matters. No questions, passwords or other sensitive fields are returned.
const getPublicAssessmentCovers = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT TOP 100 ea.id, ea.title, ea.subject, ea.duration_minutes,
        ea.cover_page_url, ea.cover_page_width, ea.cover_page_height,
        CONVERT(VARCHAR(16), ea.available_from, 126) AS start_label,
        CASE WHEN ea.available_from  IS NULL THEN NULL
             ELSE DATEDIFF(SECOND, GETDATE(), ea.available_from)  END AS seconds_until_start,
        CASE WHEN ea.available_until IS NULL THEN NULL
             ELSE DATEDIFF(SECOND, GETDATE(), ea.available_until) END AS seconds_until_end,
        ${SQL_SCHEDULE_STATE} AS schedule_state
      FROM e_assessments ea
      WHERE ${SQL_ACTIVE_OR_UPCOMING}
      ORDER BY CASE WHEN ${SQL_IS_ACTIVE} THEN 0 ELSE 1 END, ea.available_from ASC, ea.id DESC
    `);
    const rows = result.recordset || [];
    res.json({
      active: rows.filter((r) => r.schedule_state === "active"),
      upcoming: rows.filter((r) => r.schedule_state === "upcoming"),
    });
  } catch (err) {
    console.error("GET PUBLIC ASSESSMENT COVERS ERROR:", err);
    res.status(500).json({ active: [], upcoming: [], message: "Failed to load assessments" });
  }
};

const getEAssessmentById = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);

    // A student may only ever fetch an assessment's content through the
    // exam-only session created by /e-assessments/exam-login (username +
    // this assessment's admin-set exam password) — and only for the exact
    // assessment that token was scoped to. A regular, otherwise-valid
    // student-portal login session is deliberately NOT enough on its own;
    // this is what stops a student who is simply logged into the portal
    // from opening someone else's — or even their own — exam without the
    // exam password.
    if (req.user?.role === "student") {
      if (!req.user.examOnly || req.user.examAssessmentId !== assessmentId) {
        return res.status(403).json({ message: "You must sign in with your username and this assessment's exam password to view it." });
      }
    }

    const assessmentResult = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT ea.*, c.name AS class_name, t.name AS teacher_name
        FROM e_assessments ea
        LEFT JOIN Classes  c ON ea.class_id   = c.id
        LEFT JOIN Teachers t ON ea.teacher_id = t.id
        WHERE ea.id = @id
      `);

    if (!assessmentResult.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }
    const assessment = redactForRole(assessmentResult.recordset[0], req.user?.role);

    // A student taking the exam gets their TRUE remaining time here,
    // computed server-side from when their session was first activated
    // — not the assessment's nominal duration. Without this, the
    // frontend's countdown has no way to know how much time has
    // already elapsed, and (see TakeEAssessment.jsx's enterActive())
    // would reset to the full duration on every refresh or resume —
    // letting a student reset their exam clock indefinitely just by
    // reloading the page or getting locked/unlocked.
    let remaining_seconds = null;
    if (req.user?.role === "student" && req.user.examOnly && req.user.examAssessmentId === assessmentId) {
      const totalSeconds = (assessment.duration_minutes || 30) * 60;
      // Time left on the DB clock, anchored to when the PAPER started (not
      // when this student logged in) — see utils/examClock.js.
      const sessionResult = await pool.request()
        .input("aid", sql.Int, assessmentId)
        .input("sid", sql.Int, req.user.id)
        .query(`
          SELECT ${secondsLeftSql("a", "es")} AS seconds_left
          FROM e_assessment_exam_sessions es
          INNER JOIN e_assessments a ON a.id = es.e_assessment_id
          WHERE es.e_assessment_id = @aid AND es.student_id = @sid AND es.activated_at IS NOT NULL
        `);
      const left = sessionResult.recordset[0]?.seconds_left;
      // Not activated yet (shouldn't normally happen — this endpoint is only
      // called after activation) — fall back to full duration.
      remaining_seconds = left == null ? totalSeconds : Math.max(0, Number(left));
    }

    const questionResult = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT q.id AS question_id, q.question_text, q.marks, q.correct_answer,
               q.question_type, o.option_label, o.option_text
        FROM e_assessment_questions q
        LEFT JOIN e_assessment_options o ON q.id = o.question_id
        WHERE q.e_assessment_id = @id
        ORDER BY q.id, o.option_label
      `);

    // Diagrams/photos attached to each question — fetched as a separate
    // query (like options above, joining it in directly would multiply
    // rows against the options join) and merged into the map below.
    const imageResult = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT qi.question_id, qi.id, qi.image_url
        FROM e_assessment_question_images qi
        INNER JOIN e_assessment_questions q ON q.id = qi.question_id
        WHERE q.e_assessment_id = @id
        ORDER BY qi.question_id, qi.sort_order, qi.id
      `);
    const imagesByQuestion = {};
    imageResult.recordset.forEach((row) => {
      (imagesByQuestion[row.question_id] ||= []).push({ id: row.id, image_url: row.image_url });
    });

    // Students taking the exam must never receive the answer key —
    // only admin/teacher (building/marking the assessment) get it.
    const includeAnswers = STAFF_ROLES.includes(req.user?.role);

    const map = {};
    questionResult.recordset.forEach((row) => {
      if (!map[row.question_id]) {
        map[row.question_id] = {
          id: row.question_id,
          question_text: row.question_text,
          marks: row.marks,
          ...(includeAnswers ? { correct_answer: row.correct_answer } : {}),
          question_type: row.question_type || "mcq",
          options: [],
          images: imagesByQuestion[row.question_id] || [],
        };
      }
      if (row.option_label) {
        map[row.question_id].options.push({ option_label: row.option_label, option_text: row.option_text });
      }
    });

    res.json({ assessment, questions: Object.values(map), remaining_seconds });
  } catch (err) {
    console.error("GET ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

/* =========================================================================
   STANDALONE EXAM LOGIN (no portal account session required)
   ─────────────────────────────────────────────────────────
   Body: { assessmentId, username, examPassword }

   Lets a student reach /take-assessment/:id directly (e.g. from a link
   shared by their teacher) using just their username + the exam
   password set on this specific assessment — no prior /login needed.

   Deliberately never responds with HTTP 401/403: the frontend's global
   axios interceptor treats any 401/403 as "session invalid" and wipes
   localStorage + redirects to /login, which would yank a student who
   was never logged in in the first place off of this page. Bad
   credentials here are reported as normal 400-level JSON instead.

   The issued token is a normal student JWT (so all the existing
   protect/authorize("student") routes work unchanged) plus two extra
   claims — examOnly + examAssessmentId — that scope it to this one
   assessment. See redactForRole/getEAssessmentById and the exam-only
   checks in startExamSession/submitEAssessment/getStudentResult below.
========================================================================= */

const examLogin = async (req, res) => {
  try {
    const assessmentId = toInt(req.body.assessmentId);
    const username = (req.body.username || "").trim();
    const examPassword = (req.body.examPassword || "").trim();

    if (!assessmentId || !username || !examPassword) {
      return res.status(400).json({ success: false, message: "Assessment, username and exam password are all required" });
    }

    // MULTI-TENANT: there's no JWT yet at this point (that's the whole
    // point of exam-login — a student reaches it via a shared link with
    // no prior /login), so server.js's DB middleware has no tenant hint
    // and req.pool is just the "default" tenant. The assessment could
    // live in ANY configured tenant DB, so try each one in turn (same
    // pattern as routes/auth.js's POST /login) until the assessment id is
    // found, then look the student up in THAT SAME tenant's Students
    // table — a student's account and the assessment they're sitting
    // always live in one database together, never split across two.
    let pool = null;
    let tenant = null;
    let assessment = null;

    for (const tenantKey of listTenantKeys()) {
      const candidatePool = await getPool(tenantKey);

      // Both queries below are wrapped in withTransientRetry: under a login
      // burst, the pool can be momentarily saturated (all DB_POOL_MAX
      // connections busy) — that surfaces as a pool-acquire-timeout error,
      // not a real query failure, so one quick retry after a short backoff
      // is safe and often succeeds once a connection frees up. This never
      // retries on bad credentials/validation, since those aren't thrown
      // errors here at all — see isTransientDbError.
      let aRes;
      try {
        aRes = await withTransientRetry(
          () => candidatePool.request()
            .input("id", sql.Int, assessmentId)
            .query(`SELECT id, title, subject, duration_minutes, class_id, status, active_status, exam_password FROM e_assessments WHERE id = @id`),
          { label: `exam-login:fetch-assessment:${tenantKey}` }
        );
      } catch (dbErr) {
        return respondDbBusy(res, dbErr);
      }

      if (aRes.recordset.length) {
        pool = candidatePool;
        tenant = tenantKey;
        assessment = aRes.recordset[0];
        break;
      }
    }

    if (!assessment) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    // Activity log: no JWT exists yet, and req.pool is only the default
    // tenant — tell the logger which tenant DB/assessment this really is.
    req.auditPool = pool;
    req.auditAssessmentId = assessment.id;

    if (!assessment.exam_password) {
      return res.status(400).json({ success: false, message: "This assessment has no exam password configured. Ask your teacher to set one, or log in to the student portal normally." });
    }
    if (assessment.exam_password !== examPassword) {
      return res.status(400).json({ success: false, message: "Incorrect exam password" });
    }
    // ACCOUNT STATUS: the moment the exam password is accepted, look the
    // trainee up and refuse an inactive account before anything else (paper
    // active check, device/SEB checks, token). Blank status = active so
    // legacy rows aren't locked out; anything else (inactive, graduated,
    // suspended...) is refused. 400 on purpose, like the other login errors.
    let sRes;
    try {
      sRes = await withTransientRetry(
        () => pool.request()
          .input("username", sql.NVarChar, username)
          .query(`SELECT id, username, name, status FROM Students WHERE username = @username`),
        { label: "exam-login:fetch-student" }
      );
    } catch (dbErr) {
      return respondDbBusy(res, dbErr);
    }

    if (!sRes.recordset.length) {
      return res.status(400).json({ success: false, message: "No student account found with that username" });
    }
    const student = sRes.recordset[0];
    req.auditActor = { id: student.id, username: student.username };

    if (!isActiveStudent(student.status)) {
      return res.status(400).json({
        success: false,
        code: "STUDENT_INACTIVE",
        message: "Your account isn't active, so you can't take this assessment. Please contact the school office.",
      });
    }

    // Only the Start/Stop (active_status) toggle decides whether students
    // can enter — approval status is no longer checked here. Strict
    // comparison on purpose: a NULL active_status is NOT treated as active,
    // matching the student list query in getEAssessments.
    // Exception: a student who was granted a resit / replay of a closed paper.
    let replayEntry = false;
    if (assessment.active_status !== "Active") {
      try { replayEntry = await hasPendingResit(pool, assessment.id, student.id); }
      catch (dbErr) { return respondDbBusy(res, dbErr); }
      if (!replayEntry) {
        return res.status(400).json({ success: false, message: "This assessment isn't active right now." });
      }
    }

    // Desktop-only switch: reject phones/tablets before any token is issued.
    const deviceCheck = await checkDesktopOnly(req, pool, tenant, assessment.id, { username });
    if (deviceCheck.blocked) return sendBlocked(res, deviceCheck.device);

    // Safe Exam Browser switch: refuse to issue a token to any other browser.
    const sebCheck = await checkSeb(req, pool, tenant, assessment.id);
    if (sebCheck.blocked) return sendSebBlocked(res);

    // Trainee access list + open/close window (see utils/examAccess.js).
    // 400 (never 401/403) on purpose — see the note above this function.
    let accessCheck;
    try {
      // A granted replay is allowed outside the paper's open/close window.
      const pendingResit = replayEntry || await hasPendingResit(pool, assessment.id, student.id);
      accessCheck = await checkStudentAccess(pool, assessment.id, student.id, { skipWindow: pendingResit });
    }
    catch (dbErr) { return respondDbBusy(res, dbErr); }
    if (!accessCheck.allowed) {
      return res.status(400).json({ success: false, code: accessCheck.code, message: accessCheck.message });
    }

    // Short-lived on purpose: just long enough to sit the exam, not a
    // standing session. duration_minutes + 20 min buffer, clamped.
    const minutes = Math.min(Math.max((assessment.duration_minutes || 30) + 20, 30), 240);

    const token = jwt.sign(
      {
        id: student.id,
        username: student.username,
        role: "student",
        permissions: [],
        source: "Students",
        tenant,
        mustChangePassword: false,
        examOnly: true,
        examAssessmentId: assessment.id,
      },
      process.env.JWT_SECRET || "doravo_core_secret",
      { expiresIn: `${minutes}m` }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: student.id,
        username: student.username,
        name: student.name || "",
        role: "student",
        permissions: [],
        source: "Students",
        tenant,
        mustChangePassword: false,
        examOnly: true,
        examAssessmentId: assessment.id,
      },
      assessment: {
        id: assessment.id,
        title: assessment.title,
        subject: assessment.subject,
        duration_minutes: assessment.duration_minutes,
      },
    });
  } catch (err) {
    console.error("EXAM LOGIN ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


/* =========================================================================
   QUESTIONS
========================================================================= */

// Shared gate for add/update/delete question actions. Admin/sub_admin
// always pass. A teacher passes only if they created the assessment
// (legacy path) OR the admin explicitly picked them as a permitted
// question-setter in e_assessment_question_setters. Returns
// { ok: true } or { ok: false, status, message } for the caller to
// respond with directly.
async function canManageAssessmentQuestions(pool, req, e_assessmentId) {
  const role = req.user?.role;
  if (["admin", "sub_admin", "sub_admin_2", "module_admin"].includes(role)) return { ok: true };

  const teacherId = toInt(req.user?.id);
  const result = await pool.request()
    .input("id", sql.Int, e_assessmentId)
    .input("teacherId", sql.Int, teacherId)
    .query(`
      SELECT
        (SELECT teacher_id FROM e_assessments WHERE id = @id) AS owner_teacher_id,
        (SELECT COUNT(*) FROM e_assessment_question_setters
          WHERE e_assessment_id = @id AND teacher_id = @teacherId) AS is_setter
    `);
  const row = result.recordset[0];
  if (!row || row.owner_teacher_id == null) {
    return { ok: false, status: 404, message: "Assessment not found" };
  }
  if (row.owner_teacher_id === teacherId || row.is_setter > 0) {
    return { ok: true };
  }
  return {
    ok: false, status: 403,
    message: "You have not been assigned to add questions to this assessment.",
  };
}

// Shared insert logic behind addEAssessmentQuestion (one question, typed
// in by hand) and bulkAddQuestions (many questions at once, from the Word
// document importer) — both need exactly the same question-row + options
// + images insert, just called a different number of times.
async function insertQuestionRow(pool, e_assessmentId, payload) {
  const { question_text, marks, options, correct_answer, question_type, time_limit, marking_guide, images } = payload;
  const type = question_type === "essay" ? "essay" : "mcq";

  const questionResult = await pool.request()
    .input("e_assessment_id", sql.Int, e_assessmentId)
    .input("question_text", sql.NVarChar(sql.MAX), question_text)
    .input("marks", sql.Int, marks || 1)
    .input("correct_answer", sql.NVarChar(sql.MAX), type === "mcq" ? correct_answer || null : null)
    .input("marking_guide", sql.NVarChar(sql.MAX), type === "essay" ? marking_guide || null : null)
    .input("question_type", sql.NVarChar(50), type)
    .input("time_limit", sql.Int, time_limit || 60)
    .query(`
      INSERT INTO e_assessment_questions
        (e_assessment_id, question_text, question_type, marks, time_limit, correct_answer, marking_guide)
      OUTPUT INSERTED.id
      VALUES
        (@e_assessment_id, @question_text, @question_type, @marks, @time_limit, @correct_answer, @marking_guide)
    `);

  const questionId = questionResult.recordset[0].id;

  if (type === "mcq" && Array.isArray(options)) {
    for (const o of options) {
      await pool.request()
        .input("question_id", sql.Int, questionId)
        .input("option_label", sql.NVarChar(10), o.label || o.option_label)
        .input("option_text", sql.NVarChar(sql.MAX), o.text || o.option_text)
        .query(`
          INSERT INTO e_assessment_options (question_id, option_label, option_text)
          VALUES (@question_id, @option_label, @option_text)
        `);
    }
  }

  if (Array.isArray(images)) {
    let sortOrder = 0;
    for (const img of images) {
      const url = typeof img === "string" ? img : img?.image_url || img?.url;
      if (!url) continue;
      await pool.request()
        .input("question_id", sql.Int, questionId)
        .input("image_url", sql.NVarChar(500), url)
        .input("sort_order", sql.Int, sortOrder++)
        .query(`
          INSERT INTO e_assessment_question_images (question_id, image_url, sort_order)
          VALUES (@question_id, @image_url, @sort_order)
        `);
    }
  }

  return { questionId, type };
}

const addEAssessmentQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const { question_text } = req.body;

    if (!e_assessmentId || !question_text) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const permission = await canManageAssessmentQuestions(pool, req, e_assessmentId);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    // Enforce the admin-set "add questions by" deadline server-side —
    // the frontend disables the button too, but that alone can always be
    // bypassed by calling the API directly, so the real gate lives here.
    const deadlineCheck = await pool.request().input("id", sql.Int, e_assessmentId)
      .query(`SELECT questions_deadline FROM e_assessments WHERE id = @id`);
    if (!deadlineCheck.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }
    const deadline = deadlineCheck.recordset[0].questions_deadline;
    if (deadline && new Date(deadline) < new Date()) {
      return res.status(403).json({
        message: `The deadline to add questions to this assessment passed on ${new Date(deadline).toLocaleString()}.`,
      });
    }

    const { questionId, type } = await insertQuestionRow(pool, e_assessmentId, req.body);

    res.json({ success: true, question_id: questionId, question_type: type });
  } catch (err) {
    console.error("ADD QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Bulk version of the above — used by the "Import from Word Document"
// flow in AddQuestions.jsx. The teacher previews/edits the parsed
// questions client-side first (parseQuestionsDocx never writes to the
// e_assessment_questions table itself, only to disk for images), then
// this endpoint saves the reviewed list in one call. Same deadline gate
// as addEAssessmentQuestion, checked once up front rather than per
// question.
const bulkAddQuestions = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];

    if (!e_assessmentId || !questions.length) {
      return res.status(400).json({ message: "No questions to import" });
    }

    const permission = await canManageAssessmentQuestions(pool, req, e_assessmentId);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    const deadlineCheck = await pool.request().input("id", sql.Int, e_assessmentId)
      .query(`SELECT questions_deadline FROM e_assessments WHERE id = @id`);
    if (!deadlineCheck.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }
    const deadline = deadlineCheck.recordset[0].questions_deadline;
    if (deadline && new Date(deadline) < new Date()) {
      return res.status(403).json({
        message: `The deadline to add questions to this assessment passed on ${new Date(deadline).toLocaleString()}.`,
      });
    }

    let imported = 0;
    for (const q of questions) {
      if (!q || !String(q.question_text || "").trim()) continue;
      await insertQuestionRow(pool, e_assessmentId, q);
      imported++;
    }

    res.json({ success: true, imported });
  } catch (err) {
    console.error("BULK ADD QUESTIONS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================================
   QUESTION IMAGES (diagrams/photos attached to a single question)
========================================================================= */
const uploadQuestionImages = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    if (!questionId) return res.status(400).json({ message: "Invalid question ID" });
    if (!req.files || !req.files.length) {
      return res.status(400).json({ message: "No images uploaded" });
    }

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    const countResult = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT COUNT(*) AS c, ISNULL(MAX(sort_order), -1) AS maxOrder FROM e_assessment_question_images WHERE question_id = @id`);
    let sortOrder = countResult.recordset[0].maxOrder + 1;

    const inserted = [];
    for (const file of req.files) {
      const url = questionImageUrlFor(file.filename);
      const result = await pool.request()
        .input("question_id", sql.Int, questionId)
        .input("image_url", sql.NVarChar(500), url)
        .input("sort_order", sql.Int, sortOrder++)
        .query(`
          INSERT INTO e_assessment_question_images (question_id, image_url, sort_order)
          OUTPUT INSERTED.id
          VALUES (@question_id, @image_url, @sort_order)
        `);
      inserted.push({ id: result.recordset[0].id, image_url: url });
    }

    res.json({ success: true, images: inserted });
  } catch (err) {
    console.error("UPLOAD QUESTION IMAGES ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Image upload failed" });
  }
};

const deleteQuestionImage = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    const imageId = toInt(req.params.imageId);
    if (!questionId || !imageId) return res.status(400).json({ message: "Invalid ID" });

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    const imgResult = await pool.request()
      .input("id", sql.Int, imageId)
      .input("qid", sql.Int, questionId)
      .query(`SELECT image_url FROM e_assessment_question_images WHERE id = @id AND question_id = @qid`);
    if (!imgResult.recordset.length) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }

    await pool.request().input("id", sql.Int, imageId)
      .query(`DELETE FROM e_assessment_question_images WHERE id = @id`);

    deleteQuestionImageByUrl(imgResult.recordset[0].image_url);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE QUESTION IMAGE ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Image removal failed" });
  }
};

/* =========================================================================
   IMPORT QUESTIONS FROM A WORD DOCUMENT (.docx)
   ─────────────────────────────────────────────
   Lets a teacher upload a question paper they already have as a Word
   document instead of retyping every question by hand. This endpoint
   only PARSES the document and returns the result for the teacher to
   review/edit on the frontend — nothing is saved to
   e_assessment_questions until they confirm via POST .../questions/bulk
   (bulkAddQuestions above). Any diagrams embedded in the document ARE
   written to disk immediately (uploads/question-images) so the preview
   can show them; if the teacher discards a parsed question before
   importing, its image file is simply left orphaned on disk — the same
   trade-off this codebase already accepts elsewhere for uploaded files
   that end up unused.

   Expected document format (plain text, one question per block):

     Q1: What is the capital of France? (2 marks)
     A) Paris
     B) London
     C) Berlin
     D) Madrid
     Answer: A

     Q2: Explain the water cycle shown below. (5 marks)
     [Essay]
     Marking guide: Should mention evaporation, condensation, precipitation.

   - A line starting "Q<number>" (optionally "Question") starts a new
     question. A trailing "(N marks)" on that line sets its marks.
   - Lines "A) ..." / "B. ..." etc. become MCQ options.
   - A line "Answer: <letter>" sets the correct option and marks the
     question as MCQ.
   - A line "[Essay]" forces the question to be treated as essay even if
     it has option-like lines.
   - A line "Marking guide: ..." sets the essay marking guide.
   - Any image in a paragraph is attached to whichever question that
     paragraph falls under.

   Questions that come out MCQ with no recognised "Answer:" line are
   still returned (flagged with needs_review) rather than dropped, so
   the teacher can fix them in the preview instead of silently losing
   a question.
========================================================================= */
const QUESTION_LINE_RE = /^Q(?:uestion)?\s*\.?\s*(\d+)[:.)\-]?\s*(.*)$/i;
const OPTION_LINE_RE = /^([A-Za-z])[).]\s+(.*)$/;
const ANSWER_LINE_RE = /^Answer\s*[:\-]?\s*([A-Za-z])\b/i;
const ESSAY_MARKER_RE = /^\[?\s*Essay\s*\]?$/i;
const MARKING_GUIDE_RE = /^Marking\s*guide\s*[:\-]?\s*(.*)$/i;
const TRAILING_MARKS_RE = /\(\s*(\d+)\s*marks?\s*\)\s*$/i;
const IMG_SRC_RE = /<img[^>]*src="([^"]+)"[^>]*>/gi;

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function finalizeParsedQuestion(q) {
  if (!q) return null;
  const hasOptions = q.options.length >= 2;
  let type = q.forceType || (hasOptions ? "mcq" : "essay");
  let needs_review = false;

  if (type === "mcq" && !q.correct_answer) {
    needs_review = true; // parsed as MCQ but no "Answer:" line found
  }
  if (type === "mcq" && !hasOptions) {
    // marked essay-with-answer-line by mistake, or malformed — fall back
    type = "essay";
  }

  return {
    question_text: q.textParts.join(" ").trim() || "(untitled question)",
    question_type: type,
    marks: q.marks || 1,
    options: type === "mcq" ? q.options : [],
    correct_answer: type === "mcq" ? (q.correct_answer || null) : null,
    marking_guide: type === "essay" ? (q.markingGuideParts.join(" ").trim() || null) : null,
    images: q.images,
    needs_review,
  };
}

const parseQuestionsDocx = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    if (!e_assessmentId) return res.status(400).json({ message: "Invalid assessment ID" });
    if (!req.file) return res.status(400).json({ message: "No document uploaded" });

    const permission = await canManageAssessmentQuestions(pool, req, e_assessmentId);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    fs.mkdirSync(QUESTION_IMAGES_DIR, { recursive: true });
    const extByType = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
      "image/gif": ".gif", "image/bmp": ".bmp", "image/webp": ".webp",
    };

    const mammothOptions = {
      convertImage: mammoth.images.imgElement((image) =>
        image.read().then((buffer) => {
          const ext = extByType[image.contentType] || ".png";
          const filename = `${Date.now()}-${crypto.randomInt(0, 1e9)}${ext}`;
          fs.writeFileSync(path.join(QUESTION_IMAGES_DIR, filename), buffer);
          return { src: questionImageUrlFor(filename) };
        })
      ),
    };

    const result = await mammoth.convertToHtml({ buffer: req.file.buffer }, mammothOptions);
    const html = result.value || "";

    // Walk the document's paragraphs/list items in order — each becomes
    // one "line" of text plus any images it contains.
    const blocks = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => m[1] ?? m[2] ?? "");

    const questions = [];
    let current = null;
    let inMarkingGuide = false;

    for (const block of blocks) {
      const images = [...block.matchAll(IMG_SRC_RE)].map((m) => m[1]);
      const text = decodeHtmlEntities(block.replace(/<[^>]+>/g, "")).trim();

      const qMatch = text.match(QUESTION_LINE_RE);
      if (qMatch) {
        if (current) questions.push(current);
        let stem = qMatch[2] || "";
        let marks = 1;
        const marksMatch = stem.match(TRAILING_MARKS_RE);
        if (marksMatch) {
          marks = toInt(marksMatch[1]) || 1;
          stem = stem.replace(TRAILING_MARKS_RE, "").trim();
        }
        current = {
          textParts: stem ? [stem] : [],
          marks,
          options: [],
          correct_answer: null,
          forceType: null,
          markingGuideParts: [],
          images: [...images],
        };
        inMarkingGuide = false;
        continue;
      }

      if (!current) continue; // stray text before the first "Q..." line — ignore

      if (images.length) current.images.push(...images);

      if (ESSAY_MARKER_RE.test(text)) {
        current.forceType = "essay";
        continue;
      }

      const answerMatch = text.match(ANSWER_LINE_RE);
      if (answerMatch) {
        current.correct_answer = answerMatch[1].toUpperCase();
        inMarkingGuide = false;
        continue;
      }

      const guideMatch = text.match(MARKING_GUIDE_RE);
      if (guideMatch) {
        inMarkingGuide = true;
        if (guideMatch[1]) current.markingGuideParts.push(guideMatch[1]);
        continue;
      }

      const optMatch = !inMarkingGuide && text.match(OPTION_LINE_RE);
      if (optMatch && current.forceType !== "essay") {
        current.options.push({ label: optMatch[1].toUpperCase(), text: optMatch[2].trim() });
        continue;
      }

      if (!text) continue; // blank separator line

      if (inMarkingGuide) {
        current.markingGuideParts.push(text);
      } else if (!current.options.length) {
        // continuation of a multi-line question stem
        current.textParts.push(text);
      }
      // stray lines after options have started (and before "Answer:")
      // are otherwise ignored — safest default for an unrecognised format
    }
    if (current) questions.push(current);

    const parsed = questions.map(finalizeParsedQuestion).filter(Boolean);

    res.json({
      success: true,
      questions: parsed,
      warning: parsed.length === 0
        ? "No questions were recognised in this document. Make sure each question starts with \"Q1:\", \"Q2:\", etc."
        : undefined,
    });
  } catch (err) {
    console.error("PARSE QUESTIONS DOCX ERROR:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to read that document" });
  }
};

/* ---- music paper helpers: marker overlays + model answer sheet ---------- */
const PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_SHEET_CHARS = 1_500_000;
const MAX_SHEETS = 3;
// Keep only well-formed PNG data URLs (never trust the client), max 3, each size-capped.
const cleanPngList = (list) => (Array.isArray(list) ? list : [])
  .map((v) => (typeof v === "string" ? v : v?.png))
  .filter((v) => typeof v === "string" && v.length <= MAX_SHEET_CHARS && PNG_DATA_URL_RE.test(v))
  .slice(0, MAX_SHEETS);
const parseMusicAnnotations = (raw) => {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map((v) => (typeof v === "string" && PNG_DATA_URL_RE.test(v) ? v : "")) : []; }
  catch { return []; }
};

const getAssessmentQuestions = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);

    const result = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .query(`
        SELECT q.id, q.question_text, q.marks, q.correct_answer, q.marking_guide,
               q.question_type, q.model_answer_sheet, o.option_label, o.option_text
        FROM e_assessment_questions q
        LEFT JOIN e_assessment_options o ON q.id = o.question_id
        WHERE q.e_assessment_id = @assessmentId
        ORDER BY q.id
      `);
    // The model answer is for staff only — never sent to a student sitting the exam.
    const isStaffViewer = req.user?.role && req.user.role !== "student" && !req.user?.examOnly;

    const imageResult = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .query(`
        SELECT qi.question_id, qi.id, qi.image_url
        FROM e_assessment_question_images qi
        INNER JOIN e_assessment_questions q ON q.id = qi.question_id
        WHERE q.e_assessment_id = @assessmentId
        ORDER BY qi.question_id, qi.sort_order, qi.id
      `);
    const imagesByQuestion = {};
    imageResult.recordset.forEach((row) => {
      (imagesByQuestion[row.question_id] ||= []).push({ id: row.id, image_url: row.image_url });
    });

    const map = {};
    result.recordset.forEach((row) => {
      if (!map[row.id]) {
        map[row.id] = {
          id: row.id,
          question_text: row.question_text,
          marks: row.marks,
          correct_answer: row.correct_answer,
          marking_guide: row.marking_guide,
          question_type: row.question_type || "mcq",
          ...(isStaffViewer ? { model_answer_sheet: row.model_answer_sheet || null } : {}),
          options: [],
          images: imagesByQuestion[row.id] || [],
        };
      }
      if (row.option_label) {
        map[row.id].options.push({ option_label: row.option_label, option_text: row.option_text });
      }
    });

    res.json(Object.values(map));
  } catch (err) {
    console.error("GET QUESTIONS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    const { question_text, marks, correct_answer, marking_guide, essay_answer, options, question_type, time_limit } = req.body;
    const type = question_type === "essay" || question_type === "descriptive" ? "essay" : "mcq";

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    await pool.request()
      .input("id", sql.Int, questionId)
      .input("question_text", sql.NVarChar(sql.MAX), question_text)
      .input("marks", sql.Int, marks || 1)
      .input("correct_answer", sql.NVarChar(sql.MAX), type === "mcq" ? correct_answer || null : null)
      .input("marking_guide", sql.NVarChar(sql.MAX), type === "essay" ? (marking_guide || essay_answer || null) : null)
      .input("question_type", sql.NVarChar(50), type)
      .input("time_limit", sql.Int, time_limit || 60)
      .query(`
        UPDATE e_assessment_questions
        SET question_text = @question_text, marks = @marks, correct_answer = @correct_answer,
            marking_guide = @marking_guide, question_type = @question_type, time_limit = @time_limit
        WHERE id = @id
      `);

    await pool.request().input("id", sql.Int, questionId)
      .query(`DELETE FROM e_assessment_options WHERE question_id = @id`);

    if (type === "mcq" && Array.isArray(options)) {
      for (const option of options) {
        await pool.request()
          .input("question_id", sql.Int, questionId)
          .input("option_label", sql.NVarChar(10), option.label || option.option_label)
          .input("option_text", sql.NVarChar(sql.MAX), option.text || option.option_text)
          .query(`
            INSERT INTO e_assessment_options (question_id, option_label, option_text)
            VALUES (@question_id, @option_label, @option_text)
          `);
      }
    }

    res.json({ success: true, message: "Question updated successfully" });
  } catch (err) {
    console.error("UPDATE QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const deleteQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    if (!questionId) return res.status(400).json({ success: false, message: "Invalid question ID" });

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    // Clean up attached images too (rows + files on disk) so nothing is orphaned.
    const imgs = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT image_url FROM e_assessment_question_images WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_question_images WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_options WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_answers WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_questions WHERE id = @id`);
    imgs.recordset.forEach((r) => deleteQuestionImageByUrl(r.image_url));

    res.json({ success: true, message: "Question deleted successfully" });
  } catch (err) {
    console.error("DELETE QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================================
   EXAM SESSION / SINGLE-DEVICE TOKEN LOCK
   ------------------------------------------------------------------------
   Honest limitation: a web page cannot disable a physical device or block
   it "until restart" — no browser API reaches the OS. What this DOES do:
     - issue a one-time 6-character token per (student, assessment)
     - bind that token to the first device that activates it
     - reject / lock the session the instant a second device tries the
       same token (checked continuously via heartbeat)
     - the frontend then shows a full-screen lock overlay that traps
       input on the offending device until the exam ends or an admin
       clears the lock — this is the realistic, honest version of
       "locks the device."
========================================================================= */

// A session counts as "live" while it is active and still inside the exam's
// duration (+ the same grace window the server's auto-submit uses). Sessions
// past that are closed by utils/examAttempts.finalizeExpiredAttempts, so they
// never block a student from sitting their next exam.
const findOtherLiveSession = async (pool, studentId, assessmentId) => {
  const r = await pool.request()
    .input("sid", sql.Int, studentId)
    .input("aid", sql.Int, assessmentId)
    .input("grace", sql.Int, FINALIZE_GRACE_MINUTES)
    .query(`
      SELECT TOP 1 es.e_assessment_id, a.title
      FROM e_assessment_exam_sessions es
      INNER JOIN e_assessments a ON a.id = es.e_assessment_id
      WHERE es.student_id = @sid
        AND es.e_assessment_id <> @aid
        AND es.status = 'active'
        AND es.activated_at IS NOT NULL
        AND DATEADD(MINUTE, ISNULL(a.duration_minutes, 30) + @grace, ${clockStartSql("a", "es")}) > GETDATE()
      ORDER BY es.activated_at DESC
    `);
  return r.recordset[0] || null;
};

// Student starts the exam -> issue (or resume) a token for this device-binding cycle
const startExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessment_id = toInt(req.params.id);
    const student_id = req.user?.id;
    if (!e_assessment_id || !student_id) {
      return res.status(400).json({ message: "Missing assessment or student" });
    }

    // Starting an exam session — the very first step of taking an exam —
    // requires the exam-only token issued by /e-assessments/exam-login for
    // this exact assessment. A general student-portal login is never
    // sufficient by itself: without the admin-set exam password for THIS
    // assessment, a portal session cannot start (or resume) it.
    if (!req.user?.examOnly || req.user.examAssessmentId !== e_assessment_id) {
      return res.status(403).json({ message: "You must sign in with your username and this assessment's exam password to start it." });
    }

    const existing = await pool.request()
      .input("aid", sql.Int, e_assessment_id)
      .input("sid", sql.Int, student_id)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);

    // ONE SESSION PER STUDENT: a student can only be sitting one exam at a
    // time. If they already have a live (active, still inside its time
    // window) session for a DIFFERENT assessment, starting another is
    // refused until that one is submitted or runs out. The same assessment
    // is never affected — resuming it is handled just below, and the
    // (assessment, student) pair already has exactly one session row.
    const otherLive = await findOtherLiveSession(pool, student_id, e_assessment_id);
    if (otherLive) {
      return res.status(409).json({
        code: "ACTIVE_EXAM_SESSION",
        message: `You already have an exam in progress ("${otherLive.title || "another assessment"}"). Submit it first — only one exam session per student is allowed at a time.`,
        active_assessment_id: otherLive.e_assessment_id,
      });
    }

    // Trainee access list + open/close window. A student already mid-exam
    // (session active) keeps their own timer past the closing time.
    {
      const midExam = existing.recordset[0]?.status === "active";
      const pendingReplay = !!existing.recordset[0]?.resit_allowed && existing.recordset[0]?.status === "issued";
      const access = await checkStudentAccess(pool, e_assessment_id, student_id, { skipWindow: midExam || pendingReplay });
      if (!access.allowed) {
        return res.status(409).json({ code: access.code, message: access.message });
      }
    }

    if (existing.recordset.length) {
      const row = existing.recordset[0];
      if (row.status === "ended") {
        return res.status(409).json({ message: "This assessment has already been completed" });
      }
      // Resume: return same token, do not re-issue (keeps device binding intact)
      return res.json({
        success: true,
        token: row.token,
        status: row.status,
        device_bound: !!row.device_id,
        attempt_no: row.attempt_no || 1,
      });
    }

    let token, sessionId;
    // At most 2 attempts total: SQL Server deadlock victims (error 1205)
    // are a well-known, genuinely transient outcome of many concurrent
    // INSERTs racing for the same table/index pages — exactly what a
    // login burst produces here, since every student's first start-exam
    // call inserts into this same table within milliseconds of each
    // other. A deadlock victim is not a data problem and is safe to
    // retry once; it is NOT the same as the 2627 unique-violation case
    // below (a real duplicate row), which is handled by re-fetching
    // instead of retrying the insert.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        token = generateToken();
        const result = await pool.request()
          .input("aid", sql.Int, e_assessment_id)
          .input("sid", sql.Int, student_id)
          .input("token", sql.Char(6), token)
          .query(`
            INSERT INTO e_assessment_exam_sessions (e_assessment_id, student_id, token, status)
            OUTPUT INSERTED.id
            VALUES (@aid, @sid, @token, 'issued')
          `);
        sessionId = result.recordset[0].id;
        break;
      } catch (insertErr) {
        // Race condition: another near-simultaneous request (e.g. a double-fired
        // React effect) already inserted the row between our SELECT and INSERT.
        // Instead of failing, just fetch and return the row that won the race.
        if (insertErr.number === 2627) {
          const retry = await pool.request()
            .input("aid", sql.Int, e_assessment_id)
            .input("sid", sql.Int, student_id)
            .query(`SELECT * FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);

          if (retry.recordset.length) {
            const row = retry.recordset[0];
            if (row.status === "ended") {
              return res.status(409).json({ message: "This assessment has already been completed" });
            }
            return res.json({
              success: true,
              token: row.token,
              status: row.status,
              device_bound: !!row.device_id,
              attempt_no: row.attempt_no || 1,
            });
          }
          throw insertErr; // no row found after all — genuine error, let the outer catch handle it
        }

        if (insertErr.number === 1205 && attempt === 0) {
          console.warn(`⚠️ start-exam: deadlock victim on insert (aid=${e_assessment_id}, sid=${student_id}), retrying once`);
          await new Promise((r) => setTimeout(r, 100));
          continue; // one retry only
        }

        throw insertErr; // not a race condition or deadlock — genuine error, let the outer catch handle it
      }
    }

    res.json({ success: true, session_id: sessionId, token, status: "issued", device_bound: false, attempt_no: 1 });
  } catch (err) {
    console.error("START EXAM SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to start exam session" });
  }
};
// Frontend calls this immediately after showing the token, binding this browser as "the device"
const activateExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id, device_label } = req.body;
    const student_id = req.user?.id;
    if (!token || !device_id) return res.status(400).json({ message: "token and device_id are required" });

    const result = await pool.request()
      .input("token", sql.Char(6), token)
      .input("sid", sql.Int, student_id)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token AND student_id = @sid`);

    if (!result.recordset.length) return res.status(404).json({ message: "Invalid or expired token" });
    const row = result.recordset[0];

    if (row.status === "locked") {
      return res.status(423).json({ locked: true, message: "This exam session is locked. Ask an admin to unlock it." });
    }
    if (row.status === "ended") {
      return res.status(409).json({ message: "This assessment has already been completed" });
    }

    if (!row.device_id) {
      // First activation: the access list / window may have changed since the
      // token was issued, so re-check before the clock starts.
      // An unlocked session (activated_at already set) is a student already
      // mid-exam coming back, so — like start-exam does for an active session —
      // the open/close window must not shut them out after the lock.
      const resumingAfterUnlock = !!row.activated_at;
      const access = await checkStudentAccess(pool, row.e_assessment_id, student_id, { skipWindow: resumingAfterUnlock || !!row.resit_allowed });
      if (!access.allowed) {
        return res.status(409).json({ code: access.code, message: access.message });
      }
      // Late arrival: the clock runs from when the paper STARTED, so a student
      // who only gets in after the paper's time is up has nothing to sit.
      const timeCheck = await pool.request()
        .input("aid", sql.Int, row.e_assessment_id)
        .input("attempt", sql.Int, row.attempt_no || 1)
        .query(`
          SELECT CASE WHEN @attempt <= 1 AND a.started_at IS NOT NULL
                      THEN DATEDIFF(SECOND, GETDATE(), DATEADD(MINUTE, ISNULL(a.duration_minutes, 30), a.started_at)) END AS paper_seconds_left
          FROM e_assessments a WHERE a.id = @aid
        `);
      const paperLeft = timeCheck.recordset[0]?.paper_seconds_left;
      if (paperLeft != null && Number(paperLeft) <= 0) {
        return res.status(409).json({
          code: "PAPER_TIME_OVER",
          message: "The time for this paper has already ended, so you can no longer start it. Please contact your invigilator or the school office.",
        });
      }
      // First activation — one live session per student: re-check here too,
      // since two exams could both have been "issued" before either started.
      const otherLive = await findOtherLiveSession(pool, student_id, row.e_assessment_id);
      if (otherLive) {
        return res.status(409).json({
          code: "ACTIVE_EXAM_SESSION",
          message: `You already have an exam in progress ("${otherLive.title || "another assessment"}"). Submit it first — only one exam session per student is allowed at a time.`,
          active_assessment_id: otherLive.e_assessment_id,
        });
      }
      // First activation — bind this device.
      // activated_at is the original exam start: keep it on a resume after an
      // unlock (COALESCE) so the session's clock is not reset.
      await pool.request()
        .input("id", sql.Int, row.id)
        .input("device_id", sql.NVarChar(200), device_id)
        .input("device_label", sql.NVarChar(300), device_label || "")
        .query(`
          UPDATE e_assessment_exam_sessions
          SET device_id = @device_id, device_label = @device_label,
              status = 'active', activated_at = ISNULL(activated_at, GETDATE()), last_heartbeat = GETDATE()
          WHERE id = @id
        `);
      // A newly bound device may have a different clock from the one that wrote
      // the draft; forget the old client timestamp so its first sync is never
      // rejected as "older than what the server holds" (answers entered after
      // the unlock were being dropped, leaving only the pre-lock answers).
      try {
        await pool.request()
          .input("aid", sql.Int, row.e_assessment_id)
          .input("sid", sql.Int, student_id)
          .query(`UPDATE e_assessment_drafts SET client_saved_at = NULL WHERE e_assessment_id = @aid AND student_id = @sid`);
      } catch (_) { /* draft table/column optional — never block activation */ }
      return res.json({ success: true, status: "active" });
    }

    if (row.device_id !== device_id) {
      // A different device tried to use this token — lock it out
      await pool.request()
        .input("id", sql.Int, row.id)
        .query(`
          UPDATE e_assessment_exam_sessions
          SET status = 'locked', locked_at = GETDATE(), lock_reason = 'Token used on a second device'
          WHERE id = @id
        `);
      return res.status(423).json({ locked: true, message: "This exam token is already in use on another device." });
    }

    // Same device resuming
    await pool.request().input("id", sql.Int, row.id)
      .query(`UPDATE e_assessment_exam_sessions SET last_heartbeat = GETDATE() WHERE id = @id`);
    res.json({ success: true, status: "active" });
  } catch (err) {
    console.error("ACTIVATE EXAM SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to activate exam session" });
  }
};

// Frontend pings this every ~10s while the exam is open
const heartbeatExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id } = req.body;
    if (!token || !device_id) return res.status(400).json({ message: "token and device_id are required" });

    // Fast path: the normal heartbeat (live session, bound device) is ONE
    // statement instead of a SELECT then an UPDATE. With hundreds of students
    // pinging every few seconds this halves the heartbeat load on the pool.
    const fast = await pool.request()
      .input("token", sql.Char(6), token)
      .input("device", sql.NVarChar(200), device_id)
      .query(`UPDATE e_assessment_exam_sessions SET last_heartbeat = GETDATE()
              WHERE token = @token AND status = 'active' AND device_id = @device`);
    if (fast.rowsAffected[0]) return res.json({ locked: false, ended: false });

    const result = await pool.request().input("token", sql.Char(6), token)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token`);
    if (!result.recordset.length) return res.status(404).json({ locked: false, ended: true, message: "Session not found" });

    const row = result.recordset[0];
    if (row.status === "ended") return res.json({ locked: false, ended: true });
    if (row.status === "locked") return res.status(423).json({ locked: true, ended: false });

    if (row.device_id && row.device_id !== device_id) {
      await pool.request().input("id", sql.Int, row.id).query(`
        UPDATE e_assessment_exam_sessions
        SET status = 'locked', locked_at = GETDATE(), lock_reason = 'Device mismatch on heartbeat'
        WHERE id = @id
      `);
      return res.status(423).json({ locked: true, ended: false });
    }

    await pool.request().input("id", sql.Int, row.id)
      .query(`UPDATE e_assessment_exam_sessions SET last_heartbeat = GETDATE() WHERE id = @id`);
    res.json({ locked: false, ended: false });
  } catch (err) {
    console.error("HEARTBEAT ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Called on submit / time-up to close out the session cleanly
const endExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "token is required" });

    await pool.request().input("token", sql.Char(6), token).query(`
      UPDATE e_assessment_exam_sessions SET status = 'ended', ended_at = GETDATE() WHERE token = @token
    `);
    res.json({ success: true });
  } catch (err) {
    console.error("END EXAM SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   AUTOSAVE / DEVICE SYNC — the exam is cached on the student's device and
   the device posts its answers here every 30 seconds (and again the moment
   it comes back online). The row is overwritten each time and is what the
   server submits if time runs out before the student does
   (utils/examAttempts).
   Because a device may queue/retry syncs while offline, each request carries
   client_saved_at (when the device last changed an answer). A request whose
   client_saved_at is OLDER than what the server already holds is ignored, so
   a late-arriving retry can never overwrite newer answers.
========================================================================= */
/* A drawing (music paper) is stored inside the answer as a PNG data URL.
   Cap a single answer so one runaway/hand-crafted payload can't bloat the DB. */
const MAX_ANSWER_CHARS = 6 * 1024 * 1024;
const answerTooLarge = (val) => typeof val === "string" && val.length > MAX_ANSWER_CHARS;

const autosaveExamAnswers = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);
    const student_id = req.user?.id;
    const { answers, token, device_id } = req.body;
    const clientSavedAtRaw = Number(req.body.client_saved_at);
    const clientSavedAt = Number.isFinite(clientSavedAtRaw) && clientSavedAtRaw > 0 ? Math.floor(clientSavedAtRaw) : null;
    if (!assessmentId || !student_id) return res.status(400).json({ message: "Missing assessment or student" });
    if (req.user?.examOnly && req.user.examAssessmentId !== assessmentId) {
      return res.status(403).json({ message: "This exam session isn't valid for this assessment" });
    }
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return res.status(400).json({ message: "answers must be an object of questionId -> answer" });
    }

    // Only the live, bound device of an active session may save.
    const sessRes = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, student_id)
      .query(`SELECT status, token, device_id FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);
    const sess = sessRes.recordset[0];
    if (!sess) return res.status(404).json({ message: "No exam session found" });
    if (sess.status === "ended") return res.status(409).json({ ended: true, message: "This assessment has already been completed" });
    if (sess.status === "locked") return res.status(423).json({ locked: true, message: "Exam session is locked" });
    if (token && sess.token !== token) return res.status(403).json({ message: "Token does not match this session" });
    if (sess.device_id && device_id && sess.device_id !== device_id) {
      return res.status(423).json({ locked: true, message: "Device mismatch" });
    }

    if (Object.values(answers).some(answerTooLarge)) {
      return res.status(413).json({ message: "One of your answers is too large to save. Clear some of the drawing and try again." });
    }

    // Keep only non-empty answers, keyed by question id.
    const clean = {};
    Object.entries(answers).forEach(([qid, val]) => {
      if (!/^\d+$/.test(qid)) return;
      if (val === null || val === undefined || String(val).trim() === "") return;
      clean[qid] = typeof val === "string" ? val : String(val);
    });
    const json = JSON.stringify(clean);
    const count = Object.keys(clean).length;
    // Never let an empty payload (e.g. a device that failed to restore its
    // answers) overwrite a real draft.
    if (count === 0) return res.json({ success: true, saved: 0, skipped: true, session_status: sess.status });

    // The UPDATE only applies when this sync is not older than what the server
    // already holds (client_saved_at). @@ROWCOUNT = 0 then means either "no
    // row yet" (insert it) or "a newer sync already landed" (ignore this one).
    const saveRes = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, student_id)
      .input("json", sql.NVarChar(sql.MAX), json)
      .input("count", sql.Int, count)
      .input("cts", sql.BigInt, clientSavedAt)
      .query(`
        UPDATE e_assessment_drafts
        SET answers_json = @json, answered_count = @count, saved_at = GETDATE(),
            client_saved_at = ISNULL(@cts, client_saved_at)
        WHERE e_assessment_id = @aid AND student_id = @sid
          AND (@cts IS NULL OR client_saved_at IS NULL OR client_saved_at <= @cts);
        IF @@ROWCOUNT = 0
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM e_assessment_drafts WHERE e_assessment_id = @aid AND student_id = @sid)
          BEGIN
            INSERT INTO e_assessment_drafts (e_assessment_id, student_id, answers_json, answered_count, client_saved_at)
            VALUES (@aid, @sid, @json, @count, @cts);
            SELECT 1 AS applied;
          END
          ELSE SELECT 0 AS applied;
        END
        ELSE SELECT 1 AS applied;
      `);
    const applied = !saveRes.recordset?.length || saveRes.recordset[0].applied === 1;

    // Server clock is the authority on time left; the device re-syncs its
    // offline countdown from this on every successful sync.
    let secondsLeft = null;
    try {
      const t = await pool.request()
        .input("aid", sql.Int, assessmentId)
        .input("sid", sql.Int, student_id)
        .query(`
          SELECT ${secondsLeftSql("a", "es")} AS seconds_left
          FROM e_assessment_exam_sessions es
          INNER JOIN e_assessments a ON a.id = es.e_assessment_id
          WHERE es.e_assessment_id = @aid AND es.student_id = @sid
            AND es.status = 'active' AND es.activated_at IS NOT NULL
        `);
      if (t.recordset.length && t.recordset[0].seconds_left != null) {
        secondsLeft = Math.max(0, Number(t.recordset[0].seconds_left));
      }
    } catch (_) { /* optional */ }

    res.json({
      success: true,
      saved: count,
      applied,
      stale: !applied,
      saved_at: new Date().toISOString(),
      session_status: sess.status,
      seconds_left: secondsLeft,
    });
  } catch (err) {
    console.error("AUTOSAVE EXAM ERROR:", err);
    res.status(500).json({ message: "Autosave failed" });
  }
};

// Returns the last autosaved answers so a student who comes back (new
// device after an unlock, cleared browser, etc.) continues where they were.
const getExamDraft = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);
    const student_id = req.user?.id;
    if (req.user?.examOnly && req.user.examAssessmentId !== assessmentId) {
      return res.status(403).json({ message: "This exam session isn't valid for this assessment" });
    }
    const r = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, student_id)
      .query(`SELECT answers_json, saved_at FROM e_assessment_drafts WHERE e_assessment_id = @aid AND student_id = @sid`);

    // Time left according to the SERVER clock (exam start + duration), so a
    // page refresh can't hand the student a fresh full-length timer — and so
    // the on-screen clock agrees with when the server auto-submits.
    let secondsLeft = null;
    try {
      const t = await pool.request()
        .input("aid", sql.Int, assessmentId)
        .input("sid", sql.Int, student_id)
        .query(`
          SELECT ${secondsLeftSql("a", "es")} AS seconds_left
          FROM e_assessment_exam_sessions es
          INNER JOIN e_assessments a ON a.id = es.e_assessment_id
          WHERE es.e_assessment_id = @aid AND es.student_id = @sid
            AND es.status = 'active' AND es.activated_at IS NOT NULL
        `);
      if (t.recordset.length && t.recordset[0].seconds_left != null) {
        secondsLeft = Math.max(0, Number(t.recordset[0].seconds_left));
      }
    } catch (_) { /* fall back to the full duration on the client */ }

    let answers = {};
    let savedAt = null;
    if (r.recordset.length) {
      try { answers = JSON.parse(r.recordset[0].answers_json) || {}; } catch (_) { answers = {}; }
      savedAt = r.recordset[0].saved_at;
    }
    res.json({ answers, saved_at: savedAt, seconds_left: secondsLeft });
  } catch (err) {
    console.error("GET EXAM DRAFT ERROR:", err);
    res.status(500).json({ answers: {} });
  }
};

/* =========================================================================
   ADMIN — GRANT RESIT
   Gives one student another attempt at one assessment. Their current
   submission stays untouched (and keeps its marks) until they actually
   submit the resit; at that point it is archived and replaced. The exam
   session is reset with a fresh token so they can sign in and sit it again.
========================================================================= */
const grantResit = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.body.assessment_id);
    const studentId = toInt(req.body.student_id);
    if (!assessmentId || !studentId) {
      return res.status(400).json({ message: "assessment_id and student_id are required" });
    }

    const sessRes = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);
    const sess = sessRes.recordset[0];
    const subRes = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`SELECT id FROM e_assessment_submissions WHERE e_assessment_id = @aid AND student_id = @sid`);
    const hasSubmission = subRes.recordset.length > 0;

    if (!sess && !hasSubmission) {
      return res.status(404).json({ message: "This student has not sat this assessment yet" });
    }
    if (sess && sess.resit_allowed) {
      return res.status(409).json({ message: "A resit has already been granted and not yet taken" });
    }
    if (sess && (sess.status === "active" || sess.status === "locked") && !hasSubmission) {
      return res.status(409).json({ message: "This student is still sitting the exam. Unlock or wait for them to finish first." });
    }

    // "replace": the resit's mark replaces the old one. "keep_best": the
    // official mark becomes whichever of the two is higher.
    const policy = req.body.score_policy === "keep_best" ? "keep_best" : "replace";
    const nextAttempt = (sess?.attempt_no || 1) + 1;
    const grantedBy = toInt(req.user?.id);

    let newToken = null;
    for (let i = 0; i < 5 && !newToken; i++) {
      const t = generateToken();
      try {
        if (sess) {
          await pool.request()
            .input("id", sql.Int, sess.id)
            .input("token", sql.Char(6), t)
            .input("attempt", sql.Int, nextAttempt)
            .input("by", sql.Int, grantedBy)
            .input("policy", sql.NVarChar(20), policy)
            .query(`
              UPDATE e_assessment_exam_sessions
              SET status = 'issued', token = @token, device_id = NULL, device_label = NULL,
                  locked_at = NULL, lock_reason = NULL, ended_at = NULL, activated_at = NULL,
                  last_heartbeat = NULL, auto_submitted = 0,
                  resit_allowed = 1, attempt_no = @attempt, resit_policy = @policy,
                  resit_granted_at = GETDATE(), resit_granted_by = @by
              WHERE id = @id
            `);
        } else {
          // Submission exists but its session row is gone (older data) — recreate it.
          await pool.request()
            .input("aid", sql.Int, assessmentId)
            .input("sid", sql.Int, studentId)
            .input("token", sql.Char(6), t)
            .input("attempt", sql.Int, nextAttempt)
            .input("by", sql.Int, grantedBy)
            .input("policy", sql.NVarChar(20), policy)
            .query(`
              INSERT INTO e_assessment_exam_sessions
                (e_assessment_id, student_id, token, status, resit_allowed, attempt_no, resit_policy, resit_granted_at, resit_granted_by)
              VALUES (@aid, @sid, @token, 'issued', 1, @attempt, @policy, GETDATE(), @by)
            `);
        }
        newToken = t;
      } catch (e) {
        if (e.number === 2627 || e.number === 2601) continue; // token collision — try another
        throw e;
      }
    }
    if (!newToken) return res.status(500).json({ message: "Could not issue a new exam token. Please try again." });

    // Start the resit from a clean slate.
    await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`DELETE FROM e_assessment_drafts WHERE e_assessment_id = @aid AND student_id = @sid`);

    try {
      const info = await pool.request().input("aid", sql.Int, assessmentId)
        .query(`SELECT title FROM e_assessments WHERE id = @aid`);
      await notifyOne(pool, studentId, "Students", {
        title: "Resit Opportunity",
        message: `You have been given another attempt at "${info.recordset[0]?.title || "an assessment"}". Sign in to the exam to retake it.`,
        type: "exam",
      });
    } catch (e) { console.error("RESIT NOTIFY ERROR:", e.message); }

    res.json({ success: true, message: "Resit granted", attempt_no: nextAttempt, score_policy: policy });
  } catch (err) {
    console.error("GRANT RESIT ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Admin: cancel a resit that was granted but not yet taken.
const cancelResit = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.body.assessment_id);
    const studentId = toInt(req.body.student_id);
    const r = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .query(`
        UPDATE e_assessment_exam_sessions
        SET resit_allowed = 0, status = 'ended', ended_at = GETDATE(),
            attempt_no = CASE WHEN attempt_no > 1 THEN attempt_no - 1 ELSE 1 END
        WHERE e_assessment_id = @aid AND student_id = @sid AND resit_allowed = 1 AND status = 'issued'
      `);
    if (!r.rowsAffected[0]) {
      return res.status(409).json({ message: "No pending resit to cancel (the student may have already started it)" });
    }
    res.json({ success: true, message: "Resit cancelled" });
  } catch (err) {
    console.error("CANCEL RESIT ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Read-only session check used by a locked screen. Unlike /activate it NEVER
// changes the row — the old locked screen polled /activate, and when two
// devices were both waiting, whichever polled second hit the "different
// device" branch and re-locked the session right after the admin freed it.
// `can_resume` is true only once an admin has unlocked it (status 'issued').
const examSessionStatus = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id } = req.body;
    const student_id = req.user?.id;
    if (!token) return res.status(400).json({ message: "token is required" });

    const result = await pool.request()
      .input("token", sql.Char(6), token)
      .input("sid", sql.Int, student_id)
      .query(`SELECT status, device_id, lock_reason FROM e_assessment_exam_sessions WHERE token = @token AND student_id = @sid`);
    if (!result.recordset.length) return res.status(404).json({ message: "Invalid or expired token" });

    const row = result.recordset[0];
    res.json({
      status: row.status,
      locked: row.status === "locked",
      ended: row.status === "ended",
      can_resume: row.status === "issued" || (row.status === "active" && !!device_id && row.device_id === device_id),
      lock_reason: row.lock_reason || null,
    });
  } catch (err) {
    console.error("EXAM SESSION STATUS ERROR:", err);
    res.status(500).json({ message: "Failed to check exam session" });
  }
};

// Student device reports a local lock (too many violations etc.) so the
// session shows as Locked on the admin screen. Before this, those locks
// lived only in the student's browser: the server row stayed 'active', the
// admin saw no Unlock button, and the student could never be released.
const lockExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id, reason, reason_code } = req.body;
    const student_id = req.user?.id;
    if (!token) return res.status(400).json({ message: "token is required" });
    const fullReason = String(reason || "Locked by this device").slice(0, 300);
    const codePrefix = reason_code ? `[${String(reason_code).replace(/[^a-z_]/gi, "").slice(0, 30)}] ` : "";

    const result = await pool.request()
      .input("token", sql.Char(6), token)
      .input("sid", sql.Int, student_id)
      .query(`SELECT id, status, device_id FROM e_assessment_exam_sessions WHERE token = @token AND student_id = @sid`);
    if (!result.recordset.length) return res.status(404).json({ message: "Invalid or expired token" });

    const row = result.recordset[0];
    if (row.status === "ended") return res.json({ success: true, status: "ended" });
    if (row.status === "issued") return res.json({ success: true, status: row.status }); // not bound yet — nothing to lock
    if (row.device_id && device_id && row.device_id !== device_id) {
      return res.status(403).json({ message: "Not the bound device" });
    }

    const doLock = (text) => pool.request()
      .input("id", sql.Int, row.id)
      .input("reason", sql.NVarChar(300), text)
      .query(`
        UPDATE e_assessment_exam_sessions
        SET lock_reason = CASE WHEN status = 'locked' AND lock_reason IS NOT NULL THEN lock_reason ELSE @reason END,
            locked_at   = CASE WHEN status = 'locked' AND locked_at IS NOT NULL THEN locked_at ELSE GETDATE() END,
            status = 'locked'
        WHERE id = @id AND status <> 'ended'
      `);
    try {
      // First lock reason wins: a later event must not overwrite what the admin sees.
      try {
        await doLock(`${codePrefix}${fullReason}`.slice(0, 300));
      } catch (wide) {
        // lock_reason may be a narrower column — keep as much of the reason as fits
        await doLock(`${codePrefix}${fullReason}`.slice(0, 100));
      }
    } catch (e) {
      // lock_reason may be a narrower column than expected — the lock itself
      // matters more than its wording, so retry with a short fixed reason.
      await doLock("Locked by this device");
    }
    res.json({ success: true, status: "locked" });
  } catch (err) {
    console.error("LOCK EXAM SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to lock exam session" });
  }
};

/* ─────────────────────────────────────────────────────────
   DEVICE SESSIONS (Admin > E-Assessments > Device Locks)
   Every exam session in four groups, each with the STEP the
   device has reached:
     not_started → token issued, student hasn't entered (or was
                   unlocked and hasn't resumed yet)
     active      → entered; answering (N of M answered, connection)
     locked      → locked by the device-binding / violation rules
     submitted   → finished (manually or auto-submitted at time up)
   Steps: 1 token issued · 2 entered / device verified ·
          3 answering · 4 submitted
───────────────────────────────────────────────────────── */

// How many questions an autosaved draft ({ "<qid>": value }) has an answer for.
// Essays count when they have text or a table; "<p><br></p>" doesn't.
const countDraftAnswers = (json) => {
  if (!json) return 0;
  let draft;
  try { draft = JSON.parse(json); } catch { return 0; }
  if (!draft || typeof draft !== "object") return 0;
  return Object.values(draft).filter((v) => {
    if (v == null) return false;
    const t = String(v);
    if (/<table\b/i.test(t)) return true;
    return t.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
  }).length;
};

// Heartbeats arrive every few seconds while a device is connected; this is
// how long without one before we call it "no signal".
const HEARTBEAT_STALE_SECONDS = 60;

// Turns a raw session row into the grouped/stepped shape the admin screen shows.
const describeExamSession = (r) => {
  const total = r.total_questions || 0;
  const answered = r.status === "ended" ? (r.submitted_answer_count || 0) : (r.draft_answered_count || 0);
  const hbAge = r.last_heartbeat_age == null ? null : Number(r.last_heartbeat_age);
  const connection = r.status === "active"
    ? (hbAge != null && hbAge <= HEARTBEAT_STALE_SECONDS ? "online" : "no_signal")
    : null;
  const progress = total ? `${answered} of ${total} answered` : `${answered} answered`;

  let group, step, label;
  if (r.status === "ended") {
    group = "submitted"; step = 4;
    label = `Submitted — ${progress}${r.auto_submitted ? " (auto-submitted at time up)" : ""}`;
  } else if (r.status === "locked") {
    group = "locked";
    step = r.activated_at ? 3 : 2;
    label = r.activated_at ? `Locked while answering — ${progress}` : "Locked before starting";
  } else if (r.status === "active") {
    group = "active";
    if (answered === 0) { step = 2; label = "Entered — nothing answered yet"; }
    else if (total && answered >= total) { step = 3; label = `All ${total} answered — hasn't submitted yet`; }
    else { step = 3; label = `Answering — ${progress}`; }
  } else {
    group = "not_started"; step = 1;
    label = r.activated_at ? "Unlocked — waiting to resume"
          : r.resit_allowed ? "Resit granted — hasn't entered yet"
          : "Token issued — hasn't entered yet";
  }

  const { draft_answered_count, last_heartbeat_age, submitted_answer_count, ...rest } = r; // never ship the drafts themselves
  return { ...rest, group, step, step_label: label, answered_count: answered, total_questions: total, connection };
};

// Admin: every exam session (not started / active / locked / submitted) with its
// step and progress, so the screen can group them, count them, search them and
// export each group.
// Short-lived cache + in-flight de-duplication. The Device Locks tab polls this
// endpoint, and the page also fires it on load; when the query was slow each
// poll started ANOTHER copy while the first was still running, the copies
// competed for the same connections, and everything snowballed into the 45s
// ETIMEOUT. Now identical requests inside a few seconds share one query.
const EXAM_SESSIONS_TTL_MS = 5000;
const examSessionsCache = new Map(); // key -> { at, promise }

const queryExamSessions = async (pool, aid) => {
  const request = pool.request();
  if (aid) request.input("aid", sql.Int, aid);
  const result = await request.query(`
      SELECT es.id, es.e_assessment_id, es.student_id, es.token, es.status, es.device_id, es.device_label,
             es.issued_at, es.activated_at, es.last_heartbeat, es.locked_at, es.lock_reason, es.ended_at,
             es.auto_submitted, es.resit_allowed, es.attempt_no,
             st.name AS student_name, st.studentClass AS student_class, st.username AS student_username,
             a.title AS assessment_title, a.subject AS subject_name,
             ISNULL(a.duration_minutes, 30) AS duration_minutes,
             ISNULL(vpc.n, 0) AS photo_count,
             ISNULL(qc.n, 0) AS total_questions,
             sub.id AS submission_id, sub.submitted_at AS submitted_at,
             -- only finished sessions need the submitted-answer count, and DATALENGTH
             -- avoids converting every essay to NVARCHAR(MAX) just to measure it
             CASE WHEN es.status = 'ended' AND sub.id IS NOT NULL THEN
               (SELECT COUNT(*) FROM e_assessment_answers ans
                 WHERE ans.submission_id = sub.id
                   AND (ISNULL(ans.selected_answer, '') <> '' OR DATALENGTH(ans.essay_answer) > 0))
             END AS submitted_answer_count,
             CASE WHEN es.status IN ('active','locked') AND es.activated_at IS NOT NULL
                  THEN ${secondsLeftSql("a", "es")} END AS seconds_left,
             CASE WHEN es.last_heartbeat IS NOT NULL THEN DATEDIFF(SECOND, es.last_heartbeat, GETDATE()) END AS last_heartbeat_age,
             d.answered_count AS draft_answered_count
      FROM e_assessment_exam_sessions es
      LEFT JOIN Students st ON st.id = es.student_id
      LEFT JOIN e_assessments a ON a.id = es.e_assessment_id
      LEFT JOIN e_assessment_submissions sub
             ON sub.e_assessment_id = es.e_assessment_id AND sub.student_id = es.student_id
      LEFT JOIN e_assessment_drafts d
             ON d.e_assessment_id = es.e_assessment_id AND d.student_id = es.student_id
            AND es.status IN ('active','locked')
      -- aggregated once, instead of a correlated COUNT per session row (slow with many students)
      LEFT JOIN (SELECT session_id, COUNT(*) AS n FROM e_assessment_violation_photos GROUP BY session_id) vpc ON vpc.session_id = es.id
      LEFT JOIN (SELECT e_assessment_id, COUNT(*) AS n FROM e_assessment_questions GROUP BY e_assessment_id) qc ON qc.e_assessment_id = es.e_assessment_id
      WHERE (es.status IN ('locked','active','issued') OR (es.status = 'ended' AND sub.id IS NOT NULL))
        ${aid ? "AND es.e_assessment_id = @aid" : ""}
      ORDER BY CASE es.status WHEN 'locked' THEN 0 WHEN 'active' THEN 1 WHEN 'issued' THEN 2 ELSE 3 END,
               ISNULL(es.last_heartbeat, ISNULL(es.ended_at, es.issued_at)) DESC
    `);
  return (result.recordset || []).map(describeExamSession);
};

const getExamSessions = async (req, res) => {
  try {
    const aid = toInt(req.query.assessmentId);
    const key = `${req.dbTenant || "default"}:${aid || 0}`;
    const hit = examSessionsCache.get(key);
    let promise;
    if (hit && Date.now() - hit.at < EXAM_SESSIONS_TTL_MS) {
      promise = hit.promise; // fresh result, or the same query still running
    } else {
      promise = queryExamSessions(req.pool, aid);
      examSessionsCache.set(key, { at: Date.now(), promise });
      promise.catch(() => { if (examSessionsCache.get(key)?.promise === promise) examSessionsCache.delete(key); });
    }
    res.json(await promise);
  } catch (err) {
    console.error("GET EXAM SESSIONS ERROR:", err);
    res.status(500).json([]);
  }
};

// Admin: students who sat down for an exam (a session exists and has ended)
// but have NO submission — e.g. time ran out with nothing saved, or the
// session was closed. They have no row on the submissions tab, so this is
// where an admin finds them to grant a resit.
const getUnsubmittedSessions = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT es.id, es.e_assessment_id, es.student_id, es.status, es.attempt_no,
             es.activated_at, es.ended_at, es.auto_submitted,
             st.name AS student_name, st.studentClass AS student_class,
             a.title AS assessment_title, a.subject AS subject_name
      FROM e_assessment_exam_sessions es
      INNER JOIN e_assessments a ON a.id = es.e_assessment_id
      LEFT JOIN Students st ON st.id = es.student_id
      WHERE es.status = 'ended'
        AND ISNULL(es.resit_allowed, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM e_assessment_submissions s
          WHERE s.e_assessment_id = es.e_assessment_id AND s.student_id = es.student_id
        )
      ORDER BY es.ended_at DESC
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error("GET UNSUBMITTED SESSIONS ERROR:", err);
    res.status(500).json([]);
  }
};

// Admin: unlock — clears device binding so the student can resume on a chosen device
const unlockExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const result = await pool.request().input("id", sql.Int, id).query(`
      UPDATE e_assessment_exam_sessions
      SET status = 'issued', device_id = NULL, device_label = NULL,
          locked_at = NULL, lock_reason = NULL
      WHERE id = @id AND status = 'locked'
    `);
    // Only a locked row can be unlocked — never revive a submitted exam.
    if (!result.rowsAffected[0]) {
      return res.status(409).json({ message: "This session is not locked (it may already be unlocked or finished)" });
    }
    res.json({ success: true, message: "Session unlocked" });
  } catch (err) {
    console.error("UNLOCK EXAM SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Admin: unlock MANY locked sessions at once (e.g. a network blip locked half
// the room). Same effect as unlockExamSession per row — clears the device
// binding so each student can resume on a device of their choice — and, like
// it, only ever touches rows that are currently 'locked'. Must be told what to
// unlock, explicitly: a list of session ids, one assessment, or all:true.
const unlockExamSessionsBulk = async (req, res) => {
  try {
    const pool = req.pool;
    const ids = Array.isArray(req.body?.sessionIds)
      ? [...new Set(req.body.sessionIds.map(toInt).filter(Boolean))]
      : null;
    const aid = toInt(req.body?.assessmentId);
    const all = req.body?.all === true;

    if (ids && ids.length > 2000) return res.status(400).json({ message: "Too many sessions at once (max 2000)" });
    if (!(ids && ids.length) && !aid && !all) {
      return res.status(400).json({ message: "Say what to unlock: sessionIds, assessmentId, or all: true" });
    }

    const request = pool.request();
    let scope = "1 = 1";
    if (ids && ids.length) scope = `id IN (${ids.join(",")})`; // integers only (toInt above) — safe to inline
    else if (aid) { request.input("aid", sql.Int, aid); scope = "e_assessment_id = @aid"; }

    const result = await request.query(`
      UPDATE e_assessment_exam_sessions
      SET status = 'issued', device_id = NULL, device_label = NULL,
          locked_at = NULL, lock_reason = NULL
      WHERE status = 'locked' AND ${scope}
    `);
    const unlocked = result.rowsAffected[0] || 0;
    res.json({ success: true, unlocked, message: unlocked ? `${unlocked} session${unlocked === 1 ? "" : "s"} unlocked` : "Nothing to unlock" });
  } catch (err) {
    console.error("BULK UNLOCK EXAM SESSIONS ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   CAMERA VIOLATION PHOTOS
   Student side: TakeEAssessment.jsx's webcam eye/gaze check no longer
   locks the exam on its own (see the HONEST SCOPE NOTE at the top of
   that file) — instead it silently, continuously uploads a timestamped,
   captioned snapshot from the student's own camera every time their
   eyes are off the screen, for an invigilator to review afterward.
   Admin side: getViolationPhotos lets that review actually happen —
   listed per exam session, newest first, alongside the same student/
   assessment context as getExamSessions above.
========================================================================= */
const uploadViolationPhoto = async (req, res) => {
  try {
    const pool = req.pool;
    const student_id = req.user?.id;
    const { assessment_id, token, device_id, image, reason, screenshot, question_id, question_number, answer_text } = req.body;
    const e_assessment_id = toInt(assessment_id);

    if (!student_id) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!e_assessment_id || !token || !image) {
      return res.status(400).json({ success: false, message: "assessment_id, token and image are required" });
    }
    // Same guardrail as every other exam-session endpoint: an exam-only
    // token is only ever valid for the one assessment it was issued for.
    if (req.user?.examOnly && req.user.examAssessmentId !== e_assessment_id) {
      return res.status(403).json({ success: false, message: "This exam session isn't valid for this assessment" });
    }

    const sessionRes = await pool.request()
      .input("token", sql.Char(6), token)
      .input("sid", sql.Int, student_id)
      .input("aid", sql.Int, e_assessment_id)
      .query(`SELECT id FROM e_assessment_exam_sessions WHERE token = @token AND student_id = @sid AND e_assessment_id = @aid`);
    if (!sessionRes.recordset.length) {
      return res.status(404).json({ success: false, message: "Exam session not found" });
    }
    const sessionId = sessionRes.recordset[0].id;

    let filename;
    try {
      filename = saveViolationPhoto(image);
    } catch (imgErr) {
      return res.status(400).json({ success: false, message: imgErr.message || "Invalid image" });
    }

    // Optional full-screen screenshot taken at the same moment. A bad or
    // missing screenshot never fails the webcam photo.
    let screenshotFile = null;
    if (screenshot) {
      try { screenshotFile = saveViolationPhoto(screenshot); } catch { screenshotFile = null; }
    }

    // Which question the student was on. The question text comes from the
    // database (not trusted from the browser) when the id belongs to this
    // assessment.
    let qId = toInt(question_id) || null;
    let qText = null;
    if (qId) {
      const qRes = await pool.request()
        .input("qid", sql.Int, qId).input("aid", sql.Int, e_assessment_id)
        .query(`SELECT question_text FROM e_assessment_questions WHERE id = @qid AND e_assessment_id = @aid`);
      if (qRes.recordset.length) qText = qRes.recordset[0].question_text;
      else qId = null;
    }

    await pool.request()
      .input("session_id", sql.Int, sessionId)
      .input("e_assessment_id", sql.Int, e_assessment_id)
      .input("student_id", sql.Int, student_id)
      .input("device_id", sql.NVarChar(200), device_id || "")
      .input("reason", sql.NVarChar(300), (reason || "").slice(0, 300))
      .input("photo_url", sql.NVarChar(500), violationPhotoUrlFor(filename))
      .input("screenshot_url", sql.NVarChar(500), screenshotFile ? violationPhotoUrlFor(screenshotFile) : null)
      .input("question_id", sql.Int, qId)
      .input("question_number", sql.Int, toInt(question_number) || null)
      .input("question_text", sql.NVarChar(sql.MAX), qText)
      .input("answer_text", sql.NVarChar(sql.MAX), typeof answer_text === "string" ? answer_text.slice(0, 4000) : null)
      .query(`
        INSERT INTO e_assessment_violation_photos
          (session_id, e_assessment_id, student_id, device_id, reason, photo_url,
           screenshot_url, question_id, question_number, question_text, answer_text)
        VALUES (@session_id, @e_assessment_id, @student_id, @device_id, @reason, @photo_url,
                @screenshot_url, @question_id, @question_number, @question_text, @answer_text)
      `);

    // Fire-and-forget from the student's point of view — this must never
    // slow down or interrupt the exam they're sitting.
    res.json({ success: true });
  } catch (err) {
    console.error("UPLOAD VIOLATION PHOTO ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save violation photo" });
  }
};

// Admin: review the evidence photos captured for one exam session (see
// getExamSessions above for the row this drills into).
const getViolationPhotos = async (req, res) => {
  try {
    const pool = req.pool;
    const sessionId = toInt(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ message: "sessionId is required" });

    const result = await pool.request()
      .input("session_id", sql.Int, sessionId)
      .query(`
        SELECT id, session_id, e_assessment_id, student_id, device_id, reason, photo_url, createdAt,
               screenshot_url, question_id, question_number, question_text, answer_text
        FROM e_assessment_violation_photos
        WHERE session_id = @session_id
        ORDER BY createdAt DESC
      `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error("GET VIOLATION PHOTOS ERROR:", err);
    res.status(500).json([]);
  }
};

/* =========================================================================
   STUDENT — SUBMIT / RESULT
========================================================================= */
const submitEAssessment = async (req, res) => {
  const pool = req.pool;
  try {
    const { assessment_id, answers, token, device_id } = req.body;
    const student_id = req.user?.id;

    if (!assessment_id || !Array.isArray(answers)) {
      return res.status(400).json({ success: false, message: "Invalid submission payload" });
    }
    if (!student_id) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (answers.some((a) => answerTooLarge(a?.essay_answer))) {
      return res.status(413).json({ success: false, message: "One of your answers is too large to submit. Clear some of the drawing and try again." });
    }

    if (req.user?.examOnly && req.user.examAssessmentId !== toInt(assessment_id)) {
      return res.status(403).json({ success: false, message: "This exam session isn't valid for this assessment" });
    }

    // Validate the exam session token/device before accepting the submission
    if (token) {
      const sessionCheck = await pool.request()
        .input("token", sql.Char(6), token)
        .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token`);
      const session = sessionCheck.recordset[0];
      if (session) {
        if (session.status === "locked") {
          return res.status(423).json({ success: false, message: "Exam session is locked. Submission rejected." });
        }
        if (session.device_id && device_id && session.device_id !== device_id) {
          return res.status(423).json({ success: false, message: "Device mismatch. Submission rejected." });
        }
      }
    }

    // One shared code path (utils/examAttempts) writes the submission, so a
    // normal submit, a time-up submit and the server's autosave finalizer
    // all behave identically — including archiving the previous attempt
    // when an admin has granted this student a resit.
    const result = await persistAttempt(pool, {
      assessmentId: Number(assessment_id),
      studentId: Number(student_id),
      answers,
    });

    if (!result.ok) {
      return res.status(409).json({
        success: false,
        message: "You have already submitted this assessment",
        submission_id: result.submissionId,
      });
    }

    return res.status(201).json({ success: true, submission_id: result.submissionId, message: "Assessment submitted successfully" });
  } catch (err) {
    console.error("SUBMIT ERROR:", err);
    return res.status(500).json({ success: false, message: "Submission failed", error: err.message });
  }
};

/* Saved teacher highlights arrive as a JSON string column. Malformed/legacy
   values just mean "no point-by-point data" — never an error for the student. */
const parseStoredHighlights = (raw) => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((h) => h && !h.prior && typeof h.text === "string")
      .map((h) => ({
        id: String(h.id ?? ""),
        text: h.text.slice(0, 500),
        mark: Number(h.mark) || 0,
        status: Number(h.mark) > 0 ? "correct" : "wrong",
        reason: typeof h.reason === "string" ? h.reason.slice(0, 500) : "",
      }));
  } catch {
    return [];
  }
};

/* Student-facing view of an approved AI evaluation: which expected points the
   answer hit, which it missed, and the reason given per criterion. Only
   teacher-approved ("approved"/"adjusted") evaluations are returned. When the
   teacher adjusted the mark, the AI's per-criterion marks are NOT sent (they
   would not add up to the final mark) — just which points were matched. */
const loadReleasedAiPoints = async (pool, submissionId) => {
  const r = await pool.request().input("submissionId", sql.Int, submissionId).query(`
    SELECT e.question_id, e.review_state, e.criteria_json, sv.criteria_json AS scheme_criteria_json
    FROM ai_marking_evaluations e
    LEFT JOIN ai_marking_scheme_versions sv ON sv.id = e.scheme_version_id
    WHERE e.submission_id = @submissionId
      AND e.review_state IN ('approved','adjusted')
      AND e.status IN ('success','needs_review')
  `);
  const out = {};
  for (const row of r.recordset) {
    let stored; let scheme;
    try { stored = JSON.parse(row.criteria_json || "null"); } catch { stored = null; }
    try { scheme = JSON.parse(row.scheme_criteria_json || "[]"); } catch { scheme = []; }
    if (!stored || !Array.isArray(stored.criteria)) continue;
    const schemeById = new Map((Array.isArray(scheme) ? scheme : []).map((c) => [c.criterionId, c]));
    const adjusted = row.review_state === "adjusted";

    out[row.question_id] = {
      adjusted,
      criteria: stored.criteria.map((c) => {
        const s = schemeById.get(c.criterionId) || {};
        const expected = Array.isArray(s.expectedPoints) ? s.expectedPoints : [];
        const matched = new Set(Array.isArray(c.matchedPoints) ? c.matchedPoints : []);
        return {
          label: String(c.label ?? s.label ?? ""),
          max_marks: Number(c.maxMarks ?? s.maxMarks) || 0,
          marks: adjusted ? null : Number(c.marksAwarded) || 0,
          explanation: typeof c.explanation === "string" ? c.explanation.slice(0, 600) : "",
          points: expected.map((text, i) => ({ text: String(text).slice(0, 300), met: matched.has(i) })),
        };
      }),
    };
  }
  return out;
};

const getStudentResult = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);
    const studentId = req.user?.id;

    if (req.user?.examOnly && req.user.examAssessmentId !== assessmentId) {
      return res.status(403).json({ message: "This exam session isn't valid for this assessment" });
    }

    const subResult = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT s.*, a.title AS assessment_title, a.subject AS assessment_subject,
               a.total_marks AS total_marks, t.name AS teacher_name
        FROM e_assessment_submissions s
        LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
        LEFT JOIN Teachers t ON t.id = a.teacher_id
        WHERE s.e_assessment_id = @assessmentId AND s.student_id = @studentId
      `);

    const submission = fixTotalMarks(subResult.recordset[0] || null);
    if (!submission) return res.json({ submission: null, released: false, questions: [] });

    // Marks/answers are only ever shown to the student once the submission
    // has actually been released (see releaseMarks/bulkReleaseMarks) — a
    // submission sitting at 'submitted' or 'marked' means a teacher/admin
    // hasn't signed off on it yet, so no per-question detail goes out,
    // same principle as the exam_password redaction above.
    if (submission.status !== "released") {
      return res.json({ submission, released: false, questions: [] });
    }

    // Full marked-paper breakdown: every question on the paper, this
    // student's own answer, whether it was correct (MCQ) and the marks/
    // remarks a teacher gave it (essay) — mirrors the shape TakeEAssessment
    // shows while sitting the exam (question_text/options/images), just
    // overlaid with the answer + marking outcome instead of blank inputs.
    const questionsResult = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .input("submissionId", sql.Int, submission.id)
      .query(`
        SELECT q.id, q.question_text, q.marks AS max_marks, q.correct_answer, q.question_type,
               o.option_label, o.option_text,
               ans.selected_answer, ans.essay_answer, ans.is_correct, ans.marks_awarded, ans.remarks,
               ans.highlights, ans.highlighted_html, ans.music_annotations, q.model_answer_sheet
        FROM e_assessment_questions q
        LEFT JOIN e_assessment_options o ON q.id = o.question_id
        LEFT JOIN e_assessment_answers ans ON ans.question_id = q.id AND ans.submission_id = @submissionId
        WHERE q.e_assessment_id = @assessmentId
        ORDER BY q.id, o.id
      `);

    const imageResult = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .query(`
        SELECT qi.question_id, qi.id, qi.image_url
        FROM e_assessment_question_images qi
        INNER JOIN e_assessment_questions q ON q.id = qi.question_id
        WHERE q.e_assessment_id = @assessmentId
        ORDER BY qi.question_id, qi.sort_order, qi.id
      `);
    const imagesByQuestion = {};
    imageResult.recordset.forEach((row) => {
      (imagesByQuestion[row.question_id] ||= []).push({ id: row.id, image_url: row.image_url });
    });

    const map = {};
    questionsResult.recordset.forEach((row) => {
      if (!map[row.id]) {
        map[row.id] = {
          id: row.id,
          question_text: row.question_text,
          question_type: row.question_type || "mcq",
          max_marks: row.max_marks,
          correct_answer: row.correct_answer,
          selected_answer: row.selected_answer,
          essay_answer: row.essay_answer,
          is_correct: row.is_correct,
          marks_awarded: row.marks_awarded,
          remarks: row.remarks,
          // Teacher's point-by-point marking of an essay: `highlights` is the
          // saved list ({id,text,mark,status?}) and `highlighted_html` is the
          // answer with the <mark> spans + ✓/✗ badges baked in. The client
          // sanitises the HTML before rendering it.
          highlights: parseStoredHighlights(row.highlights),
          highlighted_html: row.highlighted_html || null,
          // Music paper: the marker's overlays on the student's drawing, and the
          // model answer — this endpoint only runs once marks are released.
          music_annotations: parseMusicAnnotations(row.music_annotations),
          model_answer_sheet: row.model_answer_sheet || null,
          ai_points: null,
          options: [],
          images: imagesByQuestion[row.id] || [],
        };
      }
      if (row.option_label) {
        map[row.id].options.push({ option_label: row.option_label, option_text: row.option_text });
      }
    });

    // Per-point breakdown for answers that were marked with AI assistance and
    // then signed off by the teacher (approved / adjusted). Best-effort: a
    // school without the AI-marking tables, or any failure here, must never
    // stop the student seeing their paper.
    try {
      const aiPoints = await loadReleasedAiPoints(pool, submission.id);
      for (const [qid, pts] of Object.entries(aiPoints)) {
        if (map[qid]) map[qid].ai_points = pts;
      }
    } catch (aiErr) {
      console.warn("GET RESULT: AI point breakdown unavailable:", aiErr.message);
    }

    res.json({ submission, released: true, questions: Object.values(map) });
  } catch (err) {
    console.error("GET RESULT ERROR:", err);
    res.status(500).json({ message: "Failed to load result" });
  }
};

/* =========================================================================
   ADMIN — REVIEW / TOGGLE / STATS
========================================================================= */
const getPendingAssessments = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT ea.*, t.name AS teacher_name, c.name AS class_name
      FROM e_assessments ea
      LEFT JOIN Teachers t ON ea.teacher_id = t.id
      LEFT JOIN Classes c ON ea.class_id = c.id
      WHERE ea.status = 'pending'
      ORDER BY ea.id DESC
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error("GET PENDING ERROR:", err);
    res.status(500).json([]);
  }
};

const reviewAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);
    const { status, admin_comment } = req.body;
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid status" });

    const existing = await pool.request().input("id", sql.Int, assessmentId)
      .query(`SELECT teacher_id, title FROM e_assessments WHERE id = @id`);

    await pool.request()
      .input("id", sql.Int, assessmentId)
      .input("status", sql.NVarChar, status)
      .input("admin_comment", sql.NVarChar, admin_comment || "")
      .query(`UPDATE e_assessments SET status = @status, admin_comment = @admin_comment WHERE id = @id`);

    if (existing.recordset.length && existing.recordset[0].teacher_id) {
      const { teacher_id, title } = existing.recordset[0];
      await notifyOne(pool, teacher_id, "Teachers", {
        title: status === "approved" ? "Assessment Approved" : "Assessment Rejected",
        message: status === "approved"
          ? `Your assessment "${title}" was approved and can now be activated for students.`
          : `Your assessment "${title}" was rejected.${admin_comment ? ` Reason: ${admin_comment}` : ""}`,
        type: "exam",
      });
    }

    res.json({ success: true, message: `Assessment ${status}` });
  } catch (err) {
    console.error("REVIEW ERROR:", err);
    res.status(500).json({ message: "Review failed" });
  }
};

// Admin switch: restrict an assessment to Windows/Mac laptops & desktops.
// Takes an explicit { enabled: true|false } (never a blind flip) and is
// allowed at any time — including while the exam is live; students already
// on a phone/tablet are rejected on their next heartbeat/autosave.
// Admin: browse / export the E-Assessment activity log (who did what, when).
const getActivityLog = async (req, res) => {
  try {
    const wantsCsv = String(req.query.format || "").toLowerCase() === "csv";
    const { rows, total, page, limit } = await queryActivityLog(req.pool, req.query, { forCsv: wantsCsv });

    if (!wantsCsv) return res.json({ success: true, rows, total, page, limit });

    const esc = (v) => {
      let t = v == null ? "" : String(v);
      if (/^[=+\-@]/.test(t)) t = "'" + t; // stop spreadsheet formula injection
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ["Time","Portal","Role","Actor","Username","Action","Outcome","HTTP","Assessment","Student","IP","Device","Details"];
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push([
        r.created_at ? new Date(r.created_at).toISOString() : "",
        r.portal, r.actor_role, r.actor_name, r.actor_username, r.action, r.outcome, r.http_status,
        r.assessment_title || r.assessment_id, r.student_name || r.student_username || r.student_id,
        r.ip, r.device, r.details,
      ].map(esc).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="e-assessment-activity-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send("\uFEFF" + lines.join("\r\n"));
  } catch (err) {
    console.error("GET ACTIVITY LOG ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load the activity log" });
  }
};

/* =========================================================================
   TRAINEE ACCESS + OPEN/CLOSE WINDOW (Admin > E-Assessments > "Who can sit")
   GET  /admin/:id/access -> { restrict_students, available_from,
        available_until, allowed_student_ids, students: [...] }
        (students = active trainees in the assessment's class / year)
   PUT  /admin/:id/access  body { restrict_students: bool,
        student_ids?: number[], available_from?: string|null,
        available_until?: string|null }
        Times are East Africa Time wall-clock ("YYYY-MM-DDTHH:mm").
========================================================================= */
const getAccessSettings = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });

    const a = await pool.request().input("id", sql.Int, id).query(`
      SELECT ISNULL(restrict_students, 0) AS restrict_students, available_from, available_until
      FROM e_assessments WHERE id = @id`);
    if (!a.recordset.length) return res.status(404).json({ message: "Assessment not found" });

    const pickable = await pool.request().input("aid", sql.Int, id).query(`
      SELECT st.id, st.name, st.username, st.studentClass
      FROM e_assessments ea
      INNER JOIN Students st ON (
           st.studentClass IN (SELECT c.name FROM Classes c WHERE c.id = ea.class_id)
        OR (ea.year_of_study IS NOT NULL AND st.yearOfStudy = ea.year_of_study)
      )
      WHERE ea.id = @aid
        AND (st.status IS NULL OR LTRIM(RTRIM(st.status)) = '' OR LOWER(st.status) = 'active')
      ORDER BY st.studentClass, st.name`);
    const allowed = await pool.request().input("aid", sql.Int, id)
      .query(`SELECT student_id FROM e_assessment_allowed_students WHERE e_assessment_id = @aid`);

    res.json({
      success: true,
      restrict_students: !!a.recordset[0].restrict_students,
      available_from: a.recordset[0].available_from,
      available_until: a.recordset[0].available_until,
      allowed_student_ids: allowed.recordset.map((r) => r.student_id),
      students: pickable.recordset,
    });
  } catch (err) {
    console.error("GET ACCESS SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to load the access settings" });
  }
};

const setAccessSettings = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    const body = req.body || {};
    if (typeof body.restrict_students !== "boolean") {
      return res.status(400).json({ message: "`restrict_students` (true/false) is required" });
    }
    const exists = await pool.request().input("id", sql.Int, id).query(`SELECT id FROM e_assessments WHERE id = @id`);
    if (!exists.recordset.length) return res.status(404).json({ message: "Assessment not found" });

    const touchesWindow = "available_from" in body || "available_until" in body;
    let from = null, until = null;
    if (touchesWindow) {
      from = toWallClock(body.available_from);
      until = toWallClock(body.available_until);
      if (body.available_from && !from) return res.status(400).json({ message: "The opening date/time isn't valid" });
      if (body.available_until && !until) return res.status(400).json({ message: "The closing date/time isn't valid" });
      if (from && until && until <= from) {
        return res.status(400).json({ message: "The closing time must be after the opening time" });
      }
      if (from || until) {
        // Assessments run by a Main Examination timetable are opened/closed by
        // that schedule, so a second window here would just conflict with it.
        const linked = await pool.request().input("id", sql.Int, id).query(
          `SELECT TOP 1 1 AS x FROM exam_subject_sessions WHERE e_assessment_id = @id AND status <> 'draft'`);
        if (linked.recordset.length) {
          return res.status(409).json({ message: "This assessment is scheduled as a Main Examination subject. Set its times from the Main Examination timetable instead." });
        }
      }
    }

    const ids = Array.isArray(body.student_ids)
      ? [...new Set(body.student_ids.map(toInt).filter(Boolean))]
      : null;
    if (body.restrict_students && ids && ids.length === 0) {
      return res.status(400).json({ message: "Pick at least one trainee, or choose \"All active trainees\"." });
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const rq = new sql.Request(tx).input("id", sql.Int, id).input("r", sql.Bit, body.restrict_students ? 1 : 0);
      if (touchesWindow) {
        rq.input("from", sql.DateTime, from).input("until", sql.DateTime, until);
        await rq.query(`
          UPDATE e_assessments
          SET restrict_students = @r, available_from = @from, available_until = @until,
              schedule_opened_at = NULL, schedule_closed_at = NULL
          WHERE id = @id`);
      } else {
        await rq.query(`UPDATE e_assessments SET restrict_students = @r WHERE id = @id`);
      }
      if (ids) {
        await new sql.Request(tx).input("id", sql.Int, id)
          .query(`DELETE FROM e_assessment_allowed_students WHERE e_assessment_id = @id`);
        for (const sid of ids) {
          await new sql.Request(tx).input("id", sql.Int, id).input("sid", sql.Int, sid)
            .query(`INSERT INTO e_assessment_allowed_students (e_assessment_id, student_id) VALUES (@id, @sid)`);
        }
      }
      await tx.commit();
    } catch (txErr) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      throw txErr;
    }

    const fresh = await pool.request().input("id", sql.Int, id).query(`
      SELECT ISNULL(restrict_students, 0) AS restrict_students, available_from, available_until,
             (SELECT COUNT(*) FROM e_assessment_allowed_students WHERE e_assessment_id = @id) AS allowed_count
      FROM e_assessments WHERE id = @id`);
    const f = fresh.recordset[0];
    res.json({
      success: true,
      restrict_students: !!f.restrict_students,
      available_from: f.available_from,
      available_until: f.available_until,
      allowed_count: f.allowed_count,
      message: "Trainee access and schedule saved.",
    });
  } catch (err) {
    console.error("SET ACCESS SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to save the access settings" });
  }
};

/* =========================================================================
   ACTIVATE / DEACTIVATE STUDENTS (Admin > E-Assessments > "Students" tab)
   GET /admin/students-activation -> every student with ALL their details
        (for searching) + `deactivated` / `account_active` flags.
   PUT /admin/students-activation/status  body { student_ids: number[], active: bool }
        active=false -> the student can no longer see / log in to / start ANY
                        e-assessment (their portal account is untouched)
        active=true  -> access restored
   Enforced everywhere access is checked (exam login, the student's list,
   starting/resuming a session). Someone already typing keeps their open page
   until they refresh/resume — they cannot start or resume after that.
========================================================================= */
const getStudentsActivation = async (req, res) => {
  try {
    const r = await req.pool.request().query(`
      SELECT st.id, st.name, st.admissionNo, st.username, st.studentClass, st.yearOfStudy,
             st.gender, st.email, st.phone, st.assessmentNumber, st.status,
             CASE WHEN bz.id IS NULL THEN 0 ELSE 1 END AS deactivated
      FROM Students st
      LEFT JOIN e_assessment_blocked_students bz ON bz.student_id = st.id
      ORDER BY st.studentClass, st.name`);
    const students = r.recordset.map((s) => ({
      ...s,
      deactivated: !!s.deactivated,
      account_active: isActiveStudent(s.status),
    }));
    res.json({ success: true, students });
  } catch (err) {
    console.error("GET STUDENTS ACTIVATION ERROR:", err);
    res.status(500).json({ message: "Failed to load the students" });
  }
};

const setStudentsActivation = async (req, res) => {
  try {
    const pool = req.pool;
    const body = req.body || {};
    if (typeof body.active !== "boolean") {
      return res.status(400).json({ message: "`active` (true/false) is required" });
    }
    const ids = Array.isArray(body.student_ids)
      ? [...new Set(body.student_ids.map(toInt).filter(Boolean))]
      : [];
    if (!ids.length) return res.status(400).json({ message: "Pick at least one student" });
    if (ids.length > 5000) return res.status(400).json({ message: "Too many students at once (max 5000)" });

    const by = toInt(req.user?.id) || null;
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const sid of ids) {
        const rq = new sql.Request(tx).input("sid", sql.Int, sid);
        if (body.active) {
          await rq.query(`DELETE FROM e_assessment_blocked_students WHERE student_id = @sid`);
        } else {
          await rq.input("by", sql.Int, by).query(`
            IF NOT EXISTS (SELECT 1 FROM e_assessment_blocked_students WHERE student_id = @sid)
              INSERT INTO e_assessment_blocked_students (student_id, deactivated_by) VALUES (@sid, @by)`);
        }
      }
      await tx.commit();
    } catch (txErr) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      throw txErr;
    }

    res.json({
      success: true,
      active: body.active,
      student_ids: ids,
      message: `${ids.length} student${ids.length === 1 ? "" : "s"} ${body.active ? "activated" : "deactivated"} for all assessments.`,
    });
  } catch (err) {
    console.error("SET STUDENTS ACTIVATION ERROR:", err);
    res.status(500).json({ message: "Failed to update the students" });
  }
};

const setDesktopOnly = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ message: "`enabled` (true/false) is required" });
    }
    const enabled = req.body.enabled;

    const r = await pool.request()
      .input("id", sql.Int, id)
      .input("v", sql.Bit, enabled ? 1 : 0)
      .query(`UPDATE e_assessments SET desktop_only = @v WHERE id = @id; SELECT @@ROWCOUNT AS n;`);
    if (!r.recordset[0]?.n) return res.status(404).json({ message: "Assessment not found" });

    invalidateDesktopOnlyCache(req.user?.tenant, id); // this server instance sees it instantly
    res.json({
      success: true,
      desktop_only: enabled,
      message: enabled
        ? "Desktop-only is ON — phones and tablets are now blocked from this exam."
        : "Desktop-only is OFF — any device can take this exam.",
    });
  } catch (err) {
    console.error("SET DESKTOP-ONLY ERROR:", err);
    res.status(500).json({ message: "Failed to update the device restriction" });
  }
};


/* =========================================================================
   SAFE EXAM BROWSER switch + allowed keys (see utils/sebRestriction.js)
   Body: { enabled?: boolean, keys?: string }  — keys = one Config Key /
   Browser Exam Key (64 hex chars) per line; "" clears them.
========================================================================= */
const setSebSettings = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });

    const hasEnabled = typeof req.body?.enabled === "boolean";
    const hasKeys = typeof req.body?.keys === "string";
    if (!hasEnabled && !hasKeys) return res.status(400).json({ message: "Send `enabled` (true/false) and/or `keys` (text)" });

    let keysValue = null;
    if (hasKeys) {
      const { keys, invalid } = parseSebKeys(req.body.keys);
      if (invalid.length) {
        return res.status(400).json({ message: `Each key must be 64 hexadecimal characters. Not valid: ${invalid.slice(0, 3).map((k) => k.slice(0, 12) + "…").join(", ")}` });
      }
      if (keys.length > 10) return res.status(400).json({ message: "At most 10 keys per assessment." });
      keysValue = keys.length ? keys.join("\n") : null;
    }

    const sets = [];
    const request = pool.request().input("id", sql.Int, id);
    if (hasEnabled) { sets.push("require_seb = @en"); request.input("en", sql.Bit, req.body.enabled ? 1 : 0); }
    if (hasKeys) { sets.push("seb_keys = @keys"); request.input("keys", sql.NVarChar(sql.MAX), keysValue); }

    const r = await request.query(
      `UPDATE e_assessments SET ${sets.join(", ")} WHERE id = @id;
       SELECT @@ROWCOUNT AS n;
       SELECT ISNULL(require_seb, 0) AS require_seb, seb_keys FROM e_assessments WHERE id = @id;`
    );
    if (!r.recordsets[0][0]?.n) return res.status(404).json({ message: "Assessment not found" });

    invalidateSebCache(req.user?.tenant, id);
    const row = r.recordsets[1][0] || {};
    res.json({
      success: true,
      require_seb: !!row.require_seb,
      seb_keys: row.seb_keys || "",
      message: row.require_seb
        ? (row.seb_keys ? "Safe Exam Browser is REQUIRED — only SEB with a matching key can take this exam." : "Safe Exam Browser is REQUIRED, but no key is saved yet — only a basic check is applied. Add a Config Key for real protection.")
        : "Safe Exam Browser is not required for this assessment.",
    });
  } catch (err) {
    console.error("SET SEB SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to update the Safe Exam Browser setting" });
  }
};

/* =========================================================================
   EXAM SECURITY SWITCHES (per assessment)
   setSecuritySettings — admin/teacher turns individual security features
                         ON/OFF for one assessment. Partial updates allowed.
   getSecuritySettings — the exam page reads the switches before the exam
                         starts (student, exam-only token for THIS exam) and
                         the admin page can read them too.
   Unknown/NULL values are treated as ON (strict) everywhere.
========================================================================= */
const SECURITY_FIELDS = ["require_camera", "require_screen_share", "require_fullscreen", "lock_on_violations"];

const securityFromRow = (row) => {
  const out = {};
  for (const k of SECURITY_FIELDS) out[k] = row && row[k] != null ? !!row[k] : true;
  return out;
};

const setSecuritySettings = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });

    const updates = SECURITY_FIELDS.filter((k) => k in (req.body || {}));
    if (!updates.length) return res.status(400).json({ message: "Send at least one of: " + SECURITY_FIELDS.join(", ") });
    for (const k of updates) {
      if (typeof req.body[k] !== "boolean") return res.status(400).json({ message: `\`${k}\` must be true or false` });
    }

    const request = pool.request().input("id", sql.Int, id);
    updates.forEach((k) => request.input(k, sql.Bit, req.body[k] ? 1 : 0));
    const r = await request.query(
      `UPDATE e_assessments SET ${updates.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id;
       SELECT @@ROWCOUNT AS n;
       SELECT ${SECURITY_FIELDS.join(", ")} FROM e_assessments WHERE id = @id;`
    );
    if (!r.recordsets[0][0]?.n) return res.status(404).json({ message: "Assessment not found" });

    res.json({ success: true, security: securityFromRow(r.recordsets[1][0]), message: "Security settings updated." });
  } catch (err) {
    console.error("SET SECURITY SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to update the security settings" });
  }
};

const getSecuritySettings = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });

    // A student may only read the switches of the exam their exam-only token is scoped to.
    if (req.user?.role === "student" && (!req.user.examOnly || req.user.examAssessmentId !== id)) {
      return res.status(403).json({ message: "Not allowed for this assessment." });
    }

    const r = await pool.request().input("id", sql.Int, id)
      .query(`SELECT ${SECURITY_FIELDS.join(", ")} FROM e_assessments WHERE id = @id`);
    if (!r.recordset.length) return res.status(404).json({ message: "Assessment not found" });
    res.json({ success: true, security: securityFromRow(r.recordset[0]) });
  } catch (err) {
    console.error("GET SECURITY SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to load the security settings" });
  }
};

/* =========================================================================
   MUSIC PAPER SWITCH
   Identifies a paper as a Music paper (answers need drawing: staves, notes,
   rests). When ON, students get the drawing pad on this assessment's essay
   questions. Allowed for admin/sub_admin and for teachers who own / set
   questions for the assessment (same gate as editing its questions).
   Can be flipped at any time; students pick it up on their next page load.
========================================================================= */
const setMusicPaper = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ message: "`enabled` (true/false) is required" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, id);
    if (!permission.ok) return res.status(permission.status).json({ message: permission.message });

    const enabled = req.body.enabled;
    const r = await pool.request()
      .input("id", sql.Int, id)
      .input("v", sql.Bit, enabled ? 1 : 0)
      .query(`UPDATE e_assessments SET music_paper = @v WHERE id = @id; SELECT @@ROWCOUNT AS n;`);
    if (!r.recordset[0]?.n) return res.status(404).json({ message: "Assessment not found" });

    res.json({
      success: true,
      music_paper: enabled,
      message: enabled
        ? "Music paper is ON — students get the drawing pad on the essay questions."
        : "Music paper is OFF — students answer with the normal text box only.",
    });
  } catch (err) {
    console.error("SET MUSIC-PAPER ERROR:", err);
    res.status(500).json({ message: "Failed to update the music paper setting" });
  }
};


/* =========================================================================
   REJECTED DEVICES + PER-DEVICE ALLOW-LIST (Desktop-only switch)
   getDeviceAccess  — every phone/tablet the switch rejected, with student,
                      assessment, platform (Android/iPhone/...), attempts.
   setDeviceAccess  — "Allow" / "Revoke" one of those devices. Allowed
                      devices pass the Desktop-only check for that student +
                      assessment (see utils/deviceRestriction.js).
========================================================================= */
const getDeviceAccess = async (req, res) => {
  try {
    const pool = req.pool;
    const request = pool.request();
    const where = [];
    const status = String(req.query.status || "").toLowerCase();
    if (status === "blocked" || status === "allowed") { request.input("status", sql.NVarChar(10), status); where.push("d.status = @status"); }
    const aid = toInt(req.query.assessmentId);
    if (aid) { request.input("aid", sql.Int, aid); where.push("d.e_assessment_id = @aid"); }
    const platform = String(req.query.platform || "").toLowerCase().replace(/[^a-z]/g, "");
    if (platform) { request.input("platform", sql.NVarChar(30), platform); where.push("d.platform = @platform"); }
    const r = await request.query(`
      SELECT TOP 500 d.id, d.e_assessment_id, d.student_id, d.device_key, d.platform, d.user_agent, d.ip, d.reason,
             d.attempts, d.first_seen, d.last_seen, d.status, d.allowed_at,
             st.name AS student_name, st.username AS student_username, st.studentClass AS student_class,
             a.title AS assessment_title, ISNULL(a.desktop_only, 0) AS desktop_only,
             us.name AS allowed_by_name
      FROM e_assessment_device_access d
      LEFT JOIN Students st ON st.id = d.student_id
      LEFT JOIN e_assessments a ON a.id = d.e_assessment_id
      LEFT JOIN Users us ON us.id = d.allowed_by
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY CASE d.status WHEN 'blocked' THEN 0 ELSE 1 END, d.last_seen DESC
    `);
    res.json(r.recordset || []);
  } catch (err) {
    console.error("GET DEVICE ACCESS ERROR:", err);
    res.status(500).json([]);
  }
};

const setDeviceAccess = (allow) => async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid device record" });
    const r = await pool.request()
      .input("id", sql.Int, id)
      .input("status", sql.NVarChar(10), allow ? "allowed" : "blocked")
      .input("by", sql.Int, allow ? (req.user?.id ?? null) : null)
      .query(`
        UPDATE e_assessment_device_access
        SET status = @status, allowed_by = @by, allowed_at = CASE WHEN @status = 'allowed' THEN GETDATE() ELSE NULL END
        WHERE id = @id;
        SELECT e_assessment_id FROM e_assessment_device_access WHERE id = @id;
      `);
    if (!r.recordset.length) return res.status(404).json({ message: "Device record not found" });
    req._auditAssessmentId = r.recordset[0].e_assessment_id; // so the activity log names the exam
    invalidateDeviceAccessCache(); // this server instance applies it instantly
    res.json({
      success: true,
      status: allow ? "allowed" : "blocked",
      message: allow
        ? "Device allowed — the student can now use it for this exam (they may need to press Try again)."
        : "Device blocked again.",
    });
  } catch (err) {
    console.error("SET DEVICE ACCESS ERROR:", err);
    res.status(500).json({ message: "Failed to update the device" });
  }
};
const allowDevice = setDeviceAccess(true);
const revokeDevice = setDeviceAccess(false);


/* Printable register (school logo + header) of the students who did this
   assessment and those who didn't — see utils/eAssessmentAttendance.js. */
const downloadAttendancePdf = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    const out = await generateAttendancePdf(req.pool, id, req.query.tz);
    if (!out) return res.status(404).json({ message: "Assessment not found" });
    sendPdfBuffer(res, out.buffer, out.filename);
  } catch (err) {
    console.error("ATTENDANCE PDF ERROR:", err);
    res.status(500).json({ message: "Could not create the attendance PDF" });
  }
};

const toggleEAssessmentActive = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const current = await pool.request().input("id", sql.Int, id)
      .query(`SELECT active_status, class_id, year_of_study, title FROM e_assessments WHERE id = @id`);
    if (!current.recordset.length) return res.status(404).json({ message: "Assessment not found" });

    // Phase 6 — Main Examination integration guard: once an assessment is
    // attached to a Main Examination subject session (mainExams routes'
    // attachAssessment), its active_status is owned by the exam scheduler
    // (utils/examScheduler.js), which flips it automatically on the
    // published schedule. Letting the old manual Start/Stop button here
    // fight that would let an admin either open an exam before its
    // scheduled time or close one the scheduler just opened. A subject
    // session that's still 'draft' (never published) hasn't handed control
    // over yet, so manual toggling is still fine at that stage.
    const linkedSession = await pool.request().input("id", sql.Int, id)
      .query(`
        SELECT TOP 1 main_examination_id, status FROM exam_subject_sessions
        WHERE e_assessment_id = @id AND status <> 'draft'
      `);
    if (linkedSession.recordset.length) {
      return res.status(409).json({
        message: "This assessment is scheduled as a Main Examination subject. Manage its Start/Stop from the Main Examination's timetable instead.",
        main_examination_id: linkedSession.recordset[0].main_examination_id,
      });
    }

    const { class_id, year_of_study, title } = current.recordset[0];
    const next = current.recordset[0].active_status === "Active" ? "Inactive" : "Active";
    await pool.request().input("id", sql.Int, id).input("active_status", sql.NVarChar(20), next)
      .query(`UPDATE e_assessments
              SET active_status = @active_status${next === "Active" ? ", started_at = GETDATE()" : ""}
              WHERE id = @id`);

    if (next === "Active" && (class_id || year_of_study)) {
      // A year-wide assessment (year_of_study set) targets every student
      // in that year of study directly via Students.yearOfStudy, rather
      // than the single class_id it also carries for backward-compat
      // display — that class_id is only a "representative" class, not
      // the whole audience, once year_of_study is set.
      // Only active students who are actually permitted to sit it.
      const students = { recordset: await getPermittedStudents(pool, id) };
      await notifyUsers(
        pool,
        (students.recordset || []).map((s) => ({ id: s.id, source: "Students" })),
        {
          title: "Assessment Now Open",
          message: `"${title}" is now open — you can take it from your E-Assessments page.`,
          type: "exam",
        }
      );
    }

    res.json({ success: true, active_status: next });
  } catch (err) {
    console.error("TOGGLE ACTIVE ERROR:", err);
    res.status(500).json({ message: "Toggle failed" });
  }
};

const getEAssessmentQuickStats = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT
        COUNT(*) AS submitted_count,
        SUM(CASE WHEN status = 'marked' OR score IS NOT NULL THEN 1 ELSE 0 END) AS marked_count,
        SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) AS released_count,
        SUM(CASE WHEN remark_requested = 1 THEN 1 ELSE 0 END) AS remark_count,
        AVG(CAST(score AS FLOAT)) AS average_score,
        MAX(score) AS highest_score,
        MIN(score) AS lowest_score
      FROM e_assessment_submissions
      WHERE e_assessment_id = @id
    `);
    const row = result.recordset[0] || {};

    res.json({
      submitted_count: row.submitted_count || 0,
      marked_count: row.marked_count || 0,
      released_count: row.released_count || 0,
      remark_count: row.remark_count || 0,
      average_score: row.average_score != null ? Math.round((Number(row.average_score) + Number.EPSILON) * 100) / 100 : null,
      highest_score: row.highest_score,
      lowest_score: row.lowest_score,
    });
  } catch (err) {
    console.error("QUICK STATS ERROR:", err);
    res.status(500).json({ message: "Failed to get stats" });
  }
};

/* =========================================================================
   CLASSES / SUBJECTS / TEACHERS
========================================================================= */
const getClasses = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name FROM Classes ORDER BY name ASC`);
    res.json(result.recordset.map((c) => ({ id: c.id, name: c.name, class_id: c.id, class_name: c.name })));
  } catch (err) {
    console.error("GET CLASSES ERROR:", err);
    res.status(500).json([]);
  }
};

const getSubjects = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name FROM Subjects ORDER BY name ASC`);
    res.json(result.recordset.map((s) => ({ id: s.id, name: s.name, subject_name: s.name })));
  } catch (err) {
    console.error("GET SUBJECTS ERROR:", err);
    res.status(500).json([]);
  }
};

const getTeachers = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name, email, subject, staffId FROM Teachers ORDER BY name ASC`);
    res.json(result.recordset);
  } catch (err) {
    console.error("GET TEACHERS ERROR:", err);
    res.status(500).json([]);
  }
};

const assignTeacher = async (req, res) => {
  try {
    const pool = req.pool;
    const { teacher_id, subject_id, class_id } = req.body;
    if (!teacher_id || !subject_id || !class_id) return res.status(400).json({ message: "Missing fields" });

    const exists = await pool.request()
      .input("teacher_id", sql.Int, teacher_id).input("subject_id", sql.Int, subject_id).input("class_id", sql.Int, class_id)
      .query(`SELECT id FROM TeacherSubjects WHERE teacher_id = @teacher_id AND subject_id = @subject_id AND class_id = @class_id`);
    if (exists.recordset.length > 0) return res.status(400).json({ message: "Teacher already assigned" });

    await pool.request()
      .input("teacher_id", sql.Int, teacher_id).input("subject_id", sql.Int, subject_id).input("class_id", sql.Int, class_id)
      .query(`INSERT INTO TeacherSubjects (teacher_id, subject_id, class_id) VALUES (@teacher_id, @subject_id, @class_id)`);

    const names = await pool.request()
      .input("subject_id", sql.Int, subject_id).input("class_id", sql.Int, class_id)
      .query(`
        SELECT (SELECT name FROM Subjects WHERE id = @subject_id) AS subject_name,
               (SELECT name FROM Classes  WHERE id = @class_id)  AS class_name
      `);
    const { subject_name, class_name } = names.recordset[0] || {};

    await notifyOne(pool, teacher_id, "Teachers", {
      title: "New Class Allocation",
      message: `You've been allocated to mark ${subject_name || "a subject"} for ${class_name || "a class"}.`,
      type: "allocation",
    });

    res.json({ success: true, message: "Teacher assigned successfully" });
  } catch (err) {
    console.error("ASSIGN TEACHER ERROR:", err);
    res.status(500).json({ message: "Assignment failed" });
  }
};


/* Assign MANY teachers to MANY subjects across MANY classes in one go (the
   "select all teachers / all subjects / all classes" option on the admin
   screen). Creates every missing (teacher, subject, class) row in a single
   statement and skips the ones that already exist, so it is safe to run
   twice. Each affected teacher gets ONE notification, not one per row. */
const assignTeachersBulk = async (req, res) => {
  try {
    const pool = req.pool;
    const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const teacherIds = ints(req.body.teacher_ids);
    const subjectIds = ints(req.body.subject_ids);
    const classIds = ints(req.body.class_ids);
    if (!teacherIds.length || !subjectIds.length || !classIds.length) {
      return res.status(400).json({ message: "Pick at least one teacher, one subject and one class" });
    }
    const combos = teacherIds.length * subjectIds.length * classIds.length;
    if (combos > 20000) {
      return res.status(400).json({ message: `That would create ${combos} assignments. Please narrow the selection (limit 20,000).` });
    }
    // Only validated integers are inlined (never user text).
    const r = await pool.request().query(`
      INSERT INTO TeacherSubjects (teacher_id, subject_id, class_id)
      OUTPUT inserted.id, inserted.teacher_id, inserted.subject_id, inserted.class_id
      SELECT t.id, s.id, c.id
      FROM Teachers t CROSS JOIN Subjects s CROSS JOIN Classes c
      WHERE t.id IN (${teacherIds.join(",")}) AND s.id IN (${subjectIds.join(",")}) AND c.id IN (${classIds.join(",")})
        AND NOT EXISTS (SELECT 1 FROM TeacherSubjects x WHERE x.teacher_id = t.id AND x.subject_id = s.id AND x.class_id = c.id)
    `);
    const perTeacher = {};
    for (const row of r.recordset || []) perTeacher[row.teacher_id] = (perTeacher[row.teacher_id] || 0) + 1;
    const created = Object.values(perTeacher).reduce((a, b) => a + b, 0);

    for (const [tid, count] of Object.entries(perTeacher)) {
      try {
        await notifyOne(pool, Number(tid), "Teachers", {
          title: "New Class Allocation",
          message: `You've been allocated ${count} new subject/class assignment${count === 1 ? "" : "s"} to mark.`,
          type: "allocation",
        });
      } catch (_) { /* a failed notification must not undo the assignments */ }
    }
    const batchId = await safeRecord(pool, {
      kind: "teacher_subject", summary: `Assigned ${created} teacher/subject/class combination(s) to ${Object.keys(perTeacher).length} teacher(s)`, userId: req.user?.id,
      changes: (r.recordset || []).map((x) => ({ kind: "ts_added", target_id: x.id, teacher_id: x.teacher_id, subject_id: x.subject_id, class_id: x.class_id })),
    });
    res.json({ success: true, created, skipped: combos - created, teachers: Object.keys(perTeacher).length, batch_id: batchId });
  } catch (err) {
    console.error("ASSIGN TEACHERS BULK ERROR:", err);
    res.status(500).json({ message: "Assignment failed" });
  }
};

const getAssignedTeachers = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT ts.id, ts.teacher_id, t.name AS teacher_name, t.email, t.staffId,
             ts.subject_id, s.name AS subject_name, ts.class_id, c.name AS class_name
      FROM TeacherSubjects ts
      LEFT JOIN Teachers t ON ts.teacher_id = t.id
      LEFT JOIN Subjects s ON ts.subject_id = s.id
      LEFT JOIN Classes c ON ts.class_id = c.id
      ORDER BY t.name ASC, c.name ASC
    `);
    res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    console.error("GET ASSIGNED TEACHERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch assigned teachers" });
  }
};

const deleteAssignments = async (req, res) => {
  try {
    const pool = req.pool;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No ids provided" });

    const wanted = assignmentEngine.ints(ids);
    // remember what is being removed so it can be put back with Undo
    const gone = [];
    for (const part of (function* () { for (let i = 0; i < wanted.length; i += 1000) yield wanted.slice(i, i + 1000); })()) {
      const r = await pool.request().query(`SELECT id, teacher_id, subject_id, class_id FROM TeacherSubjects WHERE id IN (${part.join(",")})`);
      gone.push(...(r.recordset || []));
    }
    for (const id of ids) {
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM TeacherSubjects WHERE id = @id`);
    }
    const batchId = await safeRecord(pool, {
      kind: "teacher_subject", summary: `Removed ${gone.length} teacher/subject/class assignment(s)`, userId: req.user?.id,
      changes: gone.map((x) => ({ kind: "ts_removed", target_id: x.id, teacher_id: x.teacher_id, subject_id: x.subject_id, class_id: x.class_id })),
    });
    res.json({ success: true, message: "Assignments deleted", batch_id: batchId });
  } catch (err) {
    console.error("DELETE ASSIGNMENTS ERROR:", err);
    res.status(500).json({ message: "Delete failed" });
  }
};

/* =========================================================================
   DELETE ASSESSMENTS
========================================================================= */
const deleteAssessments = async (req, res) => {
  try {
    const pool = req.pool;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, message: "No assessments selected" });

    for (const id of ids) {
      await pool.request().input("id", sql.Int, id).query(`
        DELETE o FROM e_assessment_options o
        INNER JOIN e_assessment_questions q ON o.question_id = q.id
        WHERE q.e_assessment_id = @id
      `);
      await pool.request().input("id", sql.Int, id).query(`
        DELETE a FROM e_assessment_answers a
        INNER JOIN e_assessment_submissions s ON a.submission_id = s.id
        WHERE s.e_assessment_id = @id
      `);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_submissions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_questions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_exam_sessions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessments WHERE id = @id`);
    }

    res.json({ success: true, message: "Assessments deleted successfully" });
  } catch (err) {
    console.error("DELETE ASSESSMENTS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================================
   SUBMISSIONS / MARKING / ASSIGNMENT
========================================================================= */
const getAllSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT
  s.id, s.e_assessment_id, s.student_id, s.submitted_at, s.status, s.score,
  s.remark_requested, s.remark_status, s.remark_reason, s.admin_comment, s.released_at,
  a.title AS assessment_title, a.subject AS subject_name, a.total_marks AS total_marks,
  st.name AS student_name,
  (SELECT COUNT(*) FROM e_assessment_violation_photos vp
    WHERE vp.e_assessment_id = s.e_assessment_id AND vp.student_id = s.student_id) AS photo_count,
  aa.teacher_id AS assigned_teacher_id, t.name AS assigned_teacher_name,
  (SELECT COUNT(*) FROM e_assessment_answer_assignments axc INNER JOIN e_assessment_answers anc ON anc.id = axc.answer_id
    WHERE anc.submission_id = s.id) AS alloc_count,
  STUFF((SELECT DISTINCT ', ' + t2.name FROM e_assessment_answer_assignments ax2
           INNER JOIN e_assessment_answers an2 ON an2.id = ax2.answer_id
           INNER JOIN Teachers t2 ON t2.id = ax2.teacher_id
         WHERE an2.submission_id = s.id FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS alloc_teachers
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
LEFT JOIN Students st ON st.id = s.student_id
LEFT JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id
LEFT JOIN Teachers t ON t.id = aa.teacher_id
ORDER BY s.submitted_at DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("GET ALL SUBMISSIONS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch submissions" });
  }
};

const getAssessmentSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);

    // Only show a teacher the submissions that were actually distributed
    // to THEM (e_assessment_submission_assignments.teacher_id). Without
    // this join/filter, every teacher saw every submission for the
    // assessment regardless of who admin assigned it to.
    const isTeacher = req.user?.role === "teacher";

    const request = pool.request().input("assessmentId", sql.Int, assessmentId);
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT
        s.id,
        s.e_assessment_id,
        s.student_id,
        s.submitted_at,
        s.status,
        s.score,
        s.remark_requested,
        s.remark_status,
        s.remark_reason,
        s.admin_comment,
        a.total_marks AS total_marks,
        st.name AS student_name,
        (SELECT COUNT(*) FROM e_assessment_violation_photos vp
          WHERE vp.e_assessment_id = s.e_assessment_id AND vp.student_id = s.student_id) AS photo_count
      FROM e_assessment_submissions s
      LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
      LEFT JOIN Students st ON st.id = s.student_id
      WHERE s.e_assessment_id = @assessmentId
      ${isTeacher ? "AND " + TEACHER_SUB_ACCESS : ""}
      ORDER BY s.id DESC
    `);
    res.json({ success: true, submissions: result.recordset });
  } catch (err) {
    console.error("GET SUBMISSIONS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* Evidence for the marking screens: the camera photos taken while each
   student sat this assessment (see uploadViolationPhoto) plus the student's
   profile photo, so a teacher who flags a response has something to compare
   against. Called only AFTER the caller has already enforced the teacher's
   submission-assignment check, so it never widens who can see what. Returns
   { [student_id]: { name, profile_photo_url, photos: [...] } }. */
const loadStudentEvidence = async (pool, eAssessmentId, studentIds) => {
  const ids = [...new Set((studentIds || []).map(toInt).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  const idList = ids.join(","); // integers only (toInt) — safe to inline
  try {
    const studentsRes = await pool.request().query(
      `SELECT id, name, photoUrl FROM Students WHERE id IN (${idList})`
    );
    studentsRes.recordset.forEach((st) => {
      out[st.id] = { name: st.name, profile_photo_url: st.photoUrl || null, photos: [] };
    });
    const photosRes = await pool.request()
      .input("aid", sql.Int, eAssessmentId)
      .query(`
        SELECT id, student_id, reason, photo_url, createdAt,
               screenshot_url, question_id, question_number, question_text, answer_text
        FROM e_assessment_violation_photos
        WHERE e_assessment_id = @aid AND student_id IN (${idList})
        ORDER BY createdAt ASC
      `);
    photosRes.recordset.forEach((ph) => {
      if (!out[ph.student_id]) out[ph.student_id] = { name: null, profile_photo_url: null, photos: [] };
      out[ph.student_id].photos.push({
        id: ph.id, reason: ph.reason, photo_url: ph.photo_url, created_at: ph.createdAt,
        screenshot_url: ph.screenshot_url || null,
        question_id: ph.question_id || null,
        question_number: ph.question_number || null,
        question_text: ph.question_text || null,
        answer_text: ph.answer_text || null,
      });
    });
  } catch (err) {
    // Evidence is a nice-to-have on the marking screen — never block marking.
    console.error("LOAD STUDENT EVIDENCE ERROR:", err);
  }
  return out;
};

// Admin: every camera photo for one student on one assessment (all of their
// sessions/attempts), plus their profile photo.
const getStudentExamPhotos = async (req, res) => {
  try {
    const eAssessmentId = toInt(req.params.eAssessmentId);
    const studentId = toInt(req.params.studentId);
    if (!eAssessmentId || !studentId) return res.status(400).json({ message: "eAssessmentId and studentId are required" });
    const map = await loadStudentEvidence(req.pool, eAssessmentId, [studentId]);
    res.json(map[studentId] || { name: null, profile_photo_url: null, photos: [] });
  } catch (err) {
    console.error("GET STUDENT EXAM PHOTOS ERROR:", err);
    res.status(500).json({ message: "Failed to load photos" });
  }
};

const getSubmissionForMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const submissionId = toInt(req.params.id);

    // Direct-by-ID lookup, so it needs its own ownership check: a teacher
    // must not be able to open a submission just by guessing/typing its
    // id if it wasn't distributed to them.
    if (req.user?.role === "teacher") {
      const owns = await pool.request()
        .input("id", sql.Int, submissionId)
        .input("teacherId", sql.Int, toInt(req.user.id))
        .query(`SELECT s.id FROM e_assessment_submissions s WHERE s.id = @id AND ${TEACHER_SUB_ACCESS}`);
      if (!owns.recordset.length) {
        return res.status(403).json({ message: "This submission was not assigned to you." });
      }
    }

    const submission = await pool.request().input("id", sql.Int, submissionId)
      .query(`SELECT * FROM e_assessment_submissions WHERE id = @id`);

    const isTeacherViewer = req.user?.role === "teacher";
    const answersReq = pool.request().input("id", sql.Int, submissionId);
    if (isTeacherViewer) answersReq.input("teacherId", sql.Int, toInt(req.user.id));
    const answers = await answersReq.query(`
      SELECT a.id, a.question_id, a.selected_answer, a.essay_answer, a.is_correct, a.marks_awarded, a.remarks, a.highlights, a.highlighted_html, a.music_annotations,
             q.question_text, q.correct_answer, q.marks AS max_marks, q.question_type, q.model_answer_sheet
      FROM e_assessment_answers a
      INNER JOIN e_assessment_questions q ON q.id = a.question_id
      ${isTeacherViewer ? "LEFT JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id" : ""}
      WHERE a.submission_id = @id
      ${isTeacherViewer ? "AND " + TEACHER_ANSWER_VISIBLE : ""}
      ORDER BY q.id
    `);

    const subRow = submission.recordset[0] || {};
    const evidence = subRow.student_id
      ? (await loadStudentEvidence(pool, subRow.e_assessment_id, [subRow.student_id]))[subRow.student_id] || null
      : null;

    res.json({ submission: subRow, answers: (answers.recordset || []).map((r) => ({ ...r, music_annotations: parseMusicAnnotations(r.music_annotations) })), evidence });
  } catch (err) {
    console.error("MARKING FETCH ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const getAllSubmissionsForMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    if (!e_assessmentId) return res.status(400).json({ success: false, message: "Invalid e_assessment ID" });

    // Same fix as getAssessmentSubmissions: a teacher can only mark the
    // submissions that were distributed to them, not every submission for
    // the assessment. Admin/sub_admin (who don't hit this teacher-only
    // route in practice) fall back to the unfiltered query.
    const isTeacher = req.user?.role === "teacher";
    const request = pool.request().input("e_assessmentId", sql.Int, e_assessmentId);
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const submissionsResult = await request.query(`
      SELECT s.*
      FROM e_assessment_submissions s
      WHERE s.e_assessment_id = @e_assessmentId
      ${isTeacher ? "AND " + TEACHER_SUB_ACCESS : ""}
    `);
    const submissions = submissionsResult.recordset;
    if (!submissions.length) return res.status(200).json([]);

    const evidenceByStudent = await loadStudentEvidence(pool, e_assessmentId, submissions.map((s) => s.student_id));

    const finalData = [];
    for (const submission of submissions) {
      const answersReq = pool.request().input("submissionId", sql.Int, submission.id);
      if (isTeacher) answersReq.input("teacherId", sql.Int, toInt(req.user.id));
      const answersResult = await answersReq.query(`
        SELECT a.id, a.submission_id, a.question_id, a.essay_answer, a.marks_awarded, a.remarks, a.highlights, a.highlighted_html, a.music_annotations,
       q.question_text, q.question_type, q.marks AS max_marks, q.marking_guide, q.model_answer_sheet
FROM e_assessment_answers a
INNER JOIN e_assessment_questions q ON a.question_id = q.id
${isTeacher ? "LEFT JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id" : ""}
WHERE a.submission_id = @submissionId
${isTeacher ? "AND " + TEACHER_ANSWER_VISIBLE : ""}
      `);
      finalData.push({
        submission,
        answers: answersResult.recordset.map((r) => ({ ...r, music_annotations: parseMusicAnnotations(r.music_annotations) })),
        evidence: evidenceByStudent[submission.student_id] || { name: null, profile_photo_url: null, photos: [] },
      });
    }
    res.status(200).json(finalData);
  } catch (err) {
    console.error("GET ALL SUBMISSIONS FOR MARKING ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* PUT /questions/:questionId/model-sheet  { sheets: [png|{png}] }
   The question setter's model-answer drawing for a music-paper essay question.
   Stored in the same <img data-music-sheet> format a student's answer uses. */
const setModelSheet = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    if (!questionId) return res.status(400).json({ success: false, message: "Invalid question ID" });
    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) return res.status(404).json({ success: false, message: "Question not found" });
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) return res.status(permission.status).json({ success: false, message: permission.message });

    const sheets = cleanPngList(req.body?.sheets);
    const html = sheets.map((png) => `<p><img data-music-sheet="1" data-tpl="treble" src="${png}" alt="Model answer"></p>`).join("");
    await pool.request()
      .input("id", sql.Int, questionId)
      .input("v", sql.NVarChar(sql.MAX), html || null)
      .query(`UPDATE e_assessment_questions SET model_answer_sheet = @v WHERE id = @id`);
    res.json({ success: true, model_answer_sheet: html || null });
  } catch (err) {
    console.error("SET MODEL SHEET ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to save the model answer" });
  }
};

const saveMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const { scores, remarks, highlights, essayHTML, musicAnnotations } = req.body;
    if (!scores || typeof scores !== "object" || !Object.keys(scores).length) {
      return res.status(400).json({ success: false, message: "No scores provided" });
    }

    const answerIds = Object.keys(scores).map(Number).filter((n) => !isNaN(n));
    if (!answerIds.length) return res.status(400).json({ success: false, message: "No valid answer ids provided" });

    for (const answerId of answerIds) {
      const mark = Number(scores[answerId]) || 0;
      // The client always sends its full current highlight state per
      // answer (empty array included), so this is authoritative — write
      // it as-is. Strip the `prior: true` placeholder ("Previously
      // marked") the frontend synthesizes for already-graded answers; it
      // isn't real highlight data and shouldn't be persisted as if it were.
      const hlList = (highlights?.[answerId] || []).filter((h) => !h.prior);
      const hlJson = hlList.length ? JSON.stringify(hlList) : null;
      // The marked-up essay HTML (the <mark class="hl-mark"> spans) — only
      // meaningful alongside actual highlight data, so it's dropped
      // whenever hlList is empty (an override-only mark, or highlights
      // that were all removed again before saving).
      const markedHtml = hlList.length ? (essayHTML?.[answerId] || null) : null;

      const mkReq = () => pool.request()
        .input("answerId", sql.Int, answerId)
        .input("mark", sql.Int, mark)
        .input("remarks", sql.NVarChar(sql.MAX), remarks?.[answerId] || "")
        .input("highlights", sql.NVarChar(sql.MAX), hlJson)
        .input("highlightedHtml", sql.NVarChar(sql.MAX), markedHtml)
        .input("markerId", sql.Int, toInt(req.user?.id) || null);
      try {
        // marked_at keeps the FIRST time the answer was marked (the leaderboard
        // measures how fast work gets done, not when it was last tweaked).
        await mkReq().query(`
          UPDATE e_assessment_answers
          SET marks_awarded = @mark,
              remarks = @remarks,
              highlights = @highlights,
              highlighted_html = @highlightedHtml,
              marked_by = @markerId,
              marked_at = ISNULL(marked_at, GETDATE())
          WHERE id = @answerId
        `);
      } catch (e) {
        if (!/invalid column name/i.test(String(e.message))) throw e;
        await mkReq().query(`
          UPDATE e_assessment_answers
          SET marks_awarded = @mark, remarks = @remarks,
              highlights = @highlights, highlighted_html = @highlightedHtml
          WHERE id = @answerId
        `);
      }

      // Music paper: marker overlays. Only written when the client sent this
      // answer's key (so marking screens that don't know about drawings never
      // wipe them). Overlays are positional: index i = i-th drawing sheet, ""
      // = not annotated. All-empty clears the column.
      if (musicAnnotations && Object.prototype.hasOwnProperty.call(musicAnnotations, answerId)) {
        const raw = Array.isArray(musicAnnotations[answerId]) ? musicAnnotations[answerId].slice(0, MAX_SHEETS) : [];
        const list = raw.map((v) => (typeof v === "string" && v.length <= MAX_SHEET_CHARS && PNG_DATA_URL_RE.test(v) ? v : ""));
        await pool.request()
          .input("answerId", sql.Int, answerId)
          .input("ann", sql.NVarChar(sql.MAX), list.some(Boolean) ? JSON.stringify(list) : null)
          .query(`UPDATE e_assessment_answers SET music_annotations = @ann WHERE id = @answerId`);
      }
    }

    const idList = answerIds.join(",");
    const subLookup = await pool.request().query(`
      SELECT DISTINCT submission_id FROM e_assessment_answers WHERE id IN (${idList})
    `);
    const submissionIds = subLookup.recordset.map((r) => r.submission_id);

    const results = [];
    for (const submissionId of submissionIds) {
      // Safety net: MCQ answers are supposed to get marks_awarded set the
      // moment the student submits (see submitEAssessment), but some
      // marking screens only ever send essay answer ids in `scores` and
      // never touch the MCQ rows — if an MCQ answer's marks_awarded is
      // still NULL for any reason when a teacher saves marking, make sure
      // it gets graded here instead of silently contributing 0 forever.
      await pool.request()
        .input("submission_id", sql.Int, submissionId)
        .query(`
          UPDATE a
          SET a.marks_awarded = CASE
                WHEN a.selected_answer IS NOT NULL AND q.correct_answer IS NOT NULL
                     AND LOWER(LTRIM(RTRIM(a.selected_answer))) = LOWER(LTRIM(RTRIM(q.correct_answer)))
                THEN ISNULL(q.marks, 0)
                ELSE 0
              END,
              a.is_correct = CASE
                WHEN a.selected_answer IS NOT NULL AND q.correct_answer IS NOT NULL
                     AND LOWER(LTRIM(RTRIM(a.selected_answer))) = LOWER(LTRIM(RTRIM(q.correct_answer)))
                THEN 1 ELSE 0
              END
          FROM e_assessment_answers a
          INNER JOIN e_assessment_questions q ON q.id = a.question_id
          WHERE a.submission_id = @submission_id
            AND q.question_type <> 'essay'
            AND a.marks_awarded IS NULL
        `);

      const totalResult = await pool.request()
        .input("submission_id", sql.Int, submissionId)
        .query(`SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`);
      const totalScore = totalResult.recordset[0].total;

      const unmarkedEssays = await pool.request()
        .input("submission_id", sql.Int, submissionId)
        .query(`
          SELECT COUNT(*) AS cnt
          FROM e_assessment_answers a
          INNER JOIN e_assessment_questions q ON q.id = a.question_id
          WHERE a.submission_id = @submission_id AND q.question_type = 'essay' AND a.marks_awarded IS NULL
            -- an essay the student left blank has nothing to mark (it counts as 0) and is never
            -- handed out when answered questions are split between teachers, so it must not
            -- keep the submission from being finished
            AND LEN(LTRIM(RTRIM(CAST(ISNULL(a.essay_answer, '') AS NVARCHAR(MAX))))) > 0
        `);
      const isFullyMarked = unmarkedEssays.recordset[0].cnt === 0;

      if (isFullyMarked) {
        const doneReq = () => pool.request()
          .input("submission_id", sql.Int, submissionId).input("score", sql.Int, totalScore)
          .input("markerId", sql.Int, toInt(req.user?.id) || null);
        try {
          await doneReq().query(`
            UPDATE e_assessment_submissions
            SET score = @score, status = 'marked', remark_completed = 1, remark_requested = 0, remark_status = 'completed',
                marking_completed_at = ISNULL(marking_completed_at, GETDATE()),
                marking_completed_by = ISNULL(marking_completed_by, @markerId)
            WHERE id = @submission_id
          `);
        } catch (e) {
          if (!/invalid column name/i.test(String(e.message))) throw e;
          await doneReq().query(`
            UPDATE e_assessment_submissions
            SET score = @score, status = 'marked', remark_completed = 1, remark_requested = 0, remark_status = 'completed'
            WHERE id = @submission_id
          `);
        }
      } else {
        await pool.request()
          .input("submission_id", sql.Int, submissionId).input("score", sql.Int, totalScore)
          .query(`UPDATE e_assessment_submissions SET score = @score WHERE id = @submission_id`);
      }
      results.push({ submission_id: submissionId, total_score: totalScore, fully_marked: isFullyMarked });
    }

    res.json({ success: true, results, message: "Marked successfully" });
  } catch (err) {
    console.error("SAVE MARKING ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const saveMarkingBulk = saveMarking; // same shape/body contract — kept as distinct route name for the frontend

/* ═════════════════════════════════════════════════════════════════════
   MARKING SESSION CACHE — autosave / resume-anywhere for the marking UI
   (see the table comment in ensureSchema.js for the full rationale).
   Scoped to (assessment, teacher) so it works the same whether the
   teacher is back on the same device or has logged in on another one.
═════════════════════════════════════════════════════════════════════ */
const getMarkingSession = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const teacherId = toInt(req.user?.id);
    if (!e_assessmentId) return res.status(400).json({ message: "Invalid assessment id" });

    const result = await pool.request()
      .input("e_assessmentId", sql.Int, e_assessmentId)
      .input("teacherId", sql.Int, teacherId)
      .query(`
        SELECT state, updatedAt FROM e_assessment_marking_sessions
        WHERE e_assessment_id = @e_assessmentId AND teacher_id = @teacherId
      `);

    if (!result.recordset.length) return res.json({ state: null, updatedAt: null });

    const row = result.recordset[0];
    let state = null;
    try { state = JSON.parse(row.state); } catch { state = null; }
    res.json({ state, updatedAt: row.updatedAt });
  } catch (err) {
    console.error("GET MARKING SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const saveMarkingSession = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const teacherId = toInt(req.user?.id);
    if (!e_assessmentId) return res.status(400).json({ message: "Invalid assessment id" });

    const { state } = req.body;
    if (!state || typeof state !== "object") {
      return res.status(400).json({ message: "No session state provided" });
    }

    // Guard against a runaway payload (shouldn't happen — this is just
    // scores/remarks/highlights/flags for one batch — but NVARCHAR(MAX)
    // is effectively unbounded, so cap it defensively).
    const serialized = JSON.stringify(state).slice(0, 8_000_000);

    const existing = await pool.request()
      .input("e_assessmentId", sql.Int, e_assessmentId)
      .input("teacherId", sql.Int, teacherId)
      .query(`
        SELECT id FROM e_assessment_marking_sessions
        WHERE e_assessment_id = @e_assessmentId AND teacher_id = @teacherId
      `);

    if (existing.recordset.length) {
      await pool.request()
        .input("e_assessmentId", sql.Int, e_assessmentId)
        .input("teacherId", sql.Int, teacherId)
        .input("state", sql.NVarChar(sql.MAX), serialized)
        .query(`
          UPDATE e_assessment_marking_sessions
          SET state = @state, updatedAt = GETDATE()
          WHERE e_assessment_id = @e_assessmentId AND teacher_id = @teacherId
        `);
    } else {
      await pool.request()
        .input("e_assessmentId", sql.Int, e_assessmentId)
        .input("teacherId", sql.Int, teacherId)
        .input("state", sql.NVarChar(sql.MAX), serialized)
        .query(`
          INSERT INTO e_assessment_marking_sessions (e_assessment_id, teacher_id, state)
          VALUES (@e_assessmentId, @teacherId, @state)
        `);
    }

    res.json({ success: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("SAVE MARKING SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Called once the batch is fully saved & finished — the cached draft has
// served its purpose (everything it held is now committed to
// e_assessment_answers), so drop it rather than let a stale draft get
// pulled back on the next visit.
const clearMarkingSession = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const teacherId = toInt(req.user?.id);
    if (!e_assessmentId) return res.status(400).json({ message: "Invalid assessment id" });

    // keep the "who marked what" record before the draft disappears (marking leaderboard)
    try { await require("../utils/markingBackfill").backfillMarkersFromSessions(pool, { teacherId, assessmentId: e_assessmentId }); } catch { /* never block clearing */ }

    await pool.request()
      .input("e_assessmentId", sql.Int, e_assessmentId)
      .input("teacherId", sql.Int, teacherId)
      .query(`
        DELETE FROM e_assessment_marking_sessions
        WHERE e_assessment_id = @e_assessmentId AND teacher_id = @teacherId
      `);

    res.json({ success: true });
  } catch (err) {
    console.error("CLEAR MARKING SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const assignSubmission = async (req, res) => {
  try {
    const pool = req.pool;
    const { submissionId, teacherId } = req.body;
    if (!submissionId || !teacherId) return res.status(400).json({ success: false, message: "submissionId and teacherId are required" });
    const changes = await assignmentEngine.distributeBySubmission(pool, [submissionId], [teacherId]);
    const batchId = await safeRecord(pool, { kind: "submission", summary: "Assigned 1 submission to a teacher", userId: req.user?.id, changes });
    res.json({ success: true, message: "Submission assigned successfully", batch_id: batchId });
  } catch (err) {
    console.error("ASSIGN SUBMISSION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const bulkAssignSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const { submission_ids, teacher_ids } = req.body;
    if (!Array.isArray(submission_ids) || !submission_ids.length) return res.status(400).json({ message: "No submissions provided" });
    if (!Array.isArray(teacher_ids) || !teacher_ids.length) return res.status(400).json({ message: "No teachers provided" });
    const teachers = assignmentEngine.ints(teacher_ids);
    const changes = await assignmentEngine.distributeBySubmission(pool, submission_ids, teachers);
    const batchId = await safeRecord(pool, { kind: "submission", summary: `Distributed ${submission_ids.length} submission(s) across ${teachers.length} teacher(s)`, userId: req.user?.id, changes });
    res.json({ success: true, message: `${submission_ids.length} submission(s) distributed across ${teachers.length} teacher(s)`, batch_id: batchId });
  } catch (err) {
    console.error("BULK ASSIGN ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* SMART DISTRIBUTE — one entry point for "Distribute Equally" / "Auto-Assign All".
   More teachers than submissions -> split by ANSWERED QUESTIONS (every teacher
   gets work); otherwise share out whole submissions as before. Either way the
   action is recorded so it can be undone. */
const smartDistribute = async (req, res) => {
  try {
    const pool = req.pool;
    const submissionIds = assignmentEngine.ints(req.body.submission_ids);
    const teacherIds = assignmentEngine.ints(req.body.teacher_ids);
    if (!submissionIds.length) return res.status(400).json({ message: "No submissions provided" });
    if (!teacherIds.length) return res.status(400).json({ message: "No teachers provided" });

    const mode = assignmentEngine.chooseMode(teacherIds.length, submissionIds.length);
    if (mode === assignmentEngine.MODE.SUBMISSION) {
      const changes = await assignmentEngine.distributeBySubmission(pool, submissionIds, teacherIds);
      const batchId = await safeRecord(pool, { kind: "submission", summary: `Distributed ${submissionIds.length} submission(s) across ${teacherIds.length} teacher(s)`, userId: req.user?.id, changes });
      return res.json({ success: true, mode, submissions: submissionIds.length, teachers: teacherIds.length, batch_id: batchId,
        message: `${submissionIds.length} submission(s) split across ${teacherIds.length} teacher(s)` });
    }

    const out = await assignmentEngine.distributeByQuestion(pool, submissionIds, teacherIds);
    if (!out.total) {
      return res.json({ success: true, mode, allocated: 0, batch_id: null, message: "There are no answered, unmarked essay questions left to allocate." });
    }
    const used = Object.keys(out.perTeacher).length;
    const batchId = await safeRecord(pool, {
      kind: "question",
      summary: `More teachers (${teacherIds.length}) than submissions (${submissionIds.length}): split ${out.total} answered question(s) across ${used} teacher(s)`,
      userId: req.user?.id, changes: out.changes,
    });
    for (const [tid, count] of Object.entries(out.perTeacher)) {
      try {
        await notifyOne(pool, Number(tid), "Teachers", {
          title: "New Marking Allocation",
          message: `You've been allocated ${count} answered question${count === 1 ? "" : "s"} to mark.`,
          type: "allocation",
        });
      } catch (_) { /* a failed notification must not undo the allocation */ }
    }
    res.json({
      success: true, mode, allocated: out.total, teachers: used, per_teacher: out.perTeacher, batch_id: batchId,
      message: `More teachers than submissions, so the ${out.total} answered question(s) were split across ${used} teacher(s)`,
    });
  } catch (err) {
    console.error("SMART DISTRIBUTE ERROR:", err);
    res.status(500).json({ message: "Distribution failed" });
  }
};

const getAssignmentBatches = async (req, res) => {
  try {
    const r = await req.pool.request().query(`
      SELECT TOP 30 b.id, b.kind, b.summary, b.created_at, b.undone_at, u.name AS created_by_name,
             (SELECT COUNT(*) FROM e_assessment_assignment_changes c WHERE c.batch_id = b.id) AS change_count
      FROM e_assessment_assignment_batches b
      LEFT JOIN Users u ON u.id = b.created_by
      ORDER BY b.id DESC
    `);
    res.json(r.recordset || []);
  } catch (err) {
    console.error("GET ASSIGNMENT BATCHES ERROR:", err);
    res.status(500).json([]);
  }
};

const undoAssignmentBatch = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid action" });
    const out = await assignmentEngine.undoBatch(req.pool, id, req.user?.id);
    if (out.status !== 200) return res.status(out.status).json({ message: out.message });
    const extra = [];
    if (out.keptMarked) extra.push(`${out.keptMarked} left as they are because marking has already started`);
    if (out.changedSince) extra.push(`${out.changedSince} skipped because they were changed afterwards`);
    res.json({ success: true, restored: out.restored, kept_marked: out.keptMarked, changed_since: out.changedSince,
      message: `Undone: ${out.restored} item${out.restored === 1 ? "" : "s"} restored${extra.length ? " (" + extra.join("; ") + ")" : ""}` });
  } catch (err) {
    console.error("UNDO ASSIGNMENT ERROR:", err);
    res.status(500).json({ message: "Could not undo that action" });
  }
};

const getNextSubmissionForMarking = async (req, res) => {
  try {
    const pool = req.pool;

    // Same distribution rule: a teacher can only be handed a submission
    // that was actually assigned to them, never one assigned to (or
    // unassigned and belonging to) another teacher.
    const isTeacher = req.user?.role === "teacher";
    const request = pool.request();
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT TOP 1 s.*
      FROM e_assessment_submissions s
      WHERE s.status = 'submitted'
      ${isTeacher ? "AND " + TEACHER_SUB_ACCESS : ""}
      ORDER BY NEWID()
    `);
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error("GET NEXT FOR MARKING ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   REMARK REQUESTS
========================================================================= */
const requestRemark = async (req, res) => {
  try {
    const pool = req.pool;
    const submission_id = toInt(req.params.id);
    const { reason } = req.body;

    await pool.request().input("submission_id", sql.Int, submission_id).input("reason", sql.NVarChar(sql.MAX), reason || "").query(`
      UPDATE e_assessment_submissions
      SET remark_requested = 1, remark_reason = @reason, remark_status = 'pending'
      WHERE id = @submission_id
    `);

    res.status(201).json({ success: true, message: "Remark request created successfully" });
  } catch (err) {
    console.error("CREATE REMARK ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const getRemarkRequests = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT s.*, a.title AS assessment_title, a.subject AS subject_name, st.name AS student_name,
             aa.teacher_id AS assigned_teacher_id, t.name AS teacher_name
      FROM e_assessment_submissions s
      LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
      LEFT JOIN Students st ON st.id = s.student_id
      LEFT JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id
      LEFT JOIN Teachers t ON t.id = aa.teacher_id
      WHERE s.remark_requested = 1 OR s.remark_status IS NOT NULL
      ORDER BY s.submitted_at DESC
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error("GET REMARK REQUESTS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch remark requests", error: err.message });
  }
};

const reviewRemarkRequest = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { status, admin_comment } = req.body;

    const validStatuses = ["approved", "rejected", "revision", "pending"];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: "Invalid status" });

    const existing = await pool.request().input("id", sql.Int, id).query(`
      SELECT s.student_id, a.title
      FROM e_assessment_submissions s
      LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
      WHERE s.id = @id
    `);

    await pool.request()
      .input("id", sql.Int, id).input("status", sql.NVarChar(50), status)
      .input("admin_comment", sql.NVarChar(sql.MAX), admin_comment || "").query(`
        UPDATE e_assessment_submissions
        SET remark_status = @status, admin_comment = @admin_comment,
            remark_requested = CASE WHEN @status = 'pending' THEN 1 ELSE 0 END,
            reviewed_at = GETDATE()
        WHERE id = @id
      `);

    if (existing.recordset.length && status !== "pending") {
      const { student_id, title } = existing.recordset[0];
      const statusLabel = { approved: "approved", rejected: "rejected", revision: "sent for revision" }[status] || status;
      await notifyOne(pool, student_id, "Students", {
        title: "Remark Request Update",
        message: `Your remark request for "${title || "an assessment"}" was ${statusLabel}.${admin_comment ? ` ${admin_comment}` : ""}`,
        type: "exam",
      });
    }

    res.json({ success: true, message: `Remark request ${status}` });
  } catch (err) {
    console.error("REVIEW REMARK ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   RELEASE MARKS
========================================================================= */
/* `SELECT s.*, ..., a.total_marks AS total_marks` returns TWO columns named
   total_marks when the submissions table has one of its own — the driver
   then hands back an array (e.g. [0, 30]) instead of a number, which the
   screens printed as "030" and turned into NaN%. The assessment's total
   is the last one selected, so take that. */
const fixTotalMarks = (row) => {
  if (row && Array.isArray(row.total_marks)) {
    row.total_marks = row.total_marks[row.total_marks.length - 1];
  }
  return row;
};

const getReleasedMarks = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT s.*, a.title AS assessment_title, a.subject AS subject_name, a.total_marks AS total_marks,
       st.name AS student_name
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
LEFT JOIN Students st ON st.id = s.student_id
WHERE s.status = 'released'
ORDER BY s.released_at DESC
    `);
    res.status(200).json(result.recordset.map(fixTotalMarks));
  } catch (err) {
    console.error("GET RELEASED MARKS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch released marks", error: err.message });
  }
};

/* =========================================================================
   ENSURE ASSESSMENT FOR E-ASSESSMENT  (schema fix — §"Marks labeling")

   Marks.assessmentId is meant to always point at Assessments.id — that's
   how routes/assessments.js, server.js's /api/marks/* endpoints, and the
   new /api/marks/report endpoint all read it. Historically, releasing an
   online exam's marks broke that: it inserted e_assessments.id directly
   into Marks.assessmentId instead, so the same column silently pointed
   into two unrelated tables depending on where a mark came from.

   This get-or-creates a real Assessments row for a given e_assessment
   (tagged sourceSystem='e_assessment', sourceRefId=<e_assessments.id> so
   it's never duplicated on a second release) and returns its id, so every
   Marks row — manual or online — is consistent from here on.

   Runs inside the caller's transaction so it commits/rolls back with the
   rest of the release.
========================================================================= */
const ensureAssessmentForEAssessment = async (transaction, eAssessmentId, subjectId) => {
  const existing = await new sql.Request(transaction)
    .input("sourceRefId", sql.Int, eAssessmentId)
    .query(`
      SELECT TOP 1 id FROM Assessments
      WHERE sourceSystem = 'e_assessment' AND sourceRefId = @sourceRefId
    `);
  if (existing.recordset.length) return existing.recordset[0].id;

  const eaResult = await new sql.Request(transaction)
    .input("id", sql.Int, eAssessmentId)
    .query(`
      SELECT ea.id, ea.title, ea.subject, ea.total_marks, ea.class_id,
             c.name AS class_name,
             ess.main_examination_id, me.term, me.academic_year
      FROM e_assessments ea
      LEFT JOIN Classes c ON c.id = ea.class_id
      LEFT JOIN exam_subject_sessions ess ON ess.e_assessment_id = ea.id
      LEFT JOIN main_examinations me ON me.id = ess.main_examination_id
      WHERE ea.id = @id
    `);
  const ea = eaResult.recordset[0];

  // A subject slot inside a Main Examination is a combined, multi-paper
  // event ('main'); a standalone CAT/assignment turned into an
  // e-assessment is a one-off single-subject assessment ('subject').
  const examScope = ea?.main_examination_id ? "main" : "subject";

  const insertResult = await new sql.Request(transaction)
    .input("name", sql.NVarChar, ea?.title || "Online Assessment")
    .input("assessmentType", sql.NVarChar, "E-Assessment")
    .input("targetClass", sql.NVarChar, ea?.class_name || "")
    .input("term", sql.NVarChar, ea?.term || "")
    .input("year", sql.NVarChar, ea?.academic_year || "")
    .input("totalMarks", sql.Int, ea?.total_marks || 100)
    .input("examScope", sql.NVarChar, examScope)
    .input("sourceRefId", sql.Int, eAssessmentId)
    .query(`
      INSERT INTO Assessments
      (name, assessmentType, targetClass, term, year, totalMarks, status, examScope, sourceSystem, sourceRefId)
      OUTPUT INSERTED.id
      VALUES
      (@name, @assessmentType, @targetClass, @term, @year, @totalMarks, 'Active', @examScope, 'e_assessment', @sourceRefId)
    `);
  const assessmentId = insertResult.recordset[0].id;

  if (subjectId) {
    await new sql.Request(transaction)
      .input("assessmentId", sql.Int, assessmentId)
      .input("subjectId", sql.Int, subjectId)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM AssessmentSubjects WHERE assessmentId = @assessmentId AND subjectId = @subjectId)
        INSERT INTO AssessmentSubjects (assessmentId, subjectId) VALUES (@assessmentId, @subjectId)
      `);
  }

  return assessmentId;
};

/* Writes a released e-assessment mark into Marks. Normally that is a plain
   insert. If the student already has a mark for this assessment (only
   possible after a "keep best" resit — "replace" removes the old one when
   the resit is submitted) the higher percentage is kept, so a resit can
   only ever improve the official mark under that policy. */
const writeReleasedMark = async (transaction, { studentId, subjectId, assessmentId, score, percentage }) => {
  const existing = await new sql.Request(transaction)
    .input("studentId", sql.Int, studentId)
    .input("assessmentId", sql.Int, assessmentId)
    .query(`SELECT TOP 1 id, percentage FROM Marks WHERE studentId = @studentId AND assessmentId = @assessmentId ORDER BY id DESC`);

  if (existing.recordset.length) {
    const old = existing.recordset[0];
    if (percentage != null && (old.percentage == null || percentage > Number(old.percentage))) {
      await new sql.Request(transaction)
        .input("id", sql.Int, old.id)
        .input("score", sql.Int, score)
        .input("percentage", sql.Float, percentage)
        .query(`UPDATE Marks SET score = @score, percentage = @percentage, createdAt = GETDATE() WHERE id = @id`);
    }
    return; // otherwise the earlier, higher mark stays
  }

  await new sql.Request(transaction)
    .input("studentId", sql.Int, studentId)
    .input("subjectId", sql.Int, subjectId)
    .input("assessmentId", sql.Int, assessmentId)
    .input("score", sql.Int, score)
    .input("percentage", sql.Float, percentage)
    .query(`
      INSERT INTO Marks (studentId, subjectId, assessmentId, score, percentage, createdAt)
      VALUES (@studentId, @subjectId, @assessmentId, @score, @percentage, GETDATE())
    `);
};

const releaseMarks = async (req, res) => {
  const pool = req.pool;
  const transaction = new sql.Transaction(pool);
  try {
    const { submission_id } = req.body;
    if (!submission_id) return res.status(400).json({ message: "submission_id is required" });

    await transaction.begin();

    const subResult = await new sql.Request(transaction).input("id", sql.Int, submission_id).query(`
      SELECT s.id, s.student_id, s.score, ISNULL(a.total_marks, 100) AS total_marks, s.status,
       a.id AS assessment_id, a.subject, a.title
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
WHERE s.id = @id
    `);

    if (!subResult.recordset.length) { await transaction.rollback(); return res.status(404).json({ message: "Submission not found" }); }
    const sub = subResult.recordset[0];
    if (sub.status === "released") { await transaction.rollback(); return res.status(400).json({ message: "Marks already released" }); }
    if (sub.score == null) { await transaction.rollback(); return res.status(400).json({ message: "Submission has not been marked yet" }); }

    const percentage = sub.total_marks ? (sub.score / sub.total_marks) * 100 : null;

    // e_assessments stores the subject as text, Marks needs the subject's id — look it up
    const subjectLookup = await new sql.Request(transaction)
      .input("subjectName", sql.NVarChar, sub.subject || "")
      .query(`SELECT TOP 1 id FROM Subjects WHERE name = @subjectName`);
    const subjectId = subjectLookup.recordset[0]?.id || null;

    // Get-or-create the Assessments row this e_assessment maps to, so
    // Marks.assessmentId points at Assessments.id like every other mark
    // (see ensureAssessmentForEAssessment above — this used to insert
    // sub.assessment_id, which was actually e_assessments.id).
    const assessmentId = await ensureAssessmentForEAssessment(transaction, sub.assessment_id, subjectId);

    await writeReleasedMark(transaction, { studentId: sub.student_id, subjectId, assessmentId, score: sub.score, percentage });

    await new sql.Request(transaction).input("id", sql.Int, submission_id).query(`
      UPDATE e_assessment_submissions SET status = 'released', released_at = GETDATE() WHERE id = @id
    `);

    await transaction.commit();

    await notifyOne(pool, sub.student_id, "Students", {
      title: "Exam Results Released",
      message: `Your results for "${sub.title || "an assessment"}" have been released. Score: ${sub.score}/${sub.total_marks}.`,
      type: "exam",
    });

    res.json({ success: true, message: "Marks released successfully" });
  } catch (err) {
    console.error("RELEASE MARKS ERROR:", err);
    try { await transaction.rollback(); } catch (_) {}
    res.status(500).json({ message: err.message });
  }
};

const bulkReleaseMarks = async (req, res) => {
  const pool = req.pool;
  try {
    const { submission_ids } = req.body;
    if (!Array.isArray(submission_ids) || !submission_ids.length) return res.status(400).json({ message: "No submissions provided" });

    let released = 0;
    for (const id of submission_ids) {
      const transaction = new sql.Transaction(pool);
      try {
        await transaction.begin();
        const subResult = await new sql.Request(transaction).input("id", sql.Int, id).query(`
  SELECT s.id, s.student_id, s.score, ISNULL(a.total_marks, 100) AS total_marks, s.status,
         a.id AS assessment_id, a.subject, a.title
  FROM e_assessment_submissions s
  LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
  WHERE s.id = @id
`);
        const sub = subResult.recordset[0];
        if (!sub || sub.status === "released" || sub.score == null) { await transaction.rollback(); continue; }

        const percentage = sub.total_marks ? (sub.score / sub.total_marks) * 100 : null;

        // e_assessments stores the subject as text, Marks needs the subject's id — look it up
        const subjectLookup = await new sql.Request(transaction)
          .input("subjectName", sql.NVarChar, sub.subject || "")
          .query(`SELECT TOP 1 id FROM Subjects WHERE name = @subjectName`);
        const subjectId = subjectLookup.recordset[0]?.id || null;

        // Get-or-create the Assessments row this e_assessment maps to —
        // see ensureAssessmentForEAssessment above; keeps this in sync
        // with the single releaseMarks() fix.
        const assessmentId = await ensureAssessmentForEAssessment(transaction, sub.assessment_id, subjectId);

        await writeReleasedMark(transaction, { studentId: sub.student_id, subjectId, assessmentId, score: sub.score, percentage });

        await new sql.Request(transaction).input("id", sql.Int, id).query(`
          UPDATE e_assessment_submissions SET status = 'released', released_at = GETDATE() WHERE id = @id
        `);
        await transaction.commit();
        released++;

        await notifyOne(pool, sub.student_id, "Students", {
          title: "Exam Results Released",
          message: `Your results for "${sub.title || "an assessment"}" have been released. Score: ${sub.score}/${sub.total_marks}.`,
          type: "exam",
        });
      } catch (innerErr) {
        try { await transaction.rollback(); } catch (_) {}
        console.error("BULK RELEASE ITEM ERROR:", innerErr);
      }
    }
    res.json({ success: true, released_count: released });
  } catch (err) {
    console.error("BULK RELEASE MARKS ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   GRADING SYSTEM
   Single configurable scale (see GradingSystem table in ensureSchema.js)
   that every report screen — reports.jsx, StudentReport.jsx,
   TeacherReports.jsx — reads instead of each hard-coding its own grade
   boundaries. GET is intentionally NOT behind requirePage: a student
   or teacher viewing their own report needs this too, same reasoning
   as GET /api/school-settings being public. PUT is admin-only, gated
   on the route by requirePage("E-Assessments").
========================================================================= */
const getGradingSystem = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT TOP 1 * FROM GradingSystem WHERE id = 1`);
    const row = result.recordset[0];

    if (!row) {
      // Table not migrated yet on this tenant for some reason — fall
      // back to the same numbers the old hard-coded functions used,
      // so a report screen never breaks because of a missing row.
      return res.json({
        id: 1,
        systemName: "KNEC Standard",
        passMark: 40,
        gradeBands: [
          { minScore: 80, grade: "1", label: "Distinction", remark: "Excellent Performance" },
          { minScore: 75, grade: "2", label: "Distinction", remark: "Good Performance" },
          { minScore: 70, grade: "3", label: "Credit", remark: "Good Performance" },
          { minScore: 60, grade: "4", label: "Credit", remark: "Fair Performance" },
          { minScore: 50, grade: "5", label: "Pass", remark: "Weak Performance" },
          { minScore: 40, grade: "6", label: "Pass", remark: "Needs Improvement" },
          { minScore: 0, grade: "7", label: "Fail", remark: "Needs Improvement" },
        ],
        overallBands: [
          { minScore: 75, label: "DISTINCTION" },
          { minScore: 60, label: "CREDIT" },
          { minScore: 40, label: "PASS" },
          { minScore: 0, label: "REFERRED" },
        ],
      });
    }

    let gradeBands = [];
    let overallBands = [];
    try { gradeBands = JSON.parse(row.gradeBandsJson || "[]"); } catch (_) {}
    try { overallBands = JSON.parse(row.overallBandsJson || "[]"); } catch (_) {}

    res.json({
      id: row.id,
      systemName: row.systemName,
      passMark: row.passMark,
      gradeBands,
      overallBands,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error("GET GRADING SYSTEM ERROR:", err);
    res.status(500).json({ message: "Failed to load grading system" });
  }
};

const updateGradingSystem = async (req, res) => {
  try {
    const pool = req.pool;
    const { systemName, passMark, gradeBands, overallBands } = req.body || {};

    if (!Array.isArray(gradeBands) || gradeBands.length === 0) {
      return res.status(400).json({ message: "At least one grade band is required" });
    }
    if (!Array.isArray(overallBands) || overallBands.length === 0) {
      return res.status(400).json({ message: "At least one overall-result band is required" });
    }

    // Normalize + validate every band before persisting — a bad row
    // here would silently break every report/result-slip in the app.
    const cleanGradeBands = gradeBands
      .map((b) => ({
        minScore: Number(b.minScore),
        grade: String(b.grade ?? "").trim(),
        label: String(b.label ?? "").trim(),
        remark: String(b.remark ?? "").trim(),
      }))
      .filter((b) => !Number.isNaN(b.minScore) && b.label)
      .sort((a, b) => b.minScore - a.minScore);

    const cleanOverallBands = overallBands
      .map((b) => ({
        minScore: Number(b.minScore),
        label: String(b.label ?? "").trim(),
      }))
      .filter((b) => !Number.isNaN(b.minScore) && b.label)
      .sort((a, b) => b.minScore - a.minScore);

    if (!cleanGradeBands.length) return res.status(400).json({ message: "Grade bands are invalid" });
    if (!cleanOverallBands.length) return res.status(400).json({ message: "Overall-result bands are invalid" });

    await pool.request()
      .input("systemName", sql.NVarChar, systemName || "Standard Grading")
      .input("passMark", sql.Int, Number.isFinite(Number(passMark)) ? parseInt(passMark, 10) : 40)
      .input("gradeBandsJson", sql.NVarChar(sql.MAX), JSON.stringify(cleanGradeBands))
      .input("overallBandsJson", sql.NVarChar(sql.MAX), JSON.stringify(cleanOverallBands))
      .input("updatedBy", sql.Int, req.user?.id || null)
      .query(`
        IF EXISTS (SELECT * FROM GradingSystem WHERE id = 1)
          UPDATE GradingSystem SET
            systemName = @systemName,
            passMark = @passMark,
            gradeBandsJson = @gradeBandsJson,
            overallBandsJson = @overallBandsJson,
            updatedAt = GETDATE(),
            updatedBy = @updatedBy
          WHERE id = 1
        ELSE
          INSERT INTO GradingSystem (id, systemName, passMark, gradeBandsJson, overallBandsJson, updatedBy)
          VALUES (1, @systemName, @passMark, @gradeBandsJson, @overallBandsJson, @updatedBy)
      `);

    const result = await pool.request().query(`SELECT TOP 1 * FROM GradingSystem WHERE id = 1`);
    const row = result.recordset[0];
    res.json({
      success: true,
      id: row.id,
      systemName: row.systemName,
      passMark: row.passMark,
      gradeBands: JSON.parse(row.gradeBandsJson),
      overallBands: JSON.parse(row.overallBandsJson),
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error("UPDATE GRADING SYSTEM ERROR:", err);
    res.status(500).json({ message: "Failed to update grading system" });
  }
};

/* =========================================================================
   EXPORTS (single source of truth — no other module.exports in this file)
========================================================================= */
module.exports = {
  setDesktopOnly,
  setMusicPaper,
  setModelSheet,
  getAccessSettings, getStudentsActivation, setStudentsActivation,
  setAccessSettings,
  setSecuritySettings,
  setSebSettings,
  getSecuritySettings,
  getActivityLog,
  // core
  createEAssessment, updateEAssessment, getEAssessments, getEAssessmentById,
  addEAssessmentQuestion, getAssessmentQuestions, updateQuestion, deleteQuestion,
  bulkAddQuestions, parseQuestionsDocx,

  // public (no-auth) cover-page preview for the /take-assessment picker
  getPublicAssessmentCovers,

  // cover page (per-exam PDF)
  uploadCoverPage, deleteCoverPage,

  // question images (diagrams/photos)
  uploadQuestionImages, deleteQuestionImage,

  // standalone exam-password login (no portal account session)
  examLogin,

  // exam session / device lock
  startExamSession, activateExamSession, heartbeatExamSession, endExamSession,
  getExamSessions, unlockExamSession, unlockExamSessionsBulk, examSessionStatus, lockExamSession,
  autosaveExamAnswers, getExamDraft, grantResit, cancelResit, getUnsubmittedSessions,

  // camera violation photos (evidence capture, no longer a lock trigger)
  uploadViolationPhoto, getViolationPhotos, getStudentExamPhotos,

  // student
  submitEAssessment, getStudentResult,

  // admin review / stats
  getPendingAssessments, reviewAssessment, toggleEAssessmentActive, getEAssessmentQuickStats,
  deleteAssessments, deleteAssignments,
  getDeviceAccess, allowDevice, revokeDevice, downloadAttendancePdf,

  // support data
  getClasses, getSubjects, getTeachers, assignTeacher, assignTeachersBulk, getAssignedTeachers,

  // submissions / marking
  getAllSubmissions, getAssessmentSubmissions, getSubmissionForMarking, getAllSubmissionsForMarking,
  saveMarking, saveMarkingBulk, assignSubmission, bulkAssignSubmissions, smartDistribute, getAssignmentBatches, undoAssignmentBatch, getNextSubmissionForMarking,
  getMarkingSession, saveMarkingSession, clearMarkingSession,

  // remarks
  requestRemark, getRemarkRequests, reviewRemarkRequest,

  // release
  getReleasedMarks, releaseMarks, bulkReleaseMarks,

  // grading system
  getGradingSystem, updateGradingSystem,
};