/* =========================================================================
   AI MARKING — Phase 7 review & approval tests (no database, no network)

   The REAL logic, service and controller run against an in-memory store
   (tests/helpers/memoryReviewStore.js) with real all-or-nothing semantics.
   Proven: the review behaves correctly GIVEN a store that honours the
   contract. NOT proven: the T-SQL in aiMarkingReview.store.js — the static
   tests at the bottom pin its key guarantees; the rest needs a real SQL
   Server (tests/README.md "Phase 7 checklist").
========================================================================= */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeReq, makeRes } = require("./helpers/mockPool");
const { createMemoryReviewStore } = require("./helpers/memoryReviewStore");
const L = require("../services/aiMarkingReview.logic");
const S = require("../services/aiMarkingReview.service");
const { makeReviewController } = require("../controllers/aiMarkingReview.controller");
const { runReviewStoreSmoke, REVIEW_CALLS } = require("../utils/aiMarkingWorkerSmoke");
const { createSqlReviewStore } = require("../services/aiMarkingReview.store");

suite("aiMarkingReview.test.js");

const T = 5;                                   // the teacher
const ctx = (over = {}) => ({ teacherId: T, role: "teacher", ...over });
async function rejects(promise, code, status) {
  try { await promise; } catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code || err.message}`);
    if (status) assert.strictEqual(err.statusCode, status);
    return err;
  }
  assert.fail(`expected ${code} but it resolved`);
}
const half = (c1, c2) => [
  { criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, marksAwarded: c1, evidence: ["glucose and oxygen"], matchedPoints: [0], explanation: "x" },
  { criterionId: "c2", label: "States the products", maxMarks: 3, marksAwarded: c2, evidence: ["glucose and oxygen"], matchedPoints: [0, 1], explanation: "y" },
];
const evOf = (over = {}) => L.presentEvaluation({
  criteriaJson: JSON.stringify({ criteria: half(2, 3), missingPoints: [] }), reviewFlags: "[]",
  schemeCriteriaJson: JSON.stringify([{ criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, expectedPoints: ["a", "b"] }, { criterionId: "c2", label: "States the products", maxMarks: 3, expectedPoints: ["glucose", "oxygen"] }]),
  suggestedTotal: 5, maxMarks: 5, ...over,
});

/* ============================== pure logic ============================== */

test("logic: accept takes a whole suggestion as it is", () => {
  const r = L.resolveApproval({ mode: "accept" }, evOf());
  assert.strictEqual(r.finalMark, 5);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.criteriaFinal.map((c) => c.final), [2, 3]);
});

test("logic: a fractional suggestion is NEVER silently rounded — accept is refused with the two nearest whole marks", () => {
  const frac = (total, max = 5) => evOf({ suggestedTotal: total, maxMarks: max, criteriaJson: JSON.stringify({ criteria: half(1.5, 2), missingPoints: [] }) });
  const e = (() => { try { L.resolveApproval({ mode: "accept" }, frac(3.5)); } catch (x) { return x; } })();
  assert.strictEqual(e.code, "NEEDS_WHOLE_MARK");
  assert.strictEqual(e.statusCode, 409);
  assert.deepStrictEqual(e.details.options, [3, 4]);
  assert.deepStrictEqual(L.wholeMarkOptions(4.5, 5), [4, 5]);
  assert.deepStrictEqual(L.wholeMarkOptions(0.5, 5), [0, 1]);
  assert.deepStrictEqual(L.wholeMarkOptions(4.5, 4), [4], "never offers a mark above the maximum");
  assert.deepStrictEqual(L.wholeMarkOptions(3, 5), [3]);
});

test("logic: accept takes no marks; adjust needs something; modes are validated", () => {
  const code = (req, ev = evOf()) => { try { L.resolveApproval(req, ev); } catch (x) { return x.code; } return null; };
  assert.strictEqual(code({ mode: "accept", finalMark: 3 }), "ACCEPT_TAKES_NO_MARKS");
  assert.strictEqual(code({ mode: "accept", criteriaMarks: {} }), "ACCEPT_TAKES_NO_MARKS");
  assert.strictEqual(code({ mode: "adjust" }), "NOTHING_TO_ADJUST");
  assert.strictEqual(code({ mode: "approve" }), "BAD_MODE");
  assert.strictEqual(code(null), "BAD_MODE");
  assert.strictEqual(code({ mode: "accept" }, { ...evOf(), suggestedTotal: null }), "NO_SUGGESTION");
});

test("logic: adjusting criteria — only the criteria given change, the total is the exact sum, and halves that add up to a whole are fine", () => {
  const a = L.resolveApproval({ mode: "adjust", criteriaMarks: { c1: 1 } }, evOf());
  assert.strictEqual(a.finalMark, 4);                         // 1 + AI's 3
  assert.strictEqual(a.changed, true);
  assert.deepStrictEqual(a.criteriaFinal.map((c) => [c.criterionId, c.ai, c.final]), [["c1", 2, 1], ["c2", 3, 3]]);
  const b = L.resolveApproval({ mode: "adjust", criteriaMarks: { c1: 1.5, c2: 2.5 } }, evOf());
  assert.strictEqual(b.finalMark, 4, "1.5 + 2.5 = 4 is a whole mark");
  const same = L.resolveApproval({ mode: "adjust", criteriaMarks: { c1: 2, c2: 3 } }, evOf());
  assert.strictEqual(same.changed, false, "adjusting to exactly what the AI said is not a change");
});

test("logic: a teacher is never capped by the AI — any whole mark from 0 to the maximum", () => {
  const low = evOf({ suggestedTotal: 2, criteriaJson: JSON.stringify({ criteria: half(1, 1), missingPoints: [] }) });
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 5 }, low).finalMark, 5);
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 0 }, evOf()).finalMark, 0);
});

test("logic: every invalid mark is refused with a specific code", () => {
  const code = (req) => { try { L.resolveApproval({ mode: "adjust", ...req }, evOf()); } catch (x) { return x.code; } return null; };
  assert.strictEqual(code({ criteriaMarks: { c1: 2.5 } }), "MARK_EXCEEDS_CRITERION");
  assert.strictEqual(code({ criteriaMarks: { c1: -1 } }), "MARK_NEGATIVE");
  assert.strictEqual(code({ criteriaMarks: { c1: 1.234 } }), "MARK_PRECISION");
  assert.strictEqual(code({ criteriaMarks: { c1: "2" } }), "BAD_MARK");
  assert.strictEqual(code({ criteriaMarks: { c1: NaN } }), "BAD_MARK");
  assert.strictEqual(code({ criteriaMarks: { zzz: 1 } }), "UNKNOWN_CRITERION");
  assert.strictEqual(code({ criteriaMarks: [1, 2] }), "BAD_CRITERIA_MARKS");
  assert.strictEqual(code({ criteriaMarks: { c1: 1.5 } }), "NOT_WHOLE", "1.5 + AI's 3 = 4.5");
  assert.strictEqual(code({ finalMark: 3.5 }), "NOT_WHOLE");
  assert.strictEqual(code({ finalMark: -1 }), "MARK_OUT_OF_RANGE");
  assert.strictEqual(code({ finalMark: 6 }), "MARK_OUT_OF_RANGE");
  assert.strictEqual(code({ finalMark: "4" }), "BAD_MARK");
  assert.strictEqual(code({ finalMark: Infinity }), "BAD_MARK");
  assert.strictEqual(code({ criteriaMarks: { c1: 1 }, finalMark: 5 }), "TOTAL_MISMATCH");
  assert.strictEqual(L.resolveApproval({ mode: "adjust", criteriaMarks: { c1: 1 }, finalMark: 4 }, evOf()).finalMark, 4);
});

test("logic: rounding is recorded as rounding, not as disagreement", () => {
  const frac = evOf({ suggestedTotal: 3.5, criteriaJson: JSON.stringify({ criteria: half(1.5, 2), missingPoints: [] }) });
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 4 }, frac).roundedFromSuggestion, true);
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 3 }, frac).roundedFromSuggestion, true);
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 1 }, frac).roundedFromSuggestion, false, "a real disagreement");
  assert.strictEqual(L.resolveApproval({ mode: "adjust", criteriaMarks: { c1: 1, c2: 3 } }, frac).roundedFromSuggestion, false, "criteria were edited");
  assert.strictEqual(L.resolveApproval({ mode: "adjust", finalMark: 4 }, evOf()).roundedFromSuggestion, false, "whole suggestion: nothing to round");
});

test("logic: text cleaning — reasons required where they must be, length limited, only strings", () => {
  assert.strictEqual(L.cleanText("  hi  ", { max: 10, field: "x" }), "hi");
  assert.strictEqual(L.cleanText("", { max: 10, field: "x" }), null);
  assert.strictEqual(L.cleanText("   ", { max: 10, field: "x" }), null);
  const bad = (v, o) => { try { L.cleanText(v, { max: 5, field: "reason", ...o }); } catch (x) { return x.code; } return null; };
  assert.strictEqual(bad("", { required: true }), "REASON_REQUIRED");
  assert.strictEqual(bad("   ", { required: true }), "REASON_REQUIRED");
  assert.strictEqual(bad("toolong"), "TEXT_TOO_LONG");
  assert.strictEqual(bad(42), "BAD_TEXT");
  assert.ok(L.REASON_REQUIRED.has("reject") && L.REASON_REQUIRED.has("flag_scheme") && L.REASON_REQUIRED.has("request_reevaluation"));
  assert.ok(!L.REASON_REQUIRED.has("mark_manually"));
});

test("logic: presentation joins the AI's marks with the scheme's labels, expected points, alternatives and the flags", () => {
  const ev = L.presentEvaluation({
    criteriaJson: JSON.stringify({ criteria: half(1.5, 2), missingPoints: ["names the stomata"] }), reviewFlags: JSON.stringify([{ code: "ambiguous_answer", source: "model" }]),
    schemeCriteriaJson: JSON.stringify([{ criterionId: "c1", label: "Defines", maxMarks: 2, expectedPoints: ["p0", "p1"], acceptableAlternatives: ["alt"] }]),
    suggestedTotal: 3.5, maxMarks: 5,
  });
  assert.strictEqual(ev.criteria.length, 2);
  assert.deepStrictEqual(ev.criteria[0].expectedPoints, ["p0", "p1"]);
  assert.deepStrictEqual(ev.criteria[0].acceptableAlternatives, ["alt"]);
  assert.strictEqual(ev.criteria[0].aiMarks, 1.5);
  assert.deepStrictEqual(ev.criteria[1].expectedPoints, [], "a criterion missing from the scheme still displays");
  assert.deepStrictEqual(ev.missingPoints, ["names the stomata"]);
  assert.strictEqual(ev.suggestedIsWhole, false);
  assert.deepStrictEqual(ev.wholeOptions, [3, 4]);
  assert.strictEqual(ev.flags[0].code, "ambiguous_answer");
  const broken = L.presentEvaluation({ criteriaJson: "not json", reviewFlags: "also not json", schemeCriteriaJson: null, suggestedTotal: 2, maxMarks: 5 });
  assert.deepStrictEqual(broken.criteria, []);
  assert.deepStrictEqual(broken.flags, []);
});

/* ============================== approval ============================== */

test("APPROVE accept: the mark becomes real, the evaluation is approved, the adjustment is logged, the submission is recomputed", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  const r = await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" });
  assert.strictEqual(r.finalMark, 5);
  assert.strictEqual(r.reviewState, "approved");
  assert.strictEqual(r.replayed, false);
  assert.strictEqual(x.answer.marks_awarded, 5);
  assert.strictEqual(x.eval.review_state, "approved");
  assert.strictEqual(Number(x.eval.teacher_final_mark), 5);
  assert.strictEqual(x.eval.teacher_approved_by, T);
  assert.ok(x.eval.teacher_approved_at > 0);
  const adj = s.adjustmentsOf(x.id);
  assert.strictEqual(adj.length, 1);
  assert.deepStrictEqual([adj[0].action, adj[0].final_mark, adj[0].actor_id, adj[0].actor_role], ["accept", 5, T, "teacher"]);
  assert.strictEqual(x.submission.score, 5);
  assert.strictEqual(x.submission.status, "marked", "the only essay is marked, so the submission is fully marked — exactly as saveMarking would do");
  assert.strictEqual(r.submission.fullyMarked, true);
});

test("APPROVE: a submission with another essay still unmarked is NOT marked complete", async () => {
  const s = createMemoryReviewStore();
  const a = s.add({ submissionId: 50, questionId: 100 });
  s.add({ submissionId: 50, questionId: 101 });                       // second essay on the same submission, unmarked
  await S.approve(s, { ...ctx(), evaluationId: a.id, mode: "accept" });
  assert.strictEqual(a.submission.score, 5);
  assert.strictEqual(a.submission.status, "submitted", "still waiting for the other essay");
});

test("APPROVE adjust: the teacher's own per-criterion marks win, and before/after are logged", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  const r = await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "adjust", criteriaMarks: { c2: 2 }, reason: "Missed the oxygen link" });
  assert.strictEqual(r.finalMark, 4);
  assert.strictEqual(r.reviewState, "adjusted");
  assert.strictEqual(x.answer.marks_awarded, 4);
  const adj = s.adjustmentsOf(x.id)[0];
  assert.strictEqual(adj.action, "adjust");
  assert.strictEqual(adj.reason, "Missed the oxygen link");
  assert.strictEqual(JSON.parse(adj.before_json).suggestedTotal, 5);
  assert.deepStrictEqual(JSON.parse(adj.after_json).criteria.map((c) => [c.criterionId, c.ai, c.final]), [["c1", 2, 2], ["c2", 3, 2]]);
  assert.strictEqual(x.eval.suggested_total, 5, "the AI's own record is never overwritten");
  assert.ok(x.eval.criteria_json.includes('"marksAwarded":3'));
});

test("APPROVE: 'adjust' that lands exactly on the AI's marks is recorded as an accept (no phantom disagreement)", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  const r = await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "adjust", finalMark: 5 });
  assert.strictEqual(r.reviewState, "approved");
  assert.strictEqual(s.adjustmentsOf(x.id)[0].action, "accept");
});

test("APPROVE D1: an AI total of 3.5 cannot be accepted; the teacher picks 3 or 4 and it is logged as rounding", async () => {
  const s = createMemoryReviewStore();
  const x = s.add({ suggestedTotal: 3.5, criteria: half(1.5, 2) });
  const err = await rejects(S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" }), "NEEDS_WHOLE_MARK", 409);
  assert.deepStrictEqual(err.details.options, [3, 4]);
  assert.strictEqual(x.answer.marks_awarded, null, "nothing was written");
  assert.strictEqual(x.eval.review_state, "awaiting_review");
  const r = await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "adjust", finalMark: 4 });
  assert.strictEqual(r.roundedFromSuggestion, true);
  assert.strictEqual(JSON.parse(s.adjustmentsOf(x.id)[0].after_json).roundedFromSuggestion, true);
  assert.strictEqual(x.answer.marks_awarded, 4);
});

test("APPROVE: an optional remark is saved with the mark; no remark leaves the existing one alone; over-long is refused", async () => {
  const s = createMemoryReviewStore();
  const a = s.add(), b = s.add();
  b.answer.remarks = "earlier note";
  await S.approve(s, { ...ctx(), evaluationId: a.id, mode: "accept", remark: "  Good work  " });
  await S.approve(s, { ...ctx(), evaluationId: b.id, mode: "accept" });
  assert.strictEqual(a.answer.remarks, "Good work");
  assert.strictEqual(b.answer.remarks, "earlier note");
  const c = s.add();
  await rejects(S.approve(s, { ...ctx(), evaluationId: c.id, mode: "accept", remark: "x".repeat(2001) }), "TEXT_TOO_LONG", 400);
  assert.strictEqual(c.answer.marks_awarded, null);
});

test("NOT FORCED: nothing is written until the teacher acts — an unreviewed suggestion is only a suggestion", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  await S.listQueue(s, { teacherId: T });
  await S.getDetail(s, { teacherId: T, evaluationId: x.id });
  assert.strictEqual(x.answer.marks_awarded, null);
  assert.strictEqual(x.eval.review_state, "awaiting_review");
  assert.strictEqual(s.db.adjustments.length, 0);
  assert.strictEqual(x.submission.status, "submitted");
});

test("AUTHORISATION: a teacher who is not assigned gets 'not found' for everything — detail, approve, reject, flag, re-evaluate, manual — and nothing changes", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();                                   // assigned to teacher 5 only
  const other = ctx({ teacherId: 6 });
  await rejects(S.getDetail(s, { ...other, evaluationId: x.id }), "NOT_FOUND", 404);
  await rejects(S.approve(s, { ...other, evaluationId: x.id, mode: "accept" }), "NOT_FOUND", 404);
  await rejects(S.reject(s, { ...other, evaluationId: x.id, reason: "no" }), "NOT_FOUND", 404);
  await rejects(S.markManually(s, { ...other, evaluationId: x.id }), "NOT_FOUND", 404);
  await rejects(S.flagScheme(s, { ...other, evaluationId: x.id, reason: "no" }), "NOT_FOUND", 404);
  await rejects(S.requestReevaluation(s, { ...other, evaluationId: x.id, reason: "no" }), "NOT_FOUND", 404);
  await rejects(S.approve(s, { ...ctx(), evaluationId: 9999, mode: "accept" }), "NOT_FOUND", 404);
  await rejects(S.approve(s, { ...ctx(), evaluationId: "abc", mode: "accept" }), "BAD_ID", 400);
  assert.strictEqual(x.answer.marks_awarded, null);
  assert.strictEqual(x.eval.review_state, "awaiting_review");
  assert.strictEqual(s.db.adjustments.length, 0);
  assert.deepStrictEqual((await S.listQueue(s, { teacherId: 6 })).items, [], "their queue shows none of it");
});

test("GUARDS: hand-marked, released, edited, failed, still-pending and already-rejected answers are all refused — and nothing is written", async () => {
  const s = createMemoryReviewStore();
  const marked = s.add({ marksAwarded: 3 });
  const released = s.add({ submissionStatus: "released" });
  const edited = s.add(); edited.answer.essay_answer = "<p>edited after the AI marked it</p>";
  const failed = s.add({ status: "failed" });
  const pending = s.add({ status: "pending" });
  const rejected = s.add({ reviewState: "rejected" });
  const superseded = s.add({ reviewState: "superseded" });
  const go = (x) => S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" });
  await rejects(go(marked), "ANSWER_ALREADY_MARKED", 409);
  await rejects(go(released), "SUBMISSION_RELEASED", 409);
  await rejects(go(edited), "ANSWER_CHANGED", 409);
  await rejects(go(failed), "NOT_REVIEWABLE", 409);
  await rejects(go(pending), "NOT_REVIEWABLE", 409);
  await rejects(go(rejected), "ALREADY_REVIEWED", 409);
  await rejects(go(superseded), "ALREADY_REVIEWED", 409);
  assert.strictEqual(marked.answer.marks_awarded, 3, "the teacher's own mark is untouched");
  for (const x of [released, edited, failed, pending, rejected, superseded]) assert.strictEqual(x.answer.marks_awarded, null);
  assert.strictEqual(s.db.adjustments.length, 0);
});

test("RACE: the teacher hand-marks the answer between the page load and the save -> refused, evaluation untouched, their mark kept", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  s.hooks.beforeClaim = async () => { x.answer.marks_awarded = 2; };
  await rejects(S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" }), "ANSWER_ALREADY_MARKED", 409);
  assert.strictEqual(x.answer.marks_awarded, 2);
  assert.strictEqual(x.eval.review_state, "awaiting_review", "the claim was rolled back");
  assert.strictEqual(x.eval.teacher_approved_by, null);
  assert.strictEqual(s.db.adjustments.length, 0);
});

test("RACE: the submission is released, or the answer is edited, between load and save -> refused and rolled back", async () => {
  const s1 = createMemoryReviewStore();
  const a = s1.add();
  s1.hooks.afterClaim = async () => { a.submission.status = "released"; };
  await rejects(S.approve(s1, { ...ctx(), evaluationId: a.id, mode: "accept" }), "SUBMISSION_RELEASED", 409);
  assert.strictEqual(a.answer.marks_awarded, null);
  assert.strictEqual(a.eval.review_state, "awaiting_review");

  const s2 = createMemoryReviewStore();
  const b = s2.add();
  s2.hooks.afterClaim = async () => { b.answer.essay_answer = "<p>changed</p>"; };
  await rejects(S.approve(s2, { ...ctx(), evaluationId: b.id, mode: "accept" }), "ANSWER_CHANGED", 409);
  assert.strictEqual(b.answer.marks_awarded, null);
  assert.strictEqual(b.eval.review_state, "awaiting_review");
  assert.strictEqual(s2.db.adjustments.length, 0);
});

test("ATOMIC: a failure after the mark is written (or after it is logged) rolls EVERYTHING back", async () => {
  for (const point of ["afterMarkWrite", "afterLog"]) {
    const s = createMemoryReviewStore();
    const x = s.add();
    s.hooks[point] = async () => { throw new Error(`boom at ${point}`); };
    await assert.rejects(S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" }), new RegExp(point));
    assert.strictEqual(x.answer.marks_awarded, null, `${point}: mark rolled back`);
    assert.strictEqual(x.eval.review_state, "awaiting_review", `${point}: evaluation rolled back`);
    assert.strictEqual(x.eval.teacher_final_mark, null);
    assert.strictEqual(s.db.adjustments.length, 0, `${point}: no log row survives`);
    assert.strictEqual(x.submission.status, "submitted");
    assert.strictEqual(x.submission.score, 0);
    // and the answer is still reviewable afterwards
    s.hooks[point] = null;
    assert.strictEqual((await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" })).finalMark, 5);
  }
});

test("IDEMPOTENT: double click / retry / five simultaneous requests apply the mark once and log it once", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  const results = await Promise.all(Array.from({ length: 5 }, () => S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" })));
  assert.strictEqual(results.filter((r) => !r.replayed).length, 1);
  assert.strictEqual(results.filter((r) => r.replayed).length, 4);
  assert.strictEqual(s.adjustmentsOf(x.id).length, 1);
  assert.strictEqual(x.answer.marks_awarded, 5);
  const later = await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" });
  assert.strictEqual(later.replayed, true);
  assert.strictEqual(s.adjustmentsOf(x.id).length, 1);
  await rejects(S.approve(s, { ...ctx(), evaluationId: x.id, mode: "adjust", finalMark: 2 }), "ALREADY_REVIEWED", 409);
  assert.strictEqual(x.answer.marks_awarded, 5, "a different decision later cannot overwrite it");
});

test("CONFLICT: accept and reject racing on the same suggestion — exactly one wins", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  const outcomes = await Promise.allSettled([
    S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" }),
    S.reject(s, { ...ctx(), evaluationId: x.id, reason: "wrong" }),
  ]);
  assert.strictEqual(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const loser = outcomes.find((o) => o.status === "rejected");
  assert.strictEqual(loser.reason.code, "ALREADY_REVIEWED");
  const wonApprove = x.eval.review_state === "approved";
  assert.strictEqual(x.answer.marks_awarded, wonApprove ? 5 : null, "a rejected suggestion never leaves a mark behind");
  assert.strictEqual(s.db.adjustments.length, 1);
});

/* ============================== decisions ============================== */

test("REJECT: needs a reason, writes no mark, closes the suggestion, is logged, and replays safely", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  await rejects(S.reject(s, { ...ctx(), evaluationId: x.id }), "REASON_REQUIRED", 400);
  await rejects(S.reject(s, { ...ctx(), evaluationId: x.id, reason: "  " }), "REASON_REQUIRED", 400);
  const r = await S.reject(s, { ...ctx(), evaluationId: x.id, reason: "Misread the diagram" });
  assert.strictEqual(r.reviewState, "rejected");
  assert.strictEqual(x.answer.marks_awarded, null);
  assert.strictEqual(s.adjustmentsOf(x.id)[0].action, "reject");
  assert.strictEqual(s.adjustmentsOf(x.id)[0].reason, "Misread the diagram");
  assert.strictEqual((await S.reject(s, { ...ctx(), evaluationId: x.id, reason: "again" })).replayed, true);
  assert.strictEqual(s.adjustmentsOf(x.id).length, 1);
  await rejects(S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" }), "ALREADY_REVIEWED", 409);
  assert.deepStrictEqual((await S.listQueue(s, { teacherId: T })).items, [], "it leaves the review queue");
});

test("MARK MANUALLY: no reason needed, closes the suggestion and tells the UI where to mark it", async () => {
  const s = createMemoryReviewStore();
  const x = s.add({ assessmentId: 9 });
  const r = await S.markManually(s, { ...ctx(), evaluationId: x.id });
  assert.strictEqual(r.reviewState, "rejected");
  assert.deepStrictEqual(r.manualMarking, { assessmentId: 9, submissionId: x.submissionId, questionId: 100, answerId: x.answerId });
  assert.strictEqual(s.adjustmentsOf(x.id)[0].action, "mark_manually");
  assert.strictEqual(x.answer.marks_awarded, null);
});

test("REQUEST RE-EVALUATION: needs a reason, supersedes the suggestion (from awaiting OR rejected), warns it is a new paid job, and is blocked once marked or released", async () => {
  const s = createMemoryReviewStore();
  const a = s.add(), b = s.add({ reviewState: "rejected" }), marked = s.add({ marksAwarded: 2 }), released = s.add({ submissionStatus: "released" }), done = s.add();
  await rejects(S.requestReevaluation(s, { ...ctx(), evaluationId: a.id }), "REASON_REQUIRED", 400);
  const r = await S.requestReevaluation(s, { ...ctx(), evaluationId: a.id, reason: "Model ignored the second paragraph" });
  assert.strictEqual(r.reviewState, "superseded");
  assert.ok(/new job/i.test(r.note) && /not refunded/i.test(r.note), "the teacher is told it costs again");
  assert.strictEqual(a.answer.marks_awarded, null);
  assert.strictEqual(s.adjustmentsOf(a.id)[0].action, "request_reevaluation");
  assert.strictEqual((await S.requestReevaluation(s, { ...ctx(), evaluationId: a.id, reason: "x" })).replayed, true);
  assert.strictEqual((await S.requestReevaluation(s, { ...ctx(), evaluationId: b.id, reason: "wrong" })).reviewState, "superseded");
  await rejects(S.requestReevaluation(s, { ...ctx(), evaluationId: marked.id, reason: "x" }), "ANSWER_ALREADY_MARKED", 409);
  await rejects(S.requestReevaluation(s, { ...ctx(), evaluationId: released.id, reason: "x" }), "SUBMISSION_RELEASED", 409);
  await S.approve(s, { ...ctx(), evaluationId: done.id, mode: "accept" });
  await rejects(S.requestReevaluation(s, { ...ctx(), evaluationId: done.id, reason: "x" }), "ALREADY_REVIEWED", 409);
  assert.strictEqual(done.answer.marks_awarded, 5, "an approved mark is not undone by a re-evaluation request");
});

test("FLAG SCHEME: needs a reason, changes nothing about the answer, is idempotent per teacher, counts distinct people, and works even after approval", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();
  await rejects(S.flagScheme(s, { ...ctx(), evaluationId: x.id }), "REASON_REQUIRED", 400);
  const r = await S.flagScheme(s, { ...ctx(), evaluationId: x.id, reason: "Criterion 2 double counts" });
  assert.strictEqual(r.reviewState, "awaiting_review", "flagging does not close the suggestion");
  assert.strictEqual((await S.flagScheme(s, { ...ctx(), evaluationId: x.id, reason: "again" })).replayed, true);
  assert.strictEqual(s.adjustmentsOf(x.id).length, 1);
  s.db.assignments.add(`6:${x.submissionId}`);
  await S.flagScheme(s, { teacherId: 6, role: "teacher", evaluationId: x.id, reason: "Agree" });
  assert.strictEqual((await S.getDetail(s, { teacherId: T, evaluationId: x.id })).scheme.flaggedByPeople, 2);
  assert.strictEqual((await S.approve(s, { ...ctx(), evaluationId: x.id, mode: "accept" })).finalMark, 5, "a flag never blocks marking");
  assert.strictEqual((await S.flagScheme(s, { teacherId: 6, role: "teacher", evaluationId: x.id, reason: "post-approval" })).replayed, true);
});

/* ============================== bulk accept ============================== */

test("BULK ACCEPT: only clean, unflagged, whole-mark suggestions the teacher selected; each is applied and logged individually; failures never stop the rest", async () => {
  const s = createMemoryReviewStore();
  const clean1 = s.add(), clean2 = s.add();
  const flagged = s.add({ flags: ["ambiguous_answer"] });
  const attention = s.add({ status: "needs_review" });
  const fractional = s.add({ suggestedTotal: 3.5, criteria: half(1.5, 2) });
  const handMarked = s.add(); handMarked.answer.marks_awarded = 1;
  const foreign = s.add({ assigned: false });
  const out = await S.bulkAccept(s, { ...ctx(), evaluationIds: [clean1.id, clean2.id, flagged.id, attention.id, fractional.id, handMarked.id, foreign.id, clean1.id] });
  assert.strictEqual(out.results.length, 7, "the duplicate id was ignored");
  assert.strictEqual(out.accepted, 2);
  const code = (x) => out.results.find((r) => r.id === x.id).code;
  assert.strictEqual(code(flagged), "NEEDS_INDIVIDUAL_REVIEW");
  assert.strictEqual(code(attention), "NEEDS_INDIVIDUAL_REVIEW");
  assert.strictEqual(code(fractional), "NEEDS_INDIVIDUAL_REVIEW");
  assert.strictEqual(code(handMarked), "ANSWER_ALREADY_MARKED", "it passed the bulk pre-check, then the guard refused it");
  assert.strictEqual(code(foreign), "NOT_FOUND", "someone else's work is not even acknowledged");
  assert.strictEqual(clean1.answer.marks_awarded, 5);
  assert.strictEqual(clean2.answer.marks_awarded, 5);
  for (const x of [flagged, attention, fractional, foreign]) assert.strictEqual(x.answer.marks_awarded, null);
  assert.strictEqual(handMarked.answer.marks_awarded, 1, "a hand-marked answer is untouched");
  const logged = [...s.adjustmentsOf(clean1.id), ...s.adjustmentsOf(clean2.id)];
  assert.ok(logged.length === 2 && logged.every((a) => a.action === "accept" && a.reason === "Bulk accept" && a.actor_id === T));
});

test("BULK ACCEPT: selection must be explicit and bounded", async () => {
  const s = createMemoryReviewStore();
  await rejects(S.bulkAccept(s, { ...ctx(), evaluationIds: [] }), "NO_SELECTION", 400);
  await rejects(S.bulkAccept(s, { ...ctx(), evaluationIds: undefined }), "NO_SELECTION", 400);
  await rejects(S.bulkAccept(s, { ...ctx(), evaluationIds: [1, "x"] }), "BAD_ID", 400);
  await rejects(S.bulkAccept(s, { ...ctx(), evaluationIds: Array.from({ length: S.MAX_BULK + 1 }, (_, i) => i + 1) }), "TOO_MANY", 400);
});

/* ============================== queue & detail ============================== */

test("QUEUE: only the teacher's own, unreviewed, unmarked, unreleased suggestions; views filter; hand-marking removes an item", async () => {
  const s = createMemoryReviewStore();
  const ok = s.add(), attn = s.add({ status: "needs_review" }), fail = s.add({ status: "failed" });
  s.add({ assigned: false });                              // someone else's
  s.add({ marksAwarded: 3 });                              // already marked
  s.add({ submissionStatus: "released" });
  s.add({ reviewState: "approved" });
  s.add({ reviewState: "rejected" });
  const ids = async (view) => (await S.listQueue(s, { teacherId: T, view })).items.map((i) => i.id);
  assert.deepStrictEqual(await ids("awaiting"), [ok.id, attn.id]);
  assert.deepStrictEqual(await ids("attention"), [attn.id]);
  assert.deepStrictEqual(await ids("failed"), [fail.id]);
  ok.answer.marks_awarded = 4;                              // teacher marks it by hand in the normal page
  assert.deepStrictEqual(await ids("awaiting"), [attn.id], "no longer a pending suggestion");
  await rejects(S.listQueue(s, { teacherId: T, view: "everything" }), "BAD_VIEW", 400);
});

test("QUEUE: bulk-acceptable only when clean; failed rows say nothing was charged; previews are plain text; paging works and the limit is clamped", async () => {
  const s = createMemoryReviewStore();
  const clean = s.add({ questionHtml: `<p>${"Explain the process of photosynthesis in detail. ".repeat(10)}</p>` });
  const flagged = s.add({ flags: ["off_topic"] });
  const frac = s.add({ suggestedTotal: 3.5, criteria: half(1.5, 2) });
  const fail = s.add({ status: "failed" });
  const q = await S.listQueue(s, { teacherId: T });
  const by = (id) => q.items.find((i) => i.id === id);
  assert.strictEqual(by(clean.id).bulkAcceptable, true);
  assert.strictEqual(by(flagged.id).bulkAcceptable, false);
  assert.strictEqual(by(frac.id).bulkAcceptable, false);
  assert.deepStrictEqual(by(flagged.id).flags, ["off_topic"]);
  assert.ok(by(clean.id).questionPreview.length <= 141 && !/<[a-z]/i.test(by(clean.id).questionPreview) && by(clean.id).questionPreview.endsWith("…"));
  const f = await S.listQueue(s, { teacherId: T, view: "failed" });
  assert.ok(/nothing was charged/i.test(f.items[0].failureNote));
  assert.strictEqual(f.items[0].id, fail.id);

  const page1 = await S.listQueue(s, { teacherId: T, limit: 2 });
  assert.strictEqual(page1.items.length, 2);
  assert.strictEqual(page1.nextCursor, page1.items[1].id);
  const page2 = await S.listQueue(s, { teacherId: T, limit: 2, afterId: page1.nextCursor });
  assert.deepStrictEqual(page2.items.map((i) => i.id), [frac.id]);
  assert.strictEqual(page2.nextCursor, null);
  assert.strictEqual((await S.listQueue(s, { teacherId: T, limit: 100000 })).items.length, 3);
  assert.strictEqual((await S.listQueue(s, { teacherId: T, limit: -5 })).items.length, 3, "nonsense limit falls back to a sane default");
});

test("DETAIL: everything the review screen needs, as PLAIN TEXT (a student's HTML can never run in the teacher's browser)", async () => {
  const s = createMemoryReviewStore();
  const x = s.add({
    essay: `<p>Plants make glucose &amp; oxygen.</p><script>alert(document.cookie)</script><img src=x onerror="alert(1)"><p>Second paragraph</p>`,
    flags: ["ambiguous_answer", "alternative_not_in_scheme"], missingPoints: ["names the chloroplast"],
  });
  x.eval.answer_content_hash = require("./helpers/memoryReviewStore").sha(x.answer.essay_answer);
  const d = await S.getDetail(s, { teacherId: T, evaluationId: x.id });
  assert.ok(!/<\s*\/?\s*(script|img|p|b)\b/i.test(d.answer.text), "no tag survives");
  assert.ok(!/<[^>]+>/.test(d.question.text) && /photosynthesis/i.test(d.question.text));
  assert.ok(d.answer.text.includes("glucose & oxygen"));
  assert.strictEqual(d.answer.hasImage, true);
  assert.ok(/image/i.test(d.answer.note));
  assert.strictEqual(d.ai.criteria.length, 2);
  assert.deepStrictEqual(d.ai.criteria[0].expectedPoints, ["light to chemical energy", "in chloroplasts"]);
  assert.deepStrictEqual(d.ai.criteria[0].acceptableAlternatives, ["makes food from sunlight"]);
  assert.deepStrictEqual(d.ai.missingPoints, ["names the chloroplast"]);
  assert.deepStrictEqual(d.ai.flags.map((f) => f.code), ["ambiguous_answer", "alternative_not_in_scheme"]);
  assert.ok(d.ai.flags.every((f) => f.text && f.text.length > 10), "flags come with plain-language text");
  assert.strictEqual(d.question.maxMarks, 5);
  assert.strictEqual(d.canApprove, true);
  assert.deepStrictEqual(d.blockers, []);
  assert.deepStrictEqual(d.manualMarking, { assessmentId: 1, submissionId: x.submissionId, questionId: 100, answerId: x.answerId });
  assert.strictEqual(d.scheme.versionNo, 1);
  assert.strictEqual(d.student.name, "Student " + x.id);
});

test("DETAIL: blockers explain WHY a suggestion can't be applied, whole-mark options appear for fractions, history is shown as 'you'", async () => {
  const s = createMemoryReviewStore();
  const marked = s.add({ marksAwarded: 2 });
  const edited = s.add(); edited.answer.essay_answer = "<p>changed</p>";
  const released = s.add({ submissionStatus: "released" });
  const frac = s.add({ suggestedTotal: 3.5, criteria: half(1.5, 2) });
  const blockers = async (x) => (await S.getDetail(s, { teacherId: T, evaluationId: x.id })).blockers;
  assert.deepStrictEqual(await blockers(marked), ["ANSWER_ALREADY_MARKED"]);
  assert.deepStrictEqual(await blockers(edited), ["ANSWER_CHANGED"]);
  assert.deepStrictEqual(await blockers(released), ["SUBMISSION_RELEASED"]);
  const d = await S.getDetail(s, { teacherId: T, evaluationId: frac.id });
  assert.strictEqual(d.ai.suggestedIsWhole, false);
  assert.deepStrictEqual(d.ai.wholeOptions, [3, 4]);
  assert.strictEqual(d.canApprove, true, "still approvable — by choosing a whole mark");

  await S.reject(s, { ...ctx(), evaluationId: frac.id, reason: "no" });
  const after = await S.getDetail(s, { teacherId: T, evaluationId: frac.id });
  assert.deepStrictEqual(after.blockers, ["ALREADY_REVIEWED"]);
  assert.deepStrictEqual(after.history.map((h) => [h.action, h.by]), [["reject", "you"]]);
});

test("DETAIL: a FAILED evaluation has no suggestion, says so, and offers no approval", async () => {
  const s = createMemoryReviewStore();
  const x = s.add({ status: "failed" });
  const d = await S.getDetail(s, { teacherId: T, evaluationId: x.id });
  assert.strictEqual(d.ai, null);
  assert.ok(/nothing was charged/i.test(d.evaluation.failureNote));
  assert.strictEqual(d.canApprove, false);
  assert.deepStrictEqual(d.blockers, ["NOT_REVIEWABLE"]);
  await rejects(S.reject(s, { ...ctx(), evaluationId: x.id, reason: "x" }), "NOT_REVIEWABLE", 409);
});

/* ============================== controller ============================== */

function api(storeFactory) {
  const c = makeReviewController({ storeFactory });
  const call = async (handler, { user = { id: T, role: "teacher" }, params = {}, body = {}, query = {} } = {}) => {
    const res = makeRes();
    await c[handler](makeReq({ pool: { tag: "pool" }, user, params, body, query }), res);
    return res;
  };
  return { c, call };
}

test("CONTROLLER: identity comes from the login, never the body — a forged teacherId is ignored", async () => {
  const s = createMemoryReviewStore();
  const x = s.add();                                                           // teacher 5's
  const { call } = api(() => s);
  const forged = await call("approve", { user: { id: 6, role: "teacher" }, params: { id: String(x.id) }, body: { mode: "accept", teacherId: 5, teacher_id: 5 } });
  assert.strictEqual(forged.statusCode, 404, "teacher 6 cannot act as 5");
  assert.strictEqual(x.answer.marks_awarded, null);
  const real = await call("approve", { params: { id: String(x.id) }, body: { mode: "accept", teacherId: 99 } });
  assert.strictEqual(real.statusCode, 200);
  assert.strictEqual(s.adjustmentsOf(x.id)[0].actor_id, T, "the log records the authenticated teacher");
  const anon = await call("getQueue", { user: null });
  assert.strictEqual(anon.statusCode, 401);
  const noId = await call("getQueue", { user: { role: "teacher" } });
  assert.strictEqual(noId.statusCode, 401);
});

test("CONTROLLER: status codes and bodies — 200 success, 400 bad input, 404 unknown, 409 conflicts with details", async () => {
  const s = createMemoryReviewStore();
  const ok = s.add(), frac = s.add({ suggestedTotal: 3.5, criteria: half(1.5, 2) });
  const { call } = api(() => s);
  const a = await call("approve", { params: { id: String(ok.id) }, body: { mode: "accept" } });
  assert.deepStrictEqual([a.statusCode, a.body.success, a.body.finalMark, a.body.reviewState], [200, true, 5, "approved"]);
  const f = await call("approve", { params: { id: String(frac.id) }, body: { mode: "accept" } });
  assert.deepStrictEqual([f.statusCode, f.body.code, f.body.details.options], [409, "NEEDS_WHOLE_MARK", [3, 4]]);
  assert.strictEqual((await call("approve", { params: { id: String(frac.id) }, body: { mode: "nope" } })).statusCode, 400);
  assert.strictEqual((await call("approve", { params: { id: "abc" }, body: { mode: "accept" } })).statusCode, 400);
  assert.strictEqual((await call("approve", { params: { id: "99999" }, body: { mode: "accept" } })).statusCode, 404);
  assert.strictEqual((await call("approve", { params: { id: String(frac.id) }, body: undefined })).statusCode, 400, "no body at all is a 400, not a crash");
  assert.strictEqual((await call("reject", { params: { id: String(frac.id) }, body: {} })).body.code, "REASON_REQUIRED");
  const q = await call("getQueue", { query: { view: "awaiting", limit: "1" } });
  assert.deepStrictEqual([q.statusCode, q.body.items.length], [200, 1]);
  assert.strictEqual((await call("getQueue", { query: { view: "zzz" } })).statusCode, 400);
  const d = await call("getDetail", { params: { id: String(frac.id) } });
  assert.strictEqual(d.body.review.ai.suggestedTotal, 3.5);
  const b = await call("bulkAccept", { body: { evaluationIds: [frac.id] } });
  assert.deepStrictEqual([b.statusCode, b.body.accepted, b.body.results[0].code], [200, 0, "NEEDS_INDIVIDUAL_REVIEW"]);
  for (const h of ["markManually", "flagScheme", "requestReevaluation"]) {
    const r = await call(h, { params: { id: String(frac.id) }, body: { reason: "because" } });
    assert.strictEqual(r.statusCode, 200, h);
  }
});

test("CONTROLLER: internal errors never leak SQL or content — generic message, nothing else", async () => {
  const boom = { getForReview: async () => { throw new Error("SELECT * FROM e_assessment_answers failed: secret column x"); } };
  const { call } = api(() => boom);
  const origError = console.error; console.error = () => {};
  try {
    const r = await call("getDetail", { params: { id: "1" } });
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!/SELECT|secret|e_assessment/.test(JSON.stringify(r.body)));
    assert.ok(r.body.message);
  } finally { console.error = origError; }
});

test("ROUTES: every review route is registered, fixed paths come before '/:id', and all sit behind protect + authorize", () => {
  const router = require("../routes/aiMarkingTeacher");
  const stack = router.stack;
  const firstRoute = stack.findIndex((l) => l.route);
  assert.ok(firstRoute >= 2, "protect and authorize are mounted before any route");
  const paths = stack.filter((l) => l.route && l.route.path.startsWith("/review")).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  assert.deepStrictEqual(paths, [
    "GET /review/queue", "POST /review/bulk-accept", "GET /review/:id", "POST /review/:id/approve", "POST /review/:id/reject",
    "POST /review/:id/mark-manually", "POST /review/:id/flag-scheme", "POST /review/:id/request-reevaluation",
  ]);
});

/* ============================== SQL pinned statically ============================== */

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const STORE = read("services/aiMarkingReview.store.js");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const tagged = (name) => STORE.split(`/*review:${name}`)[1].split("`")[0];

test("STATIC: the mark is written only under all four guards, inside the same statement", () => {
  const w = tagged("write-mark");
  assert.ok(/marks_awarded IS NULL/.test(w), "still unmarked");
  assert.ok(/s\.status <> 'released'/.test(w), "not released");
  assert.ok(/\$\{HASH_OF_ANSWER\} = @hash/.test(w), "same content the AI saw");
  assert.ok(/\$\{ASSIGNED\("a\.submission_id"\)\}/.test(w), "this teacher's submission");
  assert.ok(/ISNULL\(@remark, a\.remarks\)/.test(w), "no remark = keep the existing one");
  assert.ok(!/highlights|highlighted_html/.test(w), "never touches the highlight data");
  const claim = tagged("approve-claim");
  assert.ok(/review_state = 'awaiting_review' AND status IN \('success','needs_review'\)/.test(claim));
});

test("STATIC: every state change is compare-and-set; adjustments are INSERT-only; the evaluation's AI output is never edited", () => {
  const noComments = STORE.replace(/\/\*[\s\S]*?\*\//g, (m) => (/\/\*review:/.test(m) ? m : ""));
  assert.ok(!/UPDATE\s+ai_marking_adjustments|DELETE\s+FROM/i.test(noComments));
  assert.ok(/INSERT INTO ai_marking_adjustments/.test(noComments));
  const evalUpdates = noComments.split(/UPDATE\s+ai_marking_evaluations/i).slice(1).map((u) => u.split("`")[0]);
  assert.strictEqual(evalUpdates.length, 2, "exactly two kinds of evaluation update");
  for (const u of evalUpdates) assert.ok(/review_state\s*(=\s*'awaiting_review'|IN\s*\$\{from\})/.test(u), `unguarded: ${u.slice(0, 80)}`);
  // the decision update's allowed-from list is built from a variable; pin what it can contain
  assert.ok(STORE.includes(`const from = action === "request_reevaluation" ? "('awaiting_review','rejected')" : "('awaiting_review')";`), "decisions can only start from awaiting_review (re-evaluation also from rejected)");
  for (const u of evalUpdates) assert.ok(!/criteria_json|suggested_total|review_flags|token_usage_json|processing_cost|status\s*=/.test(u.split("WHERE")[0]), "the AI's output and the billing record are never edited");
});

test("STATIC: review can never move money, touch jobs, or release anything", () => {
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/institution_wallets|wallet_ledger|ai_marking_wallets|ai_marking_ledger|ai_marking_jobs|ai_marking_pricing|\bMarks\b|released_at/.test(code));
  assert.ok(!/status\s*=\s*'released'/.test(code), "never sets a submission released");
  const subUpdates = code.match(/UPDATE\s+e_assessment_submissions/gi) || [];
  assert.strictEqual(subUpdates.length, 2, "only the two saveMarking-equivalent recompute updates");
  assert.ok(!/Date\.now|new Date\(|console\./.test(code), "database clock only, no logging");
});

test("STATIC: the submission recompute is IDENTICAL to saveMarking's (so release behaves the same) — fails if saveMarking changes", () => {
  const save = norm(read("controllers/eAssessment.controller.js"));
  const st = require("../services/aiMarkingReview.store");
  for (const [name, sqlText] of Object.entries({ MCQ_SAFETY_NET_SQL: st.MCQ_SAFETY_NET_SQL, TOTAL_SQL: st.TOTAL_SQL, UNMARKED_ESSAYS_SQL: st.UNMARKED_ESSAYS_SQL, FULLY_MARKED_UPDATE_SQL: st.FULLY_MARKED_UPDATE_SQL, PARTIAL_UPDATE_SQL: st.PARTIAL_UPDATE_SQL })) {
    assert.ok(save.includes(norm(sqlText)), `${name} has drifted from saveMarking in eAssessment.controller.js — review both`);
  }
});

test("STATIC: eligibility lets a superseded evaluation go, but not a merely rejected one", () => {
  const elig = read("services/aiMarkingEligibility.service.js");
  const hasLive = elig.split("AS has_live_eval")[0].split("CASE WHEN EXISTS").slice(-1)[0];
  assert.ok(/ev\.review_state <> 'superseded'/.test(hasLive));
  assert.ok(!/rejected/.test(hasLive), "rejected still blocks (D8): re-buying needs the explicit request");
  assert.ok(/review_state <> ''superseded''/.test(read("utils/aiMarkingSchema.js")), "and the database's live-answer index agrees");
});

test("STATIC: no review file logs student or answer content", () => {
  for (const f of ["services/aiMarkingReview.service.js", "services/aiMarkingReview.logic.js", "services/aiMarkingReview.store.js"]) {
    assert.ok(!/console\./.test(read(f)), `${f} must not log`);
  }
  const ctl = read("controllers/aiMarkingReview.controller.js").split("\n").filter((l) => /console\./.test(l));
  assert.strictEqual(ctl.length, 1);
  assert.ok(!/body|answer|question|essay|req\./.test(ctl[0]), "the one log line carries only an error code and message");
});

test("SMOKE: the SQL smoke tool covers every review store method and reports a failing statement by name", async () => {
  const s = createMemoryReviewStore();
  const ok = await runReviewStoreSmoke(s);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.results.filter((r) => !r.ok)));
  const contract = Object.keys(createSqlReviewStore({ request: () => ({}) })).sort();
  const covered = new Set(REVIEW_CALLS.map(([label]) => label.replace(/ \(.*\)$/, "")));
  assert.deepStrictEqual(contract.filter((m) => !covered.has(m)), [], "every review store method is in the smoke check");
  const broken = { ...s, getForReview: async () => { throw new Error("Invalid column name 'admissionNo'."); } };
  const bad = await runReviewStoreSmoke(broken);
  assert.deepStrictEqual(bad.results.filter((r) => !r.ok).map((r) => r.label), ["getForReview"]);
});
