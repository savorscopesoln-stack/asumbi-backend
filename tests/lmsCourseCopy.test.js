/* L2.4 — templates, duplicate course, rollover. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsCourseCopy.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)
const C = require("../utils/lmsCourseCopy");
const events = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers", tenant: "isoA" });
const student = { id: 7, role: "student", source: "Students", tenant: "isoA" };
const admin = { id: 1, role: "admin", source: "Users", tenant: "isoA" };
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const tplRow = (o = {}) => ({ id: 3, name: "Biology base", description: null, is_shared: 0, source_course_id: 5, created_by_source: "Teachers", created_by: 7, created_at: "2026-10-01", updated_at: "2026-10-01", ...o });
const content = (o = {}) => JSON.stringify({ course: { description: "About cells", objectives: ["Know cells"], semester: "T1", programme: "Sci", visibility: "listed" }, sections: [{ title: "Cells", summary: "Intro" }, { title: "Tissues", summary: null }], ...o });
const batch = (m) => m.log.filter((l) => l.sql.includes("BEGIN TRAN"));
const dup = () => Object.assign(new Error("dup"), { number: 2601 });

/* ---------------- pure ---------------- */
test("template input: name 3-120, optional description/shared, unknown fields refused, partial needs something", () => {
  assert.deepStrictEqual(C.validateTemplateInput({ name: "  <b>Bio</b> base ", shared: true }).value, { name: "bBio/b base", shared: true });
  for (const b of [{}, { name: "ab" }, { name: "x".repeat(121) }, { name: "okay", shared: "yes" }, { name: "okay", description: "x".repeat(501) }, { name: "okay", courseId: 1 }, null, []]) assert.strictEqual(C.validateTemplateInput(b).ok, false, JSON.stringify(b)?.slice(0, 40));
  assert.strictEqual(C.validateTemplateInput({}, { partial: true }).ok, false); assert.strictEqual(C.validateTemplateInput({ description: null }, { partial: true }).value.description, null);
});

test("readContent: stored JSON is never trusted - tags stripped, caps applied, junk ignored", () => {
  assert.deepStrictEqual(C.readContent("not json"), { course: { description: null, objectives: [], semester: null, programme: null, visibility: "enrolled_only" }, sections: [] });
  const r = C.readContent(JSON.stringify({ course: { visibility: "weird", objectives: Array.from({ length: 30 }, (_, i) => `o${i}`) }, sections: [{ title: "<script>x</script>" }, { title: "" }, null, ...Array.from({ length: 150 }, (_, i) => ({ title: `S${i}` }))] }));
  assert.strictEqual(r.course.visibility, "enrolled_only"); assert.strictEqual(r.course.objectives.length, 20); assert.strictEqual(r.sections.length, 100); assert.ok(!r.sections[0].title.includes("<"));
});

test("rollover input: toYear later than fromYear, flags are booleans, defaults copyStaff=true copyEnrolments=false, ids bounded", () => {
  const ok = C.validateRollover({ fromYear: "2025", toYear: 2026 }); assert.ok(ok.ok); assert.deepStrictEqual([ok.value.copyStaff, ok.value.copyEnrolments, ok.value.dryRun], [true, false, false]);
  for (const b of [{}, { fromYear: 2026, toYear: 2026 }, { fromYear: 2027, toYear: 2026 }, { fromYear: 1999, toYear: 2026 }, { fromYear: 2025, toYear: 2026, copyStaff: "no" }, { fromYear: 2025, toYear: 2026, courseIds: [] }, { fromYear: 2025, toYear: 2026, courseIds: [1, "x"] }, { fromYear: 2025, toYear: 2026, courseIds: Array.from({ length: 201 }, (_, i) => i + 1) }, { fromYear: 2025, toYear: 2026, extra: 1 }, null]) assert.strictEqual(C.validateRollover(b).ok, false, JSON.stringify(b)?.slice(0, 60));
  assert.deepStrictEqual(C.validateRollover({ fromYear: 2025, toYear: 2026, courseIds: [3, "3", 4] }).value.courseIds, [3, 4]);
});

