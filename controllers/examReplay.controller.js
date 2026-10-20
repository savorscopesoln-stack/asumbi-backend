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
const MAX_REPLAY_BATCH = 2000;

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

/* ---------------------------------------------------------------------------
   STUDENTS WHO DID NOT SIT THE PAPER
   "Didn't sit" = a student this paper is for (same audience rule that decides
   who may enter it: class / year, restriction list, active, not blocked) who has
   no submission and no exam session that was ever used — either no session at
   all, or one that was issued but never started and has no replay waiting.
   They can be given the paper the same way as a replay: a fresh token, and
   nobody else gets in.
--------------------------------------------------------------------------- */
async function loadAbsentStudents(pool, assessmentId) {
  const { getPermittedStudents } = require("../utils/examAccess");
  const permitted = await getPermittedStudents(pool, assessmentId);
  if (!permitted.length) return [];
  const used = await pool.request().input("aid", sql.Int, assessmentId).query(`
    SELECT es.student_id FROM e_assessment_exam_sessions es
    WHERE es.e_assessment_id = @aid
      AND NOT (es.status = 'issued' AND ISNULL(es.resit_allowed, 0) = 0)
    UNION
    SELECT sub.student_id FROM e_assessment_submissions sub WHERE sub.e_assessment_id = @aid`);
  const sat = new Set(used.recordset.map((r) => r.student_id));
  return permitted.filter((st) => !sat.has(st.id));
}

