const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");
const cs = require("../utils/combinedSubjects");
const analytics = require("../controllers/mainExamAnalytics.controller");
const reports = require("../controllers/mainExamReports.controller");
const codes = require("../controllers/mainExamSubjectCodes.controller");

suite("combinedSubjects.test.js");

/* ---------- pure helper ---------- */

test("buildCombineMap keeps only valid links (no self, no missing target, no chains/loops)", () => {
  const m = cs.buildCombineMap([
    { session_id: 1, report_combine_with: null },
    { session_id: 2, report_combine_with: 1 },   // ok
    { session_id: 3, report_combine_with: 3 },   // self
    { session_id: 4, report_combine_with: 99 },  // target not in list
    { session_id: 5, report_combine_with: 2 },   // target is itself combined -> chain, dropped
    { session_id: 6, report_combine_with: 7 },   // loop 6 <-> 7, both dropped
    { session_id: 7, report_combine_with: 6 },
  ]);
  assert.deepStrictEqual([...m.entries()], [[2, 1]]);
});

test("combined mark = marks of both papers over both totals", () => {
  const c = cs.combineParts([
    { score: 60, total_marks: 100 }, { score: 40, total_marks: 50 },
  ]);
  assert.strictEqual(c.percentage, 66); // 100/150 = 66.67 -> floored like every percentage
  assert.strictEqual(c.score, 100);
  assert.strictEqual(c.total_marks, 150);
  assert.strictEqual(c.sat, true);
});

test("combined: if one part is 0 (absent or scored 0) the OTHER part is used on its own", () => {
  const c = cs.combineParts([{ score: 80, total_marks: 100 }, { score: null, total_marks: 50, absent: true }]);
  assert.strictEqual(c.percentage, 80); // not 80/150 = 53
  assert.strictEqual(c.total_marks, 100);
  const zero = cs.combineParts([{ score: 0, total_marks: 100 }, { score: 40, total_marks: 50 }]);
  assert.strictEqual(zero.percentage, 80); // 40/50
  assert.strictEqual(zero.sat, true);
  const bothZero = cs.combineParts([{ score: 0, total_marks: 100 }, { score: 0, total_marks: 50 }]);
  assert.strictEqual(bothZero.percentage, 0);
  assert.strictEqual(bothZero.absent, false); // both were sat, just scored 0
  const none = cs.combineParts([{ score: null, total_marks: 100, absent: true }, { score: null, total_marks: 50, absent: true }]);
  assert.strictEqual(none.percentage, 0);
  assert.strictEqual(none.absent, true);
});

test("combined: a pending compulsory part (exam not over) means not counted yet", () => {
  const c = cs.combineParts([{ score: 80, total_marks: 100 }, { score: null, total_marks: 50 }]);
  assert.strictEqual(c.percentage, null);
  assert.strictEqual(c.sat, false);
});

test("combined: optional part not sat is left out; not-registered parts are ignored", () => {
  const opt = cs.combineParts([{ score: 70, total_marks: 100 }, { score: null, total_marks: 50, optional: true }]);
  assert.strictEqual(opt.percentage, 70);
  assert.strictEqual(opt.total_marks, 100);
  const reg = cs.combineParts([{ score: 45, total_marks: 50 }, { not_registered: true, total_marks: 100 }]);
  assert.strictEqual(reg.percentage, 90);
  const neither = cs.combineParts([{ not_registered: true, total_marks: 50 }, { not_registered: true, total_marks: 100 }]);
  assert.strictEqual(neither.not_registered, true);
});

test("foldCells puts the combined subject where the main subject is and leaves others untouched", () => {
  const cells = [
    { session_id: 1, score: 50, total_marks: 100 },
    { session_id: 2, score: 30, total_marks: 100 },
    { session_id: 3, score: 20, total_marks: 100 },
  ];
  const out = cs.foldCells(cells, new Map([[1, 3]])); // 1 is merged into 3
  assert.deepStrictEqual(out.map((c) => c.session_id), [2, 3]); // sits where the MAIN subject (3) sits
  assert.strictEqual(out[1].combined, true);
  assert.strictEqual(out[1].percentage, 35); // 70/200
  assert.strictEqual(out[0], cells[1]);
  assert.strictEqual(cs.foldCells(cells, new Map()), cells);
});

