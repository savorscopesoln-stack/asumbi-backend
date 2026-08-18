const express = require("express");
const router = express.Router();

const VALID_LEAVE_TYPES = ["short_stay", "long", "emergency"];

// Sensible default durations (minutes) per leave type, used whenever
// the caller doesn't supply an explicit duration.
const DEFAULT_DURATION_BY_TYPE = {
  short_stay: 120,   // 2 hours
  long: 2880,        // 2 days
  emergency: 60,     // 1 hour — fast turnaround
};

const LEAVE_TYPE_LABEL = {
  short_stay: "Short Stay",
  long: "Long Leave",
  emergency: "Emergency Leave",
};

module.exports = (poolPromise, sql) => {

  /* ================= NOTIFY HELPER =================
     Writes a row into Notifications for the student.
     Failure to notify should never break the leave action itself.
  */
  const notifyStudent = async (pool, studentId, title, message, type = "leave") => {
    try {
      await pool.request()
        .input("recipientId", sql.Int, studentId)
        .input("recipientSource", sql.NVarChar, "Students")
        .input("title", sql.NVarChar, title)
        .input("message", sql.NVarChar, message)
        .input("type", sql.NVarChar, type)
        .query(`
          INSERT INTO Notifications
            (recipientId, recipientSource, title, message, type, isRead, createdAt)
          VALUES
            (@recipientId, @recipientSource, @title, @message, @type, 0, GETDATE())
        `);
    } catch (err) {
      console.log("LEAVE NOTIFY ERROR:", err.message);
    }
  };

  /* ================= CREATE LEAVE ================= */
  router.post("/", async (req, res) => {
    try {
      const pool = await poolPromise;

      const {
        student_id,
        reason,
        request_date,
        duration,
        leave_type,
      } = req.body;

      if (!student_id || !reason) {
        return res.status(400).json({ message: "student_id and reason are required" });
      }

      const type = VALID_LEAVE_TYPES.includes(leave_type) ? leave_type : "short_stay";
      const finalDuration = duration || DEFAULT_DURATION_BY_TYPE[type];

      await pool.request()
        .input("student_id", sql.Int, student_id)
        .input("reason", sql.NVarChar, reason)
        .input("request_date", sql.Date, request_date)
        .input("duration", sql.Int, finalDuration)
        .input("leave_type", sql.NVarChar, type)
        .query(`
          INSERT INTO leave_outs
          (student_id, reason, request_date, duration, status, leave_type)
          VALUES
          (@student_id, @reason, @request_date, @duration, 'pending', @leave_type)
        `);

      res.json({ message: "Leave request submitted" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Failed to submit leave" });
    }
  });

  /* ================= STUDENT LEAVES ================= */
  router.get("/student", async (req, res) => {
    try {
      const pool = await poolPromise;
      const studentId = req.query.studentId;

      const result = await pool.request()
        .input("studentId", sql.Int, studentId)
        .query(`
          SELECT *
          FROM leave_outs
          WHERE student_id = @studentId
          ORDER BY id DESC
        `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= ADMIN GET ALL ================= */
  router.get("/", async (req, res) => {
    try {
      const pool = await poolPromise;

      const result = await pool.request().query(`
        SELECT *
        FROM leave_outs
        ORDER BY id DESC
      `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= APPROVE ================= */
  router.put("/:id/approve", async (req, res) => {
    try {
      const pool = await poolPromise;

      const { approvedAt, duration } = req.body;

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id, leave_type FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const { student_id, leave_type } = existing.recordset[0];

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("approvedAt", sql.DateTime, approvedAt)
        .input("duration", sql.Int, duration)
        .query(`
          UPDATE leave_outs
          SET status='approved',
              approved_at=@approvedAt,
              duration=@duration
          WHERE id=@id AND status='pending'
        `);

      await notifyStudent(
        pool,
        student_id,
        "Leave Request Approved",
        `Your ${LEAVE_TYPE_LABEL[leave_type] || "leave"} request has been approved. You may print your leave permit from the Leave & Gate Pass page.`
      );

      res.json({ message: "Approved" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Approve failed" });
    }
  });

  /* ================= DENY ================= */
  router.put("/:id/deny", async (req, res) => {
    try {
      const pool = await poolPromise;

      const { reason } = req.body;
      const denyReason = reason || "No reason provided";

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id, leave_type FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const { student_id, leave_type } = existing.recordset[0];

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("reason", sql.NVarChar, denyReason)
        .query(`
          UPDATE leave_outs
          SET status='denied',
              deny_reason=@reason
          WHERE id=@id AND status='pending'
        `);

      await notifyStudent(
        pool,
        student_id,
        "Leave Request Denied",
        `Your ${LEAVE_TYPE_LABEL[leave_type] || "leave"} request was denied. Reason: ${denyReason}`
      );

      res.json({ message: "Denied" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Deny failed" });
    }
  });

  /* ================= REVOKE ================= */
  router.put("/:id/revoke", async (req, res) => {
    try {
      const pool = await poolPromise;

      // Get student info first (for WhatsApp + in-app notification)
      const leave = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          SELECT student_id, reason, status, leave_type
          FROM leave_outs
          WHERE id=@id
        `);

      if (!leave.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const data = leave.recordset[0];

      // Prevent double revoke
      if (data.status === "revoked") {
        return res.status(400).json({ message: "Already revoked" });
      }

      // Update status
      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          UPDATE leave_outs
          SET status='revoked'
          WHERE id=@id
        `);

      /* ================= WHATSAPP HOOK =================
         Replace this with real WhatsApp API (Twilio / Meta Cloud API)
      */
      console.log(`📲 WhatsApp to Student ${data.student_id}:`);
      console.log(`Your leave has been REVOKED. Please report back immediately.`);

      await notifyStudent(
        pool,
        data.student_id,
        "Leave Revoked",
        "Your leave has been revoked by the administration. Please report back to the institution immediately.",
        "leave_urgent"
      );

      res.json({ message: "Leave revoked & student notified" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Revoke failed" });
    }
  });

  /* ================= EXPIRE ================= */
  router.put("/:id/expire", async (req, res) => {
    try {
      const pool = await poolPromise;

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id FROM leave_outs WHERE id=@id`);

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          UPDATE leave_outs
          SET status='expired'
          WHERE id=@id
        `);

      if (existing.recordset.length) {
        await notifyStudent(
          pool,
          existing.recordset[0].student_id,
          "Leave Expired",
          "Your approved leave duration has expired. Please report back to the institution.",
          "leave_urgent"
        );
      }

      res.json({ message: "Expired" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Expire failed" });
    }
  });

  /* ================= ANALYTICS ================= */
  router.get("/analytics", async (req, res) => {
    try {
      const pool = await poolPromise;

      const result = await pool.request().query(`
        SELECT 
          student_id,
          COUNT(*) AS totalLeaves,
          SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approvedLeaves,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pendingLeaves,
          SUM(CASE WHEN status='denied' THEN 1 ELSE 0 END) AS deniedLeaves,
          SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expiredLeaves,
          SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revokedLeaves
        FROM leave_outs
        GROUP BY student_id
        ORDER BY totalLeaves DESC
      `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  return router;
};
