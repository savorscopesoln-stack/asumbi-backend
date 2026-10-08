const { makeOperationalService, makeFinanceService, AnalyticsError } = require("../services/aiMarkingAnalytics.service");
const { describeError } = require("../utils/safeLog");
const { createSqlOperationalStore, createSqlEconomicsStore } = require("../services/aiMarkingAnalytics.store");
const { teacherWalletSummary } = require("../services/aiMarkingEligibility.service");

/* =========================================================================
   AI MARKING — ANALYTICS ENDPOINTS (Phase 10). Read-only.

   Teacher      GET /api/ai-marking-analytics/teacher        role "teacher" ONLY
   Institution  GET /api/ai-marking-analytics/institution    role "admin" / "module_admin"
   Finance      GET /api/finance/ai-marking/analytics                         (platform-wide)
                GET /api/finance/institutions/:tenantKey/ai-marking/analytics  (one institution)
                -> mounted in routes/finance.js behind protect + financeOnly

   Query: from, to (YYYY-MM-DD), assessmentId (teacher + institution only).

   The role is checked here in addition to the route guard, because authorize()
   lets admin/module_admin through every role list: an administrator must not be
   able to read the teacher endpoint as if they were a teacher, and a teacher must
   never reach the institution one. Whose data is read comes from req.user and the
   authenticated tenant pool — never from the query string.
========================================================================= */

const INSTITUTION_ROLES = new Set(["admin", "module_admin"]);
const roleOf = (req) => String(req.user?.role || "").toLowerCase().trim();

function fail(res, err, fallback) {
  if (err instanceof AnalyticsError) return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
  if (err && err.statusCode === 404) return res.status(404).json({ success: false, message: err.message });
  console.error("AI MARKING ANALYTICS ERROR:", describeError(err));
  return res.status(500).json({ success: false, message: fallback });
}

function makeAnalyticsController({
  operationalStoreFactory = createSqlOperationalStore,
  economicsStoreFactory = createSqlEconomicsStore,
  walletFactory = (pool) => () => teacherWalletSummary(pool),
  getPool = (key) => require("../config/db").getPool(key),
  listTenantKeys = () => require("../config/db").listTenantKeys(),
  assertValidTenant = (key) => require("./finance.controller").assertValidTenant(key),
} = {}) {
  return {
    teacher: async (req, res) => {
      try {
        if (roleOf(req) !== "teacher") return res.status(403).json({ success: false, message: "Teachers only", code: "FORBIDDEN" });
        const svc = makeOperationalService({ store: operationalStoreFactory(req.pool), walletSummary: walletFactory(req.pool) });
        const out = await svc.forTeacher({ teacherId: req.user?.id, from: req.query.from, to: req.query.to, assessmentId: req.query.assessmentId });
        res.json({ success: true, ...out });
      } catch (err) { fail(res, err, "Server error loading AI marking analytics"); }
    },

    institution: async (req, res) => {
      try {
        if (!INSTITUTION_ROLES.has(roleOf(req))) return res.status(403).json({ success: false, message: "Institution administrators only", code: "FORBIDDEN" });
        const svc = makeOperationalService({ store: operationalStoreFactory(req.pool), walletSummary: walletFactory(req.pool) });
        const out = await svc.forInstitution({ from: req.query.from, to: req.query.to, assessmentId: req.query.assessmentId });
        res.json({ success: true, ...out });
      } catch (err) { fail(res, err, "Server error loading AI marking analytics"); }
    },

    financeInstitution: async (req, res) => {
      try {
        if (roleOf(req) !== "finance") return res.status(403).json({ success: false, message: "Doravo Finance access only", code: "FORBIDDEN" });
        const tenantKey = req.params.tenantKey;
        assertValidTenant(tenantKey);
        const svc = makeFinanceService({
          openTenant: async (key) => { const pool = await getPool(key); return { operational: operationalStoreFactory(pool), economics: economicsStoreFactory(pool) }; },
          listTenants: async () => listTenantKeys(),
        });
        res.json({ success: true, ...(await svc.forInstitution({ tenantKey, from: req.query.from, to: req.query.to })) });
      } catch (err) { fail(res, err, "Server error loading AI marking analytics"); }
    },

    financePlatform: async (req, res) => {
      try {
        if (roleOf(req) !== "finance") return res.status(403).json({ success: false, message: "Doravo Finance access only", code: "FORBIDDEN" });
        const svc = makeFinanceService({
          openTenant: async (key) => { const pool = await getPool(key); return { operational: operationalStoreFactory(pool), economics: economicsStoreFactory(pool) }; },
          listTenants: async () => listTenantKeys(),
        });
        res.json({ success: true, ...(await svc.platform({ from: req.query.from, to: req.query.to })) });
      } catch (err) { fail(res, err, "Server error loading AI marking analytics"); }
    },
  };
}

module.exports = { makeAnalyticsController, ...makeAnalyticsController() };
