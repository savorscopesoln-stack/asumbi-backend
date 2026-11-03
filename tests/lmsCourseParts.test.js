/* L2.2 — sections, co-teachers, course calendar. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsCourseParts.test.js");
const P = require("../utils/lmsCourseParts");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const admin = { id: 1, role: "admin", source: "Users" };
const student = { id: 7, role: "student", source: "Students" };
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const sec = (o = {}) => ({ id: 3, course_id: 5, title: "Cells", summary: null, sort_order: 10, ...o });
const ev = (o = {}) => ({ id: 4, course_id: 5, title: "Quiz", event_type: "event", starts_at: "2026-11-01T08:00:00Z", ends_at: null, all_day: 0, ...o });

/* ---- validation ---- */
test("section validation: title required, plain text, unknown fields rejected; partial needs something", () => {
  assert.deepStrictEqual(P.validateSection({ title: "  <b>Cells</b> " }).value, { title: "bCells/b" });
  for (const b of [{}, { title: "" }, { title: "x".repeat(201) }, { title: "ok", sort_order: 1 }, { title: "ok", summary: "x".repeat(1001) }, null, []]) assert.strictEqual(P.validateSection(b).ok, false, JSON.stringify(b)?.slice(0, 50));
  assert.strictEqual(P.validateSection({}, { partial: true }).ok, false); assert.strictEqual(P.validateSection({ summary: null }, { partial: true }).value.summary, null);
});

test("event validation: ISO dates, known types, end not before start", () => {
  assert.ok(P.validateEvent({ title: "Test", startsAt: "2026-11-01T08:00:00Z", endsAt: "2026-11-01T09:00:00Z", eventType: "exam", allDay: false }).ok);
  for (const b of [{ title: "t" }, { title: "t", startsAt: "tomorrow" }, { title: "t", startsAt: "2026-11-02T08:00:00Z", endsAt: "2026-11-01T08:00:00Z" }, { title: "t", startsAt: "2026-11-01T08:00:00Z", eventType: "party" }, { title: "t", startsAt: "2026-11-01T08:00:00Z", allDay: "yes" }, { title: "t", startsAt: "2026-11-01T08:00:00Z", courseId: 9 }]) assert.strictEqual(P.validateEvent(b).ok, false, JSON.stringify(b));
});

test("staff input validation: only Teachers/Users sources, positive integer id", () => {
  assert.ok(P.validateStaffInput({ source: "Teachers", id: "12" }).ok);
  for (const b of [{ source: "Students", id: 1 }, { source: "Teachers", id: 0 }, { source: "Teachers", id: "1; DROP" }, { source: "Teachers", id: 1, role: "owner" }, null]) assert.strictEqual(P.validateStaffInput(b).ok, false, JSON.stringify(b));
});

/* ---- sections ---- */
test("createSection: placed last (max+10) via parameters, audited; limit and archived/missing courses refused", async () => {
  const m = makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_course_sections", () => [{ n: 2 }]], ["INSERT INTO lms_course_sections", () => [sec({ sort_order: 30 })]]]);
  const r = await P.createSection(m.pool, teacher(), 5, { title: "Cells" });
  assert.ok(r.ok); assert.strictEqual(r.section.sortOrder, 30);
  const q = m.log.find((l) => l.sql.includes("INSERT INTO lms_course_sections")); assert.ok(q.sql.includes("ISNULL(MAX(sort_order), 0) + 10") && !q.sql.includes("Cells"));
  assert.ok(m.log.some((l) => l.inputs.act === "section.created"));
  const full = makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_course_sections", () => [{ n: 100 }]]]);
  assert.strictEqual((await P.createSection(full.pool, teacher(), 5, { title: "x" })).code, "LIMIT_REACHED");
  assert.strictEqual((await P.createSection(makeMockPool([live("archived")]).pool, teacher(), 5, { title: "x" })).code, "COURSE_ARCHIVED");
  assert.strictEqual((await P.createSection(makeMockPool([]).pool, teacher(), 5, { title: "x" })).notFound, true);
  const none = makeMockPool([]); assert.strictEqual((await P.createSection(none.pool, teacher(), 5, { title: "" })).ok, false); assert.strictEqual(none.log.length, 0);
});

