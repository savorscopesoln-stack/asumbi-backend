/* =========================================================================
   LMS ASSIGNMENTS  (L5.1a)  the assignment DEFINITION: what is asked, when, and how work may be handed in.
   Submissions, files, marking and grades are later units (L5.2+); this unit has no student-written data.

   Rules (documented, simple):
   - An assignment belongs to one course (and optionally one of its sections). Course staff (owner / co-teacher / LMS admin) with
     `lms.course.manage` create, edit, publish, unpublish and delete. Archived or pending courses are read-only (same rule as lessons).
   - status: draft (staff only) | published. Students see a published assignment only once `availableFrom` has passed, only in a
     PUBLISHED or archived (read-only) course, and only with an ACTIVE enrolment (checked by the route). Drafts and not-yet-available ones
     are invisible to them, including in the planner.
   - Dates are ISO 8601 WITH a time zone. availableFrom <= dueAt <= cutoffAt. All optional. cutoffAt = the final closing time for the
     accept/penalise policies; with policy `block` the assignment closes at dueAt, so a cutoffAt is refused.
   - submissionType: text | files | both. allowedExtensions / maxFileMb may only NARROW what the school allows (settings.files); null = use the school's.
     maxFiles 1-10, maxAttempts 1-10, maxPoints 1-1000 (2 decimals).
   - latePolicy accept | penalise | block, latePenaltyPercent 0-100: null = the school's default (settings). `effective` in every staff/student
     answer shows the values that will really apply, so nobody has to guess.
   - workMode is `individual` or `group` (L8.4a, D-102). A group assignment needs maxAttempts 1 and submissionType text, and its workMode cannot change once any work exists.
   - Instructions are PLAIN TEXT (1-8000 chars, line breaks kept, tags stripped) and must be shown as text. Attachments are files already in THIS
     school's lms upload folder (max 10).
   - Max 300 live assignments per course. Delete = soft delete; refused (HAS_SUBMISSIONS) once any student has handed in work (L5.2a).
   - Publishing emits `lms.assignment.published` ({tenant, courseId, assignmentId}); nobody subscribes yet.
   Authorisation lives in the routes; every query is parameterised and every course query also matches course_id.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const lessons = require("./lmsLessons");
const events = require("./lmsEvents");

const MAX_PER_COURSE = 300, MAX_ATTACHMENTS = 10, MAX_EXT = 20;
const STATUSES = ["draft", "published"], SUBMISSION_TYPES = ["text", "files", "both"], LATE_POLICIES = ["accept", "penalise", "block"];
const KEYS = ["title", "instructions", "sectionId", "status", "availableFrom", "dueAt", "cutoffAt", "submissionType", "allowedExtensions", "maxFileMb", "maxFiles", "maxAttempts", "latePolicy", "latePenaltyPercent", "maxPoints", "workMode", "attachments"];
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
const intIn = (v, lo, hi) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });

/* ISO 8601 with an explicit time zone, between year 2000 and 3 years ahead. Returns a Date or null. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function isoDate(v, now = new Date()) {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const d = new Date(v); if (Number.isNaN(d.getTime())) return null;
  return d >= new Date("2000-01-01T00:00:00Z") && d <= new Date(now.getTime() + 3 * 365 * 864e5) ? d : null;
}

/* Pure. Field-level checks only; cross-field and settings checks are in `check`. */
function validate(body, { partial = false, tenant, now = new Date() } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!KEYS.includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if (!partial || "instructions" in body) { const t = multiLine(body.instructions); if (t.length < 1 || t.length > 8000) errors.push("instructions are required: 1-8000 characters of plain text."); else value.instructions = t; }
  if ("sectionId" in body) { if (body.sectionId === null) value.sectionId = null; else { const n = posInt(body.sectionId); if (n === null) errors.push("sectionId must be a section id or null."); else value.sectionId = n; } }
  if ("status" in body) { if (!STATUSES.includes(body.status)) errors.push('status must be "draft" or "published".'); else value.status = body.status; }
  for (const k of ["availableFrom", "dueAt", "cutoffAt"]) if (k in body) {
    if (body[k] === null) value[k] = null; else { const d = isoDate(body[k], now); if (!d) errors.push(`${k} must be a date and time in ISO 8601 with a time zone (for example 2026-11-02T17:00:00+03:00), or null.`); else value[k] = d; }
  }
  if ("submissionType" in body) { if (!SUBMISSION_TYPES.includes(body.submissionType)) errors.push(`submissionType must be one of ${SUBMISSION_TYPES.join(", ")}.`); else value.submissionType = body.submissionType; }
  if ("allowedExtensions" in body) {
    if (body.allowedExtensions === null) value.allowedExtensions = null;
    else if (!Array.isArray(body.allowedExtensions) || body.allowedExtensions.length < 1 || body.allowedExtensions.length > MAX_EXT) errors.push(`allowedExtensions must be null or a list of 1-${MAX_EXT} file extensions.`);
    else { const x = body.allowedExtensions.map((e) => String(e ?? "").trim().toLowerCase().replace(/^\./, "")); if (x.some((e) => !/^[a-z0-9]{1,8}$/.test(e))) errors.push("allowedExtensions: use letters and digits only, for example pdf."); else value.allowedExtensions = [...new Set(x)]; }
  }
  if ("maxFileMb" in body) { if (body.maxFileMb === null) value.maxFileMb = null; else { const n = intIn(body.maxFileMb, 1, 200); if (n === null) errors.push("maxFileMb must be a whole number 1-200, or null."); else value.maxFileMb = n; } }
  if ("maxFiles" in body) { const n = intIn(body.maxFiles, 1, 10); if (n === null) errors.push("maxFiles must be a whole number 1-10."); else value.maxFiles = n; }
  if ("maxAttempts" in body) { const n = intIn(body.maxAttempts, 1, 10); if (n === null) errors.push("maxAttempts must be a whole number 1-10."); else value.maxAttempts = n; }
  if ("latePolicy" in body) { if (body.latePolicy === null) value.latePolicy = null; else if (!LATE_POLICIES.includes(body.latePolicy)) errors.push(`latePolicy must be null or one of ${LATE_POLICIES.join(", ")}.`); else value.latePolicy = body.latePolicy; }
  if ("latePenaltyPercent" in body) { if (body.latePenaltyPercent === null) value.latePenaltyPercent = null; else { const n = intIn(body.latePenaltyPercent, 0, 100); if (n === null) errors.push("latePenaltyPercent must be a whole number 0-100, or null."); else value.latePenaltyPercent = n; } }
  if ("maxPoints" in body) { const n = typeof body.maxPoints === "string" && body.maxPoints.trim() !== "" ? Number(body.maxPoints) : body.maxPoints; if (typeof n !== "number" || !Number.isFinite(n) || n < 1 || n > 1000 || Math.round(n * 100) / 100 !== n) errors.push("maxPoints must be a number 1-1000 with at most 2 decimals."); else value.maxPoints = n; }
  if ("workMode" in body) { if (body.workMode !== "individual" && body.workMode !== "group") errors.push('workMode must be "individual" or "group".'); else value.workMode = body.workMode; }
  if ("attachments" in body) {
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS) errors.push(`attachments must be a list of at most ${MAX_ATTACHMENTS} files.`);
    else {
      const out = [];
      for (const a of body.attachments) {
        const url = isPlainObject(a) ? lessons.localMediaUrl(a.url, tenant) : null;
        if (!url) { errors.push("Each attachment must be a file uploaded to this school's LMS media library."); break; }
        const name = oneLine(a.name || url.split("/").pop()).slice(0, 150);
        out.push({ url, name: name || "file" });
      }
      if (!errors.length) value.attachments = out;
    }
  }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Send at least one field to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* Pure. The values that will really apply (school defaults filled in). */
