/* =========================================================================
   LMS OFFLINE RESOURCE PACKS  (L10.1a, D-113)  add-on flag `lms_offline`, schema step 042 (`lms_offline_packs`, `lms_offline_pack_lessons`).
   BACKEND only: the pack DEFINITION, the frozen MANIFEST and who may read it. The file BYTES and lesson content downloads are L10.1b; the service worker is L10.2.

   Rules (documented, simple, all enforced here):
   - STAFF (flag `lms_offline` first, then `lms.course.manage`, then course owner / co-teacher / admin): create a pack (name, size budget, optional expiry, 1-50 lessons of THIS
     course), edit it while it is a DRAFT, PUBLISH it, RETIRE it. At most 10 live packs per course. A pack holds lessons only; files come from the lesson blocks.
   - PUBLISH freezes a manifest and is the integrity step: the course must be published; every lesson must be visible to learners right now (published, not scheduled for later,
     not deleted); every uploaded file a lesson block uses must exist in the media library AND on disk, and is hashed (sha256, with its real size). Links and YouTube/Vimeo
     embeds cannot work offline: they are counted per lesson as `onlineOnly` and never block a pack. The total size of the files must fit the pack budget
     (`maxMb` 1-200, default 50; 409 PACK_TOO_LARGE with the numbers). At most 200 files. Any problem refuses the publish and changes nothing (409 with the lesson/file ids).
   - The manifest (stored, never rebuilt) lists each lesson with its `contentVersion` and a `contentSha256` of its blocks, and each file with `sha256` and `sizeBytes`;
     `manifestSha256` is the hash of the manifest text, so a device can tell whether its copy is current. Later lesson edits never change a published manifest: the learner
     route reports `staleLessons` (lessons whose content version moved on, or that are no longer visible) so the device knows to ask for a new pack. Nothing is silently rewritten.
   - LEARNERS (enrolled, studentOnly): see only PUBLISHED packs of their course that have not expired; `GET manifest` of a retired, expired, draft or other course's pack is the
     same 404. Expiry is checked on every read.
   - Audit `offline_pack.created/updated/published/retired` (ids and counts only). Every query is parameterised; id lists travel as ONE JSON parameter read with OPENJSON.
========================================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { VISIBLE } = require("./lmsLessons");
const { UPLOADS_ROOT, safeTenant } = require("./uploadPaths");

const MAX_PACKS = 10, MAX_LESSONS = 50, MAX_FILES = 200, MAX_MB = 200, DEFAULT_MB = 50, MAX_BLOCKS_READ = 5000;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const notFound = (what = "Course") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const reject = (code, msg, extra) => ({ ok: false, code, errors: [msg], ...(extra || {}) });
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim() : null);
const staffOf = (user) => { const a = actorOf(user); return a && a.role !== "student" ? a : null; };

/* The file hasher: (tenant, storedName) -> { sha256, size } or null when the file is not there. A caller may pass its own as `ctx.hasher` (tests, or a store other than the disk);
   there is NO shared global to replace, so concurrent callers can never see each other's hasher. */
const defaultHasher = async (tenant, storedName) => {
  const abs = path.join(UPLOADS_ROOT, safeTenant(tenant), "lms", path.basename(String(storedName || "")));
  let st; try { st = await fs.promises.stat(abs); } catch { return null; } if (!st.isFile()) return null;
  return new Promise((resolve) => { const h = crypto.createHash("sha256"); const rs = fs.createReadStream(abs); rs.on("error", () => resolve(null)); rs.on("data", (c) => h.update(c)); rs.on("end", () => resolve({ sha256: h.digest("hex"), size: st.size })); });
};

