/* L3.4a — completion rules and lesson progress. Mocked pool only: SQL syntax and the DATEDIFF credit
   arithmetic are NOT verified on a real SQL Server (see docs/ASSUMPTIONS A27). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsProgress.test.js");
const P = require("../utils/lmsProgress");
const L = require("../utils/lmsLessons");
const { on } = require("../utils/lmsEvents");

const student = (id = 21) => ({ id, role: "student", source: "Students" });
const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const course = (status = "published") => ["FROM lms_courses WHERE id", () => (status ? [{ status }] : [])];
const lesson = (o = {}) => ["FROM lms_lessons WHERE id = @id", onlyIds("id", [9], [{ id: 9, completion_rule: null, min_minutes: null, ...o }])];
const prow = (o = {}) => ({ lesson_id: 9, status: "in_progress", seconds_spent: 0, view_count: 1, first_viewed_at: "t0", last_viewed_at: "t1", completed_at: null, ...o });
const TOUCH = "UPDATE lms_lesson_progress SET seconds_spent", DONE = "UPDATE lms_lesson_progress SET status = 'completed'", INS = "INSERT INTO lms_lesson_progress", CUR = "FROM lms_lesson_progress WHERE lesson_id";
const T = "prog-t";

/* ---------------- validation ---------------- */
test("validateView: only a whole number of seconds 0-600; unknown fields and odd types refused; empty body is fine", () => {
  for (const ok of [undefined, null, {}, { seconds: 0 }, { seconds: 30 }, { seconds: 600 }]) assert.ok(P.validateView(ok).ok, JSON.stringify(ok));
  for (const bad of [{ seconds: -1 }, { seconds: 601 }, { seconds: 1.5 }, { seconds: "30" }, { seconds: null }, { seconds: NaN }, { studentId: 5 }, [], "x", 5]) assert.strictEqual(P.validateView(bad).ok, false, JSON.stringify(bad));
});
test("lesson completion rule validation: rule list, min_time needs minutes, minutes only with min_time and only together with a rule", () => {
  const v = (b, o) => L.validateLesson(b, o || { partial: true });
  assert.ok(v({ completionRule: "view" }).ok && v({ completionRule: "mark_complete" }).ok);
  assert.deepStrictEqual([v({ completionRule: "min_time", minMinutes: 5 }).value.completionRule, v({ completionRule: "min_time", minMinutes: 5 }).value.minMinutes], ["min_time", 5]);
  for (const bad of [{ completionRule: "quiz_pass" }, { completionRule: "min_time" }, { completionRule: "min_time", minMinutes: 0 }, { completionRule: "min_time", minMinutes: 241 }, { completionRule: "min_time", minMinutes: null }, { completionRule: "view", minMinutes: 5 }, { minMinutes: 5 }, { completionRule: "x", minMinutes: 5 }]) assert.strictEqual(v(bad).ok, false, JSON.stringify(bad));
  assert.ok(v({ completionRule: "view", minMinutes: null }).ok);
  assert.ok(L.validateLesson({ title: "x", completionRule: "min_time", minMinutes: 10 }).ok);
});
test("lessons store and show the rule: default mark_complete, min_minutes cleared when the rule is not min_time", async () => {
  const les = (o = {}) => ({ id: 9, course_id: 5, section_id: null, title: "Cells", summary: null, status: "draft", estimated_minutes: null, sort_order: 10, content_version: 1, published_at: null, publish_at: null, created_at: "x", updated_at: "x", ...o });
  const live = ["FROM lms_courses WHERE id", () => [{ status: "draft" }]];
  const a = makeMockPool([live, ["UPDATE lms_lessons SET", () => [les({ completion_rule: "min_time", min_minutes: 8 })]]]);
  const r = await L.updateLesson(a.pool, teacher(), 5, 9, { completionRule: "min_time", minMinutes: 8 }, T);
  assert.ok(r.ok); assert.deepStrictEqual([r.lesson.completionRule, r.lesson.minMinutes], ["min_time", 8]);
  const q = a.log.find((x) => x.sql.includes("UPDATE lms_lessons SET")); assert.ok(q.sql.includes("completion_rule = @cr") && q.sql.includes("min_minutes = @mm") && q.sql.includes("course_id = @c")); assert.deepStrictEqual([q.inputs.cr, q.inputs.mm], ["min_time", 8]);
  const b = makeMockPool([live, ["UPDATE lms_lessons SET", () => [les()]]]); await L.updateLesson(b.pool, teacher(), 5, 9, { completionRule: "view", minMinutes: null }, T);
  const q2 = b.log.find((x) => x.sql.includes("UPDATE lms_lessons SET")); assert.deepStrictEqual([q2.inputs.cr, q2.inputs.mm], ["view", null]);
  assert.strictEqual((await L.listLessons(makeMockPool([["FROM lms_lessons WHERE course_id", () => [les()]]]).pool, 5))[0].completionRule, "mark_complete"); // NULL column = default
  const c = makeMockPool([live, ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 0 }]], ["INSERT INTO lms_lessons", () => [les({ completion_rule: "view" })]]]); await L.createLesson(c.pool, teacher(), 5, { title: "Cells", completionRule: "view" });
  const qi = c.log.find((x) => x.sql.includes("INSERT INTO lms_lessons")); assert.ok(qi.sql.includes("completion_rule, min_minutes") && qi.sql.includes("@cr, @mm")); assert.strictEqual(qi.inputs.cr, "view");
});

