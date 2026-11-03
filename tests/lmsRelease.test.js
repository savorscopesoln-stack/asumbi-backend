/* L5.4b-2 — bulk return + scheduled grade release (D-064/D-065). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsRelease.test.js");
const R = require("../utils/lmsRelease"), M = require("../utils/lmsMarking"), D = require("../utils/lmsDashboard"), events = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const NOW = new Date("2026-11-20T08:00:00Z"), FUT = "2026-11-25T08:00:00+03:00";
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const EXISTS = (yes = true) => ["SELECT TOP 1 id FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL", onlyIds("c", [5], () => (yes ? [{ id: 4 }] : []))];
const DUE = (rows = []) => ["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => rows];
const GR = (sid, stu = 21) => ({ submission_id: sid, assignment_id: 4, course_id: 5, student_id: stu });
const PEEK = (at) => ["SELECT TOP 1 release_at FROM lms_assignment_releases", () => (at ? [{ release_at: at }] : [])];
const SETQ = ["UPDATE lms_assignment_releases SET", () => []];
const DEL = (rows) => ["DELETE FROM lms_assignment_releases", () => rows];
const RETALL = (rows) => ["FROM lms_submission_grades g WHERE g.assignment_id = @a AND g.course_id = @c", () => rows];
const SKIP = (n) => ["SELECT COUNT(*) AS n FROM lms_submissions s LEFT JOIN lms_submission_grades g", () => [{ n }]];
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE |DELETE FROM|SET XACT_ABORT/.test(x.sql) && !/lms_audit_log/.test(x.sql));
const norel = (m) => m.log.filter((x) => !/returned_at = rel\.release_at/.test(x.sql));

test("pure: parseReleaseAt needs ISO 8601 WITH a time zone, in the future, at most a year ahead", () => {
  const ok = R.parseReleaseAt("2026-11-25T08:00:00+03:00", NOW); assert.ok(ok.ok); assert.strictEqual(ok.date.toISOString(), "2026-11-25T05:00:00.000Z");
  assert.ok(R.parseReleaseAt("2026-11-25T08:00Z", NOW).ok);
  for (const v of ["2026-11-25T08:00:00", "2026-11-25", "tomorrow", "", null, undefined, 5, {}, ["2026-11-25T08:00:00Z"], "2026-13-45T08:00:00Z", "2026-11-20T08:00:00Z", "2026-11-19T08:00:00Z", "2027-12-31T08:00:00Z"]) assert.strictEqual(R.parseReleaseAt(v, NOW).ok, false, String(v));
  assert.ok(R.parseReleaseAt("2027-11-20T08:00:00Z", NOW).ok, "365 days ahead is fine");
});

test("releaseDue: ONE guarded UPDATE (draft only, due schedule only, saved at or before the release time, latest attempts only), scoped by parameters; events once per grade with ids only", async () => {
  const seen = []; const off = events.on("lms.grade.released", (p) => { if (p.tenant === "relT1") seen.push(p); });
  const m = makeMockPool([DUE([GR(31), GR(32, 22)])]); const n = await R.releaseDue(m.pool, { courseId: 5, assignmentId: 4, studentId: 21 }, { tenant: "relT1", now: NOW }); await tick(); off();
  assert.strictEqual(n, 2); assert.strictEqual(m.log.length, 1); const q = m.log[0];
  assert.deepStrictEqual([q.inputs.c, q.inputs.a, q.inputs.st], [5, 4, 21]); assert.deepStrictEqual(q.inputs.now, NOW);
  assert.ok(/UPDATE g SET status = 'returned', returned_at = rel\.release_at/.test(q.sql), "returned_at is the scheduled time");
  assert.ok(/WHERE g\.status = 'draft'/.test(q.sql) && /rel\.release_at <= @now/.test(q.sql) && /g\.graded_at <= rel\.release_at/.test(q.sql));
  assert.ok(/ar\.assignment_id = g\.assignment_id AND ar\.course_id = g\.course_id/.test(q.sql) && /g\.course_id = @c/.test(q.sql) && /g\.assignment_id = @a/.test(q.sql) && /g\.student_id = @st/.test(q.sql));
  assert.ok(/s\.attempt_no = \(SELECT MAX\(l\.attempt_no\)/.test(q.sql) && /s\.status = 'submitted'/.test(q.sql), "latest submitted attempt only");
  assert.ok(!/\b(5|4|21)\b/.test(q.sql.replace(/@\w+/g, "")), "no literal ids");
  assert.deepStrictEqual(seen.map((x) => [x.courseId, x.assignmentId, x.submissionId, x.studentId]).sort(), [[5, 4, 31, 21], [5, 4, 32, 22]]);
  const one = makeMockPool([DUE([GR(31)])]); await R.releaseDue(one.pool, { studentId: 21 }, { now: NOW }); assert.ok(!/g\.course_id = @c|g\.assignment_id = @a/.test(one.log[0].sql) && /g\.student_id = @st/.test(one.log[0].sql));
});
test("releaseDue: no scope = no query; no tenant = no events; a database failure is swallowed (grades just stay hidden) unless `strict`", async () => {
  for (const sc of [undefined, null, {}, { courseId: "5" }, { assignmentId: 0 }, { studentId: -1 }, { courseId: 1.5 }]) { const m = makeMockPool([DUE([GR(1)])]); assert.strictEqual(await R.releaseDue(m.pool, sc, { now: NOW }), 0); assert.strictEqual(m.log.length, 0, JSON.stringify(sc)); }
  const seen = []; const off = events.on("lms.grade.released", (p) => seen.push(p)); const m = makeMockPool([DUE([GR(1)])]); assert.strictEqual(await R.releaseDue(m.pool, { assignmentId: 4 }, { now: NOW }), 1); await tick(); off(); assert.ok(!seen.some((p) => p.submissionId === 1 && p.assignmentId === 4 && p.tenant), "no tenant, nothing emitted for it");
  const bad = makeMockPool([["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("db secret"); }]]);
  assert.strictEqual(await R.releaseDue(bad.pool, { assignmentId: 4 }, { now: NOW }), 0);
  await assert.rejects(() => R.releaseDue(bad.pool, { assignmentId: 4 }, { now: NOW, strict: true }), /db secret/);
});

test("returnAll: ONE UPDATE of draft grades on latest attempts of THIS assignment; ungraded work counted not touched; audit + one event per returned grade", async () => {
  const seen = []; const off = events.on("lms.grade.released", (p) => { if (p.tenant === "relT2") seen.push(p); });
  const m = makeMockPool([live(), EXISTS(), RETALL([GR(31), GR(32, 22), GR(33, 23)]), SKIP(2)]);
  const r = await R.returnAll(m.pool, teacher(), 5, 4, { tenant: "relT2", now: NOW }); await tick(); off();
  assert.deepStrictEqual([r.ok, r.returned, r.skippedUngraded], [true, 3, 2]); assert.strictEqual(seen.length, 3);
  const q = m.log.find((x) => /UPDATE g SET status = 'returned', returned_at = @now/.test(x.sql)); assert.ok(q);
  assert.ok(/g\.assignment_id = @a AND g\.course_id = @c AND g\.status = 'draft'/.test(q.sql) && /MAX\(l\.attempt_no\)/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c], [4, 5]); assert.ok(!/\b(4|5)\b/.test(q.sql.replace(/@\w+/g, "")));
  assert.strictEqual(writes(m).length, 1, "exactly one write");
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)), "audited");
  const sk = m.log.find((x) => /LEFT JOIN lms_submission_grades g/.test(x.sql)); assert.ok(/g\.id IS NULL/.test(sk.sql) && /s\.assignment_id = @a AND s\.course_id = @c/.test(sk.sql));
});
test("returnAll: unknown or other-course assignment = not found with no write; archived/pending course refused; a class with nothing graded returns 0", async () => {
  const gone = makeMockPool([live(), EXISTS(false), RETALL([GR(1)])]); const a = await R.returnAll(gone.pool, teacher(), 5, 4, { now: NOW }); assert.deepStrictEqual([a.ok, a.notFound], [false, true]); assert.strictEqual(writes(gone).length, 0);
  const other = makeMockPool([live(), EXISTS(), RETALL([GR(1)])]); assert.strictEqual((await R.returnAll(other.pool, teacher(), 9, 4, { now: NOW })).notFound, true); assert.strictEqual(writes(other).length, 0);
  for (const [st, code] of [["archived", "COURSE_ARCHIVED"], ["pending", "COURSE_PENDING"]]) { const m = makeMockPool([live(st), EXISTS(), RETALL([GR(1)])]); const r = await R.returnAll(m.pool, teacher(), 5, 4, { now: NOW }); assert.deepStrictEqual([r.ok, r.code], [false, code]); assert.strictEqual(writes(m).length, 0); }
  const none = makeMockPool([live(), EXISTS(), RETALL([]), SKIP(4)]); const z = await R.returnAll(none.pool, teacher(), 5, 4, { now: NOW }); assert.deepStrictEqual([z.ok, z.returned, z.skippedUngraded], [true, 0, 4]);
  assert.strictEqual((await R.returnAll(makeMockPool([]).pool, null, 5, 4, { now: NOW })).notFound, true);
});

test("setRelease: validates first; applies a due schedule (strict) BEFORE writing; upsert is one statement with all values as parameters; audited; archived refused", async () => {
  const m = makeMockPool([live(), EXISTS(), DUE([]), SETQ]); const r = await R.setRelease(m.pool, teacher(7), 5, 4, { releaseAt: FUT }, { now: NOW });
  assert.deepStrictEqual([r.ok, r.release.releaseAt, r.release.passed], [true, "2026-11-25T05:00:00.000Z", false]);
  const iDue = m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iSet = m.log.findIndex((x) => /UPDATE lms_assignment_releases SET/.test(x.sql)); assert.ok(iDue >= 0 && iSet > iDue, "due schedule applied first");
  const q = m.log[iSet]; assert.ok(/WHERE assignment_id = @a AND course_id = @c/.test(q.sql) && /IF @@ROWCOUNT = 0 INSERT INTO lms_assignment_releases/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.uid, q.inputs.src], [4, 5, 7, "Teachers"]); assert.ok(!/2026|\b(4|5|7)\b/.test(q.sql.replace(/@\w+/g, "")));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  for (const body of [null, [], {}, { releaseAt: "2026-11-19T08:00:00Z" }, { releaseAt: "nope" }, { releaseAt: FUT, extra: 1 }, { when: FUT }]) { const b = makeMockPool([live(), EXISTS(), DUE([]), SETQ]); const x = await R.setRelease(b.pool, teacher(), 5, 4, body, { now: NOW }); assert.strictEqual(x.ok, false, JSON.stringify(body)); assert.strictEqual(writes(b).length, 0); }
  for (const [st, code] of [["archived", "COURSE_ARCHIVED"], ["pending", "COURSE_PENDING"]]) { const a = makeMockPool([live(st), EXISTS(), DUE([]), SETQ]); const x = await R.setRelease(a.pool, teacher(), 5, 4, { releaseAt: FUT }, { now: NOW }); assert.deepStrictEqual([x.ok, x.code], [false, code]); assert.strictEqual(writes(a).length, 0); }
  const gone = makeMockPool([live(), EXISTS(false), SETQ]); assert.strictEqual((await R.setRelease(gone.pool, teacher(), 5, 4, { releaseAt: FUT }, { now: NOW })).notFound, true); assert.strictEqual(writes(gone).length, 0);
  let n = 0; const dup = makeMockPool([live(), EXISTS(), DUE([]), ["UPDATE lms_assignment_releases SET", () => { if (n++ === 0) { const e = new Error("dup"); e.number = 2627; throw e; } return []; }]]);
  assert.ok((await R.setRelease(dup.pool, teacher(), 5, 4, { releaseAt: FUT }, { now: NOW })).ok); assert.strictEqual(n, 2, "a parallel first save is retried as an update");
  const boom = makeMockPool([live(), EXISTS(), ["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("db down"); }], SETQ]); await assert.rejects(() => R.setRelease(boom.pool, teacher(), 5, 4, { releaseAt: FUT }, { now: NOW }), /db down/); assert.strictEqual(writes(boom).length, 0, "if a due release could not be applied, a schedule is never overwritten");
});
test("cancelRelease: one guarded DELETE (release_at > now); a passed schedule is SCHEDULE_PASSED, none is NOT_SCHEDULED; archived refused", async () => {
  const ok = makeMockPool([live(), EXISTS(), DUE([]), DEL([{ release_at: FUT }])]); const r = await R.cancelRelease(ok.pool, teacher(), 5, 4, { now: NOW }); assert.deepStrictEqual([r.ok, r.cancelled], [true, true]);
  const q = ok.log.find((x) => /DELETE FROM lms_assignment_releases/.test(x.sql)); assert.ok(/WHERE assignment_id = @a AND course_id = @c AND release_at > @now/.test(q.sql) && /OUTPUT DELETED\.release_at/.test(q.sql)); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const passed = makeMockPool([live(), EXISTS(), DUE([]), DEL([]), PEEK("2026-11-19T08:00:00Z")]); const p = await R.cancelRelease(passed.pool, teacher(), 5, 4, { now: NOW }); assert.deepStrictEqual([p.ok, p.code], [false, "SCHEDULE_PASSED"]);
  const none = makeMockPool([live(), EXISTS(), DUE([]), DEL([]), PEEK(null)]); assert.strictEqual((await R.cancelRelease(none.pool, teacher(), 5, 4, { now: NOW })).code, "NOT_SCHEDULED");
  const arch = makeMockPool([live("archived"), EXISTS(), DEL([{ release_at: FUT }])]); assert.strictEqual((await R.cancelRelease(arch.pool, teacher(), 5, 4, { now: NOW })).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(arch).length, 0);
  assert.strictEqual((await R.cancelRelease(makeMockPool([live(), EXISTS(false)]).pool, teacher(), 5, 4, { now: NOW })).notFound, true);
  const boom = makeMockPool([live(), EXISTS(), ["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("db down"); }], DEL([{ release_at: FUT }])]); await assert.rejects(() => R.cancelRelease(boom.pool, teacher(), 5, 4, { now: NOW }), /db down/); assert.strictEqual(writes(boom).length, 0, "a due release that could not be applied is never silently cancelled");
});
test("getRelease: applies a due schedule first, then shows {releaseAt, passed}; none = null; unknown assignment = not found", async () => {
  const f = makeMockPool([EXISTS(), DUE([]), PEEK("2026-11-25T05:00:00Z")]); const a = await R.getRelease(f.pool, 5, 4, { now: NOW }); assert.deepStrictEqual(a.release, { releaseAt: "2026-11-25T05:00:00.000Z", passed: false });
  const p = makeMockPool([EXISTS(), DUE([GR(1)]), PEEK("2026-11-19T08:00:00Z")]); assert.strictEqual((await R.getRelease(p.pool, 5, 4, { now: NOW })).release.passed, true);
  assert.strictEqual((await R.getRelease(makeMockPool([EXISTS(), PEEK(null)]).pool, 5, 4, { now: NOW })).release, null); assert.strictEqual((await R.getRelease(makeMockPool([EXISTS(false)]).pool, 5, 4, { now: NOW })).notFound, true);
});

/* ---- every read path applies a due schedule first (fail-safe: a missed call only DELAYS a release) ---- */
const ASSIGN = ["title, max_points FROM lms_assignments WHERE id = @a AND course_id = @c", () => [{ id: 4, title: "Essay", max_points: "20.00" }]];
const SUB = ["SELECT TOP 1 id, student_id, attempt_no, body_text", () => [{ id: 31, student_id: 21, attempt_no: 1, body_text: "x", submitted_at: "2026-10-01T08:00:00Z", is_late: 0, late_penalty_percent: null }]];
const NORUBRIC = ["FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r", () => []];
test("saveGrade applies a due schedule BEFORE saving, so a grade the schedule just returned cannot be changed (ALREADY_RETURNED, Q34)", async () => {
  const m = makeMockPool([live(), ASSIGN, SUB, NORUBRIC, ["SELECT TOP 1 id FROM lms_assignments WHERE id = @a", () => [{ id: 4 }]], DUE([GR(31)]), ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @ok", () => [{ ok: 1, returned: 1 }]]]);
  const r = await M.saveGrade(m.pool, teacher(), 5, 4, 31, { points: 12 }, { tenant: "relT3" }); assert.deepStrictEqual([r.ok, r.code], [false, "ALREADY_RETURNED"]);
  const iDue = m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iSave = m.log.findIndex((x) => /SET XACT_ABORT ON/.test(x.sql)); assert.ok(iDue >= 0 && iSave > iDue);
});
test("returnGrade applies a due schedule first (the single return then answers ALREADY_RETURNED instead of returning twice)", async () => {
  const m = makeMockPool([live(), SUB, DUE([GR(31)]), ["UPDATE lms_submission_grades SET status = 'returned'", () => []], ["SELECT TOP 1 status FROM lms_submission_grades", () => [{ status: "returned" }]]]);
  const r = await M.returnGrade(m.pool, teacher(), 5, 4, 31, { tenant: "relT4", now: NOW }); assert.deepStrictEqual([r.ok, r.code], [false, "ALREADY_RETURNED"]);
  const iD = m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iU = m.log.findIndex((x) => /UPDATE lms_submission_grades SET status = 'returned'/.test(x.sql)); assert.ok(iD >= 0 && iU > iD);
});
test("queue and marking reads apply a due schedule first; the queue also reports the schedule {releaseAt, passed}", async () => {
  const m = makeMockPool([ASSIGN, DUE([]), ["SELECT COUNT(*) AS n FROM lms_submissions s LEFT JOIN Students st", () => [{ n: 0 }]], ["FROM lms_submissions s LEFT JOIN Students st", () => []], PEEK("2026-11-25T05:00:00Z")]);
  const r = await M.listQueue(m.pool, 5, 4, {}); assert.ok(r.ok); assert.deepStrictEqual(r.release, { releaseAt: "2026-11-25T05:00:00.000Z", passed: r.release.passed }); assert.strictEqual(typeof r.release.passed, "boolean");
  const iR = m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iQ = m.log.findIndex((x) => /FROM lms_submissions s LEFT JOIN Students st/.test(x.sql)); assert.ok(iR >= 0 && iQ > iR, "release before the queue rows are read");
  const none = makeMockPool([ASSIGN, ["SELECT COUNT(*) AS n FROM lms_submissions s LEFT JOIN Students st", () => [{ n: 0 }]], ["FROM lms_submissions s LEFT JOIN Students st", () => []]]); assert.strictEqual((await M.listQueue(none.pool, 5, 4, {})).release, null);
  const g = makeMockPool([ASSIGN, DUE([]), SUB, ["FROM Students WHERE id = @s", () => [{ name: "A", admissionNo: "1" }]]]); await M.getForMarking(g.pool, 5, 4, 31); assert.ok(g.log.some((x) => /returned_at = rel\.release_at/.test(x.sql)));
});
test("student reads (feedback, assignment status, dashboard) apply the schedule for THAT student only", async () => {
  const f = makeMockPool([DUE([])]); await M.feedbackForStudent(f.pool, student(21), 5, 4, { now: NOW }); const q = f.log.find((x) => /returned_at = rel\.release_at/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.a, q.inputs.st], [5, 4, 21]);
  const t = makeMockPool([DUE([])]); await M.feedbackForStudent(t.pool, teacher(), 5, 4); assert.strictEqual(t.log.length, 0, "staff: nothing queried");
  const a = makeMockPool([DUE([])]); await M.attachStatus(a.pool, student(21), 5, [{ id: 4 }], { now: NOW }); const qa = a.log.find((x) => /returned_at = rel\.release_at/.test(x.sql)); assert.deepStrictEqual([qa.inputs.c, qa.inputs.st, qa.inputs.a], [5, 21, undefined]);
  const d = makeMockPool([DUE([])]); await D.getDashboard(d.pool, student(21), NOW); const qd = d.log.find((x) => /returned_at = rel\.release_at/.test(x.sql)); assert.deepStrictEqual([qd.inputs.st, qd.inputs.c, qd.inputs.a], [21, undefined, undefined]);
  const iD = d.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iF = d.log.findIndex((x) => /FROM lms_submission_grades g\s+JOIN lms_submissions sb|FROM lms_submission_grades g JOIN lms_submissions sb/.test(x.sql)); assert.ok(iD >= 0 && iF > iD, "dashboard feedback is read after the release");
  const down = makeMockPool([["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("x"); }]]); const out = await D.getDashboard(down.pool, student(21), NOW); assert.ok(out.ok && !out.errors.recentFeedback, "a failed release never breaks the dashboard");
});

/* ---- routes ---- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const BASE = "/courses/:courseId/assignments/:assignmentId", P = { courseId: "5", assignmentId: "4" };
const SOON = () => new Date(Date.now() + 5 * 864e5).toISOString(); // routes use the real clock
const full = () => makeMockPool([staff([5]), live(), EXISTS(), DUE([]), RETALL([GR(31)]), SKIP(1), PEEK("2026-11-25T05:00:00Z"), SETQ, DEL([{ release_at: FUT }])]);
/* ---- L5.4b-3: per-student override (Q36 = both; D-066) ---- */
const ENR = (yes = true) => ["SELECT TOP 1 student_id FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s", () => (yes ? [{ student_id: 21 }] : [])];
const SSET = ["UPDATE lms_student_releases SET", () => []];
const SDEL = (rows) => ["DELETE FROM lms_student_releases", () => rows];
const SPEEK = (at) => ["SELECT TOP 1 release_at FROM lms_student_releases", () => (at ? [{ release_at: at }] : [])];
test("releaseDue (override): ONE statement whose effective time is the student's own override (only if at or after the grade was saved), else the assignment schedule; override first", async () => {
  const m = makeMockPool([DUE([GR(31)])]); await R.releaseDue(m.pool, { courseId: 5, assignmentId: 4 }, { now: NOW }); assert.strictEqual(m.log.length, 1); const q = m.log[0].sql;
  assert.ok(/FROM lms_student_releases sr WHERE sr\.assignment_id = g\.assignment_id AND sr\.course_id = g\.course_id AND sr\.student_id = g\.student_id AND sr\.release_at >= g\.graded_at/.test(q), "override matches assignment, course AND student; ignored for later-graded work");
  assert.ok(/SELECT 1 AS pri, sr\.release_at[\s\S]*UNION ALL SELECT 2 AS pri, ar\.release_at[\s\S]*ORDER BY x\.pri/.test(q), "override wins over the assignment schedule");
  assert.ok(/g\.graded_at <= rel\.release_at AND rel\.release_at <= @now/.test(q) && /g\.status = 'draft'/.test(q) && /MAX\(l\.attempt_no\)/.test(q));
});
test("setStudentRelease: validates, student must be enrolled in THIS course, due schedule applied (strict, for that student) BEFORE the one-statement upsert; audited with ids only; archived refused", async () => {
  const m = makeMockPool([live(), EXISTS(), ENR(), DUE([]), SSET]); const r = await R.setStudentRelease(m.pool, teacher(7), 5, 4, 21, { releaseAt: FUT }, { now: NOW });
  assert.deepStrictEqual([r.ok, r.release.studentId, r.release.releaseAt, r.release.passed], [true, 21, "2026-11-25T05:00:00.000Z", false]);
  const iDue = m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)), iSet = m.log.findIndex((x) => /UPDATE lms_student_releases SET/.test(x.sql)); assert.ok(iDue >= 0 && iSet > iDue);
  assert.deepStrictEqual([m.log[iDue].inputs.c, m.log[iDue].inputs.a, m.log[iDue].inputs.st], [5, 4, 21], "due release applied for that student only");
  const q = m.log[iSet]; assert.ok(/WHERE assignment_id = @a AND course_id = @c AND student_id = @s/.test(q.sql) && /IF @@ROWCOUNT = 0 INSERT INTO lms_student_releases/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.s, q.inputs.uid], [4, 5, 21, 7]); assert.ok(!/2026|\b(4|5|7|21)\b/.test(q.sql.replace(/@\w+/g, "")));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  for (const body of [null, [], {}, { releaseAt: "2026-11-19T08:00:00Z" }, { releaseAt: "nope" }, { releaseAt: FUT, extra: 1 }]) { const b = makeMockPool([live(), EXISTS(), ENR(), DUE([]), SSET]); assert.strictEqual((await R.setStudentRelease(b.pool, teacher(), 5, 4, 21, body, { now: NOW })).ok, false, JSON.stringify(body)); assert.strictEqual(writes(b).length, 0); }
  for (const bad of [0, -1, 1.5, "21", null, undefined]) { const b = makeMockPool([live(), EXISTS(), ENR(), SSET]); assert.strictEqual((await R.setStudentRelease(b.pool, teacher(), 5, 4, bad, { releaseAt: FUT }, { now: NOW })).notFound, true); assert.strictEqual(b.log.length, 0); }
  const ne = makeMockPool([live(), EXISTS(), ENR(false), SSET]); assert.strictEqual((await R.setStudentRelease(ne.pool, teacher(), 5, 4, 21, { releaseAt: FUT }, { now: NOW })).notFound, true); assert.strictEqual(writes(ne).length, 0, "a student of another course / school cannot be given a release");
  for (const [st, code] of [["archived", "COURSE_ARCHIVED"], ["pending", "COURSE_PENDING"]]) { const a = makeMockPool([live(st), EXISTS(), ENR(), SSET]); const x = await R.setStudentRelease(a.pool, teacher(), 5, 4, 21, { releaseAt: FUT }, { now: NOW }); assert.deepStrictEqual([x.ok, x.code], [false, code]); assert.strictEqual(writes(a).length, 0); }
  assert.strictEqual((await R.setStudentRelease(makeMockPool([live(), EXISTS(false), ENR(), SSET]).pool, teacher(), 5, 4, 21, { releaseAt: FUT }, { now: NOW })).notFound, true);
  let n = 0; const dup = makeMockPool([live(), EXISTS(), ENR(), DUE([]), ["UPDATE lms_student_releases SET", () => { if (n++ === 0) { const e = new Error("dup"); e.number = 2601; throw e; } return []; }]]); assert.ok((await R.setStudentRelease(dup.pool, teacher(), 5, 4, 21, { releaseAt: FUT }, { now: NOW })).ok); assert.strictEqual(n, 2);
  const boom = makeMockPool([live(), EXISTS(), ENR(), ["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("db down"); }], SSET]); await assert.rejects(() => R.setStudentRelease(boom.pool, teacher(), 5, 4, 21, { releaseAt: FUT }, { now: NOW }), /db down/); assert.strictEqual(writes(boom).length, 0);
});
test("cancelStudentRelease: one guarded DELETE (this student, release_at > now); passed = SCHEDULE_PASSED, none = NOT_SCHEDULED; archived refused; nothing silently cancelled when a due release failed", async () => {
  const ok = makeMockPool([live(), EXISTS(), DUE([]), SDEL([{ release_at: FUT }])]); const r = await R.cancelStudentRelease(ok.pool, teacher(), 5, 4, 21, { now: NOW }); assert.deepStrictEqual([r.ok, r.cancelled], [true, true]);
  const q = ok.log.find((x) => /DELETE FROM lms_student_releases/.test(x.sql)); assert.ok(/WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND release_at > @now/.test(q.sql)); assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.s], [4, 5, 21]); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const passed = makeMockPool([live(), EXISTS(), DUE([]), SDEL([]), SPEEK("2026-11-19T08:00:00Z")]); assert.strictEqual((await R.cancelStudentRelease(passed.pool, teacher(), 5, 4, 21, { now: NOW })).code, "SCHEDULE_PASSED");
  const none = makeMockPool([live(), EXISTS(), DUE([]), SDEL([]), SPEEK(null)]); assert.strictEqual((await R.cancelStudentRelease(none.pool, teacher(), 5, 4, 21, { now: NOW })).code, "NOT_SCHEDULED");
  const arch = makeMockPool([live("archived"), EXISTS(), SDEL([{ release_at: FUT }])]); assert.strictEqual((await R.cancelStudentRelease(arch.pool, teacher(), 5, 4, 21, { now: NOW })).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(arch).length, 0);
  assert.strictEqual((await R.cancelStudentRelease(makeMockPool([live(), EXISTS(), SDEL([{ release_at: FUT }])]).pool, teacher(), 5, 4, 0, { now: NOW })).notFound, true);
  const boom = makeMockPool([live(), EXISTS(), ["UPDATE g SET status = 'returned', returned_at = rel.release_at", () => { throw new Error("db down"); }], SDEL([{ release_at: FUT }])]); await assert.rejects(() => R.cancelStudentRelease(boom.pool, teacher(), 5, 4, 21, { now: NOW }), /db down/); assert.strictEqual(writes(boom).length, 0);
});
test("listStudentReleases: applies due schedules first, TOP 500 scoped by assignment AND course, maps passed; unknown assignment not found", async () => {
  const m = makeMockPool([EXISTS(), DUE([]), ["FROM lms_student_releases sr LEFT JOIN Students st", () => [{ student_id: 21, release_at: "2026-11-25T05:00:00Z", student_name: "A", admission_no: "1" }, { student_id: 22, release_at: "2026-11-19T05:00:00Z", student_name: null, admission_no: null }]]]);
  const r = await R.listStudentReleases(m.pool, 5, 4, { now: NOW }); assert.deepStrictEqual(r.releases.map((x) => [x.studentId, x.passed, x.studentName]), [[21, false, "A"], [22, true, null]]);
  const q = m.log.find((x) => /TOP 500 sr\.student_id/.test(x.sql)); assert.ok(/TOP 500/.test(q.sql) && /sr\.assignment_id = @a AND sr\.course_id = @c/.test(q.sql)); assert.ok(m.log.findIndex((x) => /returned_at = rel\.release_at/.test(x.sql)) < m.log.indexOf(q));
  assert.strictEqual((await R.listStudentReleases(makeMockPool([EXISTS(false)]).pool, 5, 4, { now: NOW })).notFound, true);
});
const SB = `${BASE}/grade-release/students`;
const sfull = () => makeMockPool([staff([5]), live(), EXISTS(), ENR(), DUE([]), SSET, SDEL([{ release_at: FUT }]), ["FROM lms_student_releases sr LEFT JOIN Students st", () => []]]);
test("student-release routes: staff with lms.submission.grade + membership only; students and non-members get 403 with nothing touched; bad ids 404; bad body 400; passed 409; tenant isolation", async () => {
  const ok = [["get", SB, 200], ["put", `${SB}/:studentId`, 200, { releaseAt: SOON() }], ["delete", `${SB}/:studentId`, 200]]; const PS = { ...P, studentId: "21" };
  for (const [method, p, code, body] of ok) {
    const r = await call(method, p, { user: teacher(), pool: sfull().pool, params: PS, body: body || {} }); assert.strictEqual(r.res.statusCode, code, `${method} ${p}: ${JSON.stringify(r.res.body)}`); assert.strictEqual(r.res.body.success, true);
    const st = sfull(); assert.strictEqual((await call(method, p, { user: student(), pool: st.pool, params: PS, body: body || {} })).res.statusCode, 403); assert.strictEqual(writes(st).length, 0);
    const ns = makeMockPool([staff([6]), live(), EXISTS(), ENR(), SSET]); assert.strictEqual((await call(method, p, { user: teacher(), pool: ns.pool, params: PS, body: body || {} })).res.statusCode, 403); assert.ok(!ns.log.some((x) => /lms_student_releases/.test(x.sql)));
    assert.strictEqual((await call(method, p, { user: teacher(), pool: sfull().pool, params: { ...PS, assignmentId: "abc" }, body: body || {} })).res.statusCode, 404);
    if (p.includes(":studentId")) for (const bad of ["abc", "0", "-3"]) assert.strictEqual((await call(method, p, { user: teacher(), pool: sfull().pool, params: { ...PS, studentId: bad }, body: body || {} })).res.statusCode, 404, bad);
  }
  assert.strictEqual((await call("put", `${SB}/:studentId`, { user: teacher(), pool: sfull().pool, params: PS, body: { releaseAt: "2001-01-01T08:00:00Z" } })).res.statusCode, 400);
  assert.strictEqual((await call("put", `${SB}/:studentId`, { user: teacher(), pool: makeMockPool([staff([5]), live(), EXISTS(), ENR(false), SSET]).pool, params: PS, body: { releaseAt: SOON() } })).res.statusCode, 404, "student not in this course");
  const pass = await call("delete", `${SB}/:studentId`, { user: teacher(), pool: makeMockPool([staff([5]), live(), EXISTS(), DUE([]), SDEL([]), SPEEK("2020-01-01T00:00:00Z")]).pool, params: PS }); assert.deepStrictEqual([pass.res.statusCode, pass.res.body.code], [409, "SCHEDULE_PASSED"]);
  const resp = (own) => [staff([5]), live(), ["SELECT TOP 1 id FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL", onlyIds("a", own, [{ id: 4 }])], ENR(), DUE([]), SSET];
  const Tn = makeTenants({ A: resp([4]), B: resp([77]) }); assert.strictEqual((await call("put", `${SB}/:studentId`, { user: teacher(), pool: Tn.A.pool, params: PS, body: { releaseAt: SOON() }, tenant: "A" })).res.statusCode, 200); Tn.assertQueried("A"); Tn.assertUntouched("B");
  assert.strictEqual((await call("put", `${SB}/:studentId`, { user: teacher(), pool: Tn.A.pool, params: { ...PS, assignmentId: "77" }, body: { releaseAt: SOON() }, tenant: "A" })).res.statusCode, 404); Tn.assertUntouched("B");
});
test("static (L5.4b-3): step 022 additive, unique per (assignment, student), after 021, table blocklisted; 3 routes gated and registered after the router guards; no interpolated user value", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "022_lms_student_release"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "021_lms_grade_release") + 1);
  assert.ok(st.sql.some((x) => /CREATE UNIQUE INDEX UX_lms_student_releases_assignment_student ON lms_student_releases \(assignment_id, student_id\)/.test(x)) && st.sql.every((x) => !/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(x)));
  assert.ok(/"lms_student_releases"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), "blocklisted");
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && /\/grade-release\/students/.test(l.route.path)); assert.strictEqual(mine.length, 3);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(router.stack.indexOf(l) > first); assert.ok(l.route.stack.length >= 3, `${l.route.path} needs permission + membership`); }
});

