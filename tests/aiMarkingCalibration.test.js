/* =========================================================================
   AI MARKING — PHASE 9 TESTS: calibration (agreement of AI suggestions with teachers' final marks)

   Real logic, real service and real controller, over an in-memory store that
   honours the SQL store's contract (tests/helpers/memoryCalibrationStore.js).
   NOT proven here: that the T-SQL in aiMarkingCalibration.store.js runs or
   returns the right rows, real SQL Server behaviour, or how the screen looks.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const L = require("../services/aiMarkingCalibration.logic");
const { makeCalibrationService, CalibrationError } = require("../services/aiMarkingCalibration.service");
const { makeCalibrationController } = require("../controllers/aiMarkingCalibration.controller");
const { createMemoryCalibrationStore } = require("./helpers/memoryCalibrationStore");

suite("aiMarkingCalibration.test.js");

let id = 0;
/** A decided evaluation. d = AI mark - teacher mark. */
const ev = (over = {}) => ({ evaluation_id: ++id, scheme_version_id: 10, version_no: 1, question_id: 1, max_marks: 10, suggested_total: 6, teacher_final_mark: 6, review_state: "approved", ...over });
const many = (n, over) => Array.from({ length: n }, () => ev(over));
const S = (rows) => L.summarise(rows.map(L.normaliseRow).filter(Boolean));
async function rejects(p) { try { await p; } catch (e) { return e; } return null; }

/* ------------------------------------------------------------------ logic */

test("tolerance is max(0.5 mark, 10% of the question), and a mark exactly on it still agrees", () => {
  assert.strictEqual(L.toleranceFor(5), 0.5);
  assert.strictEqual(L.toleranceFor(10), 1);
  assert.strictEqual(L.toleranceFor(20), 2);
  const s = S([ev({ suggested_total: 7, teacher_final_mark: 6 }), ev({ suggested_total: 7.5, teacher_final_mark: 6 })]);
  assert.strictEqual(s.withinTolerance, 1);                 // diff 1 (on the line) agrees, diff 1.5 does not
});

test("a rejection is a disagreement and counts in the denominator", () => {
  const s = S([...many(8), ev({ review_state: "rejected", suggested_total: null, teacher_final_mark: null }), ev({ review_state: "rejected", suggested_total: null, teacher_final_mark: null })]);
  assert.strictEqual(s.reviewed, 10);
  assert.strictEqual(s.rejected, 2);
  assert.strictEqual(s.agreementRate, 0.8);
  assert.strictEqual(s.biasPct, 0);                          // bias uses approved rows only
});

test("bias sign: positive means the AI was more generous than the teacher", () => {
  const generous = S(many(12, { suggested_total: 8, teacher_final_mark: 6 }));
  assert.strictEqual(generous.biasPct, 20);
  assert.strictEqual(generous.aiHigher, 12);
  const strict = S(many(12, { suggested_total: 4, teacher_final_mark: 6 }));
  assert.strictEqual(strict.biasPct, -20);
  assert.strictEqual(strict.aiLower, 12);
  assert.strictEqual(strict.meanAbsErrorPct, 20);
});

test("unchanged vs changed by the teacher", () => {
  const s = S([...many(6), ...many(4, { suggested_total: 6, teacher_final_mark: 7 })]);
  assert.strictEqual(s.unchanged, 6);
  assert.strictEqual(s.changedByTeacher, 4);
});

test("fewer than MIN_SAMPLE decisions never produces a verdict, however good they look", () => {
  const s = S(many(L.MIN_SAMPLE - 1));
  assert.strictEqual(s.agreementRate, 1);
  assert.strictEqual(s.verdict, "not_enough_data");
  assert.ok(s.reasons[0].includes(String(L.MIN_SAMPLE)));
});

test("verdicts: agrees / mixed / disagrees", () => {
  assert.strictEqual(S(many(40)).verdict, "agrees");                                    // 40/40
  assert.strictEqual(S(many(10)).verdict, "mixed");                                     // 10/10 is real but the interval is still wide
  assert.strictEqual(S([...many(9), ...many(1, { suggested_total: 9 })]).verdict, "mixed");
  assert.strictEqual(S([...many(2), ...many(18, { suggested_total: 9, teacher_final_mark: 3 })]).verdict, "disagrees");
});

