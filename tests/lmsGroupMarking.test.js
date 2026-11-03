/* L8.4b — mark / return a group hand-in once (D-103). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
suite("lmsGroupMarking.test.js");
const GM = require("../utils/lmsGroupMarking");
const M = require("../utils/lmsMarking");

const teacher = { id: 7, role: "teacher", source: "Teachers" };
const world = (o = {}) => makeMockPool([
  ["s.group_id = (SELECT g.group_id FROM lms_submissions g", (i) => (o.none ? [] : (o.rows || [31, 32, 33]).map((id) => ({ id, student_id: 100 + id })))],
  ["SELECT TOP 1 id FROM lms_submissions WHERE id = @sid", () => (o.own ? [{ id: 31 }] : [])],
  ["FROM lms_submissions s LEFT JOIN Students st", () => o.queue || []],
  ["SELECT COUNT(*) AS n FROM lms_submissions s", () => [{ n: 0 }]],
  ["SELECT TOP 1 id, title, max_points FROM lms_assignments", () => [{ id: 4, title: "T", max_points: 100 }]],
]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql)).map((x) => `${x.inputs.act} ${x.inputs.d}`);
const inj = (name, fn) => ({ marking: { [name]: fn } });

test("saveGroupGrade: siblings found by group of THIS course + assignment (submitted, max 50, clicked row first); the same body goes to every row through saveGrade; counts and one audit entry", async () => {
  const calls = []; const o1 = inj("saveGrade", async (pool, user, c, a, sid, body) => { calls.push([c, a, sid, body]); return sid === 33 ? { ok: false, code: "ALREADY_RETURNED", errors: ["x"] } : { ok: true, grade: { finalPoints: 70, sid } }; });
  {
    const m = world({ rows: [31, 32, 33] }); const body = { points: 70, comment: "Good" }; const r = await GM.saveGroupGrade(m.pool, teacher, 5, 4, 31, body, { tenant: "t", ...o1 });
    assert.deepStrictEqual([r.ok, r.grade.sid, r.members.graded, r.members.skipped, r.members.failed], [true, 31, 2, [33], []]);
    assert.deepStrictEqual(calls.map((x) => x.slice(0, 3)), [[5, 4, 31], [5, 4, 32], [5, 4, 33]]); assert.ok(calls.every((x) => x[3] === body), "the same body for every member");
    const q = m.log.find((x) => /s\.group_id = \(SELECT g\.group_id/.test(x.sql)); assert.ok(/SELECT TOP 50/.test(q.sql) && /s\.assignment_id = @a AND s\.course_id = @c AND s\.status = 'submitted'/.test(q.sql) && /g\.id = @sid AND g\.assignment_id = @a AND g\.course_id = @c AND g\.status = 'submitted'/.test(q.sql) && /ORDER BY CASE WHEN s\.id = @sid THEN 0 ELSE 1 END/.test(q.sql), q.sql); assert.deepStrictEqual(q.inputs, { c: 5, a: 4, sid: 31 });
    const au = audits(m); assert.strictEqual(au.length, 1); assert.ok(/submission\.graded_group/.test(au[0]) && /"graded":2/.test(au[0]) && /"skipped":1/.test(au[0]));
  }
});

test("saveGroupGrade: if the clicked row is refused nothing else is touched; other members' failures are reported, not thrown; bad ids and non-actors cost no query", async () => {
  let n = 0; const o2 = inj("saveGrade", async () => { n++; return { ok: false, errors: ["points must be 0-100"] }; });
  { const m = world(); const r = await GM.saveGroupGrade(m.pool, teacher, 5, 4, 31, { points: 999 }, o2); assert.deepStrictEqual([r.ok, n, audits(m).length], [false, 1, 0]); }
  const o2b = inj("saveGrade", async (p, u, c, a, sid) => (sid === 32 ? { ok: false, code: "COURSE_READ_ONLY", errors: ["x"] } : { ok: true, grade: {} }));
  { const r = await GM.saveGroupGrade(world().pool, teacher, 5, 4, 31, { points: 5 }, o2b); assert.deepStrictEqual([r.ok, r.members.graded, r.members.failed], [true, 2, [{ submissionId: 32, code: "COURSE_READ_ONLY" }]]); }
  for (const args of [[teacher, 0, 4, 31], [teacher, 5, "x", 31], [teacher, 5, 4, null], [null, 5, 4, 31]]) { const m = world(); const r = await GM.saveGroupGrade(m.pool, ...args, {}, {}); assert.strictEqual(r.notFound, true); assert.strictEqual(m.log.length, 0); }
});

test("not group work = 409 NOT_GROUP_WORK (the row exists); a row of another course/assignment or none = 404; nothing is graded either way", async () => {
  let n = 0; const o3 = inj("saveGrade", async () => { n++; return { ok: true, grade: {} }; });
  {
    const a = await GM.saveGroupGrade(world({ none: true, own: true }).pool, teacher, 5, 4, 31, { points: 1 }, o3); assert.deepStrictEqual([a.ok, a.code], [false, "NOT_GROUP_WORK"]);
    const b = await GM.saveGroupGrade(world({ none: true }).pool, teacher, 5, 4, 31, { points: 1 }, o3); assert.strictEqual(b.notFound, true); assert.strictEqual(n, 0);
    const own = world({ none: true, own: true }); await GM.returnGroup(own.pool, teacher, 5, 4, 31, o3); const q = own.log.find((x) => /SELECT TOP 1 id FROM lms_submissions WHERE id = @sid/.test(x.sql)); assert.ok(/assignment_id = @a AND course_id = @c AND status = 'submitted'/.test(q.sql));
  }
});

test("returnGroup: returnGrade for every row, clicked first; ungraded or already returned members are skipped, never changed; audited with counts", async () => {
  const calls = []; const o4 = inj("returnGrade", async (p, u, c, a, sid) => { calls.push(sid); return sid === 32 ? { ok: false, code: "NOT_GRADED", errors: ["x"] } : sid === 33 ? { ok: false, code: "ALREADY_RETURNED", errors: ["x"] } : { ok: true, grade: { sid } }; });
  { const m = world(); const r = await GM.returnGroup(m.pool, teacher, 5, 4, 31, { tenant: "t", ...o4 }); assert.deepStrictEqual([r.ok, r.members.returned, r.members.skipped, r.members.failed, calls], [true, 1, [32, 33], [], [31, 32, 33]]); assert.ok(/submission\.returned_group/.test(audits(m)[0]) && /"returned":1/.test(audits(m)[0]) && /"skipped":2/.test(audits(m)[0])); }
  const o4b = inj("returnGrade", async () => ({ ok: false, code: "NOT_GRADED", errors: ["Save a grade before returning the work."] }));
  { const m = world(); const r = await GM.returnGroup(m.pool, teacher, 5, 4, 31, o4b); assert.deepStrictEqual([r.ok, r.code], [false, "NOT_GRADED"]); assert.strictEqual(audits(m).length, 0); }
});

test("queue: group work shows ONE row per group by default (lowest id of the same attempt), groups=all shows every row, a bad value never reaches the database, rows carry groupId", async () => {
  const row = { id: 31, group_id: 3, student_id: 131, attempt_no: 1, submitted_at: "2026-11-10T10:00:00Z", is_late: 0, late_penalty_percent: null, student_name: "A B", admission_no: "1", grade_status: null, final_points: null, max_points: null };
  const m = world({ queue: [row] }); const r = await M.listQueue(m.pool, 5, 4, {}); assert.ok(r.ok); assert.strictEqual(r.items[0].groupId, 3);
  const q = m.log.find((x) => /OFFSET/.test(x.sql)).sql; assert.ok(/s\.group_id IS NULL OR s\.id = \(SELECT MIN\(x\.id\) FROM lms_submissions x WHERE x\.assignment_id = s\.assignment_id AND x\.course_id = s\.course_id AND x\.group_id = s\.group_id AND x\.status = 'submitted' AND x\.attempt_no = s\.attempt_no\)/.test(q));
  assert.ok(/s\.group_id IS NULL OR/.test(m.log.find((x) => /COUNT\(\*\) AS n/.test(x.sql)).sql), "the total uses the same rule");
  const all = world({ queue: [row] }); await M.listQueue(all.pool, 5, 4, { groups: "all" }); assert.ok(!/MIN\(x\.id\)/.test(all.log.find((x) => /OFFSET/.test(x.sql)).sql));
  const bad = world(); const b = await M.listQueue(bad.pool, 5, 4, { groups: "x; DROP" }); assert.strictEqual(b.ok, false); assert.strictEqual(bad.log.length, 0);
});

test("static: 2 routes behind permission + course membership, registered after the guards; no raw db, no req.body, only fixed SQL interpolation", () => {
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && /\/submissions\/:submissionId\/group-(grade|return)$/.test(l.route.path)); assert.strictEqual(mine.length, 2);
  assert.deepStrictEqual(mine.map((l) => Object.keys(l.route.methods)[0]).sort(), ["post", "put"]); const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(router.stack.indexOf(l) > first); assert.ok(l.route.stack.length >= 3, "permission + membership + handler"); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsGroupMarking.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src) && !/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{(?!MAX_MEMBERS\b)[^}]*\}/.test(piece), piece.slice(0, 60));
});
