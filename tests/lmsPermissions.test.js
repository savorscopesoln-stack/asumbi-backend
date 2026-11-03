/* L1.3 — LMS permissions + course membership (utils/lmsPermissions.js). Mocked pool. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsPermissions.test.js");
const P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" };
const student = { id: 7, role: "student", source: "Students" }; // same id as the teacher on purpose
const poolGrants = (codes) => makeMockPool([["FROM lms_user_permissions", () => codes.map((c) => ({ permission_code: c }))]]).pool;
const run = async (mw, req) => { let called = false; const res = makeRes(); await mw(req, res, () => { called = true; }); return { called, res }; };

test("role defaults: admin all; teacher teaching set; student/finance/master none", () => {
  assert.strictEqual(P.roleDefaults({ role: "admin" }).length, P.PERMISSIONS.length);
  assert.strictEqual(P.roleDefaults({ role: "module_admin" }).length, P.PERMISSIONS.length);
  assert.deepStrictEqual(P.roleDefaults(teacher), P.TEACHER_DEFAULTS);
  assert.ok(!P.roleDefaults(teacher).includes("lms.settings.manage"));
  assert.ok(!P.roleDefaults(teacher).includes("lms.course.delete"), "course delete is owner-only, not a role default");
  for (const u of [student, { role: "finance" }, { role: "admin", isMaster: true }, { role: "user" }, null]) assert.deepStrictEqual(P.roleDefaults(u), [], JSON.stringify(u));
});

test("sub_admin is an LMS administrator ONLY with the 'LMS' page key", () => {
  assert.strictEqual(P.roleDefaults({ role: "sub_admin", permissions: ["Students"] }).length, 0);
  assert.strictEqual(P.roleDefaults({ role: "sub_admin_2", permissions: ["LMS"] }).length, P.PERMISSIONS.length);
});

test("HOD = teacher + grant: grants add permissions; unknown codes are ignored", async () => {
  const eff = await P.getEffectivePermissions(poolGrants(["lms.course.approve", "lms.analytics.department", "bogus.code"]), teacher);
  assert.ok(eff.has("lms.course.approve") && eff.has("lms.analytics.department") && eff.has("lms.course.create"));
  assert.ok(!eff.has("bogus.code"));
});

test("grants never give finance, master or students LMS access", async () => {
  const pool = poolGrants(["lms.settings.manage"]);
  for (const u of [{ id: 1, role: "finance" }, { id: 1, role: "admin", isMaster: true }, student]) assert.strictEqual((await P.getEffectivePermissions(pool, u)).size, 0, u.role);
});

test("grant lookup failure falls back to role defaults (never grants more)", async () => {
  const broken = { request() { return { input() { return this; }, async query() { throw new Error("no table"); } }; } };
  const eff = await P.getEffectivePermissions(broken, teacher);
  assert.deepStrictEqual([...eff].sort(), [...P.TEACHER_DEFAULTS].sort());
});

test("requireLmsPermission: allowed passes; missing gets 403 LMS_FORBIDDEN; unauthenticated 401", async () => {
  const pool = poolGrants([]);
  assert.strictEqual((await run(P.requireLmsPermission("lms.course.create"), { user: teacher, pool })).called, true);
  const no = await run(P.requireLmsPermission("lms.settings.manage"), { user: teacher, pool });
  assert.strictEqual(no.called, false); assert.strictEqual(no.res.body.code, "LMS_FORBIDDEN");
  assert.strictEqual((await run(P.requireLmsPermission("lms.course.create"), { pool })).res.statusCode, 401);
  assert.strictEqual((await run(P.requireLmsPermission("lms.course.create"), { user: student, pool })).called, false);
});

test("actorOf: source from token, else from role; same numeric id in different tables stays distinct", () => {
  assert.deepStrictEqual(P.actorOf({ id: 7, role: "student" }), { source: "Students", id: 7, role: "student" });
  assert.strictEqual(P.actorOf({ id: 7, role: "teacher" }).source, "Teachers");
  assert.strictEqual(P.actorOf({ id: 7, role: "sub_admin" }).source, "Users");
  assert.strictEqual(P.actorOf({ id: 7, role: "teacher", source: "Evil" }).source, "Teachers", "bad source claim ignored");
  assert.strictEqual(P.actorOf({ id: "7; DROP", role: "teacher" }), null);
  assert.strictEqual(P.actorOf({ id: 0, role: "teacher" }), null);
});

/* fake membership: course 1 -> teacher#7 owner, Teachers#8 co-teacher, student#7 enrolled */
const members = { "1|Teachers|7": "owner", "1|Teachers|8": "co_teacher", "1|Students|7": "student" };
const lookup = async (_p, courseId, a) => members[`${courseId}|${a.source}|${a.id}`] || null;
const access = (roles, user, courseId, pool = poolGrants([])) => run(P.requireCourseAccess({ roles, lookup }), { user, pool, params: { courseId } });

