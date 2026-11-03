/* L3.1a — lessons, content blocks, HTML sanitiser. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsLessons.test.js");
const H = require("../utils/lmsHtml");
const L = require("../utils/lmsLessons");
const { on } = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const les = (o = {}) => ({ id: 9, course_id: 5, section_id: null, title: "Cells", summary: null, status: "draft", estimated_minutes: null, sort_order: 10, content_version: 1, published_at: null, created_at: "x", updated_at: "x", ...o });
const T = "school1", img = (o = {}) => ({ type: "image", url: `/uploads/${T}/lms/a.png`, alt: "A cell", ...o });

/* ---------------- sanitiser ---------------- */
test("sanitiser: scripts, event handlers, styles, iframes, forms, images and unsafe links never survive", () => {
  const bad = ["<p>Hi <script>alert(1)</script>x</p>", "<img src=x onerror=alert(1)>", "<p onclick=\"x()\" style=\"color:red\">a</p>", "<iframe src=//evil></iframe>t", "<svg><script>alert(1)</script></svg>",
    "<style>p{}</style><p>t</p>", "<form action=//e><input></form>", "<<script>script>alert(1)<</script>/script>", "<a href=\"javascript:alert(1)\">x</a>", "<a href=\"jav&#x61;script:alert(1)\">x</a>",
    "<a href=\" java\tscript:alert(1)\">x</a>", "<a href=\"data:text/html;base64,xx\">d</a>", "<object data=x></object>", "<math><mi>x</mi></math>", "<p title=\"\\\"><script>alert(1)</script>\">q</p>"];
  for (const b of bad) { const o = H.sanitizeHtml(b); assert.ok(!/<(script|img|iframe|style|form|input|svg|object|math)|\son\w+=|style=|javascript:|data:/i.test(o), `${b} -> ${o}`); }
  assert.strictEqual(H.sanitizeHtml("<a href=\"javascript:alert(1)\">x</a>"), "<a>x</a>");
});
test("sanitiser: keeps teaching markup, forces safe link attributes, repairs nesting, escapes stray characters", () => {
  assert.strictEqual(H.sanitizeHtml("<h1>T</h1><p><strong>b</strong> <em>i</em></p><ul><li>a</li></ul>"), "<h2>T</h2><p><strong>b</strong> <em>i</em></p><ul><li>a</li></ul>");
  assert.strictEqual(H.sanitizeHtml("<a href=\"https://ex.com/?a=1&b=2\" onclick=\"x()\">ok</a>"), "<a href=\"https://ex.com/?a=1&amp;b=2\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">ok</a>");
  assert.strictEqual(H.sanitizeHtml("<b><i>x</b></i>"), "<b><i>x</i></b>");
  assert.strictEqual(H.sanitizeHtml("</p></div>x<p>open"), "x<p>open</p>");
  assert.strictEqual(H.sanitizeHtml("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
  assert.strictEqual(H.sanitizeHtml("<td colspan=2 onclick=x>c</td>"), "<td colspan=\"2\">c</td>");
  assert.strictEqual(H.sanitizeHtml("<!-- hidden --><p>x</p>"), "<p>x</p>");
  assert.strictEqual(H.sanitizeHtml(null), ""); assert.strictEqual(H.sanitizeHtml(H.sanitizeHtml("<p>a &amp; b</p>")), "<p>a &amp; b</p>"); // idempotent
  assert.strictEqual(H.htmlToText("<p>Hello &amp; <b>world</b></p><ul><li>a</li></ul>"), "Hello & world a");
  assert.ok(H.sanitizeHtml("<p>x</p>".repeat(100000)).length <= H.MAX_HTML * 2); // bounded work
});

/* ---------------- validation ---------------- */
test("lesson validation: title required, plain text, known fields and values only", () => {
  assert.deepStrictEqual(L.validateLesson({ title: "  <b>Cells</b> ", sectionId: "3", estimatedMinutes: 20, status: "published" }).value, { title: "bCells/b", sectionId: 3, estimatedMinutes: 20, status: "published" });
  for (const b of [{}, { title: "" }, { title: "x".repeat(201) }, { title: "ok", sectionId: "x" }, { title: "ok", estimatedMinutes: 0 }, { title: "ok", estimatedMinutes: 601 }, { title: "ok", status: "archived" }, { title: "ok", sort_order: 1 }, null, []]) assert.strictEqual(L.validateLesson(b).ok, false, JSON.stringify(b)?.slice(0, 60));
  assert.strictEqual(L.validateLesson({}, { partial: true }).ok, false); assert.strictEqual(L.validateLesson({ sectionId: null }, { partial: true }).value.sectionId, null);
});
test("block validation: every type normalised; text sanitised; unknown types/fields rejected; limit enforced", () => {
  const ok = L.validateBlocks([{ type: "text", html: "<p>Hi<script>x</script></p>" }, { type: "divider" }, { type: "link", url: "https://example.com/a", title: "Read" }, img({ caption: "Fig 1" }),
    { type: "audio", url: `/uploads/${T}/lms/talk.mp3`, title: "Talk" }, { type: "file", url: `/uploads/${T}/lms/notes.pdf`, title: "Notes" }, { type: "video", url: "https://youtu.be/dQw4w9WgXcQ" }, { type: "embed", url: "https://vimeo.com/123456789" }], T);
  assert.ok(ok.ok, JSON.stringify(ok.errors)); assert.strictEqual(ok.blocks[0].html, "<p>Hi</p>");
  assert.strictEqual(JSON.parse(ok.blocks[6].data).url, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"); assert.strictEqual(JSON.parse(ok.blocks[7].data).url, "https://player.vimeo.com/video/123456789");
  for (const b of [{ type: "script" }, { type: "text" }, { type: "text", html: "x", onclick: "y" }, { type: "divider", html: "x" }, null, "x"]) assert.strictEqual(L.validateBlocks([b], T).ok, false, JSON.stringify(b));
  assert.strictEqual(L.validateBlocks(new Array(201).fill({ type: "divider" }), T).ok, false); assert.strictEqual(L.validateBlocks("no", T).ok, false); assert.ok(L.validateBlocks([], T).ok);
});
test("block URLs: only this school's LMS media, http(s) links and YouTube/Vimeo; no traversal, other schools, scripts or look-alike hosts", () => {
  for (const u of ["/uploads/school2/lms/a.png", "/uploads/school1/photos/a.png", "/uploads/school1/lms/../../etc/passwd", "/uploads/school1/lms/a.png?x=1", "//evil.com/a.png", "https://evil.com/a.png", "javascript:alert(1)", "/uploads/school1/lms//a.png", "/uploads/school1/lms/a b.png", ""]) assert.strictEqual(L.validateBlocks([img({ url: u })], T).ok, false, u);
  assert.ok(L.validateBlocks([img({ url: "/uploads/school1/lms/unit1/a.png" })], "School1").ok); // tenant keys are normalised exactly like the upload folders
  for (const u of ["javascript:alert(1)", "ftp://x.com/a", "data:text/html,x", "/relative", "https://"]) assert.strictEqual(L.validateBlocks([{ type: "link", url: u, title: "x" }], T).ok, false, u);
  for (const u of ["https://evil.com/embed/dQw4w9WgXcQ", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", "http://youtu.be/dQw4w9WgXcQ", "https://user:pw@youtu.be/dQw4w9WgXcQ", "https://youtube.com/watch?v=<script>", "https://vimeo.com/abc", "https://www.youtube.com/@channel"]) assert.strictEqual(L.validateBlocks([{ type: "embed", url: u }], T).ok, false, u);
  assert.strictEqual(L.validateBlocks([{ type: "embed", url: `/uploads/${T}/lms/a.mp4` }], T).ok, false); // embed = provider only; video may also be an upload
  assert.ok(L.validateBlocks([{ type: "video", url: `/uploads/${T}/lms/a.mp4` }], T).ok);
});
test("images need alt text (or an explicit 'decorative'), for accessibility", () => {
  assert.strictEqual(L.validateBlocks([img({ alt: "" })], T).ok, false); assert.strictEqual(L.validateBlocks([{ type: "image", url: `/uploads/${T}/lms/a.png` }], T).ok, false);
  assert.ok(L.validateBlocks([{ type: "image", url: `/uploads/${T}/lms/a.png`, decorative: true }], T).ok); assert.strictEqual(L.validateBlocks([img({ decorative: "yes" })], T).ok, false);
  assert.strictEqual(L.validateBlocks([img({ alt: "x".repeat(301) })], T).ok, false);
});

/* ---------------- service ---------------- */
test("createLesson: placed last in its section via parameters, audited; limits, foreign sections, archived/missing courses refused", async () => {
  const mk = (extra = []) => makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 2 }]], ["FROM lms_course_sections WHERE id", onlyIds("c", [5], onlyIds("s", [3], [{ id: 3 }]))], ["INSERT INTO lms_lessons", () => [les({ section_id: 3, sort_order: 30 })]], ...extra]);
  const m = mk(); const r = await L.createLesson(m.pool, teacher(), 5, { title: "Cells", sectionId: 3 }); assert.ok(r.ok); assert.strictEqual(r.lesson.sortOrder, 30);
  const q = m.log.find((x) => x.sql.includes("INSERT INTO lms_lessons")); assert.ok(q.sql.includes("ISNULL(MAX(sort_order), 0) + 10") && !q.sql.includes("Cells") && q.inputs.c === 5); assert.ok(m.log.some((x) => x.inputs.act === "lesson.created"));
  assert.strictEqual((await L.createLesson(mk().pool, teacher(), 5, { title: "x", sectionId: 99 })).ok, false);
  assert.strictEqual((await L.createLesson(makeMockPool([live(), ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 1000 }]]]).pool, teacher(), 5, { title: "x" })).code, "LIMIT_REACHED");
  assert.strictEqual((await L.createLesson(makeMockPool([live("archived")]).pool, teacher(), 5, { title: "x" })).code, "COURSE_ARCHIVED");
  assert.strictEqual((await L.createLesson(makeMockPool([live("pending")]).pool, teacher(), 5, { title: "x" })).code, "COURSE_PENDING");
  assert.strictEqual((await L.createLesson(makeMockPool([]).pool, teacher(), 5, { title: "x" })).notFound, true);
  const none = makeMockPool([]); assert.strictEqual((await L.createLesson(none.pool, teacher(), 5, { title: "" })).ok, false); assert.strictEqual(none.log.length, 0);
});
test("update/delete lesson: match lesson id AND course id; other course's lesson is 'not found'; delete is soft; publishing emits an event", async () => {
  const seen = []; const off = on("lms.lesson.published", (e) => seen.push(e));
  const m = makeMockPool([live(), ["UPDATE lms_lessons SET title", onlyIds("id", [9], [les({ title: "New", status: "published" })])], ["UPDATE lms_lessons SET status", onlyIds("id", [9], [les({ status: "published" })])], ["UPDATE lms_lessons SET deleted_at", onlyIds("id", [9], [{ id: 9 }])]]);
  assert.ok((await L.updateLesson(m.pool, teacher(), 5, 9, { title: "New" }, "iso-pub")).ok);
  const q = m.log.find((x) => x.sql.includes("SET title")); assert.ok(q.sql.includes("course_id = @c") && q.sql.includes("deleted_at IS NULL") && q.inputs.c === 5);
  assert.ok((await L.updateLesson(m.pool, teacher(), 5, 9, { status: "published" }, "iso-pub")).ok); await tick();
  assert.strictEqual(seen.filter((e) => e.tenant === "iso-pub").length, 1); assert.deepStrictEqual(Object.keys(seen.find((e) => e.tenant === "iso-pub")).sort(), ["at", "courseId", "event", "lessonId", "tenant"]); /* ids only, no personal data */ off && off();
  assert.strictEqual((await L.updateLesson(m.pool, teacher(), 5, 99, { title: "x" })).notFound, true);
  assert.ok((await L.deleteLesson(m.pool, teacher(), 5, 9)).ok); assert.strictEqual((await L.deleteLesson(m.pool, teacher(), 5, 99)).notFound, true); assert.ok(!m.log.some((x) => /DELETE\s+FROM/i.test(x.sql)));
});
test("reorderLessons: exactly the live lessons of THAT section, once each, in one transaction", async () => {
  const cur = () => makeMockPool([live(), ["SELECT TOP 1000 id FROM lms_lessons", () => [{ id: 1 }, { id: 2 }, { id: 3 }]]]);
  const a = cur(); assert.ok((await L.reorderLessons(a.pool, teacher(), 5, 3, [3, 1, 2])).ok);
  const tx = a.log.find((x) => x.sql.includes("BEGIN TRAN")); assert.ok(tx.sql.includes("COMMIT") && (tx.sql.match(/UPDATE lms_lessons/g) || []).length === 3 && tx.sql.split("UPDATE").slice(1).every((x) => x.includes("course_id = @c")));
  for (const ids of [[1, 2], [1, 2, 3, 4], [1, 2, 99], [1, 1, 2], [1, 2, "x"], "no"]) { const b = cur(); assert.strictEqual((await L.reorderLessons(b.pool, teacher(), 5, 3, ids)).ok, false, JSON.stringify(ids)); assert.ok(!b.log.some((x) => x.sql.includes("BEGIN TRAN"))); }
  assert.strictEqual((await L.reorderLessons(cur().pool, teacher(), 5, "x", [1, 2, 3])).ok, false);
});
test("saveBlocks: ONE guarded atomic statement, content only as parameters, sanitised before storing; stale editor gets a conflict; not found; archived", async () => {
  const blocks = [{ type: "text", html: "<p>Hi<script>x</script></p>" }, img()];
  const m = makeMockPool([live(), ["UPDATE lms_lessons SET content_version", () => [{ new_version: 4, lesson_exists: 1 }]], ["FROM lms_lesson_blocks WHERE lesson_id", () => [{ id: 1, block_type: "text", sort_order: 10, html: "<p>Hi</p>", data: null }, { id: 2, block_type: "image", sort_order: 20, html: null, data: JSON.stringify({ url: `/uploads/${T}/lms/a.png`, alt: "A cell" }) }]]]);
  const r = await L.saveBlocks(m.pool, teacher(), 5, 9, { baseVersion: 3, blocks }, T); assert.ok(r.ok); assert.strictEqual(r.contentVersion, 4); assert.strictEqual(r.blocks[0].html, "<p>Hi</p>"); assert.strictEqual(r.blocks[1].alt, "A cell");
  const tx = m.log.find((x) => x.sql.includes("BEGIN TRAN")); assert.ok(tx.sql.includes("content_version = @v") && tx.sql.includes("IF @@ROWCOUNT = 1") && tx.sql.includes("COMMIT") && tx.sql.includes("XACT_ABORT")); assert.ok(!tx.sql.includes("Hi") && !tx.sql.includes("script"));
  assert.strictEqual(tx.inputs.h0, "<p>Hi</p>"); assert.strictEqual(tx.inputs.v, 3); assert.strictEqual(tx.inputs.c, 5); assert.ok(tx.sql.includes("course_id = @c") && /DELETE FROM lms_lesson_blocks WHERE lesson_id = @l AND course_id = @c/.test(tx.sql));
  assert.ok(m.log.some((x) => x.inputs.act === "lesson.content_saved"));
  const stale = makeMockPool([live(), ["UPDATE lms_lessons SET content_version", () => [{ new_version: null, lesson_exists: 1 }]]]); const c = await L.saveBlocks(stale.pool, teacher(), 5, 9, { baseVersion: 1, blocks: [] }, T); assert.strictEqual(c.code, "CONTENT_CONFLICT"); assert.ok(!stale.log.some((x) => x.inputs.act));
  const gone = makeMockPool([live(), ["UPDATE lms_lessons SET content_version", () => [{ new_version: null, lesson_exists: 0 }]]]); assert.strictEqual((await L.saveBlocks(gone.pool, teacher(), 5, 9, { baseVersion: 1, blocks: [] }, T)).notFound, true);
  const arch = makeMockPool([live("archived")]); assert.strictEqual((await L.saveBlocks(arch.pool, teacher(), 5, 9, { baseVersion: 1, blocks: [] }, T)).code, "COURSE_ARCHIVED"); assert.ok(!arch.log.some((x) => x.sql.includes("BEGIN TRAN")));
  for (const b of [{ blocks: [] }, { baseVersion: "x", blocks: [] }, { baseVersion: 1, blocks: [{ type: "text", html: 5 }] }, { baseVersion: 1, blocks: [], extra: 1 }, null]) { const n = makeMockPool([live()]); assert.strictEqual((await L.saveBlocks(n.pool, teacher(), 5, 9, b, T)).ok, false); assert.ok(!n.log.some((x) => x.sql.includes("BEGIN TRAN"))); }
});
test("students: only published lessons of a published/archived course; draft courses and draft lessons are 'not found'", async () => {
  const course = (rows) => ["FROM lms_courses WHERE id", () => rows];
  const m = makeMockPool([course([{ status: "published" }]), ["FROM lms_course_sections WHERE course_id", () => [{ id: 3, title: "Unit 1", summary: null, sort_order: 10 }]], ["FROM lms_lessons WHERE course_id = @c", () => [{ id: 9, section_id: 3, title: "Cells", summary: null, estimated_minutes: 15, sort_order: 10 }, { id: 10, section_id: null, title: "Intro", summary: null, estimated_minutes: null, sort_order: 20 }]]]);
  const r = await L.listLessonsForStudent(m.pool, 5); assert.ok(r.ok); assert.strictEqual(r.sections[0].lessons[0].title, "Cells"); assert.strictEqual(r.unsectioned[0].title, "Intro");
  const q = m.log.find((x) => x.sql.includes("FROM lms_lessons")); assert.ok(q.sql.includes("status = 'published'") && q.sql.includes("deleted_at IS NULL"));
  assert.ok(m.log.find((x) => x.sql.includes("FROM lms_courses")).sql.includes("status IN ('published','archived')"));
  assert.strictEqual((await L.listLessonsForStudent(makeMockPool([course([])]).pool, 5)).notFound, true);
  const g = makeMockPool([course([{ status: "published" }]), ["FROM lms_lessons WHERE id", onlyIds("id", [9], [{ id: 9, course_id: 5, section_id: 3, title: "Cells", summary: null, estimated_minutes: 15 }])], ["FROM lms_lesson_blocks WHERE lesson_id", () => [{ id: 1, block_type: "text", sort_order: 10, html: "<p>x</p>", data: null }]]]);
  const one = await L.getLessonForStudent(g.pool, 5, 9); assert.ok(one.ok && one.blocks.length === 1); assert.ok(g.log.find((x) => x.sql.includes("FROM lms_lessons WHERE id")).sql.includes("status = 'published'"));
  assert.strictEqual((await L.getLessonForStudent(g.pool, 5, 77)).notFound, true); assert.ok(!("status" in one.lesson) && !("contentVersion" in one.lesson));
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
const LP = "/courses/:courseId/lessons", LI = "/courses/:courseId/lessons/:lessonId";

test("routes: owner and co-teacher edit lessons; non-members, students and strangers get the same 403 and nothing is written", async () => {
  const mk = (role) => makeMockPool([staff([5], role), live(), ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: 0 }]], ["INSERT INTO lms_lessons", () => [les()]]]);
  for (const role of ["teacher", "co_teacher"]) { const a = await call("post", LP, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body: { title: "Cells" } }); assert.strictEqual(a.res.statusCode, 201); }
  const refused = [];
  for (const [user, pool, courseId] of [[teacher(), mk("teacher"), "6"], [student(), makeMockPool([enrolled([5]), live()]), "5"], [{ id: 5, role: "finance", source: "Users" }, mk("teacher"), "5"]]) {
    const r = await call("post", LP, { user, pool: pool.pool, params: { courseId }, body: { title: "x" } }); assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, r.res.body.code === "LMS_FORBIDDEN" ? "LMS_FORBIDDEN" : "COURSE_ACCESS_DENIED"]); assert.ok(!pool.log.some((x) => x.sql.startsWith("INSERT"))); refused.push(r.res);
  }
  const g = await call("get", LP, { user: student(), pool: makeMockPool([enrolled([5])]).pool, params: { courseId: "5" } }); assert.strictEqual(g.res.statusCode, 403); // staff list is not for students
});
test("routes: bad ids 404, invalid bodies 400, stale content 409, order route is not read as an id", async () => {
  const pool = (extra = []) => makeMockPool([staff([5]), live(), ...extra]).pool;
  assert.strictEqual((await call("get", LI, { user: teacher(), pool: pool(), params: { courseId: "5", lessonId: "abc" } })).res.statusCode, 404);
  assert.strictEqual((await call("patch", LI, { user: teacher(), pool: pool(), params: { courseId: "5", lessonId: "9" }, body: { title: "" } })).res.statusCode, 400);
  const c = await call("put", `${LI}/content`, { user: teacher(), pool: pool([["UPDATE lms_lessons SET content_version", () => [{ new_version: null, lesson_exists: 1 }]]]), params: { courseId: "5", lessonId: "9" }, body: { baseVersion: 1, blocks: [] }, tenant: T });
  assert.deepStrictEqual([c.res.statusCode, c.res.body.code], [409, "CONTENT_CONFLICT"]);
  const router = require("../routes/lms"); const idx = (p, m) => router.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods[m]); assert.ok(idx(`${LP}/order`, "put") < idx(LI, "get"));
  const o = await call("put", `${LP}/order`, { user: teacher(), pool: pool([["SELECT TOP 1000 id FROM lms_lessons", () => [{ id: 1 }, { id: 2 }]], ["FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL ORDER", () => []]]), params: { courseId: "5" }, body: { sectionId: null, ids: [2, 1] } }); assert.strictEqual(o.res.statusCode, 200);
  assert.strictEqual((await call("put", `${LP}/order`, { user: teacher(), pool: pool([["SELECT TOP 1000 id FROM lms_lessons", () => [{ id: 1 }]]]), params: { courseId: "5" }, body: { ids: [9] } })).res.statusCode, 409);
});
test("routes: a student sees published lessons of an enrolled course only; staff and strangers are refused on the learner routes", async () => {
  const LL = "/courses/:courseId/learn/lessons", LO = "/courses/:courseId/learn/lessons/:lessonId";
  const pool = () => makeMockPool([enrolled([5]), live("published"), ["FROM lms_course_sections WHERE course_id", () => []], ["FROM lms_lessons WHERE course_id = @c", () => []]]).pool;
  const ok = await call("get", LL, { user: student(), pool: pool(), params: { courseId: "5" } }); assert.strictEqual(ok.res.statusCode, 200);
  const other = await call("get", LL, { user: student(), pool: pool(), params: { courseId: "6" } }); const missing = await call("get", LL, { user: student(), pool: pool(), params: { courseId: "999" } }); sameForbidden(other.res, missing.res);
  const t = makeMockPool([staff([5])]); const asStaff = await call("get", LL, { user: teacher(), pool: t.pool, params: { courseId: "5" } }); assert.strictEqual(asStaff.res.statusCode, 403); assert.strictEqual(t.log.length, 0);
  assert.strictEqual((await call("get", LO, { user: student(), pool: pool(), params: { courseId: "5", lessonId: "x" } })).res.statusCode, 404);
  const draftCourse = makeMockPool([enrolled([5]), ["FROM lms_courses WHERE id", () => []]]); assert.strictEqual((await call("get", LL, { user: student(), pool: draftCourse.pool, params: { courseId: "5" } })).res.statusCode, 404);
});
test("isolation: lesson ids of school B never resolve in school A; B's database is never queried", async () => {
  const Tn = makeTenants({
    isoA: [staff([1]), live(), ["UPDATE lms_lessons SET title", (i) => (i.c === 1 && i.id === 10 ? [les({ id: 10, course_id: 1 })] : [])], ["UPDATE lms_lessons SET content_version", (i) => (i.c === 1 && i.l === 10 ? [{ new_version: 2, lesson_exists: 1 }] : [{ new_version: null, lesson_exists: 0 }])], ["FROM lms_lesson_blocks WHERE lesson_id", () => []]],
    isoB: [staff([2]), live(), ["UPDATE lms_lessons SET title", () => [les({ id: 30, course_id: 2 })]]],
  });
  const own = await call("patch", LI, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "1", lessonId: "10" }, body: { title: "Mine" }, tenant: "isoA" }); assert.strictEqual(own.res.statusCode, 200);
  const foreign = await call("patch", LI, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "1", lessonId: "30" }, body: { title: "Hijack" }, tenant: "isoA" }); assert.strictEqual(foreign.res.statusCode, 404);
  const foreignContent = await call("put", `${LI}/content`, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "1", lessonId: "30" }, body: { baseVersion: 1, blocks: [] }, tenant: "isoA" }); assert.strictEqual(foreignContent.res.statusCode, 404);
  const otherCourse = await call("get", LP, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "2" }, tenant: "isoA" }); const missing = await call("get", LP, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "999" }, tenant: "isoA" }); sameForbidden(otherCourse.res, missing.res);
  const mediaB = await call("put", `${LI}/content`, { user: teacher(), pool: Tn.isoA.pool, params: { courseId: "1", lessonId: "10" }, body: { baseVersion: 1, blocks: [img({ url: "/uploads/isob/lms/a.png" })] }, tenant: "isoA" }); assert.strictEqual(mediaB.res.statusCode, 400); // another school's file cannot be linked
  Tn.assertUntouched("isoB");
});
test("static: schema step 008 additive; every L3.1a route sits behind the licence gate with permission + membership middleware; tables blocklisted; no raw db; no innerHTML-style output", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "008_lms_lessons"); assert.ok(st && STEPS[STEPS.length - 1] === st || STEPS.indexOf(st) >= 7);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(ddl)); assert.ok(/IF NOT EXISTS[^]*CREATE TABLE lms_lessons/.test(ddl) && /CREATE TABLE lms_lesson_blocks/.test(ddl) && /content_version INT NOT NULL DEFAULT 1/.test(ddl));
  const router = require("../routes/lms"), first = router.stack.findIndex((l) => l.route); assert.ok(first >= 2);
  const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/(lessons|learn\/lessons)/.test(l.route.path)); assert.strictEqual(mine.length, 19); // 9 from L3.1a + 4 from L3.3a + 2 student progress routes from L3.4a (view, complete) + 2 prerequisite routes from L3.5a + 2 outcome-tag routes from L3.6
  for (const l of mine) assert.ok(l.route.stack.length >= (/learn/.test(l.route.path) ? 3 : l.route.methods.get ? 2 : 3), l.route.path + " " + Object.keys(l.route.methods));
  assert.ok(router.stack.indexOf(mine[0]) > first);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(/RECORD_TABLE_BLOCKLIST[^;]*"lms_lessons"[^;]*"lms_lesson_blocks"/.test(server));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsLessons.js"), "utf8"); assert.ok(!/mssql"\)\.connect|new sql\.ConnectionPool|getPool|poolPromise/.test(src));
  assert.ok(!/SELECT \*/.test(src));
  assert.ok(/sanitizeHtml/.test(src) && /localMediaUrl/.test(src));
});
