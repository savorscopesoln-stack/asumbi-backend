const { getPool } = require("../config/db");
const { assertValidTenant } = require("./finance.controller");
const { logFinanceAudit } = require("../utils/financeAuditLog");
const P = require("../utils/tenantPageAccess");

/* FINANCE — PAGE ACCESS. Same shape as financeModules.controller.js: the institution
   comes from :tenantKey, its own pool is opened directly, routes are protect + financeOnly. */
const fail = (res, err, fallback) =>
  res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : fallback });

const getPages = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    await P.ensureTenantPageAccessSchema(pool);
    P.invalidatePageAccessCache(tenantKey);
    res.json({ success: true, tenantKey, disabled: await P.getDisabledPages(pool, tenantKey) });
  } catch (err) { fail(res, err, "Server error loading page access"); }
};

/* body: { changes: [{ portal: "admin"|"student"|"teacher", page_key, enabled }] } — all validated first, then applied. */
const setPages = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length || changes.length > 500) return res.status(400).json({ success: false, message: "Send between 1 and 500 changes" });
    for (const c of changes) {
      if (!P.PORTALS.includes(c?.portal) || !P.isValidPageKey(c.portal, c.page_key) || typeof c.enabled !== "boolean") {
        return res.status(400).json({ success: false, message: `Invalid change for ${c?.portal}:${c?.page_key}` });
      }
      if (c.enabled === false && P.isLocked(c.portal, c.page_key)) {
        return res.status(400).json({ success: false, message: "That page is the portal's landing page and can't be switched off." });
      }
    }
    const pool = await getPool(tenantKey);
    await P.ensureTenantPageAccessSchema(pool);
    const actorId = Number(req.user?.id) || null;
    for (const c of changes) await P.setPageAccess(pool, { portal: c.portal, pageKey: c.page_key, enabled: c.enabled, actorId });
    await logFinanceAudit(pool, {
      action: "page_access_changed", actorId, actorRole: "finance",
      details: { changes: changes.map((c) => ({ portal: c.portal, page: c.page_key, enabled: c.enabled })) },
    });
    P.invalidatePageAccessCache(tenantKey);
    res.json({ success: true, tenantKey, disabled: await P.getDisabledPages(pool, tenantKey) });
  } catch (err) {
    console.error("FINANCE SET PAGE ACCESS ERROR:", err);
    fail(res, err, "Server error saving page access");
  }
};

module.exports = { getPages, setPages };