test("a high agreement rate with a large generous bias is not 'agrees'", () => {
  // every mark within tolerance (diff 1 of 10 = 10%), but always the same direction -> bias 10%, above the 5% allowance
  const s = S(many(40, { suggested_total: 7, teacher_final_mark: 6 }));
  assert.strictEqual(s.agreementRate, 1);
  assert.notStrictEqual(s.verdict, "agrees");
  assert.ok(s.reasons.some((r) => /generous/.test(r)));
});

test("large bias alone, with enough approvals, is 'disagrees' with a plain reason", () => {
  const s = S(many(15, { suggested_total: 9, teacher_final_mark: 7, max_marks: 10 }).concat(many(15, { suggested_total: 8, teacher_final_mark: 7 })));
  assert.ok(Math.abs(s.biasPct) > 10);
  assert.strictEqual(s.verdict, "disagrees");
  assert.ok(s.reasons.some((r) => /more generous/.test(r)));
});

test("Wilson interval: widens with small n, brackets the rate, null for n=0", () => {
  assert.strictEqual(L.wilson(0, 0), null);
  const small = L.wilson(5, 5), big = L.wilson(50, 50);
  assert.ok(small.low < big.low);
  const w = L.wilson(30, 40);
  assert.ok(w.low < 0.75 && w.high > 0.75);
  assert.ok(L.wilson(0, 10).low === 0 && L.wilson(10, 10).high === 1);
});

test("rows that are not decisions or are malformed are ignored, never counted or thrown on", () => {
  const bad = [
    ev({ review_state: "awaiting_review" }), ev({ review_state: "superseded" }), ev({ review_state: "approved", suggested_total: null }),
    ev({ suggested_total: 11 }), ev({ teacher_final_mark: -1 }), ev({ max_marks: 0 }), ev({ scheme_version_id: "x" }), null, 7,
  ];
  assert.strictEqual(bad.map(L.normaliseRow).filter(Boolean).length, 0);
  const rep = L.questionReport([...many(3), ev({ suggested_total: 99 })], { question_id: 1, approved_version_id: 10 });
  assert.strictEqual(rep.skippedRows, 1);                  // a decided row with impossible marks is reported, not hidden
  assert.strictEqual(rep.current.reviewed, 3);
});

test("rubber-stamp caution appears only when nearly every approval equals the AI's and there are enough of them", () => {
  assert.ok(S(many(30)).notes.some((n) => n.code === "NEARLY_ALL_UNCHANGED"));
  assert.ok(!S(many(10)).notes.some((n) => n.code === "NEARLY_ALL_UNCHANGED"));
  assert.ok(!S([...many(20), ...many(10, { suggested_total: 6, teacher_final_mark: 7 })]).notes.some((n) => n.code === "NEARLY_ALL_UNCHANGED"));
});

test("many rejections get their own note", () => {
  const rej = (n) => many(n, { review_state: "rejected", suggested_total: null, teacher_final_mark: null });
  assert.ok(S([...many(7), ...rej(5)]).notes.some((n) => n.code === "MANY_REJECTED"));
  assert.ok(!S([...many(11), ...rej(1)]).notes.some((n) => n.code === "MANY_REJECTED"));
});

test("questionReport: versions are separate, newest first; the headline is the APPROVED version only", () => {
  const rows = [...many(30, { scheme_version_id: 10, version_no: 1, suggested_total: 9, teacher_final_mark: 3 }), ...many(3, { scheme_version_id: 11, version_no: 2 })];
  const rep = L.questionReport(rows, { question_id: 1, approved_version_id: 11, approved_version_no: 2 });
  assert.deepStrictEqual(rep.versions.map((v) => v.versionNo), [2, 1]);
  assert.strictEqual(rep.versions[1].verdict, "disagrees");  // the old version's bad record is kept ...
  assert.strictEqual(rep.current.versionId, 11);
  assert.strictEqual(rep.verdict, "not_enough_data");        // ... but does not colour today's scheme
});

test("questionReport: a question with decisions only on superseded versions has no current stats", () => {
  const rep = L.questionReport(many(20, { scheme_version_id: 10 }), { question_id: 1, approved_version_id: 12 });
  assert.strictEqual(rep.current, null);
  assert.strictEqual(rep.verdict, "not_enough_data");
  assert.strictEqual(L.questionReport([], { question_id: 1 }).versions.length, 0);
});

