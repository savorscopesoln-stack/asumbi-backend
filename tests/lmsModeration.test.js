/* L9.2b - HOD / admin assessment moderation work list + cohort grade summaries (D-107). Read only, tenant-wide, paginated, nothing ranked, learners never named.
   Mocked pool only: the SQL (CTE with ROW_NUMBER, NOT EXISTS, OFFSET/FETCH) is NOT verified on a real SQL Server; the tests pin the guards in the query TEXT.
   NOTE (F-2): never patch a shared module export here; the cohort test injects the distribution builder through the module-local `distribution` option. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsModeration.test.js");
const D = require("../utils/lmsDashboards");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const NOW = new Date("2026-11-02T12:00:00Z");
const keysOf = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };

test("normModDays / daysWaiting / normPage with cohort limits (pure)", () => {
  assert.deepStrictEqual([D.normModDays(), D.normModDays("14"), D.normModDays(0), D.normModDays(91), D.normModDays("x"), D.normModDays(1.5), D.normModDays(90), D.normModDays("")], [7, 14, 7, 7, 7, 7, 90, 7]);
  assert.deepStrictEqual([D.daysWaiting("2026-10-26T12:00:00Z", NOW), D.daysWaiting("2026-10-26T13:00:00Z", NOW), D.daysWaiting("2027-01-01T00:00:00Z", NOW), D.daysWaiting(null, NOW), D.daysWaiting("junk", NOW)], [7, 6, 0, null, null]);
  const n = (q) => D.normPage(q, D.COHORT_MAX_PAGE_SIZE, D.COHORT_DEFAULT_PAGE_SIZE);
  assert.deepStrictEqual([n({}), n({ pageSize: "10" }), n({ pageSize: "11" }), n({ page: "3", pageSize: "2" })], [{ page: 1, pageSize: 5 }, { page: 1, pageSize: 10 }, { page: 1, pageSize: 5 }, { page: 3, pageSize: 2 }]);
  assert.deepStrictEqual([D.normPage({ pageSize: "50" }), D.normPage({})], [{ page: 1, pageSize: 50 }, { page: 1, pageSize: 25 }], "the L9.2a defaults are unchanged");
});

test("cohortSummary (pure): reduced numbers only; refusals and junk become `unavailable` with a code, never a throw", () => {
  const ok = { ok: true, view: "staff", distribution: { learners: 30, graded: 28, notGraded: 2, mean: 61.5, median: 60, min: 10, max: 99, passMark: 50, passed: 20, failed: 8, passRate: 71.43, histogram: [1], bands: [1], unbanded: 0 } };
  assert.deepStrictEqual(D.cohortSummary(ok), { learners: 30, graded: 28, notGraded: 2, mean: 61.5, median: 60, passMark: 50, passRate: 71.43 }, "no histogram, no bands, no min/max");
  assert.deepStrictEqual(D.cohortSummary({ ok: true, distribution: { learners: 0, graded: 0, notGraded: 0, mean: null, median: null, passMark: 50, passRate: null } }), { learners: 0, graded: 0, notGraded: 0, mean: null, median: null, passMark: 50, passRate: null });
  assert.deepStrictEqual([D.cohortSummary({ ok: false, code: "TOO_MANY_LEARNERS" }), D.cohortSummary({ ok: false, code: "EXPORT_TOO_LARGE" }), D.cohortSummary({ ok: false, notFound: true }), D.cohortSummary(null), D.cohortSummary({ ok: true })],
    [{ unavailable: "TOO_MANY_LEARNERS" }, { unavailable: "EXPORT_TOO_LARGE" }, { unavailable: "NOT_FOUND" }, { unavailable: "UNAVAILABLE" }, { unavailable: "UNAVAILABLE" }]);
});

/* ------------------------------ moderation ------------------------------ */
const AW = (o = {}) => ({ id: 11, title: "Lab report", due_at: "2026-10-20T10:00:00Z", course_id: 1, code: "BIO1", course_title: "Biology", awaiting: 12, oldest: "2026-10-23T12:00:00Z", total_count: 2, ...o });
const NR = (o = {}) => ({ id: 12, title: "Essay", due_at: null, course_id: 1, code: "BIO1", course_title: "Biology", submitted_learners: 4, total_count: 2, ...o });
const modWorld = (o = {}) => makeMockPool([["WITH latest AS", () => o.awaiting || [AW(), AW({ id: 13, title: "Quiz write-up", awaiting: 1, oldest: "2026-10-30T12:00:00Z", course_id: 2, code: "CHE1", course_title: "Chemistry" })]],
  ["NOT EXISTS (SELECT 1 FROM lms_assignment_rubrics", () => o.norubric || [NR(), NR({ id: 14, title: "Project", due_at: "2026-12-01T09:00:00Z", submitted_learners: 0, course_id: 2, code: "CHE1", course_title: "Chemistry" })]]]);

