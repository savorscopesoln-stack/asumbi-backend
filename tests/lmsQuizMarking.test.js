/* L6.1a - quiz marking + question validation. PURE functions: no pool, no network. Fixed hand-checked cases for every question type. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("lmsQuizMarking.test.js");
const M = require("../utils/lmsQuizMarking");

const opts = (...c) => c.map((x, i) => ({ text: `Option ${i + 1}`, correct: !!x }));
const build = (body) => { const v = M.validateQuestion({ stem: "Q?", ...body }); assert.ok(v.ok, JSON.stringify(v.errors)); return { type: v.value.type, points: v.value.points, stem: v.value.stem, spec: v.value.spec }; };
const mark = (q, a) => { const r = M.markAnswer(q, a); return [r.status, r.points]; };

test("validate: text is cleaned (tags, control characters), defaults applied, tags de-duplicated, spec holds only the type fields", () => {
  const v = M.validateQuestion({ type: "true_false", stem: " <b>Is</b>\u0000 the sky blue? ", correct: "true", subject: " Physics ", topic: "Light", difficulty: "HARD", outcomeIds: [3, "3", 4], points: "2.5" });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepStrictEqual([v.value.stem, v.value.points, v.value.difficulty, v.value.subject, v.value.topic, v.value.outcomeIds, v.value.spec], ["bIs/b the sky blue?", 2.5, "hard", "Physics", "Light", [3, 4], { correct: true }]);
  assert.strictEqual(M.validateQuestion({ type: "essay", stem: "x" }).value.points, 1, "points default to 1");
});

test("validate: every bound and every wrong shape is refused (common fields)", () => {
  const ok = { type: "true_false", stem: "s", correct: true };
  const bad = [null, [], "x", {}, { type: "nope", stem: "s" }, { type: 5 }, { ...ok, stem: "" }, { ...ok, stem: "s".repeat(4001) }, { ...ok, explanation: "e".repeat(2001) },
    { ...ok, points: 0 }, { ...ok, points: -1 }, { ...ok, points: 100.01 }, { ...ok, points: 1.234 }, { ...ok, points: "x" }, { ...ok, difficulty: "extreme" },
    { ...ok, subject: "s".repeat(101) }, { ...ok, topic: "t".repeat(101) }, { ...ok, outcomeIds: [1, 2, 3, 4, 5, 6] }, { ...ok, outcomeIds: ["x"] }, { ...ok, outcomeIds: "1" }, { ...ok, outcomeIds: [0] },
    { ...ok, extra: 1 }, { ...ok, options: [] }, { ...ok, correct: "maybe" }, { type: "true_false", stem: "s" }];
  bad.forEach((b, i) => assert.strictEqual(M.validateQuestion(b).ok, false, `case ${i}: ${JSON.stringify(b)?.slice(0, 80)}`));
  assert.ok(M.validateQuestion({ ...ok, points: 100 }).ok && M.validateQuestion({ ...ok, stem: "s".repeat(4000) }).ok && M.validateQuestion({ ...ok, points: 0.01 }).ok);
});

test("validate: choice questions (counts, exactly-one rule, duplicates, unknown fields, text length)", () => {
  const t = (type, options, extra = {}) => M.validateQuestion({ type, stem: "s", options, ...extra }).ok;
  assert.ok(t("mcq_single", opts(1, 0)) && t("mcq_single", opts(1, 0, 0, 0, 0, 0, 0, 0, 0, 0)) && t("mcq_multi", opts(1, 1)) && t("mcq_multi", opts(0, 1, 1, 1)));
  assert.ok(!t("mcq_single", opts(1)), "one option is too few"); assert.ok(!t("mcq_single", opts(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), "11 options is too many");
  assert.ok(!t("mcq_single", opts(0, 0)), "none correct"); assert.ok(!t("mcq_single", opts(1, 1)), "two correct in a single-choice question");
  assert.ok(!t("mcq_multi", opts(0, 0)), "multi needs at least one correct"); assert.ok(!t("mcq_single", "x") && !t("mcq_single", undefined));
  assert.ok(!t("mcq_single", [{ text: "A", correct: true }, { text: "a", correct: false }]), "same text ignoring case");
  assert.ok(!t("mcq_single", [{ text: "", correct: true }, { text: "b" }]) && !t("mcq_single", [{ text: "A".repeat(501), correct: true }, { text: "b" }]));
  assert.ok(!t("mcq_single", [{ text: "A", correct: true, extra: 1 }, { text: "b" }]) && !t("mcq_single", [{ text: "A", correct: "yes" }, { text: "b" }]) && !t("mcq_single", [{ text: "A", correct: true, feedback: "f".repeat(301) }, { text: "b" }]));
  assert.ok(!t("mcq_single", [5, 6]) && !t("mcq_multi", opts(1, 1), { partialCredit: "sometimes" }));
  assert.ok(!M.validateQuestion({ type: "mcq_single", stem: "s", options: opts(1, 0), partialCredit: true }).ok, "partialCredit is not a field of single choice");
  const v = M.validateQuestion({ type: "mcq_single", stem: "s", options: [{ text: " <i>A</i> ", correct: true, feedback: "Yes" }, { text: "B" }] }).value.spec.options;
  assert.deepStrictEqual(v, [{ position: 1, text: "iA/i", correct: true, feedback: "Yes" }, { position: 2, text: "B", correct: false, feedback: "" }]);
});

test("validate: short answer, numeric, matching, ordering, essay specifics", () => {
  const ok = (b) => M.validateQuestion({ stem: "s", ...b }).ok;
  assert.ok(ok({ type: "short_answer", accepted: ["Nairobi"] }) && ok({ type: "short_answer", accepted: Array.from({ length: 20 }, (_, i) => `a${i}`) }));
  assert.ok(!ok({ type: "short_answer", accepted: [] }) && !ok({ type: "short_answer", accepted: Array.from({ length: 21 }, (_, i) => `a${i}`) }) && !ok({ type: "short_answer", accepted: [""] }) && !ok({ type: "short_answer", accepted: [5] }) && !ok({ type: "short_answer", accepted: ["a".repeat(201)] }) && !ok({ type: "short_answer" }) && !ok({ type: "short_answer", accepted: ["a"], caseSensitive: "x" }));
  assert.deepStrictEqual(M.validateQuestion({ type: "short_answer", stem: "s", accepted: ["A", " A ", "B"] }).value.spec.accepted, ["A", "B"], "duplicates collapse");
  assert.ok(ok({ type: "numeric", value: 9.81, tolerance: 0.01, unit: "m/s" }) && ok({ type: "numeric", value: "3" }) && ok({ type: "numeric", value: 0 }));
  assert.ok(!ok({ type: "numeric" }) && !ok({ type: "numeric", value: "abc" }) && !ok({ type: "numeric", value: 1, tolerance: -1 }) && !ok({ type: "numeric", value: 1, tolerance: "x" }) && !ok({ type: "numeric", value: 1, unit: "u".repeat(31) }) && !ok({ type: "numeric", value: Infinity }));
  const p = (n) => Array.from({ length: n }, (_, i) => ({ left: `L${i}`, right: `R${i}` }));
  assert.ok(ok({ type: "matching", pairs: p(2) }) && ok({ type: "matching", pairs: p(10) }) && !ok({ type: "matching", pairs: p(1) }) && !ok({ type: "matching", pairs: p(11) }) && !ok({ type: "matching", pairs: "x" }));
  assert.ok(!ok({ type: "matching", pairs: [{ left: "a", right: "1" }, { left: "A", right: "2" }] }), "same left"); assert.ok(!ok({ type: "matching", pairs: [{ left: "a", right: "1" }, { left: "b", right: "1" }] }), "same right");
  assert.ok(!ok({ type: "matching", pairs: [{ left: "", right: "1" }, { left: "b", right: "2" }] }) && !ok({ type: "matching", pairs: [{ left: "a", right: "1", x: 1 }, { left: "b", right: "2" }] }) && !ok({ type: "matching", pairs: [3, 4] }));
  assert.ok(ok({ type: "ordering", items: ["a", "b"] }) && ok({ type: "ordering", items: Array.from({ length: 10 }, (_, i) => `i${i}`) }) && !ok({ type: "ordering", items: ["a"] }) && !ok({ type: "ordering", items: Array.from({ length: 11 }, (_, i) => `i${i}`) }) && !ok({ type: "ordering", items: ["a", "A"] }) && !ok({ type: "ordering", items: ["a", 2] }) && !ok({ type: "ordering", items: ["a", ""] }));
  assert.ok(ok({ type: "essay" }) && ok({ type: "essay", maxWords: 500 }) && ok({ type: "essay", maxWords: 10000 }) && !ok({ type: "essay", maxWords: 0 }) && !ok({ type: "essay", maxWords: 10001 }) && !ok({ type: "essay", maxWords: 1.5 }));
  assert.strictEqual(M.validateQuestion({ type: "essay", stem: "s" }).value.spec.maxWords, null);
});

test("mark: single choice", () => {
  const q = build({ type: "mcq_single", points: 2, options: opts(0, 1, 0) });
  assert.deepStrictEqual([mark(q, { selected: 2 }), mark(q, { selected: "2" }), mark(q, { selected: 1 }), mark(q, { selected: 3 }), mark(q, { selected: 9 }), mark(q, { selected: 0 }), mark(q, { selected: [2] }), mark(q, { selected: null }), mark(q, {}), mark(q, null), mark(q, undefined), mark(q, "2")],
    [["correct", 2], ["correct", 2], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["unanswered", 0], ["unanswered", 0], ["unanswered", 0]]);
});

test("mark: multiple choice, all-or-nothing and partial credit (hits minus wrongs, never below 0)", () => {
  const strict = build({ type: "mcq_multi", points: 4, options: opts(1, 1, 0, 0) });
  assert.deepStrictEqual([mark(strict, { selected: [1, 2] }), mark(strict, { selected: [2, 1, 1] }), mark(strict, { selected: [1] }), mark(strict, { selected: [1, 2, 3] }), mark(strict, { selected: [3] }), mark(strict, { selected: [] }), mark(strict, { selected: [1, 9] }), mark(strict, { selected: "1" }), mark(strict, { selected: ["x"] }), mark(strict, {})],
    [["correct", 4], ["correct", 4], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0]]);
  const part = build({ type: "mcq_multi", points: 4, partialCredit: true, options: opts(1, 1, 0, 0) });
  assert.deepStrictEqual([mark(part, { selected: [1, 2] }), mark(part, { selected: [1] }), mark(part, { selected: [1, 3] }), mark(part, { selected: [1, 3, 4] }), mark(part, { selected: [3] }), mark(part, { selected: [1, 2, 3] })],
    [["correct", 4], ["partial", 2], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["partial", 2]]);
  const three = build({ type: "mcq_multi", points: 3, partialCredit: true, options: opts(1, 1, 1, 0) });
  assert.deepStrictEqual(mark(three, { selected: [1] }), ["partial", 1]); assert.deepStrictEqual(mark(three, { selected: [1, 2] }), ["partial", 2]);
});

test("mark: true/false", () => {
  const t = build({ type: "true_false", correct: true, points: 1 }), f = build({ type: "true_false", correct: false, points: 1 });
  assert.deepStrictEqual([mark(t, { selected: true }), mark(t, { selected: "true" }), mark(t, { selected: false }), mark(t, { selected: "false" }), mark(t, { selected: "maybe" }), mark(t, { selected: 1 }), mark(t, {}), mark(t, { selected: null }), mark(t, { selected: "" })],
    [["correct", 1], ["correct", 1], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["unanswered", 0]]);
  assert.deepStrictEqual([mark(f, { selected: false }), mark(f, { selected: true })], [["correct", 1], ["incorrect", 0]]);
});

test("mark: short answer (whitespace, case, case-sensitive, any accepted string, empty)", () => {
  const q = build({ type: "short_answer", accepted: ["Nairobi", "Nairobi City"], points: 3 }), cs = build({ type: "short_answer", accepted: ["NaCl"], caseSensitive: true, points: 1 });
  assert.deepStrictEqual([mark(q, { text: "nairobi" }), mark(q, { text: "  NAIROBI  " }), mark(q, { text: "nairobi   city" }), mark(q, { text: "Mombasa" }), mark(q, { text: "Nairobi!" }), mark(q, { text: "   " }), mark(q, { text: "" }), mark(q, {}), mark(q, { text: 5 })],
    [["correct", 3], ["correct", 3], ["correct", 3], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["unanswered", 0], ["incorrect", 0]]);
  assert.deepStrictEqual([mark(cs, { text: "NaCl" }), mark(cs, { text: "nacl" }), mark(cs, { text: " NaCl " })], [["correct", 1], ["incorrect", 0], ["correct", 1]]);
});

test("mark: numeric (tolerance edges, strings, comma decimals refused, junk)", () => {
  const q = build({ type: "numeric", value: 9.81, tolerance: 0.01, points: 2 }), exact = build({ type: "numeric", value: 0.3, points: 1 }), z = build({ type: "numeric", value: 0, points: 1 });
  assert.deepStrictEqual([mark(q, { value: 9.81 }), mark(q, { value: "9.82" }), mark(q, { value: 9.8 }), mark(q, { value: 9.83 }), mark(q, { value: 9.79 }), mark(q, { value: " 9.81 " }), mark(q, { value: "9,81" }), mark(q, { value: "1,000" }), mark(q, { value: "abc" }), mark(q, { value: "" }), mark(q, {}), mark(q, { value: NaN }), mark(q, { value: "9.81e0" }), mark(q, { value: "9 .81" })],
    [["correct", 2], ["correct", 2], ["correct", 2], ["incorrect", 0], ["incorrect", 0], ["correct", 2], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["incorrect", 0], ["correct", 2], ["correct", 2]]);
  assert.strictEqual(mark(exact, { value: 0.1 + 0.2 })[0], "correct", "float noise does not fail an exact answer");
  assert.deepStrictEqual([mark(z, { value: 0 }), mark(z, { value: "0" }), mark(z, { value: 0.1 })], [["correct", 1], ["correct", 1], ["incorrect", 0]]);
});

test("mark: matching (all-or-nothing and partial; null = not set; wrong length / range = 0)", () => {
  const strict = build({ type: "matching", points: 3, pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }, { left: "c", right: "3" }] });
  const part = build({ type: "matching", points: 3, partialCredit: true, pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }, { left: "c", right: "3" }] });
  assert.deepStrictEqual([mark(strict, { pairs: [1, 2, 3] }), mark(strict, { pairs: [1, 3, 2] }), mark(strict, { pairs: [1, 2, null] }), mark(strict, { pairs: [null, null, null] }), mark(strict, { pairs: [1, 2] }), mark(strict, { pairs: [1, 2, 4] }), mark(strict, { pairs: [] }), mark(strict, {}), mark(strict, { pairs: "123" }), mark(strict, { pairs: ["1", "2", "3"] })],
    [["correct", 3], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["incorrect", 0], ["correct", 3]]);
  assert.deepStrictEqual([mark(part, { pairs: [1, 3, 2] }), mark(part, { pairs: [1, 2, null] }), mark(part, { pairs: [2, 3, 1] }), mark(part, { pairs: [3, 2, 1] })], [["partial", 1], ["partial", 2], ["incorrect", 0], ["partial", 1]]);
});

test("mark: ordering (exact, partial = items in the right place, must be a permutation)", () => {
  const strict = build({ type: "ordering", points: 4, items: ["first", "second", "third", "fourth"] }), part = build({ type: "ordering", points: 4, partialCredit: true, items: ["first", "second", "third", "fourth"] });
  assert.deepStrictEqual([mark(strict, { order: [1, 2, 3, 4] }), mark(strict, { order: [2, 1, 3, 4] }), mark(strict, { order: [1, 1, 3, 4] }), mark(strict, { order: [1, 2, 3] }), mark(strict, { order: [1, 2, 3, 5] }), mark(strict, { order: [] }), mark(strict, {}), mark(strict, { order: "1234" }), mark(strict, { order: [0, 2, 3, 4] })],
    [["correct", 4], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["incorrect", 0], ["unanswered", 0], ["unanswered", 0], ["incorrect", 0], ["incorrect", 0]]);
  assert.deepStrictEqual([mark(part, { order: [2, 1, 3, 4] }), mark(part, { order: [1, 2, 3, 4] }), mark(part, { order: [4, 3, 2, 1] }), mark(part, { order: [1, 1, 3, 4] })], [["partial", 2], ["correct", 4], ["incorrect", 0], ["incorrect", 0]]);
});

test("mark: essay is never auto-marked; unknown type and broken questions never throw and score 0", () => {
  const e = build({ type: "essay", points: 10 });
  assert.deepStrictEqual(M.markAnswer(e, { text: "A long answer" }), { status: "manual", fraction: null, points: null, maxPoints: 10 });
  assert.deepStrictEqual(M.markAnswer(e, null), { status: "manual", fraction: null, points: null, maxPoints: 10 }, "an empty essay is still a teacher decision");
  for (const q of [null, undefined, {}, { type: "weird", points: 1 }, { type: "mcq_single", points: 1 }, { type: "mcq_single", points: 1, spec: { options: "x" } }, { type: "ordering", points: 1, spec: null }]) {
    const r = M.markAnswer(q, { selected: 1, order: [1] }); assert.ok(["incorrect", "unanswered"].includes(r.status) && r.points === 0, JSON.stringify(q));
  }
  assert.strictEqual(M.markAnswer({ type: "true_false", points: 2.5, spec: { correct: true } }, { selected: true }).points, 2.5);
  assert.strictEqual(M.markAnswer({ type: "mcq_multi", points: 1, spec: { partialCredit: true, options: opts(1, 1, 1).map((o, i) => ({ ...o, position: i + 1 })) } }, { selected: [1] }).points, 0.33, "points are rounded to 2 decimals");
});

test("studentView: no answer key in ANY type (correct flags, accepted answers, value, feedback, explanation, positions that give the pairing away)", () => {
  const defs = [build({ type: "mcq_single", options: opts(1, 0) }), build({ type: "mcq_multi", options: opts(1, 1, 0) }), build({ type: "true_false", correct: true }),
    build({ type: "short_answer", accepted: ["SECRETWORD"] }), build({ type: "numeric", value: 424242, tolerance: 7, unit: "kg" }), build({ type: "essay", maxWords: 50 }),
    build({ type: "matching", pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }, { left: "c", right: "3" }] }), build({ type: "ordering", items: ["one", "two", "three", "four"] })];
  for (const q of defs) {
    q.explanation = "EXPLAIN-SECRET"; if (q.spec.options) q.spec.options[0].feedback = "FEEDBACK-SECRET";
    const { view } = M.studentView(q, "seed"); const s = JSON.stringify(view);
    for (const bad of ["SECRETWORD", "424242", "EXPLAIN-SECRET", "FEEDBACK-SECRET", '"correct"', "accepted", "partialCredit", "tolerance"]) assert.ok(!s.includes(bad), `${q.type} leaks ${bad}: ${s}`);
  }
  const m = M.studentView(defs[6], "x"); assert.ok(m.view.rights.every((r) => !("position" in r)), "right-hand items carry a display ref, not their position");
  assert.notDeepStrictEqual(m.refMap.rights, [1, 2, 3], "right-hand list is never in answer-key order");
  const o = M.studentView(defs[7], "x"); assert.ok(o.view.items.every((r) => !("position" in r)) && o.refMap.items.join() !== "1,2,3,4", "ordering items are never shown already sorted");
  assert.deepStrictEqual(M.studentView(defs[4], "x").view, { type: "numeric", stem: "Q?", points: 1, unit: "kg" });
});

test("permutation: deterministic per seed, a real permutation, never the identity for n >= 2, different seeds differ", () => {
  for (let n = 2; n <= 10; n++) for (const seed of ["", "a", "attempt-7-q-3", "ünï"]) {
    const p = M.permutation(n, seed); assert.deepStrictEqual([...p].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1)); assert.notDeepStrictEqual(p, Array.from({ length: n }, (_, i) => i + 1), `n=${n} seed=${seed}`);
    assert.deepStrictEqual(M.permutation(n, seed), p);
  }
  assert.deepStrictEqual(M.permutation(1, "x"), [1]); assert.deepStrictEqual(M.permutation(0, "x"), []);
  const seeds = new Set(Array.from({ length: 30 }, (_, i) => M.permutation(8, `s${i}`).join())); assert.ok(seeds.size > 20, "seeds give varied orders");
});

test("translateAnswer: display refs become positions; shuffling never changes the marks; bad refs score 0; other types pass through", () => {
  const match = build({ type: "matching", points: 3, pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }, { left: "c", right: "3" }] });
  const order = build({ type: "ordering", points: 4, items: ["one", "two", "three", "four"] });
  for (const seed of ["s1", "s2", "s3", "s4"]) {
    const m = M.studentView(match, seed); const refOf = (text) => m.view.rights.find((r) => r.text === text).ref;
    assert.deepStrictEqual(mark(match, M.translateAnswer(match, m.refMap, { pairs: [refOf("1"), refOf("2"), refOf("3")] })), ["correct", 3]);
    assert.deepStrictEqual(mark(match, M.translateAnswer(match, m.refMap, { pairs: [refOf("2"), refOf("1"), refOf("3")] })), ["incorrect", 0]);
    const o = M.studentView(order, seed); const oref = (text) => o.view.items.find((r) => r.text === text).ref;
    assert.deepStrictEqual(mark(order, M.translateAnswer(order, o.refMap, { order: ["one", "two", "three", "four"].map(oref) })), ["correct", 4]);
    assert.deepStrictEqual(mark(order, M.translateAnswer(order, o.refMap, { order: ["two", "one", "three", "four"].map(oref) })), ["incorrect", 0]);
  }
  const m = M.studentView(match, "s1");
  assert.deepStrictEqual(mark(match, M.translateAnswer(match, m.refMap, { pairs: [9, 9, 9] })), ["incorrect", 0], "a ref that does not exist scores 0");
  assert.deepStrictEqual(mark(match, M.translateAnswer(match, m.refMap, { pairs: [null, null, null] })), ["unanswered", 0]);
  assert.deepStrictEqual(M.translateAnswer(order, M.studentView(order, "s").refMap, { order: ["x", 1, 2, 3] }).order[0], 0, "ordering: junk ref becomes an invalid position");
  assert.deepStrictEqual(M.translateAnswer({ type: "mcq_single" }, {}, { selected: 2 }), { selected: 2 }); assert.strictEqual(M.translateAnswer(match, {}, null), null);
});
