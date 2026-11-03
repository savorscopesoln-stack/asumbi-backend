/* =========================================================================
   LMS COURSE DISCUSSIONS  (L8.1a, D-095)  schema step 034 `lms_forums`, `lms_threads`, `lms_posts` (+ `lms_post_reports`, used by L8.1b).
   Routes (flag `lms_discussions` FIRST): staff under /courses/:id/discussions (any course owner / co-teacher / admin; forum management needs `lms.course.manage`),
   learners under /courses/:id/learn/discussions (studentOnly + ACTIVE enrolment). The viewer (staff or learner) is decided by the ROUTE, never by the client.

   Rules:
   - One default forum per course ("General discussion", made on the first list, idempotent) + up to 20 live forums. A forum can be STAFF ONLY (learners get 404) and
     LOCKED (learners cannot start threads or reply; staff still can). The default forum cannot be staff only or removed.
   - Learners read in a PUBLISHED or ARCHIVED course and write only in a PUBLISHED one (archived = read only, 409 COURSE_READ_ONLY). Staff write in published courses.
   - Plain text only: < > and control characters are stripped, line breaks kept. Thread title 1-200, post 1-5000 characters.
   - A thread = a title + an OPENING post + flat replies (no nesting). Lists and thread pages are paginated (pageSize <= 50).
   - Visibility (used by every read): a HIDDEN thread or post never reaches another learner (not even in a count or in "last activity"); its author still sees it, marked
     `hidden: true`; staff see everything with the reason. Hiding, locking, pinning and reports are L8.1b (utils/lmsDiscussionMod.js). Staff also see `reportCount` (open reports) per post / per thread.
   - An author may edit their OWN post for 15 minutes (server clock), unless it is hidden or its thread/forum is locked (learners). Nobody edits someone else's post.
   - Learners may post at most 30 times per hour per course (threads count); staff are not limited. A learner's text goes through the word-filter hook (utils/lmsWordFilter).
   - Other learners are shown as "First L." (like certificates); staff by full name. Never an admission number.
   - GROUP FORUMS (L8.2b, D-099): a forum may belong to ONE group of this course (`groupId`, fixed at creation, never the default forum, never staff only). A learner sees and
     writes in it ONLY while they are a live member of that live group (`groupVis`, checked in SQL everywhere a learner reaches a forum); staff see every group forum.
     Removing a learner from the group, or deleting the group, hides the forum from them at once (rows stay). Deleting a group does not delete its forum.
   Event `lms.discussion.posted` {tenant, courseId, threadId, postId} (ids only). Forum management is audited; ordinary posts are not.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { holderName } = require("./lmsCertificates");
const wordFilter = require("./lmsWordFilter");
const events = require("./lmsEvents");

const MAX_FORUMS = 20, MAX_PAGE = 50, EDIT_MINUTES = 15, LEARNER_POSTS_PER_HOUR = 30, TITLE_MAX = 200, BODY_MAX = 5000, DEFAULT_TITLE = "General discussion";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const notFound = (what = "Course") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const reject = (code, msg) => ({ ok: false, code, errors: [msg] });
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/* Pure. Plain text: control characters (except \n and \t) and < > removed, CRLF -> LF, trimmed. Not a string -> null. */
function cleanText(v) {
  if (typeof v !== "string") return null;
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim();
}
const paging = (q = {}) => { const p = Math.max(1, parseInt(q.page, 10) || 1), s = Math.min(MAX_PAGE, Math.max(1, parseInt(q.pageSize, 10) || 20)); return { page: p, pageSize: s, offset: (p - 1) * s }; };

