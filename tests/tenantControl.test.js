/* Master admin account + trial period (tenant control). */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
suite("tenantControl.test.js");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const lic = require("../utils/tenantLicense");
const master = require("../utils/masterAdmin");

const DAY = 24 * 60 * 60 * 1000;

test("trial status: none, running, and expired", () => {
  assert.strictEqual(lic.computeTrialStatus(null).hasTrial, false);
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const running = lic.computeTrialStatus({ trial_starts_at: new Date(now - DAY), trial_ends_at: new Date(now + 3 * DAY + 1000) }, now);
  assert.ok(running.active && !running.expired);
  assert.strictEqual(running.daysLeft, 4); // part days round up
  assert.strictEqual(running.msLeft, 3 * DAY + 1000);
  const over = lic.computeTrialStatus({ trial_starts_at: new Date(now - 9 * DAY), trial_ends_at: new Date(now - 1000) }, now);
  assert.ok(over.expired && !over.active);
  assert.strictEqual(over.msLeft, 0);
});

test("trial days must be a whole number from 1 to 365", () => {
  assert.strictEqual(lic.parseDays(14), 14);
  assert.strictEqual(lic.parseDays("30"), 30);
  for (const bad of [0, -3, 1.5, 366, "abc", null, undefined, NaN]) assert.strictEqual(lic.parseDays(bad), null, String(bad));
});

test("start runs from now; extend adds to the current end, or to now once expired", () => {
  const now = Date.UTC(2026, 9, 17);
  const start = lic.planTrial({ mode: "start", days: 10, current: { trial_ends_at: new Date(now + 99 * DAY) }, now });
  assert.strictEqual(start.endsAt.getTime(), now + 10 * DAY);
  const ext = lic.planTrial({ mode: "extend", days: 5, current: { trial_starts_at: new Date(now - DAY), trial_ends_at: new Date(now + 2 * DAY) }, now });
  assert.strictEqual(ext.endsAt.getTime(), now + 7 * DAY);
  assert.strictEqual(ext.startsAt.getTime(), now - DAY, "extending keeps the original start");
  const afterExpiry = lic.planTrial({ mode: "extend", days: 5, current: { trial_ends_at: new Date(now - 3 * DAY) }, now });
  assert.strictEqual(afterExpiry.endsAt.getTime(), now + 5 * DAY);
  assert.strictEqual(lic.planTrial({ mode: "extend", days: 5, current: null, now }).endsAt.getTime(), now + 5 * DAY);
});

test("master username is per tenant; password comes only from the environment", () => {
  const env = { MASTER_ADMIN_USERNAME: "dora-master", MASTER_ADMIN_PASSWORD: "shared-secret", MASTER_ADMIN_PASSWORD_EREGI: "eregi-secret" };
  assert.strictEqual(master.masterConfig("default", env).username, "dora-master_default");
  assert.strictEqual(master.masterConfig("eregi", env).username, "dora-master_eregi");
  assert.strictEqual(master.masterConfig("default", env).password, "shared-secret");
  assert.strictEqual(master.masterConfig("eregi", env).password, "eregi-secret", "per-tenant override wins");
  assert.strictEqual(master.masterConfig("other", env).password, "shared-secret", "others fall back to the shared one");
  assert.strictEqual(master.masterConfig("default", {}).password, "", "no password configured = nothing seeded");
  assert.strictEqual(master.masterConfig("default", {}).username, "doravo-master_default");
});

test("bypass token is stable for a password and never the same across tenants/passwords", () => {
  const a = master.bypassToken("pw", "default");
  assert.strictEqual(a.length, 16);
  assert.ok(a.equals(master.bypassToken("pw", "default")));
  assert.ok(!a.equals(master.bypassToken("pw", "eregi")));
  assert.ok(!a.equals(master.bypassToken("pw2", "default")));
  assert.ok(!master.bypassToken("", "default").equals(master.bypassToken("", "default")), "no password => random, unguessable");
});

test("the trigger blocks insert/update/delete of master rows unless the token is present", () => {
  const token = master.bypassToken("pw", "default");
  const sqlText = master.triggerSql(token).replace(/\s+/g, " ");
  assert.ok(sqlText.includes("CREATE OR ALTER TRIGGER TR_Users_master_protect ON Users"));
  assert.ok(sqlText.includes("AFTER INSERT, UPDATE, DELETE"));
  assert.ok(sqlText.includes("0x" + token.toString("hex")), "token baked in so only the seeder passes");
  assert.ok(sqlText.includes("FROM deleted WHERE ISNULL(isMaster, 0) = 1") && sqlText.includes("FROM inserted WHERE ISNULL(isMaster, 0) = 1"),
    "covers changing a master row AND forging/promoting one");
  assert.ok(sqlText.includes("THROW 51001"));
  assert.ok(!sqlText.includes("pw"), "password itself never appears in SQL");
});