test("update/delete section: always match section id AND course id; a section of another course is 'not found'; delete is soft", async () => {
  const m = makeMockPool([live(), ["UPDATE lms_course_sections SET title", onlyIds("id", [3], [sec({ title: "New" })])], ["UPDATE lms_course_sections SET deleted_at", onlyIds("id", [3], [{ id: 3 }])]]);
  const u = await P.updateSection(m.pool, teacher(), 5, 3, { title: "New" }); assert.ok(u.ok);
  const q = m.log.find((l) => l.sql.includes("SET title")); assert.ok(q.sql.includes("course_id = @c") && q.sql.includes("deleted_at IS NULL")); assert.strictEqual(q.inputs.c, 5);
  assert.strictEqual((await P.updateSection(m.pool, teacher(), 5, 99, { title: "New" })).notFound, true);
  assert.ok((await P.deleteSection(m.pool, teacher(), 5, 3)).ok); assert.strictEqual((await P.deleteSection(m.pool, teacher(), 5, 99)).notFound, true);
  assert.ok(!m.log.some((l) => /DELETE\s+FROM/i.test(l.sql)));
});

test("reorderSections: must list every live section of THIS course exactly once; applied in one transaction", async () => {
  const cur = () => makeMockPool([live(), ["SELECT TOP 100 id FROM lms_course_sections", () => [{ id: 1 }, { id: 2 }, { id: 3 }]]]);
  const a = cur(); assert.ok((await P.reorderSections(a.pool, teacher(), 5, [3, 1, 2])).ok);
  const tx = a.log.find((l) => l.sql.includes("BEGIN TRAN")); assert.ok(tx.sql.includes("COMMIT") && (tx.sql.match(/UPDATE lms_course_sections/g) || []).length === 3); assert.deepStrictEqual([tx.inputs.i0, tx.inputs.o0, tx.inputs.o2], [3, 10, 30]);
  assert.ok(tx.sql.split("UPDATE").slice(1).every((x) => x.includes("course_id = @c")));
  for (const ids of [[1, 2], [1, 2, 3, 4], [1, 2, 99], [1, 1, 2], [1, 2, "x"], "no"]) { const b = cur(); const r = await P.reorderSections(b.pool, teacher(), 5, ids); assert.strictEqual(r.ok, false, JSON.stringify(ids)); assert.ok(!b.log.some((l) => l.sql.includes("BEGIN TRAN"))); }
});

/* ---- co-teachers ---- */
test("addCoTeacher: must exist (explicit columns only), becomes co_teacher; duplicates, owner and limit are refused; former staff are reactivated", async () => {
  const base = (extra = []) => makeMockPool([live(), ["FROM Teachers WHERE id", () => [{ id: 8 }]], ["role) IN", () => [{ id: 2 }]], ["staff_role = 'co_teacher'", () => [{ n: 1 }]], ...extra]);
  const a = base(); assert.ok((await P.addCoTeacher(a.pool, teacher(), 5, { source: "Teachers", id: 8 })).ok);
  assert.ok(a.log.some((l) => l.sql.startsWith("INSERT INTO lms_course_staff") && l.sql.includes("'co_teacher'"))); assert.ok(a.log.some((l) => l.inputs.act === "course.coteacher.added"));
  assert.ok(a.log.every((l) => !/SELECT\s+\*/i.test(l.sql) && !/password/i.test(l.sql)));
  const none = makeMockPool([live(), ["FROM Teachers WHERE id", () => []]]); assert.strictEqual((await P.addCoTeacher(none.pool, teacher(), 5, { source: "Teachers", id: 999 })).ok, false);
  const dup = base([["TOP 1 staff_role, is_active", () => [{ staff_role: "co_teacher", is_active: 1 }]]]); assert.strictEqual((await P.addCoTeacher(dup.pool, teacher(), 5, { source: "Teachers", id: 8 })).code, "ALREADY_STAFF");
  const own = base([["TOP 1 staff_role, is_active", () => [{ staff_role: "teacher", is_active: 1 }]]]); const o = await P.addCoTeacher(own.pool, teacher(), 5, { source: "Teachers", id: 7 }); assert.ok(o.conflict && /owner/.test(o.errors[0]));
  const lim = makeMockPool([live(), ["FROM Teachers WHERE id", () => [{ id: 8 }]], ["staff_role = 'co_teacher'", () => [{ n: 10 }]]]); assert.strictEqual((await P.addCoTeacher(lim.pool, teacher(), 5, { source: "Teachers", id: 8 })).code, "LIMIT_REACHED");
  const re = base([["TOP 1 staff_role, is_active", () => [{ staff_role: "co_teacher", is_active: 0 }]]]); assert.ok((await P.addCoTeacher(re.pool, teacher(), 5, { source: "Teachers", id: 8 })).ok);
  assert.ok(re.log.some((l) => l.sql.startsWith("UPDATE lms_course_staff SET is_active = 1")) && !re.log.some((l) => l.sql.startsWith("INSERT INTO lms_course_staff")));
});