/* ---------------- templates ---------------- */
test("saveAsTemplate: snapshots details + live sections only (never year/code/class/subject/people), parameterised, audited", async () => {
  const m = makeMockPool([["TOP 1 description, objectives_json", () => [{ description: "About cells", objectives_json: "[\"Know cells\"]", semester: "T1", programme: "Sci", visibility: "listed" }]],
    ["SELECT COUNT(*) AS n FROM lms_course_templates", () => [{ n: 2 }]], ["FROM lms_course_sections WHERE course_id = @c", () => [{ title: "Cells", summary: "Intro" }]], ["INSERT INTO lms_course_templates", () => [tplRow()]]]);
  const r = await C.saveAsTemplate(m.pool, teacher(), 5, { name: "Biology base", shared: false }); assert.ok(r.ok); assert.strictEqual(r.template.mine, true);
  const q = m.log.find((l) => l.sql.includes("INSERT INTO lms_course_templates")); assert.ok(!q.sql.includes("Biology base"));
  const j = JSON.parse(q.inputs.j); assert.deepStrictEqual(Object.keys(j).sort(), ["course", "sections"]); assert.ok(!/academic|code|class|cohort|subject|staff/i.test(Object.keys(j.course).join(",")));
  assert.strictEqual(j.sections.length, 1); assert.ok(m.log.some((l) => l.inputs.act === "template.created"));
  assert.strictEqual((await C.saveAsTemplate(makeMockPool([["TOP 1 description, objectives_json", () => []]]).pool, teacher(), 5, { name: "Biology base" })).notFound, true);
  assert.strictEqual((await C.saveAsTemplate(makeMockPool([["TOP 1 description, objectives_json", () => [{}]], ["SELECT COUNT(*) AS n FROM lms_course_templates", () => [{ n: C.MAX_TEMPLATES }]]]).pool, teacher(), 5, { name: "Biology base" })).code, "LIMIT_REACHED");
  const d = makeMockPool([["TOP 1 description, objectives_json", () => [{}]], ["SELECT COUNT(*) AS n FROM lms_course_templates", () => [{ n: 0 }]], ["INSERT INTO lms_course_templates", () => { throw dup(); }]]);
  assert.strictEqual((await C.saveAsTemplate(d.pool, teacher(), 5, { name: "Biology base" })).conflict, true);
});

test("listTemplates: school-shared + own only (admin all), paginated, search escaped, bounded page size", async () => {
  const m = makeMockPool([["FROM lms_course_templates t", () => [{ ...tplRow(), total_count: 31 }, { ...tplRow({ id: 4, created_by: 9, is_shared: 1 }), total_count: 31 }]]]);
  const r = await C.listTemplates(m.pool, teacher(), { q: "100%_bio", page: "2", pageSize: "9999" });
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items.map((t) => t.mine)], [31, 2, 100, [true, false]]);
  const q = m.log[0]; assert.ok(q.sql.includes("t.is_shared = 1") && q.sql.includes("t.created_by = @uid") && q.sql.includes("OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY") && q.sql.includes("ESCAPE"));
  assert.deepStrictEqual([q.inputs.admin, q.inputs.src, q.inputs.uid, q.inputs.off, q.inputs.lim], [0, "Teachers", 7, 100, 100]); assert.ok(q.inputs.q.includes("100\\%\\_bio"));
  await C.listTemplates(m.pool, admin, { isAdmin: true }); assert.strictEqual(m.log[1].inputs.admin, 1);
});

test("update/delete template: only the creator or an LMS administrator (the SQL says so); others get the same 'not found'", async () => {
  const m = makeMockPool([["UPDATE lms_course_templates SET name", () => [tplRow({ name: "Renamed" })]], ["UPDATE lms_course_templates SET deleted_at", () => [{ id: 3 }]]]);
  assert.ok((await C.updateTemplate(m.pool, teacher(), 3, { name: "Renamed" })).ok); assert.ok((await C.deleteTemplate(m.pool, teacher(), 3)).ok);
  for (const l of m.log.filter((x) => x.sql.startsWith("UPDATE lms_course_templates"))) assert.ok(l.sql.includes("@admin = 1 OR (created_by_source = @src AND created_by = @uid)") && l.sql.includes("deleted_at IS NULL"));
  const none = makeMockPool([]); assert.strictEqual((await C.updateTemplate(none.pool, teacher(9), 3, { name: "Hijack" })).notFound, true); assert.strictEqual((await C.deleteTemplate(none.pool, teacher(9), 3)).notFound, true);
  assert.strictEqual((await C.updateTemplate(none.pool, teacher(), 3, {})).ok, false);
  const d = makeMockPool([["UPDATE lms_course_templates SET name", () => { throw dup(); }]]); assert.strictEqual((await C.updateTemplate(d.pool, teacher(), 3, { name: "Same" })).conflict, true);
});

