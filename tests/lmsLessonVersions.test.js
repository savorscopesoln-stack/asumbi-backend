/* L3.3a — lesson versions, restore, scheduled publishing, student preview.
   Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsLessonVersions.test.js");
const L = require("../utils/lmsLessons");
const { on } = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const les = (o = {}) => ({ id: 9, course_id: 5, section_id: null, title: "Cells", summary: null, status: "draft", estimated_minutes: null, sort_order: 10, content_version: 3, published_at: null, publish_at: null, created_at: "x", updated_at: "x", ...o });
const T = "school1", img = (o = {}) => ({ type: "image", url: `/uploads/${T}/lms/a.png`, alt: "A cell", ...o });
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const SNAP = "SELECT TOP 1 version_no, title, label, blocks_json";
const snapRow = (blocks, o = {}) => ({ version_no: 2, title: "Cells", label: null, blocks_json: typeof blocks === "string" ? blocks : JSON.stringify(blocks), created_at: "x", ...o });
const TX = "UPDATE lms_lessons SET content_version";

/* ---------------- scheduling: validation ---------------- */
test("publishAt validation: future, explicit time zone, within 2 years; cancelling needs a status; draft + schedule is contradictory", () => {
  const ok = L.validateLesson({ title: "x", publishAt: inDays(3) }); assert.ok(ok.ok, JSON.stringify(ok.errors)); assert.ok(ok.value.publishAt instanceof Date);
  assert.ok(L.validateLesson({ title: "x", publishAt: "2999-01-01T00:00:00Z" }).ok === false); // > 2 years
  for (const bad of [inDays(-1), "2026-11-02", "2026-11-02T08:00:00", "tomorrow", 12345, "", {}, "9999-99-99T99:99:99Z"]) assert.strictEqual(L.validateLesson({ title: "x", publishAt: bad }).ok, false, String(bad));
  assert.strictEqual(L.validateLesson({ publishAt: null }, { partial: true }).ok, false); // which way? hide or publish now
  assert.strictEqual(L.validateLesson({ publishAt: null, status: "published" }, { partial: true }).value.publishAt, null);
  assert.strictEqual(L.validateLesson({ title: "x", publishAt: inDays(2), status: "draft" }).ok, false);
  assert.ok(L.validateLesson({ title: "x", publishAt: inDays(2), status: "published" }).ok);
  assert.strictEqual(L.futureDate("2026-11-02T08:00:00+03:00") === null, Date.parse("2026-11-02T08:00:00+03:00") <= Date.now()); // explicit offsets are honoured
});

