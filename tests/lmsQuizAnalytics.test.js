/* L6.5 - question analytics (D-084): hand-calculated difficulty / discrimination / distractor numbers, pooling of random picks, exclusions, privacy, scoping, route gates.
   Mocked pool only: the SQL itself (CASE inside SELECT, OPENJSON id list, TOP caps) is NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsQuizAnalytics.test.js");
const A = require("../utils/lmsQuizAnalytics");
const P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };

/* ---- synthetic world: 20 graded attempts (ids 1..20, learner = id + 100), attempt i scored i*5 % (max 10, total i/2) ----
   Q1 mcq_single (bank 100 v1), correct = option 1. Attempts 11..20 chose 1 (correct); 3..6 chose 2; 7..10 chose 3; 1..2 left it empty.
   Q2 true_false (bank 101 v1), correct = true. Everybody chose true.  Q3 essay (bank 102 v1), points = attempt/20 * 5 (max 5). */
const ATT = (extra = []) => [...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, status: "graded", total_points: (i + 1) / 2, max_points: 10 })), ...extra];
const QS = [
  { id: 1, attempt_id: null, source_question_id: 100, source_version: 1, type: "mcq_single", stem: "Q1 stem", points: 1, position: 1 },
  { id: 2, attempt_id: null, source_question_id: 101, source_version: 1, type: "true_false", stem: "Q2 stem", points: 1, position: 2 },
  { id: 3, attempt_id: null, source_question_id: 102, source_version: 1, type: "essay", stem: "Q3 stem", points: 5, position: 3 },
];
const ANS = () => {
  const out = [];
  for (let a = 1; a <= 20; a++) {
    const sel = a >= 11 ? 1 : a >= 7 ? 3 : a >= 3 ? 2 : null;
    out.push(sel === null ? { attempt_id: a, quiz_question_id: 1, answer_json: null, status: "unanswered", points: 0, max_points: 1 }
      : { attempt_id: a, quiz_question_id: 1, answer_json: JSON.stringify({ selected: sel }), status: sel === 1 ? "correct" : "incorrect", points: sel === 1 ? 1 : 0, max_points: 1 });
    out.push({ attempt_id: a, quiz_question_id: 2, answer_json: JSON.stringify({ selected: true }), status: "correct", points: 1, max_points: 1 });
    out.push({ attempt_id: a, quiz_question_id: 3, answer_json: "{}", status: "manual", points: (a / 20) * 5, max_points: 5 });
  }
  return out;
};
const SPEC1 = JSON.stringify({ options: [{ position: 1, text: "Right", correct: true }, { position: 2, text: "Wrong A", correct: false }, { position: 3, text: "Wrong B", correct: false }] });
const SPEC2 = JSON.stringify({ correct: true });

const quizRow = (o = {}) => ({ id: 4, title: "CAT 1", assessment_type: "coursework", status: "published", quiz_mode: "quiz", counts_to_grade: 1, ...o });
const quizQ = (row = quizRow()) => ["FROM lms_quizzes z JOIN lms_courses c ON c.id = z.course_id", (i) => (i.c === 5 && i.z === 4 && row ? [row] : [])];
const attQ = (rows = ATT()) => ["FROM lms_quiz_attempts WHERE quiz_id", (i) => (i.c === 5 && i.z === 4 ? rows : [])];
const qsQ = (rows = QS) => ["attempt_id, source_question_id", (i) => (i.c === 5 && i.z === 4 ? rows : [])];
const ansQ = (rows = ANS()) => ["FROM lms_quiz_answers a", (i) => (i.c === 5 && i.z === 4 ? rows : [])];
const specQ = (map = { 1: SPEC1, 2: SPEC2 }) => ["SELECT id, spec_json", (i) => JSON.parse(i.ids).filter((id) => map[id]).map((id) => ({ id, spec_json: map[id] }))];
const world = (o = {}) => makeMockPool([quizQ(o.quiz), attQ(o.att), qsQ(o.qs), ansQ(o.ans), specQ(o.spec)]);

