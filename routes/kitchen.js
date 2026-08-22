const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config/db");
const { authorize } = require("../middleware/authMiddleware");

const KITCHEN_STAFF_ROLES = ["admin", "sub_admin", "sub_admin_2"];

const getActorDisplayName = async (pool, user) => {
  try {
    const r = await pool.request().input("id", sql.Int, user.id).query(`SELECT name, username FROM Users WHERE id=@id`);
    const row = r.recordset[0];
    return row?.name || row?.username || user.username || `User ${user.id}`;
  } catch {
    return user?.username || "Unknown";
  }
};

/* =========================================================
   POST /api/kitchen/verify   { code }
   Looks up today's still-unused meal code, marks it used, and
   decrements that student's meal_cards balance by one (if any
   remains). A code is rejected outright once usedAt is set — it
   can never be verified a second time, matching "the code can only
   be used once".
========================================================= */
router.post("/verify", authorize(...KITCHEN_STAFF_ROLES), async (req, res) => {
  try {
    const pool = await poolPromise;
    const code = String(req.body.code || "").trim();
    if (!code) return res.status(400).json({ message: "Code is required" });

    const today = new Date().toISOString().slice(0, 10);

    const result = await pool.request()
      .input("code", sql.NVarChar, code)
      .input("today", sql.Date, today)
      .query(`
        SELECT mdc.id, mdc.student_id, mdc.slot, mdc.meal_card_id, mdc.usedAt,
               s.name AS student_name, s.admissionNo, s.studentClass
        FROM meal_daily_codes mdc
        LEFT JOIN Students s ON s.id = mdc.student_id
        WHERE mdc.code = @code AND mdc.code_date = @today
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ message: "Invalid or expired code" });
    }

    const row = result.recordset[0];
    if (row.usedAt) {
      return res.status(409).json({ message: `This code has already been used for ${row.student_name}'s ${row.slot}.` });
    }

    const actorName = await getActorDisplayName(pool, req.user);

    await pool.request()
      .input("id", sql.Int, row.id)
      .input("name", sql.NVarChar, actorName)
      .query(`UPDATE meal_daily_codes SET usedAt = GETDATE(), usedByName = @name WHERE id = @id`);

    if (row.meal_card_id) {
      await pool.request().input("id", sql.Int, row.meal_card_id).query(`
        UPDATE meal_cards SET meals_remaining = CASE WHEN meals_remaining > 0 THEN meals_remaining - 1 ELSE 0 END
        WHERE id = @id
      `);
    }

    res.json({
      message: `${row.slot[0].toUpperCase()}${row.slot.slice(1)} verified for ${row.student_name}.`,
      student_name: row.student_name,
      admissionNo: row.admissionNo,
      studentClass: row.studentClass,
      slot: row.slot,
    });
  } catch (err) {
    console.error("KITCHEN VERIFY ERROR:", err);
    res.status(500).json({ message: "Verification failed" });
  }
});

/* =========================================================
   GET /api/kitchen/log?date=YYYY-MM-DD
   Every code generated for the given date (defaults to today),
   whether used or not — a simple live activity feed for kitchen
   staff, not a full report (no printing requested for this page).
========================================================= */
router.get("/log", authorize(...KITCHEN_STAFF_ROLES), async (req, res) => {
  try {
    const pool = await poolPromise;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const result = await pool.request().input("date", sql.Date, date).query(`
      SELECT mdc.id, mdc.slot, mdc.code, mdc.usedAt, mdc.usedByName,
             s.name AS student_name, s.admissionNo, s.studentClass
      FROM meal_daily_codes mdc
      LEFT JOIN Students s ON s.id = mdc.student_id
      WHERE mdc.code_date = @date
      ORDER BY mdc.usedAt DESC
    `);

    res.json({ date, rows: result.recordset || [] });
  } catch (err) {
    console.error("KITCHEN LOG ERROR:", err);
    res.status(500).json({ date: req.query.date, rows: [] });
  }
});

module.exports = router;
