/* L6.2a - quiz definitions: validation, create/update/publish, question SNAPSHOTS, ordering, routes + licence gate. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
suite("lmsQuizzes.test.js");
const Z = require("../utils/lmsQuizzes");
const events = require("../utils/lmsEvents");
const schema = require("../utils/lmsSchema");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = { id: 21, role: "student", source: "Students" };
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const QROW = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Quiz", instructions: null, assessment_type: "practice", status: "draft", published_at: null, available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 1,
  shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", question_count: 2, total_points: "3.00", ...o });
/* LOADQ: a quiz of course 5 only (other course ids find nothing, like a real separate row set) */
const LOADQ = (row = QROW()) => ["FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c", (i) => (i.id === row.id && i.c === row.course_id ? [row] : [])];
const KQ = (rows = []) => ["FROM lms_quiz_questions WHERE quiz_id = @id AND course_id = @c AND attempt_id IS NULL ORDER BY position", () => rows];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_quizzes", () => [{ n }]];
const NEWQ = (id = 4) => ["INSERT INTO lms_quizzes", () => [{ id }]];
const BANK = (rows) => ["FROM lms_questions q WHERE q.id IN", () => rows];
const brow = (o = {}) => ({ id: 11, scope: "school", course_id: null, owner_source: "Teachers", owner_id: 2, type: "true_false", stem: "Is it?", explanation: "Because", points: "2.00", difficulty: "easy", subject: null, topic: null, spec_json: JSON.stringify({ correct: true }), version: 6, ...o });
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));
const quizSaved = (extra = []) => [live(), COUNT(0), NEWQ(), LOADQ(QROW({ question_count: 0, total_points: "0" })), KQ(), ...extra];

test("validate: fields, bounds, plain text; controlled_exam has its own error code; unknown fields refused", () => {
  const ok = Z.validate({ title: "  <b>Week 1</b> quiz ", instructions: "Read <script>x</script>\r\n\r\n\r\n\r\nall", assessmentType: "coursework", timeLimitMinutes: "30", maxAttempts: 3, shuffleQuestions: true, feedbackTiming: "never" });
  assert.ok(ok.ok, JSON.stringify(ok.errors)); assert.strictEqual(ok.value.title, "bWeek 1/b quiz"); assert.ok(!/[<>]/.test(ok.value.instructions) && !/\n\n\n/.test(ok.value.instructions)); assert.strictEqual(ok.value.timeLimitMinutes, 30);
  const ce = Z.validate({ title: "x", assessmentType: "controlled_exam" }); assert.deepStrictEqual([ce.ok, ce.code], [false, "CONTROLLED_EXAM_NOT_IN_LMS"]);
  for (const bad of [{}, { title: "" }, { title: "x".repeat(201) }, { title: "x", timeLimitMinutes: 0 }, { title: "x", timeLimitMinutes: 601 }, { title: "x", maxAttempts: 0 }, { title: "x", maxAttempts: 21 }, { title: "x", shuffleOptions: "yes" },
    { title: "x", feedbackTiming: "sometimes" }, { title: "x", assessmentType: "exam" }, { title: "x", dueAt: "2026-11-02 17:00" }, { title: "x", dueAt: "2026-11-02T17:00:00" }, { title: "x", extra: 1 }, { title: "x", instructions: "y".repeat(4001) }, null, []]) {
    assert.strictEqual(Z.validate(bad).ok, false, JSON.stringify(bad));
  }
  assert.ok(Z.validate({ timeLimitMinutes: null }, { partial: true }).ok, "partial: no title needed; null = no limit");
});

test("check: practice never counts to a grade; after_close needs a due date; available must not be after due", () => {
  assert.ok(Z.check({ assessmentType: "practice", countsToGrade: true, feedbackTiming: "immediate" }).length);
  assert.deepStrictEqual(Z.check({ assessmentType: "coursework", countsToGrade: true, feedbackTiming: "immediate" }), []);
  assert.ok(Z.check({ assessmentType: "practice", feedbackTiming: "after_close", dueAt: null }).length);
  assert.ok(Z.check({ assessmentType: "practice", feedbackTiming: "immediate", availableFrom: new Date("2026-12-01"), dueAt: new Date("2026-11-01") }).length);
});

