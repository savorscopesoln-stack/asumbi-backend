/* =========================================================================
   PER-SCHOOL UPLOAD FOLDERS
   Every uploaded file lives under  uploads/<tenant>/<kind>/<file>  and is
   addressed by  /uploads/<tenant>/<kind>/<file>  (kind = photos, website,
   cover-pages, question-images, ...). Two schools therefore never share a
   folder, and a stored URL names the school it belongs to.

   The current school comes from an AsyncLocalStorage set by server.js's DB
   middleware, so the existing url/delete helpers keep their signatures.
   Old URLs without a school segment (/uploads/photos/x.jpg) still resolve to
   the legacy shared folders until scripts/migrateUploadsToTenantFolders.js
   has moved them; after that set LEGACY_UPLOADS=off to stop serving them.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");
const store = new AsyncLocalStorage();

const safeTenant = (t) => {
  const k = String(t || "default").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return k || "default";
};

/** Run `fn` with `tenant` as the current school (used by server.js middleware). */
const runWithTenant = (tenant, fn) => store.run({ tenant: safeTenant(tenant) }, fn);
const currentTenant = (req) => safeTenant(req?.tenant || store.getStore()?.tenant);

/** Absolute folder for this school's `kind` (created on demand). */
function uploadDir(kind, req) {
  const dir = path.join(UPLOADS_ROOT, currentTenant(req), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Public URL for a file just stored in this school's `kind` folder. */
const uploadUrl = (kind, filename, req) => `/uploads/${currentTenant(req)}/${kind}/${filename}`;

/**
 * Disk path for a stored URL — or null when it must not be touched.
 * - /uploads/<tenant>/<kind>/<file>: only if <tenant> is the CURRENT school,
 *   so one school can never delete/read another school's file.
 * - /uploads/<kind>/<file> (legacy, no school segment): the old shared folder.
 * - an absolute path already inside uploads/ (multer's req.file.path).
 */
function resolveUploadFile(urlOrPath, kind, req) {
  if (!urlOrPath) return null;
  const raw = String(urlOrPath);
  let abs = null;
  if (path.isAbsolute(raw) && raw.startsWith(UPLOADS_ROOT + path.sep)) {
    abs = raw;
  } else {
    const parts = raw.split("?")[0].split("/").filter(Boolean); // ["uploads", ...]
    if (parts[0] !== "uploads" || parts.some((p) => p === "..")) return null;
    if (parts.length === 4 && parts[2] === kind) {
      if (parts[1] !== currentTenant(req)) return null; // someone else's file
      abs = path.join(UPLOADS_ROOT, parts[1], kind, parts[3]);
    } else if (parts.length === 3 && parts[1] === kind) {
      abs = path.join(UPLOADS_ROOT, kind, parts[2]); // legacy
    }
  }
  if (!abs) return null;
  const rel = path.relative(UPLOADS_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

function deleteUploadByUrl(urlOrPath, kind, req) {
  try {
    const abs = resolveUploadFile(urlOrPath, kind, req);
    if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (err) {
    console.error("upload delete failed:", err.message);
  }
}

module.exports = { UPLOADS_ROOT, runWithTenant, currentTenant, uploadDir, uploadUrl, resolveUploadFile, deleteUploadByUrl, safeTenant };
