const sql = require("mssql");
const { getInstitutionHeader, getSigningOfficials, sendPdfBuffer } = require("../utils/reportExport");
const { buildTranscriptPdf } = require("../utils/transcriptPdf");
const { loadGradingSystem, getGradeForScore, getOverallResultForScore } = require("../utils/grading");

const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/* =========================================================================
   TRANSCRIPT DOWNLOAD
   GET /api/main-exams/transcripts/download?scope=class|all&className=...&examId=all|<id>

   Builds one printable PDF covering every matching student — one page
   (or more, if they've sat enough exams) each — showing either every
   Main Examination they have released marks for, or just one selected
   exam (the "Download Transcripts" button on the Main Examinations
   list — MainExaminations.jsx).

   Deliberately reuses the EXACT SAME released-marks chain as the
   student's own report card (§ student report card exam selection —
   Marks.assessmentId → Assessments(sourceSystem='e_assessment') →
   e_assessments → exam_subject_sessions → main_examinations), so a
   transcript can never show a number the student's own report card
   wouldn't also show (§51 "one source of truth"). Students with no
   released marks for the chosen scope are silently skipped rather
   than given a blank page.
========================================================================= */
const downloadTranscripts = async (req, res) => {
  try {
    const pool = req.pool;
    const scope = String(req.query.scope || "class");
    const className = req.query.className ? String(req.query.className) : null;
    const examIdRaw = req.query.examId ? String(req.query.examId) : "all";
    const examId = examIdRaw === "all" ? null : toInt(examIdRaw);

    if (examIdRaw !== "all" && !examId) {
      return res.status(400).json({ success: false, message: "Invalid exam selection" });
    }
    if (scope === "class" && !className) {
      return res.status(400).json({ success: false, message: "A class is required for a per-class transcript" });
    }

    /* ---------------- 1. Students in scope ---------------- */
    const studentsReq = pool.request();
    let studentsQuery = `SELECT id, name, admissionNo, studentClass, gender, assessmentNumber, yearOfStudy FROM Students`;
    if (scope === "class") {
      studentsReq.input("className", sql.NVarChar, className);
      studentsQuery += ` WHERE studentClass = @className`;
    }
    studentsQuery += ` ORDER BY studentClass, name`;
    const studentsResult = await studentsReq.query(studentsQuery);
    const students = studentsResult.recordset;
    if (!students.length) {
      return res.status(404).json({ success: false, message: "No students found for this selection" });
    }

    /* ---------------- 2. Resolve the selected exam's name (for the title/filename) ---------------- */
    let singleExam = null;
    if (examId) {
      const examResult = await pool.request().input("id", sql.Int, examId)
        .query(`SELECT id, name FROM main_examinations WHERE id = @id`);
      singleExam = examResult.recordset[0];
      if (!singleExam) return res.status(404).json({ success: false, message: "Exam not found" });
    }

    /* ---------------- 3. Released marks for every matching student ----------------
       Same chain GET /api/student/marks (routes/marks.js) uses for a
       single student's own report card, just widened to many students
       and (optionally) not filtered to one exam. */
    const studentIds = students.map((s) => s.id);
    const marksReq = pool.request();
    const idParams = studentIds.map((id, i) => { marksReq.input(`sid${i}`, sql.Int, id); return `@sid${i}`; });
    if (examId) marksReq.input("examId", sql.Int, examId);

    let marksQuery = `
      SELECT
        m.studentId,
        me.id AS mainExaminationId, me.name AS examName, me.academic_year, me.term, me.start_date,
        sub.name AS subjectName, sub.code AS subjectCode,
        m.percentage
      FROM Marks m
      INNER JOIN Assessments a ON a.id = m.assessmentId AND a.sourceSystem = 'e_assessment'
      INNER JOIN e_assessments ea ON ea.id = a.sourceRefId
      INNER JOIN exam_subject_sessions ess ON ess.e_assessment_id = ea.id
      INNER JOIN main_examinations me ON me.id = ess.main_examination_id
      LEFT JOIN Subjects sub ON sub.id = m.subjectId
      WHERE m.studentId IN (${idParams.join(",")})
    `;
    if (examId) marksQuery += ` AND me.id = @examId`;
    marksQuery += ` ORDER BY me.start_date ASC, me.id ASC, sub.name ASC`;

    const marksResult = await marksReq.query(marksQuery);
    const marksRows = marksResult.recordset;

    if (!marksRows.length) {
      return res.status(404).json({
        success: false,
        message: singleExam
          ? `No released marks found for "${singleExam.name}" for this selection`
          : "No released marks found for this selection",
      });
    }

    /* ---------------- 4. Group rows: studentId → examId → subjects[] ---------------- */
    const gradingSystem = await loadGradingSystem(pool);
    const byStudent = new Map();
    marksRows.forEach((row) => {
      if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, new Map());
      const examsMap = byStudent.get(row.studentId);
      if (!examsMap.has(row.mainExaminationId)) {
        examsMap.set(row.mainExaminationId, {
          examName: row.examName, academic_year: row.academic_year, term: row.term, subjects: [],
        });
      }
      examsMap.get(row.mainExaminationId).subjects.push({
        subjectCode: row.subjectCode || null,
        subjectName: row.subjectName || row.subjectCode || "Subject",
        percentage: row.percentage,
      });
    });

    /* ---------------- 5. Shape into buildTranscriptPdf's expected format ----------------
       Students in scope with no released marks at all are skipped
       (rather than drawing a blank page for them). */
    const studentPages = [];
    students.forEach((student) => {
      const examsMap = byStudent.get(student.id);
      if (!examsMap || !examsMap.size) return;

      const exams = [...examsMap.values()].map((exam) => {
        const scores = exam.subjects.map((s) => Number(s.percentage)).filter((n) => !Number.isNaN(n));
        const average = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

        // Per-subject grade band: `label` (e.g. "Credit") is shown in
        // BOTH the "Grade" and "Points" table columns — the app has one
        // grading scale, not the separate letter-grade/points scales a
        // college transcript like the sample sometimes uses. The
        // band's own numeric `grade` code (e.g. "4") still exists
        // underneath and is what the exam's aggregate points total
        // below is summed from, so that figure means something even
        // though the two visible columns match.
        const subjects = exam.subjects.map((s) => {
          const band = s.percentage != null ? getGradeForScore(s.percentage, gradingSystem) : null;
          return {
            ...s,
            grade: band ? band.label : "—",
            points: band ? band.label : "—",
            gradePoints: band ? Number(band.grade) : null,
            result: s.percentage != null ? getOverallResultForScore(s.percentage, gradingSystem) : "—",
          };
        });

        const gradePointsList = subjects.map((s) => s.gradePoints).filter((n) => n != null && !Number.isNaN(n));
        const aggregatePoints = gradePointsList.length ? gradePointsList.reduce((a, b) => a + b, 0) : null;

        return {
          ...exam,
          subjects,
          average,
          overallResult: average != null ? getOverallResultForScore(average, gradingSystem) : "—",
          aggregatePoints,
        };
      });

      const allScores = exams.flatMap((e) => e.subjects.map((s) => Number(s.percentage)).filter((n) => !Number.isNaN(n)));
      const cumulativeAverage = allScores.length ? round1(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;

      studentPages.push({
        student,
        exams,
        cumulativeAverage,
        cumulativeResult: cumulativeAverage != null ? getOverallResultForScore(cumulativeAverage, gradingSystem) : "—",
      });
    });

    if (!studentPages.length) {
      return res.status(404).json({
        success: false,
        message: singleExam
          ? `No released marks found for "${singleExam.name}" for this selection`
          : "No released marks found for this selection",
      });
    }

    /* ---------------- 6. Render + send ---------------- */
    const institution = await getInstitutionHeader(pool);
    const officials = await getSigningOfficials(pool);
    const buffer = await buildTranscriptPdf({
      institution,
      officials,
      title: singleExam ? singleExam.name : "Full Academic Transcript (All Exams)",
      subtitle: scope === "class" ? `Class: ${className}` : "All Students",
      students: studentPages,
    });

    const filenameBase = scope === "class" ? className : "all-students";
    const examSlug = singleExam ? singleExam.name : "all-exams";
    const filename = `Transcripts-${filenameBase}-${examSlug}`
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + ".pdf";

    sendPdfBuffer(res, buffer, filename);
  } catch (err) {
    console.error("DOWNLOAD TRANSCRIPTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating transcripts" });
  }
};

module.exports = { downloadTranscripts };
