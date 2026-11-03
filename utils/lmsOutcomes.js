/* =========================================================================
   LMS LEARNING OUTCOMES + LESSON OUTCOME TAGS  (L3.6)

   The LMS owns a lightweight outcomes list (master prompt section 4 hook) so a later curriculum module can replace or
   sync it: id, code, title, description, parent, source, version.
   Rules (documented, simple):
   - Outcomes are managed by LMS administrators (lms.settings.manage): create, edit, retire (soft delete), CSV import.
     Teachers (lms.lesson.edit) can only list/read them and tag their own lessons.
   - code: 1-50 chars (letters, digits, space . _ - /), unique among live outcomes, case-insensitive. title 1-300, description up to 2000.
   - Outcomes form a tree: a parent must exist, an outcome cannot sit under itself or one of its own descendants, and the tree
     is at most 5 levels deep. An outcome with live children cannot be retired.
   - `version` goes up by 1 on every real change (nothing is written when nothing changed). `source` is set by the server
     (manual | csv), never by the caller; a curriculum module will later write its own value.
   - Retiring keeps the tag rows (learning evidence history) but retired outcomes are never shown on lessons.
   - A lesson can carry up to 20 outcome tags. Tags live in `lms_outcome_tags` (entity_type + entity_id) so questions, assignments
     and rubric criteria can use the same table in later phases. Setting tags replaces the list atomically.
   - CSV import (max 300 rows / 256 KB per file, one atomic batch): columns code, title (required), description, parentCode (optional).
     New codes are created; existing codes are updated when something differs. If the parentCode column exists it is authoritative
     (empty = top level); if it is absent, parents are left alone. dryRun reports without writing. Bad rows are reported by line
     and skipped; rows whose parent was rejected are skipped too.
   Authorisation lives in the routes; every query is parameterised.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const { escapeLike } = require("./lmsCourses");
const { readCsv } = require("./lmsCsv");

const MAX_OUTCOMES = 5000, MAX_TAGS = 20, MAX_DEPTH = 5, MAX_IMPORT_ROWS = 300, MAX_IMPORT_BYTES = 256 * 1024;
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const isDuplicateKey = (err) => err && (err.number === 2601 || err.number === 2627);
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/ ]{0,49}$/;
const DUP = (code) => ({ ok: false, code: "DUPLICATE_CODE", errors: [`An outcome with code ${code} already exists.`] });

const shape = (r) => ({ id: r.id, code: r.code, title: r.title, description: r.description ?? null, parentId: r.parent_id ?? null, source: r.source, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at });
const COLS = "id, code, title, description, parent_id, source, version, created_at, updated_at";

/* ------------------------------ validation ------------------------------- */
function validateOutcome(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["code", "title", "description", "parentId"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "code" in body) { const c = oneLine(body.code); if (!CODE_RE.test(c)) errors.push("code is required: 1-50 characters (letters, digits, space . _ - /), starting with a letter or digit."); else value.code = c; }
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 300) errors.push("title is required: 1-300 characters."); else value.title = t; }
  if ("description" in body) { if (body.description === null || body.description === "") value.description = null; else { const d = oneLine(body.description); if (d.length > 2000) errors.push("description must be at most 2000 characters."); else value.description = d; } }
  if ("parentId" in body) { if (body.parentId === null) value.parentId = null; else { const p = posInt(body.parentId); if (p === null) errors.push("parentId must be a positive whole number or null."); else value.parentId = p; } }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Send at least one field to change.");
  return errors.length ? { ok: false, errors, value: {} } : { ok: true, value };
}

function validateIds(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (k !== "ids") return { ok: false, errors: [`Unknown field "${k}".`] };
  if (!Array.isArray(body.ids)) return { ok: false, errors: ["ids must be a list of outcome ids (an empty list clears the tags)."] };
  if (body.ids.length > MAX_TAGS) return { ok: false, errors: [`A lesson can have at most ${MAX_TAGS} outcome tags.`] };
  const ids = body.ids.map((x) => posInt(x));
  if (ids.some((x) => x === null)) return { ok: false, errors: ["Every id must be a positive whole number."] };
  if (new Set(ids).size !== ids.length) return { ok: false, errors: ["Each outcome may be listed once."] };
  return { ok: true, ids };
}

