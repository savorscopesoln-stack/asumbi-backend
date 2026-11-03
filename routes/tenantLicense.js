const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getTrialStatus } = require("../utils/tenantLicense");
const { listModules } = require("../utils/tenantModules");
const { getDisabledPages } = require("../utils/tenantPageAccess");

/* Tenant side: what the trial countdown banner reads. Any signed-in user of
   the tenant may read it (read-only); it only ever reports THEIR OWN tenant,
   because req.pool is the tenant the token was issued for. Nothing here can
   change the trial — that is finance-only (routes/finance.js). */
router.get("/license", protect, async (req, res) => {
  try {
    const trial = await getTrialStatus(req.pool);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, trial, serverTime: new Date().toISOString() });
  } catch (err) {
    // an unreadable license must never break the app: report "no trial"
    console.error("TENANT LICENSE READ ERROR:", err.message);
    res.json({ success: true, trial: { hasTrial: false, active: false, expired: false }, serverTime: new Date().toISOString() });
  }
});

/* Which licensed modules/flags THIS tenant has (drives menus + upgrade prompts).
   Read-only; only reports the caller's own tenant. Fails closed (empty list). */
router.get("/modules", protect, async (req, res) => {
  const modules = await listModules(req.pool, req.tenant || req.user.tenant);
  res.set("Cache-Control", "no-store");
  res.json({ success: true, modules });
});

/* Pages Finance has switched off for THIS tenant, per portal (admin keys / student + teacher routes).
   Read-only, any signed-in user; fails open (nothing hidden) if unreadable. */
router.get("/pages", protect, async (req, res) => {
  const disabled = await getDisabledPages(req.pool, req.tenant || req.user.tenant);
  res.set("Cache-Control", "no-store");
  res.json({ success: true, disabled });
});

module.exports = router;
