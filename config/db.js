const sql = require("mssql");
require("dotenv").config();

// =========================================================
// CONFIG — single source of truth, fully env-driven
// Works for local SQL Server Express AND cloud (Azure SQL)
// =========================================================
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433,
  options: {
    // Azure SQL requires encryption; local SQL Server Express usually doesn't.
    // Set DB_ENCRYPT=true in your .env when connecting to Azure SQL / any cloud DB.
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_CERT !== "false",
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
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

// =========================================================
// VALIDATE ENV — fail fast with a clear message
// =========================================================
if (!config.user || !config.password || !config.server || !config.database) {
  throw new Error(
    "❌ Missing DB config. Check DB_USER, DB_PASSWORD, DB_SERVER, DB_NAME in your .env file."
  );
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

const poolPromise = new LazyPool(config);

module.exports = {
  sql,
  poolPromise,
};
