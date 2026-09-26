const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, poolPromise, getPool, listTenantKeys } = require("../config/db");
const { protect, requirePage } = require("../middleware/authMiddleware");
const { verifyToken } = require("../utils/totp");

// Password every admin-reset account is set back to. Kept as one named
// constant so it's easy to change later without hunting through the file.
const DEFAULT_RESET_PASSWORD = "1234";

// Whitelisted so a table name can never be built from unchecked input.
const SOURCE_TABLE = {
  Users: "Users",
  Students: "Students",
  Teachers: "Teachers",
};

/* =========================================================
   LOGIN (ALL USERS - MULTI-TENANT)
   ─────────────────────────────────────────────────────────
   Tries every configured tenant database in turn — the "default"
   DB first, then any extra tenants listed in DB_TENANTS (e.g.
   "eregi") — checking Users, then Students, then Teachers in each,
   until a matching username is found, instead of only ever looking
   at one hard-coded database. See config/db.js for how tenants are
   declared. Whichever DB the match came from is stamped into the
   JWT as `tenant`, so later requests (server.js's DB middleware)
   get routed back to that same database automatically.
========================================================= */
router.post("/login", async (req, res) => {
  try {
    let { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: "Username and password required"
      });
    }

    // ================= NORMALIZE INPUT =================
    username = username.trim();

    let user = null;
    let source = null;
    let tenant = null;

    for (const tenantKey of listTenantKeys()) {
      const pool = await getPool(tenantKey);

      /* ================= USERS ================= */
      const userRes = await pool.request()
        .input("username", sql.NVarChar, username)
        .query("SELECT * FROM Users WHERE username = @username");

      if (userRes.recordset.length > 0) {
        user = userRes.recordset[0];
        source = "Users";
        tenant = tenantKey;
        break;
      }

      /* ================= STUDENTS ================= */
      const studentRes = await pool.request()
        .input("username", sql.NVarChar, username)
        .query("SELECT * FROM Students WHERE username = @username");

      if (studentRes.recordset.length > 0) {
        user = studentRes.recordset[0];
        source = "Students";
        tenant = tenantKey;
        break;
      }

      /* ================= TEACHERS ================= */
      const teacherRes = await pool.request()
        .input("staffId", sql.NVarChar, username)
        .query("SELECT * FROM Teachers WHERE username = @staffId");

      if (teacherRes.recordset.length > 0) {
        user = teacherRes.recordset[0];
        source = "Teachers";
        tenant = tenantKey;
        break;
      }
    }

    /* ================= NOT FOUND (in any tenant) ================= */
    if (!user) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    console.log("Lookup result:", { username, found: !!user, source, tenant });

    /* ================= PASSWORD CHECK ================= */
    if (!user.password) {
      return res.status(401).json({
        message: "Account password missing or not set"
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }
    /* ================= ROLE SYSTEM =================
       Four account tiers exist in the Users table now:
       "admin" (full access, every page), "sub_admin" and
       "sub_admin_2" (limited admin capabilities AND limited to
       whichever pages were granted at setup — two independent,
       equally-capable tiers), and "module_admin" (FULL admin
       capabilities, same as "admin", but still limited to whichever
       pages were granted at setup — see authMiddleware.js's
       authorize()/requirePage() for exactly how each tier is
       enforced). Any legacy "staff" rows are migrated to
       "sub_admin" on server boot (ensureSchema), but the
       fallback below covers it defensively too. */
    let role = "user";
    let permissions = [];

    if (source === "Students") {
      role = "student";
    } 
    else if (source === "Teachers") {
      role = "teacher";
    } 
    else {
      const dbRole = (user.role || "").toLowerCase();

      if (dbRole === "admin") role = "admin";
      else if (dbRole === "sub_admin" || dbRole === "staff") role = "sub_admin";
      else if (dbRole === "sub_admin_2") role = "sub_admin_2";
      // "module_admin" — full admin CAPABILITIES (see authMiddleware.js's
      // authorize() bypass), but page access is limited by its own
      // permissions list, same as the sub_admin tiers just above.
      else if (dbRole === "module_admin") role = "module_admin";
      // "finance" — Doravo Finance (wallet/credit-ledger system).
      // Deliberately NOT given the authorize() admin bypass anywhere —
      // see middleware/financeAuth.js's financeOnly, which every
      // routes/finance.js endpoint uses instead of authorize("finance").
      else if (dbRole === "finance") role = "finance";

      if (role === "sub_admin" || role === "sub_admin_2" || role === "module_admin") {
        try {
          const parsed = JSON.parse(user.permissions || "[]");
          permissions = Array.isArray(parsed) ? parsed : [];
        } catch {
          permissions = [];
        }
      }
    }

    /* ================= FINANCE MFA CHALLENGE =================
       If this finance account has MFA enabled (Users.mfaEnabled —
       ensureSchema.js, set via POST /api/finance/mfa/confirm), a
       correct username+password is only step one. Instead of the
       real access token, hand back a short-lived (5 min) pre-auth
       token that ONLY proves "this password check already passed" —
       it carries no role/permissions and is rejected by every normal
       protect-gated route (no matching role) — and the frontend must
       exchange it at POST /api/auth/finance-mfa/verify along with the
       current 6-digit code before a real token is ever issued. This
       never touches student/teacher/admin login at all — the branch
       is only reachable for role === "finance" && mfaEnabled. */
    if (role === "finance" && user.mfaEnabled) {
      const mfaToken = jwt.sign(
        { id: user.id, tenant, mfaPending: true },
        process.env.JWT_SECRET || "doravo_core_secret",
        { expiresIn: "5m" }
      );
      return res.json({ mfaRequired: true, mfaToken });
    }

    /* ================= TOKEN =================
       profileIncomplete only ever applies to students (see
       Students.profileCompleted in ensureSchema.js) — it drives the
       "complete your profile" step shown right after their first
       forced password change. */
    const mustChangePassword = !!user.mustChangePassword;
    const profileIncomplete = source === "Students" && !user.profileCompleted;

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role,
        permissions,
        source,
        tenant,
        mustChangePassword,
        profileIncomplete,
      },
      process.env.JWT_SECRET || "doravo_core_secret",
      { expiresIn: "1d" }
    );

    /* ================= RESPONSE ================= */
    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name || "",
        role,
        permissions,
        source,
        tenant,
        subject: user.subject || null,
        photoUrl: user.photoUrl || null,
        mustChangePassword,
        profileIncomplete,
      }
    });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      message: "Server error"
    });
  }
});