test("create: a DRAFT, parameterised, audited; text only as parameters; publishing at creation refused; archived course, bad section and the 200 limit are refused", async () => {
  const m = makeMockPool([...quizSaved(), ["FROM lms_course_sections", () => []]]);
  const r = await Z.createQuiz(m.pool, teacher(), 5, { title: "x'; DROP TABLE lms_quizzes;--", assessmentType: "coursework", countsToGrade: true, dueAt: "2026-11-02T17:00:00+03:00" });
  assert.ok(r.ok, JSON.stringify(r.errors)); const w = sqlOf(m, /^INSERT INTO lms_quizzes/);
  assert.ok(w && !/DROP TABLE/.test(w.sql) && /'draft'/.test(w.sql) && w.inputs.t.includes("DROP TABLE") && w.inputs.c === 5 && w.inputs.cg === true && w.inputs.ty === "coursework", "text is a parameter; status literal draft");
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)), "audited");
  const pub = await Z.createQuiz(makeMockPool([]).pool, teacher(), 5, { title: "x", status: "published" }); assert.deepStrictEqual([pub.ok, pub.code], [false, "NO_QUESTIONS"]);
  const arch = await Z.createQuiz(makeMockPool([live("archived")]).pool, teacher(), 5, { title: "x" }); assert.deepStrictEqual([arch.ok, arch.code], [false, "COURSE_ARCHIVED"]);
  const sec = await Z.createQuiz(makeMockPool([live(), COUNT(0), ["FROM lms_course_sections", () => []]]).pool, teacher(), 5, { title: "x", sectionId: 9 }); assert.strictEqual(sec.ok, false);
  const lim = await Z.createQuiz(makeMockPool([live(), COUNT(200)]).pool, teacher(), 5, { title: "x" }); assert.deepStrictEqual([lim.ok, lim.code], [false, "QUIZ_LIMIT"]);
  const ex = await Z.createQuiz(makeMockPool([]).pool, teacher(), 5, { title: "x", assessmentType: "controlled_exam" }); assert.strictEqual(ex.code, "CONTROLLED_EXAM_NOT_IN_LMS");
  const pc = await Z.createQuiz(makeMockPool([]).pool, teacher(), 5, { title: "x", countsToGrade: true }); assert.strictEqual(pc.ok, false, "practice + countsToGrade refused");
});

test("get/list: every query also matches the course; another course's quiz is 'not found'; paged", async () => {
  const m = makeMockPool([LOADQ(), KQ([{ id: 1, position: 1, type: "true_false", stem: "s", explanation: null, points: "1.00", difficulty: null, spec_json: JSON.stringify({ correct: true }), source_question_id: 11, source_version: 6 }])]);
  const r = await Z.getQuiz(m.pool, 5, 4); assert.ok(r.ok); assert.deepStrictEqual([r.quiz.questionCount, r.quiz.totalPoints, r.quiz.questions[0].spec.correct, r.quiz.questions[0].sourceVersion], [2, 3, true, 6]);
  assert.ok(m.log.every((x) => /course_id = @c/.test(x.sql)), "course matched in every query");
  const other = await Z.getQuiz(makeMockPool([LOADQ()]).pool, 6, 4); assert.strictEqual(other.notFound, true);
  assert.strictEqual((await Z.getQuiz(makeMockPool([]).pool, 5, "abc")).notFound, true);
  const l = makeMockPool([["FROM lms_quizzes z WHERE z.course_id = @c", () => [{ ...QROW(), total_count: 31 }]]]); const lr = await Z.listQuizzes(l.pool, 5, { page: "2", pageSize: "500", status: "weird" });
  assert.deepStrictEqual([lr.total, lr.page, lr.pageSize, l.log[0].inputs.n, l.log[0].inputs.off, l.log[0].inputs.st], [31, 2, 100, 100, 100, null]);
});

