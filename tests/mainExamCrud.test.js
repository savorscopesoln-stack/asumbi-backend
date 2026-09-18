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

test("create: happy path returns 201 + new id", async () => {
  const { pool } = makeMockPool([
    ["INSERT INTO main_examinations", () => [{ id: 42 }]],
  ]);
  const res = makeRes();
  await createMainExamination(makeReq({
    pool,
    body: { name: "2026 Second Year Final Examination", start_date: "2026-11-02", end_date: "2026-11-13" },
    user: { id: 1, role: "admin" },
  }), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.id, 42);
});

test("archive: 404 for an id that doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["UPDATE main_examinations SET status = 'archived'", () => []],
  ]);
  const res = makeRes();
  await archiveMainExamination(makeReq({ pool, params: { id: "999" } }), res);
  assert.strictEqual(res.statusCode, 404);
});

test("archive: succeeds for an existing exam", async () => {
  const { pool } = makeMockPool([
    ["UPDATE main_examinations SET status = 'archived'", () => [{ id: 42 }]],
  ]);
  const res = makeRes();
  await archiveMainExamination(makeReq({ pool, params: { id: "42" } }), res);
  assert.strictEqual(res.statusCode, 200);
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
