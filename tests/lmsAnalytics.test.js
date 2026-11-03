/* L9.1a - teacher attention analytics (D-105): read only prompts with the numbers behind them. Mocked pool only: the SQL (CTE + ROW_NUMBER, OPENJSON) is NOT verified on a real SQL Server;
   the tests pin the guards in the query TEXT (course scope, active enrolment, submitted-only latest attempt, published only, marked quizzes only). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsAnalytics.test.js");
const N = require("../utils/lmsAnalytics"), S = require("../utils/lmsSettings");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const NOW = new Date("2026-11-02T12:00:00Z");
const ASG = [{ id: 1, title: "Essay", dueAt: "2026-10-10T10:00:00Z" }, { id: 2, title: "Lab", dueAt: "2026-10-20T10:00:00Z" }, { id: 3, title: "Project", dueAt: "2026-12-01T10:00:00Z" }, { id: 4, title: "No date", dueAt: null }];
const L = (id, name, enrolledAt) => ({ studentId: id, name, enrolledAt });
const LEARNERS = [L(21, "Amina", "2026-08-01T08:00:00Z"), L(22, "Brian", "2026-08-01T08:00:00Z"), L(23, "Cheche", "2026-10-30T08:00:00Z"), L(24, "Dina", "2026-08-01T08:00:00Z"), L(25, "Eli", "2026-09-01T12:00:00Z")];
const sub = (...rows) => new Map(rows.map(([a, late, at]) => [a, { late, at }]));
const world = () => ({
  learners: LEARNERS, lessonsTotal: 4, assignments: ASG, now: NOW,
  lessonStats: new Map([[21, { done: 3, lastAt: "2026-11-01T09:00:00Z" }], [22, { done: 1, lastAt: "2026-10-01T12:00:00Z" }], [24, { done: 4, lastAt: "2026-10-30T09:00:00Z" }]]),
  submitted: new Map([[21, sub([1, false, "2026-10-09T10:00:00Z"], [2, false, "2026-10-19T10:00:00Z"])], [24, sub([1, true, "2026-10-11T10:00:00Z"], [2, true, "2026-10-21T10:00:00Z"], [3, true, "2026-10-25T10:00:00Z"])]]),
  openExt: new Set(["2:23"]), quiz: new Map([[21, [90, 70]], [24, [20, 40]]]), quizActivity: new Map(), thresholds: { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 }, outcome: null,
});
const typesOf = (r, id) => (r.learners.find((x) => x.studentId === id) || { alerts: [] }).alerts.map((a) => a.type);

test("buildAttention (pure): hand-calculated alerts, each with reason + numbers + threshold; name order; nobody ranked", () => {
  const r = N.buildAttention(world());
  assert.deepStrictEqual(r.learners.map((x) => x.name), ["Brian", "Cheche", "Dina", "Eli"], "name order, Amina has no alert so is not listed (Dina has the most alerts but is not first)");
  assert.deepStrictEqual([typesOf(r, 22), typesOf(r, 23), typesOf(r, 24), typesOf(r, 25), typesOf(r, 21)], [["inactive", "missing_work"], ["missing_work"], ["late_pattern", "low_quiz"], ["inactive", "missing_work"], []]);
  const b = r.learners[0].alerts; assert.deepStrictEqual(b[0].data, { lastActivityAt: "2026-10-01T12:00:00.000Z", since: "2026-10-01T12:00:00.000Z", daysInactive: 32 });
  assert.deepStrictEqual(b[0].threshold, { inactiveDays: 14 }); assert.ok(/32 days/.test(b[0].reason) && /14/.test(b[0].reason));
  assert.deepStrictEqual([b[1].data.missing, b[1].data.pastDueAssignments, b[1].data.items.map((x) => x.title)], [2, 2, ["Essay", "Lab"]], "future and undated assignments are never missing");
  const c = r.learners[1].alerts[0]; assert.deepStrictEqual([c.data.missing, c.data.items.map((x) => x.assignmentId)], [1, [1]], "an open extension on the Lab removes it from missing");
  const d = r.learners[2].alerts; assert.deepStrictEqual(d[0].data, { submitted: 3, late: 3, latePercent: 100 }); assert.deepStrictEqual(d[1].data, { quizzesMarked: 2, averagePercent: 30 }); assert.deepStrictEqual(d[1].threshold, { lowQuizPercent: 50, minQuizzes: 2 });
  const e = r.learners[3].alerts[0]; assert.deepStrictEqual([e.data.lastActivityAt, e.data.since, e.data.daysInactive], [null, "2026-09-01T12:00:00.000Z", 62]); assert.ok(/since joining/.test(e.reason));
  assert.deepStrictEqual(r.summary.alertCounts, { inactive: 2, missing_work: 3, late_pattern: 1, low_quiz: 1 });
  assert.deepStrictEqual([r.summary.learners, r.summary.learnersWithAlerts], [5, 4]);
  assert.deepStrictEqual(r.summary.completion, { lessons: 4, notStarted: 2, inProgress: 2, complete: 1, averagePercent: 40 });
  assert.deepStrictEqual(r.summary.timeliness, { assignmentsPastDue: 2, submitted: 5, late: 3, missing: 5 });
  assert.deepStrictEqual(r.summary.quizzes, { marked: 4, averagePercent: 55 }); assert.strictEqual(r.summary.outcomeCoverage, null);
  const text = JSON.stringify(r); for (const bad of ["admission", "rank", "risk", "score", "grade", "label", "verdict", "atRisk"]) assert.ok(!new RegExp(bad, "i").test(text), bad);
});

test("buildAttention: boundaries (exactly at the threshold alerts, one below does not; minimum counts for late and quiz; no due date or future due never missing)", () => {
  const at = (days, th = {}) => { const w = world(); w.learners = [L(30, "Zed", "2026-01-01T00:00:00Z")]; w.submitted = new Map(); w.assignments = []; w.lessonStats = new Map([[30, { done: 1, lastAt: new Date(NOW.getTime() - days * 86400000).toISOString() }]]); w.quiz = new Map(); w.thresholds = { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50, ...th }; return typesOf(N.buildAttention(w), 30); };
  assert.deepStrictEqual([at(14), at(13), at(14, { inactiveDays: 15 }), at(15, { inactiveDays: 15 })], [["inactive"], [], [], ["inactive"]]);
  const late = (n, lateN, th = 50) => { const w = world(); w.learners = [L(30, "Zed", "2026-10-30T00:00:00Z")]; w.assignments = []; w.quiz = new Map(); w.lessonStats = new Map([[30, { done: 0, lastAt: NOW.toISOString() }]]); w.thresholds.lateSharePercent = th; w.submitted = new Map([[30, new Map(Array.from({ length: n }, (_, i) => [i + 1, { late: i < lateN, at: NOW.toISOString() }]))]]); return typesOf(N.buildAttention(w), 30); };
  assert.deepStrictEqual([late(2, 2), late(3, 2), late(4, 2), late(4, 1), late(4, 2, 51), late(4, 2, 50)], [[], ["late_pattern"], ["late_pattern"], [], [], ["late_pattern"]], "needs 3 submitted; 2/4 = 50% meets a 50% threshold, not 51%");
  const qz = (list, th = 50) => { const w = world(); w.learners = [L(30, "Zed", "2026-10-30T00:00:00Z")]; w.assignments = []; w.submitted = new Map(); w.lessonStats = new Map([[30, { done: 0, lastAt: NOW.toISOString() }]]); w.thresholds.lowQuizPercent = th; w.quiz = new Map([[30, list]]); return typesOf(N.buildAttention(w), 30); };
  assert.deepStrictEqual([qz([10]), qz([10, 20]), qz([40, 60]), qz([40, 59]), qz([40, 60], 51)], [[], ["low_quiz"], [], ["low_quiz"], ["low_quiz"]], "one quiz is never enough; the average must be BELOW the threshold");
  const m = world(); m.learners = [L(30, "Zed", "2026-10-30T00:00:00Z")]; m.assignments = [{ id: 9, title: "x", dueAt: "2026-11-02T12:00:00Z" }]; m.submitted = new Map(); m.lessonStats = new Map([[30, { done: 0, lastAt: NOW.toISOString() }]]); m.quiz = new Map(); m.openExt = new Set();
  assert.deepStrictEqual(typesOf(N.buildAttention(m), 30), [], "due exactly now is not past due yet");
  m.assignments[0].dueAt = "2026-11-02T11:59:59Z"; assert.deepStrictEqual(typesOf(N.buildAttention(m), 30), ["missing_work"]);
});

test("buildAttention: more than five missing lists five (oldest due first) but counts all; a bad or missing threshold falls back to the default", () => {
  const w = world(); w.learners = [L(30, "Zed", "2026-10-30T00:00:00Z")]; w.submitted = new Map(); w.openExt = new Set(); w.lessonStats = new Map([[30, { done: 0, lastAt: NOW.toISOString() }]]); w.quiz = new Map();
  w.assignments = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: `A${i + 1}`, dueAt: `2026-10-0${i + 1}T10:00:00Z` }));
  const a = N.buildAttention(w).learners[0].alerts[0]; assert.deepStrictEqual([a.data.missing, a.data.items.length, a.data.items[0].title, a.data.items[4].title], [8, 5, "A1", "A5"]);
  assert.deepStrictEqual(N.normThresholds(undefined), { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 });
  assert.deepStrictEqual(N.normThresholds({ inactiveDays: 0, lowQuizPercent: 101, lateSharePercent: "x" }), { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 });
  assert.deepStrictEqual(N.normThresholds({ inactiveDays: 365, lowQuizPercent: 1, lateSharePercent: 100 }), { inactiveDays: 365, lowQuizPercent: 1, lateSharePercent: 100 });
});

/* ------------------------------ report over the (mocked) database ------------------------------ */
function dbWorld(o = {}) {
  const ENR = (o.learners || LEARNERS).map((l) => ({ student_id: l.studentId, student_name: l.name, enrolled_at: l.enrolledAt }));
  const w = world();
  return makeMockPool([
    ["SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL", (i) => (i.c === 5 ? [{ id: 5 }] : [])],
    ["FROM lms_course_enrolments e LEFT JOIN Students st", () => ENR],
    ["SELECT setting_key, value_json FROM lms_settings", () => o.settings || []],
    ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 4 }]],
    ["FROM lms_assignments WHERE course_id = @c AND status = 'published'", () => (o.asg || ASG).map((a) => ({ id: a.id, title: a.title, due_at: a.dueAt }))],
    ["FROM lms_lesson_progress p", () => [...w.lessonStats].map(([id, x]) => ({ student_id: id, done: x.done, last_at: x.lastAt }))],
    ["FROM lms_submissions s JOIN lms_assignments a", () => { const out = []; for (const [sid, m] of w.submitted) for (const [aid, x] of m) out.push({ assignment_id: aid, student_id: sid, is_late: x.late ? 1 : 0, submitted_at: x.at }); return out; }],
    ["FROM lms_extensions", () => [{ assignment_id: 2, student_id: 23 }]],
    ["FROM lms_quiz_attempts t JOIN lms_quizzes z", () => { const out = []; for (const [sid, list] of w.quiz) for (const p of list) out.push({ student_id: sid, total_points: p, max_points: 100 }); return out; }],
    ["MAX(started_at) AS last_at FROM lms_quiz_attempts", () => []],
    ["SELECT COUNT(*) AS tags FROM lms_outcome_tags", () => [{ tags: o.tags || 0 }]],
    ["AS lessons_visible", () => [{ lessons_visible: 4, lessons_tagged: 3, outcomes_tagged: 2 }]],
  ]);
}
test("attentionReport: the same numbers end to end; thresholds from the tenant setting; read only; course scoped; names only", async () => {
  const m = dbWorld(); const r = await N.attentionReport(m.pool, teacher, 5, { now: NOW }); assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.learners.map((x) => [x.name, x.alerts.map((a) => a.type)]), [["Brian", ["inactive", "missing_work"]], ["Cheche", ["missing_work"]], ["Dina", ["late_pattern", "low_quiz"]], ["Eli", ["inactive", "missing_work"]]]);
  assert.deepStrictEqual(r.summary.alertCounts, { inactive: 2, missing_work: 3, late_pattern: 1, low_quiz: 1 }); assert.deepStrictEqual(r.summary.thresholds, { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 });
  assert.deepStrictEqual(r.summary.quizzes, { marked: 4, averagePercent: 55 }); assert.strictEqual(r.generatedAt, NOW.toISOString()); assert.ok(/not verdicts/.test(r.note));
  assert.ok(m.log.every((x) => /^\s*(SELECT|WITH)/i.test(x.sql)), "read only"); assert.ok(m.log.every((x) => x.matched !== null || /lms_settings/.test(x.sql)), "no stray query");
  assert.ok(m.log.filter((x) => !/lms_settings/.test(x.sql)).every((x) => /course_id = @c|e\.course_id = @c|id = @c/.test(x.sql) && x.inputs.c === 5), "every query is scoped to the course");
  assert.ok(!JSON.stringify(r).match(/admission/i));
  const s = await N.attentionReport(dbWorld({ settings: [{ setting_key: "analytics", value_json: JSON.stringify({ inactiveDays: 40, lowQuizPercent: 25 }) }] }).pool, teacher, 5, { now: NOW });
  assert.deepStrictEqual(s.summary.thresholds, { inactiveDays: 40, lowQuizPercent: 25, lateSharePercent: 50 }); assert.deepStrictEqual(s.summary.alertCounts, { inactive: 1, missing_work: 3, late_pattern: 1, low_quiz: 0 }, "Brian (32 days) no longer inactive at 40; Dina's 30% is above 25%");
  const bad = await N.attentionReport(dbWorld({ settings: [{ setting_key: "analytics", value_json: "{{{" }] }).pool, teacher, 5, { now: NOW }); assert.strictEqual(bad.summary.thresholds.inactiveDays, 14, "bad stored value = defaults");
});