test("removeCoTeacher: only active co-teachers; the owner row cannot be removed here", async () => {
  const m = makeMockPool([live(), ["UPDATE lms_course_staff SET is_active = 0", (i) => (i.u === 8 ? [{ user_id: 8 }] : [])]]);
  assert.ok((await P.removeCoTeacher(m.pool, teacher(), 5, "Teachers", "8")).ok);
  const q = m.log.find((l) => l.sql.startsWith("UPDATE lms_course_staff")); assert.ok(q.sql.includes("staff_role = 'co_teacher'") && q.sql.includes("course_id = @c"));
  assert.strictEqual((await P.removeCoTeacher(m.pool, teacher(), 5, "Teachers", "7")).notFound, true, "owner id matches no co_teacher row");
  assert.strictEqual((await P.removeCoTeacher(m.pool, teacher(), 5, "Students", "8")).ok, false);
  assert.strictEqual((await P.removeCoTeacher(m.pool, teacher(), 5, "Teachers", "abc")).ok, false);
});

/* ---- calendar ---- */
test("calendar list: bounded window, parameters only, TOP 500; bad/oversized ranges refused without a query", async () => {
  const m = makeMockPool([["FROM lms_course_events", () => [ev()]]]);
  const r = await P.listEvents(m.pool, 5, { from: "2026-10-01", to: "2026-12-31", now: new Date("2026-10-28") });
  assert.ok(r.ok); assert.strictEqual(r.events[0].title, "Quiz"); assert.ok(m.log[0].sql.includes("TOP 500") && m.log[0].sql.includes("course_id = @c"));
  assert.ok(m.log[0].inputs.f instanceof Date);
  const d = makeMockPool([["FROM lms_course_events", () => []]]); assert.ok((await P.listEvents(d.pool, 5, { now: new Date("2026-10-28") })).ok);
  assert.ok(Math.round((d.log[0].inputs.t - d.log[0].inputs.f) / 864e5) === 210);
  const n = makeMockPool([]);
  for (const q of [{ from: "x", to: "2026-12-01" }, { from: "2026-12-01", to: "2026-01-01" }, { from: "2020-01-01", to: "2026-01-01" }]) assert.strictEqual((await P.listEvents(n.pool, 5, q)).ok, false);
  assert.strictEqual(n.log.length, 0);
});

