/* =========================================================================
   LMS COURSE APPROVAL  (L2.5)

   Used only when the tenant setting courseApprovalRequired is on.
     draft --submit--> pending --approve--> published
                          |--return (reason required)--> draft
                          |--withdraw (by the teacher)--> draft
   Every step is ONE atomic statement guarded by the expected current status
   (so two people acting at once cannot both succeed) and writes a row to
   lms_course_approvals in the same transaction. Authorisation is in the routes:
   submit/withdraw = course staff; approve/return = lms.course.approve (a reviewer
   who is not on the course, decision D-030). The person who submitted a course
   cannot approve it unless they are an LMS administrator (D-030).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const events = require("./lmsEvents");
const { actorOf } = require("./lmsPermissions");
const { escapeLike } = require("./lmsCourses");

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

function validateNote(body, { required = false, field = "reason" } = {}) {
  if (body == null) body = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const extra = Object.keys(body).filter((k) => k !== field); if (extra.length) return { ok: false, errors: [`Unknown field "${extra[0]}".`] };
  const t = body[field] == null ? "" : oneLine(body[field]);
  if (t.length > 500) return { ok: false, errors: [`${field} must be at most 500 characters.`] };
  if (required && t.length < 3) return { ok: false, errors: [`${field} is required: 3-500 characters.`] };
  return { ok: true, value: t || null };
}

/* Explains why a guarded move did not happen. */
async function whyNot(pool, courseId, want) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const st = r.recordset && r.recordset[0] ? r.recordset[0].status : null;
  if (!st) return { ok: false, notFound: true, errors: ["Course not found."] };
  const msg = want === "draft" ? "Only a draft course can be submitted for approval." : "This course is not waiting for approval.";
  return { ok: false, code: "BAD_TRANSITION", errors: [msg], status: st };
}

/* One guarded move + history row, atomically. extraSet e.g. "published_at = SYSUTCDATETIME()". */
async function move(pool, user, courseId, { from, to, action, reason = null, extraSet = "" }) {
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("from", sql.NVarChar(20), from).input("to", sql.NVarChar(20), to)
    .input("act", sql.NVarChar(20), action).input("reason", sql.NVarChar(500), reason).input("as", sql.NVarChar(20), actor.source).input("ai", sql.Int, actor.id)
    .query(`
      SET XACT_ABORT ON;
      DECLARE @t TABLE (id INT);
      BEGIN TRAN;
        UPDATE lms_courses SET status = @to, updated_at = SYSUTCDATETIME()${extraSet ? ", " + extraSet : ""}
        OUTPUT INSERTED.id INTO @t
        WHERE id = @c AND deleted_at IS NULL AND status = @from;
        INSERT INTO lms_course_approvals (course_id, action, reason, actor_source, actor_id) SELECT id, @act, @reason, @as, @ai FROM @t;
      COMMIT;
      SELECT id FROM @t;`);
  if (!(r.recordset && r.recordset.length)) return whyNot(pool, courseId, from);
  await audit(pool, actor, `course.approval.${action}`, "lms_courses", courseId, { from, to, hasReason: !!reason });
  return { ok: true };
}

async function submitForApproval(pool, user, courseId, { approvalRequired = false } = {}) {
  if (!approvalRequired) return { ok: false, code: "APPROVAL_NOT_REQUIRED", errors: ["This school does not require approval. Publish the course directly."] };
  return move(pool, user, courseId, { from: "draft", to: "pending", action: "submitted" });
}

async function withdrawSubmission(pool, user, courseId) {
  return move(pool, user, courseId, { from: "pending", to: "draft", action: "withdrawn" });
}

async function returnCourse(pool, user, courseId, body) {
  const v = validateNote(body, { required: true }); if (!v.ok) return v;
  return move(pool, user, courseId, { from: "pending", to: "draft", action: "returned", reason: v.value });
}

/* isAdmin = holds lms.settings.manage. Emits lms.course.published like a direct publish. */
async function approveCourse(pool, user, courseId, body, { isAdmin = false, tenant = null } = {}) {
  const v = validateNote(body, { field: "note" }); if (!v.ok) return v;
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  if (!isAdmin) {
    const s = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 actor_source, actor_id FROM lms_course_approvals WHERE course_id = @c AND action = 'submitted' ORDER BY id DESC`);
    const last = s.recordset && s.recordset[0];
    if (last && last.actor_source === actor.source && last.actor_id === actor.id) return { ok: false, forbidden: true, code: "SELF_APPROVAL", errors: ["You submitted this course, so someone else must approve it."] };
  }
  const r = await move(pool, user, courseId, { from: "pending", to: "published", action: "approved", reason: v.value, extraSet: "published_at = SYSUTCDATETIME(), archived_at = NULL" });
  if (r.ok && tenant) events.emit("lms.course.published", { tenant, courseId });
  return r;
}

/* Reviewer queue: pending courses, oldest submission first. Paginated, searchable. */
async function listPending(pool, { q = "", page = 1, pageSize = 20 } = {}) {
  const size = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20)), pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const req = pool.request(), where = ["c.deleted_at IS NULL", "c.status = 'pending'"], term = oneLine(q).slice(0, 100);
  if (term) { where.push("(c.title LIKE @q ESCAPE '\\' OR c.code LIKE @q ESCAPE '\\')"); req.input("q", sql.NVarChar(210), `%${escapeLike(term)}%`); }
  req.input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const r = await req.query(`
    SELECT c.id, c.code, c.title, c.academic_year, c.class_name, c.programme,
      (SELECT TOP 1 a.created_at FROM lms_course_approvals a WHERE a.course_id = c.id AND a.action = 'submitted' ORDER BY a.id DESC) AS submitted_at,
      COUNT(*) OVER() AS total_count
    FROM lms_courses c WHERE ${where.join(" AND ")}
    ORDER BY submitted_at ASC, c.id ASC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map((x) => ({ id: x.id, code: x.code, title: x.title, academicYear: x.academic_year, className: x.class_name || null, programme: x.programme || null, submittedAt: x.submitted_at || null })), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

/* Newest first, bounded. */
async function listHistory(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 50 id, action, reason, actor_source, actor_id, created_at FROM lms_course_approvals WHERE course_id = @c ORDER BY id DESC`);
  return (r.recordset || []).map((x) => ({ id: x.id, action: x.action, reason: x.reason || null, actorSource: x.actor_source, actorId: x.actor_id, createdAt: x.created_at }));
}

module.exports = { validateNote, submitForApproval, withdrawSubmission, returnCourse, approveCourse, listPending, listHistory };
