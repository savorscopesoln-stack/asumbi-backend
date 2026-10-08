const { makeCalibrationService, CalibrationError } = require("../services/aiMarkingCalibration.service");
const { describeError } = require("../utils/safeLog");
const { createSqlCalibrationStore } = require("../services/aiMarkingCalibration.store");

/* =========================================================================
   AI MARKING — CALIBRATION ENDPOINTS (Phase 9)

   GET /api/e-assessments/ai-marking/scheme/calibration?assessmentId=
   GET /api/e-assessments/ai-marking/scheme/calibration/question?assessmentId=&questionId=

   Behind protect + authorize("teacher") (see routes/aiMarkingTeacher.js).
   Tenant = req.pool. Teacher id = req.user.id only. Read-only; not gated on
   AI_MARKING_JOBS_ENABLED. Unexpected errors are logged by code/message only
   and reported generically.
========================================================================= */

function teacherIdOf(req) {
  const id = Number(req.user?.id);
  if (!Number.isInteger(id) || id < 1) throw new CalibrationError(401, "UNAUTHENTICATED", "Not authenticated");
  return id;
}

function makeCalibrationController({ storeFactory = createSqlCalibrationStore } = {}) {
  const handle = (fallback, fn) => async (req, res) => {
    try {
      const teacherId = teacherIdOf(req);
      const out = await fn({ svc: makeCalibrationService({ store: storeFactory(req.pool) }), teacherId, req });
      res.json({ success: true, ...out });
    } catch (err) {
      if (err instanceof CalibrationError) return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
      console.error("AI MARKING CALIBRATION ERROR:", describeError(err));
      return res.status(500).json({ success: false, message: fallback });
    }
  };
  return {
    assessmentReport: handle("Server error loading the calibration report", ({ svc, teacherId, req }) => svc.assessmentReport({ teacherId, assessmentId: req.query.assessmentId })),
    questionReport: handle("Server error loading the calibration report", ({ svc, teacherId, req }) => svc.questionReport({ teacherId, assessmentId: req.query.assessmentId, questionId: req.query.questionId })),
  };
}

module.exports = { makeCalibrationController, ...makeCalibrationController() };
