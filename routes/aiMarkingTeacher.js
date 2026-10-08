const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const c = require("../controllers/aiMarkingTeacher.controller");
const r = require("../controllers/aiMarkingReview.controller");
const sc = require("../controllers/aiMarkingScheme.controller");
const cal = require("../controllers/aiMarkingCalibration.controller");
const { general, heavy } = require("../middleware/aiMarkingRateLimit");

/* Mount in server.js BEFORE the existing e-assessments router, otherwise a
   generic "/:id" route there can capture "/ai-marking/...":

     app.use("/api/e-assessments/ai-marking", require("./routes/aiMarkingTeacher"));
     app.use("/api/e-assessments", require("./routes/eAssessments"));

   authorize("teacher") follows the repo's convention (admin/module_admin
   bypass is inherent to authorize). An admin has no submission assignments,
   so for them every count is zero rather than a data leak. */
const router = express.Router();
router.use(protect, authorize("teacher"), general);   // Phase 11: per-user request cap; heavy routes add a tighter one below

router.get("/dashboard", c.getDashboard);
router.get("/selectable", heavy, c.getSelectable);
router.post("/preview", heavy, c.previewSelection);

// Phase 4 — money-moving. createJob additionally requires AI_MARKING_JOBS_ENABLED=true.
router.post("/jobs", heavy, c.createJob);
router.get("/jobs", c.listJobs);
router.get("/jobs/:id", c.getJob);
router.post("/jobs/:id/cancel", c.cancelJob);

// Phase 7 — review & approval. Moves no money; the ONLY place an AI suggestion can become a mark
// (and only for a submission assigned to the calling teacher, still unmarked and unreleased).
// Fixed paths first so "/review/:id" cannot swallow them.
router.get("/review/queue", r.getQueue);
router.post("/review/bulk-accept", heavy, r.bulkAccept);
router.get("/review/:id", r.getDetail);
router.post("/review/:id/approve", r.approve);
router.post("/review/:id/reject", r.reject);
router.post("/review/:id/mark-manually", r.markManually);
router.post("/review/:id/flag-scheme", r.flagScheme);
router.post("/review/:id/request-reevaluation", r.requestReevaluation);

// Phase 8 — marking schemes (structured, versioned criteria the AI marks against). Free; moves no money
// and writes no marks. Fixed paths only, so nothing here can be swallowed by a "/:id" route.
router.get("/scheme/readiness", sc.readiness);
router.get("/scheme/question/:questionId", sc.getQuestion);
router.post("/scheme/question/:questionId/draft-from-guide", sc.draftFromGuide);
router.post("/scheme/question/:questionId/validate", sc.validate);
router.post("/scheme/question/:questionId/draft", sc.saveDraft);
router.post("/scheme/question/:questionId/suggest", sc.suggest);
router.post("/scheme/version/:versionId/approve", sc.approve);
router.post("/scheme/version/:versionId/discard", sc.discard);

// Phase 9 — calibration: do teachers end up giving the marks the AI suggested, per scheme version?
// Read-only, aggregate, no student data. Fixed paths only.
router.get("/scheme/calibration", cal.assessmentReport);
router.get("/scheme/calibration/question", cal.questionReport);

module.exports = router;