test("createFromTemplate: template defaults + caller's fields, always a draft, sections inserted in order by parameter, caller is the only staff", async () => {
  const got = []; const off = events.on("lms.course.created", (e) => { if (e.courseId === 55) got.push(e); }); // tests interleave: only count this test's course
  const m = makeMockPool([["FROM lms_course_templates t WHERE t.id = @id", () => [tplRow({ content_json: content() })]], ["DECLARE @new TABLE", () => [{ id: 55 }]]]);
  const r = await C.createFromTemplate(m.pool, teacher(), { templateId: "3", code: "bio 101", title: "Biology 1", academicYear: 2026, className: "Form 1A" }, { tenant: "isoA" }); assert.ok(r.ok); assert.strictEqual(r.id, 55); assert.strictEqual(r.sections, 2);
  const b = batch(m)[0]; assert.ok(b.sql.includes("'draft'") && b.sql.includes("INSERT INTO lms_course_staff") && !b.sql.includes("Cells"));
  assert.deepStrictEqual([b.inputs.code, b.inputs.desc, b.inputs.sem, b.inputs.vis, b.inputs.cls, b.inputs.st0, b.inputs.st1, b.inputs.ss0], ["BIO 101", "About cells", "T1", "listed", "Form 1A", "Cells", "Tissues", "Intro"]);
  assert.ok(b.sql.indexOf("@st0") < b.sql.indexOf("@st1") && b.sql.includes(", 10, @src") && b.sql.includes(", 20, @src"));
  assert.ok(m.log.some((l) => l.inputs.act === "course.created_from_template")); await sharedTick(); assert.strictEqual(got.length, 1); off && off();
  for (const body of [null, {}, { templateId: 0, code: "AB1", title: "Biology", academicYear: 2026 }, { templateId: 3, title: "No code", academicYear: 2026 }, { templateId: 3, code: "AB1", title: "x", academicYear: 2026 }, { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026, status: "published" }]) {
    const x = await C.createFromTemplate(makeMockPool([["FROM lms_course_templates t WHERE t.id = @id", () => [tplRow({ content_json: content() })]]]).pool, teacher(), body); assert.strictEqual(x.ok, false, JSON.stringify(body));
  }
  assert.strictEqual((await C.createFromTemplate(makeMockPool([]).pool, teacher(), { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026 })).notFound, true);
  const sub = makeMockPool([["FROM lms_course_templates t WHERE t.id = @id", () => [tplRow({ content_json: content() })]], ["FROM subjects WHERE id", () => []]]);
  assert.strictEqual((await C.createFromTemplate(sub.pool, teacher(), { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026, subjectId: 9 })).ok, false);
  const d = makeMockPool([["FROM lms_course_templates t WHERE t.id = @id", () => [tplRow({ content_json: content() })]], ["DECLARE @new TABLE", () => { throw dup(); }]]);
  assert.strictEqual((await C.createFromTemplate(d.pool, teacher(), { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026 })).conflict, true);
});

