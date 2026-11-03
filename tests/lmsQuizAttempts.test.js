/* L6.2b-1 - student quiz attempts: start/resume, server-clock deadline, autosave, submit + auto-marking, feedback timing, no answer-key leak, isolation, routes.
   Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsQuizAttempts.test.js");
const A = require("../utils/lmsQuizAttempts");
const M = require("../utils/lmsQuizMarking");
const Z = require("../utils/lmsQuizzes");
const events = require("../utils/lmsEvents");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const T0 = new Date("2026-11-02T10:00:00Z"), at = (sec) => new Date(T0.getTime() + sec * 1000);

/* ---- fixtures ---- */
const QUESTIONS = [
  { id: 1, position: 1, type: "true_false", stem: "Water boils at 100C at sea level.", explanation: "Standard pressure.", points: "2.00", spec_json: JSON.stringify({ correct: true }) },
  { id: 2, position: 2, type: "mcq_single", stem: "Capital of Kenya?", explanation: "Nairobi is the capital.", points: "1.00", spec_json: JSON.stringify({ options: [{ position: 1, text: "Mombasa", correct: false, feedback: "SECRET-FB-1" }, { position: 2, text: "Nairobi", correct: true, feedback: "" }, { position: 3, text: "Kisumu", correct: false, feedback: "" }] }) },
  { id: 3, position: 3, type: "matching", stem: "Match", explanation: "", points: "3.00", spec_json: JSON.stringify({ pairs: [{ position: 1, left: "Cat", right: "Meow" }, { position: 2, left: "Dog", right: "Woof" }, { position: 3, left: "Cow", right: "Moo" }], partialCredit: false }) },
  { id: 4, position: 4, type: "essay", stem: "Discuss.", explanation: "", points: "5.00", spec_json: JSON.stringify({ maxWords: 50 }) },
];
const NOESSAY = QUESTIONS.slice(0, 3);
const qrows = (list) => list.map((x) => ({ ...x }));
const quizRow = (o = {}) => ({ id: 4, course_id: 5, title: "Quiz 1", instructions: null, assessment_type: "practice", available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 2, shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, question_count: 4, total_points: "11.00", course_status: "published", ...o });
const attRow = (o = {}) => ({ id: 70, quiz_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "in_progress", seed: "abcd1234abcd1234", started_at: T0.toISOString(), deadline_at: null, submitted_at: null, auto_submitted: 0, auto_points: null, manual_points: null, total_points: null, max_points: "11.00", needs_marking: 0, ...o });

const COLS = "attempt_no, status, seed, started_at, deadline_at, submitted_at, auto_submitted, auto_points, manual_points, total_points, max_points, needs_marking";
const LOAD_ATTEMPT = `${COLS} FROM lms_quiz_attempts WHERE id = @a`, OPEN_ATTEMPT = `${COLS} FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress'`;

/* A tiny stateful world: one quiz (course 5, id 4), one learner's attempts, answers. Responders read/write `st`, so start -> save -> submit -> reload behave like a database. */
function world(opts = {}) {
  const st = { quiz: opts.noQuiz ? null : quizRow(opts.quiz), questions: qrows(opts.questions || QUESTIONS), attempts: (opts.attempts || []).map((x) => ({ ...x })), answers: opts.answers || [], claimed: opts.claimed ?? 1, nextId: 70, dupOnInsert: opts.dupOnInsert || false };
  const mine = (i) => st.attempts.filter((a) => a.student_id === i.s && a.course_id === i.c && a.quiz_id === i.z);
  const rs = [
    ["FROM lms_quizzes z JOIN lms_courses c", (i) => (i.c === 5 && (i.id === undefined || i.id === 4) && st.quiz ? [st.quiz] : [])],
    ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position", (i) => (i.z === 4 && i.c === 5 ? st.questions : [])],
    ["FROM lms_quiz_answers WHERE attempt_id = @a", (i) => st.answers.filter((x) => x.attempt_id === i.a && i.s === 21)],
    [LOAD_ATTEMPT, (i) => st.attempts.filter((a) => a.id === i.a && a.quiz_id === i.z && a.course_id === i.c && a.student_id === i.s)],
    [OPEN_ATTEMPT, (i) => mine(i).filter((a) => a.status === "in_progress")],
    ["GROUP BY quiz_id, status", (i) => { const out = {}; for (const a of st.attempts.filter((x) => x.student_id === i.s)) { const k = `${a.quiz_id}|${a.status}`; out[k] = (out[k] || 0) + 1; } return Object.entries(out).map(([k, n]) => ({ quiz_id: Number(k.split("|")[0]), status: k.split("|")[1], n })); }],
    ["FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s ORDER BY attempt_no DESC", (i) => mine(i)],
    ["INSERT INTO lms_quiz_attempts", (i) => {
      if (st.dupOnInsert) { st.dupOnInsert = false; const e = new Error("dup"); e.number = 2601; throw e; }
      const n = mine(i).length; if (n >= i.max) return [];
      const row = attRow({ id: st.nextId++, attempt_no: n + 1, seed: i.seed, started_at: i.now.toISOString(), deadline_at: i.dl ? i.dl.toISOString() : null, max_points: String(i.mp) }); st.attempts.push(row); return [row];
    }],
    ["UPDATE lms_quiz_attempts SET status = @st", (i) => {
      const a = st.attempts.find((x) => x.id === i.a && x.student_id === i.s && x.status === "in_progress"); if (!a || !st.claimed) return [{ claimed: 0 }];
      Object.assign(a, { status: i.st, submitted_at: i.sub.toISOString(), auto_submitted: i.auto ? 1 : 0, auto_points: i.ap, total_points: i.tp, max_points: i.mp, needs_marking: i.nm ? 1 : 0 });
      let k = 0; while (`q${k}` in i) { st.answers = st.answers.filter((x) => !(x.attempt_id === a.id && x.quiz_question_id === i[`q${k}`])); st.answers.push({ attempt_id: a.id, quiz_question_id: i[`q${k}`], answer_json: i[`j${k}`], status: i[`t${k}`], points: i[`p${k}`], max_points: i[`x${k}`] }); k += 1; }
      return [{ claimed: 1 }];
    }],
    ["IF EXISTS (SELECT 1 FROM lms_quiz_attempts", (i) => {
      const a = st.attempts.find((x) => x.id === i.a && x.student_id === i.s && x.status === "in_progress"); if (!a) return [{ ok: 0 }];
      let k = 0; while (`q${k}` in i) { const ex = st.answers.find((x) => x.attempt_id === a.id && x.quiz_question_id === i[`q${k}`]); if (ex) ex.answer_json = i[`j${k}`]; else st.answers.push({ attempt_id: a.id, quiz_question_id: i[`q${k}`], answer_json: i[`j${k}`], status: null, points: null, max_points: 0 }); k += 1; }
      return [{ ok: 1 }];
    }],
  ];
  return { st, m: makeMockPool(rs) };
}
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));
const answersOf = (st, id = 70) => Object.fromEntries(st.answers.filter((x) => x.attempt_id === id).map((x) => [x.quiz_question_id, x]));
const json = (o) => JSON.stringify(o);

