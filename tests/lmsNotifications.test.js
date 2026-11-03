/* L4.4b — in-app notifications for LMS events. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const { tick } = require("./helpers/tick");
suite("lmsNotifications.test.js");
const N = require("../utils/lmsNotifications");
const events = require("../utils/lmsEvents");
const S = require("../utils/lmsSettings");

const ANN = (a) => ["FROM lms_announcements a LEFT JOIN lms_courses c", () => (a ? [a] : [])];
const SETTINGS = (o) => ["FROM lms_settings", () => (o === undefined ? [] : [{ setting_key: "notifications", value_json: JSON.stringify(o) }])];
const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ student_id: from + i }));
const ann = (o = {}) => ({ title: "Exam dates", body: "See the notice board.", course_title: "Biology F3", course_status: "published", ...o });

function deps(pools, { active = true } = {}) {
  const sent = [];
  return {
    sent,
    getPool: async (t) => { if (!pools[t]) throw new Error(`no pool ${t}`); return pools[t].pool; },
    notify: async (pool, rec, opts) => { sent.push({ pool, rec, opts }); },
    isActive: async (pool, t, m) => (typeof active === "function" ? active(t, m) : active) && m === "lms",
  };
}
const evt = (o) => ({ event: "lms.announcement.published", tenant: "t1", courseId: 5, announcementId: 8, ...o });

test("course announcement: notifies ONLY active enrolled students of that course; text, type and link are right; ids only as parameters", async () => {
  const m = makeMockPool([SETTINGS(), ANN(ann()), ["FROM lms_course_enrolments WHERE course_id", (i) => (i.last === 0 ? rows(21, 3) : [])]]);
  const d = deps({ t1: m }); const r = await N.handle(evt(), d);
  assert.strictEqual(r.sent, 3); assert.strictEqual(d.sent.length, 1);
  assert.deepStrictEqual(d.sent[0].rec, [{ id: 21, source: "Students" }, { id: 22, source: "Students" }, { id: 23, source: "Students" }]);
  const o = d.sent[0].opts; assert.strictEqual(o.type, "lms_announcement"); assert.strictEqual(o.title, "Biology F3: Exam dates"); assert.strictEqual(o.link, "/student/courses/5/learn");
  const q = m.log.find((x) => /lms_course_enrolments/.test(x.sql)); assert.ok(/status = 'active'/.test(q.sql) && /course_id = @c/.test(q.sql) && q.inputs.c === 5 && !/\b5\b/.test(q.sql.replace(/TOP 500/, "")));
  const a = m.log.find((x) => /lms_announcements/.test(x.sql)); assert.ok(/a\.course_id = @c/.test(a.sql) && /a\.status = 'published'/.test(a.sql) && /a\.deleted_at IS NULL/.test(a.sql) && /DATEDIFF\(SECOND/.test(a.sql));
});
test("school-wide announcement: reads active Students, announcement must have course_id NULL, link goes to My courses", async () => {
  const m = makeMockPool([SETTINGS(), ANN(ann({ course_title: null, course_status: null })), ["FROM Students WHERE status = 'active'", () => rows(1, 2)]]);
  const d = deps({ t1: m }); const r = await N.handle(evt({ courseId: null }), d);
  assert.strictEqual(r.sent, 2); assert.strictEqual(d.sent[0].opts.title, "Exam dates"); assert.strictEqual(d.sent[0].opts.link, "/student/courses");
  assert.ok(/a\.course_id IS NULL/.test(m.log.find((x) => /lms_announcements/.test(x.sql)).sql));
  assert.ok(!m.log.some((x) => /lms_course_enrolments/.test(x.sql)));
});
test("fan-out reads keyset batches (last id moves forward) and stops at the cap", async () => {
  const lasts = []; const m = makeMockPool([SETTINGS(), ANN(ann()), ["FROM lms_course_enrolments", (i) => { lasts.push(i.last); return i.last >= 1000 ? rows(i.last + 1, 3) : rows(i.last + 1, N.BATCH); }]]);
  const d = deps({ t1: m }); const r = await N.handle(evt(), d);
  assert.deepStrictEqual(lasts, [0, 500, 1000]); assert.strictEqual(r.sent, 1003); assert.strictEqual(d.sent.length, 3);
  const inf = makeMockPool([SETTINGS(), ANN(ann()), ["FROM lms_course_enrolments", (i) => rows(i.last + 1, N.BATCH)]]);
  const d2 = deps({ t1: inf }); const r2 = await N.handle(evt(), d2);
  assert.strictEqual(r2.sent, N.MAX_COURSE); assert.ok(d2.sent.every((x) => x.rec.length <= N.BATCH));
});
test("no licence: nothing read, nothing sent (jobs are gated like routes); `lms` is the module asked", async () => {
  const m = makeMockPool([]); const asked = [];
  const d = deps({ t1: m }, { active: (t, mod) => { asked.push([t, mod]); return false; } });
  const r = await N.handle(evt(), d);
  assert.deepStrictEqual([r.sent, r.skipped, m.log.length, d.sent.length], [0, "NO_LICENCE", 0, 0]); assert.deepStrictEqual(asked, [["t1", "lms"]]);
});
test("tenant setting notifications.inApp = false switches everything off; default is on", async () => {
  const off = makeMockPool([SETTINGS({ inApp: false }), ANN(ann())]); const d = deps({ t1: off });
  assert.strictEqual((await N.handle(evt(), d)).skipped, "DISABLED"); assert.strictEqual(d.sent.length, 0); assert.ok(!off.log.some((x) => /lms_announcements/.test(x.sql)));
  assert.strictEqual(S.DEFAULTS.notifications.inApp, true);
});
test("not current -> nothing: unpublished, deleted, other course, or re-published long after the first publish (query returns no row)", async () => {
  const m = makeMockPool([SETTINGS(), ANN(null)]); const d = deps({ t1: m });
  const r = await N.handle(evt(), d); assert.deepStrictEqual([r.sent, r.skipped, d.sent.length], [0, "NOT_CURRENT", 0]);
});
test("course that is no longer published (archived/draft): announcement is not pushed", async () => {
  for (const st of ["archived", "draft", "pending"]) {
    const m = makeMockPool([SETTINGS(), ANN(ann({ course_status: st }))]); const d = deps({ t1: m });
    const r = await N.handle(evt(), d); assert.deepStrictEqual([r.skipped, d.sent.length], ["COURSE_NOT_PUBLISHED", 0]);
  }
});
test("bad ids in the event are refused without asking the database about recipients", async () => {
  for (const bad of [{ announcementId: 0 }, { announcementId: "8; DROP" }, { courseId: -2 }, { courseId: "x" }]) {
    const m = makeMockPool([SETTINGS(), ANN(ann())]); const d = deps({ t1: m });
    const r = await N.handle(evt(bad), d); assert.strictEqual(r.skipped, "BAD_EVENT"); assert.strictEqual(d.sent.length, 0);
  }
});
test("enrolment approved / declined notify exactly that student; every other action notifies nobody", async () => {
  const mk = () => makeMockPool([SETTINGS(), ["SELECT title FROM lms_courses WHERE id = @c", (i) => (i.c === 5 ? [{ title: "Biology F3" }] : [])]]);
  const a = mk(), da = deps({ t1: a }); await N.handle({ event: "lms.enrolment.changed", tenant: "t1", courseId: 5, action: "approved", studentId: 33 }, da);
  assert.deepStrictEqual(da.sent[0].rec, [{ id: 33, source: "Students" }]); assert.strictEqual(da.sent[0].opts.type, "lms_enrolment"); assert.ok(/approved/.test(da.sent[0].opts.message) && da.sent[0].opts.link === "/student/courses/5/learn");
  const b = mk(), db = deps({ t1: b }); await N.handle({ event: "lms.enrolment.changed", tenant: "t1", courseId: 5, action: "declined", studentId: 34 }, db);
  assert.ok(/not approved/.test(db.sent[0].opts.message) && db.sent[0].opts.link === "/student/courses"); assert.deepStrictEqual(db.sent[0].rec, [{ id: 34, source: "Students" }]);
  for (const action of ["added", "withdrawn", "self_withdrawn", "transferred", "self_enrolled"]) {
    const c = mk(), dc = deps({ t1: c }); const r = await N.handle({ event: "lms.enrolment.changed", tenant: "t1", courseId: 5, action, studentId: 35 }, dc);
    assert.deepStrictEqual([r.skipped, dc.sent.length], ["NO_NOTICE", 0]);
  }
  const gone = mk(), dg = deps({ t1: gone }); assert.strictEqual((await N.handle({ event: "lms.enrolment.changed", tenant: "t1", courseId: 99, action: "approved", studentId: 33 }, dg)).skipped, "NO_COURSE");
});
test("tenant isolation: an event for tenant A uses only A's pool; tenant B's pool is never touched; unknown tenant fails without sending", async () => {
  const a = makeMockPool([SETTINGS(), ANN(ann()), ["FROM lms_course_enrolments", (i) => (i.last === 0 ? rows(1, 1) : [])]]), b = makeMockPool([SETTINGS(), ANN(ann())]);
  const d = deps({ A: a, B: b }); await N.handle(evt({ tenant: "A" }), d);
  assert.strictEqual(b.log.length, 0); assert.ok(a.log.length > 0); assert.ok(d.sent.every((x) => x.pool === a.pool));
  await assert.rejects(() => N.handle(evt({ tenant: "ZZ" }), d)); assert.strictEqual(d.sent.length, 1);
});
test("register(): events on the bus reach the handlers; unknown events and failing handlers never break the emitter; unsubscribe stops delivery", async () => {
  const m = makeMockPool([SETTINGS(), ANN(ann()), ["FROM lms_course_enrolments", (i) => (i.last === 0 ? rows(7, 1) : [])]]); const d = deps({ regT: m }); const results = [];
  const off = N.register({ ...d, onResult: (e, r) => { if (e.tenant === "regT") results.push(r); } });
  assert.strictEqual(events.emit("lms.announcement.published", { tenant: "regT", courseId: 5, announcementId: 8 }), true);
  assert.strictEqual(events.emit("lms.lesson.completed", { tenant: "regT", courseId: 5 }), true);
  await tick(); assert.deepStrictEqual(results.map((r) => r.sent), [1]); assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(events.emit("lms.announcement.published", { tenant: "missing", courseId: 5, announcementId: 8 }), true); await tick();
  off(); events.emit("lms.announcement.published", { tenant: "regT", courseId: 5, announcementId: 8 }); await tick(); assert.strictEqual(d.sent.length, 1);
});
test("settings: notifications.inApp must be boolean; unknown keys refused; merged and saved like other nested settings", () => {
  assert.deepStrictEqual(S.validateSettingsPatch({ notifications: { inApp: false } }).value, { notifications: { inApp: false } });
  for (const bad of [{ notifications: { inApp: "no" } }, { notifications: { sms: true } }, { notifications: true }]) assert.strictEqual(S.validateSettingsPatch(bad).ok, false);
  assert.strictEqual(S.mergeSettings([{ setting_key: "notifications", value_json: "{\"inApp\":false}" }]).notifications.inApp, false);
});

/* ---- grade released notice (A61 follow-up) ---- */
const GREL = (x) => ["FROM lms_submission_grades g JOIN lms_assignments a ON a.id = g.assignment_id JOIN lms_courses c", () => (x === null ? [] : [x || { assignment_title: "Essay 1", course_title: "Biology F3" }])];
const gevt = (o) => ({ event: "lms.grade.released", tenant: "t1", courseId: 5, assignmentId: 4, submissionId: 31, studentId: 21, ...o });
test("grade released: ONE in-app notice to THAT student only; no mark or comment in the text; link to the course; query matches grade, assignment, course AND student, status returned, course published", async () => {
  const m = makeMockPool([SETTINGS(), GREL()]); const d = deps({ t1: m }); const r = await N.handle(gevt(), d);
  assert.strictEqual(r.sent, 1); assert.strictEqual(d.sent.length, 1); assert.deepStrictEqual(d.sent[0].rec, [{ id: 21, source: "Students" }]);
  const o = d.sent[0].opts; assert.strictEqual(o.type, "lms_grade"); assert.strictEqual(o.title, "Feedback returned: Essay 1"); assert.strictEqual(o.link, "/student/courses/5/learn"); assert.ok(!/\d+\s*\/\s*\d+|points|marks?:/i.test(o.message.replace("your mark and feedback", "")), "no score in the notice");
  const q = m.log.find((x) => /lms_submission_grades g JOIN/.test(x.sql)); assert.ok(/g\.submission_id = @sub AND g\.assignment_id = @a AND g\.course_id = @c AND g\.student_id = @s AND g\.status = 'returned'/.test(q.sql) && /c\.status = 'published'/.test(q.sql) && /a\.deleted_at IS NULL/.test(q.sql));
  assert.deepStrictEqual([q.inputs.sub, q.inputs.a, q.inputs.c, q.inputs.s], [31, 4, 5, 21]); assert.ok(!/\b(31|21)\b/.test(q.sql.replace(/@\w+/g, "")));
});
test("grade released: nothing sent when the grade is not (or no longer) returned / course unpublished / ids bad / no licence / setting off; never throws on a bad event", async () => {
  const none = makeMockPool([SETTINGS(), GREL(null)]); const d = deps({ t1: none }); assert.deepStrictEqual([(await N.handle(gevt(), d)).skipped, d.sent.length], ["NOT_CURRENT", 0]);
  for (const bad of [{ courseId: null }, { assignmentId: 0 }, { submissionId: "x" }, { studentId: -1 }, { studentId: 1.5 }]) { const m = makeMockPool([SETTINGS(), GREL()]); const dd = deps({ t1: m }); const r = await N.handle(gevt(bad), dd); assert.deepStrictEqual([r.skipped, dd.sent.length], ["BAD_EVENT", 0], JSON.stringify(bad)); assert.ok(!m.log.some((x) => /lms_submission_grades/.test(x.sql))); }
  const nl = makeMockPool([]); const dn = deps({ t1: nl }, { active: false }); assert.strictEqual((await N.handle(gevt(), dn)).skipped, "NO_LICENCE"); assert.strictEqual(nl.log.length, 0);
  const off = makeMockPool([SETTINGS({ inApp: false }), GREL()]); const doff = deps({ t1: off }); assert.strictEqual((await N.handle(gevt(), doff)).skipped, "DISABLED"); assert.ok(!off.log.some((x) => /lms_submission_grades/.test(x.sql)));
});
test("grade released: wired on the real bus via register(); another school's pool is never used (tenant comes from the event)", async () => {
  const a = makeMockPool([SETTINGS(), GREL()]), b = makeMockPool([SETTINGS(), GREL()]); const d = deps({ gA: a, gB: b }); const res = [];
  const off = N.register({ getPool: d.getPool, notify: d.notify, isActive: d.isActive, onResult: (e, r) => { if (e.tenant === "gA") res.push(r); } });
  events.emit("lms.grade.released", { tenant: "gA", courseId: 5, assignmentId: 4, submissionId: 31, studentId: 21 }); await tick(); await tick(); off();
  assert.deepStrictEqual(res.map((r) => r.sent), [1]); assert.strictEqual(b.log.length, 0, "school B untouched"); assert.ok(d.sent.length >= 1);
});