/* Pure. { ok, value } or { ok:false, errors }. Create needs name + lessonIds; edit accepts any subset (at least one). */
function validatePack(body, edit = false, now = new Date()) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).find((k) => !["name", "maxMb", "expiresAt", "lessonIds"].includes(k)); if (extra) return { ok: false, errors: [`Unknown field: ${extra}.`] };
  const v = {}, errors = [];
  if (!edit || body.name !== undefined) { const n = clean(body.name); if (!n || n.length > 100) errors.push("name is required (1-100 characters)."); else v.name = n; }
  if (body.maxMb !== undefined) { if (!Number.isInteger(body.maxMb) || body.maxMb < 1 || body.maxMb > MAX_MB) errors.push(`maxMb must be a whole number from 1 to ${MAX_MB}.`); else v.maxMb = body.maxMb; } else if (!edit) v.maxMb = DEFAULT_MB;
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) v.expiresAt = null;
    else { const d = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null; if (!d || Number.isNaN(d.getTime()) || d <= now) errors.push("expiresAt must be a date and time in the future (or null for no expiry)."); else v.expiresAt = d.toISOString(); }
  } else if (!edit) v.expiresAt = null;
  if (!edit || body.lessonIds !== undefined) {
    const l = body.lessonIds; if (!Array.isArray(l) || !l.length || l.length > MAX_LESSONS || !l.every((x) => Number.isInteger(x) && x > 0) || new Set(l).size !== l.length) errors.push(`lessonIds must be 1 to ${MAX_LESSONS} different lesson ids.`); else v.lessonIds = l;
  }
  if (edit && !errors.length && !Object.keys(v).length) errors.push("Nothing to change.");
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

/* Pure. The lesson content hash: ordered blocks as stored. */
const lessonContentSha = (blocks) => sha(JSON.stringify(blocks.map((b) => [b.block_type, b.html ?? null, b.data ?? null])));
const urlOf = (b) => { if (!b.data) return null; try { const d = JSON.parse(b.data); return typeof d.url === "string" ? d.url : null; } catch { return null; } };
const isExternal = (u) => /^https?:\/\//i.test(u);

/* Pure. Builds the manifest object (no I/O). lessons [{id,title,content_version,blocks:[..]}], files Map(url -> {mediaId,name,ext,kind,sizeBytes,sha256}) */
function buildManifest({ pack, lessons, fileByUrl, builtAt }) {
  const files = new Map(), outLessons = lessons.map((l) => {
    let onlineOnly = 0;
    for (const b of l.blocks) { const u = urlOf(b); if (!u) continue; if (isExternal(u)) onlineOnly += 1; else { const f = fileByUrl.get(u); if (f) files.set(f.mediaId, f); } }
    return { id: l.id, title: l.title, contentVersion: l.content_version, contentSha256: lessonContentSha(l.blocks), blocks: l.blocks.length, onlineOnly };
  });
  const list = [...files.values()].sort((a, b) => a.mediaId - b.mediaId), totalBytes = list.reduce((n, f) => n + f.sizeBytes, 0);
  return { v: 1, packId: pack.id, courseId: pack.course_id, name: pack.name, builtAt, expiresAt: iso(pack.expires_at), lessons: outLessons, files: list, totalBytes };
}

