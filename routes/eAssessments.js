const express = require("express");
const router = express.Router();

const {
  // core
  createEAssessment, updateEAssessment, getEAssessments, getEAssessmentById,
  addEAssessmentQuestion, getAssessmentQuestions, updateQuestion, deleteQuestion,
  bulkAddQuestions, parseQuestionsDocx,

  // cover page (per-exam PDF)
  uploadCoverPage, deleteCoverPage,

  // question images (diagrams/photos)
  uploadQuestionImages, deleteQuestionImage,

  // standalone exam-password login (no portal account session)
  examLogin,

  // exam session / device lock
  startExamSession, activateExamSession, heartbeatExamSession, endExamSession,
  getExamSessions, unlockExamSession,

  // student
  submitEAssessment, getStudentResult,

  // admin review / stats
  getPendingAssessments, reviewAssessment, toggleEAssessmentActive, getEAssessmentQuickStats,
  deleteAssessments, deleteAssignments,

  // support data
  getClasses, getSubjects, getTeachers, assignTeacher, getAssignedTeachers,

  // submissions / marking
  getAllSubmissions, getAssessmentSubmissions, getSubmissionForMarking, getAllSubmissionsForMarking,
  saveMarking, saveMarkingBulk, assignSubmission, bulkAssignSubmissions, getNextSubmissionForMarking,

  // remarks
  requestRemark, getRemarkRequests, reviewRemarkRequest,

  // release
  getReleasedMarks, releaseMarks, bulkReleaseMarks,
} = require("../controllers/eAssessment.controller");

const { protect, authorize, requirePage } = require("../middleware/authMiddleware");
const { runCoverPageUpload } = require("../middleware/coverPageUpload");
const { runQuestionImageUpload } = require("../middleware/questionImageUpload");
const { runQuestionDocUpload } = require("../middleware/questionDocUpload");
const { examLoginConcurrencyGuard } = require("../middleware/examLoginConcurrencyGuard");

// Wrap the promise-based multer runners (see photoUpload.js's runPhotoUpload
// for the pattern this follows) so a bad file (wrong type/too large) comes
// back as a normal JSON 400 instead of an unhandled multer error.
const coverPageMiddleware = async (req, res, next) => {
  try { await runCoverPageUpload(req, res); next(); }
  catch (err) { res.status(400).json({ message: err.message || "Upload failed" }); }
};
const questionImageMiddleware = async (req, res, next) => {
  try { await runQuestionImageUpload(req, res); next(); }
  catch (err) { res.status(400).json({ message: err.message || "Upload failed" }); }
};
const questionDocMiddleware = async (req, res, next) => {
  try { await runQuestionDocUpload(req, res); next(); }
  catch (err) { res.status(400).json({ message: err.message || "Upload failed" }); }
};

/* =========================================================================
   HEALTH CHECK
========================================================================= */
router.get("/health", (req, res) => {
  res.json({ success: true, message: "E-Assessment API Running", timestamp: new Date() });
});

/* =========================================================================
   STANDALONE EXAM LOGIN — deliberately NOT behind `protect`.
   Lets a student reach /take-assessment/:id without ever going through
   the normal student-portal login, using their username + the exam
   password set on this specific assessment (see AdminEAssessments →
   Create/Edit Assessment → "Exam Password").
========================================================================= */
router.post("/exam-login", examLoginConcurrencyGuard, examLogin);

/* =========================================================================
   SUPPORT DATA
========================================================================= */
router.get("/classes", protect, getClasses);
router.get("/subjects", protect, getSubjects);
router.get("/teachers", protect, requirePage("E-Assessments"), getTeachers);

/* =========================================================================
   ADMIN — ASSESSMENT MANAGEMENT
========================================================================= */
router.post("/admin/assign-teacher", protect, requirePage("E-Assessments"), assignTeacher);
router.get("/admin/assigned-teachers", protect, requirePage("E-Assessments"), getAssignedTeachers);
router.get("/admin/pending", protect, requirePage("E-Assessments"), getPendingAssessments);
router.put("/admin/:id/review", protect, requirePage("E-Assessments"), reviewAssessment);
router.put("/admin/:id/toggle-active", protect, requirePage("E-Assessments"), toggleEAssessmentActive);
router.get("/admin/:id/quick-stats", protect, requirePage("E-Assessments"), getEAssessmentQuickStats);
router.delete("/admin/delete-assessments", protect, requirePage("E-Assessments"), deleteAssessments);
router.delete("/admin/delete-assignments", protect, requirePage("E-Assessments"), deleteAssignments);

