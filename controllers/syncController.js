const sql = require("mssql");
const crypto = require("crypto");
const { hashToken } = require("../middleware/syncDeviceAuth");

// Records a pull/push attempt — success OR failure — so "Recent sync
// activity" actually reflects reality. Previously only successful pulls
// and successful/duplicate pushes were ever logged, so a device that was
// unauthorized, mistyped an assessment id, or hit a server error left no
// trace at all: the admin panel just looked idle. Best-effort — a logging
// failure should never mask the real error being reported to the caller.
async function logSyncAttempt(pool, { deviceId, assessmentId, direction, status, recordCount = 0, message = null }) {
  try {
    await pool.request()
      .input("device_id", sql.Int, deviceId)
      .input("assessment_id", sql.Int, assessmentId ?? null)
      .input("direction", sql.NVarChar(10), direction)
      .input("record_count", sql.Int, recordCount)
      .input("status", sql.NVarChar(20), status)
      .input("message", sql.NVarChar(500), message)
      .query(`
        INSERT INTO e_assessment_sync_logs (device_id, e_assessment_id, direction, record_count, status, message)
        VALUES (@device_id, @assessment_id, @direction, @record_count, @status, @message)
      `);
  } catch (logErr) {
    console.error("SYNC LOG WRITE FAILED:", logErr);
  }
}

/* =========================================================================
   ADMIN — DEVICE MANAGEMENT
========================================================================= */

