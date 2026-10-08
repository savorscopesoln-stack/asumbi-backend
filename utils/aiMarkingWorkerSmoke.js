/* =========================================================================
   AI MARKING WORKER — SQL SMOKE CHECK

   The worker's T-SQL (services/aiMarkingWorker.store.js) has never been run
   by the people who wrote it: there was no SQL Server available. A typo in a
   table or column name would make EVERY answer error out. This runs each
   store method once against an id that cannot exist (-1), so:
     - SQL Server must PARSE and BIND every statement (table/column names,
       OUTPUT / CTE / DATEADD syntax, parameter types) -> typos surface here;
     - every UPDATE matches zero rows -> nothing is changed, so it is safe
       to run on a live database;
     - every SELECT is bounded by that id (or is a cheap aggregate).
   It does NOT prove locking behaviour, READPAST under concurrency, or that
   the queries do the right thing on real rows — see tests/README.md.

   Run:  node scripts/verifyAiMarkingWorkerSql.js [tenantKey]
========================================================================= */

const GHOST = -1;
const row = { status: "failed", model: "smoke", prompt_version: "smoke", criteria_json: null, suggested_total: null, review_flags: "[]", token_usage_json: "{}", processing_cost: null, last_error: "smoke", reused_from_evaluation_id: null };
const spend = { error: "smoke", tokenUsageJson: "{}", cost: null };

/** [label, (store) => Promise] — order irrelevant; each is independent. */
const STORE_CALLS = [
  ["listActiveJobs", (s) => s.listActiveJobs()],
  ["leaseJob", (s) => s.leaseJob(GHOST, "smoke", 1000, { model: "m", provider: "p" })],
  ["renewLease", (s) => s.renewLease(GHOST, "smoke", 1000)],
  ["releaseLease", (s) => s.releaseLease(GHOST, "smoke")],
  ["getJobState", (s) => s.getJobState(GHOST)],
  ["pauseJob", (s) => s.pauseJob(GHOST, 1000, "smoke")],
  ["recordJobError", (s) => s.recordJobError(GHOST, "smoke")],
  ["markJobHealthy", (s) => s.markJobHealthy(GHOST)],
  ["claimEvaluations", (s) => s.claimEvaluations(GHOST, 1, 1000)],
  ["countOpen", (s) => s.countOpen(GHOST)],
  ["loadWorkItem", (s) => s.loadWorkItem(GHOST)],
  ["findReusable", (s) => s.findReusable({ id: GHOST, questionId: GHOST, answerHash: "0".repeat(64), schemeVersionId: GHOST, maxMarks: 1 }, { promptVersion: "smoke", model: "smoke" })],
  ["recordResult (guarded)", (s) => s.recordResult(GHOST, row, { guarded: true })],
  ["recordResult (unguarded)", (s) => s.recordResult(GHOST, row, { guarded: false })],
  ["scheduleRetry", (s) => s.scheduleRetry(GHOST, 1000, spend)],
  ["releaseClaim", (s) => s.releaseClaim(GHOST, { ...spend, keepAttempt: true })],
  ["cancelEvaluation", (s) => s.cancelEvaluation(GHOST, "smoke", spend)],
  ["addLateSpend", (s) => s.addLateSpend(GHOST, { cost: 0 })],
  ["measureThroughput", (s) => s.measureThroughput()],
  ["countQueued", (s) => s.countQueued()],
];

