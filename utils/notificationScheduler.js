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

const startNotificationScheduler = (poolPromise, io, dispatchBroadcast) => {
  const tick = async () => {
    try {
      const pool = await poolPromise;
      const due = await pool.request().query(`
        SELECT * FROM ScheduledNotifications
        WHERE status = 'pending' AND scheduledFor IS NOT NULL AND scheduledFor <= GETDATE()
      `);

      for (const row of due.recordset || []) {
        try {
          await dispatchBroadcast(pool, io, row);
          console.log(`📣 Scheduled notification #${row.id} dispatched`);
        } catch (err) {
          console.error(`⚠️ Scheduled notification #${row.id} failed:`, err.message);
        }
      }
    } catch (err) {
      // DB not reachable this tick (e.g. Azure SQL Serverless still
      // waking up) — just retry on the next tick instead of crashing.
      console.error("⚠️ Notification scheduler tick skipped:", err.message);
    }
  };

  setInterval(tick, TICK_MS);
  // Also run once shortly after boot so anything scheduled while the
  // server was down goes out promptly rather than waiting a full minute.
  setTimeout(tick, 5000);
};

module.exports = { startNotificationScheduler };
