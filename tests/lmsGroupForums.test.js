/* L8.2b - group forums (D-099): a forum may belong to ONE live group of the course; a learner reaches it only as a live member of that group, in EVERY read/write path;
   staff see everything; removing a member or deleting the group hides it at once; no schema surprises (step 036). Mocked pool only: the membership SQL (EXISTS over
   lms_group_members + lms_groups) is NOT verified on a real SQL Server; the tests pin the clause in every query TEXT and that the learner id is passed as @vid. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const { tick } = require("./helpers/tick");
suite("lmsGroupForums.test.js");
const D = require("../utils/lmsDiscussions"), M = require("../utils/lmsDiscussionMod"), N = require("../utils/lmsNotifications");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, member = { id: 30, role: "student", source: "Students" }, outsider = { id: 31, role: "student", source: "Students" };
const GROUP_ID = 4, GF = 3; // forum 3 belongs to group 4; forum 1 is the default (no group)
const MEMBERS = new Set([30]);
const CLAUSE = /AND \((\w+)\.group_id IS NULL OR EXISTS \(SELECT 1 FROM lms_group_members gm JOIN lms_groups gg ON gg\.id = gm\.group_id AND gg\.course_id = gm\.course_id AND gg\.deleted_at IS NULL WHERE gm\.group_id = \1\.group_id AND gm\.course_id = \1\.course_id AND gm\.student_id = @vid AND gm\.removed_at IS NULL\)\)/;
// The mock emulates the membership filter the SQL performs, using the @vid the code passes: a learner who is not in the group gets no row.
const world = (o = {}) => makeMockPool([
  ["INSERT INTO lms_threads", () => [{ threadId: 21, postId: 31 }]],
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 ? [{ status: o.status || "published" }] : [])],
  ["INSERT INTO lms_forums (course_id, title, is_default", () => []],
  ["SELECT TOP 1 id FROM lms_groups WHERE id = @g", (i) => (i.c === 5 && i.g === GROUP_ID && !o.groupGone ? [{ id: GROUP_ID }] : [])],
  ["INSERT INTO lms_forums (course_id, title, description", () => [{ id: 9 }]],
  ["UPDATE lms_forums SET ", () => [{ id: GF }]],
  ["FROM lms_forums f WHERE f.course_id = @c", (i) => [{ id: 1, title: "General discussion", description: null, staff_only: 0, locked: 0, is_default: 1, group_id: null, thread_count: 2 }, { id: GF, title: "Team A", description: null, staff_only: 0, locked: 0, is_default: 0, group_id: GROUP_ID, thread_count: 1 }]
    .filter((f) => f.group_id === null || o.staffView || MEMBERS.has(i.vid))],
  ["FROM lms_forums WHERE id = @f AND course_id = @c", (i) => { const f = { id: i.f, title: "Team A", description: null, staff_only: 0, locked: 0, is_default: i.f === 1 ? 1 : 0, group_id: i.f === GF ? GROUP_ID : null }; return f.group_id && !o.staffView && !MEMBERS.has(i.vid) ? [] : [f]; }],
  ["SELECT COUNT(*) AS n FROM lms_threads t", () => [{ n: 1 }]],
  ["FROM lms_threads t LEFT JOIN Students st", () => [{ id: 11, title: "Plan", pinned: 0, locked: 0, hidden_at: null, author_source: "Students", author_id: 30, author_name: "Amina Kamau", created_at: new Date().toISOString(), reply_count: 0, last_post_at: null }]],
  ["FROM lms_threads t JOIN lms_forums f", (i) => (o.staffView || MEMBERS.has(i.vid) ? [{ id: 11, forum_id: GF, title: "Plan", pinned: 0, locked: 0, hidden_at: null, hidden_reason: null, author_source: "Students", author_id: 30, author_name: "Amina Kamau", created_at: new Date().toISOString(), forum_locked: 0, forum_title: "Team A" }] : [])],
  ["OUTPUT INSERTED.id SELECT th.id", () => [{ id: 32 }]],
  ["SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t", (i) => (o.staffView || MEMBERS.has(i.vid) ? [{ id: i.p }] : [])],
  ["UPDATE p SET body", () => [{ id: 2 }]],
  ["SELECT TOP 1 p.id, p.author_source, p.author_id FROM lms_posts p", (i) => (MEMBERS.has(i.vid) ? [{ id: i.p, author_source: "Students", author_id: 99 }] : [])],
]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const sqlOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).sql || "", inOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).inputs || {};

test("groupVis (pure): the clause is for a learner id @vid, a LIVE group (not deleted), a LIVE membership (not removed), this course; a normal forum (no group) always passes", () => {
  const c = D.groupVis("f").replace(/\s+/g, " "); assert.ok(CLAUSE.test(c), c); assert.ok(/f\.group_id IS NULL OR EXISTS/.test(c));
  assert.ok(CLAUSE.test(D.groupVis("lms_forums").replace(/\s+/g, " ")) && /lms_forums\.group_id/.test(D.groupVis("lms_forums")), "also works with the bare table name");
});

test("validateForum (pure): groupId is a whole number >= 1 or null, only on create, never with staffOnly: true", () => {
  const f = (b, e) => D.validateForum(b, e);
  assert.deepStrictEqual(f({ title: "Team A", groupId: 4 }).value, { title: "Team A", groupId: 4 }); assert.deepStrictEqual(f({ title: "x", groupId: null }).value, { title: "x" }, "null = a normal forum");
  assert.deepStrictEqual(f({ title: "x", groupId: 4, staffOnly: false }).value, { title: "x", staffOnly: false, groupId: 4 });
  for (const g of [0, -1, 1.5, "4", true, [], {}, 2147483648]) assert.strictEqual(f({ title: "x", groupId: g }).ok, false, JSON.stringify(g));
  const both = f({ title: "x", groupId: 4, staffOnly: true }); assert.ok(!both.ok && /cannot also be staff only/.test(both.errors[0]));
  for (const b of [{ groupId: 4 }, { groupId: null }, { title: "x", groupId: 5 }]) { const e = f(b, true); assert.ok(!e.ok && /cannot be changed/.test(e.errors[0]), JSON.stringify(b)); }
  assert.strictEqual(f({ title: "x" }, true).ok, true);
});

test("createForum with a group: the group must be a live group of THIS course (else 404, nothing inserted), group_id is stored, audit shows the id, the answer carries groupId; without a group nothing extra runs", async () => {
  const m = world(); const r = await D.createForum(m.pool, teacher, 5, { title: "Team A", groupId: GROUP_ID }); assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.forum.groupId, GROUP_ID);
  const g = sqlOf(m, "FROM lms_groups WHERE id = @g"); assert.ok(/id = @g AND course_id = @c AND deleted_at IS NULL/.test(g) && inOf(m, "FROM lms_groups WHERE id = @g").c === 5, "live group of this course");
  const ins = m.log.find((x) => /INSERT INTO lms_forums \(course_id, title, description/.test(x.sql)); assert.ok(/group_id, created_by_source, created_by\)/.test(ins.sql) && /@so, @lk, @gid, @src, @uid/.test(ins.sql) && ins.inputs.gid === GROUP_ID);
  assert.deepStrictEqual(JSON.parse(audits(m)[0].inputs.d), { courseId: 5, staffOnly: false, groupId: GROUP_ID }, "audit has the group id and ids only");
  for (const o of [{ groupGone: true }]) { const n = world(o); const x = await D.createForum(n.pool, teacher, 5, { title: "T", groupId: GROUP_ID }); assert.strictEqual(x.notFound, true); assert.ok(!n.log.some((l) => /INSERT INTO lms_forums \(course_id, title, description/.test(l.sql)), "no forum for a missing/deleted group"); }
  const other = world(); assert.strictEqual((await D.createForum(other.pool, teacher, 5, { title: "T", groupId: 99 })).notFound, true, "a group of another course/unknown id");
  const plain = world(); const p = await D.createForum(plain.pool, teacher, 5, { title: "Plain" }); assert.ok(p.ok); assert.strictEqual(p.forum.groupId, null); assert.ok(!plain.log.some((l) => /FROM lms_groups/.test(l.sql)), "no group lookup"); assert.strictEqual(inOf(plain, "INSERT INTO lms_forums (course_id, title, description").gid, null);
  const bad = world(); assert.strictEqual((await D.createForum(bad.pool, teacher, 5, { title: "T", groupId: GROUP_ID, staffOnly: true })).ok, false); assert.strictEqual(bad.log.length, 0, "validation first");
});

test("updateForum: a group forum cannot become staff only (409 GROUP_FORUM), its group cannot be changed (400, nothing queried); other edits still work", async () => {
  const a = world({ staffView: true }); const r = await D.updateForum(a.pool, teacher, 5, GF, { staffOnly: true }); assert.deepStrictEqual([r.ok, r.code], [false, "GROUP_FORUM"]); assert.ok(!a.log.some((x) => /UPDATE lms_forums SET/.test(x.sql)));
  const b = world(); const e = await D.updateForum(b.pool, teacher, 5, GF, { groupId: 1 }); assert.strictEqual(e.ok, false); assert.strictEqual(b.log.length, 0);
  assert.ok((await D.updateForum(world({ staffView: true }).pool, teacher, 5, GF, { locked: true })).ok, "locking a group forum is fine");
  assert.ok((await D.updateForum(world({ staffView: true }).pool, teacher, 5, 1, { staffOnly: true })).code === "DEFAULT_FORUM");
});

test("listForums: a member sees the group forum, an outsider does not; staff see both with groupId; the learner shape has no groupId; the clause is in the learner query only", async () => {
  const m = world(); const r = await D.listForums(m.pool, member, 5, false); assert.deepStrictEqual(r.items.map((x) => x.id), [1, GF]); assert.ok(r.items.every((x) => !("groupId" in x) && !("staffOnly" in x)), "a learner is not told about groups");
  const q = sqlOf(m, "FROM lms_forums f WHERE f.course_id = @c"); assert.ok(/f\.staff_only = 0 AND \(f\.group_id IS NULL OR EXISTS/.test(q) && CLAUSE.test(q) && inOf(m, "FROM lms_forums f WHERE f.course_id = @c").vid === 30);
  const o = await D.listForums(world().pool, outsider, 5, false); assert.deepStrictEqual(o.items.map((x) => x.id), [1], "not a member: only the normal forum");
  const s = world({ staffView: true }); const st = await D.listForums(s.pool, teacher, 5, true); assert.deepStrictEqual(st.items.map((x) => [x.id, x.groupId]), [[1, null], [GF, GROUP_ID]]); assert.ok(!/lms_group_members/.test(sqlOf(s, "FROM lms_forums f WHERE f.course_id = @c")), "staff are not filtered");
});

test("every learner path checks membership: threads list (loadForum), thread read, new thread guard, reply, edit own post, report; each passes the learner's id and carries the clause; an outsider gets nothing", async () => {
  // listThreads -> loadForum
  const a = world(); assert.ok((await D.listThreads(a.pool, member, 5, GF, {}, false)).ok); const lf = sqlOf(a, "FROM lms_forums WHERE id = @f AND course_id = @c"); assert.ok(CLAUSE.test(lf) && /lms_forums\.group_id/.test(lf) && inOf(a, "FROM lms_forums WHERE id = @f AND course_id = @c").vid === 30);
  const a2 = world(); assert.strictEqual((await D.listThreads(a2.pool, outsider, 5, GF, {}, false)).notFound, true); assert.ok(!a2.log.some((x) => /FROM lms_threads t/.test(x.sql)), "an outsider reads no thread of the group forum");
  const a3 = world({ staffView: true }); assert.ok((await D.listThreads(a3.pool, teacher, 5, GF, {}, true)).ok); assert.ok(!/lms_group_members/.test(sqlOf(a3, "FROM lms_forums WHERE id = @f AND course_id = @c")));
  // createThread: loadForum + the guard inside the INSERT
  const b = world(); assert.ok((await D.createThread(b.pool, member, 5, GF, { title: "Plan", body: "Hi" }, false, {})).ok); const g = sqlOf(b, "INSERT INTO lms_threads"); assert.ok(/staff_only = 0 AND locked = 0 AND \(lms_forums\.group_id IS NULL OR EXISTS/.test(g) && /gm\.student_id = @vid AND gm\.removed_at IS NULL/.test(g), "the insert itself re-checks membership");
  const b2 = world(); assert.strictEqual((await D.createThread(b2.pool, outsider, 5, GF, { title: "Plan", body: "Hi" }, false, {})).notFound, true); assert.ok(!b2.log.some((x) => /INSERT INTO lms_threads/.test(x.sql)), "an outsider cannot start a thread");
  assert.ok((await D.createThread(world({ staffView: true }).pool, teacher, 5, GF, { title: "Plan", body: "Hi" }, true, {})).ok, "staff may post in any group forum");
  // createPost -> loadThread
  const c = world(); assert.ok((await D.createPost(c.pool, member, 5, 11, { body: "Reply" }, false, {})).ok); const lt = sqlOf(c, "FROM lms_threads t JOIN lms_forums f"); assert.ok(/f\.staff_only = 0 AND \(f\.group_id IS NULL OR EXISTS/.test(lt) && CLAUSE.test(lt) && inOf(c, "FROM lms_threads t JOIN lms_forums f").vid === 30);
  const c2 = world(); assert.strictEqual((await D.createPost(c2.pool, outsider, 5, 11, { body: "Reply" }, false, {})).notFound, true); assert.ok(!c2.log.some((x) => /OUTPUT INSERTED\.id SELECT th\.id/.test(x.sql)), "an outsider cannot reply");
  // editPost ownership join
  const d = world(); assert.ok((await D.editPost(d.pool, member, 5, 2, { body: "Edited" }, false)).ok); const ep = sqlOf(d, "SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t"); assert.ok(CLAUSE.test(ep) && /f\.staff_only = 0 AND \(f\.group_id IS NULL/.test(ep) && inOf(d, "SELECT TOP 1 p.id FROM lms_posts p JOIN lms_threads t").vid === 30);
  const d2 = world(); assert.strictEqual((await D.editPost(d2.pool, outsider, 5, 2, { body: "Edited" }, false)).notFound, true); assert.ok(!d2.log.some((x) => /UPDATE p SET body/.test(x.sql)), "a removed member can no longer edit in the group forum");
  // reportPost (L8.1b)
  const e = world(); await M.reportPost(e.pool, member, 5, 2, { reason: "rude" }); const rp = sqlOf(e, "SELECT TOP 1 p.id, p.author_source, p.author_id FROM lms_posts p"); assert.ok(CLAUSE.test(rp) && /f\.staff_only = 0 AND \(f\.group_id IS NULL/.test(rp) && inOf(e, "SELECT TOP 1 p.id, p.author_source, p.author_id FROM lms_posts p").vid === 30);
  const e2 = world(); assert.strictEqual((await M.reportPost(e2.pool, outsider, 5, 2, { reason: "rude" })).notFound, true); assert.ok(!e2.log.some((x) => /INSERT INTO lms_post_reports/.test(x.sql)), "an outsider cannot report a post they cannot see");
});

test("the learner clause is never applied to staff reads or to the staff-only routes (staff see everything; no group SQL for them)", async () => {
  const m = world({ staffView: true }); await D.listForums(m.pool, teacher, 5, true); await D.listThreads(m.pool, teacher, 5, GF, {}, true); await D.createPost(m.pool, teacher, 5, 11, { body: "x" }, true, {}); await D.editPost(m.pool, teacher, 5, 2, { body: "y" }, true);
  assert.ok(!m.log.some((x) => /lms_group_members/.test(x.sql)), "no membership SQL on any staff query");
});

test("reply notices: only members of the group are told about a reply in a group forum (the group id travels as @gid, membership checked per recipient); a normal forum sends @gid NULL", async () => {
  const POST = "FROM lms_posts p JOIN lms_threads t ON t.id = p.thread_id", WHO = "FROM ( SELECT th.author_id AS sid";
  const mk = (groupId, ids) => makeMockPool([["FROM lms_settings", () => []], [POST, () => [{ author_source: "Students", author_id: 30, thread_title: "Plan", course_title: "Bio", group_id: groupId }]], [WHO, () => ids.map((x) => ({ student_id: x }))]]);
  const deps = (m) => { const sent = []; return { sent, getPool: async () => m.pool, notify: async (p, rec, o) => { sent.push(rec); }, isActive: async () => true }; };
  const evt = { event: "lms.discussion.posted", tenant: "t1", courseId: 5, threadId: 11, postId: 31 };
  const g = mk(GROUP_ID, [21, 22]); const dg = deps(g); await N.handle(evt, dg); const w = sqlOf(g, WHO), i = inOf(g, WHO);
  assert.strictEqual(i.gid, GROUP_ID); assert.ok(/AND \(@gid IS NULL OR EXISTS \(SELECT 1 FROM lms_group_members gm JOIN lms_groups gg ON gg\.id = gm\.group_id AND gg\.course_id = gm\.course_id AND gg\.deleted_at IS NULL WHERE gm\.group_id = @gid AND gm\.course_id = @c AND gm\.student_id = x\.sid AND gm\.removed_at IS NULL\)\)/.test(w), w);
  assert.ok(/SELECT p\.author_source, p\.author_id, t\.title AS thread_title, c\.title AS course_title, f\.group_id/.test(sqlOf(g, POST)), "the forum's group is read with the reply");
  const n = mk(null, [21]); await N.handle(evt, deps(n)); assert.strictEqual(inOf(n, WHO).gid, null, "normal forum: no group filter value");
});

test("schema step 036: additive (guarded ALTER + index), last step, no destructive statement; the forums table is already blocked from the record editor", () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("036_lms_group_forums");
  assert.ok(i === ids.length - 10 && ids[i - 1] === "035_lms_groups" && ids[i + 1] === "037_lms_peer_review"); const t = schema.STEPS[i].sql.join("\n");
  assert.ok(/IF COL_LENGTH\('lms_forums', 'group_id'\) IS NULL ALTER TABLE lms_forums ADD group_id INT NULL/.test(t) && /IX_lms_forums_group ON lms_forums \(course_id, group_id\)/.test(t) && /IF NOT EXISTS \(SELECT \* FROM sys\.indexes WHERE name='IX_lms_forums_group'/.test(t));
  assert.ok(!/DROP |DELETE |UPDATE |ALTER COLUMN/i.test(t), "additive only");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_forums"/.test(server));
  assert.strictEqual(new Set(ids).size, ids.length, "step ids are unique");
});

test("routes: forum create/edit still pass the body through (groupId reaches the module); the clause helper is exported", () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  assert.ok(/forums`, dGate, gbManage, staffAccess, dRun\("FORUM CREATE", \(req\) => disc\.createForum\(req\.pool, req\.user, cid\(req\), req\.body\), 201\)/.test(src)); assert.strictEqual(typeof D.groupVis, "function");
});