/** Run every call; never throws. Returns { ok, results:[{label, ok, error?}] }. */
async function runStoreSmoke(store) {
  const results = [];
  for (const [label, fn] of STORE_CALLS) {
    try { await fn(store); results.push({ label, ok: true }); }
    catch (err) { results.push({ label, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

/* The Phase 7 review store, same idea: ghost ids, so every statement is parsed and bound but matches nothing.
   (applyApproval / applyDecision open a transaction, find no row to claim, and roll back.) */
const REVIEW_CALLS = [
  ["listQueue", (s) => s.listQueue({ teacherId: GHOST, view: "awaiting", limit: 1 })],
  ["getForReview", (s) => s.getForReview({ evaluationId: GHOST, teacherId: GHOST })],
  ["getAdjustments", (s) => s.getAdjustments(GHOST)],
  ["countSchemeFlags", (s) => s.countSchemeFlags(GHOST, GHOST)],
  ["applyApproval", (s) => s.applyApproval({ evaluationId: GHOST, teacherId: GHOST, actorRole: "smoke", finalMark: 0, state: "approved", action: "accept", remark: null, reason: null, beforeJson: "{}", afterJson: "{}", answerId: GHOST, submissionId: GHOST, expectedHash: "0".repeat(64) })],
  ["applyDecision (reject)", (s) => s.applyDecision({ evaluationId: GHOST, teacherId: GHOST, actorRole: "smoke", action: "reject", reason: "smoke" })],
  ["applyDecision (request_reevaluation)", (s) => s.applyDecision({ evaluationId: GHOST, teacherId: GHOST, actorRole: "smoke", action: "request_reevaluation", reason: "smoke" })],
  ["applyDecision (flag_scheme)", (s) => s.applyDecision({ evaluationId: GHOST, teacherId: GHOST, actorRole: "smoke", action: "flag_scheme", reason: "smoke" })],
];

async function runReviewStoreSmoke(store) {
  const results = [];
  for (const [label, fn] of REVIEW_CALLS) {
    try { await fn(store); results.push({ label, ok: true }); }
    catch (err) { results.push({ label, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

/* The Phase 8 scheme store, same idea. Every call uses ghost ids, so each statement is parsed and bound but matches
   nothing: reads return nothing, createDraft/approve find no row to lock, update/discard touch zero rows. */
const SCHEME_CALLS = [
  ["getQuestion", (s) => s.getQuestion({ teacherId: GHOST, questionId: GHOST })],
  ["listVersions", (s) => s.listVersions(GHOST)],
  ["getVersion", (s) => s.getVersion({ teacherId: GHOST, versionId: GHOST })],
  ["listAssessmentQuestions", (s) => s.listAssessmentQuestions({ teacherId: GHOST, assessmentId: GHOST })],
  ["countPinnedInFlight", (s) => s.countPinnedInFlight(GHOST)],
  ["updateDraft", (s) => s.updateDraft({ versionId: GHOST, criteriaJson: "[]", maxMarks: 1, guideHash: "0".repeat(64), changeNote: null })],
  ["discardDraft", (s) => s.discardDraft(GHOST)],
  ["approveVersion", (s) => s.approveVersion({ versionId: GHOST, approvedBy: GHOST, approvalNotes: "{}" })],
];

async function runSchemeStoreSmoke(store) {
  const results = [];
  for (const [label, fn] of SCHEME_CALLS) {
    try { await fn(store); results.push({ label, ok: true }); }
    catch (err) { results.push({ label, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

/* The Phase 9 calibration store: two read-only SELECTs, ghost ids, so each is parsed and bound and matches nothing. */
const CALIBRATION_CALLS = [
  ["getAgreementRows", (s) => s.getAgreementRows({ teacherId: GHOST, assessmentId: GHOST })],
  ["getAgreementRows (one question)", (s) => s.getAgreementRows({ teacherId: GHOST, assessmentId: GHOST, questionId: GHOST })],
  ["listQuestions", (s) => s.listQuestions({ teacherId: GHOST, assessmentId: GHOST })],
];

async function runCalibrationStoreSmoke(store) {
  const results = [];
  for (const [label, fn] of CALIBRATION_CALLS) {
    try { await fn(store); results.push({ label, ok: true }); }
    catch (err) { results.push({ label, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

/* The Phase 10 analytics stores: read-only; a 1900 period and ghost ids so every statement is parsed and bound but matches nothing. */
const GHOST_RANGE = { from: new Date("1900-01-01T00:00:00Z"), toExclusive: new Date("1900-01-02T00:00:00Z") };
const ANALYTICS_CALLS = [
  ["position (teacher)", (s) => s.operational.position({ kind: "teacher", teacherId: GHOST })],
  ["position (institution)", (s) => s.operational.position({ kind: "institution" }, { assessmentId: 2147483646 })],
  ["activity", (s) => s.operational.activity({ kind: "institution" }, GHOST_RANGE)],
  ["agreementRows", (s) => s.operational.agreementRows({ kind: "teacher", teacherId: GHOST }, GHOST_RANGE)],
  ["criteriaRows", (s) => s.operational.criteriaRows({ kind: "institution" }, GHOST_RANGE)],
  ["questionTexts", (s) => s.operational.questionTexts([GHOST])],
  ["byTeacher", (s) => s.operational.byTeacher(GHOST_RANGE)],
  ["charges", (s) => s.operational.charges({ kind: "institution" }, GHOST_RANGE)],
  ["charges (per teacher)", (s) => s.operational.charges({ kind: "institution" }, GHOST_RANGE, { perTeacher: true })],
  ["economics.costRows", (s) => s.economics.costRows(GHOST_RANGE)],
  ["economics.reconciliation", (s) => s.economics.reconciliation(GHOST_RANGE)],
];

async function runAnalyticsStoreSmoke(store) {
  const results = [];
  for (const [label, fn] of ANALYTICS_CALLS) {
    try { await fn(store); results.push({ label, ok: true }); }
    catch (err) { results.push({ label, ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { runStoreSmoke, runReviewStoreSmoke, runSchemeStoreSmoke, runCalibrationStoreSmoke, runAnalyticsStoreSmoke, STORE_CALLS, REVIEW_CALLS, SCHEME_CALLS, CALIBRATION_CALLS, ANALYTICS_CALLS, GHOST };
