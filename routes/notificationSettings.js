const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/notificationSettings.controller");

/* All routes here are mounted behind protect + adminOnly in server.js —
   this is API-credential management, a level above the "Notifications"
   sub-admin page permission, so only a true "admin" account reaches it. */

router.get("/", ctrl.getSettings);
router.put("/", ctrl.updateSettings);
router.post("/test", ctrl.sendTest);

module.exports = router;
