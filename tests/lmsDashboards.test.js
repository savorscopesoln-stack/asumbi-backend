/* L9.2a - HOD / admin dashboards (D-106): course quality review + staff activity. Read only, tenant-wide, paginated, nothing ranked, learners never named.
   Mocked pool only: the SQL (correlated COUNT subqueries, OFFSET/FETCH, CTE) is NOT verified on a real SQL Server; the tests pin the guards in the query TEXT. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsDashboards.test.js");
const D = require("../utils/lmsDashboards"), P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const NOW = new Date("2026-11-02T12:00:00Z");
const row = (o = {}) => ({ status: "published", staff: 1, learners: 30, lessons: 10, lessonsTagged: 4, assignments: 2, quizzes: 1, submittedAt: null, ...o });
const keysOf = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };
const types = (r, ctx = { tenantUsesOutcomes: true, now: NOW }) => D.courseFlags(r, ctx).map((f) => f.type);

test("normPage: page >= 1, pageSize 1-50 else default 25; junk falls back", () => {
  assert.deepStrictEqual([D.normPage({}), D.normPage({ page: "3", pageSize: "50" }), D.normPage({ page: 0, pageSize: 51 }), D.normPage({ page: -2, pageSize: 0 }), D.normPage({ page: "x", pageSize: 1.5 }), D.normPage({ page: 2, pageSize: 1 })],
    [{ page: 1, pageSize: 25 }, { page: 3, pageSize: 50 }, { page: 1, pageSize: 25 }, { page: 1, pageSize: 25 }, { page: 1, pageSize: 25 }, { page: 2, pageSize: 1 }]);
});

test("courseFlags (pure): each flag only in the states where it makes sense; each carries reason + numbers; archived none; draft only no_staff", () => {
  assert.deepStrictEqual(types(row()), [], "a healthy published course has no flag");
  assert.deepStrictEqual(types(row({ lessons: 0 })), ["no_published_lessons", "no_outcome_tags"].filter((t) => t === "no_published_lessons"), "no lessons: the tag flag needs lessons");
  assert.deepStrictEqual(types(row({ assignments: 0, quizzes: 0 })), ["no_assessment"]); assert.deepStrictEqual(types(row({ assignments: 0 })), [], "a quiz alone is an assessment");
  assert.deepStrictEqual(types(row({ learners: 0 })), ["no_learners"]); assert.deepStrictEqual(types(row({ staff: 0 })), ["no_staff"]);
  assert.deepStrictEqual(types(row({ lessonsTagged: 0 })), ["no_outcome_tags"]); assert.deepStrictEqual(types(row({ lessonsTagged: 0 }), { tenantUsesOutcomes: false, now: NOW }), [], "tags only matter where the tenant uses them");
  assert.deepStrictEqual(types(row({ status: "draft", staff: 0, lessons: 0, learners: 0, assignments: 0, quizzes: 0 })), ["no_staff"]);
  assert.deepStrictEqual(types(row({ status: "archived", staff: 0, lessons: 0, learners: 0, assignments: 0, quizzes: 0 })), []);
  const p = D.courseFlags(row({ status: "pending", staff: 0, submittedAt: "2026-10-30T11:00:00Z" }), { tenantUsesOutcomes: true, now: NOW });
  assert.deepStrictEqual(p.map((f) => f.type), ["awaiting_approval", "no_staff"]); assert.deepStrictEqual(p[0].data, { submittedAt: "2026-10-30T11:00:00.000Z", waitingDays: 3 }); assert.ok(/3 days/.test(p[0].reason));
  assert.strictEqual(D.courseFlags(row({ status: "pending", submittedAt: null }), { tenantUsesOutcomes: false, now: NOW })[0].data.waitingDays, null, "no recorded submission time = no invented number");
  assert.deepStrictEqual(types(row({ lessons: "x", learners: -4, staff: null, assignments: undefined, quizzes: NaN })), ["no_staff", "no_published_lessons", "no_assessment", "no_learners"], "garbage counts read as 0");
  const all = D.courseFlags(row({ lessons: 0, assignments: 0, quizzes: 0, learners: 0, staff: 0 }), { tenantUsesOutcomes: true, now: NOW }); assert.ok(all.every((f) => f.type && f.reason && f.data && typeof f.data === "object"));
});

/* ------------------------------ over the (mocked) database ------------------------------ */
const CR = (o = {}) => ({ id: 1, code: "BIO1", title: "Biology", academic_year: 2026, programme: "Science", status: "published", learners: 30, staff: 1, lessons: 10, lessons_tagged: 4, assignments: 2, quizzes: 1, submitted_at: null, total_count: 3, ...o });
function courseWorld(o = {}) {
  const rows = o.rows || [CR(), CR({ id: 2, code: "BIO2", status: "published", lessons: 0, lessons_tagged: 0, total_count: 3 }), CR({ id: 3, code: "CHE1", status: "pending", staff: 0, submitted_at: "2026-10-30T11:00:00Z", total_count: 3 })];
  return makeMockPool([
    ["FROM lms_courses c WHERE c.deleted_at IS NULL AND (@y IS NULL", () => rows],
    ["SELECT status, COUNT(*) AS n FROM lms_courses WHERE deleted_at IS NULL GROUP BY status", () => o.groups || [{ status: "published", n: 7 }, { status: "draft", n: 2 }, { status: "pending", n: 1 }, { status: "archived", n: 4 }, { status: "weird", n: 99 }]],
    ["SELECT TOP 1 1 AS x FROM lms_outcome_tags", () => (o.noTags ? [] : [{ x: 1 }])],
  ]);
}
test("courseQualityReport: shape, counts, flags per course, summary over ALL live courses (not the page), no ranking, no learner names", async () => {
  const m = courseWorld(); const r = await D.courseQualityReport(m.pool, admin, {}, { now: NOW }); assert.ok(r.ok);
  assert.deepStrictEqual([r.page, r.pageSize, r.total], [1, 25, 3]); assert.deepStrictEqual(r.courses.map((c) => [c.code, c.flags.map((f) => f.type)]), [["BIO1", []], ["BIO2", ["no_published_lessons"]], ["CHE1", ["awaiting_approval", "no_staff"]]]);
  assert.deepStrictEqual(r.courses[0].counts, { learners: 30, staff: 1, lessonsPublished: 10, lessonsTagged: 4, assignmentsPublished: 2, quizzesPublished: 1 });
  assert.deepStrictEqual(r.summary, { courses: 14, byStatus: { draft: 2, pending: 1, published: 7, archived: 4 }, tenantUsesOutcomeTags: true, flaggedOnThisPage: 2 }, "an unknown status is ignored, the total is of ALL courses");
  assert.deepStrictEqual(r.courses[2].flags[0].data, { submittedAt: "2026-10-30T11:00:00.000Z", waitingDays: 3 });
  const ks = [...keysOf(r)].join(" "); for (const bad of ["rank", "risk", "score", "verdict", "admission", "student", "grade"]) assert.ok(!new RegExp(bad, "i").test(ks), `no field called like ${bad}: ${ks}`);
  const nt = await D.courseQualityReport(courseWorld({ noTags: true, rows: [CR({ lessons_tagged: 0 })] }).pool, admin, {}, { now: NOW }); assert.deepStrictEqual([nt.courses[0].flags.length, nt.summary.tenantUsesOutcomeTags], [0, false]);
  const empty = await D.courseQualityReport(courseWorld({ rows: [] }).pool, admin, { page: 9 }, { now: NOW }); assert.deepStrictEqual([empty.ok, empty.total, empty.courses.length, empty.page], [true, 0, 0, 9]);
});

