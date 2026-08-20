/* =========================================================================
   NOTIFICATION CHANNELS
   Thin, dependency-light wrappers around the three "outside the system"
   delivery channels used by the admin broadcast notifications page:
     - email     via SMTP (nodemailer)
     - sms       via Twilio's REST API (plain fetch, no SDK)
     - whatsapp  via Twilio's WhatsApp API (same REST endpoint, "whatsapp:"
                 prefixed numbers)

   Configuration is read via utils/notificationSettingsStore.js, which
   prefers whatever was saved from the admin "Notification Settings"
   page and falls back to the matching environment variable — so this
   keeps working unmodified for a deployment that only ever used .env.

   Every function here is defensive about missing configuration: if
   nothing is configured (DB or env), it returns { ok: false, skipped:
   true } instead of throwing, so a broadcast that fans out to all four
   channels still succeeds on the channels that ARE configured (e.g.
   in-app + email) even before an admin has wired up Twilio.
========================================================================= */

const nodemailer = require("nodemailer");
const { getEffectiveConfig } = require("../utils/notificationSettingsStore");

/* A pool-less fallback config for the rare caller that doesn't have a
   pool handy — env vars only, same as the old behaviour. */
const envOnlyConfig = () => ({
  emailHost: process.env.EMAIL_HOST || null,
  emailPort: Number(process.env.EMAIL_PORT) || 587,
  emailSecure: String(process.env.EMAIL_SECURE || "false") === "true",
  emailUser: process.env.EMAIL_USER || null,
  emailPassword: process.env.EMAIL_PASSWORD || null,
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER || null,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
  twilioSmsFrom: process.env.TWILIO_SMS_FROM || null,
  twilioWhatsappFrom: process.env.TWILIO_WHATSAPP_FROM || null,
});

const resolveConfig = async (pool) => {
  if (!pool) return envOnlyConfig();
  try {
    return await getEffectiveConfig(pool);
  } catch (err) {
    console.error("⚠️ Failed to load notification settings, falling back to env:", err.message);
    return envOnlyConfig();
  }
};

/* ================= EMAIL ================= */

const emailConfigured = async (pool) => {
  const cfg = await resolveConfig(pool);
  return !!(cfg.emailHost && cfg.emailUser && cfg.emailPassword);
};

// Transporters are cheap to (re)build and config can change at any time
// from the settings page, so no cross-call caching here — this only
// runs once per outgoing email, not per keystroke.
const buildTransporter = (cfg) =>
  nodemailer.createTransport({
    host: cfg.emailHost,
    port: Number(cfg.emailPort) || 587,
    secure: !!cfg.emailSecure,
    auth: {
      user: cfg.emailUser,
      pass: cfg.emailPassword,
    },
  });

const sendEmail = async ({ to, subject, message }, pool) => {
  if (!to) return { ok: false, reason: "No email address on file" };

  const cfg = await resolveConfig(pool);
  if (!cfg.emailHost || !cfg.emailUser || !cfg.emailPassword) {
    return { ok: false, skipped: true, reason: "Email (SMTP) is not configured yet — add it under Notification Settings" };
  }

  try {
    const transporter = buildTransporter(cfg);
    await transporter.sendMail({
      from: cfg.emailFrom || cfg.emailUser,
      to,
      subject: subject || "Notification",
      text: message,
      html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.5;">${String(message)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>")}</div>`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

/* ================= SMS + WHATSAPP (Twilio) ================= */

const twilioConfigured = async (pool) => {
  const cfg = await resolveConfig(pool);
  return !!(cfg.twilioAccountSid && cfg.twilioAuthToken);
};

// Best-effort local-number normalization. Kenyan-style "07XXXXXXXX" /
// "01XXXXXXXX" numbers become "+254XXXXXXXXX"; anything already in
// international form is left alone (just make sure it has a leading +).
const normalizePhone = (raw) => {
  let phone = String(raw || "").trim().replace(/[\s-]/g, "");
  if (!phone) return null;
  if (phone.startsWith("0") && phone.length === 10) phone = "+254" + phone.slice(1);
  if (!phone.startsWith("+")) phone = "+" + phone;
  return phone;
};

const twilioSendRaw = async ({ to, from, body, cfg }) => {
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken) {
    return { ok: false, skipped: true, reason: "Twilio is not configured yet — add it under Notification Settings" };
  }
  if (!from) return { ok: false, skipped: true, reason: "Sender number not configured" };

  const sid = cfg.twilioAccountSid;
  const authToken = cfg.twilioAuthToken;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${authToken}`).toString("base64");

  const form = new URLSearchParams();
  form.append("To", to);
  form.append("From", from);
  form.append("Body", body);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data?.message || `Twilio HTTP ${res.status}` };
    return { ok: true, sid: data.sid };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

const sendSms = async ({ to, message }, pool) => {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "No/invalid phone number on file" };
  const cfg = await resolveConfig(pool);
  return twilioSendRaw({ to: phone, from: cfg.twilioSmsFrom, body: message, cfg });
};

const sendWhatsapp = async ({ to, message }, pool) => {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "No/invalid phone number on file" };
  const cfg = await resolveConfig(pool);
  const from = cfg.twilioWhatsappFrom ? `whatsapp:${cfg.twilioWhatsappFrom.replace(/^whatsapp:/, "")}` : null;
  return twilioSendRaw({ to: `whatsapp:${phone}`, from, body: message, cfg });
};

module.exports = {
  sendEmail,
  sendSms,
  sendWhatsapp,
  emailConfigured,
  twilioConfigured,
  normalizePhone,
};
