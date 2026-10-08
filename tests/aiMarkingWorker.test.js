/* =========================================================================
   AI MARKING WORKER — Phase 6 tests (no database, no network)

   The REAL worker and the REAL Phase 5 engine run against an in-memory store
   (tests/helpers/memoryWorkerStore.js) and a scripted provider, on a fake
   clock. Proven: worker logic given a store that honours the contract.
   NOT proven: the T-SQL in aiMarkingWorker.store.js, real lock/READPAST
   behaviour, or the live provider — see tests/README.md "Phase 6 checklist".
   The static tests at the bottom pin the SQL's most important guarantees.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { createMemoryWorkerStore, createFakeClock } = require("./helpers/memoryWorkerStore");
const { resolveConfig } = require("../services/aiMarkingEngine.config");
const { ProviderError } = require("../services/aiMarkingEngine.providers");
const prompt = require("../services/aiMarkingEngine.prompt");
const L = require("../services/aiMarkingWorker.limits");
const W = require("../services/aiMarkingWorker.service");
const { startAiMarkingWorker } = require("../services/aiMarkingWorker.runner");
const { runStoreSmoke, STORE_CALLS } = require("../utils/aiMarkingWorkerSmoke");
const { createSqlWorkerStore } = require("../services/aiMarkingWorker.store");
const { presentJob } = require("../services/aiMarkingJobs.service");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");

suite("aiMarkingWorker.test.js");

/* ------------------------------ fixtures ------------------------------ */
const ENV = { AI_MARKING_PROVIDER: "mock", AI_MARKING_MODEL: "test-model", AI_MARKING_COST_INPUT_PER_MTOK: "3", AI_MARKING_COST_OUTPUT_PER_MTOK: "15", AI_MARKING_COST_CURRENCY: "usd" };
const CRITERIA = [
  { criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, expectedPoints: ["light energy converted to chemical energy", "occurs in chloroplasts"], acceptableAlternatives: [] },
  { criterionId: "c2", label: "States the products", maxMarks: 3, expectedPoints: ["glucose", "oxygen"] },
];
const answerText = (n) => `<p>Photosynthesis is how plants convert light energy into chemical energy in the chloroplasts. It produces glucose and oxygen. Note ${n}.</p>`;
const goodReply = () => JSON.stringify({
  criteria: [
    { criterionId: "c1", marksAwarded: 2, evidence: ["convert light energy into chemical energy in the chloroplasts"], matchedPoints: [0, 1], explanation: "Defines it correctly." },
    { criterionId: "c2", marksAwarded: 3, evidence: ["It produces glucose and oxygen"], matchedPoints: [0, 1], explanation: "Both products named." },
  ],
  missingPoints: [], totalMarks: 5, flags: [], cannotEvaluate: false, cannotEvaluateReason: null,
});
const usage = { inputTokens: 1000, outputTokens: 200 };            // cost = 1000/1e6*3 + 200/1e6*15 = 0.006
const OK_COST = 0.006;
const err = (kind, over = {}) => new ProviderError(kind, `${kind} (fixture)`, over);
const TIMEOUT = () => err("TIMEOUT", { retryable: true });
const UNAVAILABLE = () => err("UNAVAILABLE", { retryable: true, status: 503 });
const AUTH = () => err("AUTH", { systemic: true, status: 401 });
const BAD_REQUEST = () => err("BAD_REQUEST", { systemic: true, status: 400 });

/** A provider driven by a function of (callNumber, request). Returns reply text/object, or throws. */
function scripted(fn) {
  const p = {
    name: "mock", model: "test-model", calls: [],
    async complete(req) {
      p.calls.push(req);
      const r = await fn(p.calls.length, req);
      if (r instanceof Error) throw r;
      return { text: typeof r === "string" ? r : r.text, usage: r.usage || usage, model: "test-model", requestId: "x", truncated: false };
    },
  };
  return p;
}

function harness({ count = 3, cfgEnv = {}, reply = () => goodReply(), jobOver = {}, answerOver = () => ({}), noProvider = false, extraJobs = 0 } = {}) {
  const clock = createFakeClock();
  const store = createMemoryWorkerStore(clock);
  store.addJob({ id: 1, ...jobOver });
  for (let i = 0; i < count; i += 1) store.addAnswer({ jobId: 1, essay: answerText(i + 1), questionMarks: 5, maxMarks: 5, criteria: CRITERIA, ...answerOver(i) });
  const engineConfig = resolveConfig(ENV);
  const cfg = L.resolveWorkerConfig({ AI_MARKING_WORKER_ENABLED: "true", AI_MARKING_RATE_LIMIT_RPM: "6000", ...cfgEnv }, engineConfig);
  const limiter = L.createRateLimiter({ perMinute: cfg.ratePerMinute, clock });
  const breaker = L.createCircuitBreaker({ threshold: cfg.breakerThreshold, cooldownMs: cfg.breakerCooldownMs, clock });
  const provider = scripted(reply);
  const logs = [];
  const log = { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const finals = [];
  const alerts = [];
  // Mirrors the real finalizeJob: on a requested cancel it first cancels every pending answer (never charged),
  // otherwise it refuses while any answer is still pending.
  const finalizeJob = async (id) => {
    const j = store.db.jobs.get(id);
    if (j.cancel_requested) for (const e of store.evalsOf(id)) if (e.status === "pending") Object.assign(e, { status: "cancelled", completed_at: clock.now() });
    if (store.countBy(id, "pending") > 0) throw Object.assign(new Error("still pending"), { code: "JOB_NOT_FINISHED" });
    j.status = j.cancel_requested ? "cancelled" : store.countBy(id, "success") + store.countBy(id, "needs_review") === 0 ? "failed" : "completed";
    finals.push(id);
  };
  const ctx = { store, finalizeJob, alert: (e) => alerts.push(e) };
  const mk = (workerId, over = {}) => W.createAiMarkingWorker({
    cfg, engineConfig, provider: noProvider ? null : provider, limiter, breaker, clock, random: () => 0.5, workerId, log, state: { lastServed: new Map() }, ...over,
  });
  return { clock, store, cfg, engineConfig, limiter, breaker, provider, logs, finals, alerts, ctx, worker: mk("w1"), mk };
}
const statuses = (h, jobId = 1) => h.store.evalsOf(jobId).map((e) => e.status);

/* ------------------------------ config & primitives ------------------------------ */

test("config: off by default; sane defaults; bad numbers are reported and defaulted; job lease always outlasts one batch", () => {
  const d = L.resolveWorkerConfig({}, resolveConfig(ENV));
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.concurrency, 4);
  assert.strictEqual(d.ratePerMinute, 50);
  assert.ok(d.jobLeaseMs >= d.answerLeaseMs, "a healthy worker must not lose its own job mid-batch");
  assert.ok(d.answerLeaseMs >= 2 * 60000, "answer lease covers every format-retry call plus slack");
  const bad = L.resolveWorkerConfig({ AI_MARKING_WORKER_CONCURRENCY: "99", AI_MARKING_RATE_LIMIT_RPM: "abc", AI_MARKING_BACKOFF_BASE_MS: "50000", AI_MARKING_BACKOFF_MAX_MS: "1000" }, resolveConfig(ENV));
  assert.strictEqual(bad.errors.length, 3, "concurrency, rpm, and max < base");
  assert.strictEqual(bad.concurrency, 4);
  assert.ok(bad.backoffMaxMs >= bad.backoffBaseMs);
  assert.strictEqual(L.resolveWorkerConfig({ AI_MARKING_WORKER_ENABLED: "TRUE" }, {}).enabled, true);
});

