const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const { sql, poolPromise } = require("../config/db");

/* =========================================================
   REGISTER (USERS ONLY - KEEP AS IS)
========================================================= */
const registerUser = async (req, res) => {
  try {
    const { username, password, role } = req.body;

    const pool = await poolPromise;

    const check = await pool.request()
      .input("username", sql.NVarChar, username)
      .query("SELECT * FROM Users WHERE username = @username");

    if (check.recordset.length > 0) {
      return res.status(400).json({ message: "User exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.request()
      .input("username", sql.NVarChar, username)
      .input("password", sql.NVarChar, hashed)
      .input("role", sql.NVarChar, role || "student")
      .query(`
        INSERT INTO Users (username, password, role)
        VALUES (@username, @password, @role)
      `);

    res.json({ message: "User created" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================
   LOGIN (FIXED - ALL SYSTEMS)
========================================================= */
const loginUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    const pool = await poolPromise;

    let user = null;
    let role = null;
    let source = null;

    /* ================= USERS ================= */
    const userRes = await pool.request()
      .input("username", sql.NVarChar, username)
      .query("SELECT * FROM Users WHERE username = @username");

    if (userRes.recordset.length > 0) {
      user = userRes.recordset[0];
      role = user.role;
      source = "Users";
    }

    /* ================= STUDENTS ================= */
    if (!user) {
      const studentRes = await pool.request()
        .input("username", sql.NVarChar, username)
        .query("SELECT * FROM Students WHERE username = @username");

      if (studentRes.recordset.length > 0) {
        user = studentRes.recordset[0];
        role = "student";
        source = "Students";
      }
    }

    /* ================= TEACHERS ================= */
    if (!user) {
      const teacherRes = await pool.request()
        .input("username", sql.NVarChar, username)
        .query("SELECT * FROM Teachers WHERE username = @username");

      if (teacherRes.recordset.length > 0) {
        user = teacherRes.recordset[0];
        role = "teacher";
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
      return res.status(500).json({
        message: "Account password missing"
      });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
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
      }
    });

  } catch (err) {
    console.log("LOGIN ERROR:", err);
    return res.status(500).json({
      message: "Server error"
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
};