const express = require("express");
const router = express.Router();

const {
  // core
  createEAssessment, updateEAssessment, getEAssessments, getEAssessmentById,
  addEAssessmentQuestion, getAssessmentQuestions, updateQuestion, deleteQuestion,

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

const { protect, authorize } = require("../middleware/authMiddleware");

/* =========================================================================
   HEALTH CHECK
========================================================================= */
router.get("/health", (req, res) => {
  res.json({ success: true, message: "E-Assessment API Running", timestamp: new Date() });
});

/* =========================================================================
   SUPPORT DATA
========================================================================= */
router.get("/classes", protect, getClasses);
router.get("/subjects", protect, getSubjects);
router.get("/teachers", protect, authorize("admin"), getTeachers);

/* =========================================================================
   ADMIN — ASSESSMENT MANAGEMENT
========================================================================= */
router.post("/admin/assign-teacher", protect, authorize("admin"), assignTeacher);
router.get("/admin/assigned-teachers", protect, authorize("admin"), getAssignedTeachers);
router.get("/admin/pending", protect, authorize("admin"), getPendingAssessments);
router.put("/admin/:id/review", protect, authorize("admin"), reviewAssessment);
router.put("/admin/:id/toggle-active", protect, authorize("admin"), toggleEAssessmentActive);
router.get("/admin/:id/quick-stats", protect, authorize("admin"), getEAssessmentQuickStats);
router.delete("/admin/delete-assessments", protect, authorize("admin"), deleteAssessments);
router.delete("/admin/delete-assignments", protect, authorize("admin"), deleteAssignments);

/* =========================================================================
   ADMIN — SUBMISSIONS / ASSIGNMENT
========================================================================= */
router.get("/submissions", protect, authorize("admin"), getAllSubmissions);
router.post("/admin/assign-submission", protect, authorize("admin"), assignSubmission);
router.post("/admin/bulk-assign-submissions", protect, authorize("admin"), bulkAssignSubmissions);

/* =========================================================================
   ADMIN — REMARK REQUESTS
========================================================================= */
router.get("/admin/remark-requests", protect, authorize("admin"), getRemarkRequests);
router.put("/admin/remark-requests/:id/review", protect, authorize("admin"), reviewRemarkRequest);

/* =========================================================================
   ADMIN — RELEASE MARKS
========================================================================= */
router.get("/admin/released-marks", protect, authorize("admin"), getReleasedMarks);
router.put("/admin/release-marks", protect, authorize("admin"), releaseMarks);
router.put("/admin/bulk-release-marks", protect, authorize("admin"), bulkReleaseMarks);

/* =========================================================================
   ADMIN — EXAM SESSION / DEVICE-LOCK MANAGEMENT
========================================================================= */
router.get("/admin/exam-sessions", protect, authorize("admin"), getExamSessions);
router.put("/admin/exam-sessions/:id/unlock", protect, authorize("admin"), unlockExamSession);

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