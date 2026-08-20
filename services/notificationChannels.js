/* =========================================================================
   NOTIFICATION CHANNELS
   Thin, dependency-light wrappers around the three "outside the system"
   delivery channels used by the admin broadcast notifications page:
     - email     via SMTP (nodemailer)
     - sms       via Twilio's REST API (plain fetch, no SDK)
     - whatsapp  via Twilio's WhatsApp API (same REST endpoint, "whatsapp:"
                 prefixed numbers)

   Every function here is defensive about missing configuration: if the
   relevant env vars aren't set, it returns { ok: false, skipped: true }
   instead of throwing, so a broadcast that fans out to all four channels
   still succeeds on the channels that ARE configured (e.g. in-app +
   email) even before an admin has wired up Twilio.
========================================================================= */

const nodemailer = require("nodemailer");

/* ================= EMAIL ================= */

const emailConfigured = () =>
  !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);

let cachedTransporter = null;
const getTransporter = () => {
  if (!emailConfigured()) return null;
  if (cachedTransporter) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: String(process.env.EMAIL_SECURE || "false") === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
  return cachedTransporter;
};

const sendEmail = async ({ to, subject, message }) => {
  if (!to) return { ok: false, reason: "No email address on file" };

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, skipped: true, reason: "EMAIL_HOST / EMAIL_USER / EMAIL_PASSWORD not configured" };
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
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

const twilioConfigured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

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

const twilioSendRaw = async ({ to, from, body }) => {
  if (!twilioConfigured()) {
    return { ok: false, skipped: true, reason: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured" };
  }
  if (!from) return { ok: false, skipped: true, reason: "Sender number not configured" };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
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

const sendSms = async ({ to, message }) => {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "No/invalid phone number on file" };
  return twilioSendRaw({ to: phone, from: process.env.TWILIO_SMS_FROM, body: message });
};

const sendWhatsapp = async ({ to, message }) => {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "No/invalid phone number on file" };
  const from = process.env.TWILIO_WHATSAPP_FROM ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM.replace(/^whatsapp:/, "")}` : null;
  return twilioSendRaw({ to: `whatsapp:${phone}`, from, body: message });
};

module.exports = {
  sendEmail,
  sendSms,
  sendWhatsapp,
  emailConfigured,
  twilioConfigured,
  normalizePhone,
};
