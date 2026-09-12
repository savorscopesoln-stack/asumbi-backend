/* =========================================================================
   TRANSIENT DB RETRY — narrow, opt-in helper
   ─────────────────────────────────────────────────────────
   Retries a DB operation ONLY when the failure looks like a transient
   infrastructure/connection problem (pool exhausted, socket reset,
   connection timeout) — never for application-level outcomes like bad
   credentials, validation errors, or "not found", which aren't errors
   thrown by mssql at all in this codebase (they're normal early returns).

   Deliberately small and bounded:
     - at most `retries` extra attempts (default 1 → 2 attempts total)
     - short fixed backoff (default 150ms) — no exponential blow-up
     - every retry is logged so a burst of transient failures is visible
       in server logs instead of silently multiplying load

   This is NOT a general-purpose retry wrapper for the whole app — it is
   used only where a route explicitly opts in (currently just
   examLogin), so it can never turn a login burst into a retry storm
   against other routes.
========================================================================= */

// mssql surfaces pool/connection problems via these error names/codes.
// See node-mssql's ConnectionError / RequestError with these `code`
// values, and the underlying tarn.js "TimeoutError" (pool exhausted).
const TRANSIENT_ERROR_MARKERS = [
  "ETIMEOUT", // mssql/tarn: pool acquire timed out (pool exhausted)
  "ECONNRESET", // socket reset mid-query
  "ESOCKET", // low-level socket failure
  "ECONNCLOSED", // pool/connection closed under us
  "ELOGIN", // transient login handshake failure (not bad-credentials — those are our own app check, not this)
];

function isTransientDbError(err) {
  if (!err) return false;
  const code = err.code || err.originalError?.code;
  if (code && TRANSIENT_ERROR_MARKERS.includes(code)) return true;
  // tarn's own pool-exhaustion error doesn't always set `.code`; it does
  // set a recognizable message.
  if (typeof err.message === "string" && /timed out.*acquir|timeout.*pool/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * @param {() => Promise<any>} fn - the DB operation to attempt
 * @param {{ retries?: number, backoffMs?: number, label?: string }} opts
 */
async function withTransientRetry(fn, opts = {}) {
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 150;
  const label = opts.label || "db-operation";

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isTransientDbError(err);
      if (!canRetry) throw err;
      console.warn(
        `⚠️ Transient DB error on "${label}" (attempt ${attempt + 1}/${retries + 1}), retrying in ${backoffMs}ms:`,
        err.message
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

module.exports = { withTransientRetry, isTransientDbError };
