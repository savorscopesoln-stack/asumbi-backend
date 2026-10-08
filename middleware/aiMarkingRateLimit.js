/* =========================================================================
   AI MARKING RATE LIMITS (Phase 11)

   The app had no rate limiting at all. The AI-marking endpoints include
   queries that scan large tables (selection previews, analytics) and a
   money-moving POST, so a runaway client, a stuck retry loop or a stolen
   teacher login could degrade the whole service for every school.

   Fixed-window counters per (authenticated user, tenant, limiter name). Run
   AFTER `protect` so a user id exists; if there is none the client IP is
   used. Dependency-free on purpose.

   KNOWN LIMITS (be honest about them)
     - Counters live in this process's memory. With N server instances the
       effective limit is N x max, and a restart resets them. That is enough to stop
       accidents and casual abuse; it is NOT a defence against a distributed
       attack — put a real limiter (reverse proxy / WAF) in front for that.
     - Behind a proxy, req.ip is the proxy unless `app.set("trust proxy", ...)` is
       configured. That only matters for the no-user fallback, which `protect`
       makes unreachable on these routes.
     - It limits requests, not provider spend. Spend is bounded separately: a job
       needs wallet balance, and Phase 8 suggestions have their own hourly cap.

   Tunables (requests per minute per user):
     AI_MARKING_RATE_GENERAL_PER_MIN  default 300   ordinary reads / review actions / polling
     AI_MARKING_RATE_HEAVY_PER_MIN    default 30    previews, job creation, bulk accept, analytics
     AI_MARKING_RATE_FINANCE_PER_MIN  default 10    platform-wide finance analytics (reads every tenant)
========================================================================= */

function envInt(name, fallback, env = process.env) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : fallback;
}

function createRateLimiter({ name, max, windowMs = 60000, now = Date.now } = {}) {
  if (!name || !(max >= 1) || !(windowMs >= 1000)) throw new Error("createRateLimiter: name, max >= 1 and windowMs >= 1000 are required");
  const hits = new Map();           // key -> { count, resetAt }
  let lastSweep = now();

  const sweep = (t) => {
    if (t - lastSweep < windowMs && hits.size < 10000) return;
    lastSweep = t;
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  };

  const middleware = (req, res, next) => {
    const t = now();
    sweep(t);
    const who = req.user && req.user.id != null ? `u${req.user.id}` : `ip${req.ip || "?"}`;
    const key = `${name}|${req.user?.tenant || "default"}|${who}`;
    let h = hits.get(key);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + windowMs }; hits.set(key, h); }
    h.count += 1;
    if (h.count > max) {
      const retry = Math.max(1, Math.ceil((h.resetAt - t) / 1000));
      res.set && res.set("Retry-After", String(retry));
      return res.status(429).json({ success: false, code: "RATE_LIMITED", message: `Too many requests. Please wait ${retry} seconds and try again.` });
    }
    next();
  };
  middleware.limiterName = name;
  middleware._size = () => hits.size;
  return middleware;
}

function createDefaultLimiters(env = process.env) {
  return {
    general: createRateLimiter({ name: "ai-general", max: envInt("AI_MARKING_RATE_GENERAL_PER_MIN", 300, env) }),
    heavy: createRateLimiter({ name: "ai-heavy", max: envInt("AI_MARKING_RATE_HEAVY_PER_MIN", 30, env) }),
    finance: createRateLimiter({ name: "ai-finance", max: envInt("AI_MARKING_RATE_FINANCE_PER_MIN", 10, env) }),
  };
}

module.exports = { createRateLimiter, createDefaultLimiters, ...createDefaultLimiters() };
