/* =========================================================================
   LMS MEDIA  (L3.2a): upload, list and delete lesson files.

   Rules (master prompt rules 7 + 9, decisions D-012/D-016/D-035):
   - the file's REAL bytes must match its extension (magic-number check); a
     renamed .exe/.html is refused whatever its name says;
   - extension must be on the tenant's allowed list and never on the
     script-capable list; size limit and storage quota come from settings;
   - stored under uploads/<school>/lms/ with a RANDOM name (the original name is
     display text only), so URLs cannot be guessed and names cannot traverse;
   - a scan hook runs before the file is written (default: accept; plug a
     virus scanner in with setScanner());
   - a file used by a lesson block cannot be deleted from under it.
   Uploads are held in memory for the check, so the per-file cap is
   min(settings maxFileMb, MEMORY_CAP_MB). Longer videos belong on YouTube/Vimeo.
========================================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { FORBIDDEN_EXT } = require("./lmsSettings");
const { UPLOADS_ROOT, safeTenant } = require("./uploadPaths");
const { checkQuota, invalidateStorage } = require("./lmsUsage");
const { posInt, editable } = require("./lmsCourseParts");

const MEMORY_CAP_MB = 25, MAX_LIST = 100;
const KIND = { jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", mp4: "video", webm: "video" };
const kindOf = (ext) => KIND[ext] || "file";

const startsWith = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v);
const ascii = (b, at, s) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;
const isText = (b) => { if (b.includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } };
/* ext -> test of the file's first bytes. Office files: new formats are zip ("PK"), old ones OLE ("D0CF"). */
const SIGN = {
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]), jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]), png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"), webp: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  pdf: (b) => ascii(b, 0, "%PDF-"), mp3: (b) => ascii(b, 0, "ID3") || (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  m4a: (b) => ascii(b, 4, "ftyp"), mp4: (b) => ascii(b, 4, "ftyp"), wav: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE"), ogg: (b) => ascii(b, 0, "OggS"),
  webm: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  docx: (b) => startsWith(b, [0x50, 0x4b]), xlsx: (b) => startsWith(b, [0x50, 0x4b]), pptx: (b) => startsWith(b, [0x50, 0x4b]), zip: (b) => startsWith(b, [0x50, 0x4b]),
  doc: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]), xls: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]), ppt: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]),
  txt: isText, csv: isText, md: isText,
};
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : null; };
const displayName = (name) => String(name || "file").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 150) || "file";

let scanner = async () => ({ ok: true });
/* scanner(buffer, { ext, name }) -> { ok, reason? }. A throw counts as a refusal (fail closed). */
const setScanner = (fn) => { scanner = typeof fn === "function" ? fn : async () => ({ ok: true }); };

/* Shared by other uploaders (submissions): true only when the scan hook says ok; a throw counts as a refusal (fail closed). */
async function runScan(buffer, meta, override) {
  try { const r = await (typeof override === "function" ? override : scanner)(buffer, meta); return !!(r && r.ok === true); } catch { return false; }
}

/* Pure check of one upload against the tenant's settings. */
function checkUpload(file, settings) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) return { ok: false, code: "NO_FILE", errors: ["Choose a file to upload."] };
  const ext = extOf(file.originalname);
  const allowed = (settings?.files?.allowedExtensions || []).map((e) => String(e).toLowerCase());
  if (!ext || FORBIDDEN_EXT.has(ext) || !allowed.includes(ext) || !SIGN[ext]) return { ok: false, code: "FILE_TYPE_NOT_ALLOWED", errors: ["This file type is not allowed."] };
  const maxMb = Math.min(settings?.files?.maxFileMb || 10, MEMORY_CAP_MB);
  if (file.buffer.length > maxMb * 1048576) return { ok: false, code: "FILE_TOO_LARGE", errors: [`Files can be at most ${maxMb} MB. For longer videos use a YouTube or Vimeo link.`] };
  if (!SIGN[ext](file.buffer)) return { ok: false, code: "FILE_CONTENT_MISMATCH", errors: ["The file's contents do not match its type."] };
  return { ok: true, ext, size: file.buffer.length };
}

const shape = (r) => ({ id: r.id, courseId: r.course_id, url: r.url, name: r.original_name, ext: r.ext, kind: r.kind, sizeBytes: Number(r.size_bytes), createdAt: r.created_at });