test("a different question size is compared in proportion (tolerance and bias scale with the marks)", () => {
  const s = S(many(12, { max_marks: 20, suggested_total: 15, teacher_final_mark: 14 }));   // 1 mark of 20 = within 2-mark tolerance, 5% bias
  assert.strictEqual(s.agreementRate, 1);
  assert.strictEqual(s.biasPct, 5);
});

/* ---------------------------------------------------------------- service */

function world() {
  const store = createMemoryCalibrationStore();
  store.addQuestion({ question_id: 1, assessment_id: 100, marks: 10, approved_version_id: 10, approved_version_no: 1, question_text: "Describe osmosis. ".repeat(20) });
  store.addQuestion({ question_id: 2, assessment_id: 100, marks: 10, approved_version_id: null });
  store.addQuestion({ question_id: 3, assessment_id: 200, marks: 10, approved_version_id: 30 });   // another assessment
  store.addSetter(100, 7);
  store.assign(100, 8);
  for (let i = 0; i < 12; i++) store.addEval({ question_id: 1, scheme_version_id: 10, max_marks: 10, suggested_total: 6, teacher_final_mark: 6 });
  store.addEval({ question_id: 1, scheme_version_id: 10, review_state: "awaiting_review", max_marks: 10, suggested_total: 1, teacher_final_mark: null });
  store.addEval({ question_id: 3, scheme_version_id: 30, suggested_total: 1, teacher_final_mark: 9, max_marks: 10 });
  return { store, svc: makeCalibrationService({ store }) };
}

test("service: assessment report lists every essay question, only this assessment's evaluations, and states its rules and caveats", async () => {
  const { svc } = world();
  const r = await svc.assessmentReport({ teacherId: 7, assessmentId: 100 });
  assert.deepStrictEqual(r.questions.map((q) => q.questionId), [1, 2]);
  assert.strictEqual(r.questions[0].current.reviewed, 12);   // the awaiting-review row and the other assessment's row are not counted
  assert.strictEqual(r.questions[1].verdict, "not_enough_data");
  assert.ok(r.questions[0].questionText.length <= 140);
  assert.strictEqual(r.rules.minSample, L.MIN_SAMPLE);
  assert.ok(r.caveats.length >= 2);
  assert.strictEqual(r.overall.reviewed, 12);
  assert.strictEqual(r.questionVerdicts.not_enough_data >= 1, true);
});

test("service: setters and assigned markers may read; strangers get 'not found' (never an empty report)", async () => {
  const { svc } = world();
  assert.ok((await svc.assessmentReport({ teacherId: 8, assessmentId: 100 })).questions.length);
  const e = await rejects(svc.assessmentReport({ teacherId: 99, assessmentId: 100 }));
  assert.ok(e instanceof CalibrationError && e.statusCode === 404);
  const e2 = await rejects(svc.questionReport({ teacherId: 99, assessmentId: 100, questionId: 1 }));
  assert.strictEqual(e2.statusCode, 404);
});

test("service: a question id from another assessment cannot be read through this one", async () => {
  const { svc } = world();
  const e = await rejects(svc.questionReport({ teacherId: 7, assessmentId: 100, questionId: 3 }));
  assert.strictEqual(e.statusCode, 404);
});

test("service: bad ids are a 400", async () => {
  const { svc } = world();
  for (const bad of [undefined, "abc", 0, -1, 1.5]) {
    assert.strictEqual((await rejects(svc.assessmentReport({ teacherId: 7, assessmentId: bad }))).statusCode, 400);
  }
  assert.strictEqual((await rejects(svc.questionReport({ teacherId: 7, assessmentId: 100, questionId: "x" }))).statusCode, 400);
});

test("service: question report carries every version and no student fields", async () => {
  const { svc, store } = world();
  store.addEval({ question_id: 1, scheme_version_id: 9, version_no: 0, max_marks: 10, suggested_total: 6, teacher_final_mark: 6 });
  const r = await svc.questionReport({ teacherId: 7, assessmentId: 100, questionId: 1 });
  assert.strictEqual(r.question.versions.length, 2);
  const text = JSON.stringify(r);
  for (const banned of ["student", "submission", "essay_answer", "answer_id"]) assert.ok(!text.toLowerCase().includes(banned), `leaks ${banned}`);
});