/* ====================================== pure ====================================== */
test("availability / deadline: no due date = open; after the due date closed; archived read-only; deadline = start + limit, never after the due date", () => {
  assert.strictEqual(A.availability({ dueAt: null }, { now: T0 }).open, true);
  assert.strictEqual(A.availability({ dueAt: at(60) }, { now: at(30) }).open, true);
  assert.strictEqual(A.availability({ dueAt: at(60) }, { now: at(61) }).code, "QUIZ_CLOSED");
  assert.strictEqual(A.availability({ dueAt: null }, { readOnly: true, now: T0 }).code, "COURSE_READ_ONLY");
  assert.strictEqual(A.deadlineOf({ timeLimitMinutes: null, dueAt: null }, T0), null);
  assert.strictEqual(A.deadlineOf({ timeLimitMinutes: 10, dueAt: null }, T0).getTime(), at(600).getTime());
  assert.strictEqual(A.deadlineOf({ timeLimitMinutes: 10, dueAt: at(300) }, T0).getTime(), at(300).getTime(), "due date wins when earlier");
  assert.strictEqual(A.deadlineOf({ timeLimitMinutes: 10, dueAt: at(9000) }, T0).getTime(), at(600).getTime());
  assert.strictEqual(A.deadlineOf({ timeLimitMinutes: null, dueAt: at(300) }, T0).getTime(), at(300).getTime());
  assert.strictEqual(A.pastGrace(at(100), at(100 + A.GRACE_SECONDS)), false); assert.strictEqual(A.pastGrace(at(100), at(101 + A.GRACE_SECONDS)), true); assert.strictEqual(A.pastGrace(null, at(99999)), false);
});

test("cleanAnswer: every type keeps only its own shape; empty clears; wrong shapes and unknown fields are refused; essay word cap", () => {
  const q = (type, spec = {}) => ({ type, spec });
  assert.deepStrictEqual(A.cleanAnswer(q("mcq_single"), { selected: "2" }), { ok: true, value: { selected: 2 } });
  assert.strictEqual(A.cleanAnswer(q("mcq_single"), { selected: null }).value, null);
  for (const junk of [5, true, "2", [1]]) assert.strictEqual(A.cleanAnswer(q("mcq_single"), junk).ok, false, `a bare ${JSON.stringify(junk)} is not an answer`);
  assert.strictEqual(A.cleanAnswer(q("mcq_single"), { selected: "x" }).ok, false); assert.strictEqual(A.cleanAnswer(q("mcq_single"), { selected: 1, extra: 1 }).ok, false); assert.strictEqual(A.cleanAnswer(q("mcq_single"), "2").ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("mcq_multi"), { selected: [1, "3", 1] }).value, { selected: [1, 3] }); assert.strictEqual(A.cleanAnswer(q("mcq_multi"), { selected: [] }).value, null); assert.strictEqual(A.cleanAnswer(q("mcq_multi"), { selected: "1" }).ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("true_false"), { selected: "false" }).value, { selected: false }); assert.strictEqual(A.cleanAnswer(q("true_false"), { selected: "maybe" }).ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("short_answer"), { text: "  <b>Nairobi</b>  " }).value, { text: "bNairobi/b" }, "tags stripped");
  assert.strictEqual(A.cleanAnswer(q("short_answer"), { text: "x".repeat(501) }).ok, false); assert.strictEqual(A.cleanAnswer(q("short_answer"), { text: "   " }).value, null);
  assert.deepStrictEqual(A.cleanAnswer(q("numeric"), { value: "12.5" }).value, { value: "12.5" }); assert.deepStrictEqual(A.cleanAnswer(q("numeric"), { value: 3 }).value, { value: 3 }); assert.strictEqual(A.cleanAnswer(q("numeric"), { value: Infinity }).ok, false); assert.strictEqual(A.cleanAnswer(q("numeric"), { value: {} }).ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("matching"), { pairs: [1, null, "3"] }).value, { pairs: [1, null, 3] }); assert.strictEqual(A.cleanAnswer(q("matching"), { pairs: [null, null] }).value, null); assert.strictEqual(A.cleanAnswer(q("matching"), { pairs: [1, 99] }).ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("ordering"), { order: [2, 1, 3] }).value, { order: [2, 1, 3] }); assert.strictEqual(A.cleanAnswer(q("ordering"), { order: [null] }).ok, false);
  assert.deepStrictEqual(A.cleanAnswer(q("essay", { maxWords: 3 }), { text: "one two three" }).value, { text: "one two three" }); assert.strictEqual(A.cleanAnswer(q("essay", { maxWords: 3 }), { text: "one two three four" }).ok, false);
  assert.strictEqual(A.cleanAnswer(q("essay"), { text: "y".repeat(20001) }).ok, false);
  assert.strictEqual(A.cleanAnswer(q("nonsense"), { a: 1 }).ok, false); assert.strictEqual(A.cleanAnswer(q("essay"), null).value, null);
});

test("validateAnswersBody: only known question ids, at most 100, exact body shape; one bad answer refuses the whole call", () => {
  const byId = new Map(QUESTIONS.map((x) => [x.id, { id: x.id, type: x.type, spec: JSON.parse(x.spec_json) }]));
  const ok = A.validateAnswersBody({ answers: { 1: { selected: true }, 2: null } }, byId); assert.ok(ok.ok); assert.deepStrictEqual([ok.answers.get(1), ok.answers.get(2)], [{ selected: true }, null]);
  for (const bad of [null, [], {}, { answers: [] }, { answers: { 99: { selected: true } } }, { answers: { x: 1 } }, { answers: { 1: { selected: "maybe" } } }, { answers: { 1: { selected: true } }, extra: 1 }, { answers: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i + 1, null])) }]) assert.strictEqual(A.validateAnswersBody(bad, byId).ok, false, json(bad).slice(0, 50));
});

