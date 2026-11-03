/* L4.1a — student dashboard API. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsDashboard.test.js");
const D = require("../utils/lmsDashboard");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-10-29T08:00:00Z");
const CONT = ["SELECT TOP 3 p.course_id", () => [{ course_id: 5, course_title: "Biology F3", lesson_id: 9, lesson_title: "Cells", last_viewed_at: "2026-10-28T10:00:00Z" }]];
const CARDS = ["SELECT TOP 6 c.id, c.title", () => [{ id: 5, title: "Biology F3", code: "BIO3", total_lessons: 7, completed_lessons: 3 }, { id: 6, title: "Maths", code: null, total_lessons: 0, completed_lessons: 0 }]];
const COUNTS = ["SUM(CASE WHEN e.status = 'active'", () => [{ active_n: 2, pending_n: 1 }]];
const PLAN = ["FROM lms_course_events e", () => Array.from({ length: 7 }, (_, i) => ({ id: i + 1, course_id: 5, course_title: "Biology F3", title: `E${i}`, description: null, event_type: "event", starts_at: new Date(NOW.getTime() + (i + 1) * 36e5), ends_at: null, all_day: 0 }))];
const NEWS = ["FROM lms_announcements a LEFT JOIN lms_courses c", () => [{ id: 3, course_id: null, title: "Holiday", body: "b", status: "published", pinned: 1, published_at: "x", created_at: "x", updated_at: "x", course_title: null, total_count: 9 }]];
const all = () => makeMockPool([CONT, CARDS, COUNTS, PLAN, NEWS]);

test("dashboard: all four sections, progress uses floor(100*done/total) and 0 when a course has no lessons; counts; upcoming capped at 5 with `more`; announcements total", async () => {
  const m = all(); const r = await D.getDashboard(m.pool, student(21), NOW);
  assert.ok(r.ok); assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.continueLearning.map((x) => [x.courseId, x.lessonId, x.lessonTitle]), [[5, 9, "Cells"]]);
  assert.deepStrictEqual(r.courses.map((c) => [c.courseId, c.completedLessons, c.totalLessons, c.percent]), [[5, 3, 7, 42], [6, 0, 0, 0]]);
  assert.deepStrictEqual([r.totalCourses, r.pendingRequests], [2, 1]);
  assert.deepStrictEqual([r.upcoming.length, r.upcomingMore, r.upcoming[0].title], [5, true, "E0"]);
  assert.deepStrictEqual([r.announcements.length, r.announcementsTotal, r.announcements[0].pinned], [1, 9, true]);
});
test("progress is clamped: completed can never exceed total or go over 100%", async () => {
  const m = makeMockPool([CONT, ["SELECT TOP 6 c.id, c.title", () => [{ id: 5, title: "B", code: "x", total_lessons: 3, completed_lessons: 9 }]], COUNTS, PLAN, NEWS]);
  const r = await D.getDashboard(m.pool, student(), NOW); assert.deepStrictEqual([r.courses[0].completedLessons, r.courses[0].percent], [3, 100]);
});
test("every query is scoped to the token's student and enforces enrolment, published course and visible lessons in SQL; ids only as parameters", async () => {
  const m = all(); await D.getDashboard(m.pool, student(21), NOW);
  const own = m.log.filter((x) => /lms_lesson_progress|lms_course_enrolments|lms_course_events|lms_announcements/.test(x.sql)); assert.ok(own.length >= 5);
  for (const q of own) { assert.strictEqual(q.inputs.s, 21, q.sql.slice(0, 60)); assert.ok(!/\b21\b/.test(q.sql.replace(/TOP \d+/g, "")), "no literal id"); assert.ok(!/SELECT \*/.test(q.sql) && !/password/i.test(q.sql)); }
  const c = m.log.find((x) => /FROM lms_lesson_progress p JOIN lms_lessons l/.test(x.sql)).sql;
  assert.ok(/p\.status = 'in_progress'/.test(c) && /en\.status = 'active'/.test(c) && /c\.status = 'published'/.test(c) && /c\.deleted_at IS NULL/.test(c) && /l\.deleted_at IS NULL/.test(c) && /l\.course_id = p\.course_id/.test(c) && /l\.status = 'published'/.test(c) && /TOP 3/.test(c));
  const k = m.log.find((x) => /SELECT TOP 6 c\.id/.test(x.sql)).sql; assert.ok(/en\.student_id = @s AND en\.status = 'active'/.test(k) && /c\.status = 'published'/.test(k) && /p\.status = 'completed'/.test(k) && /p\.student_id = @s/.test(k));
});
test("VISIBLE_L is the same rule as lmsLessons.VISIBLE (drift guard): unreleased or draft lessons never reach the dashboard", () => {
  assert.strictEqual(D.VISIBLE_L, D.VISIBLE.replace(/\b(status|publish_at)\b/g, "l.$1"));
});
test("a failing section is reported and the others still render (graceful failure)", async () => {
  const boom = ["SELECT TOP 3 p.course_id", () => { throw new Error("db secret detail"); }];
  const m = makeMockPool([boom, CARDS, COUNTS, PLAN, NEWS]); const r = await D.getDashboard(m.pool, student(), NOW);
  assert.ok(r.ok && r.errors.continueLearning === "UNAVAILABLE" && Object.keys(r.errors).length === 1); assert.deepStrictEqual(r.continueLearning, []); assert.strictEqual(r.courses.length, 2); assert.ok(!/secret detail/.test(JSON.stringify(r)));
  const bad = makeMockPool([CONT, ["SELECT TOP 6 c.id", () => { throw new Error("x"); }], COUNTS, ["FROM lms_course_events e", () => { throw new Error("y"); }], NEWS]); const r2 = await D.getDashboard(bad.pool, student(), NOW);
  assert.deepStrictEqual(Object.keys(r2.errors).sort(), ["courses", "upcoming"]); assert.strictEqual(r2.announcements.length, 1);
});
test("only students: staff, admins and malformed users are refused before any query", async () => {
  for (const u of [teacher, { id: 1, role: "admin", source: "Users" }, { id: 21, role: "student", source: "Teachers" }, { id: 21, role: "student", source: "Users" }, null, {}]) { const m = all(); const r = await D.getDashboard(m.pool, u, NOW); assert.deepStrictEqual([r.ok, r.forbidden, m.log.length], [false, true, 0]); }
});
test("a new student with nothing gets an empty but valid dashboard", async () => {
  const m = makeMockPool([]); const r = await D.getDashboard(m.pool, student(), NOW);
  assert.deepStrictEqual([r.ok, r.continueLearning, r.courses, r.upcoming, r.announcements, r.totalCourses, r.pendingRequests], [true, [], [], [], [], 0, 0]);
});

