/* =========================================================================
   WALLET CONTROLLER — non-transactional guard-path tests.

   Same scope note as walletLedger.test.js: removeStudentAllocation calls
   releaseEntitlement, which opens a real `new sql.Transaction(pool)` —
   not fakeable by tests/helpers/mockPool.js today (see that file's own
   header). So this file only covers the guard clauses that run BEFORE
   the transactional call: invalid input and "examination not found".
   The actual release-a-reserved-credit behavior is verified by static
   review of walletLedger.service.js's releaseEntitlement (same
   UPDLOCK/HOLDLOCK + idempotency-key pattern already proven by
   reserveCreditsForStudents/consumeEntitlementsForExam) and is flagged,
   not silently assumed, as needing a live-SQL-Server pass.
========================================================================= */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const { removeStudentAllocation, previewEligibleStudents, getAllocatedStudents } = require("../controllers/wallet.controller");

suite("walletController.test.js");

test("removeStudentAllocation: 400 for a non-numeric student id", async () => {
  const { pool } = makeMockPool([]);
  const res = makeRes();
  await removeStudentAllocation(makeReq({
    pool, params: { mainExamId: "42", studentId: "not-a-number" },
  }), res);
  assert.strictEqual(res.statusCode, 400);
});

test("removeStudentAllocation: 404 when the examination doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await removeStudentAllocation(makeReq({
    pool, params: { mainExamId: "999", studentId: "7" },
  }), res);
  assert.strictEqual(res.statusCode, 404);
});

test("previewEligibleStudents: returns students filtered by cohort year, no exam id needed", async () => {
  const { pool } = makeMockPool([
    ["FROM Students s", () => [
      { id: 1, name: "Amina Otieno", admissionNo: "A001", studentClass: "2B", yearOfStudy: 2 },
      { id: 2, name: "Brian Kiptoo", admissionNo: "A002", studentClass: "2B", yearOfStudy: 2 },
    ]],
    ["FROM institution_wallets", () => [{ id: 1, available_credits: 10, reserved_credits: 0, total_purchased: 10, total_allocated: 0 }]],
  ]);
  const res = makeRes();
  await previewEligibleStudents(makeReq({ pool, query: { cohortYear: "2" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.students.length, 2);
  assert.strictEqual(res.body.availableCredits, 10);
});

test("getAllocatedStudents: 404 when the examination doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await getAllocatedStudents(makeReq({ pool, params: { mainExamId: "999" } }), res);
  assert.strictEqual(res.statusCode, 404);
});

test("getAllocatedStudents: returns only reserved entitlements for an existing exam", async () => {
  const { pool } = makeMockPool([
    ["FROM main_examinations WHERE id = @id", () => [{ id: 42, name: "2026 Final", status: "published", cohort_year: 2 }]],
    ["FROM student_exam_entitlements", () => [
      { id: 3, name: "Chebet Wanjiru", admissionNo: "A003", studentClass: "2A", allocated_at: new Date() },
    ]],
  ]);
  const res = makeRes();
  await getAllocatedStudents(makeReq({ pool, params: { mainExamId: "42" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.students.length, 1);
  assert.strictEqual(res.body.students[0].name, "Chebet Wanjiru");
});
