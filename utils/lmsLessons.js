/* =========================================================================
   LMS LESSONS  (L3.1a): lessons inside a course, each made of ordered blocks.

   Same contract as lmsCourseParts.js: authorisation lives in the routes; this
   file validates and queries. EVERY row lookup also matches course_id, so a
   lesson/section id from another course (or school) is "not found".
   - Titles/summaries are plain text. Rich text exists only inside "text" blocks
     and is rebuilt from an allow-list on EVERY save (lmsHtml.js).
   - Media blocks hold a URL, never HTML: a file from THIS school's
     /uploads/<school>/lms/ folder, or an https link on a short provider list.
   - Content saves are ONE atomic statement guarded by content_version: a stale
     editor gets CONTENT_CONFLICT and nothing is overwritten.
   - Students see only published lessons of a published/archived course.
   - L3.3a: every content save also stores a snapshot (lms_lesson_versions, last 50 kept)
     in the SAME atomic statement; restoring copies a snapshot back as a NEW save, so
     history is never rewritten. Scheduling = status published + a future publish_at,
     checked when students read (no background job). Preview shows staff the student view.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { emit } = require("./lmsEvents");
const { posInt, editable } = require("./lmsCourseParts");
const { sanitizeHtml, safeHref } = require("./lmsHtml");
const { safeTenant } = require("./uploadPaths");

const MAX_LESSONS = 1000, MAX_BLOCKS = 200, MAX_TEXT_HTML = 100000, MAX_MINUTES = 600, MAX_LESSON_CHARS = 500000, KEEP_VERSIONS = 50;
const BLOCK_TYPES = ["text", "image", "video", "audio", "file", "link", "embed", "divider"];
const STATUSES = ["draft", "published"];
const COMPLETION_RULES = ["view", "mark_complete", "min_time"], MAX_MIN_TIME = 240;

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
/* ISO 8601 with an explicit zone (so "9am" is never guessed), in the future, at most 2 years ahead. */
function futureDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v); const now = Date.now();
  return Number.isFinite(t) && t > now && t < now + 2 * 365 * 86400000 ? new Date(t) : null;
}

/* ---------------------------- media URL checks ---------------------------- */
/* A school's own LMS media folder only. No "..", no double slashes, no query/hash, no other school. */
function localMediaUrl(raw, tenant) {
  const v = String(raw ?? "");
  const m = /^\/uploads\/([a-z0-9_-]+)\/lms\/([A-Za-z0-9][A-Za-z0-9._-]{0,150}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}){0,3})$/.exec(v);
  if (!m || v.includes("..") || m[1] !== safeTenant(tenant)) return null;
  return v;
}
/* Provider links are rewritten to their embed address; nothing else is allowed. */
function providerEmbed(raw) {
  let u; try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const id = (s) => (/^[A-Za-z0-9_-]{6,20}$/.test(s || "") ? s : null);
  let m;
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = u.pathname === "/watch" ? id(u.searchParams.get("v")) : (m = /^\/embed\/([A-Za-z0-9_-]{6,20})$/.exec(u.pathname)) ? id(m[1]) : null;
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === "youtube-nocookie.com") { m = /^\/embed\/([A-Za-z0-9_-]{6,20})$/.exec(u.pathname); return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null; }
  if (host === "youtu.be") { m = /^\/([A-Za-z0-9_-]{6,20})$/.exec(u.pathname); return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null; }
  if (host === "vimeo.com" || host === "player.vimeo.com") { m = /^\/(?:video\/)?(\d{5,12})$/.exec(u.pathname); return m ? `https://player.vimeo.com/video/${m[1]}` : null; }
  return null;
}

