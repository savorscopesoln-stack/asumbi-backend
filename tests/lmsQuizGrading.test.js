/* L6.2b-2 - staff marking of written quiz answers: validation, queue (+ expired sweep), attempt view in positions, mark flow (partial then last = graded),
   no re-mark, NOT_MANUAL / not submitted, learner result shows points + comment, isolation, routes, schema 027. Mocked pool only: SQL NOT verified on SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { tick } = require("./helpers/tick");
suite("lmsQuizGrading.test.js");
const G = require("../utils/lmsQuizGrading");
const A = require("../utils/lmsQuizAttempts");
const events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const T0 = new Date("2026-11-02T10:00:00Z"), at = (s) => new Date(T0.getTime() + s * 1000);
const SEED = "abcd1234abcd1234";
const QUESTIONS = [
  { id: 1, position: 1, type: "true_false", stem: "Water boils at 100C.", explanation: "", points: "2.00", spec_json: JSON.stringify({ correct: true }) },
  { id: 2, position: 2, type: "mcq_single", stem: "Capital of Kenya?", explanation: "Nairobi.", points: "1.00", spec_json: JSON.stringify({ options: [{ position: 1, text: "Mombasa", correct: false, feedback: "" }, { position: 2, text: "Nairobi", correct: true, feedback: "" }, { position: 3, text: "Kisumu", correct: false, feedback: "" }] }) },
  { id: 3, position: 3, type: "essay", stem: "Discuss A.", explanation: "", points: "5.00", spec_json: JSON.stringify({ maxWords: 50 }) },
  { id: 4, position: 4, type: "essay", stem: "Discuss B.", explanation: "", points: "3.00", spec_json: JSON.stringify({ maxWords: 50 }) },
];
const att = (o = {}) => ({ id: 70, student_id: 21, attempt_no: 1, status: "submitted", seed: SEED, started_at: T0.toISOString(), deadline_at: null, submitted_at: T0.toISOString(), auto_submitted: 0, auto_points: "3.00", manual_points: null, total_points: null, max_points: "11.00", needs_marking: 1, ...o });
const ans = (o) => ({ attempt_id: 70, quiz_id: 4, course_id: 5, student_id: 21, comment: null, marked_by_source: null, marked_by: null, marked_at: null, ...o });
const ANSWERS = () => [
  ans({ quiz_question_id: 1, answer_json: JSON.stringify({ selected: true }), status: "correct", points: "2.00", max_points: "2.00" }),
  ans({ quiz_question_id: 2, answer_json: JSON.stringify({ selected: 2 }), status: "correct", points: "1.00", max_points: "1.00" }),
  ans({ quiz_question_id: 3, answer_json: JSON.stringify({ text: "My <b>essay</b> A" }), status: "manual", points: null, max_points: "5.00" }),
  ans({ quiz_question_id: 4, answer_json: JSON.stringify({ text: "Essay B" }), status: "manual", points: null, max_points: "3.00" }),
];

/* A small stateful world: quiz 4 in course 5, student 21, one attempt. The mark responder emulates the guarded SQL (so the logic under test is the real JS). */
function world(o = {}) {
  const st = { attempts: (o.attempts || [att()]).map((x) => ({ ...x })), answers: (o.answers || ANSWERS()).map((x) => ({ ...x })), expired: o.expired || [], quizDeleted: !!o.quizDeleted, markRace: !!o.markRace };
  const rs = [
    ["UPDATE lms_quiz_answers SET points = @p", (i) => {
      const a = st.attempts.find((x) => x.id === i.a); const r = st.answers.find((x) => x.attempt_id === i.a && x.quiz_question_id === i.q);
      if (!a || a.status !== "submitted" || !r || r.status !== "manual" || st.markRace) return [{ marked: 0, graded: 0 }];
      Object.assign(r, { points: String(i.p), status: "marked", comment: i.cm, marked_by_source: i.src, marked_by: i.by, marked_at: i.now.toISOString() });
      if (st.answers.some((x) => x.attempt_id === i.a && x.status === "manual")) return [{ marked: 1, graded: 0 }];
      const mp = st.answers.filter((x) => x.attempt_id === i.a && x.marked_by_source).reduce((s, x) => s + Number(x.points), 0);
      Object.assign(a, { manual_points: String(mp), total_points: String(Number(a.auto_points) + mp), status: "graded", needs_marking: 0 }); return [{ marked: 1, graded: 1 }];
    }],
    ["FROM lms_quizzes WHERE id = @z AND course_id = @c AND deleted_at IS NULL", (i) => (i.c === 5 && i.z === 4 && !st.quizDeleted ? [{ id: 4, title: "Quiz 1", shuffle_options: 0, max_attempts: 2 }] : [])],
    ["FROM lms_quizzes z JOIN lms_courses c", (i) => (i.c === 5 && i.id === 4 ? [{ id: 4, course_id: 5, title: "Quiz 1", instructions: null, assessment_type: "practice", available_from: null, due_at: null, time_limit_minutes: 10, max_attempts: 2, shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, question_count: 4, total_points: "11.00", course_status: "published" }] : [])],
    ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position", (i) => (i.z === 4 && i.c === 5 ? QUESTIONS : [])],
    ["FROM lms_quiz_answers WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c", (i) => st.answers.filter((x) => x.attempt_id === i.a && x.quiz_id === i.z && x.course_id === i.c)],
    ["FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c", (i) => st.attempts.filter((x) => x.id === i.a && i.z === 4 && i.c === 5)],
    ["FROM Students WHERE id = @s", () => [{ name: "Amina Test", admissionNo: "A-001" }]],
    ["status = 'in_progress' AND deadline_at IS NOT NULL", () => st.expired],
    ["UPDATE lms_quiz_attempts SET status = @st", (i) => { const a = st.expired.find((x) => x.id === i.a); if (!a) return [{ claimed: 0 }]; st.expired = st.expired.filter((x) => x.id !== i.a); st.attempts.push(att({ id: a.id, status: i.st, needs_marking: i.nm ? 1 : 0 })); return [{ claimed: 1 }]; }],
    ["SELECT COUNT(*) AS n FROM lms_quiz_attempts a WHERE", (i) => [{ n: st.attempts.filter((a) => a.id && i.z === 4 && i.c === 5).length }]],
    ["FROM lms_quiz_attempts a LEFT JOIN Students s", (i) => (i.z === 4 && i.c === 5 ? st.attempts.map((a) => ({ ...a, student_name: "Amina Test", admission_no: "A-001" })) : [])],
  ];
  return { st, m: makeMockPool(rs) };
}
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));

