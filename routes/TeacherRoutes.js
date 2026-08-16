const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const { sql } = require("../config/db");

const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   UPLOAD ROUTE
========================= */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const pool = req.pool;

    if (!pool) {
      return res.status(500).json({ message: "Database connection missing" });
    }

    const type = req.body.type;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!data.length) {
      return res.status(400).json({ message: "Empty file" });
    }

    /* =========================
       STUDENTS UPLOAD
    ========================= */
  if (type === "students") {

  for (let row of data) {

    const phone = (row.phone || "").toString().trim();

    let cleanPhone = phone;

    if (cleanPhone.startsWith("0")) {
      cleanPhone = "+254" + cleanPhone.substring(1);
    }

    const hashedPassword = await bcrypt.hash("1234", 10);

    await pool.request()

      .input("name", row.name)
      .input("admissionNo", row.admissionNo)
      .input(
        "studentClass",
        row.studentClass || row.class || "A"
      )
      .input("gender", row.gender || "Unknown")
      .input("status", row.status || "active")
      .input("email", row.email || null)
      .input("yearOfStudy", row.yearOfStudy || 1)
      .input("phone", cleanPhone)
      .input(
        "assessmentNumber",
        row.assessmentNumber || null
      )

      .input(
        "username",
        row.admissionNo
      )

      .input(
        "password",
        hashedPassword
      )

      .input("role", "student")

      .query(`
        INSERT INTO Students
        (
          name,
          admissionNo,
          studentClass,
          gender,
          status,
          email,
          yearOfStudy,
          username,
          password,
          role,
          phone,
          assessmentNumber
        )

        VALUES
        (
          @name,
          @admissionNo,
          @studentClass,
          @gender,
          @status,
          @email,
          @yearOfStudy,
          @username,
          @password,
          @role,
          @phone,
          @assessmentNumber
        )
      `);
  }
}

    /* =========================
       TEACHERS UPLOAD (LOGIN SAFE)
    ========================= */
    else if (type === "teachers") {
      for (let row of data) {

        const name = (row.name || "").toString().trim();
        const staffId = (row.staffId || "").toString().trim();
        const subject = (row.subject || "").toString().trim();
        const phone = (row.phone || "").toString().trim();

        if (!name || !staffId) continue;

        // 🔥 prevent duplicates
        const exists = await pool.request()
          .input("staffId", sql.NVarChar, staffId)
          .query("SELECT id FROM Teachers WHERE staffId = @staffId");

        if (exists.recordset.length > 0) continue;

        const username = staffId;
        const hashedPassword = await bcrypt.hash("123456", 10);

        await pool.request()
          .input("name", sql.NVarChar, name)
          .input("staffId", sql.NVarChar, staffId)
          .input("subject", sql.NVarChar, subject)
          .input("phone", sql.NVarChar, phone)
          .input("username", sql.NVarChar, username)
          .input("password", sql.NVarChar, hashedPassword)
          .input("role", sql.NVarChar, "teacher")
          .query(`
            INSERT INTO Teachers 
            (name, staffId, subject, phone, username, password, role)
            VALUES 
            (@name, @staffId, @subject, @phone, @username, @password, @role)
          `);
      }
    }

    /* =========================
       USERS UPLOAD
    ========================= */
    else if (type === "users") {
      for (let row of data) {

        const username = (row.username || "").toString().trim();
        const email = (row.email || "").toString().trim();
        const role = (row.role || "user").toString().toLowerCase();

        if (!username) continue;

        // 🔥 prevent duplicates
        const exists = await pool.request()
          .input("username", sql.NVarChar, username)
          .query("SELECT id FROM Users WHERE username = @username");

        if (exists.recordset.length > 0) continue;

        const hashedPassword = await bcrypt.hash(
          row.password || "123456",
          10
        );

        await pool.request()
          .input("username", sql.NVarChar, username)
          .input("role", sql.NVarChar, role)
          .input("email", sql.NVarChar, email)
          .input("password", sql.NVarChar, hashedPassword)
          .query(`
            INSERT INTO Users (username, role, email, password)
            VALUES (@username, @role, @email, @password)
          `);
      }
    }

    return res.json({
      message: "Upload successful",
      inserted: data.length,
    });

  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;