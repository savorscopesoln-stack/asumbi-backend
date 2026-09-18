const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const { getMyExamDashboard, getMyTimetable } = require("../controllers/mainExamStudent.controller");

suite("studentDashboard.test.js");

const sessions = [
  { session_id: 1, subject: "Mathematics", status: "ended", exam_date: "2026-11-02", start_time: "2026-11-02T09:00", end_time: "2026-11-02T11:00", venue: "Hall A", e_assessment_id: 101, main_examination_id: 10, main_examination_name: "2026 Final Exam" },
  { session_id: 2, subject: "ICT", status: "active", exam_date: "2026-11-03", start_time: "2026-11-03T09:00", end_time: "2026-11-03T12:00", venue: "Lab 1", e_assessment_id: 102, main_examination_id: 10, main_examination_name: "2026 Final Exam" },
  { session_id: 3, subject: "Engineering Science", status: "scheduled", exam_date: "2026-11-05", start_time: "2026-11-05T14:00", end_time: "2026-11-05T16:00", venue: "Hall B", e_assessment_id: 103, main_examination_id: 10, main_examination_name: "2026 Final Exam" },
  { session_id: 4, subject: "Communication", status: "ended", exam_date: "2026-11-01", start_time: "2026-11-01T09:00", end_time: "2026-11-01T11:00", venue: "Hall A", e_assessment_id: 104, main_examination_id: 10, main_examination_name: "2026 Final Exam" },
];

function baseResponses() {
  return [
    ["FROM Students WHERE id = @id", () => [{ id: 5, name: "Jane", studentClass: "2A", yearOfStudy: 2 }]],
    ["FROM exam_subject_sessions", () => sessions],
    ["FROM e_assessment_submissions", () => [{ e_assessment_id: 101, status: "marked" }]],
    // Mathematics(101): ended+marked -> completed
    // ICT(102): active, no submission -> active, [ENTER EXAM]
    // Engineering Science(103): scheduled, no submission -> upcoming
    // Communication(104): ended, no submission -> absent
  ];
}

test("dashboard: an ended+marked subject shows as completed, not still 'ended'", async () => {
  const { pool } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 5 } }), res);
  const math = res.body.completed.find((s) => s.subject === "Mathematics");
  assert.ok(math, "Mathematics appears in completed");
  assert.strictEqual(math.status, "completed");
});

test("dashboard: exactly one ACTIVE subject surfaces for [ENTER EXAM]", async () => {
  const { pool } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 5 } }), res);
  assert.strictEqual(res.body.active.length, 1);
  assert.strictEqual(res.body.active[0].subject, "ICT");
  assert.ok(res.body.active[0].e_assessment_id, "entry needs the assessment id to route to");
});

test("dashboard: a still-scheduled subject is 'upcoming', never exposed as enterable early (§39)", async () => {
  const { pool } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 5 } }), res);
  assert.strictEqual(res.body.upcoming.length, 1);
  assert.strictEqual(res.body.upcoming[0].subject, "Engineering Science");
  assert.ok(!res.body.active.some((s) => s.subject === "Engineering Science"));
});

test("dashboard: an ended subject with no submission is 'absent', not silently dropped", async () => {
  const { pool } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 5 } }), res);
  const comm = res.body.completed.find((s) => s.subject === "Communication");
  assert.ok(comm);
  assert.strictEqual(comm.status, "absent");
});

test("dashboard: exactly 3 queries regardless of subject count (§58 — no N+1)", async () => {
  const { pool, log } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 5 } }), res);
  assert.strictEqual(res.statusCode, 200);
  // 1 student lookup + 1 sessions join + 1 batched submissions lookup —
  // never one query per subject.
  assert.strictEqual(log.length, 3, `expected 3 queries, saw ${log.length}`);
});

test("timetable: scoped to one Main Examination, includes derived status per subject", async () => {
  const { pool } = makeMockPool(baseResponses());
  const res = makeRes();
  await getMyTimetable(makeReq({ pool, user: { id: 5 }, params: { mainExamId: "10" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.timetable.length, 4);
  assert.strictEqual(res.body.examination.name, "2026 Final Exam");
});

test("student not found returns 404, not a crash", async () => {
  const { pool } = makeMockPool([
    ["FROM Students WHERE id = @id", () => []],
  ]);
  const res = makeRes();
  await getMyExamDashboard(makeReq({ pool, user: { id: 999 } }), res);
  assert.strictEqual(res.statusCode, 404);
});