test("courseQualityReport: query text keeps the guards (live courses, active enrolments/staff, published things only, stable non-flag order, OFFSET paging, filters are parameters)", async () => {
  const m = courseWorld(); await D.courseQualityReport(m.pool, admin, { page: "2", pageSize: "10", academicYear: "2026", status: "published", programme: "Science'; DROP TABLE x;--" }, { now: NOW });
  const q = m.log.find((x) => /FROM lms_courses c WHERE/.test(x.sql)); const t = q.sql;
  assert.ok(/c\.deleted_at IS NULL/.test(t) && /e\.status = 'active'/.test(t) && /s\.is_active = 1/.test(t) && /a\.status = 'published' AND a\.deleted_at IS NULL/.test(t) && /z\.status = 'published' AND z\.deleted_at IS NULL/.test(t) && /status = 'published' AND \(publish_at IS NULL OR publish_at <= SYSUTCDATETIME\(\)\)/.test(t) && /t\.entity_type = 'lesson'/.test(t) && /ap\.action = 'submitted' ORDER BY ap\.id DESC/.test(t));
  assert.ok(/ORDER BY c\.academic_year DESC, c\.code, c\.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY/.test(t), "order never depends on flags or counts");
  assert.deepStrictEqual([q.inputs.y, q.inputs.st, q.inputs.pr, q.inputs.off, q.inputs.n], [2026, "published", "Science'; DROP TABLE x;--", 10, 10]); assert.ok(!/DROP TABLE|Science/.test(t), "filters are parameters");
  assert.ok(!/Students|admission/i.test(t), "no learner table is read"); assert.ok(m.log.every((x) => /^\s*(SELECT|WITH)/i.test(x.sql)), "read only");
  const bad = courseWorld(); await D.courseQualityReport(bad.pool, admin, { academicYear: "abc", status: "nope", programme: "  ", pageSize: "500" }, { now: NOW }); const b = bad.log[0].inputs; assert.deepStrictEqual([b.y, b.st, b.pr, b.n], [null, null, null, 25], "bad filters = no filter; pageSize over 50 = 25");
  const sum = m.log.find((x) => /GROUP BY status/.test(x.sql)); assert.ok(/^SELECT status, COUNT\(\*\) AS n FROM lms_courses WHERE deleted_at IS NULL GROUP BY status$/.test(sum.sql), "the summary counts every live course: no filter, no paging");
});

