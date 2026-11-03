/* L1.5 — audit helper, event bus, usage meter. Mocked pool + real temp folders. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const fs = require("fs"), os = require("os"), path = require("path");
suite("lmsFoundation.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)
const A = require("../utils/lmsAudit");
const E = require("../utils/lmsEvents");
const U = require("../utils/lmsUsage");
// Wait for async event delivery. A timer alone is racy: if another test blocks the loop past the delay,
// timers run BEFORE the setImmediate that delivers the event. So wait, then flush setImmediate several times.
const tick = sharedTick;

test("audit: sanitizeDetails redacts secrets/contact keys at any depth and caps size", () => {
  const d = A.sanitizeDetails({ keys: ["a"], password: "x", nested: { Email: "a@b.c", ok: 1, deep: { apiKey: "k" } }, long: "z".repeat(1000) });
  assert.strictEqual(d.password, "[redacted]"); assert.strictEqual(d.nested.Email, "[redacted]"); assert.strictEqual(d.nested.deep.apiKey, "[redacted]");
  assert.strictEqual(d.nested.ok, 1); assert.ok(d.long.length < 400);
  assert.ok(A.serializeDetails({ big: "y".repeat(10000).split("") }).length <= 4100);
});

test("audit: writes a parameterised row; bad actor id becomes NULL; never throws", async () => {
  const { pool, log } = makeMockPool();
  assert.strictEqual(await A.audit(pool, { id: "7; DROP", role: "admin" }, "course.publish", "lms_courses", 12, { token: "t" }), true);
  const l = log[0]; assert.strictEqual(l.inputs.a, null); assert.strictEqual(l.inputs.eid, "12");
  assert.ok(!l.sql.includes("DROP")); assert.ok(JSON.parse(l.inputs.d).token === "[redacted]");
  const broken = { request() { return { input() { return this; }, async query() { throw new Error("db down"); } }; } };
  assert.strictEqual(await A.audit(broken, { id: 1 }, "x.y"), false);
  assert.strictEqual(await A.audit(pool, { id: 1 }, ""), false);
});

test("audit: listAudit clamps limit, filters by parameters only, and returns a paging cursor", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: 30 - i }));
  const { pool, log } = makeMockPool([["FROM lms_audit_log", () => rows]]);
  const r = await A.listAudit(pool, { entity: "x'; DROP--", limit: 3, beforeId: 31 });
  assert.strictEqual(log[0].inputs.lim, 3); assert.ok(!log[0].sql.includes("DROP")); assert.ok(log[0].sql.includes("id < @b"));
  assert.strictEqual(r.nextBeforeId, 28);
  assert.strictEqual((await A.listAudit(pool, { limit: 99999 })) && log[1].inputs.lim, 100);
  assert.strictEqual((await A.listAudit(pool, { limit: -5 })) && log[2].inputs.lim, 1);
  assert.strictEqual((await A.listAudit(pool, { limit: 5 })).nextBeforeId, null, "fewer rows than limit = no next page");
});

test("events: unknown event and missing tenant are rejected, not thrown", () => {
  assert.strictEqual(E.emit("lms.nope", { tenant: "a" }), false);
  assert.strictEqual(E.emit("lms.lesson.completed", {}), false);
  assert.strictEqual(E.emit("lms.lesson.completed", { tenant: "" }), false);
  assert.throws(() => E.on("lms.nope", () => {}));
});

test("events: async delivery with tenant to exact + wildcard subscribers; unsubscribe; failing handlers isolated", async () => {
  // (one sequential test: the harness runs tests concurrently and the bus is process-global)
  const got = []; let ok = 0;
  const off1 = E.on("lms.lesson.completed", (e) => { if (e.marker === "m1") got.push(["x", e]); }); // filter by OUR marker: other tests emit this event concurrently
  const off2 = E.on("*", (e) => { if (e.marker === "m1") got.push(["*", e]); });
  assert.strictEqual(E.emit("lms.lesson.completed", { tenant: "schoolA", studentId: 3, marker: "m1" }), true);
  assert.strictEqual(got.length, 0, "handlers must not run inside emit()");
  await tick();
  assert.strictEqual(got.length, 2); assert.strictEqual(got[0][1].tenant, "schoolA"); assert.ok(got[0][1].at);
  off1(); E.emit("lms.lesson.completed", { tenant: "schoolA", marker: "m1" }); await tick();
  assert.strictEqual(got.length, 3, "only the wildcard remains");
  off2();
  const b1 = E.on("lms.quiz.attempted", () => { throw new Error("boom"); });
  const b2 = E.on("lms.quiz.attempted", async () => { throw new Error("async boom"); });
  const g = E.on("lms.quiz.attempted", () => { ok++; });
  assert.doesNotThrow(() => E.emit("lms.quiz.attempted", { tenant: "t" }));
  await tick(); assert.strictEqual(ok, 1);
  b1(); b2(); g();
});

test("usage: measures only that tenant's lms folder (isolation), counts files, skips symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmsu-"));
  const w = (t, f, n) => { const d = path.join(root, t, "lms", "media"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f), Buffer.alloc(n)); };
  w("schoola", "a.bin", 1048576); w("schoola", "b.bin", 524288); w("schoolb", "c.bin", 5 * 1048576);
  fs.mkdirSync(path.join(root, "schoola", "photos"), { recursive: true }); fs.writeFileSync(path.join(root, "schoola", "photos", "p.jpg"), Buffer.alloc(999999)); // not LMS
  try { fs.symlinkSync(path.join(root, "schoolb"), path.join(root, "schoola", "lms", "link")); } catch { /* symlinks unsupported */ }
  U.invalidateStorage();
  const a = await U.getStorage("SchoolA", { root }); const b = await U.getStorage("schoolb", { root });
  assert.strictEqual(a.fileCount, 2); assert.strictEqual(a.storageMb, 1.5);
  assert.strictEqual(b.storageMb, 5);
  assert.strictEqual((await U.getStorage("../schoolb", { root })).storageMb, 5, "tenant name is sanitised, no path traversal");
  assert.strictEqual((await U.getStorage("nobody", { root })).storageMb, 0, "missing folder = 0");
  fs.rmSync(root, { recursive: true, force: true });
});

