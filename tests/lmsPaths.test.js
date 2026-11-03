/* L9.3a - learning paths, staff side (D-108): an ordered list of existing lessons of one course. Mocked pool only: the SQL (UPDLOCK/HOLDLOCK insert, OPENJSON batch with ROLLBACK/RETURN) is NOT verified
   on a real SQL Server; the tests pin the guards in the query TEXT. F-2: no shared module export is patched here. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsPaths.test.js");
const P = require("../utils/lmsPaths");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const sub = (m, re) => m.log.filter((x) => re.test(x.sql));
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", () => (o.noCourse ? [] : [{ status: o.status || "published" }])],
  ["INSERT INTO lms_paths", () => (o.full ? [] : [{ id: 41 }])],
  ["UPDATE lms_paths SET title", () => (o.noPath ? [] : [{ id: 41 }])],
  ["UPDATE lms_paths SET deleted_at", () => (o.noPath ? [] : [{ id: 41 }])],
  ["DELETE FROM lms_path_items", () => [{ n: o.n ?? 2, code: o.code || null }]],
  ["i.lesson_id, i.position, l.title", () => [{ lesson_id: 3, position: 1, title: "Intro", status: "published" }, { lesson_id: 9, position: 2, title: "Draft one", status: "draft" }]],
  ["FROM lms_paths p WHERE p.id = @p", () => (o.noPath ? [] : [{ id: 41, title: "Catch-up", description: null, kind: "remedial", item_count: 2, learner_count: 0, created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:00Z" }])],
  ["FROM lms_paths p WHERE p.course_id = @c", () => [{ id: 41, title: "Catch-up", description: "x", kind: "remedial", item_count: 2, learner_count: 1, created_at: null, updated_at: null, total_count: 3 }]],
  ["audit", () => []],
]);

test("validatePath: title/kind/description rules, unknown fields, markup stripped, edit needs a field", () => {
  const ok = P.validatePath({ title: "  Fraction   catch-up <b>", description: "For <i>those</i> who missed week 3", kind: "remedial" });
  assert.deepStrictEqual(ok, { ok: true, value: { title: "Fraction catch-up b", description: "For ithose/i who missed week 3", kind: "remedial" } }); assert.ok(!/[<>]/.test(JSON.stringify(ok)), "angle brackets never survive (same plain-text rule as discussions)");
  for (const bad of [null, [], "x", {}, { title: "" }, { title: "x".repeat(101) }, { title: 5 }, { title: "a", kind: "gold" }, { title: "a", description: "x".repeat(501) }, { title: "a", extra: 1 }, { title: "a", description: 7 }]) assert.strictEqual(P.validatePath(bad).ok, false, JSON.stringify(bad));
  assert.deepStrictEqual(P.validatePath({ description: null }, true), { ok: true, value: { description: null } });
  assert.strictEqual(P.validatePath({}, true).ok, false); assert.strictEqual(P.validatePath({ kind: "enrichment" }, true).ok, true);
  assert.strictEqual(P.validatePath({ title: "x".repeat(100) }).ok, true, "100 is allowed");
});

test("validateItems: 0-50 distinct positive whole numbers, nothing else", () => {
  assert.deepStrictEqual(P.validateItems({ lessonIds: [3, 1, 2] }), { ok: true, value: { lessonIds: [3, 1, 2] } }); assert.strictEqual(P.validateItems({ lessonIds: [] }).ok, true, "an empty list clears the path");
  for (const bad of [null, {}, { lessonIds: "1" }, { lessonIds: [1, 1] }, { lessonIds: [0] }, { lessonIds: [-1] }, { lessonIds: [1.5] }, { lessonIds: ["1"] }, { lessonIds: [2147483648] }, { lessonIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { lessonIds: [1], x: 1 }]) assert.strictEqual(P.validateItems(bad).ok, false, JSON.stringify(bad));
  assert.strictEqual(P.validateItems({ lessonIds: Array.from({ length: 50 }, (_, i) => i + 1) }).ok, true);
});

test("createPath: inserts with the per-course cap INSIDE the statement, audits ids only; cap reached = 409 PATH_LIMIT; archived = COURSE_READ_ONLY; draft allowed", async () => {
  const m = world(); const r = await P.createPath(m.pool, teacher, "5", { title: "Catch-up", kind: "remedial" }); assert.deepStrictEqual([r.ok, r.id], [true, 41]);
  const q = sub(m, /INSERT INTO lms_paths/)[0]; assert.ok(/WITH \(UPDLOCK, HOLDLOCK\) WHERE course_id = @c AND deleted_at IS NULL\) < @max/.test(q.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.k, q.inputs.max, q.inputs.src, q.inputs.uid], [5, "remedial", 30, "Teachers", 7]);
  assert.strictEqual((await P.createPath(world({ full: true }).pool, teacher, 5, { title: "x" })).code, "PATH_LIMIT");
  assert.strictEqual((await P.createPath(world({ status: "archived" }).pool, teacher, 5, { title: "x" })).code, "COURSE_READ_ONLY");
  assert.strictEqual((await P.createPath(world({ status: "draft" }).pool, teacher, 5, { title: "x" })).ok, true, "a draft course may be prepared");
  assert.strictEqual((await P.createPath(world({ noCourse: true }).pool, teacher, 5, { title: "x" })).notFound, true);
  const bad = world(); assert.strictEqual((await P.createPath(bad.pool, teacher, 5, { title: "" })).ok, false); assert.strictEqual(bad.log.length, 0, "validation first, no query");
});

test("listPaths / getPath: course-scoped, paged, soft-deleted hidden, deleted lessons drop out, staff see draft lessons", async () => {
  const m = world(); const r = await P.listPaths(m.pool, teacher, 5, { pageSize: "500", page: "2", kind: "remedial" }); assert.ok(r.ok);
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items[0].itemCount, r.items[0].learnerCount], [3, 2, 50, 2, 1]); const q = sub(m, /FROM lms_paths p WHERE p\.course_id/)[0];
  assert.ok(/p\.course_id = @c AND p\.deleted_at IS NULL/.test(q.sql) && /OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY/.test(q.sql) && /l\.deleted_at IS NULL/.test(q.sql) && /pl\.withdrawn_at IS NULL/.test(q.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.k, q.inputs.off, q.inputs.lim], [5, "remedial", 50, 50]);
  assert.strictEqual(sub(world(), /x/).length, 0); const m2 = world(); await P.listPaths(m2.pool, teacher, 5, { kind: "weird" }); assert.strictEqual(sub(m2, /FROM lms_paths p WHERE p\.course_id/)[0].inputs.k, null);
  const g = await P.getPath(world().pool, teacher, 5, 41); assert.deepStrictEqual(g.path.items, [{ lessonId: 3, position: 1, title: "Intro", status: "published" }, { lessonId: 9, position: 2, title: "Draft one", status: "draft" }]);
  const m3 = world(); await P.getPath(m3.pool, teacher, 5, 41); const iq = sub(m3, /i\.lesson_id, i\.position, l\.title/)[0].sql; assert.ok(/l\.course_id = @c AND l\.deleted_at IS NULL/.test(iq) && /i\.course_id = @c/.test(iq) && /ORDER BY i\.position, i\.id/.test(iq));
  assert.strictEqual((await P.getPath(world({ noPath: true }).pool, teacher, 5, 41)).notFound, true); assert.strictEqual((await P.getPath(world().pool, teacher, 5, "abc")).notFound, true);
});

test("updatePath / removePath: guarded by course + not deleted; unknown path = 404; archived refused; remove is a soft delete", async () => {
  const m = world(); assert.ok((await P.updatePath(m.pool, teacher, 5, 41, { title: "New" })).ok); const q = sub(m, /UPDATE lms_paths SET title/)[0];
  assert.ok(/WHERE id = @p AND course_id = @c AND deleted_at IS NULL/.test(q.sql)); assert.deepStrictEqual([q.inputs.hasT, q.inputs.hasD, q.inputs.hasK, q.inputs.t], [true, false, false, "New"]);
  assert.strictEqual((await P.updatePath(world({ noPath: true }).pool, teacher, 5, 41, { title: "x" })).notFound, true); assert.strictEqual((await P.updatePath(world({ status: "archived" }).pool, teacher, 5, 41, { title: "x" })).code, "COURSE_READ_ONLY");
  assert.strictEqual((await P.updatePath(world().pool, teacher, 5, 41, {})).ok, false);
  const d = world(); assert.ok((await P.removePath(d.pool, teacher, 5, 41)).ok); const dq = sub(d, /UPDATE lms_paths SET deleted_at/)[0].sql; assert.ok(/WHERE id = @p AND course_id = @c AND deleted_at IS NULL/.test(dq) && !/DELETE FROM/i.test(dq));
  assert.strictEqual((await P.removePath(world({ noPath: true }).pool, teacher, 5, 41)).notFound, true); assert.strictEqual((await P.removePath(world({ status: "archived" }).pool, teacher, 5, 41)).code, "COURSE_READ_ONLY");
});

test("setItems: ONE transaction that checks the path and every lesson belong to THIS course before touching the list; BAD_LESSON / NOT_FOUND change nothing", async () => {
  const m = world(); const r = await P.setItems(m.pool, teacher, 5, 41, { lessonIds: [3, 9] }); assert.deepStrictEqual([r.ok, r.count], [true, 2]);
  const q = sub(m, /DELETE FROM lms_path_items/)[0], t = q.sql; assert.strictEqual(q.inputs.ids, "[3,9]");
  assert.ok(/SET XACT_ABORT ON; BEGIN TRAN;/.test(t) && /id = @p AND course_id = @c AND deleted_at IS NULL/.test(t) && /course_id = @c AND deleted_at IS NULL AND id IN \(SELECT CAST\(value AS INT\) FROM OPENJSON\(@ids\)\)/.test(t), "path and lessons are checked in SQL");
  assert.ok(/IF @ok <> @n BEGIN ROLLBACK;/.test(t) && t.indexOf("@ok <> @n") >= 0 && t.indexOf("@ok <> @n") < t.indexOf("DELETE FROM lms_path_items") && t.indexOf("DELETE FROM lms_path_items") < t.indexOf("INSERT INTO lms_path_items") && /ROLLBACK; SELECT CAST\(NULL AS INT\) AS n, N'BAD_LESSON'/.test(t), "validate, then replace");
  assert.ok(/CAST\(\[key\] AS INT\) \+ 1/.test(t) && /@p, @c, CAST\(value AS INT\)/.test(t) && !/DELETE FROM lms_(paths|lessons|path_learners)/.test(t), "positions 1..n, only this list is replaced");
  assert.strictEqual((await P.setItems(world({ code: "BAD_LESSON" }).pool, teacher, 5, 41, { lessonIds: [3, 999] })).code, "BAD_LESSON"); assert.strictEqual((await P.setItems(world({ code: "NOT_FOUND" }).pool, teacher, 5, 41, { lessonIds: [] })).notFound, true);
  assert.strictEqual((await P.setItems(world({ status: "archived" }).pool, teacher, 5, 41, { lessonIds: [] })).code, "COURSE_READ_ONLY");
  const bad = world(); assert.strictEqual((await P.setItems(bad.pool, teacher, 5, 41, { lessonIds: [1, 1] })).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("students and anonymous callers are 'not found' before any query; tenant A never touches tenant B; every read is a SELECT, every write names its course", async () => {
  for (const u of [student, null, { id: "x" }]) for (const [fn, args] of [["listPaths", [5, {}]], ["getPath", [5, 41]], ["createPath", [5, { title: "x" }]], ["updatePath", [5, 41, { title: "x" }]], ["removePath", [5, 41]], ["setItems", [5, 41, { lessonIds: [] }]]]) { const m = world(); const r = await P[fn](m.pool, u, ...args); assert.strictEqual(r.notFound, true, fn); assert.strictEqual(m.log.length, 0, fn); }
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => [{ status: "published" }]], ["FROM lms_paths p WHERE p.course_id", () => []]], B: [] }); assert.ok((await P.listPaths(T.A.pool, teacher, 5, {})).ok); T.assertUntouched("B"); T.assertQueried("A");
  const m = world(); await P.listPaths(m.pool, teacher, 5, {}); await P.getPath(m.pool, teacher, 5, 41); assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "reads only select");
});

test("schema step 040 is additive, the LAST step, three tables, unique live path items / learners; tables blocked from the record editor; routes: flag first, staff only, writes need lms.course.manage", () => {
  const { STEPS } = require("../utils/lmsSchema"), ids = STEPS.map((s) => s.id), i = ids.indexOf("040_lms_paths"); assert.ok(i === ids.length - 6 && ids[i - 1] === "039_lms_help_requests");
  const t = STEPS[i].sql.join("\n"); for (const n of ["lms_paths", "lms_path_items", "lms_path_learners"]) assert.ok(new RegExp(`name='${n}' AND xtype='U'`).test(t), n);
  assert.ok(!/DROP |DELETE |ALTER TABLE/i.test(t) && /UX_lms_path_items_lesson ON lms_path_items \(path_id, lesson_id\)/.test(t) && /UX_lms_path_learners_live ON lms_path_learners \(path_id, student_id\) WHERE withdrawn_at IS NULL/.test(t), "no destructive statement; no duplicates");
  const srv = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_paths", "lms_path_items", "lms_path_learners"]) assert.ok(srv.includes(`"${n}"`), `${n} blocked`);
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"); const find = (p) => router.stack.filter((l) => l.route && l.route.path === p);
  assert.ok(/const pGate = requireModule\("lms", "lms_paths"\)/.test(src));
  for (const [meth, p, n, write] of [["get", "/courses/:courseId/paths", 3, false], ["post", "/courses/:courseId/paths", 4, true], ["get", "/courses/:courseId/paths/:pathId", 3, false], ["patch", "/courses/:courseId/paths/:pathId", 4, true], ["delete", "/courses/:courseId/paths/:pathId", 4, true], ["put", "/courses/:courseId/paths/:pathId/items", 4, true]]) {
    const l = find(p).filter((x) => x.route.methods[meth]); assert.strictEqual(l.length, 1, `${meth} ${p}`); const st = l[0].route.stack; assert.strictEqual(st.length, n, `${meth} ${p}: gate + ${write ? "permission + " : ""}membership + handler`); assert.strictEqual(st[0].handle, find("/courses/:courseId/paths")[0].route.stack[0].handle, "the flag gate comes first");
  }
  assert.strictEqual(find("/courses/:courseId/learn/paths").length, 1, "the learner route arrived in L9.3b (D-109) and is pinned in lmsPathLearners.test.js");
});
