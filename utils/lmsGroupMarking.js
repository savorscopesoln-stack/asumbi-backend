/* =========================================================================
   LMS GROUP MARKING  (L8.4b, D-103): mark or return a GROUP hand-in once.
   A group hand-in is one submitted row per active member (D-102, `lms_submissions.group_id`). These two actions take ONE of those rows and apply the existing,
   fully validated `saveGrade` / `returnGrade` to every submitted row of the same group of THIS assignment and course (max 50), the clicked row first.
   - The clicked row decides: if it is refused (validation, archived course, ...) nothing else is touched.
   - A member whose grade is already RETURNED is never changed (Q34): reported in `skipped`. Any other member failure is reported in `failed`; running the
     action again is safe (same input = same result) and is the way to retry.
   - Not group work = 409 NOT_GROUP_WORK. A single member can still be marked alone with the normal per-row routes (individual override, audited).
   - Course, assignment and group are matched in SQL, so an id from another course or tenant finds nothing (404). Permission and course membership are checked in the route.
   - One extra audit entry per action (`submission.graded_group` / `submission.returned_group`) with counts only.
   `opts.marking` lets tests inject the marking functions; routes never pass it.
   Every query is parameterised.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const marking = require("./lmsMarking");

const MAX_MEMBERS = 50;
const notFound = () => ({ ok: false, notFound: true, errors: ["Submission not found."] });

/* Submitted rows of the SAME group as submission @sid (clicked row first). Empty = not found or not group work. */
async function siblings(pool, courseId, assignmentId, submissionId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("sid", sql.Int, submissionId)
    .query(`SELECT TOP ${MAX_MEMBERS} s.id, s.student_id FROM lms_submissions s
            WHERE s.assignment_id = @a AND s.course_id = @c AND s.status = 'submitted'
              AND s.group_id = (SELECT g.group_id FROM lms_submissions g WHERE g.id = @sid AND g.assignment_id = @a AND g.course_id = @c AND g.status = 'submitted')
            ORDER BY CASE WHEN s.id = @sid THEN 0 ELSE 1 END, s.id`);
  return r.recordset || [];
}
async function plan(pool, user, courseId, assignmentId, submissionId) {
  const actor = actorOf(user), c = Number.isInteger(courseId) && courseId > 0, a = Number.isInteger(assignmentId) && assignmentId > 0, s = Number.isInteger(submissionId) && submissionId > 0;
  if (!actor || !c || !a || !s) return notFound();
  const rows = await siblings(pool, courseId, assignmentId, submissionId);
  if (!rows.length) {
    const own = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("sid", sql.Int, submissionId)
      .query(`SELECT TOP 1 id FROM lms_submissions WHERE id = @sid AND assignment_id = @a AND course_id = @c AND status = 'submitted'`);
    return own.recordset && own.recordset.length ? { ok: false, code: "NOT_GROUP_WORK", errors: ["This is not group work. Mark it on its own."] } : notFound();
  }
  return { ok: true, actor, rows };
}
async function each(rows, fn) {
  const done = [], skipped = [], failed = []; let first = null;
  for (const [i, row] of rows.entries()) {
    const r = await fn(row);
    if (i === 0) { if (!r.ok) return { refused: r }; first = r; done.push(row.id); continue; }
    if (r.ok) done.push(row.id); else if (r.code === "ALREADY_RETURNED" || r.code === "NOT_GRADED") skipped.push(row.id); else failed.push({ submissionId: row.id, code: r.code || (r.notFound ? "NOT_FOUND" : "REFUSED") });
  }
  return { first, done, skipped, failed };
}

async function saveGroupGrade(pool, user, courseId, assignmentId, submissionId, body, { tenant, marking: m = marking } = {}) {
  const p = await plan(pool, user, courseId, assignmentId, submissionId); if (!p.ok) return p;
  const o = await each(p.rows, (row) => m.saveGrade(pool, user, courseId, assignmentId, row.id, body, { tenant }));
  if (o.refused) return o.refused;
  await audit(pool, p.actor, "submission.graded_group", "lms_submissions", submissionId, { courseId, assignmentId, graded: o.done.length, skipped: o.skipped.length, failed: o.failed.length });
  return { ok: true, grade: o.first.grade, members: { graded: o.done.length, skipped: o.skipped, failed: o.failed } };
}
async function returnGroup(pool, user, courseId, assignmentId, submissionId, { tenant, now, marking: m = marking } = {}) {
  const p = await plan(pool, user, courseId, assignmentId, submissionId); if (!p.ok) return p;
  const o = await each(p.rows, (row) => m.returnGrade(pool, user, courseId, assignmentId, row.id, { tenant, now }));
  if (o.refused) return o.refused;
  await audit(pool, p.actor, "submission.returned_group", "lms_submissions", submissionId, { courseId, assignmentId, returned: o.done.length, skipped: o.skipped.length, failed: o.failed.length });
  return { ok: true, grade: o.first.grade, members: { returned: o.done.length, skipped: o.skipped, failed: o.failed } };
}

module.exports = { MAX_MEMBERS, saveGroupGrade, returnGroup };
