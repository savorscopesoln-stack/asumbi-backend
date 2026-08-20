const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   PROFILE PHOTO UPLOAD MIDDLEWARE
   Disk storage (unlike the memoryStorage() multer instance
   used for the Excel/CSV bulk-upload routes) — photos need to
   persist as real files so they can be served back over HTTP
   and survive past the single request that uploaded them.

   Files land in backend/uploads/photos and are served
   statically at /uploads/photos/<filename> (mounted in
   server.js). Only image mimetypes are accepted, capped at 5MB.
========================================================= */

const PHOTOS_DIR = path.join(__dirname, "..", "uploads", "photos");
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTOS_DIR),
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

const photoUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Public URL path for a stored photo filename (stored in DB as this,
// and prefixed with the backend origin on the frontend when rendered).
const photoUrlFor = (filename) => `/uploads/photos/${filename}`;

// Best-effort delete of a previously stored photo — used when a photo
// is replaced or when a registration fails after the file was written.
// Never throws; a missing/unlinkable file just gets logged.
const deletePhotoByUrl = (photoUrl) => {
  if (!photoUrl) return;
  const filename = path.basename(photoUrl);
  const filePath = path.join(PHOTOS_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("PHOTO CLEANUP ERROR:", err.message);
    }
  });
};

// Promise wrapper so routes that need the file *and* other validation
// in one try/catch (e.g. registration, which requires the photo like
// any other required field) don't need a separate Express error
// middleware just to turn a multer error into a normal JSON 400.
const runPhotoUpload = (req, res) =>
  new Promise((resolve, reject) => {
    photoUpload.single("photo")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { photoUpload, photoUrlFor, deletePhotoByUrl, runPhotoUpload, PHOTOS_DIR };
