/* =========================================================================
   LMS OFFLINE RECEIPTS RETENTION  (D-119, A165)  flag `lms_offline`, permission `lms.settings.manage`, NO schema step.
   `lms_offline_actions` keeps one receipt per replayed offline action (ids, type, outcome; never text or answers). This admin action deletes OLD receipts.
   - Setting `offline.retentionDays` (default 90, allowed 31-3650). Never below 31: a receipt must outlive the 30-day STALE_ACTION window, otherwise a replay of an old
     action could be accepted again. A bad stored value falls back to 90.
   - Cutoff = now - retentionDays, compared with `received_at` (finished AND unfinished receipts, e.g. old conflicts). Nothing else is touched: no drafts, answers, progress or grades.
   - Deletes in batches of 2000 (at most 10 batches per call = 20 000 rows) so one call never runs long; `more: true` says to call again. `dryRun: true` only counts.
   - Admin only, tenant-wide (the table lives in the tenant's own database). Audit `offline.retention_purged` with counts only. This is a manual action on purpose: LMS jobs must be
     licence-gated per tenant (rule 2); a scheduler can call `purge` later.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");

const DEFAULT_DAYS = 90, MIN_DAYS = 31, MAX_DAYS = 3650, BATCH = 2000, MAX_BATCHES = 10;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/* Pure. The stored setting, or the default when it is missing, not a whole number, or out of range. */
const normDays = (s) => { const n = s && s.offline ? s.offline.retentionDays : undefined; return Number.isInteger(n) && n >= MIN_DAYS && n <= MAX_DAYS ? n : DEFAULT_DAYS; };
/* Pure. { ok, dryRun } or { ok:false, errors }. */
function validateBody(body) {
  if (body === undefined || body === null) return { ok: true, dryRun: false };
  if (!isObj(body) || Object.keys(body).some((k) => k !== "dryRun") || ("dryRun" in body && typeof body.dryRun !== "boolean")) return { ok: false, errors: ["Send {dryRun: true|false} or nothing."] };
  return { ok: true, dryRun: body.dryRun === true };
}

async function purge(pool, user, body, ctx = {}) {
  const v = validateBody(body); if (!v.ok) return { ok: false, errors: v.errors };
  const now = ctx.now || new Date(); const settings = typeof ctx.settings === "function" ? await ctx.settings() : ctx.settings;
  const days = normDays(settings), cutoff = new Date(now.getTime() - days * 86400000);
  if (v.dryRun) {
    const r = await pool.request().input("cut", sql.DateTime2, cutoff).query(`SELECT COUNT(*) AS n FROM lms_offline_actions WHERE received_at < @cut`);
    return { ok: true, dryRun: true, retentionDays: days, cutoff: cutoff.toISOString(), wouldDelete: Number(r.recordset && r.recordset[0] ? r.recordset[0].n : 0) };
  }
  let deleted = 0, more = false;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await pool.request().input("cut", sql.DateTime2, cutoff).input("n", sql.Int, BATCH)
      .query(`DELETE TOP (@n) FROM lms_offline_actions WHERE received_at < @cut; SELECT @@ROWCOUNT AS n;`);
    const n = Number(r.recordset && r.recordset[0] ? r.recordset[0].n : 0); deleted += n;
    if (n < BATCH) break; if (i === MAX_BATCHES - 1) more = true;
  }
  await audit(pool, actorOf(user), "offline.retention_purged", "lms_offline_actions", null, { retentionDays: days, deleted, more });
  return { ok: true, dryRun: false, retentionDays: days, cutoff: cutoff.toISOString(), deleted, more };
}

module.exports = { DEFAULT_DAYS, MIN_DAYS, MAX_DAYS, BATCH, MAX_BATCHES, normDays, validateBody, purge };
