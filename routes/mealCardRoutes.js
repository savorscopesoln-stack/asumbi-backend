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
router.post("/assign", async (req, res) => {
  const {
  student_id,
  meals_per_day,
  number_of_days,
  meals_remaining,
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

    const cardNumber = `MC-${Date.now()}-${student_id}`;

    await pool
      .request()
      .input("student_id", sql.Int, student_id)
      .input("card_number", sql.VarChar, cardNumber)
      .input("meals_remaining", sql.Int, meals_remaining)
      .input("meals_remaining", sql.Int, meals_per_day)
      .query(`
        INSERT INTO meal_cards 
        (student_id, card_number, meals_per_day, meals_remaining, status)
        VALUES 
        (@student_id, @card_number, @meals_per_day, @meals_remaining, 'active')
      `);

    res.json({ message: "Meal card assigned successfully" });

  } catch (err) {
    console.log("ASSIGN ERROR:", err.message);
    res.status(500).json({ error: err.message });
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
router.put("/update/:id", async (req, res) => {
  const { meals_per_day, meals_remaining, status } = req.body;

  try {
    const pool = await getPool();

    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .input("meals_per_day", sql.Int, meals_per_day)
      .input("meals_remaining", sql.Int, meals_remaining)
      .input("status", sql.VarChar, status)
      .query(`
        UPDATE meal_cards
        SET 
          meals_per_day = @meals_per_day,
          meals_remaining = @meals_remaining,
          status = @status
        WHERE id = @id
      `);

    res.json({ message: "Updated successfully" });

  } catch (err) {
    console.log("UPDATE ERROR:", err.message);
    res.status(500).json({ error: err.message });
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
module.exports = router;