function effectiveOf(a, settings) {
  const files = settings?.files || {};
  const policy = a.latePolicy || settings?.lateSubmission || "accept";
  return {
    latePolicy: policy,
    latePenaltyPercent: policy === "penalise" ? (a.latePenaltyPercent ?? settings?.latePenaltyPercent ?? 0) : null,
    allowedExtensions: a.submissionType === "text" ? [] : (a.allowedExtensions || files.allowedExtensions || []),
    maxFileMb: a.submissionType === "text" ? null : (a.maxFileMb || files.maxFileMb || null),
  };
}

/* Pure. Cross-field and school-settings rules on the MERGED assignment. */
function check(m, settings) {
  const errors = [], files = settings?.files || {};
  if (m.availableFrom && m.dueAt && m.availableFrom > m.dueAt) errors.push("availableFrom must be before dueAt.");
  if (m.dueAt && m.cutoffAt && m.cutoffAt < m.dueAt) errors.push("cutoffAt cannot be before dueAt.");
  if (m.availableFrom && m.cutoffAt && m.availableFrom > m.cutoffAt) errors.push("availableFrom must be before cutoffAt.");
  if (m.cutoffAt && !m.dueAt) errors.push("A cutoffAt needs a dueAt.");
  if (m.workMode === "group") { // D-102: one hand-in per group, text only for now
    if (m.maxAttempts !== 1) errors.push("A group assignment allows exactly one attempt (maxAttempts 1).");
    if (m.submissionType !== "text") errors.push('A group assignment is handed in as text only for now (submissionType "text").');
  }
  const eff = effectiveOf(m, settings);
  if (eff.latePolicy === "block" && m.cutoffAt) errors.push("With late policy block the work closes at dueAt, so cutoffAt must be empty.");
  if (eff.latePolicy === "block" && !m.dueAt) errors.push("Late policy block needs a dueAt.");
  if (eff.latePolicy === "penalise" && !m.dueAt) errors.push("Late policy penalise needs a dueAt.");
  if (m.allowedExtensions && files.allowedExtensions) { const bad = m.allowedExtensions.filter((e) => !files.allowedExtensions.includes(e)); if (bad.length) errors.push(`These file types are not allowed by the school: ${bad.join(", ")}.`); }
  if (m.maxFileMb && files.maxFileMb && m.maxFileMb > files.maxFileMb) errors.push(`maxFileMb cannot exceed the school limit of ${files.maxFileMb} MB.`);
  return errors;
}