test("moderationReport awaiting: per-assignment counts + oldest + days waiting, default 7 days, no learner data, nothing ranked", async () => {
  const m = modWorld(); const r = await D.moderationReport(m.pool, admin, {}, { now: NOW }); assert.ok(r.ok);
  assert.deepStrictEqual([r.view, r.days, r.page, r.pageSize, r.total], ["awaiting", 7, 1, 25, 2]);
  assert.deepStrictEqual(r.items[0], { assignmentId: 11, title: "Lab report", dueAt: "2026-10-20T10:00:00.000Z", course: { id: 1, code: "BIO1", title: "Biology" }, awaitingMarking: 12, oldestSubmittedAt: "2026-10-23T12:00:00.000Z", daysWaiting: 10 });
  assert.deepStrictEqual(r.items.map((i) => i.assignmentId), [11, 13], "order as the SQL returned it (course code, due date), not by waiting time or count");
  const ks = [...keysOf(r)].join(" "); for (const bad of ["rank", "risk", "score", "verdict", "admission", "student", "learnerId", "grade"]) assert.ok(!new RegExp(bad, "i").test(ks), `no field called like ${bad}: ${ks}`);
  const q = m.log[0]; assert.strictEqual(q.inputs.cut.toISOString(), "2026-10-26T12:00:00.000Z", "cutoff = now - 7 days"); assert.deepStrictEqual([q.inputs.off, q.inputs.n], [0, 25]);
  const p = await D.moderationReport(modWorld().pool, admin, { days: "30", page: "3", pageSize: "10", view: "awaiting" }, { now: NOW }); assert.deepStrictEqual([p.days, p.page, p.pageSize], [30, 3, 10]);
  const e = await D.moderationReport(modWorld({ awaiting: [] }).pool, admin, { page: 4 }, { now: NOW }); assert.deepStrictEqual([e.ok, e.total, e.items.length, e.page], [true, 0, 0, 4]);
  const g = await D.moderationReport(modWorld({ awaiting: [AW({ awaiting: -3, oldest: null, due_at: null })] }).pool, admin, {}, { now: NOW }); assert.deepStrictEqual([g.items[0].awaitingMarking, g.items[0].oldestSubmittedAt, g.items[0].daysWaiting, g.items[0].dueAt], [0, null, null, null], "garbage reads as 0 / null, nothing invented");
});

