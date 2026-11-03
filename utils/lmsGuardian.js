/* =========================================================================
   LMS GUARDIAN LINKS  (L9.5a, D-112)  read-only view for a guardian WITHOUT an account (owner answer Q97: one-time link per learner; progress + missed work only).

   Rules (documented, simple):
   - Staff side (route: flag `lms_guardian`, then `lms.settings.manage` = LMS administrator): create / list / revoke links for ONE active learner. Nothing here is reachable by a
     learner, teacher or guardian.
   - A link = 48 random hex characters (192 bits), shown ONCE; only its SHA-256 hash is stored. It expires (default 90 days, 1-365) and can be revoked. At most 5 live links per learner
     (409 LINK_LIMIT). A `label` (<= 60 chars, e.g. "Mother") tells the school who got it; it is never shown in the guardian view.
   - Public side: `/api/lms-guardian/<school key>/<secret>.json`. It works only while: the `lms` licence AND the `lms_guardian` flag are active, the learner is still active, and the link is
     neither revoked nor expired. Every failure answers the same "not found".
   - The view shows ONLY what the owner allowed: the learner's first name as stored, progress per published course the learner is actively enrolled in (completed lessons / lessons), and
     MISSED WORK = published, available assignments of those courses whose due date (the learner's extension counts) has passed and that are not handed in. Nothing else: no grades,
     no feedback, no announcements, no ids, no other learner. Fields are fixed in code (Q98: per-school switches not built).
   - last_used_at is refreshed at most once an hour; each create/revoke is audited (ids only).
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { courseCards } = require("./lmsDashboard");
const A = require("./lmsAssignments");
const X = require("./lmsExtensions");

const SECRET_RE = /^[a-f0-9]{48}$/;
const MAX_LIVE = 5, MAX_LISTED = 20, DEFAULT_DAYS = 90, MAX_DAYS = 365, MAX_COURSES = 30, MISSED_CANDIDATES = 200, MAX_MISSED = 20, TOUCH_MINUTES = 60, DAY = 864e5;
const hashOf = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
const notFound = (what = "Learner") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/* Pure. Body { label?, days? } -> { label, days } */
function validateCreate(body) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be an object."] };
  const errors = Object.keys(body).filter((k) => !["label", "days"].includes(k)).map((k) => `Unknown field "${k}".`);
  let label = "Guardian", days = DEFAULT_DAYS;
  if (body.label !== undefined) { const l = typeof body.label === "string" ? clean(body.label) : ""; if (!l || l.length > 60) errors.push("label must be 1-60 characters."); else label = l; }
  if (body.days !== undefined) { const n = typeof body.days === "string" && body.days.trim() !== "" ? Number(body.days) : body.days; if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) errors.push(`days must be a whole number from 1 to ${MAX_DAYS}.`); else days = n; }
  return errors.length ? { ok: false, errors } : { ok: true, label, days };
}

async function createLink(pool, user, studentId, body, { tenant, now = new Date(), secret = crypto.randomBytes(24).toString("hex") } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sid = posInt(studentId); if (!sid) return notFound();
  const v = validateCreate(body); if (!v.ok) return v;
  const st = await pool.request().input("s", sql.Int, sid).query(`SELECT TOP 1 id FROM Students WHERE id = @s AND status = 'active'`);
  if (!(st.recordset && st.recordset[0])) return notFound();
  const expires = new Date(now.getTime() + v.days * DAY);
  const r = await pool.request().input("s", sql.Int, sid).input("l", sql.NVarChar(60), v.label).input("h", sql.Char(64), hashOf(secret)).input("exp", sql.DateTime2, expires).input("now", sql.DateTime2, now)
    .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("max", sql.Int, MAX_LIVE)
    .query(`INSERT INTO lms_guardian_links (student_id, label, token_hash, created_by_source, created_by, created_at, expires_at)
      OUTPUT INSERTED.id
      SELECT @s, @l, @h, @src, @uid, @now, @exp
      WHERE (SELECT COUNT(*) FROM lms_guardian_links WHERE student_id = @s AND revoked_at IS NULL AND expires_at > @now) < @max`);
  const row = r.recordset && r.recordset[0];
  if (!row) return { ok: false, code: "LINK_LIMIT", errors: [`A learner can have at most ${MAX_LIVE} live guardian links. Revoke one first.`] };
  await audit(pool, actor, "guardian_link.create", "lms_guardian_links", row.id, { studentId: sid, days: v.days });
  return { ok: true, link: { id: row.id, studentId: sid, label: v.label, expiresAt: expires.toISOString() }, secret, path: `/api/lms-guardian/${encodeURIComponent(tenant || "default")}/${secret}.json` };
}

