const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sql, poolPromise } = require("../config/db");

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

    /* ================= ROLE SYSTEM ================= */
    let role = "user";

    if (source === "Students") {
      role = "student";
    } 
    else if (source === "Teachers") {
      role = "teacher";
    } 
    else {
      const dbRole = (user.role || "").toLowerCase();

      if (dbRole === "admin") role = "admin";
      else if (dbRole === "sub_admin") role = "sub_admin";
      else if (dbRole === "sub_admin_2") role = "sub_admin_2";
    }

    /* ================= TOKEN ================= */
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role,
        source,
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
        source,
        subject: user.subject || null
      }
    });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      message: "Server error"
    });
  }
});

module.exports = router;