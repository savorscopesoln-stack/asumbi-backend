/* =========================================================================
   TENANT LICENSE / TRIAL PERIOD

   Doravo Finance can put an institution on a trial period. The tenant side
   shows a live countdown to the end of it (GET /api/tenant/license).

   Storage: one row (id = 1) per tenant database in tenant_license. It is
   written ONLY by the finance endpoints (routes/finance.js, financeOnly —
   no admin bypass). The table is kept out of the admin "Data Manager" raw
   record editor (see RECORD_TABLE_BLOCKLIST in server.js), so a school's own
   administrators cannot shorten, extend or clear their trial.

   This feature DISPLAYS the trial. It deliberately does not lock anyone out
   when the trial ends — what an expired trial should do is a business
   decision to make separately.
========================================================================= */

const MAX_TRIAL_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureTenantLicenseSchema(pool) {
  try {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tenant_license' AND xtype='U')
      CREATE TABLE tenant_license (
        id INT NOT NULL PRIMARY KEY CONSTRAINT CK_tenant_license_singleton CHECK (id = 1),
        trial_starts_at DATETIME2 NULL,
        trial_ends_at DATETIME2 NULL,
        note NVARCHAR(300) NULL,
        set_by INT NULL,
        updatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      )
    `);
  } catch (err) {
    console.error("⚠️  tenant_license schema failed:", err.message);
  }
}

/* Pure: turns a stored row into what the UI needs. `now` is injectable for tests. */
function computeTrialStatus(row, now = Date.now()) {
  if (!row || !row.trial_ends_at) {
    return { hasTrial: false, active: false, expired: false, startsAt: null, endsAt: null, msLeft: 0, daysLeft: 0, note: null };
  }
  const endsAtMs = new Date(row.trial_ends_at).getTime();
  const msLeft = Math.max(0, endsAtMs - now);
  return {
    hasTrial: true,
    active: endsAtMs > now,
    expired: endsAtMs <= now,
    startsAt: row.trial_starts_at ? new Date(row.trial_starts_at).toISOString() : null,
    endsAt: new Date(endsAtMs).toISOString(),
    msLeft,
    daysLeft: Math.ceil(msLeft / DAY_MS),
    note: row.note || null,
  };
}

async function getTrialStatus(pool) {
  const r = await pool.request().query(`SELECT trial_starts_at, trial_ends_at, note FROM tenant_license WHERE id = 1`);
  return computeTrialStatus(r.recordset[0]);
}

/* Validates a requested number of days (whole days, 1..MAX_TRIAL_DAYS). */
function parseDays(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRIAL_DAYS) return null;
  return n;
}

/* mode "start": trial runs `days` from now (replaces any existing trial).
   mode "extend": adds `days` to the current end (or to now if none/expired). */
function planTrial({ mode, days, current, now = Date.now() }) {
  if (mode === "extend") {
    const base = current && current.trial_ends_at && new Date(current.trial_ends_at).getTime() > now
      ? new Date(current.trial_ends_at).getTime() : now;
    return {
      startsAt: current && current.trial_starts_at && base !== now ? new Date(current.trial_starts_at) : new Date(now),
      endsAt: new Date(base + days * DAY_MS),
    };
  }
  return { startsAt: new Date(now), endsAt: new Date(now + days * DAY_MS) };
}

/* ---- expiry gate (used by authMiddleware.protect) ----
   Once a tenant's trial has ended, staff accounts can read but not change
   anything (the UI is greyed out as well, see frontend TrialBanner). Cached
   briefly so the check is not a database round-trip on every request. */
const EXPIRY_CACHE_MS = 30000;
const expiryCache = new Map(); // tenantKey -> { expired, at }

async function isTrialExpired(pool, tenantKey, now = Date.now()) {
  const hit = expiryCache.get(tenantKey);
  if (hit && now - hit.at < EXPIRY_CACHE_MS) return hit.expired;
  const expired = (await getTrialStatus(pool)).expired;
  expiryCache.set(tenantKey, { expired, at: now });
  return expired;
}
const invalidateTrialCache = (tenantKey) => { if (tenantKey) expiryCache.delete(tenantKey); else expiryCache.clear(); };

module.exports = {
  isTrialExpired, invalidateTrialCache,
  MAX_TRIAL_DAYS, ensureTenantLicenseSchema, computeTrialStatus, getTrialStatus, parseDays, planTrial,
};