/* ------------------------------ staff activity ------------------------------ */
const SR = (o = {}) => ({ user_source: "Teachers", user_id: 7, name: "Mwangi", courses: 3, lessons_published: 5, assignments_graded: 40, announcements_posted: 2, total_count: 2, ...o });
const staffWorld = (rows = [SR(), SR({ user_id: 8, name: "Njeri", courses: 1, lessons_published: 0, assignments_graded: 0, announcements_posted: 0 })]) => makeMockPool([["WITH staff AS", () => rows]]);
test("staffActivityReport: counts only, name order from SQL, window from `days`, paginated; no score or rank; nothing identifying beyond the name", async () => {
  const m = staffWorld(); const r = await D.staffActivityReport(m.pool, admin, { days: "7", page: "2", pageSize: "20" }, { now: NOW }); assert.ok(r.ok);
  assert.deepStrictEqual([r.days, r.page, r.pageSize, r.total, r.since], [7, 2, 20, 2, "2026-10-26T12:00:00.000Z"]);
  assert.deepStrictEqual(r.staff, [{ name: "Mwangi", courses: 3, lessonsPublished: 5, assignmentsGraded: 40, announcementsPosted: 2 }, { name: "Njeri", courses: 1, lessonsPublished: 0, assignmentsGraded: 0, announcementsPosted: 0 }]);
  const ks = [...keysOf(r)].join(" "); for (const bad of ["rank", "score", "risk", "userId", "user_id", "source", "id\\b"]) assert.ok(!new RegExp(bad, "i").test(ks), `no field called like ${bad}: ${ks}`);
  const q = m.log[0]; assert.deepStrictEqual([q.inputs.off, q.inputs.n, q.inputs.since.toISOString()], [20, 20, "2026-10-26T12:00:00.000Z"]);
  const t = q.sql; assert.ok(/s\.is_active = 1/.test(t) && /c\.deleted_at IS NULL/.test(t) && /c2\.status <> 'archived'/.test(t) && /l\.published_at >= @since AND l\.created_by_source = st\.user_source AND l\.created_by = st\.user_id/.test(t) && /g\.graded_at >= @since AND g\.graded_by_source = st\.user_source AND g\.graded_by = st\.user_id/.test(t) && /a\.published_at >= @since AND a\.created_by_source = st\.user_source AND a\.created_by = st\.user_id/.test(t));
  assert.ok(/ORDER BY COALESCE\(t\.name, u\.name\), st\.user_id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY/.test(t) && !/ORDER BY[^)]*(lessons_published|assignments_graded|announcements_posted|courses)/.test(t), "ordered by name, never by activity");
  const d = staffWorld(); const dd = await D.staffActivityReport(d.pool, admin, { days: "999" }, { now: NOW }); assert.strictEqual(dd.days, 30, "days outside 1-90 = 30");
  const e = await D.staffActivityReport(staffWorld([]).pool, admin, {}, { now: NOW }); assert.deepStrictEqual([e.ok, e.total, e.staff.length], [true, 0, 0]);
  assert.ok(m.log.every((x) => /^\s*(SELECT|WITH)/i.test(x.sql)), "read only");
});

