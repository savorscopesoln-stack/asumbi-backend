/* Regenerates migrations/2026-10-04_ai_marking_phase2_fixes.sql from
   utils/aiMarkingSchema.js — the code that actually runs on boot is the
   single source of truth; this file is only the human-readable/manual copy
   (same role as every other dated file in migrations/).
   Run: node scripts/generateAiMarkingMigration.js
   tests/aiMarkingSchemaFile.test.js fails if the checked-in file drifts. */
const fs = require("fs");
const path = require("path");
const { buildMigrationText } = require("../utils/aiMarkingSchema");

const target = path.join(__dirname, "../migrations/2026-10-04_ai_marking_phase2_fixes.sql");
fs.writeFileSync(target, buildMigrationText(), "utf8");
console.log("wrote", target);
