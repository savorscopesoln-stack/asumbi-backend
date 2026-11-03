/* L1.6 — tenant isolation, applied to everything built so far (L1.1-L1.5), using helpers/tenantHarness.js.
   Later phases: copy the patterns below for each new service/route (own pool only, ID guessing, same 403). */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, tenantFolders, sameForbidden } = require("./helpers/tenantHarness");
const fs = require("fs"), path = require("path");
suite("lmsIsolation.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)

const run = async (mw, req) => { let called = false; const res = makeRes(); await mw(req, res, () => { called = true; }); return { called, res }; };
// Wait for async event delivery. A timer alone is racy: if another test blocks the loop past the delay,
// timers run BEFORE the setImmediate that delivers the event. So wait, then flush setImmediate several times.
const tick = sharedTick;

test("licence: A licensed, B not — B is blocked, and A's request never touches B's database", async () => {
  const { requireModule, invalidateModuleCache } = require("../utils/tenantModules");
  invalidateModuleCache();
  const T = makeTenants({
    isoA: [["FROM tenant_modules", () => [{ module_key: "lms", enabled: 1, flags_json: '["lms_core"]', limits_json: "{}" }]]],
    isoB: [["FROM tenant_modules", () => []]],
  });
  const gate = requireModule("lms", "lms_core");
  const a = await run(gate, { user: { id: 1, role: "admin" }, pool: T.isoA.pool, tenant: "isoA" });
  assert.strictEqual(a.called, true); T.assertUntouched("isoB");
  const b = await run(gate, { user: { id: 1, role: "admin" }, pool: T.isoB.pool, tenant: "isoB" });
  assert.strictEqual(b.called, false); assert.strictEqual(b.res.body.code, "MODULE_NOT_LICENSED");
  invalidateModuleCache();
});

test("settings: saving in A writes only A's database; B still reads its own defaults", async () => {
  const S = require("../utils/lmsSettings");
  const T = makeTenants({ isoA: [], isoB: [] });
  await S.saveSettings(T.isoA.pool, { id: 1, role: "admin" }, { lateSubmission: "block" }, "isoA");
  T.assertQueried("isoA"); T.assertUntouched("isoB");
  assert.strictEqual((await S.getSettings(T.isoB.pool)).lateSubmission, "accept");
});

test("permissions: a grant stored in A does not exist for the same (source,id) in B", async () => {
  const P = require("../utils/lmsPermissions");
  const T = makeTenants({ isoA: [["FROM lms_user_permissions", () => [{ permission_code: "lms.course.approve" }]]], isoB: [["FROM lms_user_permissions", () => []]] });
  const teacher = { id: 7, role: "teacher", source: "Teachers" };
  assert.ok((await P.getEffectivePermissions(T.isoA.pool, teacher)).has("lms.course.approve"));
  assert.ok(!(await P.getEffectivePermissions(T.isoB.pool, teacher)).has("lms.course.approve"));
});

test("course ID guessing: a teacher/student of A asking for B's course gets the SAME 403 as a course that does not exist", async () => {
  const P = require("../utils/lmsPermissions");
  const T = makeTenants({
    isoA: [["FROM lms_course_staff", onlyIds("c", [1, 2], [{ staff_role: "teacher" }])], ["FROM lms_course_enrolments", onlyIds("c", [1, 2], [{ status: "active" }])]],
    isoB: [["FROM lms_course_staff", onlyIds("c", [3], [{ staff_role: "teacher" }])], ["FROM lms_course_enrolments", onlyIds("c", [3], [{ status: "active" }])]],
  });
  const mw = P.requireCourseAccess({ roles: ["owner", "co_teacher", "student"] });
  for (const user of [{ id: 7, role: "teacher", source: "Teachers" }, { id: 7, role: "student", source: "Students" }]) {
    assert.strictEqual((await run(mw, { user, pool: T.isoA.pool, params: { courseId: "1" } })).called, true, user.role + " own course");
    const theirs = await run(mw, { user, pool: T.isoA.pool, params: { courseId: "3" } });   // B's course id
    const none = await run(mw, { user, pool: T.isoA.pool, params: { courseId: "999" } });  // nothing
    assert.strictEqual(theirs.called, false); assert.strictEqual(theirs.res.body.code, "COURSE_ACCESS_DENIED");
    sameForbidden(theirs.res, none.res);
  }
  T.assertUntouched("isoB");
});

test("audit trail: reading A's audit log queries only A's database", async () => {
  const { listAudit } = require("../utils/lmsAudit");
  const T = makeTenants({ isoA: [["FROM lms_audit_log", () => [{ id: 1 }]]], isoB: [["FROM lms_audit_log", () => [{ id: 99 }]]] });
  const r = await listAudit(T.isoA.pool, {});
  assert.strictEqual(r.rows[0].id, 1); T.assertUntouched("isoB");
});

test("storage: each school's usage counts only its own lms folder; odd tenant names cannot reach another's", async () => {
  const U = require("../utils/lmsUsage");
  const F = tenantFolders({ isoa: { "m/a.bin": 1048576 }, isob: { "m/b.bin": 3 * 1048576 } });
  U.invalidateStorage();
  try {
    assert.strictEqual((await U.getStorage("isoA", { root: F.root })).storageMb, 1);
    assert.strictEqual((await U.getStorage("isoB", { root: F.root })).storageMb, 3);
    for (const evil of ["../isob", "isoa/../isob", "isoa\\..\\isob"]) assert.notStrictEqual((await U.getStorage(evil, { root: F.root })).storageMb, 1, evil);
    assert.ok(fs.existsSync(path.join(F.root, "isob")), "other school's files untouched");
  } finally { U.invalidateStorage(); F.cleanup(); }
});

test("events: tenant is always present and a payload cannot spoof the event name", async () => {
  const E = require("../utils/lmsEvents"); const seen = [];
  const off = E.on("lms.submission.graded", (e) => { if (e.tenant === "isoA") seen.push(e); }); // filter: other test files emit this event concurrently (S30)
  E.emit("lms.submission.graded", { tenant: "isoA", event: "lms.grade.released", at: "1999" });
  await tick(); off();
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].tenant, "isoA"); assert.strictEqual(seen[0].event, "lms.submission.graded"); assert.notStrictEqual(seen[0].at, "1999");
});

test("static: LMS routes/services never open their own database connection (they must use req.pool)", () => {
  for (const f of ["../routes/lms.js", "../utils/lmsSettings.js", "../utils/lmsGrants.js", "../utils/lmsAudit.js", "../utils/lmsUsage.js", "../utils/lmsPermissions.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.ok(!/config\/db|getPool|new sql\.ConnectionPool|sql\.connect\(/.test(src), `${f} must not create or look up a pool itself`);
  }
});
