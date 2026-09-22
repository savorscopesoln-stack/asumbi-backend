const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const PDFDocument = require("pdfkit");

/* =========================================================================
   REPORT EXPORT ENGINE (Phase 12-13 — §29, §31, §32, §33)

   This file turns the JSON any Phase 11 report handler already returns
   into a real .xlsx or .pdf file. It never recomputes a number: every
   exporter below is fed the exact same JSON the report's own GET
   endpoint returns (via runHandler — see mainExamReports.controller.js
   and mainExamExports.controller.js), so a downloaded file can never
   disagree with what the Reports tab shows on screen (§33, §51).

   Two format engines:
   - EXCEL: the `xlsx` package (already a project dependency) writes the
     workbook. Its community edition doesn't serialize frozen panes on
     write (verified against the installed 0.18.5 — parsing support
     exists, writing doesn't), so §31's "frozen header rows" requirement
     is added as a small post-processing step: unzip the generated
     .xlsx, patch each sheet's <sheetView> to include a frozen <pane>,
     rezip. This only touches the one <sheetView> tag XLSX.js always
     emits as self-closing — if that ever isn't found the sheet is left
     exactly as generated rather than risking a corrupt file.
   - PDF: `pdfkit` (already a project dependency) draws the institutional
     header (logo/name/address from the existing SchoolSettings table —
     §32) and a simple auto-paginating table with a repeated header row
     on every page and page numbers.
========================================================================= */

/* -------------------------------------------------------------------------
   INSTITUTION HEADER (§32 — "Institution Logo, Institution Name...")
   Reads the existing SchoolSettings table (ensureSchema.js) — no new
   settings storage. logoUrl is a served path like
   "/uploads/website/<file>" (see middleware/websitePhotoUpload.js); this
   resolves it to the actual file on disk so pdfkit can embed it.
------------------------------------------------------------------------- */
async function getInstitutionHeader(pool) {
  try {
    const result = await pool.request().query(`SELECT TOP 1 * FROM SchoolSettings WHERE id = 1`);
    const settings = result.recordset[0] || {};
    let logoDiskPath = null;
    if (settings.logoUrl) {
      const candidate = path.join(__dirname, "..", settings.logoUrl.replace(/^\/+/, ""));
      if (fs.existsSync(candidate)) logoDiskPath = candidate;
    }
    return {
      schoolName: settings.schoolName || "",
      address: settings.address || "",
      phone: settings.phone || "",
      email: settings.email || "",
      logoDiskPath,
    };
  } catch (err) {
    console.error("⚠️ Could not load institution header for report export:", err.message);
    return { schoolName: "", address: "", phone: "", email: "", logoDiskPath: null };
  }
}

/* =========================================================================
   EXCEL
========================================================================= */

/* Patches frozen header rows into an already-written .xlsx buffer.
   freezeMap: { sheetName: numberOfRowsToFreeze }. See file header comment
   for why this exists instead of a native write option. */
