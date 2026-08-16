const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");

const upload = multer({ storage: multer.memoryStorage() });

/* =========================
   UPLOAD ROUTE
========================= */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const pool = req.pool;
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
       TEACHERS UPLOAD (FIXED FOR LOGIN)
    ========================= */
    else if (type === "teachers") {
      for (let row of data) {

        const username = (row.staffId || "").toString().trim();

        // default password for login
        const plainPassword = "123456";
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        await pool.request()
          .input("name", row.name)
          .input("staffId", row.staffId)
          .input("subject", row.subject)
          .input("phone", row.phone)
          .input("username", username)
          .input("password", hashedPassword)
          .input("role", "teacher")
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

        const hashedPassword = await bcrypt.hash(row.password || "123456", 10);

        await pool.request()
          .input("username", row.username)
          .input("role", row.role)
          .input("email", row.email)
          .input("password", hashedPassword)
          .query(`
            INSERT INTO Users (username, role, email, password)
            VALUES (@username, @role, @email, @password)
          `);
      }
    }

    return res.json({ message: "Upload successful" });

  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;