/* =========================================================================
   LMS PEER REVIEW, LEARNER SIDE + MODERATION  (L8.3b, D-101)  no schema step (tables from step 037). Flag `lms_discussions` FIRST.
   Learner routes /courses/:id/learn/peer-reviews (studentOnly + ACTIVE enrolment); staff review detail + moderation under /courses/:id/peer-rounds/:roundId/reviews/:reviewId.
   Rules:
   - A REVIEWER sees only reviews ASSIGNED to them, only while the round is OPEN (else 404), and of each only the submission TEXT of the assigned attempt (no other attempts, no
     files yet) and the round's rubric. ANONYMOUS rounds: the author's name is never even selected from the database. Otherwise `First L.`. No ids of authors.
   - Saving a review (PUT) needs the round open, `opens_at` reached and `closes_at` not passed (409 ROUND_CLOSED / ROUND_NOT_OPEN), the review not hidden (409 REVIEW_HIDDEN), the course
     published. With a rubric: EVERY criterion once with an existing level (points come from the stored level, never the client), total stored; comment optional. Without a rubric:
     comment required, scores refused. A review can be re-saved while the round is open; scores are replaced in one transaction.
   - An AUTHOR sees feedback on their own work ONLY after the round is CLOSED (Q79 default), only DONE and NOT hidden reviews, the reviewer's name only when the round is not anonymous.
   - STAFF see names, scores and comment of any review of the round; hiding a review needs `lms.course.manage` (reason <= 300, audited, text never edited, never deleted).
   - Peer scores NEVER enter the gradebook.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const { holderName } = require("./lmsCertificates");
const rubrics = require("./lmsRubrics");
/* Test seam (S48): tests swap _deps.getRubric instead of mutating the shared lmsRubrics export (tests start concurrently, a shared patch leaks into other files). */
const _deps = { getRubric: (...a) => rubrics.getRubric(...a) };
const PR = require("./lmsPeerReview");
const D = require("./lmsDiscussions");
const { readCtx, writeBlock, notFound, reject, paging, isObj, iso } = D._internal;
const { viewerOf, cleanText } = D;

const COMMENT_MAX = 2000;
const num = (v) => (v === null || v === undefined ? null : Number(v));

