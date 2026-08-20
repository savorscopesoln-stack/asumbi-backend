const express = require("express");
const bcrypt = require("bcrypt");
const fs = require("fs");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { PAGE_KEYS, sanitizePermissions } = require("../utils/pages");
const { photoUrlFor, deletePhotoByUrl, runPhotoUpload } = require("../middleware/photoUpload");

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
  // Parsed here (rather than as route middleware) so a bad/missing file
  // fails with the same 400 JSON shape as any other missing field below,
  // instead of an unhandled multer error.
  try {
    await runPhotoUpload(req, res);
  } catch (err) {
    return res.status(400).json({ message: err.message || "Photo upload failed" });
  }

  const uploadedPhotoPath = req.file ? req.file.path : null;

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
      if (uploadedPhotoPath) fs.unlink(uploadedPhotoPath, () => {});
      return res.status(400).json({ message: "All fields required" });
    }

    // ✅ PROFILE PHOTO REQUIRED
    if (!req.file) {
      return res.status(400).json({ message: "A profile photo is required" });
    }

    // ✅ CHECK DUPLICATE
    const exists = await pool.request()
      .input("admissionNo", admissionNo)
      .query(`SELECT id FROM Students WHERE admissionNo = @admissionNo`);

    if (exists.recordset.length > 0) {
      fs.unlink(uploadedPhotoPath, () => {});
      return res.status(400).json({ message: "Student already exists" });
    }

    // ================= LOGIN GENERATION =================
    const username = admissionNo;
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const photoUrl = photoUrlFor(req.file.filename);

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
      .input("photoUrl", photoUrl)
      .query(`
        INSERT INTO Students 
        (name, admissionNo, studentClass, gender, yearOfStudy, status, username, password, role, mustChangePassword, photoUrl)
        VALUES 
        (@name, @admissionNo, @studentClass, @gender, @yearOfStudy, 'active', @username, @password, @role, 1, @photoUrl)
      `);

    res.status(201).json({
      message: "Student registered",
      credentials: {
        username,
        password: plainPassword // 🔥 send back plain password ONCE
      }
    });

  } catch (err) {
    if (uploadedPhotoPath) deletePhotoByUrl(uploadedPhotoPath);
    console.log("REGISTER STUDENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   REGISTER TEACHER
========================================================= */
router.post("/teacher", async (req, res) => {
  try {
    await runPhotoUpload(req, res);
  } catch (err) {
    return res.status(400).json({ message: err.message || "Photo upload failed" });
  }

  const uploadedPhotoPath = req.file ? req.file.path : null;

  try {
    const pool = req.pool;

    const { name, subject, phone, staffId } = req.body;

    // ✅ VALIDATION
    if (!name || !subject || !phone || !staffId) {
      if (uploadedPhotoPath) fs.unlink(uploadedPhotoPath, () => {});
      return res.status(400).json({ message: "All fields required" });
    }

    // ✅ PROFILE PHOTO REQUIRED
    if (!req.file) {
      return res.status(400).json({ message: "A profile photo is required" });
    }

    // 📱 Kenyan phone validation
    if (!/^(\+254|0)[7-9]\d{8}$/.test(phone)) {
      fs.unlink(uploadedPhotoPath, () => {});
      return res.status(400).json({ message: "Invalid phone number" });
    }

    // ✅ CHECK DUPLICATE
    const exists = await pool.request()
      .input("staffId", staffId)
      .query(`SELECT id FROM Teachers WHERE staffId = @staffId`);

    if (exists.recordset.length > 0) {
      fs.unlink(uploadedPhotoPath, () => {});
      return res.status(400).json({ message: "Teacher already exists" });
    }

    // ================= LOGIN GENERATION =================
    const username = staffId;
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const photoUrl = photoUrlFor(req.file.filename);

    // ================= INSERT =================
    await pool.request()
      .input("name", name)
      .input("subject", subject)
      .input("phone", phone)
      .input("staffId", staffId)
      .input("username", username)
      .input("password", hashedPassword)
      .input("role", "teacher")
      .input("photoUrl", photoUrl)
      .query(`
        INSERT INTO Teachers 
        (name, subject, phone, staffId, username, password, role, mustChangePassword, photoUrl)
        VALUES 
        (@name, @subject, @phone, @staffId, @username, @password, @role, 1, @photoUrl)
      `);

    res.status(201).json({
      message: "Teacher registered",
      credentials: {
        username,
        password: plainPassword
      }
    });

  } catch (err) {
    if (uploadedPhotoPath) deletePhotoByUrl(uploadedPhotoPath);
    console.log("REGISTER TEACHER ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================================================
   REGISTER ADMIN / SUB-ADMIN ACCOUNT (Users table)
   Admin-only — this is how a super-admin creates smaller
   accounts one at a time, each with a random one-time
   password that must be changed on first login.

   role: "admin" (full access), "sub_admin", or "sub_admin_2"
   (both sub-admin tiers are limited to whichever pages are
   listed in `permissions`, chosen right here at setup time —
   there's no separate step to grant access later, so a
   sub-admin's pages are locked in now). sub_admin and
   sub_admin_2 are two independent, equally-capable tiers —
   useful when an admin wants to create a second, separate
   batch of limited-access accounts.
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
    const SUB_ADMIN_ROLES = ["sub_admin", "sub_admin_2"];

    if (!["admin", ...SUB_ADMIN_ROLES].includes(normalizedRole)) {
      return res.status(400).json({
        message: `Invalid role. Must be "admin", "sub_admin", or "sub_admin_2".`,
      });
    }

    // Admins always have full access; either sub-admin tier needs a
    // permissions list, and it must contain at least one page —
    // otherwise the account would be created with nowhere to go.
    if (SUB_ADMIN_ROLES.includes(normalizedRole)) {
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