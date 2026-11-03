/* L7.1b - gradebook staff routes (D-086): validators, categories, manual items, grade entry with history in ONE batch, the grid, route gates.
   Mocked pool only: the SQL itself (OUTPUT, OFFSET/FETCH, OPENJSON, XACT_ABORT batch) is NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsGradebook.test.js");
const G = require("../utils/lmsGradebook"), events = require("../utils/lmsEvents"), P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const NOW = new Date("2026-11-20T08:00:00Z");
const irow = (o = {}) => ({ id: 3, category_id: 1, title: "Test 1", source_type: "manual", source_id: null, max_points: 50, weight: 1, released: 0, position: 1, ...o });
const crow = (o = {}) => ({ id: 1, name: "Tests", weight: 60, drop_lowest: 0, position: 1, ...o });

const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const CAT = (rows = [crow()], own = [5]) => ["FROM lms_grade_categories WHERE id = @k AND course_id = @c", onlyIds("c", own, (i) => rows.filter((r) => r.id === i.k))];
const ITEM = (rows = [irow()], own = [5]) => ["FROM lms_grade_items WHERE id = @i AND course_id = @c AND deleted_at IS NULL", onlyIds("c", own, (i) => rows.filter((r) => r.id === i.i))];
const ENR = (ids = [21]) => ["FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s AND status = 'active'", (i) => (ids.includes(i.s) ? [{ student_id: i.s }] : [])];
const EXIST = (row = null) => ["FROM lms_grades WHERE item_id = @i AND course_id = @c AND student_id = @s", () => (row ? [row] : [])];
const WRITE_OK = (key) => [key, () => [{ n: 1 }]];
const ins = (m) => m.log.find((x) => /INSERT INTO lms_grades \(/.test(x.sql));
const upd = (m) => m.log.find((x) => /UPDATE lms_grades SET/.test(x.sql));
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE |DELETE FROM/.test(x.sql) && !/lms_audit_log/.test(x.sql));
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));

test("dec2 and the validators: ranges, 2 decimals, unknown fields, partial bodies, nothing-to-change", () => {
  assert.deepStrictEqual([G.dec2(1.25, 0, 5), G.dec2("2", 0, 5), G.dec2(1.255, 0, 5), G.dec2(5.01, 0, 5), G.dec2(-0.01, 0, 5), G.dec2(NaN, 0, 5), G.dec2("", 0, 5), G.dec2(null, 0, 5), G.dec2(0.1 + 0.2, 0, 5)], [1.25, 2, null, null, null, null, null, null, 0.3]);
  assert.deepStrictEqual(G.validateCategory({ name: " <b>Tests</b> ", weight: "60", dropLowest: 1 }).value, { name: "bTests/b", weight: 60, dropLowest: 1 });
  for (const b of [{}, { name: "" }, { name: "x".repeat(101) }, { name: "a", weight: 100.01 }, { name: "a", weight: -1 }, { name: "a", dropLowest: 21 }, { name: "a", dropLowest: 1.5 }, { name: "a", nope: 1 }, null, [], { name: "a", position: -1 }]) assert.strictEqual(G.validateCategory(b).ok, false, JSON.stringify(b));
  assert.strictEqual(G.validateCategory({}, { partial: true }).ok, false); assert.deepStrictEqual(G.validateCategory({ weight: 0 }, { partial: true }).value, { weight: 0 });
  assert.deepStrictEqual(G.validateItem({ title: "T", maxPoints: 50, categoryId: "2", released: true }).value, { title: "T", maxPoints: 50, categoryId: 2, released: true });
  for (const b of [{ title: "T" }, { maxPoints: 5 }, { title: "T", maxPoints: 0 }, { title: "T", maxPoints: 10000.01 }, { title: "T", maxPoints: 5, released: "yes" }, { title: "T", maxPoints: 5, categoryId: 0 }, { title: "T", maxPoints: 5, weight: 101 }, { title: "T", maxPoints: 5, sourceType: "quiz" }]) assert.strictEqual(G.validateItem(b).ok, false, JSON.stringify(b));
  assert.strictEqual(G.validateItem({ categoryId: null }, { partial: true }).value.categoryId, null);
  assert.deepStrictEqual(G.validateGrade({ points: "40.5", comment: " ok ", reason: " typo " }, 50).value, { points: 40.5, comment: "ok", reason: "typo" });
  for (const b of [{}, { reason: "x" }, { points: 50.01 }, { points: -1 }, { points: "abc" }, { excused: "no" }, { comment: 5 }, { comment: "c".repeat(1001) }, { points: 1, reason: "r".repeat(301) }, { points: 1, extra: 1 }]) assert.strictEqual(G.validateGrade(b, 50).ok, false, JSON.stringify(b));
  assert.strictEqual(G.validateGrade({ points: 50 }, 50).ok, true, "full marks allowed"); assert.strictEqual(G.validateGrade({ points: null }, 50).value.points, null);
});

test("planGrade (pure): first entry, unchanged, changed values need a reason, hidden/comment alone do not", () => {
  const ex = { id: 9, points: 30, excused: 0, hidden: 0, comment: null };
  assert.deepStrictEqual([G.planGrade(null, { points: 30 }).changed, G.planGrade(null, { points: 30 }).needsReason], [true, false]);
  assert.deepStrictEqual([G.planGrade(ex, { points: 30 }).changed, G.planGrade(ex, { points: "30.00" }).changed], [false, false], "same value = unchanged");
  assert.deepStrictEqual([G.planGrade(ex, { points: 31 }).changed, G.planGrade(ex, { points: 31 }).needsReason, G.planGrade(ex, { points: null }).needsReason, G.planGrade(ex, { excused: true }).needsReason], [true, true, true, true]);
  const h = G.planGrade(ex, { hidden: true }); assert.deepStrictEqual([h.changed, h.needsReason, h.next.hidden, h.next.points], [true, false, true, 30]);
  assert.deepStrictEqual([G.planGrade(ex, { comment: "Good" }).needsReason, G.planGrade(ex, { comment: "Good" }).next.comment], [false, "Good"]);
  const blank = { id: 9, points: null, excused: 0, hidden: 0, comment: "note" }; assert.strictEqual(G.planGrade(blank, { points: 12 }).needsReason, false, "an ungraded row has nothing to explain");
  assert.strictEqual(G.planGrade({ ...ex, comment: "a" }, { comment: null }).changed, true);
});

test("createCategory: validated before any query, course must be editable, one scoped INSERT with the 30 cap, audited; limit and archived refused", async () => {
  const m0 = makeMockPool([]); assert.strictEqual((await G.createCategory(m0.pool, teacher, 5, { name: "" })).ok, false); assert.strictEqual(m0.log.length, 0, "a bad body touches no table");
  const m = makeMockPool([live(), ["INSERT INTO lms_grade_categories", (i) => [{ id: 11, name: i.n, weight: i.w, drop_lowest: i.d, position: 4 }]]]);
  const r = await G.createCategory(m.pool, teacher, 5, { name: "Homework", weight: 40, dropLowest: 2 }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.category, { id: 11, name: "Homework", weight: 40, dropLowest: 2, position: 4 });
  const q = m.log.find((x) => /INSERT INTO lms_grade_categories/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.n, q.inputs.w, q.inputs.d, q.inputs.lim, q.inputs.uid, q.inputs.src], [5, "Homework", 40, 2, 30, 7, "Teachers"]);
  assert.ok(/WHERE \(SELECT COUNT\(\*\) FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL\) < @lim/.test(q.sql)); assert.strictEqual(audits(m).length, 1);
  const full = makeMockPool([live(), ["INSERT INTO lms_grade_categories", () => []]]); assert.strictEqual((await G.createCategory(full.pool, teacher, 5, { name: "X" })).code, "CATEGORY_LIMIT");
  for (const st of ["archived", "pending"]) { const a = makeMockPool([live(st)]); const x = await G.createCategory(a.pool, teacher, 5, { name: "X" }); assert.ok(!x.ok && /COURSE_/.test(x.code)); assert.strictEqual(writes(a).length, 0); }
  assert.ok(G.MAX_CATEGORIES === 30 && G.MAX_ITEMS === 200);
});

test("updateCategory / deleteCategory: scoped by course, only sent fields change; delete is soft and moves its items to 'no category' in the SAME batch; another course's id is not found", async () => {
  const m = makeMockPool([live(), CAT(), ["UPDATE lms_grade_categories SET", (i) => [{ id: i.k, name: "Quizzes", weight: i.w, drop_lowest: 1, position: 1 }]]]);
  const r = await G.updateCategory(m.pool, teacher, 5, 1, { weight: 25 }); assert.ok(r.ok); assert.strictEqual(r.category.weight, 25);
  const q = m.log.find((x) => /UPDATE lms_grade_categories SET/.test(x.sql)); assert.ok(/SET weight = @w, updated_at = @now/.test(q.sql) && !/name = |drop_lowest = /.test(q.sql), q.sql.slice(0, 120)); assert.ok(/WHERE id = @k AND course_id = @c AND deleted_at IS NULL/.test(q.sql));
  assert.strictEqual((await G.updateCategory(m.pool, teacher, 5, 1, {})).ok, false);
  const other = makeMockPool([live(), CAT([crow()], [9])]); assert.strictEqual((await G.updateCategory(other.pool, teacher, 5, 1, { weight: 1 })).notFound, true); assert.strictEqual(writes(other).length, 0);
  const d = makeMockPool([live(), CAT(), ["UPDATE lms_grade_categories SET deleted_at", () => [{ n: 1, moved: 3 }]]]);
  const x = await G.deleteCategory(d.pool, teacher, 5, 1); assert.deepStrictEqual([x.ok, x.itemsUncategorised], [true, 3]);
  const b = d.log.find((l) => /deleted_at = @now/.test(l.sql)); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(b.sql) && /UPDATE lms_grade_items SET category_id = NULL/.test(b.sql) && /COMMIT/.test(b.sql), "one transaction");
  assert.ok(!/DELETE FROM/.test(b.sql), "soft delete only"); assert.strictEqual(audits(d).length, 1);
  const none = makeMockPool([live(), CAT(), ["UPDATE lms_grade_categories SET deleted_at", () => [{ n: 0, moved: 0 }]]]); assert.strictEqual((await G.deleteCategory(none.pool, teacher, 5, 1)).notFound, true, "lost a race = not found");
});

test("createItem: category must belong to the course, manual source, 200 cap, scoped INSERT; updateItem: only sent fields, lowering the max below a given grade is refused; deleteItem is soft", async () => {
  const bad = makeMockPool([live(), CAT([], [5])]); assert.strictEqual((await G.createItem(bad.pool, teacher, 5, { title: "T", maxPoints: 10, categoryId: 99 })).ok, false); assert.strictEqual(writes(bad).length, 0);
  const m = makeMockPool([live(), CAT(), ["INSERT INTO lms_grade_items", (i) => [irow({ id: 12, title: i.t, max_points: i.m, weight: i.w, released: i.rel, category_id: i.k })]]]);
  const r = await G.createItem(m.pool, teacher, 5, { title: "Test 2", maxPoints: 100, categoryId: 1 }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.item.id, r.item.maxPoints, r.item.weight, r.item.released, r.item.sourceType], [12, 100, 1, false, "manual"]);
  const q = m.log.find((x) => /INSERT INTO lms_grade_items/.test(x.sql)); assert.ok(/'manual', NULL/.test(q.sql) && /< @lim/.test(q.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.lim, q.inputs.rel], [5, 200, 0]);
  const full = makeMockPool([live(), ["INSERT INTO lms_grade_items", () => []]]); assert.strictEqual((await G.createItem(full.pool, teacher, 5, { title: "T", maxPoints: 1 })).code, "ITEM_LIMIT");
  const u = makeMockPool([live(), ITEM(), ["FROM lms_grades WHERE item_id = @i AND course_id = @c AND points > @m", () => []], ["UPDATE lms_grade_items SET", (i) => [irow({ title: i.t, released: i.rel })]]]);
  const ur = await G.updateItem(u.pool, teacher, 5, 3, { title: "Renamed", released: true }); assert.ok(ur.ok); assert.ok(!u.log.some((x) => /points > @m/.test(x.sql)), "no max change = no check");
  const uq = u.log.find((x) => /UPDATE lms_grade_items SET/.test(x.sql)); assert.ok(/SET title = @t, released = @rel, updated_at = @now/.test(uq.sql) && /course_id = @c/.test(uq.sql));
  const ex = makeMockPool([live(), ITEM(), ["points > @m", () => [{ id: 1 }]]]); const er = await G.updateItem(ex.pool, teacher, 5, 3, { maxPoints: 20 }); assert.strictEqual(er.code, "GRADES_EXCEED_MAX"); assert.strictEqual(writes(ex).length, 0);
  const d = makeMockPool([live(), ITEM(), ["UPDATE lms_grade_items SET deleted_at", () => [{ id: 3 }]]]); assert.ok((await G.deleteItem(d.pool, teacher, 5, 3)).deleted); assert.ok(!d.log.some((x) => /DELETE FROM/.test(x.sql)), "grades and history stay");
  assert.strictEqual((await G.deleteItem(makeMockPool([live(), ITEM([irow()], [9])]).pool, teacher, 5, 3)).notFound, true);
});

test("setGrade, first entry: ONE batch inserts the grade AND its history row (same transaction), all values are parameters, audited, ONE event with ids only", async () => {
  const seen = []; const off = events.on("lms.grade.entered", (e) => { if (e.tenant === "qa-gb") seen.push(e); }); // tests run concurrently: ignore other tests' events
  const m = makeMockPool([live(), ITEM(), ENR(), EXIST(null), WRITE_OK("INSERT INTO lms_grades (")]);
  const r = await G.setGrade(m.pool, teacher, 5, 3, 21, { points: 40, comment: "Well done" }, { tenant: "qa-gb", now: NOW }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.grade, { points: 40, excused: false, hidden: false, comment: "Well done" }); assert.strictEqual(r.unchanged, false);
  const q = ins(m); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(q.sql) && /INSERT INTO lms_grade_history/.test(q.sql) && /COMMIT/.test(q.sql), "grade + history in one batch");
  assert.deepStrictEqual([q.inputs.c, q.inputs.i, q.inputs.s, q.inputs.p, q.inputs.e, q.inputs.h, q.inputs.uid, q.inputs.src], [5, 3, 21, 40, 0, 0, 7, "Teachers"]);
  assert.strictEqual(m.log.filter((x) => /lms_grade_history/.test(x.sql)).length, 1, "history is not written by a second request"); assert.strictEqual(audits(m).length, 1);
  await tick(); off(); assert.deepStrictEqual(seen.map((e) => [e.tenant, e.courseId, e.itemId, e.studentId]), [["qa-gb", 5, 3, 21]]); assert.ok(events.EVENTS.includes("lms.grade.entered"));
  assert.ok(!/Well done|student_name/.test(JSON.stringify(audits(m).map((a) => a.inputs))), "no comment text in the audit log");
});

test("setGrade, change: a reason is required for an entered grade; the UPDATE is guarded by the values the teacher saw and writes history in the same batch; unchanged = no write; hidden/comment alone need no reason", async () => {
  const row = { id: 9, points: 30, excused: 0, hidden: 0, comment: null };
  const w = () => makeMockPool([live(), ITEM(), ENR(), EXIST(row), WRITE_OK("UPDATE lms_grades SET")]);
  const no = w(); const nr = await G.setGrade(no.pool, teacher, 5, 3, 21, { points: 35 }, { now: NOW }); assert.strictEqual(nr.ok, false); assert.ok(/reason/.test(nr.errors[0])); assert.strictEqual(writes(no).length, 0);
  const m = w(); const r = await G.setGrade(m.pool, teacher, 5, 3, 21, { points: 35, reason: "Re-marked" }, { now: NOW }); assert.ok(r.ok && !r.unchanged);
  const q = upd(m); assert.ok(/ISNULL\(points, -1\) = ISNULL\(@op, -1\) AND excused = @oe AND hidden = @oh/.test(q.sql) && /IF @n = 1 INSERT INTO lms_grade_history/.test(q.sql), q.sql.slice(0, 300));
  assert.deepStrictEqual([q.inputs.g, q.inputs.op, q.inputs.p, q.inputs.why], [9, 30, 35, "Re-marked"]);
  const same = w(); const u = await G.setGrade(same.pool, teacher, 5, 3, 21, { points: 30 }, { now: NOW }); assert.deepStrictEqual([u.ok, u.unchanged], [true, true]); assert.strictEqual(writes(same).length, 0); assert.strictEqual(audits(same).length, 0, "nothing changed, nothing audited");
  const h = w(); const hr = await G.setGrade(h.pool, teacher, 5, 3, 21, { hidden: true }, { now: NOW }); assert.ok(hr.ok && hr.grade.hidden === true && hr.grade.points === 30); assert.strictEqual(upd(h).inputs.h, 1);
  const x = w(); assert.ok((await G.setGrade(x.pool, teacher, 5, 3, 21, { excused: true, reason: "Absent, medical" }, { now: NOW })).ok); assert.strictEqual(upd(x).inputs.e, 1);
  const blank = makeMockPool([live(), ITEM(), ENR(), EXIST({ id: 9, points: null, excused: 0, hidden: 0, comment: null }), WRITE_OK("UPDATE lms_grades SET")]); assert.ok((await G.setGrade(blank.pool, teacher, 5, 3, 21, { points: 12 }, { now: NOW })).ok, "ungraded row: no reason needed");
});

test("setGrade, races and refusals: a lost guard or a duplicate key is 409 CHANGED with nothing audited; over the max, not enrolled, other course, withdrawn learner, archived course all refused before any write", async () => {
  const row = { id: 9, points: 30, excused: 0, hidden: 0, comment: null };
  const lost = makeMockPool([live(), ITEM(), ENR(), EXIST(row), ["UPDATE lms_grades SET", () => [{ n: 0 }]]]); assert.strictEqual((await G.setGrade(lost.pool, teacher, 5, 3, 21, { points: 31, reason: "r" })).code, "CHANGED"); assert.strictEqual(audits(lost).length, 0);
  const dup = { pool: { request: () => { const q = { input: () => q, query: async (s) => { if (/INSERT INTO lms_grades \(/.test(s)) { const e = new Error("dup"); e.number = 2627; throw e; } const t = s.replace(/\s+/g, " "); if (/FROM lms_courses/.test(t)) return { recordset: [{ status: "published" }] }; if (/lms_grade_items/.test(t)) return { recordset: [irow()] }; if (/lms_course_enrolments/.test(t)) return { recordset: [{ student_id: 21 }] }; return { recordset: [] }; } }; return q; } } };
  assert.strictEqual((await G.setGrade(dup.pool, teacher, 5, 3, 21, { points: 10 })).code, "CHANGED");
  const over = makeMockPool([live(), ITEM(), ENR(), EXIST(null)]); assert.strictEqual((await G.setGrade(over.pool, teacher, 5, 3, 21, { points: 50.5 })).ok, false); assert.strictEqual(writes(over).length, 0);
  const ne = makeMockPool([live(), ITEM(), ENR([99]), EXIST(null)]); assert.strictEqual((await G.setGrade(ne.pool, teacher, 5, 3, 21, { points: 5 })).notFound, true); assert.strictEqual(writes(ne).length, 0);
  assert.ok(/status = 'active'/.test(ne.log.find((x) => /lms_course_enrolments/.test(x.sql)).sql), "only ACTIVE learners can be graded");
  const oc = makeMockPool([live(), ITEM([irow()], [9]), ENR(), EXIST(null)]); assert.strictEqual((await G.setGrade(oc.pool, teacher, 5, 3, 21, { points: 5 })).notFound, true);
  for (const [i, s] of [["x", 21], [3, "x"], [0, 21], [3, -1]]) assert.strictEqual((await G.setGrade(makeMockPool([]).pool, teacher, 5, i, s, { points: 1 })).notFound, true);
  assert.strictEqual((await G.setGrade(makeMockPool([]).pool, null, 5, 3, 21, { points: 1 })).notFound, true);
  const arch = makeMockPool([live("archived"), ITEM(), ENR(), EXIST(null)]); assert.strictEqual((await G.setGrade(arch.pool, teacher, 5, 3, 21, { points: 1 })).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(arch).length, 0);
});

test("tenant isolation: tenant B is never queried, and its ids (item, learner) look exactly like missing ones from tenant A", async () => {
  const T = makeTenants({ A: [live(), ITEM([irow()], [5]), ENR([21]), EXIST(null), WRITE_OK("INSERT INTO lms_grades (")], B: [live(), ITEM([irow({ id: 77 })], [6]), ENR([88]), EXIST(null), WRITE_OK("INSERT INTO lms_grades (")] });
  assert.strictEqual((await G.setGrade(T.A.pool, teacher, 5, 77, 21, { points: 5 })).notFound, true, "B's item id");
  assert.strictEqual((await G.setGrade(T.A.pool, teacher, 5, 3, 88, { points: 5 })).notFound, true, "B's learner id");
  assert.strictEqual((await G.setGrade(T.A.pool, teacher, 6, 3, 21, { points: 5 })).notFound, true, "another course id");
  T.assertUntouched("B"); assert.ok((await G.setGrade(T.A.pool, teacher, 5, 3, 21, { points: 5 })).ok);
  assert.strictEqual(T.A.log.filter((x) => /INSERT INTO lms_grades \(/.test(x.sql)).length, 1, "only the one valid call wrote");
});

const CATS = [crow({ id: 1, name: "Tests", weight: 60 }), crow({ id: 2, name: "Homework", weight: 40, position: 2 })];
const ITEMS = [irow({ id: 1, category_id: 1, max_points: 50, title: "T1", position: 1 }), irow({ id: 2, category_id: 1, max_points: 100, title: "T2", position: 2 }), irow({ id: 3, category_id: 2, max_points: 10, title: "H1", position: 3 })];
const LEARNERS = [{ student_id: 21, student_name: "Amina", admission_no: "A1" }, { student_id: 22, student_name: "Brian", admission_no: "A2" }, { student_id: 23, student_name: "Chebet", admission_no: "A3" }];
const GR = [
  { item_id: 1, student_id: 21, points: 40, excused: 0, hidden: 0, comment: "x" }, { item_id: 2, student_id: 21, points: 50, excused: 0, hidden: 0, comment: null }, { item_id: 3, student_id: 21, points: 10, excused: 0, hidden: 1, comment: null },
  { item_id: 1, student_id: 23, points: null, excused: 1, hidden: 0, comment: null }, { item_id: 2, student_id: 23, points: 100, excused: 0, hidden: 0, comment: null },
];
const gworld = (o = {}) => makeMockPool([
  ["FROM lms_grade_categories WHERE course_id = @c", (i) => (i.c === 5 ? (o.cats || CATS) : [])], ["FROM lms_grade_items WHERE course_id = @c", (i) => (i.c === 5 ? (o.items || ITEMS) : [])],
  ["SELECT COUNT(*) AS n FROM lms_course_enrolments", (i) => [{ n: o.total ?? 3 }]], ["FROM lms_course_enrolments e LEFT JOIN Students st", () => o.learners || LEARNERS],
  ["FROM lms_grades g JOIN lms_grade_items i", (i) => (i.c === 5 ? (o.grades || GR).filter((g) => JSON.parse(i.ids).includes(g.student_id)) : [])],
]);

test("listGradebook: staff-view totals match the hand calculation (hidden grades still count for staff, excused is left out, nothing graded = null), grades are read only for the page's learners", async () => {
  const m = gworld(); const r = await G.listGradebook(m.pool, 5, {}); assert.ok(r.ok);
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.hasMore, r.items.length, r.categories.length], [3, 1, 30, false, 3, 2]);
  const [a, b, c] = r.learners;
  // Amina: T1 40/50 = 80, T2 50/100 = 50 -> Tests 65; H1 10/10 = 100 (hidden, but staff see it) -> 0.6*65 + 0.4*100 = 79
  assert.deepStrictEqual([a.studentId, a.percent, a.itemsCounted, a.itemsLeftOut], [21, 79, 3, 0]); assert.deepStrictEqual(a.grades[3], { points: 10, excused: false, hidden: true, hasComment: false }); assert.strictEqual(a.grades[1].hasComment, true);
  assert.deepStrictEqual([b.percent, b.itemsCounted, b.grades], [null, 0, {}]);
  // Chebet: T1 excused (left out), T2 100 -> Tests 100; Homework has nothing -> only Tests counts, weights re-scaled -> 100
  assert.deepStrictEqual([c.percent, c.itemsCounted, c.itemsLeftOut], [100, 1, 2]);
  assert.ok(!/"comment"/.test(JSON.stringify(r.learners)), "comment text is not in the grid");
  const g = m.log.find((x) => /FROM lms_grades g JOIN/.test(x.sql)); assert.deepStrictEqual(JSON.parse(g.inputs.ids), [21, 22, 23]); assert.ok(/g\.course_id = @c/.test(g.sql) && /i\.deleted_at IS NULL/.test(g.sql) && /OPENJSON\(@ids\)/.test(g.sql) && /TOP 20000/.test(g.sql));
  for (const x of m.log) assert.ok(/@c\b/.test(x.sql), "every query is scoped by course: " + x.sql.slice(0, 50)); assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
});

test("listGradebook paging: size capped at 100, OFFSET from the page, hasMore, and an empty course or no items runs no grade query", async () => {
  const m = gworld({ total: 250, learners: LEARNERS.slice(0, 1) }); const r = await G.listGradebook(m.pool, 5, { page: 2, pageSize: 100 }); assert.deepStrictEqual([r.page, r.pageSize, r.hasMore], [2, 100, true]);
  const l = m.log.find((x) => /OFFSET @off ROWS FETCH NEXT @size/.test(x.sql)); assert.deepStrictEqual([l.inputs.off, l.inputs.size], [100, 100]); assert.ok(/status = 'active'/.test(l.sql));
  assert.strictEqual((await G.listGradebook(gworld().pool, 5, { pageSize: 5000 })).pageSize, 100); const d = await G.listGradebook(gworld().pool, 5, { page: -4, pageSize: "x" }); assert.deepStrictEqual([d.page, d.pageSize], [1, 30]);
  const e = gworld({ learners: [], total: 0 }); const er = await G.listGradebook(e.pool, 5, {}); assert.deepStrictEqual([er.learners, er.hasMore], [[], false]); assert.ok(!e.log.some((x) => /lms_grades g/.test(x.sql)));
  const ni = gworld({ items: [] }); assert.ok(!ni.log.some((x) => /lms_grades g/.test(x.sql)) || true); await G.listGradebook(ni.pool, 5, {}); assert.ok(!ni.log.some((x) => /FROM lms_grades g/.test(x.sql)), "no items = no grade query");
  const other = await G.listGradebook(gworld().pool, 6, {}); assert.deepStrictEqual([other.items, other.categories], [[], []], "another course's id returns nothing of this one");
});

test("gradeHistory: scoped to item, course AND learner, newest first, capped; an item of another course is not found; no write", async () => {
  const H = [{ id: 5, old_points: 30, new_points: 35, old_excused: 0, new_excused: 0, reason: "Re-marked", changed_by_source: "Teachers", changed_by: 7, changed_at: NOW }, { id: 4, old_points: null, new_points: 30, old_excused: null, new_excused: 0, reason: null, changed_by_source: "Teachers", changed_by: 7, changed_at: NOW }];
  const m = makeMockPool([ITEM(), ["FROM lms_grade_history WHERE item_id = @i AND course_id = @c AND student_id = @s", () => H]]); const r = await G.gradeHistory(m.pool, 5, 3, 21);
  assert.deepStrictEqual([r.ok, r.history.length, r.history[0].oldPoints, r.history[0].newPoints, r.history[0].reason, r.history[1].oldPoints, r.history[1].oldExcused], [true, 2, 30, 35, "Re-marked", null, null]);
  const q = m.log.find((x) => /lms_grade_history/.test(x.sql)); assert.ok(/TOP 100/.test(q.sql) && /ORDER BY id DESC/.test(q.sql)); assert.deepStrictEqual([q.inputs.i, q.inputs.c, q.inputs.s], [3, 5, 21]);
  assert.strictEqual((await G.gradeHistory(makeMockPool([ITEM([irow()], [9])]).pool, 5, 3, 21)).notFound, true); assert.strictEqual((await G.gradeHistory(makeMockPool([]).pool, 5, "x", 21)).notFound, true);
});

test("routes: gradebook routes, each = flag gate + permission + course access + handler; flag lms_gradebook first; right permission per action; bad ids are 404; success shapes", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const GB = "/courses/:courseId/gradebook", want = [["get", GB], ["post", `${GB}/categories`], ["patch", `${GB}/categories/:categoryId`], ["delete", `${GB}/categories/:categoryId`], ["post", `${GB}/items`], ["patch", `${GB}/items/:itemId`], ["delete", `${GB}/items/:itemId`], ["put", `${GB}/items/:itemId/grades/:studentId`], ["get", `${GB}/items/:itemId/grades/:studentId/history`]];
  const found = want.map(([mth, p]) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[mth])); assert.ok(found.every(Boolean), "all routes exist"); for (const f of found) assert.strictEqual(f.route.stack.length, 4);
  assert.ok(/gbGate = requireModule\("lms", "lms_gradebook"\)/.test(src) && /gbView = requireLmsPermission\("lms\.gradebook\.view"\)/.test(src) && /gbManage = requireLmsPermission\("lms\.course\.manage"\)/.test(src) && /gbGrade = requireLmsPermission\("lms\.submission\.grade"\)/.test(src));
  assert.strictEqual((src.match(/gbGate, gbView, staffAccess/g) || []).length, 10, "grid + history + CSV export (L7.4a) + certificate list (L7.5a) + badge list (L7.5b) + 2 reports (L7.6a) + progress CSV, submissions, teacher activity (L7.6b)"); assert.strictEqual((src.match(/gbGate, gbManage, staffAccess/g) || []).length, 11, "6 + link (L7.1c) + 4 badge create/award/edit/remove (L7.5b)"); assert.strictEqual((src.match(/gbGate, gbGrade, staffAccess/g) || []).length, 2, "grade entry + sync (L7.1c)");
  assert.ok(!P.roleDefaults({ role: "student" }).some((c) => c === "lms.gradebook.view" || c === "lms.submission.grade" || c === "lms.course.manage"), "students hold none of the three permissions");
  assert.ok(P.roleDefaults({ role: "teacher" }).includes("lms.gradebook.view"));
  const h = (mth, p) => found[want.findIndex(([a, b]) => a === mth && b === p)].route.stack[3].handle;
  const m = gworld(); const res = makeRes(); await h("get", GB)({ pool: m.pool, user: teacher, params: { courseId: "5" }, query: {}, tenant: "t" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.learners.length, "ok" in res.body], [200, true, 3, false]);
  const r1 = makeRes(); await h("patch", `${GB}/items/:itemId`)({ pool: m.pool, user: teacher, params: { courseId: "5", itemId: "abc" }, body: { title: "x" }, tenant: "t" }, r1); assert.strictEqual(r1.statusCode, 404);
  const r2 = makeRes(); await h("put", `${GB}/items/:itemId/grades/:studentId`)({ pool: m.pool, user: teacher, params: { courseId: "5", itemId: "3", studentId: "0" }, body: { points: 1 }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 404);
  const w = makeMockPool([live(), ITEM(), ENR(), EXIST(null), WRITE_OK("INSERT INTO lms_grades (")]); const r3 = makeRes(); await h("put", `${GB}/items/:itemId/grades/:studentId`)({ pool: w.pool, user: teacher, params: { courseId: "5", itemId: "3", studentId: "21" }, body: { points: 44 }, tenant: "t" }, r3);
  assert.deepStrictEqual([r3.statusCode, r3.body.success, r3.body.grade.points, r3.body.unchanged], [200, true, 44, false]);
  const r4 = makeRes(); await h("put", `${GB}/items/:itemId/grades/:studentId`)({ pool: makeMockPool([live(), ITEM(), ENR(), EXIST({ id: 9, points: 30, excused: 0, hidden: 0, comment: null })]).pool, user: teacher, params: { courseId: "5", itemId: "3", studentId: "21" }, body: { points: 45 }, tenant: "t" }, r4); assert.strictEqual(r4.statusCode, 400, "reason missing");
  const r5 = makeRes(); await h("post", `${GB}/categories`)({ pool: makeMockPool([live(), ["INSERT INTO lms_grade_categories", () => [crow({ id: 8 })]]]).pool, user: teacher, params: { courseId: "5" }, body: { name: "Tests", weight: 60 }, tenant: "t" }, r5); assert.deepStrictEqual([r5.statusCode, r5.body.category.id], [201, 8]);
  const r6 = makeRes(); await h("get", `${GB}/items/:itemId/grades/:studentId/history`)({ pool: makeMockPool([ITEM(), ["FROM lms_grade_history", () => []]]).pool, user: teacher, params: { courseId: "5", itemId: "3", studentId: "21" }, query: {}, tenant: "t" }, r6); assert.deepStrictEqual([r6.statusCode, r6.body.history], [200, []]);
});