/* ---------------- pure ---------------- */
test("validateMark: 0..max, at most 2 decimals, numeric strings ok, comment trimmed/cleaned/limited", () => {
  assert.deepStrictEqual(G.validateMark({ points: "2.5", comment: "  Good <script>  " }, 5), { ok: true, points: 2.5, comment: "Good script" });
  assert.strictEqual(G.validateMark({ points: 0 }, 5).ok, true); assert.strictEqual(G.validateMark({ points: 5 }, 5).ok, true);
  for (const bad of [{ points: -1 }, { points: 5.01 }, { points: 1.234 }, { points: "abc" }, { points: null }, {}, { points: NaN }, { points: Infinity }]) assert.strictEqual(G.validateMark(bad, 5).ok, false, JSON.stringify(bad));
  assert.strictEqual(G.validateMark({ points: 1, comment: "x".repeat(2001) }, 5).ok, false); assert.strictEqual(G.validateMark({ points: 1, comment: 5 }, 5).ok, false);
  assert.strictEqual(G.validateMark({ points: 1, comment: "   " }, 5).comment, null); assert.strictEqual(G.validateMark(null, 5).ok, false); assert.strictEqual(G.validateMark([1], 5).ok, false);
});

/* ---------------- queue ---------------- */
test("queue: submitted + graded attempts with name/points/needsMarking, paged; bad filter = 400; other course or deleted quiz = not found; no in-progress attempts listed", async () => {
  const w = world(); const r = await G.listAttempts(w.m.pool, teacher, 5, 4, { filter: "needs_marking", page: 1, pageSize: 10, now: at(10), tenant: "qg-1" });
  assert.ok(r.ok); assert.deepStrictEqual([r.total, r.items.length, r.items[0].studentName, r.items[0].needsMarking, r.items[0].autoPoints, r.items[0].totalPoints, r.items[0].maxPoints], [1, 1, "Amina Test", true, 3, null, 11]);
  const q = sqlOf(w.m, /FROM lms_quiz_attempts a LEFT JOIN Students/); assert.ok(/a\.quiz_id = @z AND a\.course_id = @c AND a\.status = 'submitted' AND a\.needs_marking = 1/.test(q.sql) && /OFFSET @off ROWS FETCH NEXT @size ROWS ONLY/.test(q.sql));
  assert.ok(!/in_progress/.test(q.sql), "the list never contains in-progress attempts");
  const all = sqlOf((await (async () => { const x = world(); await G.listAttempts(x.m.pool, teacher, 5, 4, { now: at(10) }); return x; })()).m, /LEFT JOIN Students/); assert.ok(/a\.status IN \('submitted','graded'\)/.test(all.sql));
  assert.deepStrictEqual([(await G.listAttempts(world().m.pool, teacher, 5, 4, { filter: "x" })).ok, (await G.listAttempts(world().m.pool, teacher, 6, 4, {})).notFound, (await G.listAttempts(world().m.pool, teacher, 5, 9, {})).notFound, (await G.listAttempts(world({ quizDeleted: true }).m.pool, teacher, 5, 4, {})).notFound], [false, true, true, true]);
  assert.strictEqual((await G.listAttempts(world().m.pool, teacher, 5, 4, { pageSize: 5000 })).pageSize, 100, "page size is capped");
});
test("queue: an in-progress attempt past deadline + grace is closed first with its saved answers (A88); one still inside its time is untouched", async () => {
  const exp = [{ id: 71, quiz_id: 4, course_id: 5, student_id: 22, attempt_no: 1, status: "in_progress", seed: SEED, started_at: T0.toISOString(), deadline_at: at(600).toISOString(), submitted_at: null, auto_submitted: 0, auto_points: null, manual_points: null, total_points: null, max_points: "11.00", needs_marking: 0 }];
  const w = world({ expired: exp, answers: [] }); const r = await G.listAttempts(w.m.pool, teacher, 5, 4, { now: at(700), tenant: "qg-2" }); assert.ok(r.ok); assert.strictEqual(r.closedExpired, 1);
  const sw = sqlOf(w.m, /deadline_at IS NOT NULL/); assert.ok(/status = 'in_progress' AND deadline_at IS NOT NULL AND deadline_at < @cut/.test(sw.sql) && /SELECT TOP 50/.test(sw.sql));
  assert.strictEqual(sw.inputs.cut.getTime(), at(700 - A.GRACE_SECONDS).getTime(), "cut = now - grace");
  const up = sqlOf(w.m, /UPDATE lms_quiz_attempts SET status = @st/); assert.strictEqual(up.inputs.s, 22, "closed for the learner who owned it"); assert.strictEqual(up.inputs.auto, 1);
});

