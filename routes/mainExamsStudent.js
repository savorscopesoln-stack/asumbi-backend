const express = require("express");
const router = express.Router();

const { getMyExamDashboard, getMyTimetable } = require("../controllers/mainExamStudent.controller");
const { protect, authorize } = require("../middleware/authMiddleware");

/* =========================================================================
   STUDENT-FACING MAIN EXAMINATION ROUTES (§39-§40, Phase 14)
   Separate router/file from routes/mainExams.js on purpose: that router
   is gated with `requirePage("E-Assessments")`, which students don't
   have — the same `protect, authorize("student")` pattern already used
   for every other student-facing e-assessment route in
   routes/eAssessments.js (submit, start-exam, results, etc.).
========================================================================= */
router.use(protect, authorize("student"));

router.get("/dashboard", getMyExamDashboard);
router.get("/:mainExamId/timetable", getMyTimetable);

module.exports = router;
