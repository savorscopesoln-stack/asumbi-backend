/* =========================================================================
   TENANT PAGE ACCESS  (Finance decides which pages each institution gets)

   One table per tenant database, `tenant_page_access`, holds the pages Doravo
   Finance has switched OFF for that institution, per portal:
     admin   -> page keys from utils/pages.js (e.g. "Meals", "Gate", "LMS")
     student -> portal routes (e.g. "/student/meals")
     teacher -> portal routes (e.g. "/teacher/courses")
   A page with no row is ENABLED (so existing institutions lose nothing and
   newly added pages appear automatically). Written ONLY by the finance
   endpoints (routes/finance.js, financeOnly) and hidden from the admin raw
   record editor, like tenant_license / tenant_modules.

   This sits ABOVE the school admin's own "Portal Pages" switches: a page Finance
   has turned off cannot be turned back on by the school.
   Hiding only removes menus and blocks the screen; it never deletes data.
========================================================================= */
const sql = require("mssql");
const { PAGE_KEYS } = require("./pages");

const PORTALS = ["admin", "student", "teacher"];
/* Landing pages: switching these off would leave a role with nowhere to go. */
const LOCKED = new Set(["admin:Dashboard", "student:/student", "teacher:/teacher/dashboard"]);

function isValidPageKey(portal, key) {
  if (typeof key !== "string" || !key || key.length > 200) return false;
  if (portal === "admin") return PAGE_KEYS.includes(key);
  if (portal === "student") return key === "/student" || key.startsWith("/student/");
  if (portal === "teacher") return key.startsWith("/teacher/");
  return false;
}
const isLocked = (portal, key) => LOCKED.has(`${portal}:${key}`);

async function ensureTenantPageAccessSchema(pool) {
  try {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tenant_page_access' AND xtype='U')
      CREATE TABLE tenant_page_access (
        portal NVARCHAR(20) NOT NULL,
        page_key NVARCHAR(200) NOT NULL,
        enabled BIT NOT NULL DEFAULT 1,
        set_by INT NULL,
        updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_tenant_page_access PRIMARY KEY (portal, page_key)
      )
    `);
  } catch (err) {
    console.error("⚠️  tenant_page_access schema failed:", err.message);
  }
}

/* Pure: rows -> { admin: [disabled keys], student: [...], teacher: [...] }. */
function toDisabledMap(rows) {
  const out = { admin: [], student: [], teacher: [] };
  for (const r of rows || []) {
    if (r && (r.enabled === false || r.enabled === 0)) {
      if (out[r.portal] && !isLocked(r.portal, r.page_key)) out[r.portal].push(r.page_key);
    }
  }
  return out;
}

/* ---- per-tenant cache (key = tenantKey, never shared) ---- */
const CACHE_MS = 30000;
const cache = new Map();

async function getDisabledPages(pool, tenantKey, now = Date.now()) {
  const key = tenantKey || "default";
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.map;
  try {
    const r = await pool.request().query(`SELECT portal, page_key, enabled FROM tenant_page_access`);
    const map = toDisabledMap(r.recordset);
    cache.set(key, { at: now, map });
    return map;
  } catch (err) {
    // Fails OPEN (unlike module licences): an unreadable list must never lock a school out of its own pages.
    console.error("PAGE ACCESS READ ERROR (showing all pages):", err.message);
    return { admin: [], student: [], teacher: [] };
  }
}
const invalidatePageAccessCache = (tenantKey) => { if (tenantKey) cache.delete(tenantKey); else cache.clear(); };

async function setPageAccess(pool, { portal, pageKey, enabled, actorId }) {
  await pool.request()
    .input("p", sql.NVarChar(20), portal)
    .input("k", sql.NVarChar(200), pageKey)
    .input("en", sql.Bit, enabled ? 1 : 0)
    .input("by", sql.Int, actorId || null)
    .query(`
      MERGE tenant_page_access AS t USING (SELECT @p AS portal, @k AS page_key) AS s
        ON t.portal = s.portal AND t.page_key = s.page_key
      WHEN MATCHED THEN UPDATE SET enabled=@en, set_by=@by, updatedAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (portal, page_key, enabled, set_by) VALUES (@p, @k, @en, @by);
    `);
}

module.exports = {
  PORTALS, isValidPageKey, isLocked, ensureTenantPageAccessSchema, toDisabledMap,
  getDisabledPages, invalidatePageAccessCache, setPageAccess,
};
