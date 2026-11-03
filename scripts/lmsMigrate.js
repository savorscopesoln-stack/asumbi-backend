/* LMS schema runner CLI.  node scripts/lmsMigrate.js --dry-run [tenantKey]
   --dry-run lists pending steps and changes nothing. Without it, applies pending steps. */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { getPool, listTenantKeys } = require("../config/db");
const { planLmsSchema, ensureLmsSchema } = require("../utils/lmsSchema");

(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const only = args.find((a) => !a.startsWith("--"));
  let failed = false;
  for (const key of only ? [only] : listTenantKeys()) {
    try {
      const pool = await getPool(key);
      if (dry) { const p = await planLmsSchema(pool); console.log(`[${key}] pending: ${p.pending.join(", ") || "none"} | applied: ${p.applied.length}${p.changed.length ? " | EDITED: " + p.changed.join(", ") : ""}`); }
      else { const r = await ensureLmsSchema(pool, key); console.log(`[${key}] ran: ${r.ran.join(", ") || "none"}${r.failed ? " | FAILED: " + r.failed : ""}`); if (r.failed) failed = true; }
    } catch (e) { failed = true; console.log(`[${key}] could not connect: ${e.message}`); }
  }
  process.exit(failed ? 1 : 0);
})();
