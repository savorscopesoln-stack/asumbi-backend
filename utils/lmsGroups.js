/* =========================================================================
   LMS COURSE GROUPS  (L8.2a, D-098)  schema step 035 `lms_groups`, `lms_group_members`.
   Routes (flag `lms_discussions` FIRST): STAFF under /courses/:id/groups (read = any course owner / co-teacher / admin; write = `lms.course.manage` + membership),
   LEARNER GET /courses/:id/learn/groups/mine (studentOnly + ACTIVE enrolment). The viewer kind is fixed by the ROUTE.
   Rules:
   - ONE set of groups per course; a learner is in at most ONE live group of a course (filtered unique index). Only ACTIVE enrolled learners can be members; a learner who
     withdraws drops out of every count and view but the row stays (soft). Up to 50 groups per course, names unique per course (409 NAME_TAKEN).
   - Staff writes: draft and published courses; archived = 409 COURSE_READ_ONLY. Moving a learner to another group is the same call as adding.
   - AUTO allocation `POST /groups/allocate {groups: 2..50, seed?, dryRun?, replace?}` is REPRODUCIBLE: active learners are sorted by id, shuffled by a seeded PRNG
     (utils/lmsQuizMarking.permutation) and dealt round-robin, so the same learners + the same seed give the same groups (sizes differ by at most 1). The seed is returned
     (random if not sent) and audited. Existing groups: 409 GROUPS_EXIST unless `replace: true` (old groups are soft deleted, their members released). dryRun writes nothing.
   - A learner sees only THEIR OWN group and its members' names as "First L." (no ids, no admission numbers). Staff see names and admission numbers of learners.
   Group forums, group assignments and peer-review allocation come later (L8.2b / L8.3).
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const { holderName } = require("./lmsCertificates");
const { permutation } = require("./lmsQuizMarking");
const D = require("./lmsDiscussions");
const { courseStatus, readCtx, notFound, reject, paging, isObj } = D._internal;
const { viewerOf, cleanText } = D;

const MAX_GROUPS = 50, MAX_LEARNERS = 2000, MAX_BATCH = 100, NAME_MAX = 100, SEED_MAX = 50, MEMBERS_SHOWN = 100;
const isDup = (e) => !!e && (e.number === 2601 || e.number === 2627);
const nameOf = (v) => { const t = cleanText(v); return t === null ? null : t.replace(/\s+/g, " "); };

/* Pure. { ok, value:{name?, position?} } or { ok:false, errors } */
function validateGroup(body, edit = false) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["name", "position"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const v = {}, errors = [];
  if (!edit || body.name !== undefined) { const n = nameOf(body.name); if (!n || n.length > NAME_MAX) errors.push(`name is required (1-${NAME_MAX} characters).`); else v.name = n; }
  if (body.position !== undefined) { if (!Number.isInteger(body.position) || body.position < 0 || body.position > 1000) errors.push("position must be a whole number from 0 to 1000."); else v.position = body.position; }
  if (edit && !errors.length && !Object.keys(v).length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. { studentIds: [1..100 distinct positive integers] } */
function validateMembers(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => k !== "studentIds"); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const a = body.studentIds;
  if (!Array.isArray(a) || !a.length || a.length > MAX_BATCH || a.some((x) => !Number.isInteger(x) || x <= 0)) return { ok: false, errors: [`studentIds must be 1-${MAX_BATCH} positive whole numbers.`] };
  if (new Set(a).size !== a.length) return { ok: false, errors: ["studentIds must not repeat."] };
  return { ok: true, value: { studentIds: a } };
}
/* Pure. { groups, seed?, dryRun?, replace? } */
function validateAllocate(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["groups", "seed", "dryRun", "replace"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], v = {};
  if (!Number.isInteger(body.groups) || body.groups < 2 || body.groups > MAX_GROUPS) errors.push(`groups must be a whole number from 2 to ${MAX_GROUPS}.`); else v.groups = body.groups;
  if (body.seed !== undefined && body.seed !== null) { const t = typeof body.seed === "string" ? cleanText(body.seed) : null; if (!t || t.length > SEED_MAX) errors.push(`seed must be text up to ${SEED_MAX} characters.`); else v.seed = t; }
  for (const k of ["dryRun", "replace"]) if (body[k] !== undefined) { if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`); else v[k] = body[k]; }
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure and DETERMINISTIC: same ids + n + seed -> same answer, whatever order the ids arrive in. Returns [{ position:1..n, studentIds:[...] }]; every id exactly once, sizes differ by <= 1. */
function planAllocation(studentIds, n, seed) {
  const ids = [...new Set(studentIds)].sort((a, b) => a - b), perm = permutation(ids.length, String(seed ?? ""));
  const groups = Array.from({ length: n }, (_, i) => ({ position: i + 1, studentIds: [] }));
  perm.forEach((p, k) => groups[k % n].studentIds.push(ids[p - 1]));
  return groups.map((g) => ({ position: g.position, studentIds: g.studentIds.sort((a, b) => a - b) }));
}

async function staffCtx(pool, user, courseId, write) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound();
  const s = await courseStatus(pool, cid); if (!s) return notFound();
  if (write && s === "archived") return reject("COURSE_READ_ONLY", "This course is archived. Groups are read only.");
  return { ok: true, v, cid, status: s };
}
const GROUP_LIVE = "g.id = @g AND g.course_id = @c AND g.deleted_at IS NULL";
async function loadGroup(pool, cid, gid) { const r = await pool.request().input("c", sql.Int, cid).input("g", sql.Int, gid).query(`SELECT TOP 1 g.id, g.name FROM lms_groups g WHERE ${GROUP_LIVE}`); return r.recordset && r.recordset[0] ? r.recordset[0] : null; }
const COUNT_SQL = `(SELECT COUNT(*) FROM lms_group_members m JOIN lms_course_enrolments e ON e.course_id = m.course_id AND e.student_id = m.student_id AND e.status = 'active' WHERE m.group_id = g.id AND m.course_id = g.course_id AND m.removed_at IS NULL)`;

async function listGroups(pool, user, courseId) {
  const c = await staffCtx(pool, user, courseId, false); if (!c.ok) return c;
  const rq = () => pool.request().input("c", sql.Int, c.cid);
  const r = await rq().query(`SELECT TOP ${MAX_GROUPS} g.id, g.name, g.position, ${COUNT_SQL} AS member_count FROM lms_groups g WHERE g.course_id = @c AND g.deleted_at IS NULL ORDER BY g.position, g.id`);
  const u = await rq().query(`SELECT COUNT(*) AS n FROM lms_course_enrolments e WHERE e.course_id = @c AND e.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM lms_group_members m WHERE m.course_id = e.course_id AND m.student_id = e.student_id AND m.removed_at IS NULL)`);
  return { ok: true, items: (r.recordset || []).map((x) => ({ id: x.id, name: x.name, position: x.position, memberCount: Number(x.member_count) || 0 })), unassigned: Number(u.recordset && u.recordset[0] && u.recordset[0].n) || 0 };
}

async function createGroup(pool, user, courseId, body) {
  const val = validateGroup(body); if (!val.ok) return val;
  const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; const x = val.value;
  try {
    const r = await pool.request().input("c", sql.Int, c.cid).input("n", sql.NVarChar(100), x.name).input("pos", sql.Int, x.position ?? null).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id).input("max", sql.Int, MAX_GROUPS)
      .query(`INSERT INTO lms_groups (course_id, name, position, created_by_source, created_by) OUTPUT INSERTED.id, INSERTED.position
        SELECT @c, @n, COALESCE(@pos, ISNULL((SELECT MAX(position) FROM lms_groups WHERE course_id = @c AND deleted_at IS NULL), 0) + 1), @src, @uid
        WHERE (SELECT COUNT(*) FROM lms_groups WHERE course_id = @c AND deleted_at IS NULL) < @max`);
    const row = r.recordset && r.recordset[0]; if (!row) return reject("GROUP_LIMIT", `A course can have at most ${MAX_GROUPS} groups.`);
    await audit(pool, c.v, "group.created", "lms_groups", row.id, { courseId: c.cid });
    return { ok: true, group: { id: row.id, name: x.name, position: row.position, memberCount: 0 } };
  } catch (e) { if (isDup(e)) return reject("NAME_TAKEN", "A group with this name already exists in the course."); throw e; }
}

async function updateGroup(pool, user, courseId, groupId, body) {
  const gid = posInt(groupId); const val = validateGroup(body, true); if (!val.ok) return val;
  const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!gid) return notFound("Group"); const x = val.value;
  const sets = [], rq = pool.request().input("c", sql.Int, c.cid).input("g", sql.Int, gid);
  if (x.name !== undefined) { sets.push("name = @n"); rq.input("n", sql.NVarChar(100), x.name); } if (x.position !== undefined) { sets.push("position = @pos"); rq.input("pos", sql.Int, x.position); }
  try {
    const r = await rq.query(`UPDATE lms_groups SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @g AND course_id = @c AND deleted_at IS NULL`);
    if (!(r.recordset && r.recordset[0])) return notFound("Group");
  } catch (e) { if (isDup(e)) return reject("NAME_TAKEN", "A group with this name already exists in the course."); throw e; }
  await audit(pool, c.v, "group.updated", "lms_groups", gid, { courseId: c.cid, fields: Object.keys(x) });
  return { ok: true };
}

async function removeGroup(pool, user, courseId, groupId) {
  const gid = posInt(groupId); const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!gid) return notFound("Group");
  const r = await pool.request().input("c", sql.Int, c.cid).input("g", sql.Int, gid).query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @n INT, @released INT = 0;
    UPDATE lms_groups SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE id = @g AND course_id = @c AND deleted_at IS NULL;
    SET @n = @@ROWCOUNT;
    IF @n > 0 BEGIN UPDATE lms_group_members SET removed_at = SYSUTCDATETIME() WHERE group_id = @g AND course_id = @c AND removed_at IS NULL; SET @released = @@ROWCOUNT; END
    COMMIT; SELECT @n AS n, @released AS released;`);
  const row = r.recordset && r.recordset[0]; if (!row || !Number(row.n)) return notFound("Group");
  await audit(pool, c.v, "group.removed", "lms_groups", gid, { courseId: c.cid, released: Number(row.released) || 0 });
  return { ok: true, removed: true, released: Number(row.released) || 0 };
}