async function applyFrozenHeaders(buffer, freezeMap) {
  const entries = Object.entries(freezeMap).filter(([, n]) => n > 0);
  if (!entries.length) return buffer;

  const zip = await JSZip.loadAsync(buffer);
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const sheetEntries = [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)]
    .map((m) => ({ name: m[1], rId: m[2] }));
  const relEntries = [...relsXml.matchAll(/<Relationship[^>]*Id="(rId\d+)"[^>]*Target="([^"]*)"/g)]
    .map((m) => ({ rId: m[1], target: m[2] }));

  for (const [sheetName, ySplit] of entries) {
    const entry = sheetEntries.find((e) => e.name === sheetName);
    if (!entry) continue;
    const rel = relEntries.find((r) => r.rId === entry.rId);
    if (!rel) continue;
    const filePath = "xl/" + rel.target.replace(/^\/?/, "");
    const file = zip.file(filePath);
    if (!file) continue;
    const xml = await file.async("string");
    const topLeftCell = `A${ySplit + 1}`;
    const paneXml = `<pane ySplit="${ySplit}" topLeftCell="${topLeftCell}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${topLeftCell}" sqref="${topLeftCell}"/>`;
    const replaced = xml.replace(/<sheetView([^>]*?)\/>/, (_m, attrs) => `<sheetView${attrs}>${paneXml}</sheetView>`);
    if (replaced !== xml) zip.file(filePath, replaced);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/* One sheet's worth of a report. `columns`: [{ header, key, width, percent }].
   `title`/`subtitle` become the first rows above the header (matching
   §32's PDF header fields, kept consistent between the two formats).
   `totals`: optional object of {key: value} rendered as a bold final
   row — used for averages/pass-rate summaries (§31 "totals, percentages"). */
function addReportSheet(workbook, { name, title, subtitle, columns, rows, totals, note }) {
  const aoa = [];
  if (title) aoa.push([title]);
  if (subtitle) aoa.push([subtitle]);
  aoa.push([`Generated: ${new Date().toLocaleString()}`]);
  aoa.push([]);
  const headerRowIndex = aoa.length; // 0-based index of the column-header row
  aoa.push(columns.map((c) => c.header));
  if (note) {
    aoa.push([note]);
  } else if (!rows.length) {
    aoa.push(["No data available."]);
  } else {
    rows.forEach((row) => aoa.push(columns.map((c) => row[c.key] ?? null)));
    if (totals) aoa.push(columns.map((c) => (c.key in totals ? totals[c.key] : null)));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = columns.map((c) => ({ wch: c.width || 16 }));
  // Percentage columns get a real Excel number format (not just a "%"
  // string) so totals/sorting/filtering behave like actual percentages
  // (§31 "appropriate number formats"). Values are expected as plain
  // numbers (e.g. 68.4), stored as 68.4/100 with format "0.0%". Applied
  // to both the data rows and the totals row (if any) — a totals row
  // left unconverted would show "70.25" right below cells reading
  // "68.4%", which is worse than not formatting anything at all.
  const allDataRows = totals ? [...rows, totals] : rows;
  columns.forEach((c, colIdx) => {
    if (!c.percent) return;
    allDataRows.forEach((row, rowIdx) => {
      const excelRow = headerRowIndex + 1 + rowIdx; // +1 to skip the header row itself
      const cellRef = XLSX.utils.encode_cell({ r: excelRow, c: colIdx });
      const cell = ws[cellRef];
      if (cell && typeof cell.v === "number") {
        cell.v = cell.v / 100;
        cell.z = "0.0%";
      }
    });
  });

  // Basic autofilter on the header row, spanning the data (§31 "filters").
  if (rows.length) {
    const lastRow = headerRowIndex + rows.length + (totals ? 1 : 0);
    const lastCol = columns.length - 1;
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headerRowIndex, c: 0 }, e: { r: lastRow, c: lastCol } }) };
  }

  XLSX.utils.book_append_sheet(workbook, ws, name.slice(0, 31)); // Excel sheet-name limit
  return headerRowIndex + 1; // rows to freeze (everything through the header row)
}

/* Builds and returns the finished .xlsx Buffer for a multi-sheet report.
   `sheets`: array of addReportSheet's options objects. */
async function buildReportWorkbook(sheets) {
  const workbook = XLSX.utils.book_new();
  const freezeMap = {};
  sheets.forEach((sheet) => {
    freezeMap[sheet.name.slice(0, 31)] = addReportSheet(workbook, sheet);
  });
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return applyFrozenHeaders(buffer, freezeMap);
}

function sendExcelBuffer(res, buffer, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.send(buffer);
}

/* =========================================================================
   PDF
========================================================================= */

/* Draws the §32 institutional header block: logo, institution name,
   examination name, academic year, report title, generated date. */
function drawPdfHeader(doc, institution, { examinationName, academicYear, reportTitle, subtitle }) {
  const startX = doc.page.margins.left;
  let textX = startX;
  if (institution.logoDiskPath) {
    try {
      doc.image(institution.logoDiskPath, startX, doc.y, { width: 42, height: 42 });
      textX = startX + 52;
    } catch (err) {
      console.error("⚠️ Could not embed logo in PDF report:", err.message);
    }
  }
  const textWidth = doc.page.width - doc.page.margins.right - textX;
  const topY = doc.y;
  doc.fontSize(13).font("Helvetica-Bold").text(institution.schoolName || "Institution", textX, topY, { width: textWidth, align: "center" });
  if (institution.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#555").text(institution.address, { width: textWidth, align: "center" });
  }
  doc.fillColor("#000");
  doc.moveDown(0.4);
  doc.fontSize(11).font("Helvetica-Bold").text(examinationName || "", { align: "center" });
  if (academicYear) doc.fontSize(9).font("Helvetica").text(`Academic Year: ${academicYear}`, { align: "center" });
  doc.moveDown(0.6);
  doc.fontSize(12).font("Helvetica-Bold").text(reportTitle, { align: "center" });
  if (subtitle) doc.fontSize(9).font("Helvetica").text(subtitle, { align: "center" });
  doc.fontSize(8).font("Helvetica").fillColor("#777").text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(1);
  // A rule under the header keeps every report visually consistent and
  // clearly separates it from the table that follows.
  doc.moveTo(startX, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.8);
}

