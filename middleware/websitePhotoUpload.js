const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   WEBSITE MEDIA UPLOAD MIDDLEWARE
   Backs every "image" field across the whole admin CMS (hero
   background, principal photo, news/testimonial/leadership/staff
   photos, gallery tiles, event photos, site logo, map photo, and
   the gallery's "video clip" field) through ONE upload pipeline —
   deliberately not split by field, so a fix or a new allowed file
   type here applies everywhere at once instead of needing to be
   repeated per page.

   Accepts BOTH images and short video clips (so any "photo" field
   can just as well take a video — e.g. a gallery tile's "watch
   tour" clip) and disk-stores them, so files persist and can be
   served back over HTTP.

   Files land in backend/uploads/website and are served statically
   at /uploads/website/<filename> — already covered by the existing
   app.use("/uploads", express.static(...)) mount in server.js,
   since that serves the whole uploads/ folder, not just
   uploads/photos.

   Limit is sized for the larger of the two media types (a short
   video clip), since a single multer instance has one shared cap.
========================================================= */

const WEBSITE_MEDIA_DIR = path.join(__dirname, "..", "uploads", "website");
fs.mkdirSync(WEBSITE_MEDIA_DIR, { recursive: true });

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const ALLOWED_VIDEO_EXT = new Set([".mp4", ".webm", ".ogg", ".ogv", ".mov"]);

const ALLOWED_MIME = new Set([...ALLOWED_IMAGE_MIME, ...ALLOWED_VIDEO_MIME]);
const ALLOWED_EXT = new Set([...ALLOWED_IMAGE_EXT, ...ALLOWED_VIDEO_EXT]);

// Video clips run far larger than photos, so the shared limit is sized
// for video (200MB); a JPG/PNG/WEBP will obviously never come close.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WEBSITE_MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isVideo = ALLOWED_VIDEO_MIME.has(file.mimetype);
    const fallbackExt = isVideo ? ".mp4" : ".jpg";
    const safeExt = ALLOWED_EXT.has(ext) ? ext : fallbackExt;
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP photos or MP4, WebM, OGG, MOV videos are allowed"));
  }
  cb(null, true);
};

const websiteImageUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Public URL path for a stored media filename (photo or video). Stored
// as-is in the section's content_json (e.g. principal.photo, or a
// gallery item's video field); the public website prefixes it with the
// backend's origin when rendering <img>/<video> src, since the website
// and backend are separate deployments/domains.
const websiteImageUrlFor = (filename) => `/uploads/website/${filename}`;

// Best-effort delete of a previously stored file — used when an admin
// replaces an image/video. Never throws; a missing/unlinkable file
// just gets logged.
const deleteWebsiteImageByUrl = (url) => {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/website/")) return;
  const filename = path.basename(url);
  const filePath = path.join(WEBSITE_MEDIA_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("WEBSITE MEDIA CLEANUP ERROR:", err.message);
    }
  });
};

// Promise wrapper so the route can handle a multer error as a normal
// try/catch JSON 400 rather than needing separate error middleware.
const runWebsiteImageUpload = (req, res) =>
  new Promise((resolve, reject) => {
    websiteImageUpload.single("image")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { websiteImageUrlFor, deleteWebsiteImageByUrl, runWebsiteImageUpload };