test("calendar create/update/delete: course-scoped, end-before-start refused on update, soft delete, archived read-only", async () => {
  const m = makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_course_events", () => [{ n: 1 }]], ["INSERT INTO lms_course_events", () => [ev()]],
    ["TOP 1 starts_at, ends_at", onlyIds("id", [4], [{ starts_at: "2026-11-01T08:00:00Z", ends_at: null }])], ["UPDATE lms_course_events SET title", onlyIds("id", [4], [ev({ title: "Renamed" })])], ["UPDATE lms_course_events SET deleted_at", onlyIds("id", [4], [{ id: 4 }])]]);
  assert.ok((await P.createEvent(m.pool, teacher(), 5, { title: "Quiz", startsAt: "2026-11-01T08:00:00Z" })).ok);
  assert.ok((await P.updateEvent(m.pool, teacher(), 5, 4, { title: "Renamed" })).ok);
  assert.strictEqual((await P.updateEvent(m.pool, teacher(), 5, 4, { endsAt: "2026-10-01T08:00:00Z" })).ok, false, "end before the stored start");
  assert.strictEqual((await P.updateEvent(m.pool, teacher(), 5, 99, { title: "Nope" })).notFound, true);
  assert.ok((await P.deleteEvent(m.pool, teacher(), 5, 4)).ok); assert.strictEqual((await P.deleteEvent(m.pool, teacher(), 5, 99)).notFound, true);
  assert.ok(m.log.filter((l) => l.sql.includes("lms_course_events") && /WHERE id = @id/.test(l.sql)).every((l) => l.sql.includes("course_id = @c")));
  assert.strictEqual((await P.createEvent(makeMockPool([live("archived")]).pool, teacher(), 5, { title: "x", startsAt: "2026-11-01T08:00:00Z" })).code, "COURSE_ARCHIVED");
});

