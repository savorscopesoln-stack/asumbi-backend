/* =========================================================================
   AI MARKING ENGINE — CONFIGURATION (Phase 5)

   Everything provider-specific comes from the SERVER environment (or from
   `overrides`, which is where a future protected admin-settings store plugs
   in — it is not built yet, see the Phase 5 notes). Nothing here is read by
   or sent to the browser; publicConfig() is the only shape safe to expose.

   NO MODEL NAME, PROVIDER PRICE OR RATE LIMIT IS HARD-CODED. Model ids and
   token prices change; they are operational settings, not code.

   Variable                          Default   Meaning
   AI_MARKING_PROVIDER               (unset)   "anthropic" | "mock" (mock refused in production). Unset = engine off.
   AI_MARKING_API_KEY                (unset)   Provider secret. Server-only.
   AI_MARKING_MODEL                  (unset)   Exact model id to call. Required — no default on purpose.
   AI_MARKING_BASE_URL               provider  Optional gateway / proxy base URL. https only; validated (see checkBaseUrl).
   AI_MARKING_ALLOWED_HOSTS          (unset)   Optional comma-separated host allow-list for the base URL.
   AI_MARKING_TIMEOUT_MS             60000     Per provider call.
   AI_MARKING_MAX_OUTPUT_TOKENS      1500      Output ceiling per call (bounds cost).
   AI_MARKING_MAX_ANSWER_CHARS       12000     Longer answers are NOT truncated; they go to manual marking.
   AI_MARKING_FORMAT_ATTEMPTS        2         Calls allowed per answer when the reply fails validation (1-3).
   AI_MARKING_COST_INPUT_PER_MTOK    (unset)   Your provider price per million input tokens.
   AI_MARKING_COST_OUTPUT_PER_MTOK   (unset)   ... per million output tokens. Both unset = cost recorded as unknown.
   AI_MARKING_COST_CURRENCY          (unset)   Currency of the two prices above (informational; must match pricing currency before margin reports).
   AI_MARKING_SHORT_ANSWER_WORDS     10        "Full marks on fewer words than this" raises a review flag.
   AI_MARKING_LONG_ZERO_WORDS        40        "Zero marks on at least this many words" raises a review flag.
========================================================================= */

const DEFAULTS = {
  timeoutMs: 60000, maxOutputTokens: 1500, maxAnswerChars: 12000, formatAttempts: 2,
  shortAnswerWords: 10, longZeroWords: 40,
};

function num(env, name, fallback, { min, max, integer = false } = {}, errors) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min != null && n < min) || (max != null && n > max)) {
    errors.push(`${name} is invalid`);
    return fallback;
  }
  return n;
}

/**
 * AI_MARKING_BASE_URL decides where student answers AND the provider key are sent, so a wrong value is a
 * data leak, not just a bad setting. Returns { url } (normalised, no trailing slash) or { error }.
 *   - must be an absolute https URL (plain http only for localhost outside production, for local gateways)
 *   - no embedded credentials, query string or fragment
 *   - never a link-local / cloud-metadata address
 * An operator who really needs a private-network gateway can name its host in AI_MARKING_ALLOWED_HOSTS
 * (comma separated); when that list is set, ONLY those hosts are accepted.
 */
function checkBaseUrl(raw, env) {
  let u;
  try { u = new URL(raw); } catch { return { error: "AI_MARKING_BASE_URL is not a valid URL" }; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const production = env.NODE_ENV === "production";
  if (u.username || u.password) return { error: "AI_MARKING_BASE_URL must not contain a username or password" };
  if (u.search || u.hash) return { error: "AI_MARKING_BASE_URL must not contain a query string or fragment" };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal && !production)) {
    return { error: "AI_MARKING_BASE_URL must use https (http is allowed only for localhost outside production)" };
  }
  if (/^169\.254\./.test(host) || host === "metadata.google.internal" || /^fe80:/.test(host) || host === "100.100.100.200") {
    return { error: "AI_MARKING_BASE_URL points at a link-local or cloud-metadata address" };
  }
  const allowed = String(env.AI_MARKING_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(host)) return { error: "AI_MARKING_BASE_URL host is not in AI_MARKING_ALLOWED_HOSTS" };
  return { url: u.toString().replace(/\/+$/, "") };
}

