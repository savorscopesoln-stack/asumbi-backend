const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config/db");
const { authorize } = require("../middleware/authMiddleware");

/* =========================================================
   GET /api/notifications
   The logged-in user's INBOX: every notification addressed to them
   that has not been archived yet, newest first. A notification is
   archived automatically the moment it is marked read (single or
   read-all), so the inbox only ever holds unread items plus anything
   read since the page was last loaded.

   GET /api/notifications?archived=1
   The ARCHIVE: read notifications, most recently archived first.
   Capped (default 200, max 500, ?limit=) so a long history can't
   make the page heavy.
========================================================= */
router.get("/", async (req, res) => {
  try {
    const pool = req.pool; // tenant-resolved by server.js DB middleware
    const wantArchive = ["1", "true"].includes(String(req.query.archived || "").toLowerCase());

    const request = pool.request()
      .input("id", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source);

    let result;
    if (wantArchive) {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      result = await request.input("limit", sql.Int, limit).query(`
        SELECT TOP (@limit) *
        FROM Notifications
        WHERE recipientId = @id AND recipientSource = @source AND archivedAt IS NOT NULL
        ORDER BY archivedAt DESC, createdAt DESC
      `);
    } else {
      result = await request.query(`
        SELECT *
        FROM Notifications
        WHERE recipientId = @id AND recipientSource = @source AND archivedAt IS NULL
        ORDER BY createdAt DESC
      `);
    }

    res.json(result.recordset || []);
  } catch (err) {
    console.log("GET NOTIFICATIONS ERROR:", err);
    res.status(500).json([]);
  }
});

/* =========================================================
   GET /api/notifications/unread-count
========================================================= */
router.get("/unread-count", async (req, res) => {
  try {
    const pool = req.pool; // tenant-resolved by server.js DB middleware

    const result = await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        SELECT COUNT(*) AS count
        FROM Notifications
        WHERE recipientId = @id AND recipientSource = @source AND isRead = 0
      `);

    res.json({ count: result.recordset[0]?.count || 0 });
  } catch (err) {
    console.log("UNREAD COUNT ERROR:", err);
    res.status(500).json({ count: 0 });
  }
});

/* =========================================================
   PUT /api/notifications/read-all
   Marks every inbox notification read AND archives it.
========================================================= */
router.put("/read-all", async (req, res) => {
  try {
    const pool = req.pool; // tenant-resolved by server.js DB middleware

    await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        UPDATE Notifications
        SET isRead = 1, archivedAt = GETDATE()
        WHERE recipientId = @id AND recipientSource = @source AND archivedAt IS NULL
      `);

    res.json({ message: "All notifications marked as read and archived" });
  } catch (err) {
    console.log("MARK ALL READ ERROR:", err);
    res.status(500).json({ message: "Failed to update notifications" });
  }
});

/* =========================================================
   PUT /api/notifications/:id/read
   Marks one notification read AND archives it.
========================================================= */
router.put("/:id/read", async (req, res) => {
  try {
    const pool = req.pool; // tenant-resolved by server.js DB middleware

    await pool.request()
      .input("id", sql.Int, req.params.id)
      .input("uid", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        UPDATE Notifications
        SET isRead = 1, archivedAt = ISNULL(archivedAt, GETDATE())
        WHERE id = @id AND recipientId = @uid AND recipientSource = @source
      `);

    res.json({ message: "Marked as read and archived" });
  } catch (err) {
    console.log("MARK READ ERROR:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

/* =========================================================
   POST /api/notifications   (admin / teacher / sub_admin only)
   Send a notification to a single student, a single teacher,
   a whole class, or every student.
   body: { recipientType: 'student'|'teacher'|'class'|'all_students',
           recipientId, studentClass, title, message, type }
========================================================= */
router.post("/", authorize("admin", "teacher", "sub_admin", "sub_admin_2"), async (req, res) => {
  try {
    const pool = req.pool; // tenant-resolved by server.js DB middleware
    const { recipientType, recipientId, studentClass, title, message, type } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "Message is required" });
    }

    let recipients = [];

    if (recipientType === "student" && recipientId) {
      recipients = [{ id: recipientId, source: "Students" }];
    } else if (recipientType === "teacher" && recipientId) {
      recipients = [{ id: recipientId, source: "Teachers" }];
    } else if (recipientType === "class" && studentClass) {
      const result = await pool.request()
        .input("cls", sql.NVarChar, studentClass)
        .query(`SELECT id FROM Students WHERE studentClass = @cls`);
      recipients = (result.recordset || []).map((s) => ({ id: s.id, source: "Students" }));
    } else if (recipientType === "all_students") {
      const result = await pool.request().query(`SELECT id FROM Students`);
      recipients = (result.recordset || []).map((s) => ({ id: s.id, source: "Students" }));
    } else {
      return res.status(400).json({ message: "Invalid or missing recipient" });
    }

    if (!recipients.length) {
      return res.status(404).json({ message: "No matching recipients found" });
    }

    for (const r of recipients) {
      await pool.request()
        .input("recipientId", sql.Int, r.id)
        .input("recipientSource", sql.NVarChar, r.source)
        .input("title", sql.NVarChar, title || "Notification")
        .input("message", sql.NVarChar, message)
        .input("type", sql.NVarChar, type || "general")
        .input("createdBy", sql.Int, req.user.id)
        .input("createdBySource", sql.NVarChar, req.user.source || req.user.role)
        .query(`
          INSERT INTO Notifications
            (recipientId, recipientSource, title, message, type, isRead, createdBy, createdBySource, createdAt)
          VALUES
            (@recipientId, @recipientSource, @title, @message, @type, 0, @createdBy, @createdBySource, GETDATE())
        `);
    }

    // Best-effort realtime ping — the frontend can listen for this to
    // refresh a notification badge; failure here should never break
    // the request since the DB write already succeeded.
    try {
      const io = req.app.get("io");
      if (io) io.to(`tenant:${String(req.tenant || "default").toLowerCase()}`).emit("notification:new", { recipients });
    } catch (_) {}

    res.json({ message: `Notification sent to ${recipients.length} recipient(s)` });
  } catch (err) {
    console.log("CREATE NOTIFICATION ERROR:", err);
    res.status(500).json({ message: "Failed to send notification" });
  }
});

module.exports = router;
