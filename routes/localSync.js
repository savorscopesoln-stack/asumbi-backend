const express = require("express");
const router = express.Router();

const {
  createSyncDevice, getSyncDevices, revokeSyncDevice, reissueSyncDevice, getSyncLogs,
  pullPackage, pullExamPackage, pushResults, getMyAssessments,
} = require("../controllers/syncController");

const { protect, requirePage } = require("../middleware/authMiddleware");
const { authenticateSyncDevice } = require("../middleware/syncDeviceAuth");

/* ===== Admin/teacher-facing device management (normal JWT auth) ===== */
router.post("/devices", protect, requirePage("E-Assessments"), createSyncDevice);
router.get("/devices", protect, requirePage("E-Assessments"), getSyncDevices);
router.put("/devices/:id/revoke", protect, requirePage("E-Assessments"), revokeSyncDevice);
router.put("/devices/:id/reissue", protect, requirePage("E-Assessments"), reissueSyncDevice);
router.get("/logs", protect, requirePage("E-Assessments"), getSyncLogs);

/* ===== Local-server-facing endpoints (sync-token auth, no JWT) ===== */
router.get("/pull/:assessmentId", authenticateSyncDevice, pullPackage);
// Whole Main Examination in one shot — authorized by the exam_code
// itself rather than the per-assessment scope table (see generateExamCode
// in mainExam.controller.js and pullExamPackage in syncController.js).
router.get("/pull-exam/:examCode", authenticateSyncDevice, pullExamPackage);
router.post("/push", authenticateSyncDevice, pushResults);
// Was missing entirely — the local server's "Check sync token status"
// button (GET /local-sync/my-assessments) had nothing to hit and always
// failed. This is what checkTokenStatus()/GET /sync/status depend on.
router.get("/my-assessments", authenticateSyncDevice, getMyAssessments);

module.exports = router;
