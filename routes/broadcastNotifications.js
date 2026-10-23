const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/broadcastNotification.controller");
const sms = require("../controllers/directSms.controller");

/* All routes here are mounted behind protect + requirePage("Notifications")
   in server.js — only admin / a sub_admin granted that page can reach
   any of these. */

router.get("/recipients", ctrl.getRecipientDirectory);
/* Direct SMS to typed numbers + the saved-contacts address book.
   Declared before "/:id" so these paths can never be mistaken for an id. */
router.get("/contacts", sms.listContacts);
router.post("/contacts", sms.createContact);
router.put("/contacts/:id", sms.updateContact);
router.delete("/contacts/:id", sms.deleteContact);
router.get("/sms", sms.listDirectSms);
router.post("/sms", sms.sendDirectSms);

router.get("/", ctrl.listBroadcasts);
router.post("/", ctrl.createBroadcast);
router.delete("/:id", ctrl.cancelBroadcast);

module.exports = router;