test("validateCombineChanges rejects self, unknown, no-paper, and chains", () => {
  const existing = [
    { session_id: 1, subject: "English", report_combine_with: null, has_paper: true },
    { session_id: 2, subject: "Literature", report_combine_with: 1, has_paper: true },
    { session_id: 3, subject: "Maths", report_combine_with: null, has_paper: true },
    { session_id: 4, subject: "Art", report_combine_with: null, has_paper: false },
  ];
  assert.strictEqual(cs.validateCombineChanges(existing, new Map([[3, null]])), null);
  assert.ok(cs.validateCombineChanges(existing, new Map([[3, 3]])));
  assert.ok(cs.validateCombineChanges(existing, new Map([[3, 77]])));
  assert.ok(cs.validateCombineChanges(existing, new Map([[3, 4]])));           // Art has no paper
  assert.ok(cs.validateCombineChanges(existing, new Map([[3, 2]])));           // into a subject that is itself combined
  assert.ok(cs.validateCombineChanges(existing, new Map([[1, 3]])));           // English already has Literature in it
});

/* ---------- Nominal Roll: the combined subject drives total and mean ---------- */

const SUBJECTS = [
  { session_id: 10, subject: "English", session_status: "ended", start_time: "2026-11-01T08:00:00Z", e_assessment_id: 100, report_code: null, report_key: null, report_combine_with: null, allow_concurrent: 0, paper_label: null, total_marks: 100, class_name: "F1", year_of_study: 1 },
  { session_id: 11, subject: "Literature", session_status: "ended", start_time: "2026-11-02T08:00:00Z", e_assessment_id: 101, report_code: null, report_key: null, report_combine_with: 10, allow_concurrent: 0, paper_label: null, total_marks: 50, class_name: "F1", year_of_study: 1 },
  { session_id: 12, subject: "Maths", session_status: "ended", start_time: "2026-11-03T08:00:00Z", e_assessment_id: 102, report_code: null, report_key: null, report_combine_with: null, allow_concurrent: 0, paper_label: null, total_marks: 100, class_name: "F1", year_of_study: 1 },
];
const CANDIDATES = [
  { student_id: 1, name: "Amina", admissionNo: "A1", gender: "F", studentClass: "F1", yearOfStudy: 1 },
  { student_id: 2, name: "Brian", admissionNo: "A2", gender: "M", studentClass: "F1", yearOfStudy: 1 },
  { student_id: 3, name: "Chao", admissionNo: "A3", gender: "M", studentClass: "F1", yearOfStudy: 1 },
];
// Amina: Eng 60/100, Lit 40/50, Maths 90.  Brian: Eng 80, Lit absent, Maths 50.  Chao: sat nothing.
const SUBMISSIONS = [
  { student_id: 1, e_assessment_id: 100, score: 60 }, { student_id: 1, e_assessment_id: 101, score: 40 }, { student_id: 1, e_assessment_id: 102, score: 90 },
  { student_id: 2, e_assessment_id: 100, score: 80 }, { student_id: 2, e_assessment_id: 102, score: 50 },
];
const rollPool = (subjects = SUBJECTS) => makeMockPool([
  ["FROM exam_subject_sessions ess LEFT JOIN e_assessments ea", () => subjects],
  ["SELECT name FROM Classes", () => [{ name: "F1" }]],
  ["SELECT DISTINCT st.id AS student_id, st.name", () => CANDIDATES],
  ["FROM e_assessment_submissions WHERE e_assessment_id IN", () => SUBMISSIONS],
]).pool;

