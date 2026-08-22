const { sql } = require("../config/db");

/* =========================================================
   NOTIFY
   Central place every controller uses to write rows into the
   Notifications table, so "an action happened that affects a
   student/teacher" reliably shows up in their in-system inbox
   without every route re-implementing the insert.

   recipients: [{ id, source }]   source is 'Students' | 'Teachers' | 'Users'
   opts: { title, message, type, createdBy, createdBySource, createdByName, link }

   Never throws — a notification failing to write should never break
   the action that triggered it (marks still save, exam still
   approves, etc. even if this insert has a problem).
========================================================= */
// Chunk size kept well under SQL Server's ~2100 parameter limit
// (9 params per recipient row here).
const NOTIFY_CHUNK_SIZE = 200;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function notifyUsers(pool, recipients, opts = {}) {
  if (!pool || !recipients || !recipients.length) return;
  const {
    title, message, type = "general",
    createdBy = null, createdBySource = null, createdByName = null, link = null,
  } = opts;
  if (!message) return;

  const valid = recipients.filter((r) => r && r.id && r.source);
  if (!valid.length) return;

  // One (or a handful of) multi-row INSERT(s) instead of one round trip per
  // recipient — a deploy/auto-assign notifying dozens of teachers and
  // students was previously doing that many sequential DB calls just for
  // notifications, on top of the assignment inserts themselves.
  for (const batch of chunk(valid, NOTIFY_CHUNK_SIZE)) {
    try {
      const request = pool.request();
      const valuesSql = batch
        .map((r, i) => {
          request.input(`recipientId${i}`, sql.Int, r.id);
          request.input(`recipientSource${i}`, sql.NVarChar, r.source);
          return `(@recipientId${i}, @recipientSource${i}, @title, @message, @type, 0, @createdBy, @createdBySource, @createdByName, @link, GETDATE())`;
        })
        .join(",\n          ");

      request.input("title", sql.NVarChar, title || "Notification");
      request.input("message", sql.NVarChar, message);
      request.input("type", sql.NVarChar, type);
      request.input("createdBy", sql.Int, createdBy);
      request.input("createdBySource", sql.NVarChar, createdBySource);
      request.input("createdByName", sql.NVarChar, createdByName);
      request.input("link", sql.NVarChar, link);

      await request.query(`
        INSERT INTO Notifications
          (recipientId, recipientSource, title, message, type, isRead, createdBy, createdBySource, createdByName, link, createdAt)
        VALUES
          ${valuesSql};
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