/* ---------------- attempt view ---------------- */
test("attempt view: every answer with stem, the learner's answer in POSITIONS, the key and status; student text is returned as data; in-progress / other course = not found; no-store is a route concern", async () => {
  const r = await G.getAttempt(world().m.pool, 5, 4, 70); assert.ok(r.ok);
  const a = r.attempt; assert.deepStrictEqual([a.studentName, a.admissionNo, a.status, a.needsMarking, a.answers.length], ["Amina Test", "A-001", "submitted", true, 4]);
  const mc = a.answers[1]; assert.deepStrictEqual([mc.status, mc.points, mc.needsMarking], ["correct", 1, false]); assert.ok(JSON.stringify(mc.key).includes("Nairobi") || JSON.stringify(mc.key).includes("2"), "key present for staff");
  const es = a.answers[2]; assert.deepStrictEqual([es.needsMarking, es.points, es.maxPoints, es.yourAnswer], [true, null, 5, { text: "My <b>essay</b> A" }]);
  assert.strictEqual((await G.getAttempt(world({ attempts: [att({ status: "in_progress" })] }).m.pool, 5, 4, 70)).notFound, true);
  for (const [c, z, id] of [[6, 4, 70], [5, 9, 70], [5, 4, 71], [5, 4, "x"]]) assert.strictEqual((await G.getAttempt(world().m.pool, c, z, id)).notFound, true, `${c}/${z}/${id}`);
});

