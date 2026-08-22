const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config/db");


/* ================= GET POOL ================= */
const getPool = async () => {
  return await poolPromise;
};

/* ================= GET ACTIVE STUDENTS ================= */
router.get("/students/active", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT 
        id,
        name,
        admissionNo,
        studentClass,
        gender,
        status,
        yearOfStudy,
        phone
      FROM Students
      WHERE status = 'active'
    `);

    res.json(result.recordset);
  } catch (err) {
    console.log("ACTIVE STUDENTS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= SEARCH STUDENTS ================= */
router.get("/students/search", async (req, res) => {
  const { q } = req.query;

  try {
    const pool = await getPool();

    if (!q) return res.json([]);

    const result = await pool
      .request()
      .input("q", sql.VarChar, `%${q}%`)
      .query(`
        SELECT 
          id,
          name,
          admissionNo,
          studentClass,
          gender,
          status
        FROM Students
        WHERE status = 'active'
        AND (
          name LIKE @q OR
          admissionNo LIKE @q OR
          studentClass LIKE @q
        )
      `);

    res.json(result.recordset);
  } catch (err) {
    console.log("SEARCH STUDENTS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= ASSIGN MEAL CARD ================= */
/* ================= ASSIGN MEAL CARD ================= */
router.post("/assign", async (req, res) => {
  const {
    student_id,
    meals_per_day,
    number_of_days,
  } = req.body;

  try {
    const pool = await getPool();

    const check = await pool
      .request()
      .input("student_id", sql.Int, student_id)
      .query(`
        SELECT id 
        FROM meal_cards 
        WHERE student_id = @student_id
        AND status IN ('active', 'suspended')
      `);

    if (check.recordset.length > 0) {
      return res.status(400).json({
        message: "Meal card already assigned for this student",
      });
    }

    const totalMeals =
      Number(meals_per_day) * Number(number_of_days);

    const cardNumber = `MC-${Date.now()}-${student_id}`;

    await pool
      .request()
      .input("student_id", sql.Int, student_id)
      .input("card_number", sql.VarChar, cardNumber)
      .input("meals_per_day", sql.Int, meals_per_day)
      .input("number_of_days", sql.Int, number_of_days)
      .input("meals_remaining", sql.Int, totalMeals)
      .query(`
        INSERT INTO meal_cards 
        (
          student_id,
          card_number,
          meals_per_day,
          number_of_days,
          meals_remaining,
          status
        )
        VALUES 
        (
          @student_id,
          @card_number,
          @meals_per_day,
          @number_of_days,
          @meals_remaining,
          'active'
        )
      `);

    res.json({
      message: "Meal card assigned successfully",
    });

  } catch (err) {
    console.log("ASSIGN ERROR:", err.message);

    res.status(500).json({
      error: err.message,
    });
  }
});
/* ================= GET ALL MEAL CARDS ================= */
router.get("/all", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT 
        mc.id,
        mc.card_number,
        mc.meals_per_day,
        mc.meals_remaining,
        mc.status,

        s.id AS student_id,
        s.name,
        s.admissionNo,
        s.studentClass,
        s.gender,
        s.phone

      FROM meal_cards mc
      JOIN Students s ON mc.student_id = s.id
      ORDER BY mc.id DESC
    `);

    res.json(result.recordset);
  } catch (err) {
    console.log("GET CARDS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= UPDATE CARD ================= */
/* ================= UPDATE CARD ================= */
router.put("/update/:id", async (req, res) => {
  const {
    meals_per_day,
    number_of_days,
    status,
  } = req.body;

  try {
    const pool = await getPool();

    const mealsRemaining =
      Number(meals_per_day) * Number(number_of_days);

    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .input("meals_per_day", sql.Int, meals_per_day)
      .input("number_of_days", sql.Int, number_of_days)
      .input("meals_remaining", sql.Int, mealsRemaining)
      .input("status", sql.VarChar, status)
      .query(`
        UPDATE meal_cards
        SET 
          meals_per_day = @meals_per_day,
          number_of_days = @number_of_days,
          meals_remaining = @meals_remaining,
          status = @status
        WHERE id = @id
      `);

    res.json({
      message: "Updated successfully",
    });

  } catch (err) {
    console.log("UPDATE ERROR:", err.message);

    res.status(500).json({
      error: err.message,
    });
  }
});
/* ================= SUSPEND ================= */
router.put("/suspend/:id", async (req, res) => {
  try {
    const pool = await getPool();

    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query(`
        UPDATE meal_cards
        SET status = 'suspended'
        WHERE id = @id
      `);

    res.json({ message: "Suspended" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= DISABLE ================= */
router.put("/disable/:id", async (req, res) => {
  try {
    const pool = await getPool();

    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query(`
        UPDATE meal_cards
        SET status = 'inactive'
        WHERE id = @id
      `);

    res.json({ message: "Disabled" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= ACTIVATE ================= */
router.put("/activate/:id", async (req, res) => {
  try {
    const pool = await getPool();

    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query(`
        UPDATE meal_cards
        SET status = 'active'
        WHERE id = @id
      `);

    res.json({ message: "Activated" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= GET STUDENT MEAL CARD ================= */
router.get("/my/:id", async (req, res) => {
  const studentId = req.params.id;

  try {
    const pool = await getPool();

    const result = await pool
      .request()
      .input("id", sql.Int, studentId)
      .query(`
        SELECT 
          mc.id,
          mc.card_number,
          mc.meals_per_day,
          mc.meals_remaining,
          mc.status,

          s.id AS student_id,
          s.name,
          s.admissionNo,
          s.studentClass

        FROM meal_cards mc
        JOIN Students s ON mc.student_id = s.id
        WHERE mc.student_id = @id
      `);

    if (result.recordset.length === 0) {
      return res.json(null);
    }

    res.json(result.recordset[0]);

  } catch (err) {
    console.log("MY MEAL CARD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});
/* ================= DELETE ALL MEAL CARDS ================= */
router.delete("/delete-all", async (req, res) => {
  try {
    const pool = await getPool();

    await pool.request().query(`
      DELETE FROM meal_cards
    `);

    res.json({
      success: true,
      message: "All meal cards deleted successfully",
    });

  } catch (err) {
    console.log("DELETE ALL ERROR:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* ================= DAILY MEAL CODES (Kitchen verification) =================
   3 single-use codes per student per day — breakfast/lunch/supper.
   Called by the student's meal card page; generates today's 3 codes
   the first time they're requested each day (idempotent afterwards —
   calling this again the same day just returns the same codes, it
   never regenerates ones already issued), then returns them along
   with whether each has been used yet.
================================================================= */
router.get("/my/:studentId/daily-codes", async (req, res) => {
  const studentId = Number(req.params.studentId);
  const SLOTS = ["breakfast", "lunch", "supper"];

  try {
    const pool = await getPool();
    const today = new Date().toISOString().slice(0, 10);

    const cardRes = await pool.request().input("sid", sql.Int, studentId).query(`
      SELECT id, status FROM meal_cards WHERE student_id = @sid
    `);
    const card = cardRes.recordset[0];
    if (!card || card.status !== "active") {
      return res.status(400).json({ message: "No active meal card for this student" });
    }

    const existing = await pool.request()
      .input("sid", sql.Int, studentId)
      .input("today", sql.Date, today)
      .query(`
        SELECT slot, code, usedAt FROM meal_daily_codes
        WHERE student_id = @sid AND code_date = @today
      `);

    const bySlot = {};
    (existing.recordset || []).forEach((r) => { bySlot[r.slot] = r; });

    for (const slot of SLOTS) {
      if (bySlot[slot]) continue;

      let code = null;
      for (let attempt = 0; attempt < 8 && !code; attempt++) {
        const candidate = String(Math.floor(100000 + Math.random() * 900000));
        const clash = await pool.request()
          .input("code", sql.NVarChar, candidate)
          .input("today", sql.Date, today)
          .query(`SELECT id FROM meal_daily_codes WHERE code = @code AND code_date = @today`);
        if (clash.recordset.length === 0) code = candidate;
      }
      if (!code) continue; // extremely unlikely; that slot just won't have a code today

      await pool.request()
        .input("sid", sql.Int, studentId)
        .input("cardId", sql.Int, card.id)
        .input("slot", sql.NVarChar, slot)
        .input("code", sql.NVarChar, code)
        .input("today", sql.Date, today)
        .query(`
          INSERT INTO meal_daily_codes (student_id, meal_card_id, slot, code, code_date)
          VALUES (@sid, @cardId, @slot, @code, @today)
        `);

      bySlot[slot] = { slot, code, usedAt: null };
    }

    res.json({
      date: today,
      codes: SLOTS.map((slot) => ({
        slot,
        code: bySlot[slot]?.code || null,
        used: !!bySlot[slot]?.usedAt,
      })),
    });
  } catch (err) {
    console.log("DAILY CODES ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;