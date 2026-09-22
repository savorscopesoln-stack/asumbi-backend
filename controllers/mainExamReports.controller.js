const sql = require("mssql");
const {
  getMainExamAnalytics,
  getSubjectAnalytics,
  getStudentExaminationProfile,
  loadNominalRoll,
  computeClassPerformance,
} = require("./mainExamAnalytics.controller");

/* =========================================================================
   MAIN EXAMINATION REPORTS (Phase 11 — §29-§33)

   §33 is the whole point of this file: "Reports must be generated from
   the backend using authoritative database data... Backend
   calculates/returns authoritative report data." Every report here is
   plain JSON — row-shaped, ready for a table or an export — with no
   calculation living only on the frontend.

   §51 "one source of truth": wherever a report needs the same numbers
   the Analytics tab already shows (the exam summary, a subject's
   question analysis, a student's per-subject scores), this file calls
   the SAME Phase 9 handler in-process via runHandler() below instead of
   re-deriving them with different SQL. A report and the dashboard can
   never disagree, because they're the same function call. Only the
   handful of genuinely report-shaped queries with no analytics
   equivalent (per-student result rows for a subject/class, the
   marking-progress-by-subject roll-up, a candidate's personal schedule)
   have their own SQL below — and those use the identical
   score/total_marks formula as everywhere else in the app.

   Report §30.9 "Examination Timetable" isn't duplicated here at all —
   it's served by the already-existing GET /main-exams/:mainExamId/timetable
   (examSubjectSession.controller.js), mounted a second time under
   /reports/timetable in routes/mainExams.js so it shows up naturally in
   a "Reports" tab without a second implementation (§14).
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/* -------------------------------------------------------------------------
   Calls one of the Phase 9 Express handlers in-process and captures the
   JSON it would have sent, instead of re-implementing its SQL here. Real
   handlers only ever call req.pool / req.params / req.query and res.json
   / res.status(...).json(...), so a minimal stand-in for each is enough.
------------------------------------------------------------------------- */
function runHandler(handler, { pool, params = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const req = { pool, params, query };
    const res = {
      json: (data) => resolve({ statusCode: 200, data }),
      status(code) {
        return { json: (data) => resolve({ statusCode: code, data }) };
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/* =========================================================================
   1. MAIN EXAMINATION SUMMARY  (§30.1)
   GET /main-exams/:mainExamId/reports/summary
========================================================================= */
const getSummaryReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid id" });

    const { statusCode, data } = await runHandler(getMainExamAnalytics, { pool, params: { id: mainExamId } });
    if (statusCode !== 200) return res.status(statusCode).json(data);

    // Nominal Roll — every registered candidate + the subjects they're
    // entered for. Own query (not part of computeMainExaminationSummary,
    // see loadNominalRoll's comment) since it's specific to this report.
    const nominalRoll = await loadNominalRoll(pool, mainExamId);

    // Overall Performance ranking — every scored candidate, ranked
    // exam-wide (not just within their own class/stream) by the exact
    // same average_percentage the Nominal Roll already computed and
    // displays, via loadNominalRoll's assignOverallPositions (§51: one
    // pass over the roll's own rows, never a second mean calculation).
    // Candidates with nothing scored yet are left off this ranked list —
    // they still appear in the Nominal Roll itself with a "—" position.
    // `marks` is carried straight over from the Nominal Roll row (same
    // per-subject scores, same order as `nominal_roll.subjects`) so this
    // ranking can show what a candidate scored in every paper, not just
    // their mean — never a second per-subject lookup.
    const overallRanking = (nominalRoll.rows || [])
      .filter((r) => r.average_percentage != null)
      .map((r) => ({
        overall_position: r.overall_position,
        student_id: r.student_id,
        admission_no: r.admission_no,
        name: r.name,
        class: r.class,
        average_percentage: r.average_percentage,
        marks: r.marks,
      }))
      .sort((a, b) => a.overall_position - b.overall_position);

    // Class Performance — one row per class/stream, rolled up from the
    // same Nominal Roll rows (§51) using the exam's configured pass mark
    // (data.performance.pass_mark), so it always agrees with the
    // exam-wide pass rate shown above it.
    const classPerformance = computeClassPerformance(nominalRoll.rows || [], data.performance.pass_mark);

    // Class Performance Ranking — every scored candidate, ranked WITHIN
    // their own class/stream (class_position, from loadNominalRoll's
    // assignClassPositions — §51: same pass, same figure the Nominal
    // Roll already shows for that candidate, never re-derived). Unlike
    // Overall Performance above, position here resets per class, so a
    // student can be e.g. "1st" in their class while sitting well down
    // the exam-wide Overall Performance list. Grouped by class, then by
    // position within it — the same order loadNominalRoll's own rows
    // are already sorted in, so this is just that same list narrowed to
    // scored candidates and carrying `class_position` instead of
    // `overall_position`.
    const classRanking = (nominalRoll.rows || [])
      .filter((r) => r.average_percentage != null)
      .map((r) => ({
        class_position: r.class_position,
        student_id: r.student_id,
        admission_no: r.admission_no,
        name: r.name,
        class: r.class,
        average_percentage: r.average_percentage,
        marks: r.marks,
      }))
      .sort((a, b) => {
        const classCmp = String(a.class || "").localeCompare(String(b.class || ""));
        if (classCmp !== 0) return classCmp;
        return a.class_position - b.class_position;
      });

    res.json({
      success: true,
      report: "main_examination_summary",
      generated_at: new Date().toISOString(),
      examination: data.examination,
      candidate_stats: data.candidate_stats,
      performance: data.performance,
      grade_distribution: data.grade_distribution,
      grade_distribution_note: data.grade_distribution_note,
      subjects: data.subjects,
      overall_ranking: overallRanking,
      class_performance: classPerformance,
      class_ranking: classRanking,
      nominal_roll: nominalRoll,
    });
  } catch (err) {
    console.error("GET SUMMARY REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating summary report" });
  }
};

/* =========================================================================
   2. SUBJECT RESULTS  (§30.2)
   GET /main-exams/:mainExamId/reports/subjects/:subjectId/results
========================================================================= */
const getSubjectResultsReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const subjectId = toInt(req.params.subjectId);
    if (!mainExamId || !subjectId) return res.status(400).json({ success: false, message: "Invalid id" });

    const sessionResult = await pool.request()
      .input("id", sql.Int, subjectId).input("mainExamId", sql.Int, mainExamId)
      .query(`
        SELECT ess.id AS session_id, ess.subject, ess.status AS session_status, ess.e_assessment_id,
          ea.total_marks, ea.class_id, ea.year_of_study
        FROM exam_subject_sessions ess
        LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        WHERE ess.id = @id AND ess.main_examination_id = @mainExamId
      `);
    const session = sessionResult.recordset[0];
    if (!session) return res.status(404).json({ success: false, message: "Subject session not found" });
    if (!session.e_assessment_id) {
      return res.json({ success: true, report: "subject_results", subject: session, rows: [],
        note: "No assessment is attached to this subject yet." });
    }

    const rowsResult = await pool.request()
      .input("eid", sql.Int, session.e_assessment_id)
      .input("classId", sql.Int, session.class_id || 0)
      .input("year", sql.Int, session.year_of_study || 0)
      .query(`
        SELECT st.id AS student_id, st.name, st.admissionNo,
          sub.score, sub.status AS submission_status
        FROM Students st
        LEFT JOIN Classes c ON c.id = @classId
        LEFT JOIN e_assessment_submissions sub ON sub.student_id = st.id AND sub.e_assessment_id = @eid
        WHERE (c.name IS NOT NULL AND c.name = st.studentClass) OR st.yearOfStudy = @year
        ORDER BY st.name
      `);

    const ended = ["ended", "marking", "completed"].includes(String(session.session_status || "").toLowerCase());
    const rows = rowsResult.recordset.map((r) => ({
      student_id: r.student_id,
      name: r.name,
      admission_no: r.admissionNo,
      marks: r.score,
      total_marks: session.total_marks,
      percentage: r.score != null && session.total_marks > 0 ? round1((r.score / session.total_marks) * 100) : null,
      grade: null, // §16 — no grading scale configured in this system yet
      status: r.score != null ? "Completed" : (ended ? "Absent" : "Scheduled"),
    }));

    res.json({
      success: true,
      report: "subject_results",
      generated_at: new Date().toISOString(),
      subject: { session_id: session.session_id, subject: session.subject, total_marks: session.total_marks },
      rows,
    });
  } catch (err) {
    console.error("GET SUBJECT RESULTS REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating subject results report" });
  }
};