const COLS = "id, course_id, section_id, title, instructions, status, published_at, available_from, due_at, cutoff_at, submission_type, allowed_extensions, max_file_mb, max_files, max_attempts, late_policy, late_penalty_percent, max_points, work_mode, attachments_json, created_at, updated_at";
const parseJson = (t, fb) => { try { const v = JSON.parse(t); return v ?? fb; } catch { return fb; } };
const safeDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const iso = (d) => { const x = safeDate(d); return x ? x.toISOString() : null; };
/* Row -> the API's own shape (model for merging and for answers). */
function model(r) {
  return {
    id: r.id, courseId: r.course_id, sectionId: r.section_id ?? null, title: r.title, instructions: r.instructions, status: r.status, publishedAt: iso(r.published_at),
    availableFrom: safeDate(r.available_from), dueAt: safeDate(r.due_at), cutoffAt: safeDate(r.cutoff_at),
    submissionType: r.submission_type, allowedExtensions: r.allowed_extensions ? parseJson(r.allowed_extensions, null) : null, maxFileMb: r.max_file_mb ?? null, maxFiles: r.max_files, maxAttempts: r.max_attempts,
    latePolicy: r.late_policy ?? null, latePenaltyPercent: r.late_penalty_percent ?? null, maxPoints: Number(r.max_points), workMode: r.work_mode, attachments: r.attachments_json ? parseJson(r.attachments_json, []) : [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
const outDates = (m) => ({ ...m, availableFrom: iso(m.availableFrom), dueAt: iso(m.dueAt), cutoffAt: iso(m.cutoffAt) });
const staffShape = (r, settings) => { const m = model(r); return { ...outDates(m), effective: effectiveOf(m, settings) }; };
/* Students never receive status, authorship or timestamps. */
const studentShape = (r, settings) => {
  const m = model(r);
  return { id: m.id, courseId: m.courseId, sectionId: m.sectionId, title: m.title, instructions: m.instructions, availableFrom: iso(m.availableFrom), dueAt: iso(m.dueAt), cutoffAt: iso(m.cutoffAt), submissionType: m.submissionType,
    maxFiles: m.maxFiles, maxAttempts: m.maxAttempts, maxPoints: m.maxPoints, workMode: m.workMode, attachments: m.attachments, effective: effectiveOf(m, settings) };
};

const sectionOk = async (pool, courseId, sectionId) => {
  if (sectionId == null) return true;
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sectionId).query(`SELECT TOP 1 id FROM lms_course_sections WHERE id = @s AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
};

/* ------------------------------ staff ------------------------------------ */
async function createAssignment(pool, user, courseId, body, { tenant, settings, now = new Date() } = {}) {
  const v = validate(body, { tenant, now }); if (!v.ok) return { ok: false, errors: v.errors };
  const m = { submissionType: "both", maxFiles: 5, maxAttempts: 1, maxPoints: 100, workMode: "individual", status: "draft", attachments: [], allowedExtensions: null, maxFileMb: null, latePolicy: null, latePenaltyPercent: null, sectionId: null, availableFrom: null, dueAt: null, cutoffAt: null, ...v.value };
  const bad = check(m, settings); if (bad.length) return { ok: false, errors: bad };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (!(await sectionOk(pool, courseId, m.sectionId))) return { ok: false, errors: ["That section is not part of this course."] };
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_assignments WHERE course_id = @c AND deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= MAX_PER_COURSE) return { ok: false, code: "ASSIGNMENT_LIMIT", errors: [`A course can have at most ${MAX_PER_COURSE} assignments.`] };
  const actor = actorOf(user), pub = m.status === "published";
  const r = await pool.request().input("c", sql.Int, courseId).input("sec", sql.Int, m.sectionId).input("t", sql.NVarChar(200), m.title).input("ins", sql.NVarChar(sql.MAX), m.instructions)
    .input("st", sql.NVarChar(20), m.status).input("af", sql.DateTime2, m.availableFrom).input("due", sql.DateTime2, m.dueAt).input("cut", sql.DateTime2, m.cutoffAt)
    .input("sty", sql.NVarChar(10), m.submissionType).input("ext", sql.NVarChar(400), m.allowedExtensions ? JSON.stringify(m.allowedExtensions) : null).input("mfm", sql.Int, m.maxFileMb)
    .input("mf", sql.Int, m.maxFiles).input("ma", sql.Int, m.maxAttempts).input("lp", sql.NVarChar(10), m.latePolicy).input("lpp", sql.Int, m.latePenaltyPercent)
    .input("pts", sql.Decimal(7, 2), m.maxPoints).input("wm", sql.NVarChar(10), m.workMode).input("att", sql.NVarChar(sql.MAX), m.attachments.length ? JSON.stringify(m.attachments) : null)
    .input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
    .query(`INSERT INTO lms_assignments (course_id, section_id, title, instructions, status, published_at, available_from, due_at, cutoff_at, submission_type, allowed_extensions, max_file_mb, max_files, max_attempts, late_policy, late_penalty_percent, max_points, work_mode, attachments_json, created_by_source, created_by)
      OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
      VALUES (@c, @sec, @t, @ins, @st, CASE WHEN @st = 'published' THEN SYSUTCDATETIME() ELSE NULL END, @af, @due, @cut, @sty, @ext, @mfm, @mf, @ma, @lp, @lpp, @pts, @wm, @att, @src, @uid)`);
  const row = r.recordset[0];
  await audit(pool, actor, "assignment.created", "lms_assignments", row.id, { courseId, status: row.status });
  if (pub && tenant) events.emit("lms.assignment.published", { tenant, courseId, assignmentId: row.id });
  return { ok: true, assignment: staffShape(row, settings) };
}

async function listForStaff(pool, courseId, opts = {}, settings) {
  const { size, pg } = paging(opts), req = pool.request().input("c", sql.Int, courseId).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  let cond = "course_id = @c AND deleted_at IS NULL";
  if (STATUSES.includes(opts.status)) { cond += " AND status = @st"; req.input("st", sql.NVarChar(20), opts.status); }
  const r = await req.query(`SELECT ${COLS}, COUNT(*) OVER() AS total_count FROM lms_assignments WHERE ${cond}
    ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map((x) => staffShape(x, settings)), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

async function loadOne(pool, courseId, id) {
  const r = await pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId).query(`SELECT TOP 1 ${COLS} FROM lms_assignments WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
async function getOne(pool, courseId, id, settings) {
  const row = await loadOne(pool, courseId, id);
  return row ? { ok: true, assignment: staffShape(row, settings) } : { ok: false, notFound: true, errors: ["Assignment not found."] };
}

async function updateAssignment(pool, user, courseId, id, body, { tenant, settings, now = new Date() } = {}) {
  const v = validate(body, { partial: true, tenant, now }); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const cur = await loadOne(pool, courseId, id); if (!cur) return { ok: false, notFound: true, errors: ["Assignment not found."] };
  const before = model(cur), merged = { ...before, ...v.value };
  const bad = check(merged, settings); if (bad.length) return { ok: false, errors: bad };
  if ("sectionId" in v.value && !(await sectionOk(pool, courseId, v.value.sectionId))) return { ok: false, errors: ["That section is not part of this course."] };
  if ("workMode" in v.value && v.value.workMode !== before.workMode) {
    const used = await pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @id AND course_id = @c`);
    if (used.recordset && used.recordset.length) return { ok: false, code: "HAS_SUBMISSIONS", errors: ["Work already exists for this assignment, so its work mode cannot change."] };
  }
  const same = (a, b) => JSON.stringify(a instanceof Date ? a.toISOString() : a) === JSON.stringify(b instanceof Date ? b.toISOString() : b);
  const changed = Object.keys(v.value).filter((k) => !same(v.value[k], before[k]));
  if (!changed.length) return { ok: true, assignment: staffShape(cur, settings), unchanged: true };
  const MAP = { title: ["title", sql.NVarChar(200)], instructions: ["instructions", sql.NVarChar(sql.MAX)], sectionId: ["section_id", sql.Int], status: ["status", sql.NVarChar(20)], availableFrom: ["available_from", sql.DateTime2], dueAt: ["due_at", sql.DateTime2], cutoffAt: ["cutoff_at", sql.DateTime2],
    submissionType: ["submission_type", sql.NVarChar(10)], allowedExtensions: ["allowed_extensions", sql.NVarChar(400)], maxFileMb: ["max_file_mb", sql.Int], maxFiles: ["max_files", sql.Int], maxAttempts: ["max_attempts", sql.Int],
    latePolicy: ["late_policy", sql.NVarChar(10)], latePenaltyPercent: ["late_penalty_percent", sql.Int], maxPoints: ["max_points", sql.Decimal(7, 2)], workMode: ["work_mode", sql.NVarChar(10)], attachments: ["attachments_json", sql.NVarChar(sql.MAX)] };
  const req = pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId), sets = [];
  for (const k of changed) {
    const [col, type] = MAP[k]; let val = v.value[k];
    if (k === "allowedExtensions") val = val ? JSON.stringify(val) : null; if (k === "attachments") val = val && val.length ? JSON.stringify(val) : null;
    sets.push(`${col} = @p_${col}`); req.input(`p_${col}`, type, val);
  }
  const publishing = changed.includes("status") && v.value.status === "published";
  if (publishing) sets.push("published_at = COALESCE(published_at, SYSUTCDATETIME())");
  const r = await req.query(`UPDATE lms_assignments SET ${sets.join(", ")}, updated_at = SYSUTCDATETIME()
    OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")} WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Assignment not found."] };
  await audit(pool, actorOf(user), "assignment.updated", "lms_assignments", id, { courseId, changed });
  if (publishing && tenant) events.emit("lms.assignment.published", { tenant, courseId, assignmentId: id });
  return { ok: true, assignment: staffShape(row, settings) };
}

async function deleteAssignment(pool, user, courseId, id) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  // L5.2a: handed-in work is never orphaned. Drafts alone do not block (they are not work handed in).
  const used = await pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @id AND course_id = @c AND status = 'submitted'`);
  if (used.recordset && used.recordset.length) return { ok: false, code: "HAS_SUBMISSIONS", errors: ["Students have handed in work for this assignment, so it cannot be deleted. Unpublish it instead."] };
  const r = await pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId)
    .query(`UPDATE lms_assignments SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Assignment not found."] };
  await audit(pool, actorOf(user), "assignment.deleted", "lms_assignments", id, { courseId });
  return { ok: true };
}

/* ------------------------------ students --------------------------------- */
/* The route guarantees an ACTIVE enrolment. A student sees only published assignments that are already available. */
const AVAILABLE = `a.status = 'published' AND a.deleted_at IS NULL AND (a.available_from IS NULL OR a.available_from <= SYSUTCDATETIME())`;
async function listForStudentCourse(pool, courseId, opts = {}, settings) {
  if (!(await lessons.studentCourseOpen(pool, courseId))) return { ok: false, notFound: true, errors: ["Course not found."] };
  const { size, pg } = paging(opts);
  const r = await pool.request().input("c", sql.Int, courseId).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size)
    .query(`SELECT ${COLS.split(", ").map((c) => `a.${c}`).join(", ")}, COUNT(*) OVER() AS total_count FROM lms_assignments a WHERE a.course_id = @c AND ${AVAILABLE}
      ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at, a.id OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map((x) => studentShape(x, settings)), total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}
async function getForStudent(pool, courseId, id, settings) {
  if (!(await lessons.studentCourseOpen(pool, courseId))) return { ok: false, notFound: true, errors: ["Course not found."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, id)
    .query(`SELECT TOP 1 ${COLS.split(", ").map((c) => `a.${c}`).join(", ")} FROM lms_assignments a WHERE a.id = @id AND a.course_id = @c AND ${AVAILABLE}`);
  const row = r.recordset && r.recordset[0];
  return row ? { ok: true, assignment: studentShape(row, settings) } : { ok: false, notFound: true, errors: ["Assignment not found."] };
}

module.exports = { MAX_PER_COURSE, MAX_ATTACHMENTS, AVAILABLE, COLS, isoDate, validate, check, effectiveOf, model, createAssignment, listForStaff, getOne, updateAssignment, deleteAssignment, listForStudentCourse, getForStudent };
