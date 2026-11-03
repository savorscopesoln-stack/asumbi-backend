/* L7.6b - staff reports part 2 (D-094): submission status per assignment, teacher activity (counts), progress CSV. Read only (the CSV writes one audit row), bounded,
   tenant scoped, route gates. Mocked pool only: the SQL (CTE + ROW_NUMBER, correlated COUNT subqueries, OPENJSON-free joins) is NOT verified on a real SQL Server;
   the tests pin the guards in the query TEXT (course scope, active enrolment, submitted-only, latest attempt, deleted/published filters). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsReports2.test.js");
const R = require("../utils/lmsReports"), P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const LEARNERS = [{ student_id: 21, student_name: "Amina", admission_no: "A1" }, { student_id: 22, student_name: "Brian", admission_no: "A2" }, { student_id: 23, student_name: "Cheche", admission_no: "A3" }, { student_id: 24, student_name: "Dina", admission_no: "A4" }];
const many = (n) => Array.from({ length: n }, (_, i) => ({ student_id: i + 1, student_name: "n", admission_no: "a" }));
const readOnly = (m) => m.log.every((x) => /^\s*(SELECT|WITH)/i.test(x.sql));

/* ------------------------------ submission status ------------------------------ */
test("buildSubmissionStatus (pure): hand-calculated parts, missing only after the due date and not for open extensions, summary", () => {
  const A = [{ id: 1, title: "Essay", dueAt: "d1", pastDue: true }, { id: 2, title: "Lab", dueAt: "d2", pastDue: false }, { id: 3, title: "Open", dueAt: null, pastDue: false }];
  const agg = new Map([[1, { submitted: 2, late: 1, graded: 1, returned: 0 }], [2, { submitted: 4, late: 0, graded: 0, returned: 4 }]]);
  const r = R.buildSubmissionStatus(A, agg, new Map([[1, 1]]), 4);
  assert.deepStrictEqual(r.rows.map((x) => [x.assignmentId, x.submitted, x.late, x.notSubmitted, x.missing, x.awaitingMarking, x.graded, x.returned]),
    [[1, 2, 1, 2, 1, 1, 1, 0], [2, 4, 0, 0, 0, 0, 0, 4], [3, 0, 0, 4, 0, 0, 0, 0]]);
  assert.deepStrictEqual(r.summary, { assignments: 3, learners: 4, awaitingMarking: 1, missing: 1 });
  assert.deepStrictEqual([r.rows[0].title, r.rows[0].dueAt, r.rows[0].pastDue, r.rows[2].dueAt, r.rows[2].pastDue], ["Essay", "d1", true, null, false]);
  const notDue = R.buildSubmissionStatus([{ id: 9, title: "x", dueAt: "d", pastDue: false }], new Map(), new Map(), 4); assert.strictEqual(notDue.rows[0].missing, 0, "due date not reached = nobody is missing");
  const allExt = R.buildSubmissionStatus([{ id: 9, title: "x", dueAt: "d", pastDue: true }], new Map(), new Map([[9, 4]]), 4); assert.strictEqual(allExt.rows[0].missing, 0, "every absentee has an open extension");
  const noExt = R.buildSubmissionStatus([{ id: 9, title: "x", dueAt: "d", pastDue: true }], new Map(), new Map(), 4); assert.strictEqual(noExt.rows[0].missing, 4);
  assert.deepStrictEqual(R.buildSubmissionStatus([], new Map(), new Map(), 4).summary, { assignments: 0, learners: 4, awaitingMarking: 0, missing: 0 });
});

test("buildSubmissionStatus (pure): stale or impossible counts are clamped so the parts always add up and nothing is negative", () => {
  const A = [{ id: 1, title: "x", dueAt: "d", pastDue: true }];
  const bad = R.buildSubmissionStatus(A, new Map([[1, { submitted: 9, late: 9, graded: 9, returned: 7 }]]), new Map([[1, 50]]), 4).rows[0];
  assert.deepStrictEqual([bad.submitted, bad.late, bad.returned, bad.graded, bad.awaitingMarking, bad.notSubmitted, bad.missing], [4, 4, 4, 0, 0, 0, 0]);
  for (const x of [{ submitted: -3, late: "x", graded: null, returned: undefined }, { submitted: NaN }]) { const r = R.buildSubmissionStatus(A, new Map([[1, x]]), new Map([[1, -2]]), 4).rows[0]; assert.deepStrictEqual([r.submitted, r.late, r.graded, r.returned, r.awaitingMarking, r.missing], [0, 0, 0, 0, 0, 4]); }
  for (const g of [{ submitted: 3, late: 1, graded: 2, returned: 2 }, { submitted: 4, late: 0, graded: 1, returned: 1 }]) { const r = R.buildSubmissionStatus(A, new Map([[1, g]]), new Map(), 4).rows[0]; assert.strictEqual(r.awaitingMarking + r.graded + r.returned, r.submitted); assert.strictEqual(r.submitted + r.notSubmitted, 4); }
});

