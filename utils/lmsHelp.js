/* =========================================================================
   LMS HELP REQUESTS + OFFICE HOURS  (L8.5, D-104)  schema step 039 `lms_help_requests`, `lms_office_hours`. Flag `lms_discussions` (the engagement flag, see D-104).
   Learner (studentOnly + ACTIVE enrolment, routes under /courses/:id/learn): ask the course staff ONE question, see own requests and the answers, withdraw an open request,
   read the office-hour lines. Staff (staffAccess + `lms.course.manage`, routes under /courses/:id): inbox, answer once (or mark answered without text), manage office-hour lines.
   Rules:
   - A request is plain text 1-1000 characters (< > and control characters stripped), optionally about ONE lesson OR ONE assignment of THIS course (checked in SQL, never both).
   - Write only in a PUBLISHED course (archived = read only 409 COURSE_READ_ONLY). A learner may have at most 3 OPEN requests per course and send at most 10 per 24 hours
     (both checked inside the INSERT, so parallel calls cannot beat the limit). The learner text goes through the word-filter hook (utils/lmsWordFilter).
   - A learner sees ONLY their own requests; another learner's request is 404. Staff see every request of the courses they belong to. Staff see the learner's name (never an admission number).
   - Answer = ONCE: one guarded UPDATE `WHERE status = 'open'`; a second answer is 409 ALREADY_ANSWERED and changes nothing. `reply` is optional (<= 2000 characters): no reply = "mark answered".
   - Withdraw = soft delete of the learner's OWN request while it is still open. An answered request cannot be withdrawn (it is the record of what the learner was told).
   - Office hours are text lines (1-200 characters, at most 10 per course, no booking engine). Any course staff read; `lms.course.manage` writes; learners read in published/archived courses.
   Event `lms.help.answered` {tenant, courseId, requestId} (ids only). Audit: help.answered, help.withdrawn, office_hours.added|removed (ids, never text).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const wordFilter = require("./lmsWordFilter");
const events = require("./lmsEvents");
const disc = require("./lmsDiscussions");
const { courseStatus, notFound, reject, iso, isObj } = disc._internal;
const { cleanText, viewerOf } = disc;

const BODY_MAX = 1000, REPLY_MAX = 2000, LINE_MAX = 200, MAX_LINES = 10, MAX_OPEN = 3, MAX_PER_DAY = 10, MAX_PAGE = 50;
const STATUSES = ["open", "answered", "all"];
const paging = (q = {}) => { const p = Math.max(1, parseInt(q.page, 10) || 1), s = Math.min(MAX_PAGE, Math.max(1, parseInt(q.pageSize, 10) || 20)); return { page: p, pageSize: s, offset: (p - 1) * s }; };
const idOrNull = (v) => (v === undefined || v === null ? null : (Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : false));

/* Pure. { ok, value:{ body, lessonId, assignmentId } } or { ok:false, errors }. */
function validateRequest(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["body", "lessonId", "assignmentId"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], b = cleanText(body.body);
  if (!b || b.length > BODY_MAX) errors.push(`body is required (1-${BODY_MAX} characters).`);
  const l = idOrNull(body.lessonId), a = idOrNull(body.assignmentId);
  if (l === false) errors.push("lessonId must be a whole number or null."); if (a === false) errors.push("assignmentId must be a whole number or null.");
  if (l && a) errors.push("Link a help request to a lesson OR an assignment, not both.");
  return errors.length ? { ok: false, errors } : { ok: true, value: { body: b, lessonId: l || null, assignmentId: a || null } };
}
/* Pure. { ok, value:{ reply|null } }. No reply = just mark answered. */
function validateReply(body) {
  if (body === undefined || body === null) return { ok: true, value: { reply: null } };
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => k !== "reply"); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  if (body.reply === undefined || body.reply === null) return { ok: true, value: { reply: null } };
  const r = cleanText(body.reply); if (r === null || r.length > REPLY_MAX) return { ok: false, errors: [`reply must be text up to ${REPLY_MAX} characters.`] };
  return { ok: true, value: { reply: r || null } };
}
/* Pure. { ok, value:{ line } }. */
function validateLine(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => k !== "line"); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const t = cleanText(body.line); const l = t ? t.replace(/\s+/g, " ") : t;
  return !l || l.length > LINE_MAX ? { ok: false, errors: [`line is required (1-${LINE_MAX} characters).`] } : { ok: true, value: { line: l } };
}

const writeBlock = (s) => (s === "published" ? null : s === "archived" ? reject("COURSE_READ_ONLY", "This course is archived. Help requests are read only.") : reject("COURSE_NOT_PUBLISHED", "The course is not published."));
async function readCtx(pool, v, cid) { const s = await courseStatus(pool, cid); if (!s) return notFound(); if (!v.staff && !["published", "archived"].includes(s)) return notFound(); return { ok: true, status: s }; }
const ANSWERER = `COALESCE(te.name, us.name)`; // staff display name (Teachers or Users); never an id
const ANSWER_JOINS = `LEFT JOIN Teachers te ON h.answered_by_source = N'Teachers' AND te.id = h.answered_by LEFT JOIN users us ON h.answered_by_source = N'Users' AND us.id = h.answered_by`;

