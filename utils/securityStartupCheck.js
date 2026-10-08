/* =========================================================================
   SECURITY STARTUP CHECK (Phase 11)

   WHY THIS EXISTS
   middleware/authMiddleware.js, routes/auth.js, server.js and others fall back to a
   hard-coded signing secret ("doravo_core_secret") when JWT_SECRET is unset. A
   server that starts that way will accept a token anyone can forge — including
   {role:"finance"} (which can credit AI-marking wallets for any institution) and
   any tenant claim. The fallback is convenient on a laptop and catastrophic on a
   misconfigured production host, and nothing noticed the difference.

   WHAT IT DOES
   In production (NODE_ENV=production) a missing, known-default or short JWT_SECRET
   is FATAL: the process refuses to start, with a message naming the problem and never
   the value. Outside production the same findings are loud warnings, so local
   development is unchanged.

   It deliberately does not change how tokens are verified, and it never prints a
   secret. If your host does not set NODE_ENV=production the checks only warn —
   which is why a missing NODE_ENV is itself warned about.
========================================================================= */

const KNOWN_DEFAULTS = new Set([
  "doravo_core_secret", "asumbi_secret", "asumbi_secret_key_123",
  "secret", "jwt_secret", "changeme", "change_me", "your_secret_here", "password", "test", "dev", "development",
]);
const MIN_SECRET_LENGTH = 32;

/** -> { fatal: string[], warnings: string[] } — pure; never includes a secret value. */
function checkSecurityConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const fatal = [];
  const warnings = [];
  const problem = (msg) => (production ? fatal : warnings).push(msg);

  const secret = String(env.JWT_SECRET || "").trim();
  if (!secret) problem("JWT_SECRET is not set: the server would sign and accept tokens with a built-in default that anyone can forge. Generate one with: openssl rand -hex 32");
  else if (KNOWN_DEFAULTS.has(secret.toLowerCase())) problem("JWT_SECRET is a well-known default value. Generate a new one with: openssl rand -hex 32");
  else if (secret.length < MIN_SECRET_LENGTH) problem(`JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`);

  if (!production) {
    warnings.push(`NODE_ENV is "${env.NODE_ENV || "(unset)"}", not "production": security findings are warnings only, and the mock AI provider is permitted.`);
  } else {
    if (String(env.DB_ENCRYPT || "").toLowerCase() !== "true") warnings.push("DB_ENCRYPT is not 'true': database traffic (including student answers) is not encrypted in transit.");
    if (String(env.DB_TRUST_CERT || "").toLowerCase() === "true") warnings.push("DB_TRUST_CERT is 'true': the database server certificate is not being validated.");
  }

  const provider = String(env.AI_MARKING_PROVIDER || "").trim().toLowerCase();
  if (provider) {
    if (provider === "mock" && production) fatal.push("AI_MARKING_PROVIDER=mock is not allowed in production.");
    if (String(env.AI_MARKING_JOBS_ENABLED || "").toLowerCase() === "true" && !env.AI_MARKING_API_KEY && provider === "anthropic") {
      warnings.push("AI_MARKING_JOBS_ENABLED is true but AI_MARKING_API_KEY is empty: AI jobs will fail until it is set.");
    }
  }
  return { fatal, warnings };
}

/** Log warnings; throw (so the process exits before listening) on fatal findings. */
function enforceSecurityConfig(env = process.env, log = console) {
  const { fatal, warnings } = checkSecurityConfig(env);
  for (const w of warnings) log.warn(`[security] WARNING: ${w}`);
  if (fatal.length) {
    const err = new Error(`Refusing to start in production with an unsafe configuration:\n - ${fatal.join("\n - ")}`);
    err.code = "UNSAFE_CONFIGURATION";
    throw err;
  }
  return { fatal, warnings };
}

module.exports = { checkSecurityConfig, enforceSecurityConfig, KNOWN_DEFAULTS, MIN_SECRET_LENGTH };
