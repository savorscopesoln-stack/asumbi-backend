/* L6.3a - practice centre modes (D-081): quiz | revision | mock on lms_quizzes.quiz_mode; mode rules, mode filter (staff + student), mode on student items, routes pass ?mode=.
   Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsPracticeModes.test.js");
const Z = require("../utils/lmsQuizzes");
const A = require("../utils/lmsQuizAttempts");
const schema = require("../utils/lmsSchema");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const QROW = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Set", instructions: null, assessment_type: "practice", status: "draft", published_at: null, available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 3,
  shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", question_count: 2, total_points: "2.00", rule_count: 0, ...o });
const LOADQ = (row = QROW()) => ["FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c", (i) => (i.id === row.id && i.c === row.course_id ? [row] : [])];
const KQ = () => ["FROM lms_quiz_questions WHERE quiz_id = @id AND course_id = @c AND attempt_id IS NULL ORDER BY position", () => []];
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));
const created = (row) => [live(), ["SELECT COUNT(*) AS n FROM lms_quizzes", () => [{ n: 0 }]], ["INSERT INTO lms_quizzes", () => [{ id: 4 }]], LOADQ(row), KQ()];

test("validate: mode must be quiz, revision or mock; anything else is refused", () => {
  for (const m of Z.MODES) assert.ok(Z.validate({ title: "x", mode: m }).ok, m);
  assert.deepStrictEqual(Z.MODES, ["quiz", "revision", "mock", "flashcards"]);
  for (const bad of ["cards", "exam", "", null, 1, true]) assert.strictEqual(Z.validate({ title: "x", mode: bad }).ok, false, String(bad));
  assert.strictEqual(Z.validate({ title: "x" }).value.mode, undefined, "no mode given = nothing to merge, default applies later");
});

test("check: revision = practice + instant feedback + no timer + no due date; mock needs a timer; a normal quiz is unchanged; practice still never counts", () => {
  const base = { assessmentType: "practice", feedbackTiming: "immediate", countsToGrade: false, timeLimitMinutes: null, dueAt: null };
  assert.deepStrictEqual(Z.check({ ...base, mode: "revision" }), []);
  for (const bad of [{ assessmentType: "coursework" }, { feedbackTiming: "never" }, { feedbackTiming: "after_close", dueAt: new Date("2026-12-01") }, { timeLimitMinutes: 10 }, { dueAt: new Date("2026-12-01") }]) {
    assert.ok(Z.check({ ...base, mode: "revision", ...bad }).length >= 1, JSON.stringify(bad));
  }
  assert.ok(Z.check({ ...base, mode: "mock" }).length === 1, "mock without a timer");
  assert.deepStrictEqual(Z.check({ ...base, mode: "mock", timeLimitMinutes: 45 }), []);
  assert.deepStrictEqual(Z.check({ ...base, mode: "mock", timeLimitMinutes: 45, assessmentType: "coursework", countsToGrade: true, feedbackTiming: "after_close", dueAt: new Date("2026-12-01") }), [], "a counting mock must be coursework");
  assert.ok(Z.check({ ...base, mode: "mock", timeLimitMinutes: 45, countsToGrade: true }).length, "practice mock can never count");
  assert.deepStrictEqual(Z.check({ ...base, mode: "quiz", feedbackTiming: "never", timeLimitMinutes: 10 }), [], "old behaviour untouched");
  assert.deepStrictEqual(Z.check({ ...base, feedbackTiming: "never" }), [], "no mode at all = quiz");
});

test("create: default mode is a normal quiz (stored NULL); revision/mock stored as a parameter; bad combinations refused before any write", async () => {
  const m1 = makeMockPool(created(QROW()));
  const r1 = await Z.createQuiz(m1.pool, teacher, 5, { title: "Plain" }); assert.ok(r1.ok, JSON.stringify(r1.errors));
  const w1 = sqlOf(m1, /^INSERT INTO lms_quizzes/); assert.ok(/quiz_mode/.test(w1.sql) && w1.inputs.md === null && r1.quiz.mode === "quiz");
  const m2 = makeMockPool(created(QROW({ quiz_mode: "revision" })));
  const r2 = await Z.createQuiz(m2.pool, teacher, 5, { title: "Revise ch 1", mode: "revision", maxAttempts: 10 }); assert.ok(r2.ok, JSON.stringify(r2.errors));
  const w2 = sqlOf(m2, /^INSERT INTO lms_quizzes/); assert.strictEqual(w2.inputs.md, "revision"); assert.strictEqual(r2.quiz.mode, "revision");
  assert.ok(!/revision/.test(w2.sql), "mode is a parameter, never text in the SQL");
  const m3 = makeMockPool([]); const r3 = await Z.createQuiz(m3.pool, teacher, 5, { title: "x", mode: "revision", timeLimitMinutes: 20 }); assert.strictEqual(r3.ok, false); assert.strictEqual(m3.log.length, 0, "refused before touching the database");
  const m4 = makeMockPool([]); const r4 = await Z.createQuiz(m4.pool, teacher, 5, { title: "x", mode: "mock" }); assert.strictEqual(r4.ok, false); assert.ok(/time limit/i.test(r4.errors.join(" ")));
  const m5 = makeMockPool(created(QROW({ quiz_mode: "mock", time_limit_minutes: 30 }))); const r5 = await Z.createQuiz(m5.pool, teacher, 5, { title: "Mock 1", mode: "mock", timeLimitMinutes: 30 }); assert.ok(r5.ok); assert.strictEqual(r5.quiz.mode, "mock");
});

test("update: the merged result is checked (adding a timer to a revision set is refused); mode can change only while a draft; clearing the mode back to quiz stores NULL", async () => {
  const rev = QROW({ quiz_mode: "revision" });
  const m1 = makeMockPool([live(), LOADQ(rev), KQ()]);
  const r1 = await Z.updateQuiz(m1.pool, teacher, 5, 4, { timeLimitMinutes: 15 }); assert.strictEqual(r1.ok, false); assert.ok(!m1.log.some((x) => /^UPDATE lms_quizzes/.test(x.sql)), "nothing written");
  const m2 = makeMockPool([live(), LOADQ(rev), ["FROM lms_quiz_attempts", () => []], KQ()]);
  const r2 = await Z.updateQuiz(m2.pool, teacher, 5, 4, { mode: "quiz", timeLimitMinutes: 15 }); assert.ok(r2.ok, JSON.stringify(r2.errors));
  assert.strictEqual(sqlOf(m2, /^UPDATE lms_quizzes/).inputs.md, null);
  const pub = QROW({ status: "published", quiz_mode: "revision" });
  const m3 = makeMockPool([live(), LOADQ(pub), KQ()]);
  const r3 = await Z.updateQuiz(m3.pool, teacher, 5, 4, { mode: "quiz" }); assert.deepStrictEqual([r3.ok, r3.code], [false, "QUIZ_PUBLISHED"]);
  const m4 = makeMockPool([live(), LOADQ(pub), KQ()]);
  const r4 = await Z.updateQuiz(m4.pool, teacher, 5, 4, { mode: "revision", title: "Renamed" }); assert.ok(r4.ok, "same mode on a published set is fine");
  const old = QROW({ quiz_mode: undefined, feedback_timing: "never", time_limit_minutes: 20 });
  const m5 = makeMockPool([live(), LOADQ(old), KQ()]);
  const r5 = await Z.updateQuiz(m5.pool, teacher, 5, 4, { title: "Old quiz renamed" }); assert.ok(r5.ok, "an older row with no mode keeps working: " + JSON.stringify(r5.errors));
  assert.strictEqual(sqlOf(m5, /^UPDATE lms_quizzes/).inputs.md, null);
});

test("staff list: ?mode= filters in SQL as a parameter ('quiz' also matches NULL rows); unknown mode = no filter; every query still matches the course", async () => {
  const row = QROW({ quiz_mode: "mock", total_count: 1 });
  const m = makeMockPool([["FROM lms_quizzes z WHERE z.course_id = @c", () => [row]]]);
  const r = await Z.listQuizzes(m.pool, 5, { mode: "mock" }); assert.strictEqual(r.items[0].mode, "mock");
  const q = m.log[0]; assert.strictEqual(q.inputs.md, "mock"); assert.ok(/ISNULL\(z\.quiz_mode, 'quiz'\) = @md/.test(q.sql) && /z\.course_id = @c/.test(q.sql) && !/mock/.test(q.sql));
  const m2 = makeMockPool([["FROM lms_quizzes z WHERE z.course_id = @c", () => []]]); await Z.listQuizzes(m2.pool, 5, { mode: "x'; DROP TABLE lms_quizzes;--" }); assert.strictEqual(m2.log[0].inputs.md, null);
  const m3 = makeMockPool([["FROM lms_quizzes z WHERE z.course_id = @c", () => []]]); await Z.listQuizzes(m3.pool, 5, {}); assert.strictEqual(m3.log[0].inputs.md, null);
});

test("student list: items carry the mode (older rows = quiz); ?mode= is a parameter; the existing visibility rules and the course match stay", async () => {
  const rows = [{ ...QROW({ status: "published", quiz_mode: "revision", total_count: 2 }), course_status: "published" }, { ...QROW({ id: 5, status: "published", total_count: 2 }), course_status: "published" }];
  const m = makeMockPool([["FROM lms_quizzes z JOIN lms_courses c", () => rows], ["FROM lms_quiz_attempts WHERE course_id = @c AND student_id = @s", () => []]]);
  const r = await A.listForStudent(m.pool, student, 5, { mode: "revision" }, { now: new Date("2026-11-02T10:00:00Z") });
  assert.deepStrictEqual(r.items.map((x) => x.mode), ["revision", "quiz"]);
  const q = m.log[0]; assert.strictEqual(q.inputs.md, "revision"); assert.ok(/z\.status = 'published'/.test(q.sql) && /z\.course_id = @c/.test(q.sql) && /ISNULL\(z\.quiz_mode, 'quiz'\) = @md/.test(q.sql));
  const m2 = makeMockPool([["FROM lms_quizzes z JOIN lms_courses c", () => []]]); await A.listForStudent(m2.pool, student, 5, { mode: "cards" }, { now: new Date() }); assert.strictEqual(m2.log[0].inputs.md, null);
});

test("routes: both list routes pass ?mode= through to the services", async () => {
  const router = require("../routes/lms");
  const staff = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/quizzes" && l.route.methods.get);
  const stu = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/quizzes" && l.route.methods.get);
  assert.ok(staff && stu);
  const m = makeMockPool([["FROM lms_quizzes z WHERE z.course_id = @c", () => []]]); const res = makeRes();
  await staff.route.stack[staff.route.stack.length - 1].handle({ pool: m.pool, user: teacher, params: { courseId: "5" }, query: { mode: "mock" }, tenant: "pm-a" }, res);
  assert.strictEqual(m.log[0].inputs.md, "mock");
  const m2 = makeMockPool([["FROM lms_quizzes z JOIN lms_courses c", () => []]]); const res2 = makeRes();
  await stu.route.stack[stu.route.stack.length - 1].handle({ pool: m2.pool, user: student, params: { courseId: "5" }, query: { mode: "revision" }, tenant: "pm-a" }, res2);
  assert.strictEqual(m2.log[0].inputs.md, "revision");
});

test("schema step 029: one additive, re-runnable column on lms_quizzes, after step 028", () => {
  const i28 = schema.STEPS.findIndex((s) => s.id === "028_lms_quiz_rules"), i29 = schema.STEPS.findIndex((s) => s.id === "029_lms_quiz_mode");
  assert.ok(i28 >= 0 && i29 === i28 + 1, "029 follows 028");
  const text = schema.STEPS[i29].sql.join("\n");
  assert.ok(/IF COL_LENGTH\('lms_quizzes', 'quiz_mode'\) IS NULL ALTER TABLE lms_quizzes ADD quiz_mode NVARCHAR\(12\) NULL/.test(text));
  assert.ok(!/DROP|DELETE|UPDATE|TRUNCATE/i.test(text.replace(/--[^\n]*/g, "")));
});