const ASG = [{ id: 1, title: "Essay", due_at: "2026-10-20T10:00:00Z", past_due: 1 }, { id: 2, title: "Lab", due_at: "2026-11-20T10:00:00Z", past_due: 0 }, { id: 3, title: "Open", due_at: null, past_due: 0 }];
const subWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["FROM lms_course_enrolments e", (i) => (i.c === 5 ? (o.learners || LEARNERS) : [])],
  ["FROM lms_assignments a WHERE a.course_id", () => (o.assignments || ASG)],
  ["WITH latest AS", () => [{ assignment_id: 1, submitted: 2, late: 1, graded: 1, returned: 0 }, { assignment_id: 2, submitted: 4, late: 0, graded: 0, returned: 4 }]],
  ["FROM lms_extensions x", () => [{ assignment_id: 1, n: 1 }]]]);

test("submission report: per assignment counts from the latest submitted attempt, hand-calculated, published assignments of this course only, no learner named, read only", async () => {
  const m = subWorld(); const r = await R.submissionStatusReport(m.pool, teacher, 5); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.assignments.map((x) => [x.title, x.dueAt, x.pastDue, x.learners, x.submitted, x.late, x.notSubmitted, x.missing, x.awaitingMarking, x.graded, x.returned]),
    [["Essay", "2026-10-20T10:00:00.000Z", true, 4, 2, 1, 2, 1, 1, 1, 0], ["Lab", "2026-11-20T10:00:00.000Z", false, 4, 4, 0, 0, 0, 0, 0, 4], ["Open", null, false, 4, 0, 0, 4, 0, 0, 0, 0]]);
  assert.deepStrictEqual(r.summary, { assignments: 3, learners: 4, awaitingMarking: 1, missing: 1 });
  assert.ok(!/Amina|Brian|Cheche|Dina|A[1-4]"|student/i.test(JSON.stringify(r)), "counts only: nobody is named or identified");
  const a = m.log.find((x) => /FROM lms_assignments a/.test(x.sql)); assert.ok(/a\.course_id = @c/.test(a.sql) && /a\.status = 'published'/.test(a.sql) && /a\.deleted_at IS NULL/.test(a.sql) && /TOP 200 /.test(a.sql) && a.inputs.c === 5, "published, live assignments of THIS course, capped");
  assert.ok(/CASE WHEN a\.due_at IS NULL THEN 1 ELSE 0 END, a\.due_at/.test(a.sql), "no due date last"); assert.ok(/a\.due_at < SYSUTCDATETIME\(\)/.test(a.sql), "one clock: the database's");
  const g = m.log.find((x) => /WITH latest AS/.test(x.sql));
  assert.ok(/s\.course_id = @c AND s\.status = 'submitted'/.test(g.sql), "submitted attempts of this course only (a draft is not a submission)"); assert.ok(/e\.status = 'active'/.test(g.sql) && /e\.student_id = s\.student_id/.test(g.sql), "ACTIVE learners only");
  assert.ok(/ROW_NUMBER\(\) OVER \(PARTITION BY s\.assignment_id, s\.student_id ORDER BY s\.attempt_no DESC, s\.id DESC\)/.test(g.sql) && /WHERE l\.rn = 1/.test(g.sql), "latest attempt per learner and assignment");
  assert.ok(/g\.submission_id = l\.submission_id AND g\.course_id = @c/.test(g.sql) && /g\.status = 'draft'/.test(g.sql) && /g\.status = 'returned'/.test(g.sql) && /GROUP BY l\.assignment_id/.test(g.sql) && g.inputs.c === 5);
  const x = m.log.find((y) => /FROM lms_extensions x/.test(y.sql)); assert.ok(/x\.course_id = @c/.test(x.sql) && /x\.due_at > SYSUTCDATETIME\(\)/.test(x.sql) && /NOT EXISTS \(SELECT 1 FROM lms_submissions s WHERE s\.course_id = @c AND s\.assignment_id = x\.assignment_id AND s\.student_id = x\.student_id AND s\.status = 'submitted'\)/.test(x.sql) && /e\.status = 'active'/.test(x.sql) && x.inputs.c === 5, "only OPEN extensions of learners with no submission");
  assert.ok(readOnly(m), "read only");
});

