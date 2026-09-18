const sql = require("mssql");

/* =========================================================================
   STUDENT-FACING MAIN EXAMINATION VIEWS (§39-§40, Phase 14)

   §58 governs every query in this file: this is the one part of the
   whole Main Examination feature that runs on the student hot path, not
   just an admin dashboard. Each endpoint below is a small, fixed number
   of indexed queries (see migrations/2026-09-18_add_main_exam_student_
   indexes.sql) — never a per-subject loop, never anything that touches
   analytics/marking computation. Entering an exam itself is still
   entirely the EXISTING /api/e-assessments/:id/start-exam flow (§9) —
   this file only tells the student WHAT they can enter and WHEN, it
   never itself activates or grades anything.

   §39's "do not expose an examination before its scheduled time" is
   satisfied for free here: a subject session only appears at all once
   it's left 'draft' (i.e. the timetable has been published), and
   whether the student can actually press [ENTER EXAM] is still gated
   by the existing e_assessments.active_status check in the exam-entry
   route itself — this endpoint is just a read-only summary for the UI,
   never the authority on whether entry is allowed (§8).
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

async function loadStudent(pool, studentId) {
  const result = await pool.request().input("id", sql.Int, studentId)
    .query(`SELECT id, name, studentClass, yearOfStudy FROM Students WHERE id = @id`);
  return result.recordset[0] || null;
}

/* The one query every endpoint below is built on: every published
   (non-draft) subject session, across every non-archived Main
   Examination, that applies to this student's class or year — using
   the same class-name-match / year-of-study rule the scheduler and
   admin dashboard already use (§39's own audience rule, kept in one
   place, not re-invented per endpoint). */
async function loadMySessions(pool, student, mainExamId = null) {
  const request = pool.request()
    .input("studentClass", sql.NVarChar, student.studentClass || "")
    .input("yearOfStudy", sql.Int, student.yearOfStudy || 0);
  let mainExamFilter = "";
  if (mainExamId) {
    request.input("mainExamId", sql.Int, mainExamId);
    mainExamFilter = "AND me.id = @mainExamId";
  }
  const result = await request.query(`
    SELECT
      ess.id AS session_id, ess.subject, ess.status, ess.exam_date,
      ess.start_time, ess.end_time, ess.venue, ess.e_assessment_id,
      me.id AS main_examination_id, me.name AS main_examination_name
    FROM exam_subject_sessions ess
    JOIN e_assessments ea ON ea.id = ess.e_assessment_id
    JOIN main_examinations me ON me.id = ess.main_examination_id
    LEFT JOIN Classes c ON c.id = ea.class_id
    WHERE ess.status <> 'draft'
      AND me.status <> 'archived'
      AND ( (c.name IS NOT NULL AND c.name = @studentClass) OR ea.year_of_study = @yearOfStudy )
      ${mainExamFilter}
    ORDER BY ess.start_time ASC, ess.id ASC
  `);
  return result.recordset;
}

/* This student's own submission status for a batch of assessment ids —
   one query regardless of how many subjects, never one query per
   subject. */
async function loadMySubmissions(pool, studentId, assessmentIds) {
  if (!assessmentIds.length) return {};
  const request = pool.request().input("studentId", sql.Int, studentId);
  const idParams = assessmentIds.map((aid, i) => { request.input(`aid${i}`, sql.Int, aid); return `@aid${i}`; });
  const result = await request.query(`
    SELECT e_assessment_id, status
    FROM e_assessment_submissions
    WHERE student_id = @studentId AND e_assessment_id IN (${idParams.join(",")})
  `);
  const map = {};
  result.recordset.forEach((r) => { map[r.e_assessment_id] = r.status; });
  return map;
}

function deriveDisplayStatus(session, submissionStatus) {
  if (submissionStatus === "marked" || submissionStatus === "released") return "completed";
  if (submissionStatus) return "completed"; // submitted, awaiting marking — done from the student's side
  if (session.status === "active") return "active";
  if (["ended", "marking", "completed"].includes(session.status)) return "absent";
  return "upcoming";
}

/* =========================================================================
   DASHBOARD (§39) — the "ACTIVE EXAMINATION / [ENTER EXAM]" card, plus
   short upcoming/completed lists, across every Main Examination this
   student currently has a stake in. Three queries total, none of them
   per-subject.
========================================================================= */
const getMyExamDashboard = async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = toInt(req.user.id);
    const student = await loadStudent(pool, studentId);
    if (!student) return res.status(404).json({ success: false, message: "Student not found" });

    const sessions = await loadMySessions(pool, student);
    const assessmentIds = [...new Set(sessions.map((s) => s.e_assessment_id).filter(Boolean))];
    const submissionMap = await loadMySubmissions(pool, studentId, assessmentIds);

    const shaped = sessions.map((s) => ({
      session_id: s.session_id,
      main_examination_id: s.main_examination_id,
      main_examination_name: s.main_examination_name,
      subject: s.subject,
      exam_date: s.exam_date,
      start_time: s.start_time,
      end_time: s.end_time,
      venue: s.venue,
      e_assessment_id: s.e_assessment_id,
      status: deriveDisplayStatus(s, submissionMap[s.e_assessment_id]),
    }));

    res.json({
      success: true,
      active: shaped.filter((s) => s.status === "active"),
      upcoming: shaped.filter((s) => s.status === "upcoming"),
      completed: shaped.filter((s) => s.status === "completed" || s.status === "absent"),
    });
  } catch (err) {
    console.error("GET MY EXAM DASHBOARD ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading your examinations" });
  }
};

/* =========================================================================
   MY TIMETABLE (§40) — full ordered schedule for one Main Examination.
========================================================================= */
const getMyTimetable = async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = toInt(req.user.id);
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const student = await loadStudent(pool, studentId);
    if (!student) return res.status(404).json({ success: false, message: "Student not found" });

    const sessions = await loadMySessions(pool, student, mainExamId);
    if (!sessions.length) {
      return res.json({ success: true, examination: null, timetable: [] });
    }

    const assessmentIds = [...new Set(sessions.map((s) => s.e_assessment_id).filter(Boolean))];
    const submissionMap = await loadMySubmissions(pool, studentId, assessmentIds);

    const timetable = sessions.map((s) => ({
      session_id: s.session_id,
      subject: s.subject,
      exam_date: s.exam_date,
      start_time: s.start_time,
      end_time: s.end_time,
      venue: s.venue,
      status: deriveDisplayStatus(s, submissionMap[s.e_assessment_id]),
    }));

    res.json({
      success: true,
      examination: { id: sessions[0].main_examination_id, name: sessions[0].main_examination_name },
      timetable,
    });
  } catch (err) {
    console.error("GET MY TIMETABLE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading your timetable" });
  }
};

module.exports = { getMyExamDashboard, getMyTimetable };
