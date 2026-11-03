/* =========================================================================
   LMS GRADE RELEASE  (L5.4b-2; owner answers Q34 = no re-open, Q35 = bulk return AND scheduled release; D-064, D-065)

   Three things, all about turning DRAFT grades into RETURNED ones (the only state a student can see):
   1. BULK RETURN: one set-based UPDATE returns every graded (draft) grade of the assignment's LATEST submitted attempts. Work with no grade yet is skipped
      and counted. Nothing already returned is touched.
   2. SCHEDULE: one release time per assignment (future, at most one year ahead). At that time every draft grade of the latest attempts that was SAVED AT OR
      BEFORE it is returned; a grade saved after it stays a draft (the teacher returns it by hand or bulk). A schedule can be changed or cancelled only
      while it has not passed. Once it has passed it is history and can no longer be edited (that would be re-opening, which is not allowed).
   2b. PER-STUDENT OVERRIDE (L5.4b-3, owner Q36 = both; D-066): a teacher may give one student their own release time. For work graded at or before that time it
      REPLACES the assignment schedule for that student (earlier or later); work graded after it follows the assignment schedule again. Same limits as 2:
      future, at most a year ahead, changed or cancelled only before it passes. The student must have an enrolment row in the course.
   3. `releaseDue`: the schedule is applied LAZILY. Every read of that assignment's grades (staff queue, marking, saving, a student's feedback, their
      assignment list, their dashboard) first runs ONE guarded UPDATE for the due schedules in its scope. So `status` stays the single truth and a missed call
      site can only DELAY a release, never expose a draft (fail safe). The update sets returned_at to the scheduled time, and emits `lms.grade.released` once per
      grade (the UPDATE only changes rows still `draft`, so concurrent callers cannot both emit). releaseDue never throws: a failure is logged and the caller
      carries on (grades just stay hidden a little longer).
   Rules: staff only (`lms.submission.grade` + course membership, checked in the route); archived or pending courses are read-only; every query also matches
   course_id AND assignment_id; every query is parameterised.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { editable } = require("./lmsCourseParts");
const events = require("./lmsEvents");

const MAX_AHEAD_DAYS = 366, MAX_EVENTS = 5000;
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const notFound = (what = "Assignment") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });

/* Fixed SQL fragment: g is a grade, and it belongs to the student's LATEST submitted attempt of that assignment (what the marking queue shows). */
const LATEST = `EXISTS (SELECT 1 FROM lms_submissions s WHERE s.id = g.submission_id AND s.status = 'submitted'
    AND s.attempt_no = (SELECT MAX(l.attempt_no) FROM lms_submissions l WHERE l.assignment_id = s.assignment_id AND l.student_id = s.student_id AND l.status = 'submitted'))`;

/* Pure. A release time from the client: ISO 8601 WITH a time zone, in the future, at most a year ahead. */
function parseReleaseAt(v, now = new Date()) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v.trim())) return { ok: false, errors: ["releaseAt must be an ISO 8601 date and time with a time zone, e.g. 2026-11-20T08:00:00+03:00."] };
  const d = new Date(v.trim()); if (Number.isNaN(d.getTime())) return { ok: false, errors: ["releaseAt is not a real date."] };
  if (d.getTime() <= now.getTime()) return { ok: false, errors: ["The release time must be in the future."] };
  if (d.getTime() > now.getTime() + MAX_AHEAD_DAYS * 864e5) return { ok: false, errors: [`The release time can be at most ${MAX_AHEAD_DAYS} days ahead.`] };
  return { ok: true, date: d };
}

function announce(rows, tenant, courseId, assignmentId) {
  if (!tenant) return;
  for (const r of (rows || []).slice(0, MAX_EVENTS)) events.emit("lms.grade.released", { tenant, courseId: r.course_id ?? courseId, assignmentId: r.assignment_id ?? assignmentId, submissionId: r.submission_id, studentId: r.student_id });
}

