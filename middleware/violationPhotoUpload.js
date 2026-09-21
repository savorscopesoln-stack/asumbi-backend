const fs = require("fs");
const path = require("path");

/* =========================================================
   EXAM VIOLATION PHOTO STORAGE
   Same disk-storage spirit as coverPageUpload.js / questionImageUpload.js,
   adapted for a base64 data URL instead of a multipart file — the
   student's browser (TakeEAssessment.jsx) draws a frame from their own
   camera onto a <canvas>, burns in a caption, and posts the resulting
   JPEG as a data URL in a normal JSON body rather than multipart, since
   this fires silently in the background from inside a face-detection
   loop and never involves an actual <input type="file">.

   Files land in backend/uploads/violation-photos and are served
   statically at /uploads/violation-photos/<filename> (covered by the
   existing app.use("/uploads", express.static(...)) mount in server.js)
   — but that route is intentionally never linked to from anywhere a
   student can reach; only an admin who already has the exact filename
   from getViolationPhotos can resolve it into a URL. Directory
   listing is disabled by Express's static middleware by default.
========================================================= */

const VIOLATION_PHOTOS_DIR = path.join(__dirname, "..", "uploads", "violation-photos");
fs.mkdirSync(VIOLATION_PHOTOS_DIR, { recursive: true });

const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

// Decodes and writes a data URL to disk, returning the stored filename
// (not the full URL — callers combine it with violationPhotoUrlFor).
// Throws on anything that isn't a well-formed, reasonably-sized image
// data URL — callers are expected to turn that into a 400.
const saveViolationPhoto = (dataUrl) => {
  if (typeof dataUrl !== "string") throw new Error("image must be a data URL string");
  const match = dataUrl.match(DATA_URL_RE);
  if (!match) throw new Error("image must be a base64 JPEG/PNG/WebP data URL");

  const ext = match[1] === "jpg" ? "jpeg" : match[1];
  const buffer = Buffer.from(match[2], "base64");

  // 8MB is generous for a single 640x480 JPEG frame + caption bar; guards
  // against a malformed/oversized payload without needing multer here.
  const MAX_BYTES = 8 * 1024 * 1024;
  if (buffer.length === 0 || buffer.length > MAX_BYTES) {
    throw new Error("image is empty or too large");
  }

  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
  fs.writeFileSync(path.join(VIOLATION_PHOTOS_DIR, filename), buffer);
  return filename;
};

const violationPhotoUrlFor = (filename) => `/uploads/violation-photos/${filename}`;

module.exports = { saveViolationPhoto, violationPhotoUrlFor, VIOLATION_PHOTOS_DIR };