/* Pure. { ok, value:{ scores:[{criterionId, levelPosition}]|null, comment } } or { ok:false, errors } */
function validateReview(body, hasRubric) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["scores", "comment"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], v = { scores: null, comment: null };
  if (body.comment !== undefined && body.comment !== null) { const c = cleanText(body.comment); if (c === null || c.length > COMMENT_MAX) errors.push(`comment must be text up to ${COMMENT_MAX} characters.`); else v.comment = c || null; }
  if (hasRubric) {
    if (!Array.isArray(body.scores) || !body.scores.length || body.scores.length > 20) errors.push("scores is required: one entry per rubric criterion.");
    else { const seen = new Set(); v.scores = [];
      for (const s of body.scores) { if (!isObj(s) || Object.keys(s).some((k) => !["criterionId", "levelPosition"].includes(k)) || !Number.isInteger(s.criterionId) || s.criterionId < 1 || !Number.isInteger(s.levelPosition) || s.levelPosition < 1) { errors.push("each score needs criterionId and levelPosition."); break; }
        if (seen.has(s.criterionId)) { errors.push("each criterion can be scored once."); break; } seen.add(s.criterionId); v.scores.push({ criterionId: s.criterionId, levelPosition: s.levelPosition }); } }
  } else {
    if (body.scores !== undefined && body.scores !== null) errors.push("This round has no rubric, so send a comment, not scores.");
    if (!v.comment && !errors.length) errors.push("comment is required.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. Matches a validated score list against a rubric; returns { ok, rows:[{criterionId, levelPosition, points}], total } or { ok:false, errors }. */
function scoreAgainst(rubric, scores) {
  const byC = new Map(rubric.criteria.map((c) => [c.id, c])); if (scores.length !== byC.size) return { ok: false, errors: ["Score every criterion exactly once."] };
  const rows = []; let total = 0;
  for (const s of scores) { const c = byC.get(s.criterionId); if (!c) return { ok: false, errors: ["Unknown criterion."] }; const l = c.levels.find((x) => x.position === s.levelPosition); if (!l) return { ok: false, errors: ["Unknown level for a criterion."] };
    rows.push({ criterionId: c.id, levelPosition: l.position, points: l.points }); total += l.points; }
  return { ok: true, rows, total: Math.round(total * 100) / 100 };
}

const learner = (user) => viewerOf(user, false);
const REV = `SELECT TOP 1 v.id, v.status, v.comment, v.total_points, v.hidden_at, r.id AS round_id, r.title, r.assignment_id, r.anonymous, r.rubric_id, r.opens_at, r.closes_at,
    CASE WHEN r.anonymous = 1 THEN NULL ELSE au.name END AS author_name, s.body_text
  FROM lms_peer_reviews v JOIN lms_peer_review_rounds r ON r.id = v.round_id AND r.course_id = v.course_id AND r.deleted_at IS NULL AND r.status = 'open'
  JOIN lms_submissions s ON s.id = v.submission_id AND s.course_id = v.course_id LEFT JOIN Students au ON au.id = v.author_id
  WHERE v.id = @v AND v.course_id = @c AND v.reviewer_id = @vid`;
const loadMine = async (pool, v, cid, id) => { const r = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).input("v", sql.Int, id).query(REV); return r.recordset && r.recordset[0] ? r.recordset[0] : null; };

async function listMine(pool, user, courseId, query) {
  const v = learner(user), cid = posInt(courseId); if (!v || !cid) return notFound(); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx; const pg = paging(query);
  const rq = () => pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id);
  const from = `FROM lms_peer_reviews v JOIN lms_peer_review_rounds r ON r.id = v.round_id AND r.course_id = v.course_id AND r.deleted_at IS NULL AND r.status = 'open' WHERE v.course_id = @c AND v.reviewer_id = @vid`;
  const tot = await rq().query(`SELECT COUNT(*) AS n ${from}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT v.id, v.status, r.title, r.assignment_id, r.closes_at, r.anonymous ${from} ORDER BY r.closes_at, v.id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const items = (r.recordset || []).map((x) => ({ id: x.id, status: x.status, roundTitle: x.title, assignmentId: x.assignment_id, closesAt: iso(x.closes_at), anonymous: !!x.anonymous }));
  return { ok: true, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

async function getMine(pool, user, courseId, reviewId) {
  const v = learner(user), cid = posInt(courseId), id = posInt(reviewId); if (!v || !cid || !id) return notFound("Review"); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx;
  const x = await loadMine(pool, v, cid, id); if (!x) return notFound("Review");
  let rubric = null; if (x.rubric_id) { const rr = await _deps.getRubric(pool, cid, x.rubric_id); if (rr.ok) rubric = { title: rr.rubric.title, maxPoints: rr.rubric.maxPoints, criteria: rr.rubric.criteria.map((c) => ({ id: c.id, title: c.title, description: c.description, weight: c.weight, levels: c.levels })) }; }
  const sc = await pool.request().input("v", sql.Int, id).query(`SELECT criterion_id, level_position, points FROM lms_peer_review_scores WHERE review_id = @v ORDER BY criterion_id`);
  return { ok: true, review: { id: x.id, status: x.status, hidden: !!x.hidden_at, roundTitle: x.title, assignmentId: x.assignment_id, closesAt: iso(x.closes_at), anonymous: !!x.anonymous, author: { name: x.anonymous ? null : holderName(x.author_name) } },
    submission: { text: x.body_text || "" }, rubric, mine: { comment: x.comment || null, totalPoints: num(x.total_points), scores: (sc.recordset || []).map((s) => ({ criterionId: s.criterion_id, levelPosition: s.level_position, points: Number(s.points) })) } };
}

async function saveMine(pool, user, courseId, reviewId, body) {
  const v = learner(user), cid = posInt(courseId), id = posInt(reviewId); if (!v || !cid || !id) return notFound("Review");
  const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx; const wb = writeBlock(ctx.status); if (wb) return wb;
  const x = await loadMine(pool, v, cid, id); if (!x) return notFound("Review");
  const now = Date.now(); if (x.opens_at && new Date(x.opens_at).getTime() > now) return reject("ROUND_NOT_OPEN", "This review round has not started yet."); if (x.closes_at && new Date(x.closes_at).getTime() < now) return reject("ROUND_CLOSED", "The deadline for this review has passed.");
  if (x.hidden_at) return reject("REVIEW_HIDDEN", "This review was hidden by your teacher and can no longer be changed.");
  const val = validateReview(body, !!x.rubric_id); if (!val.ok) return val; const y = val.value; let rows = [], total = null;
  if (x.rubric_id) { const rr = await _deps.getRubric(pool, cid, x.rubric_id); if (!rr.ok) return reject("RUBRIC_MISSING", "The rubric for this round is no longer available. Ask your teacher."); const m = scoreAgainst(rr.rubric, y.scores); if (!m.ok) return m; rows = m.rows; total = m.total; }
  const r = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).input("v", sql.Int, id).input("cm", sql.NVarChar(2000), y.comment).input("tp", sql.Decimal(7, 2), total).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @n INT;
      UPDATE lms_peer_reviews SET comment = @cm, total_points = @tp, status = 'done', submitted_at = ISNULL(submitted_at, SYSUTCDATETIME())
        WHERE id = @v AND course_id = @c AND reviewer_id = @vid AND hidden_at IS NULL AND EXISTS (SELECT 1 FROM lms_peer_review_rounds r WHERE r.id = lms_peer_reviews.round_id AND r.status = 'open' AND r.deleted_at IS NULL);
      SET @n = @@ROWCOUNT; IF @n = 0 BEGIN ROLLBACK; SELECT 0 AS saved; RETURN; END
      DELETE FROM lms_peer_review_scores WHERE review_id = @v;
      INSERT INTO lms_peer_review_scores (review_id, criterion_id, level_position, points) SELECT @v, j.cid, j.lp, j.pts FROM OPENJSON(@rows) WITH (cid INT '$.criterionId', lp INT '$.levelPosition', pts DECIMAL(7,2) '$.points') j;
      COMMIT; SELECT 1 AS saved;`);
  if (!(r.recordset && r.recordset[0] && r.recordset[0].saved)) return reject("ROUND_CLOSED", "This review can no longer be changed.");
  return { ok: true, saved: true, totalPoints: total };
}

