/* =========================================================================
   LMS EXTENSIONS  (L5.5): a deadline extension for ONE learner on ONE assignment (an accommodation).

   Rules (documented, simple):
   - Staff only (`lms.course.manage` + course membership, checked in the route). The learner must have an enrolment row in THIS course. Archived and pending
     courses are read-only. Every query matches course_id AND assignment_id (and student_id); all values are parameters.
   - An extension gives the learner a LATER due date (`dueAt`, required, ISO 8601 with time zone, in the future, at most 366 days ahead, after the assignment's own
     due date) and optionally a later `cutoffAt` (after dueAt). If the assignment has a cutoff and the new dueAt reaches it, `cutoffAt` is REQUIRED (nothing is
     left open by accident). If `cutoffAt` is omitted the assignment's own cutoff still applies. An assignment with no due date has nothing to extend (409 NO_DEADLINE).
   - One extension per (assignment, learner): granting again changes it. Revoking removes it (a draft the learner is still writing then follows the normal
     deadline); work already handed in keeps its recorded late flag. Both are audited. Event `lms.extension.granted` (ids only).
   - `withExtension` (pure) applies an extension row to an assignment model: effective dueAt = the later of the two dates; effective cutoffAt = the extension's, else the assignment's.
     lmsSubmissions (window, state), the dashboard "pending" list and the planner/feed all use it, so they cannot disagree.
   - Plagiarism hook: interface only, see utils/lmsPlagiarism.js.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { editable } = require("./lmsCourseParts");
const { parseReleaseAt } = require("./lmsRelease");
const events = require("./lmsEvents");

const MAX_LISTED = 500, MAX_REASON = 500;
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const notFound = (what = "Assignment") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);
const posInt = (v) => (Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : null);
const cleanReason = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim();

/* Fixed SQL for readers that LEFT JOIN a learner's extension (never user text). `sid` is a parameter NAME such as "@s". */
const joinSql = (sid) => `LEFT JOIN lms_extensions x ON x.assignment_id = a.id AND x.course_id = a.course_id AND x.student_id = ${sid}`;
const EXT_COLS = "x.due_at AS ext_due_at, x.cutoff_at AS ext_cutoff_at";

/* Pure. Applies the extension columns of a row (ext_due_at / ext_cutoff_at) to an assignment model. No extension = the same model. */
function withExtension(m, row) {
  if (!m || !row || !row.ext_due_at) return m;
  const ed = new Date(row.ext_due_at); if (Number.isNaN(ed.getTime())) return m;
  const dueAt = m.dueAt && m.dueAt > ed ? m.dueAt : ed;
  const ec = row.ext_cutoff_at ? new Date(row.ext_cutoff_at) : null;
  return { ...m, dueAt, cutoffAt: ec && !Number.isNaN(ec.getTime()) ? ec : m.cutoffAt, extended: true };
}

/* Pure. Validates a staff body against the assignment's own dates. */
function validateBody(body, a, now) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["dueAt", "cutoffAt", "reason"].includes(k))) return { ok: false, errors: ["Send only dueAt, cutoffAt and reason."] };
  const d = parseReleaseAt(body.dueAt, now); if (!d.ok) return { ok: false, errors: d.errors.map((e) => e.replace(/releaseAt/g, "dueAt").replace("release time", "new due date")) };
  const due = a.due_at ? new Date(a.due_at) : null, cut = a.cutoff_at ? new Date(a.cutoff_at) : null;
  if (!due) return { ok: false, code: "NO_DEADLINE", errors: ["This assignment has no due date, so there is nothing to extend."] };
  if (d.date.getTime() <= due.getTime()) return { ok: false, errors: ["The new due date must be later than the assignment's own due date."] };
  let cutoff = null;
  if (body.cutoffAt !== undefined && body.cutoffAt !== null) {
    const c = parseReleaseAt(body.cutoffAt, now); if (!c.ok) return { ok: false, errors: c.errors.map((e) => e.replace(/releaseAt/g, "cutoffAt").replace("release time", "cut-off")) };
    if (c.date.getTime() <= d.date.getTime()) return { ok: false, errors: ["cutoffAt must be later than dueAt."] };
    cutoff = c.date;
  } else if (cut && d.date.getTime() >= cut.getTime()) return { ok: false, errors: ["The assignment has a cut-off that this due date reaches, so cutoffAt is required."] };
  let reason = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") return { ok: false, errors: ["reason must be text."] };
    reason = cleanReason(body.reason); if (reason.length > MAX_REASON) return { ok: false, errors: [`reason is too long: at most ${MAX_REASON} characters.`] };
    if (!reason) reason = null;
  }
  return { ok: true, dueAt: d.date, cutoffAt: cutoff, reason };
}

