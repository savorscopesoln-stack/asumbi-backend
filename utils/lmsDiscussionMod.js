/* =========================================================================
   LMS DISCUSSION MODERATION AND REPORTS  (L8.1b, D-096)  NO schema step: `lms_post_reports` and the `hidden_*` columns exist since step 034 (D-095).
   Routes (flag `lms_discussions` FIRST):
   - STAFF (`lms.course.manage` + course owner / co-teacher / admin), under /courses/:id/discussions:
       PUT  /threads/:threadId/moderation {pinned?, locked?, hidden?, reason?}      PUT /posts/:postId/moderation {hidden, reason?}
       GET  /reports?status=open|resolved|all&page&pageSize                          POST /reports/:reportId/resolve {action:'dismiss'|'hide', reason?}
   - LEARNER (studentOnly + ACTIVE enrolment): POST /courses/:id/learn/discussions/posts/:postId/report {reason?}
   Rules:
   - Moderation needs a PUBLISHED course (archived = 409 COURSE_READ_ONLY, draft = 409 COURSE_NOT_PUBLISHED). Staff moderate staff-only forums too.
   - `reason` (plain text, <= 300) is only accepted together with hidden:true. Hiding sets hidden_at / hidden_by_source / hidden_by / hidden_reason; un-hiding clears all four.
     The opening post cannot be hidden alone (409 OPENING_POST): hide the thread. Hidden items stay invisible to other learners through the SQL predicates of D-095.
   - Every change is audited (`thread.moderated`, `post.moderated`, `report.resolved`) with ids and the changed flags only, never text.
   - A learner reports only a post they can SEE and did not write (409 OWN_POST). One report per (post, reporter): repeating = 200 {reported:true, already:true}.
     At most 20 new reports per learner per hour per course (409 REPORT_RATE_LIMIT). Archived course = 409 COURSE_READ_ONLY.
   - The staff queue groups reports by post; the reporter is NOT shown (Q69 default). Excerpt 300 chars. Resolving closes ALL open reports of that post in ONE statement;
     'hide' also hides the post, or the whole thread when it is the opening post.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const D = require("./lmsDiscussions");
const { courseStatus, readCtx, writeBlock, thVis, poVis, NAME_JOINS, authorOf, iso, q, paging, notFound, reject, isObj } = D._internal;
const { viewerOf, cleanText } = D;

const REASON_MAX = 300, REPORTS_PER_HOUR = 20, EXCERPT = 300, REASONS_PER_POST = 5, STATUSES = ["open", "resolved", "all"], DEFAULT_HIDE_REASON = "Hidden after a report";

/* Pure. Optional reason: plain text up to 300; empty -> null. */
function reasonOf(v, errors) {
  if (v === undefined || v === null) return null;
  const t = cleanText(v); if (t === null || t.length > REASON_MAX) { errors.push(`reason must be text up to ${REASON_MAX} characters.`); return null; }
  return t || null;
}
/* Pure. { ok, value:{pinned?,locked?,hidden?,reason?} } or { ok:false, errors } */
function validateThreadMod(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["pinned", "locked", "hidden", "reason"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const v = {}, errors = [];
  for (const k of ["pinned", "locked", "hidden"]) if (body[k] !== undefined) { if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`); else v[k] = body[k]; }
  if (body.reason !== undefined && body.reason !== null && v.hidden !== true) errors.push("reason can only be given together with hidden: true.");
  else { const r = reasonOf(body.reason, errors); if (r) v.reason = r; }
  if (!errors.length && !["pinned", "locked", "hidden"].some((k) => k in v)) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. { hidden:boolean (required), reason? } */
function validatePostMod(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["hidden", "reason"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], v = {};
  if (typeof body.hidden !== "boolean") errors.push("hidden must be true or false."); else v.hidden = body.hidden;
  if (body.reason !== undefined && body.reason !== null && body.hidden !== true) errors.push("reason can only be given together with hidden: true.");
  else { const r = reasonOf(body.reason, errors); if (r) v.reason = r; }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. A learner report: optional { reason }. undefined / null body = {}. */
function validateReport(body) {
  const b = body === undefined || body === null ? {} : body;
  if (!isObj(b)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(b).filter((k) => k !== "reason"); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], reason = reasonOf(b.reason, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { reason } };
}
/* Pure. { ok, value:{action, reason} } */
function validateResolve(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["action", "reason"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [];
  if (!["dismiss", "hide"].includes(body.action)) errors.push("action must be 'dismiss' or 'hide'.");
  if (body.reason !== undefined && body.reason !== null && body.action !== "hide") errors.push("reason can only be given together with action 'hide'.");
  const reason = reasonOf(body.reason, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { action: body.action, reason } };
}

/* Shared: staff viewer + published course. Returns { v, cid } or a result to send back. */
async function staffWriteCtx(pool, user, courseId, what) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(what);
  const s = await courseStatus(pool, cid); if (!s) return notFound(); const wb = writeBlock(s); if (wb) return wb;
  return { ok: true, v, cid };
}
const bit = (x) => (x === undefined ? null : x ? 1 : 0);

async function moderateThread(pool, user, courseId, threadId, body) {
  const tid = posInt(threadId); const val = validateThreadMod(body); if (!val.ok) return val;
  const c = await staffWriteCtx(pool, user, courseId, "Thread"); if (!c.ok) return c; if (!tid) return notFound("Thread");
  const { v, cid } = c, x = val.value;
  const r = await pool.request().input("c", sql.Int, cid).input("t", sql.Int, tid).input("pin", sql.Bit, bit(x.pinned)).input("lk", sql.Bit, bit(x.locked)).input("hid", sql.Bit, bit(x.hidden))
    .input("rs", sql.NVarChar(300), x.reason ?? null).input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id)
    .query(`UPDATE t SET pinned = COALESCE(@pin, t.pinned), locked = COALESCE(@lk, t.locked),
      hidden_at = CASE WHEN @hid = 1 THEN COALESCE(t.hidden_at, SYSUTCDATETIME()) WHEN @hid = 0 THEN NULL ELSE t.hidden_at END,
      hidden_by_source = CASE WHEN @hid = 1 THEN @src WHEN @hid = 0 THEN NULL ELSE t.hidden_by_source END,
      hidden_by = CASE WHEN @hid = 1 THEN @uid WHEN @hid = 0 THEN NULL ELSE t.hidden_by END,
      hidden_reason = CASE WHEN @hid = 1 THEN @rs WHEN @hid = 0 THEN NULL ELSE t.hidden_reason END,
      updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id, INSERTED.pinned, INSERTED.locked, INSERTED.hidden_at
      FROM lms_threads t JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL
      WHERE t.id = @t AND t.course_id = @c AND t.deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("Thread");
  const changed = {}; for (const k of ["pinned", "locked", "hidden"]) if (k in x) changed[k] = x[k];
  await audit(pool, v, "thread.moderated", "lms_threads", tid, { courseId: cid, changed, reasonGiven: !!x.reason });
  return { ok: true, thread: { id: row.id, pinned: !!row.pinned, locked: !!row.locked, hidden: !!row.hidden_at } };
}

async function moderatePost(pool, user, courseId, postId, body) {
  const pid = posInt(postId); const val = validatePostMod(body); if (!val.ok) return val;
  const c = await staffWriteCtx(pool, user, courseId, "Post"); if (!c.ok) return c; if (!pid) return notFound("Post");
  const { v, cid } = c, x = val.value;
  const f = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).query(`SELECT TOP 1 p.id, p.is_opening FROM lms_posts p
    JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id AND t.deleted_at IS NULL
    JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL
    WHERE p.id = @p AND p.course_id = @c AND p.deleted_at IS NULL`);
  const p = f.recordset && f.recordset[0]; if (!p) return notFound("Post");
  if (p.is_opening) return reject("OPENING_POST", "The opening post cannot be hidden on its own. Hide the thread instead.");
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("hid", sql.Bit, x.hidden ? 1 : 0).input("rs", sql.NVarChar(300), x.reason ?? null)
    .input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id)
    .query(`UPDATE lms_posts SET hidden_at = CASE WHEN @hid = 1 THEN COALESCE(hidden_at, SYSUTCDATETIME()) ELSE NULL END,
      hidden_by_source = CASE WHEN @hid = 1 THEN @src ELSE NULL END, hidden_by = CASE WHEN @hid = 1 THEN @uid ELSE NULL END, hidden_reason = CASE WHEN @hid = 1 THEN @rs ELSE NULL END
      OUTPUT INSERTED.id WHERE id = @p AND course_id = @c AND deleted_at IS NULL AND is_opening = 0`);
  if (!(r.recordset && r.recordset[0])) return notFound("Post");
  await audit(pool, v, "post.moderated", "lms_posts", pid, { courseId: cid, changed: { hidden: x.hidden }, reasonGiven: !!x.reason });
  return { ok: true, post: { id: pid, hidden: !!x.hidden } };
}

