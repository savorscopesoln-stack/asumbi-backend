/* =========================================================================
   LMS GRADEBOOK  (L7.1b, D-086)  STAFF side: categories, manual grade items, grade entry with history, and the paginated grid.
   Route gates (routes/lms.js): flag `lms_gradebook` FIRST, then a permission (read `lms.gradebook.view`; categories and items `lms.course.manage`;
   grade entry `lms.submission.grade`), then course membership owner/co-teacher/admin. Students never reach any of this.

   Rules (documented, simple):
   - Every query matches course_id (and item / category / student id), so an id of another course or school finds nothing ("not found", never "forbidden").
   - Categories: name 1-100 chars, weight 0-100 (2 decimals; weights need NOT add up to 100, the calculator re-scales them), dropLowest 0-20, position. At most 30 per course.
     Deleting is a soft delete; its items stay (with all their grades) and become uncategorised (weight 0 in the total, see lmsGradeCalc).
   - Items (manual only here; assignment/quiz links come with L7.1c): title 1-200, maxPoints 0.01-10000, weight 0-100 (default 1), released (default false), categoryId|null.
     At most 200 per course. Deleting is a soft delete (grades and history stay). Lowering maxPoints below a grade already entered = 409 GRADES_EXCEED_MAX.
   - Grade entry: only for a learner with an ACTIVE enrolment in THIS course. `points` 0..maxPoints (2 decimals; extra credit is NOT allowed, Q55), or null = not graded.
     Fields not sent keep their value. `excused` and `hidden` are flags; `comment` <= 1000. Nothing changed = no write, no history (`unchanged: true`).
     A `reason` (<= 300) is REQUIRED when an already entered grade (points or excused) is changed; the first entry and a change of comment/hidden alone need none.
   - Every change writes ONE `lms_grade_history` row in the SAME database transaction as the grade (one SQL batch with XACT_ABORT). The write is guarded by the values
     the staff member saw: if somebody changed the grade in the meantime the answer is 409 CHANGED and nothing is written.
     Known limit (A130): the history table keeps old/new points and excused only; a hidden/comment-only change is a row with equal points.
   - The grid lists ACTIVE learners, page size <= 100, with each learner's raw grades and the staff-view total from computeTotal (no grade bands yet, A129).
   Every query is parameterised; dynamic SQL only ever contains fixed column names chosen from validated keys.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { editable, posInt } = require("./lmsCourseParts");
const { computeTotal } = require("./lmsGradeCalc");
const events = require("./lmsEvents");

const MAX_CATEGORIES = 30, MAX_ITEMS = 200, MAX_PAGE = 100, MAX_HISTORY = 100;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clean = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim();
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);
const notFound = (what = "Course") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const changed409 = () => ({ ok: false, code: "CHANGED", errors: ["This grade was changed by someone else a moment ago. Reload and try again."] });
const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : Number(a) === Number(b));

/* Pure. A finite number with at most 2 decimals inside [min, max] (numbers or numeric strings), else null. */
function dec2(v, min, max) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-7 ? Math.round(n * 100) / 100 : null;
}
const intIn = (v, min, max) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/* ----------------------------- pure validators ----------------------------- */
function checkKeys(body, allowed) {
  if (!isObj(body)) return ["Body must be an object."];
  return Object.keys(body).filter((k) => !allowed.includes(k)).map((k) => `Unknown field "${k}".`);
}