/* ---------------- marking ---------------- */
test("mark: first essay = attempt stays submitted; LAST essay = ONE guarded transaction, graded, total = auto + manual; event once; audit; comment only as a parameter", async () => {
  const seen = []; const off = events.on("*", (e) => seen.push(e)); const w = world();
  const one = await G.markAnswer(w.m.pool, teacher, 5, 4, 70, 3, { points: 4, comment: "Strong argument'; DROP TABLE x;--" }, { now: at(20), tenant: "qg-3" });
  assert.ok(one.ok && one.graded === false); assert.deepStrictEqual([w.st.attempts[0].status, one.attempt.needsMarking, one.attempt.answers[2].status, one.attempt.answers[2].points], ["submitted", true, "marked", 4]);
  const q = sqlOf(w.m, /^SET XACT_ABORT ON; BEGIN TRAN; DECLARE @marked/); assert.ok(q && /quiz_question_id = @q AND status = 'manual' AND EXISTS \(SELECT 1 FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c AND status = 'submitted'\)/.test(q.sql) && /total_points = ISNULL\(auto_points, 0\) \+ \(SELECT ISNULL\(SUM\(points\), 0\) FROM lms_quiz_answers WHERE attempt_id = @a AND marked_by_source IS NOT NULL\)/.test(q.sql) && /status = 'graded', needs_marking = 0/.test(q.sql) && /AND status = 'submitted' AND NOT EXISTS/.test(q.sql) && /COMMIT/.test(q.sql));
  assert.ok(!q.sql.includes("DROP TABLE") && q.inputs.cm.includes("DROP TABLE"), "comment is a parameter, never SQL text");
  assert.deepStrictEqual([q.inputs.src, q.inputs.by, q.inputs.p], ["Teachers", 7, 4]);
  const two = await G.markAnswer(w.m.pool, teacher, 5, 4, 70, 4, { points: 2.5 }, { now: at(30), tenant: "qg-3" });
  assert.ok(two.ok && two.graded === true); assert.deepStrictEqual([w.st.attempts[0].status, w.st.attempts[0].manual_points, w.st.attempts[0].total_points, w.st.attempts[0].needs_marking], ["graded", "6.5", "9.5", 0]);
  assert.deepStrictEqual([two.attempt.status, two.attempt.totalPoints, two.attempt.manualPoints, two.attempt.needsMarking], ["graded", 9.5, 6.5, false]);
  await tick(); assert.deepStrictEqual(seen.filter((e) => e.tenant === "qg-3").map((e) => e.event), ["lms.quiz.graded"], "graded event only when the attempt became graded"); assert.strictEqual(seen.find((e) => e.tenant === "qg-3").manual, true, "flagged as teacher-marked (Q46 notice)"); off();
  assert.ok(w.m.log.filter((x) => /lms_audit_log/.test(x.sql)).length >= 2, "each mark is audited");
});
test("mark: refusals - graded attempt cannot be re-marked (Q34 default); auto-marked answer = NOT_MANUAL; in-progress = ATTEMPT_NOT_SUBMITTED; points over max / bad comment = 400; unknown ids = not found; lost race = CHANGED", async () => {
  const g = world({ attempts: [att({ status: "graded", needs_marking: 0 })] }); const re = await G.markAnswer(g.m.pool, teacher, 5, 4, 70, 3, { points: 1 }, {}); assert.deepStrictEqual([re.ok, re.code], [false, "ATTEMPT_GRADED"]);
  assert.strictEqual(g.m.log.some((x) => /UPDATE lms_quiz_answers/.test(x.sql)), false, "nothing was written");
  assert.strictEqual((await G.markAnswer(world().m.pool, teacher, 5, 4, 70, 1, { points: 1 }, {})).code, "NOT_MANUAL");
  assert.strictEqual((await G.markAnswer(world({ attempts: [att({ status: "in_progress" })] }).m.pool, teacher, 5, 4, 70, 3, { points: 1 }, {})).code, "ATTEMPT_NOT_SUBMITTED");
  const over = await G.markAnswer(world().m.pool, teacher, 5, 4, 70, 3, { points: 5.5 }, {}); assert.deepStrictEqual([over.ok, over.errors[0]], [false, "points must be between 0 and 5."]);
  for (const [c, z, a, k] of [[6, 4, 70, 3], [5, 9, 70, 3], [5, 4, 99, 3], [5, 4, 70, 99], [5, 4, 70, "x"]]) assert.strictEqual((await G.markAnswer(world().m.pool, teacher, c, z, a, k, { points: 1 }, {})).notFound, true, `${c}/${z}/${a}/${k}`);
  assert.strictEqual((await G.markAnswer(world({ markRace: true }).m.pool, teacher, 5, 4, 70, 3, { points: 1 }, {})).code, "CHANGED");
});
test("learner result after grading: essay points + the teacher's comment appear; graded total adds up; still nothing for another learner", async () => {
  const w = world({ attempts: [att({ status: "graded", needs_marking: 0, manual_points: "6.50", total_points: "9.50" })], answers: ANSWERS().map((x) => (x.quiz_question_id === 3 ? { ...x, status: "marked", points: "4.00", comment: "Well argued", marked_by_source: "Teachers" } : x.quiz_question_id === 4 ? { ...x, status: "marked", points: "2.50", marked_by_source: "Teachers" } : x)) });
  const rs = [["FROM lms_quizzes z JOIN lms_courses c", () => [{ id: 4, course_id: 5, title: "Quiz 1", instructions: null, assessment_type: "practice", available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 2, shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, question_count: 4, total_points: "11.00", course_status: "published" }]],
    ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position", () => QUESTIONS], ["FROM lms_quiz_answers WHERE attempt_id = @a", (i) => w.st.answers.filter((x) => i.s === 21 && x.attempt_id === i.a)],
    ["FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s", (i) => w.st.attempts.filter((x) => i.s === x.student_id && x.id === i.a)]];
  const r = await A.getAttempt(makeMockPool(rs).pool, student, 5, 4, 70, { now: at(100) }); assert.ok(r.ok, JSON.stringify(r.errors));
  const essay = r.attempt.questions.find((x) => x.id === 3); assert.deepStrictEqual([r.attempt.status, r.attempt.score, essay.status, essay.points, essay.comment], ["graded", { points: 9.5, max: 11, pending: false }, "marked", 4, "Well argued"]);
  assert.strictEqual((await A.getAttempt(makeMockPool(rs).pool, { id: 22, role: "student", source: "Students" }, 5, 4, 70, { now: at(100) })).notFound, true, "another learner cannot read it");
});

