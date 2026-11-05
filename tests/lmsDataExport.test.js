/* L11.12 - learner data export (D-150). Mocked pool only: SQL NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsDataExport.test.js");
const X = require("../utils/lmsDataExport"), lmsRouter = require("../routes/lms");
const admin = { id: 1, role: "admin", source: "Users" }, NOW = new Date("2026-11-10T09:00:00Z");
const STUDENT = ["FROM Students WHERE id = @s", (i) => (i.s === 21 ? [{ id: 21 }] : [])];
const tableQ = (t, rows) => [`FROM ${t} WHERE`, () => rows];
const q = (m) => m.log.filter((x) => /FROM lms_/.test(x.sql));

test("exports every allow-listed table for ONE learner with a bound id, newest first, LMS tables only (no Students rows)", async () => {
  const m = makeMockPool([STUDENT, tableQ("lms_submissions", [{ id: 9, student_id: 21, body_text: "my essay" }])]);
  const r = await X.exportLearner(m.pool, admin, 21, { now: NOW });
  assert.ok(r.ok); assert.strictEqual(r.export.learnerId, 21); assert.strictEqual(r.export.exportedAt, "2026-11-10T09:00:00.000Z");
  assert.deepStrictEqual(Object.keys(r.export.tables), X.TABLES.map((t) => t.t)); assert.strictEqual(r.export.tables.lms_submissions.rows[0].body_text, "my essay");
  assert.strictEqual(q(m).length, X.TABLES.length); assert.ok(q(m).every((x) => x.inputs.s === 21 && /ORDER BY id DESC/.test(x.sql) && /TOP \(@lim\)/.test(x.sql)));
  assert.ok(!m.log.some((x) => /FROM Students st|JOIN Students/.test(x.sql)), "core identity is not exported");
  assert.ok(X.TABLES.every((t) => /^lms_[a-z_]+$/.test(t.t)), "table names are fixed constants");
});

test("secret-looking columns are dropped from every row (link hashes, private file names)", async () => {
  const m = makeMockPool([STUDENT, tableQ("lms_guardian_links", [{ id: 1, student_id: 21, label: "Mum", token_hash: "abc", expires_at: NOW }]),
    tableQ("lms_submission_files", [{ id: 2, student_id: 21, original_name: "a.pdf", stored_name: "x1y2.bin", size_bytes: 10 }]),
    tableQ("lms_calendar_feeds", [{ id: 3, student_id: 21, token_hash: "zzz" }])]);
  const r = await X.exportLearner(m.pool, admin, 21, { now: NOW }); const all = JSON.stringify(r.export);
  assert.ok(!/token_hash|stored_name|abc|x1y2|zzz/.test(all)); assert.strictEqual(r.export.tables.lms_guardian_links.rows[0].label, "Mum"); assert.strictEqual(r.export.tables.lms_submission_files.rows[0].original_name, "a.pdf");
  assert.ok(X.SECRET_COL.test("password_hash") && X.SECRET_COL.test("file_path") && !X.SECRET_COL.test("body_text"));
});

test("per-table cap: asks for cap+1, keeps cap, flags truncated; cap never above 5000", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: 10 - i, student_id: 21 }));
  const m = makeMockPool([STUDENT, tableQ("lms_grades", rows)]); const r = await X.exportLearner(m.pool, admin, 21, { cap: 3, now: NOW });
  assert.deepStrictEqual([r.export.tables.lms_grades.count, r.export.tables.lms_grades.truncated, r.export.perTableCap], [3, true, 3]);
  assert.strictEqual(q(m)[0].inputs.lim, 4); const big = await X.exportLearner(makeMockPool([STUDENT]).pool, admin, 21, { cap: 999999 }); assert.strictEqual(big.export.perTableCap, 5000);
});

test("audited once with counts only; no content in the audit row", async () => {
  const m = makeMockPool([STUDENT, tableQ("lms_submissions", [{ id: 9, student_id: 21, body_text: "private words" }])]); await X.exportLearner(m.pool, admin, 21, { now: NOW });
  const a = m.log.filter((x) => /lms_audit_log/.test(x.sql)); assert.strictEqual(a.length, 1); assert.strictEqual(a[0].inputs.act, "learner.exported");
  assert.ok(!JSON.stringify(a[0].inputs).includes("private words")); assert.ok(/"rows":1/.test(a[0].inputs.d));
});

test("bad or unknown learner, or no user: not found, nothing exported, nothing audited", async () => {
  for (const sid of ["x", 0, -1, 1.5, null, "21; DROP TABLE Students"]) assert.strictEqual((await X.exportLearner(makeMockPool([STUDENT]).pool, admin, sid)).notFound, true);
  const m = makeMockPool([STUDENT]); assert.strictEqual((await X.exportLearner(m.pool, admin, 99)).notFound, true); assert.strictEqual(q(m).length, 0); assert.strictEqual(m.log.filter((x) => /lms_audit_log/.test(x.sql)).length, 0);
  assert.strictEqual((await X.exportLearner(makeMockPool([STUDENT]).pool, null, 21)).notFound, true);
});

test("tenant isolation: school A's export never touches school B; B's learner id is not found in A", async () => {
  const T = makeTenants({ A: [STUDENT], B: [["FROM Students WHERE id = @s", () => [{ id: 55 }]]] });
  assert.ok((await X.exportLearner(T.A.pool, admin, 21, { now: NOW })).ok); T.assertUntouched("B");
  assert.strictEqual((await X.exportLearner(T.A.pool, admin, 55, { now: NOW })).notFound, true); T.assertUntouched("B");
});

test("route: GET /learners/:studentId/export = permission + handler (module gate is on the mount), admin permission is lms.settings.manage, no-store + attachment, 404 not 403 for unknown", async () => {
  const l = lmsRouter.stack.find((x) => x.route && x.route.path === "/learners/:studentId/export" && x.route.methods.get); assert.ok(l); assert.strictEqual(l.route.stack.length, 2);
  const run = async (pool, params) => { const res = makeRes(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; }; await l.route.stack[1].handle({ pool, user: admin, params }, res); return res; };
  const ok = await run(makeMockPool([STUDENT]).pool, { studentId: "21" }); assert.strictEqual(ok.headers["Cache-Control"], "no-store"); assert.ok(/attachment; filename="lms-learner-21\.json"/.test(ok.headers["Content-Disposition"]));
  assert.ok(ok.body ? ok.body.success : true);
  const nf = await run(makeMockPool([STUDENT]).pool, { studentId: "99" }); assert.strictEqual(nf.statusCode, 404); assert.ok(!nf.headers["Content-Disposition"]);
});
