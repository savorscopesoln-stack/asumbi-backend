const multer = require("multer");

/* =========================================================
   QUESTION DOCUMENT (.docx) UPLOAD MIDDLEWARE
   Memory storage (like the Excel/CSV bulk-upload routes in
   routes/studentsRoutes.js / routes/TeacherRoutes.js) rather than disk
   storage — the file is only needed for the length of one request, to
   be parsed by mammoth in eAssessment.controller.js (parseQuestionsDocx),
   and never needs to be served back out or persisted.

   .docx only (the old binary .doc format isn't something mammoth can
   read) — capped at 15MB, generous for a question paper with a handful
   of embedded diagrams.
========================================================= */

const ALLOWED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const fileFilter = (req, file, cb) => {
  const nameOk = /\.docx$/i.test(file.originalname || "");
  if (!ALLOWED_MIME.has(file.mimetype) && !nameOk) {
    return cb(new Error("Only .docx Word documents are supported for question import"));
  }
  cb(null, true);
};

const questionDocUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 },
});

const runQuestionDocUpload = (req, res) =>
  new Promise((resolve, reject) => {
    questionDocUpload.single("file")(req, res, (err) => (err ? reject(err) : resolve()));
  });

module.exports = { runQuestionDocUpload };