/* Feedback on MY work: closed rounds only, done + not hidden reviews. */
async function listReceived(pool, user, courseId, query) {
  const v = learner(user), cid = posInt(courseId); if (!v || !cid) return notFound(); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx; const pg = paging(query), aid = posInt(query && query.assignmentId);
  const rq = () => { const q = pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id); return aid ? q.input("a", sql.Int, aid) : q; };
  const from = `FROM lms_peer_reviews v JOIN lms_peer_review_rounds r ON r.id = v.round_id AND r.course_id = v.course_id AND r.deleted_at IS NULL AND r.status = 'closed'
    WHERE v.course_id = @c AND v.author_id = @vid AND v.status = 'done' AND v.hidden_at IS NULL${aid ? " AND r.assignment_id = @a" : ""}`;
  const tot = await rq().query(`SELECT COUNT(*) AS n ${from}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT v.id, v.comment, v.total_points, v.submitted_at, r.title, r.assignment_id, r.anonymous, CASE WHEN r.anonymous = 1 THEN NULL ELSE rv.name END AS reviewer_name
    ${from.replace("WHERE v.course_id", "LEFT JOIN Students rv ON rv.id = v.reviewer_id WHERE v.course_id")} ORDER BY v.id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const list = r.recordset || [], total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  let scores = [];
  if (list.length) { const sr = await pool.request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(list.map((x) => x.id))).query(`SELECT s.review_id, c.title AS criterion, l.label AS level, s.points FROM lms_peer_review_scores s
      JOIN lms_rubric_criteria c ON c.id = s.criterion_id LEFT JOIN lms_rubric_levels l ON l.criterion_id = s.criterion_id AND l.position = s.level_position
      WHERE s.review_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) ORDER BY s.review_id, c.position`); scores = sr.recordset || []; }
  const items = list.map((x) => ({ id: x.id, roundTitle: x.title, assignmentId: x.assignment_id, anonymous: !!x.anonymous, reviewer: { name: x.anonymous ? null : holderName(x.reviewer_name) }, comment: x.comment || null, totalPoints: num(x.total_points), submittedAt: iso(x.submitted_at),
    scores: scores.filter((s) => s.review_id === x.id).map((s) => ({ criterion: s.criterion, level: s.level || null, points: Number(s.points) })) }));
  return { ok: true, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

/* STAFF: one review in full (names, scores, comment). */
async function staffGetReview(pool, user, courseId, roundId, reviewId) {
  const c = await PR.staffCtx(pool, user, courseId, false), rid = posInt(roundId), id = posInt(reviewId); if (!c.ok) return c; if (!rid || !id) return notFound("Review");
  const r = await pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid).input("v", sql.Int, id).query(`SELECT TOP 1 v.id, v.status, v.comment, v.total_points, v.submitted_at, v.hidden_at, v.hidden_reason, rs.name AS reviewer_name, au.name AS author_name
    FROM lms_peer_reviews v LEFT JOIN Students rs ON rs.id = v.reviewer_id LEFT JOIN Students au ON au.id = v.author_id WHERE v.id = @v AND v.round_id = @r AND v.course_id = @c`);
  const x = r.recordset && r.recordset[0]; if (!x) return notFound("Review");
  const sc = await pool.request().input("v", sql.Int, id).query(`SELECT c.title AS criterion, l.label AS level, s.points FROM lms_peer_review_scores s JOIN lms_rubric_criteria c ON c.id = s.criterion_id
    LEFT JOIN lms_rubric_levels l ON l.criterion_id = s.criterion_id AND l.position = s.level_position WHERE s.review_id = @v ORDER BY c.position`);
  return { ok: true, review: { id: x.id, status: x.status, comment: x.comment || null, totalPoints: num(x.total_points), submittedAt: iso(x.submitted_at), hidden: !!x.hidden_at, ...(x.hidden_at && x.hidden_reason ? { hiddenReason: x.hidden_reason } : {}),
    reviewer: { name: x.reviewer_name || null }, author: { name: x.author_name || null }, scores: (sc.recordset || []).map((s) => ({ criterion: s.criterion, level: s.level || null, points: Number(s.points) })) } };
}
/* STAFF: body { hidden: boolean, reason? (only with hidden:true) } */
async function moderateReview(pool, user, courseId, roundId, reviewId, body) {
  const c = await PR.staffCtx(pool, user, courseId, true), rid = posInt(roundId), id = posInt(reviewId); if (!c.ok) return c; if (!rid || !id) return notFound("Review");
  if (!isObj(body) || Object.keys(body).some((k) => !["hidden", "reason"].includes(k)) || typeof body.hidden !== "boolean") return { ok: false, errors: ["Send { hidden: true|false, reason? }."] };
  let why = null; if (body.reason !== undefined && body.reason !== null) { why = cleanText(body.reason); if (why === null || why.length > 300 || body.hidden !== true) return { ok: false, errors: ["reason (up to 300 characters) only goes with hidden: true."] }; why = why || null; }
  const r = await pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid).input("v", sql.Int, id).input("hid", sql.Bit, body.hidden ? 1 : 0).input("why", sql.NVarChar(300), why).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id)
    .query(`UPDATE lms_peer_reviews SET hidden_at = CASE WHEN @hid = 1 THEN ISNULL(hidden_at, SYSUTCDATETIME()) ELSE NULL END, hidden_by_source = CASE WHEN @hid = 1 THEN @src ELSE NULL END,
      hidden_by = CASE WHEN @hid = 1 THEN @uid ELSE NULL END, hidden_reason = CASE WHEN @hid = 1 THEN @why ELSE NULL END OUTPUT INSERTED.id WHERE id = @v AND round_id = @r AND course_id = @c`);
  if (!(r.recordset && r.recordset[0])) return notFound("Review");
  await audit(pool, c.v, "peer_review.moderated", "lms_peer_reviews", id, { courseId: c.cid, roundId: rid, hidden: body.hidden });
  return { ok: true, moderated: true };
}

module.exports = { _deps, validateReview, scoreAgainst, listMine, getMine, saveMine, listReceived, staffGetReview, moderateReview };