/* =========================================================================
   ADMIN — SUBMISSIONS / ASSIGNMENT
========================================================================= */
router.get("/submissions", protect, requirePage("E-Assessments"), getAllSubmissions);
router.post("/admin/assign-submission", protect, requirePage("E-Assessments"), assignSubmission);
router.post("/admin/bulk-assign-submissions", protect, requirePage("E-Assessments"), bulkAssignSubmissions);

/* =========================================================================
   ADMIN — REMARK REQUESTS
========================================================================= */
router.get("/admin/remark-requests", protect, requirePage("E-Assessments"), getRemarkRequests);
router.put("/admin/remark-requests/:id/review", protect, requirePage("E-Assessments"), reviewRemarkRequest);

/* =========================================================================
   ADMIN — RELEASE MARKS
========================================================================= */
router.get("/admin/released-marks", protect, requirePage("E-Assessments"), getReleasedMarks);
router.put("/admin/release-marks", protect, requirePage("E-Assessments"), releaseMarks);
router.put("/admin/bulk-release-marks", protect, requirePage("E-Assessments"), bulkReleaseMarks);

/* =========================================================================
   ADMIN — EXAM SESSION / DEVICE-LOCK MANAGEMENT
========================================================================= */
router.get("/admin/exam-sessions", protect, requirePage("E-Assessments"), getExamSessions);
router.put("/admin/exam-sessions/:id/unlock", protect, requirePage("E-Assessments"), unlockExamSession);

/* =========================================================================
   STUDENT
========================================================================= */
router.post("/submit", protect, authorize("student"), submitEAssessment);
router.get("/results/:assessmentId", protect, authorize("student"), getStudentResult);

/* exam session lifecycle (single-device token binding) */
router.post("/:id/start-exam", protect, authorize("student"), startExamSession);
router.post("/exam-session/activate", protect, authorize("student"), activateExamSession);
router.post("/exam-session/heartbeat", protect, authorize("student"), heartbeatExamSession);
router.post("/exam-session/end", protect, authorize("student"), endExamSession);

/* =========================================================================
   TEACHER / MARKING
========================================================================= */
router.get("/submissions/:assessmentId", protect, authorize("teacher"), getAssessmentSubmissions);
router.get("/marking/next", protect, authorize("teacher"), getNextSubmissionForMarking);
router.get("/marking/all/:id", protect, authorize("teacher"), getAllSubmissionsForMarking);
router.get("/marking/submission/:id", protect, authorize("teacher"), getSubmissionForMarking);
router.get("/marking/:id", protect, authorize("teacher"), getSubmissionForMarking);
router.post("/save-marking", protect, authorize("teacher"), saveMarking);
router.post("/save-marking/bulk", protect, authorize("teacher"), saveMarkingBulk);

/* student requests a remark on their own submission */
router.post("/submissions/:id/request-remark", protect, authorize("student"), requestRemark);

/* =========================================================================
   CORE ASSESSMENT ROUTES
========================================================================= */
router.get("/", protect, getEAssessments);
router.post("/", protect, authorize("teacher"), createEAssessment);
router.put("/:id", protect, authorize("teacher"), updateEAssessment);
router.post("/:id/questions", protect, authorize("teacher"), addEAssessmentQuestion);
router.get("/:id/questions", protect, getAssessmentQuestions);
router.put("/questions/:questionId", protect, authorize("teacher"), updateQuestion);
router.delete("/questions/:questionId", protect, authorize("teacher"), deleteQuestion);

/* =========================================================================
   COVER PAGE — per-exam PDF, shown to students before they start
========================================================================= */
router.post("/:id/cover-page", protect, authorize("teacher"), coverPageMiddleware, uploadCoverPage);
router.delete("/:id/cover-page", protect, authorize("teacher"), deleteCoverPage);

/* =========================================================================
   QUESTIONS FROM A WORD DOCUMENT — parse-then-review-then-bulk-save
========================================================================= */
router.post("/:id/questions/import-docx", protect, authorize("teacher"), questionDocMiddleware, parseQuestionsDocx);
router.post("/:id/questions/bulk", protect, authorize("teacher"), bulkAddQuestions);

/* =========================================================================
   QUESTION IMAGES — diagrams/photos attached to a single question
========================================================================= */
router.post("/questions/:questionId/images", protect, authorize("teacher"), questionImageMiddleware, uploadQuestionImages);
router.delete("/questions/:questionId/images/:imageId", protect, authorize("teacher"), deleteQuestionImage);

/* =========================================================================
   IMPORTANT: keep /:id LAST — it will otherwise swallow the named routes above
========================================================================= */
router.get("/:id", protect, getEAssessmentById);

/* =========================================================================
   ROUTE-LEVEL ERROR HANDLER
========================================================================= */
router.use((err, req, res, next) => {
  console.error("E-ASSESSMENT ROUTE ERROR:", err);
  res.status(500).json({ success: false, message: err.message || "Server Error" });
});

module.exports = router;