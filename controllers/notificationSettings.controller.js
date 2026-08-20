const store = require("../utils/notificationSettingsStore");
const { sendEmail, sendSms, sendWhatsapp } = require("../services/notificationChannels");

/* =========================================================================
   NOTIFICATION SETTINGS (admin-only)
   Powers the "Notification Settings" config page — lets an admin plug in
   the SMTP / Twilio credentials the broadcast notifications feature
   sends through, without needing server/.env access. Mounted behind
   `protect` + `adminOnly` in server.js — sub-admins never reach these
   routes even if granted the "Notifications" broadcast page, since API
   credentials are a different level of sensitivity.
========================================================================= */

const EMAIL_FIELDS = ["emailHost", "emailPort", "emailSecure", "emailUser", "emailPassword", "emailFrom"];
const TWILIO_FIELDS = ["twilioAccountSid", "twilioAuthToken", "twilioSmsFrom", "twilioWhatsappFrom"];

const getSettings = async (req, res) => {
  try {
    const settings = await store.getDisplaySettings(req.pool);
    res.json(settings);
  } catch (err) {
    console.error("GET NOTIFICATION SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to load notification settings", error: err.message });
  }
};

const updateSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const fields = {};

    for (const key of [...EMAIL_FIELDS, ...TWILIO_FIELDS]) {
      if (key in body) fields[key] = body[key];
    }

    const clearFields = Array.isArray(body.clearFields)
      ? body.clearFields.filter((k) => [...EMAIL_FIELDS, ...TWILIO_FIELDS].includes(k))
      : [];

    const updatedByName = req.user?.username || req.user?.email || null;
    const settings = await store.updateSettings(req.pool, fields, { updatedByName, clearFields });

    res.json({ message: "Notification settings saved", settings });
  } catch (err) {
    console.error("UPDATE NOTIFICATION SETTINGS ERROR:", err);
    res.status(500).json({ message: "Failed to save notification settings", error: err.message });
  }
};

/* POST /api/notification-settings/test
   body: { channel: 'email'|'sms'|'whatsapp', to }
   Sends a one-off test message using whatever is currently configured,
   so the admin gets an immediate yes/no on whether the credentials they
   just entered actually work — instead of only finding out the next
   time a real broadcast goes out. */
const sendTest = async (req, res) => {
  try {
    const { channel, to } = req.body || {};
    if (!to || !String(to).trim()) {
      return res.status(400).json({ message: "A destination address/number is required" });
    }

    const testMessage = "This is a test message from Asumbi's Notification Settings page. If you received this, the connection is working.";
    let result;

    if (channel === "email") {
      result = await sendEmail({ to, subject: "Test notification", message: testMessage }, req.pool);
    } else if (channel === "sms") {
      result = await sendSms({ to, message: testMessage }, req.pool);
    } else if (channel === "whatsapp") {
      result = await sendWhatsapp({ to, message: testMessage }, req.pool);
    } else {
      return res.status(400).json({ message: "channel must be one of: email, sms, whatsapp" });
    }

    if (result.ok) return res.json({ message: "Test message sent — check the destination inbox/phone." });
    return res.status(422).json({ message: result.reason || "Test message failed to send", skipped: !!result.skipped });
  } catch (err) {
    console.error("SEND TEST NOTIFICATION ERROR:", err);
    res.status(500).json({ message: "Failed to send test message", error: err.message });
  }
};

module.exports = { getSettings, updateSettings, sendTest };