async function loadAssignment(pool, courseId, assignmentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 1 id, due_at, cutoff_at FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
  return (r.recordset && r.recordset[0]) || null;
}
async function hasEnrolment(pool, courseId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT TOP 1 student_id FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s`);
  return !!(r.recordset && r.recordset[0]);
}
const shape = (x) => ({ studentId: x.student_id, studentName: x.student_name || null, admissionNo: x.admission_no || null, dueAt: iso(x.due_at), cutoffAt: iso(x.cutoff_at), reason: x.reason || null, grantedAt: iso(x.updated_at) });

async function listExtensions(pool, courseId, assignmentId) {
  if (!(await loadAssignment(pool, courseId, assignmentId))) return notFound();
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP ${MAX_LISTED} x.student_id, x.due_at, x.cutoff_at, x.reason, x.updated_at, st.name AS student_name, st.admissionNo AS admission_no
      FROM lms_extensions x LEFT JOIN Students st ON st.id = x.student_id
      WHERE x.assignment_id = @a AND x.course_id = @c ORDER BY x.due_at, x.student_id`);
  return { ok: true, extensions: (r.recordset || []).map(shape) };
}

async function setExtension(pool, user, courseId, assignmentId, studentId, body, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sid = posInt(studentId); if (!sid) return notFound("Student");
  const a = await loadAssignment(pool, courseId, assignmentId); if (!a) return notFound();
  const v = validateBody(body, a, now); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  if (!(await hasEnrolment(pool, courseId, sid))) return notFound("Student");
  const run = () => pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid).input("due", sql.DateTime2, v.dueAt).input("cut", sql.DateTime2, v.cutoffAt)
    .input("why", sql.NVarChar(500), v.reason).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_extensions SET due_at = @due, cutoff_at = @cut, reason = @why, granted_by_source = @src, granted_by = @uid, updated_at = @now WHERE assignment_id = @a AND course_id = @c AND student_id = @s;
      IF @@ROWCOUNT = 0 INSERT INTO lms_extensions (assignment_id, course_id, student_id, due_at, cutoff_at, reason, granted_by_source, granted_by) VALUES (@a, @c, @s, @due, @cut, @why, @src, @uid);`);
  try { await run(); } catch (e) { if (!isDup(e)) throw e; await run(); }
  await audit(pool, actor, "assignment.extension_granted", "lms_assignments", assignmentId, { courseId, studentId: sid, dueAt: v.dueAt.toISOString(), cutoffAt: v.cutoffAt ? v.cutoffAt.toISOString() : null });
  if (tenant) events.emit("lms.extension.granted", { tenant, courseId, assignmentId, studentId: sid });
  return { ok: true, extension: { studentId: sid, dueAt: v.dueAt.toISOString(), cutoffAt: v.cutoffAt ? v.cutoffAt.toISOString() : null, reason: v.reason } };
}

async function revokeExtension(pool, user, courseId, assignmentId, studentId) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sid = posInt(studentId); if (!sid) return notFound("Student");
  if (!(await loadAssignment(pool, courseId, assignmentId))) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`DELETE FROM lms_extensions OUTPUT DELETED.due_at WHERE assignment_id = @a AND course_id = @c AND student_id = @s`);
  if (!(r.recordset && r.recordset[0])) return notFound("Extension");
  await audit(pool, actor, "assignment.extension_revoked", "lms_assignments", assignmentId, { courseId, studentId: sid });
  return { ok: true, revoked: true };
}

module.exports = { MAX_LISTED, MAX_REASON, joinSql, EXT_COLS, withExtension, validateBody, listExtensions, setExtension, revokeExtension };
