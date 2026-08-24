const express = require("express");
const sql = require("mssql");
const router = express.Router();
const { notifyUsers } = require("../utils/notify");

// A teacher assesses at most this many trainees in one sitting/day.
const MAX_PER_TEACHER = 7;

// Weekday-name -> real calendar date helpers (server-side mirror of the
// frontend's date helpers). Used to stamp a deployment with the actual
// date it goes into effect, so date-based reports don't have to guess.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function nextDateForWeekday(weekdayName, fromDate = new Date()) {
  const targetIndex = WEEKDAY_NAMES.indexOf(weekdayName);
  if (targetIndex === -1) return null;
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const diff = (targetIndex - from.getDay() + 7) % 7;
  const result = new Date(from);
  result.setDate(from.getDate() + diff);
  return result;
}

/* ============================================================================
   BULK ASSIGNMENT INSERT — used by both auto-assign and deploy.

   The old code fired one pool.request() PER STUDENT (assignment insert +
   6 assessment inserts), all in parallel via Promise.all. That's what was
   actually making auto-assign/deploy "slow and doesn't finish":
     - The pool only has 10 connections (backend/config/db.js), so for any
       region/session bigger than ~10 students, most of those requests just
       queued up waiting for a free connection instead of running.
     - Dozens-to-hundreds of concurrent INSERTs against the same two tables
       cause SQL Server lock contention and, under real load, deadlocks —
       one request gets killed as the deadlock victim, Promise.all rejects
       immediately, and everything else in flight is abandoned. Because none
       of this ran in a transaction, whatever had already committed stayed
       committed, leaving a half-deployed session with no clean way to
       retry (re-running would try to insert duplicates for whoever *did*
       make it in).

   Fixed by doing the whole deploy/auto-assign as ONE transaction with a
   small, fixed number of round trips: a handful of multi-row INSERT
   statements (chunked to stay under SQL Server's ~2100-parameter limit)
   instead of one round trip per student. If anything fails, the
   transaction rolls back completely — no partial deployments — and it's
   safe to just retry.
============================================================================ */
const ASSIGNMENT_COLS = [
  { name: "sessionId", type: sql.Int },
  { name: "teacherId", type: sql.Int },
  { name: "studentId", type: sql.Int },
  { name: "schoolId", type: sql.Int },
  { name: "regionId", type: sql.Int },
  { name: "day", type: sql.NVarChar(50) },
  // Real calendar date this deployment goes into effect (nullable — see
  // note above ASSIGNMENT_COLS's old definition; auto-assign's numeric
  // "day 1/2/3..." rows don't have a real date, so this stays NULL there).
  { name: "deployDate", type: sql.Date },
  // Distinguishes a one-off "extra day" deployment from a standing
  // weekly research-day deployment — needed so date-based reports can
  // tell the two apart instead of guessing from the weekday alone.
  { name: "isExtra", type: sql.Bit },
];
const CHUNK_SIZE = 250; // 250 rows * 8 params/row = 2000 params, safely under the 2100 limit

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Inserts PracticumAssignments + their 6 PracticumAssessments rows each,
// in batches, inside the given transaction. Returns the new assignment IDs.
async function bulkInsertAssignments(transaction, rows) {
  const assignmentIds = [];

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    const request = new sql.Request(transaction);
    const valuesSql = batch
      .map((row, i) => {
        ASSIGNMENT_COLS.forEach(({ name, type }) =>
          request.input(`${name}${i}`, type, row[name] === undefined ? null : row[name])
        );
        return `(@sessionId${i}, @teacherId${i}, @studentId${i}, @schoolId${i}, @regionId${i}, @day${i}, @deployDate${i}, @isExtra${i})`;
      })
      .join(",\n        ");

    const result = await request.query(`
      INSERT INTO PracticumAssignments (sessionId, teacherId, studentId, schoolId, regionId, day, deployDate, isExtra)
      OUTPUT INSERTED.id
      VALUES
        ${valuesSql};
    `);
    // Multi-row INSERT...OUTPUT returns rows in insertion order.
    result.recordset.forEach((r) => assignmentIds.push(r.id));
  }

  const assessmentRows = [];
  for (const assignmentId of assignmentIds) {
    for (let n = 1; n <= 6; n++) assessmentRows.push({ assignmentId, assessmentNumber: n });
  }

  for (const batch of chunk(assessmentRows, CHUNK_SIZE * 3)) {
    const request = new sql.Request(transaction);
    const valuesSql = batch
      .map((row, i) => {
        request.input(`assignmentId${i}`, row.assignmentId);
        request.input(`assessmentNumber${i}`, row.assessmentNumber);
        return `(@assignmentId${i}, @assessmentNumber${i})`;
      })
      .join(",\n        ");

    await request.query(`
      INSERT INTO PracticumAssessments (assignmentId, assessmentNumber)
      VALUES
        ${valuesSql};
    `);
  }

  return assignmentIds;
}