/* =========================================================
   FINANCE MFA — VERIFY
   Exchanges the short-lived mfaToken from the login response above
   (issued only when role === "finance" && Users.mfaEnabled) plus the
   current 6-digit authenticator code for a real, full access token —
   otherwise identical in shape to what /login itself returns, so the
   frontend's existing login-success handling (store token, store
   user, navigate by role) works unchanged for the MFA path too.
========================================================= */
router.post("/finance-mfa/verify", async (req, res) => {
  try {
    const { mfaToken, code } = req.body || {};
    if (!mfaToken || !code) {
      return res.status(400).json({ message: "mfaToken and code are required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(mfaToken, process.env.JWT_SECRET || "doravo_core_secret");
    } catch {
      return res.status(401).json({ message: "MFA challenge expired — please log in again" });
    }
    if (!decoded?.mfaPending || !decoded?.id || !decoded?.tenant) {
      return res.status(401).json({ message: "Invalid MFA challenge" });
    }

    const pool = await getPool(decoded.tenant);
    const userRes = await pool.request()
      .input("id", sql.Int, decoded.id)
      .query(`SELECT * FROM Users WHERE id = @id`);
    const user = userRes.recordset[0];
    if (!user || user.role?.toLowerCase() !== "finance" || !user.mfaSecret) {
      return res.status(401).json({ message: "Invalid MFA challenge" });
    }

    if (!verifyToken(user.mfaSecret, code)) {
      return res.status(401).json({ message: "Incorrect or expired code" });
    }

    // From here on this is exactly the normal finance login response —
    // same claim shape /login issues for every other role, so nothing
    // downstream (protect, financeOnly, the frontend) needs to know
    // this token came via the MFA step rather than straight from
    // /login.
    const mustChangePassword = !!user.mustChangePassword;
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: "finance",
        permissions: [],
        source: "Users",
        tenant: decoded.tenant,
        mustChangePassword,
        profileIncomplete: false,
      },
      process.env.JWT_SECRET || "doravo_core_secret",
      { expiresIn: "1d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name || "",
        role: "finance",
        permissions: [],
        source: "Users",
        tenant: decoded.tenant,
        mustChangePassword,
        profileIncomplete: false,
      },
    });
  } catch (err) {
    console.log("FINANCE MFA VERIFY ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   CHANGE PASSWORD (ALL USERS - Users / Students / Teachers)
   Works for whichever table the logged-in account came from,
   identified by req.user.source set by the protect middleware
   from the JWT issued at login.
========================================================= */
router.put("/change-password", protect, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        message: "Old password and new password are required",
      });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        message: "New password must be at least 6 characters",
      });
    }

    const table = SOURCE_TABLE[req.user.source];

    if (!table) {
      return res.status(400).json({
        message: "Unable to determine account type for this user",
      });
    }

    // req.pool is already resolved to this account's tenant DB by
    // server.js's DB middleware (it reads the same `tenant` claim off
    // this request's JWT), so no separate tenant lookup is needed here.
    const pool = req.pool;

    const userRes = await pool.request()
      .input("id", sql.Int, req.user.id)
      .query(`SELECT * FROM ${table} WHERE id = @id`);

    const account = userRes.recordset[0];

    if (!account || !account.password) {
      return res.status(404).json({ message: "Account not found" });
    }

    const isMatch = await bcrypt.compare(oldPassword, account.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Old password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("password", sql.NVarChar, hashed)
      .query(`UPDATE ${table} SET password = @password, mustChangePassword = 0 WHERE id = @id`);

    /* ================= REISSUE TOKEN =================
       The old token still carries mustChangePassword: true baked in
       from login, and `protect` reads that claim straight off the
       token rather than re-querying the DB every request — so
       without a fresh token every subsequent call would still get
       blocked with PASSWORD_CHANGE_REQUIRED. Mint a new one here with
       the flag cleared (and profileIncomplete carried over for
       students) so the frontend can swap it in immediately. */
    const profileIncomplete =
      req.user.source === "Students" && !account.profileCompleted;

    const newToken = jwt.sign(
      {
        id: account.id,
        username: account.username,
        role: req.user.role,
        permissions: req.user.permissions,
        source: req.user.source,
        tenant: req.user.tenant,
        mustChangePassword: false,
        profileIncomplete,
      },
      process.env.JWT_SECRET || "doravo_core_secret",
      { expiresIn: "1d" }
    );

    return res.json({
      message: "Password updated successfully",
      token: newToken,
      user: {
        id: account.id,
        username: account.username,
        name: account.name || "",
        role: req.user.role,
        permissions: req.user.permissions,
        source: req.user.source,
        tenant: req.user.tenant,
        subject: account.subject || null,
        photoUrl: account.photoUrl || null,
        mustChangePassword: false,
        profileIncomplete,
      },
    });

  } catch (err) {
    console.log("CHANGE PASSWORD ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   ADMIN: RESET ANY ACCOUNT'S PASSWORD TO THE DEFAULT
   Body: { id, source } where source is "Users" | "Students" | "Teachers"
   (this is the same `source` value already used everywhere else,
   and is exactly what /api/records?type=... returns for each row).
   Sets mustChangePassword = 1 so the account is forced to pick its
   own password the next time it logs in.
========================================================= */
router.put("/admin/reset-password", protect, requirePage("Password Reset"), async (req, res) => {
  try {
    const { id, source } = req.body;
    const table = SOURCE_TABLE[source];

    if (!table || !id) {
      return res.status(400).json({
        message: "id and a valid source (Users, Students, or Teachers) are required",
      });
    }

    // req.pool is already resolved to this account's tenant DB by
    // server.js's DB middleware (it reads the same `tenant` claim off
    // this request's JWT), so no separate tenant lookup is needed here.
    const pool = req.pool;

    const check = await pool.request()
      .input("id", sql.Int, id)
      .query(`SELECT id, username FROM ${table} WHERE id = @id`);

    const account = check.recordset[0];

    if (!account) {
      return res.status(404).json({ message: "Account not found" });
    }

    const hashed = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 10);

    await pool.request()
      .input("id", sql.Int, id)
      .input("password", sql.NVarChar, hashed)
      .query(`UPDATE ${table} SET password = @password, mustChangePassword = 1 WHERE id = @id`);

    return res.json({
      message: "Password reset to default",
      username: account.username,
      defaultPassword: DEFAULT_RESET_PASSWORD,
    });

  } catch (err) {
    console.log("ADMIN RESET PASSWORD ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;