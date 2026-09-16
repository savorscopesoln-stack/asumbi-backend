const sql = require("mssql");
require("dotenv").config();

const tenants = require("./tenants");
const tenantContext = require("./tenantContext");

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
  constructor(cfg, label) {
    this._config = cfg;
    this._label = label; // for log lines, e.g. "default" or "eregi"
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
        console.log(`✅ SQL Server Connected (tenant: ${this._label})`);
        this._pool = pool;
        this._connecting = null;

        // If the pool drops later (DB restarts, network blip, the
        // Azure DB auto-pausing again), forget it so the *next*
        // request reconnects instead of reusing a dead pool.
        pool.on("error", (err) => {
          console.error(`⚠️ SQL pool error (tenant: ${this._label}):`, err.message);
          this._pool = null;
        });

        return pool;
      })
      .catch((err) => {
        console.error(`❌ DB Connection Failed (tenant: ${this._label}):`, err.message);
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
// MULTI-TENANT POOL REGISTRY
// One LazyPool per configured tenant, created on first use and cached
// here for the life of the process (same lifetime the old single
// `poolPromise` had).
// =========================================================
const poolsByTenant = new Map();

function getPoolForTenant(tenantKey) {
  const key = tenantKey || tenants.DEFAULT_TENANT;
  if (!poolsByTenant.has(key)) {
    const cfg = tenants.buildTenantConfig(key); // throws a clear error if misconfigured
    poolsByTenant.set(key, new LazyPool(cfg, key));
  }
  return poolsByTenant.get(key);
}

// =========================================================
// poolPromise — SAME PUBLIC SHAPE AS BEFORE.
// Every existing call site across the codebase does
// `const pool = await poolPromise` (or .then/.catch on it) with no
// idea a tenant even exists. To keep every one of those call sites
// working unchanged, poolPromise is itself a thenable: on await, it
// looks up the tenant key stashed in AsyncLocalStorage for the
// in-flight request (set by middleware/tenantContext.js very early in
// the request pipeline, before any route runs) and delegates to that
// tenant's LazyPool. Outside of a request (e.g. a background job, or
// code that never went through the tenant middleware) it just uses
// the default tenant, which is exactly the old single-DB behavior.
// =========================================================
const poolPromise = {
  then(onFulfilled, onRejected) {
    const tenantKey = tenantContext.getTenant() || tenants.DEFAULT_TENANT;
    return getPoolForTenant(tenantKey).then(onFulfilled, onRejected);
  },
  catch(onRejected) {
    const tenantKey = tenantContext.getTenant() || tenants.DEFAULT_TENANT;
    return getPoolForTenant(tenantKey).catch(onRejected);
  },
  finally(onFinally) {
    const tenantKey = tenantContext.getTenant() || tenants.DEFAULT_TENANT;
    return getPoolForTenant(tenantKey).finally(onFinally);
  },
};

module.exports = {
  sql,
  poolPromise,
  // Exposed for code that explicitly needs a *specific* tenant's pool
  // regardless of request context — e.g. server.js running
  // ensureSchema()/the notification scheduler once per configured
  // tenant at startup.
  getPoolForTenant,
  tenantKeys: tenants.ALL_TENANT_KEYS,
};
