/* =========================================================================
   LMS COURSES  (L2.1)

   Pure validation + data functions. Routes (routes/lms.js) own authorisation;
   this file never decides WHO may act, only whether the data is valid and the
   status move is allowed. Every query is parameterised and every list is
   paginated (rules 7, 8). Plain text only: description/objectives are stored
   as text and must be rendered as text (never as HTML) by the UI.

   Status model (L2.5 adds "pending" through the approval workflow):
     draft -> published   (blocked while courseApprovalRequired: use approval)
     published -> draft   (unpublish)
     draft | published -> archived,   archived -> draft (restore)
   "pending" can never be set through the generic update.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const events = require("./lmsEvents");
const { actorOf } = require("./lmsPermissions");

const VISIBILITY = ["enrolled_only", "listed"];
const SETTABLE_STATUS = ["draft", "published", "archived"];
const FIELDS = ["code", "title", "description", "objectives", "academicYear", "semester", "className", "programme", "cohort", "subjectId", "visibility"];
const CODE_RE = /^[A-Z0-9][A-Z0-9._\- ]{1,29}$/;

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim();
const intIn = (v, min, max) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/* Pure. partial=false (create) requires code, title, academicYear. Returns { ok, errors, value }. */
function validateCourseInput(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key) && !(partial && key === "status")) errors.push(`Unknown field "${key}".`);
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const optText = (k, max, fn = oneLine) => {
    if (!has(k)) return;
    if (body[k] === null || body[k] === "") { value[k] = null; return; }
    const t = fn(body[k]);
    if (t.length > max) errors.push(`${k} must be at most ${max} characters.`); else value[k] = t || null;
  };

  if (has("code") || !partial) {
    const c = oneLine(body.code).toUpperCase();
    if (!CODE_RE.test(c)) errors.push("code is required: 2-30 characters, letters, digits, space . _ - (starting with a letter or digit).");
    else value.code = c;
  }
  if (has("title") || !partial) {
    const t = oneLine(body.title);
    if (t.length < 3 || t.length > 200) errors.push("title is required: 3-200 characters."); else value.title = t;
  }
  if (has("academicYear") || !partial) {
    const y = intIn(body.academicYear, 2000, 2100);
    if (y === null) errors.push("academicYear is required: a year between 2000 and 2100."); else value.academicYear = y;
  }
  optText("description", 4000, multiLine);
  optText("semester", 30); optText("className", 50); optText("programme", 100); optText("cohort", 60);
  if (has("subjectId")) {
    if (body.subjectId === null) value.subjectId = null;
    else { const n = intIn(body.subjectId, 1, 2147483647); if (n === null) errors.push("subjectId must be a positive integer or null."); else value.subjectId = n; }
  }
  if (has("objectives")) {
    if (body.objectives === null) value.objectives = [];
    else if (!Array.isArray(body.objectives) || body.objectives.length > 20) errors.push("objectives must be a list of at most 20 items.");
    else {
      const list = body.objectives.map(oneLine).filter(Boolean);
      if (list.some((o) => o.length > 300)) errors.push("Each objective must be at most 300 characters."); else value.objectives = list;
    }
  }
  if (has("visibility")) { if (!VISIBILITY.includes(body.visibility)) errors.push(`visibility must be one of ${VISIBILITY.join(", ")}.`); else value.visibility = body.visibility; }
  if (partial && has("status")) {
    if (body.status === "pending") errors.push("A course can only become pending by being submitted for approval.");
    else if (!SETTABLE_STATUS.includes(body.status)) errors.push(`status must be one of ${SETTABLE_STATUS.join(", ")}.`);
    else value.status = body.status;
  }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to update.");
  return { ok: errors.length === 0, errors, value };
}

