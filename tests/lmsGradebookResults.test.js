/* L7.4b - gradebook course totals -> formal results (D-090): learner-view totals, skips, mapping rules, one atomic idempotent batch, dry run, isolation, route gates.
   Mocked pool only: SQL (OPENJSON, table variable, SCOPE_IDENTITY, UPDLOCK/HOLDLOCK) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsGradebookResults.test.js");
const G = require("../utils/lmsGradebookResults"), P = require("../utils/lmsPermissions"), events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const COURSE = (o = {}) => ({ id: 5, title: "Maths F3", status: "published", academic_year: 2026, semester: "Term 2", class_name: "Form 3 A", subject_id: 12, ...o });
const CATS = [{ id: 1, weight: 60, drop_lowest: 0 }, { id: 2, weight: 40, drop_lowest: 0 }];
const ITEMS = [{ id: 1, category_id: 1, max_points: 50, weight: 1 }, { id: 2, category_id: 1, max_points: 100, weight: 1 }, { id: 3, category_id: 2, max_points: 20, weight: 1 }];
const GR = [{ item_id: 1, student_id: 30, points: 40, excused: 0, hidden: 0 }, { item_id: 2, student_id: 30, points: 50, excused: 0, hidden: 0 }, { item_id: 3, student_id: 30, points: 10, excused: 0, hidden: 1 },
  { item_id: 1, student_id: 31, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 31, points: 100, excused: 0, hidden: 0 }, { item_id: 3, student_id: 31, points: 20, excused: 0, hidden: 0 },
  { item_id: 1, student_id: 33, points: null, excused: 1, hidden: 0 }];
const world = (o = {}, extra = []) => makeMockPool([
  ["FROM lms_courses WHERE id", (i) => (i.c === 5 && o.course !== null ? [o.course || COURSE()] : [])],
  ["SELECT TOP 1 id FROM subjects WHERE id = @s", (i) => (o.subj !== false && i.s === 12 ? [{ id: 12 }] : [])],
  ["SELECT TOP 1 id FROM Classes WHERE name = @n", (i) => (o.cls !== false && i.n === "Form 3 A" ? [{ id: 3 }] : [])],
  ["FROM lms_grade_categories WHERE course_id = @c", (i) => (i.c === 5 ? CATS : [])], ["FROM lms_grade_items WHERE course_id = @c", (i) => (i.c === 5 ? (o.items || ITEMS) : [])],
  ["FROM lms_course_enrolments WHERE course_id = @c", (i) => (i.c === 5 ? (o.ids || [30, 31, 32, 33]).map((s) => ({ student_id: s })) : [])],
  ["FROM lms_grades g JOIN lms_grade_items i", (i) => (i.c === 5 ? (o.grades || GR) : [])],
  ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @aid INT", () => [o.write || { assessment_id: 77, inserted: 2, updated: 0 }]], ...extra]);
const writeOf = (m) => m.log.find((x) => /SET XACT_ABORT ON; BEGIN TRAN/.test(x.sql));
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));

test("planRows (pure): student-view totals, hand-calculated; hidden grade not counted; nothing counted = skipped, never 0", () => {
  const categories = CATS.map((c) => ({ id: c.id, weight: c.weight, dropLowest: 0 })), items = ITEMS.map((i) => ({ id: i.id, categoryId: i.category_id, maxPoints: i.max_points, weight: 1 }));
  const grades = new Map([[30, [{ itemId: 1, points: 40 }, { itemId: 2, points: 50 }, { itemId: 3, points: 10, hidden: true }]], [31, [{ itemId: 1, points: 50 }, { itemId: 2, points: 100 }, { itemId: 3, points: 20 }]], [33, [{ itemId: 1, excused: true }]]]);
  const r = G.planRows({ categories, items, learnerIds: [33, 32, 31, 30], grades });
  // 30: T1 80, T2 50 -> Tests 65; Homework hidden -> only Tests -> 65.  31: 100/100 -> 100.
  assert.deepStrictEqual(r.rows, [{ studentId: 30, score: 65, percentage: 65 }, { studentId: 31, score: 100, percentage: 100 }]);
  assert.deepStrictEqual(r.skipped, [{ studentId: 32, reason: "NOTHING_COUNTED" }, { studentId: 33, reason: "NOTHING_COUNTED" }]);
  const odd = G.planRows({ categories: [{ id: 1, weight: 1, dropLowest: 0 }], items: [{ id: 1, categoryId: 1, maxPoints: 3, weight: 1 }], learnerIds: [1], grades: new Map([[1, [{ itemId: 1, points: 1 }]]]) });
  assert.deepStrictEqual(odd.rows, [{ studentId: 1, score: 33, percentage: 33.33 }], "score rounded, percentage 2 decimals");
});

test("publish: one atomic batch under source lms_grade_item with the COURSE id, 100 marks, only released items read, audited + event; skipped listed", async () => {
  const m = world();
  const r = await G.publishCourseResults(m.pool, teacher, 5, {}, { tenant: "tX" }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.assessmentId, r.totalMarks, r.inserted, r.updated, r.unchanged, r.skippedCount], [77, 100, 2, 0, 0, 2]);
  assert.deepStrictEqual(r.skipped.map((s) => [s.studentId, s.reason]), [[32, "NOTHING_COUNTED"], [33, "NOTHING_COUNTED"]]);
  const w = writeOf(m); assert.deepStrictEqual([w.inputs.src, w.inputs.q, w.inputs.tm, w.inputs.subj, w.inputs.cls], ["lms_grade_item", 5, 100, 12, "Form 3 A"]);
  assert.deepStrictEqual(JSON.parse(w.inputs.rows), [{ s: 30, sc: 65, p: 65 }, { s: 31, sc: 100, p: 100 }]);
  assert.ok(/UPDLOCK, HOLDLOCK/.test(w.sql) && /sourceSystem = @src AND sourceRefId = @q/.test(w.sql) && !/DELETE FROM/.test(w.sql) && !/\bgrade\b\s*[,)]/.test(w.sql.split("INSERT INTO Marks")[1] || ""), "locked lookup, never deletes, no grade column");
  assert.ok(/released = 1/.test(m.log.find((x) => /FROM lms_grade_items WHERE/.test(x.sql)).sql) && /i\.released = 1/.test(m.log.find((x) => /FROM lms_grades g/.test(x.sql)).sql), "unreleased items never read");
  assert.ok(/status = 'active'/.test(m.log.find((x) => /FROM lms_course_enrolments/.test(x.sql)).sql), "active learners only");
  const gq = m.log.find((x) => /FROM lms_grades g/.test(x.sql)); assert.ok(/g\.course_id = @c/.test(gq.sql) && gq.inputs.c === 5 && /TOP 100000/.test(gq.sql), "grades read for THIS course only, bounded"); assert.deepStrictEqual(JSON.parse(gq.inputs.ids), [30, 31, 32, 33]);
  const a = audits(m); assert.strictEqual(a.length, 1); assert.ok(/results\.published/.test(JSON.stringify(a[0].inputs)));
});

test("idempotent counts: an unchanged second run reports unchanged, a corrected mark reports updated; dry run writes nothing", async () => {
  const again = await G.publishCourseResults(world({ write: { assessment_id: 77, inserted: 0, updated: 0 } }).pool, teacher, 5, {});
  assert.deepStrictEqual([again.inserted, again.updated, again.unchanged], [0, 0, 2]);
  const fix = await G.publishCourseResults(world({ write: { assessment_id: 77, inserted: 0, updated: 1 } }).pool, teacher, 5, {}); assert.deepStrictEqual([fix.updated, fix.unchanged], [1, 1]);
  const d = world(); const r = await G.publishCourseResults(d.pool, teacher, 5, { dryRun: true }); assert.deepStrictEqual([r.ok, r.dryRun, r.eligible, r.skippedCount, r.totalMarks], [true, true, 2, 2, 100]);
  assert.ok(!writeOf(d) && audits(d).length === 0, "dry run: no write, no audit");
});

test("refusals: draft course, no mapping, unknown subject/class, no released item, nothing counted, too many learners, bad body; nothing written", async () => {
  const cases = [[{ course: COURSE({ status: "draft" }) }, "COURSE_NOT_PUBLISHED"], [{ course: COURSE({ subject_id: null }) }, "NO_RESULTS_MAPPING"], [{ course: COURSE({ class_name: " " }) }, "NO_RESULTS_MAPPING"],
    [{ subj: false }, "NO_RESULTS_MAPPING"], [{ cls: false }, "NO_RESULTS_MAPPING"], [{ items: [] }, "NOTHING_TO_PUBLISH"], [{ grades: [] }, "NOTHING_TO_PUBLISH"],
    [{ ids: Array.from({ length: 2001 }, (_, i) => i + 1) }, "TOO_MANY_LEARNERS"]];
  for (const [o, code] of cases) { const m = world(o); const r = await G.publishCourseResults(m.pool, teacher, 5, {}); assert.deepStrictEqual([r.ok, r.code], [false, code], code); assert.ok(!writeOf(m) && audits(m).length === 0); }
  const big = Array.from({ length: 1000 }, (_, i) => i + 1), items = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, category_id: 1, max_points: 10, weight: 1 }));
  assert.strictEqual((await G.publishCourseResults(world({ ids: big, items }).pool, teacher, 5, {})).code, "EXPORT_TOO_LARGE");
  for (const b of [[], "x", { dryRun: "yes" }]) { const m = world(); const r = await G.publishCourseResults(m.pool, teacher, 5, b); assert.strictEqual(r.ok, false); assert.strictEqual(m.log.length, 0, "validated before any query"); }
});

test("isolation: students, bad ids, other course or tenant = not found, nothing queried or written", async () => {
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const m = world(); const r = await G.publishCourseResults(m.pool, u, id, {}); assert.strictEqual(r.notFound, true); assert.ok(!writeOf(m)); }
  const T = makeTenants({ A: [["FROM lms_courses WHERE id", () => []]], B: [] }); assert.strictEqual((await G.publishCourseResults(T.A.pool, teacher, 5, {})).notFound, true); T.assertUntouched("B");
});

test("route: flag gate, publish permission (not view), course access, handler; teachers lack the permission by default; 200 no-store with no `ok` key", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const r = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/gradebook/results" && l.route.methods.post); assert.ok(r); assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/\$\{GB\}\/results`, gbGate, publishPerm, staffAccess/.test(src), "flag, then lms.gradebook.publish, then course membership");
  assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.gradebook.publish") && !P.roleDefaults({ role: "teacher" }).includes("lms.gradebook.publish"));
  const res = makeRes(); let hdr = null; res.setHeader = (k, v) => { hdr = [k, v]; };
  await r.route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "5" }, body: { dryRun: true }, tenant: "t" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.eligible, "ok" in res.body, hdr], [200, true, 2, false, ["Cache-Control", "no-store"]]);
  const r2 = makeRes(); r2.setHeader = () => {}; await r.route.stack[3].handle({ pool: world({ subj: false }).pool, user: teacher, params: { courseId: "5" }, body: {}, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.code], [409, "NO_RESULTS_MAPPING"]);
  const r3 = makeRes(); r3.setHeader = () => {}; await r.route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "9" }, body: {}, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
});

test("event: lms.results.published carries ids only and the source", async () => {
  const got = []; const off = events.on("lms.results.published", (p) => got.push(p));
  await G.publishCourseResults(world().pool, teacher, 5, {}, { tenant: "tEvt" }); await tick();
  const mine = got.filter((p) => p.tenant === "tEvt"); assert.strictEqual(mine.length, 1); assert.deepStrictEqual([mine[0].courseId, mine[0].source, mine[0].assessmentId], [5, "lms_grade_item", 77]);
  assert.ok(!/name|score|percent/i.test(Object.keys(mine[0]).join(",")), "ids and counts only"); if (typeof off === "function") off();
});
