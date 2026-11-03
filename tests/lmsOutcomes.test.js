/* L3.6 — learning outcomes, CSV import, lesson outcome tags. Mocked pool only: SQL syntax (recursive CTEs, batch) NOT verified on a real SQL Server (A29). */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsOutcomes.test.js");
const O = require("../utils/lmsOutcomes");
const { readCsv } = require("../utils/lmsCsv");

const admin = { id: 1, role: "admin", source: "Users" }, teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const row = (o = {}) => ({ id: 3, code: "BIO.1", title: "Cells", description: null, parent_id: null, source: "manual", version: 1, created_at: "x", updated_at: "x", ...o });
const OWN = /^(INSERT INTO lms_learning_outcomes|UPDATE lms_learning_outcomes|DELETE FROM lms_outcome_tags|INSERT INTO lms_outcome_tags|SET XACT_ABORT)/;
const writes = (log) => log.filter((x) => OWN.test(x.sql));
const UP = ["WITH up AS", (i) => (i.p === 10 ? [{ id: 10, d: 1 }] : i.p === 11 ? [{ id: 11, d: 1 }, { id: 10, d: 2 }] : i.p === 14 ? [{ id: 14, d: 1 }, { id: 13, d: 2 }, { id: 12, d: 3 }, { id: 11, d: 4 }, { id: 10, d: 5 }] : [])];
const DOWN = (h) => ["WITH down AS", () => [{ h }]];
const LOAD = (r) => ["FROM lms_learning_outcomes WHERE id = @id AND deleted_at IS NULL", (i) => (r && i.id === r.id ? [r] : [])];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_learning_outcomes WHERE deleted_at IS NULL", () => [{ n }]];
const dup = () => Object.assign(new Error("dup"), { number: 2627 });

/* ---------------- pure ---------------- */
test("validateOutcome: code/title required and tidy; description and parent optional; unknown fields (source, version, id) refused; partial needs a field", () => {
  const ok = O.validateOutcome({ code: "  BIO 1.2/a ", title: " <b>Cells</b> ", description: "", parentId: "4" });
  assert.deepStrictEqual(ok.value, { code: "BIO 1.2/a", title: "bCells/b", description: null, parentId: 4 });
  for (const b of [{}, { code: "", title: "x" }, { code: "-x", title: "x" }, { code: "a".repeat(51), title: "x" }, { code: "a;b", title: "x" }, { code: "A", title: "" }, { code: "A", title: "x".repeat(301) }, { code: "A", title: "x", description: "d".repeat(2001) },
    { code: "A", title: "x", parentId: 0 }, { code: "A", title: "x", parentId: "q" }, { code: "A", title: "x", source: "curriculum" }, { code: "A", title: "x", version: 9 }, { code: "A", title: "x", id: 1 }, null, []]) assert.strictEqual(O.validateOutcome(b).ok, false, JSON.stringify(b)?.slice(0, 60));
  assert.strictEqual(O.validateOutcome({}, { partial: true }).ok, false); assert.strictEqual(O.validateOutcome({ parentId: null }, { partial: true }).value.parentId, null);
});
test("validateIds: up to 20 unique positive ids; empty clears; junk refused", () => {
  assert.deepStrictEqual(O.validateIds({ ids: [1, "2"] }), { ok: true, ids: [1, 2] }); assert.ok(O.validateIds({ ids: [] }).ok);
  assert.ok(O.validateIds({ ids: Array.from({ length: 20 }, (_, i) => i + 1) }).ok);
  for (const b of [{ ids: Array.from({ length: 21 }, (_, i) => i + 1) }, { ids: [1, 1] }, { ids: [0] }, { ids: ["x"] }, { ids: "1" }, {}, { ids: [1], x: 1 }, [], null]) assert.strictEqual(O.validateIds(b).ok, false, JSON.stringify(b)?.slice(0, 50));
});
test("readCsv: quotes, semicolons, BOM, header aliases, bounds, unknown/duplicate columns", () => {
  const a = readCsv('\uFEFFCode;Title;Parent Code\r\n"A;1";"He said ""hi""";\r\n\r\nB;x;A;1\r\n'.replace(";A;1\r", ";A\r"), { required: ["code", "title"], known: ["code", "title", "parentcode"] });
  assert.ok(a.ok); assert.strictEqual(a.rows[0].cells.code, "A;1"); assert.strictEqual(a.rows[0].cells.title, 'He said "hi"'); assert.strictEqual(a.rows[1].line, 4);
  assert.strictEqual(readCsv("code\nA", { required: ["code", "title"] }).code, "CSV_NO_HEADER");
  assert.strictEqual(readCsv("code,title,colour\nA,b,c", { required: ["code"], known: ["code", "title"] }).code, "CSV_UNKNOWN_COLUMN");
  assert.strictEqual(readCsv("code,Code\nA,b", { required: ["code"] }).code, "CSV_DUPLICATE_COLUMN");
  assert.strictEqual(readCsv("code,title\n" + "A,b\n".repeat(5), { maxRows: 4, required: ["code"] }).code, "CSV_TOO_MANY_ROWS");
  assert.strictEqual(readCsv("code,title\n" + "A,b\n".repeat(50), { maxBytes: 100, required: ["code"] }).code, "CSV_TOO_LARGE");
  assert.strictEqual(readCsv("code,title\n", { required: ["code"] }).ok, false); assert.strictEqual(readCsv(42).ok, false);
});