test("Nominal Roll: two combined subjects are ONE column and ONE mark in total and mean", async () => {
  const roll = await analytics.loadNominalRoll(rollPool(), 1);
  assert.strictEqual(roll.subjects.length, 2);
  assert.strictEqual(roll.subjects[0].subject, "English + Literature");
  assert.strictEqual(roll.subjects[0].code, "ENGL");
  assert.strictEqual(roll.subjects[0].key, "English + Literature");
  assert.strictEqual(roll.subjects[0].total_marks, 150);
  assert.strictEqual(roll.subjects[1].subject, "Maths");

  const amina = roll.rows.find((r) => r.name === "Amina");
  assert.strictEqual(amina.marks.length, 2);
  assert.strictEqual(amina.marks[0].percentage, 66);  // (60+40)/150
  assert.strictEqual(amina.marks[1].percentage, 90);
  assert.strictEqual(amina.total_obtained, 156);       // 66 + 90, NOT 60+80+90
  assert.strictEqual(amina.total_possible, 200);       // two subjects x 100
  assert.strictEqual(amina.average_percentage, 78);    // 156 / 2, NOT /3

  const brian = roll.rows.find((r) => r.name === "Brian");
  assert.strictEqual(brian.marks[0].percentage, 80);   // Literature absent (0) -> English used alone
  assert.strictEqual(brian.total_obtained, 130);       // 80 + 50
  assert.strictEqual(brian.average_percentage, 65);

  const chao = roll.rows.find((r) => r.name === "Chao");
  assert.strictEqual(chao.marks[0].percentage, 0);     // absent in both, counted as one 0
  assert.strictEqual(chao.total_possible, 200);
});

test("Nominal Roll: the main subject's key wording is used for the combined column", async () => {
  const withKey = SUBJECTS.map((s) => (s.session_id === 10 ? { ...s, report_code: "101", report_key: "Languages" } : s));
  const roll = await analytics.loadNominalRoll(rollPool(withKey), 1);
  assert.strictEqual(roll.subjects[0].code, "101");
  assert.strictEqual(roll.subjects[0].key, "Languages");
});

test("Nominal Roll: with no combine link everything is exactly as before", async () => {
  const plain = SUBJECTS.map((s) => ({ ...s, report_combine_with: null }));
  const roll = await analytics.loadNominalRoll(rollPool(plain), 1);
  assert.strictEqual(roll.subjects.length, 3);
  const amina = roll.rows.find((r) => r.name === "Amina");
  assert.strictEqual(amina.total_obtained, 230); // 60 + 80 + 90
  assert.strictEqual(amina.average_percentage, 76);
});

test("Subject analysis ranks the combined subject once, from its combined mark", async () => {
  const roll = await analytics.loadNominalRoll(rollPool(), 1);
  const sa = analytics.computeSubjectAnalysis(roll, 40);
  assert.strictEqual(sa.length, 2);
  const eng = sa.find((s) => s.subject === "English + Literature");
  assert.strictEqual(eng.sat, 2);      // Amina + Brian sat; Chao absent
  assert.strictEqual(eng.absent, 1);
});

/* ---------- Student analytics + profile ---------- */

test("Student analytics: combined subject counts once in registered / completed / total / mean", async () => {
  const mk = (student_id, name, session_id, subject, score, total_marks) => ({ student_id, name, admissionNo: `A${student_id}`, session_id, subject, session_status: "ended", total_marks, score, allow_concurrent: 0, paper_label: null });
  const rows = [
    mk(1, "Amina", 10, "English", 60, 100), mk(1, "Amina", 11, "Literature", 40, 50), mk(1, "Amina", 12, "Maths", 90, 100),
  ];
  const { pool } = makeMockPool([
    ["SELECT id AS session_id, report_combine_with FROM exam_subject_sessions", () => SUBJECTS.map((s) => ({ session_id: s.session_id, report_combine_with: s.report_combine_with }))],
    ["WITH registered AS", () => rows],
  ]);
  const res = makeRes();
  await analytics.getMainExamStudentAnalytics(makeReq({ pool, params: { id: "1" } }), res);
  const st = res.body.students[0];
  assert.strictEqual(st.subjects_registered, 2);
  assert.strictEqual(st.subjects_completed, 2);
  assert.strictEqual(st.total_obtained, 156);
  assert.strictEqual(st.overall_average, 78);
});

