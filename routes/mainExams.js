const express = require("express");
const router = express.Router();

const {
  createMainExamination,
  getMainExaminations,
  getMainExaminationById,
  updateMainExamination,
  archiveMainExamination,
  deleteMainExamination,
  getMainExaminationDashboard,
  getMainExaminationAuditLog,
  generateExamCode,
} = require("../controllers/mainExam.controller");

const {
  addSubjectSession,
  getSubjectSessions,
  getSubjectSessionById,
  updateSubjectSession,
  attachAssessment,
  deleteSubjectSession,
  getTimetable,
  publishTimetable,
  unpublishTimetable,
} = require("../controllers/examSubjectSession.controller");

const {
  getMainExamAnalytics,
  getSubjectAnalytics,
  getMainExamStudentAnalytics,
  getStudentExaminationProfile,
} = require("../controllers/mainExamAnalytics.controller");

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
} = require("../controllers/mainExamReports.controller");

const { buildExportHandler } = require("../controllers/mainExamExports.controller");

const { protect, requirePage } = require("../middleware/authMiddleware");

/* =========================================================================
   MAIN EXAMINATIONS
   Reuses the existing "E-Assessments" page permission (§43) rather than
   introducing a new page key — Main Examinations is a sub-section of
   E-Assessments in the nav (§3: "Dashboard → E-Assessments → Main
   Examinations"), so whoever already has E-Assessments access manages
   this too. Every route is admin/sub_admin-only for now: subject
   scheduling, student/teacher access and analytics land in later phases.
========================================================================= */
router.use(protect, requirePage("E-Assessments"));

router.get("/", getMainExaminations);
router.post("/", createMainExamination);
router.get("/:id", getMainExaminationById);
router.put("/:id", updateMainExamination);
router.put("/:id/archive", archiveMainExamination);
router.delete("/:id", deleteMainExamination);

/* ---------------- Dashboard summary + audit log (§10, §53 — Phase 7) ---------------- */
router.get("/:id/dashboard", getMainExaminationDashboard);
router.get("/:id/audit-log", getMainExaminationAuditLog);

/* ---------------- Exam code (whole-exam local download) ---------------- */
router.post("/:id/exam-code", generateExamCode);

/* ---------------- Subject / learning-area scheduling (§4-§6) ---------------- */
router.get("/:mainExamId/subjects", getSubjectSessions);
router.post("/:mainExamId/subjects", addSubjectSession);
router.get("/:mainExamId/subjects/:id", getSubjectSessionById);
router.put("/:mainExamId/subjects/:id", updateSubjectSession);
router.put("/:mainExamId/subjects/:id/assessment", attachAssessment);
router.delete("/:mainExamId/subjects/:id", deleteSubjectSession);

/* ---------------- Timetable (§5-§6) ---------------- */
router.get("/:mainExamId/timetable", getTimetable);
router.put("/:mainExamId/publish", publishTimetable);
router.put("/:mainExamId/unpublish", unpublishTimetable);

/* ---------------- Analytics (§15-§26 — Phase 9) ----------------
   Main-exam-level and subject-level aggregation, plus the student
   drill-down (§18/§49's "Main Examination → Subject → Student" path).
   All read-only, all computed from the existing e_assessment* tables —
   no second results engine (§51). Kept on the same admin/sub_admin-only
   router guard as everything else here; a teacher-scoped subset is a
   later phase per §42's note in the Phase 7 handoff. */
router.get("/:id/analytics", getMainExamAnalytics);
router.get("/:id/analytics/students", getMainExamStudentAnalytics);
router.get("/:id/analytics/students/:studentId", getStudentExaminationProfile);
router.get("/:mainExamId/subjects/:subjectId/analytics", getSubjectAnalytics);

/* ---------------- Reports (§29-§33 — Phase 11) ----------------
   The 10 report types from §30, all authoritative/backend-computed
   (§33). Reports that overlap with the analytics above (summary,
   student result, question analysis, grade distribution) reuse those
   exact handlers in-process (§51 — see mainExamReports.controller.js's
   runHandler) so a report can never disagree with the dashboard. The
   Examination Timetable report (§30.9) is the already-existing
   GET /:mainExamId/timetable above, mounted a second time here so it's
   reachable from a "Reports" tab without a second implementation. */