// POST /api/local-sync/devices  { device_name, assessment_ids: [1,2,3] }
// Returns the raw token ONCE — it is never retrievable again, only its
// hash is stored. If it's lost, revoke the device and register a new one.
const createSyncDevice = async (req, res) => {
  try {
    const pool = req.pool;
    const { device_name, assessment_ids } = req.body;
    if (!device_name || !Array.isArray(assessment_ids) || !assessment_ids.length) {
      return res.status(400).json({ success: false, message: "device_name and at least one assessment_id are required" });
    }

    const rawToken = crypto.randomBytes(24).toString("hex"); // shown once to the admin
    const created_by = req.user?.id || null;
    // req.tenant is set by server.js's DB middleware from the ADMIN's own
    // JWT — this is the one place we reliably know which tenant this
    // device belongs to, since the local exam server's later pull/push
    // calls carry no JWT at all. Stamp it now so authenticateSyncDevice
    // can look the device up in the right tenant DB later (see
    // middleware/syncDeviceAuth.js).
    const tenantKey = String(req.tenant || "default").toLowerCase();

    const result = await pool.request()
      .input("device_name", sql.NVarChar(200), device_name)
      .input("token_hash", sql.NVarChar(128), hashToken(rawToken))
      .input("tenant_key", sql.NVarChar(50), tenantKey)
      .input("created_by", sql.Int, created_by)
      .query(`
        INSERT INTO e_assessment_sync_devices (device_name, token_hash, tenant_key, created_by)
        OUTPUT INSERTED.id
        VALUES (@device_name, @token_hash, @tenant_key, @created_by)
      `);
    const deviceId = result.recordset[0].id;

    for (const aid of assessment_ids) {
      await pool.request()
        .input("device_id", sql.Int, deviceId)
        .input("assessment_id", sql.Int, aid)
        .query(`
          INSERT INTO e_assessment_sync_device_assessments (device_id, e_assessment_id)
          VALUES (@device_id, @assessment_id)
        `);
    }

    res.status(201).json({
      success: true,
      device: { id: deviceId, device_name },
      token: rawToken, // display this to the admin once, then never again
      // Also shown once: the local exam server needs BOTH of these — the
      // token as SYNC_TOKEN and this as SYNC_TENANT_KEY (or applied
      // together via the admin page's "apply reissued token" flow) — or
      // every pull/push will 401 against the wrong tenant DB.
      tenant_key: tenantKey,
    });
  } catch (err) {
    console.error("CREATE SYNC DEVICE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/local-sync/devices
const getSyncDevices = async (req, res) => {
  try {
    const pool = req.pool;
    const devices = await pool.request().query(`
      SELECT d.id, d.device_name, d.tenant_key, d.is_active, d.last_pull_at, d.last_push_at, d.createdAt
      FROM e_assessment_sync_devices d
      ORDER BY d.createdAt DESC
    `);

    const assignments = await pool.request().query(`
      SELECT da.device_id, da.e_assessment_id, a.title
      FROM e_assessment_sync_device_assessments da
      JOIN e_assessments a ON a.id = da.e_assessment_id
    `);

    const byDevice = {};
    assignments.recordset.forEach((row) => {
      (byDevice[row.device_id] ||= []).push({ id: row.e_assessment_id, title: row.title });
    });

    res.json({
      success: true,
      devices: devices.recordset.map((d) => ({ ...d, assessments: byDevice[d.id] || [] })),
    });
  } catch (err) {
    console.error("GET SYNC DEVICES ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// PUT /api/local-sync/devices/:id/revoke
const revokeSyncDevice = async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request()
      .input("id", sql.Int, req.params.id)
      .query(`UPDATE e_assessment_sync_devices SET is_active = 0 WHERE id = @id`);
    res.json({ success: true });
  } catch (err) {
    console.error("REVOKE SYNC DEVICE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// PUT /api/local-sync/devices/:id/reissue
// Rotates a device's token and re-activates it. This is the resync path:
// a lab machine that was revoked (or whose token leaked/was lost) keeps
// its identity, assessment assignments, and history — it just gets a new
// token to authenticate with. The old token stops working immediately
// (we overwrite token_hash), so this doubles as a safe "kick and replace"
// even for a device that was never revoked.
const reissueSyncDevice = async (req, res) => {
  try {
    const pool = req.pool;

    const existing = await pool.request()
      .input("id", sql.Int, req.params.id)
      .query(`SELECT id, device_name, tenant_key FROM e_assessment_sync_devices WHERE id = @id`);
    const device = existing.recordset[0];
    if (!device) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    const rawToken = crypto.randomBytes(24).toString("hex"); // shown once to the admin
    // Re-stamp tenant_key from THIS request's own tenant too (not just
    // carry the old value forward) — reissue is also the recovery path
    // for a device whose tenant_key predates this fix and was only
    // backfilled to a guess by the migration.
    const tenantKey = String(req.tenant || device.tenant_key || "default").toLowerCase();

    await pool.request()
      .input("id", sql.Int, req.params.id)
      .input("token_hash", sql.NVarChar(128), hashToken(rawToken))
      .input("tenant_key", sql.NVarChar(50), tenantKey)
      .query(`
        UPDATE e_assessment_sync_devices
        SET token_hash = @token_hash, tenant_key = @tenant_key, is_active = 1
        WHERE id = @id
      `);

    res.json({
      success: true,
      device: { id: device.id, device_name: device.device_name },
      token: rawToken, // display this to the admin once, then never again
      tenant_key: tenantKey, // give this to the local server too — see createSyncDevice's note
    });
  } catch (err) {
    console.error("REISSUE SYNC DEVICE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/local-sync/logs?device_id=&assessment_id=
const getSyncLogs = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request()
      .input("device_id", sql.Int, req.query.device_id || null)
      .query(`
        SELECT l.*, d.device_name
        FROM e_assessment_sync_logs l
        JOIN e_assessment_sync_devices d ON d.id = l.device_id
        WHERE (@device_id IS NULL OR l.device_id = @device_id)
        ORDER BY l.createdAt DESC
      `);
    res.json({ success: true, logs: result.recordset });
  } catch (err) {
    console.error("GET SYNC LOGS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =========================================================================
   DEVICE-AUTHENTICATED — PULL PACKAGE
   GET /api/local-sync/pull/:assessmentId   (header: X-Sync-Token)
========================================================================= */
// Builds the same flat {assessment, questions, options, images, roster}
// package pullPackage always returned for a single e_assessment — pulled
// out into its own helper so pullExamPackage (whole-Main-Examination
// bundle, see below) can build one of these per subject without
// duplicating the question/option/image/roster queries.
async function buildAssessmentPackage(pool, assessmentId) {
  const aRes = await pool.request()
    .input("id", sql.Int, assessmentId)
    .query(`
      SELECT id, title, subject, class_id, year_of_study, duration_minutes,
             total_marks, instructions, exam_password, cover_page_url
      FROM e_assessments WHERE id = @id
    `);
  if (!aRes.recordset.length) return null;
  const assessment = aRes.recordset[0];

  const qRes = await pool.request()
    .input("aid", sql.Int, assessmentId)
    .query(`
      SELECT id, question_text, question_type, marks, time_limit, correct_answer, marking_guide
      FROM e_assessment_questions WHERE e_assessment_id = @aid ORDER BY id
    `);
  const questions = qRes.recordset;

  const qIds = questions.map((q) => q.id);
  let options = [], images = [];
  if (qIds.length) {
    const idList = qIds.join(",");
    const oRes = await pool.request().query(`
      SELECT question_id, option_label, option_text
      FROM e_assessment_options WHERE question_id IN (${idList})
    `);
    options = oRes.recordset;
    const iRes = await pool.request().query(`
      SELECT question_id, image_url, sort_order
      FROM e_assessment_question_images WHERE question_id IN (${idList}) ORDER BY sort_order
    `);
    images = iRes.recordset;
  }

  // Roster: students in the assessment's class, so the local server can
  // validate exam logins entirely offline. Students has no class_id
  // column — class membership is matched by name (Students.studentClass
  // = Classes.name), same as everywhere else in this codebase. Also
  // honor year_of_study-targeted assessments the same way, or a
  // whole-year assessment would pull an empty roster.
  const rosterRes = await pool.request()
    .input("class_id", sql.Int, assessment.class_id)
    .input("year_of_study", sql.Int, assessment.year_of_study)
    .query(`
      SELECT DISTINCT st.id, st.username, st.name
      FROM Students st
      WHERE st.studentClass = (SELECT name FROM Classes WHERE id = @class_id)
         OR (@year_of_study IS NOT NULL AND st.yearOfStudy = @year_of_study)
    `);

  return { assessment, questions, options, images, roster: rosterRes.recordset };
}

const pullPackage = async (req, res) => {
  try {
    const pool = req.pool;
    const deviceId = req.syncDevice.id;
    const assessmentId = parseInt(req.params.assessmentId);

    // Scope check: this device must be explicitly authorized for this
    // assessment (the "modular — only what it needs" boundary).
    const scope = await pool.request()
      .input("device_id", sql.Int, deviceId)
      .input("assessment_id", sql.Int, assessmentId)
      .query(`
        SELECT 1 FROM e_assessment_sync_device_assessments
        WHERE device_id = @device_id AND e_assessment_id = @assessment_id
      `);
    if (!scope.recordset.length) {
      await logSyncAttempt(pool, {
        deviceId, assessmentId, direction: "pull", status: "error",
        message: "This device is not authorized for that assessment",
      });
      return res.status(403).json({ success: false, message: "This device is not authorized for that assessment" });
    }

    const built = await buildAssessmentPackage(pool, assessmentId);
    if (!built) {
      await logSyncAttempt(pool, {
        deviceId, assessmentId, direction: "pull", status: "error",
        message: "Assessment not found",
      });
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    const { assessment, questions, options, images, roster } = built;

    // Attach options/images to their question client-side (keeps the
    // package simple and flat — the local server can nest them itself).
    const packageOut = {
      package_format: 1,
      exported_at: new Date().toISOString(),
      assessment,
      questions,
      options,
      images,
      roster,
    };

    await logSyncAttempt(pool, {
      deviceId, assessmentId, direction: "pull", status: "ok",
      recordCount: questions.length,
      message: `${questions.length} question(s), ${roster.length} student(s)`,
    });
    await pool.request()
      .input("id", sql.Int, deviceId)
      .query(`UPDATE e_assessment_sync_devices SET last_pull_at = GETDATE() WHERE id = @id`);

    res.json({ success: true, package: packageOut });
  } catch (err) {
    console.error("PULL PACKAGE ERROR:", err);
    await logSyncAttempt(req.pool, {
      deviceId: req.syncDevice?.id, assessmentId: parseInt(req.params.assessmentId),
      direction: "pull", status: "error", message: "Server error while building package",
    });
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =========================================================================
   DEVICE-AUTHENTICATED — PULL WHOLE MAIN EXAMINATION BY EXAM CODE
   GET /api/local-sync/pull-exam/:examCode   (header: X-Sync-Token[, X-Tenant-Key])

   The single-assessment pullPackage above needs every subject
   individually authorized in e_assessment_sync_device_assessments
   first. For a whole Main Examination that's a lot of manual per-
   subject setup for what's really one event — instead, the exam_code
   itself (see generateExamCode() in mainExam.controller.js) IS the
   authorization: any device with a valid sync token for this tenant
   that also knows the exam code may pull the whole bundle. That code
   is meant to be treated like the existing per-assessment exam_password
   — shared only with whoever is actually running the local server for
   that sitting.

   Returns the timetable (§5-§6, all exam_subject_sessions rows) plus
   one buildAssessmentPackage() bundle per subject that has an
   e_assessment_id attached — so the local server's "pull whole exam"
   button downloads everything it needs (every subject's questions,
   options, images and roster, plus the schedule to run them by) in a
   single call, offline-ready after that.
========================================================================= */
const pullExamPackage = async (req, res) => {
  const pool = req.pool;
  const deviceId = req.syncDevice?.id;
  const examCode = String(req.params.examCode || "").trim().toUpperCase();
  try {
    if (!examCode) {
      return res.status(400).json({ success: false, message: "Missing exam code" });
    }

    const examRes = await pool.request()
      .input("code", sql.NVarChar(20), examCode)
      .query(`SELECT id, name, academic_year, term FROM main_examinations WHERE exam_code = @code`);
    const examination = examRes.recordset[0];
    if (!examination) {
      await logSyncAttempt(pool, {
        deviceId, direction: "pull", status: "error",
        message: `Unknown exam code "${examCode}"`,
      });
      return res.status(404).json({ success: false, message: "No examination found for that exam code" });
    }

    const sessionsRes = await pool.request()
      .input("mainExaminationId", sql.Int, examination.id)
      .query(`
        SELECT id, subject, class_id, e_assessment_id, exam_date, start_time, end_time,
               duration_minutes, venue, max_marks, instructions, status
        FROM exam_subject_sessions
        WHERE main_examination_id = @mainExaminationId
        ORDER BY start_time ASC, exam_date ASC, id ASC
      `);
    const sessions = sessionsRes.recordset;

    // Timetable is returned as its own flat list — exactly the rows
    // getTimetable() already serves the admin dashboard — so the local
    // server can show/print a schedule even for subjects it has no
    // assessment content for yet (e.g. a paper-based subject sitting
    // inside the same Main Examination).
    const timetable = sessions.map((s) => ({
      id: s.id, subject: s.subject, class_id: s.class_id, exam_date: s.exam_date,
      start_time: s.start_time, end_time: s.end_time, duration_minutes: s.duration_minutes,
      venue: s.venue, status: s.status,
    }));

    const subjects = [];
    let totalQuestions = 0;
    for (const s of sessions) {
      if (!s.e_assessment_id) {
        subjects.push({ session_id: s.id, subject: s.subject, e_assessment_id: null, package: null });
        continue;
      }
      const built = await buildAssessmentPackage(pool, s.e_assessment_id);
      if (!built) {
        subjects.push({ session_id: s.id, subject: s.subject, e_assessment_id: s.e_assessment_id, package: null });
        continue;
      }
      totalQuestions += built.questions.length;
      subjects.push({
        session_id: s.id, subject: s.subject, e_assessment_id: s.e_assessment_id,
        package: {
          package_format: 1,
          assessment: built.assessment,
          questions: built.questions,
          options: built.options,
          images: built.images,
          roster: built.roster,
        },
      });
    }

    await logSyncAttempt(pool, {
      deviceId, direction: "pull", status: "ok",
      recordCount: totalQuestions,
      message: `Whole-exam pull "${examination.name}": ${sessions.length} subject(s), ${totalQuestions} question(s) total`,
    });
    if (deviceId) {
      await pool.request()
        .input("id", sql.Int, deviceId)
        .query(`UPDATE e_assessment_sync_devices SET last_pull_at = GETDATE() WHERE id = @id`);
    }

    res.json({
      success: true,
      package: {
        package_format: 1,
        exported_at: new Date().toISOString(),
        examination: { id: examination.id, name: examination.name, academic_year: examination.academic_year, term: examination.term, exam_code: examCode },
        timetable,
        subjects,
      },
    });
  } catch (err) {
    console.error("PULL EXAM PACKAGE ERROR:", err);
    await logSyncAttempt(pool, {
      deviceId, direction: "pull", status: "error", message: "Server error while building whole-exam package",
    });
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =========================================================================
   DEVICE-AUTHENTICATED — PUSH RESULTS
   POST /api/local-sync/push   (header: X-Sync-Token)
   body: { assessment_id, batch_id, submissions: [{ student_id, submitted_at, answers: [...] }] }
========================================================================= */
const pushResults = async (req, res) => {
  const pool = req.pool;
  const transaction = new sql.Transaction(pool);
  try {
    const deviceId = req.syncDevice.id;
    const { assessment_id, batch_id, submissions } = req.body;

    if (!assessment_id || !batch_id || !Array.isArray(submissions)) {
      await logSyncAttempt(pool, {
        deviceId, assessmentId: assessment_id, direction: "push", status: "error",
        message: "assessment_id, batch_id and submissions[] are required",
      });
      return res.status(400).json({ success: false, message: "assessment_id, batch_id and submissions[] are required" });
    }

    const scope = await pool.request()
      .input("device_id", sql.Int, deviceId)
      .input("assessment_id", sql.Int, assessment_id)
      .query(`
        SELECT 1 FROM e_assessment_sync_device_assessments
        WHERE device_id = @device_id AND e_assessment_id = @assessment_id
      `);
    if (!scope.recordset.length) {
      await logSyncAttempt(pool, {
        deviceId, assessmentId: assessment_id, direction: "push", status: "error",
        message: "This device is not authorized for that assessment",
      });
      return res.status(403).json({ success: false, message: "This device is not authorized for that assessment" });
    }

    // Idempotency: if this exact batch was already pushed (e.g. the
    // connection dropped after the DB commit but before the local
    // server saw the 200), don't insert it twice.
    const dupe = await pool.request()
      .input("sync_batch_id", sql.NVarChar(64), batch_id)
      .query(`SELECT TOP 1 id FROM e_assessment_submissions WHERE sync_batch_id = @sync_batch_id`);
    if (dupe.recordset.length) {
      await pool.request()
        .input("device_id", sql.Int, deviceId)
        .input("assessment_id", sql.Int, assessment_id)
        .input("batch_id", sql.NVarChar(64), batch_id)
        .query(`
          INSERT INTO e_assessment_sync_logs (device_id, e_assessment_id, direction, batch_id, record_count, status, message)
          VALUES (@device_id, @assessment_id, 'push', @batch_id, 0, 'duplicate', 'Batch already applied')
        `);
      return res.json({ success: true, duplicate: true, message: "Batch already applied — no changes made" });
    }

    const qRes = await pool.request()
      .input("aid", sql.Int, assessment_id)
      .query(`SELECT id, correct_answer, marks, question_type FROM e_assessment_questions WHERE e_assessment_id = @aid`);
    const questionMap = {};
    qRes.recordset.forEach((q) => (questionMap[q.id] = q));
    const hasEssay = qRes.recordset.some((q) => q.question_type === "essay");

    await transaction.begin();
    let inserted = 0;

    for (const sub of submissions) {
      if (!sub.student_id) continue;

      const existing = await new sql.Request(transaction)
        .input("aid", sql.Int, assessment_id)
        .input("sid", sql.Int, sub.student_id)
        .query(`SELECT id FROM e_assessment_submissions WHERE e_assessment_id = @aid AND student_id = @sid`);
      if (existing.recordset.length) continue; // already have this student's submission — skip, don't duplicate

      const subRes = await new sql.Request(transaction)
        .input("aid", sql.Int, assessment_id)
        .input("sid", sql.Int, sub.student_id)
        .input("submitted_at", sql.DateTime, sub.submitted_at ? new Date(sub.submitted_at) : new Date())
        .input("batch_id", sql.NVarChar(64), batch_id)
        .query(`
          INSERT INTO e_assessment_submissions (e_assessment_id, student_id, submitted_at, status, sync_batch_id)
          OUTPUT INSERTED.id
          VALUES (@aid, @sid, @submitted_at, 'submitted', @batch_id)
        `);
      const submissionId = subRes.recordset[0].id;

      for (const ans of sub.answers || []) {
        if (!ans.question_id) continue;
        const q = questionMap[ans.question_id];
        const isEssay = typeof ans.essay_answer !== "undefined" && ans.essay_answer !== null;
        let isCorrect = null, marksAwarded = null;
        if (!isEssay && q) {
          isCorrect = q.correct_answer != null && ans.selected_answer === q.correct_answer;
          marksAwarded = isCorrect ? q.marks : 0;
        }
        await new sql.Request(transaction)
          .input("submission_id", sql.Int, submissionId)
          .input("question_id", sql.Int, ans.question_id)
          .input("selected_answer", sql.NVarChar(sql.MAX), ans.selected_answer || null)
          .input("essay_answer", sql.NVarChar(sql.MAX), ans.essay_answer || null)
          .input("is_correct", sql.Bit, isCorrect)
          .input("marks_awarded", sql.Int, marksAwarded)
          .query(`
            INSERT INTO e_assessment_answers (submission_id, question_id, selected_answer, essay_answer, is_correct, marks_awarded)
            VALUES (@submission_id, @question_id, @selected_answer, @essay_answer, @is_correct, @marks_awarded)
          `);
      }

      if (!hasEssay) {
        const totalRes = await new sql.Request(transaction)
          .input("submission_id", sql.Int, submissionId)
          .query(`SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`);
        await new sql.Request(transaction)
          .input("submission_id", sql.Int, submissionId)
          .input("score", sql.Int, totalRes.recordset[0].total)
          .query(`UPDATE e_assessment_submissions SET status = 'graded', score = @score WHERE id = @submission_id`);
      }

      inserted++;
    }

    await transaction.commit();

    await pool.request()
      .input("device_id", sql.Int, deviceId)
      .input("assessment_id", sql.Int, assessment_id)
      .input("batch_id", sql.NVarChar(64), batch_id)
      .input("record_count", sql.Int, inserted)
      .query(`
        INSERT INTO e_assessment_sync_logs (device_id, e_assessment_id, direction, batch_id, record_count, status)
        VALUES (@device_id, @assessment_id, 'push', @batch_id, @record_count, 'ok')
      `);
    await pool.request()
      .input("id", sql.Int, deviceId)
      .query(`UPDATE e_assessment_sync_devices SET last_push_at = GETDATE() WHERE id = @id`);

    res.json({ success: true, inserted, skipped: submissions.length - inserted });
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    console.error("PUSH RESULTS ERROR:", err);
    await logSyncAttempt(req.pool, {
      deviceId: req.syncDevice?.id, assessmentId: req.body?.assessment_id,
      direction: "push", status: "error", message: "Server error while applying submissions (rolled back)",
    });
    res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =========================================================================
   DEVICE-AUTHENTICATED — SELF DISCOVERY
   GET /api/local-sync/my-assessments   (header: X-Sync-Token)
   Lets a local server ask "what am I authorized to sync?" instead of an
   admin having to type assessment IDs into it — this is what makes the
   pull/push connection automatic rather than manual.
========================================================================= */
const getMyAssessments = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request()
      .input("device_id", sql.Int, req.syncDevice.id)
      .query(`
        SELECT a.id, a.title, a.active_status, a.status
        FROM e_assessment_sync_device_assessments da
        JOIN e_assessments a ON a.id = da.e_assessment_id
        WHERE da.device_id = @device_id
      `);
    res.json({ success: true, assessments: result.recordset });
  } catch (err) {
    console.error("GET MY ASSESSMENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  createSyncDevice, getSyncDevices, revokeSyncDevice, reissueSyncDevice, getSyncLogs,
  pullPackage, pullExamPackage, pushResults, getMyAssessments,
};
