/* L5.3a — rubrics (definitions, library, attach). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsRubrics.test.js");
const R = require("../utils/lmsRubrics");

const admin = { id: 1, role: "admin", source: "Users" }, teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const ROW = (o = {}) => ({ id: 9, course_id: 5, title: "Essay rubric", description: null, created_at: "x", updated_at: "x", ...o });
const LOADROW = (row) => ["FROM lms_rubrics WHERE id = @id", (i) => (row && i.id === row.id && (row.course_id == null ? i.c === undefined : i.c === row.course_id) ? [row] : [])];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_rubrics", () => [{ n }]];
const OUTC = (ids) => ["FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN", () => ids.map((id) => ({ id }))];
const CRIT = [{ id: 31, position: 1, title: "Argument", description: "", weight: "10.00" }, { id: 32, position: 2, title: "Language", description: "Clear", weight: "5.00" }];
const LEV = [{ criterion_id: 31, position: 1, label: "Strong", description: "", points: "10.00" }, { criterion_id: 31, position: 2, label: "Weak", description: "", points: "2.00" }, { criterion_id: 32, position: 1, label: "Good", description: "", points: "5.00" }, { criterion_id: 32, position: 2, label: "Poor", description: "", points: "0.00" }];
const READS = [["FROM lms_rubric_criteria WHERE rubric_id = @rid ORDER", () => CRIT], ["FROM lms_rubric_levels l", () => LEV], ["FROM lms_outcome_tags t", () => [{ entity_id: 31, outcome_id: 3, code: "BIO.1", title: "Cells" }]]];
const BODY = () => ({ title: " <b>Essay</b> rubric ", description: "Marks for essays", criteria: [
  { title: "Argument", weight: 10, outcomeIds: [3, 3], levels: [{ label: "Weak", points: 2 }, { label: "Strong", points: 10 }, { label: "OK", description: "Some", points: 6 }] },
  { title: "Language", description: "Clear", weight: "5", levels: [{ label: "Poor", points: 0 }, { label: "Good", points: 5 }] }] });
const withCrit = (c) => { const b = BODY(); b.criteria = c; return b; };

test("validate: text is normalised, levels are stored best first, tags de-duplicated, total is the sum of weights", () => {
  const v = R.validate(BODY()); assert.ok(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(v.value.title, "bEssay/b rubric");
  assert.deepStrictEqual(v.value.criteria[0].levels.map((l) => l.points), [10, 6, 2]); assert.deepStrictEqual(v.value.criteria[0].outcomeIds, [3]);
  assert.strictEqual(v.value.criteria[1].weight, 5); assert.strictEqual(R.totalOf(v.value.criteria), 15);
});
test("validate: every bound is enforced (counts, weights, level points, best level = weight, distinct points, unknown fields, sum <= 1000)", () => {
  const lv = (a, b) => [{ label: "a", points: a }, { label: "b", points: b }];
  const c = (o = {}) => ({ title: "C", weight: 10, levels: lv(10, 0), ...o });
  const bad = [null, [], {}, { title: "t" }, { title: "", criteria: [c()] }, { title: "t".repeat(201), criteria: [c()] }, { title: "t", description: "d".repeat(1001), criteria: [c()] }, { title: "t", criteria: [] },
    { title: "t", criteria: Array.from({ length: 21 }, () => c()) }, { title: "t", criteria: ["x"] }, { title: "t", extra: 1, criteria: [c()] },
    ...[c({ title: "" }), c({ description: "d".repeat(501) }), c({ weight: 0 }), c({ weight: -1 }), c({ weight: 1000.01 }), c({ weight: 1.234 }), c({ weight: "x" }), c({ weight: null }), c({ foo: 1 }),
      c({ levels: [{ label: "a", points: 10 }] }), c({ levels: Array.from({ length: 9 }, (_, i) => ({ label: "l", points: i === 0 ? 10 : i })) }), c({ levels: "x" }),
      c({ levels: lv(10, 11) }), c({ levels: lv(10, -1) }), c({ levels: lv(10, 0.123) }), c({ levels: lv(5, 0) }), c({ levels: lv(10, 10) }), c({ levels: [{ label: "", points: 10 }, { label: "b", points: 0 }] }),
      c({ levels: [{ label: "a", points: 10, extra: 1 }, { label: "b", points: 0 }] }), c({ levels: [{ label: "a", description: "d".repeat(501), points: 10 }, { label: "b", points: 0 }] }),
      c({ outcomeIds: [1, 2, 3, 4, 5, 6] }), c({ outcomeIds: ["x"] }), c({ outcomeIds: "1" }), c({ outcomeIds: [0] })].map((x) => ({ title: "t", criteria: [x] })),
    { title: "t", criteria: [c({ weight: 600, levels: lv(600, 0) }), c({ weight: 401, levels: lv(401, 0) })] }];
  bad.forEach((b, i) => assert.strictEqual(R.validate(b).ok, false, `case ${i}: ${JSON.stringify(b)?.slice(0, 90)}`));
  assert.ok(R.validate({ title: "t", criteria: [c({ weight: 600, levels: lv(600, 0) }), c({ weight: 400, levels: lv(400, 0) })] }).ok, "exactly 1000 is allowed");
  assert.ok(R.validate({ title: "t", criteria: Array.from({ length: 20 }, () => c({ weight: 1, levels: lv(1, 0) })) }).ok);
  assert.ok(R.validate({ title: "t", criteria: [c({ levels: Array.from({ length: 8 }, (_, i) => ({ label: "l", points: i === 0 ? 10 : i })) })] }).ok);
});
test("create (course): ONE transaction, text only as parameters, criteria matched by position, tags use the course id, audited, cap and outcomes checked first", async () => {
  const m = makeMockPool([live(), COUNT(0), OUTC([3]), ["INSERT INTO lms_rubrics (course_id", () => [{ id: 9 }]], LOADROW(ROW()), ...READS]);
  const r = await R.createRubric(m.pool, teacher(), 5, BODY()); assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual([r.rubric.id, r.rubric.maxPoints, r.rubric.criteria.length, r.rubric.criteria[0].outcomes[0].code], [9, 15, 2, "BIO.1"]);
  const w = m.log.find((x) => /INSERT INTO lms_rubrics \(course_id/.test(x.sql)); assert.ok(w);
  assert.ok(/SET XACT_ABORT ON/.test(w.sql) && /BEGIN TRAN/.test(w.sql) && /COMMIT/.test(w.sql) && /VALUES \(@c, @t, @d, @src, @uid\)/.test(w.sql));
  for (const text of ["Argument", "Weak", "Essay", "Clear", "Strong"]) assert.ok(!w.sql.includes(text), `user text in SQL: ${text}`);
  assert.deepStrictEqual([w.inputs.c, w.inputs.ct0, w.inputs.ll0_0, w.inputs.lp0_0, w.inputs.cw1, w.inputs.src], [5, "Argument", "Strong", 10, 5, "Teachers"]);
  assert.ok(/INSERT INTO lms_rubric_levels[\s\S]*c\.rubric_id = @rid AND c\.position = v\.cpos/.test(w.sql) && /SELECT v\.oid, 'rubric_criterion', c\.id, @c FROM \(VALUES \(1, 3\)\)/.test(w.sql));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  assert.ok(m.log.findIndex((x) => /FROM lms_courses/.test(x.sql)) < m.log.findIndex((x) => /INSERT INTO lms_rubrics/.test(x.sql)));
  const full = makeMockPool([live(), OUTC([3]), COUNT(100)]); const lim = await R.createRubric(full.pool, teacher(), 5, BODY()); assert.strictEqual(lim.code, "RUBRIC_LIMIT"); assert.ok(!full.log.some((x) => /INSERT INTO/.test(x.sql)));
  const gone = makeMockPool([live(), COUNT(0), OUTC([])]); const o = await R.createRubric(gone.pool, teacher(), 5, BODY()); assert.strictEqual(o.ok, false); assert.ok(/outcome must exist/.test(o.errors[0])); assert.ok(!gone.log.some((x) => /INSERT INTO/.test(x.sql)));
  const ro = makeMockPool([live("archived")]); assert.strictEqual((await R.createRubric(ro.pool, teacher(), 5, BODY())).ok, false); assert.ok(!ro.log.some((x) => /INSERT INTO/.test(x.sql)));
  const inv = makeMockPool([]); assert.strictEqual((await R.createRubric(inv.pool, teacher(), 5, { title: "" })).ok, false); assert.strictEqual(inv.log.length, 0, "validation happens before any query");
});
test("create (school library): course_id NULL, no course lookup, tags carry course 0, own cap of 200", async () => {
  const m = makeMockPool([COUNT(0), OUTC([3]), ["INSERT INTO lms_rubrics (course_id", () => [{ id: 4 }]], LOADROW(ROW({ id: 4, course_id: null })), ...READS]);
  const r = await R.createRubric(m.pool, admin, null, BODY()); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.rubric.courseId, null);
  const w = m.log.find((x) => /INSERT INTO lms_rubrics \(course_id/.test(x.sql)); assert.ok(/VALUES \(NULL, @t, @d, @src, @uid\)/.test(w.sql) && /'rubric_criterion', c\.id, 0 FROM \(VALUES/.test(w.sql)); assert.ok(!("c" in w.inputs));
  assert.ok(!m.log.some((x) => /FROM lms_courses/.test(x.sql))); assert.ok(/course_id IS NULL/.test(m.log.find((x) => /SELECT COUNT\(\*\) AS n FROM lms_rubrics/.test(x.sql)).sql));
  assert.notStrictEqual((await R.createRubric(makeMockPool([OUTC([3]), COUNT(199)]).pool, admin, null, BODY())).code, "RUBRIC_LIMIT", "199 < 200 still passes the cap");
  assert.strictEqual((await R.createRubric(makeMockPool([OUTC([3]), COUNT(200)]).pool, admin, null, BODY())).code, "RUBRIC_LIMIT");
});
test("replace: guard + write in ONE batch (in-use check first, scoped to the course), old tags/levels/criteria removed in order; in use -> 409 code; missing -> not found; archived course refused", async () => {
  const ok = makeMockPool([live(), LOADROW(ROW()), OUTC([3]), ["UPDATE lms_rubrics SET title", () => [{ outcome: "OK" }]], ...READS]);
  const r = await R.replaceRubric(ok.pool, teacher(), 5, 9, BODY()); assert.ok(r.ok, JSON.stringify(r.errors));
  const w = ok.log.find((x) => /UPDATE lms_rubrics SET title/.test(x.sql)); const s = w.sql;
  const at = (re) => s.search(re);
  assert.ok(at(/IF EXISTS \(SELECT 1 FROM lms_assignment_rubrics ar INNER JOIN lms_submissions s ON s\.assignment_id = ar\.assignment_id AND s\.status = 'submitted' WHERE ar\.rubric_id = @id\)/) >= 0);
  assert.ok(at(/IF EXISTS/) < at(/BEGIN TRAN/) && at(/BEGIN TRAN/) < at(/UPDATE lms_rubrics/) && at(/UPDATE lms_rubrics/) < at(/DELETE FROM lms_outcome_tags/) && at(/DELETE FROM lms_outcome_tags/) < at(/DELETE FROM lms_rubric_levels/) && at(/DELETE FROM lms_rubric_levels/) < at(/DELETE FROM lms_rubric_criteria/) && at(/DELETE FROM lms_rubric_criteria/) < at(/INSERT INTO lms_rubric_criteria/) && at(/INSERT INTO lms_rubric_criteria/) < at(/COMMIT/));
  assert.ok(/WHERE id = @id AND course_id = @c AND deleted_at IS NULL/.test(s) && !/@rid/.test(s) && /entity_type = 'rubric_criterion'/.test(s)); assert.deepStrictEqual([w.inputs.id, w.inputs.c], [9, 5]);
  assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const used = makeMockPool([live(), LOADROW(ROW()), OUTC([3]), ["UPDATE lms_rubrics SET title", () => [{ outcome: "IN_USE" }]]]); const u = await R.replaceRubric(used.pool, teacher(), 5, 9, BODY()); assert.deepStrictEqual([u.ok, u.code], [false, "RUBRIC_IN_USE"]); assert.ok(!used.log.some((x) => /lms_audit_log/.test(x.sql)));
  const lost = makeMockPool([live(), LOADROW(ROW()), OUTC([3]), ["UPDATE lms_rubrics SET title", () => [{ outcome: "MISSING" }]]]); assert.strictEqual((await R.replaceRubric(lost.pool, teacher(), 5, 9, BODY())).notFound, true);
  const other = makeMockPool([live(), LOADROW(ROW({ course_id: 6 }))]); assert.strictEqual((await R.replaceRubric(other.pool, teacher(), 5, 9, BODY())).notFound, true); assert.ok(!other.log.some((x) => /UPDATE lms_rubrics/.test(x.sql)));
  const ro = makeMockPool([live("archived"), LOADROW(ROW())]); assert.strictEqual((await R.replaceRubric(ro.pool, teacher(), 5, 9, BODY())).ok, false); assert.ok(!ro.log.some((x) => /UPDATE lms_rubrics/.test(x.sql)));
  const lib = makeMockPool([LOADROW(ROW({ id: 4, course_id: null })), OUTC([3]), ["UPDATE lms_rubrics SET title", () => [{ outcome: "OK" }]], ...READS]); await R.replaceRubric(lib.pool, admin, null, 4, BODY());
  const lw = lib.log.find((x) => /UPDATE lms_rubrics SET title/.test(x.sql)); assert.ok(/course_id IS NULL AND deleted_at IS NULL/.test(lw.sql) && /'rubric_criterion', c\.id, 0 FROM/.test(lw.sql) && !("c" in lw.inputs));
});
test("delete: a guarded UPDATE (not attached to a live assignment); refused with RUBRIC_ATTACHED otherwise; other course's rubric is not found; audited", async () => {
  const ok = makeMockPool([live(), LOADROW(ROW()), ["UPDATE lms_rubrics SET deleted_at", () => [{ id: 9 }]]]); assert.strictEqual((await R.deleteRubric(ok.pool, teacher(), 5, 9)).ok, true);
  const q = ok.log.find((x) => /UPDATE lms_rubrics SET deleted_at/.test(x.sql)); assert.ok(/WHERE id = @id AND course_id = @c AND deleted_at IS NULL AND NOT EXISTS \(SELECT 1 FROM lms_assignment_rubrics ar INNER JOIN lms_assignments a ON a\.id = ar\.assignment_id AND a\.deleted_at IS NULL WHERE ar\.rubric_id = @id\)/.test(q.sql)); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const att = makeMockPool([live(), LOADROW(ROW()), ["UPDATE lms_rubrics SET deleted_at", () => []]]); const a = await R.deleteRubric(att.pool, teacher(), 5, 9); assert.deepStrictEqual([a.ok, a.code], [false, "RUBRIC_ATTACHED"]); assert.ok(!att.log.some((x) => /lms_audit_log/.test(x.sql)));
  const other = makeMockPool([live(), LOADROW(ROW({ course_id: 6 }))]); assert.strictEqual((await R.deleteRubric(other.pool, teacher(), 5, 9)).notFound, true); assert.ok(!other.log.some((x) => /UPDATE lms_rubrics/.test(x.sql)));
});
test("copy: the source must be the school library or THIS course; independent copy in ONE transaction, retired outcomes dropped; default title; cap; strict body", async () => {
  const src = (row) => ["FROM lms_rubrics WHERE id = @f", (i) => (row && i.f === row.id && (row.course_id == null || row.course_id === i.c) ? [row] : [])];
  const ok = makeMockPool([live(), src(ROW({ id: 4, course_id: null, title: "Library essay" })), COUNT(3), ["INSERT INTO lms_rubrics (course_id, title, description, created_by_source", () => [{ id: 12 }]], LOADROW(ROW({ id: 12 })), ...READS]);
  const r = await R.copyRubric(ok.pool, teacher(), 5, { fromRubricId: 4 }); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.rubric.id, 12);
  const w = ok.log.find((x) => /INSERT INTO lms_rubrics \(course_id, title, description, created_by_source/.test(x.sql)); assert.strictEqual(w.inputs.t, "Library essay (copy)"); assert.deepStrictEqual([w.inputs.f, w.inputs.c], [4, 5]);
  assert.ok(/BEGIN TRAN/.test(w.sql) && /COMMIT/.test(w.sql) && /s\.course_id IS NULL OR s\.course_id = @c/.test(w.sql) && /lms_learning_outcomes o ON o\.id = t\.outcome_id AND o\.deleted_at IS NULL/.test(w.sql) && /SELECT t\.outcome_id, 'rubric_criterion', nc\.id, @c/.test(w.sql));
  const sq = ok.log.find((x) => /FROM lms_rubrics WHERE id = @f/.test(x.sql)); assert.ok(/deleted_at IS NULL AND \(course_id IS NULL OR course_id = @c\)/.test(sq.sql), "source lookup is scoped in SQL, not only by the mock");
  const named = makeMockPool([live(), src(ROW({ id: 4, course_id: 5 })), COUNT(3), ["INSERT INTO lms_rubrics (course_id, title, description, created_by_source", () => [{ id: 13 }]], LOADROW(ROW({ id: 13 })), ...READS]); await R.copyRubric(named.pool, teacher(), 5, { fromRubricId: 4, title: " My copy " });
  assert.strictEqual(named.log.find((x) => /INSERT INTO lms_rubrics/.test(x.sql)).inputs.t, "My copy");
  const foreign = makeMockPool([live(), src(ROW({ id: 8, course_id: 6 }))]); assert.strictEqual((await R.copyRubric(foreign.pool, teacher(), 5, { fromRubricId: 8 })).notFound, true); assert.ok(!foreign.log.some((x) => /INSERT INTO/.test(x.sql)));
  assert.strictEqual((await R.copyRubric(makeMockPool([live(), src(ROW({ id: 4, course_id: null })), COUNT(100)]).pool, teacher(), 5, { fromRubricId: 4 })).code, "RUBRIC_LIMIT");
  for (const b of [null, {}, { fromRubricId: "x" }, { fromRubricId: 4, course_id: 9 }, { fromRubricId: 4, title: "" }, { fromRubricId: 0 }]) { const p = makeMockPool([]); assert.strictEqual((await R.copyRubric(p.pool, teacher(), 5, b)).ok, false, JSON.stringify(b)); assert.strictEqual(p.log.length, 0); }
  assert.strictEqual((await R.copyRubric(makeMockPool([live("archived")]).pool, teacher(), 5, { fromRubricId: 4 })).ok, false);
});
test("attach: only a rubric of THIS course and a live assignment of this course; refused once work is handed in; detach; one upsert in a transaction; audited", async () => {
  const A = ["FROM lms_assignments WHERE id = @a", (i) => (i.a === 4 && i.c === 5 ? [{ id: 4 }] : [])], SUBS = (n) => ["FROM lms_submissions WHERE assignment_id = @a", () => (n ? [{ id: 1 }] : [])];
  const cur = ["FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r", () => [ROW()]];
  const ok = makeMockPool([live(), A, LOADROW(ROW()), SUBS(0), ["UPDATE lms_assignment_rubrics SET rubric_id", () => []], cur, ...READS]);
  const r = await R.setAssignmentRubric(ok.pool, teacher(), 5, 4, { rubricId: 9 }); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.rubric.id, 9);
  const w = ok.log.find((x) => /UPDATE lms_assignment_rubrics SET rubric_id/.test(x.sql)); assert.ok(/BEGIN TRAN/.test(w.sql) && /IF @@ROWCOUNT = 0 INSERT INTO lms_assignment_rubrics/.test(w.sql) && /COMMIT/.test(w.sql)); assert.deepStrictEqual([w.inputs.a, w.inputs.c, w.inputs.r], [4, 5, 9]); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const fr = ok.log.find((x) => /FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r/.test(x.sql)); assert.ok(/r\.course_id = @c AND r\.deleted_at IS NULL/.test(fr.sql) && /ar\.course_id = @c/.test(fr.sql));
  const foreign = makeMockPool([live(), A, LOADROW(ROW({ course_id: 6 })), SUBS(0)]); const f = await R.setAssignmentRubric(foreign.pool, teacher(), 5, 4, { rubricId: 9 }); assert.strictEqual(f.notFound, true); assert.ok(!foreign.log.some((x) => /lms_assignment_rubrics SET|INSERT INTO lms_assignment_rubrics/.test(x.sql)));
  const lib = makeMockPool([live(), A, LOADROW(ROW({ id: 4, course_id: null })), SUBS(0)]); assert.strictEqual((await R.setAssignmentRubric(lib.pool, teacher(), 5, 4, { rubricId: 4 })).notFound, true, "a library rubric must be copied first");
  const used = makeMockPool([live(), A, LOADROW(ROW()), SUBS(1)]); const u = await R.setAssignmentRubric(used.pool, teacher(), 5, 4, { rubricId: 9 }); assert.deepStrictEqual([u.ok, u.code], [false, "HAS_SUBMISSIONS"]);
  const used2 = makeMockPool([live(), A, SUBS(1)]); assert.strictEqual((await R.setAssignmentRubric(used2.pool, teacher(), 5, 4, { rubricId: null })).code, "HAS_SUBMISSIONS");
  const off = makeMockPool([live(), A, SUBS(0), ["DELETE FROM lms_assignment_rubrics", () => []], cur]); const d = await R.setAssignmentRubric(off.pool, teacher(), 5, 4, { rubricId: null }); assert.ok(d.ok); const dq = off.log.find((x) => /DELETE FROM lms_assignment_rubrics/.test(x.sql)); assert.ok(/assignment_id = @a AND course_id = @c/.test(dq.sql));
  assert.strictEqual((await R.setAssignmentRubric(makeMockPool([live(), ["FROM lms_assignments WHERE id = @a", () => []]]).pool, teacher(), 5, 77, { rubricId: 9 })).notFound, true);
  for (const b of [null, {}, { rubricId: "x" }, { rubricId: 0 }, { rubricId: 9, extra: 1 }]) { const p = makeMockPool([]); assert.strictEqual((await R.setAssignmentRubric(p.pool, teacher(), 5, 4, b)).ok, false, JSON.stringify(b)); assert.strictEqual(p.log.length, 0); }
  assert.strictEqual((await R.setAssignmentRubric(makeMockPool([live("archived")]).pool, teacher(), 5, 4, { rubricId: 9 })).ok, false);
  const none = makeMockPool([A, ["FROM lms_assignment_rubrics ar", () => []]]); const g = await R.getAssignmentRubric(none.pool, 5, 4); assert.deepStrictEqual([g.ok, g.rubric], [true, null]);
});
test("list + read: paged (max 100), scoped to the course or the library, counts via subqueries, full shape has criteria, levels (best first) and outcome codes", async () => {
  const m = makeMockPool([["FROM lms_rubrics r WHERE", () => [{ id: 9, course_id: 5, title: "Essay", description: null, updated_at: "x", criteria_count: 2, max_points: "15.00", attached_count: 1, total_count: 1 }]]]);
  const l = await R.listRubrics(m.pool, 5, { pageSize: 1000, page: 2 }); assert.deepStrictEqual([l.items[0].maxPoints, l.items[0].attachedCount, l.total, l.page, l.pageSize], [15, 1, 1, 2, 100]);
  assert.ok(/r\.course_id = @c AND r\.deleted_at IS NULL/.test(m.log[0].sql) && /OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY/.test(m.log[0].sql)); assert.deepStrictEqual([m.log[0].inputs.c, m.log[0].inputs.off, m.log[0].inputs.lim], [5, 100, 100]);
  const lib = makeMockPool([["FROM lms_rubrics r WHERE", () => []]]); await R.listRubrics(lib.pool, null, {}); assert.ok(/r\.course_id IS NULL AND r\.deleted_at IS NULL/.test(lib.log[0].sql) && !("c" in lib.log[0].inputs));
  const g = await R.getRubric(makeMockPool([LOADROW(ROW()), ...READS]).pool, 5, 9); assert.ok(g.ok);
  const tq = g.rubric && (await (async () => { const m2 = makeMockPool([LOADROW(ROW()), ...READS]); await R.getRubric(m2.pool, 5, 9); return m2.log.find((x) => /FROM lms_outcome_tags t/.test(x.sql)); })()); assert.ok(/o\.id = t\.outcome_id AND o\.deleted_at IS NULL/.test(tq.sql) && /t\.entity_type = 'rubric_criterion'/.test(tq.sql), "retired outcomes are never shown");
  assert.deepStrictEqual(g.rubric.criteria[0].levels.map((x) => x.label), ["Strong", "Weak"]); assert.deepStrictEqual([g.rubric.criteria[0].outcomes[0].code, g.rubric.criteria[1].outcomes.length, g.rubric.maxPoints], ["BIO.1", 0, 15]);
  assert.strictEqual((await R.getRubric(makeMockPool([LOADROW(ROW({ course_id: 6 }))]).pool, 5, 9)).notFound, true);
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
const RC = "/courses/:courseId/rubrics", RI = "/courses/:courseId/rubrics/:rubricId", RA = "/courses/:courseId/assignments/:assignmentId/rubric", LB = "/rubric-library", LI = "/rubric-library/:rubricId";
const mk = (role = "teacher") => makeMockPool([staff([5], role), live(), COUNT(0), OUTC([3]), ["INSERT INTO lms_rubrics (course_id", () => [{ id: 9 }]], ["UPDATE lms_rubrics SET title", () => [{ outcome: "OK" }]], ["UPDATE lms_rubrics SET deleted_at", () => [{ id: 9 }]],
  LOADROW(ROW()), ["FROM lms_rubrics r WHERE", () => []], ["FROM lms_assignments WHERE id = @a", () => [{ id: 4 }]], ["FROM lms_submissions WHERE assignment_id", () => []], ["FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r", () => [ROW()]], ...READS]);
test("routes: course staff write rubrics (lms.course.manage + membership); students, strangers and other courses get the same 403 and nothing is written", async () => {
  for (const role of ["teacher", "co_teacher"]) { const r = await call("post", RC, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body: BODY() }); assert.strictEqual(r.res.statusCode, 201, role); }
  const P = { courseId: "5", rubricId: "9", assignmentId: "4" };
  assert.strictEqual((await call("get", RC, { user: teacher(), pool: mk().pool, params: P })).res.statusCode, 200);
  assert.strictEqual((await call("get", RI, { user: teacher(), pool: mk().pool, params: P })).res.statusCode, 200);
  assert.strictEqual((await call("put", RI, { user: teacher(), pool: mk().pool, params: P, body: BODY() })).res.statusCode, 200);
  assert.strictEqual((await call("delete", RI, { user: teacher(), pool: mk().pool, params: P })).res.statusCode, 200);
  assert.strictEqual((await call("get", RA, { user: teacher(), pool: mk().pool, params: P })).res.statusCode, 200);
  assert.strictEqual((await call("put", RA, { user: teacher(), pool: mk().pool, params: P, body: { rubricId: 9 } })).res.statusCode, 200);
  const refused = [];
  for (const [user, courseId] of [[student(), "5"], [teacher(), "6"], [teacher(), "999"]]) for (const [m, p, b] of [["post", RC, BODY()], ["put", RI, BODY()], ["delete", RI, {}], ["get", RC, {}], ["get", RI, {}], ["get", RA, {}], ["put", RA, { rubricId: 9 }], ["post", `${RC}/copy`, { fromRubricId: 4 }]]) {
    const k = mk(); const r = await call(m, p, { user, pool: k.pool, params: { ...P, courseId }, body: b }); assert.strictEqual(r.res.statusCode, 403, `${m} ${p} ${courseId}`);
    assert.ok(!k.log.some((x) => /^(INSERT INTO lms_rubric|UPDATE lms_rubric|DELETE FROM lms_|UPDATE lms_assignment_rubrics)/.test(x.sql) || /INSERT INTO lms_rubrics|UPDATE lms_rubrics|DELETE FROM lms_assignment_rubrics/.test(x.sql)), `${m} ${p} wrote`); refused.push(r.res);
  }
  sameForbidden(refused[0], refused[1]);
  assert.strictEqual((await call("post", RC, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, body: { title: "" } })).res.statusCode, 400);
  assert.strictEqual((await call("get", RI, { user: teacher(), pool: mk().pool, params: { courseId: "5", rubricId: "x" } })).res.statusCode, 404);
  assert.strictEqual((await call("get", RA, { user: teacher(), pool: mk().pool, params: { courseId: "5", assignmentId: "x" } })).res.statusCode, 404);
});
test("routes: the school library - teachers READ, only LMS administrators write; students never; a library rubric is copied into the course (copy route precedes :rubricId)", async () => {
  const lib = () => makeMockPool([COUNT(0), OUTC([3]), ["INSERT INTO lms_rubrics (course_id", () => [{ id: 4 }]], ["UPDATE lms_rubrics SET title", () => [{ outcome: "OK" }]], ["UPDATE lms_rubrics SET deleted_at", () => [{ id: 4 }]], LOADROW(ROW({ id: 4, course_id: null })), ["FROM lms_rubrics r WHERE", () => []], ...READS]);
  assert.strictEqual((await call("get", LB, { user: teacher(), pool: lib().pool })).res.statusCode, 200);
  assert.strictEqual((await call("get", LI, { user: teacher(), pool: lib().pool, params: { rubricId: "4" } })).res.statusCode, 200);
  for (const [m, p, b] of [["post", LB, BODY()], ["put", LI, BODY()], ["delete", LI, {}]]) {
    const t = lib(); assert.strictEqual((await call(m, p, { user: teacher(), pool: t.pool, params: { rubricId: "4" }, body: b })).res.statusCode, 403, `teacher ${m}`); assert.ok(!t.log.some((x) => /lms_rubric|INSERT|UPDATE|DELETE/.test(x.sql.replace(/lms_user_permissions/g, ""))), "nothing but the permission lookup ran");
    const s = lib(); assert.strictEqual((await call(m, p, { user: student(), pool: s.pool, params: { rubricId: "4" }, body: b })).res.statusCode, 403, `student ${m}`); assert.ok(!s.log.some((x) => /lms_rubric|INSERT|UPDATE|DELETE/.test(x.sql.replace(/lms_user_permissions/g, ""))));
  }
  assert.strictEqual((await call("get", LB, { user: student(), pool: lib().pool })).res.statusCode, 403);
  assert.strictEqual((await call("get", LI, { user: student(), pool: lib().pool, params: { rubricId: "4" } })).res.statusCode, 403);
  assert.strictEqual((await call("post", LB, { user: admin, pool: lib().pool, body: BODY() })).res.statusCode, 201);
  assert.strictEqual((await call("put", LI, { user: admin, pool: lib().pool, params: { rubricId: "4" }, body: BODY() })).res.statusCode, 200);
  assert.strictEqual((await call("delete", LI, { user: admin, pool: lib().pool, params: { rubricId: "4" } })).res.statusCode, 200);
  const cp = makeMockPool([staff([5]), live(), ["FROM lms_rubrics WHERE id = @f", () => [ROW({ id: 4, course_id: null, title: "Lib" })]], COUNT(0), ["INSERT INTO lms_rubrics (course_id, title, description, created_by_source", () => [{ id: 12 }]], LOADROW(ROW({ id: 12 })), ...READS]);
  assert.strictEqual((await call("post", `${RC}/copy`, { user: teacher(), pool: cp.pool, params: { courseId: "5" }, body: { fromRubricId: 4 } })).res.statusCode, 201);
  const router = require("../routes/lms"), idx = (p, m) => router.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.ok(idx(`${RC}/copy`, "post") > -1 && idx(`${RC}/copy`, "post") < idx(RI, "get"));
  const code = (await call("delete", LI, { user: admin, pool: makeMockPool([LOADROW(ROW({ id: 4, course_id: null })), ["UPDATE lms_rubrics SET deleted_at", () => []]]).pool, params: { rubricId: "4" } })).res; assert.deepStrictEqual([code.statusCode, code.body.code], [409, "RUBRIC_ATTACHED"]);
});
test("tenant isolation: school A's rubric calls never touch school B's database; school B's rubric is invisible to A by id guessing", async () => {
  const T = makeTenants({ A: [staff([5]), live(), COUNT(0), OUTC([3]), ["INSERT INTO lms_rubrics (course_id", () => [{ id: 9 }]], LOADROW(ROW({ id: 9 })), ...READS], B: [staff([5]), live(), LOADROW(ROW({ id: 77, title: "B secret" })), ...READS] });
  const r = await call("post", RC, { user: teacher(), pool: T.A.pool, params: { courseId: "5" }, body: BODY(), tenant: "A" }); assert.strictEqual(r.res.statusCode, 201); T.assertQueried("A"); T.assertUntouched("B");
  const g = await call("get", RI, { user: teacher(), pool: T.A.pool, params: { courseId: "5", rubricId: "77" }, tenant: "A" }); assert.strictEqual(g.res.statusCode, 404); assert.ok(!JSON.stringify(g.res.body).includes("B secret")); T.assertUntouched("B");
});
test("static: step 019 additive and ordered after 018; unique positions; all four tables blocklisted from generic records; every new route gated; no raw db, no req.body, no user value in SQL text", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "019_lms_rubrics"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "018_lms_submission_files") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); for (const t of ["lms_rubrics", "lms_rubric_criteria", "lms_rubric_levels", "lms_assignment_rubrics"]) assert.ok(new RegExp(`CREATE TABLE ${t} `).test(ddl), t);
  for (const ix of ["UX_lms_rubric_criteria_pos", "UX_lms_rubric_levels_pos", "UX_lms_assignment_rubrics_assignment"]) assert.ok(new RegExp(`CREATE UNIQUE INDEX ${ix}`).test(ddl), ix);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), line = server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST"));
  for (const t of ["lms_rubrics", "lms_rubric_criteria", "lms_rubric_levels", "lms_assignment_rubrics"]) assert.ok(line.includes(`"${t}"`), t);
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && !/\/learn\//.test(l.route.path) && (/\/rubrics?(\/|$)/.test(l.route.path) || /^\/rubric-library/.test(l.route.path))); assert.strictEqual(mine.length, 13, "13 rubric routes");
  const first = router.stack.findIndex((l) => l.route); assert.ok(first >= 2);
  for (const l of mine) { assert.ok(router.stack.indexOf(l) > first, l.route.path); assert.ok(l.route.stack.length >= 2, l.route.path); }
  for (const l of mine.filter((x) => (x.route.methods.post || x.route.methods.put || x.route.methods.delete) && !/^\/rubric-library/.test(x.route.path))) assert.ok(l.route.stack.length >= 3, `${l.route.path} needs permission + membership`);
  for (const l of mine.filter((x) => /^\/rubric-library/.test(x.route.path))) assert.ok(l.route.stack.length >= 2, l.route.path);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsRubrics.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{(?!scopeSql|tagCourse|courseId == null|kids|IN_USE|tv\.length|cv\.join|lv\.join|tv\.join)[^}]*\}/.test(piece), "unexpected interpolation in SQL: " + piece.slice(0, 70));
});