/* ----------------------------- learner side ----------------------------- */
const learnerShape = (x) => ({ id: x.id, body: x.body, status: x.status, lessonId: x.lesson_id ?? null, assignmentId: x.assignment_id ?? null, createdAt: iso(x.created_at),
  ...(x.status === "answered" ? { reply: x.reply || null, answeredAt: iso(x.answered_at), answeredBy: x.answerer ? String(x.answerer).slice(0, 80) : null } : {}) });

async function listMine(pool, user, courseId, query) {
  const v = viewerOf(user, false), cid = posInt(courseId); if (!v || !cid) return notFound(); const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc;
  const pg = paging(query);
  const r = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).input("off", sql.Int, pg.offset).input("lim", sql.Int, pg.pageSize)
    .query(`SELECT h.id, h.body, h.status, h.lesson_id, h.assignment_id, h.reply, h.answered_at, h.created_at, ${ANSWERER} AS answerer, COUNT(*) OVER() AS total_count
      FROM lms_help_requests h ${ANSWER_JOINS}
      WHERE h.course_id = @c AND h.student_id = @vid AND h.deleted_at IS NULL ORDER BY h.id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map(learnerShape), total: rows.length ? Number(rows[0].total_count) : 0, page: pg.page, pageSize: pg.pageSize };
}

async function createRequest(pool, user, courseId, body, ctx = {}) {
  const v = viewerOf(user, false), cid = posInt(courseId); if (!v || !cid) return notFound(); const val = validateRequest(body); if (!val.ok) return val;
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const x = val.value, w = wordFilter.check(x.body, { courseId: cid }); if (!w.ok) return { ok: false, errors: [w.message], code: "CONTENT_REJECTED" };
  const r = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).input("b", sql.NVarChar(1000), x.body).input("l", sql.Int, x.lessonId).input("a", sql.Int, x.assignmentId)
    .input("maxOpen", sql.Int, MAX_OPEN).input("maxDay", sql.Int, MAX_PER_DAY)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @code NVARCHAR(20) = NULL, @id INT = NULL;
      IF @l IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL) SET @code = N'BAD_LINK';
      ELSE IF @a IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL) SET @code = N'BAD_LINK';
      ELSE IF (SELECT COUNT(*) FROM lms_help_requests WITH (UPDLOCK, HOLDLOCK) WHERE course_id = @c AND student_id = @vid AND status = N'open' AND deleted_at IS NULL) >= @maxOpen SET @code = N'TOO_MANY_OPEN';
      ELSE IF (SELECT COUNT(*) FROM lms_help_requests WHERE course_id = @c AND student_id = @vid AND created_at > DATEADD(HOUR, -24, SYSUTCDATETIME())) >= @maxDay SET @code = N'RATE_LIMIT';
      IF @code IS NULL BEGIN
        INSERT INTO lms_help_requests (course_id, student_id, body, lesson_id, assignment_id) VALUES (@c, @vid, @b, @l, @a);
        SET @id = SCOPE_IDENTITY();
      END
      COMMIT; SELECT @id AS id, @code AS code;`);
  const row = r.recordset && r.recordset[0]; if (!row || !row.id) {
    const c = row && row.code;
    if (c === "BAD_LINK") return notFound("Lesson or assignment");
    if (c === "TOO_MANY_OPEN") return reject("TOO_MANY_OPEN", `You already have ${MAX_OPEN} open help requests in this course. Wait for an answer or withdraw one.`);
    return reject("HELP_RATE_LIMIT", "You have sent many help requests today. Please try again tomorrow.");
  }
  return { ok: true, id: row.id };
}

async function withdraw(pool, user, courseId, requestId) {
  const v = viewerOf(user, false), cid = posInt(courseId), rid = posInt(requestId); if (!v || !cid || !rid) return notFound("Help request");
  const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc; const wb = writeBlock(rc.status); if (wb) return wb;
  const r = await pool.request().input("c", sql.Int, cid).input("id", sql.Int, rid).input("vid", sql.Int, v.id)
    .query(`UPDATE lms_help_requests SET deleted_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND student_id = @vid AND status = N'open' AND deleted_at IS NULL`);
  if (r.recordset && r.recordset[0]) { await audit(pool, v, "help.withdrawn", "lms_help_requests", rid, { courseId: cid }); return { ok: true }; }
  const e = await pool.request().input("c", sql.Int, cid).input("id", sql.Int, rid).input("vid", sql.Int, v.id)
    .query(`SELECT TOP 1 status FROM lms_help_requests WHERE id = @id AND course_id = @c AND student_id = @vid AND deleted_at IS NULL`);
  return e.recordset && e.recordset[0] ? reject("ALREADY_ANSWERED", "This request has been answered and can no longer be withdrawn.") : notFound("Help request");
}