/* =========================================================================
   3. STUDENT RESULT REPORT  (§30.3)
   GET /main-exams/:mainExamId/reports/students/:studentId/result
   Same shape the Analytics "Student Examination Profile" drill-down
   already computes — reused verbatim (§51).
========================================================================= */
const getStudentResultReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const studentId = toInt(req.params.studentId);
    if (!mainExamId || !studentId) return res.status(400).json({ success: false, message: "Invalid id" });

    const { statusCode, data } = await runHandler(getStudentExaminationProfile, {
      pool, params: { id: mainExamId, studentId },
    });
    if (statusCode !== 200) return res.status(statusCode).json(data);

    res.json({
      success: true,
      report: "student_result",
      generated_at: new Date().toISOString(),
      student: data.student,
      overall_average: data.overall_average,
      subjects_completed: data.subjects_completed,
      subjects_absent: data.subjects_absent,
      subjects_upcoming: data.subjects_upcoming,
      subjects: data.subjects,
    });
  } catch (err) {
    console.error("GET STUDENT RESULT REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating student result report" });
  }
};

/* =========================================================================
   4. CLASS RESULTS  (§30.4)
   GET /main-exams/:mainExamId/reports/classes/:classId/results
========================================================================= */
const getClassResultsReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const classId = toInt(req.params.classId);
    if (!mainExamId || !classId) return res.status(400).json({ success: false, message: "Invalid id" });

    const classResult = await pool.request().input("classId", sql.Int, classId)
      .query(`SELECT id, name FROM Classes WHERE id = @classId`);
    const klass = classResult.recordset[0];
    if (!klass) return res.status(404).json({ success: false, message: "Class not found" });

    // Classes has no year_of_study column of its own — every other query
    // in this codebase resolves a class's year through its students
    // (Students.yearOfStudy), so this does the same: a class's students
    // share one year of study by convention, exactly like the existing
    // "year" assessment-target resolution in AdminEAssessments' backend.
    const yearResult = await pool.request().input("className", sql.NVarChar, klass.name)
      .query(`SELECT TOP 1 yearOfStudy FROM Students WHERE studentClass = @className AND yearOfStudy IS NOT NULL ORDER BY yearOfStudy`);
    const classYear = yearResult.recordset[0]?.yearOfStudy || 0;

    const subjectsResult = await pool.request()
      .input("mainExamId", sql.Int, mainExamId).input("classId", sql.Int, classId).input("year", sql.Int, classYear)
      .query(`
        SELECT ess.id AS session_id, ess.subject, ess.e_assessment_id, ea.total_marks
        FROM exam_subject_sessions ess
        JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        WHERE ess.main_examination_id = @mainExamId
          AND (ea.class_id = @classId OR ea.year_of_study = @year)
        ORDER BY ess.start_time ASC, ess.id ASC
      `);
    const subjects = subjectsResult.recordset;
    const eAssessmentIds = subjects.map((s) => s.e_assessment_id).filter(Boolean);

    const studentsResult = await pool.request().input("className", sql.NVarChar, klass.name)
      .query(`SELECT id, name, admissionNo FROM Students WHERE studentClass = @className ORDER BY name`);
    const students = studentsResult.recordset;

    let submissions = [];
    if (eAssessmentIds.length && students.length) {
      const req1 = pool.request().input("className", sql.NVarChar, klass.name);
      const idParams = eAssessmentIds.map((v, i) => { req1.input(`eid${i}`, sql.Int, v); return `@eid${i}`; }).join(",");
      const subsResult = await req1.query(`
        SELECT sub.student_id, sub.e_assessment_id, sub.score
        FROM e_assessment_submissions sub
        JOIN Students st ON st.id = sub.student_id
        WHERE sub.e_assessment_id IN (${idParams}) AND st.studentClass = @className
      `);
      submissions = subsResult.recordset;
    }
    const subMap = {}; // `${studentId}:${eAssessmentId}` -> score
    submissions.forEach((s) => { subMap[`${s.student_id}:${s.e_assessment_id}`] = s.score; });

    const rows = students.map((st) => {
      let totalObtained = 0, totalPossible = 0, scoredCount = 0;
      const subjectMarks = subjects.map((sub) => {
        const score = subMap[`${st.id}:${sub.e_assessment_id}`];
        const percentage = score != null && sub.total_marks > 0 ? round1((score / sub.total_marks) * 100) : null;
        if (score != null) { totalObtained += score; totalPossible += sub.total_marks || 0; scoredCount += 1; }
        return { subject: sub.subject, score: score ?? null, total_marks: sub.total_marks, percentage, grade: null };
      });
      return {
        student_id: st.id,
        name: st.name,
        admission_no: st.admissionNo,
        subjects: subjectMarks,
        total_marks_obtained: scoredCount ? totalObtained : null,
        total_marks_possible: scoredCount ? totalPossible : null,
        average_percentage: scoredCount && totalPossible > 0 ? round1((totalObtained / totalPossible) * 100) : null,
        grade: null,
      };
    });

    res.json({
      success: true,
      report: "class_results",
      generated_at: new Date().toISOString(),
      class: { id: klass.id, name: klass.name },
      subjects: subjects.map((s) => ({ session_id: s.session_id, subject: s.subject, total_marks: s.total_marks })),
      rows,
    });
  } catch (err) {
    console.error("GET CLASS RESULTS REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating class results report" });
  }
};

