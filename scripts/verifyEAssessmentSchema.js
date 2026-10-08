/* Verify a live tenant database has the e-assessment columns the AI marking
   feature relies on. Read-only. Usage: node scripts/verifyEAssessmentSchema.js [tenantKey]
   Exit code 0 = no errors, 1 = errors (or could not connect). */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { getPool, listTenantKeys } = require("../config/db");
const { compareSchema, loadActualColumns } = require("../utils/eAssessmentSchemaCheck");

(async () => {
  const keys = process.argv[2] ? [process.argv[2]] : listTenantKeys();
  let failed = false;
  for (const key of keys) {
    try {
      const pool = await getPool(key);
      const r = compareSchema(await loadActualColumns(pool));
      console.log(`\n[${key}] ${r.ok ? "OK" : "PROBLEMS FOUND"}  (marks_awarded type: ${r.marksAwardedType || "unknown"})`);
      r.errors.forEach((e) => console.log("  ERROR:", e));
      r.warnings.forEach((w) => console.log("  warn: ", w));
      if (!r.ok) failed = true;
    } catch (err) {
      failed = true;
      console.log(`\n[${key}] could not check: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
