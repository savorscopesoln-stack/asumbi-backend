const Module = require("module");
const { suite, test, assert } = require("./helpers/tinytest");

/* reportFormSubjects only needs mssql for its admin PUT; stub it when the
   package isn't installed so this test stays dependency-free. */
try { require.resolve("mssql"); } catch (_) {
  const orig = Module._load;
  Module._load = function (request, ...rest) {
  if (request === "mssql") return { Transaction: function () {}, Request: function () {}, Int: 1, Bit: 2 };
  return orig.call(this, request, ...rest);
  };
}
const { countedSubjectsClause } = require("../utils/reportFormSubjects");

const poolWith = (rows) => ({
  request: () => ({ query: async () => ({ recordset: rows }) }),
});

suite("optionalSubjects.test.js");
test("countedSubjectsClause keeps optional subjects (they only have a Marks row if taken)", async () => {
  const pool = poolWith([
    { id: 1, name: "Maths", code: "100", isOptional: 0 },
    { id: 2, name: "French", code: "200", isOptional: 1 },
  ]);
  const clause = await countedSubjectsClause(pool, { mode: "exam" }, "m.subjectId");
  assert.strictEqual(clause, "AND m.subjectId IN (1,2)");
});

test("no clause when nothing is configured or the source is not an exam", async () => {
  assert.strictEqual(await countedSubjectsClause(poolWith([]), { mode: "exam" }), "");
  assert.strictEqual(await countedSubjectsClause(poolWith([{ id: 1, name: "M", code: "1", isOptional: 0 }]), { mode: "assessment" }), "");
});

const { summarisePercentages, isSessionOver } = require("../utils/examPercentages");

test("totals are sums of percentages; absent compulsory = 0 counted, optional not taken is left out", () => {
  // 3 compulsory (80, 60, absent→0); the optional paper wasn't sat so it isn't in the counted list
  const s = summarisePercentages([{ percentage: 80 }, { percentage: 60 }, { percentage: 0 }, { percentage: null }], null);
  assert.deepStrictEqual(s, { total: 140, possible: 300, average: 46 });
});

test("Grading System total marks overrides count x 100", () => {
  const s = summarisePercentages([{ percentage: 50 }, { percentage: 70 }], { totalMarks: 1700 });
  assert.strictEqual(s.possible, 1700);
  assert.strictEqual(s.total, 120);
});

test("a session counts as over only once ended/completed", () => {
  assert.strictEqual(isSessionOver("ended"), true);
  assert.strictEqual(isSessionOver("scheduled"), false);
});
