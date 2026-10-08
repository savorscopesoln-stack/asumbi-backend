const { makeSchemeService, SchemeError } = require("../services/aiMarkingScheme.service");
const { describeError } = require("../utils/safeLog");
const { createSqlSchemeStore } = require("../services/aiMarkingScheme.store");
const { suggestSchemeImprovements } = require("../services/aiMarkingScheme.suggest");
const { resolveConfig } = require("../services/aiMarkingEngine.config");
const { createProvider } = require("../services/aiMarkingEngine.providers");

/* =========================================================================
   AI MARKING — SCHEME ENDPOINTS (Phase 8)

   Mounted with the rest of the teacher API at
   /api/e-assessments/ai-marking/scheme, behind protect + authorize("teacher").
   - Tenant = req.pool. Teacher id = req.user.id only (never body/query/URL).
   - Body fields are picked by name; anything else is ignored.
   - Nothing here is gated on AI_MARKING_JOBS_ENABLED: schemes cost nothing and
     writing them must work before job creation is ever switched on.
   - Suggestions are off unless AI_MARKING_SCHEME_SUGGESTIONS=on AND the engine
     is configured; then they use the server's provider credentials.
   - Errors: SchemeError carries a safe message and code; anything else is logged
     (code and message only) and reported generically.
========================================================================= */

function teacherIdOf(req) {
  const id = Number(req.user?.id);
  if (!Number.isInteger(id) || id < 1) throw new SchemeError(401, "UNAUTHENTICATED", "Not authenticated");
  return id;
}
function sendError(res, err, fallback) {
  if (err instanceof SchemeError) {
    const body = { success: false, message: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }
  console.error("AI MARKING SCHEME ERROR:", describeError(err));
  return res.status(500).json({ success: false, message: fallback });
}

function makeSchemeController({ storeFactory = createSqlSchemeStore, env = process.env, providerFactory = createProvider } = {}) {
  const build = (req) => {
    let extra = {};
    if (String(env.AI_MARKING_SCHEME_SUGGESTIONS || "").toLowerCase() === "on") {
      const config = resolveConfig(env);
      if (config.configured) extra = { suggest: suggestSchemeImprovements, config, provider: providerFactory(config) };
    }
    return makeSchemeService({ store: storeFactory(req.pool), ...extra });
  };
  const handle = (fallback, fn) => async (req, res) => {
    try {
      const teacherId = teacherIdOf(req);
      const out = await fn({ svc: build(req), teacherId, body: req.body && typeof req.body === "object" ? req.body : {}, req });
      res.json({ success: true, ...out });
    } catch (err) { sendError(res, err, fallback); }
  };
  return {
    /** GET /scheme/readiness?assessmentId= */
    readiness: handle("Server error loading scheme readiness", ({ svc, teacherId, req }) => svc.readiness({ teacherId, assessmentId: req.query.assessmentId })),
    /** GET /scheme/question/:questionId */
    getQuestion: handle("Server error loading the scheme", async ({ svc, teacherId, req }) => ({ state: await svc.questionState({ teacherId, questionId: req.params.questionId }) })),
    /** POST /scheme/question/:questionId/draft-from-guide — saves nothing */
    draftFromGuide: handle("Server error drafting from the guide", ({ svc, teacherId, req }) => svc.draftFromGuide({ teacherId, questionId: req.params.questionId })),
    /** POST /scheme/question/:questionId/validate  { criteria } — saves nothing */
    validate: handle("Server error checking the scheme", ({ svc, teacherId, req, body }) => svc.validate({ teacherId, questionId: req.params.questionId, criteria: body.criteria })),
    /** POST /scheme/question/:questionId/draft  { criteria, draftId?, changeNote? } */
    saveDraft: handle("Server error saving the draft", ({ svc, teacherId, req, body }) => svc.saveDraft({ teacherId, questionId: req.params.questionId, criteria: body.criteria, draftId: body.draftId ?? null, changeNote: body.changeNote })),
    /** POST /scheme/question/:questionId/suggest  { criteria } — advice only */
    suggest: handle("Server error getting suggestions", ({ svc, teacherId, req, body }) => svc.suggest({ teacherId, questionId: req.params.questionId, criteria: body.criteria })),
    /** POST /scheme/version/:versionId/approve  { acknowledge:[codes] } */
    approve: handle("Server error approving the scheme", ({ svc, teacherId, req, body }) => svc.approve({ teacherId, versionId: req.params.versionId, acknowledge: body.acknowledge })),
    /** POST /scheme/version/:versionId/discard — drafts only */
    discard: handle("Server error discarding the draft", ({ svc, teacherId, req }) => svc.discardDraft({ teacherId, versionId: req.params.versionId })),
  };
}

module.exports = { makeSchemeController, ...makeSchemeController() };
