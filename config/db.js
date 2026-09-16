const sql = require("mssql");
require("dotenv").config();

// =========================================================
// CONFIG — fully env-driven, now MULTI-TENANT.
// Works for local SQL Server Express AND cloud (Azure SQL).
//
// One "default" tenant is always built from the plain DB_* vars
// (DB_USER, DB_SERVER, DB_NAME, ...). Extra tenants are declared by
// listing their keys in DB_TENANTS (comma-separated, e.g.
// "eregi,someOtherSchool") and each one reads DB_<VAR>_<KEY> first,
// falling back to the plain DB_<VAR> if that specific override isn't
// set. Example, for DB_TENANTS=eregi:
//   DB_SERVER_EREGI, DB_NAME_EREGI, DB_USER_EREGI, DB_PASSWORD_EREGI,
//   DB_PORT_EREGI, DB_ENCRYPT_EREGI, DB_TRUST_CERT_EREGI
// =========================================================
function envFor(name, tenantKey) {
  if (tenantKey && tenantKey !== "default") {
    const suffixed = process.env[`${name}_${tenantKey.toUpperCase()}`];
    if (suffixed !== undefined && suffixed !== "") return suffixed;
  }
  return process.env[name];
}

function buildConfig(tenantKey) {
  return {
    user: envFor("DB_USER", tenantKey),
    password: envFor("DB_PASSWORD", tenantKey),
    server: envFor("DB_SERVER", tenantKey),
    database: envFor("DB_NAME", tenantKey),
    port: envFor("DB_PORT", tenantKey) ? parseInt(envFor("DB_PORT", tenantKey), 10) : 1433,
    options: {
      // Azure SQL requires encryption; local SQL Server Express usually doesn't.
      // Set DB_ENCRYPT=true (or DB_ENCRYPT_<TENANT>=true) for Azure SQL / any cloud DB.
      encrypt: envFor("DB_ENCRYPT", tenantKey) === "true",
      trustServerCertificate: envFor("DB_TRUST_CERT", tenantKey) !== "false",
    },
    // Pool sizing — env-driven so it can be tuned per environment without a
    // code change. The old hard-coded max:10/min:0 was fine for normal admin
    // portal traffic but is the confirmed cause of the exam-login failures
    // under a burst of ~900 simultaneous students: only 10 physical SQL
    // connections existed, so requests queued for a connection and, once the
    // queue wait exceeded tarn's default 30s acquireTimeoutMillis, failed as
    // connection-level errors rather than clean 400/401 responses.
    //
    // DB_POOL_MAX default of 50 is a conservative starting point for a
    // 2-query, index-lookup login (not "max:900" — that would just move the
    // bottleneck onto SQL Server's own worker/connection limits). Re-tune
    // upward only after confirming SQL Server CPU/connection headroom at
    // that size during staged load testing (see TESTING STRATEGY).
    //
    // DB_POOL_ACQUIRE_TIMEOUT_MS default of 8000 makes a saturated pool fail
    // fast with a clear, catchable error (caught in examLogin below and
    // turned into a 503 + Retry-After) instead of silently hanging for 30s,
    // which is what produced the connection-reset-style failures under load.
    // (Pool tuning vars aren't tenant-suffixed — every tenant shares the
    // same pool-sizing defaults unless you add DB_POOL_MAX_<TENANT> etc.
    // support later.)
    pool: {
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 50,
      min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN, 10) : 2,
      idleTimeoutMillis: process.env.DB_POOL_IDLE_MS
        ? parseInt(process.env.DB_POOL_IDLE_MS, 10)
        : 30000,
      acquireTimeoutMillis: process.env.DB_POOL_ACQUIRE_TIMEOUT_MS
        ? parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS, 10)
        : 8000,
    },
    // Azure SQL Serverless can be *paused* after a period of inactivity —
    // the first connection after a pause has to wait for it to resume,
    // which can take well over the mssql/tedious default of 15s. Give it
    // real headroom (overridable via env for local SQL Server Express,
    // which reconnects instantly and doesn't need this).
    connectionTimeout: process.env.DB_CONNECT_TIMEOUT_MS
      ? parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10)
      : 45000,
    requestTimeout: process.env.DB_REQUEST_TIMEOUT_MS
      ? parseInt(process.env.DB_REQUEST_TIMEOUT_MS, 10)
      : 45000,
  };
}

