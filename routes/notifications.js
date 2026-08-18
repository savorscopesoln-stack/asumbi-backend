const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config/db");
const { authorize } = require("../middleware/authMiddleware");

/* =========================================================
   GET /api/notifications
   Every notification addressed to the logged-in user
   (student / teacher / admin), newest first.
========================================================= */
router.get("/", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        SELECT *
        FROM Notifications
        WHERE recipientId = @id AND recipientSource = @source
        ORDER BY createdAt DESC
      `);

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
    const pool = await poolPromise;

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
========================================================= */
router.put("/read-all", async (req, res) => {
  try {
    const pool = await poolPromise;

    await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        UPDATE Notifications
        SET isRead = 1
        WHERE recipientId = @id AND recipientSource = @source
      `);

    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.log("MARK ALL READ ERROR:", err);
    res.status(500).json({ message: "Failed to update notifications" });
  }
});

/* =========================================================
   PUT /api/notifications/:id/read
========================================================= */
router.put("/:id/read", async (req, res) => {
  try {
    const pool = await poolPromise;

    await pool.request()
      .input("id", sql.Int, req.params.id)
      .input("uid", sql.Int, req.user.id)
      .input("source", sql.NVarChar, req.user.source)
      .query(`
        UPDATE Notifications
        SET isRead = 1
        WHERE id = @id AND recipientId = @uid AND recipientSource = @source
      `);

    res.json({ message: "Marked as read" });
  } catch (err) {
    console.log("MARK READ ERROR:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

/* =========================================================
   POST /api/notifications   (admin / teacher / staff only)
   Send a notification to a single student, a single teacher,
   a whole class, or every student.
   body: { recipientType: 'student'|'teacher'|'class'|'all_students',
           recipientId, studentClass, title, message, type }
========================================================= */
router.post("/", authorize("admin", "teacher", "staff"), async (req, res) => {
  try {
    const pool = await poolPromise;
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
      if (io) io.emit("notification:new", { recipients });
    } catch (_) {}

    res.json({ message: `Notification sent to ${recipients.length} recipient(s)` });
  } catch (err) {
    console.log("CREATE NOTIFICATION ERROR:", err);
    res.status(500).json({ message: "Failed to send notification" });
  }
});

module.exports = router;