test("moderationReport awaiting: the SQL keeps its guards (latest SUBMITTED attempt, ACTIVE learners, no grade row, older than the cutoff, published things only, name-free, OFFSET paging, read only)", async () => {
  const m = modWorld(); await D.moderationReport(m.pool, admin, { days: "14", page: "2", pageSize: "10" }, { now: NOW }); const t = m.log[0].sql;
  assert.ok(/e\.status = 'active'/.test(t) && /s\.status = 'submitted'/.test(t) && /PARTITION BY s\.assignment_id, s\.student_id ORDER BY s\.attempt_no DESC, s\.id DESC/.test(t) && /l\.rn = 1/.test(t), "latest submitted attempt of an ACTIVE learner");
  assert.ok(/l\.submitted_at < @cut/.test(t) && /NOT EXISTS \(SELECT 1 FROM lms_submission_grades g WHERE g\.submission_id = l\.submission_id\)/.test(t), "older than the cutoff and no grade row at all");
  assert.ok(/a\.status = 'published' AND a\.deleted_at IS NULL/.test(t) && /c\.deleted_at IS NULL AND c\.status = 'published'/.test(t), "published assignments of published, live courses");
  assert.ok(/ORDER BY c\.code, CASE WHEN a\.due_at IS NULL THEN 1 ELSE 0 END, a\.due_at, a\.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY/.test(t) && !/ORDER BY[^)]*(awaiting|oldest)/.test(t), "a work list by course and due date, never by waiting time");
  assert.ok(!/Students|admissionNo|\bname\b/i.test(t), "no learner table or name is read"); assert.deepStrictEqual([m.log[0].inputs.off, m.log[0].inputs.n, m.log[0].inputs.cut.toISOString()], [10, 10, "2026-10-19T12:00:00.000Z"]);
  assert.ok(m.log.every((x) => /^\s*(SELECT|WITH)/i.test(x.sql)), "read only");
  const bad = modWorld(); await D.moderationReport(bad.pool, admin, { view: "nope; DROP TABLE x", days: "-5", pageSize: "999" }, { now: NOW }); assert.ok(/WITH latest AS/.test(bad.log[0].sql), "an unknown view = awaiting"); assert.deepStrictEqual([bad.log[0].inputs.n, bad.log[0].inputs.cut.toISOString()], [25, "2026-10-26T12:00:00.000Z"]);
});

test("moderationReport no_rubric: published assignments without a rubric, with how much work is in; no days filter; own SQL guards", async () => {
  const m = modWorld(); const r = await D.moderationReport(m.pool, admin, { view: "no_rubric", days: "30" }, { now: NOW }); assert.ok(r.ok);
  assert.deepStrictEqual([r.view, "days" in r, r.total], ["no_rubric", false, 2]);
  assert.deepStrictEqual(r.items[0], { assignmentId: 12, title: "Essay", dueAt: null, course: { id: 1, code: "BIO1", title: "Biology" }, submittedLearners: 4 });
  assert.deepStrictEqual([r.items[1].dueAt, r.items[1].submittedLearners], ["2026-12-01T09:00:00.000Z", 0]);
  const t = m.log[0].sql; assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_assignment_rubrics ar WHERE ar\.assignment_id = a\.id\)/.test(t) && /a\.status = 'published' AND a\.deleted_at IS NULL/.test(t) && /c\.deleted_at IS NULL AND c\.status = 'published'/.test(t));
  assert.ok(/COUNT\(DISTINCT s\.student_id\) FROM lms_submissions s WHERE s\.assignment_id = a\.id AND s\.status = 'submitted'/.test(t), "drafts do not count as work handed in");
  assert.ok(/ORDER BY c\.code, CASE WHEN a\.due_at IS NULL THEN 1 ELSE 0 END, a\.due_at, a\.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY/.test(t) && !/ORDER BY[^)]*submitted_learners/.test(t));
  assert.ok(!/Students|admissionNo/i.test(t) && m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "no learner table, read only"); assert.strictEqual(m.log.length, 1, "one query per page");
});

/* ------------------------------ cohorts ------------------------------ */
const CC = (o = {}) => ({ id: 1, code: "BIO1", title: "Biology", academic_year: 2026, programme: "Science", status: "published", total_count: 3, ...o });
const dist = (o = {}) => ({ ok: true, view: "staff", distribution: { learners: 30, graded: 28, notGraded: 2, mean: 61.5, median: 60, min: 5, max: 98, passMark: 50, passed: 20, failed: 8, passRate: 71.43, histogram: [], bands: [], unbanded: 0, ...o } });
const cohortWorld = (rows = [CC(), CC({ id: 2, code: "BIO2", status: "archived" }), CC({ id: 3, code: "CHE1", programme: null })]) => makeMockPool([["FROM lms_courses c WHERE c.deleted_at IS NULL AND c.status IN", () => rows]]);

