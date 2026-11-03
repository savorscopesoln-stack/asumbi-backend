/* L6.4 - results adapter (D-083, contract B): eligibility, best-attempt picking, one atomic idempotent publish into Assessments/Marks, dry run, isolation, route gates.
   Mocked pool only: SQL syntax (OPENJSON, table variable, SCOPE_IDENTITY, UPDLOCK/HOLDLOCK) NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsResultsAdapter.test.js");
const R = require("../utils/lmsResultsAdapter");
const P = require("../utils/lmsPermissions");
const events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const QUIZ = (o = {}) => ({ assessmentType: "coursework", status: "published", countsToGrade: true, mode: "quiz", ...o });
const COURSE = (o = {}) => ({ id: 5, academicYear: 2026, semester: "Term 2", className: "Form 3 A", subjectId: 12, ...o });
const ctxRow = (o = {}) => ({ id: 4, title: "CAT 1", assessment_type: "coursework", status: "published", counts_to_grade: 1, quiz_mode: "quiz", course_id: 5, academic_year: 2026, semester: "Term 2", class_name: "Form 3 A", subject_id: 12, ...o });
const ctxQ = (row = ctxRow()) => ["FROM lms_quizzes z JOIN lms_courses c ON c.id = z.course_id", (i) => (i.c === 5 && i.z === 4 && row ? [row] : [])];
const subjQ = (ok = true) => ["SELECT TOP 1 id FROM subjects WHERE id = @s", (i) => (ok && i.s === 12 ? [{ id: 12 }] : [])];
const clsQ = (ok = true) => ["SELECT TOP 1 id FROM Classes WHERE name = @n", (i) => (ok && i.n === "Form 3 A" ? [{ id: 3 }] : [])];
const ATT = [
  { student_id: 30, attempt_no: 1, status: "graded", total_points: 6, max_points: 10 },
  { student_id: 30, attempt_no: 2, status: "graded", total_points: 8.5, max_points: 10 },
  { student_id: 31, attempt_no: 1, status: "graded", total_points: 10, max_points: 10 },
  { student_id: 32, attempt_no: 1, status: "submitted", total_points: null, max_points: 10 },
  { student_id: 33, attempt_no: 1, status: "graded", total_points: 1, max_points: 3 },
];
const attQ = (rows = ATT) => ["FROM lms_quiz_attempts a JOIN lms_course_enrolments e", (i) => (i.c === 5 && i.z === 4 ? rows : [])];
const writeQ = (inserted = 3, updated = 0, aid = 77) => ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @aid INT", () => [{ assessment_id: aid, inserted, updated }]];
const setup = (extra = [], o = {}) => makeMockPool([ctxQ(o.ctx), subjQ(o.subj), clsQ(o.cls), attQ(o.att), ...extra]);
const writeOf = (m) => m.log.find((x) => /SET XACT_ABORT ON; BEGIN TRAN/.test(x.sql));

test("checkPublishable: only a published coursework quiz that counts, in quiz/mock mode, on a mapped course", () => {
  assert.strictEqual(R.checkPublishable(QUIZ(), COURSE()), null);
  assert.strictEqual(R.checkPublishable(QUIZ({ mode: "mock" }), COURSE()), null, "a mock that is coursework and counts may publish");
  for (const q of [QUIZ({ assessmentType: "practice" }), QUIZ({ countsToGrade: false }), QUIZ({ mode: "revision" }), QUIZ({ mode: "flashcards" })]) assert.strictEqual(R.checkPublishable(q, COURSE()).code, "PRACTICE_NOT_PUBLISHABLE");
  assert.strictEqual(R.checkPublishable(QUIZ({ status: "draft" }), COURSE()).code, "QUIZ_NOT_PUBLISHED");
  assert.strictEqual(R.checkPublishable(QUIZ(), COURSE({ subjectId: null })).code, "NO_RESULTS_MAPPING");
  assert.strictEqual(R.checkPublishable(QUIZ(), COURSE({ className: "  " })).code, "NO_RESULTS_MAPPING");
  assert.strictEqual(R.checkPublishable(null, COURSE()).notFound, true);
});

test("pickScores: best graded attempt per learner, 2 decimals, ties keep the earlier attempt, unmarked learners skipped, zero-point quizzes skipped", () => {
  const { rows, skipped } = R.pickScores(ATT);
  assert.deepStrictEqual(rows.map((r) => [r.studentId, r.score, r.percentage, r.attemptNo]), [[30, 85, 85, 2], [31, 100, 100, 1], [33, 33, 33.33, 1]]);
  assert.deepStrictEqual(skipped, [{ studentId: 32, reason: "NEEDS_MARKING" }]);
  const tie = R.pickScores([{ student_id: 1, attempt_no: 2, status: "graded", total_points: 5, max_points: 10 }, { student_id: 1, attempt_no: 1, status: "graded", total_points: 5, max_points: 10 }]);
  assert.strictEqual(tie.rows[0].attemptNo, 1);
  const pend = R.pickScores([{ student_id: 1, attempt_no: 1, status: "graded", total_points: 2, max_points: 10 }, { student_id: 1, attempt_no: 2, status: "submitted", total_points: null, max_points: 10 }]);
  assert.deepStrictEqual([pend.rows, pend.skipped], [[], [{ studentId: 1, reason: "NEEDS_MARKING" }]], "a pending attempt blocks a provisional lower mark");
  const later = R.pickScores([{ student_id: 9, attempt_no: 1, status: "graded", total_points: 9, max_points: 10 }, { student_id: 9, attempt_no: 2, status: "graded", total_points: 4, max_points: 10 }]);
  assert.deepStrictEqual([later.rows[0].percentage, later.rows[0].attemptNo], [90, 1], "a later, LOWER attempt never replaces the best one");
  assert.deepStrictEqual(R.pickScores([{ student_id: 2, attempt_no: 1, status: "graded", total_points: 0, max_points: 0 }]).skipped, [{ studentId: 2, reason: "NO_POINTS" }]);
  assert.strictEqual(R.pickScores([{ student_id: 2, attempt_no: 1, status: "graded", total_points: 15, max_points: 10 }]).rows[0].percentage, 100, "never above 100");
  assert.deepStrictEqual(R.pickScores([{ student_id: "x", attempt_no: 1, status: "graded", total_points: 1, max_points: 2 }, { student_id: 5, attempt_no: 1, status: "in_progress" }]), { rows: [], skipped: [] });
});

test("publish: one atomic batch, parameters only, this source only, rows travel as one JSON parameter; counts, audit and event", async () => {
  const seen = []; const off = events.on("lms.results.published", (e) => { if (e.tenant === "ra-a") seen.push(e); });
  const m = setup([writeQ(3, 0)]);
  const r = await R.publishQuizResults(m.pool, teacher, 5, 4, {}, { tenant: "ra-a" }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.assessmentId, r.inserted, r.updated, r.unchanged, r.totalMarks], [77, 3, 0, 0, 100]);
  assert.deepStrictEqual(r.skipped, [{ studentId: 32, reason: "NEEDS_MARKING" }]); assert.strictEqual(r.skippedCount, 1);
  const c = m.log[0]; assert.ok(/z\.id = @z AND z\.course_id = @c AND z\.deleted_at IS NULL AND c\.deleted_at IS NULL/.test(c.sql), "quiz matched together with its course, live rows only");
  const w = writeOf(m); assert.ok(w, "the write batch ran");
  assert.ok(/WITH \(UPDLOCK, HOLDLOCK\)/.test(w.sql) && /sourceSystem = @src AND sourceRefId = @q/.test(w.sql) && /COMMIT;/.test(w.sql), "lock + lookup by source + commit");
  assert.ok(!/DELETE/i.test(w.sql), "no Marks row is ever deleted"); assert.ok(/WHERE m\.assessmentId = @aid/.test(w.sql) && /WHERE NOT EXISTS \(SELECT 1 FROM Marks m WHERE m\.assessmentId = @aid/.test(w.sql), "only this assessment's marks");
  assert.deepStrictEqual([w.inputs.q, w.inputs.src, w.inputs.subj, w.inputs.tm, w.inputs.cls, w.inputs.term, w.inputs.yr, w.inputs.atype], [4, "lms_quiz", 12, 100, "Form 3 A", "Term 2", "2026", "LMS Quiz"]);
  assert.deepStrictEqual(JSON.parse(w.inputs.rows), [{ s: 30, sc: 85, p: 85 }, { s: 31, sc: 100, p: 100 }, { s: 33, sc: 33, p: 33.33 }]);
  assert.ok(!/lms_quiz'|CAT 1|Form 3 A/.test(w.sql), "values are parameters, not in the SQL text");
  const a = m.log.find((x) => /lms_audit_log/.test(x.sql)); assert.ok(a, "audited"); assert.ok(/results\.published/.test(JSON.stringify(a.inputs)));
  assert.ok(!/"s":|studentId/.test(JSON.stringify(a.inputs)), "audit holds ids and counts only, never per-learner marks");
  await tick(); off && off(); assert.strictEqual(seen.length, 1); assert.deepStrictEqual([seen[0].quizId, seen[0].assessmentId, seen[0].inserted], [4, 77, 3]);
  assert.ok(!JSON.stringify(seen[0]).match(/score|percentage|studentId/), "event carries ids and counts only");
});

test("publish twice = identical result: the second run reports every learner unchanged and creates nothing new", async () => {
  const m = setup([writeQ(0, 0)]); const r = await R.publishQuizResults(m.pool, teacher, 5, 4, undefined, {}); assert.ok(r.ok);
  assert.deepStrictEqual([r.inserted, r.updated, r.unchanged], [0, 0, 3]);
  const m2 = setup([writeQ(0, 2)]); const r2 = await R.publishQuizResults(m2.pool, teacher, 5, 4, {}, {}); assert.deepStrictEqual([r2.inserted, r2.updated, r2.unchanged], [0, 2, 1], "a corrected grade updates, the rest stay unchanged");
  assert.ok(/ABS\(m\.percentage - r\.pct\) > 0\.001/.test(writeOf(m2).sql), "update only when the mark really differs");
});

test("dryRun: reports who would be published and who is skipped, writes NOTHING, no audit, no event", async () => {
  const seen = []; const off = events.on("lms.results.published", (e) => { if (e.tenant === "ra-dry") seen.push(e); });
  const m = setup([writeQ()]); const r = await R.publishQuizResults(m.pool, teacher, 5, 4, { dryRun: true }, { tenant: "ra-dry" });
  assert.deepStrictEqual([r.ok, r.dryRun, r.eligible, r.skippedCount], [true, true, 3, 1]);
  assert.ok(!writeOf(m) && !m.log.some((x) => /lms_audit_log/.test(x.sql)), "no write, no audit"); await tick(); off && off(); assert.strictEqual(seen.length, 0);
  assert.ok(!(await R.publishQuizResults(setup().pool, teacher, 5, 4, { dryRun: "yes" }, {})).ok, "dryRun must be a boolean");
  assert.ok(!(await R.publishQuizResults(setup().pool, teacher, 5, 4, [1], {})).ok, "body must be an object");
});

test("409 codes: practice never reaches the attempts or the write; unmapped course, unknown subject/class, nothing marked yet, too many learners", async () => {
  const none = (m) => assert.ok(!writeOf(m) && !m.log.some((x) => /lms_quiz_attempts/.test(x.sql)));
  for (const row of [ctxRow({ assessment_type: "practice" }), ctxRow({ counts_to_grade: 0 }), ctxRow({ quiz_mode: "revision" }), ctxRow({ quiz_mode: "flashcards" })]) { const m = setup([writeQ()], { ctx: row }); const r = await R.publishQuizResults(m.pool, teacher, 5, 4, {}, {}); assert.strictEqual(r.code, "PRACTICE_NOT_PUBLISHABLE"); none(m); }
  assert.strictEqual((await R.publishQuizResults(setup([], { ctx: ctxRow({ status: "draft" }) }).pool, teacher, 5, 4, {}, {})).code, "QUIZ_NOT_PUBLISHED");
  const un = setup([writeQ()], { ctx: ctxRow({ subject_id: null }) }); assert.strictEqual((await R.publishQuizResults(un.pool, teacher, 5, 4, {}, {})).code, "NO_RESULTS_MAPPING"); none(un);
  const ns = setup([writeQ()], { subj: false }); assert.strictEqual((await R.publishQuizResults(ns.pool, teacher, 5, 4, {}, {})).code, "NO_RESULTS_MAPPING"); none(ns);
  const nc = setup([writeQ()], { cls: false }); assert.strictEqual((await R.publishQuizResults(nc.pool, teacher, 5, 4, {}, {})).code, "NO_RESULTS_MAPPING"); none(nc);
  const nm = setup([writeQ()], { att: [ATT[3]] }); const r = await R.publishQuizResults(nm.pool, teacher, 5, 4, {}, {}); assert.strictEqual(r.code, "NOTHING_TO_PUBLISH"); assert.ok(!writeOf(nm), "no empty Assessments row is created"); assert.strictEqual(r.extra.skippedCount, 1);
  const big = Array.from({ length: R.MAX_LEARNERS + 1 }, (_, i) => ({ student_id: i + 1, attempt_no: 1, status: "graded", total_points: 1, max_points: 2 }));
  const bm = setup([writeQ()], { att: big }); assert.strictEqual((await R.publishQuizResults(bm.pool, teacher, 5, 4, {}, {})).code, "TOO_MANY_LEARNERS"); assert.ok(!writeOf(bm));
});

test("attempt query: this quiz AND this course, only ACTIVE enrolments, only submitted/graded; a write that returns nothing is a safe 409", async () => {
  const m = setup([writeQ()]); await R.publishQuizResults(m.pool, teacher, 5, 4, {}, {});
  const q = m.log.find((x) => /lms_quiz_attempts/.test(x.sql)); assert.ok(/a\.quiz_id = @z AND a\.course_id = @c/.test(q.sql) && /e\.status = 'active'/.test(q.sql) && /a\.status IN \('submitted', 'graded'\)/.test(q.sql) && /TOP 20000/.test(q.sql));
  const bad = setup([["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @aid INT", () => []]]); const r = await R.publishQuizResults(bad.pool, teacher, 5, 4, {}, {}); assert.strictEqual(r.code, "RESULTS_INTEGRATION_UNAVAILABLE");
  assert.ok(!bad.log.some((x) => /lms_audit_log/.test(x.sql)), "a failed write is not audited as published");
});

test("not found: another course's or tenant's quiz, bad ids, and a student caller look identical; the other tenant is never queried", async () => {
  const T = makeTenants({ A: [ctxQ(), subjQ(), clsQ(), attQ(), writeQ()], B: [] });
  assert.strictEqual((await R.publishQuizResults(T.A.pool, teacher, 6, 4, {}, {})).notFound, true, "other course id");
  assert.strictEqual((await R.publishQuizResults(T.A.pool, teacher, 5, 99, {}, {})).notFound, true, "other quiz id");
  assert.strictEqual((await R.publishQuizResults(T.A.pool, teacher, "x", 4, {}, {})).notFound, true);
  assert.strictEqual((await R.publishQuizResults(T.A.pool, student, 5, 4, {}, {})).notFound, true, "a student cannot publish");
  assert.strictEqual((await R.publishQuizResults(T.A.pool, null, 5, 4, {}, {})).notFound, true);
  assert.ok(!T.A.log.some((x) => /XACT_ABORT/.test(x.sql)), "nothing was written"); T.assertUntouched("B");
  const own = await R.publishQuizResults(T.B.pool, teacher, 5, 4, {}, {}); assert.strictEqual(own.notFound, true, "tenant B has no such quiz");
});

test("permission + event + route: `lms.gradebook.publish` is admin-only by default, the event is known, the route runs flag gate, permission, course access, then the handler", async () => {
  assert.ok(P.PERMISSIONS.includes("lms.gradebook.publish")); assert.ok(P.roleDefaults({ role: "admin" }).includes("lms.gradebook.publish"));
  assert.ok(!P.roleDefaults({ role: "teacher" }).includes("lms.gradebook.publish"), "a teacher needs an explicit grant");
  assert.ok(events.EVENTS.includes("lms.results.published"));
  const router = require("../routes/lms");
  const post = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/quizzes/:quizId/publish-results" && l.route.methods.post);
  assert.ok(post); assert.strictEqual(post.route.stack.length, 4, "flag gate + permission + course access + handler");
  const m = setup([writeQ()]); const res = makeRes(); await post.route.stack[3].handle({ pool: m.pool, user: teacher, params: { courseId: "5", quizId: "4" }, body: { dryRun: true }, query: {}, tenant: "ra-r" }, res);
  assert.strictEqual(res.statusCode, 200); assert.deepStrictEqual([res.body.success, res.body.dryRun, res.body.eligible], [true, true, 3]);
  const m2 = setup([writeQ()], { ctx: ctxRow({ assessment_type: "practice" }) }); const r2 = makeRes(); await post.route.stack[3].handle({ pool: m2.pool, user: teacher, params: { courseId: "5", quizId: "4" }, body: {}, query: {}, tenant: "ra-r" }, r2);
  assert.strictEqual(r2.statusCode, 409); assert.strictEqual(r2.body.code, "PRACTICE_NOT_PUBLISHABLE");
  const r3 = makeRes(); await post.route.stack[3].handle({ pool: m.pool, user: teacher, params: { courseId: "5", quizId: "abc" }, body: {}, query: {}, tenant: "ra-r" }, r3); assert.strictEqual(r3.statusCode, 404);
});
