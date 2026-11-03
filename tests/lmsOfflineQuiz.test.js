/* L10.3c - queued offline QUIZ ANSWERS (D-118): eligibility (practice, untimed, not counted), validation, per-question guarded writes (never overwrite), conflicts with both answers,
   idempotency, closed/timed-out attempts, tenant isolation, route, schema 045. In-memory tables behind a mock pool; quiz/attempt/question loaders are per-call stubs (ctx.quizzes), never a shared global.
   SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsOfflineQuiz.test.js");
const O = require("../utils/lmsOfflineQuiz"), schema = require("../utils/lmsSchema");
const NOW = new Date("2026-11-10T09:00:00.000Z"), QT = "2026-11-09T18:00:00.000Z";
const quizOk = (o = {}) => ({ id: 9, courseId: 5, assessmentType: "practice", mode: "revision", timeLimitMinutes: null, countsToGrade: false, readOnly: false, ...o });
const QUESTIONS = [{ id: 1, type: "mcq_single", points: 1, spec: {} }, { id: 2, type: "short_answer", points: 1, spec: {} }, { id: 3, type: "essay", points: 5, spec: {} }];
const A = (o = {}) => ({ clientActionId: "act-00000001", type: "quiz_answers", quizId: 9, attemptId: 31, queuedAt: QT, answers: { 1: { value: { selected: 2 }, base: null } }, ...o });
const world = ({ quiz = quizOk(), attempt = {}, answers = {}, actions = [], beforeWrite } = {}) => {
  const rows = actions.map((r, i) => ({ id: 100 + i, ...r })); let next = 200;
  const st = { attempt: attempt === null ? null : { id: 31, status: "in_progress", deadlineAt: null, studentId: 21, ...attempt }, answers: { ...answers }, writes: 0, quiz };
  const m = makeMockPool([
    ["INSERT INTO lms_offline_actions", (i) => { if (rows.some((r) => r.student_id === i.s && r.client_action_id === i.a)) { const e = new Error("dup"); e.number = 2627; throw e; } const r = { id: next++, course_id: i.c, student_id: i.s, client_action_id: i.a, action_type: i.t, quiz_id: i.z, attempt_id: i.at, result_state: null, result_code: null }; rows.push(r); return [{ id: r.id }]; }],
    ["SELECT TOP 1 id, course_id, action_type, quiz_id", (i) => rows.filter((r) => r.student_id === i.s && r.client_action_id === i.a)],
    ["UPDATE lms_offline_actions SET result_state = @st", (i) => { const r = rows.find((x) => x.id === i.id && x.student_id === i.s); if (r) { r.result_state = i.st; r.result_code = i.cd; } return []; }],
    ["SELECT quiz_question_id, answer_json FROM lms_quiz_answers", (i) => (i.s === 21 && i.c === 5 ? Object.entries(st.answers).map(([k, v]) => ({ quiz_question_id: Number(k), answer_json: v })) : [])],
    ["UPDATE lms_quiz_answers SET answer_json = @j", (i) => { if (beforeWrite) beforeWrite(st); const has = String(i.q) in st.answers; if (st.missOnce) { st.missOnce = false; return [{ n: 0 }]; } if (!has || st.attempt.status !== "in_progress" || (st.answers[i.q] ?? null) !== (i.seen ?? null)) return [{ n: 0 }]; st.answers[i.q] = i.j; st.writes++; return [{ n: 1 }]; }],
    ["INSERT INTO lms_quiz_answers", (i) => { if (beforeWrite) beforeWrite(st); if (st.missOnce) { st.missOnce = false; return [{ n: 0 }]; } if (String(i.q) in st.answers || st.attempt.status !== "in_progress") return [{ n: 0 }]; st.answers[i.q] = i.j; st.writes++; return [{ n: 1 }]; }]]);
  const quizzes = { loadQuiz: async (p, c, z) => (z === 9 && c === 5 ? st.quiz : null), loadAttempt: async (p, c, z, s, a) => (st.attempt && s === 21 && a === 31 && z === 9 ? st.attempt : null), loadQuestions: async () => QUESTIONS };
  return { ...m, rows, st, quizzes };
};
const run = (w, body, o = {}) => O.replayQuizAnswers(w.pool, o.c || 5, o.s || 21, body, { now: NOW, quizzes: w.quizzes });
const J = (v) => JSON.stringify(v);

test("eligibility (pure): only untimed PRACTICE quizzes (mode quiz or revision) that do not count to the grade; coursework, controlled exams, mock, flashcards, timed, counted, archived are refused with a code", () => {
  assert.strictEqual(O.eligibility(quizOk()).ok, true); assert.strictEqual(O.eligibility(quizOk({ mode: "quiz" })).ok, true);
  for (const o of [{ assessmentType: "coursework" }, { assessmentType: "controlled_exam" }, { mode: "mock" }, { timeLimitMinutes: 20 }, { countsToGrade: true }]) assert.deepStrictEqual([O.eligibility(quizOk(o)).ok, O.eligibility(quizOk(o)).code], [false, "NOT_OFFLINE_ELIGIBLE"], J(o));
  assert.strictEqual(O.eligibility(quizOk({ mode: "flashcards" })).code, "NOT_OFFLINE_ELIGIBLE"); assert.strictEqual(O.eligibility(quizOk({ readOnly: true })).code, "COURSE_READ_ONLY"); assert.strictEqual(O.eligibility(null).code, "NOT_FOUND");
});

test("validate (pure): 1-3 actions, only known fields, every answer is {value, base}; a bad single action is reported and the batch still runs", () => {
  for (const b of [null, [], {}, { actions: [] }, { actions: [A()], x: 1 }, { actions: Array.from({ length: 4 }, (_, i) => A({ clientActionId: "act-0000000" + i })) }]) assert.strictEqual(O.validateBatch(b).ok, false);
  const bad = (x) => !!O.validateBatch({ actions: [x] }).actions[0].invalid;
  assert.ok(!bad(A()) && !bad(A({ answers: { 1: { value: null, base: null } } })));
  for (const x of [A({ clientActionId: "x" }), A({ type: "submission_draft" }), A({ quizId: 0 }), A({ attemptId: "1" }), A({ queuedAt: "nope" }), A({ answers: {} }), A({ answers: [] }), A({ answers: { a: { value: null, base: null } } }), A({ answers: { 1: { value: null } } }), A({ answers: { 1: { value: null, base: null, extra: 1 } } }), A({ answers: { 1: 5 } }), A({ foo: 1 })]) assert.ok(bad(x), J(x));
  const two = O.validateBatch({ actions: [A(), A()] }).actions; assert.ok(/Repeated/.test(two[1].invalid));
  const many = {}; for (let i = 1; i <= 101; i++) many[i] = { value: null, base: null }; assert.ok(bad(A({ answers: many })));
});

test("applied: a new answer over base null writes ONE guarded INSERT; an answer over the server's base writes ONE guarded UPDATE naming the exact stored text; the action row holds ids and outcome, NO answer", async () => {
  const w = world(); const r = await run(w, { actions: [A()] });
  assert.deepStrictEqual([r.results[0].state, r.results[0].items, w.st.answers[1], w.st.writes, r.summary], ["applied", [{ questionId: 1, state: "applied" }], J({ selected: 2 }), 1, { applied: 1, duplicate: 0, conflict: 0, rejected: 0 }]);
  assert.deepStrictEqual([w.rows[0].result_state, w.rows[0].quiz_id, w.rows[0].attempt_id], ["applied", 9, 31]);
  const w2 = world({ answers: { 1: J({ selected: 1 }) } }); const r2 = await run(w2, { actions: [A({ answers: { 1: { value: { selected: 3 }, base: { selected: 1 } } } })] });
  assert.deepStrictEqual([r2.results[0].state, w2.st.answers[1]], ["applied", J({ selected: 3 })]);
  const up = w2.log.find((x) => /UPDATE lms_quiz_answers/.test(x.sql)); assert.ok(/answer_json = @seen/.test(up.sql) && /status = 'in_progress'/.test(up.sql) && /student_id = @s/.test(up.sql) && /course_id = @c/.test(up.sql) && /quiz_id = @z/.test(up.sql), "guarded by the stored text, the live attempt, student, course and quiz");
  assert.strictEqual(up.inputs.seen, J({ selected: 1 }));
  const ins = w.log.find((x) => /INSERT INTO lms_offline_actions/.test(x.sql)); assert.ok(!Object.values(ins.inputs).some((v) => typeof v === "string" && /selected/.test(v)), "answers never go into the action table");
  const cleared = world({ answers: { 2: J({ text: "old" }) } }); const r3 = await run(cleared, { actions: [A({ answers: { 2: { value: null, base: { text: "old" } } } })] }); assert.deepStrictEqual([r3.results[0].state, cleared.st.answers[2]], ["applied", null], "clearing an answer is a write too");
  const insSql = w.log.find((x) => /INSERT INTO lms_quiz_answers/.test(x.sql)).sql; assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_quiz_answers w WHERE w\.attempt_id = @a AND w\.quiz_question_id = @q\)/.test(insSql) && /status = 'in_progress'/.test(insSql), "the first answer is inserted only if no row exists and the attempt is live");
});

test("unchanged: the server already holds the device answer (a replay after a lost reply, or another device) -> nothing written; answers are cleaned like the online save", async () => {
  const w = world({ answers: { 1: J({ selected: 2 }), 2: J({ text: "a b" }) } });
  const r = await run(w, { actions: [A({ answers: { 1: { value: { selected: 2 }, base: null }, 2: { value: { text: "a\n b" }, base: null } } })] });
  assert.deepStrictEqual([r.results[0].state, r.results[0].items.map((x) => x.state), w.st.writes], ["applied", ["unchanged", "unchanged"], 0]);
});

test("CONFLICT per question: the server answer is neither the base nor the device answer -> that question is a conflict with BOTH answers and is NOT written; the other questions are still applied; the id is NOT used up", async () => {
  const w = world({ answers: { 1: J({ selected: 4 }) } });
  const r = await run(w, { actions: [A({ answers: { 1: { value: { selected: 2 }, base: null }, 2: { value: { text: "cat" }, base: null } } })] });
  const c = r.results[0]; assert.deepStrictEqual([c.state, c.code, c.applied, c.conflicts, r.summary.conflict], ["conflict", "ANSWER_CHANGED", 1, 1, 1]);
  assert.deepStrictEqual(c.items.find((x) => x.questionId === 1), { questionId: 1, state: "conflict", conflict: { serverAnswer: { selected: 4 }, deviceAnswer: { selected: 2 } } });
  assert.deepStrictEqual([w.st.answers[1], w.st.answers[2], w.rows[0].result_state], [J({ selected: 4 }), J({ text: "cat" }), null]);
  const again = await run(w, { actions: [A({ answers: { 1: { value: { selected: 2 }, base: null }, 2: { value: { text: "cat" }, base: null } } })] });
  assert.deepStrictEqual([again.results[0].state, again.results[0].items.map((x) => x.state)], ["conflict", ["conflict", "unchanged"]], "a replay re-checks: the saved one is unchanged, the conflict is still a conflict");
  assert.ok(!/key|correct|points|explanation/i.test(J(c)), "no key or mark in a conflict");
});

test("race: the stored text moves between the read and the guarded write -> the write misses, the question is looked at again and never overwritten", async () => {
  const w = world({ answers: { 1: J({ selected: 1 }) }, beforeWrite: (st) => { st.answers[1] = J({ selected: 4 }); } });
  const r = await run(w, { actions: [A({ answers: { 1: { value: { selected: 3 }, base: { selected: 1 } } } })] });
  assert.deepStrictEqual([r.results[0].state, w.st.answers[1], w.st.writes], ["conflict", J({ selected: 4 }), 0]);
  const once = world({ answers: { 1: J({ selected: 1 }) } }); once.st.missOnce = true; const r1 = await run(once, { actions: [A({ answers: { 1: { value: { selected: 3 }, base: { selected: 1 } } } })] });
  assert.deepStrictEqual([r1.results[0].state, once.st.answers[1]], ["applied", J({ selected: 3 })], "one missed guard (a lost race) is looked at again, then applied");
  const gone = world({ beforeWrite: (st) => { st.attempt.status = "submitted"; } }); const r2 = await run(gone, { actions: [A()] }); assert.deepStrictEqual([r2.results[0].state, gone.st.writes], ["conflict", 0], "an attempt submitted meanwhile accepts no write");
});

test("rejected, id used up: not eligible, not found, attempt closed, time up (server clock), archived; nothing written", async () => {
  const cases = [[{ quiz: quizOk({ assessmentType: "coursework" }) }, "NOT_OFFLINE_ELIGIBLE"], [{ quiz: quizOk({ timeLimitMinutes: 10 }) }, "NOT_OFFLINE_ELIGIBLE"], [{ quiz: quizOk({ readOnly: true }) }, "COURSE_READ_ONLY"], [{ quiz: null }, "NOT_FOUND"],
    [{ attempt: null }, "NOT_FOUND"], [{ attempt: { status: "submitted" } }, "ATTEMPT_CLOSED"], [{ attempt: { status: "graded" } }, "ATTEMPT_CLOSED"], [{ attempt: { deadlineAt: new Date(NOW.getTime() - 60000) } }, "TIME_UP"]];
  for (const [o, code] of cases) { const w = world(o); const r = await run(w, { actions: [A()] }); assert.deepStrictEqual([r.results[0].state, r.results[0].code, w.st.writes, w.rows[0].result_state, w.rows[0].result_code], ["rejected", code, 0, "rejected", code], code); }
  const inside = world({ attempt: { deadlineAt: new Date(NOW.getTime() - 10000) } }); assert.strictEqual((await run(inside, { actions: [A()] })).results[0].state, "applied", "inside the 30 s grace");
});

test("invalid answers: an unknown question or a bad shape (in value OR base) rejects the WHOLE action as INVALID and writes nothing", async () => {
  for (const answers of [{ 99: { value: null, base: null } }, { 1: { value: { selected: "x" }, base: null } }, { 1: { value: null, base: { text: "no" } } }, { 1: { value: { selected: 2 }, base: null }, 2: { value: { text: 5 }, base: null } }]) {
    const w = world(); const r = await run(w, { actions: [A({ answers })] }); assert.deepStrictEqual([r.results[0].state, r.results[0].code, w.st.writes], ["rejected", "INVALID", 0], J(answers));
  }
  const w = world(); const r = await run(w, { actions: [A({ clientActionId: "bad" }), A({ clientActionId: "act-00000002" })] }); assert.deepStrictEqual([r.results[0].code, r.results[1].state], ["INVALID", "applied"], "a bad action does not stop the batch");
});

test("idempotent: a replay of a finished action is duplicate with firstResult and writes nothing; the same id for another quiz/attempt/type/course is ACTION_ID_REUSED; stale actions store nothing", async () => {
  const w = world(); await run(w, { actions: [A()] }); const w1 = w.st.writes; const again = await run(w, { actions: [A()] });
  assert.deepStrictEqual([again.results[0].state, again.results[0].firstResult, w.st.writes, w.rows.length], ["duplicate", "applied", w1, 1]);
  for (const o of [{ quizId: 10 }, { attemptId: 32 }]) assert.strictEqual((await run(w, { actions: [A(o)] })).results[0].code, "ACTION_ID_REUSED", J(o));
  w.rows[0].action_type = "lesson_view"; assert.strictEqual((await run(w, { actions: [A()] })).results[0].code, "ACTION_ID_REUSED");
  const w2 = world(); for (const q of ["2026-09-01T00:00:00.000Z", "2026-11-10T09:06:00.000Z"]) { const r = await run(w2, { actions: [A({ queuedAt: q })] }); assert.deepStrictEqual([r.results[0].code, w2.rows.length], ["STALE_ACTION", 0], q); }
  const w3 = world({ actions: [{ course_id: 5, student_id: 21, client_action_id: "act-00000001", action_type: "quiz_answers", quiz_id: 9, attempt_id: 31, result_state: null }] }); const r3 = await run(w3, { actions: [A()] });
  assert.deepStrictEqual([r3.results[0].state, w3.rows[0].result_state], ["applied", "applied"], "a row left unfinished is finished by the replay");
});

test("tenant / learner isolation: another learner's attempt, another course's quiz and a bad course id are NOT_FOUND and touch no answer; every answer query names student AND course", async () => {
  const w = world(); const other = await run(w, { actions: [A()] }, { s: 22 }); assert.deepStrictEqual([other.results[0].code, w.st.writes], ["NOT_FOUND", 0]);
  const w2 = world(); const diff = await run(w2, { actions: [A()] }, { c: 6 }); assert.deepStrictEqual([diff.results[0].code, w2.st.writes], ["NOT_FOUND", 0]);
  assert.deepStrictEqual(await O.replayQuizAnswers(w.pool, 0, 21, { actions: [A()] }, {}), { ok: false, notFound: true, errors: ["Course not found."] });
  const w3 = world(); await run(w3, { actions: [A({ answers: { 1: { value: { selected: 2 }, base: null }, 2: { value: { text: "x" }, base: null } } })] });
  for (const l of w3.log.filter((x) => /lms_quiz_answers/.test(x.sql))) assert.ok(/student_id = @s/.test(l.sql) || /@s,/.test(l.sql), l.sql.slice(0, 60));
});

test("route + schema: flag `lms_offline` first, studentOnly + enrolment, no-store, bad body = 400 touching nothing; step 045 is additive (two guarded nullable INT columns), LAST, holds no answers", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), p = "/courses/:courseId/learn/offline/sync/quiz-answers";
  const lr = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.post); assert.ok(lr && lr.route.stack.length === 4); assert.ok(src.includes(`"${p}", olGate, studentOnly, studentAccess`));
  const bad = makeRes(); let h = null; bad.setHeader = (k, v) => { h = [k, v]; }; const w = world(); await lr.route.stack[3].handle({ pool: w.pool, user: { id: 21, role: "student", source: "Students" }, params: { courseId: "5" }, body: { actions: [] }, tenant: "t" }, bad);
  assert.deepStrictEqual([bad.statusCode, h], [400, ["Cache-Control", "no-store"]]); assert.ok(!w.log.length);
  const ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("045_lms_offline_quiz_answers"); assert.ok(i === ids.length - 1 && ids[i - 1] === "044_lms_offline_drafts");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(schema.STEPS[i].sql.every((s) => /^IF COL_LENGTH\('lms_offline_actions', '\w+'\) IS NULL ALTER TABLE lms_offline_actions ADD \w+ INT NULL$/.test(s.replace(/\s+/g, " ").trim())) && !/DROP |DELETE |UPDATE /i.test(t));
  assert.ok(/quiz_id INT NULL/.test(t) && /attempt_id INT NULL/.test(t) && !/answer_json|text|body/i.test(t.replace(/--.*$/gm, "")));
});
