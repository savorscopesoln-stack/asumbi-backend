/* Regenerates migrations/2026-10-19_add_missing_indexes.sql from
   utils/indexSpecs.js — the code that actually runs on boot is the single
   source of truth; the .sql is the human-readable/manual copy.
   Run: node scripts/generateIndexMigration.js
   tests/indexSpecs.test.js fails if the checked-in file drifts. */
const fs = require("fs");
const path = require("path");
const { buildMigrationText } = require("../utils/indexSpecs");

const target = path.join(__dirname, "../migrations/2026-10-19_add_missing_indexes.sql");
fs.writeFileSync(target, buildMigrationText(), "utf8");
console.log("wrote", target);