test("submission report: no assignments or no learners = no counting queries; > 2000 learners refused; empty course is fine", async () => {
  const none = subWorld({ assignments: [] }); const a = await R.submissionStatusReport(none.pool, teacher, 5); assert.deepStrictEqual([a.ok, a.assignments.length, a.summary.learners], [true, 0, 4]); assert.ok(!none.log.some((x) => /WITH latest|lms_extensions/.test(x.sql)));
  const noL = subWorld({ learners: [] }); const b = await R.submissionStatusReport(noL.pool, teacher, 5); assert.deepStrictEqual([b.ok, b.assignments.map((x) => x.notSubmitted), b.assignments.map((x) => x.missing)], [true, [0, 0, 0], [0, 0, 0]]); assert.ok(!noL.log.some((x) => /WITH latest|lms_extensions/.test(x.sql)));
  const big = await R.submissionStatusReport(subWorld({ learners: many(2001) }).pool, teacher, 5); assert.deepStrictEqual([big.ok, big.code], [false, "TOO_MANY_LEARNERS"]);
  const edge = await R.submissionStatusReport(subWorld({ learners: many(2000) }).pool, teacher, 5); assert.strictEqual(edge.ok, true, "exactly 2000 is allowed");
});

/* ------------------------------ teacher activity ------------------------------ */
const STAFF = [{ staff_role: "teacher", name: "Mr Otieno", lessons_published: 5, assignments_graded: 31, announcements_posted: 2 }, { staff_role: "co_teacher", name: null, lessons_published: 0, assignments_graded: 0, announcements_posted: 1 }];
const actWorld = (o = {}) => makeMockPool([["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["FROM lms_course_staff s", () => (o.staff || STAFF)]]);
const NOW = new Date("2026-11-01T00:00:00.000Z");

test("normDays (pure): whole days 1..90, anything else = 30", () => {
  for (const [v, want] of [[undefined, 30], [null, 30], ["", 30], [0, 30], [-5, 30], [91, 30], [1.5, 30], ["abc", 30], [NaN, 30], [1, 1], [90, 90], ["7", 7], [30, 30], ["30.5", 30], ["1e1", 10]]) assert.strictEqual(R.normDays(v), want, String(v));
});

test("teacher activity: counts per ACTIVE course staff member, window from the given clock, names and roles only (no ids), read only", async () => {
  const m = actWorld(); const r = await R.teacherActivityReport(m.pool, teacher, 5, { days: "7", now: NOW }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.days, r.since], [7, "2026-10-25T00:00:00.000Z"]);
  assert.deepStrictEqual(r.staff, [{ name: "Mr Otieno", role: "owner", lessonsPublished: 5, assignmentsGraded: 31, announcementsPosted: 2 }, { name: "", role: "co_teacher", lessonsPublished: 0, assignmentsGraded: 0, announcementsPosted: 1 }]);
  assert.ok(!/user_id|source|"id"/i.test(JSON.stringify(r.staff)), "no ids"); assert.ok(typeof r.note === "string" && /author/i.test(r.note));
  const q = m.log.find((x) => /FROM lms_course_staff s/.test(x.sql)); assert.strictEqual(q.inputs.c, 5); assert.ok(q.inputs.since instanceof Date && q.inputs.since.toISOString() === "2026-10-25T00:00:00.000Z");
  assert.ok(/s\.course_id = @c AND s\.is_active = 1/.test(q.sql) && /TOP 50 /.test(q.sql), "active staff of THIS course, capped");
  assert.ok(/FROM lms_lessons l WHERE l\.course_id = @c AND l\.deleted_at IS NULL AND l\.status = 'published' AND l\.published_at >= @since AND l\.created_by_source = s\.user_source AND l\.created_by = s\.user_id/.test(q.sql), "lessons: this course, live, published, in window, authored by the member");
  assert.ok(/FROM lms_submission_grades g WHERE g\.course_id = @c AND g\.graded_at >= @since AND g\.graded_by_source = s\.user_source AND g\.graded_by = s\.user_id/.test(q.sql), "grading: this course, in window, entered by the member (source AND id: ids collide across tables)");
  assert.ok(/FROM lms_announcements a WHERE a\.course_id = @c AND a\.deleted_at IS NULL AND a\.status = 'published' AND a\.published_at >= @since AND a\.created_by_source = s\.user_source AND a\.created_by = s\.user_id/.test(q.sql), "announcements: this course only (not school-wide), live, published, in window, by the member");
  assert.ok(readOnly(m) && !m.log.some((x) => /lms_audit_log/.test(x.sql)), "read only, no audit row");
  const d = await R.teacherActivityReport(actWorld().pool, teacher, 5, { now: NOW }); assert.deepStrictEqual([d.days, d.since], [30, "2026-10-02T00:00:00.000Z"], "default 30 days");
  const bad = await R.teacherActivityReport(actWorld().pool, teacher, 5, { days: "9999", now: NOW }); assert.strictEqual(bad.days, 30, "out of range falls back, never an unbounded window");
  const neg = await R.teacherActivityReport(actWorld({ staff: [{ staff_role: "teacher", name: "x", lessons_published: -1, assignments_graded: "z", announcements_posted: null }] }).pool, teacher, 5, { now: NOW }); assert.deepStrictEqual(neg.staff[0], { name: "x", role: "owner", lessonsPublished: 0, assignmentsGraded: 0, announcementsPosted: 0 });
  assert.deepStrictEqual((await R.teacherActivityReport(actWorld({ staff: [] }).pool, teacher, 5, { now: NOW })).staff, []);
});

/* ------------------------------ progress CSV ------------------------------ */
const progressWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["FROM lms_course_enrolments e", (i) => (i.c === 5 ? (o.learners || LEARNERS) : [])],
  ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 4 }]],
  ["FROM lms_lesson_progress p", () => [{ student_id: 21, done: 4, last_at: "2026-11-01T08:00:00Z" }, { student_id: 22, done: 2, last_at: "2026-10-30T08:00:00Z" }, { student_id: 24, done: 1, last_at: "2026-10-01T08:00:00Z" }]]]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));

