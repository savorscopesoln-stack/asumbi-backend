require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const path = require("path");

const { poolPromise, sql, getPool, listTenantKeys } = require("./config/db");
const { protect, authorize, adminOnly, requirePage } = require("./middleware/authMiddleware");
const { ensureSchema } = require("./utils/ensureSchema");
const { photoUrlFor, deletePhotoByUrl, runPhotoUpload } = require("./middleware/photoUpload");

// Idempotent startup check — creates/upgrades the Notifications table
// and adds leave_outs.leave_type if either is missing. Runs against
// EVERY configured tenant DB (default + anything in DB_TENANTS).
//
// IMPORTANT: these promises are awaited before the server starts
// accepting traffic (see startServer() near the bottom) — otherwise,
// on a cold Render deploy or a paused Azure SQL Serverless DB, requests
// can land before a tenant's schema check has actually finished,
// producing "Invalid object name" errors that look like the DB is
// broken when it's really just not ready yet. Each tenant's promise
// still catches its own error, so one bad tenant can't block the
// others or crash boot.
const schemaReadyPromises = listTenantKeys().map((tenantKey) =>
  getPool(tenantKey)
    .then((pool) => ensureSchema(pool, sql, tenantKey))
    .catch((err) =>
      console.error(`Schema ensure skipped (tenant "${tenantKey}"):`, err.message)
    )
);

// route modules
const registerRoutes = require("./routes/register");
const analyticsRoute = require("./routes/analytics");
const assessmentsRoutes = require("./routes/assessments");
const authRoutes = require("./routes/auth");
const practicumRoutes = require("./routes/practicum");
const leaveOutRoutes = require("./routes/leaveOutRoutes")(poolPromise, sql);
const portalPagesRoutes = require("./routes/portalPages")(poolPromise, sql);
const websiteRoutes = require("./routes/website")(poolPromise, sql);
const schoolSettingsRoutes = require("./routes/schoolSettings")(poolPromise, sql);
const contactRoutes = require("./routes/contact")(poolPromise, sql);
const mealRoutes = require("./routes/mealRoutes");
const gateRoutes = require("./routes/gate");
const kitchenRoutes = require("./routes/kitchen");
const attendanceRoutes = require("./routes/attendance");
const eAssessmentRoutes = require("./routes/eAssessments");
const localSyncRoutes = require("./routes/localSync");
const metaRoutes = require("./routes/meta.routes");
const feesRoutes = require("./routes/fees");
const leaveRoutes = require("./routes/leave");
const searchRoutes = require("./routes/searchRecords");
const profileChangeRequestsRoutes = require("./routes/profileChangeRequests");
const notificationsRoutes = require("./routes/notifications");
const broadcastNotificationsRoutes = require("./routes/broadcastNotifications");
const notificationSettingsRoutes = require("./routes/notificationSettings");
const studentCouncilRoutes = require("./routes/studentCouncil");
const { dispatchBroadcast } = require("./controllers/broadcastNotification.controller");
const { startNotificationScheduler } = require("./utils/notificationScheduler");

/* =========================================================
   APP INIT
========================================================= */
const app = express();
const server = http.createServer(app);

/* =========================================================
   ALLOWED ORIGINS (env-driven — set FRONTEND_URL / WEBSITE_URL in .env)
   Comma-separate multiple origins, e.g.:
   FRONTEND_URL=https://asumbi.vercel.app,http://localhost:5173

   These are TWO separate deployments hitting this same backend:
   FRONTEND_URL is the admin portal (Vite/React, asumbi_system_fixed/frontend).
   WEBSITE_URL is the public marketing site (Next.js, asumbi-website),
   whose ContactForm/newsletter POSTs run client-side in the visitor's
   browser — unlike its GET /api/website content fetch, which runs
   server-side and never sends an Origin header, those two DO need an
   allowed origin here or the browser blocks the response.
   e.g. WEBSITE_URL=https://asumbittc.ac.ke,http://localhost:3000
========================================================= */
const allowedOrigins = `${process.env.FRONTEND_URL || "http://localhost:5173"},${process.env.WEBSITE_URL || "http://localhost:3000"}`
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Doravo's two production domains — doravocore.co.ke is the app itself
// (this backend's real FRONTEND_URL: login, dashboards, and the "/"
// landing page), doravo.co.ke is the shorter marketing-facing domain
// (WEBSITE_URL). Hardcoded as a fallback the same way the Vercel
// project URLs below already are, so a misconfigured/missing
// FRONTEND_URL or WEBSITE_URL env var in a given deployment doesn't
// silently break login or the contact form for either domain. Update
// (or remove, once FRONTEND_URL/WEBSITE_URL are reliably set in every
// deployment's env) if these domains ever change.
const HARDCODED_PRODUCTION_ORIGINS = [
  "https://www.doravocore.co.ke",
  "https://doravocore.co.ke",
  "https://www.doravo.co.ke",
  "https://doravo.co.ke",
];

const corsOptions = {
  origin: (origin, callback) => {
    // allow non-browser tools (curl/Postman) which send no origin
    if (!origin) return callback(null, true);

    // allow explicit origins from FRONTEND_URL / WEBSITE_URL
    if (allowedOrigins.includes(origin)) return callback(null, true);

    // allow Doravo's own production domains regardless of env config —
    // see HARDCODED_PRODUCTION_ORIGINS above
    if (HARDCODED_PRODUCTION_ORIGINS.includes(origin)) return callback(null, true);

    // allow any Vercel preview/production deployment URL for this project
    // (covers both the admin portal AND the public website when both are
    // deployed under the same Vercel team/project naming pattern)
    if (/^https:\/\/asumbi(-[a-z0-9]+)?-savorscopesoln-stacks-projects\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    if (origin === "https://asumbi.vercel.app") return callback(null, true);

    callback(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

/* ================= SOCKET.IO ================= */
const io = new Server(server, {
  cors: corsOptions,
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

/* ================= MIDDLEWARE ================= */
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

/* ================= PROFILE PHOTOS (static) =================
   Files land on disk via backend/middleware/photoUpload.js under
   backend/uploads/photos; served back out from here so a stored
   photoUrl like "/uploads/photos/xyz.jpg" resolves to a real image. */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    console.log("Incoming:", req.method, req.url);
    next();
  });
}

/* ================= DB MIDDLEWARE (multi-tenant) =================
   Resolves which tenant DB this request belongs to from its JWT's
   `tenant` claim (stamped in routes/auth.js's POST /login once it finds
   which database the username actually lives in — see config/db.js
   for how tenants are declared via DB_TENANTS) and attaches that
   tenant's pool as req.pool / req.tenant.

   Logged-out requests (login itself, register, public pages) and
   tokens minted before multi-tenant support existed have no usable
   tenant claim, so they fall back to the "default" DB — exactly the
   old single-DB behavior. An invalid/expired token is deliberately
   NOT rejected here; that's still `protect`'s job on the actual
   route. This middleware only needs a best-effort tenant hint. */
app.use(async (req, res, next) => {
  let tenant = "default";

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(
        authHeader.split(" ")[1],
        process.env.JWT_SECRET || "doravo_core_secret"
      );
      if (decoded && decoded.tenant) tenant = decoded.tenant;
    } catch {
      // Invalid/expired — leave tenant as "default" and let `protect`
      // reject the request on the route itself.
    }
  }

  try {
    req.tenant = tenant;
    req.pool = await getPool(tenant);
    next();
  } catch (err) {
    console.error("DB ERROR:", err.message);
    res.status(500).json({ message: "DB connection failed" });
  }
});

/* =========================================================
   SAFE HELPERS
========================================================= */
const toInt = (val) => {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
};
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Doravo Core backend is running",
    timestamp: new Date().toISOString()
  });
});
/* =========================================================
   HEALTH CHECK (unauthenticated, for uptime monitors)
========================================================= */
app.get("/", (req, res) => {
  res.json({ status: "Server running 🚀" });
});