async function listMembers(pool, user, courseId, groupId, query) {
  const gid = posInt(groupId); const c = await staffCtx(pool, user, courseId, false); if (!c.ok) return c; if (!gid) return notFound("Group");
  const g = await loadGroup(pool, c.cid, gid); if (!g) return notFound("Group");
  const pg = paging(query), rq = () => pool.request().input("c", sql.Int, c.cid).input("g", sql.Int, gid);
  const FROM = `FROM lms_group_members m JOIN lms_course_enrolments e ON e.course_id = m.course_id AND e.student_id = m.student_id AND e.status = 'active' JOIN Students s ON s.id = m.student_id
    WHERE m.group_id = @g AND m.course_id = @c AND m.removed_at IS NULL`;
  const tot = await rq().query(`SELECT COUNT(*) AS n ${FROM}`);
  const r = await rq().input("off", sql.Int, pg.offset).input("ps", sql.Int, pg.pageSize).query(`SELECT m.student_id, s.name AS student_name, s.admissionNo AS admission_no ${FROM} ORDER BY s.name, m.student_id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0, items = (r.recordset || []).map((x) => ({ studentId: x.student_id, name: x.student_name || "", admissionNo: x.admission_no || "" }));
  return { ok: true, group: { id: g.id, name: g.name }, items, total, page: pg.page, pageSize: pg.pageSize, hasMore: pg.offset + items.length < total };
}

/* Add or MOVE learners into a group. Only ACTIVE enrolled learners of THIS course count; the rest are `skipped`. One atomic batch. */
async function setMembers(pool, user, courseId, groupId, body) {
  const gid = posInt(groupId); const val = validateMembers(body); if (!val.ok) return val;
  const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!gid) return notFound("Group");
  const ids = val.value.studentIds;
  const r = await pool.request().input("c", sql.Int, c.cid).input("g", sql.Int, gid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      IF NOT EXISTS (SELECT 1 FROM lms_groups WHERE id = @g AND course_id = @c AND deleted_at IS NULL) BEGIN ROLLBACK; SELECT -1 AS eligible, 0 AS moved, 0 AS added; RETURN; END
      DECLARE @ok TABLE (sid INT PRIMARY KEY), @moved INT, @added INT;
      INSERT INTO @ok SELECT DISTINCT e.student_id FROM lms_course_enrolments e WHERE e.course_id = @c AND e.status = 'active' AND e.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids));
      UPDATE m SET group_id = @g FROM lms_group_members m JOIN @ok i ON i.sid = m.student_id WHERE m.course_id = @c AND m.removed_at IS NULL AND m.group_id <> @g;
      SET @moved = @@ROWCOUNT;
      INSERT INTO lms_group_members (group_id, course_id, student_id, created_by_source, created_by)
        SELECT @g, @c, i.sid, @src, @uid FROM @ok i WHERE NOT EXISTS (SELECT 1 FROM lms_group_members WITH (UPDLOCK, HOLDLOCK) WHERE course_id = @c AND student_id = i.sid AND removed_at IS NULL);
      SET @added = @@ROWCOUNT;
      COMMIT; SELECT (SELECT COUNT(*) FROM @ok) AS eligible, @moved AS moved, @added AS added;`);
  const row = r.recordset && r.recordset[0]; if (!row || Number(row.eligible) < 0) return notFound("Group");
  const eligible = Number(row.eligible) || 0, moved = Number(row.moved) || 0, added = Number(row.added) || 0;
  await audit(pool, c.v, "group.members_set", "lms_groups", gid, { courseId: c.cid, requested: ids.length, added, moved });
  return { ok: true, added, moved, unchanged: Math.max(0, eligible - added - moved), skipped: ids.length - eligible };
}

