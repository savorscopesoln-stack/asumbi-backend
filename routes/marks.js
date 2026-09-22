const express = require("express");
const app = express();
const { notifyUsers } = require("../utils/notify");

/* ================= SAFE NUMBER ================= */
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ================= UPSERT CORE ================= */
const upsertMark = async (pool, { studentId, assessmentId, subjectId, score, max }) => {
  const percent = max ? (score / max) * 100 : 0;

  const grade =
    percent >= 75 ? "Distinction" :
    percent >= 60 ? "Credit" :
    percent >= 40 ? "Pass" : "Fail";

  await pool.request()
    .input("studentId", studentId)
    .input("assessmentId", assessmentId)
    .input("subjectId", subjectId)
    .input("score", score)
    .input("percentage", percent)
    .input("grade", grade)
    .query(`
      IF EXISTS (
        SELECT 1 FROM Marks
        WHERE studentId=@studentId
        AND assessmentId=@assessmentId
        AND subjectId=@subjectId
      )
      BEGIN
        UPDATE Marks
        SET score=@score,
            percentage=@percentage,
            grade=@grade
        WHERE studentId=@studentId
        AND assessmentId=@assessmentId
        AND subjectId=@subjectId
      END
      ELSE
      BEGIN
        INSERT INTO Marks
        (studentId, assessmentId, subjectId, score, percentage, grade)
        VALUES
        (@studentId, @assessmentId, @subjectId, @score, @percentage, @grade)
      END
    `);
};

/* =====================================================
   SAVE MARKS (BULK + SINGLE FIXED)
===================================================== */
app.post("/api/marks/save", async (req, res) => {
  try {
    const pool = req.pool || req.app.locals.pool;

    const { assessmentId, data, studentId, rawScore, subjectId } = req.body;

    const aId = toNum(assessmentId);

    if (!aId) {
      return res.status(400).json({ message: "assessmentId required" });
    }

    /* ================= GET ASSESSMENT ================= */
    const assessmentResult = await pool.request()
      .input("assessmentId", aId)
      .query(`
        SELECT status, totalMarks, name
        FROM Assessments
        WHERE id = @assessmentId
      `);

    const assessment = assessmentResult.recordset?.[0];

    if (!assessment) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    if (assessment.status !== "Active") {
      return res.status(403).json({ message: "Assessment not active" });
    }

    const max = Number(assessment.totalMarks || 100);

    /* =====================================================
       BULK SAVE MODE
    ===================================================== */
    if (Array.isArray(data) && data.length > 0) {
      const notifiedStudentIds = new Set();

      for (const d of data) {
        const sId = toNum(d.studentId);
        const subId = toNum(d.subjectId || subjectId);
        const score = Number(d.rawScore);

        if (!sId || !subId || !Number.isFinite(score)) continue;

        await upsertMark(pool, {
          studentId: sId,
          assessmentId: aId,
          subjectId: subId,
          score,
          max
        });

        notifiedStudentIds.add(sId);
      }

      await notifyUsers(
        pool,
        [...notifiedStudentIds].map((id) => ({ id, source: "Students" })),
        {
          title: "Marks Posted",
          message: `Your marks for "${assessment.name || "an assessment"}" have been posted.`,
          type: "marks",
        }
      );

      return res.json({ message: "Bulk marks saved" });
    }

    /* =====================================================
       SINGLE SAVE MODE (AUTOSAVE)
    ===================================================== */
    const sId = toNum(studentId);
    const subId = toNum(subjectId);
    const score = Number(rawScore);

    if (!sId || !subId || !Number.isFinite(score)) {
      return res.status(400).json({ message: "Invalid single payload" });
    }

    await upsertMark(pool, {
      studentId: sId,
      assessmentId: aId,
      subjectId: subId,
      score,
      max
    });

    // NOTE: deliberately not notifying here — this branch is the
    // per-cell autosave path (see "SINGLE SAVE MODE (AUTOSAVE)" above)
    // and fires on nearly every keystroke while a teacher is entering
    // marks; notifying on it would spam the student. The bulk-save
    // path above (the actual "save marks for the class" action) is
    // where the notification belongs.
    return res.json({ message: "Saved" });

  } catch (err) {
    console.error("MARKS SAVE ERROR:", err);
    return res.status(500).json({ message: err.message });
  }
});