/* =========================================================
   ROUTERS (each of these owns its own /api/* subtree)
========================================================= */
app.use("/api/auth", authRoutes);
app.use("/api/assessments", protect, assessmentsRoutes);
app.use("/api/practicum", protect, practicumRoutes);
app.use("/api/leave-outs", protect, leaveOutRoutes);
app.use("/api/portal-pages", protect, portalPagesRoutes);
// Not wrapped in global `protect` — GET /api/website is intentionally
// public (the separate Next.js marketing site fetches it with no user
// session). The admin-only read/write routes (GET/PUT /:section) apply
// protect + requirePage("Website") internally in routes/website.js.
app.use("/api/website", websiteRoutes);
// Not wrapped in global `protect` either — GET /api/school-settings backs
// the Login screen's brand/footer and every portal's report headers
// before/regardless of role, so it's public read; writes are gated
// requirePage("School Settings") internally in routes/schoolSettings.js.
app.use("/api/school-settings", schoolSettingsRoutes);
app.use("/api/contact", contactRoutes); // public POSTs (contact form + newsletter); GET/manage routes are protected internally
app.use("/analytics", protect, analyticsRoute);
app.use("/api/register", registerRoutes);
app.use("/api/meals", protect, mealRoutes);
app.use("/api/gate", protect, gateRoutes);
app.use("/api/kitchen", protect, kitchenRoutes);
app.use("/api/attendance", protect, attendanceRoutes);
app.use("/api/e-assessments", eAssessmentRoutes); // already protects internally
app.use("/api/local-sync", localSyncRoutes); // mounted separately so it can't collide with e-assessments' /:id catch-all; protects internally (JWT for admin routes, X-Sync-Token for device routes)
app.use("/api/fees", protect, feesRoutes);
app.use("/api/leave", protect, leaveRoutes);
app.use("/api/search", protect, searchRoutes);
app.use("/api/notifications", protect, notificationsRoutes);
app.use("/api/broadcast-notifications", protect, requirePage("Notifications"), broadcastNotificationsRoutes);
// API-credential management (SMTP/Twilio) — a level above the
// "Notifications" broadcast page permission, so this is admin-only
// even for a sub_admin who was granted that page.
app.use("/api/notification-settings", protect, adminOnly, notificationSettingsRoutes);

// Student Council Voting System — router applies protect/role checks per-route internally
app.use("/api/student-council", studentCouncilRoutes);

// Student profile change-request queue — router applies protect/role
// checks per-route internally (student submit/check vs admin review).
app.use("/api/student/profile-change-requests", profileChangeRequestsRoutes);
app.use("/", metaRoutes);

// Sweeps ScheduledNotifications once a minute for anything due and sends
// it out over its configured channels (in-app / email / SMS / WhatsApp).
startNotificationScheduler(getPool, listTenantKeys, io, dispatchBroadcast);

