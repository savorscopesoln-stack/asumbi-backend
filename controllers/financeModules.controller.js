const { getPool } = require("../config/db");
const { assertValidTenant } = require("./finance.controller");
const { logFinanceAudit } = require("../utils/financeAuditLog");
const M = require("../utils/tenantModules");

/* FINANCE — MODULE LICENCES. Same shape as financeTrial.controller.js: the
   institution comes from :tenantKey, its own pool is opened directly, routes are
   protect + financeOnly. */
const fail = (res, err, fallback) =>
  res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : fallback });

const getModules = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    await M.ensureTenantModulesSchema(pool);
    M.invalidateModuleCache(tenantKey);
    res.json({ success: true, tenantKey, modules: await M.listModules(pool, tenantKey),
      registry: Object.fromEntries(Object.entries(M.MODULES).map(([k, v]) => [k, { tiers: Object.keys(v.tiers), addons: v.addons }])) });
  } catch (err) { fail(res, err, "Server error loading modules"); }
};

/* body: { enabled: boolean, tier?: "base"|"standard", addons?: string[], flags?: string[], limits?: object, note? } */
const setModule = async (req, res) => {
  try {
    const { tenantKey, moduleKey } = req.params;
    assertValidTenant(tenantKey);
    if (!M.isKnownModule(moduleKey)) return res.status(404).json({ success: false, message: "Unknown module" });
    const enabled = req.body?.enabled === true;
    let flags = [];
    if (enabled) {
      flags = M.expandFlags(moduleKey, req.body || {});
      if (!flags) return res.status(400).json({ success: false, message: "Invalid tier, addons or flags" });
    } else if (Array.isArray(req.body?.flags) || req.body?.tier) {
      flags = M.expandFlags(moduleKey, req.body) || []; // keep what was sold while switched off
    }
    const limits = req.body?.limits && typeof req.body.limits === "object" && !Array.isArray(req.body.limits) ? req.body.limits : {};
    const note = String(req.body?.note || "").trim().slice(0, 300) || null;
    const pool = await getPool(tenantKey);
    await M.ensureTenantModulesSchema(pool);
    await M.saveModule(pool, { moduleKey, enabled, flags, limits, note, actorId: Number(req.user?.id) || null });
    await logFinanceAudit(pool, {
      action: enabled ? "module_enabled" : "module_disabled",
      actorId: Number(req.user?.id) || null, actorRole: "finance",
      details: { moduleKey, flags, limits, note },
    });
    M.invalidateModuleCache(tenantKey);
    res.json({ success: true, tenantKey, modules: await M.listModules(pool, tenantKey) });
  } catch (err) {
    console.error("FINANCE SET MODULE ERROR:", err);
    fail(res, err, "Server error saving module");
  }
};

module.exports = { getModules, setModule };
