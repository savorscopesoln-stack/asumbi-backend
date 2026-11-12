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
  // Government emblem at the far RIGHT, balancing the school logo on the left.
  let govDrawn = false;
  if (institution.governmentLogoDiskPath) {
    try {
      doc.image(institution.governmentLogoDiskPath, startX + fullWidth - LOGO_SIZE, topY, { fit: [LOGO_SIZE, LOGO_SIZE], align: "right", valign: "top" });
      govDrawn = true;
    } catch (err) {
      console.error("⚠️ Could not embed government logo in transcript PDF:", err.message);
    }
  }
  // Centre on the FULL page width: the school logo sits at the far left, the
  // government logo at the far right, and the same room is reserved on both
  // sides, so the school name, address and contact line stay central.
  const inset = logoDrawn || govDrawn ? LOGO_SIZE + 10 : 0;
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
  if (logoDrawn || govDrawn) doc.y = Math.max(doc.y, topY + LOGO_SIZE);
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

/* One exam's subject table: Subject | Marks % | Grade | Points |
   Description, plus an average row. A paper the student missed shows AB.
     GRADE  = the grade of the score's band in the Grading System (e.g. 1-7)
     POINTS = the band's label from the Grading System (e.g. Distinction)
     DESCRIPTION = the result label for the score (overall bands, e.g. CREDIT)
   Row height is MEASURED per row: a long subject code or name wraps (up to
   MAX_CELL_LINES lines) and the row grows to hold it, so text can never
   spill over the row below. Everything is sized from the metrics `m`. */
