/* L3.5a — lesson prerequisites ("finish A before B"). Mocked pool only: SQL syntax NOT verified on a real SQL Server (A28). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsPrerequisites.test.js");
const Q = require("../utils/lmsPrerequisites");
const P = require("../utils/lmsProgress");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const LIVE_IDS = (ids) => ["SELECT TOP 1000 id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL", () => ids.map((id) => ({ id }))];
const EDGES = (rows) => ["FROM lms_lesson_prerequisites WHERE course_id = @c", () => rows.map(([l, r]) => ({ lesson_id: l, requires_lesson_id: r }))];
const TX = "DELETE FROM lms_lesson_prerequisites WHERE lesson_id = @l AND course_id = @c";
const GET = "SELECT TOP 10 r.id, r.title FROM lms_lesson_prerequisites p JOIN lms_lessons r ON r.id = p.requires_lesson_id AND r.course_id = @c AND r.deleted_at IS NULL WHERE";
const LOCK = "AND NOT EXISTS (SELECT 1 FROM lms_lesson_progress d";
const LISTUN = "WHERE p.course_id = @c AND g.id IS NULL";
const writes = (log) => log.filter((x) => /^(INSERT|UPDATE|DELETE|SET XACT_ABORT)/.test(x.sql));

/* ---------------- pure ---------------- */
test("validateIds: a list of up to 10 unique positive ids; empty list clears; unknown fields and junk refused", () => {
  assert.deepStrictEqual(Q.validateIds({ ids: [3, 4] }), { ok: true, ids: [3, 4] }); assert.deepStrictEqual(Q.validateIds({ ids: [] }), { ok: true, ids: [] });
  assert.ok(Q.validateIds({ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).ok);
  for (const bad of [{ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, { ids: [1, 1] }, { ids: [0] }, { ids: [-1] }, { ids: ["x"] }, { ids: [1.5] }, { ids: "1" }, { ids: [null] }, {}, { ids: [1], extra: 1 }, [], null, "x"]) assert.strictEqual(Q.validateIds(bad).ok, false, JSON.stringify(bad));
});
test("createsCycle: direct, indirect and self-through-others loops are found; diamonds and unrelated chains are fine; the lesson's own old edges are ignored", () => {
  const e = (...p) => p.map(([lesson, requires]) => ({ lesson, requires }));
  assert.strictEqual(Q.createsCycle(1, [2], e([2, 1])), true); // 2 needs 1, now 1 needs 2
  assert.strictEqual(Q.createsCycle(1, [2], e([2, 3], [3, 4], [4, 1])), true); // longer loop
  assert.strictEqual(Q.createsCycle(1, [2, 3], e([2, 4], [3, 4])), false); // diamond (shared ancestor) is not a loop
  assert.strictEqual(Q.createsCycle(1, [2], e([5, 6], [6, 7])), false);
  assert.strictEqual(Q.createsCycle(1, [2], e([1, 2], [2, 3])), false); // old edge 1->2 is being replaced; 2->3 does not lead back
  assert.strictEqual(Q.createsCycle(1, [], e([2, 1])), false); // clearing never loops
});

/* ---------------- staff: set / get ---------------- */
test("setPrerequisites: replaces the list in one transaction, every id is a parameter, course_id on every statement, audited", async () => {
  const m = makeMockPool([live(), LIVE_IDS([1, 2, 3]), EDGES([]), [TX, () => []], [GET, () => [{ id: 1, title: "Intro" }, { id: 2, title: "Cells" }]]]);
  const r = await Q.setPrerequisites(m.pool, teacher(), 5, 3, { ids: [1, 2] }); assert.ok(r.ok); assert.deepStrictEqual(r.prerequisites, [{ lessonId: 1, title: "Intro" }, { lessonId: 2, title: "Cells" }]);
  const tx = m.log.find((x) => x.sql.includes(TX)); assert.ok(tx.sql.includes("SET XACT_ABORT ON") && tx.sql.includes("BEGIN TRAN") && tx.sql.includes("COMMIT") && tx.sql.includes("INSERT INTO lms_lesson_prerequisites (course_id, lesson_id, requires_lesson_id) VALUES (@c, @l, @r0), (@c, @l, @r1)"));
  assert.deepStrictEqual([tx.inputs.c, tx.inputs.l, tx.inputs.r0, tx.inputs.r1], [5, 3, 1, 2]); assert.ok(!tx.sql.includes("VALUES (5"));
  assert.ok(m.log.some((x) => x.inputs.act === "lesson.prerequisites_set"));
  const clear = makeMockPool([live(), LIVE_IDS([1, 3]), EDGES([[3, 1]]), [TX, () => []], [GET, () => []]]); assert.deepStrictEqual((await Q.setPrerequisites(clear.pool, teacher(), 5, 3, { ids: [] })).prerequisites, []);
  assert.ok(!clear.log.find((x) => x.sql.includes(TX)).sql.includes("INSERT INTO")); // empty list = delete only
});
test("setPrerequisites refuses: self, a lesson of another course, a loop, more than 10, archived course, unknown lesson, bad body — and writes nothing", async () => {
  const run = async (body, o = {}) => { const m = makeMockPool([live(o.status || "draft"), LIVE_IDS(o.ids || [1, 2, 3]), EDGES(o.edges || []), [TX, () => []], [GET, () => []]]); const r = await Q.setPrerequisites(m.pool, teacher(), 5, o.lesson || 3, body); assert.strictEqual(writes(m.log).length, 0, JSON.stringify(body)); return r; };
  assert.ok(/own prerequisite/.test((await run({ ids: [3] })).errors[0]));
  assert.ok(/of this course/.test((await run({ ids: [99] })).errors[0])); // id from another course/school looks the same as a missing one
  assert.ok(/loop/.test((await run({ ids: [2] }, { edges: [[2, 3]] })).errors[0]));
  assert.ok(/loop/.test((await run({ ids: [1] }, { edges: [[1, 2], [2, 3]] })).errors[0]));
  assert.strictEqual((await run({ ids: [1] }, { status: "archived" })).code, "COURSE_ARCHIVED");
  assert.strictEqual((await run({ ids: [1] }, { lesson: 77 })).notFound, true);
  assert.strictEqual((await run({ ids: [1, 1] })).ok, false);
  assert.strictEqual((await run({ ids: [1], x: 1 })).ok, false);
});
test("setPrerequisites ignores edges that point at deleted lessons when looking for loops", async () => {
  const m = makeMockPool([live(), LIVE_IDS([1, 2, 3]), EDGES([[2, 99], [99, 3]]), [TX, () => []], [GET, () => []]]); assert.ok((await Q.setPrerequisites(m.pool, teacher(), 5, 3, { ids: [2] })).ok);
});
test("getPrerequisites: course-scoped, titles only; unknown lesson is not found", async () => {
  const m = makeMockPool([["SELECT TOP 1 id FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL", onlyIds("l", [3], [{ id: 3 }])], [GET, () => [{ id: 1, title: "Intro" }]]]);
  const r = await Q.getPrerequisites(m.pool, 5, 3); assert.deepStrictEqual(r.prerequisites, [{ lessonId: 1, title: "Intro" }]); assert.ok(m.log.find((x) => x.sql.includes(GET)).sql.includes("p.course_id = @c"));
  assert.strictEqual((await Q.getPrerequisites(m.pool, 5, 4)).notFound, true);
});

/* ---------------- students ---------------- */
test("lockFor: counts only visible prerequisites not completed by THIS student, and a completed lesson is never locked; the SQL matches course and student", async () => {
  const m = makeMockPool([[LOCK, () => [{ id: 1, title: "Intro" }]]]); const by = await Q.lockFor(m.pool, 5, 3, 21); assert.deepStrictEqual(by, [{ lessonId: 1, title: "Intro" }]);
  const q = m.log[0]; assert.deepStrictEqual([q.inputs.c, q.inputs.l, q.inputs.s], [5, 3, 21]);
  assert.ok(q.sql.includes("r.status = 'published' AND (r.publish_at IS NULL OR r.publish_at <= SYSUTCDATETIME())")); // a hidden prerequisite is ignored
  assert.ok(q.sql.includes("t.status = 'published' AND (t.publish_at IS NULL OR t.publish_at <= SYSUTCDATETIME())")); // a hidden lesson never answers "locked" (no draft leak)
  assert.ok(q.sql.includes("r.deleted_at IS NULL") && q.sql.includes("g.student_id = @s") && q.sql.includes("g.status = 'completed'") && q.sql.includes("g.course_id = @c") && /d\.student_id = @s AND d\.course_id = @c AND d\.status = 'completed'/.test(q.sql));
  assert.deepStrictEqual(await Q.lockFor(makeMockPool([]).pool, 5, 3, 21), []);
});
test("studentListView: locked + lockedBy on each lesson, completed lessons open, never any content", async () => {
  const sec = ["FROM lms_course_sections WHERE course_id", () => [{ id: 3, title: "Unit 1", summary: null, sort_order: 10 }]];
  const les = ["FROM lms_lessons WHERE course_id = @c", () => [{ id: 1, section_id: 3, title: "Intro", summary: null, estimated_minutes: 5, sort_order: 10 }, { id: 2, section_id: 3, title: "Cells", summary: null, estimated_minutes: 15, sort_order: 20 }, { id: 4, section_id: null, title: "Done early", summary: null, estimated_minutes: null, sort_order: 30 }]];
  const m = makeMockPool([live("published"), sec, les, [LISTUN, () => [{ lesson_id: 2, req_id: 1, req_title: "Intro" }, { lesson_id: 4, req_id: 1, req_title: "Intro" }]], ["status = 'completed'", () => [{ lesson_id: 4 }]]]);
  const r = await Q.studentListView(m.pool, 5, 21); assert.ok(r.ok);
  const [intro, cells] = r.sections[0].lessons; assert.deepStrictEqual([intro.locked, intro.lockedBy], [false, []]); assert.deepStrictEqual([cells.locked, cells.lockedBy], [true, [{ lessonId: 1, title: "Intro" }]]);
  assert.strictEqual(r.unsectioned[0].locked, false); // already completed: stays open even though a rule was added later
  assert.ok(!JSON.stringify(r).includes("blocks") && !JSON.stringify(r).includes("html"));
  const un = m.log.find((x) => x.sql.includes(LISTUN)); assert.deepStrictEqual([un.inputs.c, un.inputs.s], [5, 21]); assert.ok(un.sql.includes("r.status = 'published'"));
  assert.strictEqual((await Q.studentListView(makeMockPool([["FROM lms_courses WHERE id", () => []]]).pool, 5, 21)).notFound, true); // draft course: not found, no extra queries about prerequisites
});
test("studentLessonView: locked = 409 LESSON_LOCKED with the lessons to finish and the content is never read; open = content; hidden lesson = not found", async () => {
  const lessonRow = ["FROM lms_lessons WHERE id = @id", onlyIds("id", [9], [{ id: 9, course_id: 5, section_id: null, title: "Cells", summary: null, estimated_minutes: 15 }])];
  const blocks = ["FROM lms_lesson_blocks WHERE lesson_id", () => [{ id: 1, block_type: "text", sort_order: 10, html: "<p>secret</p>", data: null }]];
  const a = makeMockPool([live("published"), [LOCK, () => [{ id: 1, title: "Intro" }, { id: 2, title: "Cells 1" }]], lessonRow, blocks]);
  const r = await Q.studentLessonView(a.pool, 5, 9, 21); assert.deepStrictEqual([r.ok, r.code], [false, "LESSON_LOCKED"]); assert.deepStrictEqual(r.extra.lockedBy.map((x) => x.title), ["Intro", "Cells 1"]); assert.ok(/Intro/.test(r.errors[0]));
  assert.ok(!a.log.some((x) => x.sql.includes("lms_lesson_blocks")) && !JSON.stringify(r).includes("secret"));
  const b = makeMockPool([live("published"), lessonRow, blocks]); const o = await Q.studentLessonView(b.pool, 5, 9, 21); assert.ok(o.ok && o.blocks.length === 1 && o.lesson.locked === false);
  const c = makeMockPool([live("published"), lessonRow, blocks]); assert.strictEqual((await Q.studentLessonView(c.pool, 5, 77, 21)).notFound, true);
  const nf = await Q.studentLessonView(makeMockPool([["FROM lms_courses WHERE id", () => []], [LOCK, () => [{ id: 1, title: "Intro" }]]]).pool, 5, 9, 21); assert.strictEqual(nf.notFound, true); // draft course: never "locked"
});
test("progress is refused for a locked lesson (view and complete) and nothing is written", async () => {
  const mk = () => makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["FROM lms_lessons WHERE id = @id", () => [{ id: 9, completion_rule: null, min_minutes: null }]], [LOCK, () => [{ id: 1, title: "Intro" }]]]);
  for (const f of [(p) => P.recordView(p, 5, 9, 21, {}, "t"), (p) => P.markComplete(p, 5, 9, 21, "t")]) { const m = mk(); const r = await f(m.pool); assert.deepStrictEqual([r.ok, r.code], [false, "LESSON_LOCKED"]); assert.strictEqual(writes(m.log).length, 0); }
  const open = makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["FROM lms_lessons WHERE id = @id", () => [{ id: 9, completion_rule: null, min_minutes: null }]], ["UPDATE lms_lesson_progress SET seconds_spent", () => [{ lesson_id: 9, status: "in_progress", seconds_spent: 0 }]]]); assert.ok((await P.recordView(open.pool, 5, 9, 21, {}, "t")).ok);
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const enrolled = (ids) => ["FROM lms_course_enrolments WHERE course_id", onlyIds("c", ids, [{ status: "active" }])];
const PP = "/courses/:courseId/lessons/:lessonId/prerequisites", LL = "/courses/:courseId/learn/lessons", LI = "/courses/:courseId/learn/lessons/:lessonId", CP = "/courses/:courseId/learn/lessons/:lessonId/complete";

