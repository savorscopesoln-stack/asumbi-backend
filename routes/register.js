const express = require("express");
const bcrypt = require("bcrypt");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { PAGE_KEYS, sanitizePermissions } = require("../utils/pages");

/* =========================================================
   HELPER: GENERATE DEFAULT PASSWORD
========================================================= */
const generatePassword = () => {
  return Math.random().toString(36).slice(-8); // e.g. x8k3p9q2
};

/* =========================================================
   REGISTER STUDENT
========================================================= */
router.post("/student", async (req, res) => {
  try {
    const pool = req.pool;

    const {
      name,
      admissionNo,
      studentClass,
      gender,
      yearOfStudy,
    } = req.body;

    // ✅ VALIDATION
    if (!name || !admissionNo || !studentClass || !gender || !yearOfStudy) {
      return res.status(400).json({ message: "All fields required" });
    }

    // ✅ CHECK DUPLICATE
    const exists = await pool.request()
      .input("admissionNo", admissionNo)
      .query(`SELECT id FROM Students WHERE admissionNo = @admissionNo`);

    if (exists.recordset.length > 0) {
      return res.status(400).json({ message: "Student already exists" });
    }

    // ================= LOGIN GENERATION =================
    const username = admissionNo;
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // ================= INSERT =================
    await pool.request()
      .input("name", name)
      .input("admissionNo", admissionNo)
      .input("studentClass", studentClass)
      .input("gender", gender)
      .input("yearOfStudy", yearOfStudy)
      .input("username", username)
      .input("password", hashedPassword)
      .input("role", "student")
      .query(`
        INSERT INTO Students 
        (name, admissionNo, studentClass, gender, yearOfStudy, status, username, password, role, mustChangePassword)
        VALUES 
        (@name, @admissionNo, @studentClass, @gender, @yearOfStudy, 'active', @username, @password, @role, 1)
      `);

    res.status(201).json({
      message: "Student registered",
      credentials: {
        username,
        password: plainPassword // 🔥 send back plain password ONCE
      }
    });

  } catch (err) {
    console.log("REGISTER STUDENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   REGISTER TEACHER
========================================================= */
router.post("/teacher", async (req, res) => {
  try {
    const pool = req.pool;

    const { name, subject, phone, staffId } = req.body;

    // ✅ VALIDATION
    if (!name || !subject || !phone || !staffId) {
      return res.status(400).json({ message: "All fields required" });
    }

    // 📱 Kenyan phone validation
    if (!/^(\+254|0)[7-9]\d{8}$/.test(phone)) {
      return res.status(400).json({ message: "Invalid phone number" });
    }

    // ✅ CHECK DUPLICATE
    const exists = await pool.request()
      .input("staffId", staffId)
      .query(`SELECT id FROM Teachers WHERE staffId = @staffId`);

    if (exists.recordset.length > 0) {
      return res.status(400).json({ message: "Teacher already exists" });
    }

    // ================= LOGIN GENERATION =================
    const username = staffId;
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // ================= INSERT =================
    await pool.request()
      .input("name", name)
      .input("subject", subject)
      .input("phone", phone)
      .input("staffId", staffId)
      .input("username", username)
      .input("password", hashedPassword)
      .input("role", "teacher")
      .query(`
        INSERT INTO Teachers 
        (name, subject, phone, staffId, username, password, role, mustChangePassword)
        VALUES 
        (@name, @subject, @phone, @staffId, @username, @password, @role, 1)
      `);

    res.status(201).json({
      message: "Teacher registered",
      credentials: {
        username,
        password: plainPassword
      }
    });

  } catch (err) {
    console.log("REGISTER TEACHER ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   REGISTER ADMIN / SUB-ADMIN ACCOUNT (Users table)
   Admin-only — this is how a super-admin creates smaller
   accounts one at a time, each with a random one-time
   password that must be changed on first login.

   role: "admin" (full access) or "sub_admin" (limited to
   whichever pages are listed in `permissions`, chosen right
   here at setup time — there's no separate step to grant
   access later, so a sub_admin's pages are locked in now).
========================================================= */
router.post("/user", protect, adminOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const { username, role, email } = req.body;
    let { permissions } = req.body;

    if (!username || !role) {
      return res.status(400).json({ message: "username and role are required" });
    }

    const normalizedRole = String(role).toLowerCase().trim();

    if (!["admin", "sub_admin"].includes(normalizedRole)) {
      return res.status(400).json({
        message: `Invalid role. Must be "admin" or "sub_admin".`,
      });
    }

    // Admins always have full access; only a sub_admin needs a
    // permissions list, and it must contain at least one page —
    // otherwise the account would be created with nowhere to go.
    if (normalizedRole === "sub_admin") {
      permissions = sanitizePermissions(permissions);

      if (permissions.length === 0) {
        return res.status(400).json({
          message: "Select at least one page this sub-admin can access.",
          availablePages: PAGE_KEYS,
        });
      }
    } else {
      permissions = [];
    }

    const exists = await pool.request()
      .input("username", username)
      .query(`SELECT id FROM Users WHERE username = @username`);

    if (exists.recordset.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    await pool.request()
      .input("username", username)
      .input("role", normalizedRole)
      .input("email", email || null)
      .input("password", hashedPassword)
      .input("permissions", JSON.stringify(permissions))
      .query(`
        INSERT INTO Users (username, role, email, password, mustChangePassword, permissions)
        VALUES (@username, @role, @email, @password, 1, @permissions)
      `);

    res.status(201).json({
      message: "Account created",
      credentials: {
        username,
        password: plainPassword, // 🔥 send back plain password ONCE
        role: normalizedRole,
        permissions,
      },
    });

  } catch (err) {
    console.log("REGISTER USER ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;