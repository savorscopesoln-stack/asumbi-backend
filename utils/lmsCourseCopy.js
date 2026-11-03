/* =========================================================================
   LMS COURSE COPYING  (L2.4): templates, duplicate course, academic-year rollover

   Same contract as lmsCourses.js: authorisation lives in the routes; this file
   validates and queries. Every query is parameterised; every list/run is bounded.

   What is copied (decision D-027):
     - course details (title, description, objectives, semester, programme, class,
       cohort, subject, visibility) and the live CONTENT SECTIONS, in order;
     - the new course is ALWAYS a draft, and its dates/status/publish history are new.
   What is NOT copied: calendar events (their dates would be stale), enrolments
   (unless a rollover is explicitly asked to), audit history, and - for duplicate
   and templates - staff other than the person making the copy.
   Lessons, files and quizzes arrive in later phases and will be added to the copy
   steps then.

   A TEMPLATE never stores year, code, class, cohort, subject or people: those are
   different every time it is used. It is private to its creator unless shared with
   the school. Templates are soft-deleted.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const events = require("./lmsEvents");
const { actorOf } = require("./lmsPermissions");
const { validateCourseInput, subjectExists, escapeLike } = require("./lmsCourses");

const MAX_SECTIONS = 100, MAX_TEMPLATES = 500, MAX_ROLLOVER = 200, MAX_TEMPLATE_JSON = 200000;

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
const isDuplicateKey = (err) => err && (err.number === 2601 || err.number === 2627);
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : fallback; } catch { return fallback; } };

/* ------------------------------ templates ------------------------------ */
function validateTemplateInput(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["name", "description", "shared"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "name" in body) { const n = oneLine(body.name); if (n.length < 3 || n.length > 120) errors.push("name is required: 3-120 characters."); else value.name = n; }
  if ("description" in body) { if (body.description === null || body.description === "") value.description = null; else { const d = oneLine(body.description); if (d.length > 500) errors.push("description must be at most 500 characters."); else value.description = d; } }
  if ("shared" in body) { if (typeof body.shared !== "boolean") errors.push("shared must be true or false."); else value.shared = body.shared; }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to update.");
  return { ok: !errors.length, errors, value };
}

/* Re-sanitises stored template content on every read (the JSON column is data, never trusted). */
function readContent(json) {
  const c = parseJson(json, {}), course = isPlainObject(c.course) ? c.course : {};
  const obj = Array.isArray(course.objectives) ? course.objectives.map(oneLine).filter(Boolean).slice(0, 20) : [];
  const sections = (Array.isArray(c.sections) ? c.sections : [])
    .map((s) => ({ title: oneLine(s && s.title).slice(0, 200), summary: s && s.summary ? oneLine(s.summary).slice(0, 1000) : null })).filter((s) => s.title).slice(0, MAX_SECTIONS);
  return {
    course: {
      description: course.description ? String(course.description).slice(0, 4000) : null, objectives: obj,
      semester: course.semester ? oneLine(course.semester).slice(0, 30) : null, programme: course.programme ? oneLine(course.programme).slice(0, 100) : null,
      visibility: course.visibility === "listed" ? "listed" : "enrolled_only",
    },
    sections,
  };
}

const shapeTemplate = (r, actor) => ({
  id: r.id, name: r.name, description: r.description || null, shared: !!r.is_shared, sourceCourseId: r.source_course_id ?? null,
  mine: !!actor && r.created_by_source === actor.source && r.created_by === actor.id, createdAt: r.created_at, updatedAt: r.updated_at,
});

