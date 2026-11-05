/* L11.6: POST /api/upload/preview, a DRY RUN of the bulk import in server.js (/api/upload).
   Mounted behind protect + adminOnly. Reads the file in memory (never writes it to disk), parses it only through
   utils/safeSpreadsheet, touches NO database and logs NO row data. Returns counts, the first problems and a 5-row preview. */
const express = require("express");
const multer = require("multer");
const { firstSheetRows } = require("../utils/safeSpreadsheet");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/* Required columns per import type: the same fields /api/upload skips a row without. */
const REQUIRED = { students: ["name", "admissionNo"], teachers: ["name", "staffId"], users: ["username"] };
const KEY = { students: "admissionNo", teachers: "staffId", users: "username" };
const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

function analyse(type, rows) {
  const required = REQUIRED[type], key = KEY[type];
  const seen = new Set(); const problems = []; let valid = 0, invalid = 0, duplicates = 0;
  rows.forEach((row, i) => {
    const line = i + 2; // header is row 1
    const missing = required.filter((c) => !text(row[c]));
    if (missing.length) { invalid++; if (problems.length < 10) problems.push({ row: line, reason: "missing " + missing.join(", ") }); return; }
    const k = text(row[key]).toLowerCase();
    if (seen.has(k)) { duplicates++; invalid++; if (problems.length < 10) problems.push({ row: line, reason: "duplicate " + key + " in file" }); return; }
    seen.add(k); valid++;
  });
  return { valid, invalid, duplicates, problems };
}

router.post("/", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ code: err.code || "UPLOAD_ERROR", message: err.code === "LIMIT_FILE_SIZE" ? "File too large (max 5 MB)" : "Upload failed" });
    const type = text(req.body && req.body.type);
    if (!REQUIRED[type]) return res.status(400).json({ code: "BAD_TYPE", message: "type must be one of: " + Object.keys(REQUIRED).join(", ") });
    if (!req.file) return res.status(400).json({ code: "NO_FILE", message: "No file uploaded. Use form-data key: file" });
    let rows;
    try { rows = firstSheetRows(req.file.buffer); }
    catch (e) { return res.status(e.status || 400).json({ code: e.code || "BAD_FILE", message: e.message }); }
    if (!rows.length) return res.status(400).json({ code: "EMPTY_FILE", message: "Empty file" });
    const result = analyse(type, rows);
    const cols = Object.keys(rows[0] || {});
    return res.json({ type, rows: rows.length, ...result, missingColumns: REQUIRED[type].filter((c) => !cols.includes(c)), preview: rows.slice(0, 5) });
  });
});

module.exports = router;
module.exports.analyse = analyse;