async function removeMember(pool, user, courseId, groupId, studentId) {
  const gid = posInt(groupId), sid = posInt(studentId); const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!gid || !sid) return notFound("Member");
  const r = await pool.request().input("c", sql.Int, c.cid).input("g", sql.Int, gid).input("s", sql.Int, sid)
    .query(`UPDATE m SET removed_at = SYSUTCDATETIME() OUTPUT INSERTED.id FROM lms_group_members m JOIN lms_groups g ON g.id = m.group_id AND g.course_id = m.course_id AND g.deleted_at IS NULL
      WHERE m.group_id = @g AND m.course_id = @c AND m.student_id = @s AND m.removed_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Member");
  await audit(pool, c.v, "group.member_removed", "lms_groups", gid, { courseId: c.cid, studentId: sid });
  return { ok: true, removed: true };
}

/* Reproducible auto allocation (see the header). */
async function allocate(pool, user, courseId, body) {
  const val = validateAllocate(body); if (!val.ok) return val;
  const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; const x = val.value;
  const rq = () => pool.request().input("c", sql.Int, c.cid);
  const ex = await rq().query(`SELECT COUNT(*) AS n FROM lms_groups WHERE course_id = @c AND deleted_at IS NULL`);
  if ((Number(ex.recordset && ex.recordset[0] && ex.recordset[0].n) || 0) > 0 && !x.replace) return reject("GROUPS_EXIST", "This course already has groups. Send replace: true to start again.");
  const lr = await rq().query(`SELECT TOP ${MAX_LEARNERS + 1} e.student_id FROM lms_course_enrolments e WHERE e.course_id = @c AND e.status = 'active' ORDER BY e.student_id`);
  const ids = (lr.recordset || []).map((y) => y.student_id).filter((v) => Number.isInteger(v));
  if (ids.length > MAX_LEARNERS) return reject("TOO_MANY_LEARNERS", `Automatic groups support up to ${MAX_LEARNERS} learners.`);
  if (!ids.length) return reject("NO_LEARNERS", "There are no active learners to put in groups.");
  if (x.groups > ids.length) return reject("TOO_MANY_GROUPS", "There are more groups than learners.");
  const seed = x.seed || crypto.randomBytes(4).toString("hex"), plan = planAllocation(ids, x.groups, seed), summary = plan.map((g) => ({ name: `Group ${g.position}`, size: g.studentIds.length }));
  if (x.dryRun) return { ok: true, dryRun: true, seed, learners: ids.length, groups: summary };
  const names = plan.map((g) => ({ name: `Group ${g.position}`, pos: g.position })), map = plan.flatMap((g) => g.studentIds.map((sid) => ({ g: g.position, sid })));
  const rel = x.replace ? `UPDATE lms_group_members SET removed_at = SYSUTCDATETIME() WHERE course_id = @c AND removed_at IS NULL;
      UPDATE lms_groups SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE course_id = @c AND deleted_at IS NULL;` : "";
  const r = await rq().input("names", sql.NVarChar(sql.MAX), JSON.stringify(names)).input("map", sql.NVarChar(sql.MAX), JSON.stringify(map)).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id)
    .query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @made TABLE (id INT, position INT), @placed INT;
      ${rel}
      INSERT INTO lms_groups (course_id, name, position, created_by_source, created_by) OUTPUT INSERTED.id, INSERTED.position INTO @made
        SELECT @c, j.name, j.pos, @src, @uid FROM OPENJSON(@names) WITH (name NVARCHAR(100) '$.name', pos INT '$.pos') j;
      INSERT INTO lms_group_members (group_id, course_id, student_id, created_by_source, created_by)
        SELECT m.id, @c, j.sid, @src, @uid FROM OPENJSON(@map) WITH (g INT '$.g', sid INT '$.sid') j JOIN @made m ON m.position = j.g
        WHERE EXISTS (SELECT 1 FROM lms_course_enrolments e WHERE e.course_id = @c AND e.student_id = j.sid AND e.status = 'active');
      SET @placed = @@ROWCOUNT;
      COMMIT; SELECT @placed AS placed;`).catch((e) => { if (isDup(e)) return { dup: true }; throw e; });
  if (r.dup) return reject("GROUPS_EXIST", "Groups with these names already exist. Try again.");
  const placed = Number(r.recordset && r.recordset[0] && r.recordset[0].placed) || 0;
  await audit(pool, c.v, "group.allocated", "lms_groups", null, { courseId: c.cid, groups: x.groups, learners: ids.length, placed, seed, replaced: !!x.replace });
  return { ok: true, seed, learners: ids.length, placed, groups: summary };
}

