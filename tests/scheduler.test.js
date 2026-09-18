const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const { startExamScheduler } = require("../utils/examScheduler");

suite("scheduler.test.js");

/* startExamScheduler wires setInterval/setTimeout; tests want the inner
   tick function directly, so setTimeout is captured instead of really
   scheduled (matches the "run once shortly after boot" call it makes). */
async function runOneTick(pool, io) {
  let captured;
  const realSetInterval = global.setInterval;
  const realSetTimeout = global.setTimeout;
  global.setInterval = () => {};
  global.setTimeout = (fn) => { captured = fn; };
  try {
    startExamScheduler(() => Promise.resolve(pool), () => ["default"], io);
    await captured();
  } finally {
    global.setInterval = realSetInterval;
    global.setTimeout = realSetTimeout;
  }
}

function makeIo() {
  const events = [];
  return { events, emit(name, payload) { events.push({ name, payload }); } };
}

test("due + approved session: activates, flips active_status, notifies, audits, emits", async () => {
  const io = makeIo();
  const { pool, log } = makeMockPool([
    ["FROM exam_subject_sessions ess", () => [{
      id: 1, main_examination_id: 10, subject: "Mathematics",
      e_assessment_id: 55, assessment_status: "approved",
      assessment_title: "Math Final", class_id: 3, year_of_study: null,
    }]],
    ["AND status = 'scheduled'", () => [{ id: 1 }]],
    ["active_status = 'Active'", () => []],
    ["FROM Students st", () => [{ id: 100 }, { id: 101 }]],
    ["UPDATE exam_subject_sessions SET status = 'ended'", () => []],
  ]);

  await runOneTick(pool, io);

  assert.ok(log.some((l) => l.sql.includes("AND status = 'scheduled'")), "row-locked activation update ran");
  assert.ok(log.some((l) => l.sql.includes("active_status = 'Active'")), "assessment flipped Active");
  assert.ok(log.some((l) => l.sql.includes("INSERT INTO exam_audit_log") && l.inputs.action === "subject_session_auto_activated"), "audit logged");
  assert.ok(io.events.some((e) => e.name === "main-exam:subject-activated"), "socket emitted");
});

test("due but NOT approved: held back, no activation, no audit", async () => {
  const io = makeIo();
  const { pool, log } = makeMockPool([
    ["FROM exam_subject_sessions ess", () => [{
      id: 2, main_examination_id: 11, subject: "ICT",
      e_assessment_id: 56, assessment_status: "pending",
      assessment_title: "ICT Final", class_id: 4, year_of_study: null,
    }]],
    ["UPDATE exam_subject_sessions SET status = 'ended'", () => []],
  ]);

  await runOneTick(pool, io);

  assert.ok(!log.some((l) => l.sql.includes("AND status = 'scheduled'")), "did not attempt to activate");
  assert.ok(!log.some((l) => l.sql.includes("active_status = 'Active'")), "assessment untouched");
  assert.ok(!log.some((l) => l.inputs.action === "subject_session_auto_activated"), "no false activation audit");
});

test("active session past end_time: ends + deactivates + audits + emits, students mid-exam untouched", async () => {
  const io = makeIo();
  const { pool, log } = makeMockPool([
    ["FROM exam_subject_sessions ess", () => []], // nothing due to activate this tick
    ["UPDATE exam_subject_sessions SET status = 'ended'", () => [{
      id: 3, main_examination_id: 12, subject: "Engineering Science", e_assessment_id: 57,
    }]],
    ["active_status = 'Inactive'", () => []],
  ]);

  await runOneTick(pool, io);

  assert.ok(log.some((l) => l.sql.includes("active_status = 'Inactive'")), "assessment deactivated");
  assert.ok(log.some((l) => l.inputs.action === "subject_session_auto_ended"), "audit logged");
  assert.ok(io.events.some((e) => e.name === "main-exam:subject-ended"), "socket emitted");
  // §9 — this file never touches e_assessment_exam_sessions / submissions;
  // confirm no query in this tick references either.
  assert.ok(!log.some((l) => /e_assessment_exam_sessions|e_assessment_submissions/i.test(l.sql)),
    "never touches in-progress student attempt data");
});

test("idempotency guarantee: the activation UPDATE carries its own status='scheduled' guard", async () => {
  // This is the structural property that makes repeated ticks safe: the
  // row-lock is IN the same UPDATE that flips the status (an atomic
  // "claim it only if it's still scheduled"), never a separate
  // SELECT-then-UPDATE that a second concurrent/rapid tick could race.
  const io = makeIo();
  const { pool, log } = makeMockPool([
    ["FROM exam_subject_sessions ess", () => [{
      id: 1, main_examination_id: 10, subject: "Mathematics",
      e_assessment_id: 55, assessment_status: "approved",
      assessment_title: "Math Final", class_id: 3, year_of_study: null,
    }]],
    ["AND status = 'scheduled'", () => [{ id: 1 }]],
    ["active_status = 'Active'", () => []],
    ["FROM Students st", () => []],
    ["UPDATE exam_subject_sessions SET status = 'ended'", () => []],
  ]);
  await runOneTick(pool, io);

  const activationUpdate = log.find((l) => l.sql.includes("SET status = 'active'"));
  assert.ok(activationUpdate, "activation update ran");
  assert.match(activationUpdate.sql, /WHERE id = @id AND status = 'scheduled'/,
    "row-lock guard is part of the same UPDATE statement, not a separate check");
});
