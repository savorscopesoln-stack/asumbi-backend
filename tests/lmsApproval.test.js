/* L2.5 — course approval workflow. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsApproval.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)
const A = require("../utils/lmsApproval");
const events = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers", tenant: "isoA" });
const student = { id: 7, role: "student", source: "Students", tenant: "isoA" };
const admin = { id: 1, role: "admin", source: "Users", tenant: "isoA" };
const hod = (id = 40) => ({ id, role: "teacher", source: "Teachers", tenant: "isoA" });
const grantApprove = ["FROM lms_user_permissions WHERE", (i) => (i.uid >= 40 && i.uid < 50 ? [{ permission_code: "lms.course.approve" }] : [])];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const settings = (on) => ["FROM lms_settings", () => [{ setting_key: "courseApprovalRequired", value_json: String(on) }]];
const moved = (ok = true) => ["DECLARE @t TABLE", () => (ok ? [{ id: 5 }] : [])];
const state = (status) => ["SELECT TOP 1 status FROM lms_courses WHERE id = @c", () => (status ? [{ status }] : [])];
const lastSubmit = (src, id) => ["action = 'submitted' ORDER BY id DESC", () => (src ? [{ actor_source: src, actor_id: id }] : [])];
const courseRow = (status) => ["FROM lms_courses WHERE id", () => [{ id: 5, code: "B1", title: "Bio", academic_year: 2026, visibility: "enrolled_only", status }]];
const batch = (m) => m.log.filter((l) => l.sql.includes("BEGIN TRAN"));

/* ---------------- service ---------------- */
test("note validation: return needs a 3-500 character reason; approve note optional; unknown fields refused", () => {
  assert.strictEqual(A.validateNote({ reason: "  <b>Add</b> objectives " }, { required: true }).value, "bAdd/b objectives");
  for (const b of [{}, { reason: "ab" }, { reason: "x".repeat(501) }, { reason: "okay", extra: 1 }, "text", []]) assert.strictEqual(A.validateNote(b, { required: true }).ok, false, JSON.stringify(b));
  assert.deepStrictEqual([A.validateNote(undefined, { field: "note" }).ok, A.validateNote({}, { field: "note" }).value], [true, null]);
});

test("submit: only when the school requires approval; ONE guarded statement draft->pending plus a history row; audited", async () => {
  const off = await A.submitForApproval(makeMockPool([]).pool, teacher(), 5, { approvalRequired: false }); assert.deepStrictEqual([off.ok, off.code], [false, "APPROVAL_NOT_REQUIRED"]);
  const m = makeMockPool([moved()]); assert.ok((await A.submitForApproval(m.pool, teacher(), 5, { approvalRequired: true })).ok);
  const b = batch(m)[0]; assert.ok(b.sql.includes("status = @from") && b.sql.includes("INSERT INTO lms_course_approvals") && b.sql.includes("deleted_at IS NULL"));
  assert.deepStrictEqual([b.inputs.from, b.inputs.to, b.inputs.act], ["draft", "pending", "submitted"]); assert.ok(m.log.some((l) => l.inputs.act === "course.approval.submitted"));
  const pend = await A.submitForApproval(makeMockPool([moved(false), state("published")]).pool, teacher(), 5, { approvalRequired: true }); assert.deepStrictEqual([pend.ok, pend.code, pend.status], [false, "BAD_TRANSITION", "published"]);
  assert.strictEqual((await A.submitForApproval(makeMockPool([moved(false), state(null)]).pool, teacher(), 5, { approvalRequired: true })).notFound, true);
});

