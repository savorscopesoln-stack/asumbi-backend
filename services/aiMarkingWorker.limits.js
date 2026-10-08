/* =========================================================================
   AI MARKING WORKER — configuration and the three "be gentle with the
   provider" primitives (Phase 6). No database, no provider, no student data.

   Everything time-based takes an injected clock ({ now(), sleep(ms) }) so
   tests are deterministic. These primitives are PER PROCESS and shared by
   every tenant: the provider's quota belongs to the API key, not the tenant.

   ENVIRONMENT (all optional; defaults in brackets)
     AI_MARKING_WORKER_ENABLED         unset = off. "true" starts the ticker.
     AI_MARKING_WORKER_CONCURRENCY     answers in flight at once        [4]  (1-16)
     AI_MARKING_RATE_LIMIT_RPM         provider calls per minute        [50] (1-6000)
     AI_MARKING_MAX_ATTEMPTS           availability retries per answer  [6]  (1-20)
     AI_MARKING_BACKOFF_BASE_MS        first retry delay                [5000]
     AI_MARKING_BACKOFF_MAX_MS         retry delay ceiling              [900000] (15 min)
     AI_MARKING_JOB_LEASE_SECONDS      job lease (renewed while working)[120]
     AI_MARKING_SLICE_SECONDS          time per job per pass (fairness) [20]
     AI_MARKING_TICK_SECONDS           ticker interval                  [5]
     AI_MARKING_BREAKER_THRESHOLD      consecutive outage failures that open the breaker [5]
     AI_MARKING_BREAKER_COOLDOWN_MS    how long the breaker stays open  [60000]
     AI_MARKING_PAUSE_MINUTES          first job pause on a systemic failure; doubles each time, capped at 2 h [10]
   The per-answer in-flight lease is derived, not configured: long enough for
   every provider call the engine may make for one answer, plus slack.
========================================================================= */

function intEnv(env, name, fallback, min, max, errors) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be a whole number between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

/** `engineConfig` supplies timeoutMs/formatAttempts so the answer lease always outlasts the slowest legitimate attempt. */
function resolveWorkerConfig(env = process.env, engineConfig = {}) {
  const errors = [];
  const cfg = {
    enabled: String(env.AI_MARKING_WORKER_ENABLED || "").trim().toLowerCase() === "true",
    concurrency: intEnv(env, "AI_MARKING_WORKER_CONCURRENCY", 4, 1, 16, errors),
    ratePerMinute: intEnv(env, "AI_MARKING_RATE_LIMIT_RPM", 50, 1, 6000, errors),
    maxAttempts: intEnv(env, "AI_MARKING_MAX_ATTEMPTS", 6, 1, 20, errors),
    backoffBaseMs: intEnv(env, "AI_MARKING_BACKOFF_BASE_MS", 5000, 100, 3600000, errors),
    backoffMaxMs: intEnv(env, "AI_MARKING_BACKOFF_MAX_MS", 900000, 1000, 86400000, errors),
    jobLeaseMs: intEnv(env, "AI_MARKING_JOB_LEASE_SECONDS", 120, 15, 3600, errors) * 1000,
    sliceMs: intEnv(env, "AI_MARKING_SLICE_SECONDS", 20, 2, 600, errors) * 1000,
    tickMs: intEnv(env, "AI_MARKING_TICK_SECONDS", 5, 1, 300, errors) * 1000,
    breakerThreshold: intEnv(env, "AI_MARKING_BREAKER_THRESHOLD", 5, 1, 100, errors),
    breakerCooldownMs: intEnv(env, "AI_MARKING_BREAKER_COOLDOWN_MS", 60000, 1000, 3600000, errors),
    pauseMinutes: intEnv(env, "AI_MARKING_PAUSE_MINUTES", 10, 1, 1440, errors),
  };
  if (cfg.backoffMaxMs < cfg.backoffBaseMs) {
    errors.push("AI_MARKING_BACKOFF_MAX_MS must be >= AI_MARKING_BACKOFF_BASE_MS");
    cfg.backoffMaxMs = cfg.backoffBaseMs;
  }
  const calls = Math.max(1, Number(engineConfig.formatAttempts) || 1);
  const perCall = Math.max(1000, Number(engineConfig.timeoutMs) || 60000);
  // Every call may also wait in the rate limiter; allow a generous queueing allowance.
  cfg.answerLeaseMs = calls * perCall + 60000;
  // The job lease must outlast one full batch of answers, or a healthy worker could lose its own job mid-batch.
  cfg.jobLeaseMs = Math.max(cfg.jobLeaseMs, cfg.answerLeaseMs);
  cfg.errors = errors;
  return cfg;
}

