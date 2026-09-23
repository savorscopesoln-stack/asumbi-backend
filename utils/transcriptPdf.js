const PDFDocument = require("pdfkit");
const { resolveReportTheme } = require("./reportThemes");

/* =========================================================================
   TRANSCRIPT PDF BUILDER

   Builds one printable document covering every student passed in —
   each student starts on a fresh page (or spans more than one, if
   they've sat enough exams), so a class transcript run can be printed
   and handed out sheet by sheet. Reuses the same institution header
   (logo/name/address) and school-chosen report theme colors every
   other PDF export in the app uses (utils/reportExport.js /
   utils/reportThemes.js) — a transcript is visually one more member
   of that same family of documents, not a one-off layout.

   `students` shape (built by transcript.controller.js):
   [{
     student: { id, name, admissionNo, studentClass },
     exams: [{ examName, academic_year, term, subjects: [{ subjectName, percentage, grade }], average, overallResult }],
     cumulativeAverage, cumulativeResult,
   }]
========================================================================= */

const PAGE_MARGIN = 40;
const ROW_H = 16;

function drawInstitutionHeader(doc, institution, { title, subtitle }, theme) {
  const startX = doc.page.margins.left;
  let textX = startX;
  if (institution.logoDiskPath) {
    try {
      doc.image(institution.logoDiskPath, startX, doc.y, { width: 42, height: 42 });
      textX = startX + 52;
    } catch (err) {
      console.error("⚠️ Could not embed logo in transcript PDF:", err.message);
    }
  }
  const textWidth = doc.page.width - doc.page.margins.right - textX;
  const topY = doc.y;
  doc.fontSize(13).font("Helvetica-Bold").fillColor("#000")
    .text(institution.schoolName || "Institution", textX, topY, { width: textWidth, align: "center" });
  if (institution.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#555").text(institution.address, { width: textWidth, align: "center" });
  }
  doc.fillColor("#000");
  doc.moveDown(0.4);
  doc.fontSize(11).font("Helvetica-Bold").text("STUDENT ACADEMIC TRANSCRIPT", { align: "center" });
  doc.fontSize(9).font("Helvetica-Bold").fillColor(theme.primary).text(title, { align: "center" });
  if (subtitle) doc.fontSize(8).font("Helvetica").fillColor("#555").text(subtitle, { align: "center" });
  doc.fillColor("#000");
  doc.moveDown(0.6);
  doc.moveTo(startX, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(theme.rule).stroke();
  doc.moveDown(0.6);
}

function drawStudentInfo(doc, student) {
  const startX = doc.page.margins.left;
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 3;
  const y = doc.y;
  const field = (label, value, i) => {
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#777").text(label.toUpperCase(), startX + i * colWidth, y);
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(value ?? "—", startX + i * colWidth, y + 11);
  };
  field("Student Name", student.name, 0);
  field("Admission No.", student.admissionNo, 1);
  field("Class", student.studentClass, 2);
  doc.y = y + 32;
  doc.moveDown(0.4);
}

/* One exam's subject table: Subject | Score | Grade, plus an average
   row. Kept intentionally simple/portrait (unlike the wide landscape
   admin report tables) since a transcript is a narrow, read-top-to-
   bottom document, closer in spirit to the report card than to a
   Nominal Roll. */
function drawExamTable(doc, exam, theme) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const subjectW = usableWidth * 0.6;
  const scoreW = usableWidth * 0.2;
  const gradeW = usableWidth - subjectW - scoreW;

  // Section heading for this exam — start a fresh page if it (plus at
  // least a header row and one data row) can't fit above the bottom
  // margin, so an exam's heading is never left orphaned at a page's
  // very bottom with its table starting on the next page.
  const neededForHeading = 20 + ROW_H * 2;
  if (doc.y + neededForHeading > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const examLabel = [exam.examName, exam.term, exam.academic_year].filter(Boolean).join(" — ");
  doc.fontSize(9.5).font("Helvetica-Bold").fillColor(theme.primary).text(examLabel);
  doc.fillColor("#000");
  doc.moveDown(0.2);

  let y = doc.y;
  const drawHeaderRow = () => {
    doc.rect(pageLeft, y, usableWidth, ROW_H).fill(theme.primary);
    doc.fillColor(theme.onPrimary).fontSize(8).font("Helvetica-Bold");
    doc.text("SUBJECT", pageLeft + 4, y + 4, { width: subjectW - 8, lineBreak: false });
    doc.text("SCORE (%)", pageLeft + subjectW + 4, y + 4, { width: scoreW - 8, align: "center", lineBreak: false });
    doc.text("GRADE", pageLeft + subjectW + scoreW + 4, y + 4, { width: gradeW - 8, align: "center", lineBreak: false });
    doc.fillColor("#000").font("Helvetica");
    y += ROW_H;
  };
  drawHeaderRow();

  exam.subjects.forEach((s, idx) => {
    if (y + ROW_H > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(pageLeft, y, usableWidth, ROW_H).fill(theme.zebra);
      doc.fillColor("#000");
    }
    doc.fontSize(8).font("Helvetica");
    doc.text(s.subjectName || "-", pageLeft + 4, y + 4, { width: subjectW - 8, lineBreak: false, ellipsis: true });
    doc.text(s.percentage != null ? `${s.percentage}%` : "—", pageLeft + subjectW + 4, y + 4, { width: scoreW - 8, align: "center", lineBreak: false });
    doc.text(s.grade || "—", pageLeft + subjectW + scoreW + 4, y + 4, { width: gradeW - 8, align: "center", lineBreak: false });
    y += ROW_H;
  });

  // Exam average row — visually distinct (theme-filled) so it reads as
  // a total, the same convention the report card's AVERAGE row uses.
  if (y + ROW_H > doc.page.height - doc.page.margins.bottom - 20) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(pageLeft, y, usableWidth, ROW_H).fill(theme.primary);
  doc.fillColor(theme.onPrimary).fontSize(8).font("Helvetica-Bold");
  doc.text("EXAM AVERAGE", pageLeft + 4, y + 4, { width: subjectW - 8 });
  doc.text(exam.average != null ? `${exam.average}%` : "—", pageLeft + subjectW + 4, y + 4, { width: scoreW - 8, align: "center" });
  doc.text(exam.overallResult || "—", pageLeft + subjectW + scoreW + 4, y + 4, { width: gradeW - 8, align: "center" });
  doc.fillColor("#000").font("Helvetica");
  y += ROW_H;

  doc.y = y + 12;
}

function drawCumulativeSummary(doc, page, theme) {
  if (page.exams.length < 2) return; // only meaningful across more than one exam
  const pageLeft = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();

  doc.moveDown(0.2);
  doc.rect(pageLeft, doc.y, usableWidth, 26).fill(theme.zebra);
  doc.fillColor(theme.primary).fontSize(9).font("Helvetica-Bold")
    .text(
      `Cumulative Average across ${page.exams.length} exams: ${page.cumulativeAverage != null ? `${page.cumulativeAverage}%` : "—"}  (${page.cumulativeResult || "—"})`,
      pageLeft + 8, doc.y + 8
    );
  doc.fillColor("#000");
  doc.y += 26;
}

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

/* Returns a Buffer. `students` is the per-student array shaped by
   transcript.controller.js; `title`/`subtitle` describe the exam
   scope and class/audience scope for the header on every page. */
function buildTranscriptPdf({ institution, title, subtitle, students }) {
  const theme = resolveReportTheme(institution?.reportTheme);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ layout: "portrait", margin: PAGE_MARGIN, size: "A4", bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    students.forEach((page, idx) => {
      if (idx > 0) doc.addPage();
      drawInstitutionHeader(doc, institution, { title, subtitle }, theme);
      drawStudentInfo(doc, page.student);
      page.exams.forEach((exam) => drawExamTable(doc, exam, theme));
      drawCumulativeSummary(doc, page, theme);
      doc.fontSize(7).fillColor("#999").text(`Generated: ${new Date().toLocaleString()}`, { align: "right" });
      doc.fillColor("#000");
    });

    addPageNumbers(doc);
    doc.end();
  });
}

module.exports = { buildTranscriptPdf };
