/* =========================================================================
   LMS LEARNING PATHS, staff side  (L9.3a, D-108)  schema step 040 (`lms_paths`, `lms_path_items`, `lms_path_learners`). Flag `lms_paths`.
   A path is an ORDERED LIST OF EXISTING LESSONS of ONE course, with a kind: core | remedial | enrichment. It is a teaching aid, not a gate: it never hides, unlocks or reorders a lesson;
   visibility, release dates and prerequisites stay with the lesson rules (L3.5). Handing a path to named learners is L9.3b (table already exists, nothing writes it yet).
   Staff routes under /courses/:id/paths: read = any course staff, write = `lms.course.manage` + course membership. Learners never reach these.
   Rules:
   - title 1-100, description <= 500 (plain text: < > and control characters stripped), kind core|remedial|enrichment (default core). At most 30 live paths per course (checked inside the INSERT).
   - Items: `PUT /paths/:id/items {lessonIds}` REPLACES the whole ordered list in ONE transaction: 0-50 DISTINCT lesson ids, every one a live lesson of THIS course (draft lessons allowed for staff);
     else nothing changes (409 BAD_LESSON). Position = index in the list.
   - Staff read shows each item's lesson title and status; an item whose lesson was deleted drops out of the answer (the row stays).
   - Writes need a draft, pending or published course (archived = 409 COURSE_READ_ONLY). A path is soft deleted (items and learner rows stay).
   Audit: path.created | path.updated | path.removed | path.items_set (ids and counts, never text).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const disc = require("./lmsDiscussions");
const { courseStatus, notFound, reject, iso, isObj } = disc._internal;
const { cleanText, viewerOf } = disc;

const TITLE_MAX = 100, DESC_MAX = 500, MAX_PATHS = 30, MAX_ITEMS = 50, MAX_PAGE = 50, KINDS = ["core", "remedial", "enrichment"];
const paging = (q = {}) => { const p = Math.max(1, parseInt(q.page, 10) || 1), s = Math.min(MAX_PAGE, Math.max(1, parseInt(q.pageSize, 10) || 20)); return { page: p, pageSize: s, offset: (p - 1) * s }; };

/* Pure. { ok, value } or { ok:false, errors }. Create needs a title; edit needs at least one field. */
function validatePath(body, edit = false) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["title", "description", "kind"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const errors = [], v = {};
  if (!edit || body.title !== undefined) { const t = cleanText(body.title); if (!t || t.length > TITLE_MAX) errors.push(`title is required (1-${TITLE_MAX} characters).`); else v.title = t.replace(/\s+/g, " "); }
  if (body.description !== undefined) { if (body.description === null) v.description = null; else { const d = cleanText(body.description); if (d === null || d.length > DESC_MAX) errors.push(`description must be text up to ${DESC_MAX} characters.`); else v.description = d || null; } }
  if (body.kind !== undefined) { if (!KINDS.includes(body.kind)) errors.push("kind must be core, remedial or enrichment."); else v.kind = body.kind; }
  if (edit && !errors.length && !Object.keys(v).length) errors.push("Send at least one field to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}
/* Pure. { ok, value:{ lessonIds } }: 0-50 distinct positive whole numbers. */
function validateItems(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => k !== "lessonIds"); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const ids = body.lessonIds;
  if (!Array.isArray(ids) || ids.length > MAX_ITEMS) return { ok: false, errors: [`lessonIds must be a list of at most ${MAX_ITEMS} lesson ids.`] };
  if (!ids.every((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)) return { ok: false, errors: ["Every lesson id must be a positive whole number."] };
  if (new Set(ids).size !== ids.length) return { ok: false, errors: ["A lesson can appear in a path only once."] };
  return { ok: true, value: { lessonIds: ids } };
}

const readBlock = async (pool, v, cid) => { const s = await courseStatus(pool, cid); return s ? { ok: true, status: s } : notFound(); };
const writeBlock = (s) => (s === "archived" ? reject("COURSE_READ_ONLY", "This course is archived. Learning paths are read only.") : null);
const pathShape = (x) => ({ id: x.id, title: x.title, description: x.description || null, kind: x.kind, itemCount: Number(x.item_count) || 0, learnerCount: Number(x.learner_count) || 0, createdAt: iso(x.created_at), updatedAt: iso(x.updated_at) });
const PATH_COUNTS = `(SELECT COUNT(*) FROM lms_path_items i JOIN lms_lessons l ON l.id = i.lesson_id AND l.course_id = p.course_id AND l.deleted_at IS NULL WHERE i.path_id = p.id) AS item_count,
  (SELECT COUNT(*) FROM lms_path_learners pl WHERE pl.path_id = p.id AND pl.withdrawn_at IS NULL) AS learner_count`;

async function listPaths(pool, user, courseId, query = {}) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const rc = await readBlock(pool, v, cid); if (!rc.ok) return rc;
  const pg = paging(query), kind = KINDS.includes(query.kind) ? query.kind : null;
  const r = await pool.request().input("c", sql.Int, cid).input("k", sql.NVarChar(12), kind).input("off", sql.Int, pg.offset).input("lim", sql.Int, pg.pageSize)
    .query(`SELECT p.id, p.title, p.description, p.kind, p.created_at, p.updated_at, ${PATH_COUNTS}, COUNT(*) OVER() AS total_count
      FROM lms_paths p WHERE p.course_id = @c AND p.deleted_at IS NULL AND (@k IS NULL OR p.kind = @k) ORDER BY p.id ASC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map(pathShape), total: rows.length ? Number(rows[0].total_count) : 0, page: pg.page, pageSize: pg.pageSize };
}

async function getPath(pool, user, courseId, pathId) {
  const v = viewerOf(user, true), cid = posInt(courseId), pid = posInt(pathId); if (!v || !cid || !pid) return notFound("Path"); const rc = await readBlock(pool, v, cid); if (!rc.ok) return rc;
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).query(`SELECT p.id, p.title, p.description, p.kind, p.created_at, p.updated_at, ${PATH_COUNTS} FROM lms_paths p WHERE p.id = @p AND p.course_id = @c AND p.deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("Path");
  const it = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).query(`SELECT TOP ${MAX_ITEMS} i.lesson_id, i.position, l.title, l.status FROM lms_path_items i
    JOIN lms_lessons l ON l.id = i.lesson_id AND l.course_id = @c AND l.deleted_at IS NULL WHERE i.path_id = @p AND i.course_id = @c ORDER BY i.position, i.id`);
  return { ok: true, path: { ...pathShape(row), items: (it.recordset || []).map((x, n) => ({ lessonId: x.lesson_id, position: n + 1, title: x.title, status: x.status })) } };
}

async function createPath(pool, user, courseId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const val = validatePath(body); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); const wb = writeBlock(s); if (wb) return wb; const x = val.value;
  const r = await pool.request().input("c", sql.Int, cid).input("t", sql.NVarChar(100), x.title).input("d", sql.NVarChar(500), x.description ?? null).input("k", sql.NVarChar(12), x.kind || "core")
    .input("src", sql.NVarChar(20), v.source).input("uid", sql.Int, v.id).input("max", sql.Int, MAX_PATHS)
    .query(`INSERT INTO lms_paths (course_id, title, description, kind, created_by_source, created_by) OUTPUT INSERTED.id
      SELECT @c, @t, @d, @k, @src, @uid WHERE (SELECT COUNT(*) FROM lms_paths WITH (UPDLOCK, HOLDLOCK) WHERE course_id = @c AND deleted_at IS NULL) < @max`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("PATH_LIMIT", `A course can have at most ${MAX_PATHS} learning paths.`);
  await audit(pool, v, "path.created", "lms_paths", id, { courseId: cid, kind: x.kind || "core" });
  return { ok: true, id };
}

async function updatePath(pool, user, courseId, pathId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId), pid = posInt(pathId); if (!v || !cid || !pid) return notFound("Path"); const val = validatePath(body, true); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); const wb = writeBlock(s); if (wb) return wb; const x = val.value;
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("hasT", sql.Bit, x.title !== undefined).input("t", sql.NVarChar(100), x.title ?? null)
    .input("hasD", sql.Bit, x.description !== undefined).input("d", sql.NVarChar(500), x.description ?? null).input("hasK", sql.Bit, x.kind !== undefined).input("k", sql.NVarChar(12), x.kind ?? null)
    .query(`UPDATE lms_paths SET title = CASE WHEN @hasT = 1 THEN @t ELSE title END, description = CASE WHEN @hasD = 1 THEN @d ELSE description END, kind = CASE WHEN @hasK = 1 THEN @k ELSE kind END, updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id WHERE id = @p AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Path");
  await audit(pool, v, "path.updated", "lms_paths", pid, { courseId: cid, fields: Object.keys(x) });
  return { ok: true };
}

async function removePath(pool, user, courseId, pathId) {
  const v = viewerOf(user, true), cid = posInt(courseId), pid = posInt(pathId); if (!v || !cid || !pid) return notFound("Path");
  const s = await courseStatus(pool, cid); if (!s) return notFound(); const wb = writeBlock(s); if (wb) return wb;
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).query(`UPDATE lms_paths SET deleted_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @p AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Path");
  await audit(pool, v, "path.removed", "lms_paths", pid, { courseId: cid });
  return { ok: true };
}

