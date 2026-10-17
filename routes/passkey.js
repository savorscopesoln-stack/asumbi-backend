/* =========================================================================
   PASSKEYS — sign in with the device's fingerprint / face / screen-lock PIN
   (WebAuthn). Works for every account type: admins (Users), teachers, students.

   HOW IT WORKS
   ─────────────────────────────────────────────────────────
   1. A signed-in user presses "Enable fingerprint / face login" on this device.
      The browser asks the device to create a key pair; the PRIVATE key never
      leaves the device (and is unlocked by fingerprint/face/PIN). We store only
      the PUBLIC key (table UserPasskeys, one database per school).
   2. Later, on the login page, "Sign in with fingerprint / face" makes the device
      sign a one-time challenge. We verify the signature with the stored public
      key and issue the same session token the password login issues.
   Nothing biometric is ever sent to or stored on the server.

   RULES
   ─────────────────────────────────────────────────────────
   - User verification is REQUIRED (a bare "tap" without fingerprint/face/PIN is refused).
   - Finance accounts are excluded: they keep password + authenticator-code (MFA).
   - An account flagged mustChangePassword must sign in with its password first.
   - An admin password reset removes that account's passkeys (see auth.js).
   - Challenges are short-lived signed tokens (5 min), so this works across
     several server instances with no shared memory.

   CONFIG (backend env)
   ─────────────────────────────────────────────────────────
   (built in)        doravocore.co.ke and doravo.co.ke (each with its www.) are always
                     allowed - no env needed. Each domain has its own passkey.
   WEBAUTHN_RP_ID    OPTIONAL extra registrable domains, comma separated.
   WEBAUTHN_ORIGINS  extra allowed site origins (comma separated). FRONTEND_URL and
                     SEB_ALLOWED_ORIGINS and anything under WEBAUTHN_RP_ID are allowed too.
   WEBAUTHN_RP_NAME  name shown in the device prompt (default "Doravo Core").
========================================================================= */
const express = require("express");
const jwt = require("jsonwebtoken");
const { sql, getPool, listTenantKeys } = require("../config/db");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
const SECRET = () => process.env.JWT_SECRET || "doravo_core_secret";
const TABLES = { Users: "Users", Students: "Students", Teachers: "Teachers" };

/* ESM-only library -> load lazily from CommonJS */
let _swa = null;
const swa = async () => (_swa ||= await import("@simplewebauthn/server"));