async function courseRow(pool, cid) { const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 id, status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`); return (r.recordset && r.recordset[0]) || null; }
const shape = (r) => ({ id: r.id, name: r.name, status: r.status, maxMb: r.max_mb, expiresAt: iso(r.expires_at), totalBytes: r.total_bytes === null || r.total_bytes === undefined ? null : Number(r.total_bytes), lessons: Number(r.lessons) || 0, manifestSha256: r.manifest_sha256 || null, publishedAt: iso(r.published_at) });

async function lessonsInCourse(pool, cid, ids) { const r = await pool.request().input("c", sql.Int, cid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(`SELECT id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`); return new Set((r.recordset || []).map((x) => x.id)); }

async function createPack(pool, user, courseId, body, now = new Date()) {
  const cid = posInt(courseId); if (!cid) return notFound(); const actor = staffOf(user); if (!actor) return notFound();
  const v = validatePack(body, false, now); if (!v.ok) return v; const x = v.value;
  if (!(await courseRow(pool, cid))) return notFound();
  const have = await lessonsInCourse(pool, cid, x.lessonIds); if (have.size !== x.lessonIds.length) return { ok: false, errors: ["lessonIds must be lessons of this course."] };
  const r = await pool.request().input("c", sql.Int, cid).input("n", sql.NVarChar(100), x.name).input("mb", sql.Int, x.maxMb).input("exp", sql.DateTime2, x.expiresAt ? new Date(x.expiresAt) : null)
    .input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("max", sql.Int, MAX_PACKS).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(x.lessonIds.map((l, i) => ({ l, o: i }))))
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @id INT;
      INSERT INTO lms_offline_packs (course_id, name, max_mb, expires_at, created_by_source, created_by)
        SELECT @c, @n, @mb, @exp, @src, @uid WHERE (SELECT COUNT(*) FROM lms_offline_packs WHERE course_id = @c AND deleted_at IS NULL) < @max;
      IF @@ROWCOUNT = 1
      BEGIN
        SET @id = SCOPE_IDENTITY();
        INSERT INTO lms_offline_pack_lessons (pack_id, course_id, lesson_id, sort_order) SELECT @id, @c, j.l, j.o FROM OPENJSON(@rows) WITH (l INT '$.l', o INT '$.o') j;
      END
      COMMIT; SELECT @id AS id;`);
  const id = r.recordset && r.recordset[0] && r.recordset[0].id; if (!id) return reject("PACK_LIMIT", `A course can have at most ${MAX_PACKS} offline packs.`);
  await audit(pool, actor, "offline_pack.created", "lms_offline_packs", id, { courseId: cid, lessons: x.lessonIds.length, maxMb: x.maxMb });
  return { ok: true, id, pack: { id, name: x.name, status: "draft", maxMb: x.maxMb, expiresAt: x.expiresAt, totalBytes: null, lessons: x.lessonIds.length, manifestSha256: null, publishedAt: null } };
}

async function updatePack(pool, user, courseId, packId, body, now = new Date()) {
  const cid = posInt(courseId), id = posInt(packId); if (!cid || !id) return notFound("Pack"); const actor = staffOf(user); if (!actor) return notFound("Pack");
  const v = validatePack(body, true, now); if (!v.ok) return v; const x = v.value;
  if (x.lessonIds) { const have = await lessonsInCourse(pool, cid, x.lessonIds); if (have.size !== x.lessonIds.length) return { ok: false, errors: ["lessonIds must be lessons of this course."] }; }
  const rq = pool.request().input("c", sql.Int, cid).input("i", sql.Int, id), sets = [];
  if (x.name !== undefined) { sets.push("name = @n"); rq.input("n", sql.NVarChar(100), x.name); }
  if (x.maxMb !== undefined) { sets.push("max_mb = @mb"); rq.input("mb", sql.Int, x.maxMb); }
  if (x.expiresAt !== undefined) { sets.push("expires_at = @exp"); rq.input("exp", sql.DateTime2, x.expiresAt ? new Date(x.expiresAt) : null); }
  rq.input("rows", sql.NVarChar(sql.MAX), x.lessonIds ? JSON.stringify(x.lessonIds.map((l, i) => ({ l, o: i }))) : null);
  const r = await rq.query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @ok INT = 0;
      UPDATE lms_offline_packs SET ${[...sets, "updated_at = SYSUTCDATETIME()"].join(", ")} WHERE id = @i AND course_id = @c AND status = 'draft' AND deleted_at IS NULL;
      SET @ok = @@ROWCOUNT;
      IF @ok = 1 AND @rows IS NOT NULL
      BEGIN
        DELETE FROM lms_offline_pack_lessons WHERE pack_id = @i AND course_id = @c;
        INSERT INTO lms_offline_pack_lessons (pack_id, course_id, lesson_id, sort_order) SELECT @i, @c, j.l, j.o FROM OPENJSON(@rows) WITH (l INT '$.l', o INT '$.o') j;
      END
      COMMIT; SELECT @ok AS ok;`);
  if (!(r.recordset && r.recordset[0] && Number(r.recordset[0].ok) === 1)) {
    const e = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`SELECT TOP 1 status FROM lms_offline_packs WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
    return e.recordset && e.recordset[0] ? reject("PACK_NOT_DRAFT", "Only a draft pack can be changed. Retire it and make a new one.") : notFound("Pack");
  }
  await audit(pool, actor, "offline_pack.updated", "lms_offline_packs", id, { courseId: cid, fields: Object.keys(x) });
  return { ok: true };
}

