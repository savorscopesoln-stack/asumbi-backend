const sql = require("mssql");
const { sendEmail, sendSms, sendWhatsapp } = require("../services/notificationChannels");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};

const VALID_CHANNELS = ["in_app", "email", "sms", "whatsapp"];
const VALID_RECIPIENT_TYPES = ["all", "students", "teachers", "admins", "class", "specific"];

const parseJsonSafe = (val, fallback) => {
  try {
    const parsed = JSON.parse(val);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

/* =========================================================================
   RECIPIENT DIRECTORY
   GET /api/broadcast-notifications/recipients?search=&type=
   Powers the "select user/user type" picker: search across Students,
   Teachers, and staff Users (admin/sub_admin) at once, or narrow to one
   type. Also returns the distinct list of student classes for the
   "whole class" option.
========================================================================= */
const getRecipientDirectory = async (req, res) => {
  try {
    const pool = req.pool;
    const search = (req.query.search || "").trim();
    const type = (req.query.type || "").trim().toLowerCase();
    const like = search ? `%${search}%` : null;

    const results = [];

    if (!type || type === "students") {
      const r = pool.request();
      let q = `
        SELECT TOP 50 id, name, username, Phone AS phone, NULL AS email, studentClass, 'Students' AS source, 'student' AS userType
        FROM Students
        WHERE status != 'graduated'
      `;
      if (like) {
        r.input("like", sql.NVarChar, like);
        q += ` AND (name LIKE @like OR admissionNo LIKE @like OR username LIKE @like)`;
      }
      q += ` ORDER BY name`;
      const out = await r.query(q);
      results.push(...(out.recordset || []));
    }

    if (!type || type === "teachers") {
      const r = pool.request();
      let q = `
        SELECT TOP 50 id, name, username, phone, email, NULL AS studentClass, 'Teachers' AS source, 'teacher' AS userType
        FROM Teachers
      `;
      if (like) {
        r.input("like", sql.NVarChar, like);
        q += ` WHERE (name LIKE @like OR staffId LIKE @like OR username LIKE @like)`;
      }
      q += ` ORDER BY name`;
      const out = await r.query(q);
      results.push(...(out.recordset || []));
    }

    if (!type || type === "admins") {
      const r = pool.request();
      let q = `
        SELECT TOP 50 id, username AS name, username, NULL AS phone, email, NULL AS studentClass, 'Users' AS source,
               LOWER(role) AS userType
        FROM Users
        WHERE LOWER(role) IN ('admin', 'sub_admin')
      `;
      if (like) {
        r.input("like", sql.NVarChar, like);
        q += ` AND (username LIKE @like OR email LIKE @like)`;
      }
      q += ` ORDER BY username`;
      const out = await r.query(q);
      results.push(...(out.recordset || []));
    }

    const classesResult = await pool.request().query(`
      SELECT DISTINCT studentClass FROM Students
      WHERE studentClass IS NOT NULL AND status != 'graduated'
      ORDER BY studentClass
    `);

    res.json({
      results,
      classes: (classesResult.recordset || []).map((r) => r.studentClass),
    });
  } catch (err) {
    console.error("GET RECIPIENT DIRECTORY ERROR:", err);
    res.status(500).json({ message: "Failed to load recipients", error: err.message });
  }
};

/* =========================================================================
   RESOLVE RECIPIENTS
   Turns { recipientType, recipientIds, studentClass } into a flat list of
   { id, source, name, email, phone } — the shape every channel needs.
========================================================================= */
const resolveRecipients = async (pool, { recipientType, recipientIds, studentClass }) => {
  const studentQuery = `
    SELECT id, name, Phone AS phone, NULL AS email, 'Students' AS source
    FROM Students WHERE status != 'graduated'
  `;
  const teacherQuery = `SELECT id, name, phone, email, 'Teachers' AS source FROM Teachers`;
  const adminQuery = `
    SELECT id, username AS name, NULL AS phone, email, 'Users' AS source
    FROM Users WHERE LOWER(role) IN ('admin', 'sub_admin')
  `;

  if (recipientType === "students") {
    const r = await pool.request().query(studentQuery);
    return r.recordset || [];
  }

  if (recipientType === "teachers") {
    const r = await pool.request().query(teacherQuery);
    return r.recordset || [];
  }

  if (recipientType === "admins") {
    const r = await pool.request().query(adminQuery);
    return r.recordset || [];
  }

  if (recipientType === "class") {
    if (!studentClass) return [];
    const r = await pool.request().input("cls", sql.NVarChar, studentClass).query(`
      SELECT id, name, Phone AS phone, NULL AS email, 'Students' AS source
      FROM Students WHERE status != 'graduated' AND studentClass = @cls
    `);
    return r.recordset || [];
  }

  if (recipientType === "all") {
    const [students, teachers, admins] = await Promise.all([
      pool.request().query(studentQuery),
      pool.request().query(teacherQuery),
      pool.request().query(adminQuery),
    ]);
    return [
      ...(students.recordset || []),
      ...(teachers.recordset || []),
      ...(admins.recordset || []),
    ];
  }

  if (recipientType === "specific") {
    const ids = Array.isArray(recipientIds) ? recipientIds : parseJsonSafe(recipientIds, []);
    if (!Array.isArray(ids) || !ids.length) return [];

    const bySource = { Students: [], Teachers: [], Users: [] };
    for (const item of ids) {
      const id = toInt(item?.id);
      const source = item?.source;
      if (id && bySource[source]) bySource[source].push(id);
    }

    const out = [];
    for (const [source, tableIds] of Object.entries(bySource)) {
      if (!tableIds.length) continue;
      const r = pool.request();
      const placeholders = tableIds.map((id, i) => {
        r.input(`id${i}`, sql.Int, id);
        return `@id${i}`;
      });
      let q;
      if (source === "Students") {
        q = `SELECT id, name, Phone AS phone, NULL AS email, 'Students' AS source FROM Students WHERE id IN (${placeholders.join(",")})`;
      } else if (source === "Teachers") {
        q = `SELECT id, name, phone, email, 'Teachers' AS source FROM Teachers WHERE id IN (${placeholders.join(",")})`;
      } else {
        q = `SELECT id, username AS name, NULL AS phone, email, 'Users' AS source FROM Users WHERE id IN (${placeholders.join(",")})`;
      }
      const result = await r.query(q);
      out.push(...(result.recordset || []));
    }
    return out;
  }

  return [];
};

/* =========================================================================
   DISPATCH
   Actually sends a broadcast row out over every requested channel, then
   updates its status/resultSummary/sentAt. Used both for "send now" and
   by the scheduler for rows whose scheduledFor time has arrived.
========================================================================= */
const dispatchBroadcast = async (pool, io, row) => {
  const channels = parseJsonSafe(row.channels, ["in_app"]);
  const recipientIds = parseJsonSafe(row.recipientIds, []);

  const recipients = await resolveRecipients(pool, {
    recipientType: row.recipientType,
    recipientIds,
    studentClass: row.studentClass,
  });

  const summary = {
    recipientCount: recipients.length,
    in_app: { sent: 0, failed: 0 },
    email: { sent: 0, failed: 0, skipped: 0 },
    sms: { sent: 0, failed: 0, skipped: 0 },
    whatsapp: { sent: 0, failed: 0, skipped: 0 },
    errors: [],
  };

  if (!recipients.length) {
    await pool.request()
      .input("id", sql.Int, row.id)
      .input("status", sql.NVarChar, "failed")
      .input("summary", sql.NVarChar, JSON.stringify({ ...summary, errors: ["No matching recipients found"] }))
      .query(`UPDATE ScheduledNotifications SET status = @status, resultSummary = @summary, sentAt = GETDATE() WHERE id = @id`);
    return { ok: false, summary };
  }

  for (const rec of recipients) {
    if (channels.includes("in_app")) {
      try {
        await pool.request()
          .input("recipientId", sql.Int, rec.id)
          .input("recipientSource", sql.NVarChar, rec.source)
          .input("title", sql.NVarChar, row.title || "Notification")
          .input("message", sql.NVarChar, row.message)
          .input("type", sql.NVarChar, "broadcast")
          .input("createdBy", sql.Int, row.createdBy)
          .input("createdBySource", sql.NVarChar, row.createdBySource)
          .query(`
            INSERT INTO Notifications
              (recipientId, recipientSource, title, message, type, isRead, createdBy, createdBySource, createdAt)
            VALUES
              (@recipientId, @recipientSource, @title, @message, @type, 0, @createdBy, @createdBySource, GETDATE())
          `);
        summary.in_app.sent++;
      } catch (err) {
        summary.in_app.failed++;
        summary.errors.push(`in_app -> ${rec.name}: ${err.message}`);
      }
    }

    if (channels.includes("email")) {
      const result = await sendEmail({ to: rec.email, subject: row.title || "Notification", message: row.message });
      if (result.ok) summary.email.sent++;
      else if (result.skipped) summary.email.skipped++;
      else {
        summary.email.failed++;
        summary.errors.push(`email -> ${rec.name}: ${result.reason}`);
      }
    }

    if (channels.includes("sms")) {
      const result = await sendSms({ to: rec.phone, message: row.message });
      if (result.ok) summary.sms.sent++;
      else if (result.skipped) summary.sms.skipped++;
      else {
        summary.sms.failed++;
        summary.errors.push(`sms -> ${rec.name}: ${result.reason}`);
      }
    }

    if (channels.includes("whatsapp")) {
      const result = await sendWhatsapp({ to: rec.phone, message: row.message });
      if (result.ok) summary.whatsapp.sent++;
      else if (result.skipped) summary.whatsapp.skipped++;
      else {
        summary.whatsapp.failed++;
        summary.errors.push(`whatsapp -> ${rec.name}: ${result.reason}`);
      }
    }
  }

  await pool.request()
    .input("id", sql.Int, row.id)
    .input("status", sql.NVarChar, "sent")
    .input("recipientCount", sql.Int, recipients.length)
    .input("summary", sql.NVarChar, JSON.stringify(summary))
    .query(`
      UPDATE ScheduledNotifications
      SET status = @status, recipientCount = @recipientCount, resultSummary = @summary, sentAt = GETDATE()
      WHERE id = @id
    `);

  // Best-effort realtime ping for in-app badges, same pattern as the
  // existing single-recipient notifications route.
  try {
    if (io && channels.includes("in_app")) io.emit("notification:new", { recipients });
  } catch (_) {}

  return { ok: true, summary };
};

/* =========================================================================
   CREATE BROADCAST
   POST /api/broadcast-notifications
   body: { title, message, channels: [...], recipientType, recipientIds,
           studentClass, scheduledFor }
   scheduledFor omitted/null/in the past -> sent immediately.
   scheduledFor in the future -> stored as 'pending', picked up by the
   scheduler tick once it's due.
========================================================================= */
const createBroadcast = async (req, res) => {
  try {
    const pool = req.pool;
    const { title, message, channels, recipientType, recipientIds, studentClass, scheduledFor } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "Message is required" });
    }

    const cleanChannels = Array.isArray(channels)
      ? channels.filter((c) => VALID_CHANNELS.includes(c))
      : [];
    if (!cleanChannels.length) {
      return res.status(400).json({ message: `At least one channel is required: ${VALID_CHANNELS.join(", ")}` });
    }

    if (!VALID_RECIPIENT_TYPES.includes(recipientType)) {
      return res.status(400).json({ message: `Invalid recipientType. Must be one of: ${VALID_RECIPIENT_TYPES.join(", ")}` });
    }
    if (recipientType === "class" && !studentClass) {
      return res.status(400).json({ message: "studentClass is required when recipientType is 'class'" });
    }
    if (recipientType === "specific" && (!Array.isArray(recipientIds) || !recipientIds.length)) {
      return res.status(400).json({ message: "recipientIds is required when recipientType is 'specific'" });
    }

    let scheduledDate = null;
    if (scheduledFor) {
      scheduledDate = new Date(scheduledFor);
      if (isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ message: "Invalid scheduledFor date" });
      }
    }
    const sendNow = !scheduledDate || scheduledDate.getTime() <= Date.now();

    const insertResult = await pool.request()
      .input("title", sql.NVarChar, title || "Notification")
      .input("message", sql.NVarChar, message)
      .input("channels", sql.NVarChar, JSON.stringify(cleanChannels))
      .input("recipientType", sql.NVarChar, recipientType)
      .input("recipientIds", sql.NVarChar, recipientType === "specific" ? JSON.stringify(recipientIds) : null)
      .input("studentClass", sql.NVarChar, recipientType === "class" ? studentClass : null)
      .input("scheduledFor", sql.DateTime, sendNow ? null : scheduledDate)
      .input("createdBy", sql.Int, req.user?.id || null)
      .input("createdBySource", sql.NVarChar, req.user?.source || req.user?.role || null)
      .query(`
        INSERT INTO ScheduledNotifications
          (title, message, channels, recipientType, recipientIds, studentClass, scheduledFor, status, createdBy, createdBySource, createdAt)
        OUTPUT INSERTED.*
        VALUES
          (@title, @message, @channels, @recipientType, @recipientIds, @studentClass, @scheduledFor, 'pending', @createdBy, @createdBySource, GETDATE())
      `);

    const row = insertResult.recordset[0];

    if (sendNow) {
      const io = req.app.get("io");
      const { summary } = await dispatchBroadcast(pool, io, row);
      return res.json({ message: "Notification sent", status: "sent", summary });
    }

    res.json({ message: `Notification scheduled for ${scheduledDate.toLocaleString()}`, status: "scheduled", id: row.id });
  } catch (err) {
    console.error("CREATE BROADCAST ERROR:", err);
    res.status(500).json({ message: "Failed to create notification", error: err.message });
  }
};

