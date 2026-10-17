/* =========================================================================
   MASTER ADMIN — one protected platform account inside every tenant DB.

   What it is
     A normal-looking Users row with role = 'admin' (so every existing admin
     capability and screen works for it with no other code change) plus
     isMaster = 1. Its job is platform-level access to a school's system that
     the school's own administrators can neither remove, lock out nor change.

   How it is protected (defence in depth)
     1. DATABASE TRIGGER (the real guarantee): TR_Users_master_protect rejects
        any INSERT / UPDATE / DELETE that touches a row with isMaster = 1 —
        no matter which code path attempted it, including the admin "Data
        Manager" raw record editor, bulk uploads, or a bug. The only way past
        it is the secret token this module sets in the session's CONTEXT_INFO
        while seeding. The token is derived from the master password, and the
        trigger is re-created with the current token on every boot.
     2. HIDDEN: the account is filtered out of every user listing, search,
        count and notification list a tenant admin can reach.
     3. NO SELF-SERVICE: nothing in the tenant UI can change it, because the
        trigger refuses — including "change password". The password is
        controlled only by the deployment's environment (below).

   Configuration (environment — never hard-code credentials)
     MASTER_ADMIN_PASSWORD            required to create/refresh the account;
                                      without it nothing is seeded (a loud
                                      warning is logged) but the trigger still
                                      protects against forged master rows.
     MASTER_ADMIN_PASSWORD_<KEY>      optional per-tenant override (KEY is the
                                      tenant key uppercased, e.g. _EREGI).
     MASTER_ADMIN_USERNAME            base username, default "doravo-master".
     MASTER_ADMIN_EMAIL               optional.

   Username per tenant: `${base}_${tenantKey}` (e.g. doravo-master_default).
   Login searches every tenant for a username and signs the user into the
   first tenant that has it (routes/auth.js), so identical usernames across
   databases would always land in the same school. A per-tenant suffix makes
   each master login unambiguous.

   Rotating the password: change the env var and redeploy — boot re-hashes it
   into every tenant. A tenant admin cannot do this.
========================================================================= */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const TRIGGER_NAME = "TR_Users_master_protect";
const MASTER_MESSAGE = "The master admin account is protected and cannot be created, changed or deleted here.";

const keySuffix = (tenantKey) =>
  tenantKey === "default" ? "" : `_${String(tenantKey).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

function masterConfig(tenantKey, env = process.env) {
  const base = (env.MASTER_ADMIN_USERNAME || "doravo-master").trim() || "doravo-master";
  const scoped = env[`MASTER_ADMIN_PASSWORD${keySuffix(tenantKey)}`];
  const password = (scoped !== undefined && scoped !== "" ? scoped : env.MASTER_ADMIN_PASSWORD) || "";
  return {
    username: `${base}_${tenantKey}`,
    password,
    email: (env.MASTER_ADMIN_EMAIL || "").trim(),
  };
}

/* 16-byte secret the trigger recognises. Derived from the password so it is
   never stored anywhere readable; random when no password is configured, so
   the trigger still blocks every attempt (nobody can produce the token). */
function bypassToken(password, tenantKey) {
  if (!password) return crypto.randomBytes(16);
  return crypto.createHash("sha256").update(`master-admin|${tenantKey}|${password}`).digest().subarray(0, 16);
}

function triggerSql(tokenBuf) {
  const body = `
    CREATE OR ALTER TRIGGER ${TRIGGER_NAME} ON Users
    AFTER INSERT, UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      IF SUBSTRING(CONTEXT_INFO(), 1, 16) = 0x${tokenBuf.toString("hex")} RETURN;
      IF EXISTS (SELECT 1 FROM deleted WHERE ISNULL(isMaster, 0) = 1)
         OR EXISTS (SELECT 1 FROM inserted WHERE ISNULL(isMaster, 0) = 1)
      BEGIN
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW 51001, '${MASTER_MESSAGE}', 1;
      END
    END
  `;
  return `EXEC('${body.replace(/'/g, "''")}')`;
}

/* Boot-time, idempotent, never throws (a problem here must not stop the server). */
async function ensureMasterAdmin(pool, sql, tenantKey = "default", env = process.env) {
  try {
    const usersExist = await pool.request().query(`SELECT 1 AS ok FROM sysobjects WHERE name='Users' AND xtype='U'`);
    if (!usersExist.recordset.length) return;

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'isMaster' AND Object_ID = Object_ID(N'Users'))
      ALTER TABLE Users ADD isMaster BIT NOT NULL CONSTRAINT DF_Users_isMaster DEFAULT 0
    `);

    const cfg = masterConfig(tenantKey, env);
    const token = bypassToken(cfg.password, tenantKey);

    // 1. (re)install the trigger with the current token
    await pool.request().query(triggerSql(token));

    if (!cfg.password) {
      console.warn(`⚠️  Master admin NOT seeded for tenant "${tenantKey}": MASTER_ADMIN_PASSWORD is not set.`);
      return;
    }

    // 2. create / refresh the account (bypass token set for this batch only)
    const existing = await pool.request().query(`SELECT TOP 1 id, username, password FROM Users WHERE isMaster = 1`);
    const row = existing.recordset[0];

    if (!row) {
      const clash = await pool.request()
        .input("username", sql.NVarChar, cfg.username)
        .query(`SELECT id FROM Users WHERE username = @username`);
      if (clash.recordset.length) {
        console.warn(`⚠️  Master admin NOT seeded for tenant "${tenantKey}": username "${cfg.username}" is already used by another account.`);
        return;
      }
    }

    const needsHash = !row || !row.password || !(await bcrypt.compare(cfg.password, row.password));
    const needsName = !row || row.username !== cfg.username;
    if (row && !needsHash && !needsName) return; // already in sync

    const hash = needsHash ? await bcrypt.hash(cfg.password, 12) : row.password;
    await pool.request()
      .input("token", sql.VarBinary(16), token)
      .input("username", sql.NVarChar, cfg.username)
      .input("password", sql.NVarChar, hash)
      .input("email", sql.NVarChar, cfg.email)
      .query(`
        -- the bypass token lives on this pooled connection only for this batch;
        -- the CATCH makes sure it is cleared even if the statement fails
        BEGIN TRY
          SET CONTEXT_INFO @token;
          IF EXISTS (SELECT 1 FROM Users WHERE isMaster = 1)
            UPDATE Users SET username = @username, password = @password, role = 'admin',
                             permissions = NULL, mustChangePassword = 0
            WHERE isMaster = 1;
          ELSE
            INSERT INTO Users (username, role, email, password, mustChangePassword, isMaster)
            VALUES (@username, 'admin', @email, @password, 0, 1);
          SET CONTEXT_INFO 0x0;
        END TRY
        BEGIN CATCH
          SET CONTEXT_INFO 0x0;
          THROW;
        END CATCH
      `);
    console.log(`🔐 Master admin ${row ? "refreshed" : "created"} for tenant "${tenantKey}" (${cfg.username})`);
  } catch (err) {
    console.error(`⚠️  Master admin setup failed for tenant "${tenantKey}":`, err.message);
  }
}

/* SQL fragment that keeps the master out of a Users query. `alias` optional. */
const notMasterSql = (alias = "") => `ISNULL(${alias ? alias + "." : ""}isMaster, 0) = 0`;

module.exports = { ensureMasterAdmin, masterConfig, bypassToken, triggerSql, notMasterSql, MASTER_MESSAGE, TRIGGER_NAME };