async function listPacks(pool, courseId) {
  const cid = posInt(courseId); if (!cid) return notFound();
  const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_PACKS} p.id, p.name, p.status, p.max_mb, p.expires_at, p.total_bytes, p.manifest_sha256, p.published_at,
      (SELECT COUNT(*) FROM lms_offline_pack_lessons l WHERE l.pack_id = p.id AND l.course_id = p.course_id) AS lessons
    FROM lms_offline_packs p WHERE p.course_id = @c AND p.deleted_at IS NULL ORDER BY p.id DESC`);
  return { ok: true, items: (r.recordset || []).map(shape) };
}

async function retirePack(pool, user, courseId, packId) {
  const cid = posInt(courseId), id = posInt(packId); if (!cid || !id) return notFound("Pack"); const actor = staffOf(user); if (!actor) return notFound("Pack");
  const r = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`UPDATE lms_offline_packs SET status = 'retired', retired_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id
    WHERE id = @i AND course_id = @c AND status <> 'retired' AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Pack");
  await audit(pool, actor, "offline_pack.retired", "lms_offline_packs", id, { courseId: cid });
  return { ok: true, retired: true };
}

/* PUBLISH: freeze the manifest (the integrity step). Nothing is changed unless every check passes. */
async function publishPack(pool, user, courseId, packId, ctx = {}) {
  const cid = posInt(courseId), id = posInt(packId); if (!cid || !id) return notFound("Pack"); const actor = staffOf(user); if (!actor) return notFound("Pack");
  const course = await courseRow(pool, cid); if (!course) return notFound();
  const pr = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`SELECT TOP 1 id, course_id, name, status, max_mb, expires_at FROM lms_offline_packs WHERE id = @i AND course_id = @c AND deleted_at IS NULL`);
  const pack = pr.recordset && pr.recordset[0]; if (!pack) return notFound("Pack");
  if (pack.status !== "draft") return reject("PACK_NOT_DRAFT", "Only a draft pack can be published.");
  if (course.status !== "published") return reject("COURSE_NOT_PUBLISHED", "Publish the course before publishing an offline pack.");
  if (pack.expires_at && new Date(pack.expires_at) <= (ctx.now || new Date())) return reject("PACK_EXPIRED", "The expiry date has passed. Set a new one first.");
  const ls = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`SELECT TOP ${MAX_LESSONS} pl.lesson_id, pl.sort_order, l.title, l.content_version, l.id AS live_id
    FROM lms_offline_pack_lessons pl LEFT JOIN lms_lessons l ON l.id = pl.lesson_id AND l.course_id = pl.course_id AND l.deleted_at IS NULL AND ${VISIBLE.replace(/\bstatus\b/g, "l.status").replace(/\bpublish_at\b/g, "l.publish_at")}
    WHERE pl.pack_id = @i AND pl.course_id = @c ORDER BY pl.sort_order, pl.lesson_id`);
  const rows = ls.recordset || []; if (!rows.length) return reject("PACK_EMPTY", "The pack has no lessons.");
  const gone = rows.filter((r) => !r.live_id).map((r) => r.lesson_id); if (gone.length) return reject("LESSON_NOT_AVAILABLE", "Some lessons are not visible to learners right now (not published, scheduled for later, or removed).", { lessonIds: gone });
  const br = await pool.request().input("c", sql.Int, cid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(rows.map((r) => r.lesson_id)))
    .query(`SELECT TOP ${MAX_BLOCKS_READ} lesson_id, block_type, sort_order, html, data FROM lms_lesson_blocks WHERE course_id = @c AND lesson_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) ORDER BY lesson_id, sort_order, id`);
  const byLesson = new Map(); for (const b of br.recordset || []) { if (!byLesson.has(b.lesson_id)) byLesson.set(b.lesson_id, []); byLesson.get(b.lesson_id).push(b); }
  const lessons = rows.map((r) => ({ id: r.lesson_id, title: r.title, content_version: r.content_version, blocks: byLesson.get(r.lesson_id) || [] }));
  const urls = [...new Set(lessons.flatMap((l) => l.blocks.map(urlOf)).filter((u) => u && !isExternal(u)))];
  if (urls.length > MAX_FILES) return reject("TOO_MANY_FILES", `A pack can hold at most ${MAX_FILES} files.`);
  const fileByUrl = new Map(), missing = [], mismatch = [];
  if (urls.length) {
    const mr = await pool.request().input("c", sql.Int, cid).input("urls", sql.NVarChar(sql.MAX), JSON.stringify(urls))
      .query(`SELECT TOP ${MAX_FILES} id, url, stored_name, original_name, ext, kind, size_bytes FROM lms_media_files WHERE course_id = @c AND deleted_at IS NULL AND url IN (SELECT value FROM OPENJSON(@urls))`);
    const media = new Map((mr.recordset || []).map((m) => [m.url, m]));
    for (const u of urls) {
      const m = media.get(u); if (!m) { missing.push(u); continue; }
      const h = await (typeof ctx.hasher === "function" ? ctx.hasher : defaultHasher)(ctx.tenant, m.stored_name); if (!h) { missing.push(u); continue; }
      if (Number(m.size_bytes) !== h.size) { mismatch.push(m.id); continue; }
      fileByUrl.set(u, { mediaId: m.id, name: m.original_name, ext: m.ext, kind: m.kind, sizeBytes: h.size, sha256: h.sha256 });
    }
  }
  if (missing.length) return reject("MEDIA_MISSING", "A file used by a lesson is missing from the media library or from storage.", { missing: missing.length });
  if (mismatch.length) return reject("MEDIA_CHANGED", "A stored file no longer matches its recorded size. Upload it again.", { mediaIds: mismatch });
  const builtAt = (ctx.now || new Date()).toISOString(), manifest = buildManifest({ pack, lessons, fileByUrl, builtAt });
  if (manifest.totalBytes > pack.max_mb * 1048576) return reject("PACK_TOO_LARGE", `The files total ${manifest.totalBytes} bytes, over the ${pack.max_mb} MB budget.`, { totalBytes: manifest.totalBytes, maxBytes: pack.max_mb * 1048576 });
  const text = JSON.stringify(manifest), h = sha(text);
  const up = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).input("m", sql.NVarChar(sql.MAX), text).input("h", sql.NVarChar(64), h).input("t", sql.BigInt, manifest.totalBytes)
    .query(`UPDATE lms_offline_packs SET status = 'published', manifest_json = @m, manifest_sha256 = @h, total_bytes = @t, published_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.id WHERE id = @i AND course_id = @c AND status = 'draft' AND deleted_at IS NULL`);
  if (!(up.recordset && up.recordset[0])) return reject("PACK_NOT_DRAFT", "Only a draft pack can be published.");
  await audit(pool, actor, "offline_pack.published", "lms_offline_packs", id, { courseId: cid, lessons: lessons.length, files: manifest.files.length, totalBytes: manifest.totalBytes });
  return { ok: true, manifestSha256: h, totalBytes: manifest.totalBytes, lessons: lessons.length, files: manifest.files.length };
}