test("approve: pending->published with published_at, emits lms.course.published; a second approve is refused; submitter cannot self-approve unless LMS admin", async () => {
  const got = []; const off = events.on("lms.course.published", (e) => { if (e.courseId === 81) got.push(e); });
  const m = makeMockPool([lastSubmit("Teachers", 7), moved()]); const r = await A.approveCourse(m.pool, hod(), 81, { note: "Good" }, { tenant: "isoA" }); assert.ok(r.ok);
  const b = batch(m)[0]; assert.ok(b.sql.includes("published_at = SYSUTCDATETIME()")); assert.deepStrictEqual([b.inputs.from, b.inputs.to, b.inputs.act, b.inputs.reason], ["pending", "published", "approved", "Good"]);
  await sharedTick(); assert.strictEqual(got.length, 1); off && off();
  const again = await A.approveCourse(makeMockPool([lastSubmit("Teachers", 7), moved(false), state("published")]).pool, hod(), 5, {}); assert.deepStrictEqual([again.ok, again.code], [false, "BAD_TRANSITION"]);
  const self = makeMockPool([lastSubmit("Teachers", 40), moved()]); const s = await A.approveCourse(self.pool, hod(40), 5, {}); assert.deepStrictEqual([s.ok, s.forbidden, s.code], [false, true, "SELF_APPROVAL"]); assert.ok(!batch(self).length);
  const adm = makeMockPool([moved()]); assert.ok((await A.approveCourse(adm.pool, admin, 5, {}, { isAdmin: true })).ok); assert.ok(!adm.log.some((l) => l.sql.includes("action = 'submitted' ORDER BY id DESC")), "admin skips the check");
  assert.strictEqual((await A.approveCourse(makeMockPool([]).pool, hod(), 5, { bad: 1 })).ok, false);
});

test("return needs a reason and sends the course back to draft; withdraw is pending->draft by staff", async () => {
  assert.strictEqual((await A.returnCourse(makeMockPool([moved()]).pool, hod(), 5, {})).ok, false);
  const m = makeMockPool([moved()]); assert.ok((await A.returnCourse(m.pool, hod(), 5, { reason: "Add objectives" })).ok); assert.deepStrictEqual([batch(m)[0].inputs.to, batch(m)[0].inputs.act, batch(m)[0].inputs.reason], ["draft", "returned", "Add objectives"]);
  const w = makeMockPool([moved()]); assert.ok((await A.withdrawSubmission(w.pool, teacher(), 5)).ok); assert.deepStrictEqual([batch(w)[0].inputs.from, batch(w)[0].inputs.act], ["pending", "withdrawn"]);
  const no = await A.withdrawSubmission(makeMockPool([moved(false), state("draft")]).pool, teacher(), 5); assert.strictEqual(no.code, "BAD_TRANSITION");
});

test("queue and history: paginated, bounded, search escaped, only pending courses", async () => {
  const m = makeMockPool([["FROM lms_courses c WHERE", () => [{ id: 5, code: "B1", title: "Bio", academic_year: 2026, class_name: "F1", programme: null, submitted_at: "2026-10-01", total_count: 41 }]]]);
  const r = await A.listPending(m.pool, { q: "50%_", page: "3", pageSize: "9999" }); assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items[0].submittedAt], [41, 3, 100, "2026-10-01"]);
  const q = m.log[0]; assert.ok(q.sql.includes("c.status = 'pending'") && q.sql.includes("c.deleted_at IS NULL") && q.sql.includes("OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY") && q.sql.includes("ESCAPE") && q.inputs.q.includes("50\\%\\_"));
  const h = makeMockPool([["FROM lms_course_approvals WHERE course_id = @c", () => [{ id: 2, action: "returned", reason: "Fix", actor_source: "Teachers", actor_id: 40, created_at: "x" }]]]);
  assert.strictEqual((await A.listHistory(h.pool, 5))[0].reason, "Fix"); assert.ok(h.log[0].sql.includes("TOP 50"));
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant = "isoA" }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const P = (s) => `/courses/:courseId/${s}`;

