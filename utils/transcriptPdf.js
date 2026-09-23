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

   Laid out to read as one signed, self-contained record per student
   (course-style intro paragraph, student particulars, a per-exam
   results table, and a signature/stamp block) rather than a bare
   list of numbers — the shape a physical academic transcript takes.

   `students` shape (built by transcript.controller.js):
   [{
     student: { id, name, admissionNo, studentClass, gender, assessmentNumber, yearOfStudy },
     exams: [{
       examName, academic_year, term,
       subjects: [{ subjectCode, subjectName, percentage, grade, points, result }],
       average, overallResult, aggregatePoints,
     }],
     cumulativeAverage, cumulativeResult,
   }]

   `officials` (from utils/reportExport.js's getSigningOfficials):
   [{ title, name }] — only the SchoolOfficials rows flagged isSignatory.
========================================================================= */

const PAGE_MARGIN = 40;
const ROW_H = 16;

function drawInstitutionHeader(doc, institution, { title, subtitle }, theme) {
  const startX = doc.page.margins.left;
  const LOGO_SIZE = 42;
  let textX = startX;
  let logoDrawn = false;
  if (institution.logoDiskPath) {
    try {
      doc.image(institution.logoDiskPath, startX, doc.y, { width: LOGO_SIZE, height: LOGO_SIZE });
      textX = startX + 52;
      logoDrawn = true;
    } catch (err) {
      console.error("⚠️ Could not embed logo in transcript PDF:", err.message);
    }
  }
  const textWidth = doc.page.width - doc.page.margins.right - textX;
  const topY = doc.y;
  doc.fontSize(13).font("Helvetica-Bold").fillColor("#000")
    .text(institution.schoolName || "Institution", textX, topY, { width: textWidth, align: "center" });
  if (institution.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#555").text(institution.address, textX, doc.y, { width: textWidth, align: "center" });
  }
  // Telephone / Email / Website contact line — same three facts the
  // sample college transcript prints under its address, pulled from
  // the same SchoolSettings row the address itself comes from.
  const contactParts = [
    institution.phone ? `Tel: ${institution.phone}` : null,
    institution.email ? `Email: ${institution.email}` : null,
    institution.website ? institution.website : null,
  ].filter(Boolean);
  if (contactParts.length) {
    doc.fontSize(8).font("Helvetica").fillColor("#555")
      .text(contactParts.join("   |   "), textX, doc.y, { width: textWidth, align: "center" });
  }
  doc.fillColor("#000");
  // The name/address/contact block can be shorter than the logo (e.g.
  // when address/contact details are missing), which previously let
  // doc.y creep back up above the logo's bottom edge — the next
  // (full-width, centered) title lines would then render on top of
  // the logo image instead of below it. Clamp the cursor to clear the
  // logo's bottom edge before anything else is drawn.
  if (logoDrawn) doc.y = Math.max(doc.y, topY + LOGO_SIZE);
  doc.x = startX;
  doc.moveDown(0.4);
  doc.fontSize(11).font("Helvetica-Bold").text("STUDENT ACADEMIC TRANSCRIPT", startX, doc.y, { width: doc.page.width - startX - doc.page.margins.right, align: "center" });
  doc.fontSize(9).font("Helvetica-Bold").fillColor(theme.primary).text(title, startX, doc.y, { width: doc.page.width - startX - doc.page.margins.right, align: "center" });
  if (subtitle) doc.fontSize(8).font("Helvetica").fillColor("#555").text(subtitle, startX, doc.y, { width: doc.page.width - startX - doc.page.margins.right, align: "center" });
  doc.fillColor("#000");
  doc.moveDown(0.6);
  doc.moveTo(startX, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(theme.rule).stroke();
  doc.moveDown(0.6);
}

/* Short confirming sentence, the same role the sample transcript's
   "This is to confirm that ... sat for the ... examination and
   qualified for the award of ..." paragraph plays — names the
   student and the exam scope in one line before the particulars
   and table below. */
function drawIntroParagraph(doc, student, title) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(8.5).font("Helvetica").fillColor("#333").text(
    `This is to confirm that the student named below sat for ${title} and attained the results shown below.`,
    { width, align: "left" }
  );
  doc.fillColor("#000");
  doc.moveDown(0.5);
}

function drawStudentInfo(doc, student) {
  const startX = doc.page.margins.left;
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 3;
  const rowH = 30;
  // Row/col positions are anchored to `startY`, captured once below —
  // NOT to doc.y at call time. PDFKit still advances doc.y after every
  // .text() call even when it's given an explicit x/y, so if each
  // field read the *current* doc.y it would drift a little further
  // down with every single field drawn (label, then value, then the
  // next field...). By the time the second row's fields were placed,
  // that compounding drift pushed them well past their intended slot
  // and into whatever was drawn next (the exam table header row) —
  // exactly the overlapping text this fixes.
  const startY = doc.y;
  const field = (label, value, col, row) => {
    const x = startX + col * colWidth;
    const y = startY + row * rowH;
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#777").text(label.toUpperCase(), x, y);
    // `height` must be paired with `ellipsis` — pdfkit only truncates
    // with "…" when it knows the box is bounded to one line; without
    // it, a long value (e.g. a long student name) silently wraps onto
    // a second line instead of truncating, and that second line then
    // overlaps the next row of fields below it.
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#000").text(value ?? "—", x, y + 11, { width: colWidth - 6, height: 13, ellipsis: true });
  };
  field("Student Name", student.name, 0, 0);
  field("Gender", student.gender, 1, 0);
  field("Index No.", student.assessmentNumber, 2, 0);
  field("Admission No.", student.admissionNo, 0, 1);
  field("Class", student.studentClass, 1, 1);
  field("Year of Study", student.yearOfStudy, 2, 1);
  doc.y = startY + rowH * 2;
  // Every field above is drawn at an explicit x (one of the three
  // columns), which leaves doc.x parked wherever the last field
  // happened to be (the third/rightmost column) once the loop ends.
  // Anything drawn next without its own explicit x — like the exam
  // heading in drawExamTable — would otherwise inherit that stray x
  // and render on top of this block's last column instead of at the
  // page's left margin.
  doc.x = startX;
  doc.moveDown(0.3);
}

/* One exam's subject table: Code | Subject | Score | Grade | Points |
   Result, plus an average row. `Grade` and `Points` intentionally show
   the same value — the app has one grading scale, not two separate
   letter/points scales — kept as two columns purely to match the
   two-grading-column shape of a college transcript. Kept
   intentionally simple/portrait (unlike the wide landscape admin
   report tables) since a transcript is a narrow, read-top-to-bottom
   document, closer in spirit to the report card than to a Nominal
   Roll. */
function drawExamTable(doc, exam, theme) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const codeW = usableWidth * 0.12;
  const subjectW = usableWidth * 0.34;
  const scoreW = usableWidth * 0.14;
  const gradeW = usableWidth * 0.14;
  const pointsW = usableWidth * 0.13;
  const resultW = usableWidth - codeW - subjectW - scoreW - gradeW - pointsW;
  const colX = [pageLeft, pageLeft + codeW, pageLeft + codeW + subjectW,
    pageLeft + codeW + subjectW + scoreW, pageLeft + codeW + subjectW + scoreW + gradeW,
    pageLeft + codeW + subjectW + scoreW + gradeW + pointsW];
  const colW = [codeW, subjectW, scoreW, gradeW, pointsW, resultW];

  // Section heading for this exam — start a fresh page if it (plus at
  // least a header row and one data row) can't fit above the bottom
  // margin, so an exam's heading is never left orphaned at a page's
  // very bottom with its table starting on the next page.
  const neededForHeading = 20 + ROW_H * 2;
  if (doc.y + neededForHeading > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const examLabel = [exam.examName, exam.term, exam.academic_year].filter(Boolean).join(" — ");
  doc.fontSize(9.5).font("Helvetica-Bold").fillColor(theme.primary)
    .text(examLabel, pageLeft, doc.y, { width: usableWidth });
  doc.fillColor("#000");
  doc.x = pageLeft;
  doc.moveDown(0.2);

  let y = doc.y;
  const headers = ["CODE", "SUBJECT", "MARKS %", "GRADE", "POINTS", "RESULT"];
  const aligns = ["center", "left", "center", "center", "center", "center"];
  const drawHeaderRow = () => {
    doc.rect(pageLeft, y, usableWidth, ROW_H).fill(theme.primary);
    doc.fillColor(theme.onPrimary).fontSize(7.5).font("Helvetica-Bold");
    headers.forEach((h, i) => {
      doc.text(h, colX[i] + 4, y + 4.5, { width: colW[i] - 8, align: aligns[i], lineBreak: false });
    });
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
    const cells = [
      s.subjectCode || "—",
      s.subjectName || "-",
      s.percentage != null ? `${s.percentage}%` : "—",
      s.grade || "—",
      s.points || "—",
      s.result || "—",
    ];
    cells.forEach((val, i) => {
      doc.text(val, colX[i] + 4, y + 4, { width: colW[i] - 8, align: aligns[i], lineBreak: false, ellipsis: true });
    });
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
  doc.text("EXAM AVERAGE", pageLeft + 4, y + 4, { width: codeW + subjectW - 8 });
  doc.text(exam.average != null ? `${exam.average}%` : "—", colX[2] + 4, y + 4, { width: scoreW - 8, align: "center" });
  doc.text(exam.overallResult || "—", colX[3], y + 4, { width: gradeW + pointsW + resultW - 4, align: "center" });
  doc.fillColor("#000").font("Helvetica");
  y += ROW_H;

  doc.y = y + 6;

  // Aggregate points line — the exam's subject grade-band codes summed
  // (see transcript.controller.js), the same "total points" figure a
  // college transcript's aggregate box shows alongside the average.
  if (exam.aggregatePoints != null) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#555")
      .text(`Aggregate Points: ${exam.aggregatePoints}`, pageLeft, doc.y, { width: usableWidth, align: "right" });
    doc.fillColor("#000");
  }

  doc.y += 10;
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

/* Signature / official-stamp block, the same "Signed / Dean of
   Curriculum / For: Chief Principal" + stamp shape the sample
   transcript closes with, drawn once per student record (not per
   exam) since the whole page is that student's one signed document.
   Officials come from SchoolOfficials (isSignatory rows only, in
   sortOrder) so this never hand-codes a name/title. */
function drawSignatureBlock(doc, officials, institution, theme) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const blockH = 90;
  if (doc.y + blockH > doc.page.height - doc.page.margins.bottom) doc.addPage();

  doc.moveDown(0.4);
  doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor(theme.rule).stroke();
  doc.moveDown(0.6);

  const sigX = pageLeft;
  const sigWidth = usableWidth * 0.62;
  const stampX = pageLeft + sigWidth + 20;
  const stampSize = 70;
  const topY = doc.y;

  // Signing officials — first is the primary signature line, any
  // further ones ("For: <title>") listed underneath, matching the
  // sample's "SIGNED: ... / Kaunda, K.M / Dean of Curriculum / For:
  // Chief Principal" stack.
  doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#777").text("SIGNED", sigX, topY);
  let sy = topY + 12;
  doc.moveTo(sigX, sy + 14).lineTo(sigX + sigWidth * 0.5, sy + 14).strokeColor("#999").stroke();
  sy += 22;

  if (officials.length) {
    officials.forEach((o, i) => {
      doc.fontSize(9.5).font("Helvetica-Bold").fillColor("#000")
        .text(i === 0 ? (o.name || "—") : `For: ${o.title || "—"}`, sigX, sy, { width: sigWidth });
      if (i === 0 && o.title) {
        sy += 12;
        doc.fontSize(8).font("Helvetica").fillColor("#555").text(o.title, sigX, sy, { width: sigWidth });
      }
      sy += 13;
    });
  } else {
    doc.fontSize(8).font("Helvetica").fillColor("#777").text("—", sigX, sy, { width: sigWidth });
  }

  doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#777")
    .text("DATE", sigX, topY, { width: sigWidth, align: "right" });
  doc.fontSize(9).font("Helvetica").fillColor("#000")
    .text(new Date().toLocaleDateString(), sigX, topY + 12, { width: sigWidth, align: "right" });

  // Official stamp — an embedded image if the school has uploaded one
  // (SchoolSettings.stampUrl), otherwise the same plain dashed-circle
  // placeholder convention the on-screen transcript/report views
  // already use rather than leaving the space blank.
  if (institution.stampDiskPath) {
    try {
      doc.image(institution.stampDiskPath, stampX, topY, { width: stampSize, height: stampSize });
    } catch (err) {
      console.error("⚠️ Could not embed stamp in transcript PDF:", err.message);
    }
  } else {
    const cx = stampX + stampSize / 2;
    const cy = topY + stampSize / 2;
    doc.circle(cx, cy, stampSize / 2).dash(3, { space: 2 }).strokeColor("#bbb").stroke();
    doc.undash();
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#bbb")
      .text("OFFICIAL\nSTAMP", stampX, cy - 8, { width: stampSize, align: "center" });
  }
  doc.fillColor("#000");

  doc.y = topY + Math.max(sy - topY, stampSize) + 8;
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
   scope and class/audience scope for the header on every page.
   `officials` is the school's signing officials (see file header). */
function buildTranscriptPdf({ institution, officials, title, subtitle, students }) {
  const theme = resolveReportTheme(institution?.reportTheme);
  const signers = Array.isArray(officials) ? officials : [];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ layout: "portrait", margin: PAGE_MARGIN, size: "A4", bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    students.forEach((page, idx) => {
      if (idx > 0) doc.addPage();
      drawInstitutionHeader(doc, institution, { title, subtitle }, theme);
      drawIntroParagraph(doc, page.student, title);
      drawStudentInfo(doc, page.student);
      page.exams.forEach((exam) => drawExamTable(doc, exam, theme));
      drawCumulativeSummary(doc, page, theme);
      drawSignatureBlock(doc, signers, institution, theme);
      doc.fontSize(7).fillColor("#999").text(`Generated: ${new Date().toLocaleString()}`, { align: "right" });
      doc.fillColor("#000");
    });

    addPageNumbers(doc);
    doc.end();
  });
}

module.exports = { buildTranscriptPdf };