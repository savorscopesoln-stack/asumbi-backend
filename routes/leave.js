const express = require("express");
const router = express.Router();
const { poolPromise } = require("../config/db");

// student request leave
router.post("/", async (req, res) => {
  try {
    const { studentId, reason } = req.body;
    if (!studentId || !reason) {
      return res.status(400).json({ message: "studentId and reason are required" });
    }

    const pool = await poolPromise;

    await pool.request()
      .input("studentId", studentId)
      .input("reason", reason)
      .query(`
        INSERT INTO LeaveRequests (studentId, reason)
        VALUES (@studentId, @reason)
      `);

    res.json({ message: "Leave request submitted" });
  } catch (err) {
    console.log("LEAVE REQUEST ERROR:", err.message);
    res.status(500).json({ message: err.message });
  }
});

// teacher approves / rejects
router.put("/:id", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "status is required" });

    const pool = await poolPromise;

    await pool.request()
      .input("id", req.params.id)
      .input("status", status)
      .query(`
        UPDATE LeaveRequests
        SET status = @status
        WHERE id = @id
      `);

    res.json({ message: "Updated" });
  } catch (err) {
    console.log("LEAVE UPDATE ERROR:", err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