/* =========================================================
   CLASSES
========================================================= */
app.get("/api/student-classes", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT DISTINCT studentClass
      FROM Students
      WHERE studentClass IS NOT NULL
      ORDER BY studentClass
    `);
    res.json(result.recordset);
  } catch (err) {
    console.log("CLASSES ERROR:", err);
    res.status(500).json({ message: "Failed classes" });
  }
});

/* =========================================================
   STUDENTS
========================================================= */
app.get("/api/students", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const request = pool.request();

    let query = `
      SELECT * FROM Students
      WHERE status != 'graduated'
    `;

    // ================= CLASS FILTER (parameterized) =================
    if (req.query.classLevel && req.query.classLevel !== "ALL") {
      const classes = req.query.classLevel.split(",").map((c) => c.trim());
      const paramNames = classes.map((c, i) => {
        const p = `class${i}`;
        request.input(p, sql.NVarChar, c);
        return `@${p}`;
      });
      query += ` AND studentClass IN (${paramNames.join(",")})`;
    }

    // ================= STATUS FILTER (parameterized) =================
    if (req.query.status && req.query.status !== "ALL") {
      request.input("status", sql.NVarChar, req.query.status);
      query += ` AND status = @status`;
    }

    // ================= SEARCH FILTER (parameterized) =================
    if (req.query.search) {
      request.input("search", sql.NVarChar, `%${req.query.search}%`);
      query += ` AND (name LIKE @search OR admissionNo LIKE @search)`;
    }

    const result = await request.query(query);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("STUDENTS ERROR:", err);
    res.status(500).json({ message: "Failed students" });
  }
});

/* =========================================================
   STUDENTS WITH MEALS (previously missing — frontend called
   /api/students-with-meals but no backend route existed)
========================================================= */
app.get("/api/students-with-meals", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT
        s.id, s.name, s.admissionNo, s.studentClass, s.gender, s.status,
        mc.id AS mealCardId, mc.card_number, mc.meals_per_day,
        mc.meals_remaining, mc.status AS mealCardStatus
      FROM Students s
      LEFT JOIN meal_cards mc ON mc.student_id = s.id
      WHERE s.status = 'active'
      ORDER BY s.name
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("STUDENTS WITH MEALS ERROR:", err);
    res.status(500).json([]);
  }
});

/* =========================================================
   SUBJECTS
========================================================= */
app.get("/api/subjects", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const request = pool.request();

    let query = `
      SELECT id, name
      FROM Subjects
      WHERE name IS NOT NULL
    `;

    if (req.query.search) {
      request.input("search", sql.NVarChar, `%${req.query.search}%`);
      query += ` AND name LIKE @search`;
    }

    query += ` ORDER BY name`;

    const result = await request.query(query);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("SUBJECTS ERROR:", err);
    res.status(500).json({ message: "Failed subjects" });
  }
});

/* =========================================================
   RECORDS (admin only — this drives raw record editing)

   Generalized to work against ANY base table in the DB, not just
   Students/Teachers/Users. mssql can't parameterize identifiers
   (table/column names), so every identifier that ends up inside a
   query string is first checked against a live read of
   INFORMATION_SCHEMA — the client's string is only ever used to
   look up a real name, never interpolated directly.
========================================================= */

// Short aliases kept for backward compatibility with the original
// three record types (and with the separate bulk-import endpoint,
// which still expects these exact lowercase strings). Any other
// real table name can also be passed directly, matched case-
// insensitively against the live schema.
const RECORD_TABLE_ALIASES = { teachers: "Teachers", users: "Users", students: "Students" };

// Column NAME patterns that must never reach the client, or be
// written to, regardless of table.
const RECORD_SENSITIVE_COLUMN_PATTERN = /password|secret|token|apikey|api_key/i;

// Tables the data manager will never expose, even to an admin —
// pure internal bookkeeping.
const RECORD_TABLE_BLOCKLIST = new Set(["sysdiagrams"]);

const TEXT_COLUMN_TYPES = new Set(["char", "varchar", "nchar", "nvarchar", "text", "ntext"]);

// Schema reads are cached for a minute at a time — long enough to
// avoid hitting INFORMATION_SCHEMA on every request, short enough
// that a migration run while the server is up is picked up without
// a restart.
const SCHEMA_CACHE_TTL_MS = 60_000;
const recordTablesCache = new Map(); // pool -> { list, expires }
const recordColumnsCache = new Map(); // "pool|table" -> { columns, expires }
const primaryKeyCache = new Map(); // "pool|table" -> { pk, expires }
const identityColumnCache = new Map(); // "pool|table" -> { identity, expires }

async function getAllTableNames(pool) {
  const cached = recordTablesCache.get(pool);
  if (cached && Date.now() < cached.expires) return cached.list;

  const result = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);

  const list = result.recordset
    .map((r) => r.TABLE_NAME)
    .filter((n) => !RECORD_TABLE_BLOCKLIST.has(n.toLowerCase()));

  recordTablesCache.set(pool, { list, expires: Date.now() + SCHEMA_CACHE_TTL_MS });
  return list;
}

// Resolves whatever the client sent ("students", "Students", or any
// other real table name) to the table's exact, canonical name as it
// exists in the live schema — or null if nothing matches. This is
// the only place a client-supplied table "name" is allowed to turn
// into something usable in a query.
async function resolveTableName(pool, requested) {
  if (!requested) return null;
  const alias = RECORD_TABLE_ALIASES[String(requested).toLowerCase()];
  if (alias) return alias;

  const tables = await getAllTableNames(pool);
  return tables.find((t) => t.toLowerCase() === String(requested).toLowerCase()) || null;
}

// Per-table column list + type, discovered from the DB schema itself
// (via INFORMATION_SCHEMA.COLUMNS) rather than hand-maintained, so a
// column added to any table later shows up automatically. `table`
// here is always an already-resolved, real table name.
async function getRecordColumnInfo(pool, table) {
  const key = `${table}`;
  const cached = recordColumnsCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.columns;

  const result = await pool
    .request()
    .input("table", sql.NVarChar, table)
    .query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @table
      ORDER BY ORDINAL_POSITION
    `);

  const columns = result.recordset.map((r) => ({ name: r.COLUMN_NAME, type: r.DATA_TYPE }));
  recordColumnsCache.set(key, { columns, expires: Date.now() + SCHEMA_CACHE_TTL_MS });
  return columns;
}

// Column names safe to send to the client / accept edits on for this
// table (sensitive columns like password hashes are stripped either
// way).
async function getRecordColumns(pool, table) {
  const info = await getRecordColumnInfo(pool, table);
  return info.filter((c) => !RECORD_SENSITIVE_COLUMN_PATTERN.test(c.name)).map((c) => c.name);
}

// Discovers the table's single-column primary key so row-level
// update/delete works generically. Falls back to "id" (the
// convention every table in this app already follows) when a table
// has no primary key constraint or a composite one.
async function getPrimaryKeyColumn(pool, table) {
  const key = `${table}`;
  const cached = primaryKeyCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.pk;

  const result = await pool
    .request()
    .input("table", sql.NVarChar, table)
    .query(`
      SELECT KU.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KU
        ON TC.CONSTRAINT_NAME = KU.CONSTRAINT_NAME
        AND TC.TABLE_NAME = KU.TABLE_NAME
      WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY' AND TC.TABLE_NAME = @table
      ORDER BY KU.ORDINAL_POSITION
    `);

  const pk = result.recordset.length === 1 ? result.recordset[0].COLUMN_NAME : "id";
  primaryKeyCache.set(key, { pk, expires: Date.now() + SCHEMA_CACHE_TTL_MS });
  return pk;
}

// Discovers whether the table has an IDENTITY (auto-increment) column,
// so the "add record" form knows to leave that column out of the
// INSERT (and out of the form itself) rather than letting the client
// supply a value SQL Server will reject.
async function getIdentityColumn(pool, table) {
  const key = `${table}`;
  const cached = identityColumnCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.identity;

  const result = await pool
    .request()
    .input("table", sql.NVarChar, table)
    .query(`
      SELECT c.name AS COLUMN_NAME
      FROM sys.identity_columns c
      JOIN sys.tables t ON c.object_id = t.object_id
      WHERE t.name = @table
    `);

  const identity = result.recordset.length ? result.recordset[0].COLUMN_NAME : null;
  identityColumnCache.set(key, { identity, expires: Date.now() + SCHEMA_CACHE_TTL_MS });
  return identity;
}

