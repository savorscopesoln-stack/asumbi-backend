const { suite, test, assert } = require("./helpers/tinytest");
const { buildGeneralRemarks } = require("../utils/generalRemarks");

suite("generalRemarks.test.js");

test("names subjects below the pass mark, weakest first, with advice", () => {
  const t = buildGeneralRemarks({ passMark: 40, weak: [{ name: "Physics", score: 35 }, { name: "Maths", score: 20 }], all: [] });
  assert.ok(t.includes("Below the 40% pass mark: Maths (20%), Physics (35%)"));
  assert.ok(/extra time/.test(t));
});

test("all subjects passed: praise and point at the weakest subject", () => {
  const t = buildGeneralRemarks({ passMark: 40, weak: [], all: [{ name: "English", score: 71 }, { name: "Maths", score: 52 }] });
  assert.ok(t.includes("All subjects met the 40% pass mark"));
  assert.ok(t.includes("Maths (52%)"));
});

test("absent papers are listed as AB", () => {
  const t = buildGeneralRemarks({ passMark: 40, weak: [], absent: ["Chemistry"], all: [{ name: "English", score: 60 }] });
  assert.ok(t.includes("Absent (AB): Chemistry"));
});