test("cohortReport: one summary per course via the injected distribution builder; refused or failing courses are listed with a code, never skipped; nobody named", async () => {
  const m = cohortWorld(), seen = [];
  const fake = async (pool, user, id) => { seen.push([pool === m.pool, user === admin, id]); if (id === 2) return { ok: false, code: "TOO_MANY_LEARNERS", errors: ["x"] }; if (id === 3) throw new Error("boom: secret detail"); return dist(); };
  const r = await D.cohortReport(m.pool, admin, {}, { now: NOW, distribution: fake }); assert.ok(r.ok);
  assert.deepStrictEqual(seen, [[true, true, 1], [true, true, 2], [true, true, 3]], "called once per listed course, with the caller's own pool and user");
  assert.deepStrictEqual([r.page, r.pageSize, r.total], [1, 5, 3]);
  assert.deepStrictEqual(r.courses[0], { id: 1, code: "BIO1", title: "Biology", academicYear: 2026, programme: "Science", status: "published", learners: 30, graded: 28, notGraded: 2, mean: 61.5, median: 60, passMark: 50, passRate: 71.43 });
  assert.deepStrictEqual(r.courses[1], { id: 2, code: "BIO2", title: "Biology", academicYear: 2026, programme: "Science", status: "archived", unavailable: "TOO_MANY_LEARNERS" });
  assert.deepStrictEqual([r.courses[2].unavailable, r.courses[2].programme], ["UNAVAILABLE", null]); assert.ok(!JSON.stringify(r).includes("secret detail"), "an error message never leaks");
  const ks = [...keysOf(r)].join(" "); for (const bad of ["rank", "risk", "verdict", "admission", "studentId", "learnerId", "histogram", "bands", "\\bmin\\b", "\\bmax\\b"]) assert.ok(!new RegExp(bad, "i").test(ks), `no field called like ${bad}: ${ks}`);
});

test("cohortReport: course list SQL = live published/archived courses, filters are parameters, year desc then code (never by results), page <= 10 (default 5), no learner table", async () => {
  const m = cohortWorld(); await D.cohortReport(m.pool, admin, { page: "2", pageSize: "10", academicYear: "2026", programme: "Science'; DROP TABLE x;--" }, { now: NOW, distribution: async () => dist() });
  const q = m.log[0], t = q.sql;
  assert.ok(/c\.deleted_at IS NULL AND c\.status IN \('published', 'archived'\)/.test(t) && /ORDER BY c\.academic_year DESC, c\.code, c\.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY/.test(t) && !/Students|admission/i.test(t));
  assert.deepStrictEqual([q.inputs.y, q.inputs.pr, q.inputs.off, q.inputs.n], [2026, "Science'; DROP TABLE x;--", 10, 10]); assert.ok(!/DROP TABLE|Science/.test(t), "filters are parameters");
  const b = cohortWorld(); await D.cohortReport(b.pool, admin, { academicYear: "abc", programme: "  ", pageSize: "11" }, { now: NOW, distribution: async () => dist() }); assert.deepStrictEqual([b.log[0].inputs.y, b.log[0].inputs.pr, b.log[0].inputs.n], [null, null, 5]);
  const e = await D.cohortReport(cohortWorld([]).pool, admin, { page: 7 }, { now: NOW, distribution: async () => { throw new Error("never"); } }); assert.deepStrictEqual([e.ok, e.total, e.courses.length, e.page], [true, 0, 0, 7]);
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
});

test("cohortReport with the REAL distributionReport over a mocked pool: a real answer is reduced, a missing course is `unavailable`", async () => {
  const m = makeMockPool([["FROM lms_courses c WHERE c.deleted_at IS NULL AND c.status IN", () => [CC({ id: 5, total_count: 1 })]], ["SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL", () => []]]);
  const r = await D.cohortReport(m.pool, admin, {}, { now: NOW }); assert.ok(r.ok); assert.deepStrictEqual([r.courses[0].id, r.courses[0].unavailable], [5, "NOT_FOUND"]);
});