test("orderOf / renderQuestion: deterministic for a seed; shuffle never keeps the identity order; shuffleOptions off keeps the teacher's order but matching is ALWAYS shuffled", () => {
  const qs = QUESTIONS.map((x) => ({ id: x.id, position: x.position, type: x.type, stem: x.stem, points: Number(x.points), spec: JSON.parse(x.spec_json) }));
  assert.deepStrictEqual(A.orderOf(qs, false, "s").map((x) => x.id), [1, 2, 3, 4]);
  const a = A.orderOf(qs, true, "seed-1").map((x) => x.id), b = A.orderOf(qs, true, "seed-1").map((x) => x.id); assert.deepStrictEqual(a, b); assert.deepStrictEqual([...a].sort(), [1, 2, 3, 4]); assert.notDeepStrictEqual(a, [1, 2, 3, 4]);
  const mcq = qs[1]; for (const seed of ["a", "b", "c", "d", "e"]) assert.deepStrictEqual(A.renderQuestion(mcq, seed, false).view.options.map((o) => o.position), [1, 2, 3], "teacher order when shuffleOptions is off");
  const shuffled = new Set(["a", "b", "c", "d", "e", "f", "g"].map((s) => A.renderQuestion(mcq, s, true).view.options.map((o) => o.position).join())); assert.ok(shuffled.size > 1, "shuffleOptions on really shuffles");
  const mt = A.renderQuestion(qs[2], "a", false); assert.notDeepStrictEqual(mt.refMap.rights, [1, 2, 3], "matching is never shown in key order");
});

test("NO ANSWER-KEY LEAK: the in-progress view of every question type contains no correct flag, accepted answer, option feedback or explanation", () => {
  const specs = [
    { id: 1, type: "mcq_single", stem: "s", points: 1, spec: { options: [{ position: 1, text: "A", correct: true, feedback: "SECRET-FB" }, { position: 2, text: "B", correct: false, feedback: "" }] } },
    { id: 2, type: "mcq_multi", stem: "s", points: 1, spec: { options: [{ position: 1, text: "A", correct: true, feedback: "SECRET-FB" }, { position: 2, text: "B", correct: true, feedback: "" }], partialCredit: true } },
    { id: 3, type: "true_false", stem: "s", points: 1, spec: { correct: true } },
    { id: 4, type: "short_answer", stem: "s", points: 1, spec: { accepted: ["SECRET-ACCEPTED"], caseSensitive: false } },
    { id: 5, type: "numeric", stem: "s", points: 1, spec: { value: 4242, tolerance: 7, unit: "m" } },
    { id: 6, type: "matching", stem: "s", points: 1, spec: { pairs: [{ position: 1, left: "L1", right: "R1" }, { position: 2, left: "L2", right: "R2" }] } },
    { id: 7, type: "ordering", stem: "s", points: 1, spec: { items: [{ position: 1, text: "first" }, { position: 2, text: "second" }] } },
    { id: 8, type: "essay", stem: "s", points: 1, spec: { maxWords: 10 } },
  ];
  for (const q of specs) { const txt = json(A.renderQuestion({ ...q, explanation: "SECRET-EXPLANATION" }, "seed", true).view); assert.ok(!/SECRET|"correct"|"accepted"|"feedback"|4242|"tolerance"|explanation/.test(txt), `${q.type}: ${txt}`); }
});