/* ---- extension granted notice (A65 follow-up) ---- */
const XQ = (x) => ["FROM lms_extensions x JOIN lms_assignments a ON a.id = x.assignment_id", () => (x === null ? [] : [x || { assignment_title: "Essay 1", course_title: "Biology F3", due_at: "2026-11-25T11:00:00Z" }])];
const xevt = (o) => ({ event: "lms.extension.granted", tenant: "t1", courseId: 5, assignmentId: 4, studentId: 21, ...o });
test("extension granted: ONE in-app notice to THAT student with the new due date; no reason text; query still requires the extension row, published assignment and course", async () => {
  const m = makeMockPool([SETTINGS(), XQ()]); const d = deps({ t1: m }); const r = await N.handle(xevt(), d);
  assert.strictEqual(r.sent, 1); assert.deepStrictEqual(d.sent[0].rec, [{ id: 21, source: "Students" }]); const o = d.sent[0].opts;
  assert.deepStrictEqual([o.type, o.title, o.link], ["lms_extension", "More time: Essay 1", "/student/courses/5/learn"]); assert.ok(o.message.includes("2026-11-25 11:00 UTC"));
  const q = m.log.find((x) => /FROM lms_extensions x JOIN/.test(x.sql)); assert.ok(/x\.assignment_id = @a AND x\.course_id = @c AND x\.student_id = @s/.test(q.sql) && /a\.status = 'published'/.test(q.sql) && /c\.status = 'published'/.test(q.sql) && !/reason/.test(q.sql));
  assert.deepStrictEqual([q.inputs.a, q.inputs.c, q.inputs.s], [4, 5, 21]);
});
test("extension granted: nothing sent when revoked meanwhile / bad ids / no licence / setting off / bad date", async () => {
  const none = makeMockPool([SETTINGS(), XQ(null)]); const d = deps({ t1: none }); assert.deepStrictEqual([(await N.handle(xevt(), d)).skipped, d.sent.length], ["NOT_CURRENT", 0]);
  for (const bad of [{ courseId: null }, { assignmentId: 0 }, { studentId: -1 }, { studentId: "x" }]) { const m = makeMockPool([SETTINGS(), XQ()]); const dd = deps({ t1: m }); assert.strictEqual((await N.handle(xevt(bad), dd)).skipped, "BAD_EVENT"); assert.ok(!m.log.some((x) => /lms_extensions/.test(x.sql))); }
  const nl = makeMockPool([]); assert.strictEqual((await N.handle(xevt(), deps({ t1: nl }, { active: false }))).skipped, "NO_LICENCE"); assert.strictEqual(nl.log.length, 0);
  const off = makeMockPool([SETTINGS({ inApp: false }), XQ()]); assert.strictEqual((await N.handle(xevt(), deps({ t1: off }))).skipped, "DISABLED");
  const bd = makeMockPool([SETTINGS(), XQ({ assignment_title: "A", course_title: "B", due_at: "garbage" })]); assert.strictEqual((await N.handle(xevt(), deps({ t1: bd }))).skipped, "NOT_CURRENT");
});
test("extension granted: wired on the real bus; tenant comes from the event so another school's pool is untouched", async () => {
  const a = makeMockPool([SETTINGS(), XQ()]), b = makeMockPool([SETTINGS(), XQ()]); const d = deps({ xA: a, xB: b }); const res = [];
  const off = N.register({ getPool: d.getPool, notify: d.notify, isActive: d.isActive, onResult: (e, r) => { if (e.tenant === "xA") res.push(r); } });
  events.emit("lms.extension.granted", { tenant: "xA", courseId: 5, assignmentId: 4, studentId: 21 }); await tick(); await tick(); off();
  assert.deepStrictEqual(res.map((r) => r.sent), [1]); assert.strictEqual(b.log.length, 0);
});