/* `strict` (used before changing or cancelling a schedule, where a silent failure could cancel a release that was due) rethrows instead of logging.
   Applies every DUE schedule inside `scope` ({courseId?, assignmentId?, studentId?}, at least one). Never throws; returns how many grades were released. */
async function releaseDue(pool, scope, { tenant, now = new Date(), strict = false } = {}) {
  try {
    const c = scope && Number.isInteger(scope.courseId) && scope.courseId > 0 ? scope.courseId : null;
    const a = scope && Number.isInteger(scope.assignmentId) && scope.assignmentId > 0 ? scope.assignmentId : null;
    const st = scope && Number.isInteger(scope.studentId) && scope.studentId > 0 ? scope.studentId : null;
    if (!c && !a && !st) return 0;
    const r = pool.request().input("now", sql.DateTime2, now);
    const where = [];
    if (c) { r.input("c", sql.Int, c); where.push("g.course_id = @c"); }
    if (a) { r.input("a", sql.Int, a); where.push("g.assignment_id = @a"); }
    if (st) { r.input("st", sql.Int, st); where.push("g.student_id = @st"); }
    /* The EFFECTIVE release time of a grade: the student's own override if it is at or after the moment the grade was saved, otherwise the assignment schedule. */
    const res = await r.query(`UPDATE g SET status = 'returned', returned_at = rel.release_at, updated_at = @now
        OUTPUT INSERTED.submission_id, INSERTED.assignment_id, INSERTED.course_id, INSERTED.student_id
        FROM lms_submission_grades g
        CROSS APPLY (SELECT TOP 1 x.release_at FROM (
            SELECT 1 AS pri, sr.release_at FROM lms_student_releases sr WHERE sr.assignment_id = g.assignment_id AND sr.course_id = g.course_id AND sr.student_id = g.student_id AND sr.release_at >= g.graded_at
            UNION ALL
            SELECT 2 AS pri, ar.release_at FROM lms_assignment_releases ar WHERE ar.assignment_id = g.assignment_id AND ar.course_id = g.course_id) x ORDER BY x.pri) rel
        WHERE g.status = 'draft' AND g.graded_at <= rel.release_at AND rel.release_at <= @now AND ${where.join(" AND ")} AND ${LATEST}`);
    const rows = res.recordset || []; if (rows.length) announce(rows, tenant);
    return rows.length;
  } catch (e) { if (strict) throw e; console.error("LMS GRADE RELEASE (releaseDue) ERROR:", e.message); return 0; }
}

async function assignmentExists(pool, courseId, assignmentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 1 id FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset[0]);
}
async function loadRelease(pool, courseId, assignmentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 1 release_at FROM lms_assignment_releases WHERE assignment_id = @a AND course_id = @c`);
  const row = r.recordset && r.recordset[0]; return row ? { releaseAt: iso(row.release_at), at: new Date(row.release_at) } : null;
}

/* The schedule shown to staff: {releaseAt, passed} or null. Applies a due schedule first so `passed` is truthful. */
async function getRelease(pool, courseId, assignmentId, { tenant, now = new Date() } = {}) {
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  await releaseDue(pool, { courseId, assignmentId }, { tenant, now });
  const x = await loadRelease(pool, courseId, assignmentId);
  return { ok: true, release: x ? { releaseAt: x.releaseAt, passed: x.at.getTime() <= now.getTime() } : null };
}

/* Create or change the schedule. Refused once the existing one has passed? No: a PASSED schedule has already been applied (releaseDue ran first), so a NEW
   future schedule may replace it (for work graded later). Only a schedule that has NOT passed is changed in place. */
async function setRelease(pool, user, courseId, assignmentId, body, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "releaseAt")) return { ok: false, errors: ["Send only releaseAt."] };
  const t = parseReleaseAt(body.releaseAt, now); if (!t.ok) return t;
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  await releaseDue(pool, { courseId, assignmentId }, { tenant, now, strict: true });
  const run = () => pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("at", sql.DateTime2, t.date).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_assignment_releases SET release_at = @at, scheduled_by_source = @src, scheduled_by = @uid, updated_at = @now WHERE assignment_id = @a AND course_id = @c;
      IF @@ROWCOUNT = 0 INSERT INTO lms_assignment_releases (assignment_id, course_id, release_at, scheduled_by_source, scheduled_by) VALUES (@a, @c, @at, @src, @uid);`);
  try { await run(); } catch (e) { if (!(e && (e.number === 2601 || e.number === 2627))) throw e; await run(); } // two first-time saves at once: the second updates
  await audit(pool, actor, "grades.release_scheduled", "lms_assignments", assignmentId, { courseId, releaseAt: t.date.toISOString() });
  return { ok: true, release: { releaseAt: t.date.toISOString(), passed: false } };
}