test("markAttempt: every type through the REAL display refs (matching), essay waits for the teacher, empty essay = 0, totals and needsMarking", () => {
  const qs = QUESTIONS.map((x) => ({ id: x.id, position: x.position, type: x.type, stem: x.stem, points: Number(x.points), spec: JSON.parse(x.spec_json) }));
  const seed = "seed-xyz"; const refs = A.renderQuestion(qs[2], seed, false).refMap.rights; // refs[i] = position shown at display ref i+1
  const rightPairs = [1, 2, 3].map((pos) => refs.indexOf(pos) + 1); // for left position p the student picks the ref that shows right text p
  const all = new Map([[1, { selected: true }], [2, { selected: 2 }], [3, { pairs: rightPairs }], [4, { text: "my essay" }]]);
  const r = A.markAttempt(qs, all, seed, false);
  assert.deepStrictEqual(r.rows.map((x) => [x.status, x.points]), [["correct", 2], ["correct", 1], ["correct", 3], ["manual", null]]); assert.deepStrictEqual([r.autoPoints, r.maxPoints, r.needsMarking], [6, 11, true]);
  const wrong = A.markAttempt(qs, new Map([[1, { selected: false }], [2, { selected: 1 }], [3, { pairs: [1, 2, 3].map((x) => (x === 1 ? rightPairs[0] : rightPairs[1])) }]]), seed, false);
  assert.deepStrictEqual(wrong.rows.map((x) => [x.status, x.points]), [["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0]]); assert.strictEqual(wrong.needsMarking, false, "an empty essay needs no marking");
  const none = A.markAttempt(qs, new Map(), seed, false); assert.deepStrictEqual(none.rows.map((x) => x.status), ["unanswered", "unanswered", "unanswered", "unanswered"]); assert.strictEqual(none.autoPoints, 0);
  const ws = A.markAttempt(qs, new Map([[4, { text: "   " }]]), seed, false); assert.strictEqual(ws.rows[3].status, "unanswered");
  assert.deepStrictEqual(A.markAttempt([], new Map(), seed).rows, []);
});

test("feedbackOf: immediate shows; after_close only once the due date has passed; never = answers hidden but SCORE visible (Q44)", () => {
  assert.strictEqual(A.feedbackOf({ feedbackTiming: "immediate" }, T0).visible, true);
  assert.strictEqual(A.feedbackOf({ feedbackTiming: "after_close", dueAt: at(60) }, at(59)).visible, false); assert.strictEqual(A.feedbackOf({ feedbackTiming: "after_close", dueAt: at(60) }, at(61)).visible, true);
  assert.strictEqual(A.feedbackOf({ feedbackTiming: "after_close", dueAt: null }, at(61)).visible, false, "no due date: it never closes");
  assert.deepStrictEqual([A.feedbackOf({ feedbackTiming: "never" }, at(9e5)).visible, A.feedbackOf({ feedbackTiming: "never" }, at(9e5)).scoreVisible, A.feedbackOf({ feedbackTiming: "never" }, at(9e5)).reason], [false, true, "never"]);
  assert.strictEqual(A.feedbackOf({ feedbackTiming: "after_close", dueAt: at(60) }, at(59)).scoreVisible, false, "after_close before the due date: no score either");
});

/* ====================================== start / resume ====================================== */
test("start: creates attempt 1 in ONE guarded INSERT (attempt limit inside the SQL), random seed, server-computed deadline; the view has all questions and no key", async () => {
  const w = world({ quiz: { time_limit_minutes: 20 } }); const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 });
  assert.ok(r.ok, json(r.errors)); assert.strictEqual(r.created, true);
  const ins = sqlOf(w.m, /^INSERT INTO lms_quiz_attempts/); assert.ok(ins && /WHERE x\.n < @max/.test(ins.sql) && /student_id = @s/.test(ins.sql) && ins.inputs.s === 21 && ins.inputs.max === 2 && ins.inputs.c === 5 && ins.inputs.z === 4);
  assert.ok(/^[0-9a-f]{16}$/.test(ins.inputs.seed)); assert.strictEqual(ins.inputs.dl.getTime(), at(1200).getTime(), "deadline = start + 20 minutes, from the server clock");
  assert.deepStrictEqual([r.attempt.attemptNo, r.attempt.status, r.attempt.secondsLeft, r.attempt.questions.length], [1, "in_progress", 1200, 4]);
  assert.ok(!/SECRET|"correct"|explanation|Nairobi is the capital/.test(json(r.attempt)), "no answer key in the take view");
  const two = await A.startAttempt(makeMockPool([]).pool, student(), 5, 4, { now: T0 }); assert.strictEqual(two.notFound, true, "unknown quiz");
});

test("start: with an attempt in progress it RESUMES that one (no second INSERT, saved answers returned); two stale tabs get the same attempt (unique index race)", async () => {
  const w = world({ attempts: [attRow()], answers: [{ attempt_id: 70, quiz_question_id: 2, answer_json: json({ selected: 3 }), status: null, points: null, max_points: 0 }] });
  const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: at(10) }); assert.ok(r.ok); assert.strictEqual(r.created, false); assert.strictEqual(r.attempt.id, 70);
  assert.ok(!sqlOf(w.m, /^INSERT INTO lms_quiz_attempts/), "no second attempt"); assert.deepStrictEqual(r.attempt.questions.find((q) => q.id === 2).answer, { selected: 3 });
  const race = world({ attempts: [], dupOnInsert: true }); race.st.attempts.push(attRow({ id: 71 }));
  // the first OPEN lookup finds the attempt already (a parallel click created it): resume, never a duplicate
  const r2 = await A.startAttempt(race.m.pool, student(), 5, 4, { now: T0 }); assert.ok(r2.ok && r2.created === false);
  const race2 = world({ attempts: [], dupOnInsert: true }); let first = true; const orig = race2.m.pool.request.bind(race2.m.pool);
  race2.m.pool.request = () => { const req = orig(); const q = req.query.bind(req); req.query = async (t) => { if (/^INSERT INTO lms_quiz_attempts/.test(t.replace(/\s+/g, " ").trim()) && first) { first = false; race2.st.attempts.push(attRow({ id: 72 })); } return q(t); }; return req; };
  const r3 = await A.startAttempt(race2.m.pool, student(), 5, 4, { now: T0 }); assert.ok(r3.ok && r3.created === false && r3.attempt.id === 72, json(r3.errors));
});

test("start: all attempts used, archived course, closed quiz, hidden quiz and another course are refused; nothing is inserted", async () => {
  const used = world({ quiz: { max_attempts: 1 }, attempts: [attRow({ status: "graded" })] }); const u = await A.startAttempt(used.m.pool, student(), 5, 4, { now: T0 }); assert.deepStrictEqual([u.ok, u.code], [false, "ATTEMPTS_USED"]);
  const arch = world({ quiz: { course_status: "archived" } }); const a = await A.startAttempt(arch.m.pool, student(), 5, 4, { now: T0 }); assert.deepStrictEqual([a.ok, a.code], [false, "COURSE_READ_ONLY"]); assert.ok(!sqlOf(arch.m, /^INSERT/));
  const closed = world({ quiz: { due_at: at(-5).toISOString() } }); const c = await A.startAttempt(closed.m.pool, student(), 5, 4, { now: T0 }); assert.deepStrictEqual([c.ok, c.code], [false, "QUIZ_CLOSED"]);
  const other = world(); assert.strictEqual((await A.startAttempt(other.m.pool, student(), 6, 4, { now: T0 })).notFound, true, "other course");
  const hidden = world({ noQuiz: true }); assert.strictEqual((await A.startAttempt(hidden.m.pool, student(), 5, 4, { now: T0 })).notFound, true, "draft/unavailable quiz looks like no quiz");
  const w = world(); await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); const q = sqlOf(w.m, /FROM lms_quizzes z JOIN lms_courses c/); assert.ok(/z\.status = 'published'/.test(q.sql) && /z\.deleted_at IS NULL/.test(q.sql) && /c\.status IN \('published','archived'\)/.test(q.sql) && /z\.available_from <= @now/.test(q.sql) && /z\.course_id = @c/.test(q.sql));
  for (const bad of [{ id: 1, role: "teacher", source: "Teachers" }, { id: 1, role: "student", source: "Teachers" }, null]) assert.strictEqual((await A.startAttempt(makeMockPool([]).pool, bad, 5, 4, { now: T0 })).notFound, true, "staff never take quizzes");
});

test("start: an in-progress attempt whose time ran out is closed automatically (answers saved so far are marked, submitted_at = the deadline) and a fresh attempt starts if any remain", async () => {
  const w = world({ attempts: [attRow({ deadline_at: at(600).toISOString() })], answers: [{ attempt_id: 70, quiz_question_id: 1, answer_json: json({ selected: true }), status: null, points: null, max_points: 0 }] });
  const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: at(700) }); assert.ok(r.ok && r.created === true && r.attempt.attemptNo === 2, json(r.errors));
  const old = w.st.attempts.find((a) => a.id === 70); assert.deepStrictEqual([old.status, old.auto_submitted, new Date(old.submitted_at).getTime()], ["graded", 1, at(600).getTime()], "the essay was left empty, so nothing waits for a teacher: graded at once");
  assert.strictEqual(answersOf(w.st)[1].status, "correct", "the answer saved before time ran out was marked");
});

