/* =========================================================================
   LMS LESSON PREREQUISITES  (L3.5a)  "finish A before B"

   Rules (documented, simple):
   - A lesson can require up to 10 other lessons of THE SAME course. Teachers set the full list in one call
     (replace, atomic). Self-reference and cycles (A needs B needs A, any length) are refused.
   - A prerequisite counts only while it is visible to students (published, not scheduled for later, not deleted).
     A hidden or deleted prerequisite is ignored, so a student can never be stuck behind a lesson they cannot open.
   - A lesson is LOCKED for a student while any counted prerequisite is not COMPLETED by that student. Chains work
     naturally: if C is not done, B is locked, so A stays locked too.
   - A lesson the student has already completed is never locked again (adding a rule later does not punish them).
   - A locked lesson shows its title in the list but its content is never sent, and view/complete are refused
     with 409 LESSON_LOCKED (the response says which lessons to finish first).
   - Date-based release is the lesson's publish_at (L3.3a). Group/class release waits for groups (L8).
   Authorisation lives in the routes; every query also matches course_id.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const lessons = require("./lmsLessons");

const MAX_PREREQS = 10, MAX_EDGES = 10000;
const visibleAs = (a) => lessons.VISIBLE.replace(/\b(status|publish_at)\b/g, `${a}.$1`); // same rule as students' lesson reads, on a table alias
const VISIBLE_R = visibleAs("r"), VISIBLE_T = visibleAs("t");

/* ids: array of positive ints, unique, at most 10. Returns { ok, ids } or { ok:false, errors }. */
function validateIds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (k !== "ids") return { ok: false, errors: [`Unknown field "${k}".`] };
  if (!Array.isArray(body.ids)) return { ok: false, errors: ["ids must be a list of lesson ids (an empty list clears the prerequisites)."] };
  if (body.ids.length > MAX_PREREQS) return { ok: false, errors: [`A lesson can have at most ${MAX_PREREQS} prerequisites.`] };
  const ids = body.ids.map((x) => posInt(x));
  if (ids.some((x) => x === null)) return { ok: false, errors: ["Every id must be a positive whole number."] };
  if (new Set(ids).size !== ids.length) return { ok: false, errors: ["Each prerequisite may be listed once."] };
  return { ok: true, ids };
}

/* Would giving `lessonId` the prerequisites `ids` create a loop? `edges` = [{lesson, requires}] of the OTHER lessons. */
function createsCycle(lessonId, ids, edges) {
  const next = new Map();
  for (const e of edges) { if (e.lesson === lessonId) continue; if (!next.has(e.lesson)) next.set(e.lesson, []); next.get(e.lesson).push(e.requires); }
  const seen = new Set(), stack = [...ids];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === lessonId) return true;
    if (seen.has(cur)) continue; seen.add(cur);
    for (const n of next.get(cur) || []) stack.push(n);
  }
  return false;
}