/* -------- list every table the Data Manager can open -------- */
app.get("/api/records/tables", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const tables = await getAllTableNames(pool);
    res.json({ tables });
  } catch (err) {
    console.log("RECORD TABLES ERROR:", err);
    res.status(500).json({ message: "Failed to list tables" });
  }
});

/* -------- read rows from any table, with optional search -------- */
app.get("/api/records", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const requestedTable = req.query.type || req.query.table;
    const table = await resolveTableName(pool, requestedTable);
    if (!table) {
      return res.status(400).json({ message: `Unknown table "${requestedTable || ""}"` });
    }

    const columns = await getRecordColumns(pool, table);
    if (!columns.length) {
      return res.status(500).json({ message: `No columns found for ${table}` });
    }

    const pk = await getPrimaryKeyColumn(pool, table);
    const orderCol = columns.includes(pk) ? pk : columns[0];

    const dbRequest = pool.request();
    let query = `SELECT ${columns.map((c) => `[${c}]`).join(", ")} FROM [${table}]`;

    const search = (req.query.search || req.query.q || "").trim();
    if (search) {
      const columnInfo = await getRecordColumnInfo(pool, table);
      const textCols = columnInfo.filter(
        (c) => !RECORD_SENSITIVE_COLUMN_PATTERN.test(c.name) && TEXT_COLUMN_TYPES.has(c.type.toLowerCase())
      );
      if (textCols.length) {
        dbRequest.input("search", sql.NVarChar, `%${search}%`);
        query += ` WHERE ` + textCols.map((c) => `[${c.name}] LIKE @search`).join(" OR ");
      }
    }

    query += ` ORDER BY [${orderCol}]`;

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 2000);
    query += ` OFFSET ${(page - 1) * limit} ROWS FETCH NEXT ${limit} ROWS ONLY`;

    const result = await dbRequest.query(query);
    const identityColumn = await getIdentityColumn(pool, table);
    res.json({ records: result.recordset, table, columns, primaryKey: pk, identityColumn });
  } catch (err) {
    console.log("RECORDS ERROR:", err);
    res.status(500).json({ message: "Records failed" });
  }
});

/* =========================================================
   CREATE RECORD (admin only)
   Generic insert for any table the Data Manager can see — mirrors
   /api/update-records but builds an INSERT instead of an UPDATE.
   The table's IDENTITY column (if any) is always left out of the
   statement so SQL Server assigns it; every other writable column
   the client actually sent is included, so a partially-filled form
   still works (unsent columns fall back to the column's own default
   / NULL).
========================================================= */
app.post("/api/records/create", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const requestedTable = req.body.type || req.body.table;
    const table = await resolveTableName(pool, requestedTable);
    if (!table) {
      return res.status(400).json({ message: `Unknown table "${requestedTable || ""}"` });
    }

    const data = req.body.data && typeof req.body.data === "object" ? req.body.data : {};

    const identityColumn = await getIdentityColumn(pool, table);
    const columnInfo = await getRecordColumnInfo(pool, table);
    const writableColumns = new Set(
      columnInfo
        .filter((c) => !RECORD_SENSITIVE_COLUMN_PATTERN.test(c.name) && c.name !== identityColumn)
        .map((c) => c.name)
    );

    const insertCols = Object.keys(data).filter(
      (k) => writableColumns.has(k) && data[k] !== "" && data[k] !== undefined
    );

    if (!insertCols.length) {
      return res.status(400).json({ message: "No fields to insert" });
    }

    const dbRequest = pool.request();
    insertCols.forEach((col, i) => dbRequest.input(`c${i}`, data[col]));

    const colList = insertCols.map((c) => `[${c}]`).join(", ");
    const valList = insertCols.map((c, i) => `@c${i}`).join(", ");

    const result = await dbRequest.query(`
      INSERT INTO [${table}] (${colList})
      OUTPUT INSERTED.*
      VALUES (${valList})
    `);

    res.json({ message: "Record created successfully", record: result.recordset?.[0] || null });
  } catch (err) {
    console.log("CREATE RECORD ERROR:", err);
    res.status(500).json({ message: err.message || "Create failed" });
  }
});

/* =========================================================
   UPDATE RECORDS (admin only)
   Builds the SET clause dynamically from whatever columns are
   present on each submitted row AND actually exist (and are
   writable) on the resolved table — so it works for any table's
   shape without a hand-maintained per-table field list. Only
   columns the client actually sent are touched; anything the row
   doesn't mention is left alone in the DB.
========================================================= */
app.post("/api/update-records", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const requestedTable = req.body.type || req.body.table;
    const table = await resolveTableName(pool, requestedTable);
    if (!table) {
      return res.status(400).json({ message: `Unknown table "${requestedTable || ""}"` });
    }

    const { data } = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ message: "data must be an array" });
    }

    const pk = await getPrimaryKeyColumn(pool, table);
    const columnInfo = await getRecordColumnInfo(pool, table);
    const writableColumns = new Set(
      columnInfo
        .filter((c) => !RECORD_SENSITIVE_COLUMN_PATTERN.test(c.name) && c.name !== pk)
        .map((c) => c.name)
    );

    let updated = 0;
    for (const row of data) {
      const pkValue = row[pk];
      if (pkValue === undefined || pkValue === null || pkValue === "") continue;

      const setCols = Object.keys(row).filter((k) => writableColumns.has(k));
      if (!setCols.length) continue;

      const dbRequest = pool.request();
      dbRequest.input("pkValue", pkValue);
      setCols.forEach((col, i) => dbRequest.input(`c${i}`, row[col]));

      const setClause = setCols.map((col, i) => `[${col}] = @c${i}`).join(", ");
      await dbRequest.query(`UPDATE [${table}] SET ${setClause} WHERE [${pk}] = @pkValue`);
      updated++;
    }

    res.json({ message: `Updated ${updated} record${updated === 1 ? "" : "s"} successfully` });
  } catch (err) {
    console.log("UPDATE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

/* =========================================================
   DELETE RECORDS (admin only)
========================================================= */
app.post("/api/update-records/delete", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const requestedTable = req.body.type || req.body.table;
    const table = await resolveTableName(pool, requestedTable);
    if (!table) {
      return res.status(400).json({ message: `Unknown table "${requestedTable || ""}"` });
    }

    const { id } = req.body;
    if (id === undefined || id === null || id === "") {
      return res.status(400).json({ message: "Invalid id" });
    }

    const pk = await getPrimaryKeyColumn(pool, table);
    await pool.request().input("id", id).query(`DELETE FROM [${table}] WHERE [${pk}] = @id`);
    res.json({ message: "Deleted" });
  } catch (err) {
    console.log("DELETE ERROR:", err);
    res.status(500).json({ message: "Delete failed" });
  }
});

