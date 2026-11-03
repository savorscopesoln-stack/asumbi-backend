/* L7.1a - grade calculation (D-085): hand-calculated weighted totals, drop-lowest, exclusions, learner view, bands, garbage input. Pure functions, no database. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("lmsGradeCalc.test.js");
const G = require("../utils/lmsGradeCalc");

const CATS = [{ id: 1, weight: 60, dropLowest: 0 }, { id: 2, weight: 40, dropLowest: 1 }];
const ITEMS = [
  { id: 10, categoryId: 1, maxPoints: 100, weight: 1, released: true },   // Exam 1
  { id: 20, categoryId: 2, maxPoints: 20, weight: 1, released: true },    // CAT 1
  { id: 21, categoryId: 2, maxPoints: 20, weight: 1, released: true },    // CAT 2
  { id: 22, categoryId: 2, maxPoints: 20, weight: 1, released: true },    // CAT 3
];
const GR = (o = {}) => ({ 10: { points: 70 }, 20: { points: 10 }, 21: { points: 18 }, 22: { points: 15 }, ...o });
const grades = (m) => Object.entries(m).filter(([, v]) => v).map(([k, v]) => ({ itemId: Number(k), ...v }));
const calc = (o = {}) => G.computeTotal({ categories: CATS, items: ITEMS, grades: grades(GR(o.grades)), ...o.rest });

test("weighted total with drop-lowest, by hand: Exams 70% x 60 + CATs mean(90, 75) = 82.5 x 40 = 75", () => {
  const r = calc(); assert.strictEqual(r.percent, 75);
  assert.deepStrictEqual(r.categories.map((c) => [c.id, c.percent, c.counted, c.dropped, c.weightUsed]), [[1, 70, 1, [], 60], [2, 82.5, 2, [20], 40]]);
  assert.deepStrictEqual([r.itemsCounted, r.itemsLeftOut], [3, 0]);
  assert.deepStrictEqual(r.items.find((i) => i.id === 20), { id: 20, percent: 50, counted: false, dropped: true, excluded: null });
});

test("an item that is not graded yet is LEFT OUT (not a zero); an empty category does not pull the total down; weights are re-scaled", () => {
  const r = calc({ grades: { 10: null } }); assert.strictEqual(r.percent, 82.5, "only the CAT category counts, rescaled to 100");
  assert.deepStrictEqual(r.categories.map((c) => [c.id, c.weightUsed]), [[2, 100]]);
  assert.deepStrictEqual(r.items.find((i) => i.id === 10), { id: 10, percent: null, counted: false, dropped: false, excluded: "NOT_GRADED" });
  const zero = calc({ grades: { 10: { points: 0 } } }); assert.strictEqual(zero.percent, 33, "an explicit 0 DOES count: 0 x 0.6 + 82.5 x 0.4");
  assert.strictEqual(calc({ grades: { 10: { points: null } } }).percent, 82.5, "points null = not graded");
  const none = G.computeTotal({ categories: CATS, items: ITEMS, grades: [] }); assert.deepStrictEqual([none.percent, none.itemsCounted, none.itemsLeftOut], [null, 0, 4]);
});

test("excused items are left out; a drop never leaves a category empty; ties drop the HIGHER id first", () => {
  const ex = calc({ grades: { 21: { points: 18, excused: true } } }); assert.strictEqual(ex.items.find((i) => i.id === 21).excluded, "EXCUSED");
  assert.deepStrictEqual(ex.categories.find((c) => c.id === 2).dropped, [20], "CAT 1 (50) is still the lowest of the two that remain"); assert.strictEqual(ex.categories.find((c) => c.id === 2).percent, 75);
  const one = G.computeTotal({ categories: [{ id: 1, weight: 100, dropLowest: 5 }], items: [{ id: 1, categoryId: 1, maxPoints: 10, weight: 1, released: true }], grades: [{ itemId: 1, points: 4 }] });
  assert.deepStrictEqual([one.percent, one.categories[0].dropped, one.categories[0].counted], [40, [], 1], "the only item is never dropped");
  const tie = G.computeTotal({ categories: [{ id: 1, weight: 100, dropLowest: 1 }], items: [1, 2, 3].map((id) => ({ id, categoryId: 1, maxPoints: 10, weight: 1, released: true })), grades: [{ itemId: 1, points: 5 }, { itemId: 2, points: 5 }, { itemId: 3, points: 9 }] });
  assert.deepStrictEqual(tie.categories[0].dropped, [2], "items 1 and 2 tie at 50%: the later one (id 2) goes");
  assert.deepStrictEqual(G.computeTotal({ categories: [{ id: 1, weight: 100, dropLowest: -2 }], items: [{ id: 1, categoryId: 1, maxPoints: 10, released: true }, { id: 2, categoryId: 1, maxPoints: 10, released: true }], grades: [{ itemId: 1, points: 1 }, { itemId: 2, points: 9 }] }).categories[0].dropped, [], "a negative drop count is 0");
});

test("item weights inside a category: (100 x 1 + 50 x 3) / 4 = 62.5; all item weights 0 = equal weights", () => {
  const mk = (w1, w2) => G.computeTotal({ categories: [{ id: 1, weight: 100 }], items: [{ id: 1, categoryId: 1, maxPoints: 10, weight: w1, released: true }, { id: 2, categoryId: 1, maxPoints: 10, weight: w2, released: true }], grades: [{ itemId: 1, points: 10 }, { itemId: 2, points: 5 }] }).percent;
  assert.strictEqual(mk(1, 3), 62.5); assert.strictEqual(mk(0, 0), 75, "equal weights"); assert.strictEqual(mk(0, 2), 50, "a zero-weight item does not count while another has weight");
});

test("category weights that do not add up to 100 are re-scaled; all zero = equal; uncategorised items count only when every weight is 0", () => {
  const items = [{ id: 1, categoryId: 1, maxPoints: 10, released: true }, { id: 2, categoryId: 2, maxPoints: 10, released: true }]; const gr = [{ itemId: 1, points: 10 }, { itemId: 2, points: 4 }];
  assert.strictEqual(G.computeTotal({ categories: [{ id: 1, weight: 30 }, { id: 2, weight: 10 }], items, grades: gr }).percent, 85, "(100 x 30 + 40 x 10) / 40");
  assert.strictEqual(G.computeTotal({ categories: [{ id: 1, weight: 0 }, { id: 2, weight: 0 }], items, grades: gr }).percent, 70, "equal: (100 + 40) / 2");
  const un = [...items, { id: 3, categoryId: null, maxPoints: 10, released: true }, { id: 4, categoryId: 99, maxPoints: 10, released: true }];
  assert.strictEqual(G.computeTotal({ categories: [{ id: 1, weight: 30 }, { id: 2, weight: 10 }], items: un, grades: [...gr, { itemId: 3, points: 0 }, { itemId: 4, points: 0 }] }).percent, 85, "uncategorised / unknown category weigh 0");
});

test("learner view: unreleased items and hidden grades are left out; staff see everything", () => {
  const items = ITEMS.map((i) => (i.id === 22 ? { ...i, released: false } : i));
  const stu = G.computeTotal({ categories: CATS, items, grades: grades(GR({ 21: { points: 18, hidden: true } })), viewer: "student" });
  assert.deepStrictEqual(stu.items.map((i) => i.excluded), [null, null, "HIDDEN", "NOT_RELEASED"]);
  assert.deepStrictEqual(stu.categories.map((c) => c.dropped), [[], []]);
  assert.strictEqual(stu.categories.find((c) => c.id === 2).percent, 50, "only CAT 1 (10/20) is visible; with ONE item the drop is skipped");
  assert.strictEqual(stu.percent, 62, "70 x 0.6 + 50 x 0.4");
  const staff = G.computeTotal({ categories: CATS, items, grades: grades(GR({ 21: { points: 18, hidden: true } })), viewer: "staff" }); assert.strictEqual(staff.percent, 75, "staff are not limited by release or hidden");
  assert.strictEqual(G.computeTotal({ categories: CATS, items, grades: grades(GR()), viewer: "anything-else" }).percent, 75, "any viewer other than 'student' gets the staff view");
});

test("percentages: extra credit above 100 is kept, below 0 becomes 0, 2-decimal half-up rounding, max <= 0 is left out", () => {
  const one = (pts, max = 20) => G.computeTotal({ categories: [{ id: 1, weight: 100 }], items: [{ id: 1, categoryId: 1, maxPoints: max, released: true }], grades: [{ itemId: 1, points: pts }] });
  assert.strictEqual(one(25).percent, 125); assert.strictEqual(one(-3).percent, 0); assert.strictEqual(one(1, 3).percent, 33.33); assert.strictEqual(one("13.3", 20).percent, 66.5);
  assert.strictEqual(one(10.5, 20).percent, 52.5); assert.strictEqual(G.round2(0.525), 0.53); assert.strictEqual(G.round2(1.005), 1.01, "float noise must not round down"); assert.strictEqual(G.round2(2.675), 2.68); assert.strictEqual(G.round2(66.665), 66.67);
  const nomax = one(5, 0); assert.deepStrictEqual([nomax.percent, nomax.items[0].excluded], [null, "NO_MAX"]);
  assert.strictEqual(one("abc").percent, null, "a non-numeric entry is treated as not graded");
});

test("grades may arrive as a Map; the order of categories in the result follows the course's category order", () => {
  const m = new Map(Object.entries(GR()).map(([k, v]) => [Number(k), v]));
  const r = G.computeTotal({ categories: [...CATS].reverse(), items: ITEMS, grades: m }); assert.strictEqual(r.percent, 75); assert.deepStrictEqual(r.categories.map((c) => c.id), [2, 1]);
});

test("bandFor: highest band reached, unordered input, invalid bands ignored, null when nothing matches", () => {
  const bands = [{ min: 0, label: "E" }, { min: 70, label: "A" }, { min: 50, label: "C" }, { min: 60, label: "B" }, { min: "x", label: "?" }, { min: 10, label: "" }, null];
  assert.deepStrictEqual([100, 70, 69.99, 60, 50, 0].map((p) => G.bandFor(p, bands)), ["A", "A", "B", "B", "C", "E"]);
  assert.strictEqual(G.bandFor(-1, bands), null); assert.strictEqual(G.bandFor(null, bands), null); assert.strictEqual(G.bandFor(50, []), null); assert.strictEqual(G.bandFor(50, "x"), null);
  assert.strictEqual(G.bandFor(125, bands), "A", "extra credit stays in the top band");
});

test("never throws on garbage input", () => {
  for (const bad of [undefined, null, 5, "x", [], { categories: "x", items: 7, grades: null }, { items: [null, 1, "a"], categories: [null], grades: [null, 3] }]) assert.doesNotThrow(() => G.computeTotal(bad));
  assert.deepStrictEqual(G.computeTotal(undefined), { percent: null, categories: [], items: [], itemsCounted: 0, itemsLeftOut: 0 });
});

test("schema step 031: additive, four tables, history is append-only by design, source uniqueness, and every table is blocked from the generic record editor", () => {
  const schema = require("../utils/lmsSchema"); const i = schema.STEPS.findIndex((x) => x.id === "031_lms_gradebook"); assert.ok(i === schema.STEPS.length - 15 && i >= 1 && schema.STEPS[i + 1].id === "032_lms_certificates" && schema.STEPS[i + 2].id === "033_lms_badges" && schema.STEPS[i + 3].id === "034_lms_discussions" && schema.STEPS[i + 4].id === "035_lms_groups" && schema.STEPS[i + 5].id === "036_lms_group_forums" && schema.STEPS[i + 6].id === "037_lms_peer_review", "031 is followed only by certificates 032, badges 033, discussions 034 and groups 035");
  const t = schema.STEPS[i].sql.join("\n");
  assert.ok(!/\b(DROP|DELETE|TRUNCATE)\b|ALTER\s+TABLE\s+(?!lms_)/i.test(t), "additive only");
  for (const n of ["lms_grade_categories", "lms_grade_items", "lms_grades", "lms_grade_history"]) assert.ok(new RegExp(`IF NOT EXISTS \\(SELECT \\* FROM sysobjects WHERE name='${n}'`).test(t), n);
  assert.ok(/CREATE UNIQUE INDEX UX_lms_grades_item_student ON lms_grades \(item_id, student_id\)/.test(t), "one grade per learner per item");
  assert.ok(/UX_lms_grade_items_source ON lms_grade_items \(course_id, source_type, source_id\) WHERE source_id IS NOT NULL AND deleted_at IS NULL/.test(t), "one item per source");
  const server = require("fs").readFileSync(require("path").join(__dirname, "../server.js"), "utf8");
  for (const n of ["lms_grade_categories", "lms_grade_items", "lms_grades", "lms_grade_history"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), `${n} must be blocked from the generic record editor`);
});
