/* =========================================================================
   LMS COURSE BADGES  (L7.5b, D-092)  schema step 033 `lms_badges` + `lms_badge_awards`.
   Routes (flag `lms_gradebook`, then permission, then course membership): list = `lms.gradebook.view`; create / edit / remove / award = `lms.course.manage`
   (owner, co-teacher or admin of THAT course); the learner's own badges (studentOnly + enrolment).

   Rules (documented, simple, transparent; a badge has exactly ONE rule, fixed when it is created):
   - course_complete    : the learner meets the certificate rule of L7.5a (all visible lessons + pass mark).
   - grade_at_least N   : N from 1 to 100; the learner-view course total (released items + visible grades only) is >= N. No grades = not eligible.
   - lessons_completed N: N from 1 to 500; the learner has completed >= N visible lessons.
   Only ACTIVE learners of a published or archived course. At most 20 live badges per course (409 BADGE_LIMIT).
   Awarding is an explicit staff action (`award`, optional `badgeId`, `dryRun`), never automatic. One batch, safe to repeat (unique (badge, learner) + NOT EXISTS);
   an award is permanent: editing or removing a badge later never takes it back, and a removed (soft deleted) badge is hidden from lists. Only name, description and
   active can be edited: the rule cannot change, so awards always mean what they said. An inactive badge is not awarded.
   Audit `badge.created/updated/removed/awarded` (ids and counts); event `lms.badge.awarded` {tenant, courseId, count}.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { loadEligibility } = require("./lmsCertificates");
const events = require("./lmsEvents");

const RULES = Object.freeze(["course_complete", "grade_at_least", "lessons_completed"]);
const MAX_BADGES = 20, MAX_AWARD_ROWS = 40000;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const notFound = (what = "Course") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const reject = (code, msg) => ({ ok: false, code, errors: [msg] });
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim() : null);

/* Pure. { ok, value } or { ok:false, errors }. `edit` = only name / description / active are accepted. */
function validateBadge(body, edit = false) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const allowed = edit ? ["name", "description", "active"] : ["name", "description", "ruleType", "ruleValue"];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.${edit && (extra[0] === "ruleType" || extra[0] === "ruleValue") ? " The rule of a badge cannot be changed." : ""}`] };
  const v = {}, errors = [];
  if (!edit || body.name !== undefined) { const n = clean(body.name); if (!n || n.length > 100) errors.push("name is required (1-100 characters)."); else v.name = n; }
  if (body.description !== undefined && body.description !== null) { const d = clean(body.description); if (d === null || d.length > 300) errors.push("description must be text up to 300 characters."); else v.description = d || null; }
  else if (body.description === null) v.description = null;
  if (edit) { if (body.active !== undefined) { if (typeof body.active !== "boolean") errors.push("active must be true or false."); else v.active = body.active; } if (!Object.keys(v).length && !errors.length) errors.push("Nothing to change."); }
  else {
    if (!RULES.includes(body.ruleType)) errors.push(`ruleType must be one of: ${RULES.join(", ")}.`);
    else if (body.ruleType === "course_complete") { if (body.ruleValue !== undefined && body.ruleValue !== null) errors.push("course_complete takes no ruleValue."); v.ruleType = body.ruleType; v.ruleValue = null; }
    else { const max = body.ruleType === "grade_at_least" ? 100 : 500; const n = body.ruleValue; if (!Number.isInteger(n) || n < 1 || n > max) errors.push(`ruleValue must be a whole number from 1 to ${max}.`); else { v.ruleType = body.ruleType; v.ruleValue = n; } }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. Does this learner (from loadEligibility) meet this badge's rule? */
function meets(badge, learner) {
  if (badge.ruleType === "course_complete") return !!learner.eligible;
  if (badge.ruleType === "grade_at_least") return learner.percent !== null && learner.percent !== undefined && Number(learner.percent) >= Number(badge.ruleValue);
  if (badge.ruleType === "lessons_completed") return Number(learner.lessonsDone) >= Number(badge.ruleValue);
  return false;
}
const shape = (r) => ({ id: r.id, name: r.name, description: r.description || null, ruleType: r.rule_type, ruleValue: r.rule_value ?? null, active: !!r.active, awarded: Number(r.awarded) || 0 });

async function courseOk(pool, cid) { const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL`); return !!(r.recordset && r.recordset[0]); }
const staffOf = (user) => { const a = actorOf(user); return a && a.role !== "student" ? a : null; };