test("backoff: doubles per attempt, capped, jittered within [half, full], and Retry-After is a floor", () => {
  const o = (random, extra = {}) => ({ baseMs: 5000, maxMs: 60000, random: () => random, ...extra });
  assert.strictEqual(L.backoffDelay(1, o(1)), 5000);
  assert.strictEqual(L.backoffDelay(2, o(1)), 10000);
  assert.strictEqual(L.backoffDelay(3, o(1)), 20000);
  assert.strictEqual(L.backoffDelay(10, o(1)), 60000, "capped at maxMs");
  assert.strictEqual(L.backoffDelay(1, o(0)), 2500, "jitter lower bound is half the ceiling");
  assert.strictEqual(L.backoffDelay(3, o(0)), 10000);
  assert.strictEqual(L.backoffDelay(1, o(0, { retryAfterMs: 90000 })), 90000, "a provider's Retry-After is never undercut");
  assert.ok(L.backoffDelay(500, o(1)) <= 60000, "huge attempt numbers cannot overflow");
});

test("rate limiter: evenly spaced starts, concurrent callers queue fairly, penalize() pushes everyone out", async () => {
  const clock = createFakeClock(0);
  const lim = L.createRateLimiter({ perMinute: 60, clock });          // one start per 1000 ms
  const starts = [];
  await Promise.all([1, 2, 3].map(async () => { await lim.acquire(); starts.push(clock.now()); }));
  assert.deepStrictEqual(starts.slice().sort((a, b) => a - b).map((t, i) => t - starts.slice().sort((a, b) => a - b)[0] >= 0 && i >= 0 ? t : t), starts.slice().sort((a, b) => a - b));
  assert.ok(clock.sleeps.includes(1000) && clock.sleeps.includes(2000), "second and third callers waited 1 s and 2 s");
  lim.penalize(30000);
  const before = clock.now();
  await lim.acquire();
  assert.ok(clock.now() - before >= 29000, "after a 429 nobody calls for the Retry-After period");
});

test("circuit breaker: opens at the threshold, then exactly one probe; success closes, failure reopens; settleProbe cannot wedge it", () => {
  const clock = createFakeClock(0);
  const b = L.createCircuitBreaker({ threshold: 3, cooldownMs: 1000, clock });
  assert.strictEqual(b.permit(), Infinity);
  b.failure(); b.failure();
  assert.strictEqual(b.permit(), Infinity, "below the threshold stays closed");
  b.failure();
  assert.strictEqual(b.permit(), 0, "open: no calls at all");
  assert.strictEqual(b.state(), "open");
  clock.advance(1000);
  assert.strictEqual(b.permit(), 1, "cooldown over: ONE probe");
  assert.strictEqual(b.permit(), 0, "no second probe while the first is out");
  b.failure();
  assert.strictEqual(b.permit(), 0, "probe failed: open again");
  clock.advance(1000);
  assert.strictEqual(b.permit(), 1);
  b.success();
  assert.strictEqual(b.permit(), Infinity, "probe succeeded: closed");
  b.trip(500);
  assert.strictEqual(b.permit(), 0);
  clock.advance(500);
  assert.strictEqual(b.permit(), 1);
  b.settleProbe();
  assert.strictEqual(b.permit(), 1, "a probe that made no call frees its slot instead of wedging half-open");
});

/* ------------------------------ happy path ------------------------------ */

test("happy path: every answer becomes a provisional suggestion, spend is recorded, the job is finalized exactly once", async () => {
  const h = harness({ count: 3 });
  const summary = await h.worker.runPass(h.ctx);
  assert.strictEqual(summary.jobs, 1);
  assert.deepStrictEqual(statuses(h), ["success", "success", "success"]);
  for (const e of h.store.evalsOf(1)) {
    assert.strictEqual(Number(e.suggested_total), 5);
    assert.strictEqual(e.model, "test-model");
    assert.strictEqual(e.prompt_version, prompt.PROMPT_VERSION);
    assert.strictEqual(e.processing_cost, OK_COST);
    assert.strictEqual(JSON.parse(e.token_usage_json).inputTokens, 1000);
    assert.strictEqual(e.next_attempt_at, null);
    assert.ok(e.completed_at != null);
  }
  assert.deepStrictEqual(h.finals, [1]);
  const j = h.store.db.jobs.get(1);
  assert.strictEqual(j.status, "completed");
  assert.strictEqual(j.model, "test-model");
  assert.ok(j.started_at != null);
  assert.strictEqual(j.locked_by, null, "lease released");
  assert.strictEqual(h.provider.calls.length, 3);
  // The worker only ever PRODUCES suggestions; it has no way to write a mark.
  for (const a of h.store.db.answers.values()) assert.strictEqual(a.marks_awarded, null);
});

test("a flagged-but-valid reply is stored as needs_review with its flags (never silently dropped)", async () => {
  const flagged = JSON.stringify({ ...JSON.parse(goodReply()), flags: ["ambiguous_answer"] });
  const h = harness({ count: 1, reply: () => flagged });
  await h.worker.runPass(h.ctx);
  const e = h.store.evalsOf(1)[0];
  assert.strictEqual(e.status, "needs_review");
  assert.ok(JSON.parse(e.review_flags).some((f) => f.code === "ambiguous_answer"));
});

/* ------------------------------ stale work is never sent to the provider ------------------------------ */

