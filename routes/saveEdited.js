const express = require("express");
const router = express.Router();

/* ================= SAVE EDITED RECORDS ================= */
router.post("/", async (req, res) => {
  try {
    const pool = req.pool;
    const { type, data } = req.body;

    if (!Array.isArray(data)) {
      return res.status(400).json({ message: "Invalid data format" });
    }

    let table = "";

    if (type === "students") table = "Students";
    else if (type === "teachers") table = "Teachers";
    else if (type === "users") table = "Users";
    else return res.status(400).json({ message: "Invalid type" });

    for (const row of data) {
      const id = row.id || row._id;
      if (!id) continue;

      /* ================= STUDENTS ================= */
if (type === "students") {

  let cleanPhone = (row.phone || "").toString().trim();

  if (cleanPhone.startsWith("0")) {
    cleanPhone = "+254" + cleanPhone.substring(1);
  }

  await pool.request()
    .input("id", id)
    .input("name", row.name)
    .input("admissionNo", row.admissionNo)
    .input("studentClass", row.studentClass)
    .input("gender", row.gender)
    .input("status", row.status || "active")
    .input("phone", cleanPhone)
    .input("email", row.email || null)
    .input("yearOfStudy", row.yearOfStudy || 1)
    .input(
      "assessmentNumber",
      row.assessmentNumber || null
    )

    .query(`
      UPDATE Students
      SET
        name=@name,
        admissionNo=@admissionNo,
        studentClass=@studentClass,
        gender=@gender,
        status=@status,
        phone=@phone,
        email=@email,
        yearOfStudy=@yearOfStudy,
        assessmentNumber=@assessmentNumber
      WHERE id=@id
    `);
}

      /* ================= TEACHERS ================= */
      if (type === "teachers") {
        await pool.request()
          .input("id", id)
          .input("name", row.name)
          .input("staffId", row.staffId)
          .input("subject", row.subject)
          .input("phone", row.phone)

          .query(`
            UPDATE Teachers
            SET name=@name,
                staffId=@staffId,
                subject=@subject,
                phone=@phone
            WHERE id=@id
          `);
      }

      /* ================= USERS ================= */
      if (type === "users") {
        await pool.request()
          .input("id", id)
          .input("username", row.username)
          .input("role", row.role)
          .input("email", row.email)

          .query(`
            UPDATE Users
            SET username=@username,
                role=@role,
                email=@email
            WHERE id=@id
          `);
      }
    }

    res.json({ message: "Updated successfully" });

  } catch (err) {
    console.log("SAVE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================= DELETE RECORD ================= */
router.post("/delete", async (req, res) => {
  try {
    const pool = req.pool;
    const { type, id } = req.body;

    if (!id) {
      return res.status(400).json({ message: "Missing ID" });
    }

    let table = "";

    if (type === "students") table = "Students";
    else if (type === "teachers") table = "Teachers";
    else if (type === "users") table = "Users";
    else return res.status(400).json({ message: "Invalid type" });

    await pool.request()
      .input("id", id)
      .query(`DELETE FROM ${table} WHERE id = @id`);

    res.json({ message: "Deleted successfully" });

  } catch (err) {
    console.log("DELETE ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;