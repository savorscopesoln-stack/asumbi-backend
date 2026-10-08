const review = require("../services/aiMarkingReview.service");
const { describeError } = require("../utils/safeLog");
const { createSqlReviewStore } = require("../services/aiMarkingReview.store");

/* =========================================================================
   AI MARKING — REVIEW ENDPOINTS (Phase 7)

   Mounted with the rest of the teacher API (routes/aiMarkingTeacher.js) at
   /api/e-assessments/ai-marking/review, behind protect + authorize("teacher").

   - Pool = req.pool (the authenticated request's own tenant database).
   - Teacher id = req.user.id. NEVER read from the body, query or URL: a teacher
     cannot review, approve or reject on behalf of anyone else.
   - Body fields are picked by name below; anything else is ignored.
   - Nothing here is gated on AI_MARKING_JOBS_ENABLED: reviewing results that
     already exist moves no money, and must keep working if job creation is
     later switched off.
   - Errors: ReviewError carries a safe, deliberate message and code; anything
     else is logged server-side and reported generically (never SQL text, never
     student content).
========================================================================= */

function teacherIdOf(req) {
  const id = Number(req.user?.id);
  if (!Number.isInteger(id) || id < 1) { const e = new review.ReviewError(401, "UNAUTHENTICATED", "Not authenticated"); throw e; }
  return id;
}

function sendError(res, err, fallback) {
  if (err instanceof review.ReviewError) {
    const body = { success: false, message: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }
  console.error("AI MARKING REVIEW ERROR:", describeError(err));
  return res.status(500).json({ success: false, message: fallback });
}

function makeReviewController({ storeFactory = createSqlReviewStore } = {}) {
  const handle = (fallback, fn) => async (req, res) => {
    try {
      const teacherId = teacherIdOf(req);
      const out = await fn({ req, store: storeFactory(req.pool), teacherId, role: req.user?.role || null });
      res.json({ success: true, ...out });
    } catch (err) { sendError(res, err, fallback); }
  };
  const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  return {
    /** GET /review/queue?view=awaiting|attention|failed&assessmentId=&questionId=&after=&limit= */
    getQueue: handle("Server error loading the review queue", ({ req, store, teacherId }) =>
      review.listQueue(store, { teacherId, view: req.query.view || "awaiting", assessmentId: req.query.assessmentId, questionId: req.query.questionId, afterId: req.query.after, limit: req.query.limit })),

    /** GET /review/:id */
    getDetail: handle("Server error loading this evaluation", async ({ req, store, teacherId }) =>
      ({ review: await review.getDetail(store, { teacherId, evaluationId: req.params.id }) })),

    /** POST /review/:id/approve  { mode: "accept"|"adjust", criteriaMarks?, finalMark?, remark?, reason? } */
    approve: handle("Server error saving the mark", async ({ req, store, teacherId, role }) => {
      const b = body(req);
      return review.approve(store, { teacherId, role, evaluationId: req.params.id, mode: b.mode, criteriaMarks: b.criteriaMarks, finalMark: b.finalMark, remark: b.remark, reason: b.reason });
    }),

    /** POST /review/bulk-accept  { evaluationIds: [..] } */
    bulkAccept: handle("Server error accepting the selected suggestions", ({ req, store, teacherId, role }) =>
      review.bulkAccept(store, { teacherId, role, evaluationIds: body(req).evaluationIds })),

    /** POST /review/:id/reject  { reason } */
    reject: handle("Server error rejecting the suggestion", ({ req, store, teacherId, role }) =>
      review.reject(store, { teacherId, role, evaluationId: req.params.id, reason: body(req).reason })),

    /** POST /review/:id/mark-manually  { reason? } */
    markManually: handle("Server error", ({ req, store, teacherId, role }) =>
      review.markManually(store, { teacherId, role, evaluationId: req.params.id, reason: body(req).reason })),

    /** POST /review/:id/flag-scheme  { reason } */
    flagScheme: handle("Server error recording the flag", ({ req, store, teacherId, role }) =>
      review.flagScheme(store, { teacherId, role, evaluationId: req.params.id, reason: body(req).reason })),

    /** POST /review/:id/request-reevaluation  { reason } */
    requestReevaluation: handle("Server error requesting a new evaluation", ({ req, store, teacherId, role }) =>
      review.requestReevaluation(store, { teacherId, role, evaluationId: req.params.id, reason: body(req).reason })),
  };
}

module.exports = { makeReviewController, ...makeReviewController() };