/* ---- routes ---- */
async function call(method, path, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]); assert.ok(layer, `${method} ${path}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const S = "/courses/:courseId/sections", E = "/courses/:courseId/calendar", ST = "/courses/:courseId/staff";

test("routes: a co-teacher edits sections and the calendar but CANNOT add or remove co-teachers; the owner can", async () => {
  const mk = (role) => makeMockPool([staff([5], role), live(), ["SELECT COUNT(*) AS n FROM lms_course_sections", () => [{ n: 0 }]], ["INSERT INTO lms_course_sections", () => [sec()]],
    ["FROM Teachers WHERE id", () => [{ id: 8 }]], ["staff_role = 'co_teacher'", () => [{ n: 0 }]], ["FROM lms_courses WHERE id", () => [{ status: "draft", id: 5, code: "B", title: "T", academic_year: 2026, visibility: "enrolled_only" }]], ["FROM lms_course_staff s", () => []]]);
  const a = await call("post", S, { user: teacher(), pool: mk("co_teacher").pool, params: { courseId: "5" }, body: { title: "Cells" } }); assert.strictEqual(a.res.statusCode, 201);
  const co = mk("co_teacher"); const b = await call("post", ST, { user: teacher(), pool: co.pool, params: { courseId: "5" }, body: { source: "Teachers", id: 8 } });
  assert.deepStrictEqual([b.res.statusCode, b.res.body.code], [403, "COURSE_ACCESS_DENIED"]); assert.ok(!co.log.some((l) => l.sql.startsWith("INSERT INTO lms_course_staff")));
  const c = await call("delete", "/courses/:courseId/staff/:source/:userId", { user: teacher(), pool: mk("co_teacher").pool, params: { courseId: "5", source: "Teachers", userId: "8" } }); assert.strictEqual(c.res.statusCode, 403);
  const d = await call("post", ST, { user: teacher(), pool: mk("teacher").pool, params: { courseId: "5" }, body: { source: "Teachers", id: 8 } }); assert.strictEqual(d.res.statusCode, 201);
});

test("routes: students and non-members are refused everywhere; duplicate/invalid inputs map to 409/400; bad ids are 404", async () => {
  const pool = () => makeMockPool([staff([5]), live(), ["SELECT COUNT(*) AS n FROM lms_course_sections", () => [{ n: 0 }]]]).pool;
  for (const [m, p, params, body] of [["get", S, { courseId: "5" }], ["post", S, { courseId: "5" }, { title: "x" }], ["get", E, { courseId: "5" }], ["post", E, { courseId: "5" }, { title: "x", startsAt: "2026-11-01T08:00:00Z" }], ["post", ST, { courseId: "5" }, { source: "Teachers", id: 8 }]]) {
    const r = await call(m, p, { user: student, pool: pool(), params, body }); assert.strictEqual(r.res.statusCode, 403, `${m} ${p}`);
    const o = await call(m, p, { user: teacher(9), pool: makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, params, body }); assert.strictEqual(o.res.statusCode, 403, `non-member ${m} ${p}`);
  }
  const bad1 = await call("post", S, { user: teacher(), pool: pool(), params: { courseId: "5" }, body: { title: "" } }); assert.deepStrictEqual([bad1.res.statusCode, bad1.res.body.code], [400, "VALIDATION_ERROR"]);
  const bad2 = await call("patch", "/courses/:courseId/sections/:sectionId", { user: teacher(), pool: pool(), params: { courseId: "5", sectionId: "abc" }, body: { title: "x" } }); assert.strictEqual(bad2.res.statusCode, 404);
  const cal = await call("get", E, { user: teacher(), pool: pool(), params: { courseId: "5" }, query: { from: "bad" } }); assert.strictEqual(cal.res.statusCode, 400);
  const dup = makeMockPool([["TOP 1 staff_role, is_active", () => [{ staff_role: "co_teacher", is_active: 1 }]], staff([5]), live(), ["FROM Teachers WHERE id", () => [{ id: 8 }]], ["staff_role = 'co_teacher'", () => [{ n: 1 }]]]);
  const d = await call("post", ST, { user: teacher(), pool: dup.pool, params: { courseId: "5" }, body: { source: "Teachers", id: 8 } }); assert.deepStrictEqual([d.res.statusCode, d.res.body.code], [409, "COURSE_CONFLICT"]);
});

test("isolation: section/event/staff ids of school B or another course never resolve in school A; B's database is never queried", async () => {
  const T = makeTenants({
    isoA: [staff([1]), live(), ["UPDATE lms_course_sections SET title", (i) => (i.c === 1 && i.id === 10 ? [sec({ id: 10, course_id: 1 })] : [])], ["UPDATE lms_course_events SET deleted_at", (i) => (i.c === 1 && i.id === 20 ? [{ id: 20 }] : [])]],
    isoB: [staff([2]), live(), ["UPDATE lms_course_sections SET title", () => [sec({ id: 30, course_id: 2 })]]],
  });
  const own = await call("patch", "/courses/:courseId/sections/:sectionId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "1", sectionId: "10" }, body: { title: "Mine" }, tenant: "isoA" }); assert.strictEqual(own.res.statusCode, 200);
  const foreign = await call("patch", "/courses/:courseId/sections/:sectionId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "1", sectionId: "30" }, body: { title: "Hijack" }, tenant: "isoA" }); assert.strictEqual(foreign.res.statusCode, 404);
  const otherCourse = await call("get", S, { user: teacher(), pool: T.isoA.pool, params: { courseId: "2" }, tenant: "isoA" });
  const missing = await call("get", S, { user: teacher(), pool: T.isoA.pool, params: { courseId: "999" }, tenant: "isoA" }); sameForbidden(otherCourse.res, missing.res);
  const ev404 = await call("delete", "/courses/:courseId/calendar/:eventId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "1", eventId: "21" }, tenant: "isoA" }); assert.strictEqual(ev404.res.statusCode, 404);
  T.assertUntouched("isoB");
});

test("every L2.2 route sits behind the licence gate with membership + permission middleware, and uses req.pool only (static)", () => {
  const router = require("../routes/lms"), first = router.stack.findIndex((l) => l.route); assert.ok(first >= 2);
  const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/(sections|staff|calendar)/.test(l.route.path)); assert.strictEqual(mine.length, 11);
  for (const l of mine) assert.ok(l.route.stack.length >= (l.route.methods.get ? 2 : 3), l.route.path + " " + Object.keys(l.route.methods));
  assert.ok(router.stack.findIndex((l) => l.route && l.route.path === "/courses/:courseId/sections/order") < router.stack.findIndex((l) => l.route && l.route.path === "/courses/:courseId/sections/:sectionId"));
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "utils", "lmsCourseParts.js"), "utf8");
  assert.ok(!/config\/db/.test(src));
  const server = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8").split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST"));
  for (const t of ["lms_course_sections", "lms_course_events"]) assert.ok(server.includes(`"${t}"`), t);
});