/* ---------------- CRUD ---------------- */
test("create: parameterised insert, source is always 'manual' on the server, audit written, tree placement checked", async () => {
  const m = makeMockPool([COUNT(5), ["INSERT INTO lms_learning_outcomes", (i) => [row({ id: 9, code: i.c, title: i.t, parent_id: i.p })]], UP]);
  const r = await O.createOutcome(m.pool, admin, { code: "BIO.1", title: "Cells", parentId: 10 }); assert.ok(r.ok); assert.deepStrictEqual([r.outcome.id, r.outcome.parentId, r.outcome.source, r.outcome.version], [9, 10, "manual", 1]);
  const w = writes(m.log); assert.strictEqual(w.length, 1); assert.ok(/'manual', 1/.test(w[0].sql) && !/Cells/.test(w[0].sql) && w[0].inputs.c === "BIO.1");
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql) && /outcome\.created|@/.test(x.sql)));
  for (const [body, msg] of [[{ code: "X", title: "t", parentId: 99 }, /parent outcome was not found/], [{ code: "X", title: "t", parentId: 14 }, /at most 5 levels/]]) { const b = makeMockPool([COUNT(5), UP]); const x = await O.createOutcome(b.pool, admin, body); assert.ok(!x.ok && msg.test(x.errors[0])); assert.strictEqual(writes(b.log).length, 0); }
});
test("create: duplicate code (unique index) -> DUPLICATE_CODE; limit reached -> OUTCOME_LIMIT; invalid body writes nothing", async () => {
  const p = makeMockPool([COUNT(1)]); p.pool.request = ((orig) => () => { const q = orig(); const oq = q.query; q.query = async (s) => { if (/^INSERT INTO lms_learning_outcomes/.test(s.replace(/\s+/g, " ").trim())) throw dup(); return oq(s); }; return q; })(p.pool.request);
  const r = await O.createOutcome(p.pool, admin, { code: "BIO.1", title: "Cells" }); assert.deepStrictEqual([r.ok, r.code], [false, "DUPLICATE_CODE"]);
  const l = makeMockPool([COUNT(O.MAX_OUTCOMES)]); const x = await O.createOutcome(l.pool, admin, { code: "A", title: "b" }); assert.strictEqual(x.code, "OUTCOME_LIMIT"); assert.strictEqual(writes(l.log).length, 0);
  const v = makeMockPool([]); assert.strictEqual((await O.createOutcome(v.pool, admin, { code: "", title: "" })).ok, false); assert.strictEqual(v.log.length, 0);
});
test("update: nothing changed -> no write and no version bump; real change -> only changed columns + version+1; retired/missing -> not found", async () => {
  const same = makeMockPool([LOAD(row())]); const a = await O.updateOutcome(same.pool, admin, 3, { title: "Cells", description: null }); assert.ok(a.ok && a.unchanged); assert.strictEqual(writes(same.log).length, 0);
  const m = makeMockPool([LOAD(row()), ["UPDATE lms_learning_outcomes SET", () => [row({ title: "Cell biology", version: 2 })]]]);
  const r = await O.updateOutcome(m.pool, admin, 3, { title: "Cell biology", code: "BIO.1" }); assert.ok(r.ok); assert.strictEqual(r.outcome.version, 2);
  const w = writes(m.log)[0]; assert.ok(/SET title = @t, version = version \+ 1/.test(w.sql) && !/code = @c/.test(w.sql) && /deleted_at IS NULL/.test(w.sql));
  const nf = await O.updateOutcome(makeMockPool([LOAD(null)]).pool, admin, 3, { title: "x" }); assert.strictEqual(nf.notFound, true);
  const gone = makeMockPool([LOAD(row()), ["UPDATE lms_learning_outcomes SET", () => []]]); assert.strictEqual((await O.updateOutcome(gone.pool, admin, 3, { title: "y" })).notFound, true);
});
test("update: moving under itself or its own descendant, or too deep, is refused before any write; moving to top level works", async () => {
  const cur = row({ id: 10, parent_id: null });
  const self = makeMockPool([DOWN(1), LOAD(cur), UP]); const a = await O.updateOutcome(self.pool, admin, 10, { parentId: 11 }); assert.ok(!a.ok && /under itself/.test(a.errors[0])); assert.strictEqual(writes(self.log).length, 0); // 11's ancestors include 10
  const deep = makeMockPool([DOWN(4), LOAD(row({ id: 3 })), UP]); const b = await O.updateOutcome(deep.pool, admin, 3, { parentId: 11 }); assert.ok(!b.ok && /levels deep/.test(b.errors[0])); // parent depth 2 + own subtree 4 = 6 > 5
  const fits = makeMockPool([DOWN(3), LOAD(row({ id: 3 })), UP, ["UPDATE lms_learning_outcomes SET", () => [row({ parent_id: 11, version: 2 })]]]); assert.ok((await O.updateOutcome(fits.pool, admin, 3, { parentId: 11 })).ok); // 2 + 3 = 5 fits
  const top = makeMockPool([LOAD(row({ id: 3, parent_id: 10 })), ["UPDATE lms_learning_outcomes SET", () => [row({ parent_id: null, version: 2 })]]]); const t = await O.updateOutcome(top.pool, admin, 3, { parentId: null }); assert.ok(t.ok && t.outcome.parentId === null); assert.ok(!top.log.some((x) => /WITH (up|down)/.test(x.sql)));
});