const isDup = (e) => !!e && (e.number === 2601 || e.number === 2627);
async function reportPost(pool, user, courseId, postId, body) {
  const v = viewerOf(user, false), cid = posInt(courseId), pid = posInt(postId); if (!v || !cid || !pid) return notFound("Post");
  const val = validateReport(body); if (!val.ok) return val;
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const f = await q(pool, v, cid).input("p", sql.Int, pid).query(`SELECT TOP 1 p.id, p.author_source, p.author_id FROM lms_posts p
    JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id AND ${thVis(false)}
    JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL AND f.staff_only = 0${D.groupVis("f")}
    WHERE p.id = @p AND p.course_id = @c AND ${poVis(false)}`);
  const p = f.recordset && f.recordset[0]; if (!p) return notFound("Post");
  if (p.author_source === v.source && Number(p.author_id) === v.id) return reject("OWN_POST", "You cannot report your own post.");
  const exists = async () => { const e = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("src", sql.NVarChar(20), v.source).input("vid", sql.Int, v.id)
    .query(`SELECT TOP 1 id FROM lms_post_reports WHERE post_id = @p AND course_id = @c AND reporter_source = @src AND reporter_id = @vid`); return !!(e.recordset && e.recordset[0]); };
  let row;
  try {
    const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("src", sql.NVarChar(20), v.source).input("vid", sql.Int, v.id).input("rs", sql.NVarChar(300), val.value.reason).input("lim", sql.Int, REPORTS_PER_HOUR)
      .query(`INSERT INTO lms_post_reports (post_id, course_id, reporter_source, reporter_id, reason) OUTPUT INSERTED.id
        SELECT @p, @c, @src, @vid, @rs
        WHERE NOT EXISTS (SELECT 1 FROM lms_post_reports WITH (UPDLOCK, HOLDLOCK) WHERE post_id = @p AND reporter_source = @src AND reporter_id = @vid)
        AND (SELECT COUNT(*) FROM lms_post_reports WHERE course_id = @c AND reporter_source = @src AND reporter_id = @vid AND created_at > DATEADD(HOUR, -1, SYSUTCDATETIME())) < @lim`);
    row = r.recordset && r.recordset[0];
  } catch (e) { if (isDup(e)) return { ok: true, reported: true, already: true }; throw e; }
  if (row) return { ok: true, reported: true };
  if (await exists()) return { ok: true, reported: true, already: true };
  return reject("REPORT_RATE_LIMIT", "You are reporting too fast. Please wait a little and try again.");
}

