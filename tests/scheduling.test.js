const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const {
  addSubjectSession,
  publishTimetable,
} = require("../controllers/examSubjectSession.controller");

suite("scheduling.test.js");

const mainExam = { id: 10, start_date: "2026-11-02", end_date: "2026-11-13" };

// A "no conflicts" baseline response set every happy-path test starts from.
function noConflictResponses(extra = []) {
  return [
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["LOWER(LTRIM(RTRIM(subject))) = LOWER(@subject)", () => []], // no duplicate
    ["start_time < @endTime AND end_time > @startTime", () => []], // no overlap
    ["INSERT INTO exam_subject_sessions", () => [{ id: 501 }]],
    ...extra,
  ];
}

test("add subject: happy path returns 201", async () => {
  const { pool } = makeMockPool(noConflictResponses());
  const res = makeRes();
  await addSubjectSession(makeReq({
    pool,
    params: { mainExamId: "10" },
    body: {
      subject: "Mathematics", exam_date: "2026-11-02",
      start_time: "2026-11-02T09:00:00", end_time: "2026-11-02T11:00:00",
    },
  }), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.id, 501);
});

test("add subject: rejects end time before start time", async () => {
  const { pool } = makeMockPool(noConflictResponses());
  const res = makeRes();
  await addSubjectSession(makeReq({
    pool,
    params: { mainExamId: "10" },
    body: { subject: "Mathematics", start_time: "2026-11-02T11:00:00", end_time: "2026-11-02T09:00:00" },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /after start time/i);
});

test("add subject: rejects exam date outside the Main Examination's range", async () => {
  const { pool } = makeMockPool(noConflictResponses());
  const res = makeRes();
  await addSubjectSession(makeReq({
    pool,
    params: { mainExamId: "10" },
    body: {
      subject: "Mathematics", exam_date: "2026-12-25",
      start_time: "2026-12-25T09:00:00", end_time: "2026-12-25T11:00:00",
    },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /end date/i);
});

test("add subject: rejects a duplicate subject in the same exam", async () => {
  const { pool } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["LOWER(LTRIM(RTRIM(subject))) = LOWER(@subject)", () => [{ id: 77 }]], // duplicate found
    ["start_time < @endTime AND end_time > @startTime", () => []],
  ]);
  const res = makeRes();
  await addSubjectSession(makeReq({
    pool,
    params: { mainExamId: "10" },
    body: {
      subject: "Mathematics", exam_date: "2026-11-02",
      start_time: "2026-11-02T09:00:00", end_time: "2026-11-02T11:00:00",
    },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /already scheduled/i);
});

test("add subject: rejects an overlapping time slot", async () => {
  const { pool } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["LOWER(LTRIM(RTRIM(subject))) = LOWER(@subject)", () => []],
    ["start_time < @endTime AND end_time > @startTime", () => [{ id: 88, subject: "ICT" }]],
  ]);
  const res = makeRes();
  await addSubjectSession(makeReq({
    pool,
    params: { mainExamId: "10" },
    body: {
      subject: "Mathematics", exam_date: "2026-11-02",
      start_time: "2026-11-02T09:30:00", end_time: "2026-11-02T10:30:00",
      class_id: 3,
    },
  }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /Overlaps with "ICT"/);
});

test("add subject: 404 for a Main Examination that doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await addSubjectSession(makeReq({ pool, params: { mainExamId: "999" }, body: { subject: "Mathematics" } }), res);
  assert.strictEqual(res.statusCode, 404);
});

test("publish timetable: refuses when a subject has no assessment attached", async () => {
  const { pool } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["FROM exam_subject_sessions ess", () => [
      { id: 1, subject: "Mathematics", start_time: "2026-11-02T09:00", end_time: "2026-11-02T11:00", e_assessment_id: null, assessment_status: null, assessment_title: null },
    ]],
  ]);
  const res = makeRes();
  await publishTimetable(makeReq({ pool, params: { mainExamId: "10" } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /no assessment attached/i.test(e)));
});

test("publish timetable: refuses when an attached assessment isn't approved", async () => {
  const { pool } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["FROM exam_subject_sessions ess", () => [
      { id: 1, subject: "Mathematics", start_time: "2026-11-02T09:00", end_time: "2026-11-02T11:00", e_assessment_id: 55, assessment_status: "pending", assessment_title: "Math Final" },
    ]],
  ]);
  const res = makeRes();
  await publishTimetable(makeReq({ pool, params: { mainExamId: "10" } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body.errors.some((e) => /not yet approved/i.test(e)));
});

test("publish timetable: succeeds once every subject is scheduled + approved", async () => {
  const { pool, log } = makeMockPool([
    ["SELECT * FROM main_examinations WHERE id = @id", () => [mainExam]],
    ["FROM exam_subject_sessions ess", () => [
      { id: 1, subject: "Mathematics", start_time: "2026-11-02T09:00", end_time: "2026-11-02T11:00", e_assessment_id: 55, assessment_status: "approved", assessment_title: "Math Final" },
    ]],
    ["UPDATE exam_subject_sessions SET status = 'scheduled'", () => []],
    ["UPDATE main_examinations SET status = 'published'", () => []],
  ]);
  const res = makeRes();
  await publishTimetable(makeReq({ pool, params: { mainExamId: "10" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(log.some((l) => l.sql.includes("status = 'published'")));
});
