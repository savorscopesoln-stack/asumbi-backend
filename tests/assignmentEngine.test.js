/* Question-level allocation (more teachers than submissions) + undo history. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("assignmentEngine.test.js");
const eng = require("../utils/assignmentEngine");
const ctrl = require("../controllers/eAssessment.controller");

function mkPool(handlers) {
  const log = [];
  return { log, request() {
    const inputs = {};
    const r = { input(n, t, v) { inputs[n] = v === undefined ? t : v; return r; },
      async query(q) {
        const text = q.replace(/\s+/g, " ").trim();
        log.push({ q: text, inputs: { ...inputs } });
        for (const [re, fn] of handlers) if (re.test(text)) return fn(inputs, text);
        return { recordset: [] };
      } };
    return r;
  } };
}
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const answers = (n, perQ = 4) => Array.from({ length: n }, (_, i) => ({ answer_id: 100 + i, question_id: Math.floor(i / perQ) + 1, submission_id: (i % perQ) + 1, e_assessment_id: 9 }));

test("mode: more teachers than submissions -> split by questions; otherwise by submissions", () => {
  assert.strictEqual(eng.chooseMode(5, 3), "question");
  assert.strictEqual(eng.chooseMode(3, 3), "submission");
  assert.strictEqual(eng.chooseMode(2, 10), "submission");
});

test("plan: every answered question goes to exactly one teacher and counts differ by at most 1", () => {
  const items = answers(23);
  const plan = eng.planAllocation(items, [11, 12, 13, 14, 15]);
  assert.strictEqual(plan.length, 23);
  assert.strictEqual(new Set(plan.map((p) => p.answer_id)).size, 23, "no answer allocated twice");
  const counts = {}; plan.forEach((p) => { counts[p.teacher_id] = (counts[p.teacher_id] || 0) + 1; });
  const vals = Object.values(counts);
  assert.ok(Math.max(...vals) - Math.min(...vals) <= 1, JSON.stringify(counts));
  assert.deepStrictEqual(Object.keys(counts).length, 5, "every teacher gets work");
});

test("plan: blocks are consecutive by question, so a teacher mostly marks the same question for many students", () => {
  const plan = eng.planAllocation(answers(12, 6), [1, 2]); // 2 questions x 6 students
  const byAnswer = Object.fromEntries(plan.map((p) => [p.answer_id, p.teacher_id]));
  const q1 = answers(12, 6).filter((a) => a.question_id === 1).map((a) => byAnswer[a.answer_id]);
  const q2 = answers(12, 6).filter((a) => a.question_id === 2).map((a) => byAnswer[a.answer_id]);
  assert.ok(q1.every((t) => t === 1) && q2.every((t) => t === 2));
});

test("plan: fewer answers than teachers -> first teachers get one each; empty input -> nothing", () => {
  const plan = eng.planAllocation(answers(2), [7, 8, 9]);
  assert.deepStrictEqual(plan.map((p) => p.teacher_id), [7, 8]);
  assert.deepStrictEqual(eng.planAllocation([], [1]), []);
  assert.deepStrictEqual(eng.planAllocation(answers(3), []), []);
});

test("smart distribute: 4 teachers, 2 submissions -> question mode, rows inserted, history recorded, teachers notified", async () => {
  const pool = mkPool([
    [/FROM e_assessment_answers a INNER JOIN e_assessment_submissions s/, () => ({ recordset: answers(10) })],
    [/INSERT INTO e_assessment_assignment_batches/, () => ({ recordset: [{ id: 77 }] })],
  ]);
  const res = mkRes();
  await ctrl.smartDistribute({ pool, user: { id: 1 }, body: { submission_ids: [1, 2], teacher_ids: [11, 12, 13, 14] } }, res);
  assert.strictEqual(res.body.mode, "question"); assert.strictEqual(res.body.allocated, 10); assert.strictEqual(res.body.batch_id, 77);
  assert.deepStrictEqual(Object.values(res.body.per_teacher).sort(), [2, 2, 3, 3]);
  const ins = pool.log.filter((l) => /INSERT INTO e_assessment_answer_assignments/.test(l.q));
  assert.strictEqual(ins.length, 1);
  const load = pool.log.find((l) => /FROM e_assessment_answers a/.test(l.q)).q;
  assert.ok(/ax\.id IS NULL/.test(load) && /marks_awarded IS NULL/.test(load) && /'essay', 'descriptive'/.test(load), "only unallocated, unmarked, essay answers");
  assert.ok(/LEN\(LTRIM\(RTRIM/.test(load), "only ANSWERED questions are counted");
  assert.ok(pool.log.some((l) => /INSERT INTO e_assessment_assignment_changes/.test(l.q)), "changes saved for undo");
});

test("smart distribute: more submissions than teachers -> original whole-submission split", async () => {
  const pool = mkPool([[/INSERT INTO e_assessment_assignment_batches/, () => ({ recordset: [{ id: 5 }] })]]);
  const res = mkRes();
  await ctrl.smartDistribute({ pool, user: { id: 1 }, body: { submission_ids: [1, 2, 3, 4], teacher_ids: [11, 12] } }, res);
  assert.strictEqual(res.body.mode, "submission");
  const ins = pool.log.filter((l) => /INSERT INTO e_assessment_submission_assignments/.test(l.q));
  assert.deepStrictEqual(ins.map((l) => l.inputs.t), [11, 12, 11, 12]);
  assert.ok(!pool.log.some((l) => /answer_assignments/.test(l.q)));
});

test("smart distribute: nothing answered to allocate -> clear message, no batch; bad input rejected", async () => {
  const res = mkRes();
  await ctrl.smartDistribute({ pool: mkPool([[/FROM e_assessment_answers a/, () => ({ recordset: [] })]]), body: { submission_ids: [1], teacher_ids: [1, 2] } }, res);
  assert.strictEqual(res.body.allocated, 0); assert.strictEqual(res.body.batch_id, null);
  const bad = mkRes(); await ctrl.smartDistribute({ pool: mkPool([]), body: { submission_ids: [], teacher_ids: [1] } }, bad);
  assert.strictEqual(bad.code, 400);
  const junk = mkPool([]); await ctrl.smartDistribute({ pool: junk, body: { submission_ids: ["1); DROP TABLE x;--"], teacher_ids: [1] } }, mkRes());
  assert.ok(!junk.log.some((l) => /DROP/.test(l.q)), "non-numeric ids never reach SQL");
});

test("undo (question allocation): takes answers back, never ones already marked, counts them", async () => {
  const pool = mkPool([
    [/FROM e_assessment_assignment_batches WHERE id/, () => ({ recordset: [{ id: 7, kind: "question", undone_at: null }] })],
    [/FROM e_assessment_assignment_changes WHERE batch_id/, () => ({ recordset: [
      ...[1, 2, 3, 4].map((i) => ({ kind: "ans", target_id: i, new_teacher_id: 11, prev_teacher_id: null })) ] })],
    [/DELETE ax OUTPUT deleted\.answer_id/, () => ({ recordset: [{ answer_id: 1 }, { answer_id: 2 }, { answer_id: 3 }] })], // 3 removed
    [/SELECT COUNT\(\*\) AS n FROM e_assessment_answer_assignments/, () => ({ recordset: [{ n: 1 }] })], // 1 already marked
  ]);
  const res = mkRes();
  await ctrl.undoAssignmentBatch({ pool, params: { id: "7" }, user: { id: 1 } }, res);
  assert.strictEqual(res.body.restored, 3); assert.strictEqual(res.body.kept_marked, 1); assert.strictEqual(res.body.changed_since, 0);
  const del = pool.log.find((l) => /DELETE ax/.test(l.q));
  assert.ok(/a\.marks_awarded IS NULL/.test(del.q) && /ax\.teacher_id = @t/.test(del.q), "only unmarked ones, only if still with that teacher");
  assert.ok(pool.log.some((l) => /SET undone_at = GETDATE\(\)/.test(l.q)), "batch marked as undone");
});

test("undo (whole submissions): restores the previous teacher or unassigns; skips changed-since and already-marked", async () => {
  const cur = { 1: { teacher_id: 11, status: "submitted" }, 2: { teacher_id: 11, status: "submitted" }, 3: { teacher_id: 99, status: "submitted" }, 4: { teacher_id: 11, status: "marked" } };
  const pool = mkPool([
    [/FROM e_assessment_assignment_batches WHERE id/, () => ({ recordset: [{ id: 8, undone_at: null }] })],
    [/FROM e_assessment_assignment_changes WHERE batch_id/, () => ({ recordset: [
      { kind: "sub", target_id: 1, prev_teacher_id: 5, new_teacher_id: 11 },
      { kind: "sub", target_id: 2, prev_teacher_id: null, new_teacher_id: 11 },
      { kind: "sub", target_id: 3, prev_teacher_id: null, new_teacher_id: 11 },
      { kind: "sub", target_id: 4, prev_teacher_id: null, new_teacher_id: 11 } ] })],
    [/FROM e_assessment_submission_assignments aa INNER JOIN/, (i) => ({ recordset: [cur[i.s]] })],
  ]);
  const res = mkRes();
  await ctrl.undoAssignmentBatch({ pool, params: { id: "8" }, user: { id: 1 } }, res);
  assert.deepStrictEqual([res.body.restored, res.body.changed_since, res.body.kept_marked], [2, 1, 1]);
  assert.ok(pool.log.some((l) => /UPDATE e_assessment_submission_assignments SET teacher_id/.test(l.q) && l.inputs.t === 5), "back to the previous teacher");
  assert.ok(pool.log.some((l) => /DELETE FROM e_assessment_submission_assignments WHERE submission_id/.test(l.q) && l.inputs.s === 2), "unassigned when there was none before");
});

test("undo (teacher/subject/class): added rows are removed, removed rows are put back", async () => {
  const pool = mkPool([
    [/FROM e_assessment_assignment_batches WHERE id/, () => ({ recordset: [{ id: 9, undone_at: null }] })],
    [/FROM e_assessment_assignment_changes WHERE batch_id/, () => ({ recordset: [
      { kind: "ts_added", target_id: 50 }, { kind: "ts_added", target_id: 51 },
      { kind: "ts_removed", teacher_id: 3, subject_id: 4, class_id: 5 } ] })],
    [/DELETE FROM TeacherSubjects OUTPUT deleted\.id/, () => ({ recordset: [{ id: 50 }] })], // 51 was already gone
    [/INSERT INTO TeacherSubjects \(teacher_id, subject_id, class_id\) OUTPUT inserted\.id/, () => ({ recordset: [{ id: 80 }] })],
  ]);
  const res = mkRes();
  await ctrl.undoAssignmentBatch({ pool, params: { id: "9" }, user: { id: 1 } }, res);
  assert.deepStrictEqual([res.body.restored, res.body.changed_since], [2, 1]);
  const ins = pool.log.find((l) => /INSERT INTO TeacherSubjects/.test(l.q)).q;
  assert.ok(/WHERE NOT EXISTS/.test(ins) && /INNER JOIN Teachers/.test(ins), "re-insert is idempotent and checks the rows still exist");
});

test("undo: unknown action -> 404, already undone -> 400, bad id -> 400", async () => {
  let res = mkRes(); await ctrl.undoAssignmentBatch({ pool: mkPool([]), params: { id: "1" }, user: { id: 1 } }, res); assert.strictEqual(res.code, 404);
  res = mkRes(); await ctrl.undoAssignmentBatch({ pool: mkPool([[/FROM e_assessment_assignment_batches WHERE id/, () => ({ recordset: [{ id: 1, undone_at: "2026-10-13" }] })]]), params: { id: "1" }, user: { id: 1 } }, res);
  assert.strictEqual(res.code, 400); assert.ok(/already been undone/.test(res.body.message));
  res = mkRes(); await ctrl.undoAssignmentBatch({ pool: mkPool([]), params: { id: "x" }, user: { id: 1 } }, res); assert.strictEqual(res.code, 400);
});

test("teacher visibility: a teacher's marking queries include question-level allocations; admin queries are unfiltered", async () => {
  const run = async (role) => {
    const pool = mkPool([[/SELECT s\.\* FROM e_assessment_submissions s/, () => ({ recordset: [{ id: 1, student_id: 2 }] })]]);
    await ctrl.getAllSubmissionsForMarking({ pool, params: { id: "9" }, user: { id: 5, role } }, mkRes());
    return pool.log.map((l) => l.q).join("\n");
  };
  const t = await run("teacher"), a = await run("admin");
  assert.ok(/e_assessment_answer_assignments ax0/.test(t), "teacher sees submissions where answers were allocated to them");
  assert.ok(/ax\.teacher_id = @teacherId/.test(t) && /LEFT JOIN e_assessment_answer_assignments ax ON ax\.answer_id = a\.id/.test(t), "and only the answers allocated to them");
  assert.ok(!/answer_assignments/.test(a), "admin view is untouched");
});

test("finishing a split submission: only ANSWERED essays can hold it open (blank ones count as 0)", async () => {
  const pool = mkPool([
    [/SELECT DISTINCT submission_id FROM e_assessment_answers/, () => ({ recordset: [{ submission_id: 9 }] })],
    [/SELECT ISNULL\(SUM\(marks_awarded\), 0\) AS total/, () => ({ recordset: [{ total: 4 }] })],
    [/SELECT COUNT\(\*\) AS cnt/, () => ({ recordset: [{ cnt: 0 }] })],
  ]);
  await ctrl.saveMarking({ pool, body: { scores: { 11: 4 } } }, mkRes());
  const q = pool.log.find((l) => /SELECT COUNT\(\*\) AS cnt/.test(l.q));
  assert.ok(q && /marks_awarded IS NULL/.test(q.q) && /LEN\(LTRIM\(RTRIM\(CAST\(ISNULL\(a\.essay_answer/.test(q.q), "the unmarked-essay check ignores blank answers");
});
