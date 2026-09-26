/* =========================================================================
   WALLET LEDGER — non-transactional path tests.

   Scope note (read this before adding more): tests/helpers/mockPool.js
   only fakes pool.request()/query() — it does not (yet) fake
   `new sql.Transaction(pool)` / `new sql.Request(transaction)`, because
   mssql's real Transaction class expects a real ConnectionPool's
   internal connection-acquisition machinery, not a plain mock object.
   That's a PRE-EXISTING gap, not one introduced here: every other
   transaction-using controller in this codebase (mainExam.controller.js
   setReportCardExam, eAssessment.controller.js's two transactions,
   syncController.js) is equally untested by this harness today.

   So this file only exercises services/walletLedger.service.js's
   non-transactional functions (getWalletSnapshot, checkAffordability)
   plus utils/creditReference.js's collision-retry logic, which are real
   code paths this harness CAN faithfully verify. The transactional
   functions (createIssuance/applyIssuance/reverseIssuance/
   reserveCreditsForStudents/releaseEntitlement/
   consumeEntitlementsForExam) are verified by static review and by
   following the exact `new sql.Transaction(pool)` /
   `new sql.Request(transaction)` pattern already proven in production by
   mainExam.controller.js's setReportCardExam — but are NOT executed
   here. Building real transaction support into mockPool.js is flagged
   as Phase 6 work that benefits this file and the pre-existing
   untested controllers alike.
========================================================================= */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const { getWalletSnapshot, checkAffordability } = require("../services/walletLedger.service");
const { generateUniqueReference } = require("../utils/creditReference");

suite("walletLedger.test.js");

test("getWalletSnapshot returns the singleton wallet row", async () => {
  const { pool } = makeMockPool([
    [
      "FROM institution_wallets",
      () => [{ id: 1, available_credits: 12, reserved_credits: 3, total_purchased: 20, total_allocated: 8, updatedAt: new Date() }],
    ],
  ]);
  const wallet = await getWalletSnapshot(pool);
  assert.strictEqual(wallet.available_credits, 12);
  assert.strictEqual(wallet.reserved_credits, 3);
});

test("checkAffordability: sufficient credits, no existing entitlements", async () => {
  const { pool } = makeMockPool([
    ["FROM institution_wallets", () => [{ available_credits: 10, reserved_credits: 0, total_purchased: 10, total_allocated: 0 }]],
    ["FROM student_exam_entitlements", () => []],
  ]);
  const result = await checkAffordability(pool, { mainExaminationId: 1, studentIds: [101, 102, 103] });
  assert.strictEqual(result.needed, 3);
  assert.strictEqual(result.available, 10);
  assert.strictEqual(result.sufficient, true);
  assert.strictEqual(result.shortfall, 0);
});

test("checkAffordability: insufficient credits reports the exact shortfall", async () => {
  const { pool } = makeMockPool([
    ["FROM institution_wallets", () => [{ available_credits: 2, reserved_credits: 0, total_purchased: 2, total_allocated: 0 }]],
    ["FROM student_exam_entitlements", () => []],
  ]);
  const result = await checkAffordability(pool, { mainExaminationId: 1, studentIds: [101, 102, 103, 104, 105] });
  assert.strictEqual(result.needed, 5);
  assert.strictEqual(result.sufficient, false);
  assert.strictEqual(result.shortfall, 3); // needs 5, has 2
});

test("checkAffordability: students already entitled don't count toward what's needed", async () => {
  const { pool } = makeMockPool([
    ["FROM institution_wallets", () => [{ available_credits: 1, reserved_credits: 2, total_purchased: 3, total_allocated: 2 }]],
    ["FROM student_exam_entitlements", () => [{ student_id: 101 }]],
  ]);
  // 101 is already entitled; only 102 is new — 1 available covers it.
  const result = await checkAffordability(pool, { mainExaminationId: 1, studentIds: [101, 102] });
  assert.strictEqual(result.alreadyEntitledCount, 1);
  assert.strictEqual(result.needed, 1);
  assert.strictEqual(result.sufficient, true);
});

test("checkAffordability: duplicate student IDs in the input are only counted once", async () => {
  const { pool } = makeMockPool([
    ["FROM institution_wallets", () => [{ available_credits: 5, reserved_credits: 0, total_purchased: 5, total_allocated: 0 }]],
    ["FROM student_exam_entitlements", () => []],
  ]);
  const result = await checkAffordability(pool, { mainExaminationId: 1, studentIds: [101, 101, 101] });
  assert.strictEqual(result.needed, 1);
});

test("generateUniqueReference returns a candidate immediately when there's no clash", async () => {
  const { pool } = makeMockPool([["FROM credit_issuances WHERE issuance_reference", () => []]]);
  const ref = await generateUniqueReference(pool, "credit_issuances", "issuance_reference", "CR");
  assert.ok(ref.startsWith("CR-"), `expected a CR- prefixed reference, got ${ref}`);
  assert.strictEqual(ref.length, 13); // "CR-" + 10 chars
});

test("generateUniqueReference retries past a collision and eventually succeeds", async () => {
  const { pool } = makeMockPool([
    ["FROM credit_issuances WHERE issuance_reference", (_inputs, callCount) => (callCount <= 2 ? [{ hit: 1 }] : [])],
  ]);
  const ref = await generateUniqueReference(pool, "credit_issuances", "issuance_reference", "CR");
  assert.ok(ref.startsWith("CR-"));
});

test("generateUniqueReference gives up after 5 straight collisions", async () => {
  const { pool } = makeMockPool([["FROM credit_issuances WHERE issuance_reference", () => [{ hit: 1 }]]]);
  await assert.rejects(
    () => generateUniqueReference(pool, "credit_issuances", "issuance_reference", "CR"),
    /Could not generate a unique CR reference/
  );
});