/* =========================================================
   STATS
========================================================= */
app.get("/api/stats", protect, async (req, res) => {
  try {
    const pool = req.pool;

    const students = await pool.request().query(`SELECT COUNT(*) c FROM Students`);
    const teachers = await pool.request().query(`SELECT COUNT(*) c FROM Teachers`);
    const users = await pool.request().query(`SELECT COUNT(*) c FROM Users`);
    const active = await pool.request().query(`SELECT COUNT(*) c FROM Students WHERE status='active'`);
    const grads = await pool.request().query(`SELECT COUNT(*) c FROM Graduations`);

    res.json({
      students: students.recordset[0].c,
      teachers: teachers.recordset[0].c,
      users: users.recordset[0].c,
      activeStudents: active.recordset[0].c,
      graduates: grads.recordset[0].c,
      roles: [],
    });
  } catch (err) {
    console.log("STATS ERROR:", err);
    res.status(500).json({ message: "Stats failed" });
  }
});

/* =========================================================
   GRADUATIONS
========================================================= */
app.get("/api/graduations", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT * FROM Graduations ORDER BY graduationYear DESC`);
    res.json({ data: result.recordset });
  } catch (err) {
    console.log("GRADUATIONS ERROR:", err);
    res.status(500).json({ message: "Graduations failed" });
  }
});

/* =========================================================
   PROMOTE YEARS (admin only, destructive-ish bulk op)
========================================================= */
app.post("/api/promote-years", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;

    const grads = await pool.request().query(`SELECT * FROM Students WHERE yearOfStudy = 3`);

    for (const s of grads.recordset) {
      const exists = await pool
        .request()
        .input("studentId", sql.Int, s.id)
        .query(`SELECT TOP 1 id FROM Graduations WHERE studentId = @studentId`);

      if (exists.recordset.length === 0) {
        await pool
          .request()
          .input("studentId", sql.Int, s.id)
          .input("name", sql.NVarChar, s.name)
          .input("admissionNo", sql.NVarChar, s.admissionNo)
          .input("studentClass", sql.NVarChar, s.studentClass)
          .input("graduationYear", sql.Int, new Date().getFullYear())
          .query(`
            INSERT INTO Graduations (studentId, name, admissionNo, studentClass, graduationYear)
            VALUES (@studentId, @name, @admissionNo, @studentClass, @graduationYear)
          `);
      }

      await pool
        .request()
        .input("id", sql.Int, s.id)
        .query(`UPDATE Students SET status = 'graduated' WHERE id = @id`);
    }

    res.json({ message: "Promotion complete", promoted: grads.recordset.length });
  } catch (err) {
    console.log("PROMOTE YEARS ERROR:", err);
    res.status(500).json({ message: "Promotion failed" });
  }
});

/* =========================================================
   UPLOAD (admin only — bulk-inserts accounts with default password)
========================================================= */
app.post("/api/upload", protect, adminOnly, upload.single("file"), async (req, res) => {
  try {
    const pool = req.pool;
    const type = req.body.type;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (type === "students") {
      for (const row of rows) {
        const name = (row.name || "").toString().trim();
        const admissionNo = (row.admissionNo || "").toString().trim();
        if (!name || !admissionNo) continue;

        const studentClass = (row.studentClass || row.class || "A").toString().toUpperCase();
        const gender = (row.gender || "Unknown").toString();
        const status = (row.status || "active").toString().toLowerCase();
        const yearOfStudy = parseInt(row.yearOfStudy) || 1;
        const username = admissionNo;
        const password = await bcrypt.hash("1234", 10);

        await pool
          .request()
          .input("name", sql.NVarChar, name)
          .input("admissionNo", sql.NVarChar, admissionNo)
          .input("studentClass", sql.NVarChar, studentClass)
          .input("gender", sql.NVarChar, gender)
          .input("status", sql.NVarChar, status)
          .input("yearOfStudy", sql.Int, yearOfStudy)
          .input("username", sql.NVarChar, username)
          .input("password", sql.NVarChar, password)
          .input("role", sql.NVarChar, "student")
          .input("assessmentNumber", sql.NVarChar, row.assessmentNumber || null)
          .input("Phone", sql.NVarChar, (row.phone || "").toString().trim())
          .query(`
            INSERT INTO Students
            (name, admissionNo, studentClass, gender, status, yearOfStudy, username, password, role, Phone, mustChangePassword)
            VALUES
            (@name, @admissionNo, @studentClass, @gender, @status, @yearOfStudy, @username, @password, @role, @Phone, 1)
          `);
      }
    }

    if (type === "teachers") {
      for (const row of rows) {
        const name = (row.name || "").toString().trim();
        const staffId = (row.staffId || "").toString().trim();
        const subject = (row.subject || "General").toString();
        const phone = (row.phone || "").toString().trim();
        const email = row.email || null;
        if (!name || !staffId) continue;

        const cleanPhone = phone.startsWith("07") ? "+254" + phone.substring(1) : phone;
        const username = staffId;
        const password = await bcrypt.hash("1234", 10);

        await pool
          .request()
          .input("name", sql.NVarChar, name)
          .input("staffId", sql.NVarChar, staffId)
          .input("subject", sql.NVarChar, subject)
          .input("phone", sql.NVarChar, cleanPhone)
          .input("email", sql.NVarChar, email)
          .input("username", sql.NVarChar, username)
          .input("password", sql.NVarChar, password)
          .input("role", sql.NVarChar, "teacher")
          .query(`
            INSERT INTO Teachers (name, staffId, subject, phone, email, username, password, role, mustChangePassword)
            VALUES (@name, @staffId, @subject, @phone, @email, @username, @password, @role, 1)
          `);
      }
    }

    if (type === "users") {
      for (const row of rows) {
        const hashedPassword = await bcrypt.hash(row.password || "1234", 10);
        await pool
          .request()
          .input("username", sql.NVarChar, row.username || "")
          .input("role", sql.NVarChar, row.role || "user")
          .input("email", sql.NVarChar, row.email || "")
          .input("password", sql.NVarChar, hashedPassword)
          .query(`
            INSERT INTO Users (username, role, email, password, mustChangePassword)
            VALUES (@username, @role, @email, @password, 1)
          `);
      }
    }

    res.json({ message: "Upload successful", type, inserted: rows.length });
  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

/* =========================================================
   MARKS
========================================================= */
app.get("/api/marks/:assessmentId", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);
    const subjectId = toInt(req.query.subjectId);
    if (!assessmentId) return res.json([]);

    let query = `
      SELECT studentId, subjectId, score, percentage, grade
      FROM Marks
      WHERE assessmentId = @assessmentId
    `;
    const request = pool.request().input("assessmentId", sql.Int, assessmentId);

    if (subjectId) {
      query += ` AND subjectId = @subjectId`;
      request.input("subjectId", sql.Int, subjectId);
    }

    const result = await request.query(query);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("MARKS FETCH ERROR:", err);
    res.status(500).json([]);
  }
});

app.get("/api/student/marks", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = toInt(req.query.studentId);
    if (!studentId) return res.status(400).json({ message: "studentId required" });

    const result = await pool
      .request()
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT s.name AS subjectName, m.score, m.percentage, m.grade
        FROM Marks m
        JOIN Subjects s ON s.id = m.subjectId
        WHERE m.studentId = @studentId
      `);

    res.json(result.recordset);
  } catch (err) {
    console.log("STUDENT MARKS ERROR:", err);
    res.status(500).json([]);
  }
});

