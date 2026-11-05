/* L8.1b - discussion moderation + reports (D-096): validation, thread/post moderation, learner reports, staff queue, resolve, staff reportCount, route gates, tenant isolation.
   Mocked pool only: SQL (UPDATE ... OUTPUT ... FROM join, GROUP BY with MAX(LEFT()), OPENJSON id list, XACT_ABORT batch) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsDiscussionMod.test.js");
const M = require("../utils/lmsDiscussionMod"), D = require("../utils/lmsDiscussions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const NOW = Date.now(), ago = (min) => new Date(NOW - min * 60000).toISOString();
const world = (o = {}, extra = []) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["BEGIN TRAN; DECLARE @n INT;", () => [{ n: o.n ?? 3 }]],
  ["UPDATE t SET pinned", () => (o.noThread ? [] : [{ id: 11, pinned: 1, locked: 0, hidden_at: o.hiddenOut === undefined ? null : o.hiddenOut }])],
  ["SELECT TOP 1 p.id, p.is_opening FROM lms_posts p", (i) => (o.noPost ? [] : [{ id: i.p, is_opening: o.opening ? 1 : 0 }])],
  ["UPDATE lms_posts SET hidden_at", () => (o.noPostUpdate ? [] : [{ id: 2 }])],
  ["SELECT TOP 1 p.id, p.author_source, p.author_id FROM lms_posts p", () => (o.noVisible ? [] : [{ id: 2, author_source: o.postAuthorSource || "Students", author_id: o.postAuthorId ?? 31 }])],
  ["INSERT INTO lms_post_reports", () => (o.dup ? (() => { const e = new Error("dup"); e.number = 2601; throw e; })() : o.noReport ? [] : [{ id: 77 }])],
  ["SELECT TOP 1 id FROM lms_post_reports", () => (o.already ? [{ id: 5 }] : [])],
  ["SELECT COUNT(DISTINCT r.post_id) AS n", () => [{ n: o.queueTotal ?? 2 }]],
  ["GROUP BY p.id, p.thread_id", () => o.queue || [
    { post_id: 2, thread_id: 11, forum_id: 1, is_opening: 0, hidden_at: null, author_source: "Students", author_id: 30, excerpt: "x".repeat(400), thread_title: "Welcome", author_name: "Amina Kamau", report_count: 3, open_count: 2, open_report_id: 41, first_at: ago(50), last_at: ago(5) },
    { post_id: 1, thread_id: 11, forum_id: 1, is_opening: 1, hidden_at: ago(1), author_source: "Teachers", author_id: 7, excerpt: "Hello", thread_title: "Welcome", author_name: "Mary Wanjiru", report_count: 1, open_count: 0, open_report_id: null, first_at: ago(80), last_at: ago(70) }]],
  ["SELECT r.post_id, r.reason FROM lms_post_reports r", () => o.reasons || [{ post_id: 2, reason: "rude" }, { post_id: 2, reason: "spam" }, { post_id: 2, reason: "a" }, { post_id: 2, reason: "b" }, { post_id: 2, reason: "c" }, { post_id: 2, reason: "d" }, { post_id: 1, reason: "odd" }]],
  ["SELECT TOP 1 r.id, r.post_id, r.resolved_at", () => (o.noRep ? [] : [{ id: 9, post_id: 2, resolved_at: o.resolvedAt || null, is_opening: o.opening ? 1 : 0, thread_id: 11 }])],
  ["FROM lms_threads t LEFT JOIN Students st", () => [{ id: 11, title: "Welcome", pinned: 0, locked: 0, hidden_at: null, author_source: "Teachers", author_id: 7, author_name: "Mary Wanjiru", created_at: ago(500), reply_count: 1, last_post_at: ago(10), report_count: 2 }]],
  ["FROM lms_forums WHERE id = @f AND course_id = @c", (i) => [{ id: i.f, title: "General", description: null, staff_only: 0, locked: 0, is_default: 1 }]],
  ["SELECT COUNT(*) AS n FROM lms_threads t", () => [{ n: 1 }]],
  ["FROM lms_threads t JOIN lms_forums f", () => [{ id: 11, forum_id: 1, title: "Welcome", pinned: 0, locked: 0, hidden_at: null, hidden_reason: null, author_source: "Teachers", author_id: 7, author_name: "M W", created_at: ago(500), forum_locked: 0, forum_title: "G" }]],
  ["SELECT COUNT(*) AS n FROM lms_posts p", () => [{ n: 1 }]],
  ["FROM lms_posts p LEFT JOIN Students st", () => [{ id: 2, body: "My answer", is_opening: 0, author_source: "Students", author_id: 30, author_name: "Amina Kamau", hidden_at: null, hidden_reason: null, edited_at: null, created_at: ago(5), report_count: 4 }]],
  ...extra]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const sqlOf = (m, needle) => (m.log.find((x) => x.sql.includes(needle)) || {}).sql || "";
const inOf = (m, needle) => (m.log.find((x) => x.sql.includes(needle)) || {}).inputs || {};
const det = (m, n = 0) => JSON.parse(audits(m)[n].inputs.d);
const noSql = (m) => assert.strictEqual(m.log.length, 0, "no query may run");

test("validation (pure): thread moderation needs a boolean change; reason only with hide; trimmed, capped; unknown fields; post needs hidden; report/resolve bodies", () => {
  const t = M.validateThreadMod;
  assert.deepStrictEqual(t({ pinned: true }).value, { pinned: true }); assert.deepStrictEqual(t({ hidden: true, reason: " <b>rude</b> " }).value, { hidden: true, reason: "brude/b" }); assert.deepStrictEqual(t({ locked: false, hidden: false }).value, { locked: false, hidden: false });
  for (const b of [{}, { reason: "x" }, { pinned: "yes" }, { locked: 1 }, { hidden: null }, { hidden: false, reason: "x" }, { pinned: true, reason: "x" }, { hidden: true, reason: "x".repeat(301) }, { hidden: true, reason: 5 }, { pinned: true, x: 1 }, null, [], "t"]) assert.strictEqual(t(b).ok, false, JSON.stringify(b));
  assert.strictEqual(t({ hidden: true, reason: "x".repeat(300) }).ok, true); assert.strictEqual(t({ hidden: true, reason: "   " }).value.reason, undefined); assert.strictEqual(t({ hidden: true, reason: null }).ok, true);
  const p = M.validatePostMod; assert.deepStrictEqual(p({ hidden: true, reason: "r" }).value, { hidden: true, reason: "r" }); assert.deepStrictEqual(p({ hidden: false }).value, { hidden: false });
  for (const b of [{}, { hidden: "true" }, { hidden: false, reason: "x" }, { hidden: true, extra: 1 }, { hidden: true, reason: "x".repeat(301) }, null]) assert.strictEqual(p(b).ok, false, JSON.stringify(b));
  const r = M.validateReport; assert.deepStrictEqual(r(undefined).value, { reason: null }); assert.deepStrictEqual(r({}).value, { reason: null }); assert.deepStrictEqual(r({ reason: " spam<> " }).value, { reason: "spam" });
  for (const b of [{ reason: "x".repeat(301) }, { reason: 5 }, { other: 1 }, [], "x"]) assert.strictEqual(r(b).ok, false, JSON.stringify(b));
  const s = M.validateResolve; assert.deepStrictEqual(s({ action: "dismiss" }).value, { action: "dismiss", reason: null }); assert.deepStrictEqual(s({ action: "hide", reason: "bad" }).value, { action: "hide", reason: "bad" });
  for (const b of [{}, { action: "delete" }, { action: "dismiss", reason: "x" }, { action: "hide", x: 1 }, { action: "hide", reason: "x".repeat(301) }, null]) assert.strictEqual(s(b).ok, false, JSON.stringify(b));
});

test("moderateThread: ONE guarded UPDATE scoped by course, only the sent flags change, hide sets all four hidden_* columns and un-hide clears them, audited with flags only", async () => {
  const m = world(); const r = await M.moderateThread(m.pool, teacher, 5, 11, { pinned: true, hidden: true, reason: "off topic" });
  assert.deepStrictEqual([r.ok, r.thread.id, r.thread.pinned], [true, 11, true]); const u = sqlOf(m, "UPDATE t SET pinned"), i = inOf(m, "UPDATE t SET pinned");
  assert.ok(/WHERE t\.id = @t AND t\.course_id = @c AND t\.deleted_at IS NULL$/.test(u) && /f\.deleted_at IS NULL/.test(u) && /OUTPUT INSERTED\.id/.test(u) && !/DELETE FROM/.test(u));
  assert.ok(/hidden_at = CASE WHEN @hid = 1 THEN COALESCE\(t\.hidden_at, SYSUTCDATETIME\(\)\) WHEN @hid = 0 THEN NULL ELSE t\.hidden_at END/.test(u) && /hidden_by_source = CASE WHEN @hid = 1 THEN @src WHEN @hid = 0 THEN NULL ELSE t\.hidden_by_source END/.test(u) && /hidden_by = CASE WHEN @hid = 1 THEN @uid WHEN @hid = 0 THEN NULL ELSE t\.hidden_by END/.test(u) && /hidden_reason = CASE WHEN @hid = 1 THEN @rs WHEN @hid = 0 THEN NULL ELSE t\.hidden_reason END/.test(u));
  assert.ok(/pinned = COALESCE\(@pin, t\.pinned\), locked = COALESCE\(@lk, t\.locked\)/.test(u));
  assert.deepStrictEqual([i.c, i.t, i.pin, i.lk, i.hid, i.rs, i.src, i.uid], [5, 11, 1, null, 1, "off topic", "Teachers", 7], "unsent flags travel as NULL = keep");
  const a = audits(m); assert.strictEqual(a.length, 1); assert.strictEqual(a[0].inputs.act, "thread.moderated"); assert.deepStrictEqual(det(m), { courseId: 5, changed: { pinned: true, hidden: true }, reasonGiven: true }); assert.ok(!/off topic/.test(JSON.stringify(a[0].inputs)), "ids + flags only, no reason text");
  const un = world(); await M.moderateThread(un.pool, admin, 5, 11, { hidden: false, locked: true }); const j = inOf(un, "UPDATE t SET pinned"); assert.deepStrictEqual([j.hid, j.lk, j.pin, j.rs], [0, 1, null, null]);
  const only = world(); await M.moderateThread(only.pool, teacher, 5, 11, { locked: true }); assert.strictEqual(inOf(only, "UPDATE t SET pinned").hid, null, "locking must not touch hidden state");
  assert.strictEqual((await M.moderateThread(world({ noThread: true }).pool, teacher, 5, 99, { pinned: true })).notFound, true);
});

test("moderateThread: only a PUBLISHED course (archived read only, draft refused), students and bad input refused before any write, another course's thread = 404", async () => {
  assert.strictEqual((await M.moderateThread(world({ status: "archived" }).pool, teacher, 5, 11, { pinned: true })).code, "COURSE_READ_ONLY"); assert.strictEqual((await M.moderateThread(world({ status: "draft" }).pool, teacher, 5, 11, { pinned: true })).code, "COURSE_NOT_PUBLISHED");
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const z = world(); const r = await M.moderateThread(z.pool, u, id, 11, { pinned: true }); assert.strictEqual(r.notFound, true); assert.ok(!z.log.some((x) => /UPDATE t SET/.test(x.sql))); }
  const bad = world(); for (const b of [{}, { pinned: "x" }, null]) assert.strictEqual((await M.moderateThread(bad.pool, teacher, 5, 11, b)).ok, false); assert.strictEqual(bad.log.length, 0);
  const z = world(); assert.strictEqual((await M.moderateThread(z.pool, teacher, 5, "abc", { pinned: true })).notFound, true); assert.ok(!z.log.some((x) => /UPDATE t SET/.test(x.sql)));
});

test("moderatePost: the OPENING post is refused (409, nothing written), hide/un-hide guard is_opening = 0 inside the UPDATE, audited without text, learner/other course refused", async () => {
  const o = world({ opening: true }); assert.strictEqual((await M.moderatePost(o.pool, teacher, 5, 1, { hidden: true })).code, "OPENING_POST"); assert.ok(!o.log.some((x) => /UPDATE lms_posts/.test(x.sql)) && audits(o).length === 0);
  const m = world(); const r = await M.moderatePost(m.pool, teacher, 5, 2, { hidden: true, reason: "rude words" }); assert.deepStrictEqual([r.ok, r.post.id, r.post.hidden], [true, 2, true]);
  const u = sqlOf(m, "UPDATE lms_posts SET hidden_at"), i = inOf(m, "UPDATE lms_posts SET hidden_at"); assert.ok(/WHERE id = @p AND course_id = @c AND deleted_at IS NULL AND is_opening = 0$/.test(u) && /hidden_by_source = CASE WHEN @hid = 1 THEN @src ELSE NULL END/.test(u) && /hidden_reason = CASE WHEN @hid = 1 THEN @rs ELSE NULL END/.test(u));
  assert.deepStrictEqual([i.hid, i.rs, i.src, i.uid, i.c, i.p], [1, "rude words", "Teachers", 7, 5, 2]); const pre = sqlOf(m, "SELECT TOP 1 p.id, p.is_opening"); assert.ok(/p\.course_id = @c/.test(pre) && /t\.deleted_at IS NULL/.test(pre) && /f\.deleted_at IS NULL/.test(pre) && !/staff_only/.test(pre), "staff may moderate staff-only forums");
  assert.strictEqual(audits(m)[0].inputs.act, "post.moderated"); assert.deepStrictEqual(det(m), { courseId: 5, changed: { hidden: true }, reasonGiven: true }); assert.ok(!/rude words/.test(JSON.stringify(audits(m)[0].inputs)));
  const un = world(); await M.moderatePost(un.pool, admin, 5, 2, { hidden: false }); assert.deepStrictEqual([inOf(un, "UPDATE lms_posts SET hidden_at").hid, inOf(un, "UPDATE lms_posts SET hidden_at").rs], [0, null]);
  assert.strictEqual((await M.moderatePost(world({ noPost: true }).pool, teacher, 5, 99, { hidden: true })).notFound, true); assert.strictEqual((await M.moderatePost(world({ noPostUpdate: true }).pool, teacher, 5, 2, { hidden: true })).notFound, true);
  assert.strictEqual((await M.moderatePost(world({ status: "archived" }).pool, teacher, 5, 2, { hidden: true })).code, "COURSE_READ_ONLY");
  for (const [uu, id] of [[student, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await M.moderatePost(z.pool, uu, id, 2, { hidden: true })).notFound, true); assert.ok(!z.log.some((x) => /UPDATE lms_posts/.test(x.sql))); }
  const bad = world(); for (const b of [{}, { hidden: "y" }, { hidden: false, reason: "x" }]) assert.strictEqual((await M.moderatePost(bad.pool, teacher, 5, 2, b)).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("reportPost: only a post the learner can SEE (visibility predicates in SQL, staff-only forums excluded), never their own, ONE insert guarded against duplicates and the hourly cap, repeat = already, race on the unique index = already", async () => {
  const m = world(); const r = await M.reportPost(m.pool, student, 5, 2, { reason: " spam " }); assert.deepStrictEqual([r.ok, r.reported, r.already], [true, true, undefined]);
  const f = sqlOf(m, "SELECT TOP 1 p.id, p.author_source"); assert.ok(/t\.hidden_at IS NULL OR \(t\.author_source = N'Students' AND t\.author_id = @vid\)/.test(f) && /p\.hidden_at IS NULL OR \(p\.author_source = N'Students' AND p\.author_id = @vid\)/.test(f) && /f\.staff_only = 0/.test(f) && /p\.course_id = @c/.test(f) && inOf(m, "SELECT TOP 1 p.id, p.author_source").vid === 30);
  const w = sqlOf(m, "INSERT INTO lms_post_reports"), i = inOf(m, "INSERT INTO lms_post_reports"); assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_post_reports WITH \(UPDLOCK, HOLDLOCK\) WHERE post_id = @p AND reporter_source = @src AND reporter_id = @vid\)/.test(w) && /DATEADD\(HOUR, -1, SYSUTCDATETIME\(\)\)\) < @lim$/.test(w) && /course_id = @c AND reporter_source = @src AND reporter_id = @vid AND created_at/.test(w));
  assert.deepStrictEqual([i.p, i.c, i.src, i.vid, i.rs, i.lim], [2, 5, "Students", 30, "spam", 20], "the reporter is always the token's learner");
  assert.strictEqual((await M.reportPost(world({ postAuthorId: 30 }).pool, student, 5, 2, {})).code, "OWN_POST"); const own = world({ postAuthorId: 30 }); await M.reportPost(own.pool, student, 5, 2, {}); assert.ok(!own.log.some((x) => /INSERT INTO lms_post_reports/.test(x.sql)));
  assert.strictEqual((await M.reportPost(world({ postAuthorSource: "Teachers", postAuthorId: 30 }).pool, student, 5, 2, {})).reported, true, "same numeric id but a different source is a different person");
  const rep = await M.reportPost(world({ noReport: true, already: true }).pool, student, 5, 2, {}); assert.deepStrictEqual([rep.ok, rep.reported, rep.already], [true, true, true]);
  assert.strictEqual((await M.reportPost(world({ noReport: true }).pool, student, 5, 2, {})).code, "REPORT_RATE_LIMIT");
  const race = await M.reportPost(world({ dup: true }).pool, student, 5, 2, {}); assert.deepStrictEqual([race.ok, race.already], [true, true]);
  assert.strictEqual((await M.reportPost(world({ noVisible: true }).pool, student, 5, 3, {})).notFound, true);
  assert.strictEqual((await M.reportPost(world({ status: "archived" }).pool, student, 5, 2, {})).code, "COURSE_READ_ONLY"); assert.strictEqual((await M.reportPost(world({ status: "draft" }).pool, student, 5, 2, {})).notFound, true);
  for (const [u, id] of [[teacher, 5], [null, 5], [student, 6], [student, "x"]]) { const z = world(); assert.strictEqual((await M.reportPost(z.pool, u, id, 2, {})).notFound, true); assert.ok(!z.log.some((x) => /INSERT INTO lms_post_reports/.test(x.sql))); }
  const bad = world(); assert.strictEqual((await M.reportPost(bad.pool, student, 5, 2, { reason: "x".repeat(301) })).ok, false); assert.strictEqual(bad.log.length, 0);
  const boom = world(); const old = boom.pool.request; boom.pool.request = () => { const r = old(); const q = r.query; r.query = async (s) => { if (/INSERT INTO lms_post_reports/.test(s)) throw new Error("db down"); return q(s); }; return r; };
  await assert.rejects(() => M.reportPost(boom.pool, student, 5, 2, {}), /db down/);
});

test("listReports: staff only, status filter in SQL (open default), grouped by post, reporter never selected or shown, excerpt 300, reasons capped at 5 per post via OPENJSON, paging capped, bad status = 400", async () => {
  const m = world(); const r = await M.listReports(m.pool, teacher, 5, { page: "2", pageSize: "500" }); assert.ok(r.ok); const list = sqlOf(m, "GROUP BY p.id, p.thread_id"), cnt = sqlOf(m, "SELECT COUNT(DISTINCT r.post_id)");
  assert.ok(/AND r\.resolved_at IS NULL/.test(list) && /AND r\.resolved_at IS NULL/.test(cnt) && /r\.course_id = @c/.test(list) && /p\.deleted_at IS NULL/.test(list) && /t\.deleted_at IS NULL/.test(list) && /f\.deleted_at IS NULL/.test(list));
  assert.ok(/ORDER BY MAX\(r\.created_at\) DESC, p\.id DESC OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY/.test(list) && inOf(m, "GROUP BY p.id, p.thread_id").ps === 50 && inOf(m, "GROUP BY p.id, p.thread_id").off === 50 && /LEFT\(p\.body, 300\)/.test(list));
  assert.ok(!/reporter_id|reporter_source/.test(list) && !/reporter/i.test(JSON.stringify(r)), "reporter identity is not read or returned (Q69)");
  assert.deepStrictEqual([r.items[0].postId, r.items[0].excerpt.length, r.items[0].reportCount, r.items[0].openCount, r.items[0].reasons, r.items[0].author, r.items[1].hidden, r.items[1].isOpening, r.items[1].reasons], [2, 300, 3, 2, ["rude", "spam", "a", "b", "c"], { name: "Amina K.", isStaff: false }, true, true, ["odd"]]);
  assert.deepStrictEqual([r.items[0].openReportId, r.items[1].openReportId], [41, null]); // S94: the screen needs an open report id to resolve
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.hasMore, r.status], [2, 2, 50, false, "open"]); assert.ok(!/author_id|authorId|admission/i.test(JSON.stringify(r)));
  const rs = sqlOf(m, "SELECT r.post_id, r.reason"); assert.ok(/OPENJSON\(@ids\)/.test(rs) && /r\.course_id = @c/.test(rs) && /AND r\.resolved_at IS NULL/.test(rs) && inOf(m, "SELECT r.post_id, r.reason").ids === "[2,1]");
  const res = world(); await M.listReports(res.pool, teacher, 5, { status: "resolved" }); assert.ok(/AND r\.resolved_at IS NOT NULL/.test(sqlOf(res, "GROUP BY p.id")) && /AND r\.resolved_at IS NOT NULL/.test(sqlOf(res, "SELECT r.post_id, r.reason")));
  const all = world(); await M.listReports(all.pool, admin, 5, { status: "all" }); assert.ok(!/resolved_at IS (NOT )?NULL AND|AND r\.resolved_at IS/.test(sqlOf(all, "SELECT COUNT(DISTINCT"))); const e = world({ queue: [], queueTotal: 0 }); const er = await M.listReports(e.pool, teacher, 5, {}); assert.deepStrictEqual([er.items.length, er.total, er.hasMore], [0, 0, false]); assert.ok(!e.log.some((x) => /OPENJSON/.test(x.sql)), "no reasons query for an empty page");
  const bad = world(); assert.strictEqual((await M.listReports(bad.pool, teacher, 5, { status: "everything" })).ok, false); assert.ok(!bad.log.some((x) => /lms_post_reports/.test(x.sql)));
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await M.listReports(z.pool, u, id, {})).notFound, true); assert.ok(!z.log.some((x) => /lms_post_reports/.test(x.sql))); }
  const arch = await M.listReports(world({ status: "archived" }).pool, teacher, 5, {}); assert.ok(arch.ok, "reading the queue works in an archived course");
});

test("resolveReport: dismiss/hide in ONE atomic batch that closes ALL open reports of the post first, hide only runs when something was resolved, opening post hides the THREAD, races and repeats give ALREADY_RESOLVED, audited", async () => {
  const d = world(); const r = await M.resolveReport(d.pool, teacher, 5, 9, { action: "dismiss" }); assert.deepStrictEqual([r.ok, r.action, r.resolved, r.hidden], [true, "dismiss", 3, null]);
  const b = sqlOf(d, "BEGIN TRAN; DECLARE @n INT;"); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(b) && /UPDATE lms_post_reports SET resolved_at = SYSUTCDATETIME\(\), resolved_by_source = @src, resolved_by = @vid, resolution = @act WHERE post_id = @p AND course_id = @c AND resolved_at IS NULL;/.test(b) && /SET @n = @@ROWCOUNT/.test(b) && /COMMIT; SELECT @n AS n/.test(b) && !/lms_posts|lms_threads/.test(b), "a dismissal touches nothing but reports");
  const h = world(); const hr = await M.resolveReport(h.pool, teacher, 5, 9, { action: "hide", reason: "bullying" }); assert.deepStrictEqual([hr.ok, hr.hidden], [true, "post"]); const hb = sqlOf(h, "BEGIN TRAN; DECLARE @n INT;");
  assert.ok(hb.indexOf("UPDATE lms_post_reports") < hb.indexOf("IF @n > 0 UPDATE lms_posts") && /IF @n > 0 UPDATE lms_posts SET hidden_at = COALESCE\(hidden_at, SYSUTCDATETIME\(\)\), hidden_by_source = @src, hidden_by = @vid, hidden_reason = @rs WHERE id = @p AND course_id = @c AND deleted_at IS NULL AND is_opening = 0;/.test(hb) && !/lms_threads/.test(hb));
  assert.deepStrictEqual([inOf(h, "BEGIN TRAN").rs, inOf(h, "BEGIN TRAN").p, inOf(h, "BEGIN TRAN").act, inOf(h, "BEGIN TRAN").src, inOf(h, "BEGIN TRAN").vid], ["bullying", 2, "hide", "Teachers", 7]);
  const dflt = world(); await M.resolveReport(dflt.pool, teacher, 5, 9, { action: "hide" }); assert.strictEqual(inOf(dflt, "BEGIN TRAN").rs, "Hidden after a report");
  const o = world({ opening: true }); const or = await M.resolveReport(o.pool, teacher, 5, 9, { action: "hide" }); assert.strictEqual(or.hidden, "thread"); const ob = sqlOf(o, "BEGIN TRAN; DECLARE @n INT;"); assert.ok(/IF @n > 0 UPDATE lms_threads SET hidden_at = COALESCE\(hidden_at, SYSUTCDATETIME\(\)\)[^;]*WHERE id = @th AND course_id = @c AND deleted_at IS NULL;/.test(ob) && !/UPDATE lms_posts/.test(ob) && inOf(o, "BEGIN TRAN").th === 11);
  const a = audits(h); assert.strictEqual(a.length, 1); assert.strictEqual(a[0].inputs.act, "report.resolved"); assert.deepStrictEqual(det(h), { courseId: 5, postId: 2, action: "hide", resolved: 3, target: "post" }); assert.ok(!/bullying/.test(JSON.stringify(a[0].inputs)));
  assert.strictEqual((await M.resolveReport(world({ resolvedAt: ago(3) }).pool, teacher, 5, 9, { action: "dismiss" })).code, "ALREADY_RESOLVED"); const done = world({ resolvedAt: ago(3) }); await M.resolveReport(done.pool, teacher, 5, 9, { action: "hide" }); assert.ok(!done.log.some((x) => /BEGIN TRAN/.test(x.sql)));
  const race = world({ n: 0 }); assert.strictEqual((await M.resolveReport(race.pool, teacher, 5, 9, { action: "hide" })).code, "ALREADY_RESOLVED"); assert.strictEqual(audits(race).length, 0);
  assert.strictEqual((await M.resolveReport(world({ noRep: true }).pool, teacher, 5, 99, { action: "dismiss" })).notFound, true);
  const f = sqlOf(d, "SELECT TOP 1 r.id, r.post_id, r.resolved_at"); assert.ok(/r\.id = @r AND r\.course_id = @c/.test(f) && /p\.deleted_at IS NULL/.test(f) && /t\.deleted_at IS NULL/.test(f));
  assert.strictEqual((await M.resolveReport(world({ status: "archived" }).pool, teacher, 5, 9, { action: "dismiss" })).code, "COURSE_READ_ONLY");
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await M.resolveReport(z.pool, u, id, 9, { action: "dismiss" })).notFound, true); assert.ok(!z.log.some((x) => /BEGIN TRAN/.test(x.sql))); }
  const bad = world(); for (const x of [{}, { action: "ban" }, { action: "dismiss", reason: "x" }]) assert.strictEqual((await M.resolveReport(bad.pool, teacher, 5, 9, x)).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("reportCount: staff see open reports per post (thread page) and per thread (list); learners' SQL never touches the reports table and their answers carry no reportCount", async () => {
  const s = world(); const t = await D.getThread(s.pool, teacher, 5, 11, {}, true); assert.strictEqual(t.posts[0].reportCount, 4);
  assert.ok(/\(SELECT COUNT\(\*\) FROM lms_post_reports rp WHERE rp\.post_id = p\.id AND rp\.course_id = p\.course_id AND rp\.resolved_at IS NULL\) AS report_count/.test(sqlOf(s, "FROM lms_posts p LEFT JOIN Students st")));
  const sl = world(); const l = await D.listThreads(sl.pool, teacher, 5, 1, {}, true); assert.strictEqual(l.items[0].reportCount, 2); assert.ok(/rp\.course_id = @c AND rp\.resolved_at IS NULL\) AS report_count/.test(sqlOf(sl, "FROM lms_threads t LEFT JOIN Students st")) && /pp\.deleted_at IS NULL/.test(sqlOf(sl, "FROM lms_threads t LEFT JOIN Students st")));
  const ln = world(); const lt = await D.getThread(ln.pool, student, 5, 11, {}, false), ll = await D.listThreads(ln.pool, student, 5, 1, {}, false);
  assert.ok(!ln.log.some((x) => /lms_post_reports/.test(x.sql)), "no learner query reads reports"); assert.ok(!/reportCount|report_count/.test(JSON.stringify([lt, ll])));
});

test("after moderation a hidden post/thread stays invisible to OTHER learners: moderation writes hidden_at, the learner predicates read hidden_at, and no hidden_* detail leaks to learners", async () => {
  const m = world(); await M.moderatePost(m.pool, teacher, 5, 2, { hidden: true, reason: "secret reason" }); assert.ok(/hidden_at = CASE WHEN @hid = 1/.test(sqlOf(m, "UPDATE lms_posts SET hidden_at")));
  const L = world(); const t = await D.getThread(L.pool, student, 5, 11, {}, false); await D.listThreads(L.pool, student, 5, 1, {}, false); await D.listForums(L.pool, student, 5, false);
  for (const needle of ["SELECT COUNT(*) AS n FROM lms_posts p", "FROM lms_posts p LEFT JOIN Students st", "SELECT COUNT(*) AS n FROM lms_threads t", "FROM lms_threads t LEFT JOIN Students st", "FROM lms_threads t JOIN lms_forums f", "FROM lms_forums f WHERE f.course_id = @c"]) assert.ok(/hidden_at IS NULL OR \([a-z]+\.author_source = N'Students' AND [a-z]+\.author_id = @vid\)/.test(sqlOf(L, needle)), needle);
  assert.ok(!/hiddenBy|hidden_by|secret reason/.test(JSON.stringify(t)));
  const rp = await M.reportPost(L.pool, student, 5, 2, {}); assert.ok(rp.ok); assert.ok(/hidden_at IS NULL OR/.test(sqlOf(L, "SELECT TOP 1 p.id, p.author_source")), "a hidden post cannot be reported by someone else either");
});

test("routes: five new routes, all behind lms_discussions; staff ones course.manage + staffAccess, the learner report studentOnly + studentAccess; shapes and status codes; a learner token on a staff handler is refused", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), DS = "/courses/:courseId/discussions", DL = "/courses/:courseId/learn/discussions";
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const staff = [["put", `${DS}/threads/:threadId/moderation`], ["put", `${DS}/posts/:postId/moderation`], ["get", `${DS}/reports`], ["post", `${DS}/reports/:reportId/resolve`]];
  for (const [m, p] of staff) { const r = find(m, p); assert.ok(r, `${m} ${p}`); assert.strictEqual(r.route.stack.length, 4, p); }
  assert.ok((src.match(/dGate, gbManage, staffAccess, dRun\("(THREAD MODERATE|POST MODERATE|REPORTS LIST|REPORT RESOLVE)"/g) || []).length === 4 && /\/posts\/:postId\/report`, dGate, studentOnly, studentAccess, dRun\("POST REPORT"/.test(src));
  assert.strictEqual(find("post", `${DL}/posts/:postId/report`).route.stack.length, 4); assert.ok(!find("put", `${DL}/threads/:threadId/moderation`) && !find("put", `${DL}/posts/:postId/moderation`) && !find("get", `${DL}/reports`) && !find("post", `${DL}/reports/:reportId/resolve`), "learners have no moderation routes");
  const h = (m, p) => find(m, p).route.stack.slice(-1)[0].handle, base = (o) => ({ params: { courseId: "5", threadId: "11", postId: "2", reportId: "9" }, query: {}, tenant: "t", ...o });
  let res = makeRes(); await h("put", `${DS}/threads/:threadId/moderation`)(base({ pool: world().pool, user: teacher, body: { pinned: true } }), res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.thread.pinned, "ok" in res.body], [200, true, true, false]);
  res = makeRes(); await h("put", `${DS}/threads/:threadId/moderation`)(base({ pool: world().pool, user: teacher, body: {} }), res); assert.strictEqual(res.statusCode, 400);
  res = makeRes(); await h("put", `${DS}/posts/:postId/moderation`)(base({ pool: world({ opening: true }).pool, user: teacher, body: { hidden: true }, params: { courseId: "5", postId: "1" } }), res); assert.deepStrictEqual([res.statusCode, res.body.code], [409, "OPENING_POST"]);
  res = makeRes(); await h("put", `${DS}/posts/:postId/moderation`)(base({ pool: world({ noPost: true }).pool, user: teacher, body: { hidden: true }, params: { courseId: "5", postId: "abc" } }), res); assert.strictEqual(res.statusCode, 404);
  res = makeRes(); await h("get", `${DS}/reports`)(base({ pool: world().pool, user: teacher }), res); assert.deepStrictEqual([res.statusCode, res.body.items.length, res.body.total], [200, 2, 2]);
  res = makeRes(); await h("get", `${DS}/reports`)(base({ pool: world().pool, user: teacher, query: { status: "zzz" } }), res); assert.strictEqual(res.statusCode, 400);
  res = makeRes(); await h("post", `${DS}/reports/:reportId/resolve`)(base({ pool: world().pool, user: teacher, body: { action: "hide" } }), res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.resolved], [200, true, 3]);
  res = makeRes(); await h("post", `${DS}/reports/:reportId/resolve`)(base({ pool: world({ resolvedAt: ago(1) }).pool, user: teacher, body: { action: "hide" } }), res); assert.deepStrictEqual([res.statusCode, res.body.code], [409, "ALREADY_RESOLVED"]);
  res = makeRes(); await h("post", `${DL}/posts/:postId/report`)(base({ pool: world().pool, user: student, body: { reason: "rude" } }), res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.reported], [200, true, true]);
  res = makeRes(); await h("post", `${DL}/posts/:postId/report`)(base({ pool: world({ noReport: true, already: true }).pool, user: student, body: {} }), res); assert.deepStrictEqual([res.statusCode, res.body.already], [200, true]);
  res = makeRes(); await h("post", `${DL}/posts/:postId/report`)(base({ pool: world({ postAuthorId: 30 }).pool, user: student, body: {} }), res); assert.deepStrictEqual([res.statusCode, res.body.code], [409, "OWN_POST"]);
  res = makeRes(); await h("post", `${DL}/posts/:postId/report`)(base({ pool: world().pool, user: teacher, body: {} }), res); assert.strictEqual(res.statusCode, 404, "a staff token on the learner report handler is refused");
  res = makeRes(); await h("put", `${DS}/threads/:threadId/moderation`)(base({ pool: world().pool, user: student, body: { hidden: true } }), res); assert.strictEqual(res.statusCode, 404, "a learner token on a staff handler is refused even if the guards were bypassed");
});

test("tenant isolation + ID guessing: another school's pool sees no course so nothing is read or written; every table access is scoped by course_id", async () => {
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] });
  for (const r of [await M.moderateThread(T.A.pool, teacher, 5, 11, { pinned: true }), await M.moderatePost(T.A.pool, teacher, 5, 2, { hidden: true }), await M.reportPost(T.A.pool, student, 5, 2, {}), await M.listReports(T.A.pool, teacher, 5, {}), await M.resolveReport(T.A.pool, teacher, 5, 9, { action: "dismiss" })]) assert.strictEqual(r.notFound, true);
  T.assertUntouched("B");
  const m = world(); await M.moderateThread(m.pool, teacher, 5, 11, {pinned: true}); await M.moderatePost(m.pool, teacher, 5, 2, { hidden: true }); await M.reportPost(m.pool, student, 5, 2, {}); await M.listReports(m.pool, teacher, 5, {}); await M.resolveReport(m.pool, teacher, 5, 9, { action: "hide" });
  for (const x of m.log.filter((y) => /lms_(threads|posts|forums|post_reports)/.test(y.sql) && !/lms_courses|lms_audit_log/.test(y.sql))) assert.ok(/course_id = @c/.test(x.sql), `unscoped SQL: ${x.sql.slice(0, 100)}`);
});

test("no schema step added by L8.1b (034 is only followed by groups 035 (L8.2a) and group forums 036 (L8.2b) and peer review 037 (L8.3a)) and no new table needs blocking from the record editor", () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id); assert.strictEqual(ids[ids.length - 12], "034_lms_discussions");
  const t = schema.STEPS[ids.length - 12].sql.join("\n"); for (const c of ["hidden_by_source", "hidden_by INT", "hidden_reason", "resolved_by_source", "resolution"]) assert.ok(t.includes(c), c);
});
