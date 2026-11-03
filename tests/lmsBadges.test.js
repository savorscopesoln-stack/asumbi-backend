/* L7.5b - course badges (D-092): validation, three transparent rules (hand-calculated), explicit idempotent award, edit/remove keep awards, learner view, schema 033, route gates.
   Mocked pool only: SQL (OPENJSON insert, UNIQUE(badge, learner), OUTPUT, subquery cap) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsBadges.test.js");
const B = require("../utils/lmsBadges"), P = require("../utils/lmsPermissions"), events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" };
const CATS = [{ id: 1, weight: 100, drop_lowest: 0 }], ITEMS = [{ id: 1, category_id: 1, max_points: 50, weight: 1 }, { id: 2, category_id: 1, max_points: 100, weight: 1 }];
// 30: 3/3 lessons, 65% (eligible). 31: 2/3 lessons, 100%. 32: 3/3, no grades. 33: 3/3, learner view 20% (T2 100 is hidden). 34: 3/3, 100%.
const DONE = [{ student_id: 30, n: 3 }, { student_id: 31, n: 2 }, { student_id: 32, n: 3 }, { student_id: 33, n: 3 }, { student_id: 34, n: 3 }];
const GR = [{ item_id: 1, student_id: 30, points: 40, excused: 0, hidden: 0 }, { item_id: 2, student_id: 30, points: 50, excused: 0, hidden: 0 }, { item_id: 1, student_id: 31, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 31, points: 100, excused: 0, hidden: 0 },
  { item_id: 1, student_id: 33, points: 10, excused: 0, hidden: 0 }, { item_id: 2, student_id: 33, points: 100, excused: 0, hidden: 1 }, { item_id: 1, student_id: 34, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 34, points: 100, excused: 0, hidden: 0 }];
const BADGES = [{ id: 1, name: "Finisher", rule_type: "course_complete", rule_value: null }, { id: 2, name: "Top 90", rule_type: "grade_at_least", rule_value: 90 }, { id: 3, name: "Reader", rule_type: "lessons_completed", rule_value: 3 }];
const world = (o = {}, extra = []) => makeMockPool([
  ["SELECT TOP 1 id, title, status FROM lms_courses", (i) => (i.c === 5 && o.course !== null ? [o.course || { id: 5, title: "Maths F3", status: "published" }] : [])],
  ["FROM lms_grade_categories", () => CATS], ["FROM lms_grade_items WHERE course_id = @c", () => ITEMS], ["FROM lms_course_enrolments WHERE course_id = @c", () => [30, 31, 32, 33, 34].map((s) => ({ student_id: s }))],
  ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 3 }]], ["FROM lms_lesson_progress p", () => DONE], ["FROM lms_grades g JOIN lms_grade_items i", () => GR], ["FROM GradingSystem", () => []],
  ["FROM lms_badges WHERE course_id = @c AND deleted_at IS NULL AND active = 1", (i) => (o.badges || BADGES).filter((b) => i.b === undefined || b.id === i.b)],
  ["FROM lms_badge_awards WHERE course_id = @c", () => (o.owned || [{ badge_id: 1, student_id: 34 }])],
  ["INSERT INTO lms_badge_awards", () => [{ inserted: o.inserted ?? 7 }]], ...extra]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const writeOf = (m) => m.log.find((x) => /INSERT INTO lms_badge_awards/.test(x.sql));

test("validateBadge (pure): create needs name + ONE valid rule; edit only name/description/active; the rule cannot change; text is cleaned", () => {
  const ok = (b, e) => B.validateBadge(b, e); const bad = (b, e) => { const r = B.validateBadge(b, e); assert.strictEqual(r.ok, false, JSON.stringify(b)); return r.errors.join(" "); };
  assert.deepStrictEqual(ok({ name: " <b>Finisher</b> ", ruleType: "course_complete" }).value, { name: "bFinisher/b", ruleType: "course_complete", ruleValue: null });
  assert.deepStrictEqual(ok({ name: "A", description: "d", ruleType: "grade_at_least", ruleValue: 100 }).value, { name: "A", description: "d", ruleType: "grade_at_least", ruleValue: 100 });
  assert.strictEqual(ok({ name: "A", ruleType: "lessons_completed", ruleValue: 500 }).ok, true);
  for (const b of [{ ruleType: "course_complete" }, { name: "", ruleType: "course_complete" }, { name: "x".repeat(101), ruleType: "course_complete" }, { name: "A" }, { name: "A", ruleType: "magic" }, { name: "A", ruleType: "course_complete", ruleValue: 5 },
    { name: "A", ruleType: "grade_at_least" }, { name: "A", ruleType: "grade_at_least", ruleValue: 0 }, { name: "A", ruleType: "grade_at_least", ruleValue: 101 }, { name: "A", ruleType: "grade_at_least", ruleValue: 50.5 }, { name: "A", ruleType: "grade_at_least", ruleValue: "50" },
    { name: "A", ruleType: "lessons_completed", ruleValue: 501 }, { name: "A", ruleType: "course_complete", description: "x".repeat(301) }, { name: "A", ruleType: "course_complete", extra: 1 }, null, [], "x"]) bad(b);
  assert.ok(/cannot be changed/.test(bad({ ruleType: "course_complete" }, true)) && /cannot be changed/.test(bad({ ruleValue: 5 }, true)));
  assert.deepStrictEqual(ok({ active: false }, true).value, { active: false }); assert.deepStrictEqual(ok({ name: "N", description: null }, true).value, { name: "N", description: null });
  bad({}, true); bad({ active: "no" }, true); bad({ name: "" }, true);
});

test("meets (pure): the three rules, boundaries and missing data", () => {
  const L = (o) => ({ eligible: false, percent: 80, lessonsDone: 4, ...o });
  assert.deepStrictEqual([B.meets({ ruleType: "course_complete" }, L({ eligible: true })), B.meets({ ruleType: "course_complete" }, L({}))], [true, false]);
  assert.deepStrictEqual([90, 89.99, 91].map((p) => B.meets({ ruleType: "grade_at_least", ruleValue: 90 }, L({ percent: p }))), [true, false, true]);
  assert.strictEqual(B.meets({ ruleType: "grade_at_least", ruleValue: 1 }, L({ percent: null })), false, "no grades never earns a grade badge");
  assert.deepStrictEqual([3, 2].map((n) => B.meets({ ruleType: "lessons_completed", ruleValue: 3 }, L({ lessonsDone: n }))), [true, false]); assert.strictEqual(B.meets({ ruleType: "nope" }, L({ eligible: true })), false);
});

test("award dry run + award: hand-calculated per badge, existing awards skipped, ONE atomic batch, learner-view numbers, audited, event; nothing for inactive/removed badges", async () => {
  const d = world(); const r = await B.awardBadges(d.pool, teacher, 5, { dryRun: true }); assert.ok(r.ok, JSON.stringify(r));
  // Finisher: eligible 30 and 34, 34 already owns it -> [30]. Top 90: 31 and 34 -> 2. Reader (3 lessons): 30, 32, 33, 34 -> 4. Learner 33's hidden T2 does not count (20%).
  assert.deepStrictEqual([r.dryRun, r.wouldAward, r.badges.map((b) => b.wouldAward)], [true, 7, [1, 2, 4]]); assert.ok(!writeOf(d) && audits(d).length === 0);
  const m = world(); const got = []; const off = events.on("lms.badge.awarded", (p) => got.push(p)); const a = await B.awardBadges(m.pool, teacher, 5, {}, { tenant: "tBadge" }); await tick();
  assert.deepStrictEqual([a.awarded, a.badges.map((b) => b.wouldAward)], [7, [1, 2, 4]]);
  const w = writeOf(m); const rows = JSON.parse(w.inputs.rows); assert.deepStrictEqual(rows.map((x) => `${x.b}:${x.s}`), ["1:30", "2:31", "2:34", "3:30", "3:32", "3:33", "3:34"]); assert.deepStrictEqual([w.inputs.c, w.inputs.src, w.inputs.uid], [5, "Teachers", 7]);
  assert.ok(/UPDLOCK, HOLDLOCK/.test(w.sql) && /NOT EXISTS \(SELECT 1 FROM lms_badge_awards x/.test(w.sql) && /bb\.deleted_at IS NULL AND bb\.active = 1/.test(w.sql) && /XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && !/DELETE FROM/.test(w.sql));
  assert.ok(/active = 1/.test(m.log.find((x) => /FROM lms_badges WHERE/.test(x.sql)).sql) && /course_id = @c/.test(m.log.find((x) => /FROM lms_badge_awards WHERE/.test(x.sql)).sql));
  assert.ok(/badge\.awarded/.test(JSON.stringify(audits(m)[0].inputs))); const mine = got.filter((p) => p.tenant === "tBadge"); assert.deepStrictEqual([mine.length, mine[0].courseId, mine[0].count], [1, 5, 7]); assert.ok(!/name|student/i.test(Object.keys(mine[0]).join(",")), "ids and counts only"); off();
  const all = world({ owned: [1, 2, 3].flatMap((b) => [30, 31, 32, 33, 34].map((s) => ({ badge_id: b, student_id: s }))) }); const again = await B.awardBadges(all.pool, teacher, 5, {}); assert.strictEqual(again.awarded, 0); assert.ok(!writeOf(all) && audits(all).length === 0, "nothing new = no write");
  const raced = await B.awardBadges(world({ inserted: 3 }).pool, teacher, 5, {}); assert.strictEqual(raced.awarded, 3, "reports what the batch really inserted");
  const none = await B.awardBadges(world({ badges: [] }).pool, teacher, 5, {}); assert.deepStrictEqual([none.ok, none.awarded], [true, 0]);
  const one = world(); const o = await B.awardBadges(one.pool, teacher, 5, { badgeId: 2 }); assert.deepStrictEqual([o.awarded, one.log.find((x) => /FROM lms_badges WHERE/.test(x.sql)).inputs.b, JSON.parse(writeOf(one).inputs.rows).every((x) => x.b === 2)], [7, 2, true]);
  assert.strictEqual((await B.awardBadges(world().pool, teacher, 5, { badgeId: 99 })).notFound, true);
});

test("award refusals: draft course, bad body, students, other course/tenant; nothing written", async () => {
  const d = world({ course: { id: 5, title: "x", status: "draft" } }); assert.strictEqual((await B.awardBadges(d.pool, teacher, 5, {})).code, "COURSE_NOT_PUBLISHED"); assert.ok(!writeOf(d));
  for (const b of [[], "x", { dryRun: "yes" }, { badgeId: 0 }, { badgeId: "a" }, { all: true }]) { const m = world(); assert.strictEqual((await B.awardBadges(m.pool, teacher, 5, b)).ok, false); assert.strictEqual(m.log.length, 0, JSON.stringify(b)); }
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const m = world(); assert.strictEqual((await B.awardBadges(m.pool, u, id, {})).notFound, true); assert.ok(!writeOf(m)); }
  const T = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await B.awardBadges(T.A.pool, teacher, 5, {})).notFound, true); T.assertUntouched("B");
});

test("create / edit / remove / list: capped at 20 in the same statement, course scoped, soft delete (awards kept), audited; list shows award counts", async () => {
  const mk = (rows) => makeMockPool([["SELECT TOP 1 id FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5 }] : [])], ["INSERT INTO lms_badges (course_id", () => rows], ["UPDATE lms_badges SET name", (i) => (i.c === 5 && i.i === 9 ? [{ id: 9 }] : [])], ["UPDATE lms_badges SET deleted_at", (i) => (i.c === 5 && i.i === 9 ? [{ id: 9 }] : [])],
    ["FROM lms_badges b WHERE b.course_id = @c", () => [{ id: 9, name: "Finisher", description: null, rule_type: "course_complete", rule_value: null, active: 1, awarded: 4 }]]]);
  const m = mk([{ id: 9 }]); const c = await B.createBadge(m.pool, teacher, 5, { name: "Finisher", ruleType: "grade_at_least", ruleValue: 75 }); assert.deepStrictEqual([c.ok, c.id, c.badge.ruleValue, c.badge.awarded], [true, 9, 75, 0]);
  const ins = m.log.find((x) => /INSERT INTO lms_badges/.test(x.sql)); assert.ok(/SELECT COUNT\(\*\) FROM lms_badges WHERE course_id = @c AND deleted_at IS NULL\) < @max/.test(ins.sql) && ins.inputs.max === 20 && ins.inputs.c === 5 && ins.inputs.v === 75); assert.ok(/badge\.created/.test(JSON.stringify(audits(m)[0].inputs)));
  const full = mk([]); const f = await B.createBadge(full.pool, teacher, 5, { name: "x", ruleType: "course_complete" }); assert.deepStrictEqual([f.ok, f.code], [false, "BADGE_LIMIT"]); assert.strictEqual(audits(full).length, 0);
  assert.strictEqual((await B.createBadge(mk([{ id: 1 }]).pool, teacher, 6, { name: "x", ruleType: "course_complete" })).notFound, true);
  const e = mk([]); assert.strictEqual((await B.updateBadge(e.pool, teacher, 5, 9, { name: "New", active: false })).ok, true); const u = e.log.find((x) => /UPDATE lms_badges SET name/.test(x.sql));
  assert.ok(/name = @n, active = @a/.test(u.sql) && /course_id = @c AND deleted_at IS NULL/.test(u.sql) && !/rule_/.test(u.sql), "only the editable fields, this course only");
  assert.strictEqual((await B.updateBadge(e.pool, teacher, 5, 8, { name: "x" })).notFound, true); assert.strictEqual((await B.updateBadge(e.pool, teacher, 5, 9, { ruleType: "course_complete" })).ok, false);
  const rm = mk([]); assert.deepStrictEqual([(await B.removeBadge(rm.pool, teacher, 5, 9)).removed, (await B.removeBadge(rm.pool, teacher, 5, 8)).notFound], [true, true]);
  assert.ok(/deleted_at = SYSUTCDATETIME\(\)/.test(rm.log[0].sql) && !/DELETE FROM|lms_badge_awards/.test(rm.log[0].sql), "soft delete: awards untouched");
  const l = await B.listBadges(mk([]).pool, 5); assert.deepStrictEqual([l.items[0].awarded, l.items[0].ruleType, l.items.length], [4, "course_complete", 1]);
  for (const u2 of [student, null]) for (const fn of [() => B.createBadge(mk([]).pool, u2, 5, { name: "x", ruleType: "course_complete" }), () => B.updateBadge(mk([]).pool, u2, 5, 9, { name: "x" }), () => B.removeBadge(mk([]).pool, u2, 5, 9)]) assert.strictEqual((await fn()).notFound, true);
});

test("my badges: only this learner's awards in this course (id from the token), removed badges hidden, no staff fields; staff are refused", async () => {
  const m = makeMockPool([["FROM lms_badge_awards a JOIN lms_badges b", (i) => (i.c === 5 && i.s === 30 ? [{ id: 1, name: "Finisher", description: "d", awarded_at: "2026-11-01T10:00:00Z" }] : [])]]);
  const r = await B.myBadges(m.pool, student, 5); assert.deepStrictEqual([r.items.length, r.items[0].name, r.items[0].awardedAt], [1, "Finisher", "2026-11-01T10:00:00.000Z"]);
  assert.ok(/b\.deleted_at IS NULL/.test(m.log[0].sql) && /a\.course_id = @c AND a\.student_id = @s/.test(m.log[0].sql) && !/awarded_by|student_id/.test(JSON.stringify(r)));
  assert.deepStrictEqual((await B.myBadges(m.pool, student, 6)).items, []);
  for (const u of [teacher, null, { id: 30, role: "teacher", source: "Students" }]) assert.strictEqual((await B.myBadges(m.pool, u, 5)).notFound, true);
});

test("schema step 033: additive, two tables, UNIQUE (badge, learner), blocked from the record editor, event registered; step order 031 -> 032 -> 033", () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("033_lms_badges");
  assert.ok(i === ids.length - 13 && ids[i + 1] === "034_lms_discussions" && ids[i + 2] === "035_lms_groups" && ids[i + 3] === "036_lms_group_forums" && ids[i + 4] === "037_lms_peer_review" && ids[i - 1] === "032_lms_certificates" && ids[i - 2] === "031_lms_gradebook");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/name='lms_badges'/.test(t) && /name='lms_badge_awards'/.test(t) && !/DROP |DELETE |ALTER TABLE [a-z_]+ DROP/i.test(t) && /UX_lms_badge_awards_badge_student ON lms_badge_awards \(badge_id, student_id\)/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_badges", "lms_badge_awards"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
  assert.ok(events.on("lms.badge.awarded", () => {}) instanceof Function);
});

test("routes: flag gate + permission + course access + handler for each; list needs gradebook.view, the rest course.manage; learner route studentOnly; 201 on create; shapes", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), GB = "/courses/:courseId/gradebook";
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const rs = [["get", `${GB}/badges`], ["post", `${GB}/badges`], ["post", `${GB}/badges/award`], ["patch", `${GB}/badges/:badgeId`], ["delete", `${GB}/badges/:badgeId`], ["get", "/courses/:courseId/learn/badges"]].map(([m, p]) => find(m, p));
  assert.ok(rs.every(Boolean)); for (const r of rs) assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/badges`, gbGate, gbView, staffAccess/.test(src) && (src.match(/badges(\/award|\/:badgeId)?`, gbGate, gbManage, staffAccess/g) || []).length === 4 && /learn\/badges", gbGate, studentOnly, studentAccess/.test(src));
  assert.ok(P.roleDefaults({ role: "teacher" }).includes("lms.course.manage") && !P.roleDefaults({ role: "student" }).includes("lms.course.manage"));
  const world2 = () => makeMockPool([["SELECT TOP 1 id FROM lms_courses WHERE id", () => [{ id: 5 }]], ["INSERT INTO lms_badges (course_id", () => [{ id: 9 }]]]);
  const res = makeRes(); await rs[1].route.stack[3].handle({ pool: world2().pool, user: teacher, params: { courseId: "5" }, body: { name: "F", ruleType: "course_complete" }, tenant: "t" }, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.id, "ok" in res.body], [201, true, 9, false]);
  const r2 = makeRes(); await rs[1].route.stack[3].handle({ pool: world2().pool, user: teacher, params: { courseId: "5" }, body: { name: "F" }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 400);
  const r3 = makeRes(); await rs[3].route.stack[3].handle({ pool: world2().pool, user: teacher, params: { courseId: "5", badgeId: "abc" }, body: { name: "x" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); r4.setHeader = () => {}; await rs[2].route.stack[3].handle({ pool: world({ course: { id: 5, title: "x", status: "draft" } }).pool, user: teacher, params: { courseId: "5" }, body: {}, tenant: "t" }, r4); assert.deepStrictEqual([r4.statusCode, r4.body.code], [409, "COURSE_NOT_PUBLISHED"]);
});
