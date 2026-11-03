/* =========================================================================
   LMS ANNOUNCEMENTS  (L4.4a)  course announcements and school-wide announcements.

   Rules (documented, simple):
   - A COURSE announcement belongs to one course. Course staff (owner / co-teacher / LMS admin, permission lms.course.manage)
     write, edit, unpublish and delete them. The course must not be archived or pending (same rule as other course edits).
   - A SCHOOL-WIDE announcement (course_id NULL) is written only by LMS administrators (lms.settings.manage).
   - status: draft (staff only) | published (students see it). published_at is set the FIRST time it is published and kept.
     `pinned` announcements sort first. Title 1-200 characters, body 1-4000 plain-text characters (no HTML, line breaks kept).
   - Students see: published announcements of a PUBLISHED (or archived, read-only) course they are ACTIVELY enrolled in, plus
     published school-wide ones. Drafts, deleted rows and other courses never reach them.
   - Max 500 live announcements per course and 500 school-wide. Delete = soft delete.
   - Publishing emits `lms.announcement.published` ({tenant, courseId|null, announcementId}); a later notification unit (L4.4b)
     subscribes to it. No notification is sent here.
   Authorisation lives in the routes; every query is parameterised and every course query also matches course_id.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const lessons = require("./lmsLessons");
const events = require("./lmsEvents");

const MAX_PER_SCOPE = 500, STATUSES = ["draft", "published"];
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
const COLS = "id, course_id, title, body, status, pinned, published_at, created_at, updated_at";
const shape = (r) => ({ id: r.id, courseId: r.course_id ?? null, title: r.title, body: r.body, status: r.status, pinned: !!r.pinned, publishedAt: r.published_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });

function validate(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!["title", "body", "pinned", "status"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if (!partial || "body" in body) { const b = multiLine(body.body); if (b.length < 1 || b.length > 4000) errors.push("body is required: 1-4000 characters of plain text."); else value.body = b; }
  if ("pinned" in body) { if (typeof body.pinned !== "boolean") errors.push("pinned must be true or false."); else value.pinned = body.pinned; }
  if ("status" in body) { if (!STATUSES.includes(body.status)) errors.push('status must be "draft" or "published".'); else value.status = body.status; }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Send at least one field to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* scope: a course id, or null for school-wide. Returns the WHERE text and binds the parameter. */
const scopeOf = (req, courseId) => { if (courseId === null) return "course_id IS NULL"; req.input("c", sql.Int, courseId); return "course_id = @c"; };