/* ============================================================================
   DEADLOCK RETRY HELPER

   SQL Server error 1205 ("deadlocked on lock resources ... chosen as the
   deadlock victim") is expected to happen occasionally under concurrency
   even with well-designed transactions — it's SQL Server's normal way of
   breaking a deadlock cycle, not a sign of corruption. The standard fix is
   to retry the whole transaction a few times with a short backoff. This
   wraps any of our transactional handlers so a transient deadlock doesn't
   surface as a hard failure to the user.
============================================================================ */
async function withDeadlockRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isDeadlock = err?.number === 1205 || err?.originalError?.info?.number === 1205;
      if (isDeadlock && attempt < retries) {
        await new Promise((res) => setTimeout(res, 150 * attempt)); // simple backoff
        continue;
      }
      throw err;
    }
  }
}

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

/* ----------------------------------------------------------------------
   BULK STUDENT UPDATE — used by Automatic Placement (randomizePlacement).

   IMPORTANT: this must be declared BEFORE "PUT /students/:id" below.
   Express matches routes top-to-bottom, and ":id" matches literally any
   path segment — including the word "bulk". With the old ordering,
   PUT /students/bulk hit the ":id" handler first, req.params.id came out
   as the string "bulk", and SQL Server threw:
     "Conversion failed when converting the nvarchar value 'bulk' to
     data type int."
   because that route does `.input("id", req.params.id)` into a query
   with `WHERE id = @id` against an int column. Moving the specific
   "/students/bulk" route above the generic "/students/:id" route fixes
   this — Express now matches the exact path first.

   The frontend used to fire one PUT /students/:id per placed student, all
   in parallel via Promise.all. Same problem auto-assign/deploy had before
   they were fixed: dozens of concurrent UPDATE Students statements each
   fire trg_UpdateClassesFromStudents, and those overlapping transactions
   collide on whatever summary row(s) the trigger maintains, producing
   "deadlocked on lock resources ... chosen as the deadlock victim"
   (error 1205) — the errors visible repeatedly in the server logs.

   Fixed the same way auto-assign/deploy were: do every update inside ONE
   transaction (sequential requests on that transaction, not N separate
   pooled connections racing each other), wrapped in a deadlock retry for
   the rare case a transient 1205 still slips through under heavy load.
   If anything fails after retries, the whole batch rolls back and it's
   safe for the client to just try again.
---------------------------------------------------------------------- */
router.put("/students/bulk", async (req, res) => {
  const pool = req.pool;
  const { updates } = req.body; // [{ id, name, admissionNo, schoolId }, ...]

  if (!Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: "updates array is required" });
  }

  try {
    await withDeadlockRetry(async () => {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        for (const u of updates) {
          await new sql.Request(transaction)
            .input("id", u.id)
            .input("name", u.name)
            .input("admissionNo", u.admissionNo || null)
            .input("schoolId", u.schoolId || null)
            .query(`
              UPDATE Students SET name = @name, admissionNo = @admissionNo, schoolId = @schoolId
              WHERE id = @id
            `);
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    });

    res.json({ message: "updated", count: updates.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Bulk student update failed" });
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

/* ============================================================================
   TEACHER-FACING VIEWS
   The Teacher Portal's Practicum page only ever needs to see the students
   THAT teacher is supervising — never the coordinator's full manage/deploy
   tooling. These two endpoints keep that scoped down to just the teacher's
   own sessionId, mirroring the same row shape /report/:sessionId already
   uses (so the frontend can reuse the same grouping/rendering logic).
============================================================================ */

// Every session this teacher has at least one assignment in, with a count
// of how many students they're supervising in each — powers the session
// picker on the teacher's Practicum page.
router.get("/teacher/:teacherId/sessions", async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request()
      .input("teacherId", req.params.teacherId)
      .query(`
        SELECT ps.id, ps.title, ps.date, ps.term, COUNT(a.id) AS studentCount
        FROM PracticumAssignments a
        JOIN PracticumSessions ps ON ps.id = a.sessionId
        WHERE a.teacherId = @teacherId
        GROUP BY ps.id, ps.title, ps.date, ps.term
        ORDER BY ps.id DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// This teacher's assigned students for one session, each with their day,
// school/region, deployment date, and their 6 assessment rows (score,
// remarks, assessedDate) — everything the Assignments tab needs to render
// and everything Assessments needs to edit, in one round trip.
router.get("/teacher/:teacherId/assignments", async (req, res) => {
  try {
    const pool = req.pool;
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const teacherRes = await pool.request()
      .input("teacherId", req.params.teacherId)
      .query(`SELECT id, name, researchDay FROM Teachers WHERE id = @teacherId`);

    const rowsRes = await pool.request()
      .input("teacherId", req.params.teacherId)
      .input("sessionId", sessionId)
      .query(`
        SELECT
          a.id AS assignmentId, a.day, a.deployDate, a.isExtra,
          s.id AS studentId, s.name AS studentName,
          sc.name AS schoolName, r.name AS regionName
        FROM PracticumAssignments a
        JOIN Students s ON s.id = a.studentId
        LEFT JOIN Schools sc ON sc.id = a.schoolId
        LEFT JOIN Regions r ON r.id = a.regionId
        WHERE a.teacherId = @teacherId AND a.sessionId = @sessionId
        ORDER BY r.name, sc.name, s.name
      `);

    const assignmentIds = rowsRes.recordset.map((r) => r.assignmentId);
    let assessmentsByAssignment = {};
    if (assignmentIds.length) {
      const idList = assignmentIds.join(",");
      const assessRes = await pool.request().query(`
        SELECT * FROM PracticumAssessments
        WHERE assignmentId IN (${idList})
        ORDER BY assignmentId, assessmentNumber
      `);
      assessmentsByAssignment = assessRes.recordset.reduce((acc, row) => {
        (acc[row.assignmentId] ||= []).push(row);
        return acc;
      }, {});
    }

    const rows = rowsRes.recordset.map((r) => ({
      ...r,
      assessments: assessmentsByAssignment[r.assignmentId] || [],
    }));

    res.json({
      teacher: teacherRes.recordset[0] || null,
      rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load teacher assignments" });
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
          deployDate: null, // auto-assign uses session day numbers (1,2,3...), not a real weekday/date
          isExtra: false,
        });
      });
    });

    await withDeadlockRetry(async () => {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        await bulkInsertAssignments(transaction, rows);
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    });

    const notifiedTeacherIds = new Set(rows.map((r) => r.teacherId));
    const notifiedStudentIds = new Set(rows.map((r) => r.studentId));

    await notifyUsers(
      pool,
      [...notifiedTeacherIds].map((id) => ({ id, source: "Teachers" })),
      {
        title: "Practicum Allocation",
        message: "You've been allocated students for practicum supervision. Check Practicum for your assignment.",
        type: "allocation",
      }
    );
    await notifyUsers(
      pool,
      [...notifiedStudentIds].map((id) => ({ id, source: "Students" })),
      {
        title: "Practicum Allocation",
        message: "You've been allocated a supervising teacher and school for practicum. Check Practicum for details.",
        type: "allocation",
      }
    );

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
          a.id AS assignmentId, a.day, a.deployDate, a.isExtra,
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
// If the destination teacher is already at (or over) the MAX_PER_TEACHER
// cap for that day, this is a "manual addition" beyond the normal
// auto-assign/deploy limit, and — per the practicum policy — only an
// admin is allowed to do that. Sub-admins with Practicum access can
// still reassign freely as long as the destination teacher stays within
// the cap.
router.put("/assign/:assignmentId", async (req, res) => {
  try {
    const pool = req.pool;
    const { teacherId } = req.body;
    const assignmentId = req.params.assignmentId;

    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }

    const currentRes = await pool.request()
      .input("id", assignmentId)
      .query(`SELECT sessionId, day, teacherId FROM PracticumAssignments WHERE id = @id`);
    const current = currentRes.recordset[0];
    if (!current) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    // Only check the cap when this actually moves the student to a
    // DIFFERENT teacher — reassigning to the same teacher is a no-op.
    if (String(teacherId) !== String(current.teacherId)) {
      const countRes = await pool.request()
        .input("sessionId", current.sessionId)
        .input("day", current.day)
        .input("teacherId", teacherId)
        .query(`
          SELECT COUNT(*) AS cnt
          FROM PracticumAssignments
          WHERE sessionId = @sessionId AND day = @day AND teacherId = @teacherId
        `);
      const destinationCount = countRes.recordset[0]?.cnt || 0;

      const requesterRole = String(req.user?.role || "").toLowerCase().trim();
      if (destinationCount >= MAX_PER_TEACHER && requesterRole !== "admin") {
        return res.status(403).json({
          error: `That teacher already has ${destinationCount}/${MAX_PER_TEACHER} trainees for this day. Only an admin can manually add beyond the cap.`,
        });
      }
    }

    await pool.request()
      .input("id", assignmentId)
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

router.post("/deploy", async (req, res) => {
  const pool = req.pool;
  const { sessionId, regionId, isExtra, day, date, teacherIds } = req.body;

  try {
    if (!sessionId || !regionId || !Array.isArray(teacherIds) || !teacherIds.length) {
      return res.status(400).json({ error: "sessionId, regionId and at least one teacherId are required" });
    }
    if (isExtra && !day) {
      return res.status(400).json({ error: "A day is required for an extra deployment" });
    }

    // The exact one-off calendar date for an extra deployment, if the
    // caller supplied one (yyyy-mm-dd from a <input type="date">).
    // Falls back to the next upcoming date for the chosen weekday.
    let extraDate = null;
    if (isExtra) {
      if (date) {
        const parsed = new Date(`${date}T00:00:00`);
        extraDate = Number.isNaN(parsed.getTime()) ? nextDateForWeekday(day) : parsed;
      } else {
        extraDate = nextDateForWeekday(day);
      }
    }

    const teachersRes = await pool.request()
      .input("regionId", regionId)
      .query(`SELECT * FROM Teachers WHERE regionId = @regionId`);
    const teacherIdSet = new Set(teacherIds.map(String));
    const teachers = teachersRes.recordset.filter((t) => teacherIdSet.has(String(t.id)));
    if (!teachers.length) {
      return res.status(400).json({ error: "None of the selected teachers were found in this region" });
    }

    const studentsRes = await pool.request()
      .input("regionId", regionId)
      .query(`
        SELECT s.id, s.schoolId
        FROM Students s
        JOIN Schools sc ON sc.id = s.schoolId
        WHERE sc.regionId = @regionId
        ORDER BY sc.name, s.name
      `);
    const students = studentsRes.recordset;
    if (!students.length) {
      return res.status(400).json({ error: "No students found in this region's schools" });
    }

    const studentIds = students.map((s) => Number(s.id)).filter(Number.isInteger);

    // Bucket into groups of MAX_PER_TEACHER, same school first
    const groups = [];
    let bucket = [];
    for (const student of students) {
      bucket.push(student);
      if (bucket.length === MAX_PER_TEACHER) {
        groups.push(bucket);
        bucket = [];
      }
    }
    if (bucket.length) groups.push(bucket);

    // Round-robin groups across the deployed teachers; each teacher's day is
    // their own research day, or the shared extra day if this is an extra deployment.
    // deployDate is the real calendar date this specific deployment goes into
    // effect: for a research day it's the next upcoming occurrence of that
    // weekday (the standing arrangement then continues weekly from there —
    // see the isExtra flag below, which is what date-based reports use to
    // decide whether to treat a row as "every week" or "this date only").
    const rows = [];
    groups.forEach((group, i) => {
      const teacher = teachers[i % teachers.length];
      const teacherDay = isExtra ? day : teacher.researchDay || day || "Unscheduled";
      const teacherDeployDate = isExtra ? extraDate : nextDateForWeekday(teacherDay);
      group.forEach((student) => {
        rows.push({
          sessionId, teacherId: teacher.id, studentId: student.id,
          schoolId: student.schoolId, regionId, day: teacherDay,
          deployDate: teacherDeployDate, isExtra: !!isExtra,
        });
      });
    });

    // Delete-then-reinsert and the bulk insert both happen in ONE transaction,
    // as a handful of chunked multi-row statements rather than one pooled
    // connection per student — see bulkInsertAssignments() above for why.
    // Wrapped in withDeadlockRetry so a transient 1205 under heavy load is
    // retried automatically instead of surfacing as a failed deployment.
    await withDeadlockRetry(async () => {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        if (studentIds.length) {
          await new sql.Request(transaction)
            .input("sessionId", sessionId)
            .query(`
              DELETE FROM PracticumAssignments
              WHERE sessionId = @sessionId
              AND studentId IN (${studentIds.join(",")})
            `);
        }
        await bulkInsertAssignments(transaction, rows);
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    });

    const deployedTeacherIds = new Set(rows.map((r) => r.teacherId));
    const deployedStudentIds = new Set(rows.map((r) => r.studentId));
    const deployMsg = isExtra
      ? `You've been deployed for an extra practicum session${day ? ` on ${day}` : ""}.`
      : "You've been deployed for practicum. Check Practicum for your school and schedule.";

    await notifyUsers(
      pool,
      [...deployedTeacherIds].map((id) => ({ id, source: "Teachers" })),
      { title: "Practicum Deployment", message: deployMsg, type: "deployment" }
    );
    await notifyUsers(
      pool,
      [...deployedStudentIds].map((id) => ({ id, source: "Students" })),
      { title: "Practicum Deployment", message: deployMsg, type: "deployment" }
    );

    res.json({ message: "deployed", studentsDeployed: rows.length, teachersUsed: teachers.length, groups: groups.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deployment failed" });
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
          a.id AS assignmentId, a.day, a.deployDate, a.isExtra,
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