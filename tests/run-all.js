/* Phase 15 regression suite. Run with: node tests/run-all.js
   (or `npm test` from backend/, see package.json).

   No live SQL Server is reachable in this environment, so every test
   here runs the real controller/utility code against a mocked
   mssql-pool (tests/helpers/mockPool.js) rather than a live database.
   That verifies logic, query shape, and response behavior faithfully,
   but it is NOT a substitute for running this once against a real
   staging database — see the manual checklist in tests/README.md for
   what still needs that. */
const { summarize } = require("./helpers/tinytest");

require("./mainExamCrud.test.js");
require("./scheduling.test.js");
require("./scheduler.test.js");
require("./studentDashboard.test.js");
require("./reportExport.test.js");
require("./regression.test.js");
require("./walletLedger.test.js");
require("./walletController.test.js");
require("./financeInvoicing.test.js");
require("./aiMarkingLedger.test.js");
require("./aiMarkingFinance.test.js");
require("./aiMarkingSchemaFile.test.js");
require("./aiMarkingTeacher.test.js");
require("./aiMarkingJobs.test.js");
require("./aiMarkingEngine.test.js");
require("./aiMarkingWorker.test.js");
require("./aiMarkingReview.test.js");
require("./aiReviewHelpers.test.js");
require("./aiMarkingScheme.test.js");
require("./aiMarkingCalibration.test.js");
require("./aiMarkingAnalytics.test.js");
require("./aiMarkingSecurity.test.js");

// If any test promise never settles, Node's event loop simply empties and the
// process exits with code 0 and NO summary — a silent false pass. Detect it.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("\nFAIL: the run ended before every test settled (a test promise never resolved).");
    process.exitCode = 1;
  }
});

(async () => {
  const ok = await summarize();
  finished = true;
  process.exit(ok ? 0 : 1);
})();