test("chosenOf: positions for mcq_single / mcq_multi / true_false; malformed or empty answers give null, never an error", () => {
  assert.deepStrictEqual(A.chosenOf("mcq_single", { selected: 2 }), ["2"]);
  assert.deepStrictEqual(A.chosenOf("mcq_single", JSON.stringify({ selected: 3 })), ["3"]);
  assert.deepStrictEqual(A.chosenOf("mcq_multi", { selected: [1, 3, 3] }), ["1", "3"], "a repeated tick counts once");
  assert.deepStrictEqual(A.chosenOf("true_false", { selected: false }), ["false"]);
  for (const [t, a] of [["mcq_single", { selected: [1, 2] }], ["mcq_single", { selected: 0 }], ["mcq_single", { selected: 11 }], ["mcq_multi", { selected: [] }], ["mcq_multi", { selected: ["1"] }],
    ["true_false", { selected: "true" }], ["mcq_single", null], ["mcq_single", "not json"], ["mcq_single", [1]], ["mcq_single", {}]]) assert.strictEqual(A.chosenOf(t, a), null, `${t} ${JSON.stringify(a)}`);
});

test("compute: difficulty, label, unanswered and discrimination match the hand calculation", () => {
  const { summary, groups } = A.compute(ATT(), QS, ANS());
  assert.deepStrictEqual([summary.gradedAttempts, summary.waitingForMarking, summary.meanPercent, summary.medianPercent, summary.lowestPercent, summary.highestPercent], [20, 0, 52.5, 52.5, 5, 100]);
  assert.deepStrictEqual([summary.discriminationAvailable, summary.groupSize, summary.questionCount], [true, 5, 3]);
  const [q1, q2, q3] = groups;
  // Q1: 10 of 20 correct -> p 0.5 (medium); top 5 (ids 20..16) all correct, bottom 5 (ids 1..5) all wrong -> 1 - 0 = 1.0 (good)
  assert.deepStrictEqual([q1.responses, q1.unanswered, q1.unansweredRate, q1.difficulty, q1.difficultyLabel], [20, 2, 0.1, 0.5, "medium"]);
  assert.deepStrictEqual(q1.discrimination, { value: 1, rating: "good" });
  // Q2: everybody right -> p 1 (easy), no difference between the groups -> 0 (weak)
  assert.deepStrictEqual([q2.difficulty, q2.difficultyLabel, q2.unanswered], [1, "easy", 0]); assert.deepStrictEqual(q2.discrimination, { value: 0, rating: "weak" });
  // Q3 essay: mean of a/20 over a = 1..20 = 10.5/20 = 0.525 -> 0.53 (rounded); top mean = (20+19+18+17+16)/5/20 = 0.9, bottom = (1+..+5)/5/20 = 0.15 -> 0.75
  assert.deepStrictEqual([q3.difficulty, q3.difficultyLabel], [0.53, "medium"]); assert.deepStrictEqual(q3.discrimination, { value: 0.75, rating: "good" });
});

test("difficulty labels: p >= 0.8 easy, p < 0.3 hard, everything between medium (exact boundaries)", () => {
  const label = (p100) => { // one question, 100 responses, `p100` of them fully right -> p = p100 / 100
    const att = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: "graded", total_points: 1, max_points: 1 }));
    const q = [{ id: 1, attempt_id: null, source_question_id: 1, source_version: 1, type: "essay", stem: "s", points: 1, position: 1 }];
    const ans = att.map((a, i) => ({ attempt_id: a.id, quiz_question_id: 1, answer_json: "{}", status: "manual", points: i < p100 ? 1 : 0, max_points: 1 }));
    return A.compute(att, q, ans).groups[0].difficultyLabel;
  };
  assert.deepStrictEqual([label(80), label(79), label(30), label(29), label(0), label(100)], ["easy", "medium", "medium", "hard", "hard", "easy"]);
});

