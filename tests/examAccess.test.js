/* Trainee access list + open/close window: pure decision rules. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("examAccess.test.js");

const ea = require("../utils/examAccess");
const wall = (s) => new Date(`${s}Z`); // wall-clock digits as a "labelled UTC" instant
const base = { student_status: "active", restrict_students: 0, is_allowed: 0, available_from: null, available_until: null };
const NOW = wall("2026-10-14T10:00");

test("default: any active student may sit", () => {
  assert.strictEqual(ea.evaluateAccess(base, NOW).allowed, true);
});
test("blank status counts as active; inactive/suspended are blocked", () => {
  assert.strictEqual(ea.evaluateAccess({ ...base, student_status: "" }, NOW).allowed, true);
  assert.strictEqual(ea.evaluateAccess({ ...base, student_status: "inactive" }, NOW).code, "STUDENT_INACTIVE");
  assert.strictEqual(ea.evaluateAccess({ ...base, student_status: "suspended" }, NOW).code, "STUDENT_INACTIVE");
});
test("restricted: only listed students", () => {
  assert.strictEqual(ea.evaluateAccess({ ...base, restrict_students: 1 }, NOW).code, "NOT_ALLOWED");
  assert.strictEqual(ea.evaluateAccess({ ...base, restrict_students: 1, is_allowed: 1 }, NOW).allowed, true);
});
test("window: before open, inside, after close", () => {
  const w = { ...base, available_from: wall("2026-10-14T09:00"), available_until: wall("2026-10-14T11:00") };
  assert.strictEqual(ea.evaluateAccess(w, wall("2026-10-14T08:59")).code, "NOT_OPEN_YET");
  assert.strictEqual(ea.evaluateAccess(w, wall("2026-10-14T09:00")).allowed, true);
  assert.strictEqual(ea.evaluateAccess(w, wall("2026-10-14T11:00")).code, "CLOSED");
});
test("not-allowed is reported before the schedule (no schedule leak)", () => {
  const r = ea.evaluateAccess({ ...base, restrict_students: 1, available_from: wall("2026-10-15T09:00") }, NOW);
  assert.strictEqual(r.code, "NOT_ALLOWED");
});
test("toWallClock keeps typed digits regardless of server timezone", () => {
  assert.strictEqual(ea.toWallClock("2026-10-14T09:30").toISOString(), "2026-10-14T09:30:00.000Z");
  assert.strictEqual(ea.toWallClock(""), null);
  assert.ok(ea.fmtWall(ea.toWallClock("2026-10-14T09:05")).startsWith("14 Oct 2026, 09:05"));
});