async function listBadges(pool, courseId) {
  const cid = posInt(courseId); if (!cid) return notFound();
  const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_BADGES} b.id, b.name, b.description, b.rule_type, b.rule_value, b.active,
      (SELECT COUNT(*) FROM lms_badge_awards a WHERE a.badge_id = b.id AND a.course_id = b.course_id) AS awarded
    FROM lms_badges b WHERE b.course_id = @c AND b.deleted_at IS NULL ORDER BY b.id`);
  return { ok: true, items: (r.recordset || []).map(shape) };
}

async function createBadge(pool, user, courseId, body) {
  const cid = posInt(courseId); if (!cid) return notFound(); const actor = staffOf(user); if (!actor) return notFound();
  const v = validateBadge(body); if (!v.ok) return v;
  if (!(await courseOk(pool, cid))) return notFound();
  const x = v.value;
  const r = await pool.request().input("c", sql.Int, cid).input("n", sql.NVarChar(100), x.name).input("d", sql.NVarChar(300), x.description ?? null).input("t", sql.NVarChar(30), x.ruleType).input("v", sql.Int, x.ruleValue)
    .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("max", sql.Int, MAX_BADGES)
    .query(`INSERT INTO lms_badges (course_id, name, description, rule_type, rule_value, created_by_source, created_by)
      OUTPUT INSERTED.id SELECT @c, @n, @d, @t, @v, @src, @uid WHERE (SELECT COUNT(*) FROM lms_badges WHERE course_id = @c AND deleted_at IS NULL) < @max`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("BADGE_LIMIT", `A course can have at most ${MAX_BADGES} badges.`);
  await audit(pool, actor, "badge.created", "lms_badges", id, { courseId: cid, ruleType: x.ruleType, ruleValue: x.ruleValue });
  return { ok: true, id, badge: { id, name: x.name, description: x.description ?? null, ruleType: x.ruleType, ruleValue: x.ruleValue, active: true, awarded: 0 } };
}

async function updateBadge(pool, user, courseId, badgeId, body) {
  const cid = posInt(courseId), id = posInt(badgeId); if (!cid || !id) return notFound("Badge"); const actor = staffOf(user); if (!actor) return notFound("Badge");
  const v = validateBadge(body, true); if (!v.ok) return v;
  const x = v.value, sets = [], rq = pool.request().input("c", sql.Int, cid).input("i", sql.Int, id);
  if (x.name !== undefined) { sets.push("name = @n"); rq.input("n", sql.NVarChar(100), x.name); }
  if (x.description !== undefined) { sets.push("description = @d"); rq.input("d", sql.NVarChar(300), x.description); }
  if (x.active !== undefined) { sets.push("active = @a"); rq.input("a", sql.Bit, x.active ? 1 : 0); }
  const r = await rq.query(`UPDATE lms_badges SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Badge");
  await audit(pool, actor, "badge.updated", "lms_badges", id, { courseId: cid, fields: Object.keys(x) });
  return { ok: true };
}

