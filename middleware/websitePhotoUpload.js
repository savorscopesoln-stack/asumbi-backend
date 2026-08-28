const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   WEBSITE IMAGE UPLOAD MIDDLEWARE
   Same pattern as middleware/photoUpload.js (disk storage, so
   files persist and can be served back over HTTP) but kept in
   its own uploads/website directory rather than mixing with
   student/teacher profile photos in uploads/photos.

   Files land in backend/uploads/website and are served
   statically at /uploads/website/<filename> — already covered
   by the existing app.use("/uploads", express.static(...))
   mount in server.js, since that serves the whole uploads/
   folder, not just uploads/photos.

   Limit is higher than profile photos (10MB vs 5MB) since hero
   backgrounds and gallery shots are often larger than a portrait
   crop, but still bounded so someone can't upload something huge
   through the admin CMS.
========================================================= */

const WEBSITE_IMAGES_DIR = path.join(__dirname, "..", "uploads", "website");
fs.mkdirSync(WEBSITE_IMAGES_DIR, { recursive: true });

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WEBSITE_IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const safeExt = ALLOWED_EXT.has(ext) ? ext : ".jpg";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, or WEBP images are allowed"));
  }
  cb(null, true);
};

const websiteImageUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Public URL path for a stored image filename. Stored as-is in the
// section's content_json (e.g. principal.photo); the public website
// prefixes it with the backend's origin when rendering <img src>,
// since the website and backend are separate deployments/domains.
const websiteImageUrlFor = (filename) => `/uploads/website/${filename}`;

// Best-effort delete of a previously stored image — used when an
// admin replaces an image (old file becomes orphaned otherwise).
// Never throws; a missing/unlinkable file just gets logged.
const deleteWebsiteImageByUrl = (url) => {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/website/")) return;
  const filename = path.basename(url);
  const filePath = path.join(WEBSITE_IMAGES_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("WEBSITE IMAGE CLEANUP ERROR:", err.message);
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
