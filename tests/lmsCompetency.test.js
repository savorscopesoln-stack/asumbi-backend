/* L9.4 - competency tracking (D-110): outcome mastery from released rubric marks and graded coursework quiz answers. Read only. Mocked pool only: the SQL (GROUP BY, CROSS APPLY, correlated MAX)
   is NOT verified on a real SQL Server; the tests pin the guards in the query TEXT and the pure rules. F-2: no shared module export is patched here. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsCompetency.test.js");
const C = require("../utils/lmsCompetency");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const sub = (m, re) => m.log.filter((x) => re.test(x.sql));
const rub = (sid, oid, code, aid, title, pts, max, at) => ({ student_id: sid, outcome_id: oid, code, outcome_title: `Outcome ${code}`, source_id: aid, source_title: title, at_time: at, pts, max_pts: max });
const qz = (sid, oid, code, qid, title, attempt, pts, max, at) => ({ student_id: sid, attempt_id: attempt, outcome_id: oid, code, outcome_title: `Outcome ${code}`, source_id: qid, source_title: title, at_time: at, pts, max_pts: max });
const RUB = [rub(30, 1, "M1", 9, "Essay 1", 8, 10, "2026-10-01T10:00:00Z"), rub(30, 1, "M1", 10, "Essay 2", 6, 10, "2026-10-20T10:00:00Z"), rub(31, 1, "M1", 9, "Essay 1", 4, 10, "2026-10-02T10:00:00Z")];
const QZ = [qz(30, 2, "M2", 4, "Quiz A", 101, 5, 10, "2026-10-05T10:00:00Z"), qz(30, 2, "M2", 4, "Quiz A", 102, 9, 10, "2026-10-06T10:00:00Z"), qz(30, 2, "M2", 5, "Quiz B", 103, 6, 10, "2026-10-09T10:00:00Z")];
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", () => (o.noCourse ? [] : [{ status: o.status || "published" }])],
  ["FROM lms_settings", () => o.settings || []],
  ["COUNT(*) AS n FROM lms_course_enrolments", () => [{ n: o.learners ?? 3 }]],
  ["SELECT TOP 1 s.name AS student_name", () => (o.notEnrolled ? [] : [{ student_name: "Amina Otieno" }])],
  ["FROM lms_submissions s JOIN lms_submission_grades g", (i) => (o.rubric || RUB).filter((x) => i.s === null || x.student_id === i.s)],
  ["FROM lms_quiz_attempts at", (i) => (o.quiz || QZ).filter((x) => i.s === null || x.student_id === i.s)],
]);

test("summarise/bandFor: fewer than 2 items = insufficient_evidence and NO number; mean x 100; bands at exactly 40 and 70; fractions clamped to 0..1", () => {
  assert.deepStrictEqual(C.summarise([]), { evidenceCount: 0, masteryPercent: null, band: "insufficient_evidence" });
  assert.deepStrictEqual(C.summarise([{ fraction: 1 }]), { evidenceCount: 1, masteryPercent: null, band: "insufficient_evidence" });
  assert.deepStrictEqual(C.summarise([{ fraction: 1 }, { fraction: 0.5 }]), { evidenceCount: 2, masteryPercent: 75, band: "secure" });
  assert.strictEqual(C.summarise([{ fraction: 0.4 }, { fraction: 0.4 }]).band, "developing", "40 is developing");
  assert.strictEqual(C.summarise([{ fraction: 0.3999 }, { fraction: 0.3999 }]).band, "beginning");
  assert.strictEqual(C.summarise([{ fraction: 0.7 }, { fraction: 0.7 }]).band, "secure", "70 is secure");
  assert.strictEqual(C.summarise([{ fraction: 0.6999 }, { fraction: 0.6999 }]).band, "developing");
  assert.strictEqual(C.summarise([{ fraction: 5 }, { fraction: -3 }]).masteryPercent, 50, "clamped to 1 and 0");
  assert.deepStrictEqual([C.MIN_EVIDENCE, C.DEVELOPING_FROM, C.SECURE_FROM], [2, 40, 70]);
});

test("toEvidence: a quiz counts once per quiz and outcome (BEST attempt, earlier wins a tie); rows without a positive maximum are dropped; rubric items kept as they are", () => {
  const ev = C.toEvidence(RUB, QZ); const a = ev.filter((e) => e.source === "quiz" && e.studentId === 30);
  assert.strictEqual(a.length, 2, "two quizzes, not three attempts"); assert.strictEqual(a.find((e) => e.sourceId === 4).fraction, 0.9);
  assert.ok(!ev.some((e) => "attemptId" in e), "no attempt id leaks");
  const tie = C.toEvidence([], [qz(1, 2, "M2", 4, "Q", 205, 5, 10, "2026-10-09T00:00:00Z"), qz(1, 2, "M2", 4, "Q", 204, 5, 10, "2026-10-08T00:00:00Z")]); assert.strictEqual(tie.length, 1);
  assert.strictEqual(tie[0].at, "2026-10-08T00:00:00.000Z", "equal fractions: the EARLIER attempt is the evidence");
  assert.strictEqual(C.toEvidence([rub(1, 1, "M1", 9, "E", 5, 0, null)], [qz(1, 2, "M2", 4, "Q", 1, 0, 0, null)]).length, 0, "zero maximum dropped");
  assert.strictEqual(C.toEvidence(null, null).length, 0);
  assert.strictEqual(C.toEvidence([rub(1, 1, "M1", 9, "E", 12, 10, null)], [])[0].fraction, 1, "extra credit never lifts a rubric item above 100%");
  assert.strictEqual(C.toEvidence([], [qz(1, 2, "M2", 4, "Q", 1, 12, 10, null)])[0].fraction, 1, "nor a quiz item");
  assert.strictEqual(ev.filter((e) => e.source === "assignment").length, 3);
});

test("perOutcome: counts only (learners with evidence, evidence items, band counts); no learner id or name anywhere in the answer", () => {
  const out = C.perOutcome(C.toEvidence(RUB, QZ)); const m1 = out.find((o) => o.code === "M1"), m2 = out.find((o) => o.code === "M2");
  assert.deepStrictEqual([m1.learnersWithEvidence, m1.evidenceItems, m1.bands], [2, 3, { insufficient_evidence: 1, beginning: 0, developing: 0, secure: 1 }]);
  assert.deepStrictEqual([m2.learnersWithEvidence, m2.evidenceItems, m2.bands.secure], [1, 2, 1]);
  assert.deepStrictEqual(out.map((o) => o.code), ["M1", "M2"], "code order, not a ranking");
  assert.ok(!/studentId|student_id|"name"|admission/i.test(JSON.stringify(out)), "nobody is named or identified");
});

test("perLearner: one learner's outcomes with mastery and the evidence behind it (newest first, percent per item)", () => {
  const out = C.perLearner(C.toEvidence(RUB, QZ).filter((e) => e.studentId === 30)); const m1 = out[0];
  assert.deepStrictEqual([m1.code, m1.evidenceCount, m1.masteryPercent, m1.band], ["M1", 2, 70, "secure"]);
  assert.deepStrictEqual(m1.evidence.map((e) => [e.title, e.percent, e.points, e.maxPoints]), [["Essay 2", 60, 6, 10], ["Essay 1", 80, 8, 10]]);
  assert.deepStrictEqual([out[1].code, out[1].masteryPercent], ["M2", 75], "best of quiz A (90) and quiz B (60)");
  assert.deepStrictEqual(C.perLearner([]), []);
});

test("SQL guards: rubric = RETURNED grades only, the grade's own rubric, LATEST submitted attempt, live assignment, live outcome, ACTIVE enrolment; quiz = graded + not waiting, coursework that counts, marked answers, ACTIVE enrolment; values are parameters", async () => {
  const m = world(); await C.learnerCompetency(m.pool, teacher, "5", "30");
  const r = sub(m, /FROM lms_submissions s JOIN lms_submission_grades g/)[0].sql, q = sub(m, /FROM lms_quiz_attempts at/)[0].sql;
  for (const re of [/g\.status = 'returned'/, /c\.rubric_id = g\.rubric_id/, /MAX\(l2\.attempt_no\)[^)]*l2\.status = 'submitted'/, /a\.deleted_at IS NULL/, /o\.deleted_at IS NULL/, /e\.status = 'active'/, /t\.entity_type = 'rubric_criterion'/, /s\.course_id = @c/, /\(@s IS NULL OR s\.student_id = @s\)/, /HAVING SUM\(mx\.max_points\) > 0/]) assert.ok(re.test(r), `rubric: ${re}`);
  assert.ok(!/'draft'/.test(r), "a draft mark never counts");
  for (const re of [/at\.status = 'graded'/, /at\.needs_marking = 0/, /q\.assessment_type = 'coursework'/, /q\.counts_to_grade = 1/, /q\.deleted_at IS NULL/, /ans\.points IS NOT NULL/, /qq\.source_question_id IS NOT NULL/, /t\.entity_type = 'question'/, /o\.deleted_at IS NULL/, /e\.status = 'active'/, /at\.course_id = @c/, /\(@s IS NULL OR at\.student_id = @s\)/, /HAVING SUM\(ans\.max_points\) > 0/]) assert.ok(re.test(q), `quiz: ${re}`);
  assert.ok(!/practice|revision|mock|flashcards/.test(q), "practice-type quizzes are not evidence");
  const w = sub(m, /FROM lms_quiz_attempts at/)[0]; assert.deepStrictEqual([w.inputs.c, w.inputs.s], [5, 30]);
  assert.ok(!/\b30\b/.test(r + q), "ids are parameters, not text");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(r + q), "read only");
});

test("courseCompetency: staff summary with the rule, learner count, paging; counts only; student, stranger and bad ids refused; draft/archived readable by staff; unknown course 404", async () => {
  const m = world(); const r = await C.courseCompetency(m.pool, teacher, "5", {});
  assert.deepStrictEqual([r.ok, r.learners, r.total, r.page, r.pageSize, r.outcomes.length], [true, 3, 2, 1, 50, 2]); assert.strictEqual(r.rule.minEvidence, 2);
  assert.ok(!/"name"|studentId|admission/i.test(JSON.stringify(r)), "nobody named");
  const p = await C.courseCompetency(world().pool, teacher, "5", { page: "2", pageSize: "1" }); assert.deepStrictEqual([p.outcomes.length, p.outcomes[0].code, p.total, p.pageSize], [1, "M2", 2, 1]);
  assert.strictEqual((await C.courseCompetency(world().pool, teacher, "5", { pageSize: "9999" })).pageSize, 100, "page size capped");
  assert.strictEqual(sub(m, /FROM lms_submissions s JOIN/)[0].inputs.s, null, "whole course = no single learner");
  for (const [u, c] of [[student, "5"], [null, "5"], [teacher, "x"], [teacher, "0"]]) { const w = world(); assert.strictEqual((await C.courseCompetency(w.pool, u, c, {})).ok, false); assert.ok(!sub(w, /lms_submission_grades|lms_quiz_attempts/).length, "no evidence read"); }
  assert.strictEqual((await C.courseCompetency(world({ noCourse: true }).pool, teacher, "5", {})).notFound, true);
  assert.strictEqual((await C.courseCompetency(world({ status: "draft" }).pool, teacher, "5", {})).ok, true); assert.strictEqual((await C.courseCompetency(world({ status: "archived" }).pool, teacher, "5", {})).ok, true);
});

test("courseCompetency: more than 2000 active learners = 409 TOO_MANY_LEARNERS (no evidence read); more than 100000 evidence rows = TOO_MUCH_EVIDENCE", async () => {
  const big = world({ learners: 2001 }); const r = await C.courseCompetency(big.pool, teacher, "5", {}); assert.strictEqual(r.code, "TOO_MANY_LEARNERS"); assert.ok(!sub(big, /lms_submission_grades/).length);
  assert.strictEqual((await C.courseCompetency(world({ learners: 2000 }).pool, teacher, "5", {})).ok, true, "2000 is allowed");
  const rows = Array.from({ length: 100001 }, (_, i) => rub(i + 1, 1, "M1", 9, "E", 1, 1, null)); const t = await C.courseCompetency(world({ rubric: rows }).pool, teacher, "5", {}); assert.strictEqual(t.code, "TOO_MUCH_EVIDENCE");
  const m = world(); await C.courseCompetency(m.pool, teacher, "5", {}); assert.ok(/SELECT TOP 100001 /.test(sub(m, /FROM lms_submissions s JOIN/)[0].sql), "the read is capped in SQL");
});

test("learnerCompetency: ACTIVE learner of this course only (else 404 and NO evidence read); returns the name (never an admission number) + mastery + evidence; the learner id is a parameter", async () => {
  const m = world(); const r = await C.learnerCompetency(m.pool, teacher, "5", "30");
  assert.deepStrictEqual([r.ok, r.student, r.outcomes.length, r.outcomes[0].masteryPercent], [true, { id: 30, name: "Amina Otieno" }, 2, 70]); assert.ok(!/admission/i.test(JSON.stringify(r)));
  const en = sub(m, /SELECT TOP 1 s\.name/)[0].sql; assert.ok(/e\.course_id = @c AND e\.student_id = @s AND e\.status = 'active'/.test(en), "enrolment of THIS course, active");
  const x = world({ notEnrolled: true }); assert.strictEqual((await C.learnerCompetency(x.pool, teacher, "5", "99")).notFound, true); assert.ok(!sub(x, /lms_submission_grades|lms_quiz_attempts/).length, "no evidence read for a stranger");
  for (const [u, c, s] of [[student, "5", "30"], [null, "5", "30"], [teacher, "x", "30"], [teacher, "5", "abc"], [teacher, "5", "0"]]) assert.strictEqual((await C.learnerCompetency(world().pool, u, c, s)).ok, false);
  assert.strictEqual((await C.learnerCompetency(world({ noCourse: true }).pool, teacher, "5", "30")).notFound, true);
  const none = await C.learnerCompetency(world({ rubric: [], quiz: [] }).pool, teacher, "5", "30"); assert.deepStrictEqual(none.outcomes, []);
});

test("myCompetency: ALWAYS the token's own id; staff and non-learners refused; draft/missing course 404; archived readable; another tenant is never touched", async () => {
  const m = world(); const r = await C.myCompetency(m.pool, student, "5"); assert.strictEqual(r.ok, true);
  assert.ok(sub(m, /FROM lms_quiz_attempts at/).every((x) => x.inputs.s === 21) && sub(m, /FROM lms_submissions s JOIN/).every((x) => x.inputs.s === 21), "own id only");
  assert.deepStrictEqual(r.outcomes, [], "learner 21 has no evidence in the fixture"); assert.ok(r.rule.text.length > 20, "the rule is shown to the learner");
  for (const [u, o] of [[teacher, {}], [null, {}], [student, { status: "draft" }], [student, { noCourse: true }], [{ id: 5, role: "student", source: "Teachers" }, {}]]) assert.strictEqual((await C.myCompetency(world(o).pool, u, "5")).ok, false);
  assert.strictEqual((await C.myCompetency(world().pool, student, "x")).ok, false); assert.ok((await C.myCompetency(world({ status: "archived" }).pool, student, "5")).ok);
  const own = await C.myCompetency(world().pool, { id: 30, role: "student", source: "Students" }, "5"); assert.strictEqual(own.outcomes.length, 2); assert.ok(!/studentId|"name"/.test(JSON.stringify(own)), "no other learner, no name");
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => [{ status: "published" }]]], B: [] }); assert.strictEqual((await C.myCompetency(T.A.pool, student, "5")).ok, true); T.assertUntouched("B");
});

test("routes: flag lms_competency gate FIRST on all three; staff routes need lms.gradebook.view + course staff, the learner route is studentOnly + course access; handlers answer 200/404", async () => {
  const router = require("../routes/lms"); const find = (p, meth) => router.stack.filter((l) => l.route && l.route.path === p && l.route.methods[meth]);
  const gate = find("/courses/:courseId/paths", "get")[0].route.stack[0].handle;
  const list = find("/courses/:courseId/competency", "get"), one = find("/courses/:courseId/competency/learners/:studentId", "get"), mine = find("/courses/:courseId/learn/competency", "get");
  assert.deepStrictEqual([list.length, one.length, mine.length], [1, 1, 1]); assert.deepStrictEqual([list[0].route.stack.length, one[0].route.stack.length, mine[0].route.stack.length], [4, 4, 4]);
  const g = list[0].route.stack[0].handle; assert.ok(g !== gate && one[0].route.stack[0].handle === g && mine[0].route.stack[0].handle === g, "the same flag gate comes first on all three, and it is not the paths gate");
  const call = async (r, req) => { const res = makeRes(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; }; const st = r[0].route.stack; await st[st.length - 1].handle({ query: {}, body: {}, tenant: "cp-a", ...req }, res); return res; };
  const a = await call(list, { pool: world().pool, user: teacher, params: { courseId: "5" } }); assert.strictEqual(a.statusCode, 200); assert.strictEqual(a.body.outcomes.length, 2); assert.strictEqual(a.headers["Cache-Control"], "no-store", "every answer is no-store");
  const b = await call(one, { pool: world().pool, user: teacher, params: { courseId: "5", studentId: "30" } }); assert.strictEqual(b.statusCode, 200); assert.strictEqual(b.body.student.name, "Amina Otieno");
  const c = await call(one, { pool: world({ notEnrolled: true }).pool, user: teacher, params: { courseId: "5", studentId: "30" } }); assert.strictEqual(c.statusCode, 404);
  const d = await call(one, { pool: world().pool, user: teacher, params: { courseId: "5", studentId: "abc" } }); assert.strictEqual(d.statusCode, 404);
  const e = await call(mine, { pool: world().pool, user: student, params: { courseId: "5" } }); assert.strictEqual(e.statusCode, 200); assert.ok(Array.isArray(e.body.outcomes));
});

const S = require("../utils/lmsSettings");
const cfg = (v) => [{ setting_key: "competency", value_json: typeof v === "string" ? v : JSON.stringify(v) }];

test("settings: `competency` has defaults 2/40/70, validates whole numbers in range with developingFrom < secureFrom, refuses unknown keys, and is not in the public view (D-111, Q95)", () => {
  assert.deepStrictEqual(S.DEFAULTS.competency, { minEvidence: 2, developingFrom: 40, secureFrom: 70 });
  assert.deepStrictEqual(S.validateSettingsPatch({ competency: { minEvidence: 3, developingFrom: "50", secureFrom: 80 } }).value.competency, { minEvidence: 3, developingFrom: 50, secureFrom: 80 });
  for (const bad of [{ minEvidence: 0 }, { minEvidence: 11 }, { developingFrom: 0 }, { developingFrom: 100 }, { secureFrom: 1 }, { secureFrom: 101 }, { minEvidence: 1.5 }, { minEvidence: "x" }, { developingFrom: 70, secureFrom: 70 }, { developingFrom: 80, secureFrom: 60 }, { other: 1 }]) assert.strictEqual(S.validateSettingsPatch({ competency: bad }).ok, false, JSON.stringify(bad));
  assert.strictEqual(S.validateSettingsPatch({ competency: [1] }).ok, false); assert.strictEqual(S.validateSettingsPatch({ competency: { minEvidence: 1 } }).ok, true, "one key alone is fine");
  assert.ok(!("competency" in S.publicView(S.mergeSettings([]))));
});

test("normThresholds: a bad, partial or inconsistent stored value falls back to the defaults as a whole; a good one is used", () => {
  const D = { minEvidence: 2, developingFrom: 40, secureFrom: 70 };
  for (const v of [null, undefined, "x", {}, { minEvidence: 3 }, { minEvidence: 0, developingFrom: 40, secureFrom: 70 }, { minEvidence: 2, developingFrom: 70, secureFrom: 70 }, { minEvidence: 2, developingFrom: 80, secureFrom: 60 }, { minEvidence: "2", developingFrom: 40, secureFrom: 70 }, { minEvidence: 2, developingFrom: 40, secureFrom: 101 }, { minEvidence: 2, developingFrom: 0, secureFrom: 70 }, { minEvidence: 11, developingFrom: 40, secureFrom: 70 }, { minEvidence: 2, developingFrom: 100, secureFrom: 100 }, { minEvidence: 2, developingFrom: 1, secureFrom: 1 }]) assert.deepStrictEqual(C.normThresholds(v), D, JSON.stringify(v));
  assert.deepStrictEqual(C.normThresholds({ minEvidence: 1, developingFrom: 50, secureFrom: 80, extra: 1 }), { minEvidence: 1, developingFrom: 50, secureFrom: 80 });
  assert.strictEqual(C.ruleFor({ minEvidence: 1, developingFrom: 50, secureFrom: 80 }).text.includes("at least 1 piece of evidence; below 50%"), true);
});

test("a school's own bands change the bands, the minimum evidence and the rule text on ALL three answers; a broken stored value = defaults", async () => {
  const th = { minEvidence: 1, developingFrom: 80, secureFrom: 95 };
  assert.deepStrictEqual([C.summarise([{ fraction: 0.9 }], th).band, C.summarise([{ fraction: 0.9 }]).band], ["developing", "insufficient_evidence"]);
  assert.deepStrictEqual([C.bandFor(79.99, th), C.bandFor(80, th), C.bandFor(94.99, th), C.bandFor(95, th)], ["beginning", "developing", "developing", "secure"]);
  const staff = await C.learnerCompetency(world({ settings: cfg(th) }).pool, teacher, "5", "30"), m1 = staff.outcomes[0];
  assert.deepStrictEqual([m1.masteryPercent, m1.band, staff.rule.secureFromPercent], [70, "beginning", 95], "70% is beginning under 80/95");
  const course = await C.courseCompetency(world({ settings: cfg(th) }).pool, teacher, "5", {}); assert.deepStrictEqual([course.rule.minEvidence, course.outcomes[0].bands.insufficient_evidence], [1, 0], "a single item now counts");
  const mine = await C.myCompetency(world({ settings: cfg(th) }).pool, { id: 30, role: "student", source: "Students" }, "5"); assert.ok(/at least 1 piece of evidence; below 80%/.test(mine.rule.text));
  const bad = await C.learnerCompetency(world({ settings: cfg("{{{") }).pool, teacher, "5", "30"); assert.deepStrictEqual([bad.outcomes[0].band, bad.rule.minEvidence], ["secure", 2], "bad JSON = defaults");
  const half = await C.learnerCompetency(world({ settings: cfg({ minEvidence: 1, developingFrom: 90, secureFrom: 50 }) }).pool, teacher, "5", "30"); assert.strictEqual(half.rule.secureFromPercent, 70, "inconsistent = defaults");
});
