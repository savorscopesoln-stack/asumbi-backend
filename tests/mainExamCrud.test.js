const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const {
  createMainExamination,
  archiveMainExamination,
  deleteMainExamination,
} = require("../controllers/mainExam.controller");

suite("mainExamCrud.test.js");

test("create: rejects a missing name", async () => {
  const { pool } = makeMockPool([]);
  const res = makeRes();
  await createMainExamination(makeReq({ pool, body: { name: "" } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test("create: rejects end_date before start_date", async () => {
  const { pool } = makeMockPool([]);
  const res = makeRes();
  await createMainExamination(makeReq({
    pool, body: { name: "2026 Final Exam", start_date: "2026-11-13", end_date: "2026-11-02" },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /end date/i);
});

// NOTE ON "create: happy path" (Phase 5 wallet integration):
// createMainExamination now calls fundNewExamination ->
// reserveCreditsForStudents, which opens a real `new sql.Transaction(pool)`
// (see walletLedger.service.js). makeMockPool only fakes `pool.request()`,
// not the tedious-level `pool.acquire()` a real mssql.Transaction needs —
// `new sql.Transaction(mockPool).begin()` throws
// "this.parent.acquire is not a function" against this mock, regardless of
// what's in `responses` below. So a true funded-201 happy path can't be
// exercised by this suite as written; it needs either a live SQL Server
// integration run (see tests/README.md) or a mock pool extended to fake
// transaction acquire/release semantics — tracked as a known gap, not
// silently skipped. What CAN be verified here, and is the more important
// regression to guard given the bug this uncovered, is that a request
// that fails the wallet's pre-check comes back as a clean 400 with a
// WalletError code — not a crash. Before examFunding.service.js
// re-exported WalletError, `fundErr instanceof WalletError` in the
// controller's catch block threw a TypeError ("Right-hand side of
// 'instanceof' is not an object") because the destructured WalletError
// was undefined, and every unfunded creation attempt 500'd instead of
// cleanly rejecting per the spec's ACCESS RULES.
test("create: no eligible students rejects cleanly with 400, not a 500 crash", async () => {
  const { pool } = makeMockPool([
    ["INSERT INTO main_examinations", () => [{ id: 42 }]],
    ["SELECT COUNT(*) AS count FROM Students", () => [{ count: 0 }]],
    ["DELETE FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await createMainExamination(makeReq({
    pool,
    body: { name: "2026 Second Year Final Examination", start_date: "2026-11-02", end_date: "2026-11-13" },
    user: { id: 1, role: "admin" },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "NO_ELIGIBLE_STUDENTS");
});

test("create: no available credits rejects cleanly with 400 and the NO_CREDITS code", async () => {
  const { pool } = makeMockPool([
    ["INSERT INTO main_examinations", () => [{ id: 42 }]],
    ["SELECT COUNT(*) AS count FROM Students", () => [{ count: 5 }]],
    ["FROM institution_wallets", () => [{ id: 1, available_credits: 0, reserved_credits: 0, total_purchased: 0, total_allocated: 0 }]],
    ["DELETE FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await createMainExamination(makeReq({
    pool,
    body: { name: "2026 Second Year Final Examination", start_date: "2026-11-02", end_date: "2026-11-13" },
    user: { id: 1, role: "admin" },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "NO_CREDITS");
});

test("archive: 404 for an id that doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["SELECT id, status FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await archiveMainExamination(makeReq({ pool, params: { id: "999" } }), res);
  assert.strictEqual(res.statusCode, 404);
});

test("archive: succeeds for an existing exam", async () => {
  const { pool } = makeMockPool([
    ["SELECT id, status FROM main_examinations WHERE id = @id", () => [{ id: 42, status: "published" }]],
    ["UPDATE main_examinations SET status = 'archived'", () => [{ id: 42 }]],
    // Phase 5: a 'published' (never-ongoing) exam being archived
    // implicitly releases any reserved entitlements — see
    // cancelExaminationFunding's SELECT of reserved student_ids.
    ["SELECT student_id FROM student_exam_entitlements", () => []],
  ]);
  const res = makeRes();
  await archiveMainExamination(makeReq({ pool, params: { id: "42" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.funding.released, 0);
});

test("archive: a 'completed' exam's consumed credits are left untouched (no implicit release)", async () => {
  const { pool } = makeMockPool([
    ["SELECT id, status FROM main_examinations WHERE id = @id", () => [{ id: 42, status: "completed" }]],
    ["UPDATE main_examinations SET status = 'archived'", () => [{ id: 42 }]],
  ]);
  const res = makeRes();
  await archiveMainExamination(makeReq({ pool, params: { id: "42" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.funding, null);
});

test("delete: blocked (409) once the exam has scheduled subjects (§41 FK safety)", async () => {
  const { pool } = makeMockPool([
    ["SELECT COUNT(*) AS cnt FROM exam_subject_sessions", () => [{ cnt: 3 }]],
  ]);
  const res = makeRes();
  await deleteMainExamination(makeReq({ pool, params: { id: "42" } }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /archive/i);
});

test("delete: allowed when the exam has zero subjects", async () => {
  const { pool } = makeMockPool([
    ["SELECT COUNT(*) AS cnt FROM exam_subject_sessions", () => [{ cnt: 0 }]],
    ["DELETE FROM main_examinations", () => [{ id: 42 }]],
  ]);
  const res = makeRes();
  await deleteMainExamination(makeReq({ pool, params: { id: "42" } }), res);
  assert.strictEqual(res.statusCode, 200);
});