function resolveConfig(env = process.env, overrides = {}) {
  const e = { ...env };
  for (const [k, v] of Object.entries(overrides || {})) if (v !== undefined) e[k] = v;
  const errors = [];

  const provider = (e.AI_MARKING_PROVIDER || "").trim().toLowerCase() || null;
  if (provider && !["anthropic", "mock"].includes(provider)) errors.push("AI_MARKING_PROVIDER must be 'anthropic' or 'mock'");
  if (provider === "mock" && e.NODE_ENV === "production") errors.push("AI_MARKING_PROVIDER=mock is not allowed in production");

  const apiKey = (e.AI_MARKING_API_KEY || "").trim() || null;
  const model = (e.AI_MARKING_MODEL || "").trim() || null;
  const cost = {
    input: num(e, "AI_MARKING_COST_INPUT_PER_MTOK", null, { min: 0 }, errors),
    output: num(e, "AI_MARKING_COST_OUTPUT_PER_MTOK", null, { min: 0 }, errors),
  };
  const cfg = {
    provider, apiKey, model,
    baseUrl: null,
    timeoutMs: num(e, "AI_MARKING_TIMEOUT_MS", DEFAULTS.timeoutMs, { min: 1000, max: 600000, integer: true }, errors),
    maxOutputTokens: num(e, "AI_MARKING_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens, { min: 200, max: 16000, integer: true }, errors),
    maxAnswerChars: num(e, "AI_MARKING_MAX_ANSWER_CHARS", DEFAULTS.maxAnswerChars, { min: 200, max: 200000, integer: true }, errors),
    formatAttempts: num(e, "AI_MARKING_FORMAT_ATTEMPTS", DEFAULTS.formatAttempts, { min: 1, max: 3, integer: true }, errors),
    shortAnswerWords: num(e, "AI_MARKING_SHORT_ANSWER_WORDS", DEFAULTS.shortAnswerWords, { min: 0, max: 1000, integer: true }, errors),
    longZeroWords: num(e, "AI_MARKING_LONG_ZERO_WORDS", DEFAULTS.longZeroWords, { min: 1, max: 100000, integer: true }, errors),
    costInputPerMTok: cost.input, costOutputPerMTok: cost.output,
    costCurrency: (e.AI_MARKING_COST_CURRENCY || "").trim().toUpperCase() || null,
  };
  const rawBase = (e.AI_MARKING_BASE_URL || "").trim();
  if (rawBase) {
    const b = checkBaseUrl(rawBase, e);
    if (b.error) errors.push(b.error); else cfg.baseUrl = b.url;
  }
  if ((cfg.costInputPerMTok == null) !== (cfg.costOutputPerMTok == null)) {
    errors.push("Set both AI_MARKING_COST_INPUT_PER_MTOK and AI_MARKING_COST_OUTPUT_PER_MTOK, or neither");
    cfg.costInputPerMTok = null; cfg.costOutputPerMTok = null;
  }

  const missing = [];
  if (!provider) missing.push("AI_MARKING_PROVIDER");
  if (!model) missing.push("AI_MARKING_MODEL");
  if (provider === "anthropic" && !apiKey) missing.push("AI_MARKING_API_KEY");
  cfg.missing = missing;
  cfg.errors = errors;
  cfg.configured = missing.length === 0 && errors.length === 0;
  return cfg;
}

/** Safe to log or return from an admin endpoint: never includes the key. */
function publicConfig(cfg) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKeyPresent: !!apiKey };
}

/** Provider cost of the tokens used, in costCurrency. null = prices not configured (unknown, NOT zero). */
function computeCost(usage, cfg) {
  if (cfg.costInputPerMTok == null || cfg.costOutputPerMTok == null) return null;
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  return (input / 1e6) * cfg.costInputPerMTok + (output / 1e6) * cfg.costOutputPerMTok;
}

module.exports = { DEFAULTS, resolveConfig, publicConfig, computeCost, checkBaseUrl };
