const sql = require("mssql");
const { logExamAudit } = require("../utils/examAuditLog");

/* =========================================================================
   REPLAY PAPER (Main Examination)
   A finished subject paper can be "replayed" for INDIVIDUAL students only.
   Nothing reopens for the class: the admin picks students, and each one is
   given a resit of the attached assessment (new token, fresh attempt, full
   duration). Everyone else stays closed. The resit machinery itself is the
   existing one (grantResit / cancelResit in eAssessment.controller.js), so a
   replay submission archives/replaces the old one exactly like any resit.
========================================================================= */

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const DONE_STATUSES = ["ended", "marking", "completed"];

// Loads the subject session and checks it is a finished paper with an assessment.
async function loadDoneSession(pool, mainExamId, id) {
  const r = await pool.request()
    .input("id", sql.Int, id)
    .input("mid", sql.Int, mainExamId)
    .query(`SELECT id, subject, paper_label, status, e_assessment_id
            FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mid`);
  const row = r.recordset[0];
  if (!row) return { error: { code: 404, message: "Subject session not found" } };
  if (!row.e_assessment_id) return { error: { code: 409, message: "This subject has no assessment attached, so there is no paper to replay." } };
  if (!DONE_STATUSES.includes(row.status)) {
    return { error: { code: 409, message: "Only a finished paper can be replayed. This one is still " + row.status + "." } };
  }
  return { session: row };
}

// Runs an existing (req,res) controller in-process and returns what it answered.
async function callController(fn, req, body) {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
  };
  await fn({ pool: req.pool, user: req.user, body }, res);
  return out;
}

/* GET /:mainExamId/subjects/:id/replay
   Summary counts always; individual students ONLY for a search (?q=), so a
   big class is never dumped on screen. */
const getReplayCandidates = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });
    const { session, error } = await loadDoneSession(pool, mainExamId, id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    const q = String(req.query.q || "").trim();
    const base = `
      FROM e_assessment_exam_sessions es
      LEFT JOIN Students st ON st.id = es.student_id
      LEFT JOIN e_assessment_submissions sub
             ON sub.e_assessment_id = es.e_assessment_id AND sub.student_id = es.student_id
      WHERE es.e_assessment_id = @aid
        AND (es.status = 'ended' OR sub.id IS NOT NULL OR es.resit_allowed = 1)`;

    const counts = await pool.request().input("aid", sql.Int, session.e_assessment_id).query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN ISNULL(es.resit_allowed, 0) = 1 AND es.status = 'issued' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN ISNULL(es.attempt_no, 1) > 1 THEN 1 ELSE 0 END) AS replayed
      ${base}`);

    let students = [];
    if (q.length >= 2) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
      const request = pool.request().input("aid", sql.Int, session.e_assessment_id);
      const likes = words.map((w, i) => {
        request.input(`w${i}`, sql.NVarChar(100), `%${w.replace(/[%_[]/g, "")}%`);
        return `(LOWER(ISNULL(st.name,'')) LIKE @w${i} OR LOWER(ISNULL(st.username,'')) LIKE @w${i} OR LOWER(ISNULL(st.studentClass,'')) LIKE @w${i})`;
      });
      const rows = await request.query(`
        SELECT TOP 50 es.student_id, st.name, st.username, st.studentClass AS class_name,
               es.status AS session_status, ISNULL(es.attempt_no, 1) AS attempt_no,
               ISNULL(es.resit_allowed, 0) AS resit_allowed,
               sub.score, sub.status AS submission_status
        ${base} AND ${likes.join(" AND ")}
        ORDER BY st.name`);
      students = rows.recordset;
    }

    const c = counts.recordset[0] || {};
    res.json({
      success: true,
      subject: session.subject,
      paper_label: session.paper_label,
      summary: { sat: c.total || 0, pending: c.pending || 0, replayed: c.replayed || 0 },
      students,
      searched: q.length >= 2,
    });
  } catch (err) {
    console.error("REPLAY CANDIDATES ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading replay candidates" });
  }
};

/* POST /:mainExamId/subjects/:id/replay   { student_ids: [..], score_policy } */
const grantReplay = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });
    const ids = Array.isArray(req.body?.student_ids)
      ? [...new Set(req.body.student_ids.map(toInt).filter(Boolean))]
      : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "Select at least one student to replay the paper for." });
    if (ids.length > 200) return res.status(400).json({ success: false, message: "Too many students at once (max 200)." });

    const { session, error } = await loadDoneSession(pool, mainExamId, id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    const { grantResit } = require("./eAssessment.controller"); // lazy: avoids a load-order cycle
    const score_policy = req.body?.score_policy === "keep_best" ? "keep_best" : "replace";
    const granted = [];
    const failed = [];
    for (const studentId of ids) {
      const out = await callController(grantResit, req, {
        assessment_id: session.e_assessment_id, student_id: studentId, score_policy,
      });
      if (out.status < 300 && out.body?.success) granted.push(studentId);
      else failed.push({ student_id: studentId, message: out.body?.message || "Could not grant" });
    }

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      examSubjectSessionId: id,
      action: "paper_replay_granted",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { subject: session.subject, granted: granted.length, failed: failed.length, student_ids: granted, score_policy },
    });

    res.json({
      success: granted.length > 0,
      granted: granted.length,
      failed,
      message: granted.length
        ? `Replay granted to ${granted.length} student${granted.length === 1 ? "" : "s"}${failed.length ? ` (${failed.length} could not be granted)` : ""}.`
        : (failed[0]?.message || "Nothing was granted."),
    });
  } catch (err) {
    console.error("GRANT REPLAY ERROR:", err);
    res.status(500).json({ success: false, message: "Server error granting replay" });
  }
};

/* POST /:mainExamId/subjects/:id/replay/cancel   { student_ids: [..] } — only replays not yet started */
const cancelReplay = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    const ids = Array.isArray(req.body?.student_ids)
      ? [...new Set(req.body.student_ids.map(toInt).filter(Boolean))]
      : [];
    if (!mainExamId || !id || !ids.length) return res.status(400).json({ success: false, message: "Select at least one student." });
    const { session, error } = await loadDoneSession(pool, mainExamId, id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    const { cancelResit } = require("./eAssessment.controller");
    let cancelled = 0;
    for (const studentId of ids) {
      const out = await callController(cancelResit, req, { assessment_id: session.e_assessment_id, student_id: studentId });
      if (out.status < 300 && out.body?.success) cancelled += 1;
    }
    await logExamAudit(pool, {
      mainExaminationId: mainExamId, examSubjectSessionId: id, action: "paper_replay_cancelled",
      actorId: req.user?.id, actorRole: req.user?.role, details: { subject: session.subject, cancelled },
    });
    res.json({ success: cancelled > 0, cancelled, message: cancelled ? `${cancelled} replay${cancelled === 1 ? "" : "s"} cancelled.` : "Nothing to cancel (students may have already started)." });
  } catch (err) {
    console.error("CANCEL REPLAY ERROR:", err);
    res.status(500).json({ success: false, message: "Server error cancelling replay" });
  }
};

module.exports = { getReplayCandidates, grantReplay, cancelReplay };
