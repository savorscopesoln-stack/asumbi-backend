/* =========================================================================
   NOTIFICATION CHANNELS
   Thin, dependency-light wrappers around the three "outside the system"
   delivery channels used by the admin broadcast notifications page:
     - email     via SMTP (nodemailer)
     - sms       via Africa's Talking (preferred when configured) or
                 Twilio's REST API as a fallback (plain fetch, no SDK)
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
  smsProvider: process.env.SMS_PROVIDER || null,
  atUsername: process.env.AT_USERNAME || null,
  atApiKey: process.env.AT_API_KEY || null,
  atSenderId: process.env.AT_SENDER_ID || null,
  atSandbox: String(process.env.AT_SANDBOX || "false") === "true",
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

/* ================= SMS fallback + WHATSAPP (Twilio) ================= */

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

/* ================= SMS (Africa's Talking) =================
   POST https://api.africastalking.com/version1/messaging
   (sandbox: https://api.sandbox.africastalking.com/version1/messaging —
   the username must then be "sandbox").
   Auth is an `apiKey` header + `username` form field. The reply carries a
   per-recipient statusCode: 100 Processed, 101 Sent, 102 Queued are
   successes; anything else (e.g. 405 InsufficientBalance, 403
   InvalidPhoneNumber, 402 InvalidSenderId) is a failure for that number. */

const AT_OK_CODES = new Set([100, 101, 102]);

const atConfigured = async (pool) => {
  const cfg = await resolveConfig(pool);
  return !!(cfg.atUsername && cfg.atApiKey);
};

const atSendRaw = async ({ to, message, cfg }) => {
  if (!cfg.atUsername || !cfg.atApiKey) {
    return { ok: false, skipped: true, reason: "Africa's Talking is not configured yet — add it under Notification Settings" };
  }

  const host = cfg.atSandbox ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  const form = new URLSearchParams();
  form.append("username", cfg.atUsername);
  form.append("to", to);
  form.append("message", message);
  if (cfg.atSenderId) form.append("from", cfg.atSenderId);

  try {
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: "POST",
      headers: {
        apiKey: cfg.atApiKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* AT returns plain text on auth errors */ }

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, reason: "Africa's Talking rejected the credentials — check the username and API key" };
      }
      return { ok: false, reason: (data && (data.message || data.errorMessage)) || raw?.slice(0, 200) || `Africa's Talking HTTP ${res.status}` };
    }

    const smsData = data?.SMSMessageData;
    const recipient = smsData?.Recipients?.[0];
    if (!recipient) {
      // No recipient rows usually means the whole request was refused
      // (e.g. "InvalidSenderId", "Invalid phone number").
      return { ok: false, reason: smsData?.Message || "Africa's Talking did not accept the message" };
    }
    if (!AT_OK_CODES.has(Number(recipient.statusCode))) {
      return { ok: false, reason: `Africa's Talking: ${recipient.status || "failed"} (code ${recipient.statusCode})` };
    }
    return { ok: true, messageId: recipient.messageId, cost: recipient.cost };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

/* Which provider carries SMS?
     smsProvider = "africastalking" | "twilio"  -> exactly that one
     anything else (auto)                       -> Africa's Talking when its
                                                   credentials exist, else Twilio
   WhatsApp is unaffected and always goes through Twilio. */
const pickSmsProvider = (cfg) => {
  const want = String(cfg.smsProvider || "").toLowerCase();
  if (want === "twilio") return "twilio";
  if (want === "africastalking") return "africastalking";
  return cfg.atUsername && cfg.atApiKey ? "africastalking" : "twilio";
};

const sendSms = async ({ to, message }, pool) => {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "No/invalid phone number on file" };
  const cfg = await resolveConfig(pool);
  if (pickSmsProvider(cfg) === "africastalking") {
    return atSendRaw({ to: phone, message, cfg });
  }
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
  atConfigured,
  pickSmsProvider,
  normalizePhone,
};