/* LEARNER (student id comes from the token via studentAccess; the course id is matched in every query). */
async function learnerPacks(pool, courseId, now = new Date()) {
  const cid = posInt(courseId); if (!cid) return notFound();
  const r = await pool.request().input("c", sql.Int, cid).input("now", sql.DateTime2, now).query(`SELECT TOP ${MAX_PACKS} p.id, p.name, p.status, p.max_mb, p.expires_at, p.total_bytes, p.manifest_sha256, p.published_at,
      (SELECT COUNT(*) FROM lms_offline_pack_lessons l WHERE l.pack_id = p.id AND l.course_id = p.course_id) AS lessons
    FROM lms_offline_packs p WHERE p.course_id = @c AND p.deleted_at IS NULL AND p.status = 'published' AND (p.expires_at IS NULL OR p.expires_at > @now) ORDER BY p.id DESC`);
  return { ok: true, items: (r.recordset || []).map((x) => { const s = shape(x); return { id: s.id, name: s.name, totalBytes: s.totalBytes, lessons: s.lessons, expiresAt: s.expiresAt, manifestSha256: s.manifestSha256, publishedAt: s.publishedAt }; }) };
}

async function learnerManifest(pool, courseId, packId, now = new Date()) {
  const cid = posInt(courseId), id = posInt(packId); if (!cid || !id) return notFound("Pack");
  const r = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).input("now", sql.DateTime2, now)
    .query(`SELECT TOP 1 manifest_json, manifest_sha256 FROM lms_offline_packs WHERE id = @i AND course_id = @c AND deleted_at IS NULL AND status = 'published' AND (expires_at IS NULL OR expires_at > @now)`);
  const row = r.recordset && r.recordset[0]; if (!row || !row.manifest_json) return notFound("Pack");
  let manifest; try { manifest = JSON.parse(row.manifest_json); } catch { return notFound("Pack"); }
  const ids = manifest.lessons.map((l) => l.id);
  const cur = ids.length ? await pool.request().input("c", sql.Int, cid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(`SELECT id, content_version FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE} AND id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`) : { recordset: [] };
  const now2 = new Map((cur.recordset || []).map((x) => [x.id, x.content_version]));
  const staleLessons = manifest.lessons.filter((l) => now2.get(l.id) !== l.contentVersion).map((l) => l.id);
  return { ok: true, manifest, manifestSha256: row.manifest_sha256, staleLessons };
}