/* ------------------------------ staff ------------------------------------ */
async function createAnnouncement(pool, user, courseId, body, tenant) {
  const v = validate(body); if (!v.ok) return { ok: false, errors: v.errors };
  if (courseId !== null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  const cnt = pool.request(); const n = await cnt.query(`SELECT COUNT(*) AS n FROM lms_announcements WHERE ${scopeOf(cnt, courseId)} AND deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= MAX_PER_SCOPE) return { ok: false, code: "ANNOUNCEMENT_LIMIT", errors: [`At most ${MAX_PER_SCOPE} announcements here. Delete old ones first.`] };
  const actor = actorOf(user), pub = v.value.status === "published";
  const r = await pool.request().input("c", sql.Int, courseId).input("t", sql.NVarChar(200), v.value.title).input("b", sql.NVarChar(4000), v.value.body).input("pin", sql.Bit, v.value.pinned === true ? 1 : 0)
    .input("st", sql.NVarChar(20), pub ? "published" : "draft").input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
    .query(`INSERT INTO lms_announcements (course_id, title, body, status, pinned, published_at, created_by_source, created_by)
            OUTPUT INSERTED.id, INSERTED.course_id, INSERTED.title, INSERTED.body, INSERTED.status, INSERTED.pinned, INSERTED.published_at, INSERTED.created_at, INSERTED.updated_at
            VALUES (@c, @t, @b, @st, @pin, CASE WHEN @st = 'published' THEN SYSUTCDATETIME() ELSE NULL END, @src, @uid)`);
  const row = r.recordset[0];
  await audit(pool, actor, "announcement.created", "lms_announcements", row.id, { courseId, status: row.status });
  if (pub && tenant) events.emit("lms.announcement.published", { tenant, courseId, announcementId: row.id });
  return { ok: true, announcement: shape(row) };
}

async function listForStaff(pool, courseId, opts = {}) {
  const { size, pg } = paging(opts), req = pool.request(), cond = scopeOf(req, courseId);
  req.input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const r = await req.query(`SELECT ${COLS}, COUNT(*) OVER() AS total_count FROM lms_announcements WHERE ${cond} AND deleted_at IS NULL
    ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map(shape), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

async function loadOne(pool, courseId, id) {
  const req = pool.request().input("id", sql.Int, id), cond = scopeOf(req, courseId);
  const r = await req.query(`SELECT TOP 1 ${COLS} FROM lms_announcements WHERE id = @id AND ${cond} AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
async function getOne(pool, courseId, id) {
  const row = await loadOne(pool, courseId, id);
  return row ? { ok: true, announcement: shape(row) } : { ok: false, notFound: true, errors: ["Announcement not found."] };
}

async function updateAnnouncement(pool, user, courseId, id, body, tenant) {
  const v = validate(body, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  if (courseId !== null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  const cur = await loadOne(pool, courseId, id); if (!cur) return { ok: false, notFound: true, errors: ["Announcement not found."] };
  const val = v.value, sets = [], req = pool.request().input("id", sql.Int, id), cond = scopeOf(req, courseId), changed = [];
  if ("title" in val && val.title !== cur.title) { sets.push("title = @t"); req.input("t", sql.NVarChar(200), val.title); changed.push("title"); }
  if ("body" in val && val.body !== cur.body) { sets.push("body = @b"); req.input("b", sql.NVarChar(4000), val.body); changed.push("body"); }
  if ("pinned" in val && val.pinned !== !!cur.pinned) { sets.push("pinned = @pin"); req.input("pin", sql.Bit, val.pinned ? 1 : 0); changed.push("pinned"); }
  const publishing = "status" in val && val.status === "published" && cur.status !== "published";
  if ("status" in val && val.status !== cur.status) { sets.push("status = @st"); req.input("st", sql.NVarChar(20), val.status); changed.push("status"); if (val.status === "published") sets.push("published_at = COALESCE(published_at, SYSUTCDATETIME())"); }
  if (!changed.length) return { ok: true, announcement: shape(cur), unchanged: true };
  const r = await req.query(`UPDATE lms_announcements SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME()
    OUTPUT INSERTED.id, INSERTED.course_id, INSERTED.title, INSERTED.body, INSERTED.status, INSERTED.pinned, INSERTED.published_at, INSERTED.created_at, INSERTED.updated_at
    WHERE id = @id AND ${cond} AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Announcement not found."] };
  await audit(pool, actorOf(user), "announcement.updated", "lms_announcements", id, { courseId, changed });
  if (publishing && tenant) events.emit("lms.announcement.published", { tenant, courseId, announcementId: id });
  return { ok: true, announcement: shape(row) };
}

async function deleteAnnouncement(pool, user, courseId, id) {
  if (courseId !== null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  const req = pool.request().input("id", sql.Int, id), cond = scopeOf(req, courseId);
  const r = await req.query(`UPDATE lms_announcements SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND ${cond} AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Announcement not found."] };
  await audit(pool, actorOf(user), "announcement.deleted", "lms_announcements", id, { courseId });
  return { ok: true };
}

/* ------------------------------ students --------------------------------- */
/* Route guarantees an ACTIVE enrolment for the course version. */
async function listForStudentCourse(pool, courseId, opts = {}) {
  if (!(await lessons.studentCourseOpen(pool, courseId))) return { ok: false, notFound: true, errors: ["Course not found."] };
  const { size, pg } = paging(opts);
  const r = await pool.request().input("c", sql.Int, courseId).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size)
    .query(`SELECT ${COLS}, COUNT(*) OVER() AS total_count FROM lms_announcements WHERE course_id = @c AND status = 'published' AND deleted_at IS NULL
            ORDER BY pinned DESC, published_at DESC, id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map(shape), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

/* Everything addressed to this student: school-wide + courses they are actively enrolled in. The student id comes from the token. */
async function listForStudentMe(pool, studentId, opts = {}) {
  const { size, pg } = paging(opts);
  const r = await pool.request().input("s", sql.Int, studentId).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size)
    .query(`SELECT a.id, a.course_id, a.title, a.body, a.status, a.pinned, a.published_at, a.created_at, a.updated_at, c.title AS course_title, COUNT(*) OVER() AS total_count
            FROM lms_announcements a LEFT JOIN lms_courses c ON c.id = a.course_id AND c.deleted_at IS NULL
            WHERE a.status = 'published' AND a.deleted_at IS NULL
              AND (a.course_id IS NULL OR (c.status IN ('published','archived') AND EXISTS (SELECT 1 FROM lms_course_enrolments e WHERE e.course_id = a.course_id AND e.student_id = @s AND e.status = 'active')))
            ORDER BY a.pinned DESC, a.published_at DESC, a.id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map((x) => ({ ...shape(x), courseTitle: x.course_title ?? null })), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

module.exports = { MAX_PER_SCOPE, validate, createAnnouncement, listForStaff, getOne, updateAnnouncement, deleteAnnouncement, listForStudentCourse, listForStudentMe };
