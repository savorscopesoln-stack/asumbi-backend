/* =========================================================================
   LMS CSV READER (L3.6)  small RFC-4180 reader for admin imports (outcomes now; question bank later).
   Quotes, escaped quotes, CRLF/LF/CR, "," or ";" delimiter (decided from the header line), UTF-8 BOM, bounded size and rows.
   Headers are matched case-insensitively with everything except letters/digits ignored ("Parent Code" = parentCode).
   Never throws; returns { ok:false, code?, errors } or { ok:true, headers, rows:[{ line, cells:{header:value} }] }.
   (utils/lmsEnrolment.js has its own admission-number reader; merging the two is parked in the backlog.)
========================================================================= */
const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function readCsv(text, { maxBytes = 256 * 1024, maxRows = 300, required = [], known = [] } = {}) {
  if (typeof text !== "string") return { ok: false, errors: ["csv must be text."] };
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, code: "CSV_TOO_LARGE", errors: [`The CSV is larger than ${Math.round(maxBytes / 1024)} KB. Split it into smaller files.`] };
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r\n|\n|\r/, 1)[0] || "";
  const delim = firstLine.includes(",") || !firstLine.includes(";") ? "," : ";";
  const rows = []; let row = [], cell = "", q = false, lineNo = 1, rowLine = 1;
  const endRow = () => { row.push(cell); cell = ""; rows.push({ line: rowLine, cells: row }); row = []; rowLine = lineNo + 1; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else { if (ch === "\n") lineNo++; cell += ch; } continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\r" || ch === "\n") { if (ch === "\r" && src[i + 1] === "\n") i++; endRow(); lineNo++; rowLine = lineNo; }
    else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  const head = rows.shift();
  if (!head) return { ok: false, errors: ["The CSV is empty."] };
  const headers = head.cells.map(norm);
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length) return { ok: false, code: "CSV_NO_HEADER", errors: [`The first row must be a header with these columns: ${required.join(", ")}.`] };
  if (known.length) { const bad = head.cells.filter((c, i) => headers[i] && !known.includes(headers[i])); if (bad.length) return { ok: false, code: "CSV_UNKNOWN_COLUMN", errors: [`Unknown column "${String(bad[0]).slice(0, 40)}". Allowed: ${known.join(", ")}.`] }; }
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) return { ok: false, code: "CSV_DUPLICATE_COLUMN", errors: ["Each column may appear once."] };
  const data = rows.filter((r) => r.cells.some((c) => String(c).trim() !== ""));
  if (data.length > maxRows) return { ok: false, code: "CSV_TOO_MANY_ROWS", errors: [`At most ${maxRows} rows per file (found ${data.length}). Split the file.`] };
  if (!data.length) return { ok: false, errors: ["The CSV has a header but no rows."] };
  return { ok: true, headers, rows: data.map((r) => ({ line: r.line, cells: Object.fromEntries(headers.map((h, i) => [h, r.cells[i] === undefined ? "" : String(r.cells[i])]).filter(([h]) => h)) })) };
}

module.exports = { readCsv, norm };