/* ---------------- scheduling: service ---------------- */
test("createLesson with publishAt: stored as a published lesson hidden until that time, time passed as a parameter", async () => {
  const when = inDays(4);
  const m = makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 0 }]], ["INSERT INTO lms_lessons", () => [les({ status: "published", publish_at: new Date(when) })]]]);
  const r = await L.createLesson(m.pool, teacher(), 5, { title: "Cells", publishAt: when }); assert.ok(r.ok);
  const q = m.log.find((x) => x.sql.includes("INSERT INTO lms_lessons")); assert.strictEqual(q.inputs.st, "published"); assert.ok(q.inputs.pat instanceof Date && q.inputs.pat.toISOString() === when); assert.ok(!q.sql.includes(when) && q.sql.includes("publish_at"));
  assert.strictEqual(r.lesson.visibleToStudents, false); assert.ok(r.lesson.publishAt);
  const d = makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 0 }]], ["INSERT INTO lms_lessons", () => [les()]]]); await L.createLesson(d.pool, teacher(), 5, { title: "Plain" });
  const q2 = d.log.find((x) => x.sql.includes("INSERT INTO lms_lessons")); assert.strictEqual(q2.inputs.st, "draft"); assert.strictEqual(q2.inputs.pat, null);
});
test("updateLesson: schedule, publish now, draft clears the schedule; only an immediate publish emits the event", async () => {
  const seen = []; const off = on("lms.lesson.published", (e) => seen.push(e));
  const mk = () => makeMockPool([live(), ["UPDATE lms_lessons SET", onlyIds("id", [9], [les({ status: "published" })])]]);
  const when = inDays(2);
  const a = mk(); assert.ok((await L.updateLesson(a.pool, teacher(), 5, 9, { publishAt: when }, "ver-sched")).ok);
  const qa = a.log.find((x) => x.sql.includes("UPDATE lms_lessons SET")); assert.strictEqual(qa.inputs.st, "published"); assert.strictEqual(qa.inputs.pat.toISOString(), when); assert.ok(qa.sql.includes("publish_at = @pat") && qa.sql.includes("course_id = @c"));
  const b = mk(); assert.ok((await L.updateLesson(b.pool, teacher(), 5, 9, { status: "published", publishAt: null }, "ver-now")).ok);
  const qb = b.log.find((x) => x.sql.includes("UPDATE lms_lessons SET")); assert.strictEqual(qb.inputs.pat, null); assert.strictEqual(qb.inputs.st, "published");
  const c = mk(); assert.ok((await L.updateLesson(c.pool, teacher(), 5, 9, { status: "draft" }, "ver-draft")).ok);
  const qc = c.log.find((x) => x.sql.includes("UPDATE lms_lessons SET")); assert.strictEqual(qc.inputs.st, "draft"); assert.strictEqual(qc.inputs.pat, null); assert.ok(!qc.sql.includes("published_at = CASE"));
  await tick();
  assert.strictEqual(seen.filter((e) => e.tenant === "ver-sched").length, 0); assert.strictEqual(seen.filter((e) => e.tenant === "ver-now").length, 1); assert.strictEqual(seen.filter((e) => e.tenant === "ver-draft").length, 0); off && off();
  assert.strictEqual((await L.updateLesson(mk().pool, teacher(), 5, 9, { publishAt: inDays(-2) }, "x")).ok, false);
});
test("visibleToStudents: published and not in the future only", () => {
  const vis = (o) => L.listLessons(makeMockPool([["FROM lms_lessons WHERE course_id", () => [les(o)]]]).pool, 5).then((x) => x[0].visibleToStudents);
  return Promise.all([vis({ status: "published" }), vis({ status: "published", publish_at: new Date(Date.now() + 86400000) }), vis({ status: "published", publish_at: new Date(Date.now() - 86400000) }), vis({ status: "draft" })])
    .then((r) => assert.deepStrictEqual(r, [true, false, true, false]));
});
test("students never get a scheduled lesson early: both learner queries check publish_at at read time", async () => {
  const course = ["FROM lms_courses WHERE id", () => [{ status: "published" }]];
  const m = makeMockPool([course, ["FROM lms_course_sections WHERE course_id", () => []], ["FROM lms_lessons WHERE course_id = @c", () => []]]); await L.listLessonsForStudent(m.pool, 5);
  assert.ok(m.log.find((x) => x.sql.includes("FROM lms_lessons")).sql.includes("(publish_at IS NULL OR publish_at <= SYSUTCDATETIME())"));
  const g = makeMockPool([course, ["FROM lms_lessons WHERE id", () => []]]); assert.strictEqual((await L.getLessonForStudent(g.pool, 5, 9)).notFound, true);
  assert.ok(g.log.find((x) => x.sql.includes("FROM lms_lessons WHERE id")).sql.includes("publish_at <= SYSUTCDATETIME()"));
});