test("STALE: answers that were hand-marked, released, edited, or whose question changed are cancelled WITHOUT calling the provider", async () => {
  const h = harness({ count: 6 });
  const e = h.store.evalsOf(1);
  h.store.db.answers.get(e[0].answer_id).marks_awarded = 3;                      // teacher marked it
  h.store.db.submissions.get(e[1].submission_id).status = "released";            // already released
  h.store.db.answers.get(e[2].answer_id).essay_answer = "<p>edited later</p>";   // content changed after claim
  h.store.db.questions.get(100).marks = 8;                                       // question re-weighted ... affects all 6
  await h.worker.runPass(h.ctx);
  // The question change cancels everything that was otherwise fine; the first three keep their more specific reasons.
  assert.deepStrictEqual(e.slice(0, 3).map((x) => x.last_error), ["MANUALLY_MARKED", "ALREADY_RELEASED", "ANSWER_CHANGED"]);
  assert.deepStrictEqual(e.slice(3).map((x) => x.last_error), ["QUESTION_CHANGED", "QUESTION_CHANGED", "QUESTION_CHANGED"]);
  assert.ok(e.every((x) => x.status === "cancelled"));
  assert.strictEqual(h.provider.calls.length, 0, "nothing stale costs money");
  assert.strictEqual(h.store.db.jobs.get(1).status, "failed", "nothing delivered -> nothing charged (finalize rule)");
});

test("RACE: a teacher marks the answer while the model is thinking -> the suggestion is discarded, never stored, but the spend is kept", async () => {
  const h = harness({ count: 1 });
  h.store.hooks.beforeRecordResult = async (evalId) => { h.store.db.answers.get(h.store.db.evals.get(evalId).answer_id).marks_awarded = 4; };
  await h.worker.runPass(h.ctx);
  const e = h.store.evalsOf(1)[0];
  assert.strictEqual(e.status, "cancelled");
  assert.strictEqual(e.last_error, "MANUALLY_MARKED");
  assert.strictEqual(e.suggested_total, null);
  assert.strictEqual(e.criteria_json, null, "the AI's suggestion must not exist alongside the teacher's mark");
  assert.strictEqual(e.processing_cost, OK_COST, "the call was real; its cost is recorded");
  assert.strictEqual(h.store.db.answers.get(e.answer_id).marks_awarded, 4, "the teacher's mark is untouched");
});

test("RACE: the submission is released while the model is thinking -> cancelled, never a suggestion on a released result", async () => {
  const h = harness({ count: 1 });
  h.store.hooks.beforeRecordResult = async (evalId) => { h.store.db.submissions.get(h.store.db.evals.get(evalId).submission_id).status = "released"; };
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.store.evalsOf(1)[0].last_error, "ALREADY_RELEASED");
  assert.strictEqual(h.store.evalsOf(1)[0].status, "cancelled");
});

test("CANCEL mid-call: the job was cancelled while the provider was answering -> result discarded, not charged, late cost still recorded", async () => {
  const h = harness({ count: 1 });
  h.store.hooks.beforeRecordResult = async (evalId) => {
    const e = h.store.db.evals.get(evalId);
    Object.assign(e, { status: "cancelled", last_error: "CANCELLED", completed_at: h.clock.now() });   // what finalizeJob's cancel does
  };
  await h.worker.runPass(h.ctx);
  const e = h.store.evalsOf(1)[0];
  assert.strictEqual(e.status, "cancelled");
  assert.strictEqual(e.suggested_total, null);
  assert.strictEqual(e.processing_cost, OK_COST);
  assert.strictEqual(h.worker.stats.lost, 1);
});

/* ------------------------------ retries ------------------------------ */

test("RETRY: a timeout keeps the answer pending, backs off exponentially, and succeeds on a later attempt", async () => {
  let n = 0;
  const h = harness({ count: 1, reply: () => (++n <= 3 ? TIMEOUT() : goodReply()) });
  const e = h.store.evalsOf(1)[0];
  const t0 = h.clock.now();
  await h.worker.runPass(h.ctx);
  assert.strictEqual(e.status, "pending");
  assert.strictEqual(e.attempt_count, 1);
  assert.strictEqual(e.next_attempt_at - t0 >= 3750 - 100 && e.next_attempt_at - t0 <= 3750 + 500, true, "attempt 1 -> ~5000 * 0.75");
  assert.strictEqual(h.finals.length, 0, "a job with an answer waiting to retry is not finalized");

  await h.worker.runPass(h.ctx);                                  // still waiting: nothing is claimed, no extra provider call
  assert.strictEqual(h.provider.calls.length, 1);

  h.clock.advance(5000);
  await h.worker.runPass(h.ctx);
  assert.strictEqual(e.attempt_count, 2);
  assert.ok(e.next_attempt_at - h.clock.now() > 7000 && e.next_attempt_at - h.clock.now() <= 7500 + 500, "attempt 2 -> ~10000 * 0.75: the delay doubled");

  h.clock.advance(8000);
  await h.worker.runPass(h.ctx);
  assert.strictEqual(e.attempt_count, 3);
  h.clock.advance(20000);
  await h.worker.runPass(h.ctx);
  assert.strictEqual(e.status, "success");
  assert.strictEqual(e.attempt_count, 4);
  assert.deepStrictEqual(h.finals, [1]);
});

test("RETRY: Retry-After from a 429 is honoured as a floor and slows the whole process, not just that answer", async () => {
  let n = 0;
  let hh;
  const callTimes = [];
  hh = harness({ count: 2, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, reply: () => { callTimes.push(hh.clock.now()); return ++n === 1 ? err("RATE_LIMITED", { retryable: true, retryAfterMs: 90000 }) : goodReply(); } });
  const h = hh;
  const t0 = h.clock.now();
  await h.worker.runPass(h.ctx);
  const first = h.store.evalsOf(1)[0];
  assert.ok(first.next_attempt_at - t0 >= 90000, "the throttled answer waits at least what the provider asked");
  assert.strictEqual(h.breaker.state(), "closed", "429 is a speed problem, not an outage: the breaker stays closed");
  assert.strictEqual(callTimes.length >= 2, true, "the other answer was still attempted in the same pass");
  assert.ok(callTimes[1] - callTimes[0] >= 90000, `the NEXT call (a different answer) also waited out the 429 (waited ${callTimes[1] - callTimes[0]} ms)`);
});

