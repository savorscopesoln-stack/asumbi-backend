/* L1.2 — LMS schema runner (utils/lmsSchema.js). Mocked pool: SQL syntax is NOT verified here. */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
suite("lmsSchema.test.js");
const L = require("../utils/lmsSchema");

/* In-memory pool that understands only the tracking table; records every statement. */
function fakePool({ applied = [], failOn = null } = {}) {
  const rows = new Map(applied.map((a) => [a.id, a.checksum]));
  const log = [];
  return { log, rows, request() {
    const inputs = {};
    const r = { input(n, _t, v) { inputs[n] = v; return r; },
      async query(text) {
        const t = text.replace(/\s+/g, " ").trim(); log.push(t);
        if (failOn && t.includes(failOn)) throw new Error("boom");
        if (t.startsWith("SELECT id, checksum FROM lms_schema_migrations")) return { recordset: [...rows].map(([id, checksum]) => ({ id, checksum })) };
        if (t.startsWith("INSERT INTO lms_schema_migrations")) rows.set(inputs.id, inputs.cs);
        return { recordset: [] };
      } };
    return r;
  } };
}

test("fresh tenant: tracking table created, step 001 runs and is recorded", async () => {
  const p = fakePool(); const rep = await L.ensureLmsSchema(p, "t1");
  assert.deepStrictEqual(rep.ran, L.STEPS.map((s) => s.id)); assert.strictEqual(rep.failed, null);
  assert.ok(p.rows.has("001_lms_audit_and_settings"));
  assert.ok(p.log[0].includes("CREATE TABLE lms_schema_migrations"));
});

test("idempotent: second run executes nothing", async () => {
  const p = fakePool(); await L.ensureLmsSchema(p, "t1");
  const before = p.log.length; const rep = await L.ensureLmsSchema(p, "t1");
  assert.deepStrictEqual(rep.ran, []); assert.deepStrictEqual(rep.skipped, L.STEPS.map((s) => s.id));
  assert.ok(!p.log.slice(before).some((s) => /CREATE TABLE lms_(audit|settings)/.test(s)));
});

test("dry run reports pending and changes nothing", async () => {
  const p = fakePool(); const plan = await L.planLmsSchema(p);
  assert.deepStrictEqual(plan.pending, L.STEPS.map((s) => s.id));
  assert.ok(!p.log.some((s) => /^(CREATE|INSERT|IF NOT EXISTS)/.test(s)), "no writes");
  assert.strictEqual(p.rows.size, 0);
});

test("steps run in order and only pending ones run", async () => {
  const steps = [{ id: "001_a", sql: ["SELECT 1 /*a*/"] }, { id: "002_b", sql: ["SELECT 2 /*b*/"] }];
  const p = fakePool({ applied: [{ id: "001_a", checksum: L.checksum(steps[0]) }] });
  const rep = await L.ensureLmsSchema(p, "t", steps);
  assert.deepStrictEqual(rep.ran, ["002_b"]);
  assert.ok(!p.log.includes("SELECT 1 /*a*/"));
});

test("an edited released step is flagged, not re-run", async () => {
  const steps = [{ id: "001_a", sql: ["SELECT 1"] }];
  const p = fakePool({ applied: [{ id: "001_a", checksum: "deadbeefdeadbeef" }] });
  const rep = await L.ensureLmsSchema(p, "t", steps);
  assert.deepStrictEqual(rep.changed, ["001_a"]); assert.deepStrictEqual(rep.ran, []);
  assert.deepStrictEqual((await L.planLmsSchema(p, steps)).changed, ["001_a"]);
});

test("failure never throws, is recorded per step, and does not block later steps", async () => {
  const steps = [{ id: "001_a", sql: ["SELECT 1"] }, { id: "002_b", sql: ["BAD SQL"] }, { id: "003_c", sql: ["SELECT 3"] }];
  const p = fakePool({ failOn: "BAD SQL" });
  const rep = await L.ensureLmsSchema(p, "t", steps);
  assert.strictEqual(rep.failed, "boom"); assert.deepStrictEqual(rep.ran, ["001_a", "003_c"]);
  assert.deepStrictEqual(rep.failedSteps.map((f) => f.id), ["002_b"]);
  assert.ok(!p.rows.has("002_b") && p.rows.has("003_c"));
});

test("safety: steps are additive only (no DROP / ALTER / DELETE / TRUNCATE, except a guarded ADD of one NULLable column on an lms_ table), every CREATE is guarded, ids are unique and ordered", () => {
  const ids = L.STEPS.map((s) => s.id);
  assert.deepStrictEqual(ids, [...ids].sort()); assert.strictEqual(new Set(ids).size, ids.length);
  for (const stmt of L.STEPS.flatMap((s) => s.sql)) {
    // The ONLY allowed ALTER: add one NULLable column to an LMS table, guarded by COL_LENGTH (additive, re-runnable, never touches data or legacy tables).
    const addNullableColumn = /^IF COL_LENGTH\('(lms_\w+)', '(\w+)'\) IS NULL\s+ALTER TABLE \1 ADD \2 [A-Z0-9]+(\(\d+(,\d+)?\))? NULL$/i.test(stmt.replace(/\s+/g, " ").trim());
    assert.ok(addNullableColumn || !/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(stmt), stmt.slice(0, 60));
    if (/CREATE\s+(TABLE|INDEX)/i.test(stmt)) assert.ok(/IF NOT EXISTS/i.test(stmt), "guard: " + stmt.slice(0, 60));
    assert.ok(!/\bFOREIGN KEY|REFERENCES\b/i.test(stmt), "D-005: no FKs into legacy tables");
  }
});

test("wiring: runs at boot for each tenant after the module table; CLI exists with --dry-run", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(server.indexOf("ensureTenantModulesSchema") < server.indexOf("ensureLmsSchema"));
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "scripts", "lmsMigrate.js"), "utf8").includes("--dry-run"));
});