test("update: publishing needs a question; publishing emits the event once; merged practice+countsToGrade refused; unknown quiz 404", async () => {
  const noQ = await Z.updateQuiz(makeMockPool([live(), LOADQ(QROW({ question_count: 0 }))]).pool, teacher(), 5, 4, { status: "published" }); assert.deepStrictEqual([noQ.ok, noQ.code], [false, "NO_QUESTIONS"]);
  const seen = []; const un = events.on ? events.on("lms.quiz.published", (e) => seen.push(e)) : null;
  const m = makeMockPool([live(), LOADQ(), KQ()]); const r = await Z.updateQuiz(m.pool, teacher(), 5, 4, { status: "published" }, { tenant: "qz-pub" }); assert.ok(r.ok, JSON.stringify(r.errors));
  const w = sqlOf(m, /^UPDATE lms_quizzes SET/); assert.ok(w && /WHERE id = @id AND course_id = @c AND deleted_at IS NULL/.test(w.sql) && w.inputs.st === "published");
  await require("./helpers/tick").tick(); if (events.on) assert.strictEqual(seen.filter((e) => e.tenant === "qz-pub").length, 1); if (typeof un === "function") un();
  const pc = await Z.updateQuiz(makeMockPool([live(), LOADQ()]).pool, teacher(), 5, 4, { countsToGrade: true }); assert.strictEqual(pc.ok, false, "stored practice quiz cannot be set to count");
  const toCw = makeMockPool([live(), LOADQ(), KQ()]); assert.ok((await Z.updateQuiz(toCw.pool, teacher(), 5, 4, { assessmentType: "coursework", countsToGrade: true })).ok);
  assert.strictEqual((await Z.updateQuiz(makeMockPool([live(), LOADQ()]).pool, teacher(), 5, 99, { title: "x" })).notFound, true);
  assert.strictEqual((await Z.updateQuiz(makeMockPool([]).pool, teacher(), 5, 4, {})).ok, false, "nothing to change");
});

test("delete: soft, matched by course; other course = not found; archived refused", async () => {
  const m = makeMockPool([live(), ["UPDATE lms_quizzes SET deleted_at", (i) => (i.c === 5 ? [{ id: i.id }] : [])]]); assert.ok((await Z.deleteQuiz(m.pool, teacher(), 5, 4)).ok);
  const w = sqlOf(m, /^UPDATE lms_quizzes SET deleted_at/); assert.ok(/WHERE id = @id AND course_id = @c AND deleted_at IS NULL/.test(w.sql) && !/DELETE FROM/.test(w.sql));
  assert.strictEqual((await Z.deleteQuiz(makeMockPool([live(), ["UPDATE lms_quizzes SET deleted_at", (i) => (i.c === 5 ? [{ id: i.id }] : [])]]).pool, teacher(), 6, 4)).notFound, true);
  assert.strictEqual((await Z.deleteQuiz(makeMockPool([live("archived")]).pool, teacher(), 5, 4)).code, "COURSE_ARCHIVED");
});