app.get("/api/student/profile", protect, async (req, res) => {
  try {
    const pool = req.pool;
    // A logged-in student's own id from their token is the normal case;
    // ?studentId= stays supported for an admin/teacher looking someone up.
    const studentId = toInt(req.query.studentId) || req.user.id;

    const result = await pool
      .request()
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT id, name, admissionNo, studentClass, gender, yearOfStudy, status,
               email, phone, assessmentNumber, photoUrl, profileCompleted
        FROM Students
        WHERE id = @studentId
      `);

    res.json(result.recordset[0] || {});
  } catch (err) {
    console.log("STUDENT PROFILE ERROR:", err);
    res.status(500).json({});
  }
});

/* =========================================================
   STUDENT PROFILE — SELF-SERVICE UPDATE (FIRST TIME ONLY)
   A student can fill in every column on their own Students row
   EXCEPT name and admissionNo (those stay staff-managed, set at
   registration) — but only the very first time, right after their
   forced password change. Always acts on the logged-in student's
   own id from the token — never a studentId in the body — so one
   student can never edit another's record through this endpoint.

   Any save AFTER the first one is rejected here (409) and must go
   through POST /api/student/profile-change-requests instead, which
   queues it for admin approval rather than applying it directly —
   see routes/profileChangeRequests.js.

   This first save is also what flips profileCompleted to 1, which
   clears the "complete your profile" step enforced right after a
   student's first password change (see authMiddleware.js) — and
   from that point on is exactly the flag that routes every future
   save into the approval queue above.
========================================================= */
app.put("/api/student/profile", protect, authorize("student"), async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = req.user.id;

    const existing = await pool
      .request()
      .input("id", sql.Int, studentId)
      .query(`SELECT profileCompleted FROM Students WHERE id = @id`);

    if (existing.recordset[0]?.profileCompleted) {
      return res.status(409).json({
        code: "PROFILE_ALREADY_COMPLETED",
        message:
          "Your profile is already set up. Further changes need admin approval — submit a change request instead.",
      });
    }

    let { studentClass, gender, email, phone, assessmentNumber } = req.body;

    studentClass = (studentClass || "").toString().trim();
    gender = (gender || "").toString().trim();
    email = (email || "").toString().trim();
    phone = (phone || "").toString().trim();
    assessmentNumber = (assessmentNumber || "").toString().trim();

    if (!studentClass || !gender || !email || !phone) {
      return res.status(400).json({
        message: "Class, gender, email, and phone are required",
      });
    }

    // Same "0xxxxxxxxx" -> "+254xxxxxxxxx" normalization used
    // everywhere else students'/teachers' phone numbers are saved.
    let cleanPhone = phone;
    if (cleanPhone.startsWith("0")) {
      cleanPhone = "+254" + cleanPhone.substring(1);
    }

    await pool
      .request()
      .input("id", sql.Int, studentId)
      .input("studentClass", sql.NVarChar, studentClass)
      .input("gender", sql.NVarChar, gender)
      .input("email", sql.NVarChar, email)
      .input("phone", sql.NVarChar, cleanPhone)
      .input("assessmentNumber", sql.NVarChar, assessmentNumber || null)
      .query(`
        UPDATE Students
        SET studentClass = @studentClass,
            gender = @gender,
            email = @email,
            phone = @phone,
            assessmentNumber = @assessmentNumber,
            profileCompleted = 1
        WHERE id = @id
      `);

    const updated = await pool
      .request()
      .input("id", sql.Int, studentId)
      .query(`
        SELECT id, name, admissionNo, studentClass, gender, yearOfStudy, status,
               email, phone, assessmentNumber, photoUrl, profileCompleted
        FROM Students
        WHERE id = @id
      `);

    const profile = updated.recordset[0] || {};

    /* ================= REISSUE TOKEN =================
       Same reasoning as change-password: the token the student is
       currently using still has profileIncomplete: true baked in
       from login, and `protect` reads that straight off the token —
       so a fresh one (with the flag cleared) has to go back to the
       frontend for every route to unblock immediately. */
    const newToken = jwt.sign(
      {
        id: profile.id,
        username: req.user.username,
        role: req.user.role,
        permissions: req.user.permissions,
        source: req.user.source,
        mustChangePassword: false,
        profileIncomplete: false,
      },
      process.env.JWT_SECRET || "doravo_core_secret",
      { expiresIn: "1d" }
    );

    res.json({
      message: "Profile updated",
      token: newToken,
      profile,
      user: {
        id: profile.id,
        username: req.user.username,
        name: profile.name || "",
        role: req.user.role,
        permissions: req.user.permissions,
        source: req.user.source,
        photoUrl: profile.photoUrl || null,
        mustChangePassword: false,
        profileIncomplete: false,
      },
    });
  } catch (err) {
    console.log("STUDENT PROFILE UPDATE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   TEACHER PROFILE (mirrors /api/student/profile above)
========================================================= */
app.get("/api/teacher/profile", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const teacherId = toInt(req.query.teacherId) || req.user.id;

    const result = await pool
      .request()
      .input("teacherId", sql.Int, teacherId)
      .query(`
        SELECT id, name, staffId, subject, phone, email, status, photoUrl
        FROM Teachers
        WHERE id = @teacherId
      `);

    res.json(result.recordset[0] || {});
  } catch (err) {
    console.log("TEACHER PROFILE ERROR:", err);
    res.status(500).json({});
  }
});

/* =========================================================
   PROFILE PHOTO — SELF-SERVICE UPLOAD/REPLACE
   Student or teacher uploads/replaces their own photo from
   their profile page. The old file (if any) is cleaned up
   after the DB row is updated to point at the new one.
========================================================= */
app.put("/api/student/profile/photo", protect, authorize("student"), async (req, res) => {
  let uploaded;
  try {
    await runPhotoUpload(req, res);
    uploaded = req.file;
  } catch (err) {
    return res.status(400).json({ message: err.message || "Photo upload failed" });
  }

  try {
    if (!uploaded) {
      return res.status(400).json({ message: "No photo file received" });
    }

    const pool = req.pool;
    const photoUrl = photoUrlFor(uploaded.filename);

    const existing = await pool
      .request()
      .input("id", sql.Int, req.user.id)
      .query(`SELECT photoUrl FROM Students WHERE id = @id`);

    await pool
      .request()
      .input("id", sql.Int, req.user.id)
      .input("photoUrl", sql.NVarChar, photoUrl)
      .query(`UPDATE Students SET photoUrl = @photoUrl WHERE id = @id`);

    const oldPhotoUrl = existing.recordset[0]?.photoUrl;
    if (oldPhotoUrl) deletePhotoByUrl(oldPhotoUrl);

    res.json({ message: "Profile photo updated", photoUrl });
  } catch (err) {
    deletePhotoByUrl(uploaded.path);
    console.log("STUDENT PHOTO UPLOAD ERROR:", err);
    res.status(500).json({ message: "Photo upload failed" });
  }
});

app.put("/api/teacher/profile/photo", protect, authorize("teacher"), async (req, res) => {
  let uploaded;
  try {
    await runPhotoUpload(req, res);
    uploaded = req.file;
  } catch (err) {
    return res.status(400).json({ message: err.message || "Photo upload failed" });
  }

  try {
    if (!uploaded) {
      return res.status(400).json({ message: "No photo file received" });
    }

    const pool = req.pool;
    const photoUrl = photoUrlFor(uploaded.filename);

    const existing = await pool
      .request()
      .input("id", sql.Int, req.user.id)
      .query(`SELECT photoUrl FROM Teachers WHERE id = @id`);

    await pool
      .request()
      .input("id", sql.Int, req.user.id)
      .input("photoUrl", sql.NVarChar, photoUrl)
      .query(`UPDATE Teachers SET photoUrl = @photoUrl WHERE id = @id`);

    const oldPhotoUrl = existing.recordset[0]?.photoUrl;
    if (oldPhotoUrl) deletePhotoByUrl(oldPhotoUrl);

    res.json({ message: "Profile photo updated", photoUrl });
  } catch (err) {
    deletePhotoByUrl(uploaded.path);
    console.log("TEACHER PHOTO UPLOAD ERROR:", err);
    res.status(500).json({ message: "Photo upload failed" });
  }
});

app.get("/api/student/summary", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = toInt(req.query.studentId);

    const result = await pool
      .request()
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT AVG(percentage) AS average, COUNT(*) AS totalSubjects
        FROM Marks
        WHERE studentId = @studentId
      `);

    const data = result.recordset[0];
    let grade = "Fail";
    if (data.average >= 75) grade = "Distinction";
    else if (data.average >= 60) grade = "Credit";
    else if (data.average >= 40) grade = "Pass";

    res.json({ average: data.average || 0, totalSubjects: data.totalSubjects || 0, grade });
  } catch (err) {
    console.log("STUDENT SUMMARY ERROR:", err);
    res.status(500).json({});
  }
});