test("finishGroup: distractor counts per option (and true/false), the key is flagged, nothing is added for essays", () => {
  const g = A.compute(ATT(), QS, ANS()).groups;
  const f1 = A.finishGroup(g[0], JSON.parse(SPEC1));
  assert.deepStrictEqual(f1.options.map((o) => [o.key, o.correct, o.chosen]), [["1", true, 10], ["2", false, 4], ["3", false, 4]]);
  assert.strictEqual(f1.noValidChoice, 2, "the two empty answers"); assert.strictEqual(f1.keyed, true); assert.ok(!("repId" in f1) && !("_chosen" in f1), "private fields removed");
  const f2 = A.finishGroup(g[1], JSON.parse(SPEC2)); assert.deepStrictEqual(f2.options.map((o) => [o.key, o.correct, o.chosen]), [["true", true, 20], ["false", false, 0]]);
  const f3 = A.finishGroup(g[2], {}); assert.ok(!("options" in f3), "essays have no options");
  const lost = A.finishGroup(g[0], null); assert.deepStrictEqual([lost.options, lost.keyed], [[], false], "a missing spec gives an empty option table, not a crash");
  const multi = A.compute([{ id: 1, status: "graded", total_points: 1, max_points: 1 }], [{ id: 9, attempt_id: null, source_question_id: 5, source_version: 1, type: "mcq_multi", stem: "m", points: 1, position: 1 }],
    [{ attempt_id: 1, quiz_question_id: 9, answer_json: JSON.stringify({ selected: [1, 3] }), status: "partial", points: 0.5, max_points: 1 }]).groups[0];
  assert.deepStrictEqual(A.finishGroup(multi, { options: [{ position: 1, text: "a", correct: true }, { position: 2, text: "b" }, { position: 3, text: "c" }] }).options.map((o) => o.chosen), [1, 0, 1], "a multi-answer response counts once per ticked option");
});

test("discrimination: needs 20 graded attempts and 5 responses per group, otherwise null with a reason; ranking is reproducible", () => {
  const few = A.compute(ATT().slice(0, 19), QS, ANS());
  assert.strictEqual(few.summary.discriminationAvailable, false); assert.ok(few.groups.every((g) => g.discrimination.value === null && g.discrimination.reason === "NEEDS_20_GRADED_ATTEMPTS"));
  // tied scores: everybody 50% -> groups are chosen by attempt id, same answer twice
  const tied = ATT().map((a) => ({ ...a, total_points: 5 })); const r1 = A.compute(tied, QS, ANS()).groups[0].discrimination, r2 = A.compute([...tied].reverse(), QS, ANS()).groups[0].discrimination;
  assert.deepStrictEqual(r1, r2, "input order never changes the result");
  // a random pick shown to only 3 attempts has too few responses in the groups
  const pick = [{ id: 50, attempt_id: 20, source_question_id: 200, source_version: 1, type: "numeric", stem: "p", points: 1, position: 1 }, { id: 51, attempt_id: 19, source_question_id: 200, source_version: 1, type: "numeric", stem: "p", points: 1, position: 1 },
    { id: 52, attempt_id: 1, source_question_id: 200, source_version: 1, type: "numeric", stem: "p", points: 1, position: 1 }];
  const ans = [20, 19, 1].map((a, i) => ({ attempt_id: a, quiz_question_id: 50 + i, answer_json: "{}", status: "correct", points: 1, max_points: 1 }));
  const g = A.compute(ATT(), pick, ans).groups[0]; assert.deepStrictEqual([g.responses, g.discrimination], [3, { value: null, reason: "TOO_FEW_RESPONSES" }]);
  assert.strictEqual(g.difficulty, 1);
});

test("a negative discrimination is rated check_key; rating thresholds are exact", () => {
  // the best attempts get the question wrong, the worst get it right
  const ans = ANS().map((x) => (x.quiz_question_id === 2 ? { ...x, points: x.attempt_id <= 10 ? 1 : 0, status: x.attempt_id <= 10 ? "correct" : "incorrect" } : x));
  const g = A.compute(ATT(), QS, ans).groups[1]; assert.deepStrictEqual(g.discrimination, { value: -1, rating: "check_key" });
  const ratings = [[0.3, "good"], [0.29, "fair"], [0.1, "fair"], [0.09, "weak"], [0, "weak"]]; // rateOf is exercised through compute below
  for (const [d, r] of ratings) {
    // build a 20-attempt world where top 5 average (0.5 + d) of the points and bottom 5 average 0.5 on a 100-point question
    const a = ATT(), q = [{ id: 1, attempt_id: null, source_question_id: 1, source_version: 1, type: "essay", stem: "s", points: 100, position: 1 }];
    const ex = a.map((x) => ({ attempt_id: x.id, quiz_question_id: 1, answer_json: "{}", status: "manual", points: Math.round((x.id >= 16 ? 0.5 + d : 0.5) * 100 * 100) / 100, max_points: 100 }));
    assert.strictEqual(A.compute(a, q, ex).groups[0].discrimination.rating, r, `d=${d}`);
  }
});