/* ---- L10.1b: lesson content + file bytes (D-114). Same gate as the manifest: published, unexpired, this course, else the same 404. ---- */
async function livePack(pool, cid, id, now) {
  const r = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).input("now", sql.DateTime2, now)
    .query(`SELECT TOP 1 manifest_json FROM lms_offline_packs WHERE id = @i AND course_id = @c AND deleted_at IS NULL AND status = 'published' AND (expires_at IS NULL OR expires_at > @now)`);
  const row = r.recordset && r.recordset[0]; if (!row || !row.manifest_json) return null;
  try { const m = JSON.parse(row.manifest_json); return m && Array.isArray(m.lessons) && Array.isArray(m.files) ? m : null; } catch { return null; }
}

/* A lesson's blocks EXACTLY as stored, so the device can recompute `lessonContentSha` and compare it with the manifest. The device (not the server) swaps each `files[].url`
   for its saved copy. If the lesson moved on since the freeze (version or content hash differs) nothing is served: 409 LESSON_CHANGED, the device must fetch a new pack. */
async function learnerLesson(pool, courseId, packId, lessonId, now = new Date()) {
  const cid = posInt(courseId), id = posInt(packId), lid = posInt(lessonId); if (!cid || !id || !lid) return notFound("Pack");
  const man = await livePack(pool, cid, id, now); if (!man) return notFound("Pack");
  const entry = man.lessons.find((l) => l.id === lid); if (!entry) return notFound("Lesson");
  const cur = await pool.request().input("c", sql.Int, cid).input("l", sql.Int, lid)
    .query(`SELECT TOP 1 id, content_version FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`);
  const live = cur.recordset && cur.recordset[0]; if (!live) return notFound("Lesson");
  const changed = () => reject("LESSON_CHANGED", "This lesson was edited after the pack was built. Download the pack again.", { lessonId: lid });
  if (live.content_version !== entry.contentVersion) return changed();
  const br = await pool.request().input("c", sql.Int, cid).input("l", sql.Int, lid)
    .query(`SELECT TOP ${MAX_BLOCKS_READ} block_type, sort_order, html, data FROM lms_lesson_blocks WHERE course_id = @c AND lesson_id = @l ORDER BY sort_order, id`);
  const blocks = br.recordset || []; if (lessonContentSha(blocks) !== entry.contentSha256) return changed();
  const inPack = new Set(man.files.map((f) => f.mediaId)), urls = [...new Set(blocks.map(urlOf).filter((u) => u && !isExternal(u)))], files = [];
  if (urls.length) {
    const mr = await pool.request().input("c", sql.Int, cid).input("urls", sql.NVarChar(sql.MAX), JSON.stringify(urls))
      .query(`SELECT TOP ${MAX_FILES} id, url FROM lms_media_files WHERE course_id = @c AND deleted_at IS NULL AND url IN (SELECT value FROM OPENJSON(@urls))`);
    for (const m of mr.recordset || []) if (inPack.has(m.id)) files.push({ url: m.url, mediaId: m.id });
  }
  return { ok: true, lesson: { id: lid, title: entry.title, contentVersion: entry.contentVersion, contentSha256: entry.contentSha256 },
    blocks: blocks.map((b) => ({ type: b.block_type, sortOrder: b.sort_order, html: b.html ?? null, data: b.data ?? null })), files };
}

