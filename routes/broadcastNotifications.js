const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/broadcastNotification.controller");

/* All routes here are mounted behind protect + requirePage("Notifications")
   in server.js — only admin / a sub_admin granted that page can reach
   any of these. */

router.get("/recipients", ctrl.getRecipientDirectory);
router.get("/", ctrl.listBroadcasts);
router.post("/", ctrl.createBroadcast);
router.delete("/:id", ctrl.cancelBroadcast);

module.exports = router;