app.post("/api/marks/save", protect, authorize("teacher", "admin"), async (req, res) => {
  try {
    const pool = req.pool;
    const { assessmentId, data, subjectId } = req.body;
    const aId = toInt(assessmentId);

    if (!aId || !Array.isArray(data)) {
      return res.status(400).json({ message: "Invalid payload" });
    }
    if (!subjectId) {
      return res.status(400).json({ message: "subjectId is required" });
    }

    const aRes = await pool
      .request()
      .input("assessmentId", sql.Int, aId)
      .query(`SELECT totalMarks FROM Assessments WHERE id = @assessmentId`);
    const max = aRes.recordset?.[0]?.totalMarks || 100;

    const getGrade = (p) => {
      if (p >= 75) return "Distinction";
      if (p >= 60) return "Credit";
      if (p >= 40) return "Pass";
      return "Fail";
    };

    for (const m of data) {
      const studentId = toInt(m.studentId);
      const subId = toInt(m.subjectId || subjectId);
      const score = Number(m.rawScore || 0);
      if (!studentId || !subId) continue;

      const percentage = (score / max) * 100;
      const grade = getGrade(percentage);

      await pool
        .request()
        .input("studentId", sql.Int, studentId)
        .input("assessmentId", sql.Int, aId)
        .input("subjectId", sql.Int, subId)
        .input("score", sql.Float, score)
        .input("percentage", sql.Float, percentage)
        .input("grade", sql.NVarChar, grade)
        .query(`
          IF EXISTS (
            SELECT 1 FROM Marks
            WHERE studentId=@studentId AND assessmentId=@assessmentId AND subjectId=@subjectId
          )
          BEGIN
            UPDATE Marks SET score=@score, percentage=@percentage, grade=@grade
            WHERE studentId=@studentId AND assessmentId=@assessmentId AND subjectId=@subjectId
          END
          ELSE
          BEGIN
            INSERT INTO Marks (studentId, assessmentId, subjectId, score, percentage, grade)
            VALUES (@studentId, @assessmentId, @subjectId, @score, @percentage, @grade)
          END
        `);
    }

    res.json({ message: "Marks saved successfully" });
  } catch (err) {
    console.error("MARKS SAVE ERROR:", err);
    res.status(500).json({ message: "Marks save failed", error: err.message });
  }
});