/* Pure. One byte range only. null = no/ignored header (send everything); "bad" = 416; { start, end } inclusive. */
function parseRange(header, size) {
  if (header === undefined || header === null || header === "") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim()); if (!m || (m[1] === "" && m[2] === "")) return "bad";
  if (!(size > 0)) return "bad";
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (!(n > 0)) return "bad"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); if (start >= size || end < start) return "bad"; }
  return { start, end };
}

/* The file opener: (tenant, storedName) -> { size, stream(start, end), close() } or null. Only the file NAME is used. A caller may pass its own as `ctx.open` (tests); no shared global. */
const defaultOpen = async (tenant, storedName) => {
  const abs = path.join(UPLOADS_ROOT, safeTenant(tenant), "lms", path.basename(String(storedName || "")));
  let fh; try { fh = await fs.promises.open(abs, "r"); } catch { return null; }
  try { const st = await fh.stat(); if (!st.isFile()) { await fh.close(); return null; } return { size: st.size, stream: (start, end) => fh.createReadStream({ start, end, autoClose: true }), close: () => fh.close().catch(() => {}) }; }
  catch { await fh.close().catch(() => {}); return null; }
};

/* Opens one pack file for streaming. The media id must be listed in THIS pack's manifest; the library row and the real file size must still equal the manifest, otherwise the same
   404 (a changed file is never served under the old hash). On success the caller owns `file.stream` and must pipe it (or call `file.close()`). */
async function learnerFile(pool, courseId, packId, mediaId, ctx = {}) {
  const cid = posInt(courseId), id = posInt(packId), mid = posInt(mediaId); if (!cid || !id || !mid) return notFound("File");
  const man = await livePack(pool, cid, id, ctx.now || new Date()); if (!man) return notFound("File");
  const entry = man.files.find((f) => f.mediaId === mid); if (!entry) return notFound("File");
  const r = await pool.request().input("c", sql.Int, cid).input("m", sql.Int, mid)
    .query(`SELECT TOP 1 stored_name, size_bytes FROM lms_media_files WHERE id = @m AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row || Number(row.size_bytes) !== entry.sizeBytes) return notFound("File");
  const f = await (typeof ctx.open === "function" ? ctx.open : defaultOpen)(ctx.tenant, row.stored_name); if (!f) return notFound("File");
  if (f.size !== entry.sizeBytes) { if (f.close) await f.close(); return notFound("File"); }
  const range = parseRange(ctx.range, f.size);
  if (range === "bad") { if (f.close) await f.close(); return { ok: false, rangeError: true, size: f.size, errors: ["That byte range cannot be served."] }; }
  const start = range ? range.start : 0, end = range ? range.end : f.size - 1;
  return { ok: true, file: { size: f.size, start, end, length: f.size ? end - start + 1 : 0, partial: !!range, name: entry.name, ext: entry.ext, sha256: entry.sha256, stream: f.size ? f.stream(start, end) : null, close: f.close } };
}

module.exports = { parseRange, learnerLesson, learnerFile, MAX_PACKS, MAX_LESSONS, MAX_FILES, MAX_MB, DEFAULT_MB, validatePack, lessonContentSha, buildManifest, createPack, updatePack, listPacks, retirePack, publishPack, learnerPacks, learnerManifest };