/* ---------------- recording a view ---------------- */
test("recordView: first open creates the row; time is a parameter and the server clock + 120 s cap are in the SQL", async () => {
  const m = makeMockPool([course(), lesson(), [TOUCH, () => []], [INS, () => [prow()]]]);
  const r = await P.recordView(m.pool, 5, 9, 21, { seconds: 45 }, T); assert.ok(r.ok && r.recorded); assert.strictEqual(r.progress.status, "in_progress"); assert.strictEqual(r.rule, "mark_complete");
  const ins = m.log.find((x) => x.sql.includes(INS)); assert.deepStrictEqual([ins.inputs.c, ins.inputs.l, ins.inputs.s], [5, 9, 21]);
  const upd = m.log.find((x) => x.sql.includes(TOUCH)); assert.strictEqual(upd.inputs.sec, 45); assert.ok(!upd.sql.includes("45"));
  assert.ok(upd.sql.includes("DATEDIFF(SECOND, last_viewed_at, SYSUTCDATETIME())") && upd.sql.includes("> 120 THEN 120") && upd.sql.includes("last_viewed_at = SYSUTCDATETIME()"));
  assert.ok(/WHERE lesson_id = @l AND student_id = @s AND course_id = @c/.test(upd.sql));
  const lq = m.log.find((x) => x.sql.includes("FROM lms_lessons WHERE id")); assert.ok(lq.sql.includes("course_id = @c") && lq.sql.includes("status = 'published'") && lq.sql.includes("deleted_at IS NULL"));
  assert.ok(m.log.find((x) => x.sql.includes("FROM lms_courses")).sql.includes("status IN ('published','archived')"));
});
test("recordView: existing row is updated (no insert); a duplicate-key race falls back to the update", async () => {
  const a = makeMockPool([course(), lesson(), [TOUCH, () => [prow({ seconds_spent: 30 })]], [INS, () => { throw new Error("must not insert"); }]]);
  const r = await P.recordView(a.pool, 5, 9, 21, { seconds: 30 }, T); assert.ok(r.ok); assert.strictEqual(r.progress.secondsSpent, 30); assert.ok(!a.log.some((x) => x.sql.includes(INS)));
  let n = 0; const b = makeMockPool([course(), lesson(), [TOUCH, () => (++n === 1 ? [] : [prow()])], [INS, () => { const e = new Error("dup"); e.number = 2627; throw e; }]]);
  assert.ok((await P.recordView(b.pool, 5, 9, 21, {}, T)).ok); assert.strictEqual(n, 2);
  const c = makeMockPool([course(), lesson(), [TOUCH, () => []], [INS, () => { throw new Error("disk full"); }]]);
  await assert.rejects(() => P.recordView(c.pool, 5, 9, 21, {}, T), /disk full/); // other errors are not swallowed
});
test("recordView: hidden/other-course lesson, missing course and bad input write nothing; archived course records nothing", async () => {
  const w = (log) => log.some((x) => /^(INSERT|UPDATE)/.test(x.sql));
  const a = makeMockPool([course(), lesson()]); assert.strictEqual((await P.recordView(a.pool, 5, 77, 21, {}, T)).notFound, true); assert.ok(!w(a.log));
  const b = makeMockPool([course(null), lesson()]); assert.strictEqual((await P.recordView(b.pool, 5, 9, 21, {}, T)).notFound, true); assert.ok(!w(b.log));
  const c = makeMockPool([course(), lesson()]); assert.strictEqual((await P.recordView(c.pool, 5, 9, 21, { seconds: 9999 }, T)).ok, false); assert.strictEqual(c.log.length, 0);
  const d = makeMockPool([course("archived"), lesson()]); const r = await P.recordView(d.pool, 5, 9, 21, { seconds: 5 }, T); assert.ok(r.ok && r.recorded === false && r.progress === null); assert.ok(!w(d.log));
});
test("recordView with rule 'view': completes on first open and emits lms.lesson.completed once, not on a later view", async () => {
  const seen = []; const off = on("lms.lesson.completed", (e) => seen.push(e));
  const mk = (rowStatus, tenant) => ({ tenant, m: makeMockPool([course(), lesson({ completion_rule: "view" }), [TOUCH, () => [prow({ status: rowStatus, completed_at: rowStatus === "completed" ? "t2" : null })]], [DONE, () => (rowStatus === "completed" ? [] : [prow({ status: "completed", completed_at: "t2" })])], [CUR, () => [prow({ status: "completed", completed_at: "t2" })]]]) });
  const a = mk("in_progress", "ev-view-1"); const r = await P.recordView(a.m.pool, 5, 9, 21, {}, a.tenant); assert.strictEqual(r.progress.status, "completed");
  const b = mk("completed", "ev-view-2"); await P.recordView(b.m.pool, 5, 9, 21, {}, b.tenant); assert.ok(!b.m.log.some((x) => x.sql.includes(DONE))); // already complete: no second completion statement
  await tick(); assert.strictEqual(seen.filter((e) => e.tenant === "ev-view-1").length, 1); assert.strictEqual(seen.filter((e) => e.tenant === "ev-view-2").length, 0);
  assert.deepStrictEqual(Object.keys(seen.find((e) => e.tenant === "ev-view-1")).filter((k) => !["at", "event"].includes(k)).sort(), ["courseId", "lessonId", "studentId", "tenant"]); // ids only (the bus adds event name and timestamp) off && off();
});

