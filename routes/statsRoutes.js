const express = require("express");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const pool = req.pool;

    // USERS COUNT
    const users = await pool.request()
      .query("SELECT COUNT(*) AS count FROM Users");

    // STUDENTS COUNT
    const students = await pool.request()
      .query("SELECT COUNT(*) AS count FROM Students");

    // TEACHERS COUNT
    const teachers = await pool.request()
      .query("SELECT COUNT(*) AS count FROM Teachers");

    // ACTIVE STUDENTS (FIXED: case-insensitive)
    const activeStudents = await pool.request()
      .query(`
        SELECT COUNT(*) AS count 
        FROM Students 
        WHERE LOWER(LTRIM(RTRIM(status))) = 'active'
      `);

    // INACTIVE STUDENTS (optional but useful)
    const inactiveStudents = await pool.request()
      .query(`
        SELECT COUNT(*) AS count 
        FROM Students 
        WHERE LOWER(LTRIM(RTRIM(status))) = 'inactive'
      `);

    // ROLE BREAKDOWN
    const roles = await pool.request()
      .query(`
        SELECT role, COUNT(*) AS count
        FROM Users
        GROUP BY role
      `);

    // RESPONSE
    res.json({
      users: Number(users.recordset[0].count || 0),
      students: Number(students.recordset[0].count || 0),
      teachers: Number(teachers.recordset[0].count || 0),

      activeStudents: Number(activeStudents.recordset[0].count || 0),
      inactiveStudents: Number(inactiveStudents.recordset[0].count || 0),

      roles: roles.recordset || [],
    });

  } catch (err) {
    console.log("STATS ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;