test("buildProgressCsv (pure): header, hand-checked rows, CRLF, quoting, formula guard on names", () => {
  const rows = [{ admissionNo: "A1", name: "Amina", completed: 4, total: 4, percent: 100, lastActivityAt: "2026-11-01T08:00:00.000Z" }, { admissionNo: "A2", name: "Doe, Jane", completed: 0, total: 4, percent: 0, lastActivityAt: null },
    { admissionNo: "=A3", name: "=HYPERLINK(\"x\")", completed: 1, total: 3, percent: 33, lastActivityAt: null }, { admissionNo: "", name: "@x", completed: 0, total: 0, percent: 0, lastActivityAt: null }];
  const csv = R.buildProgressCsv(rows), lines = csv.split("\r\n");
  assert.strictEqual(lines[0], "Admission no,Name,Lessons completed,Lessons total,Progress %,Last activity"); assert.strictEqual(lines[1], "A1,Amina,4,4,100,2026-11-01T08:00:00.000Z"); assert.strictEqual(lines[2], 'A2,"Doe, Jane",0,4,0,');
  assert.ok(lines[3].startsWith("'=A3,") && lines[3].includes("'=HYPERLINK"), "formula guard"); assert.ok(lines[4].startsWith(",'@x,"), "blank admission number stays blank, @ is guarded");
  assert.ok(csv.endsWith("\r\n") && lines.length === 6 && lines[5] === "", "CRLF, one line per learner plus the header, trailing CRLF");
  assert.strictEqual(R.buildProgressCsv([]), "Admission no,Name,Lessons completed,Lessons total,Progress %,Last activity\r\n");
});

test("progress CSV export: same learners and numbers as the JSON report, one audit row with counts only, nothing else written", async () => {
  const m = progressWorld(); const r = await R.exportProgressCsv(m.pool, teacher, 5); assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.filename, "progress-course-5.csv"); assert.strictEqual(r.learners, 4);
  assert.deepStrictEqual(r.csv.split("\r\n").slice(0, 5), ["Admission no,Name,Lessons completed,Lessons total,Progress %,Last activity", "A1,Amina,4,4,100,2026-11-01T08:00:00.000Z", "A2,Brian,2,4,50,2026-10-30T08:00:00.000Z", "A3,Cheche,0,4,0,", "A4,Dina,1,4,25,2026-10-01T08:00:00.000Z"]);
  const w = m.log.filter((x) => !/^\s*SELECT/i.test(x.sql)); assert.ok(w.every((x) => /lms_audit_log/.test(x.sql)), "read only apart from the audit row");
  const a = audits(m); assert.strictEqual(a.length, 1); const t = JSON.stringify(a[0].inputs); assert.ok(/report\.exported/.test(t) && /progress/.test(t)); assert.ok(!/Amina|Brian|A1|2026-11-01T08/.test(t), "no names, numbers or times in the audit row");
});