/* ------------------------------ tree helpers ----------------------------- */
async function ancestorCount(pool, parentId) {
  const r = await pool.request().input("p", sql.Int, parentId).query(`
    WITH up AS (SELECT id, parent_id, 1 AS d FROM lms_learning_outcomes WHERE id = @p AND deleted_at IS NULL
      UNION ALL SELECT o.id, o.parent_id, up.d + 1 FROM lms_learning_outcomes o JOIN up ON o.id = up.parent_id WHERE o.deleted_at IS NULL AND up.d < 10)
    SELECT id, d FROM up`);
  const rows = r.recordset || [];
  return { ids: rows.map((x) => x.id), depth: rows.reduce((m, x) => Math.max(m, x.d), 0) };
}
async function subtreeHeight(pool, id) {
  const r = await pool.request().input("id", sql.Int, id).query(`
    WITH down AS (SELECT id, 1 AS d FROM lms_learning_outcomes WHERE id = @id AND deleted_at IS NULL
      UNION ALL SELECT o.id, down.d + 1 FROM lms_learning_outcomes o JOIN down ON o.parent_id = down.id WHERE o.deleted_at IS NULL AND down.d < 10)
    SELECT MAX(d) AS h FROM down`);
  return Number(r.recordset?.[0]?.h) || 1;
}
/* null = fine, else an error message. selfId is null for a brand-new outcome. */
async function checkPlacement(pool, selfId, parentId) {
  if (parentId === null || parentId === undefined) return null;
  const a = await ancestorCount(pool, parentId);
  if (!a.ids.length) return "The parent outcome was not found.";
  if (selfId && a.ids.includes(selfId)) return "An outcome cannot be placed under itself or one of its own sub-outcomes.";
  const height = selfId ? await subtreeHeight(pool, selfId) : 1;
  if (a.depth + height > MAX_DEPTH) return `Outcomes can be at most ${MAX_DEPTH} levels deep.`;
  return null;
}

