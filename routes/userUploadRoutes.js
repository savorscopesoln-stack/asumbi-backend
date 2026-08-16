const express = require("express");
const sql = require("mssql");

const router = express.Router();

// =========================
// GET ALL USERS (DB)
// =========================
router.get("/", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT 
        id,
        username,
        role
      FROM Users
    `);

    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;