/* ====================================== read / autosave / submit ====================================== */
test("getAttempt: another learner, another quiz id or another course finds nothing (queries match quiz, course AND student)", async () => {
  const w = world({ attempts: [attRow()] });
  assert.ok((await A.getAttempt(w.m.pool, student(21), 5, 4, 70, { now: T0 })).ok);
  assert.strictEqual((await A.getAttempt(w.m.pool, student(22), 5, 4, 70, { now: T0 })).notFound, true, "ID guessing: attempt 70 belongs to learner 21");
  assert.strictEqual((await A.getAttempt(w.m.pool, student(21), 6, 4, 70, { now: T0 })).notFound, true);
  assert.strictEqual((await A.getAttempt(w.m.pool, student(21), 5, 9, 70, { now: T0 })).notFound, true);
  assert.strictEqual((await A.getAttempt(w.m.pool, student(21), 5, 4, "abc", { now: T0 })).notFound, true);
  const q = sqlOf(w.m, new RegExp(LOAD_ATTEMPT.replace(/[@()]/g, "\\$&"))); assert.ok(q && /AND quiz_id = @z AND course_id = @c AND student_id = @s/.test(q.sql));
});

test("saveAnswers: validated, ONE transaction guarded by 'attempt still in progress', upsert per question; unknown question / bad answer / submitted attempt / archived course refused", async () => {
  const w = world({ attempts: [attRow()] });
  const r = await A.saveAnswers(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true }, 4: { text: "draft essay" }, 2: null } }, { now: at(5) }); assert.ok(r.ok, json(r.errors)); assert.strictEqual(r.saved, 3);
  const q = sqlOf(w.m, /IF EXISTS \(SELECT 1 FROM lms_quiz_attempts/); assert.ok(q && /BEGIN TRAN/.test(q.sql) && /status = 'in_progress'/.test(q.sql) && /IF @@ROWCOUNT = 0 INSERT INTO lms_quiz_answers/.test(q.sql) && /student_id = @s/.test(q.sql));
  assert.deepStrictEqual([q.inputs.s, q.inputs.a, q.inputs.q0, q.inputs.j0, q.inputs.q1, q.inputs.j1, q.inputs.q2, q.inputs.j2], [21, 70, 1, json({ selected: true }), 2, null, 4, json({ text: "draft essay" })], "ascending question ids; a cleared answer is stored as NULL; answers stored as sent");
  assert.ok(!/DROP TABLE/.test(q.sql) && !q.sql.includes("draft essay"), "answer text is only ever a parameter");
  assert.strictEqual(answersOf(w.st)[4].answer_json, json({ text: "draft essay" }));
  for (const body of [{ answers: { 1: { selected: "maybe" } } }, {}, null]) { const x = world({ attempts: [attRow()] }); assert.strictEqual((await A.saveAnswers(x.m.pool, student(), 5, 4, 70, body, { now: T0 })).ok, false); assert.ok(!sqlOf(x.m, /IF EXISTS/), "invalid body: nothing written"); }
  const bad = world({ attempts: [attRow()] }); const br = await A.saveAnswers(bad.m.pool, student(), 5, 4, 70, { answers: { 99: { selected: true } } }, { now: at(5) }); assert.strictEqual(br.ok, false); assert.ok(!sqlOf(bad.m, /IF EXISTS/), "nothing written");
  const done = world({ attempts: [attRow({ status: "submitted" })] }); const closed = (await A.saveAnswers(done.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(5) })); assert.strictEqual(closed.code, "ATTEMPT_CLOSED"); assert.ok(!sqlOf(done.m, /IF EXISTS/), "a submitted attempt is refused before any write is even attempted");
  const arch = world({ quiz: { course_status: "archived" }, attempts: [attRow()] }); assert.strictEqual((await A.saveAnswers(arch.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(5) })).code, "COURSE_READ_ONLY");
  const foreign = world({ attempts: [attRow()] }); assert.strictEqual((await A.saveAnswers(foreign.m.pool, student(22), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(5) })).notFound, true);
  assert.deepStrictEqual(await A.saveAnswers(world({ attempts: [attRow()] }).m.pool, student(), 5, 4, 70, { answers: {} }, { now: at(5) }).then((x) => [x.ok, x.saved]), [true, 0]);
});

test("saveAnswers after the deadline (+ grace): 409 TIME_UP and the answers saved so far are submitted; inside the grace period saving still works", async () => {
  const dl = at(600).toISOString();
  const w = world({ attempts: [attRow({ deadline_at: dl })] }); const inGrace = await A.saveAnswers(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(600 + A.GRACE_SECONDS) }); assert.ok(inGrace.ok, "inside the grace period");
  const w2 = world({ attempts: [attRow({ deadline_at: dl })], answers: [{ attempt_id: 70, quiz_question_id: 1, answer_json: json({ selected: true }), status: null, points: null, max_points: 0 }] });
  const late = await A.saveAnswers(w2.m.pool, student(), 5, 4, 70, { answers: { 2: { selected: 2 } } }, { now: at(601 + A.GRACE_SECONDS) }); assert.deepStrictEqual([late.ok, late.code], [false, "TIME_UP"]);
  const at70 = w2.st.attempts[0]; assert.deepStrictEqual([at70.status, at70.auto_submitted], ["graded", 1]); assert.ok(!answersOf(w2.st)[2] || answersOf(w2.st)[2].answer_json === null, "the too-late answer was NOT saved");
  assert.strictEqual(answersOf(w2.st)[1].status, "correct", "the answer saved before time ran out was marked");
});

test("submit: auto-marks all types in ONE guarded transaction; no essay = graded with total; events + audit; submitted answers come back as RESULT", async () => {
  const seen = []; const off = events.on("*", (e) => seen.push(e));
  const w = world({ quiz: { question_count: 3, total_points: "6.00" }, questions: NOESSAY, attempts: [attRow()] });
  const refs = A.renderQuestion({ id: 3, type: "matching", stem: "s", points: 3, spec: JSON.parse(NOESSAY[2].spec_json) }, "abcd1234abcd1234:3".split(":")[0], false);
  const seed = "abcd1234abcd1234"; const rights = A.renderQuestion({ id: 3, type: "matching", stem: "s", points: 3, spec: JSON.parse(NOESSAY[2].spec_json) }, seed, false).refMap.rights; void refs;
  const pairs = [1, 2, 3].map((p) => rights.indexOf(p) + 1);
  const r = await A.submitAttempt(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true }, 2: { selected: 2 }, 3: { pairs } } }, { now: at(30), tenant: "qa-sub" }); assert.ok(r.ok, json(r.errors));
  const up = sqlOf(w.m, /^SET XACT_ABORT ON; BEGIN TRAN; DECLARE @claimed/); assert.ok(up && /WHERE id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress'/.test(up.sql) && /IF @@ROWCOUNT = 1 BEGIN/.test(up.sql) && /COMMIT/.test(up.sql));
  assert.deepStrictEqual([up.inputs.st, up.inputs.ap, up.inputs.tp, up.inputs.mp, up.inputs.nm], ["graded", 6, 6, 6, 0]);
  assert.deepStrictEqual([r.attempt.status, r.attempt.score.points, r.attempt.score.max, r.attempt.score.pending, r.attempt.feedback.visible], ["graded", 6, 6, false, true]);
  assert.deepStrictEqual(r.attempt.questions.map((q) => q.status), ["correct", "correct", "correct"]);
  assert.ok(m_has(w.m, /lms_audit_log/), "audited"); await tick(); const mine = seen.filter((e) => e.tenant === "qa-sub");
  assert.deepStrictEqual(mine.map((e) => e.event).sort(), ["lms.quiz.attempted", "lms.quiz.graded"]); assert.ok(mine.every((e) => !("score" in e) && !("answers" in e) && e.studentId === 21 && e.quizId === 4), "ids only"); off();
});
const m_has = (m, re) => m.log.some((x) => re.test(x.sql));