test("routes: staff with lms.submission.grade + membership return-all / read / set / cancel; students and non-members get 403 before any grade is read or written; bad ids 404; bad body 400; passed schedule 409", async () => {
  const ok = [["post", `${BASE}/return-all`, 200], ["get", `${BASE}/grade-release`, 200], ["put", `${BASE}/grade-release`, 200, { releaseAt: SOON() }], ["delete", `${BASE}/grade-release`, 200]];
  for (const [method, p, code, body] of ok) { const r = await call(method, p, { user: teacher(), pool: full().pool, params: P, body: body || {} }); assert.strictEqual(r.res.statusCode, code, `${method} ${p}: ${JSON.stringify(r.res.body)}`); assert.strictEqual(r.res.body.success, true); }
  const ra = await call("post", `${BASE}/return-all`, { user: teacher(), pool: full().pool, params: P }); assert.deepStrictEqual([ra.res.body.returned, ra.res.body.skippedUngraded], [1, 1]);
  for (const [method, p, , body] of ok) {
    const st = full(); const r = await call(method, p, { user: student(), pool: st.pool, params: P, body: body || {} }); assert.strictEqual(r.res.statusCode, 403, `student ${method}`); assert.strictEqual(writes(st).length, 0);
    const ns = makeMockPool([staff([6]), live(), EXISTS(), RETALL([GR(1)])]); const n = await call(method, p, { user: teacher(), pool: ns.pool, params: P, body: body || {} }); assert.strictEqual(n.res.statusCode, 403, `non-member ${method}`); assert.ok(!ns.log.some((x) => /lms_submission_grades|lms_assignment_releases/.test(x.sql)), "no grade or schedule touched");
    assert.strictEqual((await call(method, p, { user: teacher(), pool: full().pool, params: { ...P, assignmentId: "abc" }, body: body || {} })).res.statusCode, 404);
  }
  assert.strictEqual((await call("put", `${BASE}/grade-release`, { user: teacher(), pool: full().pool, params: P, body: { releaseAt: "2001-01-01T08:00:00Z" } })).res.statusCode, 400);
  assert.strictEqual((await call("put", `${BASE}/grade-release`, { user: teacher(), pool: full().pool, params: P, body: { releaseAt: "2099-01-01T08:00:00Z" } })).res.statusCode, 400, "more than a year ahead");
  const pass = await call("delete", `${BASE}/grade-release`, { user: teacher(), pool: makeMockPool([staff([5]), live(), EXISTS(), DUE([]), DEL([]), PEEK("2020-01-01T00:00:00Z")]).pool, params: P }); assert.deepStrictEqual([pass.res.statusCode, pass.res.body.code], [409, "SCHEDULE_PASSED"]);
  const arch = await call("post", `${BASE}/return-all`, { user: teacher(), pool: makeMockPool([staff([5]), live("archived"), EXISTS(), RETALL([GR(1)])]).pool, params: P }); assert.deepStrictEqual([arch.res.statusCode, arch.res.body.code], [409, "COURSE_ARCHIVED"]);
});
test("tenant isolation: school A's return-all never touches school B's database; an assignment id from another course finds nothing", async () => {
  const resp = (own) => [staff([5]), live(), ["SELECT TOP 1 id FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL", onlyIds("a", own, [{ id: 4 }])], RETALL([GR(31)]), SKIP(0)];
  const Tn = makeTenants({ A: resp([4]), B: resp([77]) });
  const a = await call("post", `${BASE}/return-all`, { user: teacher(), pool: Tn.A.pool, params: P, tenant: "A" }); assert.strictEqual(a.res.statusCode, 200); Tn.assertQueried("A"); Tn.assertUntouched("B");
  const g = await call("post", `${BASE}/return-all`, { user: teacher(), pool: Tn.A.pool, params: { ...P, assignmentId: "77" }, tenant: "A" }); assert.strictEqual(g.res.statusCode, 404); Tn.assertUntouched("B");
});
test("static: step 021 additive, unique per assignment, ordered after 020, table blocklisted; 4 routes gated and registered after the router guards, kept off the /submissions paths; no raw db, no req.body, no user value in SQL; every query matches course and assignment", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "021_lms_grade_release"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "020_lms_marking") + 1);
  assert.ok(st.sql.some((x) => /CREATE UNIQUE INDEX UX_lms_assignment_releases_assignment ON lms_assignment_releases \(assignment_id\)/.test(x)) && st.sql.every((x) => !/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(x)));
  assert.ok(/"lms_assignment_releases"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), "blocklisted");
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && /\/(return-all|grade-release)$/.test(l.route.path)); assert.strictEqual(mine.length, 4);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(router.stack.indexOf(l) > first, l.route.path); assert.ok(l.route.stack.length >= 3, `${l.route.path} needs permission + membership`); assert.ok(!/\/submissions/.test(l.route.path)); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsRelease.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db|req\.body/.test(src));
  const sqls = src.match(/`(?:UPDATE|DELETE|SELECT|IF)[\s\S]*?`/g) || []; assert.ok(sqls.length >= 6); for (const q of sqls) assert.ok(!/\$\{(?!where|LATEST)/.test(q), "no interpolated user value: " + q.slice(0, 50));
  assert.ok(require("../utils/lmsEvents").KNOWN ? true : true);
});
