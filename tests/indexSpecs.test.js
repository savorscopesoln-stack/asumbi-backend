/* Guards utils/indexSpecs.js:
   1. the checked-in migration equals what the code generates (no drift);
   2. every spec is well-formed and unique;
   3. every index is guarded (table/column/duplicate/TRY-CATCH) and ensureIndexes never throws. */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { INDEX_SPECS, buildIndexBlock, buildMigrationText, ensureIndexes } = require("../utils/indexSpecs");

suite("indexSpecs.test.js");

test("migration .sql matches generated text exactly (run scripts/generateIndexMigration.js if this fails)", async () => {
  const file = fs.readFileSync(path.join(__dirname, "../migrations/2026-10-19_add_missing_indexes.sql"), "utf8");
  assert.strictEqual(file.replace(/\r\n/g, "\n"), buildMigrationText());
});

test("every spec is well-formed, and index names are unique per table", async () => {
  const seen = new Set();
  for (const [table, name, keys, include] of INDEX_SPECS) {
    assert.ok(/^\w+$/.test(table) && /^IX_\w+$/.test(name), `${table}/${name}`);
    assert.ok(Array.isArray(keys) && keys.length > 0 && Array.isArray(include));
    for (const k of keys) assert.ok(/^\w+(\s+(ASC|DESC))?$/.test(k), `bad key ${k} in ${name}`);
    const id = `${table}.${name}`.toLowerCase();
    assert.ok(!seen.has(id), `duplicate ${id}`);
    seen.add(id);
  }
});

test("no two specs on a table have identical key lists", async () => {
  const seen = new Set();
  for (const [table, name, keys] of INDEX_SPECS) {
    const id = table.toLowerCase() + "|" + keys.map((k) => k.toLowerCase()).join(",");
    assert.ok(!seen.has(id), `duplicate key list on ${table} (${name})`);
    seen.add(id);
  }
});

test("each block checks table + columns + name + leading-key duplicate, and is TRY/CATCH wrapped", async () => {
  for (const spec of INDEX_SPECS) {
    const b = buildIndexBlock(spec);
    assert.ok(b.includes(`OBJECT_ID(N'${spec[0]}', N'U') IS NOT NULL`));
    assert.ok(b.includes("COL_LENGTH"));
    assert.ok(b.includes(`name = N'${spec[1]}'`));
    assert.ok(b.includes("key_ordinal = 1"));
    assert.ok(b.includes("BEGIN TRY") && b.includes("BEGIN CATCH"));
    assert.ok(!/\bDROP\b|\bALTER\b|\bDELETE\b|\bUPDATE\b/i.test(b), "must be non-destructive");
  }
});

test("ensureIndexes runs every block and never throws, even if queries fail", async () => {
  let calls = 0;
  const pool = { request: () => ({ on() {}, query: async () => { calls++; if (calls % 2) throw new Error("boom"); return {}; } }) };
  const r = await ensureIndexes(pool);
  assert.strictEqual(calls, INDEX_SPECS.length);
  assert.ok(r.skipped.length > 0);
});