test("routes: the teacher submits and withdraws; students, non-members and strangers are refused identically; nothing is written", async () => {
  const mk = () => makeMockPool([staff([5]), settings(true), moved(), courseRow("pending"), ["FROM lms_course_staff s", () => []]]);
  const a = await call("post", P("submit"), { user: teacher(), pool: mk().pool, params: { courseId: "5" } }); assert.strictEqual(a.res.statusCode, 200); assert.strictEqual(a.res.body.course.status, "pending");
  const w = await call("post", P("withdraw-submission"), { user: teacher(), pool: mk().pool, params: { courseId: "5" } }); assert.strictEqual(w.res.statusCode, 200);
  const st = mk(); const s = await call("post", P("submit"), { user: student, pool: st.pool, params: { courseId: "5" } }); assert.deepStrictEqual([s.res.statusCode, s.res.body.code], [403, "LMS_FORBIDDEN"]); assert.ok(!batch(st).length);
  const o = await call("post", P("submit"), { user: teacher(9), pool: makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, params: { courseId: "5" } });
  const miss = await call("post", P("submit"), { user: teacher(), pool: makeMockPool([staff([5])]).pool, params: { courseId: "6" } }); sameForbidden(o.res, miss.res); assert.strictEqual(o.res.body.code, "COURSE_ACCESS_DENIED");
  const off = await call("post", P("submit"), { user: teacher(), pool: makeMockPool([staff([5]), settings(false), moved()]).pool, params: { courseId: "5" } }); assert.deepStrictEqual([off.res.statusCode, off.res.body.code], [409, "APPROVAL_NOT_REQUIRED"]);
  const wrong = await call("post", P("submit"), { user: teacher(), pool: makeMockPool([staff([5]), settings(true), moved(false), state("published")]).pool, params: { courseId: "5" } }); assert.deepStrictEqual([wrong.res.statusCode, wrong.res.body.code], [409, "BAD_TRANSITION"]);
});

test("routes: only holders of lms.course.approve approve or return (a plain teacher, even the course owner, cannot); self-approval is a 403", async () => {
  const mk = (extra = []) => makeMockPool([grantApprove, lastSubmit("Teachers", 7), moved(), courseRow("published"), ["FROM lms_course_staff s", () => []], ...extra]);
  for (const act of ["approve", "return"]) {
    const t = mk(); const r = await call("post", P(act), { user: teacher(), pool: t.pool, params: { courseId: "5" }, body: { reason: "Needs work" } }); assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, "LMS_FORBIDDEN"], act); assert.ok(!batch(t).length);
    const s = await call("post", P(act), { user: student, pool: mk().pool, params: { courseId: "5" }, body: { reason: "Needs work" } }); assert.strictEqual(s.res.statusCode, 403);
  }
  const ok = await call("post", P("approve"), { user: hod(), pool: mk().pool, params: { courseId: "5" } }); assert.strictEqual(ok.res.statusCode, 200);
  const ret = await call("post", P("return"), { user: hod(), pool: mk().pool, params: { courseId: "5" }, body: { reason: "Needs work" } }); assert.strictEqual(ret.res.statusCode, 200);
  const noReason = await call("post", P("return"), { user: hod(), pool: mk().pool, params: { courseId: "5" }, body: {} }); assert.deepStrictEqual([noReason.res.statusCode, noReason.res.body.code], [400, "VALIDATION_ERROR"]);
  const self = await call("post", P("approve"), { user: hod(40), pool: makeMockPool([grantApprove, lastSubmit("Teachers", 40), moved()]).pool, params: { courseId: "5" } }); assert.deepStrictEqual([self.res.statusCode, self.res.body.code], [403, "SELF_APPROVAL"]);
  const gone = await call("post", P("approve"), { user: hod(), pool: makeMockPool([grantApprove, lastSubmit(null), moved(false), state(null)]).pool, params: { courseId: "5" } }); assert.strictEqual(gone.res.statusCode, 404);
  const adm = await call("post", P("approve"), { user: admin, pool: makeMockPool([moved(), courseRow("published"), ["FROM lms_course_staff s", () => []]]).pool, params: { courseId: "5" } }); assert.strictEqual(adm.res.statusCode, 200);
});

