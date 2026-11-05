/* L11.3: bounded spreadsheet parsing (xlsx has unfixed advisories). */
const { suite, test, assert } = require("./helpers/tinytest");
const XLSX = require("xlsx");
const { readWorkbookSafe, firstSheetRows, MAX_BYTES, MAX_ROWS } = require("../utils/safeSpreadsheet");
suite("safeSpreadsheet.test.js");

const xlsxBuf = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "S"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

test("a normal xlsx is read into row objects", () => {
  const rows = firstSheetRows(xlsxBuf([{ name: "A", admissionNo: "1" }, { name: "B", admissionNo: "2" }]));
  assert.strictEqual(rows.length, 2); assert.strictEqual(rows[1].admissionNo, "2");
});
test("csv text is accepted", () => {
  const rows = firstSheetRows(Buffer.from("name,admissionNo\nA,1\nB,2\n"));
  assert.strictEqual(rows.length, 2);
});
test("empty or non-buffer input is refused", () => {
  assert.strictEqual(code(() => readWorkbookSafe(Buffer.alloc(0))), "EMPTY_FILE");
  assert.strictEqual(code(() => readWorkbookSafe("text")), "EMPTY_FILE");
});
test("a file over the size cap is refused before parsing (413)", () => {
  const big = Buffer.alloc(MAX_BYTES + 1, 0x41);
  try { readWorkbookSafe(big); assert.fail("should throw"); } catch (e) { assert.strictEqual(e.code, "FILE_TOO_LARGE"); assert.strictEqual(e.status, 413); }
});
test("binary that is not zip/OLE/text is refused", () => {
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  assert.strictEqual(code(() => readWorkbookSafe(exe)), "BAD_FILE_TYPE");
});
test("more than MAX_ROWS rows is refused, not silently truncated", () => {
  const csv = "a\n" + Array.from({ length: MAX_ROWS + 5 }, (_, i) => i).join("\n");
  assert.strictEqual(code(() => firstSheetRows(Buffer.from(csv))), "TOO_MANY_ROWS");
});
test("a corrupt zip gives UNREADABLE_FILE, not a crash", () => {
  const bad = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
  const c = code(() => readWorkbookSafe(bad));
  assert.ok(c === "UNREADABLE_FILE" || c === "EMPTY_FILE", "got " + c);
});
test("formulas are not carried into the parsed workbook", () => {
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.aoa_to_sheet([["x"], [1]]); ws.A2 = { t: "n", v: 1, f: "1+1" };
  XLSX.utils.book_append_sheet(wb, ws, "S");
  const back = readWorkbookSafe(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  assert.strictEqual(back.Sheets[back.SheetNames[0]].A2.f, undefined);
});