test("RETRY: after maxAttempts the answer is FAILED (no mark, never charged) and manual marking is the fallback", async () => {
  const h = harness({ count: 1, cfgEnv: { AI_MARKING_MAX_ATTEMPTS: "3", AI_MARKING_BREAKER_THRESHOLD: "100" }, reply: () => TIMEOUT() });
  const e = h.store.evalsOf(1)[0];
  for (let i = 0; i < 3; i += 1) { await h.worker.runPass(h.ctx); h.clock.advance(24 * 3600 * 1000); }
  assert.strictEqual(e.status, "failed");
  assert.strictEqual(e.suggested_total, null, "a failure is never a zero mark");
  assert.strictEqual(e.criteria_json, null);
  assert.ok(/gave up after 3 attempts/.test(e.last_error));
  assert.deepStrictEqual(JSON.parse(e.review_flags).map((f) => f.code), ["PROVIDER_TIMEOUT"]);
  assert.deepStrictEqual(h.finals, [1]);
});

/* ------------------------------ partial failure ------------------------------ */

test("PARTIAL FAILURE: one answer's reply is unusable, the rest succeed; the failure is recorded with no mark and the job still completes", async () => {
  const h = harness({ count: 3, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, reply: (n, req) => (/Note 2\b/.test(req.messages[0].content) ? "this is not json" : goodReply()) });
  await h.worker.runPass(h.ctx);
  assert.deepStrictEqual(statuses(h), ["success", "failed", "success"]);
  const failed = h.store.evalsOf(1)[1];
  assert.strictEqual(failed.suggested_total, null);
  assert.ok(/INVALID_OUTPUT/.test(failed.last_error));
  assert.strictEqual(failed.processing_cost, OK_COST * 2, "both rejected attempts were paid for and are recorded");
  assert.strictEqual(h.store.db.jobs.get(1).status, "completed");
  assert.strictEqual(h.breaker.state(), "closed", "a provider that replies (even badly) is up");
});

/* ------------------------------ outage ------------------------------ */

test("OUTAGE: the breaker opens, calls stop, and untouched answers keep their full retry budget; recovery needs one probe", async () => {
  let up = false;
  const h = harness({ count: 8, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "2", AI_MARKING_BREAKER_THRESHOLD: "3", AI_MARKING_BREAKER_COOLDOWN_MS: "60000" }, reply: () => (up ? goodReply() : UNAVAILABLE()) });
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.breaker.state(), "open");
  const callsAtOpen = h.provider.calls.length;
  assert.ok(callsAtOpen <= 4, `outage must stop quickly (made ${callsAtOpen} calls)`);
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, callsAtOpen, "no calls at all while open");
  const untouched = h.store.evalsOf(1).filter((e) => e.attempt_count === 0);
  assert.ok(untouched.length >= 4, "answers never attempted did not lose any retry budget to the outage");
  assert.strictEqual(h.finals.length, 0);

  up = true;
  h.clock.advance(61000);                                           // cooldown over; backed-off answers are due again
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.breaker.state(), "closed");
  for (let i = 0; i < 6 && h.store.countBy(1, "pending") > 0; i += 1) { h.clock.advance(60000); await h.worker.runPass(h.ctx); }
  assert.deepStrictEqual([...new Set(statuses(h))], ["success"]);
  assert.deepStrictEqual(h.finals, [1]);
});

/* ------------------------------ systemic failures ------------------------------ */

test("SYSTEMIC: bad credentials PAUSE the job (alert, breaker tripped, claims handed back with no attempt burned) instead of failing every answer", async () => {
  let fixed = false;
  const h = harness({ count: 5, reply: () => (fixed ? goodReply() : AUTH()) });
  const other = h.store.addJob({ id: 2 });
  h.store.addAnswer({ jobId: 2, essay: answerText(99), questionMarks: 5, maxMarks: 5, criteria: CRITERIA });
  await h.worker.runPass(h.ctx);
  const j = h.store.db.jobs.get(1);
  assert.ok(j.paused_until > h.clock.now(), "paused");
  assert.strictEqual(j.pause_count, 1);
  assert.strictEqual(j.pause_reason, "PROVIDER_AUTH");
  assert.strictEqual(h.store.countBy(1, "failed"), 0, "no answer is failed for a credentials problem");
  assert.ok(h.store.evalsOf(1).every((e) => e.attempt_count === 0), "no attempt is burned by the provider's fault");
  assert.deepStrictEqual(h.alerts.map((a) => [a.type, a.jobId, a.code]), [["job_paused", 1, "PROVIDER_AUTH"]]);
  assert.strictEqual(h.breaker.state(), "open", "the whole process stops hammering a broken provider");
  assert.strictEqual(h.store.countBy(2, "pending"), 1, "the other job was not sent to the broken provider either");
  assert.ok(h.provider.calls.length <= 4);

  const callsBefore = h.provider.calls.length;
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, callsBefore, "paused: nothing is attempted");

  fixed = true;
  h.clock.advance(11 * 60000);                                       // pause (10 min) over, breaker cooldown over
  for (let i = 0; i < 5; i += 1) await h.worker.runPass(h.ctx);
  assert.deepStrictEqual([...new Set(statuses(h))], ["success"]);
  assert.strictEqual(h.store.db.jobs.get(1).pause_count, 0, "healthy again: escalation resets");
  assert.ok(h.finals.includes(1));
});

test("SYSTEMIC: repeated systemic failures pause for longer each time, capped at two hours", async () => {
  const h = harness({ count: 1, reply: () => AUTH() });
  const pauses = [];
  for (let i = 0; i < 9; i += 1) {
    await h.worker.runPass(h.ctx);
    const j = h.store.db.jobs.get(1);
    pauses.push(Math.round((j.paused_until - h.clock.now()) / 60000));
    h.clock.advance((j.paused_until - h.clock.now()) + 1000);
  }
  assert.deepStrictEqual(pauses.slice(0, 5), [10, 20, 40, 80, 120]);
  assert.strictEqual(Math.max(...pauses), 120);
  assert.strictEqual(h.store.countBy(1, "failed"), 0);
});

test("SYSTEMIC: one answer that keeps provoking 'bad request' is isolated (failed, not charged) instead of pausing the job forever", async () => {
  const h = harness({ count: 3, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, reply: (n, req) => (/Note 2\b/.test(req.messages[0].content) ? BAD_REQUEST() : goodReply()) });
  await h.worker.runPass(h.ctx);                                    // answer 1 ok, answer 2 -> systemic -> pause
  assert.strictEqual(h.store.db.jobs.get(1).pause_count, 1);
  assert.strictEqual(h.store.evalsOf(1)[1].status, "pending");
  assert.strictEqual(h.store.evalsOf(1)[1].attempt_count, 1, "a bad request DOES count against the answer");
  h.clock.advance(11 * 60000);
  await h.worker.runPass(h.ctx);                                    // second strike: isolate it, keep going
  assert.deepStrictEqual(statuses(h), ["success", "failed", "success"]);
  assert.ok(/mark manually/.test(h.store.evalsOf(1)[1].last_error));
  assert.strictEqual(h.store.evalsOf(1)[1].suggested_total, null);
  assert.strictEqual(h.store.db.jobs.get(1).status, "completed");
});