test("pooling: fixed questions and random picks of the same bank question and version are ONE question; another version is separate; a question not shown is not a response", () => {
  const att = [1, 2, 3].map((id) => ({ id, status: "graded", total_points: 1, max_points: 1 }));
  const qs = [
    { id: 10, attempt_id: 1, source_question_id: 7, source_version: 1, type: "mcq_single", stem: "same", points: 1, position: 1 },
    { id: 11, attempt_id: 2, source_question_id: 7, source_version: 1, type: "mcq_single", stem: "same", points: 1, position: 3 },
    { id: 12, attempt_id: 3, source_question_id: 7, source_version: 2, type: "mcq_single", stem: "same v2", points: 1, position: 1 },
    { id: 13, attempt_id: 3, source_question_id: null, source_version: null, type: "essay", stem: "custom", points: 2, position: 2 },
  ];
  const ans = [{ attempt_id: 1, quiz_question_id: 10, answer_json: JSON.stringify({ selected: 1 }), status: "correct", points: 1, max_points: 1 }, { attempt_id: 2, quiz_question_id: 11, answer_json: JSON.stringify({ selected: 2 }), status: "incorrect", points: 0, max_points: 1 }];
  const { groups } = A.compute(att, qs, ans);
  assert.strictEqual(groups.length, 3); const v1 = groups.find((g) => g.key === "b7v1"), v2 = groups.find((g) => g.key === "b7v2"), cu = groups.find((g) => g.key === "q13");
  assert.deepStrictEqual([v1.responses, v1.difficulty], [2, 0.5], "attempts 1 and 2 pooled; attempt 3 was never shown v1");
  assert.deepStrictEqual([v2.responses, v2.unanswered, v2.difficulty], [1, 1, 0], "an answer row that is missing counts as unanswered, score 0");
  assert.deepStrictEqual([cu.questionId, cu.responses], [null, 1], "a question without a bank source is reported on its own");
});

test("only GRADED attempts count: submitted ones are only counted as waiting, in-progress rows and bad rows are ignored, max 0 never divides", () => {
  const att = ATT([{ id: 90, status: "submitted", total_points: null, max_points: 10 }, { id: 91, status: "in_progress", total_points: null, max_points: 10 }, { id: "x", status: "graded", total_points: 1, max_points: 1 }, null]);
  const r = A.compute(att, QS, ANS()); assert.deepStrictEqual([r.summary.gradedAttempts, r.summary.waitingForMarking], [20, 1]);
  const z = A.compute([{ id: 1, status: "graded", total_points: 0, max_points: 0 }], QS, []); assert.strictEqual(z.summary.meanPercent, 0);
  assert.deepStrictEqual(A.compute([], QS, ANS()).summary, { gradedAttempts: 0, waitingForMarking: 0, meanPercent: null, medianPercent: null, lowestPercent: null, highestPercent: null, discriminationAvailable: false, groupSize: 0, questionCount: 0 });
  const ext = A.compute([{ id: 1, status: "graded", total_points: 1, max_points: 1 }], [{ id: 1, attempt_id: null, source_question_id: 1, source_version: 1, type: "essay", stem: "s", points: 1, position: 1 }], [{ attempt_id: 1, quiz_question_id: 1, answer_json: "{}", status: "manual", points: 9, max_points: 1 }]);
  assert.strictEqual(ext.groups[0].difficulty, 1, "a fraction never goes above 1");
});