/* Pure. { ok, value } or { ok:false, errors }. */
function validateForum(body, edit = false) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["title", "description", "staffOnly", "locked", "groupId"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  if (edit && body.groupId !== undefined) return { ok: false, errors: ["The group of a forum cannot be changed. Create a new forum for another group."] };
  const v = {}, errors = [];
  if (!edit || body.title !== undefined) { const t = cleanText(body.title); if (!t || t.length > 100) errors.push("title is required (1-100 characters)."); else v.title = t.replace(/\s+/g, " "); }
  if (body.description !== undefined) { if (body.description === null) v.description = null; else { const d = cleanText(body.description); if (d === null || d.length > 300) errors.push("description must be text up to 300 characters."); else v.description = d || null; } }
  for (const k of ["staffOnly", "locked"]) if (body[k] !== undefined) { if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`); else v[k] = body[k]; }
  if (body.groupId !== undefined && body.groupId !== null) { if (!Number.isInteger(body.groupId) || body.groupId < 1 || body.groupId > 2147483647) errors.push("groupId must be a whole number or null."); else { v.groupId = body.groupId; if (body.staffOnly === true) errors.push("A group forum cannot also be staff only."); } }
  if (edit && !Object.keys(v).length && !errors.length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. A thread (title + body) or a reply (body only). */
function validatePost(body, withTitle) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const allowed = withTitle ? ["title", "body"] : ["body"]; const extra = Object.keys(body).filter((k) => !allowed.includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const v = {}, errors = [];
  if (withTitle) { const t = cleanText(body.title); if (!t || t.replace(/\s+/g, " ").length > TITLE_MAX) errors.push(`title is required (1-${TITLE_MAX} characters).`); else v.title = t.replace(/\s+/g, " "); }
  const b = cleanText(body.body); if (!b || b.length > BODY_MAX) errors.push(`body is required (1-${BODY_MAX} characters).`); else v.body = b;
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

/* The viewer. `staff` comes from the ROUTE. A learner must be a Students actor with role student; staff must NOT be a student. */
function viewerOf(user, staff) {
  const a = actorOf(user); if (!a) return null;
  if (staff) return a.role === "student" ? null : { ...a, staff: true };
  return a.source === "Students" && a.role === "student" ? { ...a, staff: false } : null;
}
const thVis = (staff) => (staff ? "t.deleted_at IS NULL" : "t.deleted_at IS NULL AND (t.hidden_at IS NULL OR (t.author_source = N'Students' AND t.author_id = @vid))");
const poVis = (staff, a = "p") => (staff ? `${a}.deleted_at IS NULL` : `${a}.deleted_at IS NULL AND (${a}.hidden_at IS NULL OR (${a}.author_source = N'Students' AND ${a}.author_id = @vid))`);
const NAME_JOINS = (a) => `LEFT JOIN Students st ON ${a}.author_source = N'Students' AND st.id = ${a}.author_id
    LEFT JOIN Teachers te ON ${a}.author_source = N'Teachers' AND te.id = ${a}.author_id
    LEFT JOIN users us ON ${a}.author_source = N'Users' AND us.id = ${a}.author_id`;
const authorOf = (r) => ({ name: r.author_source === "Students" ? holderName(r.author_name) : (r.author_name ? String(r.author_name).slice(0, 80) : null), isStaff: r.author_source !== "Students" });
const q = (pool, v, cid) => pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id);

async function courseStatus(pool, cid) { const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`); return r.recordset && r.recordset[0] ? r.recordset[0].status : null; }
/* Read access: learners only see published/archived courses; staff any live course. Returns { status } or a notFound result. */
async function readCtx(pool, v, cid) { const s = await courseStatus(pool, cid); if (!s) return notFound(); if (!v.staff && !["published", "archived"].includes(s)) return notFound(); return { ok: true, status: s }; }
const writeBlock = (s) => (s === "published" ? null : s === "archived" ? reject("COURSE_READ_ONLY", "This course is archived. Discussions are read only.") : reject("COURSE_NOT_PUBLISHED", "Publish the course before posting."));