/* ---------------- duplicate ---------------- */
test("duplicateCourse: one atomic INSERT..SELECT of details + live sections as a new draft; only the caller is staff; code required", async () => {
  const m = makeMockPool([["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "Biology", academic_year: 2026 }]], ["DECLARE @new TABLE", () => [{ id: 60 }]]]);
  const r = await C.duplicateCourse(m.pool, teacher(), 5, { code: "bio-2" }); assert.deepStrictEqual([r.ok, r.id], [true, 60]);
  const b = batch(m)[0]; assert.deepStrictEqual([b.inputs.title, b.inputs.year, b.inputs.code, b.inputs.src_id], ["Biology (copy)", 2026, "BIO-2", 5]);
  assert.ok(b.sql.includes("'draft'") && b.sql.includes("FROM lms_courses WHERE id = @src_id AND deleted_at IS NULL") && b.sql.includes("s.course_id = @src_id AND s.deleted_at IS NULL"));
  assert.ok(!b.sql.includes("FROM lms_course_staff st") && !b.sql.includes("lms_course_enrolments") && !b.sql.includes("lms_course_events"), "no people, enrolments or calendar are copied");
  assert.ok(m.log.some((l) => l.inputs.act === "course.duplicated"));
  for (const body of [{}, { code: "x" }, { code: "OK1", status: "published" }, { code: "OK1", academicYear: 1900 }, null]) assert.strictEqual((await C.duplicateCourse(makeMockPool([["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "B", academic_year: 2026 }]]]).pool, teacher(), 5, body)).ok, false, JSON.stringify(body));
  assert.strictEqual((await C.duplicateCourse(makeMockPool([]).pool, teacher(), 5, { code: "OK1" })).notFound, true);
  const d = makeMockPool([["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "B", academic_year: 2026 }]], ["DECLARE @new TABLE", () => { throw dup(); }]]);
  const x = await C.duplicateCourse(d.pool, teacher(), 5, { code: "OK1" }); assert.strictEqual(x.conflict, true);
  const gone = makeMockPool([["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "B", academic_year: 2026 }]], ["DECLARE @new TABLE", () => []]]); assert.strictEqual((await C.duplicateCourse(gone.pool, teacher(), 5, { code: "OK1" })).notFound, true);
  const long = makeMockPool([["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "T".repeat(200), academic_year: 2026 }]], ["DECLARE @new TABLE", () => [{ id: 61 }]]]); assert.ok((await C.duplicateCourse(long.pool, teacher(), 5, { code: "OK1" })).ok); assert.ok(batch(long)[0].inputs.title.length <= 200);
});

/* ---------------- rollover ---------------- */
const src = (rows) => ["c.academic_year = @from", (i) => rows.filter((r) => !i.i0 || [i.i0, i.i1, i.i2].includes(r.id))];
const taken = (codes) => ["AND code IN (", () => codes.map((code) => ({ code }))];

test("rollover dry run: reports would_create / CODE_EXISTS and writes NOTHING", async () => {
  const m = makeMockPool([src([{ id: 1, code: "BIO1", title: "Biology" }, { id: 2, code: "CHM1", title: "Chem" }]), taken(["chm1"])]);
  const r = await C.rolloverCourses(m.pool, admin, { fromYear: 2025, toYear: 2026, dryRun: true });
  assert.deepStrictEqual(r.courses.map((c) => c.result), ["would_create", "skipped"]); assert.deepStrictEqual(r.summary, { planned: 2, created: 0, skipped: 1, failed: 0 });
  assert.ok(!batch(m).length && !m.log.some((l) => /^(INSERT|UPDATE|DELETE)/.test(l.sql)), "dry run is read-only");
  const q = m.log[0]; assert.ok(q.sql.includes("status <> 'archived'") && q.sql.includes("deleted_at IS NULL") && q.sql.includes("TOP 201"));
});

test("rollover: one transaction per course; created / skipped / failed are reported separately and one failure never stops the rest", async () => {
  const m = makeMockPool([src([{ id: 1, code: "BIO1", title: "B" }, { id: 2, code: "CHM1", title: "C" }, { id: 3, code: "PHY1", title: "P" }, { id: 4, code: "ENG1", title: "E" }]), taken([]),
    ["DECLARE @new TABLE", (i) => { if (i.src_id === 2) throw new Error("boom"); if (i.src_id === 3) throw dup(); if (i.src_id === 4) return []; return [{ id: 100 + i.src_id, sections: 3, enrolments: 0 }]; }]]);
  const r = await C.rolloverCourses(m.pool, admin, { fromYear: 2025, toYear: 2026 }, "isoA");
  assert.deepStrictEqual(r.courses.map((c) => [c.sourceId, c.result, c.reason || c.newCourseId]), [[1, "created", 101], [2, "failed", "ERROR"], [3, "skipped", "CODE_EXISTS"], [4, "skipped", "CODE_EXISTS"]]);
  assert.deepStrictEqual(r.summary, { planned: 4, created: 1, skipped: 2, failed: 1 }); assert.strictEqual(batch(m).length, 2, "the mock logs only batches that returned (2 of 4 threw)");
  const b = batch(m)[0]; assert.ok(b.sql.includes("'draft'") && b.sql.includes("NOT EXISTS (SELECT 1 FROM lms_courses x WHERE x.academic_year = @to AND x.code = c.code AND x.deleted_at IS NULL)"));
  assert.ok(m.log.some((l) => l.inputs.act === "course.rolled_over") && m.log.some((l) => l.inputs.act === "rollover.run"));
});

test("rollover options: staff are copied unless copyStaff=false; enrolments only when asked, active students only, with history", async () => {
  const run = async (opts) => { const m = makeMockPool([src([{ id: 1, code: "BIO1", title: "B" }]), taken([]), ["DECLARE @new TABLE", () => [{ id: 9, sections: 1, enrolments: 4 }]]]); const r = await C.rolloverCourses(m.pool, admin, { fromYear: 2025, toYear: 2026, ...opts }); return { r, sql: batch(m)[0].sql }; };
  const a = await run({}); assert.ok(a.sql.includes("INSERT INTO lms_course_staff") && !a.sql.includes("INSERT INTO lms_course_enrolments") && !a.sql.includes("INSERT INTO lms_enrolment_history")); assert.strictEqual(a.r.courses[0].enrolments, 0);
  const b = await run({ copyStaff: false }); assert.ok(!b.sql.includes("INSERT INTO lms_course_staff") && !b.sql.includes("INSERT INTO lms_course_enrolments"));
  const c = await run({ copyEnrolments: true }); assert.ok(c.sql.includes("INSERT INTO lms_course_enrolments") && c.sql.includes("e.status = 'active'") && c.sql.includes("stu.status = 'active'") && c.sql.includes("INSERT INTO lms_enrolment_history") && c.sql.includes("'rollover'")); assert.strictEqual(c.r.courses[0].enrolments, 4);
  assert.ok(!a.sql.includes("lms_course_events"), "calendar events are never copied");
});

test("rollover: courseIds narrow the set (parameterised); more than 200 matches are refused; no matches is an empty report", async () => {
  const m = makeMockPool([src([{ id: 1, code: "A1", title: "a" }, { id: 2, code: "B1", title: "b" }]), taken([])]);
  const r = await C.rolloverCourses(m.pool, admin, { fromYear: 2025, toYear: 2026, courseIds: [1, 2], dryRun: true }); assert.strictEqual(r.courses.length, 2);
  assert.ok(m.log[0].sql.includes("c.id IN (@i0, @i1)") && !m.log[0].sql.includes("IN (1"));
  const many = makeMockPool([["c.academic_year = @from", () => Array.from({ length: 201 }, (_, i) => ({ id: i + 1, code: `C${i}`, title: "t" }))]]);
  const x = await C.rolloverCourses(many.pool, admin, { fromYear: 2025, toYear: 2026 }); assert.deepStrictEqual([x.ok, x.code], [false, "TOO_MANY"]);
  const none = await C.rolloverCourses(makeMockPool([]).pool, admin, { fromYear: 2025, toYear: 2026 }); assert.deepStrictEqual([none.ok, none.courses], [true, []]);
  assert.strictEqual((await C.rolloverCourses(makeMockPool([]).pool, admin, { fromYear: 2026, toYear: 2025 })).ok, false);
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant = "isoA" }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const courseRows = ["FROM lms_courses WHERE id", () => [{ id: 60, code: "BIO-2", title: "Biology (copy)", academic_year: 2026, visibility: "enrolled_only", status: "draft" }]];

test("routes: duplicate needs lms.course.create AND staff access to the SOURCE course; strangers and missing courses look identical", async () => {
  const mk = (role) => makeMockPool([staff([5], role), ["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "Biology", academic_year: 2026 }]], ["DECLARE @new TABLE", () => [{ id: 60 }]], courseRows, ["FROM lms_course_staff s", () => []]]);
  for (const role of ["teacher", "co_teacher"]) { const a = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body: { code: "BIO-2" } }); assert.strictEqual(a.res.statusCode, 201, role); assert.strictEqual(a.res.body.course.status, "draft"); }
  const s = mk("teacher"); const sr = await call("post", "/courses/:courseId/duplicate", { user: student, pool: s.pool, params: { courseId: "5" }, body: { code: "BIO-2" } }); assert.deepStrictEqual([sr.res.statusCode, sr.res.body.code], [403, "LMS_FORBIDDEN"]); assert.ok(!batch(s).length);
  const o = await call("post", "/courses/:courseId/duplicate", { user: teacher(9), pool: makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, params: { courseId: "5" }, body: { code: "BIO-2" } });
  const miss = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: makeMockPool([staff([5])]).pool, params: { courseId: "6" }, body: { code: "BIO-2" } });
  assert.deepStrictEqual([o.res.statusCode, o.res.body.code], [403, "COURSE_ACCESS_DENIED"]); sameForbidden(o.res, miss.res);
  const d = makeMockPool([staff([5]), ["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "B", academic_year: 2026 }]], ["DECLARE @new TABLE", () => { throw dup(); }]]);
  const c = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: d.pool, params: { courseId: "5" }, body: { code: "BIO-2" } }); assert.deepStrictEqual([c.res.statusCode, c.res.body.code], [409, "COURSE_CONFLICT"]);
  const v = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: makeMockPool([staff([5]), ["TOP 1 title, academic_year FROM lms_courses", () => [{ title: "B", academic_year: 2026 }]]]).pool, params: { courseId: "5" }, body: {} }); assert.strictEqual(v.res.statusCode, 400);
});

test("routes: save-as-template needs access to that course; from-template and the template list/get work for teachers, not students", async () => {
  const st = makeMockPool([staff([5]), ["TOP 1 description, objectives_json", () => [{}]], ["SELECT COUNT(*) AS n FROM lms_course_templates", () => [{ n: 0 }]], ["INSERT INTO lms_course_templates", () => [tplRow()]]]);
  const a = await call("post", "/courses/:courseId/save-as-template", { user: teacher(), pool: st.pool, params: { courseId: "5" }, body: { name: "Biology base" } }); assert.strictEqual(a.res.statusCode, 201);
  const b = await call("post", "/courses/:courseId/save-as-template", { user: teacher(9), pool: makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, params: { courseId: "5" }, body: { name: "Biology base" } }); assert.strictEqual(b.res.statusCode, 403);
  const tpl = ["FROM lms_course_templates t WHERE t.id = @id", onlyIds("id", [3], [tplRow({ content_json: content() })])];
  const g = await call("get", "/course-templates/:templateId", { user: teacher(), pool: makeMockPool([tpl]).pool, params: { templateId: "3" } }); assert.strictEqual(g.res.body.template.content.sections.length, 2);
  assert.strictEqual((await call("get", "/course-templates/:templateId", { user: teacher(), pool: makeMockPool([tpl]).pool, params: { templateId: "4" } })).res.statusCode, 404);
  assert.strictEqual((await call("get", "/course-templates/:templateId", { user: teacher(), pool: makeMockPool([tpl]).pool, params: { templateId: "abc" } })).res.statusCode, 404);
  for (const [m, p, params, body] of [["get", "/course-templates", {}, {}], ["get", "/course-templates/:templateId", { templateId: "3" }, {}], ["patch", "/course-templates/:templateId", { templateId: "3" }, { name: "Renamed" }], ["delete", "/course-templates/:templateId", { templateId: "3" }, {}], ["post", "/courses/from-template", {}, { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026 }]]) {
    const pool = makeMockPool([tpl]); const r = await call(m, p, { user: student, pool: pool.pool, params, body }); assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, "LMS_FORBIDDEN"], `${m} ${p}`); assert.strictEqual(pool.log.length, 0, "refused before any query");
  }
  const ft = makeMockPool([tpl, ["DECLARE @new TABLE", () => [{ id: 70 }]], courseRows, ["FROM lms_course_staff s", () => []]]);
  const f = await call("post", "/courses/from-template", { user: teacher(), pool: ft.pool, body: { templateId: 3, code: "AB1", title: "Biology", academicYear: 2026 } }); assert.strictEqual(f.res.statusCode, 201);
  const nf = await call("post", "/courses/from-template", { user: teacher(), pool: makeMockPool([tpl]).pool, body: { templateId: 9, code: "AB1", title: "Biology", academicYear: 2026 } }); assert.deepStrictEqual([nf.res.statusCode, nf.res.body.code], [404, "NOT_FOUND"]);
  const del = await call("delete", "/course-templates/:templateId", { user: teacher(9), pool: makeMockPool([]).pool, params: { templateId: "3" } }); assert.strictEqual(del.res.statusCode, 404);
});

test("routes: rollover is for LMS administrators only; a teacher or student gets LMS_FORBIDDEN before any course query", async () => {
  const body = { fromYear: 2025, toYear: 2026, dryRun: true };
  for (const user of [teacher(), student]) { const m = makeMockPool([src([{ id: 1, code: "A1", title: "a" }]), taken([])]); const r = await call("post", "/rollover", { user, pool: m.pool, body }); assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, "LMS_FORBIDDEN"]); assert.ok(m.log.every((l) => l.sql.includes("lms_user_permissions")), "only the permission lookup ran"); }
  const m = makeMockPool([src([{ id: 1, code: "A1", title: "a" }]), taken([])]); const ok = await call("post", "/rollover", { user: admin, pool: m.pool, body }); assert.strictEqual(ok.res.statusCode, 200); assert.strictEqual(ok.res.body.report.summary.planned, 1);
  const bad1 = await call("post", "/rollover", { user: admin, pool: makeMockPool([]).pool, body: { fromYear: 2026, toYear: 2025 } }); assert.deepStrictEqual([bad1.res.statusCode, bad1.res.body.code], [400, "VALIDATION_ERROR"]);
  const many = await call("post", "/rollover", { user: admin, pool: makeMockPool([["c.academic_year = @from", () => Array.from({ length: 201 }, (_, i) => ({ id: i + 1, code: `C${i}`, title: "t" }))]]).pool, body: { fromYear: 2025, toYear: 2026 } }); assert.deepStrictEqual([many.res.statusCode, many.res.body.code], [409, "TOO_MANY"]);
});

test("isolation: template and course ids of school B never resolve in school A; B's database is never queried", async () => {
  const T = makeTenants({ isoA: [staff([1]), ["FROM lms_course_templates t WHERE t.id = @id", onlyIds("id", [3], [tplRow({ content_json: content() })])], ["UPDATE lms_course_templates SET name", onlyIds("id", [3], [tplRow()])]], isoB: [staff([2]), ["FROM lms_course_templates t WHERE t.id = @id", () => [tplRow({ id: 30, content_json: content() })]]] });
  assert.strictEqual((await call("get", "/course-templates/:templateId", { user: teacher(), pool: T.isoA.pool, params: { templateId: "3" } })).res.statusCode, 200);
  assert.strictEqual((await call("get", "/course-templates/:templateId", { user: teacher(), pool: T.isoA.pool, params: { templateId: "30" } })).res.statusCode, 404);
  assert.strictEqual((await call("patch", "/course-templates/:templateId", { user: teacher(), pool: T.isoA.pool, params: { templateId: "30" }, body: { name: "Hijack" } })).res.statusCode, 404);
  const other = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: T.isoA.pool, params: { courseId: "2" }, body: { code: "AB1" } });
  const missing = await call("post", "/courses/:courseId/duplicate", { user: teacher(), pool: T.isoA.pool, params: { courseId: "999" }, body: { code: "AB1" } }); sameForbidden(other.res, missing.res);
  T.assertUntouched("isoB");
});

test("static: schema step 006 is additive and guarded; every L2.4 route is behind the gate with a permission check; services use req.pool only; table blocklisted", () => {
  const { STEPS } = require("../utils/lmsSchema"); const s = STEPS.find((x) => x.id === "006_lms_course_templates"); assert.ok(s); assert.strictEqual(STEPS.map((x) => x.id).indexOf("006_lms_course_templates"), 5);
  const all = s.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(all)); assert.ok(s.sql.every((x) => /IF NOT EXISTS/.test(x))); assert.ok(/UX_lms_course_templates_owner_name/.test(all) && /deleted_at IS NULL/.test(all));
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && (/^\/course-templates/.test(l.route.path) || ["/courses/from-template", "/courses/:courseId/duplicate", "/courses/:courseId/save-as-template", "/rollover"].includes(l.route.path)));
  assert.strictEqual(mine.length, 8); for (const l of mine) assert.ok(l.route.stack.length >= 2, l.route.path);
  assert.ok(router.stack.findIndex((l) => l.route) >= 2, "licence gate registered before every route");
  const root = path.join(__dirname, ".."); assert.ok(!/config\/db/.test(fs.readFileSync(path.join(root, "utils", "lmsCourseCopy.js"), "utf8")));
  const line = fs.readFileSync(path.join(root, "server.js"), "utf8").split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")); assert.ok(line.includes('"lms_course_templates"'));
});
