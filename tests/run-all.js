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

(async () => {
  const ok = await summarize();
  process.exit(ok ? 0 : 1);
})();
