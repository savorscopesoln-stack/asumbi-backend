const express = require("express");
const router = express.Router();
const sql = require("mssql");

/* ================= UPDATE RECORDS ================= */
router.post("/", async (req, res) => {
  try {
    const pool = req.pool;

    const { type, data } = req.body;

    if (!type || !data) {
      return res.status(400).json({
        message: "Missing type or data",
      });
    }

    /* ================= STUDENTS ================= */
    if (type === "students") {
      for (const row of data) {

        let cleanPhone = row.phone || "";

        cleanPhone = cleanPhone.toString().trim();

        if (cleanPhone.startsWith("0")) {
          cleanPhone = "+254" + cleanPhone.substring(1);
        }

        await pool.request()
          .input("id", sql.Int, row.id)
          .input("name", sql.NVarChar, row.name)
          .input("admissionNo", sql.NVarChar, row.admissionNo)
          .input("studentClass", sql.NVarChar, row.studentClass)
          .input("gender", sql.NVarChar, row.gender)
          .input("status", sql.NVarChar, row.status)
          .input("yearOfStudy", sql.Int, row.yearOfStudy)
          .input("phone", sql.NVarChar, cleanPhone)
          .query(`
            UPDATE Students
            SET
              name = @name,
              admissionNo = @admissionNo,
              studentClass = @studentClass,
              gender = @gender,
              status = @status,
              yearOfStudy = @yearOfStudy,
              phone = @phone
            WHERE id = @id
          `);
      }
    }

    res.json({
      message: "Records updated successfully",
    });

  } catch (err) {
    console.log("UPDATE ERROR:", err);

    res.status(500).json({
      message: "Update failed",
      error: err.message,
    });
  }
});

module.exports = router;