/* Parse/bind-check every AI marking worker query on a real tenant database. Changes nothing
   (see utils/aiMarkingWorkerSmoke.js). Usage: node scripts/verifyAiMarkingWorkerSql.js [tenantKey]
   Exit code 0 = every statement ran, 1 = at least one failed (or could not connect). */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { getPool, listTenantKeys } = require("../config/db");
const { createSqlWorkerStore } = require("../services/aiMarkingWorker.store");
const { runStoreSmoke, runReviewStoreSmoke, runSchemeStoreSmoke, runCalibrationStoreSmoke, runAnalyticsStoreSmoke } = require("../utils/aiMarkingWorkerSmoke");
const { createSqlReviewStore } = require("../services/aiMarkingReview.store");
const { createSqlSchemeStore } = require("../services/aiMarkingScheme.store");
const { createSqlCalibrationStore } = require("../services/aiMarkingCalibration.store");
const { createSqlOperationalStore, createSqlEconomicsStore } = require("../services/aiMarkingAnalytics.store");

(async () => {
  const keys = process.argv[2] ? [process.argv[2]] : listTenantKeys();
  let failed = false;
  for (const key of keys) {
    try {
      const pool = await getPool(key);
      for (const [name, run, store] of [["worker (Phase 6)", runStoreSmoke, createSqlWorkerStore(pool)], ["review (Phase 7)", runReviewStoreSmoke, createSqlReviewStore(pool)], ["schemes (Phase 8)", runSchemeStoreSmoke, createSqlSchemeStore(pool)], ["calibration (Phase 9)", runCalibrationStoreSmoke, createSqlCalibrationStore(pool)], ["analytics (Phase 10)", runAnalyticsStoreSmoke, { operational: createSqlOperationalStore(pool), economics: createSqlEconomicsStore(pool) }]]) {
        const { ok, results } = await run(store);
        console.log(`\n[${key}] ${name}: ${ok ? "ALL STATEMENTS RAN" : "PROBLEMS FOUND"}`);
        for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label}${r.ok ? "" : ` — ${r.error}`}`);
        if (!ok) failed = true;
      }
    } catch (err) {
      failed = true;
      console.log(`\n[${key}] could not check: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