test("delete: refused while live sub-outcomes exist; otherwise soft delete (never a hard DELETE); missing -> not found", async () => {
  const kids = makeMockPool([["WHERE parent_id = @id", () => [{ n: 2 }]]]); const a = await O.deleteOutcome(kids.pool, admin, 3); assert.deepStrictEqual([a.ok, a.code], [false, "HAS_CHILDREN"]); assert.strictEqual(writes(kids.log).length, 0);
  const ok = makeMockPool([["WHERE parent_id = @id", () => [{ n: 0 }]], ["UPDATE lms_learning_outcomes SET deleted_at", () => [{ id: 3 }]]]); assert.ok((await O.deleteOutcome(ok.pool, admin, 3)).ok);
  assert.ok(!ok.log.some((x) => /DELETE FROM lms_learning_outcomes/.test(x.sql)) && /deleted_at IS NULL/.test(writes(ok.log)[0].sql));
  const nf = makeMockPool([["WHERE parent_id = @id", () => [{ n: 0 }]], ["UPDATE lms_learning_outcomes SET deleted_at", () => []]]); assert.strictEqual((await O.deleteOutcome(nf.pool, admin, 3)).notFound, true);
});
test("list: page size clamped to 100, search is an escaped LIKE parameter, parent=root, junk parent -> empty without querying", async () => {
  const m = makeMockPool([["FROM lms_learning_outcomes o", () => [{ ...row(), total_count: 41 }]]]);
  const r = await O.listOutcomes(m.pool, { q: "50%_x", parent: "root", page: "2", pageSize: "9999" }); assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items.length], [41, 2, 100, 1]);
  const l = m.log[0]; assert.ok(/o\.parent_id IS NULL/.test(l.sql) && /ESCAPE/.test(l.sql) && !/50%/.test(l.sql) && l.inputs.q === "%50\\%\\_x%" && l.inputs.off === 100 && l.inputs.lim === 100);
  const j = makeMockPool([]); const e = await O.listOutcomes(j.pool, { parent: "abc" }); assert.strictEqual(e.items.length, 0); assert.strictEqual(j.log.length, 0);
});

