const express = require("express");
const router = express.Router();
const { poolPromise } = require("../config/db");

/* ================= CLASSES ================= */
router.get("/classes", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT DISTINCT studentClass AS class_name
      FROM Students
      ORDER BY studentClass
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});

/* ================= SUBJECTS / LEARNING AREAS ================= */
router.get("/subjects", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT id, name
      FROM Subjects
      ORDER BY name
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});

/* ================= TEACHERS ================= */
router.get("/teachers", async (req, res) => {
  try {
    const pool = await poolPromise;

    const result = await pool.request().query(`
      SELECT id, name
      FROM Users
      WHERE role = 'teacher'
      ORDER BY name
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});

module.exports = router;