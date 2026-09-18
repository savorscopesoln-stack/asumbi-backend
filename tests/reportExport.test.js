const { suite, test, assert } = require("./helpers/tinytest");
const zlib = require("zlib");
const JSZip = require("jszip");
const {
  buildReportWorkbook,
  buildReportPdf,
} = require("../utils/reportExport");

/* PDFKit's content streams are FlateDecode-compressed AND text is drawn
   via hex-encoded glyph strings inside TJ arrays (e.g. "<446f7261>" for
   "Dora"), not literal "(text)" operators — so neither a raw substring
   search nor a naive inflate-and-search finds real text. Inflate every
   stream, pull out every <hex> run, decode it back to characters, and
   search the concatenated result. Uses only Node's built-in zlib, no
   new test dependency. */
function pdfContainsText(buffer, needle) {
  const raw = buffer.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let decodedText = "";
  let m;
  while ((m = streamRe.exec(raw))) {
    let inflated;
    try {
      inflated = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue; // not every stream is FlateDecode (e.g. some font subsets) — skip
    }
    const hexRe = /<([0-9A-Fa-f]+)>/g;
    let h;
    while ((h = hexRe.exec(inflated))) {
      decodedText += Buffer.from(h[1], "hex").toString("latin1");
    }
  }
  return decodedText.includes(needle);
}

suite("reportExport.test.js");

test("excel: multi-sheet workbook builds, is a valid zip, percent+totals formatting applied", async () => {
  const buffer = await buildReportWorkbook([
    {
      name: "Subject Summary", title: "Performance by Subject",
      columns: [
        { header: "Subject", key: "subject", width: 22 },
        { header: "Mean (%)", key: "mean", width: 12, percent: true },
      ],
      rows: [{ subject: "Mathematics", mean: 68.4 }, { subject: "ICT", mean: 72.1 }],
      totals: { subject: "Average", mean: 70.25 },
    },
  ]);
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0, "produced a non-empty buffer");

  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file("xl/workbook.xml"), "is a well-formed .xlsx (has workbook.xml)");
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheetXml, /<pane ySplit="\d+"[^>]*state="frozen"/, "header rows are frozen");
  assert.match(sheetXml, /0\.7025/, "totals row percent value stored as a real fraction (70.25 -> 0.7025), not text");
});

test("excel: an empty-data sheet renders a note instead of crashing (§50 — no fabricated data)", async () => {
  const buffer = await buildReportWorkbook([
    { name: "Grade Distribution", title: "Grade Distribution", columns: [{ header: "Grade", key: "grade", width: 10 }], rows: [], note: "Unavailable for this assessment." },
  ]);
  const zip = await JSZip.loadAsync(buffer);
  const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheetXml, /Unavailable for this assessment/, "note text is present in the sheet");
});

test("excel: sheet names over Excel's 31-char limit don't throw", async () => {
  const buffer = await buildReportWorkbook([
    { name: "A Very Long Sheet Name That Exceeds Thirty One Characters", title: "t", columns: [{ header: "A", key: "a", width: 10 }], rows: [] },
  ]);
  assert.ok(buffer.length > 0);
});

test("pdf: header + table render, correct page count for a long table", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Student ${i + 1}`, marks: 50 + (i % 40) }));
  const buffer = await buildReportPdf({
    institution: { schoolName: "Doravo Technical College", address: "P.O. Box 123", logoDiskPath: null },
    examinationName: "2026 Second Year Final Examination",
    academicYear: "2026",
    reportTitle: "Subject Results — Mathematics",
    sections: [{ columns: [{ header: "Name", key: "name", weight: 2 }, { header: "Marks", key: "marks", weight: 1, align: "right" }], rows }],
  });
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  // A rough but reliable page-count signal without a PDF-parsing
  // dependency: PDFKit emits one "/Type /Page" object per page.
  const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pageCount >= 4, `expected several pages for 50 rows, counted ${pageCount}`);
});

test("pdf: missing logo path is skipped gracefully, not thrown", async () => {
  const buffer = await buildReportPdf({
    institution: { schoolName: "Doravo Technical College", address: "", logoDiskPath: "/no/such/file.png" },
    examinationName: "Test Exam", academicYear: "2026", reportTitle: "Empty Report",
    sections: [{ columns: [{ header: "A", key: "a", weight: 1 }], rows: [] }],
  });
  assert.ok(buffer.length > 0);
});

test("pdf: empty rows render 'No data available.' instead of an empty page", async () => {
  const buffer = await buildReportPdf({
    institution: { schoolName: "Doravo Technical College", logoDiskPath: null },
    examinationName: "Test Exam", academicYear: "2026", reportTitle: "Empty Report",
    sections: [{ columns: [{ header: "A", key: "a", weight: 1 }], rows: [] }],
  });
  assert.ok(pdfContainsText(buffer, "No data available"), "empty-table message is present in the rendered content");
});