test("addQuestions: copies a SNAPSHOT (stem, points, spec, version) in ONE transaction at the next positions; hidden question = nothing written; duplicates, published quiz and limits refused", async () => {
  const m = makeMockPool([live(), LOADQ(), BANK([brow(), brow({ id: 12, type: "short_answer", spec_json: JSON.stringify({ accepted: ["a"] }), version: 2 })]), ["SELECT source_question_id FROM lms_quiz_questions", () => []], KQ()]);
  const r = await Z.addQuestions(m.pool, teacher(), 5, 4, { questionIds: [11, 12] }); assert.ok(r.ok, JSON.stringify(r.errors));
  const w = sqlOf(m, /INSERT INTO lms_quiz_questions/); assert.ok(w && /BEGIN TRAN/.test(w.sql) && /UPDLOCK, HOLDLOCK/.test(w.sql) && /@base \+ 1/.test(w.sql) && /@base \+ 2/.test(w.sql) && /COMMIT/.test(w.sql));
  assert.deepStrictEqual([w.inputs.s0, w.inputs.v0, w.inputs.t0, w.inputs.p0, w.inputs.j0, w.inputs.s1, w.inputs.v1, w.inputs.q, w.inputs.c], [11, 6, "true_false", 2, JSON.stringify({ correct: true }), 12, 2, 4, 5], "snapshot values come from the bank rows");
  const bankQ = sqlOf(m, /FROM lms_questions q WHERE q\.id IN/); assert.ok(/q\.deleted_at IS NULL/.test(bankQ.sql) && bankQ.inputs.src === "Teachers" && bankQ.inputs.uid === 7, "bank visibility applies to the caller");
  const hid = makeMockPool([live(), LOADQ(), BANK([brow()])]); const hr = await Z.addQuestions(hid.pool, teacher(), 5, 4, { questionIds: [11, 12] }); assert.strictEqual(hr.notFound, true); assert.ok(!hid.log.some((x) => /INSERT INTO lms_quiz_questions/.test(x.sql)), "nothing written");
  const dup = makeMockPool([live(), LOADQ(), BANK([brow()]), ["SELECT source_question_id FROM lms_quiz_questions", () => [{ source_question_id: 11 }]]]); assert.strictEqual((await Z.addQuestions(dup.pool, teacher(), 5, 4, { questionIds: [11] })).code, "DUPLICATE_QUESTION");
  const pub = await Z.addQuestions(makeMockPool([live(), LOADQ(QROW({ status: "published" }))]).pool, teacher(), 5, 4, { questionIds: [11] }); assert.deepStrictEqual([pub.ok, pub.code], [false, "QUIZ_PUBLISHED"]);
  const full = await Z.addQuestions(makeMockPool([live(), LOADQ(QROW({ question_count: 100 }))]).pool, teacher(), 5, 4, { questionIds: [11] }); assert.strictEqual(full.code, "QUIZ_QUESTION_LIMIT");
  for (const bad of [{}, { questionIds: [] }, { questionIds: [1, 1] }, { questionIds: ["x"] }, { questionIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { questionIds: [1], x: 1 }]) assert.strictEqual((await Z.addQuestions(makeMockPool([]).pool, teacher(), 5, 4, bad)).ok, false, JSON.stringify(bad).slice(0, 40));
  const adm = makeMockPool([live(), LOADQ(), BANK([brow()]), ["SELECT source_question_id FROM lms_quiz_questions", () => []], KQ()]); await Z.addQuestions(adm.pool, { id: 1, role: "admin", source: "Users" }, 5, 4, { questionIds: [11] }, { admin: true });
  assert.ok(!/private/.test(sqlOf(adm, /FROM lms_questions q WHERE q\.id IN/).sql), "an LMS administrator may add a private question (A75/A78)");
});

test("a later edit or delete in the bank cannot change the quiz: the quiz reads only lms_quiz_questions, never lms_questions", async () => {
  const m = makeMockPool([LOADQ(), KQ()]); await Z.getQuiz(m.pool, 5, 4); assert.ok(m.log.every((x) => !/lms_questions/.test(x.sql)), m.log.map((x) => x.sql).join(" | "));
});

test("removeQuestion / reorderQuestions: draft only, course matched; reorder must list every question exactly once; one UPDATE with CASE", async () => {
  const rm = makeMockPool([live(), LOADQ(), ["DELETE FROM lms_quiz_questions OUTPUT", (i) => (i.k === 1 && i.c === 5 ? [{ id: 1 }] : [])], KQ()]); assert.ok((await Z.removeQuestion(rm.pool, teacher(), 5, 4, 1)).ok);
  assert.ok(/WHERE id = @k AND quiz_id = @q AND course_id = @c/.test(sqlOf(rm, /^DELETE FROM lms_quiz_questions/).sql));
  assert.strictEqual((await Z.removeQuestion(makeMockPool([live(), LOADQ(), ["DELETE FROM lms_quiz_questions OUTPUT", () => []]]).pool, teacher(), 5, 4, 77)).notFound, true);
  assert.strictEqual((await Z.removeQuestion(makeMockPool([live(), LOADQ(QROW({ status: "published" }))]).pool, teacher(), 5, 4, 1)).code, "QUIZ_PUBLISHED");
  const cur = ["SELECT id FROM lms_quiz_questions WHERE quiz_id = @q", () => [{ id: 1 }, { id: 2 }, { id: 3 }]];
  const ok = makeMockPool([live(), LOADQ(), cur, KQ()]); assert.ok((await Z.reorderQuestions(ok.pool, teacher(), 5, 4, { ids: [3, 1, 2] })).ok);
  const w = sqlOf(ok, /^UPDATE lms_quiz_questions SET position = CASE id/); assert.ok(w && /WHEN @k0 THEN 1 WHEN @k1 THEN 2 WHEN @k2 THEN 3 END/.test(w.sql) && /course_id = @c/.test(w.sql) && w.inputs.k0 === 3);
  for (const ids of [[1, 2], [1, 2, 3, 4], [1, 2, 9], [1, 1, 2]]) { const m = makeMockPool([live(), LOADQ(), cur]); const r = await Z.reorderQuestions(m.pool, teacher(), 5, 4, { ids }); assert.strictEqual(r.ok, false, JSON.stringify(ids)); assert.ok(!m.log.some((x) => /^UPDATE lms_quiz_questions/.test(x.sql))); }
});

test("tenant isolation: a quiz id of school A is invisible in school B's database; B is never asked for A's data", async () => {
  const T = makeTenants({ A: [LOADQ(), KQ()], B: [LOADQ(QROW({ id: 999 }))] });
  assert.ok((await Z.getQuiz(T.A.pool, 5, 4)).ok); assert.strictEqual((await Z.getQuiz(T.B.pool, 5, 4)).notFound, true, "guessing id 4 in B finds nothing");
  const T2 = makeTenants({ A: [LOADQ(), KQ()], B: [] }); await Z.getQuiz(T2.A.pool, 5, 4); T2.assertUntouched("B"); T2.assertQueried("A");
});

test("schema step 025: idempotent CREATEs, no foreign keys, indexes, controlled exam not representable by default; blocklisted from the generic record API", () => {
  const src = require("fs").readFileSync(require.resolve("../utils/lmsSchema"), "utf8"); const i = src.indexOf('"025_lms_quizzes"'); assert.ok(i > 0); const step = src.slice(i, src.indexOf("\n  },", i));
  assert.ok(/IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_quizzes'/.test(step) && /IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_quiz_questions'/.test(step) && !/FOREIGN KEY|REFERENCES/.test(step) && /IX_lms_quiz_questions_quiz/.test(step) && /counts_to_grade BIT NOT NULL DEFAULT 0/.test(step));
  assert.ok(!/DROP |ALTER /.test(step), "additive only"); assert.ok(typeof schema.ensureLmsSchema === "function");
  const server = require("fs").readFileSync(require.resolve("../server.js"), "utf8"); assert.ok(/"lms_quizzes", "lms_quiz_questions"/.test(server));
});

test("routes: 14 quiz routes (8 definition + 4 random-rule routes + 1 publish-to-results route, L6.4 + 1 analytics route, L6.5), each runs the lms_quizzes flag gate first; writes need the permission; students never reach a handler", async () => {
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/quizzes/.test(l.route.path) && !/\/attempts/.test(l.route.path));
  assert.strictEqual(mine.length, 14, mine.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).join(", "));
  const order = mine.map((l) => l.route.path); assert.ok(order.indexOf("/courses/:courseId/quizzes/:quizId/questions/order") >= 0); assert.ok(order.includes("/courses/:courseId/quizzes/:quizId/publish-results"), "the L6.4 publish route is covered by the same gate/permission/access checks below");
  const writes = mine.filter((l) => !l.route.methods.get); assert.ok(writes.every((l) => l.route.stack.length === 4), "gate + permission + course access + handler"); assert.ok(mine.filter((l) => l.route.methods.get && !/\/analytics$/.test(l.route.path)).every((l) => l.route.stack.length === 3), "reads: gate + course access + handler"); assert.strictEqual(mine.find((l) => /\/analytics$/.test(l.route.path)).route.stack.length, 4, "the L6.5 analytics read also checks a permission (manage OR grade)");
  const rows = (flags, enabled = 1) => [["FROM tenant_modules", () => [{ module_key: "lms", enabled, flags_json: JSON.stringify(flags), limits_json: "{}", note: null, updatedAt: null }]]];
  const run = async (tenant, flags, enabled) => { const res = makeRes(); let nexted = false; const m = makeMockPool(rows(flags, enabled)); await mine[0].route.stack[0].handle({ user: teacher(), pool: m.pool, tenant }, res, () => { nexted = true; }); return { res, nexted }; };
  const noFlag = await run("qz-a", ["lms_core", "lms_assignments"]); assert.deepStrictEqual([noFlag.nexted, noFlag.res.statusCode, noFlag.res.body.code, noFlag.res.body.flag], [false, 403, "MODULE_NOT_LICENSED", "lms_quizzes"]);
  const yes = await run("qz-b", ["lms_core", "lms_quizzes"]); assert.strictEqual(yes.nexted, true);
  const post = mine.find((l) => l.route.methods.post && l.route.path.endsWith("/quizzes"));
  let stuNext = false; const sres = makeRes(); await post.route.stack[1].handle({ user: student, pool: makeMockPool([]).pool, tenant: "qz-c" }, sres, () => { stuNext = true; }); assert.deepStrictEqual([stuNext, sres.statusCode], [false, 403]);
});
