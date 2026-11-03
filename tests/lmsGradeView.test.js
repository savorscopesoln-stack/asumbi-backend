/* L7.3 - learner grade view (D-088): released only, hidden = pending, student-view totals, bands from the existing grading system, own id only, route gates.
   Mocked pool only: SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsGradeView.test.js");
const V = require("../utils/lmsGradeView"), P = require("../utils/lmsPermissions");

const me = { id: 21, role: "student", source: "Students" }, teacher = { id: 7, role: "teacher", source: "Teachers" };
const CATS = [{ id: 1, name: "Tests", weight: 60, drop_lowest: 0, position: 1 }, { id: 2, name: "Homework", weight: 40, drop_lowest: 0, position: 2 }];
const ITEMS = [{ id: 1, category_id: 1, title: "T1", source_type: "manual", max_points: 50, weight: 1, position: 1 }, { id: 2, category_id: 1, title: "T2", source_type: "manual", max_points: 100, weight: 1, position: 2 }, { id: 3, category_id: 2, title: "H1", source_type: "assignment", max_points: 10, weight: 1, position: 3 }];
const GR = [{ item_id: 1, points: 40, excused: 0, hidden: 0, comment: "Good" }, { item_id: 2, points: 50, excused: 0, hidden: 0, comment: null }, { item_id: 3, points: 10, excused: 0, hidden: 1, comment: "secret" }];
const world = (o = {}) => makeMockPool([
  ["FROM lms_courses WHERE id", (i) => (i.c === 5 && o.course !== false ? [{ status: o.status || "published" }] : [])],
  ["FROM lms_grade_categories WHERE course_id = @c", (i) => (i.c === 5 ? CATS : [])], ["FROM lms_grade_items WHERE course_id = @c", (i) => (i.c === 5 ? (o.items || ITEMS) : [])],
  ["FROM lms_grades g JOIN lms_grade_items i", (i) => (i.c === 5 && i.s === 21 ? (o.grades || GR) : [])],
  ["FROM GradingSystem", () => { if (o.gsThrows) throw new Error("no table"); return o.gs === undefined ? [] : o.gs; }],
]);

test("itemView (pure): graded / pending (no grade, hidden, empty points) / excused; hidden never leaks points or comment", () => {
  const it = ITEMS[0];
  assert.deepStrictEqual([V.itemView(it, { points: 40, excused: 0, hidden: 0, comment: "ok" }, 50).status, V.itemView(it, { points: 40 }, 50).percent, V.itemView(it, { points: 40, comment: "ok" }, 50).comment], ["graded", 80, "ok"]);
  const h = V.itemView(it, { points: 40, hidden: 1, comment: "secret" }, 50); assert.deepStrictEqual([h.status, h.points, h.percent, h.comment], ["pending", null, null, null]);
  assert.strictEqual(V.itemView(it, undefined, 50).status, "pending"); assert.strictEqual(V.itemView(it, { points: null }, 50).status, "pending");
  const e = V.itemView(it, { excused: 1, points: 5 }, 50); assert.deepStrictEqual([e.status, e.points], ["excused", null]);
  assert.strictEqual(V.itemView(it, { points: 60 }, 50).percent, 120, "extra credit shown as is"); assert.strictEqual(V.itemView(it, { points: 5 }, 0).percent, null);
});

test("myGrades: totals use only what the learner can see (hidden H1 is NOT counted), band from the default grading system, hand-calculated", async () => {
  const m = world(); const r = await V.myGrades(m.pool, me, 5); assert.ok(r.ok, JSON.stringify(r));
  // T1 80, T2 50 -> Tests 65; Homework hidden -> not counted -> only Tests -> total 65 -> default band "4" Credit
  assert.deepStrictEqual([r.total.percent, r.total.itemsCounted, r.total.band.grade, r.total.band.label, r.total.passed], [65, 2, "4", "Credit", true]);
  assert.deepStrictEqual(r.categories.map((c) => [c.id, c.percent]), [[1, 65], [2, null]]);
  assert.deepStrictEqual(r.items.map((i) => [i.id, i.status, i.points]), [[1, "graded", 40], [2, "graded", 50], [3, "pending", null]]);
  assert.ok(!/secret/.test(JSON.stringify(r)), "a hidden comment never reaches the learner"); assert.ok(!/graded_by|changed_by|student_id|studentId/i.test(JSON.stringify(r)), "no staff or identity fields");
  assert.strictEqual(r.items[0].comment, "Good");
});

test("scale: a configured GradingSystem row is used (bands + pass mark); a missing table or row falls back to the default; no percentage = no band", async () => {
  const gs = [{ systemName: "School A", passMark: 70, gradeBandsJson: JSON.stringify([{ minScore: 60, grade: "B", label: "Good", remark: "r" }, { minScore: 0, grade: "C", label: "Low" }]), overallBandsJson: "[]" }];
  const r = await V.myGrades(world({ gs }).pool, me, 5); assert.deepStrictEqual([r.scale.systemName, r.scale.passMark, r.total.band.grade, r.total.passed], ["School A", 70, "B", false]);
  const d = await V.myGrades(world({ gsThrows: true }).pool, me, 5); assert.strictEqual(d.total.band.grade, "4", "default scale");
  const none = await V.myGrades(world({ grades: [] }).pool, me, 5); assert.deepStrictEqual([none.total.percent, none.total.band, none.total.passed, none.total.itemsCounted], [null, null, null, 0]);
});

test("released items only, own grades only, scoped by course; nothing released = empty and no grade query; other course/draft/non-students are not found", async () => {
  const m = world(); await V.myGrades(m.pool, me, 5);
  assert.ok(/released = 1/.test(m.log.find((x) => /FROM lms_grade_items WHERE/.test(x.sql)).sql)); const g = m.log.find((x) => /FROM lms_grades g/.test(x.sql)); assert.deepStrictEqual([g.inputs.c, g.inputs.s], [5, 21]); assert.ok(/i\.released = 1/.test(g.sql) && /g\.student_id = @s/.test(g.sql));
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
  const e = world({ items: [] }); const er = await V.myGrades(e.pool, me, 5); assert.deepStrictEqual([er.items, er.total.percent], [[], null]); assert.ok(!e.log.some((x) => /FROM lms_grades g/.test(x.sql)));
  assert.strictEqual((await V.myGrades(world().pool, me, 6)).notFound, true); assert.strictEqual((await V.myGrades(world({ course: false }).pool, me, 5)).notFound, true, "draft/deleted course");
  assert.ok((await V.myGrades(world({ status: "archived" }).pool, me, 5)).ok, "archived stays readable");
  assert.ok(/status IN \('published', ?'archived'\)/.test(m.log.find((x) => /FROM lms_courses/.test(x.sql)).sql), "only published or archived courses");
  for (const u of [teacher, null, { id: 21, role: "teacher", source: "Students" }, { id: 21, role: "student", source: "Teachers" }]) assert.strictEqual((await V.myGrades(world().pool, u, 5)).notFound, true);
  const quiet = world(); await V.myGrades(quiet.pool, me, "x"); assert.strictEqual(quiet.log.length, 0);
  const T = makeTenants({ A: [["FROM lms_courses WHERE id", () => []]], B: [] }); assert.strictEqual((await V.myGrades(T.A.pool, me, 5)).notFound, true); T.assertUntouched("B");
});

test("route: flag gate, studentOnly, course access, handler; students hold no staff gradebook permission; handler answers 200 with no `ok` key and no-store", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const r = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/grades" && l.route.methods.get); assert.ok(r); assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/learn\/grades", gbGate, studentOnly, studentAccess/.test(src), "flag first, then student-only, then enrolment");
  assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.gradebook.view"));
  const res = makeRes(); let hdr = null; res.setHeader = (k, v) => { hdr = [k, v]; }; await r.route.stack[3].handle({ pool: world().pool, user: me, params: { courseId: "5" }, tenant: "t" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.total.percent, "ok" in res.body, hdr], [200, true, 65, false, ["Cache-Control", "no-store"]]);
  const r2 = makeRes(); await r.route.stack[3].handle({ pool: world().pool, user: me, params: { courseId: "9" }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 404);
});
