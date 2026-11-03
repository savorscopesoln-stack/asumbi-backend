/* L2.1 — LMS courses: validation, status rules, service queries, route authorisation, isolation.
   Mocked pool only: SQL syntax is NOT verified against a real SQL Server here. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsCourses.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)
const C = require("../utils/lmsCourses");
const events = require("../utils/lmsEvents");

const tick = sharedTick;
const GOOD = { code: " bio 101 ", title: "  Introduction to Biology ", academicYear: "2026", className: "Form 3 North", objectives: ["Describe a cell", " "], visibility: "listed" };
const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const admin = { id: 1, role: "admin", source: "Users" };
const student = { id: 7, role: "student", source: "Students" };
const courseRow = (o = {}) => ({ id: 5, code: "BIO101", title: "Biology", description: "", objectives_json: "[]", academic_year: 2026, status: "draft", visibility: "enrolled_only", ...o });

/* ---- pure validation ---- */
test("create validation: normalises code/title/year/objectives and keeps only known fields", () => {
  const r = C.validateCourseInput(GOOD);
  assert.ok(r.ok, r.errors.join("|"));
  assert.strictEqual(r.value.code, "BIO 101"); assert.strictEqual(r.value.title, "Introduction to Biology");
  assert.strictEqual(r.value.academicYear, 2026); assert.deepStrictEqual(r.value.objectives, ["Describe a cell"]);
  assert.strictEqual(r.value.visibility, "listed");
});

test("create validation: rejects missing/odd values, unknown fields and a status on create", () => {
  const bads = [{}, { ...GOOD, code: "x" }, { ...GOOD, code: "bad/code" }, { ...GOOD, title: "ab" }, { ...GOOD, academicYear: 1999 }, { ...GOOD, academicYear: "abc" },
    { ...GOOD, visibility: "public" }, { ...GOOD, subjectId: 0 }, { ...GOOD, objectives: "no" }, { ...GOOD, objectives: Array(21).fill("x") },
    { ...GOOD, description: "x".repeat(4001) }, { ...GOOD, createdBy: 1 }, { ...GOOD, status: "published" }, null, [], "str"];
  for (const b of bads) assert.strictEqual(C.validateCourseInput(b).ok, false, JSON.stringify(b)?.slice(0, 80));
});

test("text fields lose control characters and angle brackets (stored and rendered as plain text)", () => {
  const r = C.validateCourseInput({ ...GOOD, title: "Bio <script>alert(1)</script>", description: "Line1\nLine2<b>\u0000" });
  assert.ok(r.ok); assert.ok(!/[<>]/.test(r.value.title)); assert.ok(!/[<>\u0000]/.test(r.value.description)); assert.ok(r.value.description.includes("\n"));
});

test("partial validation: only what is sent; empty patch and status 'pending' are refused", () => {
  assert.deepStrictEqual(C.validateCourseInput({ title: "New title" }, { partial: true }).value, { title: "New title" });
  assert.strictEqual(C.validateCourseInput({}, { partial: true }).ok, false);
  assert.strictEqual(C.validateCourseInput({ status: "pending" }, { partial: true }).ok, false);
  assert.strictEqual(C.validateCourseInput({ status: "deleted" }, { partial: true }).ok, false);
  assert.strictEqual(C.validateCourseInput({ semester: null }, { partial: true }).value.semester, null);
});

test("status transitions: the full matrix, including approval-required schools", () => {
  const ok = (a, b, o) => C.canTransition(a, b, o).ok;
  assert.ok(ok("draft", "published")); assert.ok(ok("published", "draft")); assert.ok(ok("draft", "archived")); assert.ok(ok("published", "archived")); assert.ok(ok("archived", "draft"));
  assert.ok(!ok("archived", "published")); assert.ok(!ok("pending", "published")); assert.ok(!ok("pending", "archived"));
  assert.strictEqual(C.canTransition("draft", "published", { approvalRequired: true }).code, "APPROVAL_REQUIRED");
  assert.ok(ok("published", "published", { approvalRequired: true }), "no-op is fine");
});