async function ensureDefaultForum(pool, cid) {
  try {
    await pool.request().input("c", sql.Int, cid).input("t", sql.NVarChar(100), DEFAULT_TITLE).query(`INSERT INTO lms_forums (course_id, title, is_default, created_by_source)
      SELECT @c, @t, 1, N'system' WHERE NOT EXISTS (SELECT 1 FROM lms_forums WITH (UPDLOCK, HOLDLOCK) WHERE course_id = @c AND is_default = 1 AND deleted_at IS NULL)`);
  } catch (e) { /* a parallel call made it first (unique index): fine */ }
}
/* SQL fragment (learners only): this forum is not a group forum, or the learner (@vid) is a live member of its live group. `a` = the forum's table name or alias. */
const groupVis = (a) => ` AND (${a}.group_id IS NULL OR EXISTS (SELECT 1 FROM lms_group_members gm JOIN lms_groups gg ON gg.id = gm.group_id AND gg.course_id = gm.course_id AND gg.deleted_at IS NULL
    WHERE gm.group_id = ${a}.group_id AND gm.course_id = ${a}.course_id AND gm.student_id = @vid AND gm.removed_at IS NULL))`;
async function loadForum(pool, v, cid, fid) {
  const r = await pool.request().input("c", sql.Int, cid).input("f", sql.Int, fid).input("vid", sql.Int, v.id).query(`SELECT TOP 1 id, title, description, staff_only, locked, is_default, group_id FROM lms_forums WHERE id = @f AND course_id = @c AND deleted_at IS NULL${v.staff ? "" : ` AND staff_only = 0${groupVis("lms_forums")}`}`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
const forumShape = (r, staff) => ({ id: r.id, title: r.title, description: r.description || null, locked: !!r.locked, isDefault: !!r.is_default, ...(staff ? { staffOnly: !!r.staff_only, groupId: r.group_id ?? null } : {}), threadCount: Number(r.thread_count) || 0 });

async function listForums(pool, user, courseId, staff) {
  const v = viewerOf(user, staff), cid = posInt(courseId); if (!v || !cid) return notFound(); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx;
  await ensureDefaultForum(pool, cid);
  const r = await q(pool, v, cid).query(`SELECT TOP ${MAX_FORUMS} f.id, f.title, f.description, f.staff_only, f.locked, f.is_default, f.group_id,
      (SELECT COUNT(*) FROM lms_threads t WHERE t.forum_id = f.id AND t.course_id = f.course_id AND ${thVis(v.staff)}) AS thread_count
    FROM lms_forums f WHERE f.course_id = @c AND f.deleted_at IS NULL${v.staff ? "" : ` AND f.staff_only = 0${groupVis("f")}`} ORDER BY f.is_default DESC, f.id`);
  return { ok: true, items: (r.recordset || []).map((x) => forumShape(x, v.staff)) };
}

async function createForum(pool, user, courseId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const val = validateForum(body); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const x = val.value;
  if (x.groupId) { const g = await pool.request().input("c", sql.Int, cid).input("g", sql.Int, x.groupId).query(`SELECT TOP 1 id FROM lms_groups WHERE id = @g AND course_id = @c AND deleted_at IS NULL`); if (!(g.recordset && g.recordset[0])) return notFound("Group"); }
  const r = await pool.request().input("c", sql.Int, cid).input("t", sql.NVarChar(100), x.title).input("d", sql.NVarChar(300), x.description ?? null).input("so", sql.Bit, x.staffOnly ? 1 : 0).input("lk", sql.Bit, x.locked ? 1 : 0).input("gid", sql.Int, x.groupId ?? null)
    .input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id).input("max", sql.Int, MAX_FORUMS)
    .query(`INSERT INTO lms_forums (course_id, title, description, staff_only, locked, group_id, created_by_source, created_by) OUTPUT INSERTED.id
      SELECT @c, @t, @d, @so, @lk, @gid, @src, @uid WHERE (SELECT COUNT(*) FROM lms_forums WHERE course_id = @c AND deleted_at IS NULL) < @max`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("FORUM_LIMIT", `A course can have at most ${MAX_FORUMS} forums.`);
  await audit(pool, v, "forum.created", "lms_forums", id, { courseId: cid, staffOnly: !!x.staffOnly, groupId: x.groupId ?? null });
  return { ok: true, forum: { id, title: x.title, description: x.description ?? null, locked: !!x.locked, isDefault: false, staffOnly: !!x.staffOnly, groupId: x.groupId ?? null, threadCount: 0 } };
}
async function updateForum(pool, user, courseId, forumId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId), fid = posInt(forumId); if (!v || !cid || !fid) return notFound("Forum"); const val = validateForum(body, true); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const x = val.value, f = await loadForum(pool, v, cid, fid); if (!f) return notFound("Forum");
  if (x.staffOnly === true && f.is_default) return reject("DEFAULT_FORUM", "The default forum is for everyone and cannot be staff only.");
  if (x.staffOnly === true && f.group_id) return reject("GROUP_FORUM", "A group forum cannot also be staff only."); 
  const sets = [], rq = pool.request().input("c", sql.Int, cid).input("f", sql.Int, fid);
  if (x.title !== undefined) { sets.push("title = @t"); rq.input("t", sql.NVarChar(100), x.title); }
  if (x.description !== undefined) { sets.push("description = @d"); rq.input("d", sql.NVarChar(300), x.description); }
  if (x.staffOnly !== undefined) { sets.push("staff_only = @so"); rq.input("so", sql.Bit, x.staffOnly ? 1 : 0); }
  if (x.locked !== undefined) { sets.push("locked = @lk"); rq.input("lk", sql.Bit, x.locked ? 1 : 0); }
  const r = await rq.query(`UPDATE lms_forums SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @f AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Forum");
  await audit(pool, v, "forum.updated", "lms_forums", fid, { courseId: cid, fields: Object.keys(x) });
  return { ok: true };
}
async function removeForum(pool, user, courseId, forumId) {
  const v = viewerOf(user, true), cid = posInt(courseId), fid = posInt(forumId); if (!v || !cid || !fid) return notFound("Forum");
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const f = await loadForum(pool, v, cid, fid); if (!f) return notFound("Forum"); if (f.is_default) return reject("DEFAULT_FORUM", "The default forum cannot be removed.");
  const r = await pool.request().input("c", sql.Int, cid).input("f", sql.Int, fid).query(`UPDATE lms_forums SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @f AND course_id = @c AND deleted_at IS NULL AND is_default = 0`);
  if (!(r.recordset && r.recordset[0])) return notFound("Forum");
  await audit(pool, v, "forum.removed", "lms_forums", fid, { courseId: cid });
  return { ok: true, removed: true };
}

async function listThreads(pool, user, courseId, forumId, query, staff) {
  const v = viewerOf(user, staff), cid = posInt(courseId), fid = posInt(forumId); if (!v || !cid || !fid) return notFound("Forum"); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx;
  const f = await loadForum(pool, v, cid, fid); if (!f) return notFound("Forum");
  const pg = paging(query), rq = () => q(pool, v, cid).input("f", sql.Int, fid);
  const tot = await rq().query(`SELECT COUNT(*) AS n FROM lms_threads t WHERE t.forum_id = @f AND t.course_id = @c AND ${thVis(v.staff)}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT t.id, t.title, t.pinned, t.locked, t.hidden_at, t.author_source, t.author_id, t.created_at, COALESCE(st.name, te.name, us.name) AS author_name,
      (SELECT COUNT(*) FROM lms_posts p WHERE p.thread_id = t.id AND p.is_opening = 0 AND ${poVis(v.staff)}) AS reply_count,
      (SELECT MAX(p.created_at) FROM lms_posts p WHERE p.thread_id = t.id AND ${poVis(v.staff)}) AS last_post_at${v.staff ? ", (SELECT COUNT(*) FROM lms_post_reports rp JOIN lms_posts pp ON pp.id = rp.post_id AND pp.course_id = rp.course_id AND pp.deleted_at IS NULL WHERE pp.thread_id = t.id AND rp.course_id = @c AND rp.resolved_at IS NULL) AS report_count" : ""}
    FROM lms_threads t ${NAME_JOINS("t")}
    WHERE t.forum_id = @f AND t.course_id = @c AND ${thVis(v.staff)}
    ORDER BY t.pinned DESC, last_post_at DESC, t.id DESC OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const items = (r.recordset || []).map((x) => ({ id: x.id, title: x.title, pinned: !!x.pinned, locked: !!x.locked, ...(x.hidden_at ? { hidden: true } : {}), ...(v.staff ? { reportCount: Number(x.report_count) || 0 } : {}), author: authorOf(x), replyCount: Number(x.reply_count) || 0, lastPostAt: iso(x.last_post_at || x.created_at), createdAt: iso(x.created_at) }));
  return { ok: true, forum: { id: f.id, title: f.title, locked: !!f.locked }, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

async function loadThread(pool, v, cid, tid) {
  const r = await q(pool, v, cid).input("t", sql.Int, tid).query(`SELECT TOP 1 t.id, t.forum_id, t.title, t.pinned, t.locked, t.hidden_at, t.hidden_reason, t.author_source, t.author_id, t.created_at,
      f.locked AS forum_locked, f.title AS forum_title, COALESCE(st.name, te.name, us.name) AS author_name
    FROM lms_threads t JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL${v.staff ? "" : ` AND f.staff_only = 0${groupVis("f")}`} ${NAME_JOINS("t")}
    WHERE t.id = @t AND t.course_id = @c AND ${thVis(v.staff)}`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
const postShape = (x, v, locked, now) => {
  const mine = x.author_source === v.source && Number(x.author_id) === v.id, hidden = !!x.hidden_at;
  const young = x.created_at && now - new Date(x.created_at).getTime() <= EDIT_MINUTES * 60000;
  return { id: x.id, body: x.body, isOpening: !!x.is_opening, author: authorOf(x), mine, ...(hidden ? { hidden: true } : {}), ...(hidden && v.staff && x.hidden_reason ? { hiddenReason: x.hidden_reason } : {}),
    ...(v.staff ? { reportCount: Number(x.report_count) || 0 } : {}), editedAt: iso(x.edited_at), createdAt: iso(x.created_at), canEdit: !!(mine && !hidden && young && !(locked && !v.staff)) };
};
async function getThread(pool, user, courseId, threadId, query, staff) {
  const v = viewerOf(user, staff), cid = posInt(courseId), tid = posInt(threadId); if (!v || !cid || !tid) return notFound("Thread"); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx;
  const t = await loadThread(pool, v, cid, tid); if (!t) return notFound("Thread");
  const pg = paging({ page: query && query.page, pageSize: (query && query.pageSize) || 30 }), rq = () => q(pool, v, cid).input("t", sql.Int, tid);
  const tot = await rq().query(`SELECT COUNT(*) AS n FROM lms_posts p WHERE p.thread_id = @t AND p.course_id = @c AND ${poVis(v.staff)}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT p.id, p.body, p.is_opening, p.author_source, p.author_id, p.hidden_at, p.hidden_reason, p.edited_at, p.created_at, COALESCE(st.name, te.name, us.name) AS author_name${v.staff ? ", (SELECT COUNT(*) FROM lms_post_reports rp WHERE rp.post_id = p.id AND rp.course_id = p.course_id AND rp.resolved_at IS NULL) AS report_count" : ""}
    FROM lms_posts p ${NAME_JOINS("p")} WHERE p.thread_id = @t AND p.course_id = @c AND ${poVis(v.staff)} ORDER BY p.created_at, p.id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const locked = !!(t.locked || t.forum_locked), now = Date.now(), total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const posts = (r.recordset || []).map((x) => postShape(x, v, locked, now));
  return { ok: true, thread: { id: t.id, forumId: t.forum_id, forumTitle: t.forum_title, title: t.title, pinned: !!t.pinned, locked, author: authorOf(t), ...(t.hidden_at ? { hidden: true } : {}), ...(t.hidden_at && v.staff && t.hidden_reason ? { hiddenReason: t.hidden_reason } : {}), createdAt: iso(t.created_at) },
    posts, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + posts.length < total, canReply: !(locked && !v.staff) && ctx.status === "published" };
}

const RATE_MSG = "You are posting too fast. Please wait a little and try again.";
const rateLimit = (v) => (v.staff ? 100000 : LEARNER_POSTS_PER_HOUR);
const RATE_SQL = `(SELECT COUNT(*) FROM lms_posts r WHERE r.course_id = @c AND r.author_source = @src AND r.author_id = @vid AND r.created_at > DATEADD(HOUR, -1, SYSUTCDATETIME())) < @lim`;

async function createThread(pool, user, courseId, forumId, body, staff, ctx = {}) {
  const v = viewerOf(user, staff), cid = posInt(courseId), fid = posInt(forumId); if (!v || !cid || !fid) return notFound("Forum");
  const val = validatePost(body, true); if (!val.ok) return val;
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const f = await loadForum(pool, v, cid, fid); if (!f) return notFound("Forum"); if (f.locked && !v.staff) return reject("FORUM_LOCKED", "This forum is locked.");
  const x = val.value; if (!v.staff) { const w = wordFilter.check(`${x.title}\n${x.body}`, { courseId: cid, forumId: fid }); if (!w.ok) return { ok: false, errors: [w.message], code: "CONTENT_REJECTED" }; }
  const r = await pool.request().input("c", sql.Int, cid).input("f", sql.Int, fid).input("vid", sql.Int, v.id).input("src", sql.NVarChar(20), v.source).input("t", sql.NVarChar(200), x.title).input("b", sql.NVarChar(sql.MAX), x.body).input("lim", sql.Int, rateLimit(v))
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT, @tid INT, @pid INT;
      INSERT INTO lms_threads (forum_id, course_id, title, author_source, author_id)
        SELECT @f, @c, @t, @src, @vid WHERE ${RATE_SQL} AND EXISTS (SELECT 1 FROM lms_forums WHERE id = @f AND course_id = @c AND deleted_at IS NULL${v.staff ? "" : ` AND staff_only = 0 AND locked = 0${groupVis("lms_forums")}`});
      SET @n = @@ROWCOUNT;
      IF @n = 0 BEGIN ROLLBACK; SELECT CAST(NULL AS INT) AS threadId, CAST(NULL AS INT) AS postId; RETURN; END
      SET @tid = SCOPE_IDENTITY();
      INSERT INTO lms_posts (thread_id, forum_id, course_id, body, is_opening, author_source, author_id) VALUES (@tid, @f, @c, @b, 1, @src, @vid);
      SET @pid = SCOPE_IDENTITY();
      COMMIT; SELECT @tid AS threadId, @pid AS postId;`);
  const row = r.recordset && r.recordset[0]; if (!row || !row.threadId) return reject("POST_RATE_LIMIT", RATE_MSG);
  if (ctx.tenant) events.emit("lms.discussion.posted", { tenant: ctx.tenant, courseId: cid, threadId: row.threadId, postId: row.postId });
  return { ok: true, threadId: row.threadId, postId: row.postId };
}

async function createPost(pool, user, courseId, threadId, body, staff, ctx = {}) {
  const v = viewerOf(user, staff), cid = posInt(courseId), tid = posInt(threadId); if (!v || !cid || !tid) return notFound("Thread");
  const val = validatePost(body, false); if (!val.ok) return val;
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const t = await loadThread(pool, v, cid, tid); if (!t) return notFound("Thread"); if ((t.locked || t.forum_locked) && !v.staff) return reject("THREAD_LOCKED", "This discussion is locked.");
  const x = val.value; if (!v.staff) { const w = wordFilter.check(x.body, { courseId: cid, threadId: tid }); if (!w.ok) return { ok: false, errors: [w.message], code: "CONTENT_REJECTED" }; }
  const r = await pool.request().input("c", sql.Int, cid).input("t", sql.Int, tid).input("vid", sql.Int, v.id).input("src", sql.NVarChar(20), v.source).input("b", sql.NVarChar(sql.MAX), x.body).input("lim", sql.Int, rateLimit(v))
    .query(`INSERT INTO lms_posts (thread_id, forum_id, course_id, body, is_opening, author_source, author_id) OUTPUT INSERTED.id
      SELECT th.id, th.forum_id, th.course_id, @b, 0, @src, @vid FROM lms_threads th WHERE th.id = @t AND th.course_id = @c AND th.deleted_at IS NULL${v.staff ? "" : " AND th.locked = 0 AND th.hidden_at IS NULL"} AND ${RATE_SQL}`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("POST_RATE_LIMIT", RATE_MSG);
  if (ctx.tenant) events.emit("lms.discussion.posted", { tenant: ctx.tenant, courseId: cid, threadId: tid, postId: id });
  return { ok: true, postId: id };
}

/* Own post, 15 minutes. Staff routes may edit their own posts too; nobody edits another person's post. */
async function editPost(pool, user, courseId, postId, body, staff) {
  const v = viewerOf(user, staff), cid = posInt(courseId), pid = posInt(postId); if (!v || !cid || !pid) return notFound("Post");
  const val = validatePost(body, false); if (!val.ok) return val;
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const own = await q(pool, v, cid).input("p", sql.Int, pid).input("src", sql.NVarChar(20), v.source).query(`SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id AND t.deleted_at IS NULL
    JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL${v.staff ? "" : ` AND f.staff_only = 0${groupVis("f")}`} WHERE p.id = @p AND p.course_id = @c AND p.author_source = @src AND p.author_id = @vid AND ${poVis(v.staff)}`);
  if (!(own.recordset && own.recordset[0])) return notFound("Post");
  const x = val.value; if (!v.staff) { const w = wordFilter.check(x.body, { courseId: cid, postId: pid }); if (!w.ok) return { ok: false, errors: [w.message], code: "CONTENT_REJECTED" }; }
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("vid", sql.Int, v.id).input("src", sql.NVarChar(20), v.source).input("b", sql.NVarChar(sql.MAX), x.body).input("mins", sql.Int, EDIT_MINUTES)
    .query(`UPDATE p SET body = @b, edited_at = SYSUTCDATETIME() OUTPUT INSERTED.id FROM lms_posts p JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id JOIN lms_forums f ON f.id = t.forum_id
      WHERE p.id = @p AND p.course_id = @c AND p.author_source = @src AND p.author_id = @vid AND p.deleted_at IS NULL AND p.hidden_at IS NULL AND p.created_at >= DATEADD(MINUTE, -@mins, SYSUTCDATETIME())${v.staff ? "" : " AND t.locked = 0 AND f.locked = 0"}`);
  if (!(r.recordset && r.recordset[0])) return reject("EDIT_WINDOW_CLOSED", `A post can be edited for ${EDIT_MINUTES} minutes, and not once it is hidden or locked.`);
  return { ok: true, edited: true };
}

module.exports = { groupVis, MAX_FORUMS, EDIT_MINUTES, LEARNER_POSTS_PER_HOUR, cleanText, validateForum, validatePost, viewerOf, listForums, createForum, updateForum, removeForum, listThreads, getThread, createThread, createPost, editPost,
  /* for utils/lmsDiscussionMod.js (L8.1b); not a public API */
  _internal: { courseStatus, readCtx, writeBlock, thVis, poVis, NAME_JOINS, authorOf, iso, q, paging, notFound, reject, isObj } };