test("engine not configured: the worker does nothing (reserved jobs wait, manual marking unaffected)", async () => {
  const h = harness({ count: 2, noProvider: true });
  const s = await h.worker.runPass(h.ctx);
  assert.strictEqual(s.notConfigured, true);
  assert.ok(!h.store.calls.includes("claimEvaluations") && !h.store.calls.includes("leaseJob"));
  assert.deepStrictEqual(statuses(h), ["pending", "pending"]);
  assert.strictEqual(h.store.db.jobs.get(1).status, "reserved");
});

/* ------------------------------ cancellation ------------------------------ */

test("CANCEL: a cancel-requested job is only finalized, never processed — even while the breaker is open", async () => {
  const h = harness({ count: 2, jobOver: { cancel_requested: 1 } });
  h.breaker.trip(10 * 60000);
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, 0);
  assert.deepStrictEqual(h.finals, [1]);
});

test("CANCEL: requested between batches -> processing stops at once and the job is finalized", async () => {
  const h = harness({ count: 6, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "2" } });
  let batches = 0;
  const realClaim = h.store.claimEvaluations;
  h.store.claimEvaluations = async (...a) => { if (++batches === 2) h.store.db.jobs.get(1).cancel_requested = 1; return realClaim.apply(h.store, a); };
  await h.worker.runPass(h.ctx);
  assert.ok(h.provider.calls.length <= 4, `stopped promptly after the cancel (made ${h.provider.calls.length} calls)`);
  assert.deepStrictEqual(h.finals, [1]);
  assert.strictEqual(h.store.db.jobs.get(1).status, "cancelled");
  assert.strictEqual(h.store.countBy(1, "pending"), 0, "unprocessed answers were cancelled, not left dangling");
  assert.strictEqual(h.store.countBy(1, "cancelled") + h.store.countBy(1, "success"), 6);
});

/* ------------------------------ restarts and duplicate delivery ------------------------------ */

test("RESTART: a dead worker's job and claimed answers are picked up by another worker once the leases expire — each answer marked exactly once", async () => {
  const h = harness({ count: 4, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "2" } });
  // Worker A takes the job and claims two answers, then dies without finishing anything.
  const lease = await h.store.leaseJob(1, "dead-worker", h.cfg.jobLeaseMs);
  assert.ok(lease);
  const claimed = await h.store.claimEvaluations(1, 2, h.cfg.answerLeaseMs);
  assert.strictEqual(claimed.length, 2);

  const b = h.mk("w2");
  const early = await b.runPass(h.ctx);
  assert.strictEqual(early.skipped, 1, "the job is still leased by the (dead) worker");
  assert.strictEqual(h.provider.calls.length, 0);

  h.clock.advance(h.cfg.jobLeaseMs + 1000);                         // job lease expired; the two claimed answers' lease is the same length
  await b.runPass(h.ctx);
  for (let i = 0; i < 3 && h.store.countBy(1, "pending") > 0; i += 1) { h.clock.advance(h.cfg.answerLeaseMs + 1000); await b.runPass(h.ctx); }
  assert.deepStrictEqual([...new Set(statuses(h))], ["success"]);
  assert.strictEqual(h.provider.calls.length, 4, "exactly one provider call per answer despite the crash");
  assert.deepStrictEqual(h.finals, [1]);
});

test("DUPLICATE DELIVERY: two workers running at the same moment never process the same job twice", async () => {
  const h = harness({ count: 6 });
  const [a, b] = [h.mk("wA"), h.mk("wB")];
  const [sa, sb] = await Promise.all([a.runPass(h.ctx), b.runPass(h.ctx)]);
  assert.strictEqual(sa.jobs + sb.jobs, 1, "only one of them got the lease");
  assert.strictEqual(sa.skipped + sb.skipped, 1);
  assert.strictEqual(h.provider.calls.length, 6);
  assert.deepStrictEqual([...new Set(statuses(h))], ["success"]);
});

test("DUPLICATE DELIVERY after lease expiry: a slow worker and its replacement both finish one answer -> one result, one charge, both costs recorded", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const h = harness({ count: 1, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, reply: async () => { if (++n === 1) await gate; return goodReply(); } });
  const slow = h.mk("slow");
  const fast = h.mk("fast");
  const slowRun = slow.runPass(h.ctx);                              // claims the answer, blocks inside the provider call
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.store.evalsOf(1)[0].attempt_count, 1);

  h.clock.advance(h.cfg.jobLeaseMs + h.cfg.answerLeaseMs + 1000);   // every lease has expired; the slow worker is presumed dead
  await fast.runPass(h.ctx);
  assert.strictEqual(h.store.evalsOf(1)[0].status, "success");
  const winnerCost = h.store.evalsOf(1)[0].processing_cost;

  release();                                                         // the slow worker finally gets its answer back
  await slowRun;
  const e = h.store.evalsOf(1)[0];
  assert.strictEqual(e.status, "success");
  assert.strictEqual(h.store.evalsOf(1).length, 1, "still exactly one evaluation");
  assert.strictEqual(e.processing_cost, Math.round((winnerCost + OK_COST) * 1e4) / 1e4, "the loser's call was real money and is recorded");
  assert.strictEqual(slow.stats.written, 0);
  assert.strictEqual(slow.stats.lost, 1);
  assert.strictEqual(fast.stats.written, 1);
});

/* ------------------------------ identical work ------------------------------ */

test("REUSE: byte-identical answers to the same question under the same scheme are evaluated once; the copy costs nothing and says where it came from", async () => {
  const same = "<p>Photosynthesis is how plants convert light energy into chemical energy in the chloroplasts. It produces glucose and oxygen.</p>";
  const h = harness({ count: 3, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, answerOver: () => ({ essay: same }) });
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, 1, "the provider was paid once for three identical answers");
  const [first, second, third] = h.store.evalsOf(1);
  assert.strictEqual(first.reused_from_evaluation_id, null);
  assert.strictEqual(second.reused_from_evaluation_id, first.id);
  assert.strictEqual(third.reused_from_evaluation_id, first.id);
  assert.strictEqual(second.status, "success");
  assert.strictEqual(Number(second.suggested_total), Number(first.suggested_total));
  assert.strictEqual(second.criteria_json, first.criteria_json);
  assert.ok((second.processing_cost || 0) === 0, "a copy adds no provider cost");
  assert.strictEqual(JSON.parse(second.token_usage_json).reusedFrom, first.id);
  assert.strictEqual(h.worker.stats.reused, 2);
});

