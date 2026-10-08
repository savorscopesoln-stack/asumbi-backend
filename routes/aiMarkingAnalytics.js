const express = require("express");
const { protect, authorize } = require("../middleware/authMiddleware");
const c = require("../controllers/aiMarkingAnalytics.controller");
const { heavy } = require("../middleware/aiMarkingRateLimit");

/* Phase 10 — AI marking analytics for teachers and institution administrators.
   Read-only. Mount in server.js:

     app.use("/api/ai-marking-analytics", require("./routes/aiMarkingAnalytics"));

   Finance's platform-wide and per-institution views are NOT here: they live in
   routes/finance.js behind protect + financeOnly (strict, no admin bypass).
   authorize() lets admin/module_admin through any role list, so each handler
   also checks the exact role itself (see the controller header). */
const router = express.Router();
router.use(protect);

router.get("/teacher", authorize("teacher"), heavy, c.teacher);
router.get("/institution", authorize("admin"), heavy, c.institution);

module.exports = router;