/* =========================================================================
   5. GRADE DISTRIBUTION  (§30.5)
   GET /main-exams/:mainExamId/reports/grade-distribution
   Reuses the same main-exam summary computation (§51) — currently
   always "unavailable" because no grading-scale table exists in this
   schema (§16's "do not hard-code" instruction), never invented here.
========================================================================= */
const getGradeDistributionReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid id" });

    const { statusCode, data } = await runHandler(getMainExamAnalytics, { pool, params: { id: mainExamId } });
    if (statusCode !== 200) return res.status(statusCode).json(data);

    res.json({
      success: true,
      report: "grade_distribution",
      generated_at: new Date().toISOString(),
      examination: { id: data.examination.id, name: data.examination.name },
      grade_distribution: data.grade_distribution,
      note: data.grade_distribution_note,
    });
  } catch (err) {
    console.error("GET GRADE DISTRIBUTION REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating grade distribution report" });
  }
};

/* =========================================================================
   6. QUESTION ANALYSIS  (§30.6)
   GET /main-exams/:mainExamId/reports/subjects/:subjectId/question-analysis
   Reuses the Phase 9 subject-analytics computation verbatim (§51) —
   the questions + discrimination arrays already have exactly the shape
   §30.6 asks for.
========================================================================= */
const getQuestionAnalysisReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const subjectId = toInt(req.params.subjectId);
    if (!mainExamId || !subjectId) return res.status(400).json({ success: false, message: "Invalid id" });

    const { statusCode, data } = await runHandler(getSubjectAnalytics, {
      pool, params: { mainExamId, subjectId },
    });
    if (statusCode !== 200) return res.status(statusCode).json(data);

    const discByQuestion = {};
    (data.discrimination || []).forEach((d) => { discByQuestion[d.question_id] = d; });

    const rows = (data.questions || []).map((q) => ({
      question_id: q.question_id,
      question_type: q.question_type,
      marks: q.marks,
      attempts: q.attempts,
      correct: q.correct_pct,
      incorrect: q.incorrect_pct,
      unanswered: q.unanswered_pct,
      difficulty: q.difficulty,
      discrimination: discByQuestion[q.question_id]?.discrimination_index ?? null,
      discrimination_label: discByQuestion[q.question_id]?.label ?? (data.discrimination_note ? "Insufficient data" : null),
    }));

    res.json({
      success: true,
      report: "question_analysis",
      generated_at: new Date().toISOString(),
      subject: data.subject ? { subject: data.subject.subject } : null,
      rows,
      discrimination_note: data.discrimination_note,
    });
  } catch (err) {
    console.error("GET QUESTION ANALYSIS REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating question analysis report" });
  }
};

