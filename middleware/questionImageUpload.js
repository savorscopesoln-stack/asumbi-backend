const fs = require("fs");
const path = require("path");
const multer = require("multer");

/* =========================================================
   QUESTION IMAGE UPLOAD MIDDLEWARE
   Same disk-storage pattern as photoUpload.js — lets a teacher attach
   one or more diagrams/photos to a single question while setting it
   by hand (separately, images pulled out of an imported Word document
   are written straight to this same folder by the docx-import code in
   eAssessment.controller.js, so both paths end up in one place).

   Files land in backend/uploads/question-images and are served
   statically at /uploads/question-images/<filename> (covered by the
   existing app.use("/uploads", express.static(...)) mount).

   Up to 6 images per upload call, 8MB each — plenty for a diagram or
   scanned figure without letting one request balloon.
========================================================= */

const UPLOAD_KIND = "question-images";
const { uploadDir, uploadUrl, deleteUploadByUrl } = require("../utils/uploadPaths");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir(UPLOAD_KIND, req)),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : ".jpg";
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, GIF, or WEBP images are allowed"));
  }
  cb(null, true);
};

const questionImageUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
});

const questionImageUrlFor = (filename) => uploadUrl(UPLOAD_KIND, filename);

// Best-effort delete of a previously stored question image.
const deleteQuestionImageByUrl = (url) => deleteUploadByUrl(url, UPLOAD_KIND);

const runQuestionImageUpload = (req, res) =>
  new Promise((resolve, reject) => {
    questionImageUpload.array("images", 6)(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = {
  questionImagesDir: (req) => uploadDir(UPLOAD_KIND, req),
  questionImageUrlFor,
  deleteQuestionImageByUrl,
  runQuestionImageUpload,
};