app.post(
  "/api/assessment-students/save",
  protect,
  authorize("teacher", "admin"),
  async (req, res) => {
    try {
      const pool = req.pool;
      let { assessmentId, students } = req.body;

      if (!assessmentId || !Array.isArray(students)) {
        return res.status(400).json({ message: "Invalid data" });
      }

      const aId = toInt(assessmentId);
      if (!aId) return res.status(400).json({ message: "Invalid assessmentId" });

      students = [...new Set(students)].map(toInt).filter((id) => id);

      const transaction = pool.transaction();
      await transaction.begin();

      try {
        await transaction
          .request()
          .input("assessmentId", sql.Int, aId)
          .query(`DELETE FROM AssessmentStudents WHERE assessmentId = @assessmentId`);

        for (const studentId of students) {
          await transaction
            .request()
            .input("assessmentId", sql.Int, aId)
            .input("studentId", sql.Int, studentId)
            .query(`
              INSERT INTO AssessmentStudents (assessmentId, studentId)
              VALUES (@assessmentId, @studentId)
            `);
        }

        await transaction.commit();
        res.json({ message: "Assessment students saved successfully" });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    } catch (err) {
      console.log("ASSESSMENT STUDENTS ERROR:", err);
      res.status(500).json({ message: "Failed to save assessment students" });
    }
  }
);

/* =========================================================
   MARKS FILTER (fixed: was raw string interpolation — SQLi)
========================================================= */
app.get("/api/marks/filter", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.query.assessmentId) || 0;
    const classLevel = req.query.class;

    const request = pool.request().input("assessmentId", sql.Int, assessmentId);
    let query = `
      SELECT m.studentId, m.score AS rawScore, m.percentage, m.grade
      FROM Marks m
      JOIN Students s ON m.studentId = s.id
      WHERE m.assessmentId = @assessmentId
    `;

    if (classLevel) {
      request.input("classLevel", sql.NVarChar, classLevel);
      query += ` AND s.studentClass = @classLevel`;
    }

    const result = await request.query(query);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("MARKS FILTER ERROR:", err);
    res.status(500).json([]);
  }
});

/* =========================================================
   CLASSES / STUDENTS / SUBJECTS FROM ASSESSMENT
   (fixed: parameterized — was raw string interpolation)
========================================================= */
app.get("/api/assessment-classes/:assessmentId", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);

    const result = await pool
      .request()
      .input("assessmentId", sql.Int, assessmentId)
      .query(`
        SELECT DISTINCT s.studentClass
        FROM AssessmentStudents ast
        JOIN Students s ON ast.studentId = s.id
        WHERE ast.assessmentId = @assessmentId
        ORDER BY s.studentClass
      `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log("ASSESSMENT CLASSES ERROR:", err);
    res.status(500).json([]);
  }
});

app.get("/api/assessment-students/:assessmentId", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);
    const classLevel = req.query.classLevel;

    const request = pool.request().input("assessmentId", sql.Int, assessmentId);
    let query = `
      SELECT s.id, s.name, s.studentClass
      FROM AssessmentStudents ast
      JOIN Students s ON ast.studentId = s.id
      WHERE ast.assessmentId = @assessmentId
    `;

    if (classLevel) {
      request.input("classLevel", sql.NVarChar, classLevel);
      query += ` AND s.studentClass = @classLevel`;
    }

    const result = await request.query(query);
    res.json(result.recordset || []);
  } catch (err) {
    console.log("ASSESSMENT STUDENTS ERROR:", err);
    res.status(500).json([]);
  }
});

app.get("/api/assessment-subjects/:assessmentId", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.assessmentId);

    const result = await pool
      .request()
      .input("assessmentId", sql.Int, id)
      .query(`
        SELECT s.id, s.name
        FROM AssessmentStudents ast
        JOIN Subjects s ON s.id IS NOT NULL
        WHERE ast.assessmentId = @assessmentId
      `);

    res.json(result.recordset || []);
  } catch (err) {
    console.log("ASSESSMENT SUBJECTS ERROR:", err);
    res.status(500).json([]);
  }
});

/* =========================================================
   TEACHERS / USERS
========================================================= */
app.get("/api/teachers", protect, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name FROM Teachers`);
    res.json(result.recordset);
  } catch (err) {
    console.log("TEACHERS ERROR:", err);
    res.status(500).json([]);
  }
});

app.get("/api/users", protect, requirePage("Users"), async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT id, username, email, role, permissions FROM Users
    `);

    const rows = (result.recordset || []).map((row) => {
      let permissions = [];
      try {
        permissions = JSON.parse(row.permissions || "[]");
        if (!Array.isArray(permissions)) permissions = [];
      } catch {
        permissions = [];
      }
      return { ...row, permissions };
    });

    res.json(rows);
  } catch (err) {
    console.log("USERS ERROR:", err);
    res.status(500).json([]);
  }
});

/* =========================================================
   START SERVER
========================================================= */
const PORT = process.env.PORT || 5000;
// Explicit backlog: the new WARN[...]/"actively refused" failures seen in
// the 900-VU-at-once k6 debug run are OS-level TCP connection refusals,
// NOT the DB pool (no DB_BUSY/503s showed up in that run's checks, and
// exam-login's own duration/latency was reasonable whenever it did reach
// Express). That points at the *listen backlog* — the queue of pending
// TCP connections the OS holds while Node's event loop catches up.
// Node's default (no second arg to .listen) delegates to libuv's default
// backlog of 511; against a burst of 900 near-simultaneous connection
// attempts that's not enough headroom, and on Windows specifically a
// full backlog queue causes an immediate RST ("actively refused") rather
// than the SYN just being silently queued/dropped as on Linux.
//
// Raising this is cheap and has no functional downside — it only widens
// the queue of *already-established-at-the-TCP-level* connections
// waiting for Node to accept() them; it doesn't change app behavior.
// NOTE: on Windows, the effective backlog Winsock will actually honor is
// capped well below whatever you request here (historically ~200),
// so this helps but isn't a full fix for a Windows-hosted server taking
// a 900-at-once burst — see the accompanying report for the OS-level
// follow-up options (and note staging here is Windows; confirm your
// actual production OS before assuming this alone is sufficient).
const LISTEN_BACKLOG = process.env.LISTEN_BACKLOG
  ? parseInt(process.env.LISTEN_BACKLOG, 10)
  : 1024;
async function startServer() {
  console.log("⏳ Waiting for tenant DB schema checks before accepting traffic...");
  await Promise.allSettled(schemaReadyPromises);
  console.log("✅ Schema checks settled — starting server.");

  server.listen(PORT, LISTEN_BACKLOG, () => {
    console.log(`Server running on port ${PORT} (listen backlog ${LISTEN_BACKLOG})`);
  });
}

startServer();