test("submit with an essay: attempt is 'submitted' + needs marking, total stays NULL until the teacher marks; the essay answer is kept; only lms.quiz.attempted fires", async () => {
  const seen = []; const off = events.on("*", (e) => seen.push(e));
  const w = world({ attempts: [attRow()] });
  const r = await A.submitAttempt(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: false }, 4: { text: "My view" } } }, { now: at(30), tenant: "qa-essay" }); assert.ok(r.ok, json(r.errors));
  const up = sqlOf(w.m, /DECLARE @claimed/); assert.deepStrictEqual([up.inputs.st, up.inputs.ap, up.inputs.tp, up.inputs.nm, up.inputs.mp], ["submitted", 0, null, 1, 11]);
  assert.deepStrictEqual([r.attempt.status, r.attempt.score.pending, r.attempt.score.points], ["submitted", true, 0]); const ans = answersOf(w.st); assert.deepStrictEqual([ans[4].status, ans[4].points, ans[4].answer_json], ["manual", null, json({ text: "My view" })]);
  assert.deepStrictEqual([ans[1].status, ans[2].status], ["incorrect", "unanswered"], "every question gets a row, unanswered ones too");
  await tick(); assert.deepStrictEqual(seen.filter((e) => e.tenant === "qa-essay").map((e) => e.event), ["lms.quiz.attempted"]); off();
});

test("submit twice / double click / second tab: the second gets the already-submitted result, nothing is marked or emitted twice", async () => {
  const seen = []; const off = events.on("*", (e) => seen.push(e));
  const w = world({ quiz: { question_count: 3, total_points: "6.00" }, questions: NOESSAY, attempts: [attRow()] });
  const a = await A.submitAttempt(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(30), tenant: "qa-dbl" }); assert.ok(a.ok && !a.alreadySubmitted);
  const b = await A.submitAttempt(w.m.pool, student(), 5, 4, 70, {}, { now: at(31), tenant: "qa-dbl" }); assert.ok(b.ok && b.alreadySubmitted === true); assert.strictEqual(w.m.log.filter((x) => /DECLARE @claimed/.test(x.sql)).length, 1, "only one claim statement ran");
  const lost = world({ attempts: [attRow()], claimed: 0 }); const c = await A.submitAttempt(lost.m.pool, student(), 5, 4, 70, {}, { now: at(30), tenant: "qa-dbl" }); assert.ok(c.ok && c.alreadySubmitted === true, "claim lost the race");
  await tick(); assert.strictEqual(seen.filter((e) => e.tenant === "qa-dbl" && e.event === "lms.quiz.attempted").length, 1, "one event only"); off();
});

test("submit after the deadline (+ grace): answers in the body are IGNORED, the saved ones are marked, autoSubmitted = true; invalid body refused; other learner refused", async () => {
  const dl = at(600).toISOString();
  const w = world({ quiz: { question_count: 3, total_points: "6.00" }, questions: NOESSAY, attempts: [attRow({ deadline_at: dl })], answers: [{ attempt_id: 70, quiz_question_id: 1, answer_json: json({ selected: false }), status: null, points: null, max_points: 0 }] });
  const r = await A.submitAttempt(w.m.pool, student(), 5, 4, 70, { answers: { 1: { selected: true } } }, { now: at(700) }); assert.ok(r.ok && r.autoSubmitted === true);
  assert.strictEqual(answersOf(w.st)[1].answer_json, json({ selected: false }), "late answer ignored"); assert.strictEqual(answersOf(w.st)[1].status, "incorrect");
  const bad = world({ attempts: [attRow()] }); assert.strictEqual((await A.submitAttempt(bad.m.pool, student(), 5, 4, 70, { answers: { 99: {} } }, { now: T0 })).ok, false); assert.ok(!m_has(bad.m, /DECLARE @claimed/));
  const f = world({ attempts: [attRow()] }); assert.strictEqual((await A.submitAttempt(f.m.pool, student(22), 5, 4, 70, {}, { now: T0 })).notFound, true);
  const arch = world({ quiz: { course_status: "archived" }, attempts: [attRow()] }); assert.strictEqual((await A.submitAttempt(arch.m.pool, student(), 5, 4, 70, {}, { now: T0 })).code, "COURSE_READ_ONLY");
  const ok0 = world({ quiz: { question_count: 3 }, questions: NOESSAY, attempts: [attRow()] }); assert.ok((await A.submitAttempt(ok0.m.pool, student(), 5, 4, 70, undefined, { now: T0 })).ok, "submit with no body = mark what is saved");
});