/* ------------------------------ validation ------------------------------- */
function validateLesson(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."], value };
  for (const k of Object.keys(body)) if (!["title", "summary", "sectionId", "estimatedMinutes", "status", "publishAt", "completionRule", "minMinutes"].includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if ("summary" in body) { if (body.summary === null || body.summary === "") value.summary = null; else { const t = oneLine(body.summary); if (t.length > 1000) errors.push("summary must be at most 1000 characters."); else value.summary = t; } }
  if ("sectionId" in body) { if (body.sectionId === null) value.sectionId = null; else { const n = posInt(body.sectionId); if (n === null) errors.push("sectionId must be a section id or null."); else value.sectionId = n; } }
  if ("estimatedMinutes" in body) { if (body.estimatedMinutes === null) value.estimatedMinutes = null; else { const n = posInt(body.estimatedMinutes); if (n === null || n > MAX_MINUTES) errors.push(`estimatedMinutes must be 1-${MAX_MINUTES} or null.`); else value.estimatedMinutes = n; } }
  if ("status" in body) { if (!STATUSES.includes(body.status)) errors.push(`status must be one of ${STATUSES.join(", ")}.`); else value.status = body.status; }
  if ("publishAt" in body) {
    if (body.publishAt === null) { if (!("status" in body)) errors.push('To cancel a schedule also send status: "draft" (hide) or "published" (publish now).'); else value.publishAt = null; }
    else { const d = futureDate(body.publishAt); if (!d) errors.push("publishAt must be a future date and time in ISO 8601 with a time zone (for example 2026-11-02T08:00:00+03:00), at most 2 years ahead."); else value.publishAt = d; }
  }
  if ("completionRule" in body) { if (!COMPLETION_RULES.includes(body.completionRule)) errors.push(`completionRule must be one of ${COMPLETION_RULES.join(", ")}.`); else value.completionRule = body.completionRule; }
  if ("minMinutes" in body) {
    if (!("completionRule" in body)) errors.push("Send completionRule together with minMinutes.");
    else if (body.minMinutes === null) value.minMinutes = null;
    else { const n = posInt(body.minMinutes); if (n === null || n > MAX_MIN_TIME) errors.push(`minMinutes must be 1-${MAX_MIN_TIME} or null.`); else value.minMinutes = n; }
  }
  if (value.completionRule === "min_time" && !value.minMinutes) errors.push('completionRule "min_time" needs minMinutes (1-' + MAX_MIN_TIME + ").");
  if (value.completionRule && value.completionRule !== "min_time" && value.minMinutes != null) errors.push('minMinutes is only for completionRule "min_time".');
  if (value.publishAt instanceof Date && value.status === "draft") errors.push('A lesson cannot be a draft and scheduled at once: leave out status, or use "published".');
  if (partial && !errors.length && !Object.keys(value).length) errors.push("Nothing to update.");
  return { ok: !errors.length, errors, value };
}

const KEYS = { text: ["type", "html"], divider: ["type"], link: ["type", "url", "title"], image: ["type", "url", "alt", "decorative", "caption"], audio: ["type", "url", "title"], file: ["type", "url", "title"], video: ["type", "url", "title"], embed: ["type", "url", "title"] };

/* Returns { ok, blocks:[{type, html, data}] } with everything normalised and sanitised. */
function validateBlocks(list, tenant) {
  if (!Array.isArray(list)) return { ok: false, errors: ["blocks must be a list."] };
  if (list.length > MAX_BLOCKS) return { ok: false, errors: [`A lesson can have at most ${MAX_BLOCKS} blocks.`] };
  const errors = [], out = [];
  list.forEach((b, i) => {
    const at = `Block ${i + 1}`;
    if (!isPlainObject(b) || !BLOCK_TYPES.includes(b.type)) { errors.push(`${at}: type must be one of ${BLOCK_TYPES.join(", ")}.`); return; }
    const extra = Object.keys(b).find((k) => !KEYS[b.type].includes(k)); if (extra) { errors.push(`${at}: unknown field "${extra}" for a ${b.type} block.`); return; }
    const title = () => { const t = oneLine(b.title); return t.length > 200 ? null : t; };
    if (b.type === "text") {
      if (typeof b.html !== "string") { errors.push(`${at}: html must be text.`); return; }
      const html = sanitizeHtml(b.html); if (html.length > MAX_TEXT_HTML) { errors.push(`${at}: text is too long.`); return; }
      out.push({ type: "text", html, data: null }); return;
    }
    if (b.type === "divider") { out.push({ type: "divider", html: null, data: null }); return; }
    const t = title(); if (t === null) { errors.push(`${at}: title must be at most 200 characters.`); return; }
    let url = null;
    if (b.type === "link") { const h = safeHref(b.url); url = h && /^https?:\/\//i.test(h) ? h : null; if (!url) { errors.push(`${at}: url must be an http(s) link.`); return; } }
    else if (b.type === "embed") { url = providerEmbed(b.url); if (!url) { errors.push(`${at}: only YouTube or Vimeo links can be embedded.`); return; } }
    else if (b.type === "video") { url = localMediaUrl(b.url, tenant) || providerEmbed(b.url); if (!url) { errors.push(`${at}: video must be an uploaded file or a YouTube/Vimeo link.`); return; } }
    else { url = localMediaUrl(b.url, tenant); if (!url) { errors.push(`${at}: url must be a file uploaded to this school's LMS media.`); return; } }
    const data = { url };
    if (t) data.title = t;
    if (b.type === "image") {
      const alt = oneLine(b.alt), cap = oneLine(b.caption);
      if (alt.length > 300 || cap.length > 300) { errors.push(`${at}: alt text and caption must be at most 300 characters.`); return; }
      if (b.decorative !== undefined && typeof b.decorative !== "boolean") { errors.push(`${at}: decorative must be true or false.`); return; }
      if (!alt && b.decorative !== true) { errors.push(`${at}: describe the image (alt text) or mark it as decorative.`); return; }
      if (alt) data.alt = alt; if (b.decorative === true) data.decorative = true; if (cap) data.caption = cap;
    }
    out.push({ type: b.type, html: null, data: JSON.stringify(data) });
  });
  if (!errors.length) { const total = out.reduce((n, b) => n + (b.html ? b.html.length : 0) + (b.data ? b.data.length : 0), 0); if (total > MAX_LESSON_CHARS) errors.push("This lesson is too long. Split it into two lessons."); }
  return errors.length ? { ok: false, errors: errors.slice(0, 10) } : { ok: true, blocks: out };
}

/* -------------------------------- shapes --------------------------------- */
const shapeLesson = (r) => ({
  id: r.id, courseId: r.course_id, sectionId: r.section_id ?? null, title: r.title, summary: r.summary || null, status: r.status,
  estimatedMinutes: r.estimated_minutes ?? null, sortOrder: r.sort_order, contentVersion: r.content_version, publishedAt: r.published_at || null,
  publishAt: r.publish_at || null, completionRule: r.completion_rule || "mark_complete", minMinutes: r.min_minutes ?? null,
  visibleToStudents: r.status === "published" && (!r.publish_at || new Date(r.publish_at).getTime() <= Date.now()),
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const COLS = `id, course_id, section_id, title, summary, status, estimated_minutes, sort_order, content_version, published_at, publish_at, completion_rule, min_minutes, created_at, updated_at`;
/* What a student may see: published AND not scheduled for later. */
const VISIBLE = `status = 'published' AND (publish_at IS NULL OR publish_at <= SYSUTCDATETIME())`;
const OUT_COLS = COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ");
function shapeBlock(r) {
  let data = {}; try { data = r.data ? JSON.parse(r.data) : {}; } catch { data = {}; }
  return { id: r.id, type: r.block_type, sortOrder: r.sort_order, ...(r.block_type === "text" ? { html: r.html || "" } : data) };
}
async function blocksOf(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId)
    .query(`SELECT TOP ${MAX_BLOCKS} id, block_type, sort_order, html, data FROM lms_lesson_blocks WHERE lesson_id = @l AND course_id = @c ORDER BY sort_order, id`);
  return (r.recordset || []).map(shapeBlock);
}
async function sectionBelongs(pool, courseId, sectionId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sectionId)
    .query(`SELECT TOP 1 id FROM lms_course_sections WHERE id = @s AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}

/* ------------------------------ staff: lessons ---------------------------- */
async function listLessons(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId)
    .query(`SELECT TOP ${MAX_LESSONS} ${COLS} FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL ORDER BY section_id, sort_order, id`);
  return (r.recordset || []).map(shapeLesson);
}

async function getLesson(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId)
    .query(`SELECT TOP 1 ${COLS} FROM lms_lessons WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  return { ok: true, lesson: shapeLesson(row), blocks: await blocksOf(pool, courseId, lessonId) };
}

async function createLesson(pool, user, courseId, body) {
  const v = validateLesson(body); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (v.value.sectionId != null && !(await sectionBelongs(pool, courseId, v.value.sectionId))) return { ok: false, errors: ["That section does not belong to this course."] };
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL`);
  if ((n.recordset?.[0]?.n || 0) >= MAX_LESSONS) return { ok: false, code: "LIMIT_REACHED", errors: [`A course can have at most ${MAX_LESSONS} lessons.`] };
  const actor = actorOf(user), publish = v.value.status === "published" || v.value.publishAt instanceof Date, pat = v.value.publishAt instanceof Date ? v.value.publishAt : null;
  const r = await pool.request().input("c", sql.Int, courseId).input("sec", sql.Int, v.value.sectionId ?? null)
    .input("t", sql.NVarChar(200), v.value.title).input("s", sql.NVarChar(1000), v.value.summary ?? null).input("m", sql.Int, v.value.estimatedMinutes ?? null)
    .input("st", sql.NVarChar(20), publish ? "published" : "draft").input("pat", sql.DateTime, pat).input("cr", sql.NVarChar(20), v.value.completionRule ?? null).input("mm", sql.Int, v.value.minMinutes ?? null).input("src", sql.NVarChar(20), actor?.source ?? null).input("uid", sql.Int, actor?.id ?? null)
    .query(`INSERT INTO lms_lessons (course_id, section_id, title, summary, estimated_minutes, status, publish_at, published_at, completion_rule, min_minutes, sort_order, created_by_source, created_by)
            OUTPUT ${OUT_COLS}
            SELECT @c, @sec, @t, @s, @m, @st, @pat, CASE WHEN @st = 'published' THEN ISNULL(@pat, SYSUTCDATETIME()) ELSE NULL END, @cr, @mm, ISNULL(MAX(sort_order), 0) + 10, @src, @uid
            FROM lms_lessons WHERE course_id = @c AND ((section_id = @sec) OR (section_id IS NULL AND @sec IS NULL)) AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, errors: ["The lesson could not be created."] };
  await audit(pool, actor, "lesson.created", "lms_lessons", row.id, { courseId });
  return { ok: true, lesson: shapeLesson(row) };
}

async function updateLesson(pool, user, courseId, lessonId, patch, tenant) {
  const v = validateLesson(patch, { partial: true }); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (v.value.sectionId != null && !(await sectionBelongs(pool, courseId, v.value.sectionId))) return { ok: false, errors: ["That section does not belong to this course."] };
  const sets = [], req = pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId);
  if ("title" in v.value) { sets.push("title = @t"); req.input("t", sql.NVarChar(200), v.value.title); }
  if ("summary" in v.value) { sets.push("summary = @s"); req.input("s", sql.NVarChar(1000), v.value.summary); }
  if ("estimatedMinutes" in v.value) { sets.push("estimated_minutes = @m"); req.input("m", sql.Int, v.value.estimatedMinutes); }
  if ("completionRule" in v.value) { sets.push("completion_rule = @cr", "min_minutes = @mm"); req.input("cr", sql.NVarChar(20), v.value.completionRule).input("mm", sql.Int, v.value.completionRule === "min_time" ? v.value.minMinutes : null); }
  if ("sectionId" in v.value) { // moving to another section places the lesson last there
    sets.push("section_id = @sec", "sort_order = (SELECT ISNULL(MAX(x.sort_order), 0) + 10 FROM lms_lessons x WHERE x.course_id = @c AND x.deleted_at IS NULL AND ((x.section_id = @sec) OR (x.section_id IS NULL AND @sec IS NULL)))");
    req.input("sec", sql.Int, v.value.sectionId);
  }
  if ("status" in v.value || "publishAt" in v.value) { // draft hides and clears any schedule; otherwise publish now, or at publishAt
    const draft = v.value.status === "draft", pat = draft ? null : (v.value.publishAt ?? null);
    sets.push("status = @st", "publish_at = @pat");
    if (!draft) sets.push("published_at = CASE WHEN @pat IS NOT NULL THEN @pat WHEN publish_at IS NOT NULL THEN SYSUTCDATETIME() ELSE ISNULL(published_at, SYSUTCDATETIME()) END");
    req.input("st", sql.NVarChar(20), draft ? "draft" : "published").input("pat", sql.DateTime, pat);
  }
  sets.push("updated_at = SYSUTCDATETIME()");
  const r = await req.query(`UPDATE lms_lessons SET ${sets.join(", ")} OUTPUT ${OUT_COLS} WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  await audit(pool, actorOf(user), "lesson.updated", "lms_lessons", lessonId, { courseId, fields: Object.keys(v.value), scheduled: v.value.publishAt instanceof Date });
  if (v.value.status === "published" && !(v.value.publishAt instanceof Date)) emit("lms.lesson.published", { tenant, courseId, lessonId });
  return { ok: true, lesson: shapeLesson(row) };
}

async function deleteLesson(pool, user, courseId, lessonId) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId)
    .query(`UPDATE lms_lessons SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  await audit(pool, actorOf(user), "lesson.deleted", "lms_lessons", lessonId, { courseId });
  return { ok: true };
}

/* ids must be EXACTLY the live lessons of that section (sectionId null = lessons outside any section). */
async function reorderLessons(pool, user, courseId, sectionId, ids) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const sec = sectionId === null || sectionId === undefined ? null : posInt(sectionId);
  if (sectionId !== null && sectionId !== undefined && sec === null) return { ok: false, errors: ["sectionId must be a section id or null."] };
  if (!Array.isArray(ids) || ids.length > MAX_LESSONS) return { ok: false, errors: ["ids must be a list of lesson ids."] };
  const list = ids.map(posInt);
  if (list.some((x) => x === null) || new Set(list).size !== list.length) return { ok: false, errors: ["ids must be unique positive integers."] };
  const cur = await pool.request().input("c", sql.Int, courseId).input("sec", sql.Int, sec)
    .query(`SELECT TOP ${MAX_LESSONS} id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ((section_id = @sec) OR (section_id IS NULL AND @sec IS NULL))`);
  const have = new Set((cur.recordset || []).map((x) => x.id));
  if (have.size !== list.length || list.some((x) => !have.has(x))) return { ok: false, code: "ORDER_MISMATCH", errors: ["The list must contain every lesson of this section exactly once."] };
  if (!list.length) return { ok: true };
  const req = pool.request().input("c", sql.Int, courseId);
  const stmts = list.map((id, i) => { req.input(`i${i}`, sql.Int, id).input(`o${i}`, sql.Int, (i + 1) * 10); return `UPDATE lms_lessons SET sort_order = @o${i}, updated_at = SYSUTCDATETIME() WHERE id = @i${i} AND course_id = @c;`; });
  await req.query(`SET XACT_ABORT ON; BEGIN TRAN; ${stmts.join(" ")} COMMIT;`);
  await audit(pool, actorOf(user), "lesson.reordered", "lms_courses", courseId, { count: list.length, sectionId: sec });
  return { ok: true };
}

/* --------------------------- staff: lesson content ------------------------- */
/* body = { baseVersion, blocks:[...] }. Replaces the blocks atomically if baseVersion is still current, and stores a snapshot. */
async function saveBlocks(pool, user, courseId, lessonId, body, tenant) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["baseVersion", "blocks"].includes(k))) return { ok: false, errors: ["Body must contain baseVersion and blocks only."] };
  const base = posInt(body.baseVersion); if (base === null) return { ok: false, errors: ["baseVersion must be the contentVersion you loaded."] };
  const v = validateBlocks(body.blocks, tenant); if (!v.ok) return { ok: false, errors: v.errors };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  return commitBlocks(pool, user, courseId, lessonId, base, v.blocks, { label: null, action: "lesson.content_saved", extra: {} });
}