test("ensureMasterAdmin: installs the trigger, creates the account, clears the bypass even on failure, never throws", async () => {
  const queries = [];
  const mk = (rowsFor) => ({
    request() {
      const r = { input() { return r; }, async query(q) { queries.push(q.replace(/\s+/g, " ")); return { recordset: rowsFor(q) }; } };
      return r;
    },
  });
  const sqlLib = { NVarChar: 1, VarBinary: () => 2 };
  const env = { MASTER_ADMIN_PASSWORD: "pw-for-test" };
  {
    await master.ensureMasterAdmin(mk((q) => (q.includes("sysobjects") ? [{ ok: 1 }] : [])), sqlLib, "default", env);
    const all = queries.join("\n");
    assert.ok(all.includes("ADD isMaster BIT"));
    assert.ok(all.includes("CREATE OR ALTER TRIGGER TR_Users_master_protect"));
    assert.ok(all.includes("INSERT INTO Users (username, role, email, password, mustChangePassword, isMaster)"));
    assert.ok(all.includes("BEGIN CATCH SET CONTEXT_INFO 0x0; THROW; END CATCH"), "bypass cleared on error");
    assert.ok(all.indexOf("CREATE OR ALTER TRIGGER") < all.indexOf("INSERT INTO Users"), "trigger first, then seed");

    // a username already used by an ordinary account is never overwritten
    queries.length = 0;
    await master.ensureMasterAdmin(mk((q) => (q.includes("sysobjects") ? [{ ok: 1 }] : q.includes("WHERE username") ? [{ id: 9 }] : [])), sqlLib, "default", env);
    assert.ok(!queries.join("\n").includes("INSERT INTO Users"));

    // a failing database never crashes boot
    await master.ensureMasterAdmin({ request() { throw new Error("db down"); } }, sqlLib, "default", env);
  }
});

test("without a password nothing is seeded, but the trigger is still installed", async () => {
  const queries = [];
  const pool = { request() { const r = { input() { return r; }, async query(q) { queries.push(q.replace(/\s+/g, " ")); return { recordset: q.includes("sysobjects") ? [{ ok: 1 }] : [] }; } }; return r; } };
  await master.ensureMasterAdmin(pool, { NVarChar: 1, VarBinary: () => 2 }, "default", {});
  const all = queries.join("\n");
  assert.ok(all.includes("CREATE OR ALTER TRIGGER") && !all.includes("INSERT INTO Users"));
});

test("wiring: finance-only trial routes, tenant read route, raw editor can't touch the license, listings hide the master", () => {
  const routes = read("routes/finance.js");
  assert.ok(routes.includes("router.use(protect, financeOnly)"));
  for (const verb of ['router.get("/institutions/:tenantKey/trial"', 'router.post("/institutions/:tenantKey/trial"', 'router.delete("/institutions/:tenantKey/trial"']) {
    assert.ok(routes.includes(verb), verb);
  }
  const tenantRoute = read("routes/tenantLicense.js");
  assert.ok(!/router\.(post|put|patch|delete)/.test(tenantRoute), "tenant side is read-only");
  const server = read("server.js");
  assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\(\[[^\]]*"tenant_license"/.test(server), "license table hidden from the Data Manager");
  assert.ok(server.includes('app.use("/api/tenant"'));
  assert.ok(server.includes("ensureMasterAdmin(pool, sql, tenantKey)"));
  const usersList = server.slice(server.indexOf('app.get("/api/users"'), server.indexOf("START SERVER"));
  assert.ok(usersList.includes("ISNULL(isMaster, 0) = 0"), "user management list excludes the master");
  assert.ok(server.includes('table === "Users" && columns.includes("isMaster")'), "Data Manager Users view excludes the master");
});

test("trial expiry gate: caches per tenant, can be invalidated, and fails open on a bad read", async () => {
  let reads = 0;
  const poolFor = (endsAt) => ({ request() { return { async query() { reads++; return { recordset: endsAt ? [{ trial_starts_at: new Date(0), trial_ends_at: endsAt }] : [] }; } }; } });
  const past = new Date(Date.now() - 1000), future = new Date(Date.now() + 86400000);
  assert.strictEqual(await lic.isTrialExpired(poolFor(past), "t-exp"), true);
  assert.strictEqual(await lic.isTrialExpired(poolFor(past), "t-exp"), true);
  assert.strictEqual(reads, 1, "second check served from cache");
  assert.strictEqual(await lic.isTrialExpired(poolFor(future), "t-run"), false);
  assert.strictEqual(await lic.isTrialExpired(poolFor(null), "t-none"), false, "no trial = never expired");
  lic.invalidateTrialCache("t-exp");
  assert.strictEqual(await lic.isTrialExpired(poolFor(future), "t-exp"), false, "finance extending the trial takes effect at once");
});

test("trial expiry gate wiring: staff writes blocked after expiry; finance, master, auth, exams and reads are not", () => {
  const mw = read("middleware/authMiddleware.js");
  assert.ok(mw.includes("return trialGate(req, res, next)"), "runs inside protect");
  assert.ok(mw.includes('code: "TRIAL_EXPIRED"'));
  for (const exempt of ['role === "finance"', 'role === "student"', "req.user.isMaster", "req.user.examOnly", '"GET", "HEAD", "OPTIONS"', '"/api/auth"', '"/api/finance"', '"/api/tenant"']) {
    assert.ok(mw.includes(exempt), `exempts ${exempt}`);
  }
  assert.ok(mw.includes("TRIAL GATE ERROR (allowing request)"), "fails open");
  const ctl = read("controllers/financeTrial.controller.js");
  assert.strictEqual((ctl.match(/invalidateTrialCache\(tenantKey\)/g) || []).length, 2, "set and end both clear the cache");
});
