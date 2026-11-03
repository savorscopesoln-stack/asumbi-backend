/* L5.1a — assignment definitions (no submissions yet). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsAssignments.test.js");
const A = require("../utils/lmsAssignments");
const planner = require("../utils/lmsPlanner");
const { on } = require("../utils/lmsEvents");

const admin = { id: 1, role: "admin", source: "Users" }, teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const NOW = new Date("2026-10-29T08:00:00Z");
const S = { lateSubmission: "accept", latePenaltyPercent: 10, files: { allowedExtensions: ["pdf", "docx", "jpg", "png"], maxFileMb: 10 } };
const D = (s) => new Date(s);
const row = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Essay 1", instructions: "Write 500 words.", status: "draft", published_at: null, available_from: null, due_at: D("2026-11-10T14:00:00Z"), cutoff_at: null,
  submission_type: "both", allowed_extensions: null, max_file_mb: null, max_files: 5, max_attempts: 1, late_policy: null, late_penalty_percent: null, max_points: 100, work_mode: "individual", attachments_json: null, created_at: "x", updated_at: "x", ...o });
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_assignments", () => [{ n }]];
const SEC = (ids) => ["FROM lms_course_sections WHERE id", onlyIds("c", ids, [{ id: 3 }])];
const INS = ["INSERT INTO lms_assignments", (i) => [row({ id: 8, title: i.t, status: i.st })]];
const LOAD = (r) => ["FROM lms_assignments WHERE id = @id", (i) => (r && i.id === r.id && i.c === r.course_id ? [r] : [])];
const OWN = /^(INSERT INTO lms_assignments|UPDATE lms_assignments)/, writes = (log) => log.filter((x) => OWN.test(x.sql));
const events = (tenant) => { const got = []; const off = on("lms.assignment.published", (e) => { if (e.tenant === tenant) got.push(e); }); return { got, off }; };
const opts = (tenant = "asgT") => ({ tenant, settings: S, now: NOW });
const V = (b, o = {}) => A.validate(b, { tenant: "t1", now: NOW, ...o });

test("validate: normalises text, dates need an ISO time zone, numbers are bounded, group work accepted at validation (rules in check), other modes refused, unknown fields refused, partial needs a field", () => {
  const ok = V({ title: " <b>Essay</b> ", instructions: "Line 1\r\n\r\n\r\n\r\nLine 2 <script>", dueAt: "2026-11-10T17:00:00+03:00", availableFrom: "2026-11-01T00:00:00Z", submissionType: "files", allowedExtensions: [".PDF", "docx", "pdf"], maxFileMb: 5, maxFiles: 3, maxAttempts: 2, latePolicy: "penalise", latePenaltyPercent: 20, maxPoints: "50.5", workMode: "individual" });
  assert.ok(ok.ok, JSON.stringify(ok.errors)); const v = ok.value;
  assert.deepStrictEqual([v.title, v.instructions, v.allowedExtensions, v.maxPoints, v.maxFiles, v.latePolicy], ["bEssay/b", "Line 1\n\nLine 2 script", ["pdf", "docx"], 50.5, 3, "penalise"]);
  assert.strictEqual(v.dueAt.toISOString(), "2026-11-10T14:00:00.000Z");
  const bad = [{}, { title: "t" }, { title: "", instructions: "x" }, { title: "t", instructions: "x".repeat(8001) }, { title: "t", instructions: "i", dueAt: "2026-11-10" }, { title: "t", instructions: "i", dueAt: "2026-11-10T17:00:00" }, { title: "t", instructions: "i", dueAt: "1999-01-01T00:00:00Z" },
    { title: "t", instructions: "i", dueAt: "2031-01-01T00:00:00Z" }, { title: "t", instructions: "i", dueAt: 5 }, { title: "t", instructions: "i", submissionType: "audio" }, { title: "t", instructions: "i", maxFiles: 11 }, { title: "t", instructions: "i", maxAttempts: 0 },
    { title: "t", instructions: "i", maxPoints: 0 }, { title: "t", instructions: "i", maxPoints: 1000.01 }, { title: "t", instructions: "i", maxPoints: 10.123 }, { title: "t", instructions: "i", latePolicy: "ignore" }, { title: "t", instructions: "i", latePenaltyPercent: 101 },
    { title: "t", instructions: "i", workMode: "pair" }, { title: "t", instructions: "i", allowedExtensions: [] }, { title: "t", instructions: "i", allowedExtensions: ["pdf;rm"] }, { title: "t", instructions: "i", allowedExtensions: "pdf" },
    { title: "t", instructions: "i", status: "archived" }, { title: "t", instructions: "i", sectionId: "x" }, { title: "t", instructions: "i", course_id: 9 }, { title: "t", instructions: "i", published_at: "x" }, { title: "t", instructions: "i", created_by: 1 }, null, []];
  for (const b of bad) assert.strictEqual(V(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  assert.strictEqual(V({}, { partial: true }).ok, false); assert.strictEqual(V({ dueAt: null }, { partial: true }).value.dueAt, null); assert.strictEqual(V({ workMode: "group" }, { partial: true }).value.workMode, "group");
});
test("attachments: only files already in THIS school's lms folder; a neighbour school, traversal, query strings and plain links are refused; max 10", () => {
  const good = V({ attachments: [{ url: "/uploads/t1/lms/abc123.pdf", name: " Brief " }] }, { partial: true }); assert.deepStrictEqual(good.value.attachments, [{ url: "/uploads/t1/lms/abc123.pdf", name: "Brief" }]);
  for (const u of ["/uploads/t2/lms/abc.pdf", "/uploads/t1/lms/../x.pdf", "/uploads/t1/lms/a.pdf?x=1", "https://evil.example/a.pdf", "javascript:alert(1)", "/uploads/t1/other/a.pdf", "", null]) assert.strictEqual(V({ attachments: [{ url: u }] }, { partial: true }).ok, false, String(u));
  assert.strictEqual(V({ attachments: Array.from({ length: 11 }, () => ({ url: "/uploads/t1/lms/a.pdf" })) }, { partial: true }).ok, false); assert.strictEqual(V({ attachments: ["/uploads/t1/lms/a.pdf"] }, { partial: true }).ok, false);
  assert.deepStrictEqual(V({ attachments: [] }, { partial: true }).value.attachments, []);
});
test("check + effective: date order, block needs a due date and no cutoff, penalise needs a due date, school limits can only be narrowed; school defaults fill the gaps", () => {
  const m = (o) => ({ ...A.model(row()), ...o });
  assert.deepStrictEqual(A.check(m({}), S), []);
  assert.ok(A.check(m({ availableFrom: D("2026-11-11T00:00:00Z") }), S).length); assert.ok(A.check(m({ cutoffAt: D("2026-11-01T00:00:00Z") }), S).length); assert.ok(A.check(m({ dueAt: null, cutoffAt: D("2026-11-20T00:00:00Z") }), S).length);
  assert.ok(A.check(m({ latePolicy: "block", cutoffAt: D("2026-11-20T00:00:00Z") }), S).length); assert.ok(A.check(m({ latePolicy: "block", dueAt: null }), S).length); assert.ok(A.check(m({ latePolicy: "penalise", dueAt: null }), S).length);
  assert.ok(A.check(m({ allowedExtensions: ["pdf", "exe"] }), S)[0].includes("exe")); assert.ok(A.check(m({ maxFileMb: 11 }), S).length); assert.deepStrictEqual(A.check(m({ allowedExtensions: ["pdf"], maxFileMb: 10 }), S), []);
  assert.deepStrictEqual(A.check(m({ latePolicy: "block" }), { ...S, lateSubmission: "block" }), []);
  assert.ok(A.check(m({ dueAt: null }), { ...S, lateSubmission: "block" }).length, "school default block also needs a due date");
  const e = A.effectiveOf(m({}), S); assert.deepStrictEqual([e.latePolicy, e.latePenaltyPercent, e.allowedExtensions, e.maxFileMb], ["accept", null, S.files.allowedExtensions, 10]);
  const p = A.effectiveOf(m({ latePolicy: "penalise" }), S); assert.strictEqual(p.latePenaltyPercent, 10); assert.strictEqual(A.effectiveOf(m({ latePolicy: "penalise", latePenaltyPercent: 25 }), S).latePenaltyPercent, 25);
  const t = A.effectiveOf(m({ submissionType: "text", allowedExtensions: ["pdf"] }), S); assert.deepStrictEqual([t.allowedExtensions, t.maxFileMb], [[], null]);
  assert.strictEqual(A.effectiveOf(m({}), { ...S, lateSubmission: "block" }).latePolicy, "block");
});
test("create: draft is private and emits nothing; published sets published_at in SQL and emits ONE event; every value is a parameter; audited", async () => {
  const E = events("asgT1");
  const d = makeMockPool([live("draft"), COUNT(2), INS]); const a = await A.createAssignment(d.pool, teacher(), 5, { title: "Essay 1", instructions: "Write.", dueAt: "2026-11-10T14:00:00Z" }, opts("asgT1"));
  assert.ok(a.ok && a.assignment.status === "draft" && a.assignment.publishedAt === null && a.assignment.effective.latePolicy === "accept");
  const p = makeMockPool([live("published"), COUNT(2), INS]); const b = await A.createAssignment(p.pool, teacher(), 5, { title: "Essay 2", instructions: "Write more.", status: "published" }, opts("asgT1"));
  assert.ok(b.ok && b.assignment.status === "published"); const w = writes(p.log)[0];
  assert.ok(/CASE WHEN @st = 'published' THEN SYSUTCDATETIME\(\)/.test(w.sql) && !/Essay|Write/.test(w.sql) && w.inputs.c === 5 && w.inputs.t === "Essay 2" && w.inputs.sty === "both" && w.inputs.mf === 5 && w.inputs.ma === 1 && w.inputs.pts === 100 && w.inputs.wm === "individual");
  await tick(); E.off(); assert.deepStrictEqual(E.got.map((e) => [e.courseId, e.assignmentId]), [[5, 8]]); assert.ok(p.log.some((x) => /lms_audit_log/.test(x.sql)));
});
test("create: archived / pending course, foreign section, limit, invalid body and school-rule breaches write nothing", async () => {
  const body = { title: "t", instructions: "i" };
  for (const [st, code] of [["archived", "COURSE_ARCHIVED"], ["pending", "COURSE_PENDING"]]) { const m = makeMockPool([live(st), COUNT(0), INS]); const r = await A.createAssignment(m.pool, teacher(), 5, body, opts()); assert.deepStrictEqual([r.ok, r.code], [false, code]); assert.strictEqual(writes(m.log).length, 0); }
  const sec = makeMockPool([live(), SEC([99]), COUNT(0), INS]); const r1 = await A.createAssignment(sec.pool, teacher(), 5, { ...body, sectionId: 3 }, opts()); assert.strictEqual(r1.ok, false); assert.strictEqual(writes(sec.log).length, 0); assert.ok(/course_id = @c/.test(sec.log.find((x) => /lms_course_sections/.test(x.sql)).sql));
  const full = makeMockPool([live(), COUNT(A.MAX_PER_COURSE), INS]); assert.strictEqual((await A.createAssignment(full.pool, teacher(), 5, body, opts())).code, "ASSIGNMENT_LIMIT"); assert.strictEqual(writes(full.log).length, 0);
  for (const b of [{ title: "" }, { ...body, allowedExtensions: ["exe"] }, { ...body, maxFileMb: 50 }, { ...body, latePolicy: "block" }, { ...body, dueAt: "2026-11-10T14:00:00Z", availableFrom: "2026-12-01T00:00:00Z" }]) { const m = makeMockPool([live(), COUNT(0), INS]); const r = await A.createAssignment(m.pool, teacher(), 5, b, opts()); assert.strictEqual(r.ok, false, JSON.stringify(b)); assert.strictEqual(m.log.length, 0, "no query for invalid input: " + JSON.stringify(b)); }
});
test("update: nothing changed -> no write; rules are checked on the MERGED row; publishing emits once and keeps published_at; unpublishing keeps it; a row of another course is 'not found'", async () => {
  const E = events("asgT2");
  const same = makeMockPool([live(), LOAD(row())]); assert.ok((await A.updateAssignment(same.pool, teacher(), 5, 4, { title: "Essay 1", dueAt: "2026-11-10T14:00:00Z", allowedExtensions: null }, opts("asgT2"))).unchanged); assert.strictEqual(writes(same.log).length, 0);
  const clash = makeMockPool([live(), LOAD(row({ cutoff_at: D("2026-11-20T00:00:00Z") })), ["UPDATE lms_assignments SET", () => [row()]]]); const c = await A.updateAssignment(clash.pool, teacher(), 5, 4, { latePolicy: "block" }, opts("asgT2")); assert.strictEqual(c.ok, false); assert.strictEqual(writes(clash.log).length, 0);
  const m = makeMockPool([live(), LOAD(row()), ["UPDATE lms_assignments SET", () => [row({ status: "published", published_at: "now", max_points: 40 })]]]); const r = await A.updateAssignment(m.pool, teacher(), 5, 4, { status: "published", maxPoints: 40 }, opts("asgT2")); assert.ok(r.ok && r.assignment.status === "published" && r.assignment.maxPoints === 40);
  const w = writes(m.log)[0]; assert.ok(/status = @p_status, max_points = @p_max_points, published_at = COALESCE\(published_at, SYSUTCDATETIME\(\)\)/.test(w.sql) && /WHERE id = @id AND course_id = @c AND deleted_at IS NULL/.test(w.sql) && w.inputs.p_max_points === 40 && w.inputs.c === 5);
  const un = makeMockPool([live(), LOAD(row({ status: "published", published_at: "t0" })), ["UPDATE lms_assignments SET", () => [row()]]]); assert.ok((await A.updateAssignment(un.pool, teacher(), 5, 4, { status: "draft" }, opts("asgT2"))).ok); assert.ok(!/published_at/.test(writes(un.log)[0].sql.replace(/OUTPUT[\s\S]*WHERE/, "")));
  const other = makeMockPool([live(), LOAD(row({ course_id: 6 }))]); assert.strictEqual((await A.updateAssignment(other.pool, teacher(), 5, 4, { title: "x" }, opts("asgT2"))).notFound, true); assert.strictEqual(writes(other.log).length, 0);
  assert.ok(/FROM lms_assignments WHERE id = @id AND course_id = @c AND deleted_at IS NULL/.test(other.log.find((x) => /FROM lms_assignments WHERE id/.test(x.sql)).sql), "the lookup itself is scoped to the course");
  await tick(); E.off(); assert.strictEqual(E.got.length, 1);
  const ext = makeMockPool([live(), LOAD(row()), ["UPDATE lms_assignments SET", () => [row({ allowed_extensions: '["pdf"]' })]]]); await A.updateAssignment(ext.pool, teacher(), 5, 4, { allowedExtensions: ["pdf"], attachments: [] }, opts("asgT2")); assert.strictEqual(writes(ext.log)[0].inputs.p_allowed_extensions, '["pdf"]');
});
test("delete: soft delete only, course-scoped; archived course refused; missing -> not found", async () => {
  const m = makeMockPool([live(), ["UPDATE lms_assignments SET deleted_at", () => [{ id: 4 }]]]); assert.ok((await A.deleteAssignment(m.pool, teacher(), 5, 4)).ok);
  assert.ok(!m.log.some((x) => /DELETE FROM lms_assignments/.test(x.sql)) && /course_id = @c AND deleted_at IS NULL/.test(writes(m.log)[0].sql));
  assert.strictEqual((await A.deleteAssignment(makeMockPool([live(), ["UPDATE lms_assignments SET deleted_at", () => []]]).pool, teacher(), 5, 4)).notFound, true);
  const ar = makeMockPool([live("archived")]); assert.strictEqual((await A.deleteAssignment(ar.pool, teacher(), 5, 4)).code, "COURSE_ARCHIVED"); assert.strictEqual(writes(ar.log).length, 0);
});
test("staff list: course-scoped, deleted rows excluded, page size capped at 100, optional status filter is a parameter; unknown status ignored", async () => {
  const m = makeMockPool([["FROM lms_assignments WHERE course_id = @c AND deleted_at IS NULL", () => [{ ...row(), total_count: 31 }]]]);
  const r = await A.listForStaff(m.pool, 5, { page: 2, pageSize: 500, status: "draft" }, S); assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items[0].title], [31, 2, 100, "Essay 1"]);
  const q = m.log[0]; assert.ok(/status = @st/.test(q.sql) && q.inputs.st === "draft" && q.inputs.off === 100 && q.inputs.c === 5 && !/draft/.test(q.sql));
  const n = makeMockPool([["FROM lms_assignments WHERE course_id", () => []]]); await A.listForStaff(n.pool, 5, { status: "x'; DROP" }, S); assert.ok(!/status = @st/.test(n.log[0].sql));
});
test("students: only published AND already-available rows of an open course; the answer has no status, authorship or timestamps; effective rules shown; hidden/missing -> not found", async () => {
  const m = makeMockPool([live(), ["FROM lms_assignments a WHERE a.course_id = @c", () => [{ ...row({ status: "published", late_policy: "penalise", late_penalty_percent: 15, attachments_json: '[{"url":"/uploads/t/lms/a.pdf","name":"A"}]', created_by: 7, created_by_source: "Teachers" }), total_count: 1 }]]]);
  const r = await A.listForStudentCourse(m.pool, 5, { pageSize: 1000 }, S); assert.ok(r.ok && r.items.length === 1); const it = r.items[0];
  for (const k of ["status", "publishedAt", "createdAt", "updatedAt", "createdBy", "created_by"]) assert.ok(!(k in it), k);
  assert.deepStrictEqual([it.effective.latePolicy, it.effective.latePenaltyPercent, it.attachments.length, it.title], ["penalise", 15, 1, "Essay 1"]);
  const sql = m.log[1].sql; assert.ok(/a\.status = 'published'/.test(sql) && /a\.deleted_at IS NULL/.test(sql) && /a\.available_from IS NULL OR a\.available_from <= SYSUTCDATETIME\(\)/.test(sql)); assert.strictEqual(m.log[1].inputs.lim, 100);
  assert.strictEqual((await A.listForStudentCourse(makeMockPool([["FROM lms_courses WHERE id", () => []]]).pool, 5, {}, S)).notFound, true);
  const one = makeMockPool([live(), ["FROM lms_assignments a WHERE a.id = @id", () => []]]); assert.strictEqual((await A.getForStudent(one.pool, 5, 4, S)).notFound, true); assert.ok(/a\.course_id = @c/.test(one.log[1].sql) && /a\.status = 'published'/.test(one.log[1].sql));
  const ok = makeMockPool([live(), ["FROM lms_assignments a WHERE a.id = @id", () => [row({ status: "published" })]]]); const g = await A.getForStudent(ok.pool, 5, 4, S); assert.ok(g.ok && !("status" in g.assignment));
});
test("planner source: due dates of published, already-available assignments only, in published courses the student is ACTIVELY enrolled in; student id is a parameter; items shaped for the calendar", async () => {
  const m = makeMockPool([["FROM lms_assignments a", () => [{ id: 4, course_id: 5, course_title: "Biology F3", title: "Essay 1", due_at: D("2026-11-10T14:00:00Z") }]]]);
  const r = await planner.getPlanner(m.pool, student(21), {}, NOW); assert.ok(r.ok); const it = r.items.find((x) => x.kind === "assignment_due");
  assert.deepStrictEqual([it.key, it.title, it.courseTitle, it.eventType, it.allDay, it.endsAt], ["assignment-4", "Due: Essay 1", "Biology F3", "assignment", false, null]);
  const q = m.log.find((x) => /FROM lms_assignments a/.test(x.sql)); assert.strictEqual(q.inputs.s, 21);
  assert.ok(/a\.status = 'published'/.test(q.sql) && /a\.deleted_at IS NULL/.test(q.sql) && /a\.due_at IS NOT NULL/.test(q.sql) && /a\.available_from IS NULL OR a\.available_from <= SYSUTCDATETIME\(\)/.test(q.sql) && /c\.status = 'published'/.test(q.sql) && /en\.student_id = @s AND en\.status = 'active'/.test(q.sql) && /TOP 500/.test(q.sql) && !/\b21\b/.test(q.sql));
  const ics = planner.toIcs(r.items, NOW); assert.ok(ics.includes("UID:assignment-4@doravo-lms") && ics.includes("SUMMARY:Due: Essay 1 (Biology F3)") && ics.includes("CATEGORIES:ASSIGNMENT"));
  const t = makeMockPool([["FROM lms_assignments a", () => [{ id: 1, course_id: 5, course_title: "x", title: "t", due_at: D("2026-11-10T14:00:00Z") }]]]); assert.strictEqual((await planner.getPlanner(t.pool, teacher(), {}, NOW)).ok, false); assert.strictEqual(t.log.length, 0);
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
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const enrolled = (ids) => ["FROM lms_course_enrolments WHERE course_id", onlyIds("c", ids, [{ status: "active" }])];
const AC = "/courses/:courseId/assignments", AI = "/courses/:courseId/assignments/:assignmentId";
test("routes: course staff write assignments (lms.course.manage); students, strangers and other courses get the same 403 and nothing is written", async () => {
  const mk = (role = "teacher") => makeMockPool([staff([5], role), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row()), ["FROM lms_assignments WHERE course_id = @c AND deleted_at IS NULL", () => [{ ...row(), total_count: 1 }]], ["UPDATE lms_assignments SET", () => [row({ title: "New" })]]]);
  const body = { title: "Essay", instructions: "Write." };
  for (const role of ["teacher", "co_teacher"]) { const r = await call("post", AC, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body }); assert.strictEqual(r.res.statusCode, 201, role); }
  assert.strictEqual((await call("get", AC, { user: teacher(), pool: mk().pool, params: { courseId: "5" } })).res.statusCode, 200);
  assert.strictEqual((await call("get", AI, { user: teacher(), pool: mk().pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 200);
  assert.strictEqual((await call("patch", AI, { user: teacher(), pool: mk().pool, params: { courseId: "5", assignmentId: "4" }, body: { title: "New" } })).res.statusCode, 200);
  const refused = [];
  for (const [user, courseId] of [[student(), "5"], [teacher(), "6"], [teacher(), "999"]]) for (const [m, p, b] of [["post", AC, body], ["patch", AI, { title: "x" }], ["delete", AI, {}], ["get", AC, {}], ["get", AI, {}]]) { const k = mk(); const r = await call(m, p, { user, pool: k.pool, params: { courseId, assignmentId: "4" }, body: b }); assert.strictEqual(r.res.statusCode, 403, `${m} ${courseId}`); assert.strictEqual(writes(k.log).length, 0); if (m === "post") refused.push(r.res); }
  sameForbidden(refused[1], refused[2]);
  assert.strictEqual((await call("post", AC, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, body: { title: "" } })).res.statusCode, 400);
  assert.strictEqual((await call("patch", AI, { user: teacher(), pool: mk().pool, params: { courseId: "5", assignmentId: "x" }, body: { title: "a" } })).res.statusCode, 404);
  assert.strictEqual((await call("delete", AI, { user: teacher(), pool: makeMockPool([staff([5]), live(), ["UPDATE lms_assignments SET deleted_at", () => [{ id: 4 }]]]).pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 200);
});
test("routes: students read only through studentOnly + an ACTIVE enrolment; staff and strangers are refused; a not-yet-available assignment is a 404", async () => {
  const mk = (rows) => makeMockPool([enrolled([5]), live("published"), ["FROM lms_assignments a WHERE a.course_id", () => rows.map((r) => ({ ...r, total_count: rows.length }))], ["FROM lms_assignments a WHERE a.id = @id", () => rows]]);
  const L = "/courses/:courseId/learn/assignments", O = "/courses/:courseId/learn/assignments/:assignmentId";
  const a = await call("get", L, { user: student(), pool: mk([row({ status: "published" })]).pool, params: { courseId: "5" } }); assert.strictEqual(a.res.statusCode, 200); assert.strictEqual(a.res.body.items.length, 1); assert.ok(!("status" in a.res.body.items[0]));
  assert.strictEqual((await call("get", O, { user: student(), pool: mk([row({ status: "published" })]).pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 200);
  assert.strictEqual((await call("get", O, { user: student(), pool: mk([]).pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 404);
  for (const [path, p] of [[L, { courseId: "6" }], [O, { courseId: "6", assignmentId: "4" }]]) assert.strictEqual((await call("get", path, { user: student(), pool: mk([row()]).pool, params: p })).res.statusCode, 403);
  for (const path of [L, O]) for (const user of [teacher(), admin]) assert.strictEqual((await call("get", path, { user, pool: mk([row()]).pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 403);
});
test("tenant isolation: school A's assignment calls never touch school B's database; school B's rows are invisible to A by id guessing", async () => {
  const T = makeTenants({ A: [staff([5]), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row({ id: 4 }))], B: [staff([5]), enrolled([5]), live("published"), COUNT(0), INS, LOAD(row({ id: 77, course_id: 5, title: "B secret" }))] });
  const r = await call("post", AC, { user: teacher(), pool: T.A.pool, params: { courseId: "5" }, body: { title: "Hi", instructions: "b" }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 201); T.assertQueried("A"); T.assertUntouched("B");
  const g = await call("get", AI, { user: teacher(), pool: T.A.pool, params: { courseId: "5", assignmentId: "77" }, tenant: "A" }); assert.strictEqual(g.res.statusCode, 404); assert.ok(!JSON.stringify(g.res.body).includes("B secret")); T.assertUntouched("B");
});
test("static: step 016 additive and ordered after 015; table blocklisted; event registered; all 7 routes gated; no raw db, no req.body, no user value in SQL text; planner has no schema change of its own", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "016_lms_assignments"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "015_lms_calendar_feeds") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl) && /CREATE TABLE lms_assignments/.test(ddl) && /work_mode NVARCHAR\(10\) NOT NULL DEFAULT 'individual'/.test(ddl) && /IX_lms_assignments_course/.test(ddl) && /deleted_at DATETIME2 NULL/.test(ddl));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_assignments"')); assert.ok(require("../utils/lmsEvents").EVENTS.includes("lms.assignment.published"));
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && !/\/(submission|rubric|feedback|return-all|grade-release|extensions)/.test(l.route.path) && (/^\/courses\/:courseId\/assignments/.test(l.route.path) || /^\/courses\/:courseId\/learn\/assignments/.test(l.route.path))); assert.strictEqual(mine.length, 7);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(l.route.stack.length >= 2, l.route.path); assert.ok(router.stack.indexOf(l) > first && first >= 2); }
  for (const l of mine.filter((x) => x.route.methods.post || x.route.methods.patch || x.route.methods.delete)) assert.ok(l.route.stack.length >= 3, l.route.path);
  for (const l of mine.filter((x) => /learn/.test(x.route.path))) assert.ok(l.route.stack.length >= 3, l.route.path);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsAssignments.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{(?!cond\b|sets\.join|COLS|AVAILABLE)[^}]*\}/.test(piece.replace(/\$\{COLS\.split\(", "\)\.map\(\(c\) => `[A-Za-z]+\.\$\{c\}`\)\.join\(", "\)\}/g, "")), "unexpected interpolation in SQL: " + piece.slice(0, 60));
  assert.ok(!require("../utils/lmsSchema").STEPS.some((s) => /planner/i.test(s.id)));
});