test("REUSE is strict: different question, scheme version, or a rejected source are all re-evaluated", async () => {
  const same = "<p>Photosynthesis is how plants convert light energy into chemical energy in the chloroplasts. It produces glucose and oxygen.</p>";
  const make = (over) => { const h = harness({ count: 1, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, answerOver: () => ({ essay: same }) }); return h; };

  const h1 = make(); h1.store.addAnswer({ jobId: 1, essay: same, questionId: 101, questionMarks: 5, maxMarks: 5, criteria: CRITERIA });
  await h1.worker.runPass(h1.ctx);
  assert.strictEqual(h1.provider.calls.length, 2, "different question");

  const h2 = make(); h2.store.addAnswer({ jobId: 1, essay: same, schemeVersionId: 8, questionMarks: 5, maxMarks: 5, criteria: CRITERIA });
  await h2.worker.runPass(h2.ctx);
  assert.strictEqual(h2.provider.calls.length, 2, "different scheme version");

  const h3 = make(); await h3.worker.runPass(h3.ctx);
  h3.store.evalsOf(1)[0].review_state = "rejected";                 // a teacher rejected the first AI evaluation
  h3.store.addAnswer({ jobId: 1, essay: same, questionMarks: 5, maxMarks: 5, criteria: CRITERIA });
  h3.store.db.jobs.get(1).status = "reserved";
  await h3.worker.runPass(h3.ctx);
  assert.strictEqual(h3.provider.calls.length, 2, "a rejected evaluation is never copied");
});


test("REUSE (Phase 7): once a teacher disputes an evaluation of some exact work, NO identical answer is ever served a copy — the provider is asked again", async () => {
  const same = "<p>Photosynthesis is how plants convert light energy into chemical energy in the chloroplasts. It produces glucose and oxygen.</p>";
  const h = harness({ count: 2, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" }, answerOver: () => ({ essay: same }) });
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, 1, "the second identical answer was a copy");
  const [first, second] = h.store.evalsOf(1);
  assert.strictEqual(second.reused_from_evaluation_id, first.id);

  first.review_state = "rejected";                                  // the teacher says the AI got this exact answer wrong
  h.store.addAnswer({ jobId: 1, essay: same, questionMarks: 5, maxMarks: 5, criteria: CRITERIA });   // a third student, same words
  h.store.db.jobs.get(1).status = "reserved";
  await h.worker.runPass(h.ctx);
  assert.strictEqual(h.provider.calls.length, 2, "not copied from the disputed output (nor from its own copy)");
  assert.strictEqual(h.store.evalsOf(1)[2].reused_from_evaluation_id, null);
});

/* ------------------------------ privacy ------------------------------ */

test("PRIVACY: the student's name and admission number never reach the provider, and no log line contains student content", async () => {
  const h = harness({
    count: 2, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1" },
    answerOver: (i) => ({ essay: `<p>I am Wanjiku Kamau (ADM77${i}). Photosynthesis is how plants convert light energy into chemical energy in the chloroplasts. It produces glucose and oxygen.</p>`, studentName: "Wanjiku Kamau", admissionNo: `ADM77${i}` }),
    reply: (n) => (n === 1 ? AUTH() : goodReply()),
  });
  await h.worker.runPass(h.ctx);                                    // first call fails systemically -> logs happen
  h.clock.advance(11 * 60000);
  await h.worker.runPass(h.ctx);
  const sent = JSON.stringify(h.provider.calls);
  assert.ok(!/Wanjiku|Kamau|ADM77/i.test(sent), "identity never leaves the server");
  assert.ok(/\[NAME\]/.test(sent), "it was masked, not dropped");
  const everything = h.logs.join("\n");
  assert.ok(!/Wanjiku|Kamau|ADM77|photosynthesis|chloroplast/i.test(everything), "logs carry ids, codes and counts only");
  assert.ok(h.logs.length > 0, "something was logged, so the previous assertion means something");
});

/* ------------------------------ isolation of internal errors ------------------------------ */

test("ERROR isolation: a database error on one answer does not stop the others, and an answer that can never be loaded is failed after maxAttempts (not retried forever)", async () => {
  const h = harness({ count: 3, cfgEnv: { AI_MARKING_MAX_ATTEMPTS: "3", AI_MARKING_WORKER_CONCURRENCY: "1" } });
  const poisoned = h.store.evalsOf(1)[0].id;
  h.store.hooks.beforeLoad = async (id) => { if (id === poisoned) throw Object.assign(new Error("deadlock victim"), { code: "EREQUEST" }); };
  for (let i = 0; i < 4; i += 1) { await h.worker.runPass(h.ctx); h.clock.advance(h.cfg.answerLeaseMs + 1000); }
  const e = h.store.evalsOf(1);
  assert.strictEqual(e[1].status, "success");
  assert.strictEqual(e[2].status, "success");
  assert.strictEqual(e[0].status, "failed");
  assert.ok(/WORKER_ERROR/.test(e[0].last_error));
  assert.strictEqual(e[0].suggested_total, null);
});

test("ERROR isolation: repeated errors on a job pause it (escalating) and alert, instead of spinning", async () => {
  const h = harness({ count: 1, cfgEnv: { AI_MARKING_MAX_ATTEMPTS: "20" } });
  h.store.hooks.beforeLoad = async () => { throw Object.assign(new Error("connection lost"), { code: "ESOCKET" }); };
  for (let i = 0; i < W.JOB_ERROR_PAUSE_THRESHOLD; i += 1) { await h.worker.runPass(h.ctx); h.clock.advance(h.cfg.answerLeaseMs + 1000); }
  const j = h.store.db.jobs.get(1);
  assert.ok(j.paused_until > h.clock.now() - 1);
  assert.ok(/^WORKER_ERRORS/.test(j.pause_reason));
  assert.strictEqual(h.alerts.length, 1);
  assert.strictEqual(h.alerts[0].type, "job_paused");
});

/* ------------------------------ fairness, shutdown, ETA ------------------------------ */

test("FAIRNESS: a huge job cannot starve a small one — jobs are served least-recently-served first, one slice at a time", async () => {
  const h = harness({ count: 6, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "1", AI_MARKING_RATE_LIMIT_RPM: "30", AI_MARKING_SLICE_SECONDS: "2" } });
  h.store.addJob({ id: 2 });
  h.store.addAnswer({ jobId: 2, essay: answerText(50), questionMarks: 5, maxMarks: 5, criteria: CRITERIA });
  const w = h.mk("w1");
  await w.runPass(h.ctx);                                           // job 1 gets a slice, then job 2 gets one
  assert.ok(h.store.countBy(1, "pending") > 0, "the big job is NOT finished in one pass");
  assert.strictEqual(h.store.countBy(2, "success"), 1, "the small job was served in the same pass");
  assert.ok(h.finals.includes(2));
});

