/* =========================================================================
   FINANCE ACCOUNT — lives in the ENVIRONMENT, not in any database.

   Doravo Finance is one platform-level login (it acts on every institution
   through :tenantKey, see controllers/finance.controller.js). Like the master
   admin (utils/masterAdmin.js) its credentials are controlled only by the
   deployment's environment: nothing in any tenant UI or database can create,
   change, reset or delete it, and a school's admin cannot touch it.

   Configuration (environment)
     FINANCE_USERNAME        login name, default "doravo-finance"
     FINANCE_PASSWORD_HASH   bcrypt hash of the password (PREFERRED).
                             Make one with: node scripts/finance-account-setup.js
     FINANCE_PASSWORD        plain password (only if no hash is set; avoid in production)
     FINANCE_MFA_SECRET      optional Base32 authenticator secret. When set, a correct
                             password is only step one: a 6-digit code is also required.
     FINANCE_NAME            display name, default "Doravo Finance"
     FINANCE_HOME_TENANT     tenant key used for the session's own pool (default "default",
                             or the first configured tenant). Finance still reaches every
                             institution through :tenantKey.
   Without a password/hash nothing is enabled (a loud warning is logged) and NO
   finance login works. Old `Users` rows with role "finance" are no longer honoured.

   Rotating: change the env var and restart. The login is checked in constant
   time and never reveals whether the username or the password was wrong.
========================================================================= */
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { verifyToken } = require("./totp");

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function financeConfig(env = process.env) {
  const username = (env.FINANCE_USERNAME || "doravo-finance").trim() || "doravo-finance";
  const hash = String(env.FINANCE_PASSWORD_HASH || "").trim();
  const plain = String(env.FINANCE_PASSWORD || "");
  return {
    username,
    hash: BCRYPT_RE.test(hash) ? hash : "",
    badHash: !!hash && !BCRYPT_RE.test(hash),
    plain,
    mfaSecret: String(env.FINANCE_MFA_SECRET || "").replace(/\s+/g, "").toUpperCase(),
    name: (env.FINANCE_NAME || "Doravo Finance").trim() || "Doravo Finance",
    homeTenant: (env.FINANCE_HOME_TENANT || "").trim(),
  };
}

const isConfigured = (env = process.env) => {
  const c = financeConfig(env);
  return !!(c.hash || c.plain);
};
const sameUsername = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const isFinanceUsername = (username, env = process.env) => sameUsername(username, financeConfig(env).username);

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

/* Constant-time password check against the env credentials. Never throws. */
async function checkPassword(username, password, env = process.env) {
  try {
    const c = financeConfig(env);
    const userOk = sameUsername(username, c.username);
    let passOk = false;
    if (c.hash) passOk = await bcrypt.compare(String(password || ""), c.hash);
    else if (c.plain) passOk = crypto.timingSafeEqual(digest(password || ""), digest(c.plain));
    else await bcrypt.compare(String(password || ""), "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin"); // equalise timing
    return userOk && passOk;
  } catch { return false; }
}

const mfaRequired = (env = process.env) => !!financeConfig(env).mfaSecret;
const checkMfaCode = (code, env = process.env) => {
  const s = financeConfig(env).mfaSecret;
  return !!s && verifyToken(s, String(code || "").trim());
};

/* Tenant the finance session's own req.pool points at. */
function homeTenant(tenantKeys, env = process.env) {
  const want = financeConfig(env).homeTenant;
  if (want && tenantKeys.includes(want)) return want;
  return tenantKeys.includes("default") ? "default" : tenantKeys[0] || "default";
}

/* The user object put in tokens / returned to the frontend. id is null: there is no Users row. */
function financeUser(tenant, env = process.env) {
  const c = financeConfig(env);
  return { id: null, username: c.username, name: c.name, role: "finance", permissions: [], source: "Env", tenant,
    mustChangePassword: false, profileIncomplete: false };
}

/* Startup warnings (never include a secret). */
function financeWarnings(env = process.env) {
  const c = financeConfig(env);
  const w = [];
  if (c.badHash) w.push("FINANCE_PASSWORD_HASH is not a valid bcrypt hash: finance login is disabled until it is fixed.");
  else if (!c.hash && !c.plain) w.push("No FINANCE_PASSWORD_HASH (or FINANCE_PASSWORD) is set: nobody can sign in to Doravo Finance. Run: node scripts/finance-account-setup.js");
  else if (!c.hash && env.NODE_ENV === "production") w.push("FINANCE_PASSWORD is a plain-text password; use FINANCE_PASSWORD_HASH instead.");
  if ((c.hash || c.plain) && !c.mfaSecret) w.push("FINANCE_MFA_SECRET is not set: the finance account has no second factor.");
  return w;
}

module.exports = { financeConfig, isConfigured, isFinanceUsername, checkPassword, mfaRequired, checkMfaCode, homeTenant, financeUser, financeWarnings };
