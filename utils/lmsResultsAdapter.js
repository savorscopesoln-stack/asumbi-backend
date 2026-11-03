/* =========================================================================
   LMS RESULTS ADAPTER  (L6.4, D-083; contract B in docs/LMS_INTEGRATION_CONTRACTS.md)
   Publishes the graded attempts of ONE coursework quiz into the school's formal results (legacy `Assessments` + `Marks`).

   Rules (documented, simple, all enforced here):
   - Explicit staff action only (route needs `lms.gradebook.publish` + course membership). Never a job, never an event subscriber.
   - Only a PUBLISHED quiz of type `coursework` with `counts_to_grade = 1` and mode quiz/mock. Practice, revision sets and flashcards = 409 PRACTICE_NOT_PUBLISHABLE.
   - The course must name exactly one legacy subject (`subject_id`) and one class (`class_name`) that EXIST in `subjects` / `Classes`, else 409 NO_RESULTS_MAPPING. Nothing is guessed.
   - Which attempt counts: the learner's BEST graded attempt (default, Q51). Only learners with an ACTIVE enrolment. A learner with an attempt still waiting for
     teacher marking is skipped (NEEDS_MARKING) so a provisional lower mark is never published; learners with no attempt get no row.
   - Marks are normalised to 100: Assessments.totalMarks = 100, Marks.score = round(percentage), Marks.percentage = 2 decimals. (Quiz points can be decimal; Marks.score is an int.)
     `Marks.grade` is NOT written: the existing e-assessment release path does not write it either, grades are derived at read time with utils/grading (D-083).
   - Target rows: ONE `Assessments` row with sourceSystem `lms_quiz` and sourceRefId = the LMS quiz id (found first, created only if absent). `lms_quiz`, not `lms`, so this id space can
     never be confused with the LMS grade-item ids L7 will use (the e_assessment id-space bug this schema note warns about). Only rows of THIS source are ever touched. No Marks row is deleted.
   - Idempotent and atomic: ONE T-SQL batch (SET XACT_ABORT ON; BEGIN TRAN ... COMMIT). The Assessments lookup uses UPDLOCK, HOLDLOCK (key-range lock on
     IX_Assessments_sourceSystem_sourceRefId), so two teachers pressing the button at once are serialised; the second reports everything `unchanged`.
   - Each publish is audited (`results.published`, ids and counts only) and emits `lms.results.published` (ids only). `dryRun: true` reports who WOULD be published and writes nothing.
   Every query is parameterised; the learner list travels as ONE JSON parameter read with OPENJSON.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const events = require("./lmsEvents");

const SOURCE = "lms_quiz";
const TOTAL_MARKS = 100;
const MAX_LEARNERS = 2000;
const MAX_SKIPPED_SHOWN = 200;
const round2 = (n) => Math.round(n * 100) / 100;
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const reject = (code, msg, extra) => ({ ok: false, code, errors: [msg], ...(extra ? { extra } : {}) });

/* Pure. Is this quiz/course publishable? Returns null when yes, else a rejection. */
function checkPublishable(quiz, course) {
  if (!quiz || !course) return { ok: false, notFound: true, errors: ["Quiz not found."] };
  if (quiz.assessmentType !== "coursework" || !quiz.countsToGrade || ["revision", "flashcards"].includes(quiz.mode)) {
    return reject("PRACTICE_NOT_PUBLISHABLE", "Only a coursework quiz that counts towards the grade can be published to results. Practice, revision and flashcards never go to formal results.");
  }
  if (quiz.status !== "published") return reject("QUIZ_NOT_PUBLISHED", "Publish the quiz before sending its results.");
  if (!posInt(course.subjectId) || !String(course.className || "").trim()) {
    return reject("NO_RESULTS_MAPPING", "This course is not linked to one subject and one class. Ask the LMS administrator to set them on the course first.");
  }
  return null;
}

/* Pure. One row per learner from raw attempt rows [{student_id, attempt_no, status, total_points, max_points}].
   Best GRADED attempt (highest percentage; ties -> the earlier attempt). A learner with any submitted-but-unmarked attempt is skipped (NEEDS_MARKING). */