/* =========================================================================
   7. TOPIC / COMPETENCY REPORT  (§30.7)
   GET /main-exams/:mainExamId/reports/subjects/:subjectId/topic-analysis
   §23: this schema's e_assessment_questions table has no topic/
   competency column, so this always comes back empty with an honest
   note rather than a fabricated breakdown (§50).
========================================================================= */
const getTopicAnalysisReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const subjectId = toInt(req.params.subjectId);
    if (!mainExamId || !subjectId) return res.status(400).json({ success: false, message: "Invalid id" });

    const sessionResult = await pool.request()
      .input("id", sql.Int, subjectId).input("mainExamId", sql.Int, mainExamId)
      .query(`SELECT id, subject FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mainExamId`);
    const session = sessionResult.recordset[0];
    if (!session) return res.status(404).json({ success: false, message: "Subject session not found" });

    res.json({
      success: true,
      report: "topic_analysis",
      generated_at: new Date().toISOString(),
      subject: { subject: session.subject },
      rows: [],
      note: "Unavailable — this question schema has no topic/competency field yet (§23). Adding one would require a schema change, which is out of scope for this phase.",
    });
  } catch (err) {
    console.error("GET TOPIC ANALYSIS REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating topic analysis report" });
  }
};

/* =========================================================================
   8. MARKING PROGRESS REPORT  (§30.8)
   GET /main-exams/:mainExamId/reports/marking-progress
   Main-exam-wide, one row per subject — a roll-up of the same
   status/marks columns the marking analytics endpoint reads, grouped
   across every subject in one query rather than one call per subject
   (§57/§58).
========================================================================= */
const getMarkingProgressReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid id" });

    const { statusCode, data } = await runHandler(getMainExamAnalytics, { pool, params: { id: mainExamId } });
    if (statusCode !== 200) return res.status(statusCode).json(data);
    const eAssessmentIds = data.subjects.map((s) => s.e_assessment_id).filter(Boolean);

    let markingMap = {};
    if (eAssessmentIds.length) {
      const request = pool.request();
      const idParams = eAssessmentIds.map((v, i) => { request.input(`eid${i}`, sql.Int, v); return `@eid${i}`; }).join(",");
      const result = await request.query(`
        SELECT s.e_assessment_id,
          COUNT(*) AS total_submissions,
          SUM(CASE WHEN s.status IN ('marked','released') THEN 1 ELSE 0 END) AS marked,
          SUM(CASE WHEN s.status = 'submitted' THEN 1 ELSE 0 END) AS unmarked
        FROM e_assessment_submissions s
        WHERE s.e_assessment_id IN (${idParams})
        GROUP BY s.e_assessment_id
      `);
      result.recordset.forEach((r) => { markingMap[r.e_assessment_id] = r; });
    }

    const rows = data.subjects.map((s) => {
      const m = markingMap[s.e_assessment_id] || { total_submissions: 0, marked: 0, unmarked: 0 };
      return {
        session_id: s.session_id,
        subject: s.subject,
        total_submissions: m.total_submissions || 0,
        marked: m.marked || 0,
        unmarked: m.unmarked || 0,
        progress_pct: m.total_submissions ? round1(((m.marked || 0) / m.total_submissions) * 100) : null,
      };
    });

    res.json({ success: true, report: "marking_progress", generated_at: new Date().toISOString(), rows });
  } catch (err) {
    console.error("GET MARKING PROGRESS REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating marking progress report" });
  }
};

