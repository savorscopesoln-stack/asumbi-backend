const express = require("express");
const router = express.Router();
const XLSX = require("xlsx");
const bcrypt = require("bcrypt");
const sql = require("mssql");

// IMPORTANT: Multer middleware
const upload = require("../middleware/upload");

// ================= UPLOAD ROUTE =================
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const pool = req.pool;
    const type = req.body.type;

    // ================= FILE CHECK =================
    if (!req.file) {
      return res.status(400).json({
        message: "No file uploaded. Use form-data key: file"
      });
    }

    if (!type) {
      return res.status(400).json({
        message: "Upload type is required"
      });
    }

    // ================= READ EXCEL =================
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    console.log("UPLOAD TYPE:", type);
    console.log("ROWS FOUND:", rows.length);

    // =====================================================
    // ================= STUDENTS UPLOAD ====================
    // =====================================================
    // =====================================================
// ================= STUDENTS UPLOAD ====================
// =====================================================
if (type === "students") {
  for (let r of rows) {

    const name = (r.name || "").toString().trim();
    const admissionNo = (r.admissionNo || "").toString().trim();

    if (!name || !admissionNo) {
      console.log("SKIPPED INVALID STUDENT:", r);
      continue;
    }

    const studentClass = (r.studentClass || r.class || "A").toString().toUpperCase();
    const gender = (r.gender || "Unknown").toString();
    const email = r.email || null;
    const status = (r.status || "active").toString().toLowerCase();

    // ✅ SAFE PHONE HANDLING
    let phone = (r.phone || r.Phone || r.mobile || "").toString().trim();

    let cleanPhone = "";

    if (phone) {
      // remove spaces, dashes
      phone = phone.replace(/\s|-/g, "");

      if (phone.startsWith("0")) {
        cleanPhone = "+254" + phone.substring(1);
      } else if (phone.startsWith("+")) {
        cleanPhone = phone;
      } else {
        cleanPhone = phone; // fallback raw
      }
    }

    const yearOfStudy = Number.isFinite(parseInt(r.yearOfStudy))
      ? parseInt(r.yearOfStudy)
      : 1;

    // duplicate check
    const exists = await pool.request()
      .input("admissionNo", sql.NVarChar, admissionNo)
      .query(`SELECT id FROM Students WHERE admissionNo = @admissionNo`);

    if (exists.recordset.length > 0) {
      console.log(`SKIPPED DUPLICATE STUDENT: ${admissionNo}`);
      continue;
    }

    const username = admissionNo;
    const hashedPassword = await bcrypt.hash("1234", 10);

    await pool.request()
      .input("name", sql.NVarChar, name)
      .input("admissionNo", sql.NVarChar, admissionNo)
      .input("studentClass", sql.NVarChar, studentClass)
      .input("gender", sql.NVarChar, gender)
      .input("status", sql.NVarChar, status)
      .input("email", sql.NVarChar, email)
      .input("yearOfStudy", sql.Int, yearOfStudy)
      .input("username", sql.NVarChar, username)
      .input("password", sql.NVarChar, hashedPassword)
      .input("role", sql.NVarChar, "student")
      .input("phone", sql.NVarChar, cleanPhone || null)
      .query(`
        INSERT INTO Students
        (name, admissionNo, studentClass, gender, status, email, yearOfStudy, username, password, role, phone)
        VALUES
        (@name, @admissionNo, @studentClass, @gender, @status, @email, @yearOfStudy, @username, @password, @role, @phone)
      `);

    console.log(`✔ INSERTED STUDENT: ${name} (${admissionNo}) PHONE: ${cleanPhone}`);
  }
}

    // =====================================================
    // ================= TEACHERS UPLOAD ====================
    // =====================================================
    if (type === "teachers") {
      for (let r of rows) {

        const name = (r.name || "").toString().trim();
        const staffId = (r.staffId || "").toString().trim();
        const subject = (r.subject || "General").toString();
        const phone = (r.phone || "").toString().trim();
        const email = r.email || null;

        if (!name || !staffId) {
          console.log("SKIPPED INVALID TEACHER:", r);
          continue;
        }

        let cleanPhone = phone;
        if (phone.startsWith("07")) {
          cleanPhone = "+254" + phone.substring(1);
        }

        // duplicate check
        const exists = await pool.request()
          .input("staffId", sql.NVarChar, staffId)
          .query(`SELECT id FROM Teachers WHERE staffId = @staffId`);

        if (exists.recordset.length > 0) {
          console.log(`SKIPPED DUPLICATE TEACHER: ${staffId}`);
          continue;
        }

        const username = staffId;
        const hashedPassword = await bcrypt.hash("1234", 10);

        await pool.request()
          .input("name", sql.NVarChar, name)
          .input("staffId", sql.NVarChar, staffId)
          .input("subject", sql.NVarChar, subject)
          .input("phone", sql.NVarChar, cleanPhone)
          .input("email", sql.NVarChar, email)
          .input("username", sql.NVarChar, username)
          .input("password", sql.NVarChar, hashedPassword)
          .input("role", sql.NVarChar, "teacher")
          .query(`
            INSERT INTO Teachers 
            (name, staffId, subject, phone, email, username, password, role)
            VALUES 
            (@name, @staffId, @subject, @phone, @email, @username, @password, @role)
          `);

        console.log(`✔ INSERTED TEACHER: ${name} (${staffId})`);
      }
    }

    // =====================================================
    // ================= USERS UPLOAD =======================
    // =====================================================
    if (type === "users") {
      for (let r of rows) {

        const username = (r.username || "").toString().trim();
        const role = (r.role || "user").toString().trim();
        const email = r.email || null;

        if (!username) {
          console.log("SKIPPED INVALID USER:", r);
          continue;
        }

        const hashedPassword = await bcrypt.hash(r.password || "1234", 10);

        await pool.request()
          .input("username", sql.NVarChar, username)
          .input("role", sql.NVarChar, role)
          .input("email", sql.NVarChar, email)
          .input("password", sql.NVarChar, hashedPassword)
          .query(`
            INSERT INTO Users (username, role, email, password)
            VALUES (@username, @role, @email, @password)
          `);

        console.log(`✔ INSERTED USER: ${username}`);
      }
    }

    // ================= RESPONSE =================
    res.json({
      message: "Upload successful",
      type,
      inserted: rows.length
    });

  } catch (err) {
    console.log("UPLOAD ERROR:", err);
    res.status(500).json({
      message: "Upload failed",
      error: err.message
    });
  }
});

module.exports = router;