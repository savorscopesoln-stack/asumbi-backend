const express = require("express");
const { getMarkingLeaderboard } = require("../controllers/markingLeaderboard.controller");
const { getMyMarkingOption, listMarkingOptions, setMarkingOption } = require("../controllers/markingOption.controller");
const { getReportCardOptions, putReportCardSource } = require("../utils/reportCardSource");
const router = express.Router();

const {
  // core
  createEAssessment, updateEAssessment, getEAssessments, getEAssessmentById,
  addEAssessmentQuestion, getAssessmentQuestions, updateQuestion, deleteQuestion,
  bulkAddQuestions, parseQuestionsDocx,

  // public (no-auth) cover-page preview for the /take-assessment picker
  getPublicAssessmentCovers,

  // cover page (per-exam PDF)
  uploadCoverPage, deleteCoverPage,

  // question images (diagrams/photos)
  uploadQuestionImages, deleteQuestionImage,

  // standalone exam-password login (no portal account session)
  examLogin,
  identifyStudentForExams,

  // exam session / device lock
  startExamSession, activateExamSession, heartbeatExamSession, endExamSession,
  setDesktopOnly, setMusicPaper, setArtPaper, setWritingAids, setModelSheet, getAccessSettings, setAccessSettings, getStudentsActivation, setStudentsActivation, setSecuritySettings, setSebSettings, uploadSebConfig, deleteSebConfig, getSebInfo, downloadSebConfig, getSecuritySettings, getActivityLog,
  getExamSessions, unlockExamSession, unlockExamSessionsBulk, getDeviceAccess, allowDevice, revokeDevice, downloadAttendancePdf, examSessionStatus, lockExamSession,
  autosaveExamAnswers, getExamDraft, grantResit, cancelResit, getUnsubmittedSessions,

  // camera violation photos (evidence capture, no longer a lock trigger)
  uploadViolationPhoto, getViolationPhotos, getStudentExamPhotos,

  // student
  submitEAssessment, getStudentResult,

  // admin review / stats
  getPendingAssessments, reviewAssessment, toggleEAssessmentActive, getEAssessmentQuickStats,
  deleteAssessments, deleteAssignments,

  // support data
  getClasses, getSubjects, getTeachers, assignTeacher, assignTeachersBulk, getAssignedTeachers,

  // submissions / marking
  getAllSubmissions, getAssessmentSubmissions, getSubmissionForMarking, getAllSubmissionsForMarking,
  saveMarking, saveMarkingBulk, assignSubmission, bulkAssignSubmissions, smartDistribute, getAssignmentBatches, undoAssignmentBatch, getNextSubmissionForMarking,
  getMarkingSession, saveMarkingSession, clearMarkingSession,

  // remarks
  requestRemark, getRemarkRequests, reviewRemarkRequest,

  // release
  getReleasedMarks, releaseMarks, bulkReleaseMarks, getReportCardReleaseStatus, releaseReportCardMarks,

  // grading system
  getGradingSystem, updateGradingSystem,
} = require("../controllers/eAssessment.controller");

const { protect, authorize, requirePage } = require("../middleware/authMiddleware");
const { runCoverPageUpload } = require("../middleware/coverPageUpload");
const { runQuestionImageUpload } = require("../middleware/questionImageUpload");
const { runQuestionDocUpload } = require("../middleware/questionDocUpload");
const { examLoginConcurrencyGuard } = require("../middleware/examLoginConcurrencyGuard");
const { enforceDesktopOnly } = require("../utils/deviceRestriction");
const { enforceSeb } = require("../utils/sebRestriction");
// Student exam routes: desktop-only check, then the Safe Exam Browser check.
const enforceExamClient = [enforceDesktopOnly, enforceSeb];
const { activityLogger, preResolveQuestion } = require("../utils/eAssessmentActivityLog");

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
   ACTIVITY LOG — records who did what, when, for every student / teacher /
   admin action in this module (see utils/eAssessmentActivityLog.js for the
   route→action table). Mounted once, first, so it sees every response.
   preResolveQuestion captures a question's exam before a delete removes it.
