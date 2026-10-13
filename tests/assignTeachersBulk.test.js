const { suite, test, assert } = require("./helpers/tinytest");
suite("assignTeachersBulk.test.js");
const ctrl = require("../controllers/eAssessment.controller");
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const mkPool = (inserted) => { const log = []; return { log, request() { const r = { input() { return r; }, async query(q) { log.push(q.replace(/\s+/g, " ").trim()); return /INSERT INTO TeacherSubjects/.test(q) ? { recordset: inserted } : { recordset: [] }; } }; return r; } }; };

test("bulk assign: one statement, only integer ids inlined, existing rows skipped, counts reported", async () => {
  const pool = mkPool([{ teacher_id: 1 }, { teacher_id: 1 }, { teacher_id: 2 }]);
  const res = mkRes();
  await ctrl.assignTeachersBulk({ pool, body: { teacher_ids: [1, 2, "2"], subject_ids: [5], class_ids: [7, 8] } }, res);
  const inserts = pool.log.filter((q) => /INSERT INTO TeacherSubjects/.test(q));
  assert.strictEqual(inserts.length, 1, "a single INSERT, not one per combination");
  assert.ok(/t\.id IN \(1,2\)/.test(inserts[0]) && /s\.id IN \(5\)/.test(inserts[0]) && /c\.id IN \(7,8\)/.test(inserts[0]), "ids de-duplicated and inlined");
  assert.ok(/NOT EXISTS/.test(inserts[0]), "existing assignments are skipped");
  assert.deepStrictEqual([res.body.success, res.body.created, res.body.skipped, res.body.teachers], [true, 3, 1, 2]); // 2x1x2 = 4 combos, 3 new
});

test("bulk assign: rejects empty selections and non-numeric input; user text never reaches the SQL", async () => {
  for (const body of [{}, { teacher_ids: [], subject_ids: [1], class_ids: [1] }, { teacher_ids: [1], subject_ids: [1] }]) {
    const res = mkRes(); await ctrl.assignTeachersBulk({ pool: mkPool([]), body }, res);
    assert.strictEqual(res.code, 400);
  }
  const pool = mkPool([]); const res = mkRes();
  await ctrl.assignTeachersBulk({ pool, body: { teacher_ids: ["1); DROP TABLE x;--", 3], subject_ids: [2], class_ids: [4] } }, res);
  assert.ok(!pool.log.some((q) => /DROP/.test(q)), "junk ids are dropped, never inlined");
  assert.ok(pool.log.some((q) => /t\.id IN \(3\)/.test(q)));
});

test("bulk assign: refuses an absurdly large selection", async () => {
  const big = Array.from({ length: 300 }, (_, i) => i + 1);
  const res = mkRes(); await ctrl.assignTeachersBulk({ pool: mkPool([]), body: { teacher_ids: big, subject_ids: big, class_ids: [1] } }, res);
  assert.strictEqual(res.code, 400); assert.ok(/20,000/.test(res.body.message));
});

test("bulk assign: running it again creates nothing and says so", async () => {
  const res = mkRes(); await ctrl.assignTeachersBulk({ pool: mkPool([]), body: { teacher_ids: [1], subject_ids: [1], class_ids: [1] } }, res);
  assert.deepStrictEqual([res.body.created, res.body.skipped], [0, 1]);
});
