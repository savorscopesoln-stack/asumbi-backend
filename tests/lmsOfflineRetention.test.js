/* Offline receipts retention (D-119, A165): setting validation, cutoff, batches, dry run, admin gate, audit, tenant isolation. Mock pool, SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsOfflineRetention.test.js");
const R = require("../utils/lmsOfflineRetention"), S = require("../utils/lmsSettings");
const NOW = new Date("2026-11-10T09:00:00.000Z"), admin = { id: 3, role: "admin", source: "Staff" };
const S90 = { offline: { retentionDays: 90 } };
/* in-memory receipts: `old` rows older than the cutoff, `fresh` newer */
const world = (old = 0, fresh = 3) => {
  const st = { old, fresh, audits: [], deletes: 0 };
  const m = makeMockPool([
    ["SELECT COUNT(*) AS n FROM lms_offline_actions WHERE received_at < @cut", () => [{ n: st.old }]],
    ["DELETE TOP (@n) FROM lms_offline_actions WHERE received_at < @cut", (i) => { const n = Math.min(i.n, st.old); st.old -= n; st.deletes++; return [{ n }]; }],
    ["INSERT INTO lms_audit_log", (i) => { st.audits.push(i); return []; }]]);
  return { ...m, st };
};
const run = (w, body, settings = S90) => R.purge(w.pool, admin, body, { now: NOW, settings });

test("setting `offline.retentionDays`: default 90, whole numbers 31-3650 only (never below the 30-day stale window), unknown keys refused, not in the public view; normDays falls back on bad stored values", () => {
  assert.deepStrictEqual(S.DEFAULTS.offline, { retentionDays: 90 });
  assert.strictEqual(S.validateSettingsPatch({ offline: { retentionDays: "120" } }).value.offline.retentionDays, 120);
  for (const b of [{ retentionDays: 30 }, { retentionDays: 3651 }, { retentionDays: 31.5 }, { retentionDays: "x" }, { retentionDays: null }, { other: 1 }]) assert.strictEqual(S.validateSettingsPatch({ offline: b }).ok, false, JSON.stringify(b));
  for (const ok of [31, 3650]) assert.strictEqual(S.validateSettingsPatch({ offline: { retentionDays: ok } }).ok, true);
  assert.strictEqual(S.validateSettingsPatch({ offline: [1] }).ok, false); assert.ok(!("offline" in S.publicView(S.mergeSettings([]))));
  for (const bad of [undefined, null, {}, { offline: {} }, { offline: { retentionDays: 5 } }, { offline: { retentionDays: "90" } }, { offline: { retentionDays: 99999 } }, { offline: { retentionDays: 30.5 } }, { offline: { retentionDays: 90.5 } }]) assert.strictEqual(R.normDays(bad), 90, JSON.stringify(bad));
  assert.strictEqual(R.normDays({ offline: { retentionDays: 31 } }), 31);
});

test("body (pure): nothing or {dryRun: boolean} only", () => {
  for (const b of [undefined, null, {}, { dryRun: true }, { dryRun: false }]) assert.strictEqual(R.validateBody(b).ok, true);
  for (const b of [[], "x", { dryRun: "yes" }, { dryRun: 1 }, { days: 5 }, { dryRun: true, x: 1 }]) assert.strictEqual(R.validateBody(b).ok, false, JSON.stringify(b));
  assert.strictEqual(R.validateBody({ dryRun: true }).dryRun, true); assert.strictEqual(R.validateBody(undefined).dryRun, false);
});