/* ---- service ---- */
test("createCourse: ONE parameterised batch creates the course and the owner row; audit + event follow", async () => {
  const { pool, log } = makeMockPool([["INSERT INTO lms_courses", () => [{ id: 42 }]]]);
  const seen = []; const off = events.on("lms.course.created", (e) => { if (e.tenant === "evt-create") seen.push(e); }); // tests run concurrently: only our own tenant
  const r = await C.createCourse(pool, teacher(), GOOD, "evt-create");
  assert.deepStrictEqual([r.ok, r.id], [true, 42]);
  const q = log.find((l) => l.sql.includes("INSERT INTO lms_courses"));
  assert.ok(q.sql.includes("INSERT INTO lms_course_staff") && q.sql.includes("BEGIN TRAN") && q.sql.includes("XACT_ABORT"));
  assert.ok(!q.sql.includes("BIO 101") && !q.sql.includes("Biology"), "values must be parameters, never in the SQL text");
  assert.deepStrictEqual([q.inputs.code, q.inputs.year, q.inputs.src, q.inputs.uid, q.inputs.vis], ["BIO 101", 2026, "Teachers", 7, "listed"]);
  assert.ok(log.some((l) => l.sql.includes("INSERT INTO lms_audit_log") && l.inputs.act === "course.created"));
  await tick(); off();
  assert.strictEqual(seen.length, 1); assert.deepStrictEqual([seen[0].tenant, seen[0].courseId], ["evt-create", 42]);
});

test("createCourse: invalid input touches no database; duplicate code gives a conflict; unknown subject is refused", async () => {
  const none = makeMockPool([]);
  assert.strictEqual((await C.createCourse(none.pool, teacher(), { title: "x" })).ok, false); assert.strictEqual(none.log.length, 0);
  const dup = makeMockPool([["INSERT INTO lms_courses", () => { const e = new Error("dup"); e.number = 2601; throw e; }]]);
  const r = await C.createCourse(dup.pool, teacher(), GOOD); assert.deepStrictEqual([r.ok, r.conflict], [false, true]);
  const subj = makeMockPool([["FROM subjects", () => []]]);
  const s = await C.createCourse(subj.pool, teacher(), { ...GOOD, subjectId: 99 }); assert.strictEqual(s.ok, false);
  assert.ok(!subj.log.some((l) => l.sql.includes("INSERT INTO lms_courses")));
  assert.strictEqual((await C.createCourse(none.pool, { role: "teacher" }, GOOD)).ok, false, "no actor id -> refused");
});

test("listCourses: paginated, clamped, searches by parameter with wildcards escaped; 'mine' joins membership", async () => {
  const rows = [{ ...courseRow(), my_role: "teacher", total_count: 41 }];
  const { pool, log } = makeMockPool([["FROM lms_courses c", () => rows]]);
  const r = await C.listCourses(pool, teacher(), { q: "100%_[x]", page: "2", pageSize: "9999", status: "published", academicYear: "2026" });
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items[0].myRole], [41, 2, 100, "teacher"]);
  const q = log[0]; assert.ok(q.sql.includes("INNER JOIN lms_course_staff") && q.sql.includes("OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY"));
  assert.strictEqual(q.inputs.off, 100); assert.strictEqual(q.inputs.lim, 100);
  assert.strictEqual(q.inputs.q, "%100\\%\\_\\[x]%"); assert.ok(!q.sql.includes("100%"));
  assert.deepStrictEqual([q.inputs.src, q.inputs.uid], ["Teachers", 7]);
});

test("listCourses: scope 'all' lists every course (LEFT JOIN); an unknown status returns nothing without a query", async () => {
  const a = makeMockPool([["FROM lms_courses c", () => []]]);
  await C.listCourses(a.pool, admin, { scope: "all" }); assert.ok(a.log[0].sql.includes("LEFT JOIN lms_course_staff"));
  const b = makeMockPool([]); const r = await C.listCourses(b.pool, teacher(), { status: "x'; DROP TABLE" }); assert.strictEqual(r.items.length, 0); assert.strictEqual(b.log.length, 0);
});

test("getCourse: returns the course with staff names; only explicit columns are read from legacy tables", async () => {
  const { pool, log } = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow()]], ["FROM lms_course_staff s", () => [{ user_source: "Teachers", user_id: 7, staff_role: "teacher", name: "T. One" }, { user_source: "Users", user_id: 2, staff_role: "co_teacher", name: null }]]]);
  const c = await C.getCourse(pool, 5);
  assert.deepStrictEqual(c.staff.map((s) => s.role), ["owner", "co_teacher"]); assert.strictEqual(c.staff[0].name, "T. One");
  assert.ok(log.every((l) => !/SELECT\s+\*/i.test(l.sql)) && !log.some((l) => /password/i.test(l.sql)));
  assert.strictEqual(await C.getCourse(makeMockPool([]).pool, 5), null);
});

