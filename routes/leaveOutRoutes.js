const express = require("express");
const router = express.Router();

module.exports = (poolPromise, sql) => {

  /* ================= CREATE LEAVE ================= */
  router.post("/", async (req, res) => {
    try {
      const pool = await poolPromise;

      const {
        student_id,
        reason,
        request_date,
        duration
      } = req.body;

      await pool.request()
        .input("student_id", sql.Int, student_id)
        .input("reason", sql.NVarChar, reason)
        .input("request_date", sql.Date, request_date)
        .input("duration", sql.Int, duration || 120)
        .query(`
          INSERT INTO leave_outs
          (student_id, reason, request_date, duration, status)
          VALUES
          (@student_id, @reason, @request_date, @duration, 'pending')
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

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("reason", sql.NVarChar, reason || "No reason provided")
        .query(`
          UPDATE leave_outs
          SET status='denied',
              deny_reason=@reason
          WHERE id=@id AND status='pending'
        `);

      res.json({ message: "Denied" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Deny failed" });
    }
  });

  /* ================= REVOKE (NEW FEATURE) ================= */
  router.put("/:id/revoke", async (req, res) => {
    try {
      const pool = await poolPromise;

      // Get student info first (for WhatsApp message)
      const leave = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          SELECT student_id, reason, status
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

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          UPDATE leave_outs
          SET status='expired'
          WHERE id=@id
        `);

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