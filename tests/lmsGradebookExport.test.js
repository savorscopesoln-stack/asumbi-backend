/* L7.4a - gradebook CSV export (D-089): staff only, bounded, staff-view numbers, formula-safe cells, audited, tenant scoped, route gates.
   Mocked pool only: SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsGradebookExport.test.js");
const X = require("../utils/lmsGradebookExport"), P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const CATS = [{ id: 1, name: "Tests", weight: 60, drop_lowest: 0 }, { id: 2, name: "Homework", weight: 40, drop_lowest: 0 }];
const ITEMS = [{ id: 1, category_id: 1, title: "T1", max_points: 50, weight: 1, released: 1 }, { id: 2, category_id: 1, title: "T2", max_points: 100, weight: 1, released: 1 }, { id: 3, category_id: 2, title: "=HYPERLINK(\"x\")", max_points: 20, weight: 1, released: 0 }];
const LEARNERS = [{ student_id: 21, student_name: "Amina", admission_no: "A1" }, { student_id: 22, student_name: "=cmd|' /C calc'!A0", admission_no: "A2" }, { student_id: 23, student_name: "Brian, Jr.", admission_no: "A3" }];
const GR = [{ item_id: 1, student_id: 21, points: 40, excused: 0, hidden: 0 }, { item_id: 2, student_id: 21, points: 50, excused: 0, hidden: 0 }, { item_id: 3, student_id: 21, points: 10, excused: 0, hidden: 1 },
  { item_id: 1, student_id: 22, points: null, excused: 1, hidden: 0 }, { item_id: 2, student_id: 22, points: 100, excused: 0, hidden: 0 }];
const world = (o = {}) => makeMockPool([
  ["FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])],
  ["FROM lms_grade_categories WHERE course_id = @c", (i) => (i.c === 5 ? CATS : [])], ["FROM lms_grade_items WHERE course_id = @c", (i) => (i.c === 5 ? (o.items || ITEMS) : [])],
  ["FROM lms_course_enrolments e", (i) => (i.c === 5 ? (o.learners || LEARNERS) : [])],
  ["FROM lms_grades g JOIN lms_grade_items i", (i) => (i.c === 5 ? (o.grades || GR) : [])],
  ["FROM GradingSystem", () => []],
]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const lines = (csv) => csv.split("\r\n");

test("buildCsv (pure) + exportGradebook: header, staff-view numbers (hidden and unreleased counted), EX / blank cells, hand-calculated totals and bands", async () => {
  const m = world(); const r = await X.exportGradebook(m.pool, teacher, 5); assert.ok(r.ok, JSON.stringify(r));
  const L = lines(r.csv); assert.strictEqual(L[L.length - 1], "", "ends with CRLF"); assert.strictEqual(L.length, 5);
  // header: 2 id columns + 3 items + 2 categories + 3 summary columns
  assert.strictEqual(L[0], 'Admission no,Name,T1 (/50),T2 (/100),"\'=HYPERLINK(""x"") (/20)",Tests %,Homework %,Total %,Grade,Items counted');
  // Amina: T1 80, T2 50 -> Tests 65; H1 hidden + unreleased still counted for staff: 50 -> Homework 50; total 65*.6 + 50*.4 = 59 -> band 5
  assert.strictEqual(L[1], "A1,Amina,40,50,10,65,50,59,5,3");
  // second learner: T1 excused, T2 100 -> Tests 100; H1 not graded -> Homework blank; total 100 -> band 1; 1 item counted
  assert.strictEqual(L[2], "A2,'=cmd|' /C calc'!A0,EX,100,,100,,100,1,1");
  assert.strictEqual(L[3], 'A3,"Brian, Jr.",,,,,,,,0', "nothing graded: blank total and grade (never 0), quoted comma");
  assert.deepStrictEqual([r.filename, r.learners, r.items], ["gradebook-course-5.csv", 3, 3]);
});

test("formula safety: names/titles that start with = + - @ are exported with a leading apostrophe, never raw", async () => {
  const bad = [{ student_id: 21, student_name: "+SUM(A1)", admission_no: "-1" }, { student_id: 22, student_name: "@x", admission_no: "=1+1" }];
  const r = await X.exportGradebook(world({ learners: bad }).pool, teacher, 5);
  for (const row of lines(r.csv).filter(Boolean)) for (const c of row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) assert.ok(!/^"?[=+\-@]/.test(c), `raw formula cell: ${c}`);
  assert.ok(/'\+SUM\(A1\)/.test(r.csv) && /'@x/.test(r.csv) && /'=1\+1/.test(r.csv) && /'-1/.test(r.csv));
});

test("bounded and scoped: <= 2000 learners, <= 100000 cells, one course only, parameterised ids, read-only except one audit row with counts only", async () => {
  const m = world(); const r = await X.exportGradebook(m.pool, teacher, 5);
  const g = m.log.find((x) => /FROM lms_grades g/.test(x.sql)); assert.strictEqual(g.inputs.c, 5); assert.deepStrictEqual(JSON.parse(g.inputs.ids), [21, 22, 23]);
  assert.ok(/TOP 100000/.test(g.sql) && /deleted_at IS NULL/.test(g.sql) && /g\.course_id = @c/.test(g.sql));
  assert.ok(/status = 'active'/.test(m.log.find((x) => /FROM lms_course_enrolments e/.test(x.sql)).sql) && /TOP 2001/.test(m.log.find((x) => /FROM lms_course_enrolments e/.test(x.sql)).sql));
  const writes = m.log.filter((x) => !/^\s*SELECT/i.test(x.sql)); assert.ok(writes.every((x) => /lms_audit_log/.test(x.sql)), "read only apart from the audit row");
  const a = audits(m); assert.strictEqual(a.length, 1); assert.ok(/gradebook\.exported/.test(JSON.stringify(a[0].inputs)));
  assert.ok(!/Amina|A1|calc/.test(JSON.stringify(a[0].inputs)), "no names or admission numbers in the audit row");
  const many = Array.from({ length: 2001 }, (_, i) => ({ student_id: i + 1, student_name: "n" + i, admission_no: "a" + i }));
  const t = await X.exportGradebook(world({ learners: many }).pool, teacher, 5); assert.deepStrictEqual([t.ok, t.code], [false, "TOO_MANY_LEARNERS"]);
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, category_id: 1, title: "i" + i, max_points: 10, weight: 1, released: 1 }));
  const bigL = Array.from({ length: 501 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" }));
  const b = world({ items, learners: bigL }); const br = await X.exportGradebook(b.pool, teacher, 5); assert.deepStrictEqual([br.ok, br.code], [false, "EXPORT_TOO_LARGE"]);
  assert.ok(!b.log.some((x) => /FROM lms_grades g/.test(x.sql)), "refused before the big grade query");
  assert.strictEqual(audits(b).length, 0, "a refused export is not audited as an export");
});

test("an empty course still exports a header; students, bad ids, other or missing courses and other tenants are not found", async () => {
  const e = await X.exportGradebook(world({ items: [], learners: [] }).pool, teacher, 5); assert.ok(e.ok); assert.strictEqual(lines(e.csv)[0], "Admission no,Name,Tests %,Homework %,Total %,Grade,Items counted");
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"], [teacher, 0]]) assert.strictEqual((await X.exportGradebook(world().pool, u, id)).notFound, true, `${JSON.stringify(u)} ${id}`);
  const q = world(); await X.exportGradebook(q.pool, teacher, "x"); assert.strictEqual(q.log.length, 0, "bad id = no query");
  const T = makeTenants({ A: [["FROM lms_courses WHERE id", () => []]], B: [] }); assert.strictEqual((await X.exportGradebook(T.A.pool, teacher, 5)).notFound, true); T.assertUntouched("B");
});

test("route: flag gate, view permission, course access, handler; CSV headers; refusals use the shared 409/404 shape; students hold no gradebook view", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const r = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/gradebook/export.csv" && l.route.methods.get); assert.ok(r); assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/\$\{GB\}\/export\.csv`, gbGate, gbView, staffAccess/.test(src), "flag first, then permission, then course membership");
  assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.gradebook.view"));
  const res = makeRes(); const h = {}; res.setHeader = (k, v) => { h[k] = v; }; res.send = (b) => { res.sent = b; };
  await r.route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, res);
  assert.strictEqual(res.statusCode, 200); assert.strictEqual(h["Content-Type"], "text/csv; charset=utf-8"); assert.strictEqual(h["X-Content-Type-Options"], "nosniff"); assert.strictEqual(h["Cache-Control"], "private, no-store");
  assert.strictEqual(h["Content-Disposition"], 'attachment; filename="gradebook-course-5.csv"'); assert.ok(/^Admission no,Name,/.test(res.sent));
  const r2 = makeRes(); r2.setHeader = () => {}; await r.route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "9" }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 404);
  const big = Array.from({ length: 2001 }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" })); const r3 = makeRes(); r3.setHeader = () => {};
  await r.route.stack[3].handle({ pool: world({ learners: big }).pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r3); assert.deepStrictEqual([r3.statusCode, r3.body.code], [409, "TOO_MANY_LEARNERS"]);
});