async function call(user, pool) {
  const router = require("../routes/lms"); const layer = router.stack.find((l) => l.route && l.route.path === "/me/dashboard" && l.route.methods.get); assert.ok(layer);
  const res = makeRes(), req = { user, pool, params: {}, body: {}, query: {} }, stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); }; next(); for (let n = 0; n < pending.length; n += 1) await pending[n]; return res;
}
test("route: student 200 with success flag and no internal `ok` field; staff 403 and nothing queried; static wiring and source hygiene", async () => {
  const m = all(); const r = await call(student(), m.pool); assert.strictEqual(r.statusCode, 200); assert.ok(r.body.success === true && !("ok" in r.body) && Array.isArray(r.body.courses));
  const t = all(); const f = await call(teacher, t.pool); assert.strictEqual(f.statusCode, 403); assert.strictEqual(t.log.length, 0);
  const l = require("../routes/lms").stack.find((x) => x.route && x.route.path === "/me/dashboard"); assert.ok(l.route.stack.length >= 2);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsDashboard.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db|req\.body/.test(src));
  assert.ok(!require("../utils/lmsSchema").STEPS.some((s) => /dashboard/i.test(s.id)));
});

/* ---------------- L4.1b: pending tasks + recent feedback ---------------- */
const PEND_MATCH = "ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END"; // distinct from the planner's own assignment query
const FB_MATCH = "FROM lms_submission_grades g JOIN lms_submissions sb";
const asg = (id, o = {}) => ({ id, course_id: 5, section_id: null, title: `A${id}`, instructions: "secret instructions", status: "published", published_at: null, available_from: null,
  due_at: o.due === undefined ? new Date(NOW.getTime() + id * 864e5) : o.due, cutoff_at: o.cut || null, submission_type: "both", allowed_extensions: null, max_file_mb: null, max_files: 5,
  max_attempts: 1, late_policy: o.policy || null, late_penalty_percent: null, max_points: 50, work_mode: "individual", attachments_json: null, created_at: "x", updated_at: "x", course_title: "Biology F3" });