test("quizAnalytics: scoped queries, answer text only for option types, no learner ids anywhere in the output, options read only for the page", async () => {
  const m = world(); const r = await A.quizAnalytics(m.pool, teacher, 5, 4, {}); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.total, r.questions.length, r.hasMore, r.page, r.pageSize], [3, 3, false, 1, 20]);
  assert.deepStrictEqual([r.quiz.title, r.quiz.assessmentType, r.summary.gradedAttempts, r.summary.truncated], ["CAT 1", "coursework", 20, false]);
  assert.deepStrictEqual(r.questions[0].options.map((o) => o.chosen), [10, 4, 4]); assert.strictEqual(r.questions[0].questionId, 100);
  assert.ok(/all graded attempts/.test(r.countedAttempts) && /not verdicts/.test(r.note));
  const text = JSON.stringify(r); assert.ok(!/student_id|studentId|learnerId|learner_id|attempt_id|attemptId|admission/i.test(text), "aggregates only, no learner or attempt identifiers: " + text.slice(0, 200));
  assert.ok(!/"id":/.test(JSON.stringify(r.questions)), "internal snapshot ids are not exposed");
  for (const x of m.log) assert.ok(/@z/.test(x.sql) && /@c/.test(x.sql), "every query is scoped by quiz AND course: " + x.sql.slice(0, 60));
  const a = m.log.find((x) => /FROM lms_quiz_answers a/.test(x.sql)); assert.ok(/t\.status = 'graded'/.test(a.sql) && /q\.type IN \('mcq_single', 'mcq_multi', 'true_false'\)/.test(a.sql) && /TOP 200000/.test(a.sql), "graded attempts only; answer text only for option types; capped");
  assert.ok(/TOP 20000/.test(m.log.find((x) => /FROM lms_quiz_attempts WHERE quiz_id/.test(x.sql)).sql));
  const s = m.log.find((x) => /SELECT id, spec_json/.test(x.sql)); assert.deepStrictEqual(JSON.parse(s.inputs.ids).sort(), [1, 2], "the option specs are read only for the two option-type questions");
  assert.ok(/OPENJSON\(@ids\)/.test(s.sql) && !/\b1,\s*2\b/.test(s.sql.replace(/TOP 5/g, "")), "the id list is a parameter");
});

test("paging and the questionId filter: a page of 1 reads only that page's specs; questionId narrows to one bank question; bad input is refused", async () => {
  const m = world(); const r = await A.quizAnalytics(m.pool, teacher, 5, 4, { page: 2, pageSize: 1 });
  assert.deepStrictEqual([r.questions.length, r.questions[0].questionId, r.total, r.hasMore, r.page], [1, 101, 3, true, 2]);
  assert.deepStrictEqual(JSON.parse(m.log.find((x) => /SELECT id, spec_json/.test(x.sql)).inputs.ids), [2], "only the shown question's spec is read");
  const one = await A.quizAnalytics(world().pool, teacher, 5, 4, { questionId: "100" }); assert.deepStrictEqual([one.total, one.questions[0].questionId], [1, 100]);
  const none = await A.quizAnalytics(world().pool, teacher, 5, 4, { questionId: 999 }); assert.deepStrictEqual([none.ok, none.total, none.questions], [true, 0, []]);
  for (const bad of ["abc", -1, 0, "1.5"]) { const b = await A.quizAnalytics(world().pool, teacher, 5, 4, { questionId: bad }); assert.strictEqual(b.ok, false); assert.ok(!b.notFound); }
  const big = await A.quizAnalytics(world().pool, teacher, 5, 4, { pageSize: 5000 }); assert.strictEqual(big.pageSize, 50, "page size is capped"); assert.strictEqual((await A.quizAnalytics(world().pool, teacher, 5, 4, { page: -3, pageSize: "x" })).page, 1);
});

test("no graded attempt yet: an empty, valid report, and the heavy answer/question queries never run; waiting attempts are reported", async () => {
  const m = world({ att: [{ id: 1, status: "submitted", total_points: null, max_points: 10 }] }); const r = await A.quizAnalytics(m.pool, teacher, 5, 4, {});
  assert.deepStrictEqual([r.ok, r.summary.gradedAttempts, r.summary.waitingForMarking, r.questions, r.total], [true, 0, 1, [], 0]);
  assert.ok(!m.log.some((x) => /lms_quiz_answers|attempt_id, source_question_id/.test(x.sql)), "nothing else was read");
  const big = world({ att: Array.from({ length: 20000 }, (_, i) => ({ id: i + 1, status: "submitted", total_points: null, max_points: 1 })) }); assert.strictEqual((await A.quizAnalytics(big.pool, teacher, 5, 4, {})).summary.truncated, true, "hitting the cap is announced");
});

