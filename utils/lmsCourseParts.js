/* =========================================================================
   LMS COURSE PARTS  (L2.2): content sections, co-teachers, course calendar

   Same contract as lmsCourses.js: authorisation lives in the routes; this file
   validates and queries. EVERY row lookup is scoped by course_id as well as its
   own id, so a section/event id belonging to another course (or tenant) can
   never be read or changed by guessing it. Archived/pending courses are
   read-only. Text is plain text; render it as text.
   "Sections" = the ordered content sections of a course (lessons arrive in L3).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");

const MAX_SECTIONS = 100, MAX_CO_TEACHERS = 10, MAX_EVENTS_PER_COURSE = 2000;
const EVENT_TYPES = ["event", "deadline", "lesson", "exam"];
const STAFF_SOURCES = ["Teachers", "Users"];
const MAX_WINDOW_DAYS = 400;

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
const isDuplicateKey = (err) => err && (err.number === 2601 || err.number === 2627);

/* The course must exist, be live, and be editable (not archived/pending). */
async function courseState(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0].status : null;
}
async function editable(pool, courseId) {
  const st = await courseState(pool, courseId);
  if (!st) return { ok: false, notFound: true, errors: ["Course not found."] };
  if (st === "archived") return { ok: false, code: "COURSE_ARCHIVED", errors: ["An archived course must be restored before it can be changed."] };
  if (st === "pending") return { ok: false, code: "COURSE_PENDING", errors: ["This course is waiting for approval."] };
  return { ok: true };
}

/* ------------------------------- sections ------------------------------- */
function validateSection(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["title", "summary"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if ("summary" in body) { if (body.summary === null || body.summary === "") value.summary = null; else { const t = oneLine(body.summary); if (t.length > 1000) errors.push("summary must be at most 1000 characters."); else value.summary = t; } }
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to update.");
  return { ok: !errors.length, errors, value };
}
const shapeSection = (r) => ({ id: r.id, courseId: r.course_id, title: r.title, summary: r.summary || null, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at });

async function listSections(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`
    SELECT TOP ${MAX_SECTIONS} id, course_id, title, summary, sort_order, created_at, updated_at
    FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL ORDER BY sort_order, id`);
  return (r.recordset || []).map(shapeSection);
}

async function createSection(pool, user, courseId, body) {
  const v = validateSection(body); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL`);
  if ((n.recordset?.[0]?.n || 0) >= MAX_SECTIONS) return { ok: false, code: "LIMIT_REACHED", errors: [`A course can have at most ${MAX_SECTIONS} sections.`] };
  const actor = actorOf(user);
  const r = await pool.request().input("c", sql.Int, courseId).input("t", sql.NVarChar(200), v.value.title).input("s", sql.NVarChar(1000), v.value.summary ?? null)
    .input("src", sql.NVarChar(20), actor?.source ?? null).input("uid", sql.Int, actor?.id ?? null)
    .query(`INSERT INTO lms_course_sections (course_id, title, summary, sort_order, created_by_source, created_by)
            OUTPUT INSERTED.id, INSERTED.course_id, INSERTED.title, INSERTED.summary, INSERTED.sort_order, INSERTED.created_at, INSERTED.updated_at
            SELECT @c, @t, @s, ISNULL(MAX(sort_order), 0) + 10, @src, @uid FROM lms_course_sections WHERE course_id = @c`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, errors: ["The section could not be created."] };
  await audit(pool, actor, "section.created", "lms_course_sections", row.id, { courseId });
  return { ok: true, section: shapeSection(row) };
}

async function updateSection(pool, user, courseId, sectionId, patch) {
  const v = validateSection(patch, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const sets = [], req = pool.request().input("c", sql.Int, courseId).input("id", sql.Int, sectionId);
  if ("title" in v.value) { sets.push("title = @t"); req.input("t", sql.NVarChar(200), v.value.title); }
  if ("summary" in v.value) { sets.push("summary = @s"); req.input("s", sql.NVarChar(1000), v.value.summary); }
  sets.push("updated_at = SYSUTCDATETIME()");
  const r = await req.query(`UPDATE lms_course_sections SET ${sets.join(", ")}
    OUTPUT INSERTED.id, INSERTED.course_id, INSERTED.title, INSERTED.summary, INSERTED.sort_order, INSERTED.created_at, INSERTED.updated_at
    WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Section not found."] };
  await audit(pool, actorOf(user), "section.updated", "lms_course_sections", sectionId, { courseId, fields: Object.keys(v.value) });
  return { ok: true, section: shapeSection(row) };
}