test("Student profile: combined subject is listed once and drives the total and mean", async () => {
  const rec = (session_id, subject, score, total_marks, report_key = null) => ({ session_id, subject, report_key, allow_concurrent: 0, paper_label: null, session_status: "ended", exam_date: null, total_marks, score, submission_status: null, submitted_at: null });
  const { pool } = makeMockPool([
    ["SELECT id AS session_id, report_combine_with FROM exam_subject_sessions", () => SUBJECTS.map((s) => ({ session_id: s.session_id, report_combine_with: s.report_combine_with }))],
    ["SELECT id, name, admissionNo, studentClass, yearOfStudy FROM Students WHERE id = @studentId", () => [{ id: 1, name: "Amina", admissionNo: "A1", studentClass: "F1", yearOfStudy: 1 }]],
    ["ess.subject, ess.report_key, ess.allow_concurrent", () => [rec(10, "English", 60, 100), rec(11, "Literature", 40, 50), rec(12, "Maths", 90, 100)]],
  ]);
  const res = makeRes();
  await analytics.getStudentExaminationProfile(makeReq({ pool, params: { id: "1", studentId: "1" } }), res);
  const b = res.body;
  assert.strictEqual(b.subjects.length, 2);
  assert.strictEqual(b.subjects[0].subject, "English + Literature");
  assert.strictEqual(b.subjects[0].percentage, 66);
  assert.strictEqual(b.subjects[0].status, "completed");
  assert.strictEqual(b.total_obtained, 156);
  assert.strictEqual(b.overall_average, 78);
  assert.strictEqual(b.subjects_completed, 2);
});

/* ---------- Class results ---------- */

test("Class results: combined subject is one column and one mark per student", async () => {
  const sess = (session_id, subject, e_assessment_id, total_marks) => ({ session_id, subject, report_key: null, allow_concurrent: 0, paper_label: null, session_status: "ended", e_assessment_id, total_marks });
  const { pool } = makeMockPool([
    ["SELECT id AS session_id, report_combine_with FROM exam_subject_sessions", () => SUBJECTS.map((s) => ({ session_id: s.session_id, report_combine_with: s.report_combine_with }))],
    ["SELECT id, name FROM Classes WHERE id = @classId", () => [{ id: 5, name: "F1" }]],
    ["SELECT TOP 1 yearOfStudy FROM Students", () => [{ yearOfStudy: 1 }]],
    ["ess.subject, ess.report_key, ess.allow_concurrent, ess.paper_label, ess.status AS session_status, ess.e_assessment_id", () => [sess(10, "English", 100, 100), sess(11, "Literature", 101, 50), sess(12, "Maths", 102, 100)]],
    ["SELECT id, name, admissionNo FROM Students WHERE studentClass", () => [{ id: 1, name: "Amina", admissionNo: "A1" }]],
    ["FROM e_assessment_submissions sub", () => SUBMISSIONS.filter((s) => s.student_id === 1)],
  ]);
  const res = makeRes();
  await reports.getClassResultsReport(makeReq({ pool, params: { mainExamId: "1", classId: "5" } }), res);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.subjects.length, 2);
  assert.strictEqual(res.body.subjects[0].subject, "English + Literature");
  const row = res.body.rows[0];
  assert.strictEqual(row.subjects.length, 2);
  assert.strictEqual(row.subjects[0].percentage, 66);
  assert.strictEqual(row.total_marks_obtained, 156);
  assert.strictEqual(row.average_percentage, 78);
});

/* ---------- Subject codes & key API ---------- */

const codesPool = (subjects = SUBJECTS) => makeMockPool([
  ["FROM exam_subject_sessions ess LEFT JOIN e_assessments ea", () => subjects],
]).pool;

test("Subject codes GET returns each subject's combine_with", async () => {
  const res = makeRes();
  await codes.getSubjectCodes(makeReq({ pool: codesPool(), params: { mainExamId: "1" } }), res);
  const by = Object.fromEntries(res.body.subjects.map((s) => [s.session_id, s.combine_with]));
  assert.deepStrictEqual(by, { 10: null, 11: 10, 12: null });
});

test("Subject codes PUT rejects an invalid combine choice (self / chain) with a clear message", async () => {
  const put = async (items) => {
    const res = makeRes();
    await codes.updateSubjectCodes(makeReq({ pool: codesPool(), params: { mainExamId: "1" }, body: { items } }), res);
    return res;
  };
  const self = await put([{ session_id: 12, code: "", key: "", combine_with: 12 }]);
  assert.strictEqual(self.statusCode, 400);
  assert.ok(/itself/.test(self.body.message));
  const chain = await put([{ session_id: 12, code: "", key: "", combine_with: 11 }]); // 11 is already combined into 10
  assert.strictEqual(chain.statusCode, 400);
  assert.ok(/combined into another/.test(chain.body.message));
});
