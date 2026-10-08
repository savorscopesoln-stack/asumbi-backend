/* Guards the two "tooling" pieces added with the Phase 2 fixes:
   1. The checked-in reference migration must equal what utils/aiMarkingSchema.js
      generates (so the .sql file can never silently drift from the code that runs).
   2. utils/eAssessmentSchemaCheck.js's comparison logic. */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { buildMigrationText } = require("../utils/aiMarkingSchema");
const { compareSchema, EXPECTED } = require("../utils/eAssessmentSchemaCheck");

suite("aiMarkingSchemaFile.test.js");

test("reference migration .sql matches the generated text exactly (run scripts/generateAiMarkingMigration.js if this fails)", async () => {
  const file = fs.readFileSync(path.join(__dirname, "../migrations/2026-10-04_ai_marking_phase2_fixes.sql"), "utf8");
  assert.strictEqual(file.replace(/\r\n/g, "\n"), buildMigrationText());
});

function rowsFor(overrides = {}) {
  const rows = [];
  for (const [table, cols] of Object.entries(EXPECTED)) {
    for (const [col, spec] of Object.entries(cols)) {
      rows.push({ TABLE_NAME: table, COLUMN_NAME: col, DATA_TYPE: spec.types[0], IS_NULLABLE: "YES" });
    }
  }
  return rows.map((r) => ({ ...r, ...(overrides[`${r.TABLE_NAME}.${r.COLUMN_NAME}`] || {}) })).filter((r) => !(overrides[`${r.TABLE_NAME}.${r.COLUMN_NAME}`] || {}).__drop);
}

test("schema check: a database matching expectations passes with no errors", async () => {
  const r = compareSchema(rowsFor());
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.marksAwardedType, "int");
});

test("schema check: missing table and missing critical column are errors; missing optional column is only a warning", async () => {
  const noTable = compareSchema(rowsFor().filter((r) => r.TABLE_NAME !== "e_assessment_answers"));
  assert.strictEqual(noTable.ok, false);
  assert.ok(noTable.errors.some((e) => e.includes("e_assessment_answers does not exist")));

  const noCritical = compareSchema(rowsFor({ "e_assessment_questions.marking_guide": { __drop: true } }));
  assert.ok(noCritical.errors.some((e) => e.includes("marking_guide is missing")));

  const noOptional = compareSchema(rowsFor({ "e_assessment_answers.highlights": { __drop: true } }));
  assert.strictEqual(noOptional.ok, true);
  assert.ok(noOptional.warnings.some((w) => w.includes("highlights is missing")));
});

test("schema check: a wrong type on a critical column is an error; a decimal marks_awarded flags Decision D1 for review", async () => {
  const wrong = compareSchema(rowsFor({ "e_assessment_answers.submission_id": { DATA_TYPE: "uniqueidentifier" } }));
  assert.ok(wrong.errors.some((e) => e.includes("submission_id is uniqueidentifier")));

  const decimal = compareSchema(rowsFor({ "e_assessment_answers.marks_awarded": { DATA_TYPE: "decimal" } }));
  assert.strictEqual(decimal.ok, true);
  assert.ok(decimal.warnings.some((w) => w.includes("Decision D1")));
});

test("schema check is case-insensitive about table/column/type names", async () => {
  const rows = rowsFor().map((r) => ({ ...r, TABLE_NAME: r.TABLE_NAME.toUpperCase(), COLUMN_NAME: r.COLUMN_NAME.toUpperCase(), DATA_TYPE: r.DATA_TYPE.toUpperCase() }));
  assert.strictEqual(compareSchema(rows).ok, true);
});
