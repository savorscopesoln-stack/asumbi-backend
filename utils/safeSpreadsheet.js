/* L11.3: the only way uploaded spreadsheets are parsed. The `xlsx` package has
   known unfixed advisories, so we bound what it is given: size cap, magic-byte
   check (zip/OLE/CSV text only), row cap, first sheets only, no formulas/VBA/HTML. */
const XLSX = require("xlsx");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_SHEETS = 5;

function sniff(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return "zip"; // .xlsx
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "ole"; // .xls
  const head = buf.slice(0, 2048);
  if (head.length && !head.includes(0)) return "text"; // csv: no NUL bytes
  return null;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  e.status = code === "FILE_TOO_LARGE" ? 413 : 400;
  return e;
}

function readWorkbookSafe(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail("EMPTY_FILE", "Empty file");
  if (buffer.length > MAX_BYTES) throw fail("FILE_TOO_LARGE", "File too large (max 5 MB)");
  if (!sniff(buffer)) throw fail("BAD_FILE_TYPE", "Not a spreadsheet file");
  let wb;
  try {
    wb = XLSX.read(buffer, {
      type: "buffer", sheetRows: MAX_ROWS + 2, /* header + one row over the cap, so overflow is detected */ bookSheets: false, bookVBA: false,
      cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, sheets: 0,
    });
  } catch (_e) {
    throw fail("UNREADABLE_FILE", "Could not read the spreadsheet");
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) throw fail("EMPTY_FILE", "Empty file");
  if (wb.SheetNames.length > MAX_SHEETS) wb.SheetNames = wb.SheetNames.slice(0, MAX_SHEETS);
  return wb;
}

/* First sheet as row objects, never more than MAX_ROWS (error if exceeded). */
function firstSheetRows(buffer) {
  const wb = readWorkbookSafe(buffer);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  if (rows.length > MAX_ROWS) throw fail("TOO_MANY_ROWS", "Too many rows (max " + MAX_ROWS + ")");
  return rows;
}

module.exports = { readWorkbookSafe, firstSheetRows, MAX_BYTES, MAX_ROWS };