/* Pure. Returns { ok } or { ok:false, code, message }. */
function canTransition(from, to, { approvalRequired = false } = {}) {
  if (from === to) return { ok: true };
  if (from === "pending") return { ok: false, code: "COURSE_PENDING", message: "This course is waiting for approval." };
  if (to === "published") {
    if (from !== "draft") return { ok: false, code: "BAD_TRANSITION", message: `A ${from} course cannot be published directly.` };
    if (approvalRequired) return { ok: false, code: "APPROVAL_REQUIRED", message: "This school requires approval before a course is published." };
    return { ok: true };
  }
  if (to === "archived") return from === "draft" || from === "published" ? { ok: true } : { ok: false, code: "BAD_TRANSITION", message: `A ${from} course cannot be archived.` };
  if (to === "draft") return from === "published" || from === "archived" ? { ok: true } : { ok: false, code: "BAD_TRANSITION", message: `A ${from} course cannot move to draft.` };
  return { ok: false, code: "BAD_TRANSITION", message: "That status change is not allowed." };
}

const isDuplicateKey = (err) => err && (err.number === 2601 || err.number === 2627);
const parseObjectives = (json) => { try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const shape = (r) => ({
  id: r.id, code: r.code, title: r.title, description: r.description || "", objectives: parseObjectives(r.objectives_json),
  academicYear: r.academic_year, semester: r.semester || null, className: r.class_name || null, programme: r.programme || null,
  cohort: r.cohort || null, subjectId: r.subject_id ?? null, visibility: r.visibility, status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at || null, archivedAt: r.archived_at || null,
  ...(r.my_role !== undefined ? { myRole: r.my_role } : {}),
});

async function subjectExists(pool, subjectId) {
  const r = await pool.request().input("id", sql.Int, subjectId).query(`SELECT TOP 1 id FROM subjects WHERE id = @id`);
  return !!(r.recordset && r.recordset.length);
}

/* Creates the course (always draft) and the creator's owner row atomically (one batch). */
async function createCourse(pool, user, body, tenant = null) {
  const v = validateCourseInput(body);
  if (!v.ok) return { ok: false, errors: v.errors };
  const actor = actorOf(user);
  if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const c = v.value;
  if (c.subjectId != null && !(await subjectExists(pool, c.subjectId))) return { ok: false, errors: ["subjectId does not exist."] };
  try {
    const r = await pool.request()
      .input("code", sql.NVarChar(30), c.code).input("title", sql.NVarChar(200), c.title)
      .input("desc", sql.NVarChar(sql.MAX), c.description ?? null)
      .input("obj", sql.NVarChar(sql.MAX), JSON.stringify(c.objectives || []))
      .input("year", sql.Int, c.academicYear).input("sem", sql.NVarChar(30), c.semester ?? null)
      .input("cls", sql.NVarChar(50), c.className ?? null).input("prog", sql.NVarChar(100), c.programme ?? null)
      .input("coh", sql.NVarChar(60), c.cohort ?? null).input("subj", sql.Int, c.subjectId ?? null)
      .input("vis", sql.NVarChar(20), c.visibility || "enrolled_only")
      .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
      .query(`
        SET XACT_ABORT ON;
        DECLARE @new TABLE (id INT);
        BEGIN TRAN;
          INSERT INTO lms_courses (code, title, description, objectives_json, academic_year, semester, class_name, programme, cohort, subject_id, visibility, status, created_by_source, created_by)
          OUTPUT INSERTED.id INTO @new
          VALUES (@code, @title, @desc, @obj, @year, @sem, @cls, @prog, @coh, @subj, @vis, 'draft', @src, @uid);
          INSERT INTO lms_course_staff (course_id, user_source, user_id, staff_role, is_active)
          SELECT id, @src, @uid, 'teacher', 1 FROM @new;
        COMMIT;
        SELECT id FROM @new;`);
    const id = r.recordset && r.recordset[0] && r.recordset[0].id;
    if (!id) return { ok: false, errors: ["The course could not be created."] };
    await audit(pool, actor, "course.created", "lms_courses", id, { code: c.code, academicYear: c.academicYear });
    if (tenant) events.emit("lms.course.created", { tenant, courseId: id });
    return { ok: true, id };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: [`A course with code ${c.code} already exists for ${c.academicYear}.`] };
    throw err;
  }
}