const withPend = (rows, extra = []) => makeMockPool([CONT, CARDS, COUNTS, PLAN, NEWS, [PEND_MATCH, () => rows], ...extra]);

test("pending tasks: only what can still be handed in; overdue-but-open is flagged; cutoff-passed and block-policy-late are dropped; undated kept; shape leaks nothing else", async () => {
  const rows = [
    asg(1, { due: new Date(NOW.getTime() - 864e5) }),                                        // overdue, school default 'accept' -> open + overdue
    asg(2, { due: new Date(NOW.getTime() - 864e5), policy: "block" }),                        // overdue + block -> closed
    asg(3, { due: new Date(NOW.getTime() - 2 * 864e5), cut: new Date(NOW.getTime() - 864e5) }), // cutoff passed -> closed
    asg(4, { due: new Date(NOW.getTime() + 864e5) }),                                         // on time
    asg(5, { due: null }),                                                                    // no due date -> always open
  ];
  const r = await D.getDashboard(withPend(rows).pool, student(21), NOW);
  assert.ok(r.ok); assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.pendingTasks.map((x) => [x.assignmentId, x.overdue]), [[1, true], [4, false], [5, false]]);
  assert.deepStrictEqual(Object.keys(r.pendingTasks[0]).sort(), ["assignmentId", "courseId", "courseTitle", "dueAt", "maxPoints", "overdue", "title"]);
  assert.strictEqual(r.pendingTasks[2].dueAt, null); assert.strictEqual(r.pendingTasks[0].maxPoints, 50);
  assert.ok(!/secret instructions/.test(JSON.stringify(r.pendingTasks)));
});
test("pending tasks use the SCHOOL default late policy (setting 'block' closes an overdue assignment that has no own policy)", async () => {
  const rows = [asg(1, { due: new Date(NOW.getTime() - 864e5) }), asg(2)];
  const m = withPend(rows, [["FROM lms_settings", () => [{ setting_key: "lateSubmission", value_json: JSON.stringify("block") }]]]);
  const r = await D.getDashboard(m.pool, student(), NOW); assert.deepStrictEqual(r.pendingTasks.map((x) => x.assignmentId), [2]);
});
test("pending tasks are capped at 5 with `more`; a full candidate page also sets `more`", async () => {
  const r = await D.getDashboard(withPend(Array.from({ length: 7 }, (_, i) => asg(i + 1))).pool, student(), NOW);
  assert.deepStrictEqual([r.pendingTasks.length, r.pendingTasksMore, r.pendingTasks[0].assignmentId], [5, true, 1]);
  const full = await D.getDashboard(withPend(Array.from({ length: 50 }, (_, i) => asg(i + 1, { due: new Date(NOW.getTime() - 864e5), policy: "block" }))).pool, student(), NOW);
  assert.deepStrictEqual([full.pendingTasks.length, full.pendingTasksMore], [0, true]);
  const few = await D.getDashboard(withPend([asg(1)]).pool, student(), NOW); assert.deepStrictEqual([few.pendingTasks.length, few.pendingTasksMore], [1, false]);
});
test("pending-tasks SQL: token student only, published course, active enrolment, published+available assignment, nothing already handed in, bounded; no literal ids", async () => {
  const m = withPend([asg(1)]); await D.getDashboard(m.pool, student(21), NOW);
  const q = m.log.find((x) => x.sql.includes(PEND_MATCH)); assert.ok(q); assert.strictEqual(q.inputs.s, 21);
  assert.ok(/c\.status = 'published'/.test(q.sql) && /c\.deleted_at IS NULL/.test(q.sql) && /en\.student_id = @s AND en\.status = 'active'/.test(q.sql));
  assert.ok(/a\.status = 'published' AND a\.deleted_at IS NULL/.test(q.sql) && /a\.available_from <= SYSUTCDATETIME\(\)/.test(q.sql));
  assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_submissions sb WHERE[^)]*sb\.student_id = @s AND sb\.status = 'submitted'\)/.test(q.sql));
  assert.ok(/TOP 50/.test(q.sql) && /ORDER BY CASE WHEN a\.due_at IS NULL THEN 1 ELSE 0 END, COALESCE\(x\.due_at, a\.due_at\)/.test(q.sql));
  assert.ok(!/\b21\b/.test(q.sql.replace(/TOP \d+/g, "")) && !/SELECT \*/.test(q.sql));
});
test("pending tasks reuse the submission screen's window rule (drift guard: same function object)", () => {
  assert.strictEqual(require("../utils/lmsSubmissions").windowOf, require("../utils/lmsSubmissions").windowOf);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsDashboard.js"), "utf8"); assert.ok(/require\("\.\/lmsSubmissions"\)/.test(src) && /windowOf\(m, settings, now\)\.open/.test(src));
});

