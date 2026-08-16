const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");

/* ================= GRADUATE STUDENTS ================= */
router.post("/graduate", async (req, res) => {
  try {
    const pool = req.pool;
    const currentYear = new Date().getFullYear();

    // Get Year 3 students
    const students = await pool.request().query(`
      SELECT * FROM Students WHERE yearOfStudy = 3
    `);

    for (const s of students.recordset) {
      await pool.request()
        .input("studentId", s.id)
        .input("name", s.name)
        .input("admissionNo", s.admissionNo)
        .input("studentClass", s.studentClass)
        .input("yearOfStudy", s.yearOfStudy)
        .input("graduationYear", currentYear)
        .query(`
          INSERT INTO Graduations
          (studentId, name, admissionNo, studentClass, yearOfStudy, graduationYear)
          VALUES
          (@studentId, @name, @admissionNo, @studentClass, @yearOfStudy, @graduationYear)
        `);
    }

    // Remove graduated students
    await pool.request().query(`
      DELETE FROM Students WHERE yearOfStudy = 3
    `);

    res.json({
      success: true,
      message: `${students.recordset.length} students graduated successfully`,
    });

  } catch (err) {
    console.log("GRADUATION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================= GET GRADUATIONS ================= */
router.get("/", async (req, res) => {
  try {
    const pool = req.pool;

    const data = await pool.request().query(`
      SELECT * FROM Graduations ORDER BY id DESC
    `);

    res.json(data.recordset); // IMPORTANT: returns array

  } catch (err) {
    console.log("FETCH ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================= UNDO GRADUATION ================= */
router.post("/undo", async (req, res) => {
  try {
    const pool = req.pool;
    const { id } = req.body;

    const grad = await pool.request()
      .input("id", id)
      .query(`SELECT * FROM Graduations WHERE id = @id`);

    if (!grad.recordset.length) {
      return res.status(404).json({ message: "Not found" });
    }

    const g = grad.recordset[0];

    // Restore to students
    await pool.request()
      .input("name", g.name)
      .input("admissionNo", g.admissionNo)
      .input("studentClass", g.studentClass)
      .input("yearOfStudy", 3)
      .query(`
        INSERT INTO Students (name, admissionNo, studentClass, yearOfStudy)
        VALUES (@name, @admissionNo, @studentClass, @yearOfStudy)
      `);

    await pool.request()
      .input("id", id)
      .query(`DELETE FROM Graduations WHERE id = @id`);

    res.json({
      success: true,
      message: "Graduation undone successfully",
    });

  } catch (err) {
    console.log("UNDO ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================= PDF CERTIFICATE ================= */
router.get("/certificate/:id", async (req, res) => {
  try {
    const pool = req.pool;

    const data = await pool.request()
      .input("id", req.params.id)
      .query(`SELECT * FROM Graduations WHERE id = @id`);

    if (!data.recordset.length) {
      return res.status(404).json({ message: "Not found" });
    }

    const student = data.recordset[0];

    const doc = new PDFDocument();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${student.name}-certificate.pdf`
    );

    doc.pipe(res);

    doc.fontSize(25).text("GRADUATION CERTIFICATE", { align: "center" });
    doc.moveDown();

    doc.fontSize(16).text(`Name: ${student.name}`);
    doc.text(`Admission No: ${student.admissionNo}`);
    doc.text(`Class: ${student.studentClass}`);
    doc.text(`Graduation Year: ${student.graduationYear}`);

    doc.moveDown();
    doc.text("Congratulations on your achievement!", {
      align: "center",
    });

    doc.end();

  } catch (err) {
    console.log("PDF ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;