async function setItems(pool, user, courseId, pathId, body) {
  const v = viewerOf(user, true), cid = posInt(courseId), pid = posInt(pathId); if (!v || !cid || !pid) return notFound("Path"); const val = validateItems(body); if (!val.ok) return val;
  const s = await courseStatus(pool, cid); if (!s) return notFound(); const wb = writeBlock(s); if (wb) return wb; const ids = val.value.lessonIds;
  const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT = (SELECT COUNT(*) FROM OPENJSON(@ids)), @ok INT;
      IF NOT EXISTS (SELECT 1 FROM lms_paths WITH (UPDLOCK, HOLDLOCK) WHERE id = @p AND course_id = @c AND deleted_at IS NULL) BEGIN ROLLBACK; SELECT CAST(NULL AS INT) AS n, N'NOT_FOUND' AS code; RETURN; END
      SELECT @ok = COUNT(*) FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids));
      IF @ok <> @n BEGIN ROLLBACK; SELECT CAST(NULL AS INT) AS n, N'BAD_LESSON' AS code; RETURN; END
      DELETE FROM lms_path_items WHERE path_id = @p;
      INSERT INTO lms_path_items (path_id, course_id, lesson_id, position) SELECT @p, @c, CAST(value AS INT), CAST([key] AS INT) + 1 FROM OPENJSON(@ids);
      UPDATE lms_paths SET updated_at = SYSUTCDATETIME() WHERE id = @p;
      COMMIT; SELECT @n AS n, CAST(NULL AS NVARCHAR(20)) AS code;`);
  const row = r.recordset && r.recordset[0]; if (!row || row.code === "NOT_FOUND") return notFound("Path");
  if (row.code === "BAD_LESSON") return reject("BAD_LESSON", "Every lesson must be a lesson of this course.");
  await audit(pool, v, "path.items_set", "lms_paths", pid, { courseId: cid, count: ids.length });
  return { ok: true, count: ids.length };
}

module.exports = { TITLE_MAX, DESC_MAX, MAX_PATHS, MAX_ITEMS, KINDS, validatePath, validateItems, listPaths, getPath, createPath, updatePath, removePath, setItems };
