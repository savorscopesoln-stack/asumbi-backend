const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const analytics = require("../controllers/mainExamAnalytics.controller");

suite("rankingTies.test.js");

// Same mean (60), different totals: Zed also sat the optional Art paper (total 180), Amy did not (total 120).
// Alphabetically Amy is first, but the higher total must come first.
const mk = (session_id, subject, e_assessment_id, start) => ({ session_id, subject, session_status: "ended", start_time: start, e_assessment_id, report_code: null, report_key: null, report_combine_with: null, allow_concurrent: 0, paper_label: null, total_marks: 100, class_name: "F1", year_of_study: 1 });
const SUBJECTS = [mk(1, "English", 11, "2026-11-01T08:00:00Z"), mk(2, "Maths", 12, "2026-11-02T08:00:00Z"), mk(3, "Art (Optional)", 13, "2026-11-03T08:00:00Z")];
const CANDIDATES = [
  { student_id: 1, name: "Amy", admissionNo: "A1", gender: "F", studentClass: "F1", yearOfStudy: 1 },
  { student_id: 2, name: "Zed", admissionNo: "A2", gender: "M", studentClass: "F1", yearOfStudy: 1 },
  { student_id: 3, name: "Bob", admissionNo: "A3", gender: "M", studentClass: "F1", yearOfStudy: 1 },
  { student_id: 4, name: "Cat", admissionNo: "A4", gender: "F", studentClass: "F1", yearOfStudy: 1 },
];
const subs = (sid, scores) => scores.map((score, i) => ({ student_id: sid, e_assessment_id: 11 + i, score })).filter((x) => x.score != null);
const SUBMISSIONS = [...subs(1, [60, 60, null]), ...subs(2, [60, 60, 60]), ...subs(3, [70, 70, null]), ...subs(4, [70, 70, null])];

test("same mean: the higher total ranks first (not alphabetical); equal mean and total share a position", async () => {
  const { pool } = makeMockPool([
    ["FROM exam_subject_sessions ess LEFT JOIN e_assessments ea", () => SUBJECTS],
    ["SELECT name FROM Classes", () => [{ name: "F1" }]],
    ["SELECT DISTINCT st.id AS student_id, st.name", () => CANDIDATES],
    ["FROM e_assessment_submissions WHERE e_assessment_id IN", () => SUBMISSIONS],
  ]);
  const roll = await analytics.loadNominalRoll(pool, 1);
  const by = Object.fromEntries(roll.rows.map((r) => [r.name, r]));
  assert.strictEqual(by.Amy.average_percentage, 60);
  assert.strictEqual(by.Zed.average_percentage, 60);
  assert.ok(by.Zed.total_obtained > by.Amy.total_obtained);
  // Bob and Cat: mean 70, identical totals -> tied 1st; then Zed (higher total), then Amy.
  assert.deepStrictEqual(roll.rows.map((r) => r.class_position), [1, 1, 3, 4]);
  assert.strictEqual(by.Zed.class_position, 3);
  assert.strictEqual(by.Amy.class_position, 4);
  assert.strictEqual(by.Zed.overall_position, 3);
  assert.strictEqual(by.Amy.overall_position, 4);
  const order = roll.rows.map((r) => r.name);
  assert.ok(order.indexOf("Zed") < order.indexOf("Amy"));
});
