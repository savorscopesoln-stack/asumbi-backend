/* L8.3b - peer review learner side + moderation (D-101): reviewer sees only assigned work of an OPEN round, anonymity, rubric scoring from stored levels, deadlines, author feedback only after close,
   hidden reviews, staff detail + moderation, gates, isolation. Mocked pool only (OPENJSON transaction, joins NOT verified on a real SQL Server). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsPeerReviewLearner.test.js");
const L = require("../utils/lmsPeerReviewLearner"), rubrics = require("../utils/lmsRubrics");
const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" };
const future = (h) => new Date(Date.now() + h * 3600000).toISOString(), RUBRIC = { ok: true, rubric: { title: "Essay", maxPoints: 10, criteria: [
  { id: 1, title: "Ideas", description: "d", weight: 6, outcomes: [{ id: 1 }], levels: [{ position: 1, label: "Low", description: "", points: 2 }, { position: 2, label: "High", description: "", points: 6 }] },
  { id: 2, title: "Style", description: "", weight: 4, outcomes: [], levels: [{ position: 1, label: "Low", description: "", points: 1 }, { position: 2, label: "High", description: "", points: 4 }] }] } };
const origGet = L._deps.getRubric; const withRubric = (r) => { L._deps.getRubric = async () => r; }; const restore = () => { L._deps.getRubric = origGet; };
const rev = (o = {}) => ({ id: 8, status: "assigned", comment: null, total_points: null, hidden_at: null, round_id: 3, title: "R1", assignment_id: 9, anonymous: 1, rubric_id: 4, opens_at: null, closes_at: future(24), author_name: null, body_text: "My essay text", ...o });
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @n INT;\n      UPDATE lms_peer_reviews", () => [{ saved: o.saved ?? 1 }]],
  ["SET XACT_ABORT ON", () => [{ saved: o.saved ?? 1 }]],
  ["SELECT TOP 1 v.id, v.status, v.comment, v.total_points, v.hidden_at, r.id AS round_id", () => (o.noReview ? [] : [rev(o.rev)])],
  ["SELECT criterion_id, level_position, points FROM lms_peer_review_scores", () => [{ criterion_id: 1, level_position: 2, points: "6.00" }]],
  ["SELECT COUNT(*) AS n FROM lms_peer_reviews v", () => [{ n: 2 }]],
  ["SELECT v.id, v.status, r.title, r.assignment_id, r.closes_at", () => [{ id: 8, status: "assigned", title: "R1", assignment_id: 9, closes_at: future(5), anonymous: 1 }]],
  ["SELECT v.id, v.comment, v.total_points", () => [{ id: 8, comment: "Good", total_points: "8.0", submitted_at: "2026-11-02T00:00:00Z", title: "R1", assignment_id: 9, anonymous: o.anon === false ? 0 : 1, reviewer_name: o.anon === false ? "John Otieno" : null }]],
  ["SELECT s.review_id, c.title AS criterion", () => [{ review_id: 8, criterion: "Ideas", level: "High", points: "6" }]],
  ["SELECT TOP 1 v.id, v.status, v.comment, v.total_points, v.submitted_at", () => (o.noReview ? [] : [{ id: 8, status: "done", comment: "c", total_points: "8", submitted_at: "2026-11-02T00:00:00Z", hidden_at: o.hidden ? "2026-11-02T01:00:00Z" : null, hidden_reason: "rude", reviewer_name: "Amina Kamau", author_name: "John Otieno" }])],
  ["SELECT c.title AS criterion, l.label AS level, s.points FROM lms_peer_review_scores s", () => [{ criterion: "Ideas", level: "High", points: "6" }]],
  ["UPDATE lms_peer_reviews SET hidden_at", () => (o.noReview ? [] : [{ id: 8 }])]]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql)); const has = (m, re) => m.log.some((x) => re.test(x.sql));

test("validateReview / scoreAgainst (pure): rubric = every criterion once with ids/levels from the rubric; no rubric = comment only; limits; unknown fields", () => {
  const v = L.validateReview; assert.deepStrictEqual(v({ scores: [{ criterionId: 1, levelPosition: 2 }], comment: " <b>ok</b> " }, true).value, { scores: [{ criterionId: 1, levelPosition: 2 }], comment: "bok/b" });
  assert.deepStrictEqual(v({ comment: "Nice" }, false).value, { scores: null, comment: "Nice" });
  for (const [b, r] of [[{}, true], [{ scores: [] }, true], [{ scores: "x" }, true], [{ scores: [{ criterionId: 1, levelPosition: 0 }] }, true], [{ scores: [{ criterionId: 1, levelPosition: 1 }, { criterionId: 1, levelPosition: 2 }] }, true], [{ scores: [{ criterionId: 1, levelPosition: 1, points: 99 }] }, true], [{ scores: [{ criterionId: "1", levelPosition: 1 }] }, true],
    [{ scores: [{ criterionId: 1, levelPosition: 1 }], comment: "x".repeat(2001) }, true], [{ scores: [{ criterionId: 1, levelPosition: 1 }], x: 1 }, true], [{}, false], [{ comment: "" }, false], [{ comment: "x", scores: [{ criterionId: 1, levelPosition: 1 }] }, false], [null, true], [[], false]]) assert.strictEqual(v(b, r).ok, false, JSON.stringify(b));
  const m = L.scoreAgainst(RUBRIC.rubric, [{ criterionId: 1, levelPosition: 2 }, { criterionId: 2, levelPosition: 1 }]); assert.deepStrictEqual([m.ok, m.total, m.rows[0].points, m.rows[1].points], [true, 7, 6, 1]);
  assert.strictEqual(L.scoreAgainst(RUBRIC.rubric, [{ criterionId: 1, levelPosition: 2 }]).ok, false); assert.strictEqual(L.scoreAgainst(RUBRIC.rubric, [{ criterionId: 1, levelPosition: 9 }, { criterionId: 2, levelPosition: 1 }]).ok, false); assert.strictEqual(L.scoreAgainst(RUBRIC.rubric, [{ criterionId: 1, levelPosition: 1 }, { criterionId: 99, levelPosition: 1 }]).ok, false);
});

test("listMine / getMine: only MY assigned reviews of OPEN rounds in THIS course; anonymous author name never selected; submission text of the assigned attempt only; rubric without outcome tags", async () => {
  const m = world(); const l = await L.listMine(m.pool, student, 5, { pageSize: "999" }); const ls = m.log.find((x) => /SELECT v\.id, v\.status, r\.title/.test(x.sql));
  assert.ok(/r\.status = 'open'/.test(ls.sql) && /v\.course_id = @c AND v\.reviewer_id = @vid/.test(ls.sql) && ls.inputs.vid === 30 && ls.inputs.ps === 50 && !/author|name/i.test(ls.sql)); assert.deepStrictEqual([l.total, l.items[0].roundTitle, l.items[0].anonymous], [2, "R1", true]); assert.ok(!/author|reviewer|student/i.test(JSON.stringify(l)));
  withRubric(RUBRIC); try { const g = await L.getMine(m.pool, student, 5, 8); const q = m.log.find((x) => /SELECT TOP 1 v\.id, v\.status, v\.comment, v\.total_points, v\.hidden_at/.test(x.sql));
    assert.ok(/CASE WHEN r\.anonymous = 1 THEN NULL ELSE au\.name END AS author_name/.test(q.sql) && /r\.status = 'open'/.test(q.sql) && /s\.id = v\.submission_id AND s\.course_id = v\.course_id/.test(q.sql) && /v\.id = @v AND v\.course_id = @c AND v\.reviewer_id = @vid/.test(q.sql) && q.inputs.vid === 30 && q.inputs.v === 8);
    assert.deepStrictEqual([g.ok, g.submission.text, g.review.author, g.rubric.criteria.length, g.mine.scores[0], g.rubric.criteria[0].outcomes], [true, "My essay text", { name: null }, 2, { criterionId: 1, levelPosition: 2, points: 6 }, undefined]);
    const leak = world({ rev: { anonymous: 1, author_name: "Leak Name" } }); assert.deepStrictEqual((await L.getMine(leak.pool, student, 5, 8)).review.author, { name: null }, "even a leaking row cannot expose an anonymous author");
    const named = world({ rev: { anonymous: 0, author_name: "Amina Kamau" } }); assert.deepStrictEqual((await L.getMine(named.pool, student, 5, 8)).review.author, { name: "Amina K." });
    assert.strictEqual((await L.getMine(world({ noReview: true }).pool, student, 5, 99)).notFound, true);
  } finally { restore(); }
  for (const [u, id, st] of [[teacher, 5, "published"], [null, 5, "published"], [student, 6, "published"], [student, 5, "draft"]]) { const z = world({ status: st }); assert.strictEqual((await L.listMine(z.pool, u, id, {})).notFound, true); assert.ok(!has(z, /lms_peer_reviews/)); }
});

test("saveMine: rubric points come from STORED levels, every criterion once, one transaction replacing scores, deadline/start/hidden/closed/archived enforced, nothing written on refusal", async () => {
  withRubric(RUBRIC); try {
    const m = world(); const r = await L.saveMine(m.pool, student, 5, 8, { scores: [{ criterionId: 1, levelPosition: 2 }, { criterionId: 2, levelPosition: 1 }], comment: "Solid" }); assert.deepStrictEqual([r.ok, r.saved, r.totalPoints], [true, true, 7]);
    const w = m.log.find((x) => /UPDATE lms_peer_reviews SET comment/.test(x.sql)); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && /reviewer_id = @vid AND hidden_at IS NULL/.test(w.sql) && /r\.status = 'open'/.test(w.sql) && /DELETE FROM lms_peer_review_scores WHERE review_id = @v/.test(w.sql) && /OPENJSON\(@rows\)/.test(w.sql) && /IF @n = 0 BEGIN ROLLBACK/.test(w.sql));
    assert.deepStrictEqual([w.inputs.vid, w.inputs.v, w.inputs.tp, w.inputs.cm], [30, 8, 7, "Solid"]); assert.deepStrictEqual(JSON.parse(w.inputs.rows), [{ criterionId: 1, levelPosition: 2, points: 6 }, { criterionId: 2, levelPosition: 1, points: 1 }]);
    const forged = world(); await L.saveMine(forged.pool, student, 5, 8, { scores: [{ criterionId: 1, levelPosition: 1 }, { criterionId: 2, levelPosition: 1 }] }); assert.strictEqual(forged.log.find((x) => /UPDATE lms_peer_reviews SET comment/.test(x.sql)).inputs.tp, 3);
    for (const [name, o, code] of [["closed deadline", { rev: { closes_at: future(-1) } }, "ROUND_CLOSED"], ["not started", { rev: { opens_at: future(2) } }, "ROUND_NOT_OPEN"], ["hidden", { rev: { hidden_at: "2026-11-02T00:00:00Z" } }, "REVIEW_HIDDEN"], ["archived course", { status: "archived" }, "COURSE_READ_ONLY"], ["lost race", { saved: 0 }, "ROUND_CLOSED"]]) { const z = world(o); const x = await L.saveMine(z.pool, student, 5, 8, { scores: [{ criterionId: 1, levelPosition: 1 }, { criterionId: 2, levelPosition: 1 }] }); assert.strictEqual(x.code, code, name); if (name !== "lost race") assert.ok(!has(z, /UPDATE lms_peer_reviews SET comment/), name); }
    assert.strictEqual((await L.saveMine(world({ noReview: true }).pool, student, 5, 8, { comment: "x" })).notFound, true); assert.strictEqual((await L.saveMine(world({ status: "draft" }).pool, student, 5, 8, { comment: "x" })).notFound, true);
    for (const b of [{}, { scores: [{ criterionId: 1, levelPosition: 1 }] }, { scores: [{ criterionId: 1, levelPosition: 1 }, { criterionId: 2, levelPosition: 9 }] }, { scores: [{ criterionId: 1, levelPosition: 1 }, { criterionId: 3, levelPosition: 1 }] }]) { const z = world(); assert.strictEqual((await L.saveMine(z.pool, student, 5, 8, b)).ok, false, JSON.stringify(b)); assert.ok(!has(z, /UPDATE lms_peer_reviews SET comment/)); }
    withRubric({ ok: false, notFound: true }); const gone = world(); assert.strictEqual((await L.saveMine(gone.pool, student, 5, 8, { scores: [{ criterionId: 1, levelPosition: 1 }] })).code, "RUBRIC_MISSING");
  } finally { restore(); }
  const plain = world({ rev: { rubric_id: null } }); const p = await L.saveMine(plain.pool, student, 5, 8, { comment: "Well argued" }); assert.deepStrictEqual([p.ok, p.totalPoints], [true, null]); assert.strictEqual(JSON.parse(plain.log.find((x) => /UPDATE lms_peer_reviews SET comment/.test(x.sql)).inputs.rows).length, 0);
  assert.strictEqual((await L.saveMine(world({ rev: { rubric_id: null } }).pool, student, 5, 8, { scores: [{ criterionId: 1, levelPosition: 1 }] })).ok, false);
  for (const u of [teacher, null]) { const z = world(); assert.strictEqual((await L.saveMine(z.pool, u, 5, 8, { comment: "x" })).notFound, true); assert.strictEqual(z.log.length, 0); }
});

test("listReceived: AUTHOR feedback only from CLOSED rounds, done + not hidden, reviewer name only when not anonymous, no ids of reviewers", async () => {
  const m = world(); const r = await L.listReceived(m.pool, student, 5, { assignmentId: "9", pageSize: "999" }); const q = m.log.find((x) => /SELECT v\.id, v\.comment, v\.total_points/.test(x.sql));
  assert.ok(/r\.status = 'closed'/.test(q.sql) && /v\.author_id = @vid AND v\.status = 'done' AND v\.hidden_at IS NULL/.test(q.sql) && /r\.assignment_id = @a/.test(q.sql) && /CASE WHEN r\.anonymous = 1 THEN NULL ELSE rv\.name END/.test(q.sql) && q.inputs.vid === 30 && q.inputs.ps === 50 && q.inputs.a === 9);
  assert.deepStrictEqual([r.items[0].reviewer, r.items[0].comment, r.items[0].totalPoints, r.items[0].scores], [{ name: null }, "Good", 8, [{ criterion: "Ideas", level: "High", points: 6 }]]); assert.ok(!/reviewerId|reviewer_id|"id":3\b/.test(JSON.stringify(r.items[0]).replace('"id":8', "")));
  assert.deepStrictEqual((await L.listReceived(world({ anon: false }).pool, student, 5, {})).items[0].reviewer, { name: "John O." });
  for (const [u, id] of [[teacher, 5], [null, 5], [student, 6]]) { const z = world(); assert.strictEqual((await L.listReceived(z.pool, u, id, {})).notFound, true); assert.ok(!has(z, /lms_peer_reviews/)); }
});

test("staff detail + moderation: names and scores for staff only, hide with reason (audited, no text), un-hide clears, learners refused, archived read only, other round/course = 404", async () => {
  const d = await L.staffGetReview(world({ hidden: true }).pool, teacher, 5, 3, 8); assert.deepStrictEqual([d.review.reviewer.name, d.review.author.name, d.review.hiddenReason, d.review.scores.length, d.review.totalPoints], ["Amina Kamau", "John Otieno", "rude", 1, 8]);
  const dq = world(); await L.staffGetReview(dq.pool, teacher, 5, 3, 8); assert.ok(/v\.id = @v AND v\.round_id = @r AND v\.course_id = @c/.test(dq.log.find((x) => /SELECT TOP 1 v\.id, v\.status, v\.comment, v\.total_points, v\.submitted_at/.test(x.sql)).sql));
  assert.strictEqual((await L.staffGetReview(world({ noReview: true }).pool, teacher, 5, 3, 99)).notFound, true);
  const m = world(); assert.ok((await L.moderateReview(m.pool, teacher, 5, 3, 8, { hidden: true, reason: "abusive" })).ok); const w = m.log.find((x) => /UPDATE lms_peer_reviews SET hidden_at/.test(x.sql));
  assert.ok(/WHERE id = @v AND round_id = @r AND course_id = @c/.test(w.sql) && w.inputs.hid === 1 && w.inputs.why === "abusive" && w.inputs.src === "Teachers"); const a = JSON.stringify(audits(m)[0].inputs); assert.ok(/peer_review\.moderated/.test(a) && !/abusive/.test(a));
  const u = world(); await L.moderateReview(u.pool, teacher, 5, 3, 8, { hidden: false }); assert.deepStrictEqual([u.log.find((x) => /SET hidden_at/.test(x.sql)).inputs.hid, u.log.find((x) => /SET hidden_at/.test(x.sql)).inputs.why], [0, null]);
  assert.strictEqual((await L.moderateReview(world({ status: "archived" }).pool, teacher, 5, 3, 8, { hidden: true })).code, "COURSE_READ_ONLY"); assert.strictEqual((await L.moderateReview(world({ noReview: true }).pool, teacher, 5, 3, 8, { hidden: true })).notFound, true);
  for (const b of [{}, { hidden: "y" }, { hidden: false, reason: "x" }, { hidden: true, reason: "x".repeat(301) }, { hidden: true, x: 1 }, null]) { const z = world(); assert.strictEqual((await L.moderateReview(z.pool, teacher, 5, 3, 8, b)).ok, false, JSON.stringify(b)); assert.ok(!has(z, /UPDATE lms_peer_reviews/)); }
  for (const uu of [student, null]) { const z = world(); assert.strictEqual((await L.staffGetReview(z.pool, uu, 5, 3, 8)).notFound, true); assert.strictEqual((await L.moderateReview(z.pool, uu, 5, 3, 8, { hidden: true })).notFound, true); assert.strictEqual(z.log.length, 0); }
});

test("routes + tenant isolation: learner routes studentOnly + studentAccess ('received' is matched before ':reviewId'), staff detail read-only for staff, moderation course.manage; shapes and codes", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), PR = "/courses/:courseId/peer-rounds", PRL = "/courses/:courseId/learn/peer-reviews", find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const lr = [["get", PRL], ["get", `${PRL}/received`], ["get", `${PRL}/:reviewId`], ["put", `${PRL}/:reviewId`]].map(([m, p]) => find(m, p)); assert.ok(lr.every((r) => r && r.route.stack.length === 4));
  const order = router.stack.filter((l) => l.route && l.route.path.startsWith(PRL) && l.route.methods.get).map((l) => l.route.path); assert.ok(order.indexOf(`${PRL}/received`) < order.indexOf(`${PRL}/:reviewId`));
  const sd = find("get", `${PR}/:roundId/reviews/:reviewId`), sm = find("put", `${PR}/:roundId/reviews/:reviewId/moderation`); assert.ok(sd.route.stack.length === 3 && sm.route.stack.length === 4); assert.ok(/reviewId\/moderation`, dGate, gbManage, staffAccess/.test(src));
  assert.ok(!find("post", PRL) && !find("delete", `${PRL}/:reviewId`) && !find("put", `${PR}/:roundId/reviews/:reviewId`), "no learner create/delete, no staff edit of review text");
  withRubric(RUBRIC); try { const res = makeRes(); await lr[3].route.stack[3].handle({ pool: world().pool, user: student, params: { courseId: "5", reviewId: "8" }, body: { scores: [{ criterionId: 1, levelPosition: 2 }, { criterionId: 2, levelPosition: 2 }] }, tenant: "t" }, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.totalPoints, "ok" in res.body], [200, true, 10, false]);
    const r2 = makeRes(); await lr[3].route.stack[3].handle({ pool: world({ rev: { closes_at: future(-1) } }).pool, user: student, params: { courseId: "5", reviewId: "8" }, body: { comment: "x" }, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.code], [409, "ROUND_CLOSED"]);
    const r3 = makeRes(); await lr[2].route.stack[3].handle({ pool: world({ noReview: true }).pool, user: student, params: { courseId: "5", reviewId: "8" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404); } finally { restore(); }
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await L.listMine(T.A.pool, student, 5, {})).notFound, true); assert.strictEqual((await L.saveMine(T.A.pool, student, 5, 8, { comment: "x" })).notFound, true); assert.strictEqual((await L.listReceived(T.A.pool, student, 5, {})).notFound, true); assert.strictEqual((await L.moderateReview(T.A.pool, teacher, 5, 3, 8, { hidden: true })).notFound, true); T.assertUntouched("B");
  const m = world(); withRubric(RUBRIC); try { await L.getMine(m.pool, student, 5, 8); await L.listMine(m.pool, student, 5, {}); await L.listReceived(m.pool, student, 5, {}); await L.staffGetReview(m.pool, teacher, 5, 3, 8); } finally { restore(); }
  for (const x of m.log.filter((y) => /lms_peer_reviews v/.test(y.sql))) assert.ok(/v\.course_id = @c/.test(x.sql), `unscoped: ${x.sql.slice(0, 80)}`);
});