const escapeLike = (s) => String(s).replace(/[\\%_\[]/g, (m) => `\\${m}`);

/* Paginated list. scope "mine" = courses the actor is staff on; "all" = every course (caller must be an LMS admin). */
async function listCourses(pool, user, { scope = "mine", q = "", status = "", academicYear = null, page = 1, pageSize = 20 } = {}) {
  const actor = actorOf(user);
  if (!actor) return { items: [], total: 0, page: 1, pageSize: 20 };
  const size = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const where = ["c.deleted_at IS NULL"];
  const req = pool.request();
  let join = "";
  if (scope === "all") join = `LEFT JOIN lms_course_staff m ON m.course_id = c.id AND m.user_source = @src AND m.user_id = @uid AND m.is_active = 1`;
  else { join = `INNER JOIN lms_course_staff m ON m.course_id = c.id AND m.user_source = @src AND m.user_id = @uid AND m.is_active = 1`; }
  req.input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
  if (status) { if (![...SETTABLE_STATUS, "pending"].includes(status)) return { items: [], total: 0, page: pg, pageSize: size }; where.push("c.status = @status"); req.input("status", sql.NVarChar(20), status); }
  const year = academicYear == null || academicYear === "" ? null : intIn(academicYear, 2000, 2100);
  if (year !== null) { where.push("c.academic_year = @year"); req.input("year", sql.Int, year); }
  const term = oneLine(q).slice(0, 100);
  if (term) { where.push("(c.title LIKE @q ESCAPE '\\' OR c.code LIKE @q ESCAPE '\\')"); req.input("q", sql.NVarChar(210), `%${escapeLike(term)}%`); }
  req.input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const r = await req.query(`
    SELECT c.id, c.code, c.title, c.description, c.objectives_json, c.academic_year, c.semester, c.class_name, c.programme, c.cohort,
           c.subject_id, c.visibility, c.status, c.created_at, c.updated_at, c.published_at, c.archived_at,
           m.staff_role AS my_role, COUNT(*) OVER() AS total_count
    FROM lms_courses c ${join}
    WHERE ${where.join(" AND ")}
    ORDER BY c.academic_year DESC, c.title ASC, c.id ASC
    OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map(shape), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

async function loadCourse(pool, courseId) {
  const r = await pool.request().input("id", sql.Int, courseId).query(`
    SELECT id, code, title, description, objectives_json, academic_year, semester, class_name, programme, cohort, subject_id,
           visibility, status, created_at, updated_at, published_at, archived_at
    FROM lms_courses WHERE id = @id AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}

/* Course + its staff (names only: never SELECT * from legacy tables, they hold password columns). */
async function getCourse(pool, courseId) {
  const row = await loadCourse(pool, courseId);
  if (!row) return null;
  const s = await pool.request().input("id", sql.Int, courseId).query(`
    SELECT TOP 50 s.user_source, s.user_id, s.staff_role, COALESCE(t.name, u.name) AS name
    FROM lms_course_staff s
    LEFT JOIN Teachers t ON s.user_source = 'Teachers' AND t.id = s.user_id
    LEFT JOIN users u ON s.user_source = 'Users' AND u.id = s.user_id
    WHERE s.course_id = @id AND s.is_active = 1
    ORDER BY s.staff_role, s.id`);
  return { ...shape(row), staff: (s.recordset || []).map((x) => ({ source: x.user_source, id: x.user_id, role: x.staff_role === "co_teacher" ? "co_teacher" : "owner", name: x.name || null })) };
}

/* Partial update. ctx = { approvalRequired, tenant }. Returns { ok } | { ok:false, errors|code, status? }. */
async function updateCourse(pool, user, courseId, patch, ctx = {}) {
  const v = validateCourseInput(patch, { partial: true });
  if (!v.ok) return { ok: false, errors: v.errors };
  const row = await loadCourse(pool, courseId);
  if (!row) return { ok: false, notFound: true, errors: ["Course not found."] };
  const { status: newStatus, ...fields } = v.value;
  if (row.status === "archived" && Object.keys(fields).length) return { ok: false, code: "COURSE_ARCHIVED", errors: ["An archived course must be restored before it can be edited."] };
  if (row.status === "pending" && Object.keys(fields).length) return { ok: false, code: "COURSE_PENDING", errors: ["This course is waiting for approval."] };
  if (newStatus) { const t = canTransition(row.status, newStatus, { approvalRequired: !!ctx.approvalRequired }); if (!t.ok) return { ok: false, code: t.code, errors: [t.message] }; }
  if (fields.subjectId != null && !(await subjectExists(pool, fields.subjectId))) return { ok: false, errors: ["subjectId does not exist."] };

  const sets = [], req = pool.request().input("id", sql.Int, courseId);
  const col = { code: ["code", sql.NVarChar(30)], title: ["title", sql.NVarChar(200)], description: ["description", sql.NVarChar(sql.MAX)], academicYear: ["academic_year", sql.Int], semester: ["semester", sql.NVarChar(30)], className: ["class_name", sql.NVarChar(50)], programme: ["programme", sql.NVarChar(100)], cohort: ["cohort", sql.NVarChar(60)], subjectId: ["subject_id", sql.Int], visibility: ["visibility", sql.NVarChar(20)] };
  for (const [k, val] of Object.entries(fields)) {
    if (k === "objectives") { sets.push("objectives_json = @p_obj"); req.input("p_obj", sql.NVarChar(sql.MAX), JSON.stringify(val)); continue; }
    const [name, type] = col[k]; sets.push(`${name} = @p_${k}`); req.input(`p_${k}`, type, val);
  }
  if (newStatus && newStatus !== row.status) {
    sets.push("status = @p_status"); req.input("p_status", sql.NVarChar(20), newStatus);
    if (newStatus === "published") sets.push("published_at = SYSUTCDATETIME()");
    sets.push(newStatus === "archived" ? "archived_at = SYSUTCDATETIME()" : "archived_at = NULL");
  }
  if (!sets.length) return { ok: true, unchanged: true };
  sets.push("updated_at = SYSUTCDATETIME()");
  try { await req.query(`UPDATE lms_courses SET ${sets.join(", ")} WHERE id = @id AND deleted_at IS NULL`); }
  catch (err) { if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: ["Another course already uses that code for this academic year."] }; throw err; }
  const actor = actorOf(user);
  const action = newStatus && newStatus !== row.status ? `course.${newStatus === "draft" ? (row.status === "archived" ? "restored" : "unpublished") : newStatus}` : "course.updated";
  await audit(pool, actor, action, "lms_courses", courseId, { fields: Object.keys(fields), from: row.status, to: newStatus || row.status });
  if (ctx.tenant && newStatus === "published" && row.status !== "published") events.emit("lms.course.published", { tenant: ctx.tenant, courseId });
  return { ok: true };
}

/* Soft delete. Only draft or archived courses: a live course must be archived first. */
async function deleteCourse(pool, user, courseId) {
  const row = await loadCourse(pool, courseId);
  if (!row) return { ok: false, notFound: true, errors: ["Course not found."] };
  if (row.status !== "draft" && row.status !== "archived") return { ok: false, code: "COURSE_NOT_DELETABLE", errors: ["Archive the course before deleting it."] };
  await pool.request().input("id", sql.Int, courseId).query(`UPDATE lms_courses SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE id = @id AND deleted_at IS NULL`);
  await audit(pool, actorOf(user), "course.deleted", "lms_courses", courseId, { code: row.code, status: row.status });
  return { ok: true };
}

module.exports = { subjectExists, VISIBILITY, SETTABLE_STATUS, validateCourseInput, canTransition, createCourse, listCourses, getCourse, updateCourse, deleteCourse, escapeLike };
