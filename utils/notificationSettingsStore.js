const sql = require("mssql");

/* =========================================================================
   NOTIFICATION SETTINGS STORE
   Backs the admin "Notification Settings" config page — a single-row
   table holding the API credentials for the outbound channels (SMTP for
   email, Twilio for SMS/WhatsApp). Read through a short-lived in-memory
   cache so every broadcast send doesn't need its own round-trip, but a
   save from the config page is reflected on the very next send
   (invalidateCache() is called right after every successful write).

   Any column left NULL here just falls back to the equivalent
   environment variable in services/notificationChannels.js — so a
   deployment that already configures things via .env keeps working
   exactly as before, with the DB values only taking priority once an
   admin actually fills them in from the UI.
========================================================================= */

const CACHE_TTL_MS = 30 * 1000;
let cache = null; // { row, cachedAt }

const SECRET_FIELDS = ["emailPassword", "twilioAuthToken"];
const ALL_FIELDS = [
  "emailHost", "emailPort", "emailSecure", "emailUser", "emailPassword", "emailFrom",
  "twilioAccountSid", "twilioAuthToken", "twilioSmsFrom", "twilioWhatsappFrom",
];

const invalidateCache = () => {
  cache = null;
};

/* Makes sure the singleton row (id = 1) exists, then returns it raw
   (secrets included) — only ever used internally / by the settings
   controller, never sent back to the browser as-is. */
const getRawSettings = async (pool, { forceRefresh = false } = {}) => {
  if (!forceRefresh && cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.row;
  }

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM NotificationSettings WHERE id = 1)
    INSERT INTO NotificationSettings (id) VALUES (1)
  `);

  const result = await pool.request().query(`SELECT TOP 1 * FROM NotificationSettings WHERE id = 1`);
  const row = result.recordset?.[0] || {};
  cache = { row, cachedAt: Date.now() };
  return row;
};

/* Merges DB values (when set) over the matching env var, giving the
   shape every sendX() helper in notificationChannels.js actually
   consumes. */
const getEffectiveConfig = async (pool) => {
  const row = await getRawSettings(pool);
  return {
    emailHost: row.emailHost || process.env.EMAIL_HOST || null,
    emailPort: row.emailPort ?? (process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587),
    emailSecure: row.emailSecure ?? (String(process.env.EMAIL_SECURE || "false") === "true"),
    emailUser: row.emailUser || process.env.EMAIL_USER || null,
    emailPassword: row.emailPassword || process.env.EMAIL_PASSWORD || null,
    emailFrom: row.emailFrom || process.env.EMAIL_FROM || row.emailUser || process.env.EMAIL_USER || null,
    twilioAccountSid: row.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || null,
    twilioAuthToken: row.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN || null,
    twilioSmsFrom: row.twilioSmsFrom || process.env.TWILIO_SMS_FROM || null,
    twilioWhatsappFrom: row.twilioWhatsappFrom || process.env.TWILIO_WHATSAPP_FROM || null,
  };
};

/* Returns the shape the config page's GET renders: never the actual
   secret value, just whether it's set and where it's coming from. */
const getDisplaySettings = async (pool) => {
  const row = await getRawSettings(pool, { forceRefresh: true });
  const envConfigured = (envVar) => !!process.env[envVar];

  const sourceFor = (dbVal, envVar) => {
    if (dbVal) return "database";
    if (envConfigured(envVar)) return "environment";
    return "none";
  };

  return {
    email: {
      host: row.emailHost || "",
      port: row.emailPort ?? "",
      secure: !!row.emailSecure,
      user: row.emailUser || "",
      from: row.emailFrom || "",
      passwordSet: !!row.emailPassword,
      source: sourceFor(row.emailHost || row.emailUser || row.emailPassword, "EMAIL_HOST"),
    },
    sms: {
      accountSidSet: !!row.twilioAccountSid,
      authTokenSet: !!row.twilioAuthToken,
      smsFrom: row.twilioSmsFrom || "",
      source: sourceFor(row.twilioAccountSid, "TWILIO_ACCOUNT_SID"),
    },
    whatsapp: {
      whatsappFrom: row.twilioWhatsappFrom || "",
      source: sourceFor(row.twilioAccountSid, "TWILIO_ACCOUNT_SID"),
    },
    updatedAt: row.updatedAt || null,
    updatedByName: row.updatedByName || null,
  };
};

/* Upserts whichever fields were provided. Secret fields are only
   overwritten when a non-empty value is explicitly sent; omitting them
   (or sending "") leaves whatever is already stored untouched, and a
   dedicated `clearFields` array lets the UI explicitly blank one out. */
const updateSettings = async (pool, fields, { updatedByName, clearFields = [] } = {}) => {
  await getRawSettings(pool); // ensures the row exists

  const sets = [];
  const request = pool.request();

  for (const key of ALL_FIELDS) {
    const isSecret = SECRET_FIELDS.includes(key);
    if (clearFields.includes(key)) {
      sets.push(`${key} = NULL`);
      continue;
    }
    if (!(key in fields)) continue;
    const val = fields[key];
    if (isSecret && (val === undefined || val === null || val === "")) continue; // don't blank a secret by accident

    if (key === "emailPort") {
      request.input(key, sql.Int, val === "" || val === null ? null : Number(val));
    } else if (key === "emailSecure") {
      request.input(key, sql.Bit, !!val);
    } else {
      request.input(key, sql.NVarChar, val === "" ? null : val);
    }
    sets.push(`${key} = @${key}`);
  }

  if (!sets.length) {
    invalidateCache();
    return getDisplaySettings(pool);
  }

  request.input("updatedByName", sql.NVarChar, updatedByName || null);
  sets.push("updatedAt = GETDATE()", "updatedByName = @updatedByName");

  await request.query(`UPDATE NotificationSettings SET ${sets.join(", ")} WHERE id = 1`);
  invalidateCache();
  return getDisplaySettings(pool);
};

module.exports = {
  getEffectiveConfig,
  getDisplaySettings,
  updateSettings,
  invalidateCache,
};
