const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config/db");
const { authorize } = require("../middleware/authMiddleware");

// Same staff group that already manages the leave-out workflow this
// gate code comes from — Gate is just the physical checkpoint side of
// that same feature, so it shares its access list.
const GATE_STAFF_ROLES = ["admin", "sub_admin", "sub_admin_2"];

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
   POST /api/gate/verify   { code }
   First scan of a code records exit_time. Second scan of the SAME
   code records reentry_time and closes the cycle out. A code that's
   already fully closed (both timestamps set) is rejected — it isn't
   reusable, so re-entering it again is treated as invalid rather than
   silently no-op'd, since that'd hide a real gate-desk mistake.
========================================================= */
router.post("/verify", authorize(...GATE_STAFF_ROLES), async (req, res) => {
  try {
    const pool = await poolPromise;
    const code = String(req.body.code || "").trim();
    if (!code) return res.status(400).json({ message: "Code is required" });

    const result = await pool.request().input("code", sql.NVarChar, code).query(`
      SELECT lo.id, lo.student_id, lo.leave_type, lo.exit_time, lo.reentry_time,
             s.name AS student_name, s.admissionNo, s.studentClass
      FROM leave_outs lo
      LEFT JOIN Students s ON s.id = lo.student_id
      WHERE lo.gate_code = @code
    `);

    if (!result.recordset.length) {
      return res.status(404).json({ message: "Invalid gate code" });
    }

    const leave = result.recordset[0];
    const actorName = await getActorDisplayName(pool, req.user);

    if (leave.reentry_time) {
      return res.status(409).json({
        message: `This code was already fully used — ${leave.student_name} already exited and returned.`,
      });
    }

    if (!leave.exit_time) {
      await pool.request()
        .input("id", sql.Int, leave.id)
        .input("name", sql.NVarChar, actorName)
        .query(`
          UPDATE leave_outs
          SET exit_time = GETDATE(), exit_verified_by_name = @name, gate_status = 'out'
          WHERE id = @id
        `);

      return res.json({
        action: "exit",
        message: `Exit recorded for ${leave.student_name}.`,
        student_name: leave.student_name,
        admissionNo: leave.admissionNo,
        studentClass: leave.studentClass,
        leave_type: leave.leave_type,
      });
    }

    await pool.request()
      .input("id", sql.Int, leave.id)
      .input("name", sql.NVarChar, actorName)
      .query(`
        UPDATE leave_outs
        SET reentry_time = GETDATE(), reentry_verified_by_name = @name, gate_status = 'returned'
        WHERE id = @id
      `);

    return res.json({
      action: "reentry",
      message: `Re-entry recorded for ${leave.student_name}.`,
      student_name: leave.student_name,
      admissionNo: leave.admissionNo,
      studentClass: leave.studentClass,
      leave_type: leave.leave_type,
    });
  } catch (err) {
    console.error("GATE VERIFY ERROR:", err);
    res.status(500).json({ message: "Verification failed" });
  }
});

/* =========================================================
   GET /api/gate/report?date=YYYY-MM-DD
   Every leave with a gate code whose exit or reentry fell on the
   given date (defaults to today) — this is both the live "today" list
   and the printable end-of-day report for any past day; the frontend
   just points the date picker at whichever day it wants.
========================================================= */
router.get("/report", authorize(...GATE_STAFF_ROLES), async (req, res) => {
  try {
    const pool = await poolPromise;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const result = await pool.request().input("date", sql.Date, date).query(`
      SELECT lo.id, lo.leave_type, lo.reason, lo.gate_code, lo.gate_status,
             lo.exit_time, lo.exit_verified_by_name,
             lo.reentry_time, lo.reentry_verified_by_name,
             s.name AS student_name, s.admissionNo, s.studentClass
      FROM leave_outs lo
      LEFT JOIN Students s ON s.id = lo.student_id
      WHERE lo.gate_code IS NOT NULL
        AND (
          CAST(lo.exit_time AS DATE) = @date
          OR CAST(lo.reentry_time AS DATE) = @date
        )
      ORDER BY lo.exit_time ASC
    `);

    res.json({ date, rows: result.recordset || [] });
  } catch (err) {
    console.error("GATE REPORT ERROR:", err);
    res.status(500).json({ date: req.query.date, rows: [] });
  }
});

module.exports = router;
