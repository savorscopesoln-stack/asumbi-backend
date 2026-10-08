const engineModule = require("./aiMarkingEngine.service");
const prompt = require("./aiMarkingEngine.prompt");
const { backoffDelay, realClock } = require("./aiMarkingWorker.limits");

/* =========================================================================
   AI MARKING WORKER — logic (Phase 6)

   Turns confirmed ('reserved') jobs into PROVISIONAL evaluations. It never
   writes a final mark, never touches the wallet, and never marks anything
   itself: it loads one answer at a time, hands it to the Phase 5 engine, and
   records the outcome through the store. Money is settled by the existing
   finalizeJob() once a job has no pending answers left.

   Everything here is written against a small STORE interface
   (aiMarkingWorker.store.js is the SQL one; tests use an in-memory one), and
   against injected collaborators (clock, random, rate limiter, circuit breaker,
   engine, finalizeJob). That is what makes lease expiry, backoff, restarts and
   duplicate delivery testable without a database or a real provider.

   LIFE OF A JOB
     reserved --lease--> processing --(no pending answers)--> finalizeJob
                                                           --> completed | failed | cancelled
   A pass over a job lasts at most one "slice" so a huge job cannot starve
   small ones (jobs are served least-recently-served first).

   LIFE OF AN ANSWER (evaluation)
     pending --claim (lease + attempt+1)--> checks --> engine
        stale: answer marked / released / edited / question changed
              -> 'cancelled' (never charged)               [provider NOT called]
        identical work already evaluated in this tenant
              -> copy it (no provider call, no new provider cost)
        engine ok            -> 'success' | 'needs_review'  (guarded write)
        availability failure -> back off (exponential + jitter, Retry-After honoured)
                                until maxAttempts, then 'failed' (never charged)
        systemic failure     -> hand the answer back, PAUSE the job, trip the breaker
        anything else        -> 'failed' (never charged) -> manual marking
   A failure NEVER carries a mark; there is no path from a failure to a zero.

   IDEMPOTENCY AND DUPLICATE DELIVERY
   - Job lease: one worker per job at a time. The lease expires by itself, so a
     crashed worker's job is picked up by another process.
   - Answer claim: also time-limited (next_attempt_at). If a worker dies mid-call
     the answer becomes claimable again when the lease runs out.
   - Every result write is compare-and-set on status = 'pending'. If two workers
     do end up evaluating the same answer (lease expired while a call was slow),
     exactly one result is written; the loser's provider cost is recorded against
     the row, and the answer is charged once.
   - A result is written only if the answer is STILL unmarked and its submission
     NOT released, checked inside the same statement as the write.

   WHAT IS NEVER LOGGED OR RETURNED FROM HERE: answer text, question text,
   student names, evidence quotes. Logs carry ids, status codes and counts only.
========================================================================= */

// Availability problems that count toward the circuit breaker.
const BREAKER_CODES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_OVERLOADED", "PROVIDER_UNAVAILABLE", "PROVIDER_NETWORK", "PROVIDER_UNEXPECTED"]);
// The provider answered, so it is up (even if this particular reply was unusable).
const HEALTHY_FAILURE_CODES = new Set(["INVALID_OUTPUT", "CANNOT_EVALUATE"]);
// Systemic codes that are the provider's/credentials' fault, never the answer's.
const NEVER_ANSWER_FAULT = new Set(["PROVIDER_AUTH", "ENGINE_NOT_CONFIGURED"]);
// A "bad request" might be this one answer or the whole configuration. Same answer twice => isolate it.
const BAD_REQUEST_STRIKES = 2;
const MAX_PAUSE_MS = 2 * 60 * 60 * 1000;
const JOB_ERROR_PAUSE_THRESHOLD = 5;

const defaultLog = {
  info: (...a) => console.log("[ai-marking-worker]", ...a),
  warn: (...a) => console.warn("[ai-marking-worker]", ...a),
  error: (...a) => console.error("[ai-marking-worker]", ...a),
};