test("SHUTDOWN: stop() lets the batch in flight finish and be recorded, and claims nothing new", async () => {
  const h = harness({ count: 6, cfgEnv: { AI_MARKING_WORKER_CONCURRENCY: "2" } });
  const w = h.mk("w1");
  const realClaim = h.store.claimEvaluations;
  let batches = 0;
  h.store.claimEvaluations = async (...a) => { const r = await realClaim.apply(h.store, a); if (++batches === 1) w.stop(); return r; };
  await w.runPass(h.ctx);
  assert.strictEqual(h.store.countBy(1, "success"), 2, "the in-flight batch was completed and recorded");
  assert.strictEqual(h.store.countBy(1, "pending"), 4, "nothing further was claimed");
  assert.strictEqual(h.store.db.jobs.get(1).locked_by, null, "lease released on the way out");
});

test("ETA: null until real throughput exists; then (queue ahead + this job) / measured answers per second", async () => {
  const h = harness({ count: 10 });
  assert.strictEqual(await W.estimateSeconds(h.store, 20), null, "never guessed");
  h.store.throughput = { answersPerSecond: 2, sampleAnswers: 500, sampleJobs: 3 };
  assert.strictEqual(await W.estimateSeconds(h.store, 20), 15);       // (10 queued + 20) / 2
});

test("jobs presentation exposes a pause (so the teacher is told) without leaking internals", () => {
  const base = { id: 1, status: "processing", eligible_count: 5, unit_price: 1, quoted_total: 5, actual_total: 0, currency: "KES", cancel_requested: 0, createdAt: new Date(), selection_criteria: null };
  const paused = presentJob({ ...base, is_paused: 1, pause_reason: "PROVIDER_AUTH" });
  assert.strictEqual(paused.paused, true);
  assert.strictEqual(paused.pauseReason, "PROVIDER_AUTH");
  const running = presentJob({ ...base, is_paused: 0, pause_reason: "PROVIDER_AUTH" });
  assert.strictEqual(running.paused, false);
  assert.strictEqual(running.pauseReason, null, "a stale reason is not shown once the pause is over");
});


test("ETA wiring: the teacher preview carries the measured estimate; with no data it stays null; a failing estimate never breaks the preview", async () => {
  const { withEstimate } = require("../controllers/aiMarkingTeacher.controller");
  const run = async (handlers, billable = 20) => {
    const { pool } = makeMockPool(handlers);
    return withEstimate(pool, { counts: { billable }, estimatedSeconds: null });
  };
  const withData = await run([["worker:throughput", () => [{ answers: 600, seconds: 300, jobs: 4 }]], ["worker:count-queued", () => [{ n: 10 }]]]);
  assert.strictEqual(withData.estimatedSeconds, 15, "(10 queued + 20) / 2 answers per second");
  const noData = await run([["worker:throughput", () => [{ answers: 20, seconds: 30, jobs: 1 }]], ["worker:count-queued", () => [{ n: 0 }]]]);
  assert.strictEqual(noData.estimatedSeconds, null, "too little history -> never guessed");
  const broken = await run([["worker:throughput", () => { throw new Error("db down"); }]]);
  assert.strictEqual(broken.estimatedSeconds, null, "the preview survives a failing estimate");
  const nothing = await run([], 0);
  assert.strictEqual(nothing.estimatedSeconds, null, "nothing billable -> no query, no estimate");
});


test("SMOKE tool: covers every store method, is safe (ghost ids only), and reports a failing statement by name", async () => {
  const clock = createFakeClock();
  const memory = createMemoryWorkerStore(clock);
  const ok = await runStoreSmoke(memory);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.results.filter((r) => !r.ok)));
  // It must exercise the entire contract: if someone adds a store method, they must add it to the smoke list.
  const contract = Object.keys(createSqlWorkerStore({ request: () => ({}) })).sort();
  const covered = new Set(STORE_CALLS.map(([label]) => label.replace(/ \(.*\)$/, "")));
  assert.deepStrictEqual(contract.filter((m) => !covered.has(m)), [], "every SQL store method is in the smoke check");
  // A statement that fails to bind is reported with its method name, and does not stop the rest.
  const broken = { ...memory, loadWorkItem: async () => { throw new Error("Invalid column name 'admissionNo'."); } };
  const bad = await runStoreSmoke(broken);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.results.filter((r) => !r.ok).map((r) => r.label), ["loadWorkItem"]);
  assert.ok(/admissionNo/.test(bad.results.find((r) => !r.ok).error));
  assert.ok(bad.results.length === STORE_CALLS.length, "one failure does not abort the others");
  // And it only ever touches ids that cannot exist.
  for (const [, fn] of STORE_CALLS) assert.ok(/GHOST|-1/.test(fn.toString()) || /listActiveJobs|measureThroughput|countQueued/.test(fn.toString()));
});

/* ------------------------------ runner ------------------------------ */

