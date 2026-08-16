const express = require("express");
const router = express.Router();

// A teacher assesses at most this many trainees in one sitting/day.
const MAX_PER_TEACHER = 7;

/* ============================================================================
   META — regions, schools, teachers, students in a single round trip
============================================================================ */
router.get("/meta", async (req, res) => {
  try {
    const pool = req.pool;

    const [regions, schools, teachers, students] = await Promise.all([
      pool.request().query(`SELECT * FROM Regions ORDER BY name`),
      pool.request().query(`SELECT s.*, r.name AS regionName FROM Schools s LEFT JOIN Regions r ON r.id = s.regionId ORDER BY s.name`),
      pool.request().query(`SELECT t.*, r.name AS regionName FROM Teachers t LEFT JOIN Regions r ON r.id = t.regionId ORDER BY t.name`),
      pool.request().query(`
        SELECT s.*, sc.name AS schoolName, sc.regionId, r.name AS regionName
        FROM Students s
        LEFT JOIN Schools sc ON sc.id = s.schoolId
        LEFT JOIN Regions r ON r.id = sc.regionId
        ORDER BY s.name
      `),
    ]);

    res.json({
      regions: regions.recordset,
      schools: schools.recordset,
      teachers: teachers.recordset,
      students: students.recordset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load meta data" });
  }
});

/* ============================================================================
   REGIONS
============================================================================ */
router.post("/regions", async (req, res) => {
  try {
    const pool = req.pool;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Region name is required" });

    const result = await pool.request()
      .input("name", name)
      .query(`INSERT INTO Regions (name) OUTPUT INSERTED.* VALUES (@name)`);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create region (name may already exist)" });
  }
});

router.put("/regions/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const { name } = req.body;
    await pool.request()
      .input("id", req.params.id)
      .input("name", name)
      .query(`UPDATE Regions SET name = @name WHERE id = @id`);
    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update region" });
  }
});

router.delete("/regions/:id", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request().input("id", req.params.id).query(`DELETE FROM Regions WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Cannot delete region — it still has schools linked to it" });
  }
});

/* ============================================================================
   SCHOOLS
============================================================================ */
router.post("/schools", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, regionId } = req.body;
    if (!name || !regionId) return res.status(400).json({ error: "School name and region are required" });

    const result = await pool.request()
      .input("name", name)
      .input("regionId", regionId)
      .query(`INSERT INTO Schools (name, regionId) OUTPUT INSERTED.* VALUES (@name, @regionId)`);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create school" });
  }
});

router.put("/schools/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, regionId } = req.body;
    await pool.request()
      .input("id", req.params.id)
      .input("name", name)
      .input("regionId", regionId)
      .query(`UPDATE Schools SET name = @name, regionId = @regionId WHERE id = @id`);
    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update school" });
  }
});

router.delete("/schools/:id", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request().input("id", req.params.id).query(`DELETE FROM Schools WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Cannot delete school — it still has students linked to it" });
  }
});

/* ============================================================================
   TEACHERS
============================================================================ */
router.post("/teachers", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, email, phone, regionId } = req.body;
    if (!name) return res.status(400).json({ error: "Teacher name is required" });

    const result = await pool.request()
      .input("name", name)
      .input("email", email || null)
      .input("phone", phone || null)
      .input("regionId", regionId || null)
      .query(`
        INSERT INTO Teachers (name, email, phone, regionId)
        OUTPUT INSERTED.*
        VALUES (@name, @email, @phone, @regionId)
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create teacher" });
  }
});

router.put("/teachers/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, email, phone, regionId } = req.body;
    await pool.request()
      .input("id", req.params.id)
      .input("name", name)
      .input("email", email || null)
      .input("phone", phone || null)
      .input("regionId", regionId || null)
      .query(`
        UPDATE Teachers SET name = @name, email = @email, phone = @phone, regionId = @regionId
        WHERE id = @id
      `);
    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update teacher" });
  }
});

router.delete("/teachers/:id", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request().input("id", req.params.id).query(`DELETE FROM Teachers WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Cannot delete teacher — they still have practicum assignments on record" });
  }
});

/* ============================================================================
   STUDENTS
============================================================================ */
router.post("/students", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, admissionNo, schoolId } = req.body;
    if (!name) return res.status(400).json({ error: "Student name is required" });

    const result = await pool.request()
      .input("name", name)
      .input("admissionNo", admissionNo || null)
      .input("schoolId", schoolId || null)
      .query(`
        INSERT INTO Students (name, admissionNo, schoolId)
        OUTPUT INSERTED.*
        VALUES (@name, @admissionNo, @schoolId)
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create student" });
  }
});

router.put("/students/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const { name, admissionNo, schoolId } = req.body;
    await pool.request()
      .input("id", req.params.id)
      .input("name", name)
      .input("admissionNo", admissionNo || null)
      .input("schoolId", schoolId || null)
      .query(`
        UPDATE Students SET name = @name, admissionNo = @admissionNo, schoolId = @schoolId
        WHERE id = @id
      `);
    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update student" });
  }
});

router.delete("/students/:id", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request().input("id", req.params.id).query(`DELETE FROM Students WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Cannot delete student — they still have practicum assignments on record" });
  }
});

