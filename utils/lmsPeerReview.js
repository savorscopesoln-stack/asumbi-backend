/* =========================================================================
   LMS PEER REVIEW, STAFF SIDE  (L8.3a, D-100)  schema step 037 `lms_peer_review_rounds`, `lms_peer_reviews`, `lms_peer_review_scores`.
   Routes (flag `lms_discussions` FIRST): /courses/:id/peer-rounds. Read = any course owner / co-teacher / admin; write = `lms.course.manage` + membership.
   Rules:
   - ONE live round per assignment (filtered unique index). Rounds start as `draft` (editable), go `open` ONLY by the explicit open action (never automatic), then `closed`.
   - Authors AND reviewers = ACTIVELY enrolled learners with a SUBMITTED (or returned) attempt; the latest such attempt is the one reviewed. Fewer than 2 = 409 NOT_ENOUGH_SUBMISSIONS.
   - ALLOCATION is REPRODUCIBLE: authors sorted by learner id, a seeded permutation (utils/lmsQuizMarking.permutation) puts them in a circle, and each learner reviews the NEXT
     k learners on that circle. Nobody reviews themselves, nobody gets the same piece twice, and everybody reviews AND receives exactly min(k, n-1) reviews. Same learners + same
     seed = same allocation. `dryRun` returns the plan size and the seed and writes nothing; the seed is stored on open and audited.
   - Open freezes the allocation in ONE transaction (round -> open + all review rows). Later withdrawals do not change it. Close = `closed`; both are audited.
   - Staff see names and admission numbers of reviewer and author (anonymity applies to learners only, built in L8.3b). Peer scores NEVER enter the gradebook.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const { permutation } = require("./lmsQuizMarking");
const D = require("./lmsDiscussions");
const { courseStatus, notFound, reject, paging, isObj, iso } = D._internal;
const { viewerOf, cleanText } = D;

const MAX_LEARNERS = 2000, MAX_K = 5, SEED_MAX = 50;
const isDup = (e) => !!e && (e.number === 2601 || e.number === 2627);
const when = (v) => { if (v === null) return { ok: true, value: null }; if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: false }; const d = new Date(v); return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d }; };

/* Pure. create: assignmentId required; edit: any of the other fields. */
function validateRound(body, edit = false) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const allowed = edit ? ["title", "reviewsPerLearner", "anonymous", "rubricId", "opensAt", "closesAt"] : ["assignmentId", "title", "reviewsPerLearner", "anonymous", "rubricId", "opensAt", "closesAt"];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const v = {}, errors = [];
  if (!edit) { if (!Number.isInteger(body.assignmentId) || body.assignmentId < 1) errors.push("assignmentId is required."); else v.assignmentId = body.assignmentId; }
  if (!edit || body.title !== undefined) { const t = cleanText(body.title); if (!t || t.replace(/\s+/g, " ").length > 200) errors.push("title is required (1-200 characters)."); else v.title = t.replace(/\s+/g, " "); }
  if (body.reviewsPerLearner !== undefined) { if (!Number.isInteger(body.reviewsPerLearner) || body.reviewsPerLearner < 1 || body.reviewsPerLearner > MAX_K) errors.push(`reviewsPerLearner must be a whole number from 1 to ${MAX_K}.`); else v.reviewsPerLearner = body.reviewsPerLearner; }
  if (body.anonymous !== undefined) { if (typeof body.anonymous !== "boolean") errors.push("anonymous must be true or false."); else v.anonymous = body.anonymous; }
  if (body.rubricId !== undefined) { if (body.rubricId !== null && (!Number.isInteger(body.rubricId) || body.rubricId < 1)) errors.push("rubricId must be a rubric id or null."); else v.rubricId = body.rubricId; }
  for (const k of ["opensAt", "closesAt"]) if (body[k] !== undefined) { const w = when(body[k]); if (!w.ok) errors.push(`${k} must be a date/time or null.`); else v[k] = w.value; }
  if (v.opensAt && v.closesAt && v.closesAt <= v.opensAt) errors.push("closesAt must be after opensAt.");
  if (edit && !errors.length && !Object.keys(v).length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. body: { dryRun?, seed? } */
function validateOpen(body) {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["dryRun", "seed"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const v = {}, errors = [];
  if (body.dryRun !== undefined) { if (typeof body.dryRun !== "boolean") errors.push("dryRun must be true or false."); else v.dryRun = body.dryRun; }
  if (body.seed !== undefined && body.seed !== null) { const s = cleanText(String(typeof body.seed === "string" || typeof body.seed === "number" ? body.seed : "")); if (!s || s.length > SEED_MAX) errors.push(`seed must be 1-${SEED_MAX} characters.`); else v.seed = s; }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

/* Pure. authors: [{studentId, submissionId}] (any order); k wanted reviews; seed string. */
function planPeerAllocation(authors, k, seed) {
  const list = [...authors].sort((a, b) => a.studentId - b.studentId), n = list.length;
  if (n < 2) return { ok: false, authors: n, effective: 0, pairs: [] };
  const eff = Math.min(k, n - 1), perm = permutation(n, String(seed ?? "")), order = perm.map((p) => list[p - 1]), pairs = [];
  for (let i = 0; i < n; i += 1) for (let d = 1; d <= eff; d += 1) { const t = order[(i + d) % n]; pairs.push({ reviewerId: order[i].studentId, authorId: t.studentId, submissionId: t.submissionId }); }
  return { ok: true, authors: n, effective: eff, pairs };
}

async function staffCtx(pool, user, courseId, write) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound();
  const s = await courseStatus(pool, cid); if (!s) return notFound();
  if (write && s === "archived") return reject("COURSE_READ_ONLY", "This course is archived. Peer review is read only.");
  return { ok: true, v, cid, status: s };
}
const shape = (x) => ({ id: x.id, assignmentId: x.assignment_id, title: x.title, reviewsPerLearner: x.reviews_per_learner, anonymous: !!x.anonymous, rubricId: x.rubric_id ?? null, opensAt: iso(x.opens_at), closesAt: iso(x.closes_at),
  status: x.status, openedAt: iso(x.opened_at), closedAt: iso(x.closed_at), createdAt: iso(x.created_at), ...(x.review_count !== undefined ? { reviews: Number(x.review_count) || 0, done: Number(x.done_count) || 0 } : {}) });
const COLS = "r.id, r.assignment_id, r.title, r.reviews_per_learner, r.anonymous, r.rubric_id, r.opens_at, r.closes_at, r.status, r.opened_at, r.closed_at, r.created_at";
const COUNTS = `(SELECT COUNT(*) FROM lms_peer_reviews v WHERE v.round_id = r.id) AS review_count, (SELECT COUNT(*) FROM lms_peer_reviews v WHERE v.round_id = r.id AND v.status = 'done') AS done_count`;
async function loadRound(pool, cid, rid) { const r = await pool.request().input("c", sql.Int, cid).input("r", sql.Int, rid).query(`SELECT TOP 1 ${COLS}, r.seed, ${COUNTS} FROM lms_peer_review_rounds r WHERE r.id = @r AND r.course_id = @c AND r.deleted_at IS NULL`); return r.recordset && r.recordset[0] ? r.recordset[0] : null; }

async function createRound(pool, user, courseId, body) {
  const val = validateRound(body); if (!val.ok) return val; const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; const x = val.value;
  const a = await pool.request().input("a", sql.Int, x.assignmentId).input("c", sql.Int, c.cid).query(`SELECT TOP 1 id, work_mode FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
  if (!(a.recordset && a.recordset[0])) return notFound("Assignment");
  if (a.recordset[0].work_mode === "group") return reject("GROUP_ASSIGNMENT", "Peer review is not available for group assignments yet."); // D-102
  if (x.rubricId) { const rb = await pool.request().input("rb", sql.Int, x.rubricId).input("c", sql.Int, c.cid).query(`SELECT TOP 1 id FROM lms_rubrics WHERE id = @rb AND course_id = @c AND deleted_at IS NULL`); if (!(rb.recordset && rb.recordset[0])) return notFound("Rubric"); }
  try {
    const r = await pool.request().input("c", sql.Int, c.cid).input("a", sql.Int, x.assignmentId).input("t", sql.NVarChar(200), x.title).input("k", sql.Int, x.reviewsPerLearner ?? 2).input("an", sql.Bit, x.anonymous === false ? 0 : 1)
      .input("rb", sql.Int, x.rubricId ?? null).input("o", sql.DateTime2, x.opensAt ?? null).input("cl", sql.DateTime2, x.closesAt ?? null).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id)
      .query(`INSERT INTO lms_peer_review_rounds (course_id, assignment_id, title, reviews_per_learner, anonymous, rubric_id, opens_at, closes_at, created_by_source, created_by) OUTPUT INSERTED.id
        SELECT @c, @a, @t, @k, @an, @rb, @o, @cl, @src, @uid WHERE NOT EXISTS (SELECT 1 FROM lms_peer_review_rounds WITH (UPDLOCK, HOLDLOCK) WHERE assignment_id = @a AND deleted_at IS NULL)`);
    const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("ROUND_EXISTS", "This assignment already has a peer review round.");
    await audit(pool, c.v, "peer_round.created", "lms_peer_review_rounds", id, { courseId: c.cid, assignmentId: x.assignmentId });
    return { ok: true, id };
  } catch (e) { if (isDup(e)) return reject("ROUND_EXISTS", "This assignment already has a peer review round."); throw e; }
}
async function listRounds(pool, user, courseId, query) {
  const c = await staffCtx(pool, user, courseId, false); if (!c.ok) return c; const pg = paging(query), aid = posInt(query && query.assignmentId);
  const rq = () => { const q = pool.request().input("c", sql.Int, c.cid); return aid ? q.input("a", sql.Int, aid) : q; }, w = `r.course_id = @c AND r.deleted_at IS NULL${aid ? " AND r.assignment_id = @a" : ""}`;
  const tot = await rq().query(`SELECT COUNT(*) AS n FROM lms_peer_review_rounds r WHERE ${w}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT ${COLS}, ${COUNTS} FROM lms_peer_review_rounds r WHERE ${w} ORDER BY r.id DESC OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0, items = (r.recordset || []).map(shape);
  return { ok: true, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}
async function getRound(pool, user, courseId, roundId) {
  const c = await staffCtx(pool, user, courseId, false), rid = posInt(roundId); if (!c.ok) return c; if (!rid) return notFound("Round");
  const x = await loadRound(pool, c.cid, rid); return x ? { ok: true, round: { ...shape(x), seed: x.seed || null } } : notFound("Round");
}
async function updateRound(pool, user, courseId, roundId, body) {
  const rid = posInt(roundId), val = validateRound(body, true); if (!val.ok) return val; const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!rid) return notFound("Round"); const x = val.value;
  const cur = await loadRound(pool, c.cid, rid); if (!cur) return notFound("Round"); if (cur.status !== "draft") return reject("ROUND_LOCKED", "Only a draft round can be changed.");
  if (x.rubricId) { const rb = await pool.request().input("rb", sql.Int, x.rubricId).input("c", sql.Int, c.cid).query(`SELECT TOP 1 id FROM lms_rubrics WHERE id = @rb AND course_id = @c AND deleted_at IS NULL`); if (!(rb.recordset && rb.recordset[0])) return notFound("Rubric"); }
  const sets = [], rq = pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid);
  const add = (col, p, type, val2) => { sets.push(`${col} = @${p}`); rq.input(p, type, val2); };
  if (x.title !== undefined) add("title", "t", sql.NVarChar(200), x.title); if (x.reviewsPerLearner !== undefined) add("reviews_per_learner", "k", sql.Int, x.reviewsPerLearner);
  if (x.anonymous !== undefined) add("anonymous", "an", sql.Bit, x.anonymous ? 1 : 0); if (x.rubricId !== undefined) add("rubric_id", "rb", sql.Int, x.rubricId);
  if (x.opensAt !== undefined) add("opens_at", "o", sql.DateTime2, x.opensAt); if (x.closesAt !== undefined) add("closes_at", "cl", sql.DateTime2, x.closesAt);
  const r = await rq.query(`UPDATE lms_peer_review_rounds SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @r AND course_id = @c AND deleted_at IS NULL AND status = 'draft'`);
  if (!(r.recordset && r.recordset[0])) return reject("ROUND_LOCKED", "Only a draft round can be changed.");
  await audit(pool, c.v, "peer_round.updated", "lms_peer_review_rounds", rid, { courseId: c.cid, fields: Object.keys(x) });
  return { ok: true };
}
async function removeRound(pool, user, courseId, roundId) {
  const c = await staffCtx(pool, user, courseId, true), rid = posInt(roundId); if (!c.ok) return c; if (!rid) return notFound("Round");
  const r = await pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid).query(`UPDATE lms_peer_review_rounds SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @r AND course_id = @c AND deleted_at IS NULL AND status = 'draft'`);
  if (!(r.recordset && r.recordset[0])) { return (await loadRound(pool, c.cid, rid)) ? reject("ROUND_LOCKED", "Only a draft round can be removed.") : notFound("Round"); }
  await audit(pool, c.v, "peer_round.removed", "lms_peer_review_rounds", rid, { courseId: c.cid });
  return { ok: true, removed: true };
}

/* body: { dryRun?, seed? } */
async function openRound(pool, user, courseId, roundId, body) {
  const rid = posInt(roundId), val = validateOpen(body); if (!val.ok) return val; const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!rid) return notFound("Round"); const x = val.value;
  const cur = await loadRound(pool, c.cid, rid); if (!cur) return notFound("Round"); if (cur.status !== "draft") return reject("ROUND_LOCKED", "This round is already open or closed.");
  const ar = await pool.request().input("a", sql.Int, cur.assignment_id).input("c", sql.Int, c.cid).query(`SELECT TOP ${MAX_LEARNERS + 1} s.student_id, s.id AS submission_id FROM lms_submissions s
    JOIN lms_course_enrolments e ON e.course_id = s.course_id AND e.student_id = s.student_id AND e.status = 'active'
    WHERE s.assignment_id = @a AND s.course_id = @c AND s.status IN ('submitted', 'returned')
      AND s.attempt_no = (SELECT MAX(z.attempt_no) FROM lms_submissions z WHERE z.assignment_id = s.assignment_id AND z.student_id = s.student_id AND z.status IN ('submitted', 'returned')) ORDER BY s.student_id`);
  const authors = (ar.recordset || []).filter((y) => Number.isInteger(y.student_id) && Number.isInteger(y.submission_id)).map((y) => ({ studentId: y.student_id, submissionId: y.submission_id }));
  if (authors.length > MAX_LEARNERS) return reject("TOO_MANY_LEARNERS", `Peer review supports up to ${MAX_LEARNERS} learners.`);
  const seed = x.seed || crypto.randomBytes(4).toString("hex"), plan = planPeerAllocation(authors, cur.reviews_per_learner, seed);
  if (!plan.ok) return reject("NOT_ENOUGH_SUBMISSIONS", "At least 2 learners must have submitted before a round can open.");
  const summary = { seed, authors: plan.authors, reviewsPerLearner: plan.effective, requested: cur.reviews_per_learner, reviews: plan.pairs.length };
  if (x.dryRun) return { ok: true, dryRun: true, ...summary };
  const r = await pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid).input("seed", sql.NVarChar(50), seed).input("pairs", sql.NVarChar(sql.MAX), JSON.stringify(plan.pairs))
    .query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @n INT, @made INT;
      UPDATE lms_peer_review_rounds SET status = 'open', seed = @seed, opened_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE id = @r AND course_id = @c AND deleted_at IS NULL AND status = 'draft';
      SET @n = @@ROWCOUNT; IF @n = 0 BEGIN ROLLBACK; SELECT 0 AS made; RETURN; END
      INSERT INTO lms_peer_reviews (round_id, course_id, reviewer_id, author_id, submission_id)
        SELECT @r, @c, j.rv, j.au, j.sb FROM OPENJSON(@pairs) WITH (rv INT '$.reviewerId', au INT '$.authorId', sb INT '$.submissionId') j;
      SET @made = @@ROWCOUNT; COMMIT; SELECT @made AS made;`);
  const made = Number(r.recordset && r.recordset[0] && r.recordset[0].made) || 0; if (!made) return reject("ROUND_LOCKED", "This round is already open or closed.");
  await audit(pool, c.v, "peer_round.opened", "lms_peer_review_rounds", rid, { courseId: c.cid, seed, authors: plan.authors, reviews: made });
  return { ok: true, ...summary, reviews: made };
}
async function closeRound(pool, user, courseId, roundId) {
  const c = await staffCtx(pool, user, courseId, true), rid = posInt(roundId); if (!c.ok) return c; if (!rid) return notFound("Round");
  const r = await pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid).query(`UPDATE lms_peer_review_rounds SET status = 'closed', closed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @r AND course_id = @c AND deleted_at IS NULL AND status = 'open'`);
  if (!(r.recordset && r.recordset[0])) return (await loadRound(pool, c.cid, rid)) ? reject("ROUND_LOCKED", "Only an open round can be closed.") : notFound("Round");
  await audit(pool, c.v, "peer_round.closed", "lms_peer_review_rounds", rid, { courseId: c.cid });
  return { ok: true, closed: true };
}
/* Staff view of who reviews whom, with names and admission numbers. Paged. status: all|assigned|done. */
async function listReviews(pool, user, courseId, roundId, query) {
  const c = await staffCtx(pool, user, courseId, false), rid = posInt(roundId); if (!c.ok) return c; if (!rid) return notFound("Round"); if (!(await loadRound(pool, c.cid, rid))) return notFound("Round");
  const st = ["assigned", "done"].includes(query && query.status) ? query.status : null, pg = paging(query), w = `v.round_id = @r AND v.course_id = @c${st ? " AND v.status = @st" : ""}`;
  const rq = () => { const q = pool.request().input("c", sql.Int, c.cid).input("r", sql.Int, rid); return st ? q.input("st", sql.NVarChar(10), st) : q; };
  const tot = await rq().query(`SELECT COUNT(*) AS n FROM lms_peer_reviews v WHERE ${w}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT v.id, v.status, v.total_points, v.submitted_at, v.hidden_at, v.hidden_reason, rs.name AS reviewer_name, rs.admission_number AS reviewer_adm, au.name AS author_name, au.admission_number AS author_adm
    FROM lms_peer_reviews v LEFT JOIN Students rs ON rs.id = v.reviewer_id LEFT JOIN Students au ON au.id = v.author_id WHERE ${w} ORDER BY v.id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const items = (r.recordset || []).map((x) => ({ id: x.id, status: x.status, totalPoints: x.total_points === null || x.total_points === undefined ? null : Number(x.total_points), submittedAt: iso(x.submitted_at), hidden: !!x.hidden_at, ...(x.hidden_at && x.hidden_reason ? { hiddenReason: x.hidden_reason } : {}),
    reviewer: { name: x.reviewer_name || null, admissionNumber: x.reviewer_adm || null }, author: { name: x.author_name || null, admissionNumber: x.author_adm || null } }));
  return { ok: true, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

module.exports = { staffCtx, MAX_LEARNERS, MAX_K, validateRound, validateOpen, planPeerAllocation, createRound, listRounds, getRound, updateRound, removeRound, openRound, closeRound, listReviews };