/* ---------------- snapshots on save ---------------- */
test("saveBlocks stores a sanitised snapshot in the SAME atomic statement, keeps the last 50, prunes in that statement", async () => {
  const m = makeMockPool([live(), [TX, () => [{ new_version: 4, lesson_exists: 1 }]], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]]);
  const r = await L.saveBlocks(m.pool, teacher(), 5, 9, { baseVersion: 3, blocks: [{ type: "text", html: "<p>Hi<script>x</script></p>" }, img(), { type: "divider" }] }, T); assert.ok(r.ok);
  const tx = m.log.find((x) => x.sql.includes("BEGIN TRAN"));
  assert.ok(tx.sql.includes("INSERT INTO lms_lesson_versions") && tx.sql.indexOf("INSERT INTO lms_lesson_versions") < tx.sql.indexOf("COMMIT") && tx.sql.indexOf("INSERT INTO lms_lesson_versions") > tx.sql.indexOf("IF @@ROWCOUNT = 1"));
  assert.ok(/DELETE FROM lms_lesson_versions WHERE lesson_id = @l AND course_id = @c AND version_no <= @new - 50/.test(tx.sql));
  assert.ok(!tx.sql.includes("script") && !tx.sql.includes("A cell")); // content only as parameters
  const snap = JSON.parse(tx.inputs.snap); assert.deepStrictEqual(snap[0], { type: "text", html: "<p>Hi</p>" }); assert.deepStrictEqual(snap[1], { type: "image", url: `/uploads/${T}/lms/a.png`, alt: "A cell" }); assert.deepStrictEqual(snap[2], { type: "divider" });
  assert.strictEqual(tx.inputs.lbl, null); assert.strictEqual(tx.inputs.src, "Teachers"); assert.strictEqual(tx.inputs.uid, 7);
  const stale = makeMockPool([live(), [TX, () => [{ new_version: null, lesson_exists: 1 }]]]); assert.strictEqual((await L.saveBlocks(stale.pool, teacher(), 5, 9, { baseVersion: 1, blocks: [] }, T)).code, "CONTENT_CONFLICT");
});
test("a lesson over the size cap is refused before any database work", async () => {
  const big = Array.from({ length: 6 }, () => ({ type: "text", html: `<p>${"a".repeat(99000)}</p>` }));
  const m = makeMockPool([live()]); const r = await L.saveBlocks(m.pool, teacher(), 5, 9, { baseVersion: 1, blocks: big }, T); assert.strictEqual(r.ok, false); assert.ok(/too long/i.test(r.errors[0])); assert.strictEqual(m.log.length, 0);
});

