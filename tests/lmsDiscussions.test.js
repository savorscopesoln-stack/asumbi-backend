/* L8.1a - course discussions (D-095): validation, viewer rules, forum management, visibility SQL, threads/posts, locks, rate limit, word-filter hook, edit window, schema 034, route gates.
   Mocked pool only: SQL (OFFSET/FETCH paging, correlated counts, SCOPE_IDENTITY batch, filtered unique index) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsDiscussions.test.js");
const D = require("../utils/lmsDiscussions"), W = require("../utils/lmsWordFilter"), events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const NOW = Date.now(), ago = (min) => new Date(NOW - min * 60000).toISOString();
const world = (o = {}, extra = []) => makeMockPool([
  ["INSERT INTO lms_threads", () => [o.noInsert ? { threadId: null, postId: null } : { threadId: 21, postId: 31 }]],
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["INSERT INTO lms_forums (course_id, title, is_default", () => []],
  ["FROM lms_forums f WHERE f.course_id = @c", () => o.forums || [{ id: 1, title: "General discussion", description: null, staff_only: 0, locked: 0, is_default: 1, thread_count: 2 }, { id: 2, title: "Staff room", description: "x", staff_only: 1, locked: 0, is_default: 0, thread_count: 1 }]],
  ["FROM lms_forums WHERE id = @f AND course_id = @c", (i) => (o.forum === null ? [] : [o.forum || { id: i.f, title: "General discussion", description: null, staff_only: 0, locked: 0, is_default: i.f === 1 ? 1 : 0 }]) ],
  ["INSERT INTO lms_forums (course_id, title, description", () => (o.forumInsert === null ? [] : [{ id: 9 }])],
  ["UPDATE lms_forums SET deleted_at", () => [{ id: 2 }]], ["UPDATE lms_forums SET ", () => [{ id: 2 }]],
  ["SELECT COUNT(*) AS n FROM lms_threads t", () => [{ n: o.threadTotal ?? 3 }]],
  ["FROM lms_threads t LEFT JOIN Students st", () => o.threads || [
    { id: 11, title: "Welcome", pinned: 1, locked: 0, hidden_at: null, author_source: "Teachers", author_id: 7, author_name: "Mary Wanjiru", created_at: ago(500), reply_count: 2, last_post_at: ago(10) },
    { id: 12, title: "Question 3", pinned: 0, locked: 0, hidden_at: ago(5), author_source: "Students", author_id: 30, author_name: "Amina Kamau", created_at: ago(300), reply_count: 0, last_post_at: null }]],
  ["FROM lms_threads t JOIN lms_forums f", () => (o.thread === null ? [] : [o.thread || { id: 11, forum_id: 1, title: "Welcome", pinned: 0, locked: 0, hidden_at: null, hidden_reason: null, author_source: "Teachers", author_id: 7, author_name: "Mary Wanjiru", created_at: ago(500), forum_locked: 0, forum_title: "General discussion" }])],
  ["SELECT COUNT(*) AS n FROM lms_posts p", () => [{ n: o.postTotal ?? 3 }]],
  ["FROM lms_posts p LEFT JOIN Students st", () => o.posts || [
    { id: 1, body: "Hello class", is_opening: 1, author_source: "Teachers", author_id: 7, author_name: "Mary Wanjiru", hidden_at: null, hidden_reason: null, edited_at: null, created_at: ago(500) },
    { id: 2, body: "My answer", is_opening: 0, author_source: "Students", author_id: 30, author_name: "Amina Kamau", hidden_at: null, hidden_reason: null, edited_at: null, created_at: ago(5) },
    { id: 3, body: "Old one", is_opening: 0, author_source: "Students", author_id: 30, author_name: "Amina Kamau", hidden_at: null, hidden_reason: null, edited_at: null, created_at: ago(60) },
    { id: 4, body: "Removed text", is_opening: 0, author_source: "Students", author_id: 30, author_name: "Amina Kamau", hidden_at: ago(2), hidden_reason: "rude", edited_at: null, created_at: ago(3) }]],
  ["OUTPUT INSERTED.id SELECT th.id", () => (o.noInsert ? [] : [{ id: 32 }])],
  ["SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t", (i) => (o.mine === false ? [] : [{ id: i.p }])],
  ["UPDATE p SET body", () => (o.late ? [] : [{ id: 2 }])], ...extra]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const sqlOf = (m, needle) => (m.log.find((x) => x.sql.includes(needle)) || {}).sql || "";

test("cleanText / validateForum / validatePost (pure): plain text only, limits, unknown fields, edit needs a change", () => {
  assert.strictEqual(D.cleanText(" a<b>c\r\nd\u0007 \te "), "abc\nd \te"); assert.strictEqual(D.cleanText(5), null); assert.strictEqual(D.cleanText("   "), "");
  const f = (b, e) => D.validateForum(b, e); assert.deepStrictEqual(f({ title: " <i>Notes</i> ", description: "d", staffOnly: true, locked: false }).value, { title: "iNotes/i", description: "d", staffOnly: true, locked: false });
  for (const b of [{}, { title: "" }, { title: "x".repeat(101) }, { title: "A", description: "x".repeat(301) }, { title: "A", staffOnly: "yes" }, { title: "A", locked: 1 }, { title: "A", x: 1 }, null, [], "t"]) assert.strictEqual(f(b).ok, false, JSON.stringify(b));
  assert.strictEqual(f({}, true).ok, false); assert.strictEqual(f({ locked: true }, true).ok, true); assert.strictEqual(f({ title: "" }, true).ok, false); assert.strictEqual(f({ description: null }, true).value.description, null);
  const p = (b, t) => D.validatePost(b, t); assert.deepStrictEqual(p({ title: "Hi  there", body: "Body" }, true).value, { title: "Hi there", body: "Body" }); assert.deepStrictEqual(p({ body: "x".repeat(5000) }, false).value, { body: "x".repeat(5000) });
  for (const [b, t] of [[{ body: "x".repeat(5001) }, false], [{ body: "" }, false], [{ body: "<>" }, false], [{ title: "T" }, true], [{ body: "b" }, true], [{ title: "x".repeat(201), body: "b" }, true], [{ title: "T", body: "b" }, false], [{ body: "b", extra: 1 }, false], [null, false]]) assert.strictEqual(p(b, t).ok, false, JSON.stringify(b));
});

test("viewerOf (pure): the ROUTE decides; a learner route needs a Students learner, a staff route refuses students", () => {
  assert.strictEqual(D.viewerOf(student, false).staff, false); assert.strictEqual(D.viewerOf(teacher, true).staff, true); assert.strictEqual(D.viewerOf(admin, true).source, "Users");
  assert.strictEqual(D.viewerOf(teacher, false), null); assert.strictEqual(D.viewerOf(student, true), null); assert.strictEqual(D.viewerOf(null, true), null); assert.strictEqual(D.viewerOf({ id: 30, role: "teacher", source: "Students" }, false), null);
});

test("listForums: default forum ensured idempotently; learners never get staff-only forums or the flag; staff see all; threads counted with the visibility rule; draft course hidden from learners", async () => {
  const m = world(); const r = await D.listForums(m.pool, student, 5, false); assert.ok(r.ok);
  const ens = m.log.find((x) => /INSERT INTO lms_forums \(course_id, title, is_default/.test(x.sql)); assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_forums WITH \(UPDLOCK, HOLDLOCK\) WHERE course_id = @c AND is_default = 1 AND deleted_at IS NULL\)/.test(ens.sql) && ens.inputs.t === "General discussion");
  const sel = sqlOf(m, "FROM lms_forums f WHERE"); assert.ok(/f\.staff_only = 0/.test(sel) && /t\.hidden_at IS NULL OR \(t\.author_source = N'Students' AND t\.author_id = @vid\)/.test(sel) && m.log.find((x) => x.sql === sel).inputs.vid === 30);
  assert.ok(r.items.every((f) => !("staffOnly" in f)) && r.items[0].isDefault === true && r.items[0].threadCount === 2);
  const s = world(); const sr = await D.listForums(s.pool, teacher, 5, true); assert.ok(!/f\.staff_only = 0/.test(sqlOf(s, "FROM lms_forums f WHERE")) && /t\.deleted_at IS NULL"?/.test(sqlOf(s, "FROM lms_forums f WHERE")) && !/t\.hidden_at IS NULL/.test(sqlOf(s, "FROM lms_forums f WHERE")) && sr.items.every((f) => "staffOnly" in f));
  assert.strictEqual((await D.listForums(world({ status: "draft" }).pool, student, 5, false)).notFound, true); assert.ok((await D.listForums(world({ status: "draft" }).pool, teacher, 5, true)).ok); assert.ok((await D.listForums(world({ status: "archived" }).pool, student, 5, false)).ok);
  for (const [u, st, id] of [[teacher, false, 5], [student, true, 5], [null, true, 5], [student, false, 6], [student, false, "x"]]) { const z = world(); assert.strictEqual((await D.listForums(z.pool, u, id, st)).notFound, true); assert.ok(!z.log.some((x) => /INSERT INTO lms_forums/.test(x.sql))); }
});

test("forum management: create (cap in the INSERT, audited), edit/remove, the default forum is protected, archived course read only, learners refused, bad bodies cost no query", async () => {
  const m = world(); const r = await D.createForum(m.pool, teacher, 5, { title: "Projects", staffOnly: true }); assert.deepStrictEqual([r.ok, r.forum.id, r.forum.staffOnly], [true, 9, true]);
  const w = m.log.find((x) => /INSERT INTO lms_forums \(course_id, title, description/.test(x.sql)); assert.ok(/COUNT\(\*\) FROM lms_forums WHERE course_id = @c AND deleted_at IS NULL\) < @max$/.test(w.sql) && w.inputs.max === 20 && w.inputs.src === "Teachers" && w.inputs.so === 1); assert.ok(/forum\.created/.test(JSON.stringify(audits(m)[0].inputs)));
  assert.strictEqual((await D.createForum(world({ forumInsert: null }).pool, teacher, 5, { title: "X" })).code, "FORUM_LIMIT");
  assert.strictEqual((await D.createForum(world({ status: "archived" }).pool, teacher, 5, { title: "X" })).code, "COURSE_READ_ONLY"); assert.ok((await D.createForum(world({ status: "draft" }).pool, teacher, 5, { title: "X" })).ok);
  const u = world({ forum: { id: 1, title: "General", staff_only: 0, locked: 0, is_default: 1 } }); assert.strictEqual((await D.updateForum(u.pool, teacher, 5, 1, { staffOnly: true })).code, "DEFAULT_FORUM"); assert.ok(!u.log.some((x) => /UPDATE lms_forums/.test(x.sql)));
  assert.ok((await D.updateForum(u.pool, teacher, 5, 1, { locked: true, title: "T" })).ok); const up = u.log.find((x) => /UPDATE lms_forums SET title/.test(x.sql)); assert.ok(/course_id = @c AND deleted_at IS NULL/.test(up.sql) && up.inputs.lk === 1 && up.inputs.t === "T");
  const rm = world({ forum: { id: 1, title: "G", staff_only: 0, locked: 0, is_default: 1 } }); assert.strictEqual((await D.removeForum(rm.pool, teacher, 5, 1)).code, "DEFAULT_FORUM"); assert.ok(!rm.log.some((x) => /deleted_at = SYSUTCDATETIME/.test(x.sql)));
  const rm2 = world({ forum: { id: 2, title: "S", staff_only: 1, locked: 0, is_default: 0 } }); assert.deepStrictEqual([(await D.removeForum(rm2.pool, teacher, 5, 2)).removed, /is_default = 0/.test(sqlOf(rm2, "deleted_at = SYSUTCDATETIME")), !/DELETE FROM/.test(JSON.stringify(rm2.log.map((x) => x.sql)))], [true, true, true]);
  assert.strictEqual((await D.updateForum(world({ forum: null }).pool, teacher, 5, 7, { locked: true })).notFound, true);
  for (const fn of [(p, uu) => D.createForum(p, uu, 5, { title: "x" }), (p, uu) => D.updateForum(p, uu, 5, 2, { locked: true }), (p, uu) => D.removeForum(p, uu, 5, 2)]) { const z = world(); assert.strictEqual((await fn(z.pool, student)).notFound, true); assert.strictEqual(z.log.length, 0); }
  const bad = world(); for (const b of [{}, { title: "" }, { title: "A", staffOnly: "y" }, null]) assert.strictEqual((await D.createForum(bad.pool, teacher, 5, b)).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("listThreads: hidden threads filtered in SQL for learners (rows + count + last activity + replies), staff see all; names as First L. for learners and full for staff; pageSize capped; staff-only forum = 404 for learners", async () => {
  const m = world(); const r = await D.listThreads(m.pool, student, 5, 1, { page: "2", pageSize: "500" }, false); assert.ok(r.ok);
  const list = sqlOf(m, "FROM lms_threads t LEFT JOIN Students st"), cnt = sqlOf(m, "SELECT COUNT(*) AS n FROM lms_threads t"); const vis = /t\.hidden_at IS NULL OR \(t\.author_source = N'Students' AND t\.author_id = @vid\)/;
  assert.ok(vis.test(list) && vis.test(cnt) && (list.match(/p\.hidden_at IS NULL OR \(p\.author_source = N'Students' AND p\.author_id = @vid\)/g) || []).length === 2, "rows, count, replies and last activity all hide other people's hidden items");
  assert.ok(/ORDER BY t\.pinned DESC, last_post_at DESC, t\.id DESC OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY/.test(list) && /course_id = @c/.test(list) && m.log.find((x) => x.sql === list).inputs.ps === 50 && m.log.find((x) => x.sql === list).inputs.off === 50);
  assert.ok(/staff_only = 0/.test(sqlOf(m, "FROM lms_forums WHERE id = @f")));
  assert.deepStrictEqual([r.items[0].author, r.items[1].author, r.items[0].pinned, r.items[0].replyCount, r.items[1].hidden, r.items[0].hidden], [{ name: "Mary Wanjiru", isStaff: true }, { name: "Amina K.", isStaff: false }, true, 2, true, undefined]);
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.hasMore], [3, 2, 50, false]); assert.ok(!/author_id|authorId|admission/i.test(JSON.stringify(r)));
  const s = world(); await D.listThreads(s.pool, teacher, 5, 1, {}, true); assert.ok(!/t\.hidden_at IS NULL/.test(sqlOf(s, "FROM lms_threads t LEFT JOIN Students st")) && !/staff_only = 0/.test(sqlOf(s, "FROM lms_forums WHERE id = @f")));
  const none = world({ forum: null }); assert.strictEqual((await D.listThreads(none.pool, student, 5, 2, {}, false)).notFound, true); assert.ok(!none.log.some((x) => /FROM lms_threads/.test(x.sql)));
  assert.strictEqual((await D.listThreads(world({ status: "draft" }).pool, student, 5, 1, {}, false)).notFound, true);
});

test("getThread: learner sees own hidden post flagged (no reason), never someone else's (SQL), staff see the reason; canEdit only for own, young, visible, unlocked; canReply follows locks and course state", async () => {
  const m = world(); const r = await D.getThread(m.pool, student, 5, 11, {}, false); assert.ok(r.ok);
  assert.ok(/p\.hidden_at IS NULL OR \(p\.author_source = N'Students' AND p\.author_id = @vid\)/.test(sqlOf(m, "SELECT COUNT(*) AS n FROM lms_posts p")) && /p\.hidden_at IS NULL OR/.test(sqlOf(m, "FROM lms_posts p LEFT JOIN Students st")) && /f\.staff_only = 0/.test(sqlOf(m, "FROM lms_threads t JOIN lms_forums f")) && /f\.deleted_at IS NULL/.test(sqlOf(m, "FROM lms_threads t JOIN lms_forums f")));
  const byId = Object.fromEntries(r.posts.map((p) => [p.id, p]));
  assert.deepStrictEqual([byId[1].canEdit, byId[1].mine, byId[2].canEdit, byId[2].mine, byId[3].canEdit, byId[4].hidden, byId[4].canEdit, "hiddenReason" in byId[4], byId[1].isOpening], [false, false, true, true, false, true, false, false, true]);
  assert.deepStrictEqual([byId[2].author.name, byId[1].author.name, r.canReply, r.thread.title], ["Amina K.", "Mary Wanjiru", true, "Welcome"]);
  const st = await D.getThread(world().pool, teacher, 5, 11, {}, true); assert.strictEqual(st.posts.find((p) => p.id === 4).hiddenReason, "rude"); assert.strictEqual(st.posts.find((p) => p.id === 2).canEdit, false, "staff never edit a learner's post");
  const lock = await D.getThread(world({ thread: { id: 11, forum_id: 1, title: "W", locked: 1, hidden_at: null, author_source: "Teachers", author_id: 7, author_name: "M W", created_at: ago(5), forum_locked: 0, forum_title: "G" } }).pool, student, 5, 11, {}, false);
  assert.deepStrictEqual([lock.canReply, lock.posts.find((p) => p.id === 2).canEdit, lock.thread.locked], [false, false, true]);
  const lockStaff = await D.getThread(world({ thread: { id: 11, forum_id: 1, title: "W", locked: 1, hidden_at: null, author_source: "Teachers", author_id: 7, author_name: "M W", created_at: ago(5), forum_locked: 0, forum_title: "G" } }).pool, teacher, 5, 11, {}, true); assert.strictEqual(lockStaff.canReply, true);
  assert.strictEqual((await D.getThread(world({ status: "archived" }).pool, student, 5, 11, {}, false)).canReply, false);
  assert.strictEqual((await D.getThread(world({ thread: null }).pool, student, 5, 99, {}, false)).notFound, true);
  const hid = await D.getThread(world({ thread: { id: 12, forum_id: 1, title: "Q", locked: 0, hidden_at: ago(1), hidden_reason: "why", author_source: "Students", author_id: 30, author_name: "Amina Kamau", created_at: ago(9), forum_locked: 0, forum_title: "G" } }).pool, student, 5, 12, {}, false); assert.deepStrictEqual([hid.thread.hidden, "hiddenReason" in hid.thread], [true, false]);
  const big = await D.getThread(m.pool, student, 5, 11, { pageSize: "999" }, false); assert.strictEqual(big.pageSize, 50);
});

test("createThread: ONE atomic batch (thread + opening post), rate guard + forum guard inside the INSERT, learner id from the token, event with ids only; staff are not rate limited and may use staff-only/locked forums", async () => {
  const got = []; const off = events.on("lms.discussion.posted", (p) => got.push(p)); const m = world(); const r = await D.createThread(m.pool, student, 5, 1, { title: " Help <b> ", body: "Why?" }, false, { tenant: "tDisc" }); await tick();
  assert.deepStrictEqual([r.ok, r.threadId, r.postId], [true, 21, 31]); const w = m.log.find((x) => /INSERT INTO lms_threads/.test(x.sql));
  assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && /INSERT INTO lms_posts \(thread_id, forum_id, course_id, body, is_opening, author_source, author_id\) VALUES \(@tid, @f, @c, @b, 1, @src, @vid\)/.test(w.sql) && /DATEADD\(HOUR, -1, SYSUTCDATETIME\(\)\)\) < @lim/.test(w.sql) && /staff_only = 0 AND locked = 0/.test(w.sql) && /IF @n = 0 BEGIN ROLLBACK/.test(w.sql) && /COMMIT/.test(w.sql));
  assert.deepStrictEqual([w.inputs.vid, w.inputs.src, w.inputs.lim, w.inputs.t, w.inputs.b, w.inputs.c, w.inputs.f], [30, "Students", 30, "Help b", "Why?", 5, 1]);
  const mine = got.filter((p) => p.tenant === "tDisc"); assert.deepStrictEqual([mine.length, mine[0].courseId, mine[0].threadId, mine[0].postId], [1, 5, 21, 31]); assert.ok(!/title|body|name/i.test(Object.keys(mine[0]).join(","))); off();
  const s = world(); await D.createThread(s.pool, teacher, 5, 2, { title: "T", body: "B" }, true); const sw = s.log.find((x) => /INSERT INTO lms_threads/.test(x.sql)); assert.ok(sw.inputs.lim >= 100000 && !/staff_only = 0 AND locked = 0/.test(sw.sql) && sw.inputs.src === "Teachers");
  assert.ok((await D.createThread(world({ forum: { id: 1, title: "G", staff_only: 0, locked: 1, is_default: 1 } }).pool, teacher, 5, 1, { title: "T", body: "B" }, true)).ok, "staff may post in a locked forum");
});

test("createThread refusals: locked forum, staff-only forum, draft/archived course, rate limit, word filter, bad body, wrong viewer; nothing written", async () => {
  const w = (m) => m.log.some((x) => /INSERT INTO lms_threads/.test(x.sql)); const body = { title: "T", body: "B" };
  const lk = world({ forum: { id: 1, title: "G", staff_only: 0, locked: 1, is_default: 1 } }); assert.strictEqual((await D.createThread(lk.pool, student, 5, 1, body, false)).code, "FORUM_LOCKED"); assert.ok(!w(lk));
  const so = world({ forum: null }); assert.strictEqual((await D.createThread(so.pool, student, 5, 2, body, false)).notFound, true); assert.ok(!w(so));
  const dr = world({ status: "draft" }); assert.strictEqual((await D.createThread(dr.pool, teacher, 5, 1, body, true)).code, "COURSE_NOT_PUBLISHED"); const ar = world({ status: "archived" }); assert.strictEqual((await D.createThread(ar.pool, student, 5, 1, body, false)).code, "COURSE_READ_ONLY"); assert.ok(!w(dr) && !w(ar));
  assert.strictEqual((await D.createThread(world({ status: "draft" }).pool, student, 5, 1, body, false)).notFound, true, "a learner cannot even tell a draft course exists");
  const rl = world({ noInsert: true }); assert.strictEqual((await D.createThread(rl.pool, student, 5, 1, body, false)).code, "POST_RATE_LIMIT");
  W.setFilter((t) => !/badword/.test(t)); try { const f = world(); const r = await D.createThread(f.pool, student, 5, 1, { title: "T", body: "a badword here" }, false); assert.deepStrictEqual([r.code, r.ok], ["CONTENT_REJECTED", false]); assert.ok(!w(f));
    const ok = world(); assert.ok((await D.createThread(ok.pool, teacher, 5, 1, { title: "T", body: "badword" }, true)).ok, "the filter is for learners only"); } finally { W.setFilter(null); }
  for (const b of [{}, { title: "T" }, { body: "B" }, null, { title: "T", body: "B", x: 1 }]) { const z = world(); assert.strictEqual((await D.createThread(z.pool, student, 5, 1, b, false)).ok, false); assert.strictEqual(z.log.length, 0); }
  for (const [u, st] of [[teacher, false], [student, true], [null, false]]) { const z = world(); assert.strictEqual((await D.createThread(z.pool, u, 5, 1, body, st)).notFound, true); assert.strictEqual(z.log.length, 0); }
});

test("createPost: guards inside the INSERT (thread live, not locked/hidden for learners, rate limit), staff may reply in a locked thread, hidden thread = 404 for other learners, reply event", async () => {
  const got = []; const off = events.on("lms.discussion.posted", (p) => got.push(p)); const m = world(); const r = await D.createPost(m.pool, student, 5, 11, { body: "Me too" }, false, { tenant: "tDisc2" }); await tick(); assert.deepStrictEqual([r.ok, r.postId], [true, 32]);
  const w = m.log.find((x) => /OUTPUT INSERTED\.id SELECT th\.id/.test(x.sql)); assert.ok(/th\.locked = 0 AND th\.hidden_at IS NULL/.test(w.sql) && /th\.course_id = @c AND th\.deleted_at IS NULL/.test(w.sql) && /< @lim/.test(w.sql) && w.inputs.lim === 30 && w.inputs.vid === 30 && w.inputs.src === "Students");
  const mine = got.filter((p) => p.tenant === "tDisc2"); assert.deepStrictEqual([mine.length, mine[0].threadId, mine[0].postId], [1, 11, 32]); off();
  const lockedT = { id: 11, forum_id: 1, title: "W", locked: 1, hidden_at: null, author_source: "Teachers", author_id: 7, author_name: "M", created_at: ago(5), forum_locked: 0, forum_title: "G" };
  const lk = world({ thread: lockedT }); assert.strictEqual((await D.createPost(lk.pool, student, 5, 11, { body: "x" }, false)).code, "THREAD_LOCKED"); assert.ok(!lk.log.some((x) => /INSERT INTO lms_posts/.test(x.sql)));
  const st = world({ thread: lockedT }); assert.ok((await D.createPost(st.pool, teacher, 5, 11, { body: "Note" }, true)).ok); assert.ok(!/th\.locked = 0/.test(st.log.find((x) => /OUTPUT INSERTED\.id SELECT th\.id/.test(x.sql)).sql));
  const flk = world({ thread: { ...lockedT, locked: 0, forum_locked: 1 } }); assert.strictEqual((await D.createPost(flk.pool, student, 5, 11, { body: "x" }, false)).code, "THREAD_LOCKED");
  assert.strictEqual((await D.createPost(world({ thread: null }).pool, student, 5, 12, { body: "x" }, false)).notFound, true);
  assert.strictEqual((await D.createPost(world({ noInsert: true }).pool, student, 5, 11, { body: "x" }, false)).code, "POST_RATE_LIMIT");
  assert.strictEqual((await D.createPost(world({ status: "archived" }).pool, student, 5, 11, { body: "x" }, false)).code, "COURSE_READ_ONLY");
  for (const b of [{}, { body: "" }, { body: "x", title: "t" }, null]) { const z = world(); assert.strictEqual((await D.createPost(z.pool, student, 5, 11, b, false)).ok, false); assert.strictEqual(z.log.length, 0); }
});

test("editPost: own visible post only, 15 minute window and locks enforced in the UPDATE, learner-only lock rule, word filter, nobody edits another person's post", async () => {
  const m = world(); const r = await D.editPost(m.pool, student, 5, 2, { body: "Fixed" }, false); assert.deepStrictEqual([r.ok, r.edited], [true, true]);
  const own = sqlOf(m, "SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t"); assert.ok(/p\.author_source = @src AND p\.author_id = @vid/.test(own) && /p\.hidden_at IS NULL OR/.test(own) && /f\.staff_only = 0/.test(own));
  const up = m.log.find((x) => /UPDATE p SET body/.test(x.sql)); assert.ok(/p\.author_source = @src AND p\.author_id = @vid/.test(up.sql) && /p\.hidden_at IS NULL/.test(up.sql) && /DATEADD\(MINUTE, -@mins, SYSUTCDATETIME\(\)\)/.test(up.sql) && /t\.locked = 0 AND f\.locked = 0/.test(up.sql) && up.inputs.mins === 15 && up.inputs.vid === 30 && up.inputs.b === "Fixed");
  const s = world(); await D.editPost(s.pool, teacher, 5, 2, { body: "Mine" }, true); assert.ok(!/t\.locked = 0/.test(s.log.find((x) => /UPDATE p SET body/.test(x.sql)).sql));
  assert.strictEqual((await D.editPost(world({ mine: false }).pool, student, 5, 3, { body: "x" }, false)).notFound, true); const nm = world({ mine: false }); await D.editPost(nm.pool, student, 5, 3, { body: "x" }, false); assert.ok(!nm.log.some((x) => /UPDATE p SET/.test(x.sql)));
  assert.strictEqual((await D.editPost(world({ late: true }).pool, student, 5, 3, { body: "x" }, false)).code, "EDIT_WINDOW_CLOSED");
  assert.strictEqual((await D.editPost(world({ status: "archived" }).pool, student, 5, 2, { body: "x" }, false)).code, "COURSE_READ_ONLY");
  W.setFilter(() => false); try { const f = world(); assert.strictEqual((await D.editPost(f.pool, student, 5, 2, { body: "x" }, false)).code, "CONTENT_REJECTED"); assert.ok(!f.log.some((x) => /UPDATE p SET/.test(x.sql))); } finally { W.setFilter(null); }
  for (const b of [{}, { body: "" }, { title: "T", body: "B" }]) { const z = world(); assert.strictEqual((await D.editPost(z.pool, student, 5, 2, b, false)).ok, false); assert.strictEqual(z.log.length, 0); }
});

test("word-filter hook: nothing by default, true/false/object results, a throwing or odd filter FAILS OPEN, message capped, only functions or null accepted", () => {
  assert.deepStrictEqual(W.check("anything"), { ok: true });
  try { W.setFilter(() => false); assert.strictEqual(W.check("x").ok, false); assert.ok(W.check("x").message.length > 0);
    W.setFilter(() => ({ ok: false, message: "m".repeat(500) })); assert.strictEqual(W.check("x").message.length, 200);
    W.setFilter(() => true); assert.strictEqual(W.check("x").ok, true); W.setFilter(() => ({ ok: true })); assert.strictEqual(W.check("x").ok, true);
    W.setFilter((t, c) => ({ ok: !(c.courseId === 9 && t === "no") })); assert.deepStrictEqual([W.check("no", { courseId: 9 }).ok, W.check("no", { courseId: 8 }).ok], [false, true]);
    const log = console.error; console.error = () => {}; try { W.setFilter(() => { throw new Error("boom"); }); assert.strictEqual(W.check("x").ok, true); W.setFilter(() => 42); assert.strictEqual(W.check("x").ok, true); } finally { console.error = log; }
  } finally { W.setFilter(null); }
  assert.throws(() => W.setFilter("nope")); assert.strictEqual(W.check("x").ok, true);
});

test("schema step 034: additive, four tables, one default forum per course, one report per reporter, indexes; blocked from the record editor; event registered; 034 is last after 033", () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("034_lms_discussions");
  assert.ok(i === ids.length - 12 && ids[i - 1] === "033_lms_badges" && ids[i + 1] === "035_lms_groups" && ids[i + 3] === "037_lms_peer_review");
  const t = schema.STEPS[i].sql.join("\n"); for (const n of ["lms_forums", "lms_threads", "lms_posts", "lms_post_reports"]) assert.ok(new RegExp(`name='${n}'`).test(t), n);
  assert.ok(!/DROP |DELETE |ALTER TABLE [a-z_]+ DROP/i.test(t) && /UX_lms_forums_default ON lms_forums \(course_id\) WHERE is_default = 1 AND deleted_at IS NULL/.test(t) && /UX_lms_post_reports_one ON lms_post_reports \(post_id, reporter_source, reporter_id\)/.test(t) && /IX_lms_posts_thread ON lms_posts \(thread_id, created_at\)/.test(t) && /IX_lms_posts_author ON lms_posts \(author_source, author_id, created_at\)/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_forums", "lms_threads", "lms_posts", "lms_post_reports"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
  assert.ok(events.on("lms.discussion.posted", () => {}) instanceof Function);
});

test("routes: every route is behind the lms_discussions flag, staff routes use staffAccess (forum management also course.manage), learner routes studentOnly + studentAccess; shapes and status codes", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), DS = "/courses/:courseId/discussions", DL = "/courses/:courseId/learn/discussions";
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const common = [["get", "/forums"], ["get", "/forums/:forumId/threads"], ["post", "/forums/:forumId/threads"], ["get", "/threads/:threadId"], ["post", "/threads/:threadId/posts"], ["patch", "/posts/:postId"]];
  for (const [base, len] of [[DS, 3], [DL, 4]]) for (const [m, p] of common) { const r = find(m, base + p); assert.ok(r, `${m} ${base + p}`); assert.strictEqual(r.route.stack.length, len, `${m} ${base + p}`); }
  const mg = [["post", `${DS}/forums`], ["patch", `${DS}/forums/:forumId`], ["delete", `${DS}/forums/:forumId`]].map(([m, p]) => find(m, p)); assert.ok(mg.every((r) => r && r.route.stack.length === 4));
  assert.ok((src.match(/\/forums`, dGate, gbManage, staffAccess/g) || []).length === 1 && /forums\/:forumId`, dGate, gbManage, staffAccess/.test(src) && /const dGate = requireModule\("lms", "lms_discussions"\)/.test(src) && /\[DS, true, \[staffAccess\]\], \[DL, false, \[studentOnly, studentAccess\]\]/.test(src));
  assert.ok(!find("delete", `${DL}/forums/:forumId`) && !find("post", `${DL}/forums`) && !find("patch", `${DL}/forums/:forumId`), "learners cannot manage forums");
  const post = (base) => find("post", `${base}/forums/:forumId/threads`).route.stack.slice(-1)[0].handle;
  const res = makeRes(); await post(DL)({ pool: world().pool, user: student, params: { courseId: "5", forumId: "1" }, body: { title: "T", body: "B" }, tenant: "t" }, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.threadId, "ok" in res.body], [201, true, 21, false]);
  const r2 = makeRes(); await post(DL)({ pool: world().pool, user: student, params: { courseId: "5", forumId: "1" }, body: { title: "T" }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 400);
  const r3 = makeRes(); await post(DL)({ pool: world({ forum: null }).pool, user: student, params: { courseId: "5", forumId: "abc" }, body: { title: "T", body: "B" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); await post(DL)({ pool: world({ forum: { id: 1, title: "G", staff_only: 0, locked: 1, is_default: 1 } }).pool, user: student, params: { courseId: "5", forumId: "1" }, body: { title: "T", body: "B" }, tenant: "t" }, r4); assert.deepStrictEqual([r4.statusCode, r4.body.code], [409, "FORUM_LOCKED"]);
  const r5 = makeRes(); await post(DS)({ pool: world().pool, user: student, params: { courseId: "5", forumId: "1" }, body: { title: "T", body: "B" }, tenant: "t" }, r5); assert.strictEqual(r5.statusCode, 404, "a learner token on a staff handler is refused even if the guards were bypassed");
  const list = find("get", `${DL}/forums`).route.stack.slice(-1)[0].handle; const r6 = makeRes(); await list({ pool: world().pool, user: student, params: { courseId: "5" }, query: {}, tenant: "t" }, r6); assert.deepStrictEqual([r6.statusCode, r6.body.items.length], [200, 2]);
});

test("tenant isolation + ID guessing: another school's pool sees no course so nothing is read or written; another course's ids are always scoped by course_id in SQL", async () => {
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] });
  assert.strictEqual((await D.listForums(T.A.pool, student, 5, false)).notFound, true); assert.strictEqual((await D.createThread(T.A.pool, student, 5, 1, { title: "T", body: "B" }, false)).notFound, true); assert.strictEqual((await D.getThread(T.A.pool, teacher, 5, 11, {}, true)).notFound, true); T.assertUntouched("B");
  const m = world(); await D.getThread(m.pool, student, 5, 11, {}, false); await D.listThreads(m.pool, student, 5, 1, {}, false); await D.editPost(m.pool, student, 5, 2, { body: "x" }, false); await D.createPost(m.pool, student, 5, 11, { body: "x" }, false);
  for (const x of m.log.filter((y) => /lms_(threads|posts|forums)/.test(y.sql) && !/lms_courses/.test(y.sql))) assert.ok(/(t|p|th)?\.?course_id = @c|WHERE course_id = @c|course_id = @c/.test(x.sql), `unscoped SQL: ${x.sql.slice(0, 90)}`);
});