async function listLinks(pool, studentId, now = new Date()) {
  const sid = posInt(studentId); if (!sid) return notFound();
  const r = await pool.request().input("s", sql.Int, sid).input("now", sql.DateTime2, now)
    .query(`SELECT TOP ${MAX_LISTED} id, label, created_at, expires_at, last_used_at, revoked_at FROM lms_guardian_links WHERE student_id = @s ORDER BY id DESC`);
  return { ok: true, links: (r.recordset || []).map((x) => ({ id: x.id, label: x.label, createdAt: iso(x.created_at), expiresAt: iso(x.expires_at), lastUsedAt: iso(x.last_used_at), revoked: !!x.revoked_at,
    active: !x.revoked_at && !!x.expires_at && new Date(x.expires_at) > now })) };
}

async function revokeLink(pool, user, linkId, now = new Date()) {
  const actor = actorOf(user); if (!actor) return notFound("Link");
  const id = posInt(linkId); if (!id) return notFound("Link");
  const r = await pool.request().input("id", sql.Int, id).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_guardian_links SET revoked_at = @now OUTPUT INSERTED.student_id WHERE id = @id AND revoked_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("Link");
  await audit(pool, actor, "guardian_link.revoke", "lms_guardian_links", id, { studentId: row.student_id });
  return { ok: true, revoked: true };
}

/* Pure. Missed work from assignment rows (with ext_due_at / ext_cutoff_at) at `now`: due date passed (extension counted), newest due date first. */
function missedFrom(rows, now) {
  const out = [];
  for (const x of rows || []) {
    const m = X.withExtension(A.model(x), x);
    if (m && m.dueAt && m.dueAt.getTime() < now.getTime()) out.push({ courseTitle: x.course_title, title: m.title, dueAt: m.dueAt.toISOString() });
  }
  return out.sort((a, b) => (a.dueAt < b.dueAt ? 1 : a.dueAt > b.dueAt ? -1 : 0));
}

/* Public side. { ok:true, view } or { ok:false } (the same shape for every failure). */
async function renderView(pool, secret, now = new Date()) {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) return { ok: false };
  const r = await pool.request().input("h", sql.Char(64), hashOf(secret)).input("now", sql.DateTime2, now)
    .query(`SELECT l.id, l.student_id, l.last_used_at, st.name AS student_name
      FROM lms_guardian_links l JOIN Students st ON st.id = l.student_id AND st.status = 'active'
      WHERE l.token_hash = @h AND l.revoked_at IS NULL AND l.expires_at > @now`);
  const row = (r.recordset || [])[0]; if (!row) return { ok: false };
  const sid = row.student_id;
  const cards = await courseCards(pool, sid, MAX_COURSES);
  const m = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT TOP ${MISSED_CANDIDATES} ${A.COLS.split(", ").map((c) => `a.${c}`).join(", ")}, c.title AS course_title, ${X.EXT_COLS}
      FROM lms_assignments a
      JOIN lms_courses c ON c.id = a.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      ${X.joinSql("@s")}
      WHERE ${A.AVAILABLE} AND a.due_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM lms_course_enrolments en WHERE en.course_id = a.course_id AND en.student_id = @s AND en.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM lms_submissions sb WHERE sb.assignment_id = a.id AND sb.course_id = a.course_id AND sb.student_id = @s AND sb.status = 'submitted')
      ORDER BY COALESCE(x.due_at, a.due_at) DESC, a.id DESC`);
  const missed = missedFrom(m.recordset, now);
  const stale = !row.last_used_at || now - new Date(row.last_used_at) > TOUCH_MINUTES * 60000;
  if (stale) { try { await pool.request().input("id", sql.Int, row.id).query(`UPDATE lms_guardian_links SET last_used_at = SYSUTCDATETIME() WHERE id = @id`); } catch { /* never block the view */ } }
  return { ok: true, view: {
    learner: { name: row.student_name || null }, generatedAt: now.toISOString(), fields: ["progress", "missedWork"],
    courses: cards.items.map((c) => ({ title: c.title, code: c.code, totalLessons: c.totalLessons, completedLessons: c.completedLessons, percent: c.percent })),
    missedWork: { items: missed.slice(0, MAX_MISSED), total: missed.length, more: missed.length > MAX_MISSED || (m.recordset || []).length >= MISSED_CANDIDATES },
  } };
}

module.exports = { SECRET_RE, MAX_LIVE, hashOf, validateCreate, missedFrom, createLink, listLinks, revokeLink, renderView };
