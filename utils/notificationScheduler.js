const sql = require("mssql");

/* =========================================================================
   NOTIFICATION SCHEDULER
   Polls ScheduledNotifications once a minute for rows that are still
   'pending' and whose scheduledFor time has arrived, then dispatches
   each one. Deliberately a plain setInterval rather than a cron
   dependency — a one-minute resolution is more than enough for a
   "send this notification at 3pm" admin feature, and it needs no new
   package.
========================================================================= */
const TICK_MS = 60 * 1000;

const startNotificationScheduler = (getPool, listTenantKeys, io, dispatchBroadcast) => {
  const tick = async () => {
    // MULTI-TENANT: a scheduled notification can have been created in
    // any tenant's database, so check every configured tenant on each
    // tick rather than just the default one. One tenant's DB being
    // briefly unreachable doesn't stop the others from being checked.
    for (const tenantKey of listTenantKeys()) {
      try {
        const pool = await getPool(tenantKey);
        const due = await pool.request().query(`
          SELECT * FROM ScheduledNotifications
          WHERE status = 'pending' AND scheduledFor IS NOT NULL AND scheduledFor <= GETDATE()
        `);

        for (const row of due.recordset || []) {
          try {
            await dispatchBroadcast(pool, io, row);
            console.log(`📣 Scheduled notification #${row.id} dispatched (tenant "${tenantKey}")`);
          } catch (err) {
            console.error(`⚠️ Scheduled notification #${row.id} failed (tenant "${tenantKey}"):`, err.message);
          }
        }
      } catch (err) {
        // DB not reachable this tick (e.g. Azure SQL Serverless still
        // waking up) — just retry on the next tick instead of crashing.
        console.error(`⚠️ Notification scheduler tick skipped (tenant "${tenantKey}"):`, err.message);
      }
    }
  };

  setInterval(tick, TICK_MS);
  // Also run once shortly after boot so anything scheduled while the
  // server was down goes out promptly rather than waiting a full minute.
  setTimeout(tick, 5000);
};

module.exports = { startNotificationScheduler };
