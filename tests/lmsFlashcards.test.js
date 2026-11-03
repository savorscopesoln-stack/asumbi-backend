/* L6.3b - flashcards (D-082): deck + back-of-card, self-rating (upsert / clear), mode rules, no attempts, no random rules, isolation, routes.
   Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsFlashcards.test.js");
const F = require("../utils/lmsFlashcards");
const Z = require("../utils/lmsQuizzes");
const A = require("../utils/lmsQuizAttempts");
const R = require("../utils/lmsQuizRules");
const schema = require("../utils/lmsSchema");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-11-02T10:00:00Z");
const CARDS = [
  { id: 1, position: 1, type: "true_false", stem: "Water boils at 100C at sea level.", explanation: "Standard pressure.", spec_json: JSON.stringify({ correct: true }) },
  { id: 2, position: 2, type: "mcq_single", stem: "Capital of Kenya?", explanation: "", spec_json: JSON.stringify({ options: [{ position: 1, text: "Mombasa", correct: false }, { position: 2, text: "Nairobi", correct: true }] }) },
  { id: 3, position: 3, type: "essay", stem: "Discuss.", explanation: "Mention trade.", spec_json: JSON.stringify({ maxWords: 50 }) },
];
const DECK = (o = {}) => ({ id: 4, title: "Geography cards", instructions: "Flip", course_status: "published", ...o });
const deckQ = (row = DECK()) => ["FROM lms_quizzes z JOIN lms_courses c", (i) => (i.c === 5 && i.id === row.id && row.id ? [row] : [])];
const cardsQ = (rows = CARDS) => ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL ORDER BY position", (i) => (i.z === 4 && i.c === 5 ? rows : [])];
const ratingsQ = (st) => ["FROM lms_flashcard_ratings WHERE quiz_id = @z AND course_id = @c AND student_id = @s", (i) => [...st.entries()].filter(([k]) => k.startsWith(`${i.s}:`)).map(([k, v]) => ({ quiz_question_id: Number(k.split(":")[1]), rating: v }))];
const ownQ = (ids = [1, 2, 3]) => ["FROM lms_quiz_questions WHERE id = @k AND quiz_id = @z AND course_id = @c AND attempt_id IS NULL", (i) => (ids.includes(i.k) && i.z === 4 && i.c === 5 ? [{ id: i.k }] : [])];
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));

test("backOf: the answer per question type as plain lines; essay has no model answer; the explanation travels with it", () => {
  const b = (type, spec, explanation = "") => F.backOf({ type, explanation, spec });
  assert.deepStrictEqual(b("true_false", { correct: false }).answer, ["False"]);
  assert.deepStrictEqual(b("mcq_multi", { options: [{ position: 1, text: "A", correct: true }, { position: 2, text: "B", correct: false }, { position: 3, text: "C", correct: true }] }).answer, ["A", "C"]);
  assert.deepStrictEqual(b("short_answer", { accepted: ["Nairobi", "nairobi city"] }).answer, ["Nairobi", "nairobi city"]);
  assert.deepStrictEqual(b("numeric", { value: 9.8, tolerance: 0.1, unit: "m/s2" }).answer, ["9.8 (± 0.1) m/s2"]);
  assert.deepStrictEqual(b("matching", { pairs: [{ position: 1, left: "Cat", right: "Meow" }] }).answer, ["Cat → Meow"]);
  assert.deepStrictEqual(b("ordering", { items: [{ position: 1, text: "First" }, { position: 2, text: "Second" }] }).answer, ["1. First", "2. Second"]);
  const e = b("essay", { maxWords: 50 }, "Mention trade."); assert.deepStrictEqual([e.answer, e.explanation], [[], "Mention trade."]);
  assert.strictEqual(b("true_false", {}, "x\u0000y").explanation, "x y", "control characters stripped");
});

test("progressOf: counts only live cards; unrated = the rest; a rating of a removed card is ignored", () => {
  const p = F.progressOf([1, 2, 3, 4], new Map([[1, "known"], [2, "unknown"], [99, "known"]]));
  assert.deepStrictEqual(p, { total: 4, known: 1, unknown: 1, unrated: 2 });
});

test("getDeck: front/back/rating per card in teacher order, progress, no-store friendly; no score, no attempts; matches course and student", async () => {
  const st = new Map([["21:1", "known"], ["22:2", "unknown"]]);
  const m = makeMockPool([deckQ(), cardsQ(), ratingsQ(st)]);
  const r = await F.getDeck(m.pool, student(21), 5, 4, { now: NOW }); assert.ok(r.ok);
  assert.deepStrictEqual(r.deck.cards.map((c) => [c.id, c.number, c.rating]), [[1, 1, "known"], [2, 2, null], [3, 3, null]], "another learner's rating is never shown");
  assert.deepStrictEqual(r.deck.cards[1].back.answer, ["Nairobi"]); assert.strictEqual(r.deck.cards[0].front, "Water boils at 100C at sea level.");
  assert.deepStrictEqual(r.deck.progress, { total: 3, known: 1, unknown: 0, unrated: 2 });
  assert.ok(!JSON.stringify(r).match(/spec|correct|points|score/i), "no raw spec, no points, no score in the answer");
  const deckSql = m.log[0]; assert.ok(/z\.quiz_mode = 'flashcards'/.test(deckSql.sql) && /z\.status = 'published'/.test(deckSql.sql) && /z\.course_id = @c/.test(deckSql.sql) && /available_from/.test(deckSql.sql));
  assert.ok(m.log.every((x) => /course_id = @c|z\.course_id = @c/.test(x.sql)), "course matched in every query");
  assert.strictEqual(m.log.find((x) => /lms_flashcard_ratings/.test(x.sql)).inputs.s, 21);
});

test("getDeck: staff, bad ids, a normal quiz and another course's deck are all 'not found'; nothing is leaked", async () => {
  assert.strictEqual((await F.getDeck(makeMockPool([]).pool, teacher, 5, 4, { now: NOW })).notFound, true);
  assert.strictEqual((await F.getDeck(makeMockPool([]).pool, student(), 5, "x", { now: NOW })).notFound, true);
  assert.strictEqual((await F.getDeck(makeMockPool([deckQ(DECK({ id: 0 }))]).pool, student(), 5, 4, { now: NOW })).notFound, true, "a quiz that is not a flashcard deck matches nothing");
  assert.strictEqual((await F.getDeck(makeMockPool([deckQ()]).pool, student(), 6, 4, { now: NOW })).notFound, true, "other course");
});

test("rateCard: upsert in one guarded statement as parameters; returns fresh progress; null clears; only this learner's row is touched", async () => {
  const st = new Map(); const m = makeMockPool([deckQ(), ownQ(), cardsQ(), ratingsQ(st)]);
  const r = await F.rateCard(m.pool, student(21), 5, 4, 2, { rating: "known" }, { now: NOW }); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.rating, "known");
  const w = sqlOf(m, /UPDATE lms_flashcard_ratings/); assert.ok(w && /IF @@ROWCOUNT = 0 INSERT INTO lms_flashcard_ratings/.test(w.sql) && /student_id = @s/.test(w.sql) && /UPDLOCK, HOLDLOCK/.test(w.sql));
  assert.deepStrictEqual([w.inputs.k, w.inputs.z, w.inputs.c, w.inputs.s, w.inputs.r], [2, 4, 5, 21, "known"]); assert.ok(!/known/.test(w.sql), "rating is a parameter");
  assert.strictEqual(r.progress.total, 3);
  const m2 = makeMockPool([deckQ(), ownQ(), cardsQ(), ratingsQ(st)]); const c = await F.rateCard(m2.pool, student(21), 5, 4, 2, { rating: null }, { now: NOW });
  assert.ok(c.ok); const d = sqlOf(m2, /^DELETE FROM lms_flashcard_ratings/); assert.ok(d && /student_id = @s/.test(d.sql) && d.inputs.s === 21 && !sqlOf(m2, /UPDATE lms_flashcard_ratings/));
});

test("rateCard: bad body, unknown card (another quiz's or another course's), staff, archived course (409) and a non-deck all refused without a write", async () => {
  const none = (m) => !m.log.some((x) => /lms_flashcard_ratings/.test(x.sql) && /UPDATE|INSERT|DELETE/.test(x.sql));
  for (const bad of [{}, { rating: "maybe" }, { rating: "known", x: 1 }, null, [], { rating: 1 }, { rating: undefined }]) { const m = makeMockPool([deckQ(), ownQ()]); const r = await F.rateCard(m.pool, student(), 5, 4, 1, bad, { now: NOW }); assert.strictEqual(r.ok, false, JSON.stringify(bad)); assert.ok(none(m)); }
  const m1 = makeMockPool([deckQ(), ownQ([1])]); const r1 = await F.rateCard(m1.pool, student(), 5, 4, 2, { rating: "known" }, { now: NOW }); assert.strictEqual(r1.notFound, true); assert.ok(none(m1));
  const m2 = makeMockPool([deckQ(DECK({ course_status: "archived" })), ownQ()]); const r2 = await F.rateCard(m2.pool, student(), 5, 4, 1, { rating: "known" }, { now: NOW }); assert.deepStrictEqual([r2.ok, r2.code], [false, "COURSE_READ_ONLY"]); assert.ok(none(m2));
  const m3 = makeMockPool([]); assert.strictEqual((await F.rateCard(m3.pool, teacher, 5, 4, 1, { rating: "known" }, { now: NOW })).notFound, true);
  const m4 = makeMockPool([deckQ(DECK({ id: 0 })), ownQ()]); assert.strictEqual((await F.rateCard(m4.pool, student(), 5, 4, 1, { rating: "known" }, { now: NOW })).notFound, true);
  const m5 = makeMockPool([deckQ(), ownQ()]); assert.strictEqual((await F.rateCard(m5.pool, student(), 5, 4, "abc", { rating: "known" }, { now: NOW })).notFound, true);
});

test("tenant isolation: a rating or deck read in tenant A never touches tenant B's database", async () => {
  const st = new Map(); const T = makeTenants({ A: [deckQ(), cardsQ(), ratingsQ(st)], B: [] });
  const r = await F.getDeck(T.A.pool, student(), 5, 4, { now: NOW }); assert.ok(r.ok); T.assertUntouched("B"); T.assertQueried("A");
});

test("mode rules: a flashcard deck is practice + instant feedback + no timer + no due date; no random rules on a deck; attempts cannot start on a deck; the student list shows it as cards", async () => {
  const base = { assessmentType: "practice", feedbackTiming: "immediate", countsToGrade: false, timeLimitMinutes: null, dueAt: null };
  assert.deepStrictEqual(Z.check({ ...base, mode: "flashcards" }), []);
  for (const bad of [{ assessmentType: "coursework" }, { feedbackTiming: "never" }, { timeLimitMinutes: 5 }, { dueAt: new Date("2026-12-01") }]) assert.ok(Z.check({ ...base, mode: "flashcards", ...bad }).length, JSON.stringify(bad));
  assert.ok(/flashcard deck/.test(Z.check({ ...base, mode: "flashcards", timeLimitMinutes: 5 }).join(" ")));
  const gm = makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["SELECT TOP 1 id, status, quiz_mode FROM lms_quizzes", () => [{ id: 4, status: "draft", quiz_mode: "flashcards" }]]]);
  const rr = await R.addRule(gm.pool, teacher, 5, 4, { count: 2, pointsEach: 1 }); assert.deepStrictEqual([rr.ok, rr.code], [false, "RULES_NOT_FOR_FLASHCARDS"]);
  const row = { id: 4, course_id: 5, title: "Deck", instructions: null, assessment_type: "practice", quiz_mode: "flashcards", available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 1, shuffle_questions: 0, shuffle_options: 0, feedback_timing: "immediate", counts_to_grade: 0, question_count: 3, total_points: "3.00", rule_count: 0, course_status: "published" };
  const sm = makeMockPool([["FROM lms_quizzes z JOIN lms_courses c", () => [row]]]); const st = await A.startAttempt(sm.pool, student(), 5, 4, { now: NOW });
  assert.deepStrictEqual([st.ok, st.code], [false, "USE_CARDS"]); assert.ok(!sm.log.some((x) => /INSERT INTO lms_quiz_attempts/.test(x.sql)), "no attempt created");
  const lm = makeMockPool([["FROM lms_quizzes z JOIN lms_courses c", () => [{ ...row, total_count: 1 }]], ["FROM lms_quiz_attempts WHERE course_id = @c AND student_id = @s", () => []]]);
  const l = await A.listForStudent(lm.pool, student(), 5, { mode: "flashcards" }, { now: NOW }); assert.deepStrictEqual([l.items[0].mode, l.items[0].canStart, l.items[0].closedReason.code], ["flashcards", false, "FLASHCARDS"]); assert.strictEqual(lm.log[0].inputs.md, "flashcards");
});

test("schema step 030 + routes: ratings table is additive with a unique (student, card) index and is blocked from the record editor; both routes run the flag gate, student-only and enrolment first", async () => {
  const i = schema.STEPS.findIndex((s) => s.id === "030_lms_flashcard_ratings"); assert.ok(i === schema.STEPS.findIndex((s) => s.id === "029_lms_quiz_mode") + 1 && schema.STEPS[i + 1] && schema.STEPS[i + 1].id === "031_lms_gradebook" && i === schema.STEPS.length - 16 && schema.STEPS[i + 2].id === "032_lms_certificates" && schema.STEPS[i + 4].id === "034_lms_discussions" && schema.STEPS[i + 5].id === "035_lms_groups" && schema.STEPS[i + 6].id === "036_lms_group_forums" && schema.STEPS[i + 7].id === "037_lms_peer_review" && schema.STEPS[i + 3].id === "033_lms_badges", "030 is followed only by the gradebook step 031 (L7.1a), certificates 032 (L7.5a) badges 033 (L7.5b) and discussions 034 (L8.1)");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_flashcard_ratings'/.test(t) && /CREATE UNIQUE INDEX UX_lms_flashcard_ratings_card ON lms_flashcard_ratings \(student_id, quiz_question_id\)/.test(t) && !/DROP|DELETE|TRUNCATE/i.test(t));
  assert.ok(/"lms_flashcard_ratings"/.test(require("fs").readFileSync(require("path").join(__dirname, "../server.js"), "utf8")), "blocked from the generic record editor");
  const router = require("../routes/lms");
  const get = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/quizzes/:quizId/cards" && l.route.methods.get);
  const put = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/quizzes/:quizId/cards/:cardId/rating" && l.route.methods.put);
  assert.ok(get && put); assert.strictEqual(get.route.stack.length, 4, "gate + studentOnly + enrolment + handler"); assert.strictEqual(put.route.stack.length, 4);
  const st = new Map(); const m = makeMockPool([deckQ(), cardsQ(), ratingsQ(st)]); const res = makeRes();
  await get.route.stack[3].handle({ pool: m.pool, user: student(), params: { courseId: "5", quizId: "4" }, query: {}, tenant: "fc-a" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.deck.cards.length], [200, true, 3]);
  const m2 = makeMockPool([deckQ(), ownQ(), cardsQ(), ratingsQ(st)]); const res2 = makeRes();
  await put.route.stack[3].handle({ pool: m2.pool, user: student(), params: { courseId: "5", quizId: "4", cardId: "1" }, body: { rating: "unknown" }, query: {}, tenant: "fc-a" }, res2);
  assert.deepStrictEqual([res2.statusCode, res2.body.success, res2.body.rating], [200, true, "unknown"]);
  const m3 = makeMockPool([deckQ()]); const res3 = makeRes(); await put.route.stack[3].handle({ pool: m3.pool, user: student(), params: { courseId: "5", quizId: "4", cardId: "1" }, body: { rating: "nope" }, query: {}, tenant: "fc-a" }, res3); assert.strictEqual(res3.statusCode, 400);
});