/* Simple auto-paginating table: repeats the header row on every new
   page, zebra-stripes data rows, and never lets a row's text overflow
   past its column (§32 "do not create unreadable giant tables").

   Column widths are measured from the actual content instead of split
   evenly, so a column like "Name" naturally ends up wider than a short
   one like "Position" — sized to whichever is longer, the header text
   or the widest value in that column, then every column is scaled by
   the same factor so the table still spans the full page edge-to-edge
   (shrinking proportionally if the content is wider than one page,
   growing proportionally to fill leftover space if it's narrower). */
function drawPdfTable(doc, { columns, rows }) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const rowHeight = 16;
  const CELL_PADDING = 8;   // ~3px each side plus a little breathing room
  const MIN_COL_WIDTH = 34; // never let a column collapse to unreadable

  doc.fontSize(7.5);
  const natural = columns.map((c) => {
    doc.font("Helvetica-Bold");
    let max = doc.widthOfString(String(c.header ?? ""));
    doc.font("Helvetica");
    rows.forEach((row) => {
      const val = row[c.key];
      const text = val == null || val === "" ? "-" : String(val);
      const w = doc.widthOfString(text);
      if (w > max) max = w;
    });
    return Math.max(MIN_COL_WIDTH, max + CELL_PADDING);
  });
  const naturalTotal = natural.reduce((s, w) => s + w, 0);
  const scale = naturalTotal > 0 ? usableWidth / naturalTotal : 1;
  const colWidths = natural.map((w) => w * scale);

  let y = doc.y;

  const drawHeaderRow = () => {
    doc.rect(pageLeft, y, usableWidth, rowHeight).fill("#2c3e50");
    doc.fillColor("#fff").fontSize(7.5).font("Helvetica-Bold");
    let x = pageLeft;
    columns.forEach((c, i) => {
      doc.text(c.header, x + 3, y + 4, { width: colWidths[i] - 6, align: c.align || "left" });
      x += colWidths[i];
    });
    doc.fillColor("#000").font("Helvetica");
    y += rowHeight;
  };

  drawHeaderRow();

  if (!rows.length) {
    doc.fontSize(9).fillColor("#777").text("No data available.", pageLeft, y + 6);
    doc.fillColor("#000");
    doc.y = y + rowHeight + 10;
    return;
  }

  rows.forEach((row, idx) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(pageLeft, y, usableWidth, rowHeight).fill("#f4f6f7");
      doc.fillColor("#000");
    }
    doc.fontSize(7.5).font("Helvetica");
    let x = pageLeft;
    columns.forEach((c, i) => {
      const val = row[c.key];
      doc.text(val == null || val === "" ? "-" : String(val), x + 3, y + 4, { width: colWidths[i] - 6, align: c.align || "left" });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  doc.y = y + 10;
}

/* Adds "Page X of N" to the bottom of every page. Call once, right
   before ending the document. */
function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor("#888").text(
      `Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom + 6,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center" }
    );
  }
  doc.fillColor("#000");
}


/* ── Official-style examination timetable (matches the on-screen
   Timetable tab): # | Day / Date (merged down the day) | Time | S/N |
   Subject | Duration | Venue, with green "Break" rows derived from the
   gap between one session's end and the next one's start that day.
   `days` is [{ key: "2026-09-21", dayName, dateLabel, rows: [
     { type: "exam", time, sn, subject, duration, venue } |
     { type: "break", time, duration } ] }]. Built by SHAPES.timetable
   in mainExamExports.controller.js. Long days split across pages with
   the day cell repeated on the continuation. ── */
function drawTimetablePdf(doc, { days }) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fixed = { num: 26, day: 100, time: 112, sn: 30, dur: 86, venue: 84 };
  const subjW = usable - (fixed.num + fixed.day + fixed.time + fixed.sn + fixed.dur + fixed.venue);
  const X = {};
  let cx = left;
  [["num", fixed.num], ["day", fixed.day], ["time", fixed.time], ["sn", fixed.sn], ["subject", subjW], ["dur", fixed.dur], ["venue", fixed.venue]]
    .forEach(([k, w]) => { X[k] = { x: cx, w }; cx += w; });

  const PAD = 4;
  const LINE = "#7B8494";
  const GREEN = "#C6E0B4";
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 20;
  let y = doc.y;

  const cell = (k, top, h, text, opts = {}) => {
    const { x, w } = X[k];
    if (opts.fill) doc.rect(x, top, w, h).fill(opts.fill);
    doc.lineWidth(0.5).strokeColor(LINE).rect(x, top, w, h).stroke();
    if (text != null && text !== "") {
      doc.fillColor("#000").font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size || 8)
        .text(String(text), x + PAD, top + PAD, { width: w - PAD * 2, align: opts.align || "left" });
    }
  };

  const header = () => {
    const h = 18;
    doc.rect(left, y, usable, h).fill("#2c3e50");
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(7.5);
    [["num", "#", "center"], ["day", "DAY / DATE"], ["time", "TIME"], ["sn", "S/N", "center"], ["subject", "SUBJECT"], ["dur", "DURATION"], ["venue", "VENUE"]]
      .forEach(([k, label, align]) => doc.text(label, X[k].x + PAD, y + 5, { width: X[k].w - PAD * 2, align: align || "left" }));
    doc.fillColor("#000");
    y += h;
  };

  const rowHeight = (r) => {
    if (r.type === "break") return 18;
    doc.font("Helvetica-Bold").fontSize(8);
    const hs = doc.heightOfString(String(r.subject || ""), { width: subjW - PAD * 2 });
    doc.font("Helvetica");
    const hd = doc.heightOfString(String(r.duration || ""), { width: fixed.dur - PAD * 2 });
    const hv = doc.heightOfString(String(r.venue || "-"), { width: fixed.venue - PAD * 2 });
    return Math.max(18, Math.max(hs, hd, hv) + PAD * 2);
  };

  if (!days.length) {
    doc.fontSize(9).fillColor("#777").text("No subjects scheduled yet.", left, y + 6);
    doc.fillColor("#000");
    return;
  }

  header();

  days.forEach((day, dayIdx) => {
    let segment = [];
    let segTop = y;

    const flushSegment = () => {
      if (!segment.length) return;
      const total = segment.reduce((sum, r) => sum + r.h, 0);
      // merged # and Day/Date cells spanning the whole segment
      cell("num", segTop, total, `${dayIdx + 1}.`, { bold: true, align: "center" });
      const { x, w } = X.day;
      doc.lineWidth(0.5).strokeColor(LINE).rect(x, segTop, w, total).stroke();
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(8)
        .text(String(day.dayName || "").toUpperCase(), x + PAD, segTop + PAD, { width: w - PAD * 2 });
      doc.text(day.dateLabel, x + PAD, doc.y + 4, { width: w - PAD * 2 });
      segment = [];
    };

    day.rows.forEach((r) => {
      const h = rowHeight(r);
      if (y + h > bottomLimit()) {
        flushSegment();
        doc.addPage();
        y = doc.page.margins.top;
        header();
        segTop = y;
      }
      if (r.type === "break") {
        cell("time", y, h, r.time, { bold: true, fill: GREEN });
        cell("sn", y, h, "", { fill: GREEN });
        cell("subject", y, h, "Break", { bold: true, fill: GREEN });
        cell("dur", y, h, r.duration, { bold: true, fill: GREEN });
        cell("venue", y, h, "", { fill: GREEN });
      } else {
        cell("time", y, h, r.time);
        cell("sn", y, h, `${r.sn}.`, { align: "center" });
        cell("subject", y, h, r.subject, { bold: true });
        cell("dur", y, h, r.duration);
        cell("venue", y, h, r.venue || "-");
      }
      segment.push({ h });
      y += h;
    });
    flushSegment();
  });

  doc.y = y + 10;
}

/* Builds a full PDF report: header + one or more tables (with an
   optional section heading between them, for reports like the Summary
   that combine a few small tables — §30.1's "candidate statistics /
   overall performance / grade distribution / subject summary" in one
   document). Returns a Buffer. `landscape` defaults true since most of
   these are wide result tables (§32). */
function buildReportPdf({ institution, examinationName, academicYear, reportTitle, subtitle, sections, landscape = true }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ layout: landscape ? "landscape" : "portrait", margin: 36, size: "A4", bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawPdfHeader(doc, institution, { examinationName, academicYear, reportTitle, subtitle });

    sections.forEach((section, idx) => {
      if (idx > 0) doc.moveDown(0.8);
      if (section.heading) {
        doc.fontSize(10).font("Helvetica-Bold").text(section.heading);
        doc.moveDown(0.3);
      }
      if (section.text) {
        doc.fontSize(9).font("Helvetica").text(section.text);
        doc.moveDown(0.3);
      }
      if (section.timetable) {
        drawTimetablePdf(doc, section.timetable);
      } else if (section.columns) {
        drawPdfTable(doc, { columns: section.columns, rows: section.rows || [] });
      }
    });

    addPageNumbers(doc);
    doc.end();
  });
}

function sendPdfBuffer(res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.send(buffer);
}

module.exports = {
  getInstitutionHeader,
  buildReportWorkbook,
  sendExcelBuffer,
  buildReportPdf,
  sendPdfBuffer,
};