/**
 * Delay before retry number `attempt` (1 = the retry after the first failure).
 * Exponential with "equal jitter" (half fixed, half random) so a hundred
 * answers that failed together do not all retry in the same instant. A
 * provider-supplied Retry-After is a floor, never ignored.
 */
function backoffDelay(attempt, { baseMs, maxMs, retryAfterMs = null, random = Math.random }) {
  const n = Math.max(1, Number(attempt) || 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
  const jittered = Math.floor(ceiling / 2 + random() * (ceiling / 2));
  const floor = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(Math.max(jittered, floor), 3600000);
}

/**
 * Smooth call-start limiter: at most `perMinute` provider calls begin per
 * minute, spaced evenly (no burst that would itself trip the provider).
 * Slots are handed out synchronously, so concurrent callers queue fairly.
 * `penalize(ms)` pushes every future slot out — used when the provider says 429.
 */
function createRateLimiter({ perMinute, clock }) {
  const interval = 60000 / Math.max(1, perMinute);
  let nextSlot = 0;
  return {
    async acquire() {
      const now = clock.now();
      const start = Math.max(nextSlot, now);
      nextSlot = start + interval;
      const wait = start - now;
      if (wait > 0) await clock.sleep(wait);
    },
    penalize(ms) {
      const until = clock.now() + Math.max(0, Number(ms) || 0);
      if (until > nextSlot) nextSlot = until;
    },
    intervalMs: interval,
  };
}

/**
 * Circuit breaker for provider AVAILABILITY failures (timeouts, 5xx, network).
 *   closed     normal
 *   open       no calls at all until the cooldown ends
 *   half_open  exactly ONE probe call; success closes, failure reopens
 * While open, nothing is claimed, so an outage does not burn each answer's
 * retry budget — the queue simply waits it out.
 * permit() returns how many answers may be claimed right now (0, 1 or Infinity).
 */
function createCircuitBreaker({ threshold, cooldownMs, clock }) {
  let state = "closed";
  let failures = 0;
  let openUntil = 0;
  let probing = false;
  const open = (ms) => { state = "open"; openUntil = clock.now() + ms; probing = false; };
  return {
    permit() {
      if (state === "closed") return Infinity;
      if (state === "open") {
        if (clock.now() < openUntil) return 0;
        state = "half_open"; probing = false;
      }
      if (probing) return 0;
      probing = true;
      return 1;
    },
    success() { state = "closed"; failures = 0; probing = false; },
    failure() {
      failures += 1;
      if (state === "half_open" || failures >= threshold) open(cooldownMs);
      else probing = false;
    },
    /** The permitted probe made no provider call (e.g. nothing to claim): free the probe slot so the breaker cannot wedge half-open. */
    settleProbe() { if (state === "half_open") probing = false; },
    /** Force open (systemic problem: bad key, bad request...). Every job in this process stops. */
    trip(ms) { failures = threshold; open(ms); },
    state() { return state === "open" && clock.now() >= openUntil ? "half_open" : state; },
    openMsRemaining() { return state === "open" ? Math.max(0, openUntil - clock.now()) : 0; },
  };
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

module.exports = { resolveWorkerConfig, backoffDelay, createRateLimiter, createCircuitBreaker, realClock };