test("course access: members by role; non-member of this course is denied", async () => {
  assert.strictEqual((await access(["owner", "co_teacher"], teacher, "1")).called, true);
  assert.strictEqual((await access(["owner", "co_teacher"], { id: 8, role: "teacher", source: "Teachers" }, "1")).called, true);
  const other = await access(["owner", "co_teacher"], teacher, "2");
  assert.strictEqual(other.called, false); assert.strictEqual(other.res.body.code, "COURSE_ACCESS_DENIED");
});

test("same id, different table: student#7 is not teacher#7 (no cross-identity access)", async () => {
  assert.strictEqual((await access(["owner", "co_teacher"], student, "1")).called, false, "enrolled student cannot use staff routes");
  assert.strictEqual((await access(["student"], student, "1")).called, true);
  assert.strictEqual((await access(["student"], teacher, "1")).called, false, "teacher is not a student member");
});

test("co-teacher cannot reach owner-only routes (e.g. delete course)", async () => {
  const co = { id: 8, role: "teacher", source: "Teachers" };
  assert.strictEqual((await access(["owner", "admin"], co, "1")).called, false);
  assert.strictEqual((await access(["owner", "admin"], teacher, "1")).called, true);
});

test("LMS administrators pass without membership; finance/master never do", async () => {
  assert.strictEqual((await access(["owner", "co_teacher", "admin"], { id: 1, role: "admin", source: "Users" }, "99")).called, true);
  assert.strictEqual((await access(["owner", "admin"], { id: 2, role: "sub_admin", source: "Users", permissions: ["LMS"] }, "99")).called, true);
  assert.strictEqual((await access(["owner", "admin"], { id: 2, role: "sub_admin", source: "Users", permissions: ["Students"] }, "99")).called, false);
  assert.strictEqual((await access(["owner", "admin", "student"], { id: 3, role: "finance", source: "Users" }, "1")).called, false);
  assert.strictEqual((await access(["owner", "admin"], { id: 4, role: "admin", isMaster: true, source: "Users" }, "1")).called, false);
});

test("bad course ids and lookup errors are denied (fail closed), with one uniform error", async () => {
  for (const bad of ["abc", "-1", "0", "1; DROP TABLE x", undefined]) assert.strictEqual((await access(["owner"], teacher, bad)).called, false, String(bad));
  const boom = P.requireCourseAccess({ roles: ["owner"], lookup: async () => { throw new Error("Invalid object name"); } });
  const r = await run(boom, { user: teacher, pool: poolGrants([]), params: { courseId: "1" } });
  assert.strictEqual(r.called, false); assert.strictEqual(r.res.statusCode, 403);
});

test("default lookup uses parameterised SQL against the contract tables, per identity source", async () => {
  const seen = [];
  const pool = { request() { const inp = {}; const r = { input(n, _t, v) { inp[n] = v; return r; }, async query(t) { seen.push({ t: t.replace(/\s+/g, " "), inp }); return { recordset: [{ staff_role: "co_teacher", status: "active" }] }; } }; return r; } };
  assert.strictEqual(await P.defaultLookup(pool, 5, { source: "Teachers", id: 8 }), "co_teacher");
  assert.strictEqual(await P.defaultLookup(pool, 5, { source: "Students", id: 8 }), "student");
  assert.ok(seen[0].t.includes("lms_course_staff") && seen[0].inp.s === "Teachers");
  assert.ok(seen[1].t.includes("lms_course_enrolments") && seen[1].t.includes("student_id"));
  assert.ok(!/\$\{|\+\s*courseId/.test(require("fs").readFileSync(require("path").join(__dirname, "../utils/lmsPermissions.js"), "utf8").split("defaultLookup")[1].slice(0, 900)), "no interpolation");
});
