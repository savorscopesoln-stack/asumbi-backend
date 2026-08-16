app.post("/api/promote-years", async (req, res) => {
  try {
    const pool = req.pool;

    // 1. GET final year students
    const grads = await pool.request().query(`
      SELECT * 
      FROM Students 
      WHERE yearOfStudy = 3
    `);

    for (const s of grads.recordset) {

      // 2. Prevent duplicate graduation
      const exists = await pool.request().query(`
        SELECT TOP 1 id 
        FROM Graduations 
        WHERE studentId = ${s.id}
      `);

      if (exists.recordset.length === 0) {

        // INSERT INTO GRADUATIONS (FINAL RECORD)
        await pool.request().query(`
          INSERT INTO Graduations
          (studentId, name, admissionNo, studentClass, gender, email, yearOfGraduation, graduationYear)
          VALUES
          (${s.id}, '${s.name}', '${s.admissionNo}', '${s.studentClass}', '${s.gender}', '${s.email || ""}', ${s.yearOfStudy}, YEAR(GETDATE()))
        `);
      }

      // 3. ARCHIVE SNAPSHOT (SOFT DELETE BACKUP)
      await pool.request().query(`
        INSERT INTO StudentArchive
        (studentId, name, admissionNo, studentClass, gender, email, yearOfStudy, status)
        VALUES
        (${s.id}, '${s.name}', '${s.admissionNo}', '${s.studentClass}', '${s.gender}', '${s.email || ""}', ${s.yearOfStudy}, 'graduated')
      `);

      // 4. REMOVE FROM ACTIVE STUDENTS (SOFT DELETE STYLE)
      await pool.request().query(`
        UPDATE Students
        SET status = 'graduated'
        WHERE id = ${s.id}
      `);
    }

    // 5. PROMOTE ONLY ACTIVE STUDENTS
    await pool.request().query(`
      UPDATE Students
      SET yearOfStudy = yearOfStudy + 1
      WHERE status = 'active'
    `);

    res.json({
      success: true,
      message: "Enterprise promotion completed (archive + graduation + status update)"
    });

  } catch (err) {
    console.log("PROMOTION ERROR:", err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});