/* ---------------- marking complete ---------------- */
test("markComplete (default rule): completes in one conditional statement, emits once, and is idempotent", async () => {
  const seen = []; const off = on("lms.lesson.completed", (e) => seen.push(e));
  const a = makeMockPool([course(), lesson(), [TOUCH, () => [prow()]], [DONE, () => [prow({ status: "completed", completed_at: "t2" })]]]);
  const r = await P.markComplete(a.pool, 5, 9, 21, "ev-mc-1"); assert.ok(r.ok && r.newlyCompleted); assert.strictEqual(r.progress.status, "completed");
  const q = a.log.find((x) => x.sql.includes(DONE)); assert.ok(q.sql.includes("status <> 'completed'") && q.sql.includes("seconds_spent >= @need") && /course_id = @c/.test(q.sql)); assert.strictEqual(q.inputs.need, 0); assert.strictEqual(q.inputs.s, 21);
  const b = makeMockPool([course(), lesson(), [TOUCH, () => [prow({ status: "completed" })]], [DONE, () => []], [CUR, () => [prow({ status: "completed", completed_at: "t2" })]]]);
  const again = await P.markComplete(b.pool, 5, 9, 21, "ev-mc-2"); assert.ok(again.ok); assert.strictEqual(again.newlyCompleted, false); assert.strictEqual(again.progress.status, "completed");
  await tick(); assert.strictEqual(seen.filter((e) => e.tenant === "ev-mc-1").length, 1); assert.strictEqual(seen.filter((e) => e.tenant === "ev-mc-2").length, 0); off && off();
});
test("markComplete with rule min_time: refused until enough credited time, with the remaining time; accepted once reached", async () => {
  const mk = (secs, ok) => makeMockPool([course(), lesson({ completion_rule: "min_time", min_minutes: 5 }), [TOUCH, () => [prow({ seconds_spent: secs })]], [DONE, (i) => (ok ? [prow({ status: "completed", seconds_spent: secs })] : [])], [CUR, () => [prow({ seconds_spent: secs })]]]);
  const short = mk(100, false); const r = await P.markComplete(short.pool, 5, 9, 21, "ev-mt-1");
  assert.deepStrictEqual([r.ok, r.code, r.extra.remainingSeconds], [false, "MIN_TIME_NOT_MET", 200]); assert.ok(/4 more minutes/.test(r.errors[0]));
  assert.strictEqual(short.log.find((x) => x.sql.includes(DONE)).inputs.need, 300); // 5 minutes
  const enough = mk(300, true); assert.ok((await P.markComplete(enough.pool, 5, 9, 21, "ev-mt-2")).ok);
  const none = await P.markComplete(makeMockPool([course(), lesson({ completion_rule: "min_time", min_minutes: 1 }), [TOUCH, () => []], [INS, () => [prow()]], [DONE, () => []], [CUR, () => [prow()]]]).pool, 5, 9, 21, "ev-mt-3"); assert.strictEqual(none.code, "MIN_TIME_NOT_MET"); assert.strictEqual(none.extra.remainingSeconds, 60);
});
test("markComplete: archived course, hidden lesson and missing course are refused without writing", async () => {
  const w = (log) => log.some((x) => /^(INSERT|UPDATE)/.test(x.sql));
  const a = makeMockPool([course("archived"), lesson()]); assert.strictEqual((await P.markComplete(a.pool, 5, 9, 21, T)).code, "COURSE_ARCHIVED"); assert.ok(!w(a.log));
  const b = makeMockPool([course(), lesson()]); assert.strictEqual((await P.markComplete(b.pool, 5, 77, 21, T)).notFound, true); assert.ok(!w(b.log));
  const c = makeMockPool([course(null), lesson()]); assert.strictEqual((await P.markComplete(c.pool, 5, 9, 21, T)).notFound, true); assert.ok(!w(c.log));
});