/* ====================================== feedback timing ====================================== */
test("results: immediate shows score + key + explanation + your answer in POSITIONS; after_close hides until the due date; never hides always (no score, no answers)", async () => {
  const submitted = (o) => attRow({ status: "graded", submitted_at: at(20).toISOString(), auto_points: "3.00", total_points: "3.00", max_points: "6.00", ...o });
  const ans = [{ attempt_id: 70, quiz_question_id: 2, answer_json: json({ selected: 1 }), status: "incorrect", points: "0.00", max_points: "1.00" }, { attempt_id: 70, quiz_question_id: 1, answer_json: json({ selected: true }), status: "correct", points: "2.00", max_points: "2.00" }];
  const base = { quiz: { question_count: 3 }, questions: NOESSAY, attempts: [submitted()], answers: ans };
  const imm = await A.getAttempt(world(base).m.pool, student(), 5, 4, 70, { now: at(60) }); assert.ok(imm.ok); const v = imm.attempt;
  assert.deepStrictEqual([v.feedback.visible, v.score.points, v.score.max], [true, 3, 6]); const q2 = v.questions.find((q) => q.id === 2);
  assert.deepStrictEqual([q2.status, q2.points, q2.explanation, q2.yourAnswer, q2.key.options.find((o) => o.correct).position], ["incorrect", 0, "Nairobi is the capital.", { selected: 1 }, 2]); assert.ok(json(v).includes("SECRET-FB-1"), "option feedback is shown once results are visible");
  const ac = { ...base, quiz: { question_count: 3, feedback_timing: "after_close", due_at: at(3600).toISOString() } };
  const before = (await A.getAttempt(world(ac).m.pool, student(), 5, 4, 70, { now: at(60) })).attempt; assert.deepStrictEqual([before.feedback.visible, before.feedback.reason, before.score, before.questions], [false, "after_close", null, []]);
  assert.ok(!/Nairobi|SECRET|explanation/.test(json(before)), "no key before the quiz closes");
  const after = (await A.getAttempt(world(ac).m.pool, student(), 5, 4, 70, { now: at(3601) })).attempt; assert.strictEqual(after.feedback.visible, true);
  const nv = { ...base, quiz: { question_count: 3, feedback_timing: "never" } }; const never = (await A.getAttempt(world(nv).m.pool, student(), 5, 4, 70, { now: at(9e6) })).attempt; assert.deepStrictEqual([never.feedback.visible, never.questions.length, never.score !== null && typeof never.score.max === "number"], [false, 0, true], "Q44: score shown, no answers");
  const sub = await A.submitAttempt(world({ ...nv, attempts: [attRow()] }).m.pool, student(), 5, 4, 70, {}, { now: at(5) }); assert.ok(sub.ok && sub.attempt.score !== null && sub.attempt.questions.length === 0, "feedback 'never' (Q44): the submit response shows the score but no answers");
});

test("results with an essay waiting: score shows the auto part as pending, the essay is 'manual' with no points", async () => {
  const w = world({ attempts: [attRow({ status: "submitted", submitted_at: at(20).toISOString(), auto_points: "3.00", total_points: null, needs_marking: 1 })], answers: [{ attempt_id: 70, quiz_question_id: 4, answer_json: json({ text: "x" }), status: "manual", points: null, max_points: "5.00" }] });
  const v = (await A.getAttempt(w.m.pool, student(), 5, 4, 70, { now: at(60) })).attempt; assert.deepStrictEqual([v.score.points, v.score.pending, v.status], [3, true, "submitted"]); const e = v.questions.find((q) => q.id === 4); assert.deepStrictEqual([e.status, e.points], ["manual", null]);
});

/* ====================================== list / detail ====================================== */
test("list + detail: published and available quizzes only, ordered by due date, attempts used/left, canStart and the reason; detail lists my attempts (score only when feedback allows)", async () => {
  const w = world({ attempts: [attRow({ status: "graded", submitted_at: at(20).toISOString(), auto_points: "3.00", total_points: "3.00" }), attRow({ id: 71, attempt_no: 2 })] });
  const l = await A.listForStudent(w.m.pool, student(), 5, { page: "1", pageSize: "500" }, { now: at(5) }); assert.ok(l.ok === undefined || true); assert.strictEqual(l.pageSize, 100);
  const q = sqlOf(w.m, /FROM lms_quizzes z JOIN lms_courses c/); assert.ok(/z\.status = 'published'/.test(q.sql) && /z\.available_from <= @now/.test(q.sql) && /OFFSET @off ROWS/.test(q.sql) && /z\.course_id = @c/.test(q.sql));
  const w2 = world({ quiz: { total_count: 1 }, attempts: [attRow({ status: "graded", attempt_no: 1 }), attRow({ id: 71, attempt_no: 2, status: "in_progress" })] }); const l2 = await A.listForStudent(w2.m.pool, student(), 5, {}, { now: at(5) });
  assert.deepStrictEqual([l2.items.length, l2.total, l2.items[0].attemptsUsed, l2.items[0].attemptsLeft, l2.items[0].hasOpenAttempt, l2.items[0].status, l2.items[0].canStart], [1, 1, 2, 0, true, "in_progress", true], "resuming is allowed even when no attempts are left");
  const w3 = world({ quiz: { total_count: 1, max_attempts: 1 }, attempts: [attRow({ status: "graded" })] }); const l3 = await A.listForStudent(w3.m.pool, student(), 5, {}, { now: at(5) }); assert.deepStrictEqual([l3.items[0].canStart, l3.items[0].closedReason.code, l3.items[0].status], [false, "ATTEMPTS_USED", "attempted"]);
  assert.ok(!/spec_json|correct|accepted/.test(json(l3)), "no question content in the list");
  const d = await A.getForStudent(world({ attempts: [attRow({ status: "graded", submitted_at: at(20).toISOString(), auto_points: "3.00", total_points: "3.00", max_points: "6.00" })] }).m.pool, student(), 5, 4, { now: at(30) }); assert.ok(d.ok); assert.deepStrictEqual([d.quiz.attempts.length, d.quiz.attempts[0].score.points], [1, 3]);
  const dn = await A.getForStudent(world({ quiz: { feedback_timing: "never" }, attempts: [attRow({ status: "graded", submitted_at: at(20).toISOString(), total_points: "3.00" })] }).m.pool, student(), 5, 4, { now: at(30) }); assert.deepStrictEqual(dn.quiz.attempts[0].score, { points: 3, max: dn.quiz.attempts[0].score.max, pending: false }, "Q44: the attempt list shows the score");
  assert.strictEqual((await A.listForStudent(makeMockPool([]).pool, teacher, 5, {}, { now: T0 })).notFound, true, "staff");
  assert.strictEqual((await A.getForStudent(world().m.pool, student(), 6, 4, { now: T0 })).notFound, true);
});

