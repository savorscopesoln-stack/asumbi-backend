/* Unit tests for frontend/src/components/aiMarking/aiReviewHelpers.mjs (pure functions behind AiReviewPanel.jsx).
   The file is an .mjs so Node can import it directly; it has no React/DOM dependency.
   If you move it, set AI_REVIEW_HELPERS_PATH to its new location. */
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { suite, test, assert } = require("./helpers/tinytest");
const L = require("../services/aiMarkingReview.logic");

suite("aiReviewHelpers.test.js");

const FILE = process.env.AI_REVIEW_HELPERS_PATH || path.join(__dirname, "../../frontend/src/components/aiMarking/aiReviewHelpers.mjs");
const load = () => {
  if (!fs.existsSync(FILE)) throw new Error(`aiReviewHelpers.mjs not found at ${FILE}. If you moved it, set AI_REVIEW_HELPERS_PATH.`);
  return import(pathToFileURL(FILE).href);
};

const criteria = [
  { criterionId: "c1", label: "Defines", maxMarks: 2, aiMarks: 2 },
  { criterionId: "c2", label: "Products", maxMarks: 3, aiMarks: 3 },
];

test("parseMark: empty is null, decimals and a decimal comma are numbers, anything else is NaN", async () => {
  const H = await load();
  assert.strictEqual(H.parseMark(""), null);
  assert.strictEqual(H.parseMark("   "), null);
  assert.strictEqual(H.parseMark(undefined), null);
  assert.strictEqual(H.parseMark("2"), 2);
  assert.strictEqual(H.parseMark("1.5"), 1.5);
  assert.strictEqual(H.parseMark("1,5"), 1.5);
  for (const bad of ["abc", "-1", "1e3", ".5", "2.", "1.2.3", "0x10", "Infinity"]) assert.ok(Number.isNaN(H.parseMark(bad)), bad);
});

test("evaluateEdits: no edits = the AI's total; only CHANGED criteria are reported; same-as-AI is not a change", async () => {
  const H = await load();
  const none = H.evaluateEdits(criteria, {}, 5);
  assert.deepStrictEqual([none.total, none.anyChange, none.valid, none.marks], [5, false, true, {}]);
  const same = H.evaluateEdits(criteria, { c1: "2", c2: "" }, 5);
  assert.deepStrictEqual([same.anyChange, same.marks], [false, {}]);
  const one = H.evaluateEdits(criteria, { c2: "2" }, 5);
  assert.deepStrictEqual([one.total, one.anyChange, one.valid, one.marks], [4, true, true, { c2: 2 }]);
});

