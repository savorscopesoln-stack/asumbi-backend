/* L4.4a — course and school-wide announcements. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsAnnouncements.test.js");
const A = require("../utils/lmsAnnouncements");
const { on } = require("../utils/lmsEvents");

const admin = { id: 1, role: "admin", source: "Users" }, teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const row = (o = {}) => ({ id: 4, course_id: 5, title: "Exam dates", body: "See the notice board.", status: "draft", pinned: 0, published_at: null, created_at: "x", updated_at: "x", ...o });
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_announcements", () => [{ n }]];
const LOAD = (r) => ["FROM lms_announcements WHERE id = @id", (i) => (r && i.id === r.id && (r.course_id === null ? true : i.c === r.course_id) ? [r] : [])];
const OWN = /^(INSERT INTO lms_announcements|UPDATE lms_announcements)/, writes = (log) => log.filter((x) => OWN.test(x.sql));
const events = (tenant) => { const got = []; const off = on("lms.announcement.published", (e) => { if (e.tenant === tenant) got.push(e); }); return { got, off }; };

test("validate: title and plain-text body required; tags and control characters stripped; pinned boolean; status draft|published; unknown fields refused; partial needs a field", () => {
  const ok = A.validate({ title: " <b>Hi</b> ", body: "Line 1\r\n\r\n\r\n\r\nLine 2 <script>", pinned: true, status: "published" });
  assert.deepStrictEqual(ok.value, { title: "bHi/b", body: "Line 1\n\nLine 2 script", pinned: true, status: "published" });
  for (const b of [{}, { title: "", body: "x" }, { title: "x", body: "" }, { title: "x".repeat(201), body: "b" }, { title: "t", body: "b".repeat(4001) }, { title: "t", body: "b", pinned: "yes" }, { title: "t", body: "b", status: "archived" }, { title: "t", body: "b", course_id: 9 }, { title: "t", body: "b", published_at: "x" }, null, []]) assert.strictEqual(A.validate(b).ok, false, JSON.stringify(b)?.slice(0, 60));
  assert.strictEqual(A.validate({}, { partial: true }).ok, false); assert.strictEqual(A.validate({ pinned: false }, { partial: true }).value.pinned, false);
});
test("create: draft stays private and emits nothing; published sets published_at in SQL and emits ONE event; values only as parameters", async () => {
  const E = events("annT1");
  const d = makeMockPool([live("draft"), COUNT(2), ["INSERT INTO lms_announcements", (i) => [row({ title: i.t, status: i.st })]]]); const a = await A.createAnnouncement(d.pool, teacher(), 5, { title: "Hello", body: "World" }, "annT1");
  assert.ok(a.ok && a.announcement.status === "draft" && a.announcement.publishedAt === null);
  const p = makeMockPool([live("published"), COUNT(2), ["INSERT INTO lms_announcements", (i) => [row({ id: 8, status: i.st, published_at: "now" })]]]); const b = await A.createAnnouncement(p.pool, teacher(), 5, { title: "Hello", body: "World", status: "published" }, "annT1");
  assert.ok(b.ok && b.announcement.status === "published"); const w = writes(p.log)[0]; assert.ok(/CASE WHEN @st = 'published' THEN SYSUTCDATETIME\(\)/.test(w.sql) && !/Hello|World/.test(w.sql) && w.inputs.c === 5 && w.inputs.t === "Hello");
  await tick(); E.off(); assert.deepStrictEqual(E.got.map((e) => [e.courseId, e.announcementId]), [[5, 8]]);
  assert.ok(p.log.some((x) => /lms_audit_log/.test(x.sql)));
});
test("create: archived/pending course refused; limit reached -> ANNOUNCEMENT_LIMIT; invalid body asks nothing", async () => {
  const ar = makeMockPool([live("archived"), COUNT(0)]); const a = await A.createAnnouncement(ar.pool, teacher(), 5, { title: "t", body: "b" }, "t"); assert.deepStrictEqual([a.ok, a.code], [false, "COURSE_ARCHIVED"]); assert.strictEqual(writes(ar.log).length, 0);
  const full = makeMockPool([live("published"), COUNT(A.MAX_PER_SCOPE)]); assert.strictEqual((await A.createAnnouncement(full.pool, teacher(), 5, { title: "t", body: "b" }, "t")).code, "ANNOUNCEMENT_LIMIT"); assert.strictEqual(writes(full.log).length, 0);
  const bad = makeMockPool([]); assert.strictEqual((await A.createAnnouncement(bad.pool, teacher(), 5, { title: "" }, "t")).ok, false); assert.strictEqual(bad.log.length, 0);
});
test("school-wide: no course lookup, scoped by course_id IS NULL, course_id parameter is null", async () => {
  const m = makeMockPool([COUNT(0), ["INSERT INTO lms_announcements", () => [row({ id: 9, course_id: null })]]]); const r = await A.createAnnouncement(m.pool, admin, null, { title: "Holiday", body: "Closed Friday" }, "t");
  assert.ok(r.ok && r.announcement.courseId === null); assert.ok(!m.log.some((x) => /lms_courses/.test(x.sql))); assert.ok(/course_id IS NULL/.test(m.log[0].sql)); assert.strictEqual(writes(m.log)[0].inputs.c, null);
});
test("update: nothing changed -> no write; first publish emits once and keeps published_at; already published -> no second event; a row of another course is 'not found'", async () => {
  const E = events("annT2");
  const same = makeMockPool([live(), LOAD(row())]); assert.ok((await A.updateAnnouncement(same.pool, teacher(), 5, 4, { title: "Exam dates" }, "annT2")).unchanged); assert.strictEqual(writes(same.log).length, 0);
  const m = makeMockPool([live(), LOAD(row()), ["UPDATE lms_announcements SET", () => [row({ status: "published", published_at: "now" })]]]); const r = await A.updateAnnouncement(m.pool, teacher(), 5, 4, { status: "published", pinned: true }, "annT2"); assert.ok(r.ok && r.announcement.status === "published");
  const w = writes(m.log)[0]; assert.ok(/status = @st, published_at = COALESCE\(published_at, SYSUTCDATETIME\(\)\)/.test(w.sql) && /course_id = @c AND deleted_at IS NULL/.test(w.sql) && /pinned = @pin/.test(w.sql));
  const again = makeMockPool([live(), LOAD(row({ status: "published", published_at: "t0" })), ["UPDATE lms_announcements SET", () => [row({ status: "published", title: "New", published_at: "t0" })]]]); await A.updateAnnouncement(again.pool, teacher(), 5, 4, { title: "New", status: "published" }, "annT2");
  const other = makeMockPool([live(), LOAD(row({ course_id: 6 }))]); assert.strictEqual((await A.updateAnnouncement(other.pool, teacher(), 5, 4, { title: "x" }, "annT2")).notFound, true); assert.strictEqual(writes(other.log).length, 0);
  await tick(); E.off(); assert.strictEqual(E.got.length, 1);
  const un = makeMockPool([live(), LOAD(row({ status: "published", published_at: "t0" })), ["UPDATE lms_announcements SET", () => [row()]]]); assert.ok((await A.updateAnnouncement(un.pool, teacher(), 5, 4, { status: "draft" }, "annT2")).ok); assert.ok(!/published_at/.test(writes(un.log)[0].sql.replace(/OUTPUT[\s\S]*WHERE/, ""))); // unpublishing keeps published_at
});
test("delete: soft delete only, course-scoped; missing -> not found", async () => {
  const m = makeMockPool([live(), ["UPDATE lms_announcements SET deleted_at", () => [{ id: 4 }]]]); assert.ok((await A.deleteAnnouncement(m.pool, teacher(), 5, 4)).ok);
  assert.ok(!m.log.some((x) => /DELETE FROM lms_announcements/.test(x.sql)) && /course_id = @c AND deleted_at IS NULL/.test(writes(m.log)[0].sql));
  assert.strictEqual((await A.deleteAnnouncement(makeMockPool([live(), ["UPDATE lms_announcements SET deleted_at", () => []]]).pool, teacher(), 5, 4)).notFound, true);
});
test("students: course list shows PUBLISHED rows of an open course only (pinned first); my-list joins ACTIVE enrolment and published courses, student id from the argument", async () => {
  const m = makeMockPool([live(), ["FROM lms_announcements WHERE course_id = @c AND status = 'published'", () => [{ ...row({ status: "published", pinned: 1 }), total_count: 31 }]]]);
  const r = await A.listForStudentCourse(m.pool, 5, { page: 2, pageSize: 500 }); assert.deepStrictEqual([r.ok, r.total, r.page, r.pageSize, r.items[0].pinned], [true, 31, 2, 100, true]); assert.ok(/ORDER BY pinned DESC, published_at DESC/.test(m.log[1].sql) && m.log[1].inputs.off === 100);
  assert.strictEqual((await A.listForStudentCourse(makeMockPool([["FROM lms_courses WHERE id", () => []]]).pool, 5)).notFound, true); // draft/deleted course
  const me = makeMockPool([["FROM lms_announcements a LEFT JOIN lms_courses c", () => [{ ...row({ id: 7, course_id: 5, status: "published" }), course_title: "Biology", total_count: 1 }]]]); const x = await A.listForStudentMe(me.pool, 21, {});
  assert.deepStrictEqual([x.items[0].courseTitle, me.log[0].inputs.s], ["Biology", 21]); assert.ok(/e\.student_id = @s AND e\.status = 'active'/.test(me.log[0].sql) && /a\.status = 'published'/.test(me.log[0].sql) && /c\.status IN \('published','archived'\)/.test(me.log[0].sql) && /a\.course_id IS NULL OR/.test(me.log[0].sql));
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
const AC = "/courses/:courseId/announcements", AI = "/courses/:courseId/announcements/:announcementId";
const INS = ["INSERT INTO lms_announcements", () => [row({ id: 8 })]];
test("routes: course staff write announcements (needs lms.course.manage); students, strangers and other courses get the same 403 and nothing is written", async () => {
  const mk = (role = "teacher") => makeMockPool([staff([5], role), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row()), ["FROM lms_announcements WHERE course_id = @c AND deleted_at IS NULL", () => [{ ...row(), total_count: 1 }]], ["UPDATE lms_announcements SET", () => [row({ title: "New" })]]]);
  for (const role of ["teacher", "co_teacher"]) { const r = await call("post", AC, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body: { title: "Hi", body: "there" } }); assert.strictEqual(r.res.statusCode, 201, role); }
  assert.strictEqual((await call("get", AC, { user: teacher(), pool: mk().pool, params: { courseId: "5" } })).res.statusCode, 200);
  assert.strictEqual((await call("patch", AI, { user: teacher(), pool: mk().pool, params: { courseId: "5", announcementId: "4" }, body: { title: "New" } })).res.statusCode, 200);
  const refused = [];
  for (const [user, courseId] of [[student(), "5"], [teacher(), "6"], [teacher(), "999"]]) for (const [m, p, body] of [["post", AC, { title: "Hi", body: "b" }], ["delete", AI, {}]]) { const k = mk(); const r = await call(m, p, { user, pool: k.pool, params: { courseId, announcementId: "4" }, body }); assert.strictEqual(r.res.statusCode, 403, `${m} ${courseId}`); assert.strictEqual(writes(k.log).length, 0); if (m === "post") refused.push(r.res); }
  sameForbidden(refused[1], refused[2]);
  assert.strictEqual((await call("post", AC, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, body: { title: "" } })).res.statusCode, 400);
  assert.strictEqual((await call("patch", AI, { user: teacher(), pool: mk().pool, params: { courseId: "5", announcementId: "x" }, body: { title: "a" } })).res.statusCode, 404);
});
test("routes: school-wide announcements are LMS-admin only; teachers and students are refused with nothing written", async () => {
  const pool = () => makeMockPool([COUNT(0), ["INSERT INTO lms_announcements", () => [row({ id: 9, course_id: null })]], ["FROM lms_announcements WHERE course_id IS NULL AND deleted_at IS NULL", () => [{ ...row({ course_id: null }), total_count: 1 }]], LOAD(row({ course_id: null })), ["UPDATE lms_announcements SET deleted_at", () => [{ id: 4 }]]]);
  for (const [m, p, body] of [["get", "/announcements"], ["post", "/announcements", { title: "t", body: "b" }], ["get", "/announcements/:announcementId"], ["patch", "/announcements/:announcementId", { title: "x" }], ["delete", "/announcements/:announcementId"]]) for (const user of [teacher(), student()]) { const k = pool(); assert.strictEqual((await call(m, p, { user, pool: k.pool, params: { announcementId: "4" }, body: body || {} })).res.statusCode, 403, `${m} ${p}`); assert.strictEqual(writes(k.log).length, 0); }
  assert.strictEqual((await call("post", "/announcements", { user: admin, pool: pool().pool, body: { title: "Holiday", body: "Closed" } })).res.statusCode, 201);
  assert.strictEqual((await call("get", "/announcements", { user: admin, pool: pool().pool })).res.body.items.length, 1);
  assert.strictEqual((await call("delete", "/announcements/:announcementId", { user: admin, pool: pool().pool, params: { announcementId: "4" } })).res.statusCode, 200);
});
test("routes: students read only through studentOnly; the course list needs an ACTIVE enrolment; staff and strangers are refused", async () => {
  const mk = () => makeMockPool([enrolled([5]), live("published"), ["FROM lms_announcements WHERE course_id = @c AND status = 'published'", () => [{ ...row({ status: "published" }), total_count: 1 }]], ["FROM lms_announcements a LEFT JOIN", () => [{ ...row({ status: "published" }), course_title: "Bio", total_count: 1 }]]]);
  const a = await call("get", "/courses/:courseId/learn/announcements", { user: student(), pool: mk().pool, params: { courseId: "5" } }); assert.strictEqual(a.res.statusCode, 200); assert.strictEqual(a.res.body.items.length, 1);
  const b = await call("get", "/courses/:courseId/learn/announcements", { user: student(), pool: mk().pool, params: { courseId: "6" } }); assert.strictEqual(b.res.statusCode, 403);
  const c = await call("get", "/courses/:courseId/learn/announcements", { user: teacher(), pool: mk().pool, params: { courseId: "5" } }); assert.strictEqual(c.res.statusCode, 403);
  const m = mk(); const me = await call("get", "/me/announcements", { user: student(33), pool: m.pool }); assert.strictEqual(me.res.statusCode, 200); assert.strictEqual(m.log[0].inputs.s, 33);
  assert.strictEqual((await call("get", "/me/announcements", { user: teacher(), pool: mk().pool })).res.statusCode, 403);
});
test("tenant isolation: school A's announcement calls never touch school B's database", async () => {
  const T = makeTenants({ A: [staff([5]), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row())], B: [staff([5]), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row())] });
  const r = await call("post", AC, { user: teacher(), pool: T.A.pool, params: { courseId: "5" }, body: { title: "Hi", body: "b" }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 201); T.assertQueried("A"); T.assertUntouched("B");
  const g = await call("get", "/me/announcements", { user: student(), pool: T.A.pool, tenant: "A" }); assert.strictEqual(g.res.statusCode, 200); T.assertUntouched("B");
});
test("static: step 014 additive; table blocklisted; event registered; all 12 routes behind the gate with a permission/student check; no raw db, no req.body, no user value in SQL text", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "014_lms_announcements"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "013_lms_learning_outcomes") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl) && /CREATE TABLE lms_announcements/.test(ddl) && /course_id INT NULL/.test(ddl) && /IX_lms_announcements_course/.test(ddl));
  assert.ok(/"lms_announcements"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"))); assert.ok(require("../utils/lmsEvents").EVENTS.includes("lms.announcement.published"));
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && (/^\/announcements/.test(l.route.path) || /^\/courses\/:courseId\/announcements/.test(l.route.path) || ["/courses/:courseId/learn/announcements", "/me/announcements"].includes(l.route.path))); assert.strictEqual(mine.length, 12);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(l.route.stack.length >= 2 || /^\/(me|announcements)/.test(l.route.path), l.route.path); assert.ok(router.stack.indexOf(l) > first && first >= 2); }
  for (const l of mine.filter((x) => x.route.methods.post || x.route.methods.patch || x.route.methods.delete)) assert.ok(l.route.stack.length >= (/^\/announcements/.test(l.route.path) ? 2 : 3), l.route.path);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsAnnouncements.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{[^}]*\b(title|body|val|v\.value|studentId|id)\b/.test(piece), "no user value in SQL: " + piece.slice(0, 50));
});