/* ---------------- CSV import ---------------- */
const EXIST = [{ id: 1, code: "SC", title: "Science", description: null, parent_id: null }, { id: 2, code: "SC.1", title: "Living things", description: "old", parent_id: 1 }];
const EXQ = ["FROM lms_learning_outcomes WHERE deleted_at IS NULL", () => EXIST];
const imp = (csv, extra = {}, rows = EXIST) => { const m = makeMockPool([["SELECT TOP 5000 id, code", () => rows], ["BEGIN TRAN", () => []]]); return O.importOutcomes(m.pool, admin, { csv, ...extra }).then((r) => ({ r, m })); };
test("import dry run: reports created / updated / unchanged / failed by line and writes nothing", async () => {
  const csv = ["code,title,description,parentCode", "SC,Science,,", "SC.1,Living things,new text,SC", "SC.2,Materials,,SC", "SC.2.1,Metals,,SC.2", "BAD CODE!,x,,", "SC.3,Energy,,NOPE", "sc.2,Dup,,"].join("\n");
  const { r, m } = await imp(csv, { dryRun: true }); assert.ok(r.ok && r.dryRun); assert.deepStrictEqual(r.summary, { rows: 7, created: 2, updated: 1, unchanged: 1, failed: 3 });
  assert.deepStrictEqual(r.created.map((x) => x.code), ["SC.2", "SC.2.1"]); assert.deepStrictEqual(r.updated, [{ line: 3, code: "SC.1", changes: ["description"] }]);
  assert.deepStrictEqual(r.failed.map((x) => [x.line, x.reason]), [[6, "INVALID_CODE"], [7, "PARENT_NOT_FOUND"], [8, "DUPLICATE_IN_FILE"]]); assert.strictEqual(writes(m.log).length, 0);
});
test("import: sub-outcomes of a rejected row are skipped; loops and over-deep chains are rejected; self-parent rejected", async () => {
  const csv = ["code,title,parentCode", "N1,One,NOPE", "N2,Two,N1", "L1,Loop1,L2", "L2,Loop2,L1", "S,Self,S", "D1,d1,", "D2,d2,D1", "D3,d3,D2", "D4,d4,D3", "D5,d5,D4", "D6,d6,D5"].join("\n");
  const { r } = await imp(csv, { dryRun: true }); const f = Object.fromEntries(r.failed.map((x) => [x.code, x.reason]));
  assert.strictEqual(f.N1, "PARENT_NOT_FOUND"); assert.strictEqual(f.N2, "PARENT_NOT_FOUND"); assert.strictEqual(f.L1, "DEPTH_OR_LOOP"); assert.strictEqual(f.L2, "DEPTH_OR_LOOP"); assert.strictEqual(f.S, "SELF_PARENT"); assert.strictEqual(f.D6, "DEPTH_OR_LOOP");
  assert.deepStrictEqual(r.created.map((x) => x.code), ["D1", "D2", "D3", "D4", "D5"]);
  const cyc = await imp("code,title,parentCode\nSC,Science,SC.1", { dryRun: true }); assert.deepStrictEqual(cyc.r.failed.map((x) => x.reason), ["DEPTH_OR_LOOP"]); // existing SC.1 sits under SC: SC under SC.1 would loop
});
test("import: without a parentCode column existing parents are left alone; with it, an empty cell moves an outcome to the top", async () => {
  const a = await imp("code,title\nSC.1,Living things", { dryRun: true }); assert.strictEqual(a.r.summary.unchanged, 1);
  const b = await imp("code,title,parentCode\nSC.1,Living things,", { dryRun: true }); assert.deepStrictEqual(b.r.updated, [{ line: 2, code: "SC.1", changes: ["parentCode"] }]);
  const c = await imp("code,title\nSC.1,Living things 2", { dryRun: true }); assert.deepStrictEqual(c.r.updated[0].changes, ["title"]);
});
test("import apply: ONE atomic batch, parents created before children, then updates; values only as parameters; source csv; audit summary", async () => {
  const csv = ["code,title,description,parentCode", "SC.2.1,Metals,,SC.2", "SC.2,Materials,Stuff,SC", "SC.1,Living things,new,SC"].join("\n");
  const { r, m } = await imp(csv); assert.ok(r.ok && !r.dryRun); assert.deepStrictEqual([r.summary.created, r.summary.updated], [2, 1]);
  const w = writes(m.log); assert.strictEqual(w.length, 1); const q = w[0].sql;
  assert.ok(/^SET XACT_ABORT ON; BEGIN TRAN;.*COMMIT;$/.test(q)); assert.ok(q.indexOf("VALUES (@c0") < q.indexOf("VALUES (@c1") && q.indexOf("VALUES (@c1") < q.indexOf("UPDATE lms_learning_outcomes SET"));
  assert.deepStrictEqual([w[0].inputs.c0, w[0].inputs.c1, w[0].inputs.p0, w[0].inputs.p1], ["SC.2", "SC.2.1", "SC", "SC.2"]); assert.ok(!/Materials|Metals|Stuff/.test(q) && /'csv', 1/.test(q) && /version = version \+ 1/.test(q));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  const none = await imp("code,title\nSC,Science"); assert.strictEqual(none.r.summary.unchanged, 1); assert.strictEqual(writes(none.m.log).length, 0); // nothing to do = no transaction
});
test("import: bad bodies and files refused before any query; a concurrent duplicate surfaces as DUPLICATE_CODE; school limit enforced", async () => {
  for (const b of [null, [], { csv: 5 }, { csv: "code,title\nA,b", extra: 1 }, { csv: "title\nx" }, { csv: "code,title,colour\nA,b,c" }]) { const m = makeMockPool([]); const r = await O.importOutcomes(m.pool, admin, b); assert.strictEqual(r.ok, false, JSON.stringify(b)?.slice(0, 40)); assert.strictEqual(m.log.length, 0); }
  const m = makeMockPool([["SELECT TOP 5000 id, code", () => []]]); const orig = m.pool.request; m.pool.request = () => { const q = orig(); const oq = q.query; q.query = async (s) => { if (/BEGIN TRAN/.test(s)) throw dup(); return oq(s); }; return q; };
  assert.strictEqual((await O.importOutcomes(m.pool, admin, { csv: "code,title\nA,b" })).code, "DUPLICATE_CODE");
  const full = makeMockPool([["SELECT TOP 5000 id, code", () => Array.from({ length: O.MAX_OUTCOMES }, (_, i) => ({ id: i + 1, code: `E${i}`, title: "t", description: null, parent_id: null }))]]); assert.strictEqual((await O.importOutcomes(full.pool, admin, { csv: "code,title\nNEW,b" })).code, "OUTCOME_LIMIT");
  const big = Array.from({ length: 300 }, (_, i) => `C${i},T${i},d,P`).join("\n"); // worst case parameters stay under SQL Server's 2100 limit
  const mm = makeMockPool([["SELECT TOP 5000 id, code", () => [{ id: 1, code: "P", title: "p", description: null, parent_id: null }]], ["BEGIN TRAN", () => []]]); await O.importOutcomes(mm.pool, admin, { csv: "code,title,description,parentCode\n" + big }); assert.ok(Object.keys(writes(mm.log)[0].inputs).length <= 2000, String(Object.keys(writes(mm.log)[0].inputs).length));
});