/* Cancel a schedule that has not passed. One guarded DELETE (release_at > now), so a schedule that just came due cannot be cancelled. */
async function cancelRelease(pool, user, courseId, assignmentId, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  await releaseDue(pool, { courseId, assignmentId }, { tenant, now, strict: true });
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("now", sql.DateTime2, now)
    .query(`DELETE FROM lms_assignment_releases OUTPUT DELETED.release_at WHERE assignment_id = @a AND course_id = @c AND release_at > @now`);
  if (!(r.recordset && r.recordset[0])) {
    return (await loadRelease(pool, courseId, assignmentId))
      ? { ok: false, code: "SCHEDULE_PASSED", errors: ["This release time has already passed, so it can no longer be changed."] }
      : { ok: false, code: "NOT_SCHEDULED", errors: ["No release is scheduled for this assignment."] };
  }
  await audit(pool, actor, "grades.release_cancelled", "lms_assignments", assignmentId, { courseId });
  return { ok: true, cancelled: true };
}

/* Return every graded (draft) grade of the latest attempts NOW. One UPDATE; ungraded latest attempts are counted, not touched. */
async function returnAll(pool, user, courseId, assignmentId, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("now", sql.DateTime2, now)
    .query(`UPDATE g SET status = 'returned', returned_at = @now, updated_at = @now
        OUTPUT INSERTED.submission_id, INSERTED.assignment_id, INSERTED.course_id, INSERTED.student_id
        FROM lms_submission_grades g WHERE g.assignment_id = @a AND g.course_id = @c AND g.status = 'draft' AND ${LATEST}`);
  const rows = r.recordset || [];
  const k = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId)
    .query(`SELECT COUNT(*) AS n FROM lms_submissions s LEFT JOIN lms_submission_grades g ON g.submission_id = s.id
        WHERE s.assignment_id = @a AND s.course_id = @c AND s.status = 'submitted' AND g.id IS NULL
          AND s.attempt_no = (SELECT MAX(l.attempt_no) FROM lms_submissions l WHERE l.assignment_id = s.assignment_id AND l.student_id = s.student_id AND l.status = 'submitted')`);
  const skipped = Number(k.recordset?.[0]?.n) || 0;
  await audit(pool, actor, "grades.returned_all", "lms_assignments", assignmentId, { courseId, returned: rows.length, skippedUngraded: skipped });
  announce(rows, tenant, courseId, assignmentId);
  return { ok: true, returned: rows.length, skippedUngraded: skipped };
}

/* ---- per-student override (D-066) ---- */
const studentOk = (v) => (Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : null);
async function hasEnrolment(pool, courseId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT TOP 1 student_id FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s`);
  return !!(r.recordset && r.recordset[0]);
}
async function loadStudentRelease(pool, courseId, assignmentId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, studentId)
    .query(`SELECT TOP 1 release_at FROM lms_student_releases WHERE assignment_id = @a AND course_id = @c AND student_id = @s`);
  const row = r.recordset && r.recordset[0]; return row ? { releaseAt: iso(row.release_at), at: new Date(row.release_at) } : null;
}

/* Staff list of overrides for one assignment (at most 500, soonest first). Applies due schedules first so `passed` is truthful. */
async function listStudentReleases(pool, courseId, assignmentId, { tenant, now = new Date() } = {}) {
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  await releaseDue(pool, { courseId, assignmentId }, { tenant, now });
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 500 sr.student_id, sr.release_at, st.name AS student_name, st.admissionNo AS admission_no
      FROM lms_student_releases sr LEFT JOIN Students st ON st.id = sr.student_id
      WHERE sr.assignment_id = @a AND sr.course_id = @c ORDER BY sr.release_at, sr.student_id`);
  return { ok: true, releases: (r.recordset || []).map((x) => ({ studentId: x.student_id, studentName: x.student_name || null, admissionNo: x.admission_no || null, releaseAt: iso(x.release_at), passed: new Date(x.release_at).getTime() <= now.getTime() })) };
}

async function setStudentRelease(pool, user, courseId, assignmentId, studentId, body, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sid = studentOk(studentId); if (!sid) return notFound("Student");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "releaseAt")) return { ok: false, errors: ["Send only releaseAt."] };
  const t = parseReleaseAt(body.releaseAt, now); if (!t.ok) return t;
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  if (!(await hasEnrolment(pool, courseId, sid))) return notFound("Student");
  await releaseDue(pool, { courseId, assignmentId, studentId: sid }, { tenant, now, strict: true });
  const run = () => pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid).input("at", sql.DateTime2, t.date).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_student_releases SET release_at = @at, scheduled_by_source = @src, scheduled_by = @uid, updated_at = @now WHERE assignment_id = @a AND course_id = @c AND student_id = @s;
      IF @@ROWCOUNT = 0 INSERT INTO lms_student_releases (assignment_id, course_id, student_id, release_at, scheduled_by_source, scheduled_by) VALUES (@a, @c, @s, @at, @src, @uid);`);
  try { await run(); } catch (e) { if (!(e && (e.number === 2601 || e.number === 2627))) throw e; await run(); }
  await audit(pool, actor, "grades.student_release_scheduled", "lms_assignments", assignmentId, { courseId, studentId: sid, releaseAt: t.date.toISOString() });
  return { ok: true, release: { studentId: sid, releaseAt: t.date.toISOString(), passed: false } };
}

async function cancelStudentRelease(pool, user, courseId, assignmentId, studentId, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sid = studentOk(studentId); if (!sid) return notFound("Student");
  if (!(await assignmentExists(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  await releaseDue(pool, { courseId, assignmentId, studentId: sid }, { tenant, now, strict: true });
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid).input("now", sql.DateTime2, now)
    .query(`DELETE FROM lms_student_releases OUTPUT DELETED.release_at WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND release_at > @now`);
  if (!(r.recordset && r.recordset[0])) {
    return (await loadStudentRelease(pool, courseId, assignmentId, sid))
      ? { ok: false, code: "SCHEDULE_PASSED", errors: ["This release time has already passed, so it can no longer be changed."] }
      : { ok: false, code: "NOT_SCHEDULED", errors: ["No release is scheduled for this student."] };
  }
  await audit(pool, actor, "grades.student_release_cancelled", "lms_assignments", assignmentId, { courseId, studentId: sid });
  return { ok: true, cancelled: true };
}

/* The schedule as staff see it, WITHOUT applying it (the caller has just run releaseDue). */
async function peekRelease(pool, courseId, assignmentId, now = new Date()) {
  const x = await loadRelease(pool, courseId, assignmentId);
  return x ? { releaseAt: x.releaseAt, passed: x.at.getTime() <= now.getTime() } : null;
}

module.exports = { listStudentReleases, setStudentRelease, cancelStudentRelease, peekRelease, MAX_AHEAD_DAYS, parseReleaseAt, releaseDue, getRelease, setRelease, cancelRelease, returnAll, LATEST };