async function deleteSection(pool, user, courseId, sectionId) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, sectionId)
    .query(`UPDATE lms_course_sections SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Section not found."] };
  await audit(pool, actorOf(user), "section.deleted", "lms_course_sections", sectionId, { courseId });
  return { ok: true };
}

/* ids must be EXACTLY the course's live sections, once each (no foreign or missing ids). */
async function reorderSections(pool, user, courseId, ids) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (!Array.isArray(ids) || ids.length > MAX_SECTIONS) return { ok: false, errors: ["ids must be a list of section ids."] };
  const list = ids.map(posInt);
  if (list.some((x) => x === null) || new Set(list).size !== list.length) return { ok: false, errors: ["ids must be unique positive integers."] };
  const cur = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP ${MAX_SECTIONS} id FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL`);
  const have = new Set((cur.recordset || []).map((x) => x.id));
  if (have.size !== list.length || list.some((x) => !have.has(x))) return { ok: false, code: "ORDER_MISMATCH", errors: ["The list must contain every section of this course exactly once."] };
  if (!list.length) return { ok: true };
  const req = pool.request().input("c", sql.Int, courseId);
  const stmts = list.map((id, i) => { req.input(`i${i}`, sql.Int, id).input(`o${i}`, sql.Int, (i + 1) * 10); return `UPDATE lms_course_sections SET sort_order = @o${i}, updated_at = SYSUTCDATETIME() WHERE id = @i${i} AND course_id = @c;`; });
  await req.query(`SET XACT_ABORT ON; BEGIN TRAN; ${stmts.join(" ")} COMMIT;`);
  await audit(pool, actorOf(user), "section.reordered", "lms_courses", courseId, { count: list.length });
  return { ok: true };
}