========================================================================= */
router.use(activityLogger);
router.param("questionId", preResolveQuestion);

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
router.post("/admin/assign-teachers-bulk", protect, requirePage("E-Assessments"), assignTeachersBulk);
router.get("/admin/assigned-teachers", protect, requirePage("E-Assessments"), getAssignedTeachers);
router.get("/admin/pending", protect, requirePage("E-Assessments"), getPendingAssessments);
router.put("/admin/:id/review", protect, requirePage("E-Assessments"), reviewAssessment);
router.put("/admin/:id/toggle-active", protect, requirePage("E-Assessments"), toggleEAssessmentActive);
router.get("/admin/activity-log", protect, requirePage("E-Assessments"), getActivityLog);
router.put("/admin/:id/desktop-only", protect, requirePage("E-Assessments"), setDesktopOnly);
// Music paper switch: admin roles AND the teacher who owns the paper (gate is inside the handler).
router.put("/:id/music-paper", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2", "module_admin"), setMusicPaper);
// Art & Craft paper switch: same roles and gate as the music-paper switch.
router.put("/:id/art-paper", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2", "module_admin"), setArtPaper);
router.put("/:id/writing-aids", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2", "module_admin"), setWritingAids);
router.get("/admin/:id/access", protect, requirePage("E-Assessments"), getAccessSettings);
router.put("/admin/:id/access", protect, requirePage("E-Assessments"), setAccessSettings);
router.get("/admin/students-activation", protect, requirePage("E-Assessments"), getStudentsActivation);
router.put("/admin/students-activation/status", protect, requirePage("E-Assessments"), setStudentsActivation);
router.put("/admin/:id/security", protect, requirePage("E-Assessments"), setSecuritySettings);
router.get("/admin/report-card-release-status", protect, requirePage("E-Assessments"), getReportCardReleaseStatus);
router.put("/admin/report-card-release", protect, requirePage("E-Assessments"), releaseReportCardMarks);
router.get("/admin/report-card-options", protect, requirePage("E-Assessments"), getReportCardOptions);
router.put("/admin/report-card-source", protect, requirePage("E-Assessments"), putReportCardSource);
router.put("/admin/:id/seb", protect, requirePage("E-Assessments"), setSebSettings);
router.put("/admin/:id/seb-config", protect, requirePage("E-Assessments"), uploadSebConfig);
router.delete("/admin/:id/seb-config", protect, requirePage("E-Assessments"), deleteSebConfig);
router.get("/admin/device-access", protect, requirePage("E-Assessments"), getDeviceAccess);
router.put("/admin/device-access/:id/allow", protect, requirePage("E-Assessments"), allowDevice);
router.put("/admin/device-access/:id/revoke", protect, requirePage("E-Assessments"), revokeDevice);
router.get("/admin/:id/quick-stats", protect, requirePage("E-Assessments"), getEAssessmentQuickStats);
router.get("/admin/:id/attendance-pdf", protect, requirePage("E-Assessments"), downloadAttendancePdf);
router.delete("/admin/delete-assessments", protect, requirePage("E-Assessments"), deleteAssessments);
router.delete("/admin/delete-assignments", protect, requirePage("E-Assessments"), deleteAssignments);

/* =========================================================================
   ADMIN — SUBMISSIONS / ASSIGNMENT
========================================================================= */
router.get("/submissions", protect, requirePage("E-Assessments"), getAllSubmissions);
// Manual split marking: choose which teacher marks which questions of one assessment.
const { getSplit, saveSplit, clearSplitRules } = require("../controllers/questionSplit.controller");
router.get("/admin/assessments/:id/split", protect, requirePage("E-Assessments"), getSplit);
router.post("/admin/assessments/:id/split", protect, requirePage("E-Assessments"), saveSplit);
router.delete("/admin/assessments/:id/split", protect, requirePage("E-Assessments"), clearSplitRules);
router.post("/admin/assign-submission", protect, requirePage("E-Assessments"), assignSubmission);
router.post("/admin/bulk-assign-submissions", protect, requirePage("E-Assessments"), bulkAssignSubmissions);
router.post("/admin/smart-distribute", protect, requirePage("E-Assessments"), smartDistribute);
router.get("/admin/assignment-batches", protect, requirePage("E-Assessments"), getAssignmentBatches);
router.post("/admin/assignment-batches/:id/undo", protect, requirePage("E-Assessments"), undoAssignmentBatch);

/* =========================================================================
   ADMIN — REMARK REQUESTS
========================================================================= */
// Marking leaderboard: visible to every teacher as well as admins (everyone sees the same race)
router.get("/marking-leaderboard", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), getMarkingLeaderboard);
// Marking option 1 / 2 per teacher (option 1 is the default)
router.get("/marking-option", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), getMyMarkingOption);
router.get("/admin/marking-options", protect, requirePage("E-Assessments"), listMarkingOptions);
router.put("/admin/marking-options/:teacherId", protect, requirePage("E-Assessments"), setMarkingOption);
router.put("/admin/marking-options", protect, requirePage("E-Assessments"), setMarkingOption);
router.get("/admin/remark-requests", protect, requirePage("E-Assessments"), getRemarkRequests);
router.put("/admin/remark-requests/:id/review", protect, requirePage("E-Assessments"), reviewRemarkRequest);

/* =========================================================================
   ADMIN — RELEASE MARKS
========================================================================= */
router.get("/admin/released-marks", protect, requirePage("E-Assessments"), getReleasedMarks);
router.put("/admin/release-marks", protect, requirePage("E-Assessments"), releaseMarks);
router.put("/admin/bulk-release-marks", protect, requirePage("E-Assessments"), bulkReleaseMarks);

/* =========================================================================
   GRADING SYSTEM
   GET is deliberately just `protect` (any logged-in role) — the
   student, teacher and admin report screens all need to render a
   grade from this, not just the admin who configures it. Only the
   PUT (Admin → E-Assessments → Grading System tab) is gated by
   requirePage("E-Assessments").
========================================================================= */
router.get("/grading-system", protect, getGradingSystem);
router.put("/admin/grading-system", protect, requirePage("E-Assessments"), updateGradingSystem);

/* =========================================================================
   ADMIN — EXAM SESSION / DEVICE-LOCK MANAGEMENT
========================================================================= */
router.get("/admin/exam-sessions", protect, requirePage("E-Assessments"), getExamSessions);
router.get("/admin/exam-sessions/unsubmitted", protect, requirePage("E-Assessments"), getUnsubmittedSessions);
router.put("/admin/exam-sessions/unlock-bulk", protect, requirePage("E-Assessments"), unlockExamSessionsBulk);
router.put("/admin/exam-sessions/:id/unlock", protect, requirePage("E-Assessments"), unlockExamSession);
router.post("/admin/resit", protect, requirePage("E-Assessments"), grantResit);
router.post("/admin/resit/cancel", protect, requirePage("E-Assessments"), cancelResit);

/* =========================================================================
   STUDENT
========================================================================= */
router.post("/submit", protect, authorize("student"), enforceExamClient, submitEAssessment);
router.get("/results/:assessmentId", protect, authorize("student"), getStudentResult);

/* exam session lifecycle (single-device token binding) */
router.post("/:id/start-exam", protect, authorize("student"), enforceExamClient, startExamSession);
router.post("/:id/autosave", protect, authorize("student"), enforceExamClient, autosaveExamAnswers);
router.get("/:id/draft", protect, authorize("student"), enforceExamClient, getExamDraft);
router.get("/:id/security-settings", protect, authorize("student"), getSecuritySettings);
router.post("/exam-session/activate", protect, authorize("student"), enforceExamClient, activateExamSession);
router.post("/exam-session/heartbeat", protect, authorize("student"), enforceExamClient, heartbeatExamSession);
router.post("/exam-session/status", protect, authorize("student"), examSessionStatus);
router.post("/exam-session/lock", protect, authorize("student"), lockExamSession);
router.post("/exam-session/end", protect, authorize("student"), endExamSession);

/* camera violation photos — student uploads (fire-and-forget, evidence
   only, never a lock trigger), admin reviews per session */
router.post("/violation-photo", protect, authorize("student"), uploadViolationPhoto);
router.get("/admin/exam-sessions/:sessionId/violation-photos", protect, requirePage("E-Assessments"), getViolationPhotos);
router.get("/admin/student-photos/:eAssessmentId/:studentId", protect, requirePage("E-Assessments"), getStudentExamPhotos);

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

// Marking-session cache — draft autosave so marking survives a refresh,
// a closed tab, or continuing on a different device (see the controller
// for details). Never touches e_assessment_answers.
router.get("/marking-session/:id", protect, authorize("teacher"), getMarkingSession);
router.put("/marking-session/:id", protect, authorize("teacher"), saveMarkingSession);
router.delete("/marking-session/:id", protect, authorize("teacher"), clearMarkingSession);

/* student requests a remark on their own submission */
router.post("/submissions/:id/request-remark", protect, authorize("student"), requestRemark);

/* =========================================================================
   CORE ASSESSMENT ROUTES
========================================================================= */
// No `protect` — a student hits this before they've logged in at all
// (see the /take-assessment picker's pre-login cover banner). Must
// stay above the "/:id" route below so "/public/covers" isn't parsed
// as an :id.
router.get("/public/covers", getPublicAssessmentCovers);
router.get("/public/:id/seb-info", getSebInfo);
router.get("/public/:id/seb-config", downloadSebConfig);

// Step 1 of the picker. Built for a whole school behind ONE public IP (400+
// students): the limit is per username (stops guessing/hammering one account),
// plus a very high per-IP ceiling that only a flood would reach.
const identifyHits = new Map();
const hit = (key, max, windowMs, now) => {
  const rec = identifyHits.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n += 1;
  identifyHits.set(key, rec);
  return rec.n > max;
};
const identifyLimiter = (req, res, next) => {
  const now = Date.now();
  const u = String(req.body?.username || "").trim().toLowerCase().slice(0, 60);
  if (identifyHits.size > 20000) { for (const [k, v] of identifyHits) if (now > v.reset) identifyHits.delete(k); }
  const tooMany = hit(`u:${u}`, 40, 10 * 60 * 1000, now) || hit(`ip:${req.ip || "x"}`, 6000, 10 * 60 * 1000, now);
  if (tooMany) return res.status(429).json({ success: false, message: "Too many attempts. Please wait a minute and try again." });
  next();
};
router.post("/public/identify", identifyLimiter, identifyStudentForExams);
router.get("/public/:id/seb-info", getSebInfo);
router.get("/public/:id/seb-config", downloadSebConfig);

router.get("/", protect, getEAssessments);
router.post("/", protect, authorize("teacher"), createEAssessment);
router.put("/:id", protect, authorize("teacher"), updateEAssessment);
/* =========================================================================
   QUESTION MANAGEMENT
   Every route below is also reachable by admin/sub_admin/sub_admin_2 (and
   module_admin, via the admin bypass in authorize()) on ANY assessment —
   not just teacher-owned ones — see canManageAssessmentQuestions() in
   eAssessment.controller.js, which every one of these already calls
   internally. The route-level authorize() list has to include the
   sub-admin tiers explicitly (only "admin"/"module_admin" bypass
   automatically); leaving it as authorize("teacher") alone, as it
   originally was, rejected admin/sub_admin requests before that inner
   check ever ran — this is what /admin-e-assessments/:id/questions
   (App.jsx) is supposed to reach.
========================================================================= */
router.post("/:id/questions", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), addEAssessmentQuestion);
router.get("/:id/questions", protect, enforceExamClient, getAssessmentQuestions);
router.put("/questions/:questionId/model-sheet", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2", "module_admin"), setModelSheet);
router.put("/questions/:questionId", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), updateQuestion);
router.delete("/questions/:questionId", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), deleteQuestion);

