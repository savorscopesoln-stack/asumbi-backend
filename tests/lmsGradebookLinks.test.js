/* L7.1c - linked grade items (assignment / quiz) and the re-runnable sync (D-087). Mocked pool only: the SQL itself (table variables, OUTPUT INTO, OPENJSON) is NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsGradebookLinks.test.js");
const L = require("../utils/lmsGradebookLinks"), G = require("../utils/lmsGradebook"), events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-11-20T08:00:00Z");
const live = (st = "published") => ["FROM lms_courses WHERE id", () => [{ status: st }]];
const ASG = (own = [5], row = { title: "Essay 1", max_points: 40 }) => ["FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL", onlyIds("c", own, [row])];
const QZ = (own = [5], row = { title: "CAT 1", assessment_type: "coursework", counts_to_grade: 1, quiz_mode: null }) => ["FROM lms_quizzes WHERE id = @z AND course_id = @c AND deleted_at IS NULL", onlyIds("c", own, [row])];
const INS = (fn) => ["INSERT INTO lms_grade_items", fn || ((i) => [{ id: 31, category_id: i.k, title: i.t, source_type: i.st, source_id: i.si, max_points: i.m, weight: i.w, released: i.rel, position: 4 }])];
const lrow = (o = {}) => ({ id: 3, category_id: null, title: "Essay 1", source_type: "assignment", source_id: 4, max_points: 40, weight: 1, released: 0, position: 1, ...o });
const ITEM = (row) => ["FROM lms_grade_items WHERE id = @i AND course_id = @c AND deleted_at IS NULL", () => (row ? [row] : [])];
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE |DELETE FROM/.test(x.sql) && !/lms_audit_log/.test(x.sql));
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));

test("validateLink (pure): sourceType assignment|quiz, positive id, optional category/weight/released, unknown fields refused", () => {
  assert.deepStrictEqual(L.validateLink({ sourceType: "quiz", sourceId: "4", categoryId: 2, weight: 3, released: true }).value, { sourceType: "quiz", sourceId: 4, categoryId: 2, weight: 3, released: true });
  assert.deepStrictEqual(L.validateLink({ sourceType: "assignment", sourceId: 1 }).value, { sourceType: "assignment", sourceId: 1, categoryId: null, weight: 1, released: false });
  for (const b of [null, [], {}, { sourceType: "manual", sourceId: 1 }, { sourceType: "quiz" }, { sourceType: "quiz", sourceId: 0 }, { sourceType: "quiz", sourceId: 1, weight: 101 }, { sourceType: "quiz", sourceId: 1, max: 5 }, { sourceType: "quiz", sourceId: 1, released: "y" }]) assert.strictEqual(L.validateLink(b).ok, false, JSON.stringify(b));
});

test("pickAssignmentScores (pure): newest RETURNED grade per learner wins, scaled to the item max, never above max or below 0, bad rows skipped", () => {
  const rows = [{ student_id: 2, final_points: 30, max_points: 40, id: 9 }, { student_id: 2, final_points: 10, max_points: 40, id: 8 }, { student_id: 1, final_points: 20, max_points: 40, id: 7 }, { student_id: "x", final_points: 1, max_points: 1 }, { student_id: 3, final_points: 5, max_points: 0 }, null];
  assert.deepStrictEqual(L.pickAssignmentScores(rows.filter(Boolean), 40), [{ studentId: 1, points: 20 }, { studentId: 2, points: 30 }]);
  assert.deepStrictEqual(L.pickAssignmentScores([{ student_id: 1, final_points: 50, max_points: 50 }], 100), [{ studentId: 1, points: 100 }], "assignment max changed: scaled");
  assert.deepStrictEqual(L.pickAssignmentScores([{ student_id: 1, final_points: 60, max_points: 50 }, { student_id: 2, final_points: -5, max_points: 50 }], 50), [{ studentId: 1, points: 50 }, { studentId: 2, points: 0 }]);
  assert.deepStrictEqual(L.pickAssignmentScores(null, 10), []);
});

test("linkItem: source must be a live item of THIS course; assignment max copied; quiz = 100 and coursework that counts only; one INSERT with the cap; audited; duplicate = ALREADY_LINKED", async () => {
  const a = makeMockPool([live(), ASG(), INS()]); const r = await L.linkItem(a.pool, teacher, 5, { sourceType: "assignment", sourceId: 4 }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.item.sourceType, r.item.sourceId, r.item.maxPoints, r.item.title, r.item.released], ["assignment", 4, 40, "Essay 1", false]);
  const q = a.log.find((x) => /INSERT INTO lms_grade_items/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.st, q.inputs.si, q.inputs.lim], [5, "assignment", 4, 200]); assert.ok(/< @lim/.test(q.sql)); assert.strictEqual(audits(a).length, 1);
  const z = makeMockPool([live(), QZ(), INS()]); const zr = await L.linkItem(z.pool, teacher, 5, { sourceType: "quiz", sourceId: 6, weight: 2 }); assert.deepStrictEqual([zr.ok, zr.item.maxPoints, zr.item.weight], [true, 100, 2]);
  for (const row of [{ title: "P", assessment_type: "practice", counts_to_grade: 0 }, { title: "P", assessment_type: "coursework", counts_to_grade: 0 }, { title: "R", assessment_type: "coursework", counts_to_grade: 1, quiz_mode: "revision" }, { title: "F", assessment_type: "coursework", counts_to_grade: 1, quiz_mode: "flashcards" }]) {
    const p = makeMockPool([live(), QZ([5], row), INS()]); assert.strictEqual((await L.linkItem(p.pool, teacher, 5, { sourceType: "quiz", sourceId: 6 })).code, "PRACTICE_NOT_GRADED"); assert.strictEqual(writes(p).length, 0);
  }
  assert.ok((await L.linkItem(makeMockPool([live(), QZ([5], { title: "M", assessment_type: "coursework", counts_to_grade: 1, quiz_mode: "mock" }), INS()]).pool, teacher, 5, { sourceType: "quiz", sourceId: 6 })).ok, "a counting mock is coursework");
  const other = makeMockPool([live(), ASG([9]), INS()]); assert.strictEqual((await L.linkItem(other.pool, teacher, 5, { sourceType: "assignment", sourceId: 4 })).notFound, true); assert.strictEqual(writes(other).length, 0);
  const badcat = makeMockPool([live(), ASG(), ["FROM lms_grade_categories WHERE id = @k", () => []], INS()]); assert.strictEqual((await L.linkItem(badcat.pool, teacher, 5, { sourceType: "assignment", sourceId: 4, categoryId: 9 })).ok, false); assert.strictEqual(writes(badcat).length, 0);
  const dup = { pool: { request: () => { const q2 = { input: () => q2, query: async (s) => { const t = s.replace(/\s+/g, " "); if (/INSERT INTO lms_grade_items/.test(t)) { const e = new Error("dup"); e.number = 2601; throw e; } if (/FROM lms_courses/.test(t)) return { recordset: [{ status: "published" }] }; if (/FROM lms_assignments/.test(t)) return { recordset: [{ title: "E", max_points: 10 }] }; return { recordset: [] }; } }; return q2; } } };
  assert.strictEqual((await L.linkItem(dup.pool, teacher, 5, { sourceType: "assignment", sourceId: 4 })).code, "ALREADY_LINKED");
  const full = makeMockPool([live(), ASG(), INS(() => [])]); assert.strictEqual((await L.linkItem(full.pool, teacher, 5, { sourceType: "assignment", sourceId: 4 })).code, "ITEM_LIMIT");
  assert.ok(!(await L.linkItem(makeMockPool([live("archived"), ASG(), INS()]).pool, teacher, 5, { sourceType: "assignment", sourceId: 4 })).ok);
});

const SYNC_OK = (o = {}) => ["INSERT INTO lms_grades (item_id", () => [{ inserted: 2, updated: 1, manual: 1, ...o }]];
const SUBG = (rows) => ["FROM lms_submission_grades WHERE assignment_id = @a AND course_id = @c AND status = 'returned'", (i) => (i.c === 5 && i.a === 4 ? rows : [])];

test("syncItem (assignment): only RETURNED grades of this assignment/course, newest first, ONE batch writes grades + system history, ACTIVE learners only, manual grades protected; counts; audit + event", async () => {
  const seen = []; const off = events.on("lms.gradebook.synced", (e) => { if (e.tenant === "qa-gl") seen.push(e); });
  const rows = [{ student_id: 21, final_points: 30, max_points: 40, id: 9 }, { student_id: 22, final_points: 20, max_points: 40, id: 8 }, { student_id: 23, final_points: 10, max_points: 40, id: 7 }, { student_id: 24, final_points: 40, max_points: 40, id: 6 }];
  const m = makeMockPool([live(), ITEM(lrow()), SUBG(rows), SYNC_OK()]); const r = await L.syncItem(m.pool, teacher, 5, 3, { tenant: "qa-gl", now: NOW }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.eligible, r.inserted, r.updated, r.skippedManual, r.unchanged, r.waitingForMarking], [4, 2, 1, 1, 0, 0]);
  const rd = m.log.find((x) => /SELECT TOP \d+ student_id, final_points/.test(x.sql)); assert.ok(/ORDER BY returned_at DESC, id DESC/.test(rd.sql) && /TOP 20000/.test(rd.sql));
  const w = m.log.find((x) => /INSERT INTO lms_grades \(item_id/.test(x.sql)); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && /INSERT INTO lms_grade_history/.test(w.sql) && /COMMIT/.test(w.sql), "grades and history in ONE batch");
  assert.ok(/e\.status = 'active'/.test(w.sql), "only active learners"); assert.ok(/g\.graded_by_source = 'System' AND ISNULL\(g\.points, -1\) <> r\.p/.test(w.sql), "only system-written grades are updated");
  assert.ok(/ISNULL\(g\.graded_by_source, N''\) <> 'System'/.test(w.sql), "manual grades are counted, never touched"); assert.ok(!/DELETE FROM/.test(w.sql));
  assert.deepStrictEqual(JSON.parse(w.inputs.rows), [{ s: 21, p: 30 }, { s: 22, p: 20 }, { s: 23, p: 10 }, { s: 24, p: 40 }]); assert.strictEqual(w.inputs.i, 3);
  assert.strictEqual(audits(m).length, 1); await tick(); off(); assert.deepStrictEqual(seen.map((e) => [e.courseId, e.itemId]), [[5, 3]]);
  const again = makeMockPool([live(), ITEM(lrow()), SUBG(rows), SYNC_OK({ inserted: 0, updated: 0, manual: 0 })]); const a2 = await L.syncItem(again.pool, teacher, 5, 3, {}); assert.deepStrictEqual([a2.inserted, a2.updated, a2.unchanged], [0, 0, 4], "running it again changes nothing");
});

test("syncItem (quiz): best graded attempt as a percentage of the item max, a learner with an attempt waiting is reported, nothing to sync runs no write", async () => {
  const att = [{ student_id: 21, attempt_no: 1, status: "graded", total_points: 6, max_points: 10 }, { student_id: 21, attempt_no: 2, status: "graded", total_points: 8, max_points: 10 }, { student_id: 22, attempt_no: 1, status: "submitted", total_points: null, max_points: 10 }, { student_id: 23, attempt_no: 1, status: "graded", total_points: 1, max_points: 3 }];
  const m = makeMockPool([live(), ITEM(lrow({ source_type: "quiz", source_id: 6, max_points: 100 })), ["FROM lms_quiz_attempts a", (i) => (i.c === 5 && i.z === 6 ? att : [])], SYNC_OK({ inserted: 2, updated: 0, manual: 0 })]);
  const r = await L.syncItem(m.pool, teacher, 5, 3, { now: NOW }); assert.deepStrictEqual([r.ok, r.eligible, r.inserted, r.waitingForMarking], [true, 2, 2, 1]);
  assert.deepStrictEqual(JSON.parse(m.log.find((x) => /INSERT INTO lms_grades \(item_id/.test(x.sql)).inputs.rows), [{ s: 21, p: 80 }, { s: 23, p: 33.33 }], "best attempt, percent of 100, 2 decimals");
  const e = makeMockPool([live(), ITEM(lrow({ source_type: "quiz", source_id: 6, max_points: 100 })), ["FROM lms_quiz_attempts a", () => []]]); const er = await L.syncItem(e.pool, teacher, 5, 3, {}); assert.deepStrictEqual([er.ok, er.eligible, er.inserted], [true, 0, 0]); assert.strictEqual(writes(e).length, 0);
});

test("syncItem refusals: manual item = NOT_LINKED, other course/unknown/bad ids not found, archived refused, nothing written; tenant B never queried", async () => {
  const man = makeMockPool([live(), ITEM(lrow({ source_type: "manual", source_id: null }))]); assert.strictEqual((await L.syncItem(man.pool, teacher, 5, 3, {})).code, "NOT_LINKED"); assert.strictEqual(writes(man).length, 0);
  assert.strictEqual((await L.syncItem(makeMockPool([live(), ITEM(null)]).pool, teacher, 5, 3, {})).notFound, true);
  for (const id of ["x", 0, -2]) assert.strictEqual((await L.syncItem(makeMockPool([]).pool, teacher, 5, id, {})).notFound, true);
  assert.strictEqual((await L.syncItem(makeMockPool([]).pool, null, 5, 3, {})).notFound, true);
  const arch = makeMockPool([live("archived"), ITEM(lrow()), SUBG([]), SYNC_OK()]); assert.strictEqual((await L.syncItem(arch.pool, teacher, 5, 3, {})).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(arch).length, 0);
  const T = makeTenants({ A: [live(), ITEM(null)], B: [live(), ITEM(lrow())] }); assert.strictEqual((await L.syncItem(T.A.pool, teacher, 5, 3, {})).notFound, true); T.assertUntouched("B");
});

test("a linked item's maximum cannot be edited (follows its source); manual items still can", async () => {
  const m = makeMockPool([live(), ITEM(lrow()), ["points > @m", () => []], ["UPDATE lms_grade_items SET", () => [lrow()]]]); const r = await G.updateItem(m.pool, teacher, 5, 3, { maxPoints: 10 }); assert.strictEqual(r.code, "LINKED_ITEM_MAX"); assert.strictEqual(writes(m).length, 0);
  assert.ok((await G.updateItem(m.pool, teacher, 5, 3, { weight: 2 })).ok, "other fields of a linked item are editable");
  const man = makeMockPool([live(), ITEM(lrow({ source_type: "manual", source_id: null })), ["points > @m", () => []], ["UPDATE lms_grade_items SET", () => [lrow({ source_type: "manual", max_points: 10 })]]]); assert.ok((await G.updateItem(man.pool, teacher, 5, 3, { maxPoints: 10 })).ok);
});

test("routes: link + sync = flag gate + permission + course access + handler, link needs manage, sync needs grade; handlers answer 201 / 200 and 404 on bad ids", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), GB = "/courses/:courseId/gradebook";
  const link = router.stack.find((l) => l.route && l.route.path === `${GB}/items/link` && l.route.methods.post), sync = router.stack.find((l) => l.route && l.route.path === `${GB}/items/:itemId/sync` && l.route.methods.post);
  assert.ok(link && sync); assert.strictEqual(link.route.stack.length, 4); assert.strictEqual(sync.route.stack.length, 4);
  assert.ok(/items\/link`, gbGate, gbManage, staffAccess/.test(src) && /items\/:itemId\/sync`, gbGate, gbGrade, staffAccess/.test(src));
  const r1 = makeRes(); await link.route.stack[3].handle({ pool: makeMockPool([live(), ASG(), INS()]).pool, user: teacher, params: { courseId: "5" }, body: { sourceType: "assignment", sourceId: 4 }, tenant: "t" }, r1); assert.deepStrictEqual([r1.statusCode, r1.body.success, r1.body.item.id], [201, true, 31]);
  const r2 = makeRes(); await sync.route.stack[3].handle({ pool: makeMockPool([live(), ITEM(lrow()), SUBG([]), SYNC_OK()]).pool, user: teacher, params: { courseId: "5", itemId: "3" }, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.success, r2.body.eligible, "ok" in r2.body], [200, true, 0, false]);
  const r3 = makeRes(); await sync.route.stack[3].handle({ pool: makeMockPool([]).pool, user: teacher, params: { courseId: "5", itemId: "abc" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); await link.route.stack[3].handle({ pool: makeMockPool([live()]).pool, user: teacher, params: { courseId: "5" }, body: { sourceType: "x" }, tenant: "t" }, r4); assert.strictEqual(r4.statusCode, 400);
  assert.ok(events.EVENTS.includes("lms.gradebook.synced"));
});