function safeParse(json) {
  if (json == null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * Running totals for one answer across attempts, so no spend (or token
 * measurement) is ever lost to a retry. cost === null means "provider prices
 * are not configured": UNKNOWN, which must never be reported as zero.
 */
function readSpend(item) {
  const t = safeParse(item.tokenUsageJson) || {};
  return {
    inputTokens: Number(t.inputTokens) || 0, outputTokens: Number(t.outputTokens) || 0,
    providerCalls: Number(t.providerCalls) || 0, attempts: Number(t.attempts) || 0,
    cost: item.processingCost == null ? null : Number(item.processingCost),
    costCurrency: t.costCurrency || null, reusedFrom: t.reusedFrom || null,
  };
}

function addSpend(spend, result, engineConfig) {
  const usage = result?.usage || { inputTokens: 0, outputTokens: 0 };
  return {
    ...spend,
    inputTokens: spend.inputTokens + (Number(usage.inputTokens) || 0),
    outputTokens: spend.outputTokens + (Number(usage.outputTokens) || 0),
    providerCalls: spend.providerCalls + (Number(result?.attempts) || 0),
    attempts: spend.attempts + 1,
    cost: result?.cost == null ? spend.cost : Math.round(((spend.cost || 0) + result.cost) * 1e4) / 1e4,
    costCurrency: engineConfig?.costCurrency || spend.costCurrency,
  };
}

const spendFields = (spend) => ({
  tokenUsageJson: JSON.stringify({
    inputTokens: spend.inputTokens, outputTokens: spend.outputTokens, providerCalls: spend.providerCalls,
    attempts: spend.attempts, costExact: spend.cost, costCurrency: spend.costCurrency,
    ...(spend.reusedFrom ? { reusedFrom: spend.reusedFrom } : {}),
  }),
  cost: spend.cost,
});

/** Why an answer should no longer be AI-marked, checked on fresh data before any provider call. */
function staleReason(item) {
  if (!item.answerFound) return "ANSWER_MISSING";
  if (item.marksAwarded != null) return "MANUALLY_MARKED";
  if (item.submissionStatus === "released") return "ALREADY_RELEASED";
  if (!item.currentHash || item.currentHash !== item.answerHash) return "ANSWER_CHANGED";
  if (item.questionMarks == null || Number(item.questionMarks) !== Number(item.maxMarks)) return "QUESTION_CHANGED";
  return null;
}

function createAiMarkingWorker({
  cfg, engineConfig, provider, limiter, breaker,
  engine = engineModule, clock = realClock, random = Math.random,
  workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  log = defaultLog, state = { lastServed: new Map() },
}) {
  let stopping = false;
  const stats = { written: 0, failed: 0, cancelled: 0, retried: 0, reused: 0, lost: 0, paused: 0, providerCalls: 0 };

  // Every provider call, including the engine's own format-retry calls, passes the rate limiter.
  const limitedProvider = provider ? {
    name: provider.name, model: provider.model,
    async complete(req) { await limiter.acquire(); stats.providerCalls += 1; return provider.complete(req); },
  } : null;

  /* ------------------------------ one answer ------------------------------ */

  async function processEvaluation(ctx, claim) {
    const { store } = ctx;
    const item = await store.loadWorkItem(claim.id);
    if (!item || item.status !== "pending") return { kind: "skipped" };
    let spend = readSpend(item);

    const stale = staleReason(item);
    if (stale) {
      await store.cancelEvaluation(item.id, stale, spendFields(spend));
      stats.cancelled += 1;
      return { kind: "cancelled", code: stale };
    }

    // Identical work already evaluated (same tenant, same scheme version and prompt): copy, don't pay the provider again.
    const reusable = await store.findReusable(item, { promptVersion: prompt.PROMPT_VERSION, model: provider.model });
    if (reusable) {
      const reusedSpend = { ...spend, attempts: spend.attempts + 1, reusedFrom: reusable.id };
      const row = {
        status: reusable.status, model: provider.model, prompt_version: prompt.PROMPT_VERSION,
        criteria_json: reusable.criteriaJson, suggested_total: reusable.suggestedTotal, review_flags: reusable.reviewFlags,
        token_usage_json: spendFields(reusedSpend).tokenUsageJson, processing_cost: reusedSpend.cost,
        last_error: null, reused_from_evaluation_id: reusable.id,
      };
      const outcome = await store.recordResult(item.id, row, { guarded: true });
      const done = await afterWrite(ctx, item, outcome, reusedSpend, null);
      if (done.kind === "written") { stats.reused += 1; return { ...done, reused: true }; }
      return done;
    }

    const criteria = safeParse(item.criteriaJson);
    const result = await engine.evaluateAnswer({
      questionText: item.questionText, maxMarks: item.maxMarks, criteria, answer: item.answerHtml,
      redact: { names: item.studentName ? [item.studentName] : [], identifiers: item.admissionNo ? [item.admissionNo] : [] },
    }, { config: engineConfig, provider: limitedProvider });
    spend = addSpend(spend, result, engineConfig);

    if (result.ok) {
      const row = { ...engine.toEvaluationRow(result, engineConfig), token_usage_json: spendFields(spend).tokenUsageJson, processing_cost: spend.cost, reused_from_evaluation_id: null };
      breaker.success();
      const outcome = await store.recordResult(item.id, row, { guarded: true });
      return afterWrite(ctx, item, outcome, spend, result.cost);
    }

    const code = result.code;
    if (HEALTHY_FAILURE_CODES.has(code)) breaker.success();

    if (result.systemic) {
      if (code === "PROVIDER_BAD_REQUEST" && claim.attempt >= BAD_REQUEST_STRIKES) {
        // The same answer has now provoked a bad request more than once: treat it as the problem, not the provider.
        return recordFailure(ctx, item, result, spend, `${code}: refused by the provider on repeated attempts; mark manually`);
      }
      await store.releaseClaim(item.id, { error: `${code}: ${result.message}`, ...spendFields(spend), keepAttempt: !NEVER_ANSWER_FAULT.has(code) });
      return { kind: "systemic", code };
    }

    if (result.retryable) {
      if (BREAKER_CODES.has(code)) breaker.failure();
      if (code === "PROVIDER_RATE_LIMITED") limiter.penalize(result.retryAfterMs || backoffDelay(claim.attempt, { baseMs: cfg.backoffBaseMs, maxMs: cfg.backoffMaxMs, random }));
      if (claim.attempt >= cfg.maxAttempts) {
        return recordFailure(ctx, item, result, spend, `${code}: gave up after ${claim.attempt} attempts; mark manually`);
      }
      const delay = backoffDelay(claim.attempt, { baseMs: cfg.backoffBaseMs, maxMs: cfg.backoffMaxMs, retryAfterMs: result.retryAfterMs, random });
      await store.scheduleRetry(item.id, delay, { error: `${code}: ${result.message}`, ...spendFields(spend) });
      stats.retried += 1;
      return { kind: "retry", code, delayMs: delay };
    }

    return recordFailure(ctx, item, result, spend, null);
  }

  /** A terminal failure: no mark, never charged, routed to manual marking. */
  async function recordFailure(ctx, item, result, spend, noteOverride) {
    const row = {
      ...engine.toFailureRow(result, engineConfig),
      token_usage_json: spendFields(spend).tokenUsageJson, processing_cost: spend.cost, reused_from_evaluation_id: null,
    };
    if (noteOverride) row.last_error = noteOverride.slice(0, 1000);
    const outcome = await ctx.store.recordResult(item.id, row, { guarded: false });
    if (outcome === "written") { stats.failed += 1; return { kind: "failed", code: result.code }; }
    // Cancelled (or finished by someone else) while we were working: discard, but the provider cost is real.
    if (result.cost != null) await ctx.store.addLateSpend(item.id, { cost: result.cost });
    stats.lost += 1;
    return { kind: "lost" };
  }

  /**
   * `deltaCost` is what THIS call cost (null = unknown / nothing). It is the only
   * figure added on a lost race: the row's own totals belong to whoever won it.
   */
  async function afterWrite(ctx, item, outcome, spend, deltaCost) {
    const { store } = ctx;
    if (outcome === "written") { stats.written += 1; return { kind: "written" }; }
    if (outcome === "answer_marked" || outcome === "released") {
      // A teacher marked it (or it was released) while the model was thinking: the suggestion is moot and must not appear.
      await store.cancelEvaluation(item.id, outcome === "released" ? "ALREADY_RELEASED" : "MANUALLY_MARKED", spendFields(spend));
      stats.cancelled += 1;
      return { kind: "cancelled", code: outcome };
    }
    // 'lost': cancelled mid-call, or another worker finished this answer first. Discard our result (it is never charged
    // twice) but the provider call was real, so add its cost to the row.
    if (deltaCost != null) await store.addLateSpend(item.id, { cost: deltaCost });
    stats.lost += 1;
    return { kind: "lost" };
  }

  /* ------------------------------ one job ------------------------------ */

  async function safeFinalize(ctx, jobId) {
    try {
      await ctx.finalizeJob(jobId);
      return true;
    } catch (err) {
      // "Not finished yet" / "not reserved" just mean someone got there first or work remains: not an error.
      if (["JOB_NOT_FINISHED", "JOB_NOT_RESERVED", "JOB_NOT_FOUND"].includes(err && err.code)) return false;
      throw err;
    }
  }

  async function pauseForSystemic(ctx, jobId, code, pauseCount) {
    const pauseMs = Math.min(cfg.pauseMinutes * 60000 * 2 ** Math.min(pauseCount, 10), MAX_PAUSE_MS);
    await ctx.store.pauseJob(jobId, pauseMs, code);
    breaker.trip(Math.min(pauseMs, 10 * 60000));   // every other job in this process stops hammering a broken provider too
    stats.paused += 1;
    log.error(`job ${jobId} paused for ${Math.round(pauseMs / 60000)} min: ${code}`);
    await Promise.resolve(ctx.alert?.({ type: "job_paused", jobId, code, pauseMs, pauseCount: pauseCount + 1 })).catch(() => {});
    return pauseMs;
  }

  async function processJob(ctx, jobId) {
    const { store } = ctx;
    const lease = await store.leaseJob(jobId, workerId, cfg.jobLeaseMs, { model: provider?.model || null, provider: provider?.name || null });
    if (!lease) return { skipped: "not_leased" };
    const deadline = clock.now() + cfg.sliceMs;
    const out = { jobId, processed: 0, finalized: false, pausedMs: 0, blocked: false };
    try {
      if (lease.cancelRequested) { out.finalized = await safeFinalize(ctx, jobId); return out; }

      let sawHealthyWrite = false;
      while (!stopping && clock.now() < deadline) {
        const st = await store.getJobState(jobId);
        if (!st || (st.status !== "reserved" && st.status !== "processing")) break;
        if (st.cancelRequested) { out.finalized = await safeFinalize(ctx, jobId); break; }
        if (st.paused) break;

        const permit = breaker.permit();
        if (permit === 0) { out.blocked = true; break; }
        if (!(await store.renewLease(jobId, workerId, cfg.jobLeaseMs))) { out.leaseLost = true; breaker.settleProbe(); break; }

        const claimed = await store.claimEvaluations(jobId, Math.min(cfg.concurrency, permit), cfg.answerLeaseMs);
        if (claimed.length === 0) {
          breaker.settleProbe();
          const open = await store.countOpen(jobId);
          if (open.pending === 0) out.finalized = await safeFinalize(ctx, jobId);
          else out.waitingMs = open.wakeInMs;      // everything left is backing off or leased elsewhere; a later pass picks it up
          break;
        }

        const outcomes = await Promise.all(claimed.map((c) => processEvaluation(ctx, c).catch(async (err) => {
          // A bug or database error on ONE answer must not strand its claim: it is retried when its lease runs out,
          // and after maxAttempts it is failed (never charged -> manual marking) so it cannot loop forever.
          log.error(`evaluation ${c.id} (job ${jobId}) errored: ${err && (err.code || err.name)}`);
          if (c.attempt >= cfg.maxAttempts) {
            await store.recordResult(c.id, {
              status: "failed", model: provider?.model || null, prompt_version: prompt.PROMPT_VERSION, criteria_json: null, suggested_total: null,
              review_flags: JSON.stringify([{ code: "WORKER_ERROR", source: "engine" }]), token_usage_json: null, processing_cost: null,
              last_error: `WORKER_ERROR: ${(err && (err.code || err.name)) || "Error"} on ${c.attempt} attempts; mark manually`, reused_from_evaluation_id: null,
            }, { guarded: false }).then(() => { stats.failed += 1; }).catch(() => {});
          }
          return { kind: "error", error: err };
        })));
        breaker.settleProbe();
        out.processed += outcomes.filter((o) => o.kind !== "skipped" && o.kind !== "error").length;
        if (outcomes.some((o) => o.kind === "written")) sawHealthyWrite = true;

        const sys = outcomes.find((o) => o.kind === "systemic");
        if (sys) { out.pausedMs = await pauseForSystemic(ctx, jobId, sys.code, lease.pauseCount); break; }
        const err = outcomes.find((o) => o.kind === "error");
        if (err) throw err.error;
      }
      // Only declare the job healthy if this slice did NOT end in a pause (a pause's escalation must survive the
      // successes that happened earlier in the same slice).
      if (sawHealthyWrite && !out.pausedMs) await store.markJobHealthy(jobId);

      // The slice ended on its time limit (or stop()) rather than on an empty queue: if nothing is left to do, settle
      // now instead of making the teacher's credits wait for the next tick.
      if (!out.finalized && !out.pausedMs && !out.blocked && !out.leaseLost && !out.waitingMs) {
        const st = await store.getJobState(jobId);
        if (st && (st.status === "reserved" || st.status === "processing") && !st.paused && !st.cancelRequested) {
          const open = await store.countOpen(jobId);
          if (open.pending === 0) out.finalized = await safeFinalize(ctx, jobId);
        }
      }
      return out;
    } catch (err) {
      let count = 0;
      try { count = await store.recordJobError(jobId, `${(err && (err.code || err.name)) || "Error"}: ${err && err.message}`); } catch { /* never let bookkeeping mask the real error */ }
      log.error(`job ${jobId} pass failed (${count} consecutive): ${err && (err.code || err.name)}`);
      if (count >= JOB_ERROR_PAUSE_THRESHOLD) out.pausedMs = await pauseForSystemic(ctx, jobId, `WORKER_ERRORS: ${(err && (err.code || err.name)) || "Error"}`, lease.pauseCount);
      out.error = true;
      return out;
    } finally {
      await store.releaseLease(jobId, workerId).catch(() => {});
    }
  }

  /* ------------------------------ one pass over a tenant ------------------------------ */

  /**
   * ctx = { store, finalizeJob(jobId), alert?(event) }.
   * Cancel-requested jobs are always visited (to finish the cancel) even while
   * the breaker is open; everything else waits for the breaker.
   */
  async function runPass(ctx, { budgetMs = null } = {}) {
    const summary = { jobs: 0, skipped: 0, notConfigured: !limitedProvider };
    if (!limitedProvider) return summary;
    const started = clock.now();
    const jobs = (await ctx.store.listActiveJobs()).sort((a, b) =>
      (state.lastServed.get(a.id) || 0) - (state.lastServed.get(b.id) || 0) || a.id - b.id);
    for (const job of jobs) {
      if (stopping) break;
      if (budgetMs != null && clock.now() - started >= budgetMs) break;
      if (job.paused && !job.cancelRequested) { summary.skipped += 1; continue; }
      if (!job.cancelRequested && breaker.openMsRemaining() > 0) { summary.skipped += 1; continue; }
      state.lastServed.set(job.id, clock.now());
      const r = await processJob(ctx, job.id);
      if (r.skipped) summary.skipped += 1; else summary.jobs += 1;
    }
    return summary;
  }

  return {
    runPass, processJob, processEvaluation, stats, workerId,
    stop() { stopping = true; },
    isStopping: () => stopping,
  };
}

/**
 * Honest ETA for a new job: queued answers ahead of it plus its own, divided by
 * the throughput actually measured on finished jobs. null until enough data
 * exists — never a guess.
 */
async function estimateSeconds(store, billable) {
  const tp = await store.measureThroughput();
  if (!tp || !(tp.answersPerSecond > 0)) return null;
  const queued = await store.countQueued();
  return Math.ceil((queued + Number(billable || 0)) / tp.answersPerSecond);
}

module.exports = {
  createAiMarkingWorker, estimateSeconds,
  // exported for tests
  staleReason, readSpend, addSpend, spendFields,
  BAD_REQUEST_STRIKES, JOB_ERROR_PAUSE_THRESHOLD, MAX_PAUSE_MS,
};
