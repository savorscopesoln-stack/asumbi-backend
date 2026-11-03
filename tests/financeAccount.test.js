/* The Finance account lives in the environment (utils/financeAccount.js), not in any database. */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { suite, test, assert } = require("./helpers/tinytest");
suite("financeAccount.test.js");

const FA = require("../utils/financeAccount");
const { generateSecret, totp } = require("../utils/totp");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("not configured: nobody can sign in, and a warning says so", async () => {
  const env = {};
  assert.strictEqual(FA.isConfigured(env), false);
  assert.strictEqual(await FA.checkPassword("doravo-finance", "anything", env), false);
  assert.ok(FA.financeWarnings(env).some((w) => /nobody can sign in/.test(w)));
});

test("bcrypt hash: right user + right password only (username case-insensitive)", async () => {
  const env = { FINANCE_USERNAME: "Fin", FINANCE_PASSWORD_HASH: await bcrypt.hash("correct-horse-battery", 4) };
  assert.ok(FA.isConfigured(env));
  assert.ok(await FA.checkPassword("fin", "correct-horse-battery", env));
  assert.ok(!(await FA.checkPassword("fin", "wrong", env)));
  assert.ok(!(await FA.checkPassword("other", "correct-horse-battery", env)));
  assert.ok(FA.isFinanceUsername(" FIN ", env) && !FA.isFinanceUsername("admin", env));
});

test("plain FINANCE_PASSWORD works when no hash; a malformed hash disables login", async () => {
  assert.ok(await FA.checkPassword("doravo-finance", "pw12345678", { FINANCE_PASSWORD: "pw12345678" }));
  assert.ok(!(await FA.checkPassword("doravo-finance", "x", { FINANCE_PASSWORD: "pw12345678" })));
  const bad = { FINANCE_PASSWORD_HASH: "not-a-hash" };
  assert.strictEqual(FA.isConfigured(bad), false);
  assert.ok(FA.financeWarnings(bad).some((w) => /not a valid bcrypt hash/.test(w)));
});

test("MFA: required only when FINANCE_MFA_SECRET is set; codes verified against it", () => {
  const secret = generateSecret();
  const env = { FINANCE_PASSWORD: "pw12345678", FINANCE_MFA_SECRET: secret };
  assert.ok(FA.mfaRequired(env) && !FA.mfaRequired({ FINANCE_PASSWORD: "x" }));
  assert.ok(FA.checkMfaCode(totp(secret), env));
  assert.ok(!FA.checkMfaCode("000000", env) || totp(secret) === "000000");
  assert.ok(!FA.checkMfaCode("123456", { FINANCE_PASSWORD: "x" }));
});

test("home tenant + user shape: no Users row (id null), role finance, source Env", () => {
  assert.strictEqual(FA.homeTenant(["default", "eregi"], {}), "default");
  assert.strictEqual(FA.homeTenant(["eregi", "x"], {}), "eregi");
  assert.strictEqual(FA.homeTenant(["default", "eregi"], { FINANCE_HOME_TENANT: "eregi" }), "eregi");
  const u = FA.financeUser("default", {});
  assert.deepStrictEqual([u.id, u.role, u.source], [null, "finance", "Env"]);
});

test("wiring: login answers the finance username from env first; DB finance rows rejected; no enroll routes", () => {
  const auth = read("routes/auth.js");
  assert.ok(auth.indexOf("FA.isFinanceUsername(username)") < auth.indexOf("for (const tenantKey of listTenantKeys())"), "env check runs before any tenant lookup");
  assert.ok(/dbRole === "finance"\) \{\s*return res\.status\(401\)/.test(auth), "a Users row with role finance cannot sign in");
  assert.ok(!/mfaPending[\s\S]{0,40}Users WHERE id/.test(auth) && !/FROM Users WHERE id = @id`\);\s*const user = userRes.recordset\[0\];\s*if \(!user \|\| user\.role/.test(auth));
  const fin = read("routes/finance.js");
  assert.ok(!/mfa\/enroll|mfa\/confirm/.test(fin));
  assert.ok(/source === "Env"/.test(auth), "password change refused for the env account");
});