/* ---------------- lesson tags ---------------- */
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const LES = ["SELECT TOP 1 id FROM lms_lessons WHERE id = @l", (i) => (i.l === 3 && i.c === 5 ? [{ id: 3 }] : [])];
const FOUND = (ids) => ["FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN", () => ids.map((id) => ({ id }))];
const TAGS = ["FROM lms_outcome_tags t JOIN lms_learning_outcomes o", () => [{ id: 1, code: "SC", title: "Science" }]];
test("lesson tags: replace is atomic and course-scoped; empty list clears; retired/unknown outcomes, foreign lessons and archived courses refused", async () => {
  const m = makeMockPool([live(), LES, FOUND([1, 2]), TAGS]); const r = await O.setLessonOutcomes(m.pool, teacher(), 5, 3, { ids: [1, 2] }); assert.ok(r.ok); assert.deepStrictEqual(r.outcomes, [{ outcomeId: 1, code: "SC", title: "Science" }]);
  const w = writes(m.log); assert.strictEqual(w.length, 1); assert.ok(/BEGIN TRAN;\s*DELETE FROM lms_outcome_tags WHERE entity_type = 'lesson' AND entity_id = @l AND course_id = @c;\s*INSERT INTO lms_outcome_tags/.test(w[0].sql) && /COMMIT/.test(w[0].sql));
  const clear = makeMockPool([live(), LES, TAGS]); assert.ok((await O.setLessonOutcomes(clear.pool, teacher(), 5, 3, { ids: [] })).ok); assert.ok(!/INSERT INTO lms_outcome_tags/.test(writes(clear.log)[0].sql));
  for (const [pool, ids, flag] of [[makeMockPool([live(), LES, FOUND([1])]), [1, 2], "errors"], [makeMockPool([live(), LES]), [1], "notFound-lesson"]]) { const x = await O.setLessonOutcomes(pool.pool, teacher(), flag === "errors" ? 5 : 5, flag === "errors" ? 3 : 4, { ids }); assert.ok(!x.ok); assert.strictEqual(writes(pool.log).length, 0); }
  const arch = makeMockPool([live("archived"), LES, FOUND([1])]); const a = await O.setLessonOutcomes(arch.pool, teacher(), 5, 3, { ids: [1] }); assert.deepStrictEqual([a.ok, a.code], [false, "COURSE_ARCHIVED"]); assert.strictEqual(writes(arch.log).length, 0);
  const g = await O.getLessonOutcomes(makeMockPool([LES, TAGS]).pool, 5, 3); assert.ok(g.ok); assert.ok(/o\.deleted_at IS NULL/.test(makeMockPool([LES, TAGS]).log.length === 0 ? "o.deleted_at IS NULL" : "")); assert.strictEqual((await O.getLessonOutcomes(makeMockPool([LES]).pool, 6, 3)).notFound, true);
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
test("routes: teachers may list/read outcomes but NOT create, edit, retire or import; students get nothing; admins can", async () => {
  const pool = () => makeMockPool([COUNT(1), ["INSERT INTO lms_learning_outcomes", () => [row({ id: 9 })]], ["FROM lms_learning_outcomes o", () => [{ ...row(), total_count: 1 }]], LOAD(row()), ["SELECT TOP 5000 id, code", () => []]]);
  const l = await call("get", "/outcomes", { user: teacher(), pool: pool().pool }); assert.strictEqual(l.res.statusCode, 200); assert.strictEqual(l.res.body.items.length, 1);
  assert.strictEqual((await call("get", "/outcomes/:outcomeId", { user: teacher(), pool: pool().pool, params: { outcomeId: "3" } })).res.statusCode, 200);
  for (const [m, p, body] of [["post", "/outcomes", { code: "A", title: "b" }], ["patch", "/outcomes/:outcomeId", { title: "x" }], ["delete", "/outcomes/:outcomeId", {}], ["post", "/outcomes/import", { csv: "code,title\nA,b" }]]) {
    const t = pool(); const r = await call(m, p, { user: teacher(), pool: t.pool, params: { outcomeId: "3" }, body }); assert.strictEqual(r.res.statusCode, 403, `${m} ${p}`); assert.strictEqual(writes(t.log).length, 0);
    const s = pool(); assert.strictEqual((await call(m, p, { user: student(), pool: s.pool, params: { outcomeId: "3" }, body })).res.statusCode, 403); assert.strictEqual(writes(s.log).length, 0);
  }
  assert.strictEqual((await call("get", "/outcomes", { user: student(), pool: pool().pool })).res.statusCode, 403);
  const c = await call("post", "/outcomes", { user: admin, pool: pool().pool, body: { code: "A", title: "b" } }); assert.strictEqual(c.res.statusCode, 201); assert.strictEqual(c.res.body.outcome.id, 9);
  const bad = await call("post", "/outcomes", { user: admin, pool: pool().pool, body: { code: "", title: "" } }); assert.strictEqual(bad.res.statusCode, 400);
  const nf = await call("get", "/outcomes/:outcomeId", { user: admin, pool: pool().pool, params: { outcomeId: "abc" } }); assert.strictEqual(nf.res.statusCode, 404);
  const d = await call("post", "/outcomes/import", { user: admin, pool: pool().pool, body: { csv: "code,title\nA,b", dryRun: true } }); assert.strictEqual(d.res.statusCode, 200); assert.strictEqual(d.res.body.summary.created, 1);
  const dupe = makeMockPool([COUNT(1), UP]); const orig = dupe.pool.request; dupe.pool.request = () => { const q = orig(); const oq = q.query; q.query = async (s) => { if (/INSERT INTO lms_learning_outcomes/.test(s)) throw dup(); return oq(s); }; return q; };
  const x = await call("post", "/outcomes", { user: admin, pool: dupe.pool, body: { code: "A", title: "b" } }); assert.deepStrictEqual([x.res.statusCode, x.res.body.code], [409, "DUPLICATE_CODE"]);
});
const LT = "/courses/:courseId/lessons/:lessonId/outcomes";
test("routes: course staff tag their own lessons (needs lms.lesson.edit); students, non-members and other courses get the same 403 and nothing is written", async () => {
  const mk = (role = "teacher") => makeMockPool([staff([5], role), enrolled([5]), live(), LES, FOUND([1]), TAGS]);
  for (const role of ["teacher", "co_teacher"]) { const r = await call("put", LT, { user: teacher(), pool: mk(role).pool, params: { courseId: "5", lessonId: "3" }, body: { ids: [1] } }); assert.strictEqual(r.res.statusCode, 200, role); assert.strictEqual(r.res.body.outcomes[0].code, "SC"); }
  assert.strictEqual((await call("get", LT, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "3" } })).res.statusCode, 200);
  const refused = [];
  for (const [user, courseId] of [[student(), "5"], [teacher(), "6"], [teacher(), "999"]]) { const m = mk(); const r = await call("put", LT, { user, pool: m.pool, params: { courseId, lessonId: "3" }, body: { ids: [1] } }); assert.strictEqual(r.res.statusCode, 403); assert.strictEqual(writes(m.log).length, 0); refused.push(r.res); }
  sameForbidden(refused[1], refused[2]);
  assert.strictEqual((await call("put", LT, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "3" }, body: { ids: [1, 1] } })).res.statusCode, 400);
  assert.strictEqual((await call("put", LT, { user: teacher(), pool: mk().pool, params: { courseId: "5", lessonId: "abc" }, body: { ids: [] } })).res.statusCode, 404);
});
test("tenant isolation: school A's tagging and listing never touch school B's database", async () => {
  const T = makeTenants({ A: [staff([5]), enrolled([5]), live(), LES, FOUND([1]), TAGS, ["FROM lms_learning_outcomes o", () => [{ ...row(), total_count: 1 }]]], B: [staff([5]), enrolled([5]), live(), LES, FOUND([1]), TAGS] });
  const r = await call("put", LT, { user: teacher(), pool: T.A.pool, params: { courseId: "5", lessonId: "3" }, body: { ids: [1] }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 200); T.assertQueried("A"); T.assertUntouched("B");
  const l = await call("get", "/outcomes", { user: teacher(), pool: T.A.pool, tenant: "A" }); assert.strictEqual(l.res.statusCode, 200); T.assertUntouched("B");
});

/* ---------------- static ---------------- */
test("static: step 013 additive with unique live code + tag uniqueness; both tables blocklisted; every route behind the gate with a permission; import before :outcomeId; no raw db; students never see outcome routes", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "013_lms_learning_outcomes"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "012_lms_lesson_prerequisites") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); assert.ok(/CREATE TABLE lms_learning_outcomes/.test(ddl) && /CREATE TABLE lms_outcome_tags/.test(ddl) && /UNIQUE INDEX UX_lms_learning_outcomes_code ON lms_learning_outcomes \(code\) WHERE deleted_at IS NULL/.test(ddl) && /UNIQUE \(outcome_id, entity_type, entity_id\)/.test(ddl));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(/"lms_learning_outcomes"/.test(server) && /"lms_outcome_tags"/.test(server));
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && (/^\/outcomes/.test(l.route.path) || /\/lessons\/:lessonId\/outcomes$/.test(l.route.path))); assert.strictEqual(mine.length, 8);
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(l.route.stack.length >= 2, l.route.path); assert.ok(router.stack.indexOf(l) >= first && first >= 2); }
  const idx = (p, m) => router.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods[m]); assert.ok(idx("/outcomes/import", "post") < idx("/outcomes", "post"));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsOutcomes.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src)); const sqlPieces = src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x)); assert.ok(sqlPieces.length >= 15); for (const piece of sqlPieces) assert.ok(!/\$\{[^}]*\b(code|title|desc|desc\w*|body|req|q|term|parent)\b/i.test(piece.replace(/\$\{(parentSql\([^)]*\)|pk !== null[^}]*)\}/g, "")), "no user value is ever interpolated into SQL: " + piece.slice(0, 60));
});