function pickScores(attempts) {
  const by = new Map();
  for (const a of attempts || []) {
    const id = Number(a.student_id); if (!Number.isInteger(id) || id <= 0) continue;
    const e = by.get(id) || { pending: false, best: null, anyMax0: false };
    if (a.status === "submitted") e.pending = true;
    else if (a.status === "graded") {
      const max = Number(a.max_points), tot = Number(a.total_points);
      if (!(max > 0) || !Number.isFinite(tot)) e.anyMax0 = true;
      else {
        const pct = Math.min(100, Math.max(0, round2((tot / max) * 100)));
        if (!e.best || pct > e.best.percentage || (pct === e.best.percentage && Number(a.attempt_no) < e.best.attemptNo)) e.best = { percentage: pct, attemptNo: Number(a.attempt_no) };
      }
    }
    by.set(id, e);
  }
  const rows = [], skipped = [];
  for (const [studentId, e] of [...by.entries()].sort((x, y) => x[0] - y[0])) {
    if (e.pending) skipped.push({ studentId, reason: "NEEDS_MARKING" });
    else if (e.best) rows.push({ studentId, score: Math.round(e.best.percentage), percentage: e.best.percentage, attemptNo: e.best.attemptNo });
    else if (e.anyMax0) skipped.push({ studentId, reason: "NO_POINTS" });
  }
  return { rows, skipped };
}

/* ------------------------------- loading ------------------------------- */
async function loadContext(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP 1 z.id, z.title, z.assessment_type, z.status, z.counts_to_grade, ISNULL(z.quiz_mode, 'quiz') AS quiz_mode,
            c.id AS course_id, c.academic_year, c.semester, c.class_name, c.subject_id
       FROM lms_quizzes z JOIN lms_courses c ON c.id = z.course_id
      WHERE z.id = @z AND z.course_id = @c AND z.deleted_at IS NULL AND c.deleted_at IS NULL`);
  const x = r.recordset && r.recordset[0]; if (!x) return null;
  return {
    quiz: { id: x.id, title: x.title, assessmentType: x.assessment_type, status: x.status, countsToGrade: !!x.counts_to_grade, mode: x.quiz_mode },
    course: { id: x.course_id, academicYear: x.academic_year, semester: x.semester, className: x.class_name, subjectId: x.subject_id },
  };
}
async function mappingExists(pool, course) {
  const s = await pool.request().input("s", sql.Int, course.subjectId).query(`SELECT TOP 1 id FROM subjects WHERE id = @s`);
  if (!(s.recordset && s.recordset.length)) return false;
  const k = await pool.request().input("n", sql.NVarChar(50), String(course.className).trim()).query(`SELECT TOP 1 id FROM Classes WHERE name = @n`);
  return !!(k.recordset && k.recordset.length);
}
async function loadAttempts(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP 20000 a.student_id, a.attempt_no, a.status, a.total_points, a.max_points
       FROM lms_quiz_attempts a
       JOIN lms_course_enrolments e ON e.course_id = a.course_id AND e.student_id = a.student_id AND e.status = 'active'
      WHERE a.quiz_id = @z AND a.course_id = @c AND a.status IN ('submitted', 'graded')
      ORDER BY a.student_id, a.attempt_no`);
  return r.recordset || [];
}