test("updateCourse: publish sets published_at, emits the event and audits; a school needing approval cannot publish directly", async () => {
  const seen = []; const off = events.on("lms.course.published", (e) => { if (e.tenant === "evt-publish") seen.push(e); });
  const m = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow()]]]);
  assert.ok((await C.updateCourse(m.pool, teacher(), 5, { status: "published" }, { tenant: "evt-publish" })).ok);
  const up = m.log.find((l) => l.sql.startsWith("UPDATE lms_courses")); assert.ok(up.sql.includes("published_at = SYSUTCDATETIME()") && up.sql.includes("archived_at = NULL") && up.sql.includes("deleted_at IS NULL"));
  assert.ok(m.log.some((l) => l.inputs.act === "course.published")); await tick(); off(); assert.strictEqual(seen.length, 1);
  const g = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow()]]]);
  const r = await C.updateCourse(g.pool, teacher(), 5, { status: "published" }, { approvalRequired: true });
  assert.deepStrictEqual([r.ok, r.code], [false, "APPROVAL_REQUIRED"]); assert.ok(!g.log.some((l) => l.sql.startsWith("UPDATE")));
});

test("updateCourse: archived courses can only be restored; restore clears archived_at; duplicate code is a conflict; missing course is notFound", async () => {
  const arch = () => makeMockPool([["FROM lms_courses WHERE id", () => [courseRow({ status: "archived" })]]]);
  const a = arch(); const r = await C.updateCourse(a.pool, teacher(), 5, { title: "Edited title" }); assert.deepStrictEqual([r.ok, r.code], [false, "COURSE_ARCHIVED"]);
  const b = arch(); assert.ok((await C.updateCourse(b.pool, teacher(), 5, { status: "draft" })).ok);
  assert.ok(b.log.find((l) => l.sql.startsWith("UPDATE")).sql.includes("archived_at = NULL")); assert.ok(b.log.some((l) => l.inputs.act === "course.restored"));
  const d = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow()]], ["UPDATE lms_courses", () => { const e = new Error("dup"); e.number = 2627; throw e; }]]);
  assert.strictEqual((await C.updateCourse(d.pool, teacher(), 5, { code: "ZZZ 1" })).conflict, true);
  assert.strictEqual((await C.updateCourse(makeMockPool([]).pool, teacher(), 5, { title: "Another one" })).notFound, true);
  const p = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow({ status: "pending" })]]]);
  assert.strictEqual((await C.updateCourse(p.pool, teacher(), 5, { title: "Edit while pending" })).code, "COURSE_PENDING");
});

test("deleteCourse: soft delete only, and only for draft/archived courses", async () => {
  const live = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow({ status: "published" })]]]);
  assert.strictEqual((await C.deleteCourse(live.pool, admin, 5)).code, "COURSE_NOT_DELETABLE"); assert.ok(!live.log.some((l) => l.sql.startsWith("UPDATE")));
  const d = makeMockPool([["FROM lms_courses WHERE id", () => [courseRow()]]]);
  assert.ok((await C.deleteCourse(d.pool, admin, 5)).ok);
  assert.ok(d.log.some((l) => l.sql.startsWith("UPDATE lms_courses SET deleted_at")) && !d.log.some((l) => /DELETE\s+FROM/i.test(l.sql)));
  assert.ok(d.log.some((l) => l.inputs.act === "course.deleted"));
});

