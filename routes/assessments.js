const express = require("express");
const router = express.Router();

/* =========================================================
   SAFE INT
========================================================= */
const toInt = (v) => {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
};

/* =========================================================
   GET ALL ASSESSMENTS
========================================================= */
router.get("/", async (req, res) => {
  try {
    const pool = req.pool;

    const result = await pool.request().query(`
      SELECT * FROM Assessments
      ORDER BY id DESC
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});

/* =========================================================
   GET SINGLE ASSESSMENT
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const result = await pool.request().query(`
      SELECT * FROM Assessments WHERE id = ${id}
    `);

    res.json(result.recordset[0] || null);
  } catch (err) {
    console.log(err);
    res.status(500).json(null);
  }
});

/* =========================================================
   GET SUBJECTS FOR ASSESSMENT (FIXED)
========================================================= */
router.get("/:id/subjects", async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const result = await pool.request().query(`
      SELECT s.id, s.name
      FROM AssessmentSubjects ast
      JOIN Subjects s ON ast.subjectId = s.id
      WHERE ast.assessmentId = ${id}
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});

/* =========================================================
   GET CLASSES
========================================================= */
router.get("/:id/classes", async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const result = await pool.request().query(`
      SELECT DISTINCT s.studentClass
      FROM AssessmentStudents ast
      JOIN Students s ON ast.studentId = s.id
      WHERE ast.assessmentId = ${id}
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log(err);
    res.status(500).json([]);
  }
});
/* =========================================================
   CREATE ASSESSMENT (FIXED SUBJECTS)
========================================================= */
router.post("/", async (req, res) => {
  try {
    const pool = req.pool;
    const a = req.body;

    const result = await pool.request().query(`
      INSERT INTO Assessments
      (name, assessmentType, targetClass, term, year, totalMarks, startDate, endDate, status)
      OUTPUT INSERTED.id
      VALUES
      (
        '${a.name}',
        '${a.assessmentType || "Exam"}',
        '${a.targetClass || ""}',
        '${a.term || ""}',
        '${a.year || ""}',
        ${Number(a.totalMarks || 100)},
        ${a.startDate ? `'${a.startDate}'` : "NULL"},
        ${a.endDate ? `'${a.endDate}'` : "NULL"},
        'Active'
      )
    `);

    const assessmentId = result.recordset[0].id;

    /* ================= SAVE SUBJECTS (FIX HERE) ================= */
    if (Array.isArray(a.subjects) && a.subjects.length > 0) {
      for (const subjectId of a.subjects) {
        const sid = toInt(subjectId);
        if (!sid) continue;

        await pool.request()
          .input("assessmentId", assessmentId)
          .input("subjectId", sid)
          .query(`
            INSERT INTO AssessmentSubjects (assessmentId, subjectId)
            VALUES (@assessmentId, @subjectId)
          `);
      }
    }

    /* ================= SAVE STUDENTS ================= */
    if (Array.isArray(a.students)) {
      for (const studentId of a.students) {
        const sid = toInt(studentId);
        if (!sid) continue;

        await pool.request()
          .input("assessmentId", assessmentId)
          .input("studentId", sid)
          .query(`
            INSERT INTO AssessmentStudents (assessmentId, studentId)
            VALUES (@assessmentId, @studentId)
          `);
      }
    }

    res.json({ id: assessmentId });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Create failed" });
  }
});
/* =========================================================
   UPDATE ASSESSMENT (FIXED)
========================================================= */
router.put("/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const a = req.body;

    await pool.request().query(`
      UPDATE Assessments
      SET
        name='${a.name}',
        assessmentType='${a.assessmentType}',
        targetClass='${a.targetClass}',
        term='${a.term}',
        year='${a.year}',
        totalMarks=${Number(a.totalMarks)},
        startDate=${a.startDate ? `'${a.startDate}'` : "NULL"},
        endDate=${a.endDate ? `'${a.endDate}'` : "NULL"}
      WHERE id=${id}
    `);

    /* RESET SUBJECTS */
await pool.request().query(`
  DELETE FROM AssessmentSubjects WHERE assessmentId=${id}
`);

if (Array.isArray(a.subjects)) {
  for (const subjectId of a.subjects) {
    const sid = toInt(subjectId);
    if (!sid) continue;

    await pool.request()
      .input("assessmentId", id)
      .input("subjectId", sid)
      .query(`
        INSERT INTO AssessmentSubjects (assessmentId, subjectId)
        VALUES (@assessmentId, @subjectId)
      `);
  }
}

    /* RESET STUDENTS */
    await pool.request().query(`
      DELETE FROM AssessmentStudents WHERE assessmentId=${id}
    `);

    if (Array.isArray(a.students)) {
      for (const studentId of a.students) {
        const sid = toInt(studentId);
        if (!sid) continue;

        await pool.request().query(`
          INSERT INTO AssessmentStudents (assessmentId, studentId)
          VALUES (${id}, ${sid})
        `);
      }
    }

    res.json({ message: "Updated" });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Update failed" });
  }
});

/* =========================================================
   MARKS SAVE (FIXED - NO subjectId)
========================================================= */
router.post("/marks/save", async (req, res) => {
  try {
    const pool = req.pool;
    const { assessmentId, data } = req.body;

    const aId = toInt(assessmentId);

    // ✅ HARD VALIDATION
    if (!aId || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({
        message: "Invalid payload",
        received: { assessmentId, dataType: typeof data }
      });
    }

    // ✅ SAFE QUERY (NO STRING INTERPOLATION)
    const aRes = await pool.request()
      .input("id", aId)
      .query(`
        SELECT totalMarks 
        FROM Assessments 
        WHERE id = @id
      `);

    const max = aRes.recordset?.[0]?.totalMarks || 100;

    const getGrade = (p) => {
      if (p >= 75) return "Distinction";
      if (p >= 60) return "Credit";
      if (p >= 40) return "Pass";
      return "Fail";
    };

    for (const m of data) {
      const studentId = toInt(m.studentId);
      const score = Number(m.rawScore);

      // ✅ SKIP BAD ROWS
      if (!studentId || isNaN(score)) continue;

      const percentage = (score / max) * 100;
      const grade = getGrade(percentage);

      const request = pool.request();

      await request
        .input("studentId", studentId)
        .input("assessmentId", aId)
        .input("score", score)
        .input("percentage", percentage)
        .input("grade", grade)
        .query(`
          MERGE Marks AS target
          USING (SELECT @studentId AS studentId, @assessmentId AS assessmentId) AS source
          ON target.studentId = source.studentId 
          AND target.assessmentId = source.assessmentId

          WHEN MATCHED THEN
            UPDATE SET 
              score = @score,
              percentage = @percentage,
              grade = @grade

          WHEN NOT MATCHED THEN
            INSERT (studentId, assessmentId, score, percentage, grade)
            VALUES (@studentId, @assessmentId, @score, @percentage, @grade);
        `);
    }

    return res.json({
      message: "Marks saved successfully",
      count: data.length
    });

  } catch (err) {
    console.error("Marks save failed:", err);
    return res.status(500).json({
      message: "Marks save failed",
      error: err.message
    });
  }
});

/* =========================================================
   DELETE ASSESSMENT
========================================================= */
router.delete("/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    await pool.request().query(`DELETE FROM AssessmentSubjects WHERE assessmentId=${id}`);
    await pool.request().query(`DELETE FROM AssessmentStudents WHERE assessmentId=${id}`);
    await pool.request().query(`DELETE FROM Marks WHERE assessmentId=${id}`);
    await pool.request().query(`DELETE FROM Assessments WHERE id=${id}`);

    res.json({ message: "Deleted" });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Delete failed" });
  }
});

module.exports = router;