function validateCategory(body, { partial = false } = {}) {
  const errors = checkKeys(body, ["name", "weight", "dropLowest", "position"]), value = {};
  if (errors.length) return { ok: false, errors };
  if (body.name !== undefined) { const n = typeof body.name === "string" ? clean(body.name) : ""; if (!n || n.length > 100) errors.push("name must be 1-100 characters."); else value.name = n; }
  else if (!partial) errors.push("name is required.");
  if (body.weight !== undefined) { const w = dec2(body.weight, 0, 100); if (w === null) errors.push("weight must be a number from 0 to 100 with at most 2 decimals."); else value.weight = w; }
  if (body.dropLowest !== undefined) { const d = intIn(body.dropLowest, 0, 20); if (d === null) errors.push("dropLowest must be a whole number from 0 to 20."); else value.dropLowest = d; }
  if (body.position !== undefined) { const p = intIn(body.position, 0, 10000); if (p === null) errors.push("position must be a whole number from 0 to 10000."); else value.position = p; }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validateItem(body, { partial = false } = {}) {
  const errors = checkKeys(body, ["title", "maxPoints", "weight", "released", "categoryId", "position"]), value = {};
  if (errors.length) return { ok: false, errors };
  if (body.title !== undefined) { const t = typeof body.title === "string" ? clean(body.title) : ""; if (!t || t.length > 200) errors.push("title must be 1-200 characters."); else value.title = t; }
  else if (!partial) errors.push("title is required.");
  if (body.maxPoints !== undefined) { const m = dec2(body.maxPoints, 0.01, 10000); if (m === null) errors.push("maxPoints must be a number from 0.01 to 10000 with at most 2 decimals."); else value.maxPoints = m; }
  else if (!partial) errors.push("maxPoints is required.");
  if (body.weight !== undefined) { const w = dec2(body.weight, 0, 100); if (w === null) errors.push("weight must be a number from 0 to 100 with at most 2 decimals."); else value.weight = w; }
  if (body.released !== undefined) { if (typeof body.released !== "boolean") errors.push("released must be true or false."); else value.released = body.released; }
  if (body.categoryId !== undefined) { if (body.categoryId === null) value.categoryId = null; else { const c = posInt(body.categoryId); if (c === null) errors.push("categoryId must be a category id or null."); else value.categoryId = c; } }
  if (body.position !== undefined) { const p = intIn(body.position, 0, 10000); if (p === null) errors.push("position must be a whole number from 0 to 10000."); else value.position = p; }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* Pure. Body of a grade entry against the item's max. Returns only the keys that were sent. */
function validateGrade(body, maxPoints) {
  const errors = checkKeys(body, ["points", "excused", "hidden", "comment", "reason"]), value = {};
  if (errors.length) return { ok: false, errors };
  if (body.points !== undefined) {
    if (body.points === null) value.points = null;
    else { const p = dec2(body.points, 0, 1e7); if (p === null) errors.push("points must be a number (at most 2 decimals) or null."); else if (p > Number(maxPoints)) errors.push(`points cannot be more than ${Number(maxPoints)} (this item's maximum).`); else value.points = p; }
  }
  for (const k of ["excused", "hidden"]) if (body[k] !== undefined) { if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`); else value[k] = body[k]; }
  if (body.comment !== undefined) { if (body.comment === null) value.comment = null; else if (typeof body.comment !== "string") errors.push("comment must be text."); else { const c = clean(body.comment); if (c.length > 1000) errors.push("comment is too long: at most 1000 characters."); else value.comment = c || null; } }
  if (body.reason !== undefined && body.reason !== null) { if (typeof body.reason !== "string") errors.push("reason must be text."); else { const r = clean(body.reason); if (r.length > 300) errors.push("reason is too long: at most 300 characters."); else value.reason = r || null; } }
  const fields = Object.keys(value).filter((k) => k !== "reason");
  if (!errors.length && !fields.length) errors.push("Send at least one of points, excused, hidden or comment.");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* Pure. Merges a validated entry over the existing grade (or nothing) and decides what is needed.
   -> { next:{points,excused,hidden,comment}, changed, valuesChanged (points/excused), needsReason } */
function planGrade(existing, v) {
  const old = existing ? { points: existing.points ?? null, excused: !!existing.excused, hidden: !!existing.hidden, comment: existing.comment ?? null } : { points: null, excused: false, hidden: false, comment: null };
  const next = { points: v.points !== undefined ? v.points : old.points, excused: v.excused !== undefined ? v.excused : old.excused, hidden: v.hidden !== undefined ? v.hidden : old.hidden, comment: v.comment !== undefined ? v.comment : old.comment };
  const valuesChanged = !same(old.points, next.points) || old.excused !== next.excused;
  const flagsChanged = old.hidden !== next.hidden || (old.comment || null) !== (next.comment || null);
  const hadValue = old.points !== null || old.excused;
  return { old, next, changed: existing ? valuesChanged || flagsChanged : true, valuesChanged, needsReason: !!existing && hadValue && valuesChanged };
}

/* -------------------------------- shapes ---------------------------------- */
const catShape = (r) => ({ id: r.id, name: r.name, weight: Number(r.weight), dropLowest: Number(r.drop_lowest), position: Number(r.position) });
const itemShape = (r) => ({ id: r.id, categoryId: r.category_id ?? null, title: r.title, sourceType: r.source_type, sourceId: r.source_id ?? null, maxPoints: Number(r.max_points), weight: Number(r.weight), released: !!r.released, position: Number(r.position) });
const CAT_COLS = "id, name, weight, drop_lowest, position";
const ITEM_COLS = "id, category_id, title, source_type, source_id, max_points, weight, released, position";

async function loadItem(pool, courseId, itemId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, itemId)
    .query(`SELECT TOP 1 ${ITEM_COLS} FROM lms_grade_items WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  return (r.recordset && r.recordset[0]) || null;
}
async function loadCategory(pool, courseId, categoryId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("k", sql.Int, categoryId)
    .query(`SELECT TOP 1 ${CAT_COLS} FROM lms_grade_categories WHERE id = @k AND course_id = @c AND deleted_at IS NULL`);
  return (r.recordset && r.recordset[0]) || null;
}

/* ------------------------------- categories ------------------------------- */
async function createCategory(pool, user, courseId, body) {
  const actor = actorOf(user); if (!actor) return notFound();
  const v = validateCategory(body); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const x = v.value;
  const r = await pool.request().input("c", sql.Int, courseId).input("n", sql.NVarChar(100), x.name).input("w", sql.Decimal(6, 2), x.weight ?? 0).input("d", sql.Int, x.dropLowest ?? 0)
    .input("p", sql.Int, x.position ?? null).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("lim", sql.Int, MAX_CATEGORIES)
    .query(`INSERT INTO lms_grade_categories (course_id, name, weight, drop_lowest, position, created_by_source, created_by)
      OUTPUT INSERTED.id, INSERTED.name, INSERTED.weight, INSERTED.drop_lowest, INSERTED.position
      SELECT @c, @n, @w, @d, ISNULL(@p, (SELECT ISNULL(MAX(position), 0) + 1 FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL)), @src, @uid
      WHERE (SELECT COUNT(*) FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL) < @lim`);
  const row = r.recordset && r.recordset[0];
  if (!row) return { ok: false, code: "CATEGORY_LIMIT", errors: [`A course can have at most ${MAX_CATEGORIES} grade categories.`] };
  await audit(pool, actor, "gradebook.category_created", "lms_grade_categories", row.id, { courseId });
  return { ok: true, category: catShape(row) };
}

async function updateCategory(pool, user, courseId, categoryId, body) {
  const actor = actorOf(user); if (!actor) return notFound();
  const id = posInt(categoryId); if (!id) return notFound("Category");
  const v = validateCategory(body, { partial: true }); if (!v.ok) return v;
  if (!(await loadCategory(pool, courseId, id))) return notFound("Category");
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const x = v.value, sets = [];
  const rq = pool.request().input("c", sql.Int, courseId).input("k", sql.Int, id).input("now", sql.DateTime2, new Date());
  if (x.name !== undefined) { sets.push("name = @n"); rq.input("n", sql.NVarChar(100), x.name); }
  if (x.weight !== undefined) { sets.push("weight = @w"); rq.input("w", sql.Decimal(6, 2), x.weight); }
  if (x.dropLowest !== undefined) { sets.push("drop_lowest = @d"); rq.input("d", sql.Int, x.dropLowest); }
  if (x.position !== undefined) { sets.push("position = @p"); rq.input("p", sql.Int, x.position); }
  const r = await rq.query(`UPDATE lms_grade_categories SET ${sets.join(", ")}, updated_at = @now OUTPUT INSERTED.id, INSERTED.name, INSERTED.weight, INSERTED.drop_lowest, INSERTED.position
    WHERE id = @k AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("Category");
  await audit(pool, actor, "gradebook.category_updated", "lms_grade_categories", id, { courseId, fields: Object.keys(x) });
  return { ok: true, category: catShape(row) };
}

async function deleteCategory(pool, user, courseId, categoryId) {
  const actor = actorOf(user); if (!actor) return notFound();
  const id = posInt(categoryId); if (!id) return notFound("Category");
  if (!(await loadCategory(pool, courseId, id))) return notFound("Category");
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const r = await pool.request().input("c", sql.Int, courseId).input("k", sql.Int, id).input("now", sql.DateTime2, new Date())
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT = 0, @moved INT = 0;
      UPDATE lms_grade_categories SET deleted_at = @now, updated_at = @now WHERE id = @k AND course_id = @c AND deleted_at IS NULL; SET @n = @@ROWCOUNT;
      IF @n = 1 BEGIN UPDATE lms_grade_items SET category_id = NULL, updated_at = @now WHERE course_id = @c AND category_id = @k AND deleted_at IS NULL; SET @moved = @@ROWCOUNT; END
      COMMIT; SELECT @n AS n, @moved AS moved;`);
  const row = r.recordset && r.recordset[0]; if (!row || !row.n) return notFound("Category");
  await audit(pool, actor, "gradebook.category_deleted", "lms_grade_categories", id, { courseId, itemsUncategorised: Number(row.moved) || 0 });
  return { ok: true, deleted: true, itemsUncategorised: Number(row.moved) || 0 };
}

/* --------------------------------- items ---------------------------------- */
async function createItem(pool, user, courseId, body) {
  const actor = actorOf(user); if (!actor) return notFound();
  const v = validateItem(body); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const x = v.value;
  if (x.categoryId && !(await loadCategory(pool, courseId, x.categoryId))) return { ok: false, errors: ["That category does not exist in this course."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("k", sql.Int, x.categoryId ?? null).input("t", sql.NVarChar(200), x.title).input("m", sql.Decimal(8, 2), x.maxPoints)
    .input("w", sql.Decimal(6, 2), x.weight ?? 1).input("rel", sql.Bit, x.released ? 1 : 0).input("p", sql.Int, x.position ?? null)
    .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("lim", sql.Int, MAX_ITEMS)
    .query(`INSERT INTO lms_grade_items (course_id, category_id, title, source_type, source_id, max_points, weight, released, position, created_by_source, created_by)
      OUTPUT INSERTED.id, INSERTED.category_id, INSERTED.title, INSERTED.source_type, INSERTED.source_id, INSERTED.max_points, INSERTED.weight, INSERTED.released, INSERTED.position
      SELECT @c, @k, @t, 'manual', NULL, @m, @w, @rel, ISNULL(@p, (SELECT ISNULL(MAX(position), 0) + 1 FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL)), @src, @uid
      WHERE (SELECT COUNT(*) FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL) < @lim`);
  const row = r.recordset && r.recordset[0];
  if (!row) return { ok: false, code: "ITEM_LIMIT", errors: [`A course can have at most ${MAX_ITEMS} grade items.`] };
  await audit(pool, actor, "gradebook.item_created", "lms_grade_items", row.id, { courseId });
  return { ok: true, item: itemShape(row) };
}

async function updateItem(pool, user, courseId, itemId, body) {
  const actor = actorOf(user); if (!actor) return notFound();
  const id = posInt(itemId); if (!id) return notFound("Item");
  const v = validateItem(body, { partial: true }); if (!v.ok) return v;
  const cur = await loadItem(pool, courseId, id); if (!cur) return notFound("Item");
  if (cur.source_type !== "manual" && v.value.maxPoints !== undefined) return { ok: false, code: "LINKED_ITEM_MAX", errors: ["The maximum of a linked item follows its assignment or quiz and cannot be changed here."] };
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const x = v.value;
  if (x.categoryId && !(await loadCategory(pool, courseId, x.categoryId))) return { ok: false, errors: ["That category does not exist in this course."] };
  if (x.maxPoints !== undefined) {
    const over = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, id).input("m", sql.Decimal(8, 2), x.maxPoints)
      .query(`SELECT TOP 1 id FROM lms_grades WHERE item_id = @i AND course_id = @c AND points > @m`);
    if (over.recordset && over.recordset[0]) return { ok: false, code: "GRADES_EXCEED_MAX", errors: ["Some learners already have more points than this new maximum. Change those grades first."] };
  }
  const sets = [], rq = pool.request().input("c", sql.Int, courseId).input("i", sql.Int, id).input("now", sql.DateTime2, new Date());
  if (x.title !== undefined) { sets.push("title = @t"); rq.input("t", sql.NVarChar(200), x.title); }
  if (x.maxPoints !== undefined) { sets.push("max_points = @m"); rq.input("m", sql.Decimal(8, 2), x.maxPoints); }
  if (x.weight !== undefined) { sets.push("weight = @w"); rq.input("w", sql.Decimal(6, 2), x.weight); }
  if (x.released !== undefined) { sets.push("released = @rel"); rq.input("rel", sql.Bit, x.released ? 1 : 0); }
  if (x.categoryId !== undefined) { sets.push("category_id = @k"); rq.input("k", sql.Int, x.categoryId); }
  if (x.position !== undefined) { sets.push("position = @p"); rq.input("p", sql.Int, x.position); }
  const r = await rq.query(`UPDATE lms_grade_items SET ${sets.join(", ")}, updated_at = @now
    OUTPUT INSERTED.id, INSERTED.category_id, INSERTED.title, INSERTED.source_type, INSERTED.source_id, INSERTED.max_points, INSERTED.weight, INSERTED.released, INSERTED.position
    WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("Item");
  await audit(pool, actor, "gradebook.item_updated", "lms_grade_items", id, { courseId, fields: Object.keys(x) });
  return { ok: true, item: itemShape(row) };
}

async function deleteItem(pool, user, courseId, itemId) {
  const actor = actorOf(user); if (!actor) return notFound();
  const id = posInt(itemId); if (!id) return notFound("Item");
  if (!(await loadItem(pool, courseId, id))) return notFound("Item");
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const r = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, id).input("now", sql.DateTime2, new Date())
    .query(`UPDATE lms_grade_items SET deleted_at = @now, updated_at = @now OUTPUT INSERTED.id WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Item");
  await audit(pool, actor, "gradebook.item_deleted", "lms_grade_items", id, { courseId });
  return { ok: true, deleted: true };
}

/* ------------------------------ grade entry ------------------------------- */
async function setGrade(pool, user, courseId, itemId, studentId, body, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const iid = posInt(itemId); if (!iid) return notFound("Item");
  const sid = posInt(studentId); if (!sid) return notFound("Student");
  const item = await loadItem(pool, courseId, iid); if (!item) return notFound("Item");
  const v = validateGrade(body, item.max_points); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const en = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 student_id FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s AND status = 'active'`);
  if (!(en.recordset && en.recordset[0])) return notFound("Student");
  const ex = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, iid).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 id, points, excused, hidden, comment FROM lms_grades WHERE item_id = @i AND course_id = @c AND student_id = @s`);
  const existing = (ex.recordset && ex.recordset[0]) || null;
  const plan = planGrade(existing, v.value);
  if (existing && !plan.changed) return { ok: true, unchanged: true, grade: gradeShape(existing.points, existing.excused, existing.hidden, existing.comment) };
  if (plan.needsReason && !v.value.reason) return { ok: false, errors: ["reason is required when an entered grade is changed."] };
  const n = plan.next, why = v.value.reason || null;
  const rq = pool.request().input("c", sql.Int, courseId).input("i", sql.Int, iid).input("s", sql.Int, sid).input("now", sql.DateTime2, now)
    .input("p", sql.Decimal(8, 2), n.points).input("e", sql.Bit, n.excused ? 1 : 0).input("h", sql.Bit, n.hidden ? 1 : 0).input("cm", sql.NVarChar(1000), n.comment)
    .input("why", sql.NVarChar(300), why).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
  let batch;
  if (existing) {
    rq.input("g", sql.Int, existing.id).input("op", sql.Decimal(8, 2), plan.old.points).input("oe", sql.Bit, plan.old.excused ? 1 : 0).input("oh", sql.Bit, plan.old.hidden ? 1 : 0).input("oc", sql.NVarChar(1000), plan.old.comment);
    batch = `SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT = 0;
      UPDATE lms_grades SET points = @p, excused = @e, hidden = @h, comment = @cm, graded_by_source = @src, graded_by = @uid, updated_at = @now
        WHERE id = @g AND item_id = @i AND course_id = @c AND student_id = @s AND ISNULL(points, -1) = ISNULL(@op, -1) AND excused = @oe AND hidden = @oh AND ISNULL(comment, N'') = ISNULL(@oc, N'');
      SET @n = @@ROWCOUNT;
      IF @n = 1 INSERT INTO lms_grade_history (grade_id, item_id, course_id, student_id, old_points, new_points, old_excused, new_excused, reason, changed_by_source, changed_by, changed_at)
        VALUES (@g, @i, @c, @s, @op, @p, @oe, @e, @why, @src, @uid, @now);
      COMMIT; SELECT @n AS n;`;
  } else {
    batch = `SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @n INT = 0, @gid INT;
      IF NOT EXISTS (SELECT 1 FROM lms_grades WHERE item_id = @i AND student_id = @s)
      BEGIN
        INSERT INTO lms_grades (item_id, course_id, student_id, points, excused, comment, hidden, graded_by_source, graded_by, created_at, updated_at) VALUES (@i, @c, @s, @p, @e, @cm, @h, @src, @uid, @now, @now);
        SET @gid = SCOPE_IDENTITY(); SET @n = 1;
        INSERT INTO lms_grade_history (grade_id, item_id, course_id, student_id, old_points, new_points, old_excused, new_excused, reason, changed_by_source, changed_by, changed_at)
          VALUES (@gid, @i, @c, @s, NULL, @p, NULL, @e, @why, @src, @uid, @now);
      END
      COMMIT; SELECT @n AS n;`;
  }
  let res;
  try { res = await rq.query(batch); } catch (e) { if (isDup(e)) return changed409(); throw e; }
  const row = res.recordset && res.recordset[0]; if (!row || !Number(row.n)) return changed409();
  await audit(pool, actor, "gradebook.grade_set", "lms_grade_items", iid, { courseId, studentId: sid, oldPoints: plan.old.points, newPoints: n.points, excused: n.excused, hidden: n.hidden, reason: why });
  if (tenant) events.emit("lms.grade.entered", { tenant, courseId, itemId: iid, studentId: sid });
  return { ok: true, unchanged: false, grade: gradeShape(n.points, n.excused, n.hidden, n.comment) };
}
const gradeShape = (points, excused, hidden, comment) => ({ points: points === null || points === undefined ? null : Number(points), excused: !!excused, hidden: !!hidden, comment: comment || null });

async function gradeHistory(pool, courseId, itemId, studentId) {
  const iid = posInt(itemId), sid = posInt(studentId); if (!iid || !sid) return notFound();
  if (!(await loadItem(pool, courseId, iid))) return notFound("Item");
  const r = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, iid).input("s", sql.Int, sid)
    .query(`SELECT TOP ${MAX_HISTORY} id, old_points, new_points, old_excused, new_excused, reason, changed_by_source, changed_by, changed_at
      FROM lms_grade_history WHERE item_id = @i AND course_id = @c AND student_id = @s ORDER BY id DESC`);
  return { ok: true, history: (r.recordset || []).map((h) => ({ id: h.id, oldPoints: h.old_points === null || h.old_points === undefined ? null : Number(h.old_points), newPoints: h.new_points === null || h.new_points === undefined ? null : Number(h.new_points),
    oldExcused: h.old_excused === null || h.old_excused === undefined ? null : !!h.old_excused, newExcused: h.new_excused === null || h.new_excused === undefined ? null : !!h.new_excused,
    reason: h.reason || null, changedBy: { source: h.changed_by_source || null, id: h.changed_by ?? null }, changedAt: iso(h.changed_at) })) };
}

/* --------------------------------- the grid ------------------------------- */
async function listGradebook(pool, courseId, { page, pageSize } = {}) {
  const size = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(pageSize, 10) || 30)), pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const c = () => pool.request().input("c", sql.Int, courseId);
  const [cats, items, cnt] = await Promise.all([
    c().query(`SELECT TOP ${MAX_CATEGORIES} ${CAT_COLS} FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_ITEMS} ${ITEM_COLS} FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT COUNT(*) AS n FROM lms_course_enrolments WHERE course_id = @c AND status = 'active'`),
  ]);
  const categories = (cats.recordset || []).map(catShape), itemList = (items.recordset || []).map(itemShape);
  const total = Number(cnt.recordset && cnt.recordset[0] && cnt.recordset[0].n) || 0;
  const learnersRes = await c().input("off", sql.Int, (pg - 1) * size).input("size", sql.Int, size)
    .query(`SELECT e.student_id, st.name AS student_name, st.admissionNo AS admission_no
      FROM lms_course_enrolments e LEFT JOIN Students st ON st.id = e.student_id
      WHERE e.course_id = @c AND e.status = 'active' ORDER BY st.name, e.student_id OFFSET @off ROWS FETCH NEXT @size ROWS ONLY`);
  const learners = learnersRes.recordset || [];
  const byStudent = new Map();
  if (learners.length && itemList.length) {
    const g = await c().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(learners.map((l) => l.student_id)))
      .query(`SELECT TOP ${MAX_ITEMS * MAX_PAGE} g.item_id, g.student_id, g.points, g.excused, g.hidden, g.comment
        FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL
        WHERE g.course_id = @c AND g.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`);
    for (const r of g.recordset || []) { if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []); byStudent.get(r.student_id).push({ itemId: r.item_id, points: r.points === null || r.points === undefined ? null : Number(r.points), excused: !!r.excused, hidden: !!r.hidden, hasComment: !!r.comment }); }
  }
  const calcItems = itemList.map((i) => ({ id: i.id, categoryId: i.categoryId, maxPoints: i.maxPoints, weight: i.weight, released: i.released }));
  const rows = learners.map((l) => {
    const grades = byStudent.get(l.student_id) || [];
    const t = computeTotal({ categories, items: calcItems, grades, viewer: "staff" });
    const map = {}; for (const x of grades) map[x.itemId] = { points: x.points, excused: x.excused, hidden: x.hidden, hasComment: x.hasComment };
    return { studentId: l.student_id, name: l.student_name || null, admissionNo: l.admission_no || null, grades: map, percent: t.percent, categories: t.categories, itemsCounted: t.itemsCounted, itemsLeftOut: t.itemsLeftOut };
  });
  return { ok: true, categories, items: itemList, learners: rows, total, page: pg, pageSize: size, hasMore: pg * size < total };
}

module.exports = { loadItem, loadCategory, ITEM_COLS, itemShape, MAX_CATEGORIES, MAX_ITEMS, MAX_PAGE, dec2, validateCategory, validateItem, validateGrade, planGrade,
  createCategory, updateCategory, deleteCategory, createItem, updateItem, deleteItem, setGrade, gradeHistory, listGradebook };