async function uploadMedia(pool, user, courseId, file, settings, tenant, opts = {}) {
  const c = checkUpload(file, settings); if (!c.ok) return c;
  const e = await editable(pool, courseId); if (!e.ok) return e;
  let scan; try { scan = await (typeof opts.scanner === "function" ? opts.scanner : scanner)(file.buffer, { ext: c.ext, name: displayName(file.originalname) }); } catch { scan = { ok: false }; }
  if (!scan || scan.ok !== true) return { ok: false, code: "FILE_REJECTED", errors: ["This file was rejected by the safety check."] };
  const q = await checkQuota(tenant, settings?.storageQuotaMb, file.buffer.length);
  if (!q.ok) return { ok: false, code: "LMS_STORAGE_QUOTA_EXCEEDED", errors: ["This school's LMS storage is full."] };
  const stored = `${crypto.randomBytes(16).toString("hex")}.${c.ext}`, key = safeTenant(tenant);
  const dir = path.join(UPLOADS_ROOT, key, "lms");
  await fs.promises.mkdir(dir, { recursive: true });
  const abs = path.join(dir, stored);
  await fs.promises.writeFile(abs, file.buffer, { flag: "wx" });
  const url = `/uploads/${key}/lms/${stored}`, actor = actorOf(user);
  try {
    const r = await pool.request().input("c", sql.Int, courseId).input("sn", sql.NVarChar(200), stored).input("u", sql.NVarChar(400), url).input("on", sql.NVarChar(200), displayName(file.originalname))
      .input("x", sql.NVarChar(10), c.ext).input("k", sql.NVarChar(20), kindOf(c.ext)).input("sz", sql.BigInt, c.size).input("src", sql.NVarChar(20), actor?.source ?? null).input("uid", sql.Int, actor?.id ?? null)
      .query(`INSERT INTO lms_media_files (course_id, stored_name, url, original_name, ext, kind, size_bytes, created_by_source, created_by)
              OUTPUT INSERTED.id, INSERTED.course_id, INSERTED.url, INSERTED.original_name, INSERTED.ext, INSERTED.kind, INSERTED.size_bytes, INSERTED.created_at
              VALUES (@c, @sn, @u, @on, @x, @k, @sz, @src, @uid)`);
    const row = r.recordset && r.recordset[0]; if (!row) throw new Error("no row");
    invalidateStorage(tenant);
    await audit(pool, actor, "media.uploaded", "lms_media_files", row.id, { courseId, ext: c.ext, bytes: c.size });
    return { ok: true, file: shape(row) };
  } catch (err) { await fs.promises.unlink(abs).catch(() => {}); throw err; } // never leave an orphan file without a row
}

async function listMedia(pool, courseId, query = {}) {
  const page = Math.max(1, posInt(query.page) || 1), size = Math.min(MAX_LIST, posInt(query.pageSize) || 24);
  const r = await pool.request().input("c", sql.Int, courseId).input("off", sql.Int, (page - 1) * size).input("lim", sql.Int, size)
    .query(`SELECT id, course_id, url, original_name, ext, kind, size_bytes, created_at, COUNT(*) OVER() AS total_count FROM lms_media_files
            WHERE course_id = @c AND deleted_at IS NULL ORDER BY id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { page, pageSize: size, total: rows.length ? rows[0].total_count : 0, items: rows.map(shape) };
}

async function deleteMedia(pool, user, courseId, mediaId, tenant) {
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const f = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, mediaId)
    .query(`SELECT TOP 1 id, stored_name, url FROM lms_media_files WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = f.recordset && f.recordset[0]; if (!row) return { ok: false, notFound: true, errors: ["File not found."] };
  const used = await pool.request().input("c", sql.Int, courseId).input("u", sql.NVarChar(450), `%${String(row.url).replace(/[%_\[]/g, "[$&]")}%`)
    .query(`SELECT TOP 1 b.id FROM lms_lesson_blocks b INNER JOIN lms_lessons l ON l.id = b.lesson_id AND l.deleted_at IS NULL WHERE b.course_id = @c AND b.data LIKE @u`);
  if (used.recordset && used.recordset.length) return { ok: false, code: "MEDIA_IN_USE", errors: ["This file is used in a lesson. Remove it from the lesson first."] };
  const d = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, mediaId)
    .query(`UPDATE lms_media_files SET deleted_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(d.recordset && d.recordset.length)) return { ok: false, notFound: true, errors: ["File not found."] };
  const abs = path.join(UPLOADS_ROOT, safeTenant(tenant), "lms", path.basename(String(row.stored_name)));
  await fs.promises.unlink(abs).catch(() => {});
  invalidateStorage(tenant);
  await audit(pool, actorOf(user), "media.deleted", "lms_media_files", mediaId, { courseId });
  return { ok: true };
}

/* Thin multer wrapper: memory storage, one file in field "file", size capped by the tenant's setting. */
function uploadMiddleware(getSettings) {
  return async (req, res, next) => {
    try {
      const multer = require("multer");
      const s = await getSettings(req.pool), cap = Math.min(s.files.maxFileMb, MEMORY_CAP_MB) * 1048576;
      multer({ storage: multer.memoryStorage(), limits: { fileSize: cap, files: 1, fields: 0, parts: 2 } }).single("file")(req, res, (err) => {
        if (!err) return next();
        const big = err.code === "LIMIT_FILE_SIZE";
        res.status(big ? 413 : 400).json({ success: false, code: big ? "FILE_TOO_LARGE" : "UPLOAD_FAILED", message: big ? "That file is too large." : "The upload could not be read." });
      });
    } catch (err) { console.error("LMS UPLOAD ERROR:", err.message); res.status(500).json({ success: false, message: "Something went wrong. Please try again." }); }
  };
}

module.exports = { MEMORY_CAP_MB, SIGN, extOf, displayName, kindOf, setScanner, runScan, checkUpload, uploadMedia, listMedia, deleteMedia, uploadMiddleware };
