/* L8.2a - course groups (D-098): validation, reproducible allocation, group CRUD, members, learner view, schema 035, route gates, tenant isolation.
   Mocked pool only: SQL (filtered unique indexes, OPENJSON, table variables, OUTPUT INTO, XACT_ABORT batches) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsGroups.test.js");
const G = require("../utils/lmsGroups");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const dupErr = () => { const e = new Error("dup"); e.number = 2601; return e; };
const world = (o = {}, extra = []) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["DECLARE @n INT, @released INT", () => [{ n: o.noGroup ? 0 : 1, released: 4 }]],
  ["DECLARE @made TABLE", () => { if (o.allocDup) throw dupErr(); return [{ placed: o.placed ?? 6 }]; }],
  ["DECLARE @ok TABLE", () => [o.setRow || { eligible: 3, moved: 1, added: 1 }]],
  ["INSERTED.position SELECT @c, @n", () => { if (o.createDup) throw dupErr(); return o.createNone ? [] : [{ id: 9, position: 3 }]; }],
  ["UPDATE lms_groups SET name", () => { if (o.updateDup) throw dupErr(); return o.noGroup ? [] : [{ id: 2 }]; }],
  ["UPDATE lms_groups SET position", () => (o.noGroup ? [] : [{ id: 2 }])],
  ["FROM lms_groups g WHERE g.course_id = @c AND g.deleted_at IS NULL ORDER BY g.position", () => o.groups || [{ id: 1, name: "Group 1", position: 1, member_count: 3 }, { id: 2, name: "Group 2", position: 2, member_count: 2 }]],
  ["AND NOT EXISTS (SELECT 1 FROM lms_group_members m WHERE m.course_id = e.course_id", () => [{ n: o.unassigned ?? 4 }]],
  ["SELECT TOP 1 g.id, g.name FROM lms_groups g WHERE", () => (o.noGroup ? [] : [{ id: 2, name: "Group 2" }])],
  ["SELECT COUNT(*) AS n FROM lms_group_members m JOIN", () => [{ n: o.memberTotal ?? 2 }]],
  ["s.admissionNo AS admission_no FROM lms_group_members m", () => [{ student_id: 31, student_name: "Brian Otieno", admission_no: "A-17" }, { student_id: 30, student_name: "Amina Kamau", admission_no: "A-01" }]],
  ["UPDATE m SET removed_at = SYSUTCDATETIME() OUTPUT INSERTED.id", () => (o.noMember ? [] : [{ id: 5 }])],
  ["SELECT COUNT(*) AS n FROM lms_groups WHERE course_id = @c AND deleted_at IS NULL", () => [{ n: o.existing ?? 0 }]],
  ["SELECT TOP 2001 e.student_id FROM lms_course_enrolments", () => (o.learners || [6, 5, 4, 3, 2, 1]).map((x) => ({ student_id: x }))],
  ["SELECT TOP 1 g.id, g.name FROM lms_group_members m JOIN lms_groups g", () => (o.noMine ? [] : [{ id: 2, name: "Group 2" }])],
  ["SELECT TOP 100 m.student_id, s.name AS student_name", () => [{ student_id: 31, student_name: "Brian Otieno" }, { student_id: 30, student_name: "Amina Kamau" }]],
  ...extra]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const det = (m, n = 0) => JSON.parse(audits(m)[n].inputs.d);
const sqlOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).sql || "", inOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).inputs || {};

test("validation (pure): group name/position, members list, allocate body; unknown fields and bad types refused", () => {
  const g = G.validateGroup; assert.deepStrictEqual(g({ name: "  Team  <b>A</b> ", position: 2 }).value, { name: "Team bAb", position: 2 }.name ? { name: "Team bA/b", position: 2 } : null);
  for (const b of [{}, { name: "" }, { name: "x".repeat(101) }, { name: "A", position: -1 }, { name: "A", position: 1.5 }, { name: "A", position: 1001 }, { name: "A", x: 1 }, null, [], "t"]) assert.strictEqual(g(b).ok, false, JSON.stringify(b));
  assert.strictEqual(g({}, true).ok, false); assert.strictEqual(g({ position: 0 }, true).ok, true); assert.strictEqual(g({ name: "" }, true).ok, false);
  const m = G.validateMembers; assert.deepStrictEqual(m({ studentIds: [1, 2] }).value, { studentIds: [1, 2] });
  for (const b of [{}, { studentIds: [] }, { studentIds: [1, 1] }, { studentIds: [0] }, { studentIds: ["1"] }, { studentIds: [1.5] }, { studentIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { studentIds: [1], x: 1 }, null]) assert.strictEqual(m(b).ok, false, JSON.stringify(b));
  assert.strictEqual(m({ studentIds: Array.from({ length: 100 }, (_, i) => i + 1) }).ok, true);
  const a = G.validateAllocate; assert.deepStrictEqual(a({ groups: 3, seed: " s1 ", dryRun: true, replace: false }).value, { groups: 3, seed: "s1", dryRun: true, replace: false });
  for (const b of [{}, { groups: 1 }, { groups: 51 }, { groups: 2.5 }, { groups: "3" }, { groups: 3, seed: 5 }, { groups: 3, seed: "x".repeat(51) }, { groups: 3, seed: "  " }, { groups: 3, dryRun: "y" }, { groups: 3, replace: 1 }, { groups: 3, extra: 1 }, null]) assert.strictEqual(a(b).ok, false, JSON.stringify(b));
  assert.strictEqual(a({ groups: 50 }).ok, true); assert.strictEqual(a({ groups: 2 }).ok, true);
});

test("planAllocation (pure): REPRODUCIBLE (pinned results), independent of input order and duplicates, every learner exactly once, sizes differ by at most 1, the seed matters", () => {
  const P = G.planAllocation;
  assert.deepStrictEqual(P([1, 2, 3, 4, 5, 6], 2, "abc"), [{ position: 1, studentIds: [2, 5, 6] }, { position: 2, studentIds: [1, 3, 4] }]);
  assert.deepStrictEqual(P([6, 5, 4, 3, 2, 1, 3, 3], 2, "abc"), P([1, 2, 3, 4, 5, 6], 2, "abc"), "input order and duplicates do not matter");
  assert.deepStrictEqual(P([1, 2, 3, 4, 5, 6, 7], 3, "abc"), [{ position: 1, studentIds: [2, 4, 5] }, { position: 2, studentIds: [1, 3] }, { position: 3, studentIds: [6, 7] }]);
  assert.notDeepStrictEqual(P([1, 2, 3, 4, 5, 6], 2, "xyz"), P([1, 2, 3, 4, 5, 6], 2, "abc"));
  for (const [n, k, seed] of [[10, 3, "a"], [37, 5, "b"], [100, 7, "c"], [6, 6, "d"], [2, 2, "e"]]) {
    const ids = Array.from({ length: n }, (_, i) => (i + 1) * 3), r = P(ids, k, seed), all = r.flatMap((g) => g.studentIds), sizes = r.map((g) => g.studentIds.length);
    assert.deepStrictEqual([...all].sort((a, b) => a - b), ids); assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes ${sizes}`); assert.strictEqual(r.length, k); assert.ok(r.every((g, i) => g.position === i + 1 && g.studentIds.every((x, j, a) => !j || a[j - 1] < x)));
  }
});

test("listGroups: staff read, live groups of THIS course with active-member counts, unassigned learners counted, learners/other courses refused", async () => {
  const m = world(); const r = await G.listGroups(m.pool, teacher, 5); assert.deepStrictEqual([r.ok, r.items.length, r.items[0].memberCount, r.unassigned], [true, 2, 3, 4]);
  const q = sqlOf(m, "FROM lms_groups g WHERE g.course_id = @c"); assert.ok(/g\.deleted_at IS NULL/.test(q) && /e\.status = 'active'/.test(q) && /m\.removed_at IS NULL/.test(q) && /SELECT TOP 50/.test(q));
  const u = sqlOf(m, "AND NOT EXISTS (SELECT 1 FROM lms_group_members m"); assert.ok(/e\.course_id = @c AND e\.status = 'active'/.test(u) && /m\.removed_at IS NULL/.test(u));
  assert.ok((await G.listGroups(world({ status: "archived" }).pool, admin, 5)).ok, "archived courses can be read"); assert.ok((await G.listGroups(world({ status: "draft" }).pool, teacher, 5)).ok);
  for (const [u2, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const z = world(); assert.strictEqual((await G.listGroups(z.pool, u2, id)).notFound, true); assert.ok(!z.log.some((x) => /lms_groups/.test(x.sql))); }
});

test("createGroup: cap + next position decided inside the INSERT, name unique (409 NAME_TAKEN), audited, draft ok, archived read only, students and bad input refused first", async () => {
  const m = world(); const r = await G.createGroup(m.pool, teacher, 5, { name: " Red  team " }); assert.deepStrictEqual([r.ok, r.group.id, r.group.name, r.group.position], [true, 9, "Red team", 3]);
  const w = sqlOf(m, "INSERTED.position SELECT @c, @n"), i = inOf(m, "INSERTED.position SELECT @c, @n"); assert.ok(/COUNT\(\*\) FROM lms_groups WHERE course_id = @c AND deleted_at IS NULL\) < @max$/.test(w) && /COALESCE\(@pos, ISNULL\(\(SELECT MAX\(position\)/.test(w));
  assert.deepStrictEqual([i.c, i.n, i.max, i.src, i.uid, i.pos], [5, "Red team", 50, "Teachers", 7, null]); assert.deepStrictEqual(det(m), { courseId: 5 }); assert.strictEqual(audits(m)[0].inputs.act, "group.created");
  assert.strictEqual((await G.createGroup(world({ createNone: true }).pool, teacher, 5, { name: "X" })).code, "GROUP_LIMIT"); assert.strictEqual((await G.createGroup(world({ createDup: true }).pool, teacher, 5, { name: "X" })).code, "NAME_TAKEN");
  assert.strictEqual((await G.createGroup(world({ status: "archived" }).pool, teacher, 5, { name: "X" })).code, "COURSE_READ_ONLY"); assert.ok((await G.createGroup(world({ status: "draft" }).pool, teacher, 5, { name: "X" })).ok);
  const e = world({ createDup: true }); const boom = e.pool.request; e.pool.request = () => { const q = boom(); const f = q.query; q.query = async (s) => { if (/INSERTED\.position\s+SELECT/.test(s)) { const x = new Error("db"); x.number = 1; throw x; } return f(s); }; return q; }; await assert.rejects(() => G.createGroup(e.pool, teacher, 5, { name: "X" }), /db/);
  for (const [u, id] of [[student, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await G.createGroup(z.pool, u, 5 === id ? 5 : id, { name: "X" })).notFound, true); assert.ok(!z.log.some((x) => /INSERT INTO lms_groups/.test(x.sql))); }
  const bad = world(); for (const b of [{}, { name: "" }, null]) assert.strictEqual((await G.createGroup(bad.pool, teacher, 5, b)).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("updateGroup / removeGroup: scoped by course in SQL, only sent fields change, duplicate name = NAME_TAKEN, remove is soft and releases members in ONE batch, audited", async () => {
  const m = world(); assert.ok((await G.updateGroup(m.pool, teacher, 5, 2, { name: "Blue" })).ok); const u = sqlOf(m, "UPDATE lms_groups SET name"); assert.ok(/WHERE id = @g AND course_id = @c AND deleted_at IS NULL$/.test(u) && !/position = @pos/.test(u)); assert.deepStrictEqual(det(m), { courseId: 5, fields: ["name"] });
  const p = world(); await G.updateGroup(p.pool, teacher, 5, 2, { position: 4 }); assert.ok(/SET position = @pos/.test(sqlOf(p, "UPDATE lms_groups SET position")) && !/name = @n/.test(sqlOf(p, "UPDATE lms_groups SET position")));
  assert.strictEqual((await G.updateGroup(world({ updateDup: true }).pool, teacher, 5, 2, { name: "Blue" })).code, "NAME_TAKEN"); assert.strictEqual((await G.updateGroup(world({ noGroup: true }).pool, teacher, 5, 99, { name: "B" })).notFound, true);
  assert.strictEqual((await G.updateGroup(world({ status: "archived" }).pool, teacher, 5, 2, { name: "B" })).code, "COURSE_READ_ONLY"); const bad = world(); assert.strictEqual((await G.updateGroup(bad.pool, teacher, 5, 2, {})).ok, false); assert.strictEqual(bad.log.length, 0);
  const z = world(); assert.strictEqual((await G.updateGroup(z.pool, teacher, 5, "abc", { name: "B" })).notFound, true); assert.ok(!z.log.some((x) => /UPDATE lms_groups/.test(x.sql)));
  const d = world(); const r = await G.removeGroup(d.pool, teacher, 5, 2); assert.deepStrictEqual([r.ok, r.removed, r.released], [true, true, 4]); const b = sqlOf(d, "DECLARE @n INT, @released INT");
  assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(b) && /UPDATE lms_groups SET deleted_at = SYSUTCDATETIME\(\), updated_at = SYSUTCDATETIME\(\) WHERE id = @g AND course_id = @c AND deleted_at IS NULL/.test(b) && /IF @n > 0 BEGIN UPDATE lms_group_members SET removed_at = SYSUTCDATETIME\(\) WHERE group_id = @g AND course_id = @c AND removed_at IS NULL/.test(b) && !/DELETE FROM/.test(b) && /COMMIT/.test(b));
  assert.deepStrictEqual(det(d), { courseId: 5, released: 4 }); assert.strictEqual((await G.removeGroup(world({ noGroup: true }).pool, teacher, 5, 99)).notFound, true); const none = world({ noGroup: true }); await G.removeGroup(none.pool, teacher, 5, 99); assert.strictEqual(audits(none).length, 0);
  assert.strictEqual((await G.removeGroup(world({ status: "archived" }).pool, teacher, 5, 2)).code, "COURSE_READ_ONLY"); for (const u2 of [student, null]) { const s2 = world(); assert.strictEqual((await G.removeGroup(s2.pool, u2, 5, 2)).notFound, true); assert.strictEqual(s2.log.length, 0); }
});

test("listMembers: staff only, group must be live in THIS course, only ACTIVE enrolled learners, names + admission numbers for staff, paging capped", async () => {
  const m = world(); const r = await G.listMembers(m.pool, teacher, 5, 2, { page: "2", pageSize: "500" }); assert.deepStrictEqual([r.ok, r.group, r.total, r.pageSize, r.hasMore, r.items[0]], [true, { id: 2, name: "Group 2" }, 2, 50, false, { studentId: 31, name: "Brian Otieno", admissionNo: "A-17" }]);
  const q = sqlOf(m, "s.admissionNo AS admission_no FROM lms_group_members m"); assert.ok(/e\.status = 'active'/.test(q) && /m\.course_id = @c/.test(q) && /m\.removed_at IS NULL/.test(q) && /OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY/.test(q) && inOf(m, "s.admissionNo AS admission_no FROM lms_group_members m").off === 50);
  assert.strictEqual((await G.listMembers(world({ noGroup: true }).pool, teacher, 5, 99, {})).notFound, true); const nm = world({ noGroup: true }); await G.listMembers(nm.pool, teacher, 5, 99, {}); assert.ok(!nm.log.some((x) => /lms_group_members/.test(x.sql)));
  for (const [u, id] of [[student, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await G.listMembers(z.pool, u, id, 2, {})).notFound, true); assert.ok(!z.log.some((x) => /lms_group_members/.test(x.sql))); }
});

test("setMembers: ONE atomic batch; only ACTIVE learners of THIS course; moving = UPDATE in place, new = guarded INSERT (one live group per learner); counts reported; group re-checked inside the batch; audited with counts only", async () => {
  const m = world(); const r = await G.setMembers(m.pool, teacher, 5, 2, { studentIds: [30, 31, 32, 33] }); assert.deepStrictEqual([r.ok, r.added, r.moved, r.unchanged, r.skipped], [true, 1, 1, 1, 1]);
  const b = sqlOf(m, "DECLARE @ok TABLE"), i = inOf(m, "DECLARE @ok TABLE"); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(b) && /id = @g AND course_id = @c AND deleted_at IS NULL\) BEGIN ROLLBACK/.test(b) && /e\.course_id = @c AND e\.status = 'active' AND e\.student_id IN \(SELECT CAST\(value AS INT\) FROM OPENJSON\(@ids\)\)/.test(b));
  assert.ok(/UPDATE m SET group_id = @g FROM lms_group_members m JOIN @ok i ON i\.sid = m\.student_id WHERE m\.course_id = @c AND m\.removed_at IS NULL AND m\.group_id <> @g/.test(b) && /NOT EXISTS \(SELECT 1 FROM lms_group_members WITH \(UPDLOCK, HOLDLOCK\) WHERE course_id = @c AND student_id = i\.sid AND removed_at IS NULL\)/.test(b) && /COMMIT/.test(b));
  assert.deepStrictEqual([i.c, i.g, i.ids, i.src, i.uid], [5, 2, "[30,31,32,33]", "Teachers", 7]); assert.deepStrictEqual(det(m), { courseId: 5, requested: 4, added: 1, moved: 1 });
  assert.strictEqual((await G.setMembers(world({ setRow: { eligible: -1, moved: 0, added: 0 } }).pool, teacher, 5, 99, { studentIds: [1] })).notFound, true); const gone = world({ setRow: { eligible: -1, moved: 0, added: 0 } }); await G.setMembers(gone.pool, teacher, 5, 99, { studentIds: [1] }); assert.strictEqual(audits(gone).length, 0);
  assert.strictEqual((await G.setMembers(world({ status: "archived" }).pool, teacher, 5, 2, { studentIds: [1] })).code, "COURSE_READ_ONLY");
  for (const [u, id] of [[student, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await G.setMembers(z.pool, u, id, 2, { studentIds: [1] })).notFound, true); assert.ok(!z.log.some((x) => /DECLARE @ok/.test(x.sql))); }
  const bad = world(); for (const x of [{}, { studentIds: [] }, { studentIds: [1, 1] }]) assert.strictEqual((await G.setMembers(bad.pool, teacher, 5, 2, x)).ok, false); assert.strictEqual(bad.log.length, 0); const z = world(); assert.strictEqual((await G.setMembers(z.pool, teacher, 5, "x", { studentIds: [1] })).notFound, true); assert.ok(!z.log.some((x) => /DECLARE @ok/.test(x.sql)));
});

test("removeMember: soft removal scoped by group AND course, live group only, audited; unknown member 404", async () => {
  const m = world(); assert.ok((await G.removeMember(m.pool, teacher, 5, 2, 30)).ok); const q = sqlOf(m, "UPDATE m SET removed_at"); assert.ok(/g\.deleted_at IS NULL/.test(q) && /m\.group_id = @g AND m\.course_id = @c AND m\.student_id = @s AND m\.removed_at IS NULL$/.test(q) && !/DELETE FROM/.test(q));
  assert.deepStrictEqual(det(m), { courseId: 5, studentId: 30 }); const n = world({ noMember: true }); assert.strictEqual((await G.removeMember(n.pool, teacher, 5, 2, 99)).notFound, true); assert.strictEqual(audits(n).length, 0);
  assert.strictEqual((await G.removeMember(world({ status: "archived" }).pool, teacher, 5, 2, 30)).code, "COURSE_READ_ONLY");
  for (const [u, id, g, s] of [[student, 5, 2, 30], [teacher, 6, 2, 30], [teacher, 5, "x", 30], [teacher, 5, 2, 0]]) { const z = world(); assert.strictEqual((await G.removeMember(z.pool, u, id, g, s)).notFound, true); assert.ok(!z.log.some((x) => /UPDATE m SET/.test(x.sql))); }
});

test("allocate: dryRun writes nothing and returns the seed + sizes; same seed = same plan; GROUPS_EXIST unless replace; limits; ONE batch creates groups and members from the plan; replace releases the old set first; audited with the seed", async () => {
  const d = world(); const r = await G.allocate(d.pool, teacher, 5, { groups: 2, seed: "abc", dryRun: true }); assert.deepStrictEqual([r.ok, r.dryRun, r.seed, r.learners, r.groups], [true, true, "abc", 6, [{ name: "Group 1", size: 3 }, { name: "Group 2", size: 3 }]]); assert.ok(!d.log.some((x) => /DECLARE @made/.test(x.sql)) && audits(d).length === 0);
  assert.ok(/e\.status = 'active' ORDER BY e\.student_id/.test(sqlOf(d, "SELECT TOP 2001 e.student_id")) && /e\.course_id = @c/.test(sqlOf(d, "SELECT TOP 2001 e.student_id")));
  const m = world(); const a = await G.allocate(m.pool, teacher, 5, { groups: 2, seed: "abc" }); assert.deepStrictEqual([a.ok, a.seed, a.learners, a.placed], [true, "abc", 6, 6]); const i = inOf(m, "DECLARE @made TABLE"), b = sqlOf(m, "DECLARE @made TABLE");
  assert.deepStrictEqual(JSON.parse(i.names), [{ name: "Group 1", pos: 1 }, { name: "Group 2", pos: 2 }]); assert.deepStrictEqual(JSON.parse(i.map), [{ g: 1, sid: 2 }, { g: 1, sid: 5 }, { g: 1, sid: 6 }, { g: 2, sid: 1 }, { g: 2, sid: 3 }, { g: 2, sid: 4 }], "the pinned plan for seed abc");
  assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(b) && /OUTPUT INSERTED\.id, INSERTED\.position INTO @made/.test(b) && /JOIN @made m ON m\.position = j\.g/.test(b) && /e\.status = 'active'/.test(b) && /COMMIT; SELECT @placed AS placed/.test(b) && !/removed_at = SYSUTCDATETIME\(\) WHERE course_id = @c AND removed_at IS NULL;\s+UPDATE lms_groups SET deleted_at/.test(b), "no release without replace");
  assert.deepStrictEqual(det(m), { courseId: 5, groups: 2, learners: 6, placed: 6, seed: "abc", replaced: false });
  const m2 = world(); await G.allocate(m2.pool, teacher, 5, { groups: 2, seed: "abc" }); assert.strictEqual(inOf(m2, "DECLARE @made TABLE").map, i.map, "same learners + same seed = same result");
  const rnd = world(); const rr = await G.allocate(rnd.pool, teacher, 5, { groups: 2 }); assert.ok(/^[0-9a-f]{8}$/.test(rr.seed) && inOf(rnd, "DECLARE @made TABLE").map === JSON.stringify(G.planAllocation([1, 2, 3, 4, 5, 6], 2, rr.seed).flatMap((g) => g.studentIds.map((sid) => ({ g: g.position, sid })))), "a random seed is returned and reproduces the plan");
  const ex = world({ existing: 2 }); assert.strictEqual((await G.allocate(ex.pool, teacher, 5, { groups: 2, seed: "abc" })).code, "GROUPS_EXIST"); assert.ok(!ex.log.some((x) => /DECLARE @made/.test(x.sql)));
  const rep = world({ existing: 2 }); const rp = await G.allocate(rep.pool, teacher, 5, { groups: 2, seed: "abc", replace: true }); assert.ok(rp.ok); const rb = sqlOf(rep, "DECLARE @made TABLE");
  assert.ok(/UPDATE lms_group_members SET removed_at = SYSUTCDATETIME\(\) WHERE course_id = @c AND removed_at IS NULL;\s+UPDATE lms_groups SET deleted_at = SYSUTCDATETIME\(\), updated_at = SYSUTCDATETIME\(\) WHERE course_id = @c AND deleted_at IS NULL;/.test(rb) && rb.indexOf("UPDATE lms_group_members") < rb.indexOf("INSERT INTO lms_groups") && det(rep).replaced === true);
  assert.strictEqual((await G.allocate(world({ learners: [1, 2] }).pool, teacher, 5, { groups: 3, seed: "s" })).code, "TOO_MANY_GROUPS"); assert.strictEqual((await G.allocate(world({ learners: [] }).pool, teacher, 5, { groups: 2 })).code, "NO_LEARNERS");
  assert.strictEqual((await G.allocate(world({ learners: Array.from({ length: 2001 }, (_, k) => k + 1) }).pool, teacher, 5, { groups: 2 })).code, "TOO_MANY_LEARNERS");
  assert.strictEqual((await G.allocate(world({ allocDup: true }).pool, teacher, 5, { groups: 2, seed: "abc" })).code, "GROUPS_EXIST");
  assert.strictEqual((await G.allocate(world({ status: "archived" }).pool, teacher, 5, { groups: 2 })).code, "COURSE_READ_ONLY");
  for (const [u, id] of [[student, 5], [teacher, 6]]) { const z = world(); assert.strictEqual((await G.allocate(z.pool, u, id, { groups: 2 })).notFound, true); assert.ok(!z.log.some((x) => /lms_group|lms_course_enrolments/.test(x.sql))); }
  const bad = world(); for (const x of [{}, { groups: 1 }, { groups: 2, seed: 7 }]) assert.strictEqual((await G.allocate(bad.pool, teacher, 5, x)).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("myGroup: a learner gets ONLY their own group (id comes from the token), members as First L. with no ids or admission numbers, `mine` marks themselves; no group = null; staff, draft and other courses refused", async () => {
  const m = world(); const r = await G.myGroup(m.pool, student, 5); assert.deepStrictEqual([r.ok, r.group.id, r.group.name, r.group.members], [true, 2, "Group 2", [{ name: "Brian O.", mine: false }, { name: "Amina K.", mine: true }]]);
  const g = sqlOf(m, "SELECT TOP 1 g.id, g.name FROM lms_group_members m JOIN lms_groups g"); assert.ok(/m\.course_id = @c AND m\.student_id = @vid AND m\.removed_at IS NULL/.test(g) && /g\.deleted_at IS NULL/.test(g) && inOf(m, "SELECT TOP 1 g.id, g.name FROM lms_group_members m JOIN lms_groups g").vid === 30);
  const l = sqlOf(m, "SELECT TOP 100 m.student_id, s.name"); assert.ok(/m\.group_id = @g AND m\.course_id = @c AND m\.removed_at IS NULL/.test(l) && /e\.status = 'active'/.test(l)); assert.ok(!/admission|studentId|student_id"/i.test(JSON.stringify(r)) && !/"id":3[01]/.test(JSON.stringify(r.group.members)));
  const none = world({ noMine: true }); const nr = await G.myGroup(none.pool, student, 5); assert.deepStrictEqual([nr.ok, nr.group], [true, null]); assert.ok(!none.log.some((x) => /SELECT TOP 100 m\.student_id/.test(x.sql)));
  assert.ok((await G.myGroup(world({ status: "archived" }).pool, student, 5)).ok); assert.strictEqual((await G.myGroup(world({ status: "draft" }).pool, student, 5)).notFound, true);
  for (const [u, id] of [[teacher, 5], [admin, 5], [null, 5], [student, 6], [student, "x"]]) { const z = world(); assert.strictEqual((await G.myGroup(z.pool, u, id)).notFound, true); assert.ok(!z.log.some((x) => /lms_group_members/.test(x.sql))); }
});

test("schema step 035: additive, ONE live group per learner per course, unique live group names, indexes; blocked from the record editor; 035 is followed only by group forums 036 (L8.2b)", () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("035_lms_groups"); assert.ok(i === ids.length - 11 && ids[i - 1] === "034_lms_discussions" && ids[i + 1] === "036_lms_group_forums" && ids[i + 2] === "037_lms_peer_review");
  const t = schema.STEPS[i].sql.join("\n"); for (const n of ["lms_groups", "lms_group_members"]) assert.ok(new RegExp(`name='${n}'`).test(t), n);
  assert.ok(!/DROP |DELETE |ALTER TABLE [a-z_]+ DROP/i.test(t) && /UX_lms_groups_name ON lms_groups \(course_id, name\) WHERE deleted_at IS NULL/.test(t) && /UX_lms_group_members_one ON lms_group_members \(course_id, student_id\) WHERE removed_at IS NULL/.test(t) && /IX_lms_group_members_group ON lms_group_members \(group_id, removed_at\)/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_groups", "lms_group_members"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
});

test("routes: 9 routes behind lms_discussions; reads = staffAccess, writes = course.manage + staffAccess; the learner route studentOnly + studentAccess; shapes and status codes; wrong token kind refused", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), B = "/courses/:courseId/groups";
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const reads = [["get", B], ["get", `${B}/:groupId/members`]], writes = [["post", B], ["post", `${B}/allocate`], ["patch", `${B}/:groupId`], ["delete", `${B}/:groupId`], ["put", `${B}/:groupId/members`], ["delete", `${B}/:groupId/members/:studentId`]];
  for (const [m, p] of reads) assert.strictEqual(find(m, p).route.stack.length, 3, p); for (const [m, p] of writes) assert.strictEqual(find(m, p).route.stack.length, 4, p);
  assert.strictEqual(find("get", "/courses/:courseId/learn/groups/mine").route.stack.length, 4);
  assert.ok((src.match(/router\.(post|patch|put|delete)\([^\n]*dGate, gbManage, staffAccess, dRun\("GROUP/g) || []).length === 6 && /router\.get\(GRP, dGate, staffAccess/.test(src) && /groups\/mine`, dGate, studentOnly, studentAccess/.test(src));
  assert.ok(!find("post", "/courses/:courseId/learn/groups") && !find("put", "/courses/:courseId/learn/groups/mine") && !find("get", "/courses/:courseId/learn/groups"), "learners cannot list or change groups");
  const h = (m, p) => find(m, p).route.stack.slice(-1)[0].handle, rq = (o) => ({ params: { courseId: "5", groupId: "2", studentId: "30" }, query: {}, tenant: "t", ...o });
  let res = makeRes(); await h("get", B)(rq({ pool: world().pool, user: teacher }), res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.items.length, res.body.unassigned, "ok" in res.body], [200, true, 2, 4, false]);
  res = makeRes(); await h("post", B)(rq({ pool: world().pool, user: teacher, body: { name: "Red" } }), res); assert.deepStrictEqual([res.statusCode, res.body.group.id], [201, 9]);
  res = makeRes(); await h("post", B)(rq({ pool: world({ createDup: true }).pool, user: teacher, body: { name: "Red" } }), res); assert.deepStrictEqual([res.statusCode, res.body.code], [409, "NAME_TAKEN"]);
  res = makeRes(); await h("post", B)(rq({ pool: world().pool, user: teacher, body: {} }), res); assert.strictEqual(res.statusCode, 400);
  res = makeRes(); await h("post", `${B}/allocate`)(rq({ pool: world().pool, user: teacher, body: { groups: 2, seed: "abc", dryRun: true } }), res); assert.deepStrictEqual([res.statusCode, res.body.dryRun, res.body.seed], [200, true, "abc"]);
  res = makeRes(); await h("put", `${B}/:groupId/members`)(rq({ pool: world().pool, user: teacher, body: { studentIds: [30] } }), res); assert.deepStrictEqual([res.statusCode, res.body.added], [200, 1]);
  res = makeRes(); await h("put", `${B}/:groupId/members`)(rq({ pool: world().pool, user: teacher, body: { studentIds: [30] }, params: { courseId: "5", groupId: "abc" } }), res); assert.strictEqual(res.statusCode, 404);
  res = makeRes(); await h("delete", `${B}/:groupId`)(rq({ pool: world().pool, user: teacher }), res); assert.deepStrictEqual([res.statusCode, res.body.removed], [200, true]);
  res = makeRes(); await h("get", "/courses/:courseId/learn/groups/mine")(rq({ pool: world().pool, user: student }), res); assert.deepStrictEqual([res.statusCode, res.body.group.name], [200, "Group 2"]);
  res = makeRes(); await h("get", "/courses/:courseId/learn/groups/mine")(rq({ pool: world().pool, user: teacher }), res); assert.strictEqual(res.statusCode, 404, "a staff token on the learner handler is refused");
  res = makeRes(); await h("post", B)(rq({ pool: world().pool, user: student, body: { name: "X" } }), res); assert.strictEqual(res.statusCode, 404, "a learner token on a staff handler is refused even if the guards were bypassed");
});

test("tenant isolation + ID guessing: another school's pool sees no course so nothing is read or written; every table access is scoped by course_id", async () => {
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] });
  for (const r of [await G.listGroups(T.A.pool, teacher, 5), await G.createGroup(T.A.pool, teacher, 5, { name: "X" }), await G.updateGroup(T.A.pool, teacher, 5, 2, { name: "X" }), await G.removeGroup(T.A.pool, teacher, 5, 2), await G.listMembers(T.A.pool, teacher, 5, 2, {}), await G.setMembers(T.A.pool, teacher, 5, 2, { studentIds: [1] }), await G.removeMember(T.A.pool, teacher, 5, 2, 1), await G.allocate(T.A.pool, teacher, 5, { groups: 2 }), await G.myGroup(T.A.pool, student, 5)]) assert.strictEqual(r.notFound, true);
  T.assertUntouched("B");
  const m = world(); await G.listGroups(m.pool, teacher, 5); await G.createGroup(m.pool, teacher, 5, { name: "X" }); await G.updateGroup(m.pool, teacher, 5, 2, { name: "Y" }); await G.removeGroup(m.pool, teacher, 5, 2); await G.listMembers(m.pool, teacher, 5, 2, {}); await G.setMembers(m.pool, teacher, 5, 2, { studentIds: [1] }); await G.removeMember(m.pool, teacher, 5, 2, 1); await G.allocate(m.pool, teacher, 5, { groups: 2, seed: "s", replace: true }); await G.myGroup(m.pool, student, 5);
  for (const x of m.log.filter((y) => /lms_(groups|group_members)/.test(y.sql) && !/lms_courses|lms_audit_log/.test(y.sql))) assert.ok(/course_id = @c/.test(x.sql), `unscoped SQL: ${x.sql.slice(0, 110)}`);
});
