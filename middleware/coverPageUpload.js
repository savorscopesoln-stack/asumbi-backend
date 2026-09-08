const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   EXAM COVER PAGE UPLOAD MIDDLEWARE
   Same disk-storage pattern as photoUpload.js / websiteFileUpload.js —
   each e-assessment can carry its own cover page PDF (title page,
   instructions sheet, letterhead, etc.), shown to students before
   they start that specific exam.

   Files land in backend/uploads/cover-pages and are served statically
   at /uploads/cover-pages/<filename> (covered by the existing
   app.use("/uploads", express.static(...)) mount in server.js).

   PDF only — this is a cover PAGE, not a general document upload —
   capped at 20MB same as the website document uploads.
========================================================= */

const COVER_PAGES_DIR = path.join(__dirname, "..", "uploads", "cover-pages");
fs.mkdirSync(COVER_PAGES_DIR, { recursive: true });

const ALLOWED_MIME = new Set(["application/pdf"]);
const ALLOWED_EXT = new Set([".pdf"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COVER_PAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : ".pdf";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only PDF files are allowed for a cover page"));
  }
  cb(null, true);
};

const coverPageUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// Public URL path for a stored cover page filename — stored in the DB
// as this, and prefixed with the backend origin on the frontend
// (see FILE_BASE_URL / resolvePhotoUrl-style helpers in frontend/src/api.js).
const coverPageUrlFor = (filename) => `/uploads/cover-pages/${filename}`;

// Best-effort delete of a previously stored cover page — used when a
// cover page is replaced or removed. Never throws; a missing/unlinkable
// file just gets logged.
const deleteCoverPageByUrl = (url) => {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/cover-pages/")) return;
  const filename = path.basename(url);
  const filePath = path.join(COVER_PAGES_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("COVER PAGE CLEANUP ERROR:", err.message);
    }
  });
};

const runCoverPageUpload = (req, res) =>
  new Promise((resolve, reject) => {
    coverPageUpload.single("cover_page")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { coverPageUrlFor, deleteCoverPageByUrl, runCoverPageUpload };
