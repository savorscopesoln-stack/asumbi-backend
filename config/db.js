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
// CONNECTION POOL (singleton, reused across the app)
// =========================================================
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("✅ SQL Server Connected");
    return pool;
  })
  .catch((err) => {
    console.error("❌ DB Connection Failed:", err.message);
    throw err;
  });

module.exports = {
  sql,
  poolPromise,
};
