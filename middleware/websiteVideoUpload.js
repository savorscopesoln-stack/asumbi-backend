const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   WEBSITE VIDEO UPLOAD MIDDLEWARE
   Same pattern as websitePhotoUpload.js / websiteFileUpload.js
   (disk storage, its own directory, served statically) but for
   actual video clips — e.g. the Gallery section's "Watch tour"
   tiles, which previously only had a checkbox with no real file
   behind it.

   Files land in backend/uploads/website-videos and are served
   statically at /uploads/website-videos/<filename>, already
   covered by the existing app.use("/uploads", express.static(...))
   mount in server.js.

   Limit is much higher than images/documents (200MB) since even
   a short 1-2 minute campus-tour clip easily runs tens of MB.
========================================================= */

const UPLOAD_KIND = "website-videos";
const { uploadDir, uploadUrl, deleteUploadByUrl } = require("../utils/uploadPaths");

const ALLOWED_MIME = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const ALLOWED_EXT = new Set([".mp4", ".webm", ".ogg", ".ogv", ".mov"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir(UPLOAD_KIND, req)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : ".mp4";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only MP4, WebM, OGG, or MOV videos are allowed"));
  }
  cb(null, true);
};

const websiteVideoUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// Public URL path for a stored video filename. Stored as-is in the
// section's content_json (e.g. a gallery item's `video` field); the
// public website prefixes it with the backend's origin when
// rendering <video src>, same as image fields.
const websiteVideoUrlFor = (filename) => uploadUrl(UPLOAD_KIND, filename);

// Best-effort delete of a previously stored video — used when an
// admin replaces/removes it. Never throws; a missing/unlinkable
// file just gets logged.
const deleteWebsiteVideoByUrl = (url) => deleteUploadByUrl(url, UPLOAD_KIND);

// Promise wrapper so the route can handle a multer error as a normal
// try/catch JSON 400 rather than needing separate error middleware.
const runWebsiteVideoUpload = (req, res) =>
  new Promise((resolve, reject) => {
    websiteVideoUpload.single("video")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { websiteVideoUrlFor, deleteWebsiteVideoByUrl, runWebsiteVideoUpload };