/* ---------------- list / read versions ---------------- */
test("listVersions: lesson must belong to the course; list has no content; newest first; capped", async () => {
  const mk = () => makeMockPool([["SELECT TOP 1 id FROM lms_lessons WHERE id", onlyIds("c", [5], onlyIds("id", [9], [{ id: 9 }]))],
    ["SELECT TOP 50 version_no", onlyIds("c", [5], onlyIds("l", [9], [{ version_no: 4, title: "Cells", label: "Restored from version 2", created_by_source: "Teachers", created_by: 7, created_at: "x" }, { version_no: 3, title: "Cells", label: null, created_by_source: null, created_by: null, created_at: "y" }]))]]);
  const m = mk(); const r = await L.listVersions(m.pool, 5, 9); assert.ok(r.ok); assert.deepStrictEqual(r.versions.map((v) => v.versionNo), [4, 3]); assert.strictEqual(r.versions[0].label, "Restored from version 2");
  const q = m.log.find((x) => x.sql.includes("SELECT TOP 50 version_no")); assert.ok(!q.sql.includes("blocks_json") && q.sql.includes("ORDER BY version_no DESC") && q.sql.includes("course_id = @c") && q.inputs.c === 5 && q.inputs.l === 9);
  assert.strictEqual((await L.listVersions(mk().pool, 5, 99)).notFound, true); assert.strictEqual((await L.listVersions(mk().pool, 6, 9)).notFound, true);
});
test("getVersion: returns editor-shaped, re-sanitised blocks; corrupt, foreign-school or missing snapshots are refused", async () => {
  const get = (rows, tenant = T) => L.getVersion(makeMockPool([[SNAP, onlyIds("c", [5], onlyIds("l", [9], onlyIds("n", [2], rows)))]]).pool, 5, 9, 2, tenant);
  const good = await get([snapRow([{ type: "text", html: "<p>Old <script>alert(1)</script>text</p>" }, { type: "image", url: `/uploads/${T}/lms/a.png`, alt: "A cell" }, { type: "divider" }])]);
  assert.ok(good.ok); assert.strictEqual(good.blocks[0].html, "<p>Old text</p>"); assert.strictEqual(good.blocks[1].alt, "A cell"); assert.ok(!("id" in good.blocks[0]) && !("sortOrder" in good.blocks[0])); assert.strictEqual(good.version.versionNo, 2);
  const q = makeMockPool([[SNAP, () => [snapRow([])]]]); await L.getVersion(q.pool, 5, 9, 2, T);
  const sqlText = q.log.find((x) => x.sql.includes(SNAP)).sql; assert.ok(sqlText.includes("lesson_id = @l AND course_id = @c AND version_no = @n"), sqlText); assert.deepStrictEqual([q.log[0].inputs.c, q.log[0].inputs.l, q.log[0].inputs.n], [5, 9, 2]); // a snapshot id from another lesson/course can never match
  assert.strictEqual((await get([snapRow("{not json")])).code, "VERSION_UNREADABLE");
  assert.strictEqual((await get([snapRow([{ type: "image", url: "/uploads/school2/lms/a.png", alt: "x" }])])).code, "VERSION_UNREADABLE"); // snapshot pointing at another school
  assert.strictEqual((await get([snapRow([{ type: "script" }])])).code, "VERSION_UNREADABLE");
  assert.strictEqual((await get([])).notFound, true);
  assert.strictEqual((await L.getVersion(makeMockPool([[SNAP, onlyIds("n", [2], [snapRow([])])]]).pool, 5, 9, 7, T)).notFound, true); // a different version number never matches
});

/* ---------------- restore ---------------- */
test("restoreVersion: old blocks go through a normal guarded save as a NEW version; history is never rewritten; audited", async () => {
  const old = [{ type: "text", html: "<p>Old</p>" }, img()];
  const m = makeMockPool([live(), [SNAP, onlyIds("c", [5], onlyIds("l", [9], onlyIds("n", [2], [snapRow(old)])))], [TX, () => [{ new_version: 6, lesson_exists: 1 }]], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]]);
  const r = await L.restoreVersion(m.pool, teacher(), 5, 9, 2, { baseVersion: 5 }, T); assert.ok(r.ok); assert.strictEqual(r.contentVersion, 6);
  const tx = m.log.find((x) => x.sql.includes("BEGIN TRAN")); assert.ok(tx.sql.includes("content_version = @v") && tx.inputs.v === 5); assert.strictEqual(tx.inputs.lbl, "Restored from version 2"); assert.deepStrictEqual(JSON.parse(tx.inputs.snap), old);
  assert.ok(!m.log.some((x) => /UPDATE lms_lesson_versions|DELETE FROM lms_lesson_versions WHERE (?!lesson_id = @l AND course_id = @c AND version_no <= @new)/.test(x.sql)));
  const a = m.log.find((x) => x.inputs.act === "lesson.version_restored"); assert.ok(a);
});
test("restoreVersion: stale editor gets a conflict; archived/pending course refused before the snapshot is read; bad bodies and unknown versions rejected", async () => {
  const snap = [SNAP, () => [snapRow([{ type: "divider" }])]];
  const stale = makeMockPool([live(), snap, [TX, () => [{ new_version: null, lesson_exists: 1 }]]]); const c = await L.restoreVersion(stale.pool, teacher(), 5, 9, 2, { baseVersion: 1 }, T); assert.strictEqual(c.code, "CONTENT_CONFLICT"); assert.ok(!stale.log.some((x) => x.inputs.act));
  const arch = makeMockPool([live("archived"), snap]); assert.strictEqual((await L.restoreVersion(arch.pool, teacher(), 5, 9, 2, { baseVersion: 1 }, T)).code, "COURSE_ARCHIVED"); assert.ok(!arch.log.some((x) => x.sql.includes("blocks_json")));
  const pend = makeMockPool([live("pending"), snap]); assert.strictEqual((await L.restoreVersion(pend.pool, teacher(), 5, 9, 2, { baseVersion: 1 }, T)).code, "COURSE_PENDING");
  for (const b of [{}, { baseVersion: "x" }, { baseVersion: 1, blocks: [] }, null, []]) { const n = makeMockPool([live(), snap]); assert.strictEqual((await L.restoreVersion(n.pool, teacher(), 5, 9, 2, b, T)).ok, false); assert.strictEqual(n.log.length, 0); }
  const none = makeMockPool([live(), [SNAP, () => []]]); assert.strictEqual((await L.restoreVersion(none.pool, teacher(), 5, 9, 2, { baseVersion: 1 }, T)).notFound, true); assert.ok(!none.log.some((x) => x.sql.includes("BEGIN TRAN")));
  const bad = makeMockPool([live(), [SNAP, () => [snapRow("{broken")]]]); assert.strictEqual((await L.restoreVersion(bad.pool, teacher(), 5, 9, 2, { baseVersion: 1 }, T)).code, "VERSION_UNREADABLE"); assert.ok(!bad.log.some((x) => x.sql.includes("BEGIN TRAN")));
});