// =========================================================
// CONNECTION POOL — reconnects on demand instead of caching
// one dead promise forever.
//
// The old version connected once at startup and cached that single
// Promise. If that first attempt failed (e.g. an Azure SQL Serverless
// database that was paused), every future request kept awaiting the
// same already-rejected Promise and failed instantly — even long
// after the database had woken back up. Only a full process restart
// would recover.
//
// LazyPool fixes that: it's a "thenable" (implements .then/.catch/
// .finally) so existing call sites that do `await poolPromise` keep
// working unchanged, but every await re-checks the pool's live
// `.connected` state and reconnects if needed, instead of trusting a
// stale cached Promise.
// =========================================================
class LazyPool {
  constructor(cfg) {
    this._config = cfg;
    this._pool = null; // a connected ConnectionPool, once we have one
    this._connecting = null; // in-flight connect attempt, if any
  }

  _connect() {
    // Already connected and healthy — reuse it.
    if (this._pool && this._pool.connected) {
      return Promise.resolve(this._pool);
    }

    // A connect attempt is already in flight — piggyback on it instead
    // of opening a second pool concurrently.
    if (this._connecting) return this._connecting;

    this._connecting = new sql.ConnectionPool(this._config)
      .connect()
      .then((pool) => {
        console.log("✅ SQL Server Connected");
        this._pool = pool;
        this._connecting = null;

        // If the pool drops later (DB restarts, network blip, the
        // Azure DB auto-pausing again), forget it so the *next*
        // request reconnects instead of reusing a dead pool.
        pool.on("error", (err) => {
          console.error("⚠️ SQL pool error:", err.message);
          this._pool = null;
        });

        return pool;
      })
      .catch((err) => {
        console.error("❌ DB Connection Failed:", err.message);
        this._connecting = null;
        throw err;
      });

    return this._connecting;
  }

  then(onFulfilled, onRejected) {
    return this._connect().then(onFulfilled, onRejected);
  }
  catch(onRejected) {
    return this._connect().catch(onRejected);
  }
  finally(onFinally) {
    return this._connect().finally(onFinally);
  }
}

// =========================================================
// TENANT REGISTRY
// "default" (the plain DB_* vars) always exists. Anything listed in
// DB_TENANTS gets its own LazyPool, built from that tenant's
// DB_*_<KEY> overrides. A tenant with incomplete config is skipped
// (logged, not thrown) so one bad tenant can't take the whole app
// down — it just won't be checked during login.
// =========================================================
const tenantKeys = [
  "default",
  ...String(process.env.DB_TENANTS || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
];
const uniqueTenantKeys = [...new Set(tenantKeys)];

const pools = {}; // tenantKey -> LazyPool

for (const key of uniqueTenantKeys) {
  const cfg = buildConfig(key);
  if (!cfg.user || !cfg.password || !cfg.server || !cfg.database) {
    const label = key === "default" ? "" : `_${key.toUpperCase()}`;
    console.error(
      `❌ Missing DB config for tenant "${key}". Check DB_USER${label}, DB_PASSWORD${label}, DB_SERVER${label}, DB_NAME${label} in your .env file. Skipping this tenant.`
    );
    continue;
  }
  pools[key] = new LazyPool(cfg);
}

// =========================================================
// VALIDATE ENV — fail fast with a clear message. Only the default
// tenant is required at boot; extra tenants are optional/best-effort.
// =========================================================
if (!pools.default) {
  throw new Error(
    "❌ Missing DB config. Check DB_USER, DB_PASSWORD, DB_SERVER, DB_NAME in your .env file."
  );
}

/**
 * Get the LazyPool for a tenant key ("default", "eregi", ...).
 * Unknown/omitted keys fall back to "default" so old callers and
 * old JWTs (minted before multi-tenant support existed) keep working.
 */
function getPool(tenantKey) {
  const key = String(tenantKey || "default").toLowerCase();
  return pools[key] || pools.default;
}

/** All tenant keys that actually have a working DB config, "default" first. */
function listTenantKeys() {
  return Object.keys(pools);
}

module.exports = {
  sql,
  poolPromise: pools.default, // backward-compatible: existing single-tenant call sites are untouched
  getPool,
  listTenantKeys,
};
