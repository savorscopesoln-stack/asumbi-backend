const { sql } = require("../config/db");

/* =========================================================
   NOTIFY
   Central place every controller uses to write rows into the
   Notifications table, so "an action happened that affects a
   student/teacher" reliably shows up in their in-system inbox
   without every route re-implementing the insert.

   recipients: [{ id, source }]   source is 'Students' | 'Teachers' | 'Users'
   opts: { title, message, type, createdBy, createdBySource }

   Never throws — a notification failing to write should never break
   the action that triggered it (marks still save, exam still
   approves, etc. even if this insert has a problem).
========================================================= */
async function notifyUsers(pool, recipients, opts = {}) {
  if (!pool || !recipients || !recipients.length) return;
  const { title, message, type = "general", createdBy = null, createdBySource = null, link = null } = opts;
  if (!message) return;

  for (const r of recipients) {
    if (!r || !r.id || !r.source) continue;
    try {
      await pool.request()
        .input("recipientId", sql.Int, r.id)
        .input("recipientSource", sql.NVarChar, r.source)
        .input("title", sql.NVarChar, title || "Notification")
        .input("message", sql.NVarChar, message)
        .input("type", sql.NVarChar, type)
        .input("createdBy", sql.Int, createdBy)
        .input("createdBySource", sql.NVarChar, createdBySource)
        .input("link", sql.NVarChar, link)
        .query(`
          INSERT INTO Notifications
            (recipientId, recipientSource, title, message, type, isRead, createdBy, createdBySource, link, createdAt)
          VALUES
            (@recipientId, @recipientSource, @title, @message, @type, 0, @createdBy, @createdBySource, @link, GETDATE())
        `);
    } catch (err) {
      console.log("NOTIFY ERROR:", err.message);
    }
  }
}

/* convenience wrapper for a single recipient */
async function notifyOne(pool, id, source, opts) {
  return notifyUsers(pool, [{ id, source }], opts);
}

module.exports = { notifyUsers, notifyOne };