test("not found: another course's or tenant's quiz, bad ids, students and callers without a user look identical; the other tenant is never queried", async () => {
  const T = makeTenants({ A: [quizQ(), attQ(), qsQ(), ansQ(), specQ()], B: [] });
  assert.strictEqual((await A.quizAnalytics(T.A.pool, teacher, 6, 4, {})).notFound, true, "other course id");
  assert.strictEqual((await A.quizAnalytics(T.A.pool, teacher, 5, 99, {})).notFound, true, "other quiz id");
  assert.strictEqual((await A.quizAnalytics(T.A.pool, teacher, "x", 4, {})).notFound, true);
  assert.strictEqual((await A.quizAnalytics(T.A.pool, student, 5, 4, {})).notFound, true, "a student never gets analytics");
  assert.strictEqual((await A.quizAnalytics(T.A.pool, null, 5, 4, {})).notFound, true);
  assert.ok(!T.A.log.some((x) => /lms_quiz_answers|lms_quiz_attempts/.test(x.sql)), "no attempt or answer was read for a quiz that is not this course's"); T.assertUntouched("B");
  assert.strictEqual((await A.quizAnalytics(T.B.pool, teacher, 5, 4, {})).notFound, true, "tenant B has no such quiz");
});

test("read only: no write statement, no audit row, no event", async () => {
  const m = world(); await A.quizAnalytics(m.pool, teacher, 5, 4, {});
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql) && !/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|EXEC)\b/i.test(x.sql)), m.log.map((x) => x.sql.slice(0, 40)).join(" | "));
});

test("route: flag gate, then manage OR grade permission, then course access, then the handler; teachers hold it by default, students do not", async () => {
  const router = require("../routes/lms");
  const get = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/quizzes/:quizId/analytics" && l.route.methods.get);
  assert.ok(get); assert.strictEqual(get.route.stack.length, 4, "flag gate + permission + course access + handler");
  assert.ok(P.roleDefaults({ role: "teacher" }).includes("lms.submission.grade") || P.roleDefaults({ role: "teacher" }).includes("lms.course.manage"));
  assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.submission.grade") && !P.roleDefaults({ role: "student" }).includes("lms.course.manage"));
  // the either/or rule is asserted on the route source: requireLmsPermission accepts ANY of its codes (see lmsPermissions.js)
  assert.ok(/requireLmsPermission\("lms\.course\.manage", "lms\.submission\.grade"\)/.test(require("fs").readFileSync(require("path").join(__dirname, "../routes/lms.js"), "utf8")), "either permission opens the route");
  const m = world(); const res = makeRes(); await get.route.stack[3].handle({ pool: m.pool, user: teacher, params: { courseId: "5", quizId: "4" }, query: { page: "1" }, tenant: "qa-r" }, res);
  assert.strictEqual(res.statusCode, 200); assert.deepStrictEqual([res.body.success, res.body.questions.length, res.body.summary.gradedAttempts], [true, 3, 20]); assert.ok(!("ok" in res.body));
  const r2 = makeRes(); await get.route.stack[3].handle({ pool: m.pool, user: teacher, params: { courseId: "5", quizId: "abc" }, query: {}, tenant: "qa-r" }, r2); assert.strictEqual(r2.statusCode, 404);
  const r3 = makeRes(); await get.route.stack[3].handle({ pool: m.pool, user: teacher, params: { courseId: "5", quizId: "4" }, query: { questionId: "zz" }, tenant: "qa-r" }, r3); assert.strictEqual(r3.statusCode, 400);
  const r4 = makeRes(); await get.route.stack[3].handle({ pool: m.pool, user: student, params: { courseId: "5", quizId: "4" }, query: {}, tenant: "qa-r" }, r4); assert.strictEqual(r4.statusCode, 404);
});