const statusSql = (st) => (st === "open" ? "AND r.resolved_at IS NULL" : st === "resolved" ? "AND r.resolved_at IS NOT NULL" : "");
const REPORT_FROM = `FROM lms_post_reports r
    JOIN lms_posts p ON p.id = r.post_id AND p.course_id = r.course_id AND p.deleted_at IS NULL
    JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id AND t.deleted_at IS NULL
    JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id AND f.deleted_at IS NULL`;
async function listReports(pool, user, courseId, query) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound();
  const st = query && query.status !== undefined ? String(query.status) : "open"; if (!STATUSES.includes(st)) return { ok: false, errors: ["status must be open, resolved or all."] };
  const s = await courseStatus(pool, cid); if (!s) return notFound();
  const pg = paging(query), sc = statusSql(st), rq = () => pool.request().input("c", sql.Int, cid);
  const tot = await rq().query(`SELECT COUNT(DISTINCT r.post_id) AS n ${REPORT_FROM} WHERE r.course_id = @c ${sc}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT p.id AS post_id, p.thread_id, p.forum_id, p.is_opening, p.hidden_at, p.author_source, p.author_id,
      MAX(LEFT(p.body, ${EXCERPT})) AS excerpt, MAX(t.title) AS thread_title, MAX(COALESCE(st.name, te.name, us.name)) AS author_name,
      COUNT(*) AS report_count, SUM(CASE WHEN r.resolved_at IS NULL THEN 1 ELSE 0 END) AS open_count, MIN(r.created_at) AS first_at, MAX(r.created_at) AS last_at
    ${REPORT_FROM} ${NAME_JOINS("p")}
    WHERE r.course_id = @c ${sc}
    GROUP BY p.id, p.thread_id, p.forum_id, p.is_opening, p.hidden_at, p.author_source, p.author_id
    ORDER BY MAX(r.created_at) DESC, p.id DESC OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const rows = r.recordset || [], reasons = {};
  if (rows.length) {
    const rr = await rq().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(rows.map((x) => x.post_id))).query(`SELECT r.post_id, r.reason FROM lms_post_reports r
      WHERE r.course_id = @c AND r.reason IS NOT NULL ${sc} AND r.post_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) ORDER BY r.created_at, r.id`);
    for (const x of rr.recordset || []) { const a = (reasons[x.post_id] = reasons[x.post_id] || []); if (a.length < REASONS_PER_POST) a.push(String(x.reason).slice(0, REASON_MAX)); }
  }
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const items = rows.map((x) => ({ postId: x.post_id, threadId: x.thread_id, forumId: x.forum_id, threadTitle: x.thread_title, isOpening: !!x.is_opening, hidden: !!x.hidden_at, excerpt: String(x.excerpt || "").slice(0, EXCERPT),
    author: authorOf(x), reportCount: Number(x.report_count) || 0, openCount: Number(x.open_count) || 0, firstReportedAt: iso(x.first_at), lastReportedAt: iso(x.last_at), reasons: reasons[x.post_id] || [] }));
  return { ok: true, status: st, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

async function resolveReport(pool, user, courseId, reportId, body) {
  const rid = posInt(reportId); const val = validateResolve(body); if (!val.ok) return val;
  const c = await staffWriteCtx(pool, user, courseId, "Report"); if (!c.ok) return c; if (!rid) return notFound("Report");
  const { v, cid } = c, { action, reason } = val.value;
  const f = await pool.request().input("c", sql.Int, cid).input("r", sql.Int, rid).query(`SELECT TOP 1 r.id, r.post_id, r.resolved_at, p.is_opening, p.thread_id
    ${REPORT_FROM} WHERE r.id = @r AND r.course_id = @c`);
  const rep = f.recordset && f.recordset[0]; if (!rep) return notFound("Report");
  if (rep.resolved_at) return reject("ALREADY_RESOLVED", "This report has already been resolved.");
  const hide = action === "hide", opening = !!rep.is_opening;
  const hideSql = !hide ? "" : opening
    ? `IF @n > 0 UPDATE lms_threads SET hidden_at = COALESCE(hidden_at, SYSUTCDATETIME()), hidden_by_source = @src, hidden_by = @vid, hidden_reason = @rs, updated_at = SYSUTCDATETIME() WHERE id = @th AND course_id = @c AND deleted_at IS NULL;`
    : `IF @n > 0 UPDATE lms_posts SET hidden_at = COALESCE(hidden_at, SYSUTCDATETIME()), hidden_by_source = @src, hidden_by = @vid, hidden_reason = @rs WHERE id = @p AND course_id = @c AND deleted_at IS NULL AND is_opening = 0;`;
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, rep.post_id).input("th", sql.Int, rep.thread_id).input("src", sql.NVarChar(20), v.source).input("vid", sql.Int, v.id)
    .input("act", sql.NVarChar(20), action).input("rs", sql.NVarChar(300), reason || DEFAULT_HIDE_REASON)
    .query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @n INT;
      UPDATE lms_post_reports SET resolved_at = SYSUTCDATETIME(), resolved_by_source = @src, resolved_by = @vid, resolution = @act WHERE post_id = @p AND course_id = @c AND resolved_at IS NULL;
      SET @n = @@ROWCOUNT;
      ${hideSql}
      COMMIT; SELECT @n AS n;`);
  const n = Number(r.recordset && r.recordset[0] && r.recordset[0].n) || 0;
  if (!n) return reject("ALREADY_RESOLVED", "This report has already been resolved.");
  await audit(pool, v, "report.resolved", "lms_post_reports", rid, { courseId: cid, postId: rep.post_id, action, resolved: n, target: hide ? (opening ? "thread" : "post") : null });
  return { ok: true, action, resolved: n, hidden: hide ? (opening ? "thread" : "post") : null };
}

module.exports = { REPORTS_PER_HOUR, validateThreadMod, validatePostMod, validateReport, validateResolve, moderateThread, moderatePost, reportPost, listReports, resolveReport };
