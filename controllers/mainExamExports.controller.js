const sql = require("mssql");
const {
  getSummaryReport,
  getSubjectResultsReport,
  getStudentResultReport,
  getClassResultsReport,
  getGradeDistributionReport,
  getQuestionAnalysisReport,
  getTopicAnalysisReport,
  getMarkingProgressReport,
  getCandidateScheduleReport,
  runHandler,
} = require("./mainExamReports.controller");
const { getTimetable } = require("./examSubjectSession.controller");
const {
  getInstitutionHeader,
  buildReportWorkbook,
  sendExcelBuffer,
  buildReportPdf,
  sendPdfBuffer,
} = require("../utils/reportExport");

/* =========================================================================
   REPORT EXPORTS — Excel (§31, Phase 12) and PDF (§32, Phase 13)

   Every handler below: (1) calls the exact same *Report Express handler
   already serving the Reports tab's JSON, via runHandler — so the file
   a person downloads can never show different numbers than what they
   just saw on screen (§33, §51); (2) shapes that JSON into the generic
   {columns, rows} tables utils/reportExport.js knows how to draw;
   (3) hands it to the shared Excel or PDF builder.

   Every handler that needs a specific subject/student/class also needs
   that entity's own name for the file's title — the *Report JSON
   usually already includes it, so this only adds the one extra
   main_examinations lookup (name + academic_year) every export needs
   for its header, not a re-fetch of anything report-specific.
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

async function loadExamHeaderInfo(pool, mainExamId) {
  const result = await pool.request().input("id", sql.Int, mainExamId)
    .query(`SELECT name, academic_year FROM main_examinations WHERE id = @id`);
  return result.recordset[0] || { name: "", academic_year: "" };
}

const slug = (s) => String(s || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/* -------------------------------------------------------------------------
   One shape function per report type: given the report's own JSON, return
   { title, excelSheets: [...], pdfSections: [...] }. Kept side by side so
   a column added to one format is obviously missing if not added to the
   other.
------------------------------------------------------------------------- */
const SHAPES = {
  summary(data) {
    const cs = data.candidate_stats || {};
    const perf = data.performance || {};
    const overviewRows = [
      { label: "Registered Candidates", value: cs.registered ?? "-" },
      { label: "Attempted", value: cs.attempted ?? "-" },
      { label: "Completed", value: cs.completed ?? "-" },
      { label: "Incomplete", value: cs.incomplete ?? "-" },
      { label: "Absent", value: cs.absent ?? "-" },
    ];
    const perfRows = [
      { label: "Mean (%)", value: perf.mean ?? "-" },
      { label: "Median (%)", value: perf.median ?? "-" },
      { label: "Highest (%)", value: perf.highest ?? "-" },
      { label: "Lowest (%)", value: perf.lowest ?? "-" },
      { label: "Standard Deviation", value: perf.std_dev ?? "-" },
      { label: "Pass Rate", value: perf.pass_rate ?? (perf.pass_rate_note || "-") },
    ];
    const overviewCols = [{ header: "Metric", key: "label", width: 26 }, { header: "Value", key: "value", width: 16 }];

    const subjectCols = [
      { header: "Subject", key: "subject", width: 24 },
      { header: "Registered", key: "registered", width: 12 },
      { header: "Attempted", key: "attempted", width: 12 },
      { header: "Completed", key: "completed", width: 12 },
      { header: "Mean (%)", key: "mean", width: 12 },
      { header: "Highest (%)", key: "highest", width: 12 },
      { header: "Lowest (%)", key: "lowest", width: 12 },
    ];
    const subjectRows = data.subjects || [];

    const gradeCols = [{ header: "Grade", key: "grade", width: 14 }, { header: "Number", key: "number", width: 12 }, { header: "Percentage", key: "percentage", width: 14 }];
    const gradeRows = data.grade_distribution || [];
    const gradeNote = !data.grade_distribution ? (data.grade_distribution_note || "Unavailable") : null;

    const nr = data.nominal_roll || { subjects: [], rows: [] };
    const nominalSubjects = nr.subjects || [];
    const nominalCols = [
      { header: "Position", key: "class_position", width: 10 },
      { header: "Assessment No", key: "admission_no", width: 16 },
      { header: "Gender", key: "gender", width: 8 },
      { header: "Name", key: "name", width: 26 },
      ...nominalSubjects.map((s, i) => ({ header: s.subject, key: `subj_${i}`, width: 12 })),
      { header: "Average %", key: "average_percentage", width: 10, percent: true },
    ];
    const nominalRows = (nr.rows || []).map((r) => {
      const row = {
        class_position: r.class_position ?? "—",
        admission_no: r.admission_no,
        gender: r.gender || "—",
        name: r.name,
        average_percentage: r.average_percentage,
      };
      (r.marks || []).forEach((m, i) => { row[`subj_${i}`] = m.not_registered || m.score == null ? "—" : m.score; });
      return row;
    });

    return {
      title: "Main Examination Summary",
      excelSheets: [
        { name: "Candidate Stats", title: "Candidate Statistics", columns: overviewCols, rows: overviewRows },
        { name: "Performance", title: "Overall Performance", columns: overviewCols, rows: perfRows },
        { name: "Subject Summary", title: "Performance by Subject", columns: subjectCols, rows: subjectRows },
        { name: "Grade Distribution", title: "Grade Distribution", columns: gradeCols, rows: gradeRows, note: gradeNote },
        { name: "Nominal Roll", title: "Nominal Roll", columns: nominalCols, rows: nominalRows, note: !nominalRows.length ? "No registered candidates found." : null },
      ],
      pdfSections: [
        { heading: "Candidate Statistics", columns: overviewCols, rows: overviewRows },
        { heading: "Overall Performance", columns: overviewCols, rows: perfRows },
        { heading: "Performance by Subject", columns: subjectCols, rows: subjectRows },
        { heading: "Grade Distribution", columns: gradeCols, rows: gradeRows, text: gradeNote || undefined },
        { heading: "Nominal Roll", columns: nominalCols, rows: nominalRows },
      ],
    };
  },

  subjectResults(data) {
    const columns = [
      { header: "Admission No", key: "admission_no", width: 16 },
      { header: "Name", key: "name", width: 26 },
      { header: "Marks", key: "marks", width: 10 },
      { header: "Total Marks", key: "total_marks", width: 12 },
      { header: "Percentage", key: "percentage", width: 12, percent: true },
      { header: "Grade", key: "grade", width: 10 },
      { header: "Status", key: "status", width: 12 },
    ];
    const rows = data.rows || [];
    const scored = rows.filter((r) => r.percentage != null);
    const totals = scored.length
      ? { name: "Average", percentage: Math.round((scored.reduce((a, r) => a + r.percentage, 0) / scored.length) * 10) / 10 }
      : null;
    return {
      title: `Subject Results — ${data.subject?.subject || ""}`,
      excelSheets: [{ name: "Subject Results", title: `Subject Results — ${data.subject?.subject || ""}`, columns, rows, totals, note: data.note }],
      pdfSections: [{ columns, rows }],
    };
  },

  studentResult(data) {
    const infoCols = [{ header: "Field", key: "label", width: 20 }, { header: "Value", key: "value", width: 24 }];
    const infoRows = [
      { label: "Student", value: data.student?.name },
      { label: "Admission No", value: data.student?.admission_no },
      { label: "Overall Average", value: data.overall_average != null ? `${data.overall_average}%` : "Not enough data" },
      { label: "Subjects Completed", value: data.subjects_completed },
      { label: "Subjects Absent", value: data.subjects_absent },
      { label: "Subjects Upcoming", value: data.subjects_upcoming },
    ];
    const subjectCols = [
      { header: "Subject", key: "subject", width: 22 },
      { header: "Marks", key: "score", width: 10 },
      { header: "Total Marks", key: "total_marks", width: 12 },
      { header: "Percentage", key: "percentage", width: 12, percent: true },
      { header: "Status", key: "status", width: 12 },
    ];
    return {
      title: `Student Result — ${data.student?.name || ""}`,
      excelSheets: [
        { name: "Student Info", title: "Student Information", columns: infoCols, rows: infoRows },
        { name: "Subjects", title: "Subject Results", columns: subjectCols, rows: data.subjects || [] },
      ],
      pdfSections: [
        { heading: "Student Information", columns: infoCols, rows: infoRows },
        { heading: "Subject Results", columns: subjectCols, rows: data.subjects || [] },
      ],
    };
  },

  classResults(data) {
    const subjectList = data.subjects || [];
    const columns = [
      { header: "Admission No", key: "admission_no", width: 16 },
      { header: "Name", key: "name", width: 24 },
      ...subjectList.map((s, i) => ({ header: s.subject, key: `subj_${i}`, width: 14 })),
      { header: "Total", key: "total_marks_obtained", width: 10 },
      { header: "Average %", key: "average_percentage", width: 12, percent: true },
    ];
    const rows = (data.rows || []).map((r) => {
      const flat = { admission_no: r.admission_no, name: r.name, total_marks_obtained: r.total_marks_obtained, average_percentage: r.average_percentage };
      (r.subjects || []).forEach((s, i) => { flat[`subj_${i}`] = s.score ?? "-"; });
      return flat;
    });
    return {
      title: `Class Results — ${data.class?.name || ""}`,
      excelSheets: [{ name: "Class Results", title: `Class Results — ${data.class?.name || ""}`, columns, rows }],
      pdfSections: [{ columns, rows }],
    };
  },

  gradeDistribution(data) {
    const columns = [{ header: "Grade", key: "grade", width: 16 }, { header: "Number", key: "number", width: 12 }, { header: "Percentage", key: "percentage", width: 14 }];
    const rows = data.grade_distribution || [];
    return {
      title: "Grade Distribution",
      excelSheets: [{ name: "Grade Distribution", title: "Grade Distribution", columns, rows, note: !rows.length ? data.note : null }],
      pdfSections: [{ columns, rows, text: !rows.length ? data.note : undefined }],
    };
  },

  questionAnalysis(data) {
    const columns = [
      { header: "Q#", key: "question_id", width: 8 },
      { header: "Type", key: "question_type", width: 12 },
      { header: "Marks", key: "marks", width: 8 },
      { header: "Attempts", key: "attempts", width: 10 },
      { header: "Correct %", key: "correct", width: 10, percent: true },
      { header: "Incorrect %", key: "incorrect", width: 10, percent: true },
      { header: "Unanswered %", key: "unanswered", width: 12, percent: true },
      { header: "Difficulty", key: "difficulty", width: 12 },
      { header: "Discrimination", key: "discrimination_label", width: 14 },
    ];
    return {
      title: `Question Analysis — ${data.subject?.subject || ""}`,
      excelSheets: [{ name: "Question Analysis", title: `Question Analysis — ${data.subject?.subject || ""}`, columns, rows: data.rows || [], note: data.discrimination_note }],
      pdfSections: [{ columns, rows: data.rows || [], text: data.discrimination_note }],
    };
  },

  topicAnalysis(data) {
    const columns = [{ header: "Topic", key: "topic", width: 22 }, { header: "Questions", key: "questions", width: 12 }, { header: "Candidates", key: "candidates", width: 12 }, { header: "Average Achievement", key: "average", width: 16, percent: true }];
    return {
      title: `Topic / Competency Report — ${data.subject?.subject || ""}`,
      excelSheets: [{ name: "Topic Analysis", title: `Topic / Competency — ${data.subject?.subject || ""}`, columns, rows: data.rows || [], note: data.note }],
      pdfSections: [{ columns, rows: data.rows || [], text: data.note }],
    };
  },

  markingProgress(data) {
    const columns = [
      { header: "Subject", key: "subject", width: 24 },
      { header: "Total Submissions", key: "total_submissions", width: 16 },
      { header: "Marked", key: "marked", width: 10 },
      { header: "Unmarked", key: "unmarked", width: 10 },
      { header: "Progress %", key: "progress_pct", width: 12, percent: true },
    ];
    return {
      title: "Marking Progress",
      excelSheets: [{ name: "Marking Progress", title: "Marking Progress", columns, rows: data.rows || [] }],
      pdfSections: [{ columns, rows: data.rows || [] }],
    };
  },

  timetable(data) {
    const columns = [
      { header: "Subject", key: "subject", width: 22 },
      { header: "Date", key: "exam_date", width: 14 },
      { header: "Start", key: "start_time", width: 16 },
      { header: "End", key: "end_time", width: 16 },
      { header: "Duration (min)", key: "duration_minutes", width: 12 },
      { header: "Venue", key: "venue", width: 16 },
      { header: "Status", key: "status", width: 12 },
    ];
    const rows = (data.timetable || []).map((r) => ({
      ...r,
      exam_date: r.exam_date ? new Date(r.exam_date).toLocaleDateString() : "-",
      start_time: r.start_time ? new Date(r.start_time).toLocaleString() : "-",
      end_time: r.end_time ? new Date(r.end_time).toLocaleString() : "-",
    }));
    return {
      title: "Examination Timetable",
      excelSheets: [{ name: "Timetable", title: "Examination Timetable", columns, rows }],
      pdfSections: [{ columns, rows }],
    };
  },

  candidateSchedule(data) {
    const columns = [
      { header: "Subject", key: "subject", width: 22 },
      { header: "Date", key: "exam_date", width: 14 },
      { header: "Start", key: "start_time", width: 16 },
      { header: "End", key: "end_time", width: 16 },
      { header: "Venue", key: "venue", width: 16 },
      { header: "Status", key: "status", width: 12 },
    ];
    const rows = (data.rows || []).map((r) => ({
      ...r,
      exam_date: r.exam_date ? new Date(r.exam_date).toLocaleDateString() : "-",
      start_time: r.start_time ? new Date(r.start_time).toLocaleString() : "-",
      end_time: r.end_time ? new Date(r.end_time).toLocaleString() : "-",
    }));
    return {
      title: `Candidate Schedule — ${data.student?.name || ""}`,
      excelSheets: [{ name: "My Schedule", title: `Examination Schedule — ${data.student?.name || ""}`, columns, rows }],
      pdfSections: [{ columns, rows }],
    };
  },
};