// Gives one absent student their first sitting (kept as attempt 1: there is nothing to replace).
async function grantFirstSitting(pool, req, assessmentId, studentId, title) {
  const { generateToken } = require("./eAssessment.controller"); // lazy: avoids a load-order cycle
  const by = toInt(req.user?.id);
  let token = null;
  for (let i = 0; i < 5 && !token; i++) {
    const t = generateToken();
    try {
      const upd = await pool.request()
        .input("aid", sql.Int, assessmentId).input("sid", sql.Int, studentId)
        .input("token", sql.Char(6), t).input("by", sql.Int, by)
        .query(`
          UPDATE e_assessment_exam_sessions
          SET token = @token, status = 'issued', device_id = NULL, device_label = NULL, locked_at = NULL,
              lock_reason = NULL, ended_at = NULL, activated_at = NULL, last_heartbeat = NULL, auto_submitted = 0,
              resit_allowed = 1, resit_policy = 'replace', resit_granted_at = GETDATE(), resit_granted_by = @by
          WHERE e_assessment_id = @aid AND student_id = @sid AND status = 'issued' AND ISNULL(resit_allowed, 0) = 0`);
      if (!upd.rowsAffected[0]) {
        await pool.request()
          .input("aid", sql.Int, assessmentId).input("sid", sql.Int, studentId)
          .input("token", sql.Char(6), t).input("by", sql.Int, by)
          .query(`
            INSERT INTO e_assessment_exam_sessions
              (e_assessment_id, student_id, token, status, resit_allowed, attempt_no, resit_policy, resit_granted_at, resit_granted_by)
            VALUES (@aid, @sid, @token, 'issued', 1, 1, 'replace', GETDATE(), @by)`);
      }
      token = t;
    } catch (e) {
      if (e.number === 2627 || e.number === 2601) continue; // token collision — try another
      throw e;
    }
  }
  if (!token) return { ok: false, message: "Could not issue an exam token. Please try again." };
  await pool.request().input("aid", sql.Int, assessmentId).input("sid", sql.Int, studentId)
    .query(`DELETE FROM e_assessment_drafts WHERE e_assessment_id = @aid AND student_id = @sid`);
  try {
    const { notifyOne } = require("../utils/notify");
    await notifyOne(pool, studentId, "Students", {
      title: "Exam Opportunity",
      message: `You have been given a chance to sit "${title || "an assessment"}". Sign in to the exam to take it.`,
      type: "exam",
    });
  } catch (e) { console.error("FIRST SITTING NOTIFY ERROR:", e.message); }
  return { ok: true };
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

    const scope = req.query.scope === "absent" ? "absent" : "sat";
    const absent = await loadAbsentStudents(pool, session.e_assessment_id);

    let students = [];
    if (scope === "absent") {
      if (q.length >= 2) {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
        students = absent
          .filter((st) => {
            const hay = `${st.name || ""} ${st.username || ""} ${st.studentClass || ""}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          })
          .slice(0, 50)
          .map((st) => ({
            student_id: st.id, name: st.name, username: st.username, class_name: st.studentClass,
            session_status: "not_sat", attempt_no: 1, resit_allowed: 0, score: null, submission_status: null,
          }));
      }
    } else if (q.length >= 2) {
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
      summary: { sat: c.total || 0, pending: c.pending || 0, replayed: c.replayed || 0, absent: absent.length },
      scope,
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
    const { session, error } = await loadDoneSession(pool, mainExamId, id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    // "Select all": every student who sat this paper and does not already have a
    // replay waiting. The server resolves the list so a big class never has to be
    // sent from (or even loaded in) the browser.
    let ids = [];
    const wantAll = req.body?.all === true;
    const wantAllAbsent = req.body?.all_absent === true;
    if (wantAll) {
      const rows = await pool.request().input("aid", sql.Int, session.e_assessment_id).query(`
        SELECT DISTINCT es.student_id
        FROM e_assessment_exam_sessions es
        LEFT JOIN e_assessment_submissions sub
               ON sub.e_assessment_id = es.e_assessment_id AND sub.student_id = es.student_id
        WHERE es.e_assessment_id = @aid
          AND (es.status = 'ended' OR sub.id IS NOT NULL)
          AND NOT (ISNULL(es.resit_allowed, 0) = 1 AND es.status = 'issued')`);
      ids = rows.recordset.map((r) => r.student_id).filter(Boolean);
      if (!ids.length && !wantAllAbsent && !(Array.isArray(req.body?.student_ids) && req.body.student_ids.length)) {
        return res.status(409).json({ success: false, message: "Every student who sat this paper already has a replay waiting." });
      }
    }
    // Ticked students (sat the paper OR didn't sit it) and, when asked, every student who didn't sit.
    const ticked = Array.isArray(req.body?.student_ids) ? req.body.student_ids.map(toInt).filter(Boolean) : [];
    const absentList = await loadAbsentStudents(pool, session.e_assessment_id);
    const absentSet = new Set(absentList.map((st) => st.id));
    if (wantAllAbsent) absentList.forEach((st) => ids.push(st.id));
    ids = [...new Set([...ids, ...ticked])];
    if (!ids.length) {
      return res.status(wantAll || wantAllAbsent ? 409 : 400).json({ success: false,
        message: wantAllAbsent ? "There is nobody left who didn't sit this paper." : "Select at least one student to replay the paper for." });
    }
    if (ids.length > MAX_REPLAY_BATCH) return res.status(400).json({ success: false, message: `Too many students at once (max ${MAX_REPLAY_BATCH}).` });

    const { grantResit } = require("./eAssessment.controller"); // lazy: avoids a load-order cycle
    const score_policy = req.body?.score_policy === "keep_best" ? "keep_best" : "replace";
    const granted = [];
    const failed = [];
    let firstSittings = 0;
    for (const studentId of ids) {
      if (absentSet.has(studentId)) {
        // never sat it: a first sitting, not a re-sit (the paper's audience was checked above)
        const out = await grantFirstSitting(pool, req, session.e_assessment_id, studentId, session.subject);
        if (out.ok) { granted.push(studentId); firstSittings += 1; }
        else failed.push({ student_id: studentId, message: out.message });
        continue;
      }
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
      details: { subject: session.subject, granted: granted.length, first_sittings: firstSittings, failed: failed.length, student_ids: granted, score_policy, all: wantAll, all_absent: wantAllAbsent },
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

/* =========================================================================
   ADD TIME TO AN ACTIVE EXAM
   POST /:mainExamId/subjects/:id/extend   { minutes }
   Pushes the subject's end_time (so the scheduler does not close it early) and
   the assessment's duration_minutes (which every student's countdown, and the
   auto-submit sweep, are computed from) forward by the same amount. Students
   already sitting pick the new time up on their next autosave/heartbeat.
========================================================================= */
const MAX_EXTRA_MINUTES = 240;

const extendActiveExam = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    const minutes = toInt(req.body?.minutes);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });
    if (!minutes || minutes > MAX_EXTRA_MINUTES) {
      return res.status(400).json({ success: false, message: `Enter the extra time in whole minutes (1 to ${MAX_EXTRA_MINUTES}).` });
    }

    const r = await pool.request()
      .input("id", sql.Int, id).input("mid", sql.Int, mainExamId)
      .query(`SELECT id, subject, status, e_assessment_id, end_time, duration_minutes
              FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mid`);
    const row = r.recordset[0];
    if (!row) return res.status(404).json({ success: false, message: "Subject session not found" });
    if (row.status !== "active") return res.status(409).json({ success: false, message: "Time can only be added while the exam is active." });
    if (!row.e_assessment_id) return res.status(409).json({ success: false, message: "This subject has no assessment attached." });

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).input("id", sql.Int, id).input("m", sql.Int, minutes).query(`
        UPDATE exam_subject_sessions
        SET end_time = CASE WHEN end_time IS NULL THEN NULL ELSE DATEADD(MINUTE, @m, end_time) END,
            duration_minutes = CASE WHEN duration_minutes IS NULL THEN NULL ELSE duration_minutes + @m END,
            updatedAt = GETDATE()
        WHERE id = @id AND status = 'active'`);
      await new sql.Request(tx).input("aid", sql.Int, row.e_assessment_id).input("m", sql.Int, minutes).query(
        `UPDATE e_assessments SET duration_minutes = ISNULL(duration_minutes, 30) + @m WHERE id = @aid`);
      await tx.commit();
    } catch (e) { await tx.rollback().catch(() => {}); throw e; }

    const after = await pool.request().input("aid", sql.Int, row.e_assessment_id)
      .query(`SELECT duration_minutes FROM e_assessments WHERE id = @aid`);
    const newDuration = after.recordset[0]?.duration_minutes ?? null;

    await logExamAudit(pool, {
      mainExaminationId: mainExamId, examSubjectSessionId: id, action: "exam_time_extended",
      actorId: req.user?.id, actorRole: req.user?.role,
      details: { subject: row.subject, added_minutes: minutes, new_duration_minutes: newDuration },
    });

    try {
      const io = req.app?.get("io");
      const tenant = String(req.tenantKey || req.tenant || "default").toLowerCase();
      io?.to(`tenant:${tenant}`).emit("main-exam:time-extended", { mainExaminationId: mainExamId, subjectSessionId: id, minutes });
    } catch (_) { /* live push is best-effort; students resync on autosave anyway */ }

    res.json({
      success: true, added_minutes: minutes, duration_minutes: newDuration,
      message: `Added ${minutes} minute${minutes === 1 ? "" : "s"} to ${row.subject}. Students see it within a minute.`,
    });
  } catch (err) {
    console.error("EXTEND EXAM ERROR:", err);
    res.status(500).json({ success: false, message: "Server error adding time" });
  }
};

module.exports = { getReplayCandidates, grantReplay, cancelReplay, extendActiveExam };