/* ------------------------------ staff ------------------------------------ */
async function lessonLive(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).query(`SELECT TOP 1 id FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}
async function getPrerequisites(pool, courseId, lessonId) {
  if (!(await lessonLive(pool, courseId, lessonId))) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  return readPrerequisites(pool, courseId, lessonId);
}
async function readPrerequisites(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId)
    .query(`SELECT TOP ${MAX_PREREQS} r.id, r.title FROM lms_lesson_prerequisites p JOIN lms_lessons r ON r.id = p.requires_lesson_id AND r.course_id = @c AND r.deleted_at IS NULL
            WHERE p.lesson_id = @l AND p.course_id = @c ORDER BY r.sort_order, r.id`);
  return { ok: true, prerequisites: (r.recordset || []).map((x) => ({ lessonId: x.id, title: x.title })) };
}

async function setPrerequisites(pool, user, courseId, lessonId, body) {
  const v = validateIds(body); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const live = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP ${lessons.MAX_LESSONS} id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL`);
  const liveIds = new Set((live.recordset || []).map((x) => x.id));
  if (!liveIds.has(lessonId)) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  if (v.ids.includes(lessonId)) return { ok: false, errors: ["A lesson cannot be its own prerequisite."] };
  if (v.ids.some((id) => !liveIds.has(id))) return { ok: false, errors: ["Every prerequisite must be a lesson of this course."] };
  const ed = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP ${MAX_EDGES} lesson_id, requires_lesson_id FROM lms_lesson_prerequisites WHERE course_id = @c`);
  const edges = (ed.recordset || []).filter((x) => liveIds.has(x.lesson_id) && liveIds.has(x.requires_lesson_id)).map((x) => ({ lesson: x.lesson_id, requires: x.requires_lesson_id }));
  if (createsCycle(lessonId, v.ids, edges)) return { ok: false, errors: ["That would make a loop: one of those lessons already needs this lesson (directly or through others)."] };
  const req = pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId);
  v.ids.forEach((id, i) => req.input(`r${i}`, sql.Int, id));
  const rows = v.ids.map((_, i) => `(@c, @l, @r${i})`).join(", ");
  await req.query(`SET XACT_ABORT ON; BEGIN TRAN;
    DELETE FROM lms_lesson_prerequisites WHERE lesson_id = @l AND course_id = @c;
    ${v.ids.length ? `INSERT INTO lms_lesson_prerequisites (course_id, lesson_id, requires_lesson_id) VALUES ${rows};` : ""}
    COMMIT;`);
  await audit(pool, actorOf(user), "lesson.prerequisites_set", "lms_lessons", lessonId, { courseId, count: v.ids.length });
  return readPrerequisites(pool, courseId, lessonId); // the lesson was just confirmed live above
}

/* ------------------------------ students --------------------------------- */
/* Unmet, counted prerequisites of ONE lesson for this student: [] = open. A completed lesson is never locked. */
async function lockFor(pool, courseId, lessonId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).input("s", sql.Int, studentId)
    .query(`SELECT TOP ${MAX_PREREQS} r.id, r.title FROM lms_lesson_prerequisites p
            JOIN lms_lessons t ON t.id = p.lesson_id AND t.course_id = @c AND t.deleted_at IS NULL AND ${VISIBLE_T}
            JOIN lms_lessons r ON r.id = p.requires_lesson_id AND r.course_id = @c AND r.deleted_at IS NULL AND ${VISIBLE_R}
            LEFT JOIN lms_lesson_progress g ON g.lesson_id = r.id AND g.student_id = @s AND g.course_id = @c AND g.status = 'completed'
            WHERE p.lesson_id = @l AND p.course_id = @c AND g.id IS NULL
              AND NOT EXISTS (SELECT 1 FROM lms_lesson_progress d WHERE d.lesson_id = @l AND d.student_id = @s AND d.course_id = @c AND d.status = 'completed')
            ORDER BY r.sort_order, r.id`);
  return (r.recordset || []).map((x) => ({ lessonId: x.id, title: x.title }));
}
const lockedBody = (by) => ({ ok: false, code: "LESSON_LOCKED", errors: [`Finish ${by.map((x) => `"${x.title}"`).slice(0, 3).join(", ")}${by.length > 3 ? " and more" : ""} first.`], extra: { lockedBy: by } });

/* The student's lesson list with `locked` / `lockedBy` on every lesson (content is never in the list). */
async function studentListView(pool, courseId, studentId) {
  const base = await lessons.listLessonsForStudent(pool, courseId); if (!base.ok) return base;
  const all = [...base.sections.flatMap((s) => s.lessons), ...base.unsectioned];
  if (!all.length) return base;
  const un = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT TOP ${MAX_EDGES} p.lesson_id, r.id AS req_id, r.title AS req_title FROM lms_lesson_prerequisites p
            JOIN lms_lessons r ON r.id = p.requires_lesson_id AND r.course_id = @c AND r.deleted_at IS NULL AND ${VISIBLE_R}
            LEFT JOIN lms_lesson_progress g ON g.lesson_id = r.id AND g.student_id = @s AND g.course_id = @c AND g.status = 'completed'
            WHERE p.course_id = @c AND g.id IS NULL ORDER BY r.sort_order, r.id`);
  const done = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).query(`SELECT TOP ${lessons.MAX_LESSONS} lesson_id FROM lms_lesson_progress WHERE course_id = @c AND student_id = @s AND status = 'completed'`);
  const completed = new Set((done.recordset || []).map((x) => x.lesson_id)), by = new Map();
  for (const x of un.recordset || []) { if (!by.has(x.lesson_id)) by.set(x.lesson_id, []); by.get(x.lesson_id).push({ lessonId: x.req_id, title: x.req_title }); }
  for (const l of all) { const b = completed.has(l.id) ? [] : (by.get(l.id) || []).slice(0, MAX_PREREQS); l.locked = b.length > 0; l.lockedBy = b; }
  return base;
}

/* One lesson with its content, unless locked (then 409 LESSON_LOCKED and no content). */
async function studentLessonView(pool, courseId, lessonId, studentId) {
  const by = await lockFor(pool, courseId, lessonId, studentId); // empty for hidden/missing lessons, so a locked answer never leaks a draft
  if (by.length) return (await lessons.studentCourseOpen(pool, courseId)) ? lockedBody(by) : { ok: false, notFound: true, errors: ["Lesson not found."] };
  const r = await lessons.getLessonForStudent(pool, courseId, lessonId); if (!r.ok) return r; // content is read only after the lock check
  r.lesson.locked = false; return r;
}

module.exports = { MAX_PREREQS, validateIds, createsCycle, getPrerequisites, setPrerequisites, lockFor, lockedBody, studentListView, studentLessonView };