/* -------------------------------------------------------------------------
   REPORTS registry — one entry per §30 report type. `handler` is the
   existing Phase 11 Express handler; `params` lists which route params
   it expects (matching its own req.params usage); `shape` is one of the
   SHAPES functions above.
------------------------------------------------------------------------- */
const REPORTS = {
  summary: { handler: getSummaryReport, params: ["mainExamId"], shape: SHAPES.summary },
  "subject-results": { handler: getSubjectResultsReport, params: ["mainExamId", "subjectId"], shape: SHAPES.subjectResults },
  "student-result": { handler: getStudentResultReport, params: ["mainExamId", "studentId"], shape: SHAPES.studentResult },
  "class-results": { handler: getClassResultsReport, params: ["mainExamId", "classId"], shape: SHAPES.classResults },
  "grade-distribution": { handler: getGradeDistributionReport, params: ["mainExamId"], shape: SHAPES.gradeDistribution },
  "question-analysis": { handler: getQuestionAnalysisReport, params: ["mainExamId", "subjectId"], shape: SHAPES.questionAnalysis },
  "topic-analysis": { handler: getTopicAnalysisReport, params: ["mainExamId", "subjectId"], shape: SHAPES.topicAnalysis },
  "marking-progress": { handler: getMarkingProgressReport, params: ["mainExamId"], shape: SHAPES.markingProgress },
  timetable: { handler: getTimetable, params: ["mainExamId"], shape: SHAPES.timetable },
  "candidate-schedule": { handler: getCandidateScheduleReport, params: ["mainExamId", "studentId"], shape: SHAPES.candidateSchedule },
};

