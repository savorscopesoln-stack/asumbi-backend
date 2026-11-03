/* =========================================================================
   TENANT MODULES (ENTITLEMENTS)  — decision D-001

   One table per tenant database, `tenant_modules`, says which separately
   licensed modules (today: "lms") a school may use and which sellable
   feature flags inside them. Written ONLY by the finance endpoints
   (routes/finance.js, financeOnly — no admin bypass) and hidden from the
   admin raw-record editor (RECORD_TABLE_BLOCKLIST in server.js), exactly
   like tenant_license.

   Unlike trialGate (which fails OPEN), the module gate fails CLOSED: if
   the table cannot be read, the module is treated as NOT licensed.
   Disabling a module only blocks access; it never deletes data.
========================================================================= */
const sql = require("mssql");

/* Registry of known modules and their flags (mirrors lms.module.manifest.json). */
const MODULES = {
  lms: {
    tiers: {
      base: ["lms_core", "lms_assignments", "lms_quizzes", "lms_gradebook"],
      standard: ["lms_core", "lms_assignments", "lms_quizzes", "lms_gradebook",
        "lms_discussions", "lms_paths", "lms_competency", "lms_analytics"],
    },
    addons: ["lms_offline", "lms_guardian", "lms_live", "lms_scorm"],
  },
};

const isKnownModule = (key) => Object.prototype.hasOwnProperty.call(MODULES, key);
const allFlags = (key) => {
  const m = MODULES[key];
  return m ? [...new Set([...m.tiers.standard, ...m.addons])] : [];
};

/* Turns a request ({tier, addons[]} or {flags[]}) into a clean flag list, or null if invalid. */
function expandFlags(moduleKey, { tier, addons, flags } = {}) {
  const m = MODULES[moduleKey];
  if (!m) return null;
  const valid = new Set(allFlags(moduleKey));
  if (Array.isArray(flags)) {
    const clean = [...new Set(flags.map(String))];
    return clean.every((f) => valid.has(f)) ? clean : null;
  }
  if (!m.tiers[tier]) return null;
  const extra = Array.isArray(addons) ? addons.map(String) : [];
  if (!extra.every((f) => m.addons.includes(f))) return null;
  return [...new Set([...m.tiers[tier], ...extra])];
}

async function ensureTenantModulesSchema(pool) {
  try {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tenant_modules' AND xtype='U')
      CREATE TABLE tenant_modules (
        module_key NVARCHAR(50) NOT NULL PRIMARY KEY,
        enabled BIT NOT NULL DEFAULT 0,
        flags_json NVARCHAR(MAX) NULL,
        limits_json NVARCHAR(MAX) NULL,
        note NVARCHAR(300) NULL,
        set_by INT NULL,
        updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )
    `);
  } catch (err) {
    console.error("⚠️  tenant_modules schema failed:", err.message);
  }
}

const safeJson = (txt, fallback) => { try { const v = JSON.parse(txt); return v ?? fallback; } catch { return fallback; } };

/* Pure: a stored row -> what the gate and the UI need. */
function toStatus(row) {
  if (!row) return { enabled: false, flags: [], limits: {}, note: null, updatedAt: null };
  const flags = safeJson(row.flags_json, []);
  const limits = safeJson(row.limits_json, {});
  return {
    enabled: !!row.enabled,
    flags: Array.isArray(flags) ? flags : [],
    limits: limits && typeof limits === "object" && !Array.isArray(limits) ? limits : {},
    note: row.note || null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/* ---- per-tenant cache (never shared across tenants: key = tenantKey) ---- */
const CACHE_MS = 30000;
const cache = new Map(); // tenantKey -> { at, rows: { moduleKey: status } }

async function loadAll(pool, tenantKey, now = Date.now()) {
  const hit = cache.get(tenantKey);
  if (hit && now - hit.at < CACHE_MS) return hit.rows;
  const r = await pool.request().query(`SELECT module_key, enabled, flags_json, limits_json, note, updatedAt FROM tenant_modules`);
  const rows = {};
  for (const row of r.recordset || []) rows[row.module_key] = toStatus(row);
  cache.set(tenantKey, { at: now, rows });
  return rows;
}
const invalidateModuleCache = (tenantKey) => { if (tenantKey) cache.delete(tenantKey); else cache.clear(); };

/* Fails CLOSED: any read problem = not licensed. */
async function getModuleStatus(pool, tenantKey, moduleKey) {
  try {
    const rows = await loadAll(pool, tenantKey || "default");
    return rows[moduleKey] || toStatus(null);
  } catch (err) {
    console.error(`MODULE GATE READ ERROR (denying ${moduleKey}):`, err.message);
    return toStatus(null);
  }
}
async function listModules(pool, tenantKey) {
  try { return await loadAll(pool, tenantKey || "default"); } catch { return {}; }
}

const isAllowed = (status, flag) => !!status.enabled && (!flag || status.flags.includes(flag));

/* Express middleware. Mount AFTER `protect` so req.user / req.pool / req.tenant exist.
   requireModule("lms")                 -> module licensed
   requireModule("lms", "lms_quizzes")  -> module licensed AND that feature flag sold */
function requireModule(moduleKey, flag = null) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Not authenticated" });
    if (!req.pool) return res.status(500).json({ success: false, message: "Database not available" });
    const status = await getModuleStatus(req.pool, req.tenant || req.user.tenant, moduleKey);
    if (!isAllowed(status, flag)) {
      return res.status(403).json({
        success: false,
        code: "MODULE_NOT_LICENSED",
        module: moduleKey,
        flag,
        message: "This feature is not included in your institution's licence. Please contact Doravo to enable it.",
      });
    }
    next();
  };
}

/* For background jobs: throws-free check by pool. */
async function isModuleActive(pool, tenantKey, moduleKey, flag = null) {
  return isAllowed(await getModuleStatus(pool, tenantKey, moduleKey), flag);
}

async function saveModule(pool, { moduleKey, enabled, flags, limits, note, actorId }) {
  await pool.request()
    .input("k", sql.NVarChar(50), moduleKey)
    .input("en", sql.Bit, enabled ? 1 : 0)
    .input("fl", sql.NVarChar(sql.MAX), JSON.stringify(flags || []))
    .input("li", sql.NVarChar(sql.MAX), JSON.stringify(limits || {}))
    .input("note", sql.NVarChar(300), note || null)
    .input("by", sql.Int, actorId || null)
    .query(`
      MERGE tenant_modules AS t USING (SELECT @k AS module_key) AS s ON t.module_key = s.module_key
      WHEN MATCHED THEN UPDATE SET enabled=@en, flags_json=@fl, limits_json=@li, note=@note, set_by=@by, updatedAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (module_key, enabled, flags_json, limits_json, note, set_by) VALUES (@k, @en, @fl, @li, @note, @by);
    `);
}

module.exports = {
  MODULES, isKnownModule, allFlags, expandFlags, ensureTenantModulesSchema, toStatus,
  getModuleStatus, listModules, isAllowed, requireModule, isModuleActive, invalidateModuleCache, saveModule,
};