/* ============================================================================
   SESSIONS
============================================================================ */
router.post("/", async (req, res) => {
  try {
    const pool = req.pool;
    const { title, date, term } = req.body;

    if (!title || !date) {
      return res.status(400).json({ error: "Title and date are required" });
    }

    const result = await pool.request()
      .input("title", title)
      .input("date", date)
      .input("term", term || "Term 1")
      .query(`
        INSERT INTO PracticumSessions (title, date, term)
        OUTPUT INSERTED.*
        VALUES (@title, @date, @term)
      `);

    res.json(result.recordset[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/", async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT * FROM PracticumSessions ORDER BY id DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

router.put("/:sessionId", async (req, res) => {
  try {
    const pool = req.pool;
    const { title, date, term } = req.body;
    await pool.request()
      .input("id", req.params.sessionId)
      .input("title", title)
      .input("date", date)
      .input("term", term)
      .query(`UPDATE PracticumSessions SET title = @title, date = @date, term = @term WHERE id = @id`);
    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update session" });
  }
});

router.delete("/:sessionId", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request()
      .input("id", req.params.sessionId)
      .query(`DELETE FROM PracticumSessions WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

/* ============================================================================
   AUTO-ASSIGN

   Rule: a teacher assesses a maximum of MAX_PER_TEACHER trainees per day.
   Students are grouped by region -> school (in that order). Each teacher's
   group is filled from ONE school first; if that school runs out of
   students before the cap is reached, the remainder is topped up from the
   NEXT school in the SAME region. Once every teacher has a group for the
   day, extra groups roll over to day 2, day 3, etc., cycling teachers again.

   Only students who are not already assigned in this session are placed,
   so auto-assign can safely be re-run after adding new students.
============================================================================ */
router.post("/auto-assign/:sessionId", async (req, res) => {
  const pool = req.pool;
  const sessionId = req.params.sessionId;

  try {
    const [teachersRes, studentsRes, existingRes] = await Promise.all([
      pool.request().query(`SELECT * FROM Teachers ORDER BY id`),
      pool.request().query(`
        SELECT s.id, s.name, s.schoolId, sc.name AS schoolName, sc.regionId, r.name AS regionName
        FROM Students s
        JOIN Schools sc ON sc.id = s.schoolId
        JOIN Regions r ON r.id = sc.regionId
        ORDER BY r.name, sc.name, s.name
      `),
      pool.request()
        .input("sessionId", sessionId)
        .query(`SELECT studentId FROM PracticumAssignments WHERE sessionId = @sessionId`),
    ]);

    const teachers = teachersRes.recordset;
    const alreadyAssigned = new Set(existingRes.recordset.map((r) => r.studentId));
    const students = studentsRes.recordset.filter((s) => !alreadyAssigned.has(s.id));

    if (!teachers.length) {
      return res.status(400).json({ error: "No teachers available" });
    }
    if (!students.length) {
      return res.status(400).json({
        error: "No unassigned students found. Make sure students have a schoolId set, or everyone is already assigned.",
      });
    }

    const byRegion = new Map();
    for (const s of students) {
      if (!byRegion.has(s.regionId)) byRegion.set(s.regionId, []);
      byRegion.get(s.regionId).push(s);
    }

    const groups = [];
    for (const [regionId, regionStudents] of byRegion.entries()) {
      let bucket = [];
      for (const student of regionStudents) {
        bucket.push(student);
        if (bucket.length === MAX_PER_TEACHER) {
          groups.push({ regionId, students: bucket });
          bucket = [];
        }
      }
      if (bucket.length) groups.push({ regionId, students: bucket });
    }

    const rows = [];
    let maxDay = 1;
    groups.forEach((group, i) => {
      const teacher = teachers[i % teachers.length];
      const day = Math.floor(i / teachers.length) + 1;
      maxDay = Math.max(maxDay, day);

      group.students.forEach((student) => {
        rows.push({
          sessionId,
          teacherId: teacher.id,
          studentId: student.id,
          schoolId: student.schoolId,
          regionId: group.regionId,
          day,
        });
      });
    });

    for (const row of rows) {
      const assignment = await pool.request()
        .input("sessionId", row.sessionId)
        .input("teacherId", row.teacherId)
        .input("studentId", row.studentId)
        .input("schoolId", row.schoolId)
        .input("regionId", row.regionId)
        .input("day", row.day)
        .query(`
          INSERT INTO PracticumAssignments (sessionId, teacherId, studentId, schoolId, regionId, day)
          OUTPUT INSERTED.id
          VALUES (@sessionId, @teacherId, @studentId, @schoolId, @regionId, @day)
        `);

      const assignmentId = assignment.recordset[0].id;

      for (let n = 1; n <= 6; n++) {
        await pool.request()
          .input("assignmentId", assignmentId)
          .input("n", n)
          .query(`
            INSERT INTO PracticumAssessments (assignmentId, assessmentNumber)
            VALUES (@assignmentId, @n)
          `);
      }
    }

    res.json({
      message: "assigned",
      studentsAssigned: rows.length,
      groups: groups.length,
      teachersUsed: teachers.length,
      days: maxDay,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Auto-assign failed" });
  }
});

/* ============================================================================
   ASSIGNMENTS
============================================================================ */
router.get("/assign/:sessionId", async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request()
      .input("sessionId", req.params.sessionId)
      .query(`
        SELECT
          a.id AS assignmentId, a.day,
          t.id AS teacherId, t.name AS teacherName,
          s.id AS studentId, s.name AS studentName,
          sc.name AS schoolName, r.name AS regionName
        FROM PracticumAssignments a
        JOIN Teachers t ON t.id = a.teacherId
        JOIN Students s ON s.id = a.studentId
        LEFT JOIN Schools sc ON sc.id = a.schoolId
        LEFT JOIN Regions r ON r.id = a.regionId
        WHERE a.sessionId = @sessionId
        ORDER BY r.name, sc.name, t.name, s.name
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// Manual override — reassign one student to a different teacher.
router.put("/assign/:assignmentId", async (req, res) => {
  try {
    const pool = req.pool;
    const { teacherId } = req.body;

    await pool.request()
      .input("id", req.params.assignmentId)
      .input("teacherId", teacherId)
      .query(`UPDATE PracticumAssignments SET teacherId = @teacherId WHERE id = @id`);

    res.json({ message: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update assignment" });
  }
});

// Remove a single student's assignment (and its assessments, via cascade).
router.delete("/assign/:assignmentId", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request()
      .input("id", req.params.assignmentId)
      .query(`DELETE FROM PracticumAssignments WHERE id = @id`);
    res.json({ message: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove assignment" });
  }
});

// Reset — clear every assignment for a session so auto-assign can start fresh.
router.delete("/assign/session/:sessionId", async (req, res) => {
  try {
    const pool = req.pool;
    await pool.request()
      .input("sessionId", req.params.sessionId)
      .query(`DELETE FROM PracticumAssignments WHERE sessionId = @sessionId`);
    res.json({ message: "reset" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset assignments" });
  }
});

/* ============================================================================
   ASSESSMENTS (1-6 per assignment)
============================================================================ */
router.get("/assessments/:assignmentId", async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request()
      .input("assignmentId", req.params.assignmentId)
      .query(`
        SELECT * FROM PracticumAssessments
        WHERE assignmentId = @assignmentId
        ORDER BY assessmentNumber
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

router.put("/assessments/:id", async (req, res) => {
  try {
    const pool = req.pool;
    const { score, remarks, assessedDate } = req.body;

    await pool.request()
      .input("id", req.params.id)
      .input("score", score === "" || score === undefined ? null : score)
      .input("remarks", remarks || null)
      .input("assessedDate", assessedDate || null)
      .query(`
        UPDATE PracticumAssessments
        SET score = @score, remarks = @remarks, assessedDate = @assessedDate
        WHERE id = @id
      `);

    res.json({ message: "saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save assessment" });
  }
});

/* ============================================================================
   REPORT — full session report (used for both the on-screen report and PDF)
============================================================================ */
router.get("/report/:sessionId", async (req, res) => {
  try {
    const pool = req.pool;

    const sessionRes = await pool.request()
      .input("id", req.params.sessionId)
      .query(`SELECT * FROM PracticumSessions WHERE id = @id`);

    const rowsRes = await pool.request()
      .input("sessionId", req.params.sessionId)
      .query(`
        SELECT
          a.id AS assignmentId, a.day,
          t.name AS teacherName,
          st.name AS studentName,
          sc.name AS schoolName, r.name AS regionName,
          pa.id AS assessmentRowId, pa.assessmentNumber, pa.score, pa.remarks, pa.assessedDate
        FROM PracticumAssignments a
        JOIN Teachers t ON t.id = a.teacherId
        JOIN Students st ON st.id = a.studentId
        LEFT JOIN Schools sc ON sc.id = a.schoolId
        LEFT JOIN Regions r ON r.id = a.regionId
        LEFT JOIN PracticumAssessments pa ON pa.assignmentId = a.id
        WHERE a.sessionId = @sessionId
        ORDER BY r.name, sc.name, st.name, pa.assessmentNumber
      `);

    res.json({
      session: sessionRes.recordset[0] || null,
      rows: rowsRes.recordset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build report" });
  }
});

module.exports = router;