/* ---------------- preview ---------------- */
test("previewLesson: staff see the student shape for drafts and scheduled lessons, with the visibility reason; no staff-only fields", async () => {
  const mk = (row) => makeMockPool([["SELECT TOP 1 id, course_id, section_id, title", onlyIds("c", [5], onlyIds("id", [9], [row]))], ["FROM lms_lesson_blocks WHERE lesson_id", () => [{ id: 1, block_type: "text", sort_order: 10, html: "<p>x</p>", data: null }]]]).pool;
  const d = await L.previewLesson(mk(les()), 5, 9); assert.ok(d.ok); assert.strictEqual(d.preview.visibleToStudents, false); assert.strictEqual(d.preview.status, "draft"); assert.ok(!("contentVersion" in d.lesson) && !("status" in d.lesson) && !("publishAt" in d.lesson)); assert.strictEqual(d.blocks.length, 1);
  const s = await L.previewLesson(mk(les({ status: "published", publish_at: new Date(Date.now() + 86400000) })), 5, 9); assert.strictEqual(s.preview.visibleToStudents, false); assert.ok(s.preview.publishAt);
  const p = await L.previewLesson(mk(les({ status: "published" })), 5, 9); assert.strictEqual(p.preview.visibleToStudents, true);
  assert.strictEqual((await L.previewLesson(mk(les()), 5, 77)).notFound, true); assert.strictEqual((await L.previewLesson(mk(les()), 6, 9)).notFound, true);
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
const LI = "/courses/:courseId/lessons/:lessonId", VL = `${LI}/versions`, VO = `${LI}/versions/:versionNo`, VR = `${LI}/versions/:versionNo/restore`, PV = `${LI}/preview`;
const prm = (o = {}) => ({ courseId: "5", lessonId: "9", versionNo: "2", ...o });

test("routes: staff read history and preview; restore works for owner and co-teacher; students and non-members get the same 403 and nothing is written", async () => {
  const mkRestore = (role) => makeMockPool([staff([5], role), live(), [SNAP, () => [snapRow([{ type: "divider" }])]], [TX, () => [{ new_version: 7, lesson_exists: 1 }]], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]]);
  for (const role of ["teacher", "co_teacher"]) { const r = await call("post", VR, { user: teacher(), pool: mkRestore(role).pool, params: prm(), body: { baseVersion: 6 }, tenant: T }); assert.strictEqual(r.res.statusCode, 200, role); assert.strictEqual(r.res.body.contentVersion, 7); }
  const g = await call("get", VL, { user: teacher(), pool: makeMockPool([staff([5]), ["SELECT TOP 1 id FROM lms_lessons WHERE id", () => [{ id: 9 }]], ["SELECT TOP 50 version_no", () => [{ version_no: 3, title: "Cells", label: null, created_by_source: null, created_by: null, created_at: "x" }]]]).pool, params: prm() }); assert.strictEqual(g.res.statusCode, 200); assert.strictEqual(g.res.body.versions.length, 1);
  const one = await call("get", VO, { user: teacher(), pool: makeMockPool([staff([5]), [SNAP, () => [snapRow([{ type: "divider" }])]]]).pool, params: prm(), tenant: T }); assert.strictEqual(one.res.statusCode, 200); assert.deepStrictEqual(one.res.body.blocks, [{ type: "divider" }]);
  const pv = await call("get", PV, { user: teacher(), pool: makeMockPool([staff([5]), ["SELECT TOP 1 id, course_id, section_id, title", () => [les()]], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]]).pool, params: prm() }); assert.strictEqual(pv.res.statusCode, 200); assert.strictEqual(pv.res.body.preview.visibleToStudents, false);
  const refused = [];
  for (const [method, p, user, pool, courseId] of [["post", VR, student(), makeMockPool([enrolled([5]), live()]), "5"], ["post", VR, teacher(), mkRestore("teacher"), "6"], ["get", VL, student(), makeMockPool([enrolled([5])]), "5"], ["get", VO, teacher(), mkRestore("teacher"), "6"], ["get", PV, student(), makeMockPool([enrolled([5])]), "5"], ["get", PV, teacher(), mkRestore("teacher"), "6"]]) {
    const r = await call(method, p, { user, pool: pool.pool, params: prm({ courseId }), body: { baseVersion: 1 }, tenant: T }); assert.strictEqual(r.res.statusCode, 403, `${method} ${p}`); assert.ok(!pool.log.some((x) => x.sql.includes("BEGIN TRAN") || x.sql.startsWith("INSERT"))); refused.push(r.res);
  }
});
test("routes: bad ids 404, stale restore 409, unreadable snapshot 409, bad body 400", async () => {
  const pool = (extra = []) => makeMockPool([staff([5]), live(), ...extra]).pool;
  for (const [method, p, params] of [["get", VO, prm({ versionNo: "x" })], ["get", VO, prm({ versionNo: "0" })], ["post", VR, prm({ versionNo: "abc" })], ["get", VL, prm({ lessonId: "x" })], ["get", PV, prm({ lessonId: "-1" })]]) assert.strictEqual((await call(method, p, { user: teacher(), pool: pool(), params, body: { baseVersion: 1 }, tenant: T })).res.statusCode, 404, `${p} ${JSON.stringify(params)}`);
  const stale = await call("post", VR, { user: teacher(), pool: pool([[SNAP, () => [snapRow([])]], [TX, () => [{ new_version: null, lesson_exists: 1 }]]]), params: prm(), body: { baseVersion: 1 }, tenant: T }); assert.deepStrictEqual([stale.res.statusCode, stale.res.body.code], [409, "CONTENT_CONFLICT"]);
  const unread = await call("post", VR, { user: teacher(), pool: pool([[SNAP, () => [snapRow("{x")]]]), params: prm(), body: { baseVersion: 1 }, tenant: T }); assert.deepStrictEqual([unread.res.statusCode, unread.res.body.code], [409, "VERSION_UNREADABLE"]);
  const noBody = await call("post", VR, { user: teacher(), pool: pool(), params: prm(), body: {}, tenant: T }); assert.strictEqual(noBody.res.statusCode, 400);
  const missing = await call("post", VR, { user: teacher(), pool: pool([[SNAP, () => []]]), params: prm({ versionNo: "99" }), body: { baseVersion: 1 }, tenant: T }); assert.strictEqual(missing.res.statusCode, 404);
});
test("isolation: school B's lessons and versions never resolve in school A; B's database is never queried", async () => {
  const Tn = makeTenants({
    isoA: [staff([1]), live(), [SNAP, onlyIds("c", [1], onlyIds("l", [10], [snapRow([{ type: "divider" }])]))], [TX, (i) => (i.c === 1 && i.l === 10 ? [{ new_version: 5, lesson_exists: 1 }] : [{ new_version: null, lesson_exists: 0 }])], ["FROM lms_lesson_blocks WHERE lesson_id", () => []],
      ["SELECT TOP 1 id FROM lms_lessons WHERE id", onlyIds("c", [1], onlyIds("id", [10], [{ id: 10 }]))], ["SELECT TOP 50 version_no", () => []]],
    isoB: [staff([2]), live(), [SNAP, () => [snapRow([{ type: "divider" }])]], ["SELECT TOP 1 id FROM lms_lessons WHERE id", () => [{ id: 30 }]]],
  });
  const own = await call("post", VR, { user: teacher(), pool: Tn.isoA.pool, params: prm({ courseId: "1", lessonId: "10" }), body: { baseVersion: 4 }, tenant: "isoA" }); assert.strictEqual(own.res.statusCode, 200);
  const foreign = await call("post", VR, { user: teacher(), pool: Tn.isoA.pool, params: prm({ courseId: "1", lessonId: "30" }), body: { baseVersion: 1 }, tenant: "isoA" }); assert.strictEqual(foreign.res.statusCode, 404);
  const foreignList = await call("get", VL, { user: teacher(), pool: Tn.isoA.pool, params: prm({ courseId: "1", lessonId: "30" }), tenant: "isoA" }); assert.strictEqual(foreignList.res.statusCode, 404);
  const otherCourse = await call("get", VO, { user: teacher(), pool: Tn.isoA.pool, params: prm({ courseId: "2", lessonId: "30" }), tenant: "isoA" }); const missing = await call("get", VO, { user: teacher(), pool: Tn.isoA.pool, params: prm({ courseId: "999", lessonId: "30" }), tenant: "isoA" }); sameForbidden(otherCourse.res, missing.res);
  Tn.assertUntouched("isoB");
});