/* Builds one Express handler for a given report key + format ("excel" |
   "pdf"). Registered twice per report in routes/mainExams.js. */
function buildExportHandler(reportKey, format) {
  const config = REPORTS[reportKey];
  return async (req, res) => {
    try {
      const pool = req.pool;
      const mainExamId = toInt(req.params.mainExamId);
      if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

      const params = {};
      config.params.forEach((p) => { params[p] = req.params[p]; });

      const { statusCode, data } = await runHandler(config.handler, { pool, params, query: req.query });
      if (statusCode !== 200) return res.status(statusCode).json(data);

      const shaped = config.shape(data);
      const examInfo = await loadExamHeaderInfo(pool, mainExamId);
      const filenameBase = `${slug(examInfo.name)}-${reportKey}`;

      if (format === "excel") {
        const buffer = await buildReportWorkbook(shaped.excelSheets);
        return sendExcelBuffer(res, buffer, `${filenameBase}.xlsx`);
      }

      // PDF
      const institution = await getInstitutionHeader(pool);
      const buffer = await buildReportPdf({
        institution,
        examinationName: examInfo.name,
        academicYear: examInfo.academic_year,
        reportTitle: shaped.title,
        sections: shaped.pdfSections,
      });
      return sendPdfBuffer(res, buffer, `${filenameBase}.pdf`);
    } catch (err) {
      console.error(`EXPORT REPORT ERROR (${reportKey}/${format}):`, err);
      res.status(500).json({ success: false, message: "Server error generating export" });
    }
  };
}

module.exports = { REPORTS, buildExportHandler };