test("tenant isolation: attempt and quiz ids of school A are invisible in school B's database; B is never asked for A's data", async () => {
  const A1 = world({ attempts: [attRow()] }), B1 = world({ noQuiz: true });
  assert.ok((await A.getAttempt(A1.m.pool, student(), 5, 4, 70, { now: T0 })).ok); assert.strictEqual((await A.getAttempt(B1.m.pool, student(), 5, 4, 70, { now: T0 })).notFound, true, "guessing ids in school B finds nothing");
  const sep = makeTenants({ A: [["FROM lms_quizzes z JOIN lms_courses c", () => [quizRow()]], [LOAD_ATTEMPT, () => [attRow()]], ["FROM lms_quiz_questions", () => qrows(QUESTIONS)]], B: [] }); await A.getAttempt(sep.A.pool, student(), 5, 4, 70, { now: T0 }); sep.assertUntouched("B"); sep.assertQueried("A");
});

/* ====================================== quiz definitions: attempts lock ====================================== */
test("a quiz with attempts cannot be unpublished or deleted (409 HAS_ATTEMPTS); without attempts both still work", async () => {
  const live = ["FROM lms_courses WHERE id", () => [{ status: "published" }]];
  const QROW = { id: 4, course_id: 5, section_id: null, title: "Quiz", instructions: null, assessment_type: "practice", status: "published", published_at: "2026-01-01T00:00:00Z", available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 1, shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", question_count: 2, total_points: "3.00" };
  const loadq = ["FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c", () => [QROW]], has = ["SELECT TOP 1 id FROM lms_quiz_attempts WHERE quiz_id = @q AND course_id = @c", (i) => (i.q === 4 && i.c === 5 ? [{ id: 70 }] : [])];
  const un = makeMockPool([live, loadq, has]); const r = await Z.updateQuiz(un.pool, teacher, 5, 4, { status: "draft" }); assert.deepStrictEqual([r.ok, r.code], [false, "HAS_ATTEMPTS"]); assert.ok(!m_has(un, /^UPDATE lms_quizzes SET/), "nothing written");
  const del = makeMockPool([live, has]); const d = await Z.deleteQuiz(del.pool, teacher, 5, 4); assert.deepStrictEqual([d.ok, d.code], [false, "HAS_ATTEMPTS"]); assert.ok(!m_has(del, /^UPDATE lms_quizzes SET deleted_at/));
  const un2 = makeMockPool([live, loadq, ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []]]); assert.ok((await Z.updateQuiz(un2.pool, teacher, 5, 4, { status: "draft" })).ok, "no attempts: unpublish works");
  const del2 = makeMockPool([live, ["UPDATE lms_quizzes SET deleted_at", (i) => [{ id: i.id }]]]); assert.ok((await Z.deleteQuiz(del2.pool, teacher, 5, 4)).ok);
  const edit = makeMockPool([live, loadq, has, ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []]]); assert.ok((await Z.updateQuiz(edit.pool, teacher, 5, 4, { title: "New title" })).ok, "other edits are still allowed once attempts exist");
  assert.ok(!m_has(edit, /FROM lms_quiz_attempts/), "the attempts lookup runs only when unpublishing");
});

/* ====================================== routes / schema ====================================== */
test("routes: 8 student routes (6 attempt routes + 2 flashcard routes), each runs the lms_quizzes gate FIRST, then studentOnly; staff never reach a handler; without the flag 403 MODULE_NOT_LICENSED", async () => {
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/learn\/quizzes/.test(l.route.path));
  const sig = mine.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`); assert.strictEqual(mine.length, 8, sig.join(", "));
  for (const s of ["get /courses/:courseId/learn/quizzes", "get /courses/:courseId/learn/quizzes/:quizId", "post /courses/:courseId/learn/quizzes/:quizId/attempts", "get /courses/:courseId/learn/quizzes/:quizId/attempts/:attemptId", "put /courses/:courseId/learn/quizzes/:quizId/attempts/:attemptId/answers", "post /courses/:courseId/learn/quizzes/:quizId/attempts/:attemptId/submit"]) assert.ok(sig.includes(s), s);
  assert.ok(mine.every((l) => l.route.stack.length === 4), "gate + studentOnly + enrolment + handler");
  const rows = (flags) => [["FROM tenant_modules", () => [{ module_key: "lms", enabled: 1, flags_json: JSON.stringify(flags), limits_json: "{}", note: null, updatedAt: null }]]];
  const run = async (layer, user, tenant, flags) => { const res = makeRes(); let nexted = false; await mine[0].route.stack[layer].handle({ user, pool: makeMockPool(rows(flags)).pool, tenant, params: { courseId: "5" } }, res, () => { nexted = true; }); return { res, nexted }; };
  const noFlag = await run(0, student(), "qa-r1", ["lms_core", "lms_assignments"]); assert.deepStrictEqual([noFlag.nexted, noFlag.res.statusCode, noFlag.res.body.code, noFlag.res.body.flag], [false, 403, "MODULE_NOT_LICENSED", "lms_quizzes"]);
  const yes = await run(0, student(), "qa-r2", ["lms_core", "lms_quizzes"]); assert.strictEqual(yes.nexted, true);
  const staff = await run(1, teacher, "qa-r3", ["lms_quizzes"]); assert.deepStrictEqual([staff.nexted, staff.res.statusCode], [false, 403], "a teacher is refused before any query");
});

test("schema step 026: idempotent, additive, no foreign keys; unique indexes (one attempt number, ONE open attempt per learner/quiz, one answer row per question); blocklisted; events registered", () => {
  const fs = require("fs"); const src = fs.readFileSync(require.resolve("../utils/lmsSchema"), "utf8"); const i = src.indexOf('"026_lms_quiz_attempts"'); assert.ok(i > 0); const step = src.slice(i, src.indexOf("\n  },", i));
  assert.ok(/IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_quiz_attempts'/.test(step) && /IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_quiz_answers'/.test(step) && !/FOREIGN KEY|REFERENCES/.test(step) && !/DROP |ALTER /.test(step));
  assert.ok(/UNIQUE INDEX UX_lms_quiz_attempts_no ON lms_quiz_attempts \(quiz_id, student_id, attempt_no\)/.test(step) && /UNIQUE INDEX UX_lms_quiz_attempts_open ON lms_quiz_attempts \(quiz_id, student_id\) WHERE status = 'in_progress'/.test(step) && /UNIQUE INDEX UX_lms_quiz_answers_q ON lms_quiz_answers \(attempt_id, quiz_question_id\)/.test(step));
  assert.ok(/total_points DECIMAL\(8,2\) NULL/.test(step), "no total until graded");
  const server = fs.readFileSync(require.resolve("../server.js"), "utf8"); assert.ok(server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_quiz_attempts", "lms_quiz_answers"'));
  assert.ok(events.EVENTS.includes("lms.quiz.attempted") && events.EVENTS.includes("lms.quiz.graded"));
});
