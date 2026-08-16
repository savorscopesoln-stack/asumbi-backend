const express = require("express");
const router = express.Router();
const { poolPromise } = require("../config/db");

// GET /api/fees  — full fee list (used by the admin Fees page)
router.get("/", async (req, res) => {
  try {
    const pool = await poolPromise;
    const fees = await pool.request().query(`
      SELECT f.*, s.name AS studentName, s.admissionNo
      FROM Fees f
      JOIN Students s ON f.studentId = s.id
      ORDER BY f.id DESC
    `);
    res.json(fees.recordset);
  } catch (err) {
    console.log("FEES LIST ERROR:", err.message);
    res.status(500).json({ message: err.message });
  }
});

router.get("/:studentId", async (req, res) => {
  try {
    const pool = await poolPromise;

    const fees = await pool.request()
      .input("studentId", req.params.studentId)
      .query("SELECT * FROM Fees WHERE studentId = @studentId");

    res.json(fees.recordset);
  } catch (err) {
    console.log("FEES BY STUDENT ERROR:", err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;