/* Snapshot = the blocks in the same shape the editor sends, so a restore goes back through validateBlocks. */
const snapshotOf = (blocks) => JSON.stringify(blocks.map((b) => (b.type === "text" ? { type: "text", html: b.html } : { type: b.type, ...(b.data ? JSON.parse(b.data) : {}) })));

async function commitBlocks(pool, user, courseId, lessonId, base, blocks, { label, action, extra }) {
  const actor = actorOf(user);
  const req = pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).input("v", sql.Int, base)
    .input("snap", sql.NVarChar(sql.MAX), snapshotOf(blocks)).input("lbl", sql.NVarChar(100), label).input("src", sql.NVarChar(20), actor?.source ?? null).input("uid", sql.Int, actor?.id ?? null);
  const inserts = blocks.map((b, i) => {
    req.input(`t${i}`, sql.NVarChar(20), b.type).input(`h${i}`, sql.NVarChar(sql.MAX), b.html).input(`d${i}`, sql.NVarChar(2000), b.data);
    return `INSERT INTO lms_lesson_blocks (lesson_id, course_id, block_type, sort_order, html, data) VALUES (@l, @c, @t${i}, ${(i + 1) * 10}, @h${i}, @d${i});`;
  });
  const r = await req.query(`
    SET XACT_ABORT ON; BEGIN TRAN;
    DECLARE @new INT;
    UPDATE lms_lessons SET content_version = content_version + 1, updated_at = SYSUTCDATETIME(), @new = content_version + 1
      WHERE id = @l AND course_id = @c AND deleted_at IS NULL AND content_version = @v;
    IF @@ROWCOUNT = 1 BEGIN
      DELETE FROM lms_lesson_blocks WHERE lesson_id = @l AND course_id = @c;
      ${inserts.join(" ")}
      INSERT INTO lms_lesson_versions (lesson_id, course_id, version_no, title, label, blocks_json, created_by_source, created_by)
        SELECT @l, @c, @new, title, @lbl, @snap, @src, @uid FROM lms_lessons WHERE id = @l AND course_id = @c;
      DELETE FROM lms_lesson_versions WHERE lesson_id = @l AND course_id = @c AND version_no <= @new - ${KEEP_VERSIONS};
    END
    COMMIT;
    SELECT @new AS new_version, (SELECT COUNT(*) FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL) AS lesson_exists;`);
  const row = r.recordset && r.recordset[0];
  if (!row || !row.lesson_exists) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  if (!row.new_version) return { ok: false, code: "CONTENT_CONFLICT", errors: ["This lesson was changed somewhere else. Reload it before saving, so no work is overwritten."] };
  await audit(pool, actor, action, "lms_lessons", lessonId, { courseId, blocks: blocks.length, version: row.new_version, ...extra });
  return { ok: true, contentVersion: row.new_version, blocks: await blocksOf(pool, courseId, lessonId) };
}