/* ------------------------------ guards, isolation, routes ------------------------------ */
test("students and anonymous callers are 'not found' before any query; tenant A's report never touches tenant B", async () => {
  for (const u of [student, null, { id: "x" }]) for (const fn of [D.courseQualityReport, D.staffActivityReport]) { const m = courseWorld(); const r = await fn(m.pool, u, {}, { now: NOW }); assert.strictEqual(r.notFound, true); assert.strictEqual(m.log.length, 0); }
  const T = makeTenants({ A: [["FROM lms_courses c WHERE c.deleted_at IS NULL", () => []]], B: [] });
  const r = await D.courseQualityReport(T.A.pool, admin, {}, { now: NOW }); assert.ok(r.ok); T.assertUntouched("B"); T.assertQueried("A");
  const T2 = makeTenants({ A: [["WITH staff AS", () => []], ["x", () => []]], B: [] }); await D.staffActivityReport(T2.A.pool, admin, {}, { now: NOW }); T2.assertUntouched("B"); T2.assertQueried("A");
});

test("routes: flag lms_analytics, then lms.analytics.department, then the handler (no course membership, tenant-wide); a plain teacher is refused 403 LMS_FORBIDDEN, an administrator passes; GET only; no-store", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const find = (p) => router.stack.filter((l) => l.route && l.route.path === p);
  const mk = () => { const res = makeRes(), h = {}; res.setHeader = (k, v) => { h[k] = v; }; res.h = h; return res; };
  for (const p of ["/analytics/courses", "/analytics/staff"]) {
    const l = find(p); assert.deepStrictEqual(l.map((x) => Object.keys(x.route.methods)), [["get"]], `${p}: one GET and nothing that writes`); assert.strictEqual(l[0].route.stack.length, 3, `${p}: flag + permission + handler`);
    assert.ok(new RegExp(`router\\.get\\("${p}", anGate, deptView, async`).test(src));
    const perm = l[0].route.stack[1].handle; let called = false; const r1 = mk(); await perm({ user: teacher, pool: makeMockPool([]).pool }, r1, () => { called = true; }); assert.deepStrictEqual([called, r1.statusCode, r1.body.code], [false, 403, "LMS_FORBIDDEN"]);
    called = false; const r2 = mk(); await perm({ user: admin, pool: makeMockPool([]).pool }, r2, () => { called = true; }); assert.strictEqual(called, true, "an administrator holds it");
    called = false; const r3 = mk(); await perm({ user: { id: 7, role: "teacher", source: "Teachers" }, pool: makeMockPool([["lms_user_permissions", () => [{ permission: "lms.analytics.department" }]]]).pool }, r3, () => { called = true; }); void r3;
  }
  assert.ok(/const deptView = requireLmsPermission\("lms\.analytics\.department"\)/.test(src) && /const anGate = requireModule\("lms", "lms_analytics"\)/.test(src));
  const r4 = mk(); await find("/analytics/courses")[0].route.stack[2].handle({ pool: courseWorld().pool, user: admin, query: { pageSize: "10" }, tenant: "t" }, r4);
  assert.deepStrictEqual([r4.statusCode, r4.body.success, "ok" in r4.body, r4.body.courses.length, r4.body.pageSize, r4.h["Cache-Control"]], [200, true, false, 3, 10, "no-store"]);
  const r5 = mk(); await find("/analytics/staff")[0].route.stack[2].handle({ pool: staffWorld().pool, user: admin, query: { days: "14" }, tenant: "t" }, r5);
  assert.deepStrictEqual([r5.statusCode, r5.body.days, r5.body.staff.length, r5.h["Cache-Control"]], [200, 14, 2, "no-store"]);
  const r6 = mk(); await find("/analytics/staff")[0].route.stack[2].handle({ pool: staffWorld().pool, user: student, query: {}, tenant: "t" }, r6); assert.strictEqual(r6.statusCode, 404, "a student never reaches a report even if a route gate were missing");
  assert.ok(P.PERMISSIONS.includes("lms.analytics.department") && !P.TEACHER_DEFAULTS.includes("lms.analytics.department"), "a plain teacher does not hold it by default");
});