router.get("/:mainExamId/reports/summary", getSummaryReport);
router.get("/:mainExamId/reports/timetable", getTimetable);
router.get("/:mainExamId/reports/grade-distribution", getGradeDistributionReport);
router.get("/:mainExamId/reports/marking-progress", getMarkingProgressReport);
router.get("/:mainExamId/reports/subjects/:subjectId/results", getSubjectResultsReport);
router.get("/:mainExamId/reports/subjects/:subjectId/question-analysis", getQuestionAnalysisReport);
router.get("/:mainExamId/reports/subjects/:subjectId/topic-analysis", getTopicAnalysisReport);
router.get("/:mainExamId/reports/classes/:classId/results", getClassResultsReport);
router.get("/:mainExamId/reports/students/:studentId/result", getStudentResultReport);
router.get("/:mainExamId/reports/students/:studentId/schedule", getCandidateScheduleReport);

/* ---------------- Excel / PDF export (§29, §31-§33 — Phase 12-13) ----------------
   Same URL shape as the JSON report routes just above, with /excel or
   /pdf appended — each pulls its data from the EXACT SAME handler
   (buildExportHandler → runHandler, see mainExamExports.controller.js)
   so a downloaded file is always consistent with the on-screen report. */
router.get("/:mainExamId/reports/summary/excel", buildExportHandler("summary", "excel"));
router.get("/:mainExamId/reports/summary/pdf", buildExportHandler("summary", "pdf"));
router.get("/:mainExamId/reports/timetable/excel", buildExportHandler("timetable", "excel"));
router.get("/:mainExamId/reports/timetable/pdf", buildExportHandler("timetable", "pdf"));
router.get("/:mainExamId/reports/grade-distribution/excel", buildExportHandler("grade-distribution", "excel"));
router.get("/:mainExamId/reports/grade-distribution/pdf", buildExportHandler("grade-distribution", "pdf"));
router.get("/:mainExamId/reports/marking-progress/excel", buildExportHandler("marking-progress", "excel"));
router.get("/:mainExamId/reports/marking-progress/pdf", buildExportHandler("marking-progress", "pdf"));
router.get("/:mainExamId/reports/subjects/:subjectId/results/excel", buildExportHandler("subject-results", "excel"));
router.get("/:mainExamId/reports/subjects/:subjectId/results/pdf", buildExportHandler("subject-results", "pdf"));
router.get("/:mainExamId/reports/subjects/:subjectId/question-analysis/excel", buildExportHandler("question-analysis", "excel"));
router.get("/:mainExamId/reports/subjects/:subjectId/question-analysis/pdf", buildExportHandler("question-analysis", "pdf"));
router.get("/:mainExamId/reports/subjects/:subjectId/topic-analysis/excel", buildExportHandler("topic-analysis", "excel"));
router.get("/:mainExamId/reports/subjects/:subjectId/topic-analysis/pdf", buildExportHandler("topic-analysis", "pdf"));
router.get("/:mainExamId/reports/classes/:classId/results/excel", buildExportHandler("class-results", "excel"));
router.get("/:mainExamId/reports/classes/:classId/results/pdf", buildExportHandler("class-results", "pdf"));
router.get("/:mainExamId/reports/students/:studentId/result/excel", buildExportHandler("student-result", "excel"));
router.get("/:mainExamId/reports/students/:studentId/result/pdf", buildExportHandler("student-result", "pdf"));
router.get("/:mainExamId/reports/students/:studentId/schedule/excel", buildExportHandler("candidate-schedule", "excel"));
router.get("/:mainExamId/reports/students/:studentId/schedule/pdf", buildExportHandler("candidate-schedule", "pdf"));

/* =========================================================================
   ROUTE-LEVEL ERROR HANDLER
========================================================================= */
router.use((err, req, res, next) => {
  console.error("MAIN EXAM ROUTE ERROR:", err);
  res.status(500).json({ success: false, message: err.message || "Server Error" });
});

module.exports = router;