/* ------------------------- staff: versions and preview --------------------- */
async function lessonExists(pool, courseId, lessonId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId)
    .query(`SELECT TOP 1 id FROM lms_lessons WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}
async function listVersions(pool, courseId, lessonId) {
  if (!(await lessonExists(pool, courseId, lessonId))) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId)
    .query(`SELECT TOP ${KEEP_VERSIONS} version_no, title, label, created_by_source, created_by, created_at FROM lms_lesson_versions WHERE lesson_id = @l AND course_id = @c ORDER BY version_no DESC`);
  return { ok: true, versions: (r.recordset || []).map((x) => ({ versionNo: x.version_no, title: x.title, label: x.label || null, createdBySource: x.created_by_source ?? null, createdBy: x.created_by ?? null, createdAt: x.created_at })) };
}
/* Reads one snapshot and runs it through the SAME validation as a save (so what comes back is always sanitised and school-checked). */
async function loadSnapshot(pool, courseId, lessonId, versionNo, tenant) {
  const r = await pool.request().input("c", sql.Int, courseId).input("l", sql.Int, lessonId).input("n", sql.Int, versionNo)
    .query(`SELECT TOP 1 version_no, title, label, blocks_json, created_at FROM lms_lesson_versions WHERE lesson_id = @l AND course_id = @c AND version_no = @n`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Version not found."] };
  let list; try { list = JSON.parse(row.blocks_json); } catch { list = null; }
  const v = validateBlocks(list, tenant);
  if (!v.ok) return { ok: false, code: "VERSION_UNREADABLE", errors: ["This version can no longer be shown or restored."] };
  return { ok: true, row, blocks: v.blocks };
}
async function getVersion(pool, courseId, lessonId, versionNo, tenant) {
  const r = await loadSnapshot(pool, courseId, lessonId, versionNo, tenant); if (!r.ok) return r;
  const blocks = r.blocks.map((b) => { const { id, sortOrder, ...rest } = shapeBlock({ block_type: b.type, html: b.html, data: b.data }); return rest; });
  return { ok: true, version: { versionNo: r.row.version_no, title: r.row.title, label: r.row.label || null, createdAt: r.row.created_at }, blocks };
}
/* Restore = a normal guarded save of the old blocks (a NEW version); nothing in the history is changed or removed. */
async function restoreVersion(pool, user, courseId, lessonId, versionNo, body, tenant) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "baseVersion")) return { ok: false, errors: ["Body must contain baseVersion only."] };
  const base = posInt(body.baseVersion); if (base === null) return { ok: false, errors: ["baseVersion must be the contentVersion you loaded."] };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const snap = await loadSnapshot(pool, courseId, lessonId, versionNo, tenant); if (!snap.ok) return snap;
  return commitBlocks(pool, user, courseId, lessonId, base, snap.blocks, { label: `Restored from version ${versionNo}`, action: "lesson.version_restored", extra: { fromVersion: versionNo } });
}
/* Staff see exactly the student shape, plus whether students can open it right now. Works for drafts and scheduled lessons. */
async function previewLesson(pool, courseId, lessonId) {
  const r = await getLesson(pool, courseId, lessonId); if (!r.ok) return r;
  const l = r.lesson;
  return { ok: true, lesson: { id: l.id, courseId: l.courseId, sectionId: l.sectionId, title: l.title, summary: l.summary, estimatedMinutes: l.estimatedMinutes }, blocks: r.blocks, preview: { status: l.status, publishAt: l.publishAt, visibleToStudents: l.visibleToStudents } };
}

/* -------------------------------- students -------------------------------- */
/* Route guarantees an ACTIVE enrolment; here the course must also be published or archived (read-only for students). */
async function studentCourseOpen(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL AND status IN ('published','archived')`);
  return !!(r.recordset && r.recordset.length);
}
async function listLessonsForStudent(pool, courseId) {
  if (!(await studentCourseOpen(pool, courseId))) return { ok: false, notFound: true, errors: ["Course not found."] };
  const secs = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 100 id, title, summary, sort_order FROM lms_course_sections WHERE course_id = @c AND deleted_at IS NULL ORDER BY sort_order, id`);
  const les = await pool.request().input("c", sql.Int, courseId)
    .query(`SELECT TOP ${MAX_LESSONS} id, section_id, title, summary, estimated_minutes, completion_rule, min_minutes, sort_order FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE} ORDER BY sort_order, id`);
  const lessons = (les.recordset || []).map((l) => ({ id: l.id, sectionId: l.section_id ?? null, title: l.title, summary: l.summary || null, estimatedMinutes: l.estimated_minutes ?? null, completionRule: l.completion_rule || "mark_complete", minMinutes: l.min_minutes ?? null, sortOrder: l.sort_order }));
  const sections = (secs.recordset || []).map((s) => ({ id: s.id, title: s.title, summary: s.summary || null, lessons: lessons.filter((l) => l.sectionId === s.id) }));
  return { ok: true, sections, unsectioned: lessons.filter((l) => l.sectionId === null || !sections.some((s) => s.id === l.sectionId)) };
}
async function getLessonForStudent(pool, courseId, lessonId) {
  if (!(await studentCourseOpen(pool, courseId))) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, lessonId)
    .query(`SELECT TOP 1 id, course_id, section_id, title, summary, estimated_minutes, completion_rule, min_minutes FROM lms_lessons WHERE id = @id AND course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`);
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["Lesson not found."] };
  return { ok: true, lesson: { id: row.id, courseId: row.course_id, sectionId: row.section_id ?? null, title: row.title, summary: row.summary || null, estimatedMinutes: row.estimated_minutes ?? null, completionRule: row.completion_rule || "mark_complete", minMinutes: row.min_minutes ?? null }, blocks: await blocksOf(pool, courseId, lessonId) };
}

module.exports = {
  MAX_LESSONS, MAX_BLOCKS, BLOCK_TYPES, COMPLETION_RULES, MAX_MIN_TIME, VISIBLE, studentCourseOpen, validateLesson, validateBlocks, localMediaUrl, providerEmbed,
  MAX_LESSON_CHARS, KEEP_VERSIONS, futureDate, listLessons, getLesson, createLesson, updateLesson, deleteLesson, reorderLessons, saveBlocks, listVersions, getVersion, restoreVersion, previewLesson, listLessonsForStudent, getLessonForStudent,
};