function runnerHarness(env, { tenants = ["a", "b"], storeFor = () => null, jobsApi = null } = {}) {
  const clock = createFakeClock();
  const logs = [];
  const log = { log: () => {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const timers = [];
  const sweeps = [];
  const passes = [];
  const api = jobsApi || { sweepStalledJobs: async (pool) => { sweeps.push(pool.key); }, finalizeJob: async () => {} };
  const r = startAiMarkingWorker(async (key) => ({ key, request() { throw new Error("no db"); } }), () => tenants, {
    env, clock, log, setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearIntervalFn: () => {}, setTimeoutFn: () => {},
    providerFactory: () => scripted(() => goodReply()), jobsApi: api,
    storeFactory: (pool) => { const s = storeFor(pool.key) || createMemoryWorkerStore(clock); passes.push(pool.key); return s; },
  });
  return { r, logs, timers, sweeps, passes, clock };
}

test("runner: off unless AI_MARKING_WORKER_ENABLED=true (no timer, nothing started)", async () => {
  const x = runnerHarness({ ...ENV });
  assert.strictEqual(x.r.enabled, false);
  assert.strictEqual(x.timers.length, 0);
  await x.r.stop();
});

test("runner: engine not configured -> nothing runs and it says so once, not on every tick", async () => {
  const x = runnerHarness({ AI_MARKING_WORKER_ENABLED: "true" });
  await x.r.tick(); await x.r.tick(); await x.r.tick();
  assert.strictEqual(x.passes.length, 0);
  assert.strictEqual(x.logs.filter((l) => /not configured/.test(l)).length, 1);
});

test("runner: every tenant is visited, a failing tenant does not stop the others, and the stalled-job sweep runs at most once a minute per tenant", async () => {
  const x = runnerHarness({ ...ENV, AI_MARKING_WORKER_ENABLED: "true" }, { storeFor: (k) => (k === "a" ? { listActiveJobs: async () => { throw new Error("tenant a is down"); } } : null) });
  await x.r.tick();
  assert.deepStrictEqual(x.passes, ["a", "b"], "b was still visited after a failed");
  assert.ok(x.logs.some((l) => /tenant a pass failed/.test(l)));
  assert.deepStrictEqual(x.sweeps, ["a", "b"]);
  await x.r.tick();
  assert.deepStrictEqual(x.sweeps, ["a", "b"], "throttled");
  x.clock.advance(61000);
  await x.r.tick();
  assert.deepStrictEqual(x.sweeps, ["a", "b", "a", "b"]);
});

test("runner: stop() waits for the tick in progress and later ticks do nothing", async () => {
  const x = runnerHarness({ ...ENV, AI_MARKING_WORKER_ENABLED: "true" });
  const t = x.r.tick();
  await x.r.stop();
  await t;
  const before = x.passes.length;
  await x.r.tick();
  assert.strictEqual(x.passes.length, before);
});

/* ------------------------------ static guarantees about the SQL and the module boundaries ------------------------------ */

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const STORE = read("services/aiMarkingWorker.store.js");
const SERVICE = read("services/aiMarkingWorker.service.js");

test("STATIC: the worker store never writes marks, submissions or money — it only produces provisional evaluations", () => {
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, (m) => (/\/\*worker:/.test(m) ? m : ""));   // keep the tag comments, drop prose
  assert.ok(!/UPDATE\s+e_assessment/i.test(code), "no UPDATE of any e_assessment table");
  assert.ok(!/INSERT\s+INTO\s+(e_assessment|Marks)/i.test(code));
  assert.ok(!/DELETE\s+FROM/i.test(code), "nothing is ever deleted");
  assert.ok(!/institution_wallets|wallet_ledger|ai_marking_wallets|ai_marking_ledger|settleJob|reserveForJob|releaseJobReservation/.test(code), "money moves only in aiMarkingJobs.service.js");
  assert.ok(!/marks_awarded\s*=/.test(code), "marks_awarded is only ever read");
  for (const f of ["services/aiMarkingWorker.service.js", "services/aiMarkingWorker.store.js", "services/aiMarkingWorker.limits.js"]) {
    assert.ok(!/require\(["']\.\/aiMarkingLedger/.test(read(f)), `${f} must not import the ledger`);
  }
});

test("STATIC: every UPDATE of an evaluation is compare-and-set on its status", () => {
  const statements = STORE.split(/\/\*worker:/).slice(1).map((s) => s.split("`")[0]);
  const updates = statements.filter((s) => /UPDATE\s+ai_marking_evaluations|UPDATE\s+e\b/.test(s));
  assert.ok(updates.length >= 6, `found ${updates.length} evaluation updates`);
  for (const u of updates) {
    assert.ok(/status\s*=\s*'pending'|status\s+IN\s*\('cancelled','success','needs_review','failed'\)/.test(u), `unguarded evaluation UPDATE: ${u.slice(0, 60)}`);
  }
  // The guard is composed into the result write's WHERE clause, so it executes in the SAME statement as the write.
  assert.ok(/WHERE id = @id AND status = 'pending'\$\{guardSql\}/.test(STORE), "guard is appended to the result write's WHERE");
  const guardSql = STORE.split("const guardSql = guarded ?")[1].split("` : \"\";")[0];
  assert.ok(/marks_awarded IS NULL/.test(guardSql) && /s\.status <> 'released'/.test(guardSql), "the guard re-checks still-unmarked and not-released");
  // Writes that carry a suggestion are guarded; the only unguarded writes are failures, which provably carry no mark.
  const lines = SERVICE.split("\n");
  const unguarded = lines.map((l, i) => (/guarded: false/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.ok(unguarded.length >= 2);
  for (const i of unguarded) {
    const around = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
    assert.ok(/toFailureRow|suggested_total: null/.test(around), `an unguarded write near line ${i + 1} is not obviously a failure row`);
  }
  assert.ok((SERVICE.match(/guarded: true/g) || []).length >= 2, "success and reuse writes are both guarded");
});

test("STATIC: all timing is the database's clock; the store has no Node time and does no logging", () => {
  assert.ok(!/Date\.now|new Date\(|setTimeout|setInterval/.test(STORE.replace(/\/\*[\s\S]*?\*\//g, "")));
  assert.ok(!/console\./.test(STORE));
  assert.ok(/DATEADD\(MILLISECOND/.test(STORE) && /GETDATE\(\)/.test(STORE));
});

test("STATIC: the worker never logs student or answer content", () => {
  const logLines = SERVICE.split("\n").filter((l) => /\blog\.(info|warn|error)\(/.test(l));
  assert.ok(logLines.length >= 3);
  for (const l of logLines) assert.ok(!/answerHtml|questionText|studentName|admissionNo|criteria|essay|evidence/.test(l), `log line mentions content: ${l.trim()}`);
  const withoutDefaultLogger = SERVICE.replace(/const defaultLog = \{[\s\S]*?\n\};/, "");
  assert.ok(!/console\./.test(withoutDefaultLogger), "console is used only inside the default logger");
});

test("STATIC: the claim query skips rows another worker holds and only takes due, pending answers", () => {
  const claim = STORE.split("/*worker:claim-evals*/")[1].split("`")[0];
  assert.ok(/READPAST/.test(claim) && /UPDLOCK/.test(claim));
  assert.ok(/status = 'pending'/.test(claim) && /next_attempt_at IS NULL OR next_attempt_at <= GETDATE\(\)/.test(claim));
  assert.ok(/attempt_count = e\.attempt_count \+ 1/.test(claim));
});
