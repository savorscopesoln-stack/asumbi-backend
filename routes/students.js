const express = require("express");
const router = express.Router();
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");

// ================= UPLOAD ROUTE =================
router.post("/", async (req, res) => {
  try {
    const pool = req.pool;

    const file = req.files?.file;
    const type = req.body.type;

    if (!file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    // READ EXCEL FILE
    const workbook = XLSX.read(file.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    console.log("UPLOAD TYPE:", type);
    console.log("ROWS FOUND:", rows.length);

    // ================= STUDENTS =================
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

    // ================= TEACHERS (FIXED FOR LOGIN) =================
    if (type === "teachers") {
      for (let r of rows) {
        if (!r.name || !r.staffId) continue;

        const username = r.staffId; // 🔥 IMPORTANT FIX (login uses staffId)
        const password = "123456"; // default password
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.request()
          .input("name", r.name)
          .input("staffId", r.staffId)
          .input("subject", r.subject || "General")
          .input("phone", r.phone || null)
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

    // ================= USERS =================
    if (type === "users") {
      for (let r of rows) {
        if (!r.username) continue;

        const hashedPassword = await bcrypt.hash(r.password || "123456", 10);

        await pool.request()
          .input("username", r.username)
          .input("role", r.role || "user")
          .input("email", r.email || null)
          .input("password", hashedPassword)
          .query(`
            INSERT INTO Users (username, role, email, password)
            VALUES (@username, @role, @email, @password)
          `);
      }
    }

    res.json({
      message: "Upload successful",
      inserted: rows.length,
      type,
    });

  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;