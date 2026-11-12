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

/* One-page fitting. Every size below comes from a "metrics" object built
   for a scale factor. buildTranscriptPdf() tries scale 1 first and steps
   down (dry run on a scratch document) until a student's whole transcript
   fits on ONE A4 page. Fonts/rows never shrink below a readable floor; if
   a student has so many exams that even the floor does not fit, the
   transcript flows onto a second page instead of becoming unreadable. */
const SCALES = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58];
const MAX_CELL_LINES = 3; // a code/subject cell wraps to at most this many lines, then ends with "…"
const metricsFor = (s) => ({
  s,
  font: Math.max(6, 8 * s),
  headFont: Math.max(6, 7.5 * s),
  headH: Math.max(12, 16 * s),
  minRowH: Math.max(11, 16 * s),
  pad: Math.max(2, 3.5 * s),
  logo: Math.max(30, Math.round(42 * s)),
  infoRowH: Math.max(24, 30 * s),
  photoH: Math.max(52, Math.round(66 * s)),
  stamp: Math.max(46, Math.round(74 * s)),
  sigBoxH: Math.max(22, 34 * s),
  remarksBoxH: Math.max(18, 26 * s),
  lineOff: Math.max(26, 34 * s),
});

function drawInstitutionHeader(doc, institution, { title, subtitle }, theme, m) {
  const startX = doc.page.margins.left;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const LOGO_SIZE = m.logo;
  const topY = doc.y;
  let logoDrawn = false;
  if (institution.logoDiskPath) {
    try {
      doc.image(institution.logoDiskPath, startX, topY, { width: LOGO_SIZE, height: LOGO_SIZE });
      logoDrawn = true;
    } catch (err) {
      console.error("⚠️ Could not embed logo in transcript PDF:", err.message);
    }
  }
  // Centre on the FULL page width: the logo sits at the far left and the same
  // room is reserved on both sides, so the school name, address and contact
  // line stay central like the title lines below (they used to be centred in
  // the space right of the logo and drifted to the right).
  const inset = logoDrawn ? LOGO_SIZE + 10 : 0;
  const textX = startX + inset;
  const textWidth = fullWidth - inset * 2;
  const centre = (text, size, font, color, x = startX, width = fullWidth) =>
    doc.fontSize(size).font(font).fillColor(color).text(text, x, doc.y, { width, align: "center" });

  doc.y = topY;
  centre(institution.schoolName || "Institution", 13, "Helvetica-Bold", "#000", textX, textWidth);
  if (institution.address) centre(institution.address, 8, "Helvetica", "#555", textX, textWidth);
  const contactParts = [
    institution.phone ? `Tel: ${institution.phone}` : null,
    institution.email ? `Email: ${institution.email}` : null,
    institution.website ? institution.website : null,
  ].filter(Boolean);
  if (contactParts.length) centre(contactParts.join("   |   "), 8, "Helvetica", "#555", textX, textWidth);
  doc.fillColor("#000");
  // never let the title lines draw over the logo
  if (logoDrawn) doc.y = Math.max(doc.y, topY + LOGO_SIZE);
  doc.x = startX;
  doc.moveDown(0.4);
  centre("STUDENT ACADEMIC TRANSCRIPT", 11, "Helvetica-Bold", "#000");
  centre(title, 9, "Helvetica-Bold", theme.primary);
  if (subtitle) centre(subtitle, 8, "Helvetica", "#555");
  doc.fillColor("#000");
  doc.x = startX;
  doc.moveDown(0.6);
  doc.moveTo(startX, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(theme.rule).stroke();
  doc.moveDown(0.6);
  doc.x = startX;
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

function drawStudentInfo(doc, student, m) {
  const startX = doc.page.margins.left;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // Student photo sits at the right edge of the particulars block; the three
  // columns share the remaining width.
  const hasPhoto = !!student.photoImage;
  const photoH = m.photoH;
  const photoW = Math.round(photoH * 0.8);
  const colWidth = (fullWidth - (hasPhoto ? photoW + 12 : 0)) / 3;
  const rowH = hasPhoto ? Math.max(m.infoRowH, photoH / 2) : m.infoRowH;
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
    // Shrink the font until the whole value fits on its single line, so a
    // long student name is shown in full instead of being cut with "…".
    const shown = value == null || value === "" ? "—" : String(value);
    let size = 10;
    doc.font("Helvetica-Bold");
    while (size > 6 && doc.fontSize(size).widthOfString(shown) > colWidth - 6) size -= 0.5;
    doc.fillColor("#000").text(shown, x, y + 11 + (10 - size) / 2, { width: colWidth - 4, lineBreak: false });
  };
  field("Student Name", student.name, 0, 0);
  field("Gender", student.gender, 1, 0);
  field("Index No.", student.assessmentNumber, 2, 0);
  field("Admission No.", student.admissionNo, 0, 1);
  field("Class", student.studentClass, 1, 1);
  field("Year of Study", student.yearOfStudy, 2, 1);
  if (hasPhoto) {
    const px = startX + fullWidth - photoW;
    try {
      doc.image(student.photoImage, px, startY, { fit: [photoW, photoH], align: "center", valign: "center" });
    } catch (err) {
      console.error("⚠️ Could not embed student photo in transcript PDF:", err.message);
    }
    doc.save().lineWidth(0.8).strokeColor("#999").rect(px, startY, photoW, photoH).stroke().restore();
  }
  doc.y = startY + Math.max(rowH * 2, hasPhoto ? photoH : 0);
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

/* One exam's subject table: Code | Subject | Marks % | Grade | Points |
   Result, plus an average row.
     GRADE  = the grade of the score's band in the Grading System (e.g. 1-7)
     POINTS = the band's label from the Grading System (e.g. Distinction)
     RESULT = the result label for the score (overall bands, e.g. CREDIT)
   Row height is MEASURED per row: a long subject code or name wraps (up to
   MAX_CELL_LINES lines) and the row grows to hold it, so text can never
   spill over the row below. Everything is sized from the metrics `m`. */
function drawExamTable(doc, exam, theme, m) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const colW = [0.13, 0.33, 0.11, 0.09, 0.15, 0.19].map((w) => usableWidth * w);
  const colX = [];
  colW.reduce((x, w) => { colX.push(x); return x + w; }, pageLeft);
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 20;

  // Never leave an exam heading orphaned at the bottom of a page.
  const neededForHeading = 20 + m.headH + m.minRowH;
  if (doc.y + neededForHeading > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const examLabel = [exam.examName, exam.term, exam.academic_year].filter(Boolean).join(" — ");
  doc.fontSize(Math.max(8.5, 9.5 * m.s)).font("Helvetica-Bold").fillColor(theme.primary)
    .text(examLabel, pageLeft, doc.y, { width: usableWidth });
  doc.fillColor("#000");
  doc.x = pageLeft;
  doc.moveDown(0.2);

  let y = doc.y;
  const headers = ["CODE", "SUBJECT", "MARKS %", "GRADE", "POINTS", "RESULT"];
  const aligns = ["center", "left", "center", "center", "center", "center"];
  const drawHeaderRow = () => {
    doc.rect(pageLeft, y, usableWidth, m.headH).fill(theme.primary);
    doc.fillColor(theme.onPrimary).fontSize(m.headFont).font("Helvetica-Bold");
    const ty = y + (m.headH - doc.currentLineHeight(true)) / 2;
    headers.forEach((h, i) => {
      doc.text(h, colX[i] + 4, ty, { width: colW[i] - 8, align: aligns[i], lineBreak: false });
    });
    doc.fillColor("#000").font("Helvetica");
    y += m.headH;
  };
  drawHeaderRow();

  exam.subjects.forEach((s, idx) => {
    const cells = [
      s.subjectCode || "—",
      (() => {
        const nm = String(s.subjectName || "-").replace(/\s+/g, " ").trim();
        // optional subjects are labelled; they count toward the average when listed (i.e. the student took them)
        return s.optional && !/\(\s*optional\s*\)/i.test(nm) ? `${nm} (Optional)` : nm;
      })(),
      s.percentage != null && !Number.isNaN(Number(s.percentage)) ? `${Math.floor(Number(s.percentage) + 1e-9)}%` : "—",
      s.grade || "—",
      s.points || "—",
      s.result || "—",
    ].map(String);

    // Measure first, so the row is exactly tall enough for its wrapped text.
    doc.fontSize(m.font).font("Helvetica");
    const lh = doc.currentLineHeight(true);
    const maxH = lh * MAX_CELL_LINES + 0.5;
    const heights = cells.map((val, i) => (i < 2
      ? Math.min(maxH, Math.max(lh, doc.heightOfString(val, { width: colW[i] - 8 })))
      : lh));
    const rowH = Math.max(m.minRowH, Math.max(...heights) + 2 * m.pad);

    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow();
    }
    if (idx % 2 === 1) {
      doc.rect(pageLeft, y, usableWidth, rowH).fill(theme.zebra);
    }
    doc.fillColor("#000").fontSize(m.font).font("Helvetica");
    cells.forEach((val, i) => {
      const textY = y + (rowH - heights[i]) / 2;
      const opts = { width: colW[i] - 8, align: aligns[i], ellipsis: true };
      if (i < 2) doc.text(val, colX[i] + 4, textY, { ...opts, height: maxH });
      else doc.text(val, colX[i] + 4, textY, { ...opts, lineBreak: false });
    });
    y += rowH;
  });

  // Exam average row — theme-filled so it reads as a total.
  if (y + m.minRowH > bottomLimit()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(pageLeft, y, usableWidth, m.minRowH).fill(theme.primary);
  doc.fillColor(theme.onPrimary).fontSize(m.font).font("Helvetica-Bold");
  const ay = y + (m.minRowH - doc.currentLineHeight(true)) / 2;
  doc.text("EXAM AVERAGE", pageLeft + 4, ay, { width: colW[0] + colW[1] - 8, lineBreak: false });
  doc.text(exam.average != null ? `${Math.floor(Number(exam.average) + 1e-9)}%` : "—", colX[2] + 4, ay, { width: colW[2] - 8, align: "center", lineBreak: false });
  doc.text(exam.overallResult || "—", colX[3], ay, { width: colW[3] + colW[4] + colW[5] - 4, align: "center", lineBreak: false });
  doc.fillColor("#000").font("Helvetica");
  y += m.minRowH;

  doc.y = y + Math.max(3, 6 * m.s);

  // Aggregate points line — the subject grade codes summed (see transcript.controller.js).
  if (exam.aggregatePoints != null) {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#555")
      .text(`Aggregate Points: ${exam.aggregatePoints}`, pageLeft, doc.y, { width: usableWidth, align: "right" });
    doc.fillColor("#000");
  }

  doc.x = pageLeft;
  doc.y += Math.max(4, 10 * m.s);
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
      `Cumulative Average across ${page.exams.length} exams: ${page.cumulativeAverage != null ? `${Math.floor(Number(page.cumulativeAverage)+1e-9)}%` : "—"}  (${page.cumulativeResult || "—"})`,
      pageLeft + 8, doc.y + 8
    );
  doc.fillColor("#000");
  doc.y += 26;
}

/* Signature / stamp block — mirrors the on-screen Report Form's
   authorisation section (frontend/src/pages/reports.jsx) so every stamp
   and signature shown there also appears on the downloaded transcript:
     1. one "Class Teacher's Remarks" row per class teacher of THIS
        student's class (name, own uploaded signature, own stamp);
     2. one "Approval & Authentication" row per signatory (name, title,
        own uploaded signature, own stamp).
   A stamp falls back to the school-wide stamp when the person hasn't
   uploaded their own (same fallback as the form), and a plain dashed
   placeholder is drawn only when no stamp exists anywhere. */
function drawImageFit(doc, diskPath, x, y, w, h) {
  if (!diskPath) return false;
  try {
    doc.image(diskPath, x, y, { fit: [w, h], align: "left", valign: "center" });
    return true;
  } catch (err) {
    console.error("⚠️ Could not embed image in transcript PDF:", err.message);
    return false;
  }
}

function drawStampOrPlaceholder(doc, diskPath, x, y, size) {
  if (drawImageFit(doc, diskPath, x, y, size, size)) return;
  const cx = x + size / 2;
  const cy = y + size / 2;
  doc.circle(cx, cy, size / 2 - 1).dash(3, { space: 2 }).strokeColor("#bbb").stroke();
  doc.undash();
  doc.fontSize(7).font("Helvetica-Bold").fillColor("#bbb")
    .text("OFFICIAL\nSTAMP", x, cy - 8, { width: size, align: "center" });
  doc.fillColor("#000");
}

function drawSignatureBlock(doc, officials, institution, theme, classTeachers = [], m) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const stampSize = m.stamp;
  const sigBoxW = 150;
  const sigBoxH = m.sigBoxH;
  const schoolStamp = institution.stampDiskPath;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  const stampX = pageRight - stampSize;

  const ensureRoom = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };

  doc.moveDown(0.4 * m.s);
  ensureRoom(40);
  doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).strokeColor(theme.rule).stroke();
  doc.moveDown(0.6 * m.s);

  // One row: label, name, optional title, signature image over a line,
  // date, and the stamp at the right-hand edge. Row height is derived from
  // its contents (and the stamp) so nothing overlaps at any scale.
  const drawRow = ({ label, name, title, signatureDiskPath, stampDiskPath, remarks, noStamp }) => {
    const remarksBlock = remarks ? m.remarksBoxH + 8 : 0;
    const rowH = Math.max(stampSize + 10, 12 + remarksBlock + m.lineOff + 14);
    ensureRoom(rowH);
    const topY = doc.y;
    const lineW = usableWidth - stampSize - 24;

    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#777").text(label.toUpperCase(), pageLeft, topY, { width: lineW, lineBreak: false });
    let y = topY + 12;
    if (remarks) {
      doc.rect(pageLeft, y, lineW, m.remarksBoxH).dash(3, { space: 2 }).strokeColor("#cbd5e1").stroke();
      doc.undash();
      doc.fontSize(7.5).font("Helvetica").fillColor("#999")
        .text("Remarks and recommendations.", pageLeft + 6, y + (m.remarksBoxH - 9) / 2, { width: lineW - 12, lineBreak: false });
      y += remarksBlock;
    }
    // Name and title are shown in full: the font shrinks to fit the column.
    const fitText = (text, font, startSize, maxW, floor) => {
      let size = startSize;
      doc.font(font);
      while (size > floor && doc.fontSize(size).widthOfString(text) > maxW) size -= 0.5;
      return size;
    };
    const nameText = name || "—";
    const nameSize = fitText(nameText, "Helvetica-Bold", 9.5, lineW * 0.55, 6);
    doc.fontSize(nameSize).font("Helvetica-Bold").fillColor("#000").text(nameText, pageLeft, y, { width: lineW * 0.57, lineBreak: false });
    if (title) {
      const titleSize = fitText(String(title), "Helvetica", 8, lineW * 0.55, 6);
      doc.fontSize(titleSize).font("Helvetica").fillColor("#555").text(String(title), pageLeft, y + 12, { width: lineW * 0.57, lineBreak: false });
    }

    // signature image sits on the line, to the right of the name
    const sigX = pageLeft + lineW * 0.58;
    const lineY = y + m.lineOff;
    drawImageFit(doc, signatureDiskPath, sigX, lineY - sigBoxH - 1, sigBoxW, sigBoxH);
    doc.moveTo(sigX, lineY).lineTo(sigX + sigBoxW, lineY).strokeColor("#999").stroke();
    doc.fontSize(7).font("Helvetica").fillColor("#777").text("Signature", sigX, lineY + 2, { width: sigBoxW, lineBreak: false });

    doc.fontSize(7).font("Helvetica").fillColor("#777").text("Date", pageLeft, lineY + 2, { lineBreak: false });
    doc.moveTo(pageLeft + 24, lineY).lineTo(pageLeft + 24 + 90, lineY).strokeColor("#999").stroke();

    if (!noStamp) drawStampOrPlaceholder(doc, stampDiskPath || schoolStamp, stampX, topY + 4, stampSize);
    doc.fillColor("#000");
    doc.x = pageLeft;
    doc.y = topY + rowH;
  };

  // The Report Form always shows a class-teacher card — a blank hand-signed
  // one when nobody is assigned to the class — so the transcript does too.
  if (classTeachers.length) {
    classTeachers.forEach((ct) => drawRow({
      label: ct.title ? `${ct.title}'s Remarks` : "Class Teacher's Remarks",
      name: ct.name,
      signatureDiskPath: ct.signatureDiskPath,
      stampDiskPath: ct.stampDiskPath,
      remarks: true,
    }));
  } else {
    drawRow({ label: "Class Teacher's Remarks", name: "—", remarks: true, noStamp: true });
  }

  if (officials.length) {
    officials.forEach((o) => drawRow({
      label: "Approval & Authentication",
      name: o.name,
      title: o.title,
      signatureDiskPath: o.signatureDiskPath,
      stampDiskPath: o.stampDiskPath,
    }));
  } else {
    drawRow({ label: "Approval & Authentication", name: "—", stampDiskPath: schoolStamp });
  }

  // Footer "Official stamp" — the Report Form's footer stamp (Dean's, else
  // Principal's, else first signatory's), shown bottom-left with the date.
  const footerStamp = institution.footerStampDiskPath || schoolStamp;
  const footerSize = Math.max(40, Math.round(stampSize * 0.85));
  ensureRoom(footerSize + 6);
  const footTop = doc.y + 2;
  drawStampOrPlaceholder(doc, footerStamp, pageLeft, footTop, footerSize);
  doc.fontSize(7).font("Helvetica").fillColor("#777")
    .text(`Date: ${new Date().toLocaleDateString()}`, pageLeft, footTop + footerSize - 8, { width: usableWidth, align: "right", lineBreak: false });
  doc.fillColor("#000");
  doc.x = pageLeft;
  doc.y = footTop + footerSize + Math.max(4, 8 * m.s);
}