/* ------------------------------ guards, isolation, routes ------------------------------ */
test("students and anonymous callers are 'not found' before any query; tenant A's lists never touch tenant B", async () => {
  for (const u of [student, null, { id: "x" }]) for (const fn of [D.moderationReport, D.cohortReport]) { const m = modWorld(); const r = await fn(m.pool, u, {}, { now: NOW }); assert.strictEqual(r.notFound, true); assert.strictEqual(m.log.length, 0); }
  const T = makeTenants({ A: [["WITH latest AS", () => []], ["NOT EXISTS (SELECT 1 FROM lms_assignment_rubrics", () => []], ["FROM lms_courses c WHERE c.deleted_at IS NULL AND c.status IN", () => []]], B: [] });
  for (const q of [{}, { view: "no_rubric" }]) assert.ok((await D.moderationReport(T.A.pool, admin, q, { now: NOW })).ok);
  assert.ok((await D.cohortReport(T.A.pool, admin, {}, { now: NOW })).ok); T.assertUntouched("B"); T.assertQueried("A");
});

test("routes: flag lms_analytics, then lms.analytics.department, then the handler; a plain teacher is 403 LMS_FORBIDDEN; GET only; no-store; `ok` stripped", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const find = (p) => router.stack.filter((l) => l.route && l.route.path === p);
  const mk = () => { const res = makeRes(), h = {}; res.setHeader = (k, v) => { h[k] = v; }; res.h = h; return res; };
  for (const p of ["/analytics/moderation", "/analytics/cohorts"]) {
    const l = find(p); assert.deepStrictEqual(l.map((x) => Object.keys(x.route.methods)), [["get"]], `${p}: one GET and nothing that writes`); assert.strictEqual(l[0].route.stack.length, 3, `${p}: flag + permission + handler`);
    assert.ok(new RegExp(`router\\.get\\("${p}", anGate, deptView, async`).test(src));
    const perm = l[0].route.stack[1].handle; let called = false; const r1 = mk(); await perm({ user: teacher, pool: makeMockPool([]).pool }, r1, () => { called = true; }); assert.deepStrictEqual([called, r1.statusCode, r1.body.code], [false, 403, "LMS_FORBIDDEN"]);
    called = false; const r2 = mk(); await perm({ user: admin, pool: makeMockPool([]).pool }, r2, () => { called = true; }); assert.strictEqual(called, true, "an administrator holds it");
  }
  const r3 = mk(); await find("/analytics/moderation")[0].route.stack[2].handle({ pool: modWorld().pool, user: admin, query: { view: "no_rubric", pageSize: "10" }, tenant: "t" }, r3);
  assert.deepStrictEqual([r3.statusCode, r3.body.success, "ok" in r3.body, r3.body.view, r3.body.items.length, r3.body.pageSize, r3.h["Cache-Control"]], [200, true, false, "no_rubric", 2, 10, "no-store"]);
  const r4 = mk(); await find("/analytics/cohorts")[0].route.stack[2].handle({ pool: makeMockPool([["FROM lms_courses c WHERE c.deleted_at IS NULL AND c.status IN", () => []]]).pool, user: admin, query: {}, tenant: "t" }, r4);
  assert.deepStrictEqual([r4.statusCode, r4.body.success, "ok" in r4.body, r4.body.courses.length, r4.body.pageSize, r4.h["Cache-Control"]], [200, true, false, 0, 5, "no-store"]);
  const r5 = mk(); await find("/analytics/cohorts")[0].route.stack[2].handle({ pool: cohortWorld().pool, user: student, query: {}, tenant: "t" }, r5); assert.strictEqual(r5.statusCode, 404, "a student never reaches a report even if a route gate were missing");
});
