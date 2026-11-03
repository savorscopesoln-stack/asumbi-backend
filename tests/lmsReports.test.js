/* L7.6a - staff reports (D-093): course progress + grade distribution. Read only, bounded, hand-calculated numbers, staff view, tenant scoped, route gates.
   Mocked pool only: SQL (OPENJSON, SUM/MAX GROUP BY) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsReports.test.js");
const R = require("../utils/lmsReports"), P = require("../utils/lmsPermissions"), grading = require("../utils/grading");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const GS = grading.DEFAULT_GRADING_SYSTEM;

test("buildProgress (pure): hand-calculated percents (rounded DOWN), summary, no lessons = 0 and nobody complete, completed capped at the lesson count", () => {
  const L = (id, completed, last = null) => ({ studentId: id, name: "n" + id, admissionNo: "a" + id, completed, lastActivityAt: last });
  const r = R.buildProgress([L(1, 4, "t"), L(2, 2), L(3, 0), L(4, 1)], 4);
  assert.deepStrictEqual(r.rows.map((x) => x.percent), [100, 50, 0, 25]);
  assert.deepStrictEqual(r.summary, { learners: 4, lessons: 4, notStarted: 1, inProgress: 2, complete: 1, averagePercent: 43.75 });
  assert.strictEqual(R.buildProgress([L(1, 1)], 3).rows[0].percent, 33, "1/3 rounds down");
  const none = R.buildProgress([L(1, 5), L(2, 0)], 0); assert.deepStrictEqual([none.rows[0].percent, none.rows[0].completed, none.summary.complete, none.summary.notStarted, none.summary.averagePercent], [0, 0, 0, 2, 0]);
  assert.strictEqual(R.buildProgress([L(1, 9)], 4).rows[0].completed, 4, "capped (a lesson hidden later cannot push past 100%)");
  assert.deepStrictEqual(R.buildProgress([], 4).summary, { learners: 0, lessons: 4, notStarted: 0, inProgress: 0, complete: 0, averagePercent: 0 });
});

test("buildDistribution (pure): hand-calculated statistics, pass rate, histogram, every band listed; not graded left out, never counted as 0", () => {
  const d = R.buildDistribution([100, 65, 20, null, 75, 0], GS);
  assert.deepStrictEqual([d.learners, d.graded, d.notGraded, d.mean, d.median, d.min, d.max], [6, 5, 1, 52, 65, 0, 100]);
  assert.deepStrictEqual([d.passMark, d.passed, d.failed, d.passRate], [40, 3, 2, 60]);
  assert.deepStrictEqual(d.histogram.map((h) => h.count), [1, 0, 1, 0, 0, 0, 1, 1, 0, 1]); assert.deepStrictEqual([d.histogram[0].from, d.histogram[0].to, d.histogram[9].from, d.histogram[9].to], [0, 9.99, 90, 100]);
  assert.deepStrictEqual(d.bands.map((b) => `${b.grade}:${b.count}`), ["1:1", "2:1", "3:0", "4:1", "5:0", "6:0", "7:2"]); assert.strictEqual(d.unbanded, 0);
  const edge = R.buildDistribution([40, 39.99], GS); assert.deepStrictEqual([edge.passed, edge.failed], [1, 1], "exactly the pass mark passes");
  const even = R.buildDistribution([10, 20, 30, 41], GS); assert.deepStrictEqual([even.median, even.mean], [25, 25.25], "even count: middle two averaged, 2 decimals");
  const e = R.buildDistribution([null, null], GS); assert.deepStrictEqual([e.graded, e.mean, e.median, e.min, e.max, e.passRate, e.passed], [0, null, null, null, null, null, 0]);
  assert.strictEqual(R.buildDistribution([], GS).learners, 0); assert.strictEqual(R.buildDistribution([140], GS).histogram[9].count, 1, "above 100 lands in the last bucket");
  assert.strictEqual(R.buildDistribution([50], { passMark: 70, gradeBands: GS.gradeBands }).passed, 0, "the school's pass mark is used"); assert.strictEqual(R.buildDistribution([50], { gradeBands: GS.gradeBands }).passMark, 50, "50 when unset");
  const odd = R.buildDistribution([30, 60], { passMark: 40, gradeBands: [{ minScore: 50, grade: "A", label: "x" }] }); assert.strictEqual(odd.bands.reduce((n, x) => n + x.count, 0) + odd.unbanded, 2, "every graded learner is counted in a band or in unbanded, never dropped");
});

const LEARNERS = [{ student_id: 21, student_name: "Amina", admission_no: "A1" }, { student_id: 22, student_name: "Brian", admission_no: "A2" }, { student_id: 23, student_name: "Cheche", admission_no: "A3" }, { student_id: 24, student_name: "Dina", admission_no: "A4" }];
const progressWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["FROM lms_course_enrolments e", (i) => (i.c === 5 ? (o.learners || LEARNERS) : [])],
  ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: o.lessons ?? 4 }]],
  ["FROM lms_lesson_progress p", () => [{ student_id: 21, done: 4, last_at: "2026-11-01T08:00:00Z" }, { student_id: 22, done: 2, last_at: "2026-10-30T08:00:00Z" }, { student_id: 24, done: 1, last_at: "2026-10-01T08:00:00Z" }]]]);

test("progress report: per-learner rows in name order with last activity, hand-calculated summary, scoped to this course and ACTIVE learners, visible lessons only, no writes", async () => {
  const m = progressWorld(); const r = await R.progressReport(m.pool, teacher, 5); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.learners.map((x) => [x.name, x.admissionNo, x.completed, x.total, x.percent, x.lastActivityAt]), [["Amina", "A1", 4, 4, 100, "2026-11-01T08:00:00.000Z"], ["Brian", "A2", 2, 4, 50, "2026-10-30T08:00:00.000Z"], ["Cheche", "A3", 0, 4, 0, null], ["Dina", "A4", 1, 4, 25, "2026-10-01T08:00:00.000Z"]]);
  assert.deepStrictEqual(r.summary, { learners: 4, lessons: 4, notStarted: 1, inProgress: 2, complete: 1, averagePercent: 43.75 });
  const en = m.log.find((x) => /FROM lms_course_enrolments e/.test(x.sql)); assert.ok(/status = 'active'/.test(en.sql) && /TOP 2001/.test(en.sql) && en.inputs.c === 5);
  const p = m.log.find((x) => /FROM lms_lesson_progress p/.test(x.sql)); assert.ok(/p\.course_id = @c/.test(p.sql) && /status = 'published'/.test(p.sql) && /deleted_at IS NULL/.test(p.sql) && /GROUP BY p\.student_id/.test(p.sql)); assert.deepStrictEqual(JSON.parse(p.inputs.ids), [21, 22, 23, 24]);
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
  const none = progressWorld({ lessons: 0 }); const z = await R.progressReport(none.pool, teacher, 5); assert.deepStrictEqual([z.summary.complete, z.learners[0].percent], [0, 0]); assert.ok(!none.log.some((x) => /lms_lesson_progress/.test(x.sql)), "no lessons = no progress query");
  const empty = await R.progressReport(progressWorld({ learners: [] }).pool, teacher, 5); assert.deepStrictEqual([empty.ok, empty.learners.length, empty.summary.learners], [true, 0, 0]);
  const big = await R.progressReport(progressWorld({ learners: Array.from({ length: 2001 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" })) }).pool, teacher, 5); assert.deepStrictEqual([big.ok, big.code], [false, "TOO_MANY_LEARNERS"]);
});

const ITEMS = [{ id: 1, category_id: 1, max_points: 50, weight: 1, released: 1 }, { id: 2, category_id: 1, max_points: 100, weight: 1, released: 0 }];
const DL = [21, 22, 23, 24, 25, 26].map((s) => ({ student_id: s, student_name: "n" + s, admission_no: "a" + s }));
// 21: 100/100 -> 100. 22: 80 and 50 -> 65. 23: T1 excused, T2 20 -> 20. 24: nothing. 25: T1 50% + HIDDEN T2 100% (staff view counts it) -> 75. 26: 0 and 0 -> 0.
const GR = [{ item_id: 1, student_id: 21, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 21, points: 100, excused: 0, hidden: 0 }, { item_id: 1, student_id: 22, points: 40, excused: 0, hidden: 0 }, { item_id: 2, student_id: 22, points: 50, excused: 0, hidden: 0 },
  { item_id: 1, student_id: 23, points: null, excused: 1, hidden: 0 }, { item_id: 2, student_id: 23, points: 20, excused: 0, hidden: 0 }, { item_id: 1, student_id: 25, points: 25, excused: 0, hidden: 0 }, { item_id: 2, student_id: 25, points: 100, excused: 0, hidden: 1 },
  { item_id: 1, student_id: 26, points: 0, excused: 0, hidden: 0 }, { item_id: 2, student_id: 26, points: 0, excused: 0, hidden: 0 }];
const distWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["FROM lms_grade_categories", () => [{ id: 1, weight: 100, drop_lowest: 0 }]], ["FROM lms_grade_items WHERE course_id = @c", () => (o.items || ITEMS)],
  ["FROM lms_course_enrolments e", () => (o.learners || DL)], ["FROM lms_grades g JOIN lms_grade_items i", () => GR], ["FROM GradingSystem", () => []]]);

test("distribution report: staff-view totals (hidden grade and unreleased item count), hand-calculated, nobody named, scoped to this course, read only", async () => {
  const m = distWorld(); const r = await R.distributionReport(m.pool, teacher, 5); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.view, "staff"); const d = r.distribution;
  assert.deepStrictEqual([d.learners, d.graded, d.notGraded, d.mean, d.median, d.min, d.max, d.passed, d.failed, d.passRate], [6, 5, 1, 52, 65, 0, 100, 3, 2, 60]);
  assert.deepStrictEqual(d.histogram.map((h) => h.count), [1, 0, 1, 0, 0, 0, 1, 1, 0, 1]); assert.deepStrictEqual(d.bands.map((b) => b.count), [1, 1, 0, 1, 0, 0, 2]);
  assert.ok(!/n2[1-6]|a2[1-6]|student/i.test(JSON.stringify(r)), "no learner is named or identified");
  const g = m.log.find((x) => /FROM lms_grades g/.test(x.sql)); assert.ok(/g\.course_id = @c/.test(g.sql) && /TOP 100000/.test(g.sql) && g.inputs.c === 5); assert.ok(!/released = 1/.test(m.log.find((x) => /FROM lms_grade_items WHERE/.test(x.sql)).sql), "staff view reads unreleased items too");
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
  const hi = await R.distributionReport(distWorld().pool, teacher, 5); assert.strictEqual(hi.distribution.passMark, 40);
  const emptyItems = await R.distributionReport(distWorld({ items: [] }).pool, teacher, 5); assert.deepStrictEqual([emptyItems.distribution.graded, emptyItems.distribution.notGraded], [0, 6]);
  const big = await R.distributionReport(distWorld({ learners: Array.from({ length: 2001 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" })) }).pool, teacher, 5); assert.strictEqual(big.code, "TOO_MANY_LEARNERS");
  const cells = await R.distributionReport(distWorld({ items: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, category_id: 1, max_points: 1, weight: 1, released: 1 })), learners: Array.from({ length: 501 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" })) }).pool, teacher, 5);
  assert.strictEqual(cells.code, "EXPORT_TOO_LARGE");
});

test("isolation: students, bad ids, other or missing courses and other tenants are not found; nothing is queried for a student or a bad id", async () => {
  for (const fn of [R.progressReport, R.distributionReport]) {
    for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"], [teacher, 0]]) { const m = progressWorld(); assert.strictEqual((await fn(m.pool, u, id)).notFound, true, `${JSON.stringify(u)} ${id}`); }
    const q = progressWorld(); await fn(q.pool, student, 5); await fn(q.pool, teacher, "x"); assert.strictEqual(q.log.length, 0);
    const T = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await fn(T.A.pool, teacher, 5)).notFound, true); T.assertUntouched("B");
  }
});

test("routes: flag gate + gradebook.view + course access + handler; no-store; 409/404 shape; students hold no gradebook.view", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), GB = "/courses/:courseId/gradebook";
  const rs = ["progress", "distribution"].map((n) => router.stack.find((l) => l.route && l.route.path === `${GB}/reports/${n}` && l.route.methods.get)); assert.ok(rs.every(Boolean)); for (const r of rs) assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/reports\/progress`, gbGate, gbView, staffAccess/.test(src) && /reports\/distribution`, gbGate, gbView, staffAccess/.test(src)); assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.gradebook.view"));
  const res = makeRes(); let hdr = null; res.setHeader = (k, v) => { hdr = [k, v]; }; await rs[0].route.stack[3].handle({ pool: progressWorld().pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.summary.learners, "ok" in res.body, hdr], [200, true, 4, false, ["Cache-Control", "no-store"]]);
  const r2 = makeRes(); r2.setHeader = () => {}; await rs[1].route.stack[3].handle({ pool: distWorld().pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.view, r2.body.distribution.graded], [200, "staff", 5]);
  const r3 = makeRes(); r3.setHeader = () => {}; await rs[0].route.stack[3].handle({ pool: progressWorld().pool, user: teacher, params: { courseId: "9" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); r4.setHeader = () => {}; await rs[0].route.stack[3].handle({ pool: progressWorld({ learners: Array.from({ length: 2001 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" })) }).pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r4); assert.deepStrictEqual([r4.statusCode, r4.body.code], [409, "TOO_MANY_LEARNERS"]);
});