/* The learner's OWN group: its name and members' names ("First L."), nothing else. */
async function myGroup(pool, user, courseId) {
  const v = viewerOf(user, false), cid = posInt(courseId); if (!v || !cid) return notFound(); const ctx = await readCtx(pool, v, cid); if (!ctx.ok) return ctx;
  const g = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).query(`SELECT TOP 1 g.id, g.name FROM lms_group_members m JOIN lms_groups g ON g.id = m.group_id AND g.course_id = m.course_id AND g.deleted_at IS NULL
    WHERE m.course_id = @c AND m.student_id = @vid AND m.removed_at IS NULL`);
  const grp = g.recordset && g.recordset[0]; if (!grp) return { ok: true, group: null };
  const r = await pool.request().input("c", sql.Int, cid).input("g", sql.Int, grp.id).query(`SELECT TOP ${MEMBERS_SHOWN} m.student_id, s.name AS student_name FROM lms_group_members m
    JOIN lms_course_enrolments e ON e.course_id = m.course_id AND e.student_id = m.student_id AND e.status = 'active' JOIN Students s ON s.id = m.student_id
    WHERE m.group_id = @g AND m.course_id = @c AND m.removed_at IS NULL ORDER BY s.name, m.student_id`);
  const members = (r.recordset || []).map((x) => ({ name: holderName(x.student_name), mine: x.student_id === v.id }));
  return { ok: true, group: { id: grp.id, name: grp.name, members } };
}

module.exports = { MAX_GROUPS, MAX_LEARNERS, MAX_BATCH, validateGroup, validateMembers, validateAllocate, planAllocation, listGroups, createGroup, updateGroup, removeGroup, listMembers, setMembers, removeMember, allocate, myGroup };
