/* L1.1 — module entitlement registry + gate (utils/tenantModules.js). */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("tenantModules.test.js");

const M = require("../utils/tenantModules");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const row = (o = {}) => ({ module_key: "lms", enabled: true, flags_json: JSON.stringify(M.expandFlags("lms", { tier: "base" })), limits_json: "{}", note: null, updatedAt: new Date(), ...o });
const poolWith = (rows) => makeMockPool([["FROM tenant_modules", () => rows]]).pool;
const gate = async (pool, tenant, flag, user = { id: 1, role: "teacher" }) => {
  let called = false; const res = makeRes();
  await M.requireModule("lms", flag)({ user, pool, tenant }, res, () => { called = true; });
  return { called, res };
};

test("expandFlags: tiers, add-ons, explicit flags; rejects unknown input", () => {
  assert.deepStrictEqual(M.expandFlags("lms", { tier: "base" }), ["lms_core", "lms_assignments", "lms_quizzes", "lms_gradebook"]);
  assert.ok(M.expandFlags("lms", { tier: "standard", addons: ["lms_offline"] }).includes("lms_offline"));
  assert.ok(M.expandFlags("lms", { tier: "standard" }).includes("lms_discussions"));
  assert.strictEqual(M.expandFlags("lms", { tier: "gold" }), null);
  assert.strictEqual(M.expandFlags("lms", { tier: "base", addons: ["lms_core"] }), null, "a tier flag is not an add-on");
  assert.strictEqual(M.expandFlags("lms", { flags: ["lms_core", "nope"] }), null);
  assert.strictEqual(M.expandFlags("nomodule", { tier: "base" }), null);
});

test("toStatus: missing row / bad JSON means nothing is licensed", () => {
  assert.deepStrictEqual(M.toStatus(null).flags, []);
  assert.strictEqual(M.toStatus(null).enabled, false);
  const s = M.toStatus({ enabled: 1, flags_json: "{not json", limits_json: "[1]" });
  assert.deepStrictEqual(s.flags, []); assert.deepStrictEqual(s.limits, {});
});

test("tenant WITHOUT a row is blocked with 403 MODULE_NOT_LICENSED", async () => {
  M.invalidateModuleCache();
  const { called, res } = await gate(poolWith([]), "t-none", null);
  assert.strictEqual(called, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, "MODULE_NOT_LICENSED");
  assert.strictEqual(res.body.module, "lms");
});

test("licensed tenant passes; disabled tenant is blocked even though flags are kept", async () => {
  M.invalidateModuleCache();
  assert.strictEqual((await gate(poolWith([row()]), "t-on", "lms_core")).called, true);
  const off = await gate(poolWith([row({ enabled: false })]), "t-off", "lms_core");
  assert.strictEqual(off.called, false); assert.strictEqual(off.res.body.code, "MODULE_NOT_LICENSED");
});

test("feature flags: base tier lacks lms_discussions; add-on only when sold", async () => {
  M.invalidateModuleCache();
  const pool = poolWith([row()]);
  assert.strictEqual((await gate(pool, "t-f", "lms_quizzes")).called, true);
  const blocked = await gate(pool, "t-f", "lms_discussions");
  assert.strictEqual(blocked.called, false); assert.strictEqual(blocked.res.body.flag, "lms_discussions");
  assert.strictEqual((await gate(pool, "t-f", "lms_offline")).called, false);
});

test("fails CLOSED when the table cannot be read", async () => {
  M.invalidateModuleCache();
  const broken = { request() { return { input() { return this; }, async query() { throw new Error("Invalid object name 'tenant_modules'"); } }; } };
  const { called, res } = await gate(broken, "t-broken", null);
  assert.strictEqual(called, false); assert.strictEqual(res.statusCode, 403);
});

test("TENANT ISOLATION: cache is per tenant — A licensed never unlocks B", async () => {
  M.invalidateModuleCache();
  const a = poolWith([row()]); const b = poolWith([]);
  assert.strictEqual((await gate(a, "school-a", null)).called, true);
  assert.strictEqual((await gate(b, "school-b", null)).called, false);
  assert.strictEqual((await gate(a, "school-a", null)).called, true, "A still fine from cache");
  assert.strictEqual((await gate(b, "school-b", null)).called, false, "B still blocked from cache");
});

test("cache serves repeats without re-querying; invalidate forces a fresh read", async () => {
  M.invalidateModuleCache();
  const { pool, log } = makeMockPool([["FROM tenant_modules", () => [row()]]]);
  await M.getModuleStatus(pool, "t-c", "lms"); await M.getModuleStatus(pool, "t-c", "lms");
  assert.strictEqual(log.length, 1);
  M.invalidateModuleCache("t-c"); await M.getModuleStatus(pool, "t-c", "lms");
  assert.strictEqual(log.length, 2);
});

test("no bypass: admin, module_admin and the master account are gated too; unauthenticated is 401", async () => {
  M.invalidateModuleCache();
  for (const user of [{ id: 1, role: "admin" }, { id: 2, role: "module_admin" }, { id: 3, role: "admin", isMaster: true }]) {
    assert.strictEqual((await gate(poolWith([]), "t-nb", null, user)).called, false, user.role);
  }
  const res = makeRes(); let called = false;
  await M.requireModule("lms")({ pool: poolWith([row()]), tenant: "x" }, res, () => { called = true; });
  assert.strictEqual(called, false); assert.strictEqual(res.statusCode, 401);
});

test("isModuleActive (for background jobs) follows the same rules", async () => {
  M.invalidateModuleCache();
  assert.strictEqual(await M.isModuleActive(poolWith([row()]), "j1", "lms", "lms_core"), true);
  assert.strictEqual(await M.isModuleActive(poolWith([]), "j2", "lms"), false);
});

test("finance setModule: unknown institution is refused before any database call", async () => {
  const { setModule } = require("../controllers/financeModules.controller");
  const res = makeRes();
  await setModule({ params: { tenantKey: "no-such-school", moduleKey: "lms" }, body: { enabled: true, tier: "base" }, user: { id: 1 } }, res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.success, false);
});

test("wiring: finance-only routes, blocklisted from raw editor, schema at boot, UI interceptor, SQL parameterised", () => {
  const fin = read("routes/finance.js");
  assert.ok(/router\.use\([^)]*financeOnly/.test(fin) || /protect,\s*financeOnly/.test(fin), "finance router is protect+financeOnly");
  assert.ok(fin.includes('"/institutions/:tenantKey/modules/:moduleKey"'));
  assert.ok(read("server.js").includes('"tenant_modules"'), "blocklisted");
  assert.ok(read("server.js").includes("ensureTenantModulesSchema"), "created at boot");
  assert.ok(read("../frontend/src/api.js").includes('MODULE_NOT_LICENSED'), "frontend does not log out on it");
  assert.ok(!/\$\{/.test(read("utils/tenantModules.js").split("saveModule")[1]), "saveModule uses parameters, no interpolation");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "lms.module.manifest.json"), "utf8"));
  assert.deepStrictEqual(manifest.featureFlags.base, M.MODULES.lms.tiers.base, "manifest matches registry");
});