/* =====================================================
   GET MARKS (FIXED + SAFE)
===================================================== */
app.get("/api/marks/:assessmentId", async (req, res) => {
  try {
    const pool = req.pool || req.app.locals.pool;

    const assessmentId = toNum(req.params.assessmentId);
    const subjectId = toNum(req.query.subjectId);

    if (!assessmentId) return res.json([]);

    const request = pool.request()
      .input("assessmentId", assessmentId);

    let query = `
      SELECT studentId, subjectId, score, percentage, grade
      FROM Marks
      WHERE assessmentId = @assessmentId
    `;

    if (subjectId) {
      query += ` AND subjectId = @subjectId`;
      request.input("subjectId", subjectId);
    }

    const result = await request.query(query);

    return res.json(result.recordset || []);

  } catch (err) {
    console.error("MARKS FETCH ERROR:", err);
    return res.status(500).json([]);
  }
});
/* =====================================================
   GET STUDENT MARKS (for result slip / student portal)

   If an admin has picked a "report card exam" (E-Assessments → Main
   Examinations → "Show on Report Cards" — see setReportCardExam() in
   mainExam.controller.js), this only returns marks for that exam's
   subject papers, and stamps each row with that exam's name so
   StudentReport.jsx's report card can display it. The link from a
   Marks row back to a Main Examination runs through the same chain
   ensureAssessmentForEAssessment() (eAssessment.controller.js) already
   set up for the "examScope" fix: Marks.assessmentId → Assessments
   (sourceSystem='e_assessment', sourceRefId=e_assessments.id) →
   exam_subject_sessions.e_assessment_id → main_examinations.id.

   If no exam has been picked yet (a school that hasn't used this
   feature, or between exams), this falls back to every mark on record
   for the student — the same behaviour as before this feature existed. */
app.get("/api/student/marks", async (req, res) => {
  try {
    const pool = req.pool || req.app.locals.pool;

    const studentId = toNum(req.query.studentId);
    if (!studentId) return res.json([]);

    const activeExamResult = await pool.request().query(`
      SELECT TOP 1 id, name FROM main_examinations WHERE is_report_exam = 1
    `);
    const activeExam = activeExamResult.recordset?.[0] || null;

    const request = pool.request().input("studentId", studentId);
    let query = `
      SELECT
        m.studentId,
        m.subjectId,
        sub.name AS subjectName,
        sub.code AS subjectCode,
        m.assessmentId,
        m.score,
        m.percentage,
        m.grade,
        m.createdAt
    `;

    if (activeExam) {
      request.input("mainExaminationId", activeExam.id);
      query += `, @examName AS examName`;
      request.input("examName", activeExam.name);
    }

    query += `
      FROM Marks m
      LEFT JOIN Subjects sub ON sub.id = m.subjectId
    `;

    if (activeExam) {
      query += `
        INNER JOIN Assessments a ON a.id = m.assessmentId
          AND a.sourceSystem = 'e_assessment'
          AND a.sourceRefId IN (
            SELECT ess.e_assessment_id FROM exam_subject_sessions ess
            WHERE ess.main_examination_id = @mainExaminationId AND ess.e_assessment_id IS NOT NULL
          )
      `;
    }

    query += ` WHERE m.studentId = @studentId ORDER BY m.createdAt DESC`;

    const result = await request.query(query);

    return res.json(result.recordset || []);

  } catch (err) {
    console.error("STUDENT MARKS FETCH ERROR:", err);
    return res.status(500).json([]);
  }
});

module.exports = app;