/* ------------------------------- publish ------------------------------- */
async function publishQuizResults(pool, user, courseId, quizId, body, ctx = {}) {
  const cid = posInt(courseId), qid = posInt(quizId); if (!cid || !qid) return { ok: false, notFound: true, errors: ["Quiz not found."] };
  if (body !== undefined && body !== null && !isPlainObject(body)) return { ok: false, errors: ["Send { dryRun? }."] };
  const dryRun = body && body.dryRun === true;
  if (body && body.dryRun !== undefined && typeof body.dryRun !== "boolean") return { ok: false, errors: ["dryRun must be true or false."] };
  const actor = actorOf(user); if (!actor || actor.role === "student") return { ok: false, notFound: true, errors: ["Quiz not found."] };

  const loaded = await loadContext(pool, cid, qid);
  const bad = checkPublishable(loaded && loaded.quiz, loaded && loaded.course); if (bad) return bad;
  const { quiz, course } = loaded;
  if (!(await mappingExists(pool, course))) return reject("NO_RESULTS_MAPPING", "The subject or class set on this course was not found in the school records. Ask the LMS administrator to correct it.");

  const { rows, skipped } = pickScores(await loadAttempts(pool, cid, qid));
  if (!rows.length) return reject("NOTHING_TO_PUBLISH", "No learner has a finished, marked attempt to publish yet.", { skipped: skipped.slice(0, MAX_SKIPPED_SHOWN), skippedCount: skipped.length });
  if (rows.length > MAX_LEARNERS) return reject("TOO_MANY_LEARNERS", `At most ${MAX_LEARNERS} learners can be published at once.`);
  const shown = skipped.slice(0, MAX_SKIPPED_SHOWN);
  if (dryRun) return { ok: true, dryRun: true, eligible: rows.length, skipped: shown, skippedCount: skipped.length, totalMarks: TOTAL_MARKS };

  const json = JSON.stringify(rows.map((r) => ({ s: r.studentId, sc: r.score, p: r.percentage })));
  const res = await pool.request()
    .input("q", sql.Int, qid).input("src", sql.NVarChar(20), SOURCE)
    .input("name", sql.NVarChar(200), String(quiz.title || "LMS quiz").slice(0, 200)).input("atype", sql.NVarChar(50), "LMS Quiz")
    .input("cls", sql.NVarChar(50), String(course.className).trim()).input("term", sql.NVarChar(30), String(course.semester || "").slice(0, 30))
    .input("yr", sql.NVarChar(10), String(course.academicYear || "")).input("tm", sql.Int, TOTAL_MARKS).input("subj", sql.Int, course.subjectId)
    .input("rows", sql.NVarChar(sql.MAX), json)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @aid INT, @inserted INT = 0, @updated INT = 0;
      SELECT TOP 1 @aid = id FROM Assessments WITH (UPDLOCK, HOLDLOCK) WHERE sourceSystem = @src AND sourceRefId = @q;
      IF @aid IS NULL
      BEGIN
        INSERT INTO Assessments (name, assessmentType, targetClass, term, year, totalMarks, status, examScope, sourceSystem, sourceRefId)
        VALUES (@name, @atype, @cls, @term, @yr, @tm, 'Active', 'subject', @src, @q);
        SET @aid = SCOPE_IDENTITY();
      END
      IF NOT EXISTS (SELECT 1 FROM AssessmentSubjects WHERE assessmentId = @aid AND subjectId = @subj)
        INSERT INTO AssessmentSubjects (assessmentId, subjectId) VALUES (@aid, @subj);
      DECLARE @r TABLE (studentId INT PRIMARY KEY, score INT, pct FLOAT);
      INSERT INTO @r (studentId, score, pct) SELECT s, sc, p FROM OPENJSON(@rows) WITH (s INT '$.s', sc INT '$.sc', p FLOAT '$.p');
      UPDATE m SET score = r.score, percentage = r.pct, createdAt = GETDATE()
        FROM Marks m JOIN @r r ON r.studentId = m.studentId
       WHERE m.assessmentId = @aid AND (m.score IS NULL OR m.percentage IS NULL OR m.score <> r.score OR ABS(m.percentage - r.pct) > 0.001);
      SET @updated = @@ROWCOUNT;
      INSERT INTO Marks (studentId, subjectId, assessmentId, score, percentage, createdAt)
        SELECT r.studentId, @subj, @aid, r.score, r.pct, GETDATE() FROM @r r
         WHERE NOT EXISTS (SELECT 1 FROM Marks m WHERE m.assessmentId = @aid AND m.studentId = r.studentId);
      SET @inserted = @@ROWCOUNT;
      COMMIT;
      SELECT @aid AS assessment_id, @inserted AS inserted, @updated AS updated;`);
  const out = res.recordset && res.recordset[0];
  if (!out || !posInt(out.assessment_id)) return reject("RESULTS_INTEGRATION_UNAVAILABLE", "The results could not be written. Nothing was changed.");
  const inserted = Number(out.inserted) || 0, updated = Number(out.updated) || 0, unchanged = Math.max(0, rows.length - inserted - updated);
  await audit(pool, actor, "results.published", "Assessments", out.assessment_id, { courseId: cid, quizId: qid, assessmentId: out.assessment_id, inserted, updated, unchanged, skipped: skipped.length });
  if (ctx.tenant) events.emit("lms.results.published", { tenant: ctx.tenant, courseId: cid, quizId: qid, assessmentId: out.assessment_id, inserted, updated, unchanged });
  return { ok: true, assessmentId: out.assessment_id, totalMarks: TOTAL_MARKS, inserted, updated, unchanged, skipped: shown, skippedCount: skipped.length };
}

module.exports = { SOURCE, TOTAL_MARKS, MAX_LEARNERS, checkPublishable, pickScores, loadAttempts, publishQuizResults, mappingExists };