test("routes: queue is for reviewers; history is for course staff, LMS administrators and reviewers only", async () => {
  const q = makeMockPool([grantApprove, ["FROM lms_courses c WHERE", () => []]]);
  assert.strictEqual((await call("get", "/course-approvals", { user: hod(), pool: q.pool })).res.statusCode, 200);
  assert.strictEqual((await call("get", "/course-approvals", { user: teacher(), pool: makeMockPool([grantApprove]).pool })).res.statusCode, 403);
  assert.strictEqual((await call("get", "/course-approvals", { user: student, pool: makeMockPool([]).pool })).res.statusCode, 403);
  const hist = ["FROM lms_course_approvals WHERE course_id = @c", () => []];
  assert.strictEqual((await call("get", P("approval"), { user: teacher(), pool: makeMockPool([staff([5]), hist]).pool, params: { courseId: "5" } })).res.statusCode, 200);
  assert.strictEqual((await call("get", P("approval"), { user: hod(), pool: makeMockPool([grantApprove, hist]).pool, params: { courseId: "5" } })).res.statusCode, 200);
  assert.strictEqual((await call("get", P("approval"), { user: admin, pool: makeMockPool([hist]).pool, params: { courseId: "5" } })).res.statusCode, 200);
  const other = makeMockPool([["FROM lms_course_staff WHERE", () => []], hist]); const o = await call("get", P("approval"), { user: teacher(9), pool: other.pool, params: { courseId: "5" } });
  const stu = await call("get", P("approval"), { user: student, pool: makeMockPool([["FROM lms_course_enrolments WHERE", () => [{ status: "active" }]], hist]).pool, params: { courseId: "5" } });
  assert.deepStrictEqual([o.res.statusCode, o.res.body.code, stu.res.statusCode], [403, "COURSE_ACCESS_DENIED", 403]); assert.ok(!other.log.some((l) => l.sql.includes("lms_course_approvals")));
});

test("isolation: another school's course ids never resolve; B's database is never queried", async () => {
  const T = makeTenants({ isoA: [staff([1]), settings(true), ["DECLARE @t TABLE", onlyIds("c", [1], [{ id: 1 }])], state(null), courseRow("pending"), ["FROM lms_course_staff s", () => []]], isoB: [staff([2]), ["DECLARE @t TABLE", () => [{ id: 2 }]]] });
  assert.strictEqual((await call("post", P("submit"), { user: teacher(), pool: T.isoA.pool, params: { courseId: "1" } })).res.statusCode, 200);
  const other = await call("post", P("submit"), { user: teacher(), pool: T.isoA.pool, params: { courseId: "2" } }); const missing = await call("post", P("submit"), { user: teacher(), pool: T.isoA.pool, params: { courseId: "999" } }); sameForbidden(other.res, missing.res);
  T.assertUntouched("isoB");
});

test("static: schema step 007 additive and guarded; every L2.5 route sits behind the licence gate; permission checks present; table blocklisted; no raw db", () => {
  const { STEPS } = require("../utils/lmsSchema"); const s = STEPS.find((x) => x.id === "007_lms_course_approvals"); assert.ok(s); assert.strictEqual(STEPS.map((x) => x.id).indexOf("007_lms_course_approvals"), 6);
  const all = s.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(all) && s.sql.every((x) => /IF NOT EXISTS/.test(x)));
  const router = require("../routes/lms"); assert.ok(router.stack.findIndex((l) => l.route) >= 2);
  const mine = router.stack.filter((l) => l.route && [P("submit"), P("withdraw-submission"), P("approve"), P("return"), "/course-approvals"].includes(l.route.path)); assert.strictEqual(mine.length, 5);
  for (const l of mine) assert.ok(l.route.stack.length >= 2, l.route.path);
  const root = path.join(__dirname, ".."); assert.ok(!/config\/db/.test(fs.readFileSync(path.join(root, "utils", "lmsApproval.js"), "utf8")));
  const line = fs.readFileSync(path.join(root, "server.js"), "utf8").split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")); assert.ok(line.includes('"lms_course_approvals"'));
});
