const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, poolPromise } = require("../config/db");
const { protect, requirePage } = require("../middleware/authMiddleware");

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
   LOGIN (ALL USERS - FIXED)
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

    const pool = await poolPromise;

    let user = null;
    let source = null;

    /* ================= USERS ================= */
    const userRes = await pool.request()
      .input("username", sql.NVarChar, username)
      .query("SELECT * FROM Users WHERE username = @username");

    if (userRes.recordset.length > 0) {
      user = userRes.recordset[0];
      source = "Users";
    }

    /* ================= STUDENTS ================= */
    if (!user) {
      const studentRes = await pool.request()
        .input("username", sql.NVarChar, username)
        .query("SELECT * FROM Students WHERE username = @username");

      if (studentRes.recordset.length > 0) {
        user = studentRes.recordset[0];
        source = "Students";
      }
    }

    /* ================= TEACHERS (FIXED + SAFE) ================= */
   /* ================= TEACHERS ================= */
if (!user) {
  const teacherRes = await pool.request()
    .input("staffId", sql.NVarChar, username)
    .query("SELECT * FROM Teachers WHERE username = @staffId");
    
  if (teacherRes.recordset.length > 0) {
    user = teacherRes.recordset[0];
    source = "Teachers";
  }
}
/* ================= NOT FOUND ================= */
    if (!user) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    console.log("Lookup result:", { username, found: !!user, source });

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
       Three account tiers exist in the Users table now:
       "admin" (full access), "sub_admin", and "sub_admin_2"
       (both sub-admin tiers have access limited to whichever
       pages were granted at setup, see user.permissions
       below — they're two independent, equally-capable
       tiers). Any legacy "staff" rows are migrated to
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

      if (role === "sub_admin" || role === "sub_admin_2") {
        try {
          const parsed = JSON.parse(user.permissions || "[]");
          permissions = Array.isArray(parsed) ? parsed : [];
        } catch {
          permissions = [];
        }
      }
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
        mustChangePassword,
        profileIncomplete,
      },
      process.env.JWT_SECRET || "asumbi_secret",
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

    const pool = await poolPromise;

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
        mustChangePassword: false,
        profileIncomplete,
      },
      process.env.JWT_SECRET || "asumbi_secret",
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

    const pool = await poolPromise;

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