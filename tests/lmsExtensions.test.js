/* L5.5 — per-learner deadline extensions (D-068) + plagiarism hook (interface only). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsExtensions.test.js");
const X = require("../utils/lmsExtensions"), S = require("../utils/lmsSubmissions"), A = require("../utils/lmsAssignments"), D = require("../utils/lmsDashboard"), planner = require("../utils/lmsPlanner"), P = require("../utils/lmsPlagiarism"), events = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const NOW = new Date("2026-11-20T08:00:00Z"), AFTER = new Date("2026-11-21T10:00:00Z"), DUE = "2026-11-20T14:00:00.000Z";
const SET = { lateSubmission: "block", latePenaltyPercent: 10, files: { allowedExtensions: ["pdf"], maxFileMb: 10 } };
const d = (s) => new Date(s);
const arow = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Essay 1", instructions: "Write.", status: "published", published_at: null, available_from: null, due_at: d(DUE), cutoff_at: null, submission_type: "text",
  allowed_extensions: null, max_file_mb: null, max_files: 5, max_attempts: 2, late_policy: null, late_penalty_percent: null, max_points: 100, work_mode: "individual", attachments_json: null, created_at: NOW, updated_at: NOW, course_status: "published", ...o });
const srow = (o = {}) => ({ id: 90, assignment_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "draft", body_text: "My answer", submitted_at: null, is_late: 0, late_penalty_percent: null, created_at: NOW, updated_at: NOW, ...o });
const EXTROW = { ext_due_at: d("2026-11-25T14:00:00Z"), ext_cutoff_at: null };
const ASG = (r) => ["c.status AS course_status", (i) => (r && i.id === r.id && i.c === r.course_id ? [r] : [])];
const MINE = (rows) => ["FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s ORDER BY attempt_no DESC", (i) => rows.filter((x) => x.student_id === i.s)];
const UPD_DRAFT = ["UPDATE lms_submissions SET body_text", (i) => [{ ...srow(), body_text: i.t, updated_at: i.now }]];
const SUBMIT = ["UPDATE lms_submissions SET status = 'submitted'", (i) => [{ ...srow(), status: "submitted", submitted_at: i.now, is_late: i.late, late_penalty_percent: i.pen }]];
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const LOAD = (r = { id: 4, due_at: d(DUE), cutoff_at: null }, own = [5]) => ["SELECT TOP 1 id, due_at, cutoff_at FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL", onlyIds("c", own, () => (r ? [r] : []))];
const ENR = (yes = true) => ["SELECT TOP 1 student_id FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s", () => (yes ? [{ student_id: 21 }] : [])];
const SET_Q = ["UPDATE lms_extensions SET", () => []];
const DEL = (rows) => ["DELETE FROM lms_extensions", () => rows];
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE |DELETE FROM/.test(x.sql) && !/lms_audit_log/.test(x.sql));
const FUT = "2026-11-25T14:00:00+03:00", FUT2 = "2026-11-30T14:00:00Z";

test("withExtension (pure): later of the two due dates; extension cutoff else the assignment's; no extension = same model; bad dates ignored", () => {
  const m = A.model(arow({ cutoff_at: d("2026-12-01T00:00:00Z") })), e = X.withExtension(m, EXTROW);
  assert.strictEqual(e.dueAt.toISOString(), "2026-11-25T14:00:00.000Z"); assert.strictEqual(e.cutoffAt.toISOString(), "2026-12-01T00:00:00.000Z"); assert.strictEqual(e.extended, true); assert.strictEqual(m.extended, undefined, "original untouched");
  assert.strictEqual(X.withExtension(m, { ext_due_at: d("2026-12-05T00:00:00Z"), ext_cutoff_at: d("2026-12-09T00:00:00Z") }).cutoffAt.toISOString(), "2026-12-09T00:00:00.000Z");
  assert.strictEqual(X.withExtension({ ...m, dueAt: d("2026-12-20T00:00:00Z") }, EXTROW).dueAt.toISOString(), "2026-12-20T00:00:00.000Z", "if the assignment due date later moves past the extension, the later one wins");
  for (const r of [null, undefined, {}, { ext_due_at: null }, { ext_due_at: "nope" }]) assert.strictEqual(X.withExtension(m, r), m);
  assert.strictEqual(X.withExtension(null, EXTROW), null);
});
test("validateBody (pure): only dueAt/cutoffAt/reason; dueAt future, <= 1 year, after the assignment's due date; no due date = NO_DEADLINE; cutoff required when the due date reaches the assignment cut-off; reason cleaned and capped", () => {
  const a = { due_at: d(DUE), cutoff_at: null }, ok = X.validateBody({ dueAt: FUT, reason: " <b>Sick</b> leave\u0000 " }, a, NOW);
  assert.ok(ok.ok); assert.strictEqual(ok.dueAt.toISOString(), "2026-11-25T11:00:00.000Z"); assert.strictEqual(ok.cutoffAt, null); assert.strictEqual(ok.reason, "bSick/b leave");
  for (const b of [null, [], {}, { dueAt: "tomorrow" }, { dueAt: "2026-11-25T14:00:00" }, { dueAt: "2026-11-19T14:00:00Z" }, { dueAt: "2099-01-01T00:00:00Z" }, { dueAt: FUT, student_id: 9 }, { dueAt: FUT, reason: 5 }, { dueAt: FUT, reason: "x".repeat(501) }, { dueAt: FUT, cutoffAt: "nope" }]) assert.strictEqual(X.validateBody(b, a, NOW).ok, false, JSON.stringify(b));
  assert.strictEqual(X.validateBody({ dueAt: "2026-11-20T14:00:00Z" }, a, NOW).ok, false, "not later than the assignment's own due date");
  assert.strictEqual(X.validateBody({ dueAt: "2026-11-20T13:00:00Z" }, a, NOW).ok, false);
  assert.strictEqual(X.validateBody({ dueAt: FUT }, { due_at: null, cutoff_at: null }, NOW).code, "NO_DEADLINE");
  const c = { due_at: d(DUE), cutoff_at: d("2026-11-24T00:00:00Z") };
  assert.strictEqual(X.validateBody({ dueAt: FUT }, c, NOW).ok, false, "cut-off required when due reaches it"); assert.strictEqual(X.validateBody({ dueAt: FUT, cutoffAt: FUT }, c, NOW).ok, false, "cut-off must be after the new due date");
  assert.ok(X.validateBody({ dueAt: FUT, cutoffAt: FUT2 }, c, NOW).ok); assert.ok(X.validateBody({ dueAt: "2026-11-22T00:00:00Z" }, c, NOW).ok, "due before the cut-off: the assignment's cut-off still applies");
  assert.strictEqual(X.validateBody({ dueAt: FUT, reason: "   " }, a, NOW).reason, null);
});

test("window: the learner's extension is applied inside getState / saveDraft / submit; without it the same work is refused; after the extension it closes again; submitting inside it is NOT late", async () => {
  const noExt = await S.getState(makeMockPool([ASG(arow()), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: AFTER });
  assert.deepStrictEqual([noExt.canWrite, noExt.closedReason.code, noExt.extended], [false, "DEADLINE_PASSED", false]);
  const ext = await S.getState(makeMockPool([ASG(arow(EXTROW)), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: AFTER });
  assert.deepStrictEqual([ext.canWrite, ext.window.late, ext.extended, ext.dueAt], [true, false, true, "2026-11-25T14:00:00.000Z"]);
  const over = await S.getState(makeMockPool([ASG(arow(EXTROW)), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: d("2026-11-26T00:00:00Z") }); assert.strictEqual(over.closedReason.code, "DEADLINE_PASSED");
  const m = makeMockPool([ASG(arow(EXTROW)), MINE([]), UPD_DRAFT, SUBMIT]); const sub = await S.submit(m.pool, student(21), 5, 4, { text: "answer" }, { settings: SET, now: AFTER });
  assert.deepStrictEqual([sub.ok, sub.submission.late], [true, false]); assert.strictEqual(m.log.find((x) => /SET status = 'submitted'/.test(x.sql)).inputs.late, 0);
  const refused = await S.submit(makeMockPool([ASG(arow()), UPD_DRAFT, SUBMIT]).pool, student(21), 5, 4, { text: "answer" }, { settings: SET, now: AFTER }); assert.deepStrictEqual([refused.ok, refused.code], [false, "DEADLINE_PASSED"]);
  assert.strictEqual((await S.saveDraft(makeMockPool([ASG(arow(EXTROW)), UPD_DRAFT]).pool, student(21), 5, 4, { text: "x" }, { settings: SET, now: AFTER })).ok, true);
});
test("window SQL: the extension is joined for THIS student only (token id) and matches assignment AND course; student id is a parameter", async () => {
  const m = makeMockPool([ASG(arow(EXTROW)), MINE([])]); await S.getState(m.pool, student(21), 5, 4, { settings: SET, now: AFTER });
  const q = m.log.find((x) => /c\.status AS course_status/.test(x.sql)); assert.ok(/LEFT JOIN lms_extensions x ON x\.assignment_id = a\.id AND x\.course_id = a\.course_id AND x\.student_id = @s/.test(q.sql)); assert.strictEqual(q.inputs.s, 21); assert.ok(!/\b21\b/.test(q.sql.replace(/@\w+/g, "")));
});
test("dashboard pending list: the learner's extension keeps an overdue assignment pending, moves the due date and the overdue flag; SQL joins the extension for the token student", async () => {
  const PEND = "ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END";
  const row = { ...arow({ ...EXTROW, late_policy: "block" }), course_title: "Biology" };
  const run = async (r) => { const m = makeMockPool([[PEND, () => [r]]]); const out = await D.getDashboard(m.pool, student(21), AFTER); return { out, m }; };
  const a = await run({ ...row, ext_due_at: null, ext_cutoff_at: null }); assert.strictEqual(a.out.pendingTasks.length, 0, "block policy + past due, no extension: not pending");
  const b = await run(row); assert.deepStrictEqual(b.out.pendingTasks.map((t) => [t.assignmentId, t.dueAt, t.overdue]), [[4, "2026-11-25T14:00:00.000Z", false]]);
  const q = b.m.log.find((x) => x.sql.includes(PEND)); assert.ok(/LEFT JOIN lms_extensions x ON x\.assignment_id = a\.id AND x\.course_id = a\.course_id AND x\.student_id = @s/.test(q.sql) && /COALESCE\(x\.due_at, a\.due_at\)/.test(q.sql)); assert.strictEqual(q.inputs.s, 21);
});
test("planner / feed: the deadline shown is the learner's extended date (later of the two), joined on THIS student only", async () => {
  const m = makeMockPool([["FROM lms_assignments a", () => [{ id: 4, course_id: 5, course_title: "Biology", title: "Essay 1", due_at: "2026-11-25T14:00:00Z" }]]]);
  const r = await planner.getPlanner(m.pool, student(21), {}, d("2026-11-21T08:00:00Z")); assert.ok(r.ok);
  const q = m.log.find((x) => /FROM lms_assignments a/.test(x.sql)).sql; assert.ok(/LEFT JOIN lms_extensions x ON x\.assignment_id = a\.id AND x\.course_id = a\.course_id AND x\.student_id = @s/.test(q) && /x\.due_at > a\.due_at/.test(q)); assert.ok(!/\b21\b/.test(q.replace(/@\w+/g, "")));
  assert.ok(JSON.stringify(r).includes("2026-11-25T14:00:00"));
});

test("setExtension: validates first, learner must be enrolled in THIS course, one-statement upsert with all values as parameters, audited, ONE event with ids only; archived/pending refused; unknown assignment/student not found", async () => {
  const seen = []; const off = events.on("lms.extension.granted", (p) => { if (p.tenant === "extT1") seen.push(p); });
  const m = makeMockPool([LOAD(), live(), ENR(), SET_Q]); const r = await X.setExtension(m.pool, teacher(7), 5, 4, 21, { dueAt: FUT, reason: "Illness" }, { tenant: "extT1", now: NOW }); await tick(); off();
  assert.deepStrictEqual([r.ok, r.extension.studentId, r.extension.dueAt, r.extension.cutoffAt, r.extension.reason], [true, 21, "2026-11-25T11:00:00.000Z", null, "Illness"]);
  const q = m.log.find((x) => /UPDATE lms_extensions SET/.test(x.sql)); assert.ok(/WHERE assignment_id = @a AND course_id = @c AND student_id = @s/.test(q.sql) && /IF @@ROWCOUNT = 0 INSERT INTO lms_extensions/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.s, q.inputs.uid, q.inputs.src, q.inputs.why], [4, 5, 21, 7, "Teachers", "Illness"]); assert.ok(!/2026|Illness|\b(4|5|7|21)\b/.test(q.sql.replace(/@\w+/g, "")));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql))); assert.deepStrictEqual(seen.map((e) => [e.courseId, e.assignmentId, e.studentId]), [[5, 4, 21]]); assert.ok(events.EVENTS.includes("lms.extension.granted"));
  for (const body of [null, {}, { dueAt: "2020-01-01T00:00:00Z" }, { dueAt: FUT, x: 1 }]) { const b = makeMockPool([LOAD(), live(), ENR(), SET_Q]); assert.strictEqual((await X.setExtension(b.pool, teacher(), 5, 4, 21, body, { now: NOW })).ok, false); assert.strictEqual(writes(b).length, 0); }
  for (const bad of [0, -1, 1.5, "21", null, undefined]) { const b = makeMockPool([LOAD(), live(), ENR(), SET_Q]); assert.strictEqual((await X.setExtension(b.pool, teacher(), 5, 4, bad, { dueAt: FUT }, { now: NOW })).notFound, true); assert.strictEqual(writes(b).length, 0); }
  for (const [st, code] of [["archived", "COURSE_ARCHIVED"], ["pending", "COURSE_PENDING"]]) { const a = makeMockPool([LOAD(), live(st), ENR(), SET_Q]); const x = await X.setExtension(a.pool, teacher(), 5, 4, 21, { dueAt: FUT }, { now: NOW }); assert.deepStrictEqual([x.ok, x.code], [false, code]); assert.strictEqual(writes(a).length, 0); }
  assert.strictEqual((await X.setExtension(makeMockPool([LOAD(null), live(), ENR(), SET_Q]).pool, teacher(), 5, 4, 21, { dueAt: FUT }, { now: NOW })).notFound, true);
  const ne = makeMockPool([LOAD(), live(), ENR(false), SET_Q]); assert.strictEqual((await X.setExtension(ne.pool, teacher(), 5, 4, 21, { dueAt: FUT }, { now: NOW })).notFound, true); assert.strictEqual(writes(ne).length, 0, "a learner outside this course gets nothing");
  const nd = await X.setExtension(makeMockPool([LOAD({ id: 4, due_at: null, cutoff_at: null }), live(), ENR(), SET_Q]).pool, teacher(), 5, 4, 21, { dueAt: FUT }, { now: NOW }); assert.strictEqual(nd.code, "NO_DEADLINE");
  let n = 0; const dup = makeMockPool([LOAD(), live(), ENR(), ["UPDATE lms_extensions SET", () => { if (n++ === 0) { const e = new Error("dup"); e.number = 2627; throw e; } return []; }]]); assert.ok((await X.setExtension(dup.pool, teacher(), 5, 4, 21, { dueAt: FUT }, { now: NOW })).ok); assert.strictEqual(n, 2);
  assert.strictEqual((await X.setExtension(makeMockPool([]).pool, null, 5, 4, 21, { dueAt: FUT }, { now: NOW })).notFound, true);
});
test("revokeExtension: one DELETE scoped to assignment, course AND student; none = not found; archived refused; audited. listExtensions: TOP 500, scoped, shaped", async () => {
  const ok = makeMockPool([LOAD(), live(), DEL([{ due_at: FUT }])]); assert.deepStrictEqual([(await X.revokeExtension(ok.pool, teacher(), 5, 4, 21)).ok], [true]);
  const q = ok.log.find((x) => /DELETE FROM lms_extensions/.test(x.sql)); assert.ok(/WHERE assignment_id = @a AND course_id = @c AND student_id = @s/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.s], [4, 5, 21]); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  assert.strictEqual((await X.revokeExtension(makeMockPool([LOAD(), live(), DEL([])]).pool, teacher(), 5, 4, 21)).notFound, true);
  const arch = makeMockPool([LOAD(), live("archived"), DEL([{ due_at: FUT }])]); assert.strictEqual((await X.revokeExtension(arch.pool, teacher(), 5, 4, 21)).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(arch).length, 0);
  assert.strictEqual((await X.revokeExtension(makeMockPool([LOAD(null), DEL([{ due_at: FUT }])]).pool, teacher(), 5, 4, 21)).notFound, true);
  const l = makeMockPool([LOAD(), ["FROM lms_extensions x LEFT JOIN Students st", () => [{ student_id: 21, due_at: "2026-11-25T11:00:00Z", cutoff_at: null, reason: "Illness", updated_at: "2026-11-20T08:00:00Z", student_name: "A", admission_no: "1" }]]]);
  const r = await X.listExtensions(l.pool, 5, 4); assert.deepStrictEqual(r.extensions.map((e) => [e.studentId, e.studentName, e.dueAt, e.reason]), [[21, "A", "2026-11-25T11:00:00.000Z", "Illness"]]);
  const q2 = l.log.find((x) => /TOP 500 x\.student_id/.test(x.sql)); assert.ok(/x\.assignment_id = @a AND x\.course_id = @c/.test(q2.sql)); assert.strictEqual((await X.listExtensions(makeMockPool([LOAD(null)]).pool, 5, 4)).notFound, true);
});

async function call(method, p, { user, pool, params = {}, body = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query: {}, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const BASE = "/courses/:courseId/assignments/:assignmentId/extensions", PS = { courseId: "5", assignmentId: "4", studentId: "21" };
const SOON = () => new Date(Date.now() + 5 * 864e5).toISOString();
const farDue = () => ({ id: 4, due_at: new Date(Date.now() + 864e5), cutoff_at: null });
const full = () => makeMockPool([staff([5]), live(), LOAD(farDue()), ENR(), SET_Q, DEL([{ due_at: FUT }]), ["FROM lms_extensions x LEFT JOIN Students st", () => []]]);
test("routes: staff with membership only; students and non-members get 403 with nothing touched; bad ids 404; bad body 400; success 200; tenant isolation", async () => {
  const ok = [["get", BASE, 200], ["put", `${BASE}/:studentId`, 200, { dueAt: SOON() }], ["delete", `${BASE}/:studentId`, 200]];
  for (const [method, p, code, body] of ok) {
    const r = await call(method, p, { user: teacher(), pool: full().pool, params: PS, body: body || {} }); assert.strictEqual(r.res.statusCode, code, `${method}: ${JSON.stringify(r.res.body)}`); assert.strictEqual(r.res.body.success, true);
    const st = full(); assert.strictEqual((await call(method, p, { user: student(), pool: st.pool, params: PS, body: body || {} })).res.statusCode, 403); assert.strictEqual(writes(st).length, 0);
    const ns = makeMockPool([staff([6]), live(), LOAD(farDue()), ENR(), SET_Q, DEL([{ due_at: FUT }])]); assert.strictEqual((await call(method, p, { user: teacher(), pool: ns.pool, params: PS, body: body || {} })).res.statusCode, 403); assert.ok(!ns.log.some((x) => /lms_extensions|lms_assignments/.test(x.sql)));
    assert.strictEqual((await call(method, p, { user: teacher(), pool: full().pool, params: { ...PS, assignmentId: "abc" }, body: body || {} })).res.statusCode, 404);
    if (p.includes(":studentId")) for (const bad of ["abc", "0"]) assert.strictEqual((await call(method, p, { user: teacher(), pool: full().pool, params: { ...PS, studentId: bad }, body: body || {} })).res.statusCode, 404, bad);
  }
  assert.strictEqual((await call("put", `${BASE}/:studentId`, { user: teacher(), pool: full().pool, params: PS, body: { dueAt: "2001-01-01T00:00:00Z" } })).res.statusCode, 400);
  assert.strictEqual((await call("put", `${BASE}/:studentId`, { user: teacher(), pool: makeMockPool([staff([5]), live(), LOAD(farDue()), ENR(false), SET_Q]).pool, params: PS, body: { dueAt: SOON() } })).res.statusCode, 404);
  assert.strictEqual((await call("delete", `${BASE}/:studentId`, { user: teacher(), pool: makeMockPool([staff([5]), live(), LOAD(farDue()), DEL([])]).pool, params: PS })).res.statusCode, 404);
  assert.strictEqual((await call("put", `${BASE}/:studentId`, { user: teacher(), pool: makeMockPool([staff([5]), live("archived"), LOAD(farDue()), ENR(), SET_Q]).pool, params: PS, body: { dueAt: SOON() } })).res.statusCode, 409);
  const resp = (own) => [staff([5]), live(), ["SELECT TOP 1 id, due_at, cutoff_at FROM lms_assignments WHERE id = @a", onlyIds("a", own, () => [farDue()])], ENR(), SET_Q];
  const Tn = makeTenants({ A: resp([4]), B: resp([77]) }); assert.strictEqual((await call("put", `${BASE}/:studentId`, { user: teacher(), pool: Tn.A.pool, params: PS, body: { dueAt: SOON() }, tenant: "A" })).res.statusCode, 200); Tn.assertQueried("A"); Tn.assertUntouched("B");
  assert.strictEqual((await call("put", `${BASE}/:studentId`, { user: teacher(), pool: Tn.A.pool, params: { ...PS, assignmentId: "77" }, body: { dueAt: SOON() }, tenant: "A" })).res.statusCode, 404); Tn.assertUntouched("B");
});
test("static: step 023 additive, unique per (assignment, student), after 022, table blocklisted; 3 routes gated and registered after the router guards; no raw db / req.body; no interpolated user value", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "023_lms_extensions"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "022_lms_student_release") + 1);
  assert.ok(st.sql.some((x) => /CREATE UNIQUE INDEX UX_lms_extensions_assignment_student ON lms_extensions \(assignment_id, student_id\)/.test(x)) && st.sql.every((x) => !/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(x)));
  assert.ok(/"lms_extensions"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")));
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && /\/extensions/.test(l.route.path)); assert.strictEqual(mine.length, 3);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(router.stack.indexOf(l) > first); assert.ok(l.route.stack.length >= (l.route.methods.get ? 2 : 3), l.route.path); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsExtensions.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db|req\.body/.test(src));
  const sqls = src.match(/`(?:UPDATE|DELETE|SELECT|IF)[\s\S]*?`/g) || []; assert.ok(sqls.length >= 5); for (const q of sqls) assert.ok(!/\$\{(?!MAX_LISTED)/.test(q), "no interpolated user value: " + q.slice(0, 50));
  assert.strictEqual(X.joinSql("@s"), "LEFT JOIN lms_extensions x ON x.assignment_id = a.id AND x.course_id = a.course_id AND x.student_id = @s");
});

test("plagiarism hook (interface only): not configured = nothing happens; result clamped, only http(s) links kept; failure and timeout never throw; unregister works; bad checker refused", async () => {
  assert.deepStrictEqual(await P.check({ text: "x" }), { status: "not_configured" }); assert.strictEqual(P.isConfigured(), false);
  const seen = []; const off = P.registerChecker(async (i) => { seen.push(i); return { score: 250, reportUrl: "https://example.org/r/1" }; });
  assert.deepStrictEqual(await P.check({ tenant: "t", submissionId: 3 }), { status: "done", score: 100, reportUrl: "https://example.org/r/1" }); assert.deepStrictEqual(seen, [{ tenant: "t", submissionId: 3 }]);
  P.registerChecker(async () => ({ score: -4, reportUrl: "javascript:alert(1)" })); assert.deepStrictEqual(await P.check({}), { status: "done", score: 0, reportUrl: null });
  P.registerChecker(async () => ({ score: "abc" })); assert.strictEqual((await P.check({})).score, null);
  P.registerChecker(async () => { throw new Error("secret detail"); }); assert.deepStrictEqual(await P.check({}), { status: "error" });
  P.registerChecker(() => new Promise(() => {})); assert.deepStrictEqual(await P.check({}, { timeoutMs: 20 }), { status: "timeout" });
  assert.throws(() => P.registerChecker("nope"), /function/); P.registerChecker(null); assert.strictEqual(P.isConfigured(), false); off();
});