test("progress CSV export: refusals write NO audit row (student, other course, > 2000 learners)", async () => {
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"], [teacher, 0]]) { const m = progressWorld(); const r = await R.exportProgressCsv(m.pool, u, id); assert.strictEqual(r.notFound, true, `${JSON.stringify(u)} ${id}`); assert.strictEqual(audits(m).length, 0); }
  const m = progressWorld({ learners: many(2001) }); const r = await R.exportProgressCsv(m.pool, teacher, 5); assert.deepStrictEqual([r.ok, r.code], [false, "TOO_MANY_LEARNERS"]); assert.strictEqual(audits(m).length, 0);
});

/* ------------------------------ isolation + routes ------------------------------ */
test("isolation: students, bad ids, other or missing courses and other tenants are not found; nothing is queried for a student or a bad id", async () => {
  const fns = [R.submissionStatusReport, R.teacherActivityReport];
  for (const fn of fns) {
    for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"], [teacher, 0]]) { const m = subWorld(); assert.strictEqual((await fn(m.pool, u, id)).notFound, true, `${fn.name} ${JSON.stringify(u)} ${id}`); }
    const q = subWorld(); await fn(q.pool, student, 5); await fn(q.pool, teacher, "x"); assert.strictEqual(q.log.length, 0);
    const T = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await fn(T.A.pool, teacher, 5)).notFound, true); T.assertUntouched("B");
  }
  const T2 = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await R.exportProgressCsv(T2.A.pool, teacher, 5)).notFound, true); T2.assertUntouched("B");
});

test("routes: flag gate + gradebook.view + course access + handler; headers; 409/404 shape; days comes from the query string", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), GB = "/courses/:courseId/gradebook";
  const find = (n) => router.stack.find((l) => l.route && l.route.path === `${GB}/reports/${n}` && l.route.methods.get);
  const [csv, sub, act] = ["progress.csv", "submissions", "teacher-activity"].map(find); assert.ok(csv && sub && act); for (const r of [csv, sub, act]) assert.strictEqual(r.route.stack.length, 4);
  for (const n of ["progress\\.csv", "submissions", "teacher-activity"]) assert.ok(new RegExp(`reports/${n}\`, gbGate, gbView, staffAccess`).test(src), n);
  assert.ok(!P.roleDefaults({ role: "student" }).includes("lms.gradebook.view"));
  const mk = () => { const res = makeRes(), h = {}; res.setHeader = (k, v) => { h[k] = v; }; res.h = h; return res; };
  const r1 = mk(); await csv.route.stack[3].handle({ pool: progressWorld().pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r1);
  assert.deepStrictEqual([r1.statusCode, r1.h["Content-Type"], r1.h["X-Content-Type-Options"], r1.h["Cache-Control"], r1.h["Content-Disposition"]], [200, "text/csv; charset=utf-8", "nosniff", "private, no-store", 'attachment; filename="progress-course-5.csv"']);
  assert.ok(typeof r1.body === "string" && r1.body.startsWith("Admission no,Name,"));
  const r2 = mk(); await sub.route.stack[3].handle({ pool: subWorld().pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.success, r2.body.summary.assignments, "ok" in r2.body, r2.h["Cache-Control"]], [200, true, 3, false, "no-store"]);
  const r3 = mk(); await act.route.stack[3].handle({ pool: actWorld().pool, user: teacher, params: { courseId: "5" }, query: { days: "7" }, tenant: "t" }, r3); assert.deepStrictEqual([r3.statusCode, r3.body.days, r3.body.staff.length, r3.h["Cache-Control"]], [200, 7, 2, "no-store"]);
  const r4 = mk(); await act.route.stack[3].handle({ pool: actWorld().pool, user: teacher, params: { courseId: "5" }, query: {}, tenant: "t" }, r4); assert.strictEqual(r4.body.days, 30);
  for (const [h, w] of [[csv, progressWorld], [sub, subWorld]]) { const r = mk(); await h.route.stack[3].handle({ pool: w({ learners: many(2001) }).pool, user: teacher, params: { courseId: "5" }, tenant: "t" }, r); assert.deepStrictEqual([r.statusCode, r.body.code], [409, "TOO_MANY_LEARNERS"]); }
  for (const h of [csv, sub, act]) { const r = mk(); await h.route.stack[3].handle({ pool: subWorld().pool, user: teacher, params: { courseId: "9" }, query: {}, tenant: "t" }, r); assert.strictEqual(r.statusCode, 404); }
});