/* =========================================================================
   10. CANDIDATE EXAMINATION SCHEDULE  (§30.10)
   GET /main-exams/:mainExamId/reports/students/:studentId/schedule
   (§30.9 "Examination Timetable" is the whole-cohort version of this —
   served by the existing GET /main-exams/:mainExamId/timetable, reused
   as-is under /reports/timetable in routes/mainExams.js.)
========================================================================= */
const getCandidateScheduleReport = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const studentId = toInt(req.params.studentId);
    if (!mainExamId || !studentId) return res.status(400).json({ success: false, message: "Invalid id" });

    const studentResult = await pool.request().input("studentId", sql.Int, studentId)
      .query(`SELECT id, name, admissionNo, studentClass, yearOfStudy FROM Students WHERE id = @studentId`);
    const student = studentResult.recordset[0];
    if (!student) return res.status(404).json({ success: false, message: "Student not found" });

    const examResult = await pool.request().input("id", sql.Int, mainExamId)
      .query(`SELECT id, name FROM main_examinations WHERE id = @id`);
    const examination = examResult.recordset[0];
    if (!examination) return res.status(404).json({ success: false, message: "Main examination not found" });

    const rowsResult = await pool.request()
      .input("mainExamId", sql.Int, mainExamId)
      .input("studentId", sql.Int, studentId)
      .input("studentClass", sql.NVarChar, student.studentClass || "")
      .input("yearOfStudy", sql.Int, student.yearOfStudy || 0)
      .query(`
        SELECT ess.subject, ess.exam_date, ess.start_time, ess.end_time, ess.venue, ess.status AS session_status,
          sub.score, ea.total_marks
        FROM exam_subject_sessions ess
        JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        LEFT JOIN Classes c ON c.id = ea.class_id
        LEFT JOIN e_assessment_submissions sub ON sub.e_assessment_id = ess.e_assessment_id AND sub.student_id = @studentId
        WHERE ess.main_examination_id = @mainExamId
          AND ( (c.name IS NOT NULL AND c.name = @studentClass) OR ea.year_of_study = @yearOfStudy )
        ORDER BY ess.start_time ASC, ess.id ASC
      `);

    const rows = rowsResult.recordset.map((r) => ({
      subject: r.subject,
      exam_date: r.exam_date,
      start_time: r.start_time,
      end_time: r.end_time,
      venue: r.venue,
      status: r.score != null ? "Completed" : (r.session_status || "Scheduled"),
    }));

    res.json({
      success: true,
      report: "candidate_schedule",
      generated_at: new Date().toISOString(),
      student: { id: student.id, name: student.name, admission_no: student.admissionNo },
      examination: { id: examination.id, name: examination.name },
      rows,
    });
  } catch (err) {
    console.error("GET CANDIDATE SCHEDULE REPORT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating candidate schedule report" });
  }
};

module.exports = {
  getSummaryReport,
  getSubjectResultsReport,
  getStudentResultReport,
  getClassResultsReport,
  getGradeDistributionReport,
  getQuestionAnalysisReport,
  getTopicAnalysisReport,
  getMarkingProgressReport,
  getCandidateScheduleReport,
  runHandler, // reused by mainExamExports.controller.js (Phase 12-13) so the
              // Excel/PDF exporters call the exact same report handlers
              // in-process rather than re-deriving their data (§51).
};