const gr = (aid, o = {}) => ({ assignment_id: aid, course_id: 5, course_title: "Biology F3", assignment_title: `A${aid}`, attempt_no: o.attempt || 1, final_points: o.final ?? 40, max_points: 50, returned_at: o.at || "2026-10-28T09:00:00Z", has_comment: o.c ?? 1 });
test("recent feedback: returned grades only, newest first as the SQL orders them, numbers coerced, hasComment boolean, comment text never selected", async () => {
  const m = makeMockPool([CONT, CARDS, COUNTS, PLAN, NEWS, [FB_MATCH, () => [gr(2, { final: "37.50" }), gr(1, { c: 0, attempt: 2 })]]]);
  const r = await D.getDashboard(m.pool, student(21), NOW); assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.recentFeedback.map((x) => [x.assignmentId, x.finalPoints, x.maxPoints, x.hasComment, x.attemptNo]), [[2, 37.5, 50, true, 1], [1, 40, 50, false, 2]]);
  assert.deepStrictEqual(Object.keys(r.recentFeedback[0]).sort(), ["assignmentId", "attemptNo", "courseId", "courseTitle", "finalPoints", "hasComment", "maxPoints", "returnedAt", "title"]);
  const q = m.log.find((x) => x.sql.includes(FB_MATCH)); assert.strictEqual(q.inputs.s, 21);
  assert.ok(/g\.status = 'returned'/.test(q.sql) && /g\.student_id = @s/.test(q.sql) && /sb\.student_id = @s/.test(q.sql) && /sb\.status = 'submitted'/.test(q.sql));
  assert.ok(/c\.status = 'published'/.test(q.sql) && /en\.status = 'active'/.test(q.sql) && /a\.status = 'published' AND a\.deleted_at IS NULL/.test(q.sql));
  assert.ok(/TOP 5/.test(q.sql) && /ORDER BY g\.returned_at DESC, g\.id DESC/.test(q.sql));
  const noExpr = q.sql.replace(/CASE WHEN LEN\(LTRIM\(RTRIM\(COALESCE\(g\.comment, ''\)\)\)\) > 0 THEN 1 ELSE 0 END AS has_comment/, ""); // the only allowed use of the comment column
  assert.ok(!/g\.comment/.test(noExpr) && /AS has_comment/.test(q.sql) && !/\b21\b/.test(q.sql.replace(/TOP \d+/g, "")));
});
test("a failing pending-tasks or feedback query is reported alone; every other section still renders and no DB text leaks", async () => {
  const bad = makeMockPool([CONT, CARDS, COUNTS, PLAN, NEWS, [PEND_MATCH, () => { throw new Error("db secret detail"); }], [FB_MATCH, () => { throw new Error("db secret 2"); }]]);
  const r = await D.getDashboard(bad.pool, student(), NOW);
  assert.deepStrictEqual(Object.keys(r.errors).sort(), ["pendingTasks", "recentFeedback"]); assert.deepStrictEqual([r.pendingTasks, r.pendingTasksMore, r.recentFeedback], [[], false, []]);
  assert.strictEqual(r.courses.length, 2); assert.strictEqual(r.announcements.length, 1); assert.ok(!/secret/.test(JSON.stringify(r)));
});
test("staff still get nothing (no new query before the role check); a brand-new student has empty new sections", async () => {
  const t = withPend([asg(1)]); const f = await D.getDashboard(t.pool, teacher, NOW); assert.deepStrictEqual([f.ok, f.forbidden, t.log.length], [false, true, 0]);
  const e = await D.getDashboard(makeMockPool([]).pool, student(), NOW); assert.deepStrictEqual([e.pendingTasks, e.pendingTasksMore, e.recentFeedback], [[], false, []]);
});