async function removeBadge(pool, user, courseId, badgeId) {
  const cid = posInt(courseId), id = posInt(badgeId); if (!cid || !id) return notFound("Badge"); const actor = staffOf(user); if (!actor) return notFound("Badge");
  const r = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`UPDATE lms_badges SET deleted_at = SYSUTCDATETIME(), active = 0, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Badge");
  await audit(pool, actor, "badge.removed", "lms_badges", id, { courseId: cid });
  return { ok: true, removed: true };
}

/* Explicit, idempotent. body: { badgeId?, dryRun? } */
async function awardBadges(pool, user, courseId, body, ctx = {}) {
  const cid = posInt(courseId); if (!cid) return notFound(); const actor = staffOf(user); if (!actor) return notFound();
  if (body !== undefined && body !== null && !isObj(body)) return { ok: false, errors: ["Send { badgeId?, dryRun? }."] };
  const b = body || {}; if (Object.keys(b).some((k) => k !== "badgeId" && k !== "dryRun")) return { ok: false, errors: ["Send { badgeId?, dryRun? }."] };
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return { ok: false, errors: ["dryRun must be true or false."] };
  if (b.badgeId !== undefined && !posInt(b.badgeId)) return { ok: false, errors: ["badgeId must be a positive whole number."] };
  const el = await loadEligibility(pool, cid); if (!el.ok) return el;
  const bq = pool.request().input("c", sql.Int, cid); if (b.badgeId !== undefined) bq.input("b", sql.Int, posInt(b.badgeId));
  const br = await bq.query(`SELECT TOP ${MAX_BADGES} id, name, rule_type, rule_value FROM lms_badges WHERE course_id = @c AND deleted_at IS NULL AND active = 1${b.badgeId !== undefined ? " AND id = @b" : ""} ORDER BY id`);
  const badges = (br.recordset || []).map((x) => ({ id: x.id, name: x.name, ruleType: x.rule_type, ruleValue: x.rule_value ?? null }));
  if (b.badgeId !== undefined && !badges.length) return notFound("Badge");
  if (!badges.length) return { ok: true, dryRun: !!b.dryRun, awarded: 0, wouldAward: 0, badges: [] };
  const have = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_AWARD_ROWS} badge_id, student_id FROM lms_badge_awards WHERE course_id = @c`);
  const owned = new Set((have.recordset || []).map((r) => `${r.badge_id}:${r.student_id}`));
  const rows = [], per = [];
  for (const bd of badges) { let n = 0; for (const l of el.learners) if (meets(bd, l) && !owned.has(`${bd.id}:${l.studentId}`)) { rows.push({ b: bd.id, s: l.studentId }); n += 1; } per.push({ id: bd.id, name: bd.name, wouldAward: n }); }
  if (b.dryRun === true) return { ok: true, dryRun: true, wouldAward: rows.length, badges: per };
  if (!rows.length) return { ok: true, awarded: 0, badges: per.map((p) => ({ ...p, awarded: 0 })) };
  const r = await pool.request().input("c", sql.Int, cid).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT = 0;
      INSERT INTO lms_badge_awards (badge_id, course_id, student_id, awarded_by_source, awarded_by)
        SELECT j.b, @c, j.s, @src, @uid FROM OPENJSON(@rows) WITH (b INT '$.b', s INT '$.s') j
         WHERE EXISTS (SELECT 1 FROM lms_badges bb WHERE bb.id = j.b AND bb.course_id = @c AND bb.deleted_at IS NULL AND bb.active = 1)
           AND NOT EXISTS (SELECT 1 FROM lms_badge_awards x WITH (UPDLOCK, HOLDLOCK) WHERE x.badge_id = j.b AND x.student_id = j.s);
      SET @n = @@ROWCOUNT;
      COMMIT; SELECT @n AS inserted;`);
  const awarded = Number(r.recordset && r.recordset[0] && r.recordset[0].inserted) || 0;
  await audit(pool, actor, "badge.awarded", "lms_badge_awards", null, { courseId: cid, awarded, badges: badges.length });
  if (ctx.tenant && awarded) events.emit("lms.badge.awarded", { tenant: ctx.tenant, courseId: cid, count: awarded });
  return { ok: true, awarded, badges: per };
}

/* The learner's own badges for one course (student id from the token). */
async function myBadges(pool, user, courseId) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student") return notFound();
  const cid = posInt(courseId); if (!cid) return notFound();
  const r = await pool.request().input("c", sql.Int, cid).input("s", sql.Int, actor.id)
    .query(`SELECT TOP ${MAX_BADGES} b.id, b.name, b.description, a.awarded_at FROM lms_badge_awards a JOIN lms_badges b ON b.id = a.badge_id AND b.course_id = a.course_id AND b.deleted_at IS NULL
      WHERE a.course_id = @c AND a.student_id = @s ORDER BY a.awarded_at, b.id`);
  return { ok: true, items: (r.recordset || []).map((x) => ({ id: x.id, name: x.name, description: x.description || null, awardedAt: iso(x.awarded_at) })) };
}

module.exports = { RULES, MAX_BADGES, validateBadge, meets, listBadges, createBadge, updateBadge, removeBadge, awardBadges, myBadges };