/* ── per-database table ── */
const ensured = new Set();
async function ensureTable(pool, tenant) {
  const key = tenant || "default";
  if (ensured.has(key)) return;
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='UserPasskeys' AND xtype='U')
    CREATE TABLE UserPasskeys (
      id INT IDENTITY(1,1) PRIMARY KEY,
      source NVARCHAR(20) NOT NULL,
      accountId INT NOT NULL,
      credentialId NVARCHAR(400) NOT NULL,
      publicKey NVARCHAR(MAX) NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports NVARCHAR(200) NULL,
      label NVARCHAR(100) NULL,
      createdAt DATETIME NOT NULL DEFAULT GETDATE(),
      lastUsedAt DATETIME NULL
    );
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_UserPasskeys_credentialId')
      CREATE UNIQUE INDEX UX_UserPasskeys_credentialId ON UserPasskeys(credentialId);
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_UserPasskeys_account')
      CREATE INDEX IX_UserPasskeys_account ON UserPasskeys(source, accountId);
  `);
  ensured.add(key);
}

/* ── origin / relying-party handling ── */
const listFrom = (v) =>
  String(v || "").split(/[\s,;]+/).flatMap((t) => t.split(/(?=https?:\/\/)/i))
    .map((t) => { t = t.trim().replace(/\/+$/, ""); try { return /^https?:\/\//i.test(t) ? new URL(t).origin : ""; } catch { return ""; } })
    .filter(Boolean);

/* Built-in production domains. A passkey is locked to ONE registrable domain (its RP ID), so each
   domain gets its own RP ID: doravocore.co.ke covers doravocore.co.ke + www., doravo.co.ke covers
   doravo.co.ke + www. WEBAUTHN_RP_ID may add more (comma separated). A passkey made on one domain
   cannot be used on the other - the user simply turns it on once per domain. */
const BUILTIN_RP_DOMAINS = ["doravocore.co.ke", "doravo.co.ke"];

function resolveRp(req) {
  const origin = String(req.headers.origin || "").trim().replace(/\/+$/, "");
  let host = "", protocol = "";
  try { const u = new URL(origin); host = u.hostname.toLowerCase(); protocol = u.protocol; } catch { return null; }
  const rpDomains = [...new Set([
    ...BUILTIN_RP_DOMAINS,
    ...String(process.env.WEBAUTHN_RP_ID || "").split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
  ])];
  const rpName = process.env.WEBAUTHN_RP_NAME || "Doravo Core";

  // 1) https page on one of our registrable domains (or a subdomain of it)
  const domain = rpDomains.find((d) => host === d || host.endsWith("." + d));
  if (domain && protocol === "https:") return { origin, rpID: domain, rpName };

  // 2) explicitly allowed origins (e.g. localhost dev, Vercel preview): RP ID = that page's host
  const allowed = [...listFrom(process.env.FRONTEND_URL), ...listFrom(process.env.WEBAUTHN_ORIGINS), ...listFrom(process.env.SEB_ALLOWED_ORIGINS)];
  if (allowed.includes(origin)) return { origin, rpID: host, rpName };

  console.warn(`PASSKEY: origin "${origin}" is not allowed. Add it to WEBAUTHN_ORIGINS.`);
  return null;
}

const signChallenge = (payload) => jwt.sign(payload, SECRET(), { expiresIn: "5m" });
const readChallenge = (t, purpose) => {
  try { const d = jwt.verify(t, SECRET()); return d && d.purpose === purpose ? d : null; } catch { return null; }
};
const toB64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(String(s), "base64"));

/* =========================================================
   REGISTER  (must already be signed in)
========================================================= */
router.post("/register/options", protect, async (req, res) => {
  try {
    const rp = resolveRp(req);
    if (!rp) return res.status(400).json({ message: "Fingerprint / face login isn't set up for this website address yet. Ask the administrator." });
    if (req.user.examOnly) return res.status(403).json({ message: "Not available during an exam session." });
    if (req.user.role === "finance") return res.status(403).json({ message: "Finance accounts use password + authenticator code." });
    const table = TABLES[req.user.source];
    if (!table) return res.status(400).json({ message: "Unsupported account type." });

    const pool = req.pool;
    await ensureTable(pool, req.user.tenant);
    const existing = await pool.request()
      .input("s", sql.NVarChar(20), req.user.source).input("a", sql.Int, req.user.id)
      .query("SELECT credentialId, transports FROM UserPasskeys WHERE source=@s AND accountId=@a");

    const { generateRegistrationOptions } = await swa();
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: req.user.username,
      userID: new TextEncoder().encode(`${req.user.tenant || "default"}:${req.user.source}:${req.user.id}`),
      attestationType: "none",
      excludeCredentials: existing.recordset.map((r) => ({ id: r.credentialId, transports: r.transports ? r.transports.split(",") : undefined })),
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    });
    res.json({
      options,
      challengeToken: signChallenge({ purpose: "reg", ch: options.challenge, sid: req.user.id, src: req.user.source, tn: req.user.tenant || "default" }),
    });
  } catch (err) {
    console.error("PASSKEY REGISTER OPTIONS ERROR:", err);
    res.status(500).json({ message: "Could not start fingerprint / face setup." });
  }
});

router.post("/register/verify", protect, async (req, res) => {
  try {
    const rp = resolveRp(req);
    if (!rp) return res.status(400).json({ message: "This website address isn't allowed for passkeys." });
    const ch = readChallenge(req.body?.challengeToken, "reg");
    if (!ch || ch.sid !== req.user.id || ch.src !== req.user.source) return res.status(400).json({ message: "That setup expired. Please try again." });

    const { verifyRegistrationResponse } = await swa();
    const v = await verifyRegistrationResponse({
      response: req.body.response, expectedChallenge: ch.ch, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) return res.status(400).json({ message: "Could not verify this device." });

    const { credential } = v.registrationInfo;
    const pool = req.pool;
    await ensureTable(pool, req.user.tenant);
    const label = String(req.body?.label || "").trim().slice(0, 100) || "This device";
    await pool.request()
      .input("s", sql.NVarChar(20), req.user.source).input("a", sql.Int, req.user.id)
      .input("cid", sql.NVarChar(400), credential.id).input("pk", sql.NVarChar(sql.MAX), toB64(credential.publicKey))
      .input("ctr", sql.BigInt, credential.counter || 0).input("tr", sql.NVarChar(200), (credential.transports || []).join(",") || null)
      .input("label", sql.NVarChar(100), label)
      .query(`INSERT INTO UserPasskeys (source, accountId, credentialId, publicKey, counter, transports, label)
              VALUES (@s, @a, @cid, @pk, @ctr, @tr, @label)`);
    res.json({ success: true, message: "Fingerprint / face login is on for this device." });
  } catch (err) {
    console.error("PASSKEY REGISTER VERIFY ERROR:", err);
    res.status(400).json({ message: "Could not save this device. Please try again." });
  }
});

router.get("/list", protect, async (req, res) => {
  try {
    if (!TABLES[req.user.source]) return res.json([]);
    await ensureTable(req.pool, req.user.tenant);
    const r = await req.pool.request()
      .input("s", sql.NVarChar(20), req.user.source).input("a", sql.Int, req.user.id)
      .query("SELECT id, label, createdAt, lastUsedAt FROM UserPasskeys WHERE source=@s AND accountId=@a ORDER BY createdAt DESC");
    res.json(r.recordset);
  } catch (err) {
    console.error("PASSKEY LIST ERROR:", err);
    res.status(500).json([]);
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    await ensureTable(req.pool, req.user.tenant);
    const r = await req.pool.request()
      .input("id", sql.Int, id).input("s", sql.NVarChar(20), req.user.source).input("a", sql.Int, req.user.id)
      .query("DELETE FROM UserPasskeys WHERE id=@id AND source=@s AND accountId=@a; SELECT @@ROWCOUNT AS n;");
    if (!r.recordset[0]?.n) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("PASSKEY DELETE ERROR:", err);
    res.status(500).json({ message: "Could not remove it." });
  }
});

/* =========================================================
   SIGN IN  (public)
========================================================= */
router.post("/login/options", async (req, res) => {
  try {
    const rp = resolveRp(req);
    if (!rp) return res.status(400).json({ message: "Fingerprint / face login isn't set up for this website address yet." });
    const { generateAuthenticationOptions } = await swa();
    // Empty allowCredentials = the device offers the passkeys it holds for this site.
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
    res.json({ options, challengeToken: signChallenge({ purpose: "auth", ch: options.challenge }) });
  } catch (err) {
    console.error("PASSKEY LOGIN OPTIONS ERROR:", err);
    res.status(500).json({ message: "Could not start fingerprint / face sign-in." });
  }
});

router.post("/login/verify", async (req, res) => {
  const fail = (code, message) => res.status(code).json({ message });
  try {
    const rp = resolveRp(req);
    if (!rp) return fail(400, "This website address isn't allowed for passkeys.");
    const ch = readChallenge(req.body?.challengeToken, "auth");
    if (!ch) return fail(400, "That sign-in expired. Please try again.");
    const response = req.body?.response;
    const credentialId = String(response?.id || "");
    if (!credentialId) return fail(400, "Invalid request.");

    // The passkey could live in any school's database: find it by credential id.
    let found = null;
    for (const tenant of listTenantKeys()) {
      try {
        const pool = await getPool(tenant);
        await ensureTable(pool, tenant);
        const r = await pool.request().input("cid", sql.NVarChar(400), credentialId)
          .query("SELECT * FROM UserPasskeys WHERE credentialId=@cid");
        if (r.recordset[0]) { found = { pool, tenant, row: r.recordset[0] }; break; }
      } catch (e) { /* try the next school */ }
    }
    if (!found) return fail(401, "This device isn't registered. Sign in with your password, then turn on fingerprint / face login.");

    const { pool, tenant, row } = found;
    const { verifyAuthenticationResponse } = await swa();
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.ch, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: row.credentialId, publicKey: fromB64(row.publicKey), counter: Number(row.counter) || 0, transports: row.transports ? row.transports.split(",") : undefined },
    });
    if (!v.verified) return fail(401, "Could not verify you. Try again or use your password.");

    await pool.request().input("id", sql.Int, row.id).input("c", sql.BigInt, v.authenticationInfo.newCounter || 0)
      .query("UPDATE UserPasskeys SET counter=@c, lastUsedAt=GETDATE() WHERE id=@id");

    const table = TABLES[row.source];
    const ur = await pool.request().input("id", sql.Int, row.accountId).query(`SELECT * FROM ${table} WHERE id=@id`);
    const user = ur.recordset[0];
    if (!user) return fail(401, "Account not found.");

    /* same role/permission rules as the password login (routes/auth.js) */
    const source = row.source;
    let role = "user";
    let permissions = [];
    if (source === "Students") role = "student";
    else if (source === "Teachers") role = "teacher";
    else {
      const dbRole = (user.role || "").toLowerCase();
      if (dbRole === "admin") role = "admin";
      else if (dbRole === "sub_admin" || dbRole === "staff") role = "sub_admin";
      else if (dbRole === "sub_admin_2") role = "sub_admin_2";
      else if (dbRole === "module_admin") role = "module_admin";
      else if (dbRole === "finance") role = "finance";
      if (role === "sub_admin" || role === "sub_admin_2" || role === "module_admin") {
        try { const p = JSON.parse(user.permissions || "[]"); permissions = Array.isArray(p) ? p : []; } catch { permissions = []; }
      }
    }
    if (role === "finance") return fail(403, "Finance accounts must sign in with password and authenticator code.");
    if (user.mustChangePassword) return fail(403, "Please sign in with your password once to set a new password.");

    const mustChangePassword = false;
    const profileIncomplete = source === "Students" && !user.profileCompleted;
    const token = jwt.sign(
      { id: user.id, username: user.username, role, permissions, source, tenant, mustChangePassword, profileIncomplete, isMaster: !!user.isMaster },
      SECRET(), { expiresIn: "1d" }
    );
    res.json({
      token,
      user: {
        id: user.id, username: user.username, name: user.name || "", role, permissions, source, tenant,
        subject: user.subject || null, photoUrl: user.photoUrl || null, mustChangePassword, profileIncomplete, isMaster: !!user.isMaster,
      },
    });
  } catch (err) {
    console.error("PASSKEY LOGIN VERIFY ERROR:", err);
    res.status(401).json({ message: "Could not verify you. Try again or use your password." });
  }
});

module.exports = router;
module.exports.ensureTable = ensureTable;
