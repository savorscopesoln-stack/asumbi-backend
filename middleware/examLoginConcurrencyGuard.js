/* =========================================================================
   EXAM-LOGIN CONCURRENCY GUARD
   ─────────────────────────────────────────────────────────
   The DB pool (config/db.js) already provides bounded concurrency — only
   DB_POOL_MAX connections run at once, everything else waits in tarn's
   internal queue up to DB_POOL_ACQUIRE_TIMEOUT_MS. That's enough on its
   own for normal bursts.

   This guard adds one extra safety margin ON TOP of that, scoped only to
   POST /e-assessments/exam-login: if a truly extreme spike (e.g. the
   2000-VU staged test) pushes far more requests in-flight than the pool
   could ever serve promptly, we want the excess to fail IMMEDIATELY with
   a clear 503 + Retry-After, rather than sit queued in Node's memory for
   the full acquire-timeout window on top of everything else.

   Deliberately:
     - scoped to this one route only (never touches other API traffic)
     - a fixed ceiling (a small multiple of the DB pool size), not
       "unlimited" and not an unbounded queue
     - no waiting/queueing here at all — over the ceiling means an
       immediate, cheap 503, so Node's event loop and memory stay stable
       no matter how large the spike gets
========================================================================= */

const MAX_IN_FLIGHT = process.env.EXAM_LOGIN_MAX_IN_FLIGHT
  ? parseInt(process.env.EXAM_LOGIN_MAX_IN_FLIGHT, 10)
  : 300; // ~6x the default DB_POOL_MAX=50 — headroom for queued-but-servable requests

let inFlight = 0;

function examLoginConcurrencyGuard(req, res, next) {
  if (inFlight >= MAX_IN_FLIGHT) {
    res.set("Retry-After", "2");
    return res.status(503).json({
      success: false,
      code: "EXAM_LOGIN_BUSY",
      message: "Login is experiencing very high demand right now. Please try again in a few seconds.",
    });
  }

  inFlight++;
  let released = false;
  const release = () => {
    if (released) return; // finish + close can both fire — decrement exactly once
    released = true;
    inFlight--;
  };
  res.on("finish", release);
  res.on("close", release); // client disconnected before response finished
  next();
}

module.exports = { examLoginConcurrencyGuard };