/* =========================================================================
   LIST BROADCASTS (history — sent, scheduled/pending, cancelled)
   GET /api/broadcast-notifications
========================================================================= */
const listBroadcasts = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT * FROM ScheduledNotifications ORDER BY id DESC
    `);
    const rows = (result.recordset || []).map((r) => ({
      ...r,
      channels: parseJsonSafe(r.channels, []),
      recipientIds: parseJsonSafe(r.recipientIds, []),
      resultSummary: parseJsonSafe(r.resultSummary, null),
    }));
    res.json(rows);
  } catch (err) {
    console.error("LIST BROADCASTS ERROR:", err);
    res.status(500).json([]);
  }
};

/* =========================================================================
   CANCEL A SCHEDULED (NOT YET SENT) BROADCAST
   DELETE /api/broadcast-notifications/:id
========================================================================= */
const cancelBroadcast = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });

    const result = await pool.request()
      .input("id", sql.Int, id)
      .query(`
        UPDATE ScheduledNotifications
        SET status = 'cancelled'
        OUTPUT INSERTED.*
        WHERE id = @id AND status = 'pending'
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ message: "Nothing to cancel — it may already have been sent" });
    }

    res.json({ message: "Scheduled notification cancelled" });
  } catch (err) {
    console.error("CANCEL BROADCAST ERROR:", err);
    res.status(500).json({ message: "Failed to cancel notification", error: err.message });
  }
};

module.exports = {
  getRecipientDirectory,
  createBroadcast,
  listBroadcasts,
  cancelBroadcast,
  dispatchBroadcast,
};
