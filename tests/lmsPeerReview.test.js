/* L8.3a - peer review rounds + allocation, staff side (D-100): validation, reproducible fair allocation (property checks), create/update/remove (draft only), open (dry run, one transaction,
   frozen), close, staff review list, gates, tenant isolation. Mocked pool only: OPENJSON batch, filtered unique index, latest-attempt subquery NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsPeerReview.test.js");
const P = require("../utils/lmsPeerReview");
const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" };
const subs = (n) => Array.from({ length: n }, (_, i) => ({ student_id: 100 + i * 3, submission_id: 500 + i }));
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["SELECT TOP 1 id, work_mode FROM lms_assignments", (i) => (i.c === 5 && !o.noAssignment ? [{ id: i.a, work_mode: o.groupWork ? "group" : "individual" }] : [])],
  ["SELECT TOP 1 id FROM lms_rubrics", () => (o.noRubric ? [] : [{ id: 4 }])],
  ["INSERT INTO lms_peer_review_rounds", () => (o.exists ? [] : [{ id: 3 }])],
  ["UPDATE lms_peer_review_rounds SET status = 'open'", () => [{ made: o.made ?? 12 }]],
  ["UPDATE lms_peer_review_rounds SET status = 'closed'", () => (o.status2 === "draft" ? [] : [{ id: 3 }])],
  ["UPDATE lms_peer_review_rounds SET deleted_at", () => (o.rstatus && o.rstatus !== "draft" ? [] : [{ id: 3 }])],
  ["UPDATE lms_peer_review_rounds SET ", () => [{ id: 3 }]],
  ["SELECT TOP 1 r.id, r.assignment_id", () => (o.noRound ? [] : [{ id: 3, assignment_id: 9, title: "R1", reviews_per_learner: o.k ?? 2, anonymous: 1, rubric_id: null, opens_at: null, closes_at: null, status: o.rstatus || "draft", opened_at: null, closed_at: null, created_at: "2026-11-01T00:00:00Z", seed: "abc", review_count: 0, done_count: 0 }])],
  ["FROM lms_submissions s", () => o.authors || subs(o.n ?? 6)],
  ["SELECT COUNT(*) AS n FROM lms_peer_review_rounds r", () => [{ n: 2 }]],
  ["SELECT r.id, r.assignment_id", () => [{ id: 3, assignment_id: 9, title: "R1", reviews_per_learner: 2, anonymous: 1, rubric_id: null, opens_at: null, closes_at: null, status: "open", opened_at: null, closed_at: null, created_at: "2026-11-01T00:00:00Z", review_count: 12, done_count: 4 }]],
  ["SELECT COUNT(*) AS n FROM lms_peer_reviews v", () => [{ n: 12 }]],
  ["FROM lms_peer_reviews v LEFT JOIN Students", () => [{ id: 1, status: "done", total_points: "7.5", submitted_at: "2026-11-02T00:00:00Z", hidden_at: null, hidden_reason: null, reviewer_name: "Amina Kamau", reviewer_adm: "A1", author_name: "John Otieno", author_adm: "A2" }]]]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const has = (m, re) => m.log.some((x) => re.test(x.sql));

test("validateRound / validateOpen (pure): required assignment, 1-5 reviews, booleans, dates in order, unknown fields, edit needs a change", () => {
  const v = (b, e) => P.validateRound(b, e);
  assert.deepStrictEqual(v({ assignmentId: 9, title: " Peer  round " }).value, { assignmentId: 9, title: "Peer round" });
  const full = v({ assignmentId: 9, title: "T", reviewsPerLearner: 3, anonymous: false, rubricId: null, opensAt: "2026-11-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }).value; assert.deepStrictEqual([full.reviewsPerLearner, full.anonymous, full.rubricId, full.closesAt instanceof Date], [3, false, null, true]);
  for (const b of [{}, { title: "T" }, { assignmentId: 0, title: "T" }, { assignmentId: 9 }, { assignmentId: 9, title: "T", reviewsPerLearner: 0 }, { assignmentId: 9, title: "T", reviewsPerLearner: 6 }, { assignmentId: 9, title: "T", reviewsPerLearner: 1.5 }, { assignmentId: 9, title: "T", anonymous: "y" }, { assignmentId: 9, title: "T", rubricId: "x" }, { assignmentId: 9, title: "T", opensAt: "soon" }, { assignmentId: 9, title: "T", opensAt: "2026-11-05T00:00:00Z", closesAt: "2026-11-01T00:00:00Z" }, { assignmentId: 9, title: "x".repeat(201) }, { assignmentId: 9, title: "T", x: 1 }, null, []]) assert.strictEqual(v(b).ok, false, JSON.stringify(b));
  assert.strictEqual(v({}, true).ok, false); assert.strictEqual(v({ assignmentId: 9 }, true).ok, false); assert.strictEqual(v({ anonymous: false }, true).ok, true); assert.strictEqual(v({ title: "" }, true).ok, false);
  const o = P.validateOpen; assert.deepStrictEqual(o(undefined).value, {}); assert.deepStrictEqual(o({ dryRun: true, seed: "s1" }).value, { dryRun: true, seed: "s1" }); assert.strictEqual(o({ seed: 12 }).value.seed, "12");
  for (const b of [{ dryRun: "y" }, { seed: "" }, { seed: "x".repeat(51) }, { seed: {} }, { other: 1 }, [], "x"]) assert.strictEqual(o(b).ok, false, JSON.stringify(b));
});

test("planPeerAllocation (pure): everybody reviews AND receives exactly min(k, n-1), nobody reviews themselves or the same piece twice, same seed = same plan, other seeds differ, <2 authors refused", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ studentId: 10 + i * 7, submissionId: 900 + i }));
  for (let n = 2; n <= 40; n += 1) for (let k = 1; k <= 5; k += 1) {
    const a = mk(n), pl = P.planPeerAllocation(a, k, `seed-${n}-${k}`), eff = Math.min(k, n - 1); assert.ok(pl.ok && pl.effective === eff && pl.pairs.length === n * eff, `n=${n} k=${k}`);
    const gave = new Map(), got = new Map(), seen = new Set();
    for (const p of pl.pairs) { assert.notStrictEqual(p.reviewerId, p.authorId, "self review"); const key = `${p.reviewerId}:${p.submissionId}`; assert.ok(!seen.has(key), "duplicate pair"); seen.add(key);
      assert.strictEqual(p.submissionId, 900 + a.findIndex((x) => x.studentId === p.authorId), "submission belongs to the author"); gave.set(p.reviewerId, (gave.get(p.reviewerId) || 0) + 1); got.set(p.authorId, (got.get(p.authorId) || 0) + 1); }
    assert.ok(a.every((x) => gave.get(x.studentId) === eff && got.get(x.studentId) === eff), `fair n=${n} k=${k}`);
  }
  const a = mk(12), s1 = P.planPeerAllocation(a, 3, "alpha"), shuffled = [...a].reverse();
  assert.deepStrictEqual(P.planPeerAllocation(shuffled, 3, "alpha").pairs, s1.pairs, "input order does not matter"); assert.deepStrictEqual(P.planPeerAllocation(a, 3, "alpha").pairs, s1.pairs);
  assert.notDeepStrictEqual(P.planPeerAllocation(a, 3, "beta").pairs, s1.pairs);
  for (const n of [0, 1]) { const r = P.planPeerAllocation(mk(n), 2, "x"); assert.deepStrictEqual([r.ok, r.pairs.length], [false, 0]); }
});

test("createRound: assignment and rubric must belong to THIS course, one live round per assignment (guard + 409), audited, archived read only, learners/strangers refused, bad bodies cost nothing", async () => {
  const m = world(); const r = await P.createRound(m.pool, teacher, 5, { assignmentId: 9, title: "R1", reviewsPerLearner: 3, anonymous: false, rubricId: 4 }); assert.deepStrictEqual([r.ok, r.id], [true, 3]);
  const w = m.log.find((x) => /INSERT INTO lms_peer_review_rounds/.test(x.sql)); assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_peer_review_rounds WITH \(UPDLOCK, HOLDLOCK\) WHERE assignment_id = @a AND deleted_at IS NULL\)/.test(w.sql) && w.inputs.k === 3 && w.inputs.an === 0 && w.inputs.rb === 4 && w.inputs.c === 5 && w.inputs.src === "Teachers");
  assert.ok(/course_id = @c AND deleted_at IS NULL/.test(m.log.find((x) => /FROM lms_assignments/.test(x.sql)).sql) && /course_id = @c AND deleted_at IS NULL/.test(m.log.find((x) => /FROM lms_rubrics/.test(x.sql)).sql)); assert.ok(/peer_round\.created/.test(JSON.stringify(audits(m)[0].inputs)));
  const d = world(); await P.createRound(d.pool, teacher, 5, { assignmentId: 9, title: "R" }); const dw = d.log.find((x) => /INSERT INTO lms_peer_review_rounds/.test(x.sql)); assert.deepStrictEqual([dw.inputs.k, dw.inputs.an], [2, 1]);
  assert.strictEqual((await P.createRound(world({ noAssignment: true }).pool, teacher, 5, { assignmentId: 9, title: "R" })).notFound, true); const nr = world({ noRubric: true }); assert.strictEqual((await P.createRound(nr.pool, teacher, 5, { assignmentId: 9, title: "R", rubricId: 4 })).notFound, true); assert.ok(!has(nr, /INSERT INTO lms_peer_review_rounds/));
  assert.strictEqual((await P.createRound(world({ exists: true }).pool, teacher, 5, { assignmentId: 9, title: "R" })).code, "ROUND_EXISTS");
  const dup = makeMockPool([["SELECT TOP 1 status FROM lms_courses", () => [{ status: "published" }]], ["SELECT TOP 1 id, work_mode FROM lms_assignments", () => [{ id: 9, work_mode: "individual" }]], ["INSERT INTO lms_peer_review_rounds", () => { const e = new Error("dup"); e.number = 2601; throw e; }]]); assert.strictEqual((await P.createRound(dup.pool, teacher, 5, { assignmentId: 9, title: "R" })).code, "ROUND_EXISTS");
  assert.strictEqual((await P.createRound(world({ status: "archived" }).pool, teacher, 5, { assignmentId: 9, title: "R" })).code, "COURSE_READ_ONLY");
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await P.createRound(z.pool, u, id, { assignmentId: 9, title: "R" })).notFound, true); assert.ok(!has(z, /INSERT INTO lms_peer_review_rounds/)); }
  const bad = world(); assert.strictEqual((await P.createRound(bad.pool, teacher, 5, { title: "R" })).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("updateRound / removeRound: DRAFT only (checked in the UPDATE too), rubric must belong to the course, audited", async () => {
  const m = world(); assert.ok((await P.updateRound(m.pool, teacher, 5, 3, { title: "New", reviewsPerLearner: 4, rubricId: 4 })).ok); const w = m.log.find((x) => /UPDATE lms_peer_review_rounds SET title/.test(x.sql));
  assert.ok(/course_id = @c AND deleted_at IS NULL AND status = 'draft'/.test(w.sql) && w.inputs.t === "New" && w.inputs.k === 4 && w.inputs.rb === 4); assert.ok(/peer_round\.updated/.test(JSON.stringify(audits(m)[0].inputs)));
  const o = world({ rstatus: "open" }); assert.strictEqual((await P.updateRound(o.pool, teacher, 5, 3, { title: "x" })).code, "ROUND_LOCKED"); assert.ok(!has(o, /UPDATE lms_peer_review_rounds SET title/));
  assert.strictEqual((await P.updateRound(world({ noRound: true }).pool, teacher, 5, 3, { title: "x" })).notFound, true); assert.strictEqual((await P.updateRound(world({ noRubric: true }).pool, teacher, 5, 3, { rubricId: 4 })).notFound, true);
  const r = world(); assert.deepStrictEqual([(await P.removeRound(r.pool, teacher, 5, 3)).removed, /status = 'draft'/.test(r.log.find((x) => /deleted_at = SYSUTCDATETIME/.test(x.sql)).sql), !has(r, /DELETE FROM/)], [true, true, true]);
  assert.strictEqual((await P.removeRound(world({ rstatus: "open" }).pool, teacher, 5, 3)).code, "ROUND_LOCKED"); assert.strictEqual((await P.removeRound(world({ noRound: true, rstatus: "open" }).pool, teacher, 5, 3)).notFound, true);
  for (const u of [student, null]) { const z = world(); assert.strictEqual((await P.updateRound(z.pool, u, 5, 3, { title: "x" })).notFound, true); assert.strictEqual((await P.removeRound(z.pool, u, 5, 3)).notFound, true); assert.strictEqual(z.log.length, 0); }
});

test("openRound: dry run writes nothing; real open = ONE transaction (round -> open + review rows via OPENJSON), only active submitted learners' LATEST attempt, seed stored + audited, never automatic, needs 2+ submissions", async () => {
  const dry = world(); const d = await P.openRound(dry.pool, teacher, 5, 3, { dryRun: true, seed: "S1" }); assert.deepStrictEqual([d.ok, d.dryRun, d.seed, d.authors, d.reviewsPerLearner, d.reviews], [true, true, "S1", 6, 2, 12]);
  assert.ok(!has(dry, /UPDATE lms_peer_review_rounds|INSERT INTO lms_peer_reviews/) && audits(dry).length === 0);
  const m = world(); const r = await P.openRound(m.pool, teacher, 5, 3, { seed: "S1" }); assert.deepStrictEqual([r.ok, r.seed, r.reviews], [true, "S1", 12]);
  const a = m.log.find((x) => /FROM lms_submissions s/.test(x.sql)).sql; assert.ok(/e\.status = 'active'/.test(a) && /s\.status IN \('submitted', 'returned'\)/.test(a) && /MAX\(z\.attempt_no\)/.test(a) && /s\.assignment_id = @a AND s\.course_id = @c/.test(a));
  const w = m.log.find((x) => /UPDATE lms_peer_review_rounds SET status = 'open'/.test(x.sql)); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && /status = 'draft'/.test(w.sql) && /IF @n = 0 BEGIN ROLLBACK/.test(w.sql) && /INSERT INTO lms_peer_reviews \(round_id, course_id, reviewer_id, author_id, submission_id\)/.test(w.sql) && /OPENJSON\(@pairs\)/.test(w.sql) && /COMMIT/.test(w.sql) && w.inputs.seed === "S1");
  assert.strictEqual(JSON.parse(w.inputs.pairs).length, 12); const au = JSON.stringify(audits(m)[0].inputs); assert.ok(/peer_round\.opened/.test(au) && /S1/.test(au) && !/reviewerId/.test(au));
  const again = world(); await P.openRound(again.pool, teacher, 5, 3, { seed: "S1" }); assert.strictEqual(again.log.find((x) => /SET status = 'open'/.test(x.sql)).inputs.pairs, w.inputs.pairs, "same learners + seed = same allocation");
  const other = world(); await P.openRound(other.pool, teacher, 5, 3, { seed: "S2" }); assert.notStrictEqual(other.log.find((x) => /SET status = 'open'/.test(x.sql)).inputs.pairs, w.inputs.pairs);
  const rnd = world(); const rr = await P.openRound(rnd.pool, teacher, 5, 3, {}); assert.ok(/^[0-9a-f]{8}$/.test(rr.seed));
  const few = world({ n: 1 }); assert.strictEqual((await P.openRound(few.pool, teacher, 5, 3, {})).code, "NOT_ENOUGH_SUBMISSIONS"); assert.ok(!has(few, /SET status = 'open'/));
  const small = world({ n: 3, k: 5 }); const sm = await P.openRound(small.pool, teacher, 5, 3, { dryRun: true }); assert.deepStrictEqual([sm.reviewsPerLearner, sm.requested, sm.reviews], [2, 5, 6]);
  const op = world({ rstatus: "open" }); assert.strictEqual((await P.openRound(op.pool, teacher, 5, 3, {})).code, "ROUND_LOCKED"); assert.ok(!has(op, /FROM lms_submissions/));
  assert.strictEqual((await P.openRound(world({ made: 0 }).pool, teacher, 5, 3, {})).code, "ROUND_LOCKED");
  assert.strictEqual((await P.openRound(world({ n: 2001 }).pool, teacher, 5, 3, {})).code, "TOO_MANY_LEARNERS"); assert.strictEqual((await P.openRound(world({ status: "archived" }).pool, teacher, 5, 3, {})).code, "COURSE_READ_ONLY");
  for (const b of [{ dryRun: "y" }, { seed: "" }, { x: 1 }]) { const z = world(); assert.strictEqual((await P.openRound(z.pool, teacher, 5, 3, b)).ok, false); assert.strictEqual(z.log.length, 0); }
  for (const u of [student, null]) { const z = world(); assert.strictEqual((await P.openRound(z.pool, u, 5, 3, {})).notFound, true); assert.strictEqual(z.log.length, 0); }
});

test("closeRound: only an open round; audited; lists: rounds paged with review counts, reviews with names + admission numbers for STAFF only", async () => {
  const m = world(); assert.ok((await P.closeRound(m.pool, teacher, 5, 3)).closed); assert.ok(/status = 'open'/.test(m.log.find((x) => /SET status = 'closed'/.test(x.sql)).sql) && /peer_round\.closed/.test(JSON.stringify(audits(m)[0].inputs)));
  assert.strictEqual((await P.closeRound(world({ status2: "draft" }).pool, teacher, 5, 3)).code, "ROUND_LOCKED"); assert.strictEqual((await P.closeRound(world({ status2: "draft", noRound: true }).pool, teacher, 5, 3)).notFound, true);
  const l = world(); const r = await P.listRounds(l.pool, teacher, 5, { pageSize: "999", assignmentId: "9" }); assert.deepStrictEqual([r.total, r.pageSize, r.items[0].reviews, r.items[0].done, r.items[0].status], [2, 50, 12, 4, "open"]);
  const sql = l.log.find((x) => /OFFSET/.test(x.sql)); assert.ok(/r\.course_id = @c AND r\.deleted_at IS NULL AND r\.assignment_id = @a/.test(sql.sql) && sql.inputs.ps === 50 && sql.inputs.a === 9);
  const g = await P.getRound(world().pool, teacher, 5, 3); assert.strictEqual(g.round.seed, "abc");
  const v = world(); const rv = await P.listReviews(v.pool, teacher, 5, 3, { status: "done" }); assert.deepStrictEqual([rv.total, rv.items[0].reviewer, rv.items[0].author, rv.items[0].totalPoints], [12, { name: "Amina Kamau", admissionNumber: "A1" }, { name: "John Otieno", admissionNumber: "A2" }, 7.5]);
  assert.ok(/v\.round_id = @r AND v\.course_id = @c AND v\.status = @st/.test(v.log.find((x) => /OFFSET/.test(x.sql)).sql));
  for (const u of [student, null]) for (const fn of [(p) => P.listRounds(p, u, 5, {}), (p) => P.getRound(p, u, 5, 3), (p) => P.listReviews(p, u, 5, 3, {})]) { const z = world(); assert.strictEqual((await fn(z.pool)).notFound, true); assert.strictEqual(z.log.length, 0); }
  assert.strictEqual((await P.listReviews(world({ noRound: true }).pool, teacher, 5, 3, {})).notFound, true);
});

test("schema step 037 + blocklist + routes + tenant isolation", async () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("037_lms_peer_review"); assert.ok(i === ids.length - 9 && ids[i - 1] === "036_lms_group_forums" && ids[i + 1] === "038_lms_group_submissions");
  const t = schema.STEPS[i].sql.join("\n"); for (const n of ["lms_peer_review_rounds", "lms_peer_reviews", "lms_peer_review_scores"]) assert.ok(new RegExp(`name='${n}'`).test(t), n);
  assert.ok(!/DROP |DELETE FROM/i.test(t) && /UX_lms_peer_rounds_assignment ON lms_peer_review_rounds \(assignment_id\) WHERE deleted_at IS NULL/.test(t) && /UX_lms_peer_reviews_pair ON lms_peer_reviews \(round_id, reviewer_id, submission_id\)/.test(t) && /UX_lms_peer_scores_one ON lms_peer_review_scores \(review_id, criterion_id\)/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_peer_review_rounds", "lms_peer_reviews", "lms_peer_review_scores"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), PR = "/courses/:courseId/peer-rounds", find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const reads = [["get", PR], ["get", `${PR}/:roundId`], ["get", `${PR}/:roundId/reviews`]].map(([m, p]) => find(m, p)), writes = [["post", PR], ["patch", `${PR}/:roundId`], ["delete", `${PR}/:roundId`], ["post", `${PR}/:roundId/open`], ["post", `${PR}/:roundId/close`]].map(([m, p]) => find(m, p));
  assert.ok(reads.every((r) => r && r.route.stack.length === 3) && writes.every((r) => r && r.route.stack.length === 4)); assert.strictEqual((src.match(/peer\.\w+\(req\.pool/g) || []).length, 8); assert.ok(/PR\}\/:roundId\/open`, dGate, gbManage, staffAccess/.test(src) && /router\.post\(PR, dGate, gbManage, staffAccess/.test(src));
  const res = makeRes(); await writes[0].route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "5" }, body: { assignmentId: 9, title: "R" }, tenant: "t" }, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.id, "ok" in res.body], [201, true, 3, false]);
  const r2 = makeRes(); await writes[3].route.stack[3].handle({ pool: world({ rstatus: "open" }).pool, user: teacher, params: { courseId: "5", roundId: "3" }, body: {}, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.code], [409, "ROUND_LOCKED"]);
  const r3 = makeRes(); await writes[3].route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "5", roundId: "3" }, body: { dryRun: true, seed: "S" }, tenant: "t" }, r3); assert.deepStrictEqual([r3.statusCode, r3.body.dryRun, r3.body.authors], [200, true, 6]);
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await P.listRounds(T.A.pool, teacher, 5, {})).notFound, true); assert.strictEqual((await P.openRound(T.A.pool, teacher, 5, 3, {})).notFound, true); assert.strictEqual((await P.createRound(T.A.pool, teacher, 5, { assignmentId: 9, title: "R" })).notFound, true); T.assertUntouched("B");
  const m = world(); await P.getRound(m.pool, teacher, 5, 3); await P.listReviews(m.pool, teacher, 5, 3, {}); await P.closeRound(m.pool, teacher, 5, 3); await P.openRound(m.pool, teacher, 5, 3, { dryRun: true });
  for (const x of m.log.filter((y) => /lms_peer_review/.test(y.sql))) assert.ok(/course_id = @c/.test(x.sql), `unscoped: ${x.sql.slice(0, 80)}`);
});