/* Snapshot of a course for a template: details + live sections only. */
async function saveAsTemplate(pool, user, courseId, body) {
  const v = validateTemplateInput(body); if (!v.ok) return { ok: false, errors: v.errors };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const c = await pool.request().input("id", sql.Int, courseId).query(`SELECT TOP 1 description, objectives_json, semester, programme, visibility FROM lms_courses WHERE id = @id AND deleted_at IS NULL`);
  const row = c.recordset && c.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Course not found."] };
  const n = await pool.request().query(`SELECT COUNT(*) AS n FROM lms_course_templates WHERE deleted_at IS NULL`);
  if ((n.recordset?.[0]?.n || 0) >= MAX_TEMPLATES) return { ok: false, code: "LIMIT_REACHED", errors: [`The school can have at most ${MAX_TEMPLATES} templates.`] };
  const s = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP ${MAX_SECTIONS} title, summary FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL ORDER BY sort_order, id`);
  const content = JSON.stringify(readContent(JSON.stringify({ course: { description: row.description, objectives: parseJson(row.objectives_json, []), semester: row.semester, programme: row.programme, visibility: row.visibility }, sections: s.recordset || [] })));
  if (content.length > MAX_TEMPLATE_JSON) return { ok: false, errors: ["This course is too large to save as a template."] };
  try {
    const r = await pool.request().input("n", sql.NVarChar(120), v.value.name).input("d", sql.NVarChar(500), v.value.description ?? null).input("sh", sql.Bit, v.value.shared ? 1 : 0)
      .input("cid", sql.Int, courseId).input("j", sql.NVarChar(sql.MAX), content).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
      .query(`INSERT INTO lms_course_templates (name, description, is_shared, source_course_id, content_json, created_by_source, created_by)
              OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.is_shared, INSERTED.source_course_id, INSERTED.created_by_source, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
              VALUES (@n, @d, @sh, @cid, @j, @src, @uid)`);
    const t = r.recordset && r.recordset[0]; if (!t) return { ok: false, errors: ["The template could not be saved."] };
    await audit(pool, actor, "template.created", "lms_course_templates", t.id, { courseId, shared: !!v.value.shared });
    return { ok: true, template: shapeTemplate(t, actor) };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: ["You already have a template with that name."] };
    throw err;
  }
}

const VISIBLE = `t.deleted_at IS NULL AND (@admin = 1 OR t.is_shared = 1 OR (t.created_by_source = @src AND t.created_by = @uid))`;

async function listTemplates(pool, user, { isAdmin = false, q = "", page = 1, pageSize = 20 } = {}) {
  const actor = actorOf(user); if (!actor) return { items: [], total: 0, page: 1, pageSize: 20 };
  const size = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20)), pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const req = pool.request().input("admin", sql.Bit, isAdmin ? 1 : 0).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
  const where = [VISIBLE], term = oneLine(q).slice(0, 100);
  if (term) { where.push("t.name LIKE @q ESCAPE '\\'"); req.input("q", sql.NVarChar(210), `%${escapeLike(term)}%`); }
  req.input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const r = await req.query(`SELECT t.id, t.name, t.description, t.is_shared, t.source_course_id, t.created_by_source, t.created_by, t.created_at, t.updated_at, COUNT(*) OVER() AS total_count
    FROM lms_course_templates t WHERE ${where.join(" AND ")} ORDER BY t.name ASC, t.id ASC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map((x) => shapeTemplate(x, actor)), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

async function loadVisibleTemplate(pool, actor, id, isAdmin) {
  const r = await pool.request().input("id", sql.Int, id).input("admin", sql.Bit, isAdmin ? 1 : 0).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
    .query(`SELECT TOP 1 t.id, t.name, t.description, t.is_shared, t.source_course_id, t.content_json, t.created_by_source, t.created_by, t.created_at, t.updated_at
            FROM lms_course_templates t WHERE t.id = @id AND ${VISIBLE}`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}

async function getTemplate(pool, user, id, isAdmin = false) {
  const actor = actorOf(user); if (!actor) return null;
  const row = await loadVisibleTemplate(pool, actor, id, isAdmin); if (!row) return null;
  return { ...shapeTemplate(row, actor), content: readContent(row.content_json) };
}

/* Creator or LMS administrator only. A template someone else shared looks "not found" to you for edits. */
async function updateTemplate(pool, user, id, patch, isAdmin = false) {
  const v = validateTemplateInput(patch, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const sets = [], req = pool.request().input("id", sql.Int, id).input("admin", sql.Bit, isAdmin ? 1 : 0).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
  if ("name" in v.value) { sets.push("name = @n"); req.input("n", sql.NVarChar(120), v.value.name); }
  if ("description" in v.value) { sets.push("description = @d"); req.input("d", sql.NVarChar(500), v.value.description); }
  if ("shared" in v.value) { sets.push("is_shared = @sh"); req.input("sh", sql.Bit, v.value.shared ? 1 : 0); }
  sets.push("updated_at = SYSUTCDATETIME()");
  try {
    const r = await req.query(`UPDATE lms_course_templates SET ${sets.join(", ")}
      OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.is_shared, INSERTED.source_course_id, INSERTED.created_by_source, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
      WHERE id = @id AND deleted_at IS NULL AND (@admin = 1 OR (created_by_source = @src AND created_by = @uid))`);
    const t = r.recordset && r.recordset[0]; if (!t) return { ok: false, notFound: true, errors: ["Template not found."] };
    await audit(pool, actor, "template.updated", "lms_course_templates", id, { fields: Object.keys(v.value) });
    return { ok: true, template: shapeTemplate(t, actor) };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: ["You already have a template with that name."] };
    throw err;
  }
}

async function deleteTemplate(pool, user, id, isAdmin = false) {
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const r = await pool.request().input("id", sql.Int, id).input("admin", sql.Bit, isAdmin ? 1 : 0).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
    .query(`UPDATE lms_course_templates SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id
            WHERE id = @id AND deleted_at IS NULL AND (@admin = 1 OR (created_by_source = @src AND created_by = @uid))`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Template not found."] };
  await audit(pool, actor, "template.deleted", "lms_course_templates", id, {});
  return { ok: true };
}

/* New draft course from a template. body = { templateId, code, title, academicYear, ...optional course fields }. */
async function createFromTemplate(pool, user, body, { isAdmin = false, tenant = null } = {}) {
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const { templateId, ...rest } = body;
  const tid = posInt(templateId); if (!tid) return { ok: false, errors: ["templateId must be a positive integer."] };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const t = await loadVisibleTemplate(pool, actor, tid, isAdmin); if (!t) return { ok: false, notFound: true, errors: ["Template not found."] };
  const content = readContent(t.content_json);
  const defaults = { description: content.course.description, objectives: content.course.objectives, semester: content.course.semester, programme: content.course.programme, visibility: content.course.visibility };
  const v = validateCourseInput({ ...defaults, ...rest }); if (!v.ok) return { ok: false, errors: v.errors };
  const c = v.value;
  if (c.subjectId != null && !(await subjectExists(pool, c.subjectId))) return { ok: false, errors: ["subjectId does not exist."] };
  const req = pool.request()
    .input("code", sql.NVarChar(30), c.code).input("title", sql.NVarChar(200), c.title).input("desc", sql.NVarChar(sql.MAX), c.description ?? null)
    .input("obj", sql.NVarChar(sql.MAX), JSON.stringify(c.objectives || [])).input("year", sql.Int, c.academicYear).input("sem", sql.NVarChar(30), c.semester ?? null)
    .input("cls", sql.NVarChar(50), c.className ?? null).input("prog", sql.NVarChar(100), c.programme ?? null).input("coh", sql.NVarChar(60), c.cohort ?? null)
    .input("subj", sql.Int, c.subjectId ?? null).input("vis", sql.NVarChar(20), c.visibility || "enrolled_only")
    .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
  const secSql = content.sections.map((s, i) => {
    req.input(`st${i}`, sql.NVarChar(200), s.title).input(`ss${i}`, sql.NVarChar(1000), s.summary ?? null);
    return `INSERT INTO lms_course_sections (course_id, title, summary, sort_order, created_by_source, created_by) SELECT id, @st${i}, @ss${i}, ${(i + 1) * 10}, @src, @uid FROM @new;`;
  }).join("\n");
  try {
    const r = await req.query(`
      SET XACT_ABORT ON;
      DECLARE @new TABLE (id INT);
      BEGIN TRAN;
        INSERT INTO lms_courses (code, title, description, objectives_json, academic_year, semester, class_name, programme, cohort, subject_id, visibility, status, created_by_source, created_by)
        OUTPUT INSERTED.id INTO @new
        VALUES (@code, @title, @desc, @obj, @year, @sem, @cls, @prog, @coh, @subj, @vis, 'draft', @src, @uid);
        INSERT INTO lms_course_staff (course_id, user_source, user_id, staff_role, is_active) SELECT id, @src, @uid, 'teacher', 1 FROM @new;
        ${secSql}
      COMMIT;
      SELECT id FROM @new;`);
    const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return { ok: false, errors: ["The course could not be created."] };
    await audit(pool, actor, "course.created_from_template", "lms_courses", id, { templateId: tid, code: c.code, academicYear: c.academicYear, sections: content.sections.length });
    if (tenant) events.emit("lms.course.created", { tenant, courseId: id });
    return { ok: true, id, sections: content.sections.length };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: [`A course with code ${c.code} already exists for ${c.academicYear}.`] };
    throw err;
  }
}

/* ------------------------------ duplicate ------------------------------ */
/* body = { code (required), title?, academicYear? }. Copies details + live sections as a new DRAFT owned by the caller. */
async function duplicateCourse(pool, user, sourceId, body, tenant = null) {
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const extra = Object.keys(body).filter((k) => !["code", "title", "academicYear"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field "${extra[0]}".`] };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const src = await pool.request().input("id", sql.Int, sourceId).query(`SELECT TOP 1 title, academic_year FROM lms_courses WHERE id = @id AND deleted_at IS NULL`);
  const row = src.recordset && src.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Course not found."] };
  const v = validateCourseInput({ code: body.code, title: body.title ?? `${row.title} (copy)`.slice(0, 200), academicYear: body.academicYear ?? row.academic_year });
  if (!v.ok) return { ok: false, errors: v.errors };
  try {
    const r = await pool.request().input("src_id", sql.Int, sourceId).input("code", sql.NVarChar(30), v.value.code).input("title", sql.NVarChar(200), v.value.title).input("year", sql.Int, v.value.academicYear)
      .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).query(`
      SET XACT_ABORT ON;
      DECLARE @new TABLE (id INT);
      BEGIN TRAN;
        INSERT INTO lms_courses (code, title, description, objectives_json, academic_year, semester, class_name, programme, cohort, subject_id, visibility, status, created_by_source, created_by)
        OUTPUT INSERTED.id INTO @new
        SELECT @code, @title, description, objectives_json, @year, semester, class_name, programme, cohort, subject_id, visibility, 'draft', @src, @uid
        FROM lms_courses WHERE id = @src_id AND deleted_at IS NULL;
        INSERT INTO lms_course_staff (course_id, user_source, user_id, staff_role, is_active) SELECT id, @src, @uid, 'teacher', 1 FROM @new;
        INSERT INTO lms_course_sections (course_id, title, summary, sort_order, created_by_source, created_by)
        SELECT n.id, s.title, s.summary, s.sort_order, @src, @uid FROM @new n INNER JOIN lms_course_sections s ON s.course_id = @src_id AND s.deleted_at IS NULL;
      COMMIT;
      SELECT id FROM @new;`);
    const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return { ok: false, notFound: true, errors: ["Course not found."] };
    await audit(pool, actor, "course.duplicated", "lms_courses", id, { fromCourseId: sourceId, code: v.value.code, academicYear: v.value.academicYear });
    if (tenant) events.emit("lms.course.created", { tenant, courseId: id });
    return { ok: true, id };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, conflict: true, errors: [`A course with code ${v.value.code} already exists for ${v.value.academicYear}.`] };
    throw err;
  }
}

/* ------------------------------ rollover ------------------------------- */
function validateRollover(body) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["fromYear", "toYear", "courseIds", "copyStaff", "copyEnrolments", "dryRun"].includes(k)) errors.push(`Unknown field "${k}".`);
  const yr = (x) => { const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x; return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null; };
  const f = yr(body.fromYear), t = yr(body.toYear);
  if (f === null || t === null) errors.push("fromYear and toYear are required: years between 2000 and 2100."); else if (t <= f) errors.push("toYear must be later than fromYear."); else { value.fromYear = f; value.toYear = t; }
  for (const k of ["copyStaff", "copyEnrolments", "dryRun"]) if (k in body && typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`);
  value.copyStaff = body.copyStaff !== false; value.copyEnrolments = body.copyEnrolments === true; value.dryRun = body.dryRun === true;
  if ("courseIds" in body && body.courseIds !== null) {
    if (!Array.isArray(body.courseIds) || !body.courseIds.length || body.courseIds.length > MAX_ROLLOVER) errors.push(`courseIds must be a list of 1-${MAX_ROLLOVER} course ids.`);
    else { const ids = body.courseIds.map(posInt); if (ids.some((x) => x === null)) errors.push("courseIds must be positive integers."); else value.courseIds = [...new Set(ids)]; }
  }
  return { ok: !errors.length, errors, value };
}

/* Copies the school's non-archived, non-deleted courses of fromYear into toYear as DRAFTS.
   Same code in the target year = skipped (never overwritten). One transaction per course, so a failure
   affects only that course. dryRun reports the plan and writes nothing. LMS administrators only (route). */
async function rolloverCourses(pool, user, body, tenant = null) {
  const v = validateRollover(body); if (!v.ok) return { ok: false, errors: v.errors };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const o = v.value;
  const req = pool.request().input("from", sql.Int, o.fromYear);
  let idFilter = "";
  if (o.courseIds) { idFilter = ` AND c.id IN (${o.courseIds.map((id, i) => { req.input(`i${i}`, sql.Int, id); return `@i${i}`; }).join(", ")})`; }
  const r = await req.query(`SELECT TOP ${MAX_ROLLOVER + 1} c.id, c.code, c.title FROM lms_courses c
    WHERE c.deleted_at IS NULL AND c.academic_year = @from AND c.status <> 'archived'${idFilter} ORDER BY c.code, c.id`);
  const sources = r.recordset || [];
  if (sources.length > MAX_ROLLOVER) return { ok: false, code: "TOO_MANY", errors: [`More than ${MAX_ROLLOVER} courses match. Roll over in batches using courseIds.`] };
  if (!sources.length) return { ok: true, dryRun: o.dryRun, summary: { planned: 0, created: 0, skipped: 0, failed: 0 }, courses: [] };

  const ex = pool.request().input("to", sql.Int, o.toYear);
  const taken = await ex.query(`SELECT TOP ${MAX_ROLLOVER * 2} code FROM lms_courses WHERE deleted_at IS NULL AND academic_year = @to AND code IN (${sources.map((s, i) => { ex.input(`k${i}`, sql.NVarChar(30), s.code); return `@k${i}`; }).join(", ")})`);
  const exists = new Set((taken.recordset || []).map((x) => String(x.code).toUpperCase()));

  const out = [], summary = { planned: sources.length, created: 0, skipped: 0, failed: 0 };
  for (const s of sources) {
    const item = { sourceId: s.id, code: s.code, title: s.title };
    if (exists.has(String(s.code).toUpperCase())) { out.push({ ...item, result: "skipped", reason: "CODE_EXISTS" }); summary.skipped += 1; continue; }
    if (o.dryRun) { out.push({ ...item, result: "would_create" }); continue; }
    try {
      const q = pool.request().input("src_id", sql.Int, s.id).input("to", sql.Int, o.toYear).input("as", sql.NVarChar(20), actor.source).input("ai", sql.Int, actor.id)
        .input("detail", sql.NVarChar(300), `Rolled over from course ${s.id} (${o.fromYear})`);
      const staffSql = o.copyStaff ? `INSERT INTO lms_course_staff (course_id, user_source, user_id, staff_role, is_active)
          SELECT n.id, st.user_source, st.user_id, st.staff_role, 1 FROM @new n INNER JOIN lms_course_staff st ON st.course_id = @src_id AND st.is_active = 1;` : "";
      const enrolSql = o.copyEnrolments ? `INSERT INTO lms_course_enrolments (course_id, student_id, status, source, created_by_source, created_by)
          SELECT n.id, e.student_id, 'active', 'rollover', @as, @ai FROM @new n
          INNER JOIN lms_course_enrolments e ON e.course_id = @src_id AND e.status = 'active'
          INNER JOIN Students stu ON stu.id = e.student_id AND stu.status = 'active';
        INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, detail, actor_source, actor_id)
          SELECT en.course_id, en.student_id, 'enrolled', NULL, 'active', @detail, @as, @ai FROM lms_course_enrolments en INNER JOIN @new n ON n.id = en.course_id;` : "";
      const res = await q.query(`
        SET XACT_ABORT ON;
        DECLARE @new TABLE (id INT);
        BEGIN TRAN;
          INSERT INTO lms_courses (code, title, description, objectives_json, academic_year, semester, class_name, programme, cohort, subject_id, visibility, status, created_by_source, created_by)
          OUTPUT INSERTED.id INTO @new
          SELECT c.code, c.title, c.description, c.objectives_json, @to, c.semester, c.class_name, c.programme, c.cohort, c.subject_id, c.visibility, 'draft', @as, @ai
          FROM lms_courses c WHERE c.id = @src_id AND c.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM lms_courses x WHERE x.academic_year = @to AND x.code = c.code AND x.deleted_at IS NULL);
          INSERT INTO lms_course_sections (course_id, title, summary, sort_order, created_by_source, created_by)
            SELECT n.id, sec.title, sec.summary, sec.sort_order, @as, @ai FROM @new n INNER JOIN lms_course_sections sec ON sec.course_id = @src_id AND sec.deleted_at IS NULL;
          ${staffSql}
          ${enrolSql}
        COMMIT;
        SELECT n.id,
          (SELECT COUNT(*) FROM lms_course_sections WHERE course_id = n.id AND deleted_at IS NULL) AS sections,
          (SELECT COUNT(*) FROM lms_course_enrolments WHERE course_id = n.id) AS enrolments
        FROM @new n;`);
      const row = res.recordset && res.recordset[0];
      if (!row) { out.push({ ...item, result: "skipped", reason: "CODE_EXISTS" }); summary.skipped += 1; continue; }
      out.push({ ...item, result: "created", newCourseId: row.id, sections: row.sections || 0, enrolments: o.copyEnrolments ? row.enrolments || 0 : 0 }); summary.created += 1;
      await audit(pool, actor, "course.rolled_over", "lms_courses", row.id, { fromCourseId: s.id, fromYear: o.fromYear, toYear: o.toYear, copyStaff: o.copyStaff, copyEnrolments: o.copyEnrolments });
      if (tenant) events.emit("lms.course.created", { tenant, courseId: row.id });
    } catch (err) {
      if (isDuplicateKey(err)) { out.push({ ...item, result: "skipped", reason: "CODE_EXISTS" }); summary.skipped += 1; }
      else { console.error("LMS ROLLOVER course failed:", err.message); out.push({ ...item, result: "failed", reason: "ERROR" }); summary.failed += 1; }
    }
  }
  if (!o.dryRun) await audit(pool, actor, "rollover.run", "lms_courses", null, { fromYear: o.fromYear, toYear: o.toYear, ...summary });
  return { ok: true, dryRun: o.dryRun, summary, courses: out };
}

module.exports = { MAX_ROLLOVER, MAX_TEMPLATES, validateTemplateInput, readContent, saveAsTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate, createFromTemplate, duplicateCourse, validateRollover, rolloverCourses, posInt };