test("routes: owner and co-teacher set prerequisites (needs lms.lesson.edit); students, non-members and other courses get the same 403 and nothing is written", async () => {
  const mk = (role = "teacher") => makeMockPool([staff([5], role), enrolled([5]), live(), LIVE_IDS([1, 3]), EDGES([]), [TX, () => []], [GET, () => [{ id: 1, title: "Intro" }]], ["SELECT TOP 1 id FROM lms_lessons WHERE id = @l", () => [{ id: 3 }]]]);
  for (const role of ["teacher", "co_teacher"]) { const r = await call("put", PP, { user: teacher(), pool: mk(role).pool, params: { courseId: "5", lessonId: "3" }, body: { ids: [1] } }); assert.strictEqual(r.res.statusCode, 200, role); assert.strictEqual(r.res.body.prerequisites[0].title, "Intro"); }
  const g = await call("get", PP, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "3" } }); assert.strictEqual(g.res.statusCode, 200);
  const refused = [];
  for (const [user, courseId] of [[student(), "5"], [teacher(), "6"], [teacher(), "999"]]) { const m = mk(); const r = await call("put", PP, { user, pool: m.pool, params: { courseId, lessonId: "3" }, body: { ids: [1] } }); assert.strictEqual(r.res.statusCode, 403); assert.strictEqual(writes(m.log).length, 0); refused.push(r.res); }
  sameForbidden(refused[1], refused[2]);
  const bad = await call("put", PP, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "3" }, body: { ids: [3] } }); assert.strictEqual(bad.res.statusCode, 400);
  const nf = await call("put", PP, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "abc" }, body: { ids: [] } }); assert.strictEqual(nf.res.statusCode, 404);
});
test("routes: a locked lesson answers 409 LESSON_LOCKED with lockedBy and no content; the list marks it; completing it is refused", async () => {
  const pool = () => makeMockPool([enrolled([5]), live("published"), [LOCK, () => [{ id: 1, title: "Intro" }]], ["FROM lms_lessons WHERE id = @id", () => [{ id: 9, course_id: 5, section_id: null, title: "Cells", summary: null, estimated_minutes: 1, completion_rule: null, min_minutes: null }]], ["FROM lms_lesson_blocks WHERE lesson_id", () => [{ id: 1, block_type: "text", sort_order: 1, html: "<p>secret</p>", data: null }]],
    ["FROM lms_course_sections WHERE course_id", () => []], ["FROM lms_lessons WHERE course_id = @c", () => [{ id: 9, section_id: null, title: "Cells", summary: null, estimated_minutes: 1, sort_order: 10 }]], [LISTUN, () => [{ lesson_id: 9, req_id: 1, req_title: "Intro" }]], ["status = 'completed'", () => []]]);
  const g = await call("get", LI, { user: student(), pool: pool().pool, params: { courseId: "5", lessonId: "9" } }); assert.strictEqual(g.res.statusCode, 409); assert.deepStrictEqual([g.res.body.code, g.res.body.lockedBy], ["LESSON_LOCKED", [{ lessonId: 1, title: "Intro" }]]); assert.ok(!JSON.stringify(g.res.body).includes("secret"));
  const l = await call("get", LL, { user: student(), pool: pool().pool, params: { courseId: "5" } }); assert.strictEqual(l.res.statusCode, 200); assert.strictEqual(l.res.body.unsectioned[0].locked, true); assert.strictEqual(l.res.body.unsectioned[0].lockedBy[0].title, "Intro");
  const m = pool(); const c = await call("post", CP, { user: student(), pool: m.pool, params: { courseId: "5", lessonId: "9" } }); assert.deepStrictEqual([c.res.statusCode, c.res.body.code], [409, "LESSON_LOCKED"]); assert.strictEqual(writes(m.log).length, 0);
});
test("tenant isolation: school A's student guessing school B's lesson or prerequisite ids touches nothing in B", async () => {
  const T = makeTenants({ A: [enrolled([5]), live("published"), [LOCK, () => []], ["FROM lms_lessons WHERE id = @id", onlyIds("id", [9], [{ id: 9, course_id: 5, section_id: null, title: "x", summary: null, estimated_minutes: null }])], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]], B: [enrolled([5]), live("published"), [LOCK, () => [{ id: 1, title: "B secret" }]]] });
  const r = await call("get", LI, { user: student(), pool: T.A.pool, params: { courseId: "5", lessonId: "9" }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 200); T.assertQueried("A"); T.assertUntouched("B");
  const miss = await call("get", LI, { user: student(), pool: T.A.pool, params: { courseId: "5", lessonId: "10" }, tenant: "A" }); assert.strictEqual(miss.res.statusCode, 404); T.assertUntouched("B");
});

