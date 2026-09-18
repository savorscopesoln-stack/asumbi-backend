const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const eAssessmentController = require("../controllers/eAssessment.controller");
const { attachAssessment } = require("../controllers/examSubjectSession.controller");

suite("regression.test.js");

/* -------------------------------------------------------------------------
   T-SQL gotcha caught only by running against a real SQL Server (see
   tests/README.md's "known gap" note): PERCENTILE_CONT is a window
   function in SQL Server specifically and REQUIRES an OVER() clause,
   unlike Postgres/Oracle/SQLite. mainExamAnalytics.controller.js used it
   without one, which parses fine as plain JS/string content (so no mock
   test caught it) but fails at the database with "must have an OVER
   clause". This is a static source-text guard, not a real SQL check —
   cheap insurance against the exact same typo recurring, not a
   replacement for actually running queries against SQL Server.
------------------------------------------------------------------------- */
test("SQL guard: every PERCENTILE_CONT call in the codebase has an OVER() clause", () => {
  const fs = require("fs");
  const path = require("path");
  const controllersDir = path.join(__dirname, "..", "controllers");
  const offenders = [];
  for (const file of fs.readdirSync(controllersDir)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(controllersDir, file), "utf8");
    const re = /PERCENTILE_CONT\s*\([^)]*\)\s*WITHIN\s+GROUP\s*\([^)]*\)/gi;
    let m;
    while ((m = re.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 20);
      if (!/^\s*OVER\s*\(/i.test(after)) offenders.push(`${file} @ char ${m.index}`);
    }
  }
  assert.deepStrictEqual(offenders, [], "PERCENTILE_CONT without OVER() found");
});

/* -------------------------------------------------------------------------
   §54 — every existing CAT/Assignment export must still be there,
   untouched in shape, after all 14 phases of Main Examination work.
   This won't catch a subtle behavioural change, but it will catch the
   easy regression: an export accidentally dropped/renamed.
------------------------------------------------------------------------- */
const EXPECTED_EXISTING_EXPORTS = [
  "createEAssessment", "submitEAssessment", "reviewAssessment",
  "toggleEAssessmentActive", "getEAssessmentQuickStats", "getPendingAssessments",
];

test("eAssessment.controller.js still exports every pre-existing CAT/Assignment function", () => {
  for (const name of EXPECTED_EXISTING_EXPORTS) {
    assert.strictEqual(typeof eAssessmentController[name], "function", `${name} should still be exported`);
  }
});

test("toggle: an assessment with NO Main Examination link still toggles normally (unchanged behaviour)", async () => {
  const { pool } = makeMockPool([
    ["SELECT active_status, class_id, year_of_study, title FROM e_assessments", () => [{ active_status: "Inactive", class_id: 3, year_of_study: null, title: "CAT 1" }]],
    ["FROM exam_subject_sessions WHERE e_assessment_id = @id AND status <> 'draft'", () => []], // not linked to anything
    ["UPDATE e_assessments SET active_status", () => []],
    ["FROM Students st", () => []],
  ]);
  const res = makeRes();
  await eAssessmentController.toggleEAssessmentActive(makeReq({ pool, params: { id: "1" } }), res);
  assert.notStrictEqual(res.statusCode, 409, "an unlinked CAT is never blocked by the Main Exam guard");
});

test("toggle: an assessment attached to a PUBLISHED Main Exam subject is blocked (409), Phase 6 guard", async () => {
  const { pool } = makeMockPool([
    ["SELECT active_status, class_id, year_of_study, title FROM e_assessments", () => [{ active_status: "Active", class_id: 3, year_of_study: null, title: "Math Final" }]],
    ["FROM exam_subject_sessions WHERE e_assessment_id = @id AND status <> 'draft'", () => [{ main_examination_id: 10, status: "active" }]],
  ]);
  const res = makeRes();
  await eAssessmentController.toggleEAssessmentActive(makeReq({ pool, params: { id: "55" } }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.main_examination_id, 10);
});

test("toggle: a DRAFT (not yet published) subject session does not block manual toggling", async () => {
  // The guard's own WHERE clause excludes status='draft' — confirmed by
  // reusing the exact matcher the guard query would produce for a draft
  // link: it should fall through to "not linked" (empty recordset) since
  // a draft-status row is excluded by the query itself, not by app logic
  // here. This test documents that expectation explicitly.
  const { pool } = makeMockPool([
    ["SELECT active_status, class_id, year_of_study, title FROM e_assessments", () => [{ active_status: "Inactive", class_id: 3, year_of_study: null, title: "Math Final" }]],
    ["FROM exam_subject_sessions WHERE e_assessment_id = @id AND status <> 'draft'", () => []], // draft row excluded by the query's own WHERE
    ["UPDATE e_assessments SET active_status", () => []],
    ["FROM Students st", () => []],
  ]);
  const res = makeRes();
  await eAssessmentController.toggleEAssessmentActive(makeReq({ pool, params: { id: "55" } }), res);
  assert.notStrictEqual(res.statusCode, 409);
});

test("attachAssessment: refuses to double-book one assessment onto two subject sessions", async () => {
  const { pool } = makeMockPool([
    ["SELECT id, status, title FROM e_assessments", () => [{ id: 55, status: "approved", title: "Math Final" }]],
    ["WHERE e_assessment_id = @eAssessmentId AND id <> @excludeId", () => [{ id: 2, main_examination_id: 9 }]],
  ]);
  const res = makeRes();
  await attachAssessment(makeReq({ pool, params: { mainExamId: "10", id: "1" }, body: { e_assessment_id: 55 } }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /already attached/i);
});

test("attachAssessment: 404 for an assessment id that doesn't exist", async () => {
  const { pool } = makeMockPool([
    ["SELECT id, status, title FROM e_assessments", () => []],
  ]);
  const res = makeRes();
  await attachAssessment(makeReq({ pool, params: { mainExamId: "10", id: "1" }, body: { e_assessment_id: 999 } }), res);
  assert.strictEqual(res.statusCode, 404);
});