/* ---------------- static ---------------- */
test("static: step 010 is additive and guarded; new table blocklisted; every new route behind the gate with permission/membership; no raw db", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "010_lms_lesson_versions"); assert.ok(st && STEPS.indexOf(st) > STEPS.findIndex((s) => s.id === "009_lms_media"));
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); assert.ok(/CREATE TABLE lms_lesson_versions/.test(ddl) && /CREATE UNIQUE INDEX IX_lms_lesson_versions_lesson ON lms_lesson_versions \(lesson_id, version_no\)/.test(ddl));
  assert.ok(/IF COL_LENGTH\('lms_lessons', 'publish_at'\) IS NULL\s+ALTER TABLE lms_lessons ADD publish_at DATETIME2 NULL/.test(ddl)); assert.strictEqual((ddl.match(/ALTER/g) || []).length, 1);
  const router = require("../routes/lms"), first = router.stack.findIndex((l) => l.route);
  const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/lessons\/:lessonId\/(versions|preview)/.test(l.route.path)); assert.strictEqual(mine.length, 4);
  for (const l of mine) { assert.ok(router.stack.indexOf(l) > first); assert.ok(l.route.stack.length >= (l.route.methods.post ? 3 : 2), l.route.path); }
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(/RECORD_TABLE_BLOCKLIST[^;]*"lms_lesson_versions"/.test(server));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsLessons.js"), "utf8"); assert.ok(!/mssql"\)\.connect|new sql\.ConnectionPool|getPool|poolPromise/.test(src)); assert.ok(!/SELECT \*/.test(src));
  assert.ok(/UPDATE lms_lesson_versions/.test(src) === false); // history is append-only from the application's side
});