test("service: a truncated store result is flagged to the teacher", async () => {
  const { store } = world();
  const orig = store.getAgreementRows;
  store.getAgreementRows = async (a) => ({ ...(await orig(a)), truncated: true });
  const r = await makeCalibrationService({ store }).assessmentReport({ teacherId: 7, assessmentId: 100 });
  assert.strictEqual(r.truncated, true);
});

/* ------------------------------------------------------------- controller */

function fakeRes() { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; }

test("controller: teacher id comes from the login only, never the query or body", async () => {
  const { store } = world();
  const c = makeCalibrationController({ storeFactory: () => store });
  const res = fakeRes();
  await c.assessmentReport({ user: { id: 99 }, query: { assessmentId: "100", teacherId: "7" }, body: { teacherId: 7 }, pool: {} }, res);
  assert.strictEqual(res.statusCode, 404);
  assert.ok(store.db.calls.every((call) => call[1] === 99));
});

test("controller: 200 shape, 401 without a user, 400 on bad id, 500 is generic and leaks nothing", async () => {
  const { store } = world();
  const c = makeCalibrationController({ storeFactory: () => store });
  let res = fakeRes();
  await c.assessmentReport({ user: { id: 7 }, query: { assessmentId: "100" }, pool: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  res = fakeRes();
  await c.assessmentReport({ user: {}, query: { assessmentId: "100" }, pool: {} }, res);
  assert.strictEqual(res.statusCode, 401);
  res = fakeRes();
  await c.questionReport({ user: { id: 7 }, query: { assessmentId: "100" }, pool: {} }, res);
  assert.strictEqual(res.statusCode, 400);

  const boom = makeCalibrationController({ storeFactory: () => ({ listQuestions: async () => { throw new Error("SELECT secret FROM students"); }, getAgreementRows: async () => ({ rows: [] }) }) });
  const origErr = console.error; console.error = () => {};
  res = fakeRes();
  try { await boom.assessmentReport({ user: { id: 7 }, query: { assessmentId: "100" }, pool: {} }, res); } finally { console.error = origErr; }
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!JSON.stringify(res.body).includes("secret"));
});

/* ---- Phase 10 regression: the state Phase 7 really writes when a teacher moves the mark ---- */

test("REGRESSION: review_state 'adjusted' (what Phase 7 writes when the mark moved) is counted as a changed approval, not dropped", () => {
  const rows = [
    ...many(6, { review_state: "approved" }),                                          // kept as is
    ...many(4, { review_state: "adjusted", suggested_total: 6, teacher_final_mark: 3 }), // teacher lowered it by 3
  ];
  const s = S(rows);
  assert.strictEqual(s.reviewed, 10, "adjusted rows must be reviewed rows");
  assert.strictEqual(s.unchanged, 6);
  assert.strictEqual(s.changedByTeacher, 4);
  assert.strictEqual(s.withinTolerance, 6, "a 3-mark move on a 10-mark question is outside tolerance");
  assert.strictEqual(s.agreementRate, 0.6);
  assert.ok(s.biasPct > 0, "AI was more generous in the adjusted rows");
});

/* -------------------------------------------------- SQL text (not behaviour) */

test("SQL store: read-only, no student columns selected, access rule and decided-only filter present", () => {
  const src = fs.readFileSync(path.join(__dirname, "../services/aiMarkingCalibration.store.js"), "utf8");
  const sqlOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXEC)\b/i.test(sqlOnly), "calibration SQL must be read-only");
  assert.ok(/ACCESS_SQL/.test(sqlOnly), "authorisation rule missing");
  assert.ok(/review_state IN \('approved', 'adjusted', 'rejected'\)/.test(sqlOnly));
  assert.ok(/status IN \('success', 'needs_review'\)/.test(sqlOnly));
  const selects = sqlOnly.match(/SELECT[\s\S]*?FROM/g).join(" ");
  for (const col of ["answer_id", "submission_id", "student", "essay_answer", "answer_content_hash"]) assert.ok(!selects.includes(col), `selects ${col}`);
});

test("routes: calibration is mounted on fixed paths behind the teacher guard", () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/aiMarkingTeacher.js"), "utf8");
  assert.ok(src.includes('router.get("/scheme/calibration", cal.assessmentReport)'));
  assert.ok(src.includes('router.get("/scheme/calibration/question", cal.questionReport)'));
  assert.ok(src.indexOf("router.use(protect, authorize(\"teacher\"))") < src.indexOf("/scheme/calibration"));
});
