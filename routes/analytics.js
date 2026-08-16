const express = require("express");
const router = express.Router();

/* ================= TEACHER ANALYTICS ================= */
router.get("/teacher", async (req, res) => {
  try {
    const pool = req.pool;

    /* ================= CLASS PERFORMANCE ================= */
    const classResult = await pool.request().query(`
      SELECT 
        s.studentClass AS class,
        AVG(m.percentage) AS average
      FROM Marks m
      JOIN Students s ON s.id = m.studentId
      GROUP BY s.studentClass
    `);

    /* ================= GRADE DISTRIBUTION ================= */
    const gradeResult = await pool.request().query(`
      SELECT 
        grade,
        COUNT(*) AS value
      FROM Marks
      GROUP BY grade
    `);

    /* ================= ASSESSMENT TREND ================= */
    const trendResult = await pool.request().query(`
      SELECT 
        a.name,
        AVG(m.percentage) AS average
      FROM Marks m
      JOIN Assessments a ON a.id = m.assessmentId
      GROUP BY a.name
      ORDER BY a.id
    `);

    /* ================= TOP STUDENTS ================= */
    const topResult = await pool.request().query(`
      SELECT TOP 10
        s.name,
        s.studentClass AS class,
        AVG(m.percentage) AS average
      FROM Marks m
      JOIN Students s ON s.id = m.studentId
      GROUP BY s.name, s.studentClass
      ORDER BY average DESC
    `);

    res.json({
      classPerformance: classResult.recordset,
      gradeDistribution: gradeResult.recordset,
      assessmentTrend: trendResult.recordset,
      topStudents: topResult.recordset,
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Analytics error" });
  }
});

module.exports = router;