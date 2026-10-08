const { resolveConfig } = require("./aiMarkingEngine.config");
const { describeError } = require("../utils/safeLog");
const { createProvider } = require("./aiMarkingEngine.providers");
const { createAiMarkingWorker } = require("./aiMarkingWorker.service");
const { createSqlWorkerStore } = require("./aiMarkingWorker.store");
const { resolveWorkerConfig, createRateLimiter, createCircuitBreaker, realClock } = require("./aiMarkingWorker.limits");
const jobs = require("./aiMarkingJobs.service");
const { logFinanceAudit } = require("../utils/financeAuditLog");

/* =========================================================================
   AI MARKING WORKER — RUNNER (Phase 6)

   The same shape as utils/examScheduler.js and utils/notificationScheduler.js:
   one in-process ticker that visits every tenant database. Started from
   server.js ONLY when AI_MARKING_WORKER_ENABLED=true:

       const { startAiMarkingWorker } = require("./services/aiMarkingWorker.runner");
       startAiMarkingWorker(getPool, listTenantKeys);

   WHAT ONE TICK DOES, PER TENANT
     1. (at most once a minute) sweepStalledJobs — finishes or cancels jobs
        that died between "answers claimed" and "credits reserved".
     2. worker.runPass — leases jobs, marks answers, calls finalizeJob when a
        job has nothing pending. finalizeJob is what settles the money.

   WHEN THE ENGINE IS NOT CONFIGURED the worker does nothing at all. Manual
   marking is unaffected, and reserved jobs simply wait (teachers can cancel
   them for a full refund). It logs that fact at most every ten minutes.

   MULTIPLE PROCESSES are safe: every step is a lease or a compare-and-set.
   The rate limiter and circuit breaker are per process, so with N processes
   set AI_MARKING_RATE_LIMIT_RPM to (provider limit / N).

   ALERTS: a paused job is logged and written to finance_audit_log
   (action 'ai_marking_job_paused', no student content) so Finance can see it.
========================================================================= */

const SWEEP_EVERY_MS = 60 * 1000;
const NOT_CONFIGURED_LOG_EVERY_MS = 10 * 60 * 1000;

function startAiMarkingWorker(getPool, listTenantKeys, {
  env = process.env, clock = realClock, log = console,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, setTimeoutFn = setTimeout,
  providerFactory = createProvider, storeFactory = createSqlWorkerStore, jobsApi = jobs,
} = {}) {
  const workerCfg = resolveWorkerConfig(env, resolveConfig(env));
  if (!workerCfg.enabled) return { stop: async () => {}, tick: async () => {}, enabled: false };
  workerCfg.errors.forEach((e) => log.warn(`[ai-marking-worker] config: ${e} (default used)`));

  // Per-process, shared by every tenant: the provider quota belongs to the API key.
  const limiter = createRateLimiter({ perMinute: workerCfg.ratePerMinute, clock });
  const breaker = createCircuitBreaker({ threshold: workerCfg.breakerThreshold, cooldownMs: workerCfg.breakerCooldownMs, clock });
  const sharedState = { lastServed: new Map() };
  const lastSweep = new Map();
  let lastNotConfiguredLog = 0;
  let running = null;
  let stopped = false;
  let current = null;

  async function tick() {
    if (running || stopped) return running;
    running = (async () => {
      try {
        const engineConfig = resolveConfig(env);
        if (!engineConfig.configured) {
          if (clock.now() - lastNotConfiguredLog > NOT_CONFIGURED_LOG_EVERY_MS) {
            lastNotConfiguredLog = clock.now();
            log.warn(`[ai-marking-worker] engine not configured (${[...engineConfig.missing, ...engineConfig.errors].join("; ")}); AI jobs wait, manual marking is unaffected`);
          }
          return;
        }
        let provider;
        try { provider = providerFactory(engineConfig); } catch (e) { log.error("[ai-marking-worker] could not create the provider:", e && e.message); return; }

        current = createAiMarkingWorker({ cfg: workerCfg, engineConfig, provider, limiter, breaker, clock, state: sharedState });
        for (const key of listTenantKeys()) {
          if (stopped) break;
          try {
            const pool = await getPool(key);
            const store = storeFactory(pool);
            if (clock.now() - (lastSweep.get(key) || 0) >= SWEEP_EVERY_MS) {
              lastSweep.set(key, clock.now());
              await jobsApi.sweepStalledJobs(pool);
            }
            await current.runPass({
              store,
              finalizeJob: (jobId) => jobsApi.finalizeJob(pool, { jobId, actorRole: "system" }),
              alert: (event) => logFinanceAudit(pool, { action: "ai_marking_job_paused", actorRole: "system", details: event }),
            });
          } catch (err) {
            log.error(`[ai-marking-worker] tenant ${key} pass failed:`, describeError(err));
          }
        }
      } finally {
        running = null;
        current = null;
      }
    })();
    return running;
  }

  const timer = setIntervalFn(() => { tick(); }, workerCfg.tickMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  setTimeoutFn(() => { tick(); }, 5000);
  log.log?.(`[ai-marking-worker] started (concurrency ${workerCfg.concurrency}, ${workerCfg.ratePerMinute} calls/min)`);

  return {
    enabled: true, tick,
    /** Graceful shutdown: stop claiming new answers, let in-flight ones finish and be recorded. */
    async stop() {
      stopped = true;
      clearIntervalFn(timer);
      if (current) current.stop();
      if (running) await running.catch(() => {});
    },
    breaker, limiter,
  };
}

module.exports = { startAiMarkingWorker };