function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin. Without zeroing it, pdfkit sees
    // text below the page's content area and appends a BLANK page for every
    // footer written — i.e. one extra empty page per real page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(7).fillColor("#888").text(
      `Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - savedBottom + 6,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = savedBottom;
  }
  doc.fillColor("#000");
}

/* Draws ONE student's whole transcript starting at the current page. */
function renderStudentPage(doc, page, ctx, m) {
  drawInstitutionHeader(doc, ctx.institution, { title: ctx.title, subtitle: ctx.subtitle }, ctx.theme, m);
  drawIntroParagraph(doc, page.student, ctx.title);
  drawStudentInfo(doc, page.student, m);
  page.exams.forEach((exam) => drawExamTable(doc, exam, ctx.theme, m));
  drawCumulativeSummary(doc, page, ctx.theme);
  const norm = (v) => String(v || "").trim().toLowerCase();
  const classTeachersForStudent = ctx.classTeachers.filter((c) => norm(c.className) === norm(page.student.studentClass));
  drawSignatureBlock(doc, ctx.signers, ctx.institution, ctx.theme, classTeachersForStudent, m);
  doc.fontSize(7).fillColor("#999").text(`Generated: ${new Date().toLocaleString()}`, { align: "right" });
  doc.fillColor("#000");
}

/* Returns a Buffer. `students` is the per-student array shaped by
   transcript.controller.js; `title`/`subtitle` describe the exam
   scope and class/audience scope for the header on every page.
   `officials` is the school's signing officials (see file header).
   Each student gets ONE page: the layout is dry-run on a scratch document
   at decreasing scales until it fits (see SCALES above). */
function buildTranscriptPdf({ institution, officials, classTeachers, title, subtitle, students }) {
  const theme = resolveReportTheme(institution?.reportTheme);
  const ctx = {
    institution, title, subtitle, theme,
    signers: Array.isArray(officials) ? officials : [],
    classTeachers: Array.isArray(classTeachers) ? classTeachers : [],
  };
  return new Promise((resolve, reject) => {
    try {
      const opts = { layout: "portrait", margin: PAGE_MARGIN, size: "A4", bufferPages: true };
      const doc = new PDFDocument(opts);
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Scratch document used only to measure; its output is discarded.
      const scratch = new PDFDocument(opts);
      scratch.on("data", () => {});
      const fitsOnOnePage = (page, m) => {
        scratch.addPage();
        const before = scratch.bufferedPageRange().count;
        renderStudentPage(scratch, page, ctx, m);
        return scratch.bufferedPageRange().count === before;
      };
      const pickMetrics = (page) => {
        for (const sc of SCALES) {
          const m = metricsFor(sc);
          if (fitsOnOnePage(page, m)) return m;
        }
        return metricsFor(SCALES[SCALES.length - 1]);
      };

      students.forEach((page, idx) => {
        const m = pickMetrics(page);
        if (idx > 0) doc.addPage();
        renderStudentPage(doc, page, ctx, m);
      });
      scratch.end();

      addPageNumbers(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildTranscriptPdf };