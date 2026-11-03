/* =========================================================================
   LMS LESSON PROGRESS + COMPLETION RULES  (L3.4a)

   A student's progress is one row per (lesson, student). Rules (documented, simple, transparent):
   - A lesson has a completion rule set by the teacher:
       view          completes the first time the student opens it
       mark_complete the student presses "Mark complete" (the default)
       min_time      the student presses "Mark complete" after at least N minutes of credited time
   - Credited time is decided by the SERVER: a "view" call may report up to 600 seconds, but the server
     credits at most the real time since the previous call and at most 120 seconds per call. A client
     cannot claim more time than has actually passed, and a closed tab earns nothing.
   - Only lessons a student can see right now count. Hidden, scheduled, draft and deleted lessons are
     ignored, so the course percentage = completed visible lessons / visible lessons (rounded down; 0 if none).
   - Completing is ONE conditional statement (status <> 'completed', and for min_time the time check
     in the same WHERE), so two clicks never emit the event twice and the time rule cannot be raced.
   - Progress is only recorded for a PUBLISHED course. In an archived course students may read but nothing
     is recorded. Changing a lesson's rule later never un-completes anyone.
   - Authorisation (student + ACTIVE enrolment) lives in the routes; the student id always comes from the token.
   Event: lms.lesson.completed {tenant, courseId, lessonId, studentId} (ids only).
========================================================================= */
const sql = require("mssql");
const { emit } = require("./lmsEvents");
const { VISIBLE, MAX_LESSONS } = require("./lmsLessons");
const { lockFor, lockedBody } = require("./lmsPrerequisites");

const MAX_CLAIM_SECONDS = 600, CREDIT_CAP_SECONDS = 120;
const isDup = (e) => e && (e.number === 2627 || e.number === 2601);

const shapeProgress = (r) => r ? ({
  lessonId: r.lesson_id, status: r.status, secondsSpent: r.seconds_spent ?? 0, viewCount: r.view_count ?? 1,
  firstViewedAt: r.first_viewed_at || null, lastViewedAt: r.last_viewed_at || null, completedAt: r.completed_at || null,
}) : null;
const PCOLS = "lesson_id, status, seconds_spent, view_count, first_viewed_at, last_viewed_at, completed_at";
const OUT_P = PCOLS.split(", ").map((c) => `INSERTED.${c}`).join(", ");

/* min(claimed, real elapsed since last_viewed_at, 120), never negative. All in SQL so the clock is the server's. */
const WALL = "DATEDIFF(SECOND, last_viewed_at, SYSUTCDATETIME())";
const CLAIM_OR_WALL = `(CASE WHEN @sec < ${WALL} THEN @sec ELSE ${WALL} END)`;
const CREDIT = `(CASE WHEN @sec <= 0 THEN 0 WHEN ${CLAIM_OR_WALL} > ${CREDIT_CAP_SECONDS} THEN ${CREDIT_CAP_SECONDS} WHEN ${CLAIM_OR_WALL} < 0 THEN 0 ELSE ${CLAIM_OR_WALL} END)`;

function validateView(body) {
  if (body === undefined || body === null) return { ok: true, seconds: 0 };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (k !== "seconds") return { ok: false, errors: [`Unknown field "${k}".`] };
  if (!("seconds" in body)) return { ok: true, seconds: 0 };
  const n = body.seconds;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CLAIM_SECONDS) return { ok: false, errors: [`seconds must be a whole number from 0 to ${MAX_CLAIM_SECONDS}.`] };
  return { ok: true, seconds: n };
}

async function courseStatus(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL AND status IN ('published','archived')`);
  return r.recordset && r.recordset[0] ? r.recordset[0].status : null;
}
async function visibleLesson(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId)
    .query(`SELECT TOP 1 id, completion_rule, min_minutes FROM lms_lessons WHERE id = @id AND course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`);
  const row = r.recordset && r.recordset[0];
  return row ? { id: row.id, rule: row.completion_rule || "mark_complete", minMinutes: row.min_minutes ?? null } : null;
}

/* Creates the row if needed, otherwise credits time and bumps the last-seen time. Returns the row. */
async function touch(pool, courseId, lessonId, studentId, seconds) {
  const upd = () => pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).input("s", sql.Int, studentId).input("sec", sql.Int, seconds)
    .query(`UPDATE lms_lesson_progress SET seconds_spent = seconds_spent + ${CREDIT}, view_count = view_count + CASE WHEN ${WALL} > ${CREDIT_CAP_SECONDS} THEN 1 ELSE 0 END, last_viewed_at = SYSUTCDATETIME()
            OUTPUT ${OUT_P} WHERE lesson_id = @l AND student_id = @s AND course_id = @c`);
  let r = await upd(); let row = r.recordset && r.recordset[0]; if (row) return row;
  try {
    r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).input("s", sql.Int, studentId)
      .query(`INSERT INTO lms_lesson_progress (course_id, lesson_id, student_id) OUTPUT ${OUT_P} VALUES (@c, @l, @s)`);
    row = r.recordset && r.recordset[0]; if (row) return row;
  } catch (e) { if (!isDup(e)) throw e; } // two tabs opened the lesson at once: the other insert won, so update instead
  r = await upd(); return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}

/* Atomic completion. Returns { row, alreadyDone, tooShort }. */
async function complete(pool, courseId, lesson, studentId) {
  const need = lesson.rule === "min_time" ? (lesson.minMinutes || 1) * 60 : 0;
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lesson.id).input("s", sql.Int, studentId).input("need", sql.Int, need)
    .query(`UPDATE lms_lesson_progress SET status = 'completed', completed_at = SYSUTCDATETIME()
            OUTPUT ${OUT_P} WHERE lesson_id = @l AND student_id = @s AND course_id = @c AND status <> 'completed' AND seconds_spent >= @need`);
  if (r.recordset && r.recordset[0]) return { row: r.recordset[0], newlyDone: true };
  const cur = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lesson.id).input("s", sql.Int, studentId)
    .query(`SELECT TOP 1 ${PCOLS} FROM lms_lesson_progress WHERE lesson_id = @l AND student_id = @s AND course_id = @c`);
  const row = cur.recordset && cur.recordset[0];
  return { row, newlyDone: false, tooShort: !!row && row.status !== "completed", remaining: row ? Math.max(0, need - (row.seconds_spent || 0)) : need };
}

/* POST .../view : record that the student has the lesson open (and optionally how long since the last call). */
async function recordView(pool, courseId, lessonId, studentId, body, tenant) {
  const v = validateView(body); if (!v.ok) return { ok: false, errors: v.errors };
  const status = await courseStatus(pool, courseId); if (!status) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  const lesson = await visibleLesson(pool, courseId, lessonId); if (!lesson) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  const by = await lockFor(pool, courseId, lessonId, studentId); if (by.length) return lockedBody(by); // L3.5a: prerequisites not finished
  if (status !== "published") return { ok: true, recorded: false, progress: null, rule: lesson.rule }; // archived: read-only
  let row = await touch(pool, courseId, lessonId, studentId, v.seconds);
  if (!row) return { ok: false, errors: ["Progress could not be saved."] };
  if (lesson.rule === "view" && row.status !== "completed") {
    const c = await complete(pool, courseId, lesson, studentId);
    if (c.row) row = c.row;
    if (c.newlyDone) emit("lms.lesson.completed", { tenant, courseId, lessonId, studentId });
  }
  return { ok: true, recorded: true, progress: shapeProgress(row), rule: lesson.rule };
}

/* POST .../complete : the student presses "Mark complete". Idempotent. */
async function markComplete(pool, courseId, lessonId, studentId, tenant) {
  const status = await courseStatus(pool, courseId); if (!status) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  const lesson = await visibleLesson(pool, courseId, lessonId); if (!lesson) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  if (status !== "published") return { ok: false, code: "COURSE_ARCHIVED", errors: ["This course is archived. Progress is no longer recorded."] };
  const by = await lockFor(pool, courseId, lessonId, studentId); if (by.length) return lockedBody(by); // L3.5a
  if (!(await touch(pool, courseId, lessonId, studentId, 0))) return { ok: false, errors: ["Progress could not be saved."] };
  const c = await complete(pool, courseId, lesson, studentId);
  if (c.tooShort) {
    const mins = Math.ceil(c.remaining / 60);
    return { ok: false, code: "MIN_TIME_NOT_MET", extra: { remainingSeconds: c.remaining }, errors: [`Spend about ${mins} more minute${mins === 1 ? "" : "s"} on this lesson before marking it complete.`] };
  }
  if (c.newlyDone) emit("lms.lesson.completed", { tenant, courseId, lessonId, studentId });
  return { ok: true, progress: shapeProgress(c.row), newlyCompleted: !!c.newlyDone };
}

/* GET .../progress : per-lesson state, course percentage and where to resume. */
async function courseProgress(pool, courseId, studentId) {
  if (!(await courseStatus(pool, courseId))) return { ok: false, notFound: true, errors: ["Course not found."] };
  const secs = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 100 id, sort_order FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL ORDER BY sort_order, id`);
  const les = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP ${MAX_LESSONS} id, section_id, sort_order FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE} ORDER BY sort_order, id`);
  const prog = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT TOP ${MAX_LESSONS} ${PCOLS} FROM lms_lesson_progress WHERE course_id = @c AND student_id = @s`);
  const secIds = (secs.recordset || []).map((s) => s.id), all = les.recordset || [];
  const ordered = [...secIds.flatMap((id) => all.filter((l) => l.section_id === id)), ...all.filter((l) => l.section_id == null || !secIds.includes(l.section_id))];
  const byLesson = new Map((prog.recordset || []).map((p) => [p.lesson_id, p]));
  const lessons = ordered.map((l) => { const p = byLesson.get(l.id); return { lessonId: l.id, sectionId: l.section_id ?? null, status: p ? p.status : "not_started", secondsSpent: p ? p.seconds_spent ?? 0 : 0, lastViewedAt: p ? p.last_viewed_at || null : null, completedAt: p ? p.completed_at || null : null }; });
  const done = lessons.filter((l) => l.status === "completed").length, total = lessons.length;
  const open = lessons.filter((l) => l.status === "in_progress").sort((a, b) => new Date(b.lastViewedAt || 0) - new Date(a.lastViewedAt || 0))[0];
  const resume = open || lessons.find((l) => l.status === "not_started") || null;
  return { ok: true, percent: total ? Math.floor((100 * done) / total) : 0, completed: done, total, lessons, resumeLessonId: resume ? resume.lessonId : null };
}

module.exports = { validateView, recordView, markComplete, courseProgress, MAX_CLAIM_SECONDS, CREDIT_CAP_SECONDS };
