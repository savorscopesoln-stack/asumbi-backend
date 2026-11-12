const { suite, test, assert } = require("./helpers/tinytest");
const pct = require("../utils/examPercentages");

suite("splitPaperTotals.test.js");

const G = pct.splitGroupKey({ subject: "Mathematics", allow_concurrent: 1 });

test("split papers: only the paper that was sat counts (9819 sat, 9820 not)", () => {
  const items = [
    { percentage: 0, group: G, sat: false },   // 9820 - not sat, session over => absent 0
    { percentage: 72, group: G, sat: true },   // 9819 - sat
    { percentage: 60, group: null, sat: true },
  ];
  const counted = pct.countedWithoutSplitDuplicates(items);
  assert.strictEqual(counted.length, 2);
  assert.strictEqual(counted.reduce((a, x) => a + x.percentage, 0), 132);
});

test("split papers: neither sat counts as ONE absent 0, not two", () => {
  const counted = pct.countedWithoutSplitDuplicates([
    { percentage: 0, group: G, sat: false }, { percentage: 0, group: G, sat: false },
  ]);
  assert.strictEqual(counted.length, 1);
});

test("split papers: if both were sat the higher mark is used", () => {
  const counted = pct.countedWithoutSplitDuplicates([
    { percentage: 40, group: G, sat: true }, { percentage: 55, group: G, sat: true },
  ]);
  assert.strictEqual(counted.length, 1);
  assert.strictEqual(counted[0].percentage, 55);
});

test("normal (non split) subjects are untouched", () => {
  assert.strictEqual(pct.splitGroupKey({ subject: "English", allow_concurrent: 0 }), null);
  const counted = pct.countedWithoutSplitDuplicates([
    { percentage: 50, group: null, sat: true }, { percentage: 50, group: null, sat: true },
  ]);
  assert.strictEqual(counted.length, 2);
});
