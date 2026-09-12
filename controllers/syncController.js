const sql = require("mssql");
const crypto = require("crypto");
const { hashToken } = require("../middleware/syncDeviceAuth");

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

    const result = await pool.request()
      .input("device_name", sql.NVarChar(200), device_name)
      .input("token_hash", sql.NVarChar(128), hashToken(rawToken))
      .input("created_by", sql.Int, created_by)
      .query(`
        INSERT INTO e_assessment_sync_devices (device_name, token_hash, created_by)
        OUTPUT INSERTED.id
        VALUES (@device_name, @token_hash, @created_by)
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
      SELECT d.id, d.device_name, d.is_active, d.last_pull_at, d.last_push_at, d.createdAt
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
      return res.status(403).json({ success: false, message: "This device is not authorized for that assessment" });
    }

    const aRes = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT id, title, subject, class_id, year_of_study, duration_minutes,
               total_marks, instructions, exam_password, cover_page_url
        FROM e_assessments WHERE id = @id
      `);
    if (!aRes.recordset.length) return res.status(404).json({ success: false, message: "Assessment not found" });
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

    // Roster: students in the assessment's class, so the local server
    // can validate exam logins entirely offline.
    const rosterRes = await pool.request()
      .input("class_id", sql.Int, assessment.class_id)
      .query(`SELECT id, username, name FROM Students WHERE class_id = @class_id`);

    // Attach options/images to their question client-side (keeps the
    // package simple and flat — the local server can nest them itself).
    const packageOut = {
      package_format: 1,
      exported_at: new Date().toISOString(),
      assessment,
      questions,
      options,
      images,
      roster: rosterRes.recordset,
    };

    await pool.request()
      .input("device_id", sql.Int, deviceId)
      .input("assessment_id", sql.Int, assessmentId)
      .input("record_count", sql.Int, questions.length)
      .query(`
        INSERT INTO e_assessment_sync_logs (device_id, e_assessment_id, direction, record_count, status)
        VALUES (@device_id, @assessment_id, 'pull', @record_count, 'ok')
      `);
    await pool.request()
      .input("id", sql.Int, deviceId)
      .query(`UPDATE e_assessment_sync_devices SET last_pull_at = GETDATE() WHERE id = @id`);

    res.json({ success: true, package: packageOut });
  } catch (err) {
    console.error("PULL PACKAGE ERROR:", err);
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
  createSyncDevice, getSyncDevices, revokeSyncDevice, getSyncLogs,
  pullPackage, pushResults, getMyAssessments,
};