/* -------------------------------- admin CRUD ----------------------------- */
async function listOutcomes(pool, { q = "", parent = "", page = 1, pageSize = 50 } = {}) {
  const size = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 50)), pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const where = ["o.deleted_at IS NULL"], req = pool.request();
  const term = oneLine(q).slice(0, 100);
  if (term) { where.push("(o.title LIKE @q ESCAPE '\\' OR o.code LIKE @q ESCAPE '\\')"); req.input("q", sql.NVarChar(210), `%${escapeLike(term)}%`); }
  if (String(parent) === "root") where.push("o.parent_id IS NULL");
  else if (String(parent) !== "") { const p = posInt(parent); if (p === null) return { items: [], total: 0, page: pg, pageSize: size }; where.push("o.parent_id = @parent"); req.input("parent", sql.Int, p); }
  req.input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const r = await req.query(`SELECT o.id, o.code, o.title, o.description, o.parent_id, o.source, o.version, o.created_at, o.updated_at, COUNT(*) OVER() AS total_count
    FROM lms_learning_outcomes o WHERE ${where.join(" AND ")} ORDER BY o.code ASC, o.id ASC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map(shape), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

async function loadOutcome(pool, id) {
  const r = await pool.request().input("id", sql.Int, id).query(`SELECT TOP 1 ${COLS} FROM lms_learning_outcomes WHERE id = @id AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
async function getOutcome(pool, id) {
  const row = await loadOutcome(pool, id);
  return row ? { ok: true, outcome: shape(row) } : { ok: false, notFound: true, errors: ["Outcome not found."] };
}

async function createOutcome(pool, user, body) {
  const v = validateOutcome(body); if (!v.ok) return { ok: false, errors: v.errors };
  const n = await pool.request().query(`SELECT COUNT(*) AS n FROM lms_learning_outcomes WHERE deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= MAX_OUTCOMES) return { ok: false, code: "OUTCOME_LIMIT", errors: [`A school can have at most ${MAX_OUTCOMES} outcomes.`] };
  const bad = await checkPlacement(pool, null, v.value.parentId ?? null); if (bad) return { ok: false, errors: [bad] };
  const actor = actorOf(user);
  try {
    const r = await pool.request().input("c", sql.NVarChar(50), v.value.code).input("t", sql.NVarChar(300), v.value.title).input("d", sql.NVarChar(2000), v.value.description ?? null)
      .input("p", sql.Int, v.value.parentId ?? null).input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
      .query(`INSERT INTO lms_learning_outcomes (code, title, description, parent_id, source, version, created_by_source, created_by)
              OUTPUT INSERTED.id, INSERTED.code, INSERTED.title, INSERTED.description, INSERTED.parent_id, INSERTED.source, INSERTED.version, INSERTED.created_at, INSERTED.updated_at
              VALUES (@c, @t, @d, @p, 'manual', 1, @src, @uid)`);
    const row = r.recordset[0];
    await audit(pool, actor, "outcome.created", "lms_learning_outcomes", row.id, { code: row.code });
    return { ok: true, outcome: shape(row) };
  } catch (err) { if (isDuplicateKey(err)) return DUP(v.value.code); throw err; }
}

async function updateOutcome(pool, user, id, body) {
  const v = validateOutcome(body, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  const cur = await loadOutcome(pool, id); if (!cur) return { ok: false, notFound: true, errors: ["Outcome not found."] };
  const val = v.value, changes = [];
  if ("code" in val && val.code !== cur.code) changes.push("code");
  if ("title" in val && val.title !== cur.title) changes.push("title");
  if ("description" in val && (val.description ?? null) !== (cur.description ?? null)) changes.push("description");
  if ("parentId" in val && (val.parentId ?? null) !== (cur.parent_id ?? null)) changes.push("parentId");
  if (!changes.length) return { ok: true, outcome: shape(cur), unchanged: true };
  if (changes.includes("parentId")) { const bad = await checkPlacement(pool, id, val.parentId); if (bad) return { ok: false, errors: [bad] }; }
  const sets = [], req = pool.request().input("id", sql.Int, id);
  if (changes.includes("code")) { sets.push("code = @c"); req.input("c", sql.NVarChar(50), val.code); }
  if (changes.includes("title")) { sets.push("title = @t"); req.input("t", sql.NVarChar(300), val.title); }
  if (changes.includes("description")) { sets.push("description = @d"); req.input("d", sql.NVarChar(2000), val.description ?? null); }
  if (changes.includes("parentId")) { sets.push("parent_id = @p"); req.input("p", sql.Int, val.parentId ?? null); }
  try {
    const r = await req.query(`UPDATE lms_learning_outcomes SET ${sets.join(", ")}, version = version + 1, updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id, INSERTED.code, INSERTED.title, INSERTED.description, INSERTED.parent_id, INSERTED.source, INSERTED.version, INSERTED.created_at, INSERTED.updated_at
      WHERE id = @id AND deleted_at IS NULL`);
    const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Outcome not found."] };
    await audit(pool, actorOf(user), "outcome.updated", "lms_learning_outcomes", id, { changed: changes });
    return { ok: true, outcome: shape(row) };
  } catch (err) { if (isDuplicateKey(err)) return DUP(val.code); throw err; }
}

async function deleteOutcome(pool, user, id) {
  const kids = await pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) AS n FROM lms_learning_outcomes WHERE parent_id = @id AND deleted_at IS NULL`);
  if (Number(kids.recordset?.[0]?.n) > 0) return { ok: false, code: "HAS_CHILDREN", errors: ["Retire or move the sub-outcomes first."] };
  const r = await pool.request().input("id", sql.Int, id).query(`UPDATE lms_learning_outcomes SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Outcome not found."] };
  await audit(pool, actorOf(user), "outcome.retired", "lms_learning_outcomes", id, {});
  return { ok: true };
}

/* ------------------------------- CSV import ------------------------------ */
async function importOutcomes(pool, user, body) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["csv", "dryRun"].includes(k))) return { ok: false, errors: ['Body must be { csv: "...", dryRun?: true }.'] };
  const p = readCsv(body.csv, { maxBytes: MAX_IMPORT_BYTES, maxRows: MAX_IMPORT_ROWS, required: ["code", "title"], known: ["code", "title", "description", "parentcode"] });
  if (!p.ok) return p;
  const hasParent = p.headers.includes("parentcode"), hasDesc = p.headers.includes("description");
  const dryRun = body.dryRun === true;
  const ex = await pool.request().query(`SELECT TOP ${MAX_OUTCOMES} id, code, title, description, parent_id FROM lms_learning_outcomes WHERE deleted_at IS NULL`);
  const existing = ex.recordset || [], byId = new Map(existing.map((x) => [x.id, x])), byCode = new Map(existing.map((x) => [String(x.code).toLowerCase(), x]));
  const failed = [], seen = new Map(), rows = new Map();
  const fail = (r, reason, message) => failed.push({ line: r.line, code: r.code || "", reason, message });
  for (const r of p.rows) {
    const code = oneLine(r.cells.code), title = oneLine(r.cells.title), desc = hasDesc ? (oneLine(r.cells.description) || null) : undefined, pc = hasParent ? oneLine(r.cells.parentcode) : undefined;
    const row = { line: r.line, code, title, desc, parentCode: pc || null, parentKey: hasParent ? (pc ? pc.toLowerCase() : null) : undefined };
    if (!CODE_RE.test(code)) { fail(row, "INVALID_CODE", "code must be 1-50 characters (letters, digits, space . _ - /)."); continue; }
    if (title.length < 1 || title.length > 300) { fail(row, "INVALID_TITLE", "title is required: 1-300 characters."); continue; }
    if (desc && desc.length > 2000) { fail(row, "INVALID_DESCRIPTION", "description must be at most 2000 characters."); continue; }
    if (pc && !CODE_RE.test(pc)) { fail(row, "INVALID_PARENT", "parentCode is not a valid code."); continue; }
    const key = code.toLowerCase();
    if (seen.has(key)) { fail(row, "DUPLICATE_IN_FILE", `Same code as line ${seen.get(key)}.`); continue; }
    seen.set(key, r.line); row.key = key; rows.set(key, row);
  }
  const parentKeyOf = (key) => { // final parent (lower-case code) of a node after this import
    const f = rows.get(key); const e = byCode.get(key);
    if (f && f.parentKey !== undefined) return f.parentKey;
    return e && e.parent_id && byId.get(e.parent_id) ? String(byId.get(e.parent_id).code).toLowerCase() : null;
  };
  for (let pass = 0; pass < 8; pass++) {
    const drop = []; // judged against ONE snapshot per pass, so the order of rows in the file never decides who fails
    for (const [key, row] of [...rows]) {
      const pk = parentKeyOf(key); let problem = null;
      if (pk !== null) {
        if (pk === key) problem = ["SELF_PARENT", "An outcome cannot be its own parent."];
        else if (!rows.has(pk) && !byCode.has(pk)) problem = ["PARENT_NOT_FOUND", `Parent code ${row.parentCode} was not found (or its own row was rejected).`];
      }
      if (!problem) { let cur = key, steps = 0; const visited = new Set(); while (cur !== null && steps <= MAX_DEPTH) { if (visited.has(cur)) { steps = MAX_DEPTH + 1; break; } visited.add(cur); cur = parentKeyOf(cur); steps++; } if (steps > MAX_DEPTH) problem = ["DEPTH_OR_LOOP", `Outcomes can be at most ${MAX_DEPTH} levels deep and cannot loop.`]; }
      if (problem) drop.push([key, row, problem]);
    }
    if (!drop.length) break;
    for (const [key, row, problem] of drop) { fail(row, problem[0], problem[1]); rows.delete(key); }
  }
  const depthOf = (key) => { let d = 0, cur = key; while (cur !== null && d <= MAX_DEPTH) { d++; cur = parentKeyOf(cur); } return d; };
  const creates = [], updates = []; let unchanged = 0;
  for (const [key, row] of rows) {
    const e = byCode.get(key);
    if (!e) { creates.push(row); continue; }
    const ch = [];
    if (row.title !== e.title) ch.push("title");
    if (row.desc !== undefined && (row.desc ?? null) !== (e.description ?? null)) ch.push("description");
    if (row.parentKey !== undefined) { const cur = e.parent_id && byId.get(e.parent_id) ? String(byId.get(e.parent_id).code).toLowerCase() : null; if (row.parentKey !== cur) ch.push("parentCode"); }
    if (ch.length) updates.push({ row, e, changes: ch }); else unchanged++;
  }
  if (existing.length + creates.length > MAX_OUTCOMES) return { ok: false, code: "OUTCOME_LIMIT", errors: [`A school can have at most ${MAX_OUTCOMES} outcomes.`] };
  creates.sort((a, b) => depthOf(a.key) - depthOf(b.key) || a.line - b.line);
  const report = {
    ok: true, dryRun,
    summary: { rows: p.rows.length, created: creates.length, updated: updates.length, unchanged, failed: failed.length },
    created: creates.map((r) => ({ line: r.line, code: r.code })), updated: updates.map((u) => ({ line: u.row.line, code: u.e.code, changes: u.changes })),
    failed: failed.sort((a, b) => a.line - b.line),
  };
  if (dryRun || (!creates.length && !updates.length)) return report;
  const actor = actorOf(user), req = pool.request().input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null), stmts = [];
  const canonical = (pk) => (rows.get(pk) ? rows.get(pk).code : byCode.get(pk).code); // exact spelling already stored or being stored
  const parentSql = (name) => `(SELECT TOP 1 id FROM lms_learning_outcomes WHERE code = @${name} AND deleted_at IS NULL)`;
  creates.forEach((r, i) => {
    req.input(`c${i}`, sql.NVarChar(50), r.code).input(`t${i}`, sql.NVarChar(300), r.title).input(`d${i}`, sql.NVarChar(2000), r.desc ?? null);
    const pk = parentKeyOf(r.key); if (pk !== null) req.input(`p${i}`, sql.NVarChar(50), canonical(pk));
    stmts.push(`INSERT INTO lms_learning_outcomes (code, title, description, parent_id, source, version, created_by_source, created_by) VALUES (@c${i}, @t${i}, @d${i}, ${pk !== null ? parentSql(`p${i}`) : "NULL"}, 'csv', 1, @src, @uid);`);
  });
  updates.forEach((u, j) => {
    req.input(`u${j}`, sql.Int, u.e.id).input(`ut${j}`, sql.NVarChar(300), u.row.title); const sets = [`title = @ut${j}`];
    if (u.changes.includes("description")) { req.input(`ud${j}`, sql.NVarChar(2000), u.row.desc ?? null); sets.push(`description = @ud${j}`); }
    if (u.changes.includes("parentCode")) { const pk = u.row.parentKey; if (pk === null) sets.push("parent_id = NULL"); else { req.input(`up${j}`, sql.NVarChar(50), canonical(pk)); sets.push(`parent_id = ${parentSql(`up${j}`)}`); } }
    stmts.push(`UPDATE lms_learning_outcomes SET ${sets.join(", ")}, version = version + 1, updated_at = SYSUTCDATETIME() WHERE id = @u${j} AND deleted_at IS NULL;`);
  });
  try { await req.query(`SET XACT_ABORT ON; BEGIN TRAN; ${stmts.join(" ")} COMMIT;`); }
  catch (err) { if (isDuplicateKey(err)) return { ok: false, code: "DUPLICATE_CODE", errors: ["Another import or edit added one of these codes at the same time. Run the import again."] }; throw err; }
  await audit(pool, actor, "outcome.imported", "lms_learning_outcomes", null, report.summary);
  return report;
}

/* ------------------------------ lesson tags ------------------------------ */
async function lessonLive(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).query(`SELECT TOP 1 id FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}
async function readLessonOutcomes(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId)
    .query(`SELECT TOP ${MAX_TAGS} o.id, o.code, o.title FROM lms_outcome_tags t JOIN lms_learning_outcomes o ON o.id = t.outcome_id AND o.deleted_at IS NULL
            WHERE t.entity_type = 'lesson' AND t.entity_id = @l AND t.course_id = @c ORDER BY o.code, o.id`);
  return { ok: true, outcomes: (r.recordset || []).map((x) => ({ outcomeId: x.id, code: x.code, title: x.title })) };
}
async function getLessonOutcomes(pool, courseId, lessonId) {
  if (!(await lessonLive(pool, courseId, lessonId))) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  return readLessonOutcomes(pool, courseId, lessonId);
}
async function setLessonOutcomes(pool, user, courseId, lessonId, body) {
  const v = validateIds(body); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (!(await lessonLive(pool, courseId, lessonId))) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  if (v.ids.length) {
    const q = pool.request(); v.ids.forEach((id, i) => q.input(`o${i}`, sql.Int, id));
    const f = await q.query(`SELECT id FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN (${v.ids.map((_, i) => `@o${i}`).join(", ")})`);
    const have = new Set((f.recordset || []).map((x) => x.id));
    if (v.ids.some((id) => !have.has(id))) return { ok: false, errors: ["Every outcome must exist (it may have been retired)."] };
  }
  const req = pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId);
  v.ids.forEach((id, i) => req.input(`r${i}`, sql.Int, id));
  const rows = v.ids.map((_, i) => `(@r${i}, 'lesson', @l, @c)`).join(", ");
  await req.query(`SET XACT_ABORT ON; BEGIN TRAN;
    DELETE FROM lms_outcome_tags WHERE entity_type = 'lesson' AND entity_id = @l AND course_id = @c;
    ${v.ids.length ? `INSERT INTO lms_outcome_tags (outcome_id, entity_type, entity_id, course_id) VALUES ${rows};` : ""}
    COMMIT;`);
  await audit(pool, actorOf(user), "lesson.outcomes_set", "lms_lessons", lessonId, { courseId, count: v.ids.length });
  return readLessonOutcomes(pool, courseId, lessonId);
}

module.exports = {
  MAX_OUTCOMES, MAX_TAGS, MAX_DEPTH, MAX_IMPORT_ROWS, validateOutcome, validateIds,
  listOutcomes, getOutcome, createOutcome, updateOutcome, deleteOutcome, importOutcomes, getLessonOutcomes, setLessonOutcomes,
};
