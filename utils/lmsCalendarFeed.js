/* =========================================================================
   LMS CALENDAR SUBSCRIPTION FEED  (L4.5b)  a private link a student adds to Google/Apple/Outlook calendar.

   Why a token link: calendar apps cannot send a login header, so the link itself is the secret.
   Rules (documented, simple):
   - ONE feed per student. The secret is 48 random hex characters (192 bits), shown ONCE when it is created; only its
     SHA-256 hash is stored, so a database leak does not leak working links.
   - Creating again REPLACES the secret (the old link stops working at once). Revoking switches the feed off.
   - The link is `/api/lms-feed/<school key>/<secret>.ics`; the school key only picks the database, the secret is checked
     inside THAT database, so a secret from school A can never open anything in school B.
   - A feed only works while: the school's `lms` licence is active, the student is still active, and the feed is not revoked.
     Every failure answers the same "not found" (no hint which part was wrong).
   - Content = the planner rules (enrolled + published courses only) for 14 days back to ~106 days ahead, max 500 rows.
   - last_used_at is refreshed at most once an hour (no write on every poll).
   Authorisation for create/revoke lives in the routes (studentOnly); the student id always comes from the token.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { audit } = require("./lmsAudit");
const planner = require("./lmsPlanner");

const SECRET_RE = /^[a-f0-9]{48}$/;
const BACK_DAYS = 14, SPAN_DAYS = 120, DAY = 864e5, TOUCH_MINUTES = 60;
const hashOf = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");
const studentOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a : null; };
const forbidden = () => ({ ok: false, forbidden: true, errors: ["Only students have a calendar feed."] });

/* Creates the feed or replaces its secret. Returns the secret ONCE. */
async function createFeed(pool, user, tenant, secret = crypto.randomBytes(24).toString("hex")) {
  const a = studentOf(user); if (!a) return forbidden();
  await pool.request().input("s", sql.Int, a.id).input("h", sql.Char(64), hashOf(secret))
    .query(`UPDATE lms_calendar_feeds SET token_hash = @h, created_at = SYSUTCDATETIME(), last_used_at = NULL, revoked_at = NULL WHERE student_id = @s;
      IF @@ROWCOUNT = 0 INSERT INTO lms_calendar_feeds (student_id, token_hash) VALUES (@s, @h)`);
  await audit(pool, a, "calendar_feed.create", "lms_calendar_feeds", a.id, null);
  return { ok: true, secret, path: `/api/lms-feed/${encodeURIComponent(tenant || "default")}/${secret}.ics` };
}

async function feedStatus(pool, user) {
  const a = studentOf(user); if (!a) return forbidden();
  const r = await pool.request().input("s", sql.Int, a.id)
    .query(`SELECT created_at, last_used_at, revoked_at FROM lms_calendar_feeds WHERE student_id = @s`);
  const row = (r.recordset || [])[0];
  return { ok: true, active: !!row && !row.revoked_at, createdAt: row ? row.created_at : null, lastUsedAt: row ? row.last_used_at : null };
}

async function revokeFeed(pool, user) {
  const a = studentOf(user); if (!a) return forbidden();
  const r = await pool.request().input("s", sql.Int, a.id)
    .query(`UPDATE lms_calendar_feeds SET revoked_at = SYSUTCDATETIME() WHERE student_id = @s AND revoked_at IS NULL`);
  const changed = (r.rowsAffected && r.rowsAffected[0]) || 0;
  if (changed) await audit(pool, a, "calendar_feed.revoke", "lms_calendar_feeds", a.id, null);
  return { ok: true, revoked: changed > 0 };
}

/* Public side. Returns { ok:true, ics } or { ok:false } (always the same shape for every failure). */
async function renderFeed(pool, secret, now = new Date()) {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) return { ok: false };
  const r = await pool.request().input("h", sql.Char(64), hashOf(secret))
    .query(`SELECT f.student_id, f.last_used_at
      FROM lms_calendar_feeds f JOIN Students st ON st.id = f.student_id AND st.status = 'active'
      WHERE f.token_hash = @h AND f.revoked_at IS NULL`);
  const row = (r.recordset || [])[0]; if (!row) return { ok: false };
  const w = { ok: true, f: new Date(now.getTime() - BACK_DAYS * DAY), t: new Date(now.getTime() - BACK_DAYS * DAY + SPAN_DAYS * DAY) };
  const out = await planner.itemsForStudent(pool, row.student_id, w);
  const stale = !row.last_used_at || now - new Date(row.last_used_at) > TOUCH_MINUTES * 60000;
  if (stale) { try { await pool.request().input("id", sql.Int, row.student_id).query(`UPDATE lms_calendar_feeds SET last_used_at = SYSUTCDATETIME() WHERE student_id = @id`); } catch { /* never block the feed */ } }
  return { ok: true, ics: planner.toIcs(out.items, now) };
}

module.exports = { createFeed, feedStatus, revokeFeed, renderFeed, hashOf, SECRET_RE };