/* ---------------- isolation / routes / schema ---------------- */
test("isolation: every query of the grading module is scoped by course AND quiz; the tenant database is the pool, so school B's pool never sees school A's rows", async () => {
  const w = world(); await G.listAttempts(w.m.pool, teacher, 5, 4, { now: at(5) }); await G.getAttempt(w.m.pool, 5, 4, 70); await G.markAnswer(w.m.pool, teacher, 5, 4, 70, 3, { points: 1 }, { now: at(6) });
  for (const x of w.m.log.filter((l) => /lms_quiz_(attempts|answers|questions)/.test(l.sql) && !/lms_audit_log/.test(l.sql))) assert.ok(/course_id = @c/.test(x.sql) && (/quiz_id = @z/.test(x.sql) || /id = @a/.test(x.sql) || /z\.id = @id/.test(x.sql)), x.sql.slice(0, 90));
  const b = world({ attempts: [], answers: [] }); assert.strictEqual((await G.getAttempt(b.m.pool, 5, 4, 70)).notFound, true, "school B has no attempt 70");
});
test("routes: 3 staff routes, each = lms_quizzes gate FIRST, then lms.submission.grade, then course membership; without the flag 403 MODULE_NOT_LICENSED; students have no staff route", async () => {
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/quizzes\/:quizId\/attempts/.test(l.route.path));
  const sig = mine.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`); assert.strictEqual(mine.length, 3, sig.join(", "));
  for (const s of ["get /courses/:courseId/quizzes/:quizId/attempts", "get /courses/:courseId/quizzes/:quizId/attempts/:attemptId", "put /courses/:courseId/quizzes/:quizId/attempts/:attemptId/answers/:quizQuestionId/mark"]) assert.ok(sig.includes(s), s);
  assert.ok(mine.every((l) => l.route.stack.length === 4), "gate + permission + membership + handler");
  const rows = [["FROM tenant_modules", () => [{ module_key: "lms", enabled: 1, flags_json: JSON.stringify(["lms_core", "lms_assignments"]), limits_json: "{}", note: null, updatedAt: null }]]];
  const res = makeRes(); let nexted = false; await mine[0].route.stack[0].handle({ user: teacher, pool: makeMockPool(rows).pool, tenant: "qg-r1", params: { courseId: "5" } }, res, () => { nexted = true; });
  assert.deepStrictEqual([nexted, res.statusCode, res.body.code, res.body.flag], [false, 403, "MODULE_NOT_LICENSED", "lms_quizzes"]);
});
test("schema step 027: additive only (guarded ADD of nullable columns + one index), registered in the test runner", () => {
  const fs = require("fs"); const src = fs.readFileSync(require.resolve("../utils/lmsSchema"), "utf8"); const i = src.indexOf('"027_lms_quiz_marking"'); assert.ok(i > 0); const step = src.slice(i, src.indexOf("\n  },", i));
  for (const c of ["comment NVARCHAR(2000) NULL", "marked_by_source NVARCHAR(20) NULL", "marked_by INT NULL", "marked_at DATETIME2 NULL"]) assert.ok(step.includes(`IF COL_LENGTH('lms_quiz_answers', '${c.split(" ")[0]}') IS NULL ALTER TABLE lms_quiz_answers ADD ${c}`), c);
  assert.ok(!/DROP |DELETE |TRUNCATE |FOREIGN KEY|REFERENCES/.test(step) && /IF NOT EXISTS \(SELECT \* FROM sys\.indexes WHERE name='IX_lms_quiz_attempts_quiz'/.test(step));
  assert.ok(fs.readFileSync(require.resolve("./run-all.js"), "utf8").includes('lmsQuizGrading.test.js'));
});