/* ------------------------------- co-teachers ------------------------------ */
function validateStaffInput(body) {
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const extra = Object.keys(body).filter((k) => !["source", "id"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field "${extra[0]}".`] };
  if (!STAFF_SOURCES.includes(body.source)) return { ok: false, errors: [`source must be one of ${STAFF_SOURCES.join(", ")}.`] };
  const id = posInt(body.id); if (id === null) return { ok: false, errors: ["id must be a positive integer."] };
  return { ok: true, value: { source: body.source, id } };
}

/* Existence check reads explicit columns only (legacy tables hold password columns). */
async function staffAccountExists(pool, source, id) {
  const q = source === "Teachers" ? `SELECT TOP 1 id FROM Teachers WHERE id = @id` : `SELECT TOP 1 id FROM users WHERE id = @id AND LOWER(role) IN ('admin','module_admin','sub_admin','sub_admin_2')`;
  const r = await pool.request().input("id", sql.Int, id).query(q);
  return !!(r.recordset && r.recordset.length);
}

async function addCoTeacher(pool, user, courseId, body) {
  const v = validateStaffInput(body); if (!v.ok) return v;
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const { source, id } = v.value;
  if (!(await staffAccountExists(pool, source, id))) return { ok: false, errors: ["That staff member does not exist."] };
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_course_staff WHERE course_id = @c AND is_active = 1 AND staff_role = 'co_teacher'`);
  const cur = await pool.request().input("c", sql.Int, courseId).input("s", sql.NVarChar(20), source).input("u", sql.Int, id).query(`SELECT TOP 1 staff_role, is_active FROM lms_course_staff WHERE course_id = @c AND user_source = @s AND user_id = @u`);
  const existing = cur.recordset && cur.recordset[0];
  if (existing && existing.is_active) return { ok: false, conflict: true, code: "ALREADY_STAFF", errors: [existing.staff_role === "co_teacher" ? "Already a co-teacher of this course." : "This person is already the owner of this course."] };
  if ((n.recordset?.[0]?.n || 0) >= MAX_CO_TEACHERS) return { ok: false, code: "LIMIT_REACHED", errors: [`A course can have at most ${MAX_CO_TEACHERS} co-teachers.`] };
  try {
    if (existing) await pool.request().input("c", sql.Int, courseId).input("s", sql.NVarChar(20), source).input("u", sql.Int, id)
      .query(`UPDATE lms_course_staff SET is_active = 1, staff_role = 'co_teacher' WHERE course_id = @c AND user_source = @s AND user_id = @u AND is_active = 0`);
    else await pool.request().input("c", sql.Int, courseId).input("s", sql.NVarChar(20), source).input("u", sql.Int, id)
      .query(`INSERT INTO lms_course_staff (course_id, user_source, user_id, staff_role, is_active) VALUES (@c, @s, @u, 'co_teacher', 1)`);
  } catch (err) { if (isDuplicateKey(err)) return { ok: false, conflict: true, code: "ALREADY_STAFF", errors: ["Already staff on this course."] }; throw err; }
  await audit(pool, actorOf(user), "course.coteacher.added", "lms_courses", courseId, { source, id });
  return { ok: true };
}

/* Only co-teachers can be removed here; the owner row is protected (owner change is a separate, explicit feature). */
async function removeCoTeacher(pool, user, courseId, source, userId) {
  if (!STAFF_SOURCES.includes(source) || posInt(userId) === null) return { ok: false, errors: ["Invalid staff reference."] };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.NVarChar(20), source).input("u", sql.Int, posInt(userId))
    .query(`UPDATE lms_course_staff SET is_active = 0 OUTPUT INSERTED.user_id WHERE course_id = @c AND user_source = @s AND user_id = @u AND staff_role = 'co_teacher' AND is_active = 1`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Co-teacher not found on this course."] };
  await audit(pool, actorOf(user), "course.coteacher.removed", "lms_courses", courseId, { source, id: posInt(userId) });
  return { ok: true };
}

/* -------------------------------- calendar -------------------------------- */
const parseDate = (v) => { if (typeof v !== "string" || v.length < 10 || v.length > 40) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

function validateEvent(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["title", "description", "eventType", "startsAt", "endsAt", "allDay"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if ("description" in body) { if (body.description === null || body.description === "") value.description = null; else { const t = oneLine(body.description); if (t.length > 1000) errors.push("description must be at most 1000 characters."); else value.description = t; } }
  if ("eventType" in body) { if (!EVENT_TYPES.includes(body.eventType)) errors.push(`eventType must be one of ${EVENT_TYPES.join(", ")}.`); else value.eventType = body.eventType; }
  if (!partial || "startsAt" in body) { const d = parseDate(body.startsAt); if (!d) errors.push("startsAt is required: an ISO date-time."); else value.startsAt = d; }
  if ("endsAt" in body) { if (body.endsAt === null) value.endsAt = null; else { const d = parseDate(body.endsAt); if (!d) errors.push("endsAt must be an ISO date-time or null."); else value.endsAt = d; } }
  if ("allDay" in body) { if (typeof body.allDay !== "boolean") errors.push("allDay must be true or false."); else value.allDay = body.allDay; }
  if (value.startsAt && value.endsAt && value.endsAt < value.startsAt) errors.push("endsAt cannot be before startsAt.");
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to update.");
  return { ok: !errors.length, errors, value };
}
const EV_COLS = "id, course_id, title, description, event_type, starts_at, ends_at, all_day, created_at, updated_at";
const OUT_COLS = EV_COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ");
const shapeEvent = (r) => ({ id: r.id, courseId: r.course_id, title: r.title, description: r.description || null, eventType: r.event_type, startsAt: r.starts_at, endsAt: r.ends_at || null, allDay: !!r.all_day, createdAt: r.created_at, updatedAt: r.updated_at });

/* Bounded window (default: 30 days back to 180 days ahead; at most 400 days; at most 500 rows). */
async function listEvents(pool, courseId, { from, to, now = new Date() } = {}) {
  let f = from ? parseDate(from) : new Date(now.getTime() - 30 * 864e5), t = to ? parseDate(to) : new Date(now.getTime() + 180 * 864e5);
  if (!f || !t) return { ok: false, errors: ["from and to must be ISO dates."] };
  if (t < f) return { ok: false, errors: ["to cannot be before from."] };
  if ((t - f) / 864e5 > MAX_WINDOW_DAYS) return { ok: false, errors: [`The date range can be at most ${MAX_WINDOW_DAYS} days.`] };
  const r = await pool.request().input("c", sql.Int, courseId).input("f", sql.DateTime2, f).input("t", sql.DateTime2, t)
    .query(`SELECT TOP 500 ${EV_COLS} FROM lms_course_events WHERE course_id = @c AND deleted_at IS NULL AND starts_at >= @f AND starts_at <= @t ORDER BY starts_at, id`);
  return { ok: true, events: (r.recordset || []).map(shapeEvent) };
}

async function createEvent(pool, user, courseId, body) {
  const v = validateEvent(body); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_course_events WHERE course_id = @c AND deleted_at IS NULL`);
  if ((n.recordset?.[0]?.n || 0) >= MAX_EVENTS_PER_COURSE) return { ok: false, code: "LIMIT_REACHED", errors: [`A course can have at most ${MAX_EVENTS_PER_COURSE} calendar events.`] };
  const actor = actorOf(user), x = v.value;
  const r = await pool.request().input("c", sql.Int, courseId).input("t", sql.NVarChar(200), x.title).input("d", sql.NVarChar(1000), x.description ?? null)
    .input("ty", sql.NVarChar(20), x.eventType || "event").input("s", sql.DateTime2, x.startsAt).input("e", sql.DateTime2, x.endsAt ?? null).input("a", sql.Bit, x.allDay ? 1 : 0)
    .input("src", sql.NVarChar(20), actor?.source ?? null).input("uid", sql.Int, actor?.id ?? null)
    .query(`INSERT INTO lms_course_events (course_id, title, description, event_type, starts_at, ends_at, all_day, created_by_source, created_by)
            OUTPUT ${OUT_COLS} VALUES (@c, @t, @d, @ty, @s, @e, @a, @src, @uid)`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, errors: ["The event could not be created."] };
  await audit(pool, actor, "event.created", "lms_course_events", row.id, { courseId, eventType: row.event_type });
  return { ok: true, event: shapeEvent(row) };
}

async function updateEvent(pool, user, courseId, eventId, patch) {
  const v = validateEvent(patch, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const cur = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, eventId).query(`SELECT TOP 1 starts_at, ends_at FROM lms_course_events WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const old = cur.recordset && cur.recordset[0]; if (!old) return { ok: false, notFound: true, errors: ["Event not found."] };
  const start = "startsAt" in v.value ? v.value.startsAt : new Date(old.starts_at), end = "endsAt" in v.value ? v.value.endsAt : (old.ends_at ? new Date(old.ends_at) : null);
  if (end && end < start) return { ok: false, errors: ["endsAt cannot be before startsAt."] };
  const map = { title: ["title", sql.NVarChar(200)], description: ["description", sql.NVarChar(1000)], eventType: ["event_type", sql.NVarChar(20)], startsAt: ["starts_at", sql.DateTime2], endsAt: ["ends_at", sql.DateTime2], allDay: ["all_day", sql.Bit] };
  const sets = [], req = pool.request().input("c", sql.Int, courseId).input("id", sql.Int, eventId);
  for (const [k, val] of Object.entries(v.value)) { const [col, type] = map[k]; sets.push(`${col} = @p_${k}`); req.input(`p_${k}`, type, k === "allDay" ? (val ? 1 : 0) : val); }
  sets.push("updated_at = SYSUTCDATETIME()");
  const r = await req.query(`UPDATE lms_course_events SET ${sets.join(", ")} OUTPUT ${OUT_COLS} WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Event not found."] };
  await audit(pool, actorOf(user), "event.updated", "lms_course_events", eventId, { courseId, fields: Object.keys(v.value) });
  return { ok: true, event: shapeEvent(row) };
}

async function deleteEvent(pool, user, courseId, eventId) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, eventId)
    .query(`UPDATE lms_course_events SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Event not found."] };
  await audit(pool, actorOf(user), "event.deleted", "lms_course_events", eventId, { courseId });
  return { ok: true };
}

module.exports = {
  MAX_SECTIONS, MAX_CO_TEACHERS, EVENT_TYPES, validateSection, validateStaffInput, validateEvent, posInt, editable, courseState,
  listSections, createSection, updateSection, deleteSection, reorderSections,
  addCoTeacher, removeCoTeacher, listEvents, createEvent, updateEvent, deleteEvent,
};