/* ---------------- static ---------------- */
test("static: step 012 additive and guarded; table blocklisted; both staff routes behind the gate with permission + membership; no raw db; lock check runs before content is read", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "012_lms_lesson_prerequisites"); assert.ok(st && STEPS.indexOf(st) > STEPS.findIndex((s) => s.id === "011_lms_lesson_progress"));
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); assert.ok(/CREATE TABLE lms_lesson_prerequisites/.test(ddl) && /UNIQUE \(lesson_id, requires_lesson_id\)/.test(ddl) && /IX_lms_lesson_prerequisites_course/.test(ddl));
  assert.ok(/"lms_lesson_prerequisites"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")));
  const router = require("../routes/lms"); const put = router.stack.find((l) => l.route && l.route.path === PP && l.route.methods.put), get = router.stack.find((l) => l.route && l.route.path === PP && l.route.methods.get);
  assert.strictEqual(put.route.stack.length, 3); assert.strictEqual(get.route.stack.length, 2); assert.ok(router.stack.indexOf(put) >= 2);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsPrerequisites.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  const view = src.slice(src.indexOf("async function studentLessonView")); assert.ok(view.indexOf("lockFor(") < view.indexOf("getLessonForStudent("), "lock check must come first");
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "lms.js"), "utf8"); assert.ok(/prereq\.studentLessonView/.test(routes) && /prereq\.studentListView/.test(routes) && !/lessons\.getLessonForStudent\(/.test(routes) && !/lessons\.listLessonsForStudent\(/.test(routes)); // students never reach the unguarded readers
});
