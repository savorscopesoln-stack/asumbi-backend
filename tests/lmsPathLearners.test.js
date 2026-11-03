/* L9.3b - learning paths, learners (D-109): staff assign/withdraw/list named learners; each learner sees ONLY the paths assigned to them. Mocked pool only: the SQL (OPENJSON batch,
   table variables, FOR JSON PATH, UPDLOCK/HOLDLOCK) is NOT verified on a real SQL Server; the tests pin the guards in the query TEXT. F-2: no shared module export is patched here. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsPathLearners.test.js");
const L = require("../utils/lmsPathLearners");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const sub = (m, re) => m.log.filter((x) => re.test(x.sql));
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", () => (o.noCourse ? [] : [{ status: o.status || "published" }])],
  ["INSERT INTO lms_path_learners", () => [o.batch || { assigned: 2, already: 1, ok_json: JSON.stringify([{ id: 30 }, { id: 31 }, { id: 32 }]), code: null }]],
  ["UPDATE l SET withdrawn_at", () => (o.noRow ? [] : [{ id: 5 }])],
  ["SELECT TOP 1 id FROM lms_paths WHERE id = @p", () => (o.noPath ? [] : [{ id: 41 }])],
  ["JOIN Students s ON s.id = l.student_id", () => [{ student_id: 30, student_name: "Amina Otieno", assigned_at: "2026-11-02T10:00:00Z", reason: "Missed week 3", total_count: 7, lesson_total: 3, lessons_completed: 1 }]],
  ["SELECT TOP 30 p.id, p.title", () => (o.mine === undefined ? [{ id: 41, title: "Catch-up", description: "d", kind: "remedial", reason: "Missed week 3" }, { id: 42, title: "Stretch", description: null, kind: "enrichment", reason: null }] : o.mine)],
  ["FROM lms_path_items i WHERE i.course_id = @c", () => [{ path_id: 41, lesson_id: 3, position: 1 }, { path_id: 41, lesson_id: 9, position: 2 }, { path_id: 41, lesson_id: 4, position: 3 }, { path_id: 42, lesson_id: 4, position: 1 }]],
  ["FROM lms_course_sections", () => []],
  ["FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND status = 'published'", () => [{ id: 3, section_id: null, title: "Intro", sort_order: 1 }, { id: 4, section_id: null, title: "Fractions", sort_order: 2 }]],
  ["FROM lms_lesson_prerequisites p", () => ((o.doneIds || []).includes(3) ? [] : [{ lesson_id: 4, req_id: 3, req_title: "Intro" }])],
  ["AND student_id = @s AND status = 'completed'", () => (o.doneIds || []).map((id) => ({ lesson_id: id }))],
  ["AND student_id = @vid", () => [{ lesson_id: 3, status: "in_progress" }]],
  ["audit", () => []],
]);

test("validateAssign: 1-100 distinct positive learner ids, plain-text reason <= 300, unknown fields refused, markup stripped", () => {
  assert.deepStrictEqual(L.validateAssign({ studentIds: [30, 31], reason: "  Missed <b>week</b> 3 " }), { ok: true, value: { studentIds: [30, 31], reason: "Missed bweek/b 3" } });
  assert.deepStrictEqual(L.validateAssign({ studentIds: [1] }), { ok: true, value: { studentIds: [1], reason: null } });
  assert.strictEqual(L.validateAssign({ studentIds: [1], reason: null }).value.reason, null);
  for (const bad of [null, [], "x", {}, { studentIds: [] }, { studentIds: "1" }, { studentIds: [1, 1] }, { studentIds: [0] }, { studentIds: [-2] }, { studentIds: [1.5] }, { studentIds: ["1"] }, { studentIds: [2147483648] },
    { studentIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { studentIds: [1], extra: 1 }, { studentIds: [1], reason: 5 }, { studentIds: [1], reason: "x".repeat(301) }]) assert.strictEqual(L.validateAssign(bad).ok, false, JSON.stringify(bad));
  assert.strictEqual(L.validateAssign({ studentIds: Array.from({ length: 100 }, (_, i) => i + 1) }).ok, true, "100 is allowed");
  assert.strictEqual(L.validateAssign({ studentIds: [1], reason: "x".repeat(300) }).ok, true);
});

test("assign: ONE locked transaction, ACTIVE enrolment of THIS course only, live-unique insert, never deletes; ids and reason travel as parameters; skipped = not enrolled; audit holds counts, never the reason", async () => {
  const m = world(); const r = await L.assignLearners(m.pool, teacher, "5", "41", { studentIds: [30, 31, 32, 99], reason: "Missed week 3" });
  assert.deepStrictEqual([r.ok, r.assigned, r.alreadyAssigned, r.skipped], [true, 2, 1, [{ studentId: 99, reason: "NOT_ENROLLED" }]]);
  const w = sub(m, /INSERT INTO lms_path_learners/)[0]; assert.ok(w, "the batch ran");
  assert.ok(/WITH \(UPDLOCK, HOLDLOCK\) WHERE id = @p AND course_id = @c AND deleted_at IS NULL/.test(w.sql) && /SET XACT_ABORT ON; BEGIN TRAN;/.test(w.sql) && /COMMIT;/.test(w.sql), "path locked, live, of this course, one transaction");
  assert.ok(/JOIN lms_course_enrolments e ON e\.course_id = @c AND e\.student_id = q\.id AND e\.status = 'active'/.test(w.sql), "ACTIVE enrolment of this course");
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM lms_path_learners l WHERE l\.path_id = @p AND l\.student_id = o\.id AND l\.withdrawn_at IS NULL\)/.test(w.sql), "a live holder is never duplicated");
  assert.ok(!/\bDELETE\s+(FROM\s+)?lms_|UPDATE lms_path_learners/i.test(w.sql), "assigning never deletes or rewrites an existing row");
  assert.deepStrictEqual(JSON.parse(w.inputs.ids), [30, 31, 32, 99]); assert.deepStrictEqual([w.inputs.c, w.inputs.p, w.inputs.why, w.inputs.src, w.inputs.uid], [5, 41, "Missed week 3", "Teachers", 7]);
  assert.ok(!/Missed week|30, 31/.test(w.sql), "values are parameters, not in the SQL text");
  const a = sub(m, /lms_audit_log/)[0]; assert.ok(a && /path\.learners_assigned/.test(JSON.stringify(a.inputs))); assert.ok(!/Missed week/.test(JSON.stringify(a.inputs)), "audit never holds the reason");
});

test("assign: no learner enrolled = everyone skipped, nothing assigned; path missing/deleted = 404; archived = 409 COURSE_READ_ONLY with NO write; student, bad ids and bad bodies write nothing", async () => {
  const none = world({ batch: { assigned: 0, already: 0, ok_json: null, code: null } }); const r0 = await L.assignLearners(none.pool, teacher, "5", "41", { studentIds: [8, 9] });
  assert.deepStrictEqual([r0.ok, r0.assigned, r0.skipped.length], [true, 0, 2]);
  assert.strictEqual((await L.assignLearners(world({ batch: { assigned: null, already: null, ok_json: null, code: "NOT_FOUND" } }).pool, teacher, "5", "41", { studentIds: [1] })).notFound, true);
  const arch = world({ status: "archived" }); const ra = await L.assignLearners(arch.pool, teacher, "5", "41", { studentIds: [1] }); assert.strictEqual(ra.code, "COURSE_READ_ONLY"); assert.ok(!sub(arch, /INSERT INTO lms_path_learners/).length);
  const draft = world({ status: "draft" }); assert.strictEqual((await L.assignLearners(draft.pool, teacher, "5", "41", { studentIds: [1] })).ok, true, "a draft course may prepare paths");
  for (const [u, c, p, b] of [[student, "5", "41", { studentIds: [1] }], [null, "5", "41", { studentIds: [1] }], [teacher, "x", "41", { studentIds: [1] }], [teacher, "5", "x", { studentIds: [1] }], [teacher, "5", "41", { studentIds: [] }]]) {
    const m = world(); const r = await L.assignLearners(m.pool, u, c, p, b); assert.strictEqual(r.ok, false); assert.ok(!sub(m, /INSERT INTO lms_path_learners/).length, "nothing written");
  }
  assert.strictEqual((await L.assignLearners(world({ noCourse: true }).pool, teacher, "5", "41", { studentIds: [1] })).notFound, true);
});

test("withdraw: sets withdrawn_at on the LIVE row of a live path of THIS course (row stays, never deleted); 404 when the learner does not hold it; archived and student blocked; audit ids only", async () => {
  const m = world(); const r = await L.withdrawLearner(m.pool, teacher, "5", "41", "30"); assert.deepStrictEqual([r.ok, r.withdrawn], [true, true]);
  const q = sub(m, /UPDATE l SET withdrawn_at/)[0]; assert.ok(/l\.path_id = @p AND l\.course_id = @c AND l\.student_id = @s AND l\.withdrawn_at IS NULL/.test(q.sql) && /p\.deleted_at IS NULL/.test(q.sql) && !/\bDELETE\s+(FROM\s+)?lms_/i.test(q.sql));
  assert.deepStrictEqual([q.inputs.c, q.inputs.p, q.inputs.s], [5, 41, 30]);
  assert.ok(/path\.learner_withdrawn/.test(JSON.stringify(sub(m, /lms_audit_log/)[0].inputs)));
  assert.strictEqual((await L.withdrawLearner(world({ noRow: true }).pool, teacher, "5", "41", "30")).notFound, true);
  const arch = world({ status: "archived" }); assert.strictEqual((await L.withdrawLearner(arch.pool, teacher, "5", "41", "30")).code, "COURSE_READ_ONLY"); assert.ok(!sub(arch, /UPDATE l SET/).length);
  for (const [u, p, s] of [[student, "41", "30"], [teacher, "x", "30"], [teacher, "41", "x"], [null, "41", "30"]]) { const w = world(); assert.strictEqual((await L.withdrawLearner(w.pool, u, "5", p, s)).ok, false); assert.ok(!sub(w, /UPDATE l SET/).length); }
});

test("list: only ACTIVELY enrolled live holders, name + date + reason + completed-lesson COUNT; no admission number, no seconds; paging clamped; unknown path = 404", async () => {
  const m = world(); const r = await L.listLearners(m.pool, teacher, "5", "41", { page: "2", pageSize: "500" });
  assert.deepStrictEqual([r.ok, r.total, r.page, r.pageSize], [true, 7, 2, 50]); assert.deepStrictEqual(r.items, [{ studentId: 30, name: "Amina Otieno", assignedAt: "2026-11-02T10:00:00.000Z", reason: "Missed week 3", lessonsCompleted: 1, lessonTotal: 3 }]);
  const q = sub(m, /JOIN Students s ON s\.id = l\.student_id/)[0]; assert.ok(/e\.status = 'active'/.test(q.sql) && /l\.withdrawn_at IS NULL/.test(q.sql) && /g\.status = 'completed'/.test(q.sql) && /x\.deleted_at IS NULL/.test(q.sql));
  assert.ok(!/admissionNo|seconds_spent|last_viewed|first_viewed/.test(q.sql), "no admission number and no activity detail"); assert.deepStrictEqual([q.inputs.off, q.inputs.lim], [50, 50]);
  assert.strictEqual((await L.listLearners(world({ noPath: true }).pool, teacher, "5", "41", {})).notFound, true);
  assert.strictEqual((await L.listLearners(world().pool, student, "5", "41", {})).ok, false, "a student can never list holders");
  const e = await L.listLearners(world().pool, teacher, "5", "41", { page: "-3", pageSize: "0" }); assert.deepStrictEqual([e.page, e.pageSize], [1, 20]);
});

test("shapeMyPath (pure): lessons the learner cannot see are LEFT OUT and never named; status, locked and progress counts come only from what remains", () => {
  const visible = new Map([[3, { id: 3, title: "Intro", locked: false }], [4, { id: 4, title: "Fractions", locked: true }]]);
  const progress = new Map([[3, "completed"], [4, "in_progress"], [9, "completed"]]);
  const s = L.shapeMyPath({ id: 41, title: "Catch-up", description: null, kind: "remedial", reason: "r" }, [{ lesson_id: 3 }, { lesson_id: 9 }, { lesson_id: 4 }, { lesson_id: 77 }], visible, progress);
  assert.deepStrictEqual(s.items, [{ lessonId: 3, title: "Intro", status: "completed", locked: false }, { lessonId: 4, title: "Fractions", status: "in_progress", locked: true }]);
  assert.deepStrictEqual([s.progress, s.reason, s.description, s.kind], [{ done: 1, total: 2 }, "r", null, "remedial"]);
  assert.ok(!/Draft|"lessonId":9|"lessonId":77/.test(JSON.stringify(s)), "a hidden lesson is not even counted");
  assert.deepStrictEqual(L.shapeMyPath({ id: 1, title: "t", kind: "core" }, [{ lesson_id: 5 }], new Map(), new Map()).items, []);
  assert.strictEqual(L.shapeMyPath({ id: 1, title: "t", kind: "core" }, [{ lesson_id: 3 }], visible, new Map()).items[0].status, "not_started");
});

test("myPaths: ONLY my live assigned paths of this course; hidden lessons never named; locked uses the player's rule; no other learner and no student id in the answer", async () => {
  const m = world(); const r = await L.myPaths(m.pool, student, "5"); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.paths.map((p) => [p.id, p.kind, p.reason, p.items.map((i) => [i.lessonId, i.status, i.locked]), p.progress]),
    [[41, "remedial", "Missed week 3", [[3, "in_progress", false], [4, "not_started", true]], { done: 0, total: 2 }], [42, "enrichment", null, [[4, "not_started", true]], { done: 0, total: 1 }]]);
  const q = sub(m, /SELECT TOP 30 p\.id, p\.title/)[0]; assert.ok(/l\.course_id = @c AND l\.student_id = @vid AND l\.withdrawn_at IS NULL/.test(q.sql) && /p\.deleted_at IS NULL/.test(q.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.vid], [5, 21]);
  const pr = sub(m, /AND student_id = @vid/)[0]; assert.strictEqual(pr.inputs.vid, 21, "progress is MY progress only");
  assert.ok(!/studentId|student_id|Draft one|admission/i.test(JSON.stringify(r)), "no learner id, no hidden lesson title");
  const done = world({ doneIds: [3] }); const r2 = await L.myPaths(done.pool, student, "5"); assert.strictEqual(r2.paths[0].items[1].locked, false, "finishing the prerequisite unlocks it, same rule as the player");
  const none = world({ mine: [] }); assert.deepStrictEqual(await L.myPaths(none.pool, student, "5"), { ok: true, paths: [] }); assert.ok(!sub(none, /FROM lms_path_items/).length, "no path = no further reads");
});

test("myPaths: staff, strangers and non-published courses are refused; another tenant's data is never touched", async () => {
  for (const [u, o] of [[teacher, {}], [null, {}], [student, { status: "draft" }], [student, { noCourse: true }], [{ id: 5, role: "student", source: "Teachers" }, {}]]) assert.strictEqual((await L.myPaths(world(o).pool, u, "5")).ok, false);
  assert.strictEqual((await L.myPaths(world().pool, student, "x")).ok, false);
  assert.ok((await L.myPaths(world({ status: "archived" }).pool, student, "5")).ok, "an archived course stays readable");
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => [{ status: "published" }]], ["SELECT TOP 30 p.id, p.title", () => []]], B: [] });
  assert.deepStrictEqual(await L.myPaths(T.A.pool, student, "5"), { ok: true, paths: [] }); T.assertUntouched("B");
});

test("routes: flag gate FIRST on all four; assign/withdraw need lms.course.manage; the learner route is studentOnly + course access; handlers answer 200/404", async () => {
  const router = require("../routes/lms"); const find = (p, meth) => router.stack.filter((l) => l.route && l.route.path === p && l.route.methods[meth]);
  const gate = find("/courses/:courseId/paths", "get")[0].route.stack[0].handle;
  for (const [meth, p, n] of [["put", "/courses/:courseId/paths/:pathId/learners", 4], ["delete", "/courses/:courseId/paths/:pathId/learners/:studentId", 4], ["get", "/courses/:courseId/paths/:pathId/learners", 3], ["get", "/courses/:courseId/learn/paths", 4]]) {
    const l = find(p, meth); assert.strictEqual(l.length, 1, `${meth} ${p}`); assert.strictEqual(l[0].route.stack.length, n, `${meth} ${p}`); assert.strictEqual(l[0].route.stack[0].handle, gate, `${meth} ${p}: the flag gate comes first`);
  }
  const mine = find("/courses/:courseId/learn/paths", "get")[0].route.stack; const m = world(); const res = makeRes();
  await mine[mine.length - 1].handle({ pool: m.pool, user: student, params: { courseId: "5" }, query: {}, body: {}, tenant: "pl-a" }, res); assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.paths.length, 2);
  const put = find("/courses/:courseId/paths/:pathId/learners", "put")[0].route.stack; const r2 = makeRes();
  await put[put.length - 1].handle({ pool: world().pool, user: teacher, params: { courseId: "5", pathId: "41" }, query: {}, body: { studentIds: [30] }, tenant: "pl-a" }, r2); assert.strictEqual(r2.statusCode, 200); assert.strictEqual(r2.body.assigned, 2);
  const r3 = makeRes(); await put[put.length - 1].handle({ pool: world().pool, user: teacher, params: { courseId: "5", pathId: "abc" }, query: {}, body: { studentIds: [30] }, tenant: "pl-a" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); await put[put.length - 1].handle({ pool: world().pool, user: teacher, params: { courseId: "5", pathId: "41" }, query: {}, body: { studentIds: [] }, tenant: "pl-a" }, r4); assert.strictEqual(r4.statusCode, 400);
  const del = find("/courses/:courseId/paths/:pathId/learners/:studentId", "delete")[0].route.stack; const r5 = makeRes();
  await del[del.length - 1].handle({ pool: world({ noRow: true }).pool, user: teacher, params: { courseId: "5", pathId: "41", studentId: "30" }, query: {}, body: {}, tenant: "pl-a" }, r5); assert.strictEqual(r5.statusCode, 404);
});