test("usage: getUsage reports percent of quota; active learners null when table missing, number when present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmsu-")); U.invalidateStorage();
  const d = path.join(root, "t1", "lms"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "f"), Buffer.alloc(1048576));
  const none = makeMockPool([["lms_activity_events", () => [{ n: null }]]]).pool;
  const u = await U.getUsage(none, "t1", 4, { root });
  assert.strictEqual(u.storagePercent, 25); assert.strictEqual(u.activeLearners30d, null);
  const some = makeMockPool([["lms_activity_events", () => [{ n: 42 }]]]).pool;
  assert.strictEqual((await U.getUsage(some, "t1", 4, { root })).activeLearners30d, 42);
  const broken = { request() { return { input() { return this; }, async query() { throw new Error("x"); } }; } };
  assert.strictEqual(await U.getActiveLearners(broken), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("usage: checkQuota blocks an upload that would exceed the quota (fresh measurement)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmsu-")); U.invalidateStorage();
  const d = path.join(root, "t2", "lms"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "f"), Buffer.alloc(3 * 1048576));
  assert.strictEqual((await U.checkQuota("t2", 4, 0.5 * 1048576, { root })).ok, true);
  const no = await U.checkQuota("t2", 4, 2 * 1048576, { root });
  assert.strictEqual(no.ok, false); assert.strictEqual(no.code, "LMS_STORAGE_QUOTA_EXCEEDED");
  assert.strictEqual((await U.checkQuota("t2", null, 1, { root })).ok, false, "no quota configured = fail closed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("router exposes /audit and /usage behind the settings permission; settings save emits an event", async () => {
  const router = require("../routes/lms");
  for (const p of ["/audit", "/usage"]) { const l = router.stack.find((x) => x.route && x.route.path === p); assert.ok(l, p); assert.ok(l.route.stack.length >= 2, p + " needs a permission check"); }
  const seen = [];
  const offS = E.on("lms.settings.updated", (e) => { if (e.tenant === "schoolA") seen.push(e); });
  const S = require("../utils/lmsSettings");
  const { pool } = makeMockPool();
  await S.saveSettings(pool, { id: 1, role: "admin" }, { lateSubmission: "block" }, "schoolA");
  await tick(); assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].tenant, "schoolA"); assert.deepStrictEqual(seen[0].keys, ["lateSubmission"]); offS();
});
