const express = require("express");
const router = express.Router();
const { sql } = require("../config/db");

/* =========================
   GET ATTENDANCE
========================= */
router.get("/", async (req, res) => {
  try {
    const pool = req.pool;

    const { date, session } = req.query;

    if (!date || !session) {
      return res.status(400).json({ message: "Date and session required" });
    }

    const result = await pool.request()
      .input("attendanceDate", sql.Date, date)
      .input("session", sql.NVarChar, session)
      .query(`
        SELECT studentId, status
        FROM Attendance
        WHERE attendanceDate = @attendanceDate AND session = @session
      `);

    res.json(result.recordset);
  } catch (err) {
    console.log("GET ATTENDANCE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});


/* =========================
   SAVE / UPDATE ATTENDANCE
========================= */
router.post("/save", async (req, res) => {
  try {
    const pool = req.pool;

    const { date, session, records } = req.body;

    if (!date || !session || !records) {
      return res.status(400).json({ message: "Missing data" });
    }

    for (let r of records) {
      const { studentId, status } = r;

      const check = await pool.request()
        .input("studentId", sql.Int, studentId)
        .input("attendanceDate", sql.Date, date)
        .input("session", sql.NVarChar, session)
        .query(`
          SELECT id FROM Attendance
          WHERE studentId=@studentId 
          AND attendanceDate=@attendanceDate 
          AND session=@session
        `);

      if (check.recordset.length > 0) {
        await pool.request()
          .input("studentId", sql.Int, studentId)
          .input("attendanceDate", sql.Date, date)
          .input("session", sql.NVarChar, session)
          .input("status", sql.NVarChar, status)
          .query(`
            UPDATE Attendance
            SET status=@status
            WHERE studentId=@studentId 
            AND attendanceDate=@attendanceDate 
            AND session=@session
          `);
      } else {
        await pool.request()
          .input("studentId", sql.Int, studentId)
          .input("attendanceDate", sql.Date, date)
          .input("session", sql.NVarChar, session)
          .input("status", sql.NVarChar, status)
          .query(`
            INSERT INTO Attendance (studentId, attendanceDate, session, status)
            VALUES (@studentId, @attendanceDate, @session, @status)
          `);
      }
    }

    res.json({ message: "Attendance saved successfully" });

  } catch (err) {
    console.log("SAVE ATTENDANCE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;