/* ------------------------------- staff side ------------------------------ */
async function listInbox(pool, user, courseId, query = {}) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc;
  const status = query.status === undefined ? "open" : query.status; if (!STATUSES.includes(status)) return { ok: false, errors: ["status must be open, answered or all."] };
  const pg = paging(query);
  const r = await pool.request().input("c", sql.Int, cid).input("st", sql.NVarChar(10), status).input("off", sql.Int, pg.offset).input("lim", sql.Int, pg.pageSize)
    .query(`SELECT h.id, h.body, h.status, h.lesson_id, h.assignment_id, h.reply, h.answered_at, h.created_at, ${ANSWERER} AS answerer, s.name AS student_name, COUNT(*) OVER() AS total_count
      FROM lms_help_requests h JOIN Students s ON s.id = h.student_id ${ANSWER_JOINS}
      WHERE h.course_id = @c AND h.deleted_at IS NULL AND (@st = N'all' OR h.status = @st) ORDER BY CASE WHEN h.status = N'open' THEN 0 ELSE 1 END, h.id ASC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map((x) => ({ ...learnerShape(x), learner: x.student_name ? String(x.student_name).slice(0, 120) : null })), total: rows.length ? Number(rows[0].total_count) : 0, page: pg.page, pageSize: pg.pageSize };
}

async function answer(pool, user, courseId, requestId, body, ctx = {}) {
  const v = viewerOf(user, true), cid = posInt(courseId), rid = posInt(requestId); if (!v || !cid || !rid) return notFound("Help request");
  const val = validateReply(body); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const r = await pool.request().input("c", sql.Int, cid).input("id", sql.Int, rid).input("rep", sql.NVarChar(2000), val.value.reply).input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id)
    .query(`UPDATE lms_help_requests SET status = N'answered', reply = @rep, answered_by_source = @src, answered_by = @uid, answered_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND status = N'open' AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) {
    const e = await pool.request().input("c", sql.Int, cid).input("id", sql.Int, rid).query(`SELECT TOP 1 status FROM lms_help_requests WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
    return e.recordset && e.recordset[0] ? reject("ALREADY_ANSWERED", "This help request has already been answered.") : notFound("Help request");
  }
  await audit(pool, v, "help.answered", "lms_help_requests", rid, { courseId: cid, withReply: val.value.reply !== null });
  if (ctx.tenant) events.emit("lms.help.answered", { tenant: ctx.tenant, courseId: cid, requestId: rid });
  return { ok: true };
}

/* ------------------------------ office hours ------------------------------ */
const lineShape = (x) => ({ id: x.id, line: x.line });
async function listLines(pool, user, courseId, staff) {
  const v = viewerOf(user, staff), cid = posInt(courseId); if (!v || !cid) return notFound(); const rc = await readCtx(pool, v, cid); if (!rc.ok) return rc;
  const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_LINES} id, line FROM lms_office_hours WHERE course_id = @c AND deleted_at IS NULL ORDER BY id`);
  return { ok: true, items: (r.recordset || []).map(lineShape) };
}
async function addLine(pool, user, courseId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const val = validateLine(body); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const r = await pool.request().input("c", sql.Int, cid).input("l", sql.NVarChar(200), val.value.line).input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id).input("max", sql.Int, MAX_LINES)
    .query(`INSERT INTO lms_office_hours (course_id, line, created_by_source, created_by) OUTPUT INSERTED.id
      SELECT @c, @l, @src, @uid WHERE (SELECT COUNT(*) FROM lms_office_hours WITH (UPDLOCK, HOLDLOCK) WHERE course_id = @c AND deleted_at IS NULL) < @max`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("LINE_LIMIT", `A course can have at most ${MAX_LINES} office-hour lines.`);
  await audit(pool, v, "office_hours.added", "lms_office_hours", id, { courseId: cid });
  return { ok: true, item: { id, line: val.value.line } };
}
async function removeLine(pool, user, courseId, lineId) {
  const v = viewerOf(user, true), cid = posInt(courseId), lid = posInt(lineId); if (!v || !cid || !lid) return notFound("Office-hour line");
  const s = await courseStatus(pool, cid); if (!s) return notFound(); if (s === "archived") return writeBlock(s);
  const r = await pool.request().input("c", sql.Int, cid).input("id", sql.Int, lid).query(`UPDATE lms_office_hours SET deleted_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Office-hour line");
  await audit(pool, v, "office_hours.removed", "lms_office_hours", lid, { courseId: cid });
  return { ok: true };
}

module.exports = { BODY_MAX, REPLY_MAX, LINE_MAX, MAX_LINES, MAX_OPEN, MAX_PER_DAY, validateRequest, validateReply, validateLine, listMine, createRequest, withdraw, listInbox, answer, listLines, addLine, removeLine };
