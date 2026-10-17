const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getTrialStatus } = require("../utils/tenantLicense");

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

module.exports = router;