test("evaluateEdits: bad input is explained in words and never marked valid", async () => {
  const H = await load();
  const t = (edits, max = 5, crit = criteria) => H.evaluateEdits(crit, edits, max);
  assert.ok(/at most 2/.test(t({ c1: "2.5" }).problems[0]));
  assert.ok(/enter a number/.test(t({ c1: "x" }).problems[0]));
  assert.ok(/2 decimal places/.test(t({ c1: "1.234" }).problems[0]));
  assert.ok(/not a whole number/.test(t({ c1: "1.5" }).problems[0]), "1.5 + AI's 3 = 4.5");
  assert.strictEqual(t({ c1: "1.5", c2: "2.5" }).valid, true, "1.5 + 2.5 = 4");
  assert.ok(/above the question's maximum/.test(t({}, 4).problems[0]), "criteria add to 5 but the question is out of 4");
  assert.strictEqual(t({ c1: "-1" }).valid, false);
});

test("evaluateEdits: reports whether anything was typed and how many boxes are unusable (so bad input is never silently ignored)", async () => {
  const H = await load();
  const untouched = H.evaluateEdits(criteria, {}, 5);
  assert.deepStrictEqual([untouched.touched, untouched.fieldErrors], [false, 0]);
  const bad = H.evaluateEdits(criteria, { c1: "2.5", c2: "abc" }, 5);
  assert.deepStrictEqual([bad.touched, bad.fieldErrors, bad.anyChange], [true, 2, false], "invalid text is touched + an error even though it is not a 'change'");
  const wholeProblem = H.evaluateEdits(criteria, { c1: "1.5" }, 5);
  assert.deepStrictEqual([wholeProblem.touched, wholeProblem.fieldErrors, wholeProblem.valid], [true, 0, false], "a non-whole total is a problem but not a bad box");
  const same = H.evaluateEdits(criteria, { c1: "2" }, 5);
  assert.deepStrictEqual([same.touched, same.anyChange, same.valid], [true, false, true]);
});

test("evaluateDirectMark: whole numbers within range only", async () => {
  const H = await load();
  assert.deepStrictEqual(H.evaluateDirectMark("", 5), { value: null, problem: null });
  assert.deepStrictEqual(H.evaluateDirectMark("4", 5), { value: 4, problem: null });
  assert.ok(H.evaluateDirectMark("3.5", 5).problem);
  assert.ok(H.evaluateDirectMark("6", 5).problem);
  assert.ok(H.evaluateDirectMark("abc", 5).problem);
  assert.deepStrictEqual(H.evaluateDirectMark("0", 5), { value: 0, problem: null });
});

test("PARITY: the client's whole-number options match the server's for every total and maximum", async () => {
  const H = await load();
  for (let max = 1; max <= 10; max += 1) {
    for (let t = 0; t <= max * 2; t += 1) {
      const total = t / 2;
      if (total > max) continue;
      assert.deepStrictEqual(H.wholeOptions(total, max), L.wholeMarkOptions(total, max), `total ${total} / max ${max}`);
    }
  }
});

test("PARITY: for a grid of teacher edits, the client's verdict and total are exactly the server's", async () => {
  const H = await load();
  const c1s = ["", "0", "0.5", "1", "1.5", "2", "2.5", "-1", "1.234", "x"];
  const c2s = ["", "0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "1.25"];
  const ev = L.presentEvaluation({
    criteriaJson: JSON.stringify({ criteria: [
      { criterionId: "c1", label: "Defines", maxMarks: 2, marksAwarded: 2, evidence: ["a"], matchedPoints: [0], explanation: "x" },
      { criterionId: "c2", label: "Products", maxMarks: 3, marksAwarded: 3, evidence: ["a"], matchedPoints: [0], explanation: "y" },
    ], missingPoints: [] }),
    reviewFlags: "[]", schemeCriteriaJson: "[]", suggestedTotal: 5, maxMarks: 5,
  });
  let compared = 0;
  for (const a of c1s) for (const b of c2s) {
    const edits = { c1: a, c2: b };
    const client = H.evaluateEdits(ev.criteria, edits, 5);
    // exactly what the panel would send
    const sent = {};
    for (const [id, text] of Object.entries(edits)) { const p = H.parseMark(text); if (p !== null) sent[id] = p; }
    let server = null;
    try { server = L.resolveApproval({ mode: "adjust", criteriaMarks: sent }, ev); } catch { server = null; }
    if (Object.values(sent).some((v) => Number.isNaN(v))) { assert.strictEqual(client.valid, false, JSON.stringify(edits)); compared += 1; continue; }
    assert.strictEqual(client.valid, server !== null, `validity differs for ${JSON.stringify(edits)}`);
    if (server) assert.strictEqual(client.total, server.finalMark, `total differs for ${JSON.stringify(edits)}`);
    compared += 1;
  }
  assert.strictEqual(compared, c1s.length * c2s.length);
});

test("highlightSegments: exact, case-insensitive and whitespace-tolerant matches; segments always rebuild the original text", async () => {
  const H = await load();
  const rebuild = (segs) => segs.map((s) => s.text).join("");
  const text = "Plants make GLUCOSE and\noxygen using light energy.";
  const segs = H.highlightSegments(text, ["glucose and oxygen"]);
  assert.strictEqual(rebuild(segs), text);
  assert.deepStrictEqual(segs.filter((s) => s.hit).map((s) => s.text), ["GLUCOSE and\noxygen"], "case and the line break do not matter");
  assert.deepStrictEqual(H.highlightSegments(text, ["light energy"]).filter((s) => s.hit).map((s) => s.text), ["light energy"]);
});

test("highlightSegments: never invents a match; overlapping and adjacent highlights merge; special characters are literal", async () => {
  const H = await load();
  const rebuild = (segs) => segs.map((s) => s.text).join("");
  const none = H.highlightSegments("Plants need water.", ["photosynthesis occurs", "", "   ", null, undefined]);
  assert.deepStrictEqual(none, [{ text: "Plants need water.", hit: false }]);
  const over = H.highlightSegments("abc def ghi jkl", ["abc def ghi", "def ghi jkl"]);
  assert.deepStrictEqual(over.filter((s) => s.hit).map((s) => s.text), ["abc def ghi jkl"], "overlap merged");
  const adj = H.highlightSegments("abcdef", ["abc", "def"]);
  assert.deepStrictEqual(adj.filter((s) => s.hit).map((s) => s.text), ["abcdef"], "adjacent merged");
  const special = "The gas (CO2) is used; cost is $5.00 [approx].";
  assert.strictEqual(H.highlightSegments(special, ["(CO2) is used"]).filter((s) => s.hit)[0].text, "(CO2) is used");
  assert.strictEqual(H.highlightSegments(special, ["$5.00 [approx]."]).filter((s) => s.hit)[0].text, "$5.00 [approx].");
  assert.strictEqual(H.highlightSegments(special, [".*"]).filter((s) => s.hit).length, 0, "a regex-looking quote is not a regex");
  assert.deepStrictEqual(H.highlightSegments("", ["x"]), []);
  assert.deepStrictEqual(H.highlightSegments(undefined, ["x"]), []);
  for (const q of [["The"], ["the", "gas"], ["is", "is used", "used;"]]) assert.strictEqual(rebuild(H.highlightSegments(special, q)), special);
  const many = H.highlightSegments("a b a b a", ["a"]);
  assert.strictEqual(many.filter((s) => s.hit).length, 3, "every occurrence");
});

test("errorMessage: known server codes become teacher-friendly sentences; unknown ones use the server's text", async () => {
  const H = await load();
  assert.ok(/already been marked/.test(H.errorMessage("ANSWER_ALREADY_MARKED")));
  assert.ok(/released/.test(H.errorMessage("SUBMISSION_RELEASED")));
  assert.strictEqual(H.errorMessage("SOMETHING_NEW", "server says so"), "server says so");
  assert.ok(/Nothing was changed/.test(H.errorMessage(undefined, undefined)));
});