test("purge: deletes only receipts older than now - retentionDays (cutoff passed as a parameter), batch of 2000 per statement, audit with COUNTS only; a small tenant needs one statement", async () => {
  const w = world(5); const r = await run(w, {});
  assert.deepStrictEqual([r.ok, r.deleted, r.more, r.dryRun, r.retentionDays, r.cutoff, w.st.old, w.st.deletes], [true, 5, false, false, 90, new Date(NOW.getTime() - 90 * 86400000).toISOString(), 0, 1]);
  const del = w.log.find((x) => /DELETE TOP/.test(x.sql)); assert.ok(/FROM lms_offline_actions WHERE received_at < @cut/.test(del.sql) && !/lms_submissions|lms_quiz|lms_lesson_progress|lms_grades/.test(del.sql), "only the receipts table");
  assert.deepStrictEqual([del.inputs.n, new Date(del.inputs.cut).toISOString()], [2000, r.cutoff]);
  assert.strictEqual(w.st.audits.length, 1); const a = w.st.audits[0]; assert.ok(a.act === "offline.retention_purged" && a.e === "lms_offline_actions" && /"deleted":5/.test(a.d) && /"retentionDays":90/.test(a.d) && !/text|answer/i.test(a.d.replace(/retentionDays/, "")), "counts only");
  const custom = world(0); const rc = await run(custom, {}, { offline: { retentionDays: 40 } }); assert.strictEqual(rc.cutoff, new Date(NOW.getTime() - 40 * 86400000).toISOString());
  const none = world(0); const rn = await run(none, undefined, undefined); assert.deepStrictEqual([rn.deleted, rn.retentionDays], [0, 90], "no settings at all = the default");
});

test("purge batches: 2000 per statement, at most 10 statements per call; more = true says to call again; the next call continues", async () => {
  const w = world(25000); const r = await run(w, {});
  assert.deepStrictEqual([r.deleted, r.more, w.st.deletes, w.st.old], [20000, true, 10, 5000]);
  const r2 = await run(w, {}); assert.deepStrictEqual([r2.deleted, r2.more, w.st.old], [5000, false, 0]);
  const exact = world(2000); const re = await run(exact, {}); assert.deepStrictEqual([re.deleted, re.more, exact.st.deletes], [2000, false, 2], "a full batch is followed by one more look, and an empty one ends it");
});

test("dryRun: only COUNTS, deletes nothing, writes no audit", async () => {
  const w = world(7); const r = await run(w, { dryRun: true });
  assert.deepStrictEqual([r.dryRun, r.wouldDelete, w.st.old, w.st.deletes, w.st.audits.length], [true, 7, 7, 0, 0]);
  assert.ok(w.log.every((x) => /^\s*SELECT/i.test(x.sql)));
});

test("bad body = refused and NOTHING touched", async () => {
  const w = world(4); const r = await run(w, { dryRun: "yes" }); assert.deepStrictEqual([r.ok, w.log.length, w.st.old], [false, 0, 4]);
});

test("tenant isolation: the purge runs only on the pool it is given; tenant B's receipts are untouched", async () => {
  const st = { old: 5 }, mk = () => [["DELETE TOP (@n) FROM lms_offline_actions", (i) => { const n = Math.min(i.n, st.old); st.old -= n; return [{ n }]; }], ["INSERT INTO lms_audit_log", () => []]];
  const T = makeTenants({ A: mk(), B: mk() }); const r = await R.purge(T.A.pool, admin, {}, { now: NOW, settings: S90 }); assert.strictEqual(r.deleted, 5); T.assertQueried("A"); T.assertUntouched("B");
});

test("route + wiring: flag `lms_offline` FIRST, then lms.settings.manage, no-store; bad body = 400 touching nothing; an audit row is written and the table list stays blocked from the record editor", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), p = "/offline/retention/purge";
  const lr = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.post); assert.ok(lr && lr.route.stack.length === 3);
  assert.ok(src.includes(`"${p}", olGate, requireLmsPermission("lms.settings.manage")`));
  const bad = makeRes(); let h = null; bad.setHeader = (k, v) => { h = [k, v]; }; const w = world(2);
  await lr.route.stack[2].handle({ pool: w.pool, user: admin, params: {}, body: { dryRun: "x" }, tenant: "t" }, bad);
  assert.deepStrictEqual([bad.statusCode, h], [400, ["Cache-Control", "no-store"]]); assert.ok(!w.log.some((x) => /DELETE|COUNT/.test(x.sql)));
  assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_offline_actions"/.test(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")));
  assert.ok(!/setInterval|setTimeout/.test(fs.readFileSync(path.join(__dirname, "../utils/lmsOfflineRetention.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, "")), "no hidden timer: the purge is an explicit, licence-gated admin action");
});
