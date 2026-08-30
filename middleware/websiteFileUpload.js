const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   WEBSITE DOCUMENT UPLOAD MIDDLEWARE
   Same pattern as websitePhotoUpload.js, but for the Downloads
   CMS section — PDFs, Word docs, spreadsheets — rather than
   images. Kept in its own uploads/website-files directory so
   documents don't mix with photos.

   Files land in backend/uploads/website-files and are served
   statically at /uploads/website-files/<filename>, covered by
   the existing app.use("/uploads", express.static(...)) mount
   in server.js.

   Limit is higher than images (20MB) since prospectuses/
   handbooks can run several MB, but still bounded.
========================================================= */

const WEBSITE_FILES_DIR = path.join(__dirname, "..", "uploads", "website-files");
fs.mkdirSync(WEBSITE_FILES_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const ALLOWED_EXT = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WEBSITE_FILES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : ".pdf";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only PDF, Word, or Excel documents are allowed"));
  }
  cb(null, true);
};

const websiteFileUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// Public URL path for a stored document filename. Stored as-is in
// the "downloads" section's content_json; the public website
// prefixes it with the backend's origin, same as image fields.
const websiteFileUrlFor = (filename) => `/uploads/website-files/${filename}`;

// Best-effort delete of a previously uploaded document — used when
// an admin replaces/removes a download. Never throws.
const deleteWebsiteFileByUrl = (url) => {
  if (!url || typeof url !== "string" || !url.startsWith("/uploads/website-files/")) return;
  const filename = path.basename(url);
  const filePath = path.join(WEBSITE_FILES_DIR, filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("WEBSITE FILE CLEANUP ERROR:", err.message);
    }
  });
};

const runWebsiteFileUpload = (req, res) =>
  new Promise((resolve, reject) => {
    websiteFileUpload.single("file")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { websiteFileUrlFor, deleteWebsiteFileByUrl, runWebsiteFileUpload };