/* ---- routes: run each route's own middleware stack (licence gate is covered in lmsSettings/lmsIsolation) ---- */
async function call(method, path, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path} not found`);
  const req = { user, pool, params, body, query, tenant }; const res = makeRes();
  const stack = layer.route.stack.map((s) => s.handle);
  // stock middleware calls next() without awaiting it, so track every handler promise until all have settled
  let i = 0; const pending = [];
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next();
  for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res, req };
}
const staffRows = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];

test("routes: only users with lms.course.create can create; a student gets LMS_FORBIDDEN and nothing is written", async () => {
  const m = makeMockPool([["INSERT INTO lms_courses", () => [{ id: 1 }]]]);
  const r = await call("post", "/courses", { user: student, pool: m.pool, body: GOOD });
  assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, "LMS_FORBIDDEN"]); assert.strictEqual(m.log.length, 0);
});

test("routes: teacher creates (201), bad input is 400 VALIDATION_ERROR, duplicate is 409", async () => {
  const ok = makeMockPool([["INSERT INTO lms_courses", () => [{ id: 9 }]], ["FROM lms_courses WHERE id", () => [courseRow({ id: 9 })]]]);
  const a = await call("post", "/courses", { user: teacher(), pool: ok.pool, body: GOOD });
  assert.deepStrictEqual([a.res.statusCode, a.res.body.course.id], [201, 9]);
  const b = await call("post", "/courses", { user: teacher(), pool: ok.pool, body: { title: "x" } });
  assert.deepStrictEqual([b.res.statusCode, b.res.body.code], [400, "VALIDATION_ERROR"]);
  const dup = makeMockPool([["INSERT INTO lms_courses", () => { const e = new Error("d"); e.number = 2601; throw e; }]]);
  const c = await call("post", "/courses", { user: teacher(), pool: dup.pool, body: GOOD });
  assert.deepStrictEqual([c.res.statusCode, c.res.body.code], [409, "COURSE_CONFLICT"]);
});

test("routes: list is 'mine' for teachers even if they ask for scope=all; administrators get 'all'", async () => {
  const m = () => makeMockPool([["FROM lms_courses c", () => []]]);
  const t = m(); const a = await call("get", "/courses", { user: teacher(), pool: t.pool, query: { scope: "all" } });
  assert.strictEqual(a.res.body.scope, "mine"); assert.ok(t.log.find((l) => l.sql.includes("FROM lms_courses c")).sql.includes("INNER JOIN lms_course_staff"));
  const ad = m(); const b = await call("get", "/courses", { user: admin, pool: ad.pool, query: { scope: "all" } });
  assert.strictEqual(b.res.body.scope, "all"); assert.ok(ad.log.find((l) => l.sql.includes("FROM lms_courses c")).sql.includes("LEFT JOIN lms_course_staff"));
  const s = await call("get", "/courses", { user: student, pool: m().pool }); assert.strictEqual(s.res.statusCode, 403);
});

test("routes: non-member and unknown course give the IDENTICAL 403; a member reads it; an administrator reads any", async () => {
  const mk = () => makeMockPool([staffRows([5]), ["FROM lms_courses WHERE id", () => [courseRow()]], ["FROM lms_course_staff s", () => []]]);
  const own = await call("get", "/courses/:courseId", { user: teacher(), pool: mk().pool, params: { courseId: "5" } });
  assert.deepStrictEqual([own.res.statusCode, own.res.body.myRole], [200, "owner"]);
  const other = await call("get", "/courses/:courseId", { user: teacher(8), pool: makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, params: { courseId: "5" } });
  const none = await call("get", "/courses/:courseId", { user: teacher(), pool: mk().pool, params: { courseId: "999" } });
  assert.strictEqual(other.res.body.code, "COURSE_ACCESS_DENIED"); sameForbidden(other.res, none.res);
  const adm = await call("get", "/courses/:courseId", { user: admin, pool: mk().pool, params: { courseId: "5" } });
  assert.deepStrictEqual([adm.res.statusCode, adm.res.body.myRole], [200, "admin"]);
  const st = await call("get", "/courses/:courseId", { user: student, pool: mk().pool, params: { courseId: "5" } });
  assert.strictEqual(st.res.body.code, "COURSE_ACCESS_DENIED", "students cannot use the staff course view");
});

test("routes: co-teacher may edit but NOT delete; owner may delete a draft; delete of a published course is refused", async () => {
  const mk = (role, status = "draft") => makeMockPool([staffRows([5], role), ["FROM lms_courses WHERE id", () => [courseRow({ status })]], ["FROM lms_settings", () => []], ["FROM lms_course_staff s", () => []]]);
  const edit = await call("patch", "/courses/:courseId", { user: teacher(), pool: mk("co_teacher").pool, params: { courseId: "5" }, body: { title: "Edited title" } });
  assert.strictEqual(edit.res.statusCode, 200);
  const co = mk("co_teacher"); const del = await call("delete", "/courses/:courseId", { user: teacher(), pool: co.pool, params: { courseId: "5" } });
  assert.deepStrictEqual([del.res.statusCode, del.res.body.code], [403, "COURSE_ACCESS_DENIED"]); assert.ok(!co.log.some((l) => l.sql.startsWith("UPDATE")));
  const own = await call("delete", "/courses/:courseId", { user: teacher(), pool: mk("teacher").pool, params: { courseId: "5" } }); assert.strictEqual(own.res.statusCode, 200);
  const live = await call("delete", "/courses/:courseId", { user: teacher(), pool: mk("teacher", "published").pool, params: { courseId: "5" } });
  assert.deepStrictEqual([live.res.statusCode, live.res.body.code], [409, "COURSE_NOT_DELETABLE"]);
});

test("routes: patch publishes when approval is off, and returns 409 APPROVAL_REQUIRED when the school requires it", async () => {
  const base = (settingsRows) => makeMockPool([staffRows([5]), ["FROM lms_courses WHERE id", () => [courseRow()]], ["FROM lms_settings", () => settingsRows], ["FROM lms_course_staff s", () => []]]);
  const off = await call("patch", "/courses/:courseId", { user: teacher(), pool: base([]).pool, params: { courseId: "5" }, body: { status: "published" } });
  assert.strictEqual(off.res.statusCode, 200);
  const on = await call("patch", "/courses/:courseId", { user: teacher(), pool: base([{ setting_key: "courseApprovalRequired", value_json: "true" }]).pool, params: { courseId: "5" }, body: { status: "published" } });
  assert.deepStrictEqual([on.res.statusCode, on.res.body.code], [409, "APPROVAL_REQUIRED"]);
});

test("isolation: a teacher of A guessing B's course id gets the same 403 as a missing course; B's database is never queried", async () => {
  const T = makeTenants({
    isoA: [["FROM lms_course_staff WHERE", onlyIds("c", [1, 2], [{ staff_role: "teacher" }])], ["FROM lms_courses WHERE id", onlyIds("id", [1, 2], [courseRow({ id: 1 })])], ["FROM lms_course_staff s", () => []]],
    isoB: [["FROM lms_course_staff WHERE", onlyIds("c", [3], [{ staff_role: "teacher" }])], ["FROM lms_courses WHERE id", onlyIds("id", [3], [courseRow({ id: 3 })])]],
  });
  const mine = await call("get", "/courses/:courseId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "1" }, tenant: "isoA" }); assert.strictEqual(mine.res.statusCode, 200);
  const theirs = await call("get", "/courses/:courseId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "3" }, tenant: "isoA" });
  const none = await call("get", "/courses/:courseId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "999" }, tenant: "isoA" });
  assert.strictEqual(theirs.res.body.code, "COURSE_ACCESS_DENIED"); sameForbidden(theirs.res, none.res);
  for (const verb of ["patch", "delete"]) { const r = await call(verb, "/courses/:courseId", { user: teacher(), pool: T.isoA.pool, params: { courseId: "3" }, body: { title: "Hijacked!" } }); assert.strictEqual(r.res.statusCode, 403); }
  T.assertUntouched("isoB");
  const list = makeTenants({ isoA: [["FROM lms_courses c", () => [{ ...courseRow({ id: 1 }), my_role: "teacher", total_count: 1 }]]], isoB: [] });
  await call("get", "/courses", { user: teacher(), pool: list.isoA.pool, tenant: "isoA" }); list.assertUntouched("isoB");
});

test("every course route is behind the licence gate and carries a permission check (static)", () => {
  const router = require("../routes/lms");
  const first = router.stack.findIndex((l) => l.route);
  assert.ok(first >= 2);
  const courseRoutes = router.stack.filter((l) => l.route && l.route.path.startsWith("/courses"));
  assert.ok(courseRoutes.length >= 5);
  for (const l of courseRoutes) assert.ok(l.route.stack.length >= 1 && (l.route.stack.length >= 2 || l.route.methods.post || l.route.path === "/courses"), l.route.path);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "utils", "lmsCourses.js"), "utf8");
  assert.ok(!/require\(["']\.\.\/config\/db/.test(src), "must use the request's pool only");
  const sqlTemplates = (src.match(/`[^`]*`/g) || []).filter((t) => /\b(SELECT|UPDATE|INSERT)\b/.test(t));
  assert.ok(sqlTemplates.length >= 5);
  for (const t of sqlTemplates) assert.ok(!t.replace(/\$\{(where\.join\(" AND "\)|join|sets\.join\(", "\))\}/g, "").includes("${"), "only fixed fragments may be interpolated into SQL: " + t.slice(0, 60));
});

test("raw record editor can never edit LMS course tables (they change only through validated, audited endpoints)", () => {
  const server = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  const line = server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST"));
  for (const t of ["lms_courses", "lms_course_staff", "lms_settings", "lms_audit_log", "lms_user_permissions"]) assert.ok(line.includes(`"${t}"`), t);
});