/* ---- quiz graded notice (Q46 = yes, S34) ---- */
const QG = (x) => ["FROM lms_quiz_attempts t JOIN lms_quizzes z ON z.id = t.quiz_id", () => (x === null ? [] : [x || { quiz_title: "Quiz 1", course_title: "Biology F3" }])];
const qevt = (o) => ({ event: "lms.quiz.graded", tenant: "t1", courseId: 5, quizId: 4, attemptId: 70, studentId: 21, manual: true, ...o });
test("quiz graded (Q46): ONE in-app notice to THAT student when a teacher finished marking; names only, NO score or comment; query requires graded attempt of that student/quiz/course, published quiz and course", async () => {
  const m = makeMockPool([SETTINGS(), QG()]); const d = deps({ t1: m }); const r = await N.handle(qevt(), d);
  assert.strictEqual(r.sent, 1); assert.deepStrictEqual(d.sent[0].rec, [{ id: 21, source: "Students" }]);
  const o = d.sent[0].opts; assert.deepStrictEqual([o.type, o.title, o.link], ["lms_quiz", "Quiz marked: Quiz 1", "/student/courses/5/learn"]); assert.ok(!/\d+(\.\d+)?\s*\/\s*\d+|points|score/i.test(o.message), "no mark in the notice");
  const q = m.log.find((x) => /FROM lms_quiz_attempts t JOIN/.test(x.sql)); assert.ok(/t\.id = @at AND t\.quiz_id = @z AND t\.course_id = @c AND t\.student_id = @s AND t\.status = 'graded'/.test(q.sql) && /z\.status = 'published'/.test(q.sql) && /c\.status = 'published'/.test(q.sql));
});
test("quiz graded (Q46): no notice for an auto-graded submit (no manual flag), a changed attempt, bad ids, no licence, setting off", async () => {
  const auto = deps({ t1: makeMockPool([SETTINGS(), QG()]) }); const a = await N.handle(qevt({ manual: undefined }), auto); assert.deepStrictEqual([a.sent, a.skipped, auto.sent.length], [0, "NOT_MANUAL", 0]);
  const gone = deps({ t1: makeMockPool([SETTINGS(), QG(null)]) }); assert.deepStrictEqual([(await N.handle(qevt(), gone)).skipped, gone.sent.length], ["NOT_CURRENT", 0]);
  for (const bad of [{ courseId: null }, { quizId: 0 }, { attemptId: "x" }, { studentId: -1 }]) { const d = deps({ t1: makeMockPool([SETTINGS(), QG()]) }); assert.strictEqual((await N.handle(qevt(bad), d)).skipped, "BAD_EVENT"); assert.strictEqual(d.sent.length, 0); }
  const nl = deps({ t1: makeMockPool([SETTINGS(), QG()]) }, { active: false }); assert.strictEqual((await N.handle(qevt(), nl)).skipped, "NO_LICENCE");
  const off = deps({ t1: makeMockPool([SETTINGS({ inApp: false }), QG()]) }); assert.strictEqual((await N.handle(qevt(), off)).skipped, "DISABLED");
});
