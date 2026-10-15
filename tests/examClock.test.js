/* Exam clock: runs from when the PAPER started, not when a student logs in. */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
suite("examClock.test.js");

const { clockStartSql, secondsLeftSql } = require("../utils/examClock");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("clock start uses the paper's started_at for a normal attempt, activated_at for resits/legacy", () => {
  const sqlText = clockStartSql("a", "es").replace(/\s+/g, " ");
  assert.ok(sqlText.includes("ISNULL(es.attempt_no, 1) <= 1"), "resits keep their own clock");
  assert.ok(sqlText.includes("a.started_at IS NOT NULL"), "legacy papers fall back");
  assert.ok(sqlText.includes("a.started_at < es.activated_at THEN a.started_at ELSE es.activated_at"));
  assert.ok(secondsLeftSql().includes("duration_minutes"));
});

test("every place that computes time left / expiry uses the shared clock", () => {
  const ctl = read("controllers/eAssessment.controller.js");
  assert.ok(!/DATEADD\(MINUTE, ISNULL\(a\.duration_minutes, 30\)(?: \+ @grace)?, es\.activated_at\)/.test(ctl),
    "no raw activated_at + duration left in the controller");
  assert.ok(!/DATEADD\(MINUTE, ISNULL\(a\.duration_minutes, 30\) \+ @grace, es\.activated_at\)/.test(read("utils/examAttempts.js")),
    "auto-submit uses the paper clock");
});

test("started_at is stamped on manual start, scheduled open and main-exam activation; late arrivals are refused", () => {
  assert.ok(read("controllers/eAssessment.controller.js").includes("started_at = GETDATE()"));
  assert.ok(read("controllers/eAssessment.controller.js").includes("PAPER_TIME_OVER"));
  assert.ok(read("utils/examAccess.js").includes("started_at = DATEADD"));
  assert.ok(read("utils/examScheduler.js").includes("started_at = DATEADD"));
  assert.ok(read("utils/ensureSchema.js").includes('"started_at"'));
});