function drawExamTable(doc, exam, theme, m) {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const usableWidth = pageRight - pageLeft;
  const colW = [0.38, 0.14, 0.12, 0.16, 0.20].map((w) => usableWidth * w);
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
  const headers = ["SUBJECT", "MARKS %", "GRADE", "POINTS", "DESCRIPTION"];
  const aligns = ["left", "center", "center", "center", "center"];
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
      (() => {
        const nm = String(s.subjectName || "-").replace(/\s+/g, " ").trim();
        // optional subjects are labelled; they count toward the average when listed (i.e. the student took them)
        return s.optional && !/\(\s*optional\s*\)/i.test(nm) ? `${nm} (Optional)` : nm;
      })(),
      s.absent ? "AB" : (s.percentage != null && !Number.isNaN(Number(s.percentage)) ? `${Math.floor(Number(s.percentage) + 1e-9)}%` : "—"),
      s.grade || "—",
      s.points || "—",
      s.result || "—",
    ].map(String);

    // Measure first, so the row is exactly tall enough for its wrapped text.
    doc.fontSize(m.font).font("Helvetica");
    const lh = doc.currentLineHeight(true);
    const maxH = lh * MAX_CELL_LINES + 0.5;
    const heights = cells.map((val, i) => (i < 1
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
      if (i < 1) doc.text(val, colX[i] + 4, textY, { ...opts, height: maxH });
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
  doc.text("EXAM AVERAGE", pageLeft + 4, ay, { width: colW[0] - 8, lineBreak: false });
  doc.text(exam.average != null ? `${Math.floor(Number(exam.average) + 1e-9)}%` : "—", colX[1] + 4, ay, { width: colW[1] - 8, align: "center", lineBreak: false });
  doc.text(exam.overallResult || "—", colX[2], ay, { width: colW[2] + colW[3] + colW[4] - 4, align: "center", lineBreak: false });
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

/* =========================================================================
   OFFICIAL AUTHORISATION BLOCK — a 1:1 redraw of the student Report Form's
   "Official Authorisation" section (frontend/src/pages/Student/
   StudentReport.jsx, mirrored on screen by
   frontend/src/components/OfficialAuthorisation.jsx), so the downloaded
   transcript carries its stamps and signatures exactly the way the Report
   Form does:

     - a section label bar ("OFFICIAL AUTHORISATION", theme-coloured left
       rule);
     - a two-column grid of rounded cards, filled left-to-right:
         · one "<Title>'s Remarks" card per class teacher of the student's
           class — dashed remarks box, then Name / Signature / Date;
         · one "Approved By" card per signatory — name, title, then
           Signature / Official Stamp;
     - every card's stamp is the person's OWN stamp, falling back to the
       school-wide stamp, drawn LARGE (2in x 1in) over the card's upper
       right corner, tilted -8deg at 85% opacity with a multiply blend so
       it reads as ink pressed onto the page;
     - the dashed "Official Stamp" placeholder shows only on an Approved By
       card when no stamp exists anywhere; a class-teacher card has none.

   Every measurement below is the Report Form's CSS value in px, converted
   with `u` (1px -> points, shrunk by the one-page-fit scale). There is no
   separate footer stamp: the Report Form has none.
========================================================================= */
const IMG_SIZE_CACHE = new Map();
function imageSize(doc, diskPath) {
  if (!diskPath) return null;
  if (IMG_SIZE_CACHE.has(diskPath)) return IMG_SIZE_CACHE.get(diskPath);
  let size = null;
  try {
    const img = doc.openImage(diskPath);
    size = { w: img.width, h: img.height };
  } catch (err) {
    console.error("⚠️ Could not read image for transcript PDF:", err.message);
  }
  IMG_SIZE_CACHE.set(diskPath, size);
  return size;
}

/* Graphics state that gives the stamp the Report Form's `opacity: .85` +
   `mix-blend-mode: multiply`. PDFKit has no blend-mode API, so register the
   ExtGState the same way its own opacity() does. */
function applyMultiplyBlend(doc, opacity) {
  try {
    const key = `mul_${opacity}`;
    let entry = doc._opacityRegistry[key];
    if (!entry) {
      const dict = doc.ref({ Type: "ExtGState", BM: "Multiply", ca: opacity, CA: opacity, AIS: false });
      dict.end();
      entry = [dict, `GsMul${++doc._opacityCount}`];
      doc._opacityRegistry[key] = entry;
    }
    doc.page.ext_gstates[entry[1]] = entry[0];
    doc.addContent(`/${entry[1]} gs`);
  } catch (err) {
    doc.opacity(opacity); // plain transparency if blend modes are unavailable
  }
}

function drawSignatureBlock(doc, officials, institution, theme, generalRemarks = "", m) {
  const sc = Math.max(0.6, m.s);
  const u = 0.75 * sc; // one Report Form CSS px, in PDF points
  const px = (n) => n * u;
  const fsz = (n) => Math.max(5, n * u);
  const primary = theme.primary;
  const pageLeft = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const schoolStamp = institution.stampDiskPath;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  const ensureRoom = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };

  const lineH = (size, font) => doc.font(font).fontSize(size).currentLineHeight();
  const textH = (str, size, font, width, opts = {}) =>
    doc.font(font).fontSize(size).heightOfString(String(str), { width, ...opts });

  const GAP = px(6);
  const colW = (usable - GAP) / 2;
  const BORDER = px(1);
  const PAD_X = px(12);
  const PAD_Y = px(8);
  const innerW = colW - 2 * (PAD_X + BORDER);
  const cellW = (innerW - 2 * GAP) / 3; // sigGrid: 3 equal columns, 6px gap

  /* ---- element specs (Report Form CSS) ---- */
  const TITLE = { size: fsz(10.5), font: "Helvetica-Bold", spacing: 0.1, mb: px(9) };
  const LABEL = { size: fsz(9.5), font: "Helvetica-Bold", mb: px(5) };
  const SIG_MAX_W = 0.8 * cellW;
  const SIG_MAX_H = px(32);

  // sigImage: max 80% x 32px, object-fit: contain, never upscaled past natural px size
  const sigDisplay = (diskPath) => {
    const s = imageSize(doc, diskPath);
    if (!s) return null;
    const k = Math.min(1, SIG_MAX_W / (s.w * u), SIG_MAX_H / (s.h * u));
    return { w: s.w * u * k, h: s.h * u * k };
  };

  const titleText = (t) => String(t).toUpperCase();
  const titleHeight = (t) =>
    textH(titleText(t), TITLE.size, TITLE.font, innerW, { characterSpacing: TITLE.spacing * TITLE.size });

  const labelH = () => lineH(LABEL.size, LABEL.font) + LABEL.mb;

  // The Report Form lets a stamp overhang its card; on paper keep it inside
  // so it never runs into whatever is printed below.
  const minForStamp = (c) => (c.stamp ? BORDER * 2 + px(2) + 72 * sc + 5 * sc : 0);

  /* ---- layout: natural height of each card ---- */
  const REMARK_SIZE = fsz(10);
  const layoutRemarks = (c) => {
    const textBlock = textH(c.text || " ", REMARK_SIZE, "Helvetica", innerW);
    return BORDER + PAD_Y + titleHeight(c.title) + TITLE.mb + textBlock + PAD_Y + BORDER;
  };

  const layoutApprover = (c) => {
    const nameH = textH(c.name || "—", fsz(14), "Helvetica-Bold", innerW);
    const roleH = textH(c.role || "—", fsz(12), "Helvetica", innerW);
    const identH = px(4) + nameH + px(2) + roleH + px(2) + px(4);
    const sig = c.signatureDiskPath ? sigDisplay(c.signatureDiskPath) : null;
    const items = [
      labelH() + (sig ? sig.h : BORDER),
      labelH() + (c.stamp ? 0 : px(0.7 * 96)), // dashed placeholder is 0.7in tall
    ];
    const gridH = Math.max(...items);
    return Math.max(
      BORDER + PAD_Y + titleHeight(c.title) + TITLE.mb + identH + px(6) + gridH + PAD_Y + BORDER,
      minForStamp(c)
    );
  };

  /* ---- painting ---- */
  const paintSigLine = (x, y, w) => {
    const lw = 0.8 * w;
    doc.lineWidth(BORDER).strokeColor("#334155")
      .moveTo(x + (w - lw) / 2, y + BORDER / 2).lineTo(x + (w + lw) / 2, y + BORDER / 2).stroke();
  };
  const paintLabel = (str, x, y, w) => {
    doc.font(LABEL.font).fontSize(LABEL.size).fillColor("#64748b")
      .text(str, x, y, { width: w, align: "center", lineBreak: false });
    return y + lineH(LABEL.size, LABEL.font) + LABEL.mb;
  };
  const paintSigImage = (diskPath, x, y, w) => {
    const d = sigDisplay(diskPath);
    if (!d) return false;
    try {
      doc.image(diskPath, x + (w - d.w) / 2, y, { width: d.w, height: d.h });
      return true;
    } catch (err) {
      console.error("⚠️ Could not embed signature in transcript PDF:", err.message);
      return false;
    }
  };

  // Stamp: 2in x 1in, top 2px / right 4px of the card, rotate(-8deg),
  // opacity .85, multiply — drawn last so it sits over the card's text.
  const paintStamp = (diskPath, cardX, cardY, cardW) => {
    if (!diskPath) return;
    const w = 144 * sc;
    const h = 72 * sc;
    const x = cardX + cardW - BORDER - px(4) - w;
    const y = cardY + BORDER + px(2);
    try {
      doc.save();
      doc.rotate(-8, { origin: [x + w / 2, y + h / 2] });
      applyMultiplyBlend(doc, 0.85);
      doc.image(diskPath, x, y, { fit: [w, h], align: "center", valign: "center" });
      doc.restore();
    } catch (err) {
      doc.restore();
      console.error("⚠️ Could not embed stamp in transcript PDF:", err.message);
    }
  };

  const paintCardFrame = (x, y, h) => {
    doc.roundedRect(x + BORDER / 2, y + BORDER / 2, colW - BORDER, h - BORDER, px(10))
      .lineWidth(BORDER).strokeColor("#e2e8f0").stroke();
  };
  const paintTitle = (str, x, y) => {
    doc.font(TITLE.font).fontSize(TITLE.size).fillColor(primary)
      .text(titleText(str), x, y, { width: innerW, characterSpacing: TITLE.spacing * TITLE.size });
    return y + titleHeight(str) + TITLE.mb;
  };

  const paintRemarks = (c, x, y, h) => {
    paintCardFrame(x, y, h);
    const ix = x + BORDER + PAD_X;
    const cy = paintTitle(c.title, ix, y + BORDER + PAD_Y);
    doc.font("Helvetica").fontSize(REMARK_SIZE).fillColor("#334155").text(c.text || "", ix, cy, { width: innerW });
  };

  const paintApprover = (c, x, y, h) => {
    paintCardFrame(x, y, h);
    const ix = x + BORDER + PAD_X;
    let cy = paintTitle(c.title, ix, y + BORDER + PAD_Y);
    // identity block (padding 4px 0)
    cy += px(4);
    const nameH = textH(c.name || "—", fsz(14), "Helvetica-Bold", innerW);
    doc.font("Helvetica-Bold").fontSize(fsz(14)).fillColor("#0f172a").text(c.name || "—", ix, cy, { width: innerW });
    cy += nameH + px(2);
    const roleH = textH(c.role || "—", fsz(12), "Helvetica", innerW);
    doc.font("Helvetica").fontSize(fsz(12)).fillColor("#64748b").text(c.role || "—", ix, cy, { width: innerW });
    cy += roleH + px(2) + px(4) + px(6);
    // Signature / Official Stamp (columns 1 and 2 of the 3-column grid)
    const c1 = ix;
    const c2 = ix + cellW + GAP;
    const sy = paintLabel("Signature", c1, cy, cellW);
    if (!(c.signatureDiskPath && paintSigImage(c.signatureDiskPath, c1, sy, cellW))) paintSigLine(c1, sy, cellW);
    const sy2 = paintLabel("Official Stamp", c2, cy, cellW);
    if (!c.stamp) {
      // dashed placeholder, 1.4in x 0.7in; like the Report Form it is centred
      // in its column and simply overflows to the right when wider.
      const bw = px(1.4 * 96);
      const bh = px(0.7 * 96);
      const bx = c2 + Math.max(0, (cellW - bw) / 2);
      doc.roundedRect(bx + px(0.75), sy2 + px(0.75), bw - px(1.5), bh - px(1.5), px(4))
        .lineWidth(px(1.5)).dash(px(4), { space: px(3) }).strokeColor("#94a3b8").stroke();
      doc.undash();
    }
    paintStamp(c.stamp, x, y, colW);
  };

  /* ---- build the cards in the Report Form's order ---- */
  const cards = [];
  // General remarks (automatic) replace the class teacher's remarks.
  cards.push({ kind: "remarks", title: "General Remarks", text: generalRemarks || "No remarks." });
  if (officials.length) {
    officials.forEach((o) => cards.push({
      kind: "approver",
      title: "Approved By",
      name: o.name,
      role: o.title,
      signatureDiskPath: o.signatureDiskPath,
      stamp: o.stampDiskPath || schoolStamp,
    }));
  } else {
    // Report Form fallback when no signatory is configured: the dean /
    // principal / first signatory, whose stamp is resolved into footerStampDiskPath.
    cards.push({
      kind: "approver",
      title: "Approved By",
      name: "—",
      role: "—",
      signatureDiskPath: null,
      stamp: institution.footerStampDiskPath || schoolStamp,
    });
  }

  /* ---- section label bar ---- */
  doc.moveDown(0.4 * m.s);
  const labelSize = fsz(9.5);
  const labelSpacing = 0.12 * labelSize;
  const barH = lineH(labelSize, "Helvetica-Bold");
  const rows = [];
  for (let i = 0; i < cards.length; i += 2) {
    const pair = cards.slice(i, i + 2);
    const hs = pair.map((c) => (c.kind === "remarks" ? layoutRemarks(c) : layoutApprover(c)));
    rows.push({ pair, h: Math.max(...hs) });
  }
  ensureRoom(barH + px(8) + rows[0].h);
  const barY = doc.y;
  doc.rect(pageLeft, barY, px(4), barH).fill(primary);
  doc.font("Helvetica-Bold").fontSize(labelSize).fillColor(primary)
    .text("OFFICIAL AUTHORISATION", pageLeft + px(4) + px(9), barY, { characterSpacing: labelSpacing, lineBreak: false });
  doc.y = barY + barH + px(8);

  /* ---- rows (grid items in one row share the taller card's height) ---- */
  rows.forEach((row, ri) => {
    if (ri > 0) ensureRoom(row.h);
    const y = doc.y;
    row.pair.forEach((c, ci) => {
      const x = pageLeft + ci * (colW + GAP);
      if (c.kind === "remarks") paintRemarks(c, x, y, row.h);
      else paintApprover(c, x, y, row.h);
    });
    doc.y = y + row.h + GAP;
  });

  doc.fillColor("#000").strokeColor("#000").lineWidth(1);
  doc.x = pageLeft;
  doc.y += Math.max(2, 4 * m.s);
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
  drawSignatureBlock(doc, ctx.signers, ctx.institution, ctx.theme, page.generalRemarks, m);
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