/* ---------------- course progress ---------------- */
test("courseProgress: percentage = completed visible lessons / visible lessons (rounded down); resume = latest in-progress, else first not started", async () => {
  const SEC = ["FROM lms_course_sections WHERE course_id", () => [{ id: 3, sort_order: 10 }, { id: 4, sort_order: 20 }]];
  const LES = ["FROM lms_lessons WHERE course_id", () => [{ id: 4, section_id: null, sort_order: 5 }, { id: 1, section_id: 4, sort_order: 10 }, { id: 3, section_id: 3, sort_order: 10 }, { id: 2, section_id: 3, sort_order: 20 }]];
  const PR = (rows) => ["FROM lms_lesson_progress WHERE course_id", () => rows];
  const a = makeMockPool([course(), SEC, LES, PR([{ lesson_id: 3, status: "completed", seconds_spent: 60, last_viewed_at: "2026-10-01T10:00:00Z", completed_at: "x" }, { lesson_id: 99, status: "completed", seconds_spent: 1, last_viewed_at: "x", completed_at: "x" }])]);
  const r = await P.courseProgress(a.pool, 5, 21); assert.ok(r.ok);
  assert.deepStrictEqual(r.lessons.map((l) => l.lessonId), [3, 2, 1, 4]); // section order, then lesson order (the SQL ORDER BY), unsectioned last
  assert.deepStrictEqual([r.completed, r.total, r.percent], [1, 4, 25]); assert.strictEqual(r.resumeLessonId, 2); // lesson 99 (hidden/deleted) is ignored
  const q = a.log.find((x) => x.sql.includes("FROM lms_lesson_progress")); assert.ok(q.sql.includes("student_id = @s") && q.sql.includes("course_id = @c") && q.inputs.s === 21);
  assert.ok(a.log.find((x) => x.sql.includes("FROM lms_lessons WHERE course_id")).sql.includes("status = 'published'"));
  const b = makeMockPool([course(), SEC, LES, PR([{ lesson_id: 1, status: "in_progress", seconds_spent: 5, last_viewed_at: "2026-10-02T10:00:00Z" }, { lesson_id: 2, status: "in_progress", seconds_spent: 5, last_viewed_at: "2026-10-03T10:00:00Z" }, { lesson_id: 3, status: "completed", last_viewed_at: "x", completed_at: "x" }])]);
  assert.strictEqual((await P.courseProgress(b.pool, 5, 21)).resumeLessonId, 2);
  const all = makeMockPool([course(), SEC, ["FROM lms_lessons WHERE course_id", () => [{ id: 3, section_id: 3, sort_order: 10 }]], PR([{ lesson_id: 3, status: "completed", last_viewed_at: "x", completed_at: "x" }])]); const d = await P.courseProgress(all.pool, 5, 21); assert.deepStrictEqual([d.percent, d.resumeLessonId], [100, null]);
  const none = makeMockPool([course(), SEC, ["FROM lms_lessons WHERE course_id", () => []], PR([])]); const z = await P.courseProgress(none.pool, 5, 21); assert.deepStrictEqual([z.percent, z.total, z.resumeLessonId], [0, 0, null]);
  const three = makeMockPool([course(), SEC, ["FROM lms_lessons WHERE course_id", () => [{ id: 1, section_id: 3, sort_order: 1 }, { id: 2, section_id: 3, sort_order: 2 }, { id: 3, section_id: 3, sort_order: 3 }]], PR([{ lesson_id: 1, status: "completed", last_viewed_at: "x", completed_at: "x" }])]); assert.strictEqual((await P.courseProgress(three.pool, 5, 21)).percent, 33); // rounded down
  assert.strictEqual((await P.courseProgress(makeMockPool([course(null)]).pool, 5, 21)).notFound, true);
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const enrolled = (ids) => ["FROM lms_course_enrolments WHERE course_id", onlyIds("c", ids, [{ status: "active" }])];
const staff = (ids) => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: "teacher" }])];
const VP = "/courses/:courseId/learn/lessons/:lessonId/view", CP = "/courses/:courseId/learn/lessons/:lessonId/complete", GP = "/courses/:courseId/learn/progress";

test("routes: the student id comes from the token (a body studentId is refused); view/complete/progress work for an enrolled student", async () => {
  const pool = () => makeMockPool([enrolled([5]), course(), lesson(), [TOUCH, () => [prow()]], [DONE, () => [prow({ status: "completed" })]], ["FROM lms_course_sections WHERE course_id", () => []], ["FROM lms_lessons WHERE course_id", () => []], ["FROM lms_lesson_progress WHERE course_id", () => []]]);
  const a = pool(); const v = await call("post", VP, { user: student(21), pool: a.pool, params: { courseId: "5", lessonId: "9" }, body: { seconds: 20 } }); assert.strictEqual(v.res.statusCode, 200); assert.strictEqual(v.res.body.recorded, true);
  assert.strictEqual(a.log.find((x) => x.sql.includes(TOUCH)).inputs.s, 21);
  const forged = pool(); const f = await call("post", VP, { user: student(21), pool: forged.pool, params: { courseId: "5", lessonId: "9" }, body: { studentId: 22 } }); assert.strictEqual(f.res.statusCode, 400); assert.ok(!forged.log.some((x) => /^(INSERT|UPDATE)/.test(x.sql)));
  const c = await call("post", CP, { user: student(21), pool: pool().pool, params: { courseId: "5", lessonId: "9" } }); assert.strictEqual(c.res.statusCode, 200); assert.strictEqual(c.res.body.newlyCompleted, true);
  const g = await call("get", GP, { user: student(21), pool: pool().pool, params: { courseId: "5" } }); assert.strictEqual(g.res.statusCode, 200); assert.strictEqual(g.res.body.percent, 0);
  const bad = await call("post", VP, { user: student(21), pool: pool().pool, params: { courseId: "5", lessonId: "abc" } }); assert.strictEqual(bad.res.statusCode, 404);
});
test("routes: min_time answers 409 MIN_TIME_NOT_MET with remainingSeconds", async () => {
  const pool = makeMockPool([enrolled([5]), course(), lesson({ completion_rule: "min_time", min_minutes: 2 }), [TOUCH, () => [prow({ seconds_spent: 20 })]], [DONE, () => []], [CUR, () => [prow({ seconds_spent: 20 })]]]);
  const r = await call("post", CP, { user: student(), pool: pool.pool, params: { courseId: "5", lessonId: "9" } }); assert.strictEqual(r.res.statusCode, 409); assert.deepStrictEqual([r.res.body.code, r.res.body.remainingSeconds], ["MIN_TIME_NOT_MET", 100]);
});
test("routes: teachers, non-enrolled students and other courses get the same 403 and nothing is written; staff cannot record progress", async () => {
  const mk = () => makeMockPool([enrolled([5]), staff([5]), course(), lesson(), [TOUCH, () => [prow()]], [DONE, () => [prow()]], [INS, () => [prow()]]]);
  const refused = [];
  for (const path of [VP, CP, GP]) {
    const t = mk(); const a = await call(path === GP ? "get" : "post", path, { user: teacher(), pool: t.pool, params: { courseId: "5", lessonId: "9" } }); assert.strictEqual(a.res.statusCode, 403); assert.ok(!t.log.some((x) => /^(INSERT|UPDATE)/.test(x.sql)));
    const o = mk(); const b = await call(path === GP ? "get" : "post", path, { user: student(), pool: o.pool, params: { courseId: "6", lessonId: "9" } }); assert.strictEqual(b.res.statusCode, 403); assert.ok(!o.log.some((x) => /^(INSERT|UPDATE)/.test(x.sql)));
    const m = mk(); const c = await call(path === GP ? "get" : "post", path, { user: student(), pool: m.pool, params: { courseId: "999", lessonId: "9" } }); sameForbidden(b.res, c.res); refused.push(a.res);
  }
});
test("tenant isolation: a student of school A guessing a lesson id of school B reads and writes nothing in B", async () => {
  const T2 = makeTenants({ A: [enrolled([5]), course(), lesson(), [TOUCH, () => [prow()]]], B: [enrolled([5]), course(), lesson(), [TOUCH, () => [prow()]]] });
  const r = await call("post", VP, { user: student(), pool: T2.A.pool, params: { courseId: "5", lessonId: "9" }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 200);
  T2.assertQueried("A"); T2.assertUntouched("B");
  const miss = await call("post", VP, { user: student(), pool: T2.A.pool, params: { courseId: "5", lessonId: "10" }, tenant: "A" }); assert.strictEqual(miss.res.statusCode, 404); T2.assertUntouched("B");
});

/* ---------------- static ---------------- */
test("static: step 011 additive and guarded; table blocklisted; the three routes sit behind the licence gate with studentOnly + enrolment; no raw db; student id never read from the request body", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "011_lms_lesson_progress"); assert.ok(st && STEPS.indexOf(st) > STEPS.findIndex((s) => s.id === "010_lms_lesson_versions"));
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); assert.strictEqual((ddl.match(/ALTER TABLE/g) || []).length, 2);
  assert.ok(/IF COL_LENGTH\('lms_lessons', 'completion_rule'\) IS NULL\s+ALTER TABLE lms_lessons ADD completion_rule NVARCHAR\(20\) NULL/.test(ddl) && /ADD min_minutes INT NULL/.test(ddl));
  assert.ok(/UNIQUE \(lesson_id, student_id\)/.test(ddl) && /IX_lms_lesson_progress_student/.test(ddl));
  assert.ok(/"lms_lesson_progress"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")));
  const router = require("../routes/lms"), first = router.stack.findIndex((l) => l.route);
  for (const p of [VP, CP, GP]) { const idx = router.stack.findIndex((l) => l.route && l.route.path === p); assert.ok(idx > first - 1 && idx >= 2, p); const l = router.stack[idx]; assert.strictEqual(l.route.stack.length, 3, p); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsProgress.js"), "utf8"); assert.ok(!/mssql"\)\.connect|new sql\.ConnectionPool|getPool|require\("\.\.\/config\/db"\)/.test(src)); assert.ok(!/req\.body/.test(src));
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes", "lms.js"), "utf8"); assert.ok(!/body\??\.studentId/.test(routes));
});
