const express = require("express");
const router = express.Router();

const {
  createSyncDevice, getSyncDevices, revokeSyncDevice, getSyncLogs,
  pullPackage, pushResults, getMyAssessments,
} = require("../controllers/syncController");

const { protect, requirePage } = require("../middleware/authMiddleware");
const { authenticateSyncDevice } = require("../middleware/syncDeviceAuth");

/* ===== Admin/teacher-facing device management (normal JWT auth) ===== */
router.post("/devices", protect, requirePage("E-Assessments"), createSyncDevice);
router.get("/devices", protect, requirePage("E-Assessments"), getSyncDevices);
router.put("/devices/:id/revoke", protect, requirePage("E-Assessments"), revokeSyncDevice);
router.get("/logs", protect, requirePage("E-Assessments"), getSyncLogs);

/* ===== Local-server-facing endpoints (sync-token auth, no JWT) ===== */
router.get("/my-assessments", authenticateSyncDevice, getMyAssessments);
router.get("/pull/:assessmentId", authenticateSyncDevice, pullPackage);
router.post("/push", authenticateSyncDevice, pushResults);

module.exports = router;