test("attentionReport: query text keeps the guards (active enrolment only, submitted + latest attempt, published only, marked quizzes only, no admission number selected)", async () => {
  const m = dbWorld(); await N.attentionReport(m.pool, teacher, 5, { now: NOW }); const q = (re) => m.log.find((x) => re.test(x.sql)).sql;
  assert.ok(/e\.status = 'active'/.test(q(/lms_course_enrolments e LEFT JOIN Students/)) && !/admissionNo|admission_no/.test(m.log.map((x) => x.sql).join(" ")));
  const subs = q(/FROM lms_submissions s JOIN lms_assignments a/); assert.ok(/s\.status = 'submitted'/.test(subs) && /ROW_NUMBER\(\) OVER \(PARTITION BY s\.assignment_id, s\.student_id ORDER BY s\.attempt_no DESC/.test(subs) && /rn = 1/.test(subs) && /a\.status = 'published' AND a\.deleted_at IS NULL/.test(subs) && /s\.course_id = @c/.test(subs));
  const qz = q(/FROM lms_quiz_attempts t JOIN lms_quizzes z/); assert.ok(/t\.status = 'graded'/.test(qz) && /t\.max_points > 0/.test(qz) && /z\.status = 'published' AND z\.deleted_at IS NULL/.test(qz) && /PARTITION BY t\.quiz_id, t\.student_id/.test(qz) && /t\.course_id = @c/.test(qz));
  assert.ok(/due_at > @now/.test(q(/FROM lms_extensions/)) && /course_id = @c/.test(q(/FROM lms_extensions/)));
  assert.ok(/status = 'published' AND deleted_at IS NULL/.test(q(/FROM lms_assignments WHERE/)) && /TOP 200/.test(q(/FROM lms_assignments WHERE/)));
  const ids = m.log.find((x) => /OPENJSON/.test(x.sql)).inputs.ids; assert.strictEqual(ids, JSON.stringify([21, 22, 23, 24, 25]), "learner ids come from the course enrolment list, as one JSON parameter");
  assert.ok(m.log.every((x) => !/\$\{|'\s*\+/.test(x.sql)));
});

test("attentionReport: outcome coverage appears only when lesson outcome tags exist", async () => {
  assert.strictEqual((await N.attentionReport(dbWorld().pool, teacher, 5, { now: NOW })).summary.outcomeCoverage, null);
  const m = dbWorld({ tags: 5 }); const r = await N.attentionReport(m.pool, teacher, 5, { now: NOW }); assert.deepStrictEqual(r.summary.outcomeCoverage, { lessonsVisible: 4, lessonsTagged: 3, outcomesTagged: 2 });
  const q = m.log.find((x) => /AS lessons_visible/.test(x.sql)).sql; assert.ok(/l\.course_id = @c/.test(q) && /t\.course_id = @c/.test(q) && /entity_type = 'lesson'/.test(q) && /outcome_tags WHERE course_id = @c AND entity_type = 'lesson'/.test(q), "outcome numbers are for THIS course's lessons only");
  assert.ok(/lms_outcome_tags WHERE course_id = @c AND entity_type = 'lesson'/.test(m.log.find((x) => /AS tags/.test(x.sql)).sql));
});

test("attentionReport: students, anonymous, bad ids and unknown courses are 'not found' before any data query; > 2000 learners = 409; too many cells = 409; empty course works", async () => {
  for (const [u, id] of [[student, 5], [null, 5], [teacher, "x"], [teacher, 0]]) { const m = dbWorld(); const r = await N.attentionReport(m.pool, u, id, { now: NOW }); assert.strictEqual(r.notFound, true); assert.strictEqual(m.log.length, 0); }
  assert.strictEqual((await N.attentionReport(dbWorld().pool, teacher, 9, { now: NOW })).notFound, true);
  const many = Array.from({ length: 2001 }, (_, i) => ({ studentId: i + 1, name: "n", enrolledAt: "2026-01-01T00:00:00Z" }));
  const t = await N.attentionReport(dbWorld({ learners: many }).pool, teacher, 5, { now: NOW }); assert.deepStrictEqual([t.ok, t.code], [false, "TOO_MANY_LEARNERS"]);
  const big = Array.from({ length: 1000 }, (_, i) => ({ studentId: i + 1, name: "n", enrolledAt: "2026-01-01T00:00:00Z" }));
  const ok = await N.attentionReport(dbWorld({ learners: big }).pool, teacher, 5, { now: NOW }); assert.ok(ok.ok, "1000 learners x 4 assignments = 4000 cells is fine");
  const asg = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, title: "a", dueAt: null }));
  const c = await N.attentionReport(dbWorld({ learners: big, asg }).pool, teacher, 5, { now: NOW }); assert.deepStrictEqual([c.ok, c.code], [false, "EXPORT_TOO_LARGE"], "1000 x 101 > 100000 cells");
  const none = await N.attentionReport(dbWorld({ learners: [] }).pool, teacher, 5, { now: NOW }); assert.ok(none.ok); assert.deepStrictEqual([none.summary.learners, none.summary.learnersWithAlerts, none.learners.length], [0, 0, 0]);
});

test("tenant isolation: a report in tenant A never touches tenant B's database", async () => {
  const T = makeTenants({ A: [["SELECT TOP 1 id FROM lms_courses", () => []]], B: [] });
  const r = await N.attentionReport(T.A.pool, teacher, 5, { now: NOW }); T.assertUntouched("B"); T.assertQueried("A"); assert.strictEqual(r.notFound, true, "an empty tenant has no such course");
});

test("route: flag lms_analytics -> lms.gradebook.view -> course staff -> handler; no-store; 200/404/409 shapes; read only (GET only)", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const layers = router.stack.filter((l) => l.route && l.route.path === "/courses/:courseId/analytics/attention"); assert.deepStrictEqual(layers.map((l) => Object.keys(l.route.methods)), [["get"]], "one GET route and nothing that writes");
  const h = layers[0].route; assert.strictEqual(h.stack.length, 4); assert.ok(/const anGate = requireModule\("lms", "lms_analytics"\)/.test(src) && /"\/courses\/:courseId\/analytics\/attention", anGate, gbView, staffAccess,/.test(src));
  const mk = () => { const res = makeRes(), hd = {}; res.setHeader = (k, v) => { hd[k] = v; }; res.h = hd; return res; };
  const r1 = mk(); await h.stack[3].handle({ pool: dbWorld().pool, user: teacher, params: { courseId: "5" }, query: {}, tenant: "t" }, r1);
  assert.deepStrictEqual([r1.statusCode, r1.body.success, "ok" in r1.body, r1.body.summary.learnersWithAlerts, r1.h["Cache-Control"]], [200, true, false, 4, "no-store"]);
  const r2 = mk(); await h.stack[3].handle({ pool: dbWorld().pool, user: teacher, params: { courseId: "9" }, query: {}, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 404);
  const many = Array.from({ length: 2001 }, (_, i) => ({ studentId: i + 1, name: "n", enrolledAt: "2026-01-01T00:00:00Z" }));
  const r3 = mk(); await h.stack[3].handle({ pool: dbWorld({ learners: many }).pool, user: teacher, params: { courseId: "5" }, query: {}, tenant: "t" }, r3); assert.deepStrictEqual([r3.statusCode, r3.body.code], [409, "TOO_MANY_LEARNERS"]);
});

test("settings: `analytics` thresholds validate (whole numbers in range), unknown keys are refused, defaults exist, and the public view does not expose them", () => {
  assert.deepStrictEqual(S.DEFAULTS.analytics, { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 });
  assert.deepStrictEqual(S.validateSettingsPatch({ analytics: { inactiveDays: 30, lowQuizPercent: 40 } }).value.analytics, { inactiveDays: 30, lowQuizPercent: 40 });
  for (const bad of [{ inactiveDays: 0 }, { inactiveDays: 366 }, { inactiveDays: 1.5 }, { lowQuizPercent: 101 }, { lateSharePercent: 0 }, { lateSharePercent: "x" }, { colour: 1 }, [], "x", null]) assert.strictEqual(S.validateSettingsPatch({ analytics: bad }).ok, false, JSON.stringify(bad));
  assert.deepStrictEqual(S.validateSettingsPatch({ analytics: { inactiveDays: "7" } }).value.analytics, { inactiveDays: 7 }, "a numeric string is accepted like the other settings");
  assert.ok(!("analytics" in S.publicView(S.mergeSettings([]))));
  assert.deepStrictEqual(S.mergeSettings([{ setting_key: "analytics", value_json: JSON.stringify({ inactiveDays: 21 }) }]).analytics, { inactiveDays: 21, lowQuizPercent: 50, lateSharePercent: 50 }, "a partial stored value keeps the other defaults");
});