/* =========================================================================
   COVER PAGE — per-exam PDF, shown to students before they start
========================================================================= */
router.post("/:id/cover-page", protect, authorize("teacher"), coverPageMiddleware, uploadCoverPage);
router.delete("/:id/cover-page", protect, authorize("teacher"), deleteCoverPage);

/* =========================================================================
   QUESTIONS FROM A WORD DOCUMENT — parse-then-review-then-bulk-save
========================================================================= */
router.post("/:id/questions/import-docx", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), questionDocMiddleware, parseQuestionsDocx);
router.post("/:id/questions/bulk", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), bulkAddQuestions);

/* =========================================================================
   QUESTION IMAGES — diagrams/photos attached to a single question
========================================================================= */
router.post("/questions/:questionId/images", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), questionImageMiddleware, uploadQuestionImages);
router.delete("/questions/:questionId/images/:imageId", protect, authorize("teacher", "admin", "sub_admin", "sub_admin_2"), deleteQuestionImage);

/* =========================================================================
   IMPORTANT: keep /:id LAST — it will otherwise swallow the named routes above
========================================================================= */
router.get("/:id", protect, enforceExamClient, getEAssessmentById);

/* =========================================================================
   ROUTE-LEVEL ERROR HANDLER
========================================================================= */
router.use((err, req, res, next) => {
  console.error("E-ASSESSMENT ROUTE ERROR:", err);
  res.status(500).json({ success: false, message: err.message || "Server Error" });
});

module.exports = router;