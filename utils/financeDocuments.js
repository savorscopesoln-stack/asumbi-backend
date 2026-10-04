const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

/* =========================================================================
   FINANCE DOCUMENTS — invoice & receipt PDFs

   Rendered on demand from the finance_invoices / finance_receipts rows
   (never stored as files), so a document always matches the database and
   survives a Render redeploy with no disk to lose. Built with pdfkit and the
   built-in Helvetica fonts, same as the app's other PDF exports
   (utils/transcriptPdf.js, utils/reportExport.js) — no extra dependency.
   The only bundled asset is the Doravo logo (backend/assets/doravo-logo.png);
   if it is ever missing the header falls back to the issuer name in text.

   The ISSUER is whoever bills the institution (Doravo, platform
   DoravoCore, by default). Everything about it is overridable via environment variables so
   bank / M-Pesa details never live in code:
     INVOICE_ISSUER_NAME, INVOICE_ISSUER_ADDRESS, INVOICE_ISSUER_EMAIL,
     INVOICE_ISSUER_PHONE, INVOICE_ISSUER_TAX_ID, INVOICE_PAYMENT_INSTRUCTIONS
========================================================================= */

const COLOR = {
  primary: "#8B1E2D", primaryDark: "#6F1725", primaryTint: "#FBEAEC",
  text: "#0B0F19", body: "#384152", muted: "#64748B", line: "#E2E5EA", tint: "#F8FAFC",
  paid: "#15803D", paidTint: "#ECFDF3", void: "#B91C1C", voidTint: "#FEF2F2",
  issued: "#B45309", issuedTint: "#FFFBEB",
};
const MARGIN = 48;
const LOGO_PATH = path.join(__dirname, "..", "assets", "doravo-logo.png");
const PLATFORM = "DoravoCore";

/* An env var left over from the earlier company branding must never leak
   onto a document, so any name containing "savor" falls back to Doravo. */
function cleanIssuerName(name) {
  const n = String(name || "").trim();
  return !n || /savor/i.test(n) ? "Doravo" : n;
}

function getIssuerProfile(env = process.env) {
  return {
    name: cleanIssuerName(env.INVOICE_ISSUER_NAME),
    product: PLATFORM,
    address: env.INVOICE_ISSUER_ADDRESS || "",
    email: env.INVOICE_ISSUER_EMAIL || "",
    phone: env.INVOICE_ISSUER_PHONE || "",
    taxId: env.INVOICE_ISSUER_TAX_ID || "",
    paymentInstructions: env.INVOICE_PAYMENT_INSTRUCTIONS || "",
  };
}

/** 12345.5 -> "12,345.50" (no reliance on the runtime's ICU data). */
function fmt(n) {
  const fixed = (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
  const [whole, dec] = fixed.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}
const fmtMoney = (currency, n) => `${currency} ${fmt(n)}`;
const money2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function fmtDate(d) {
  if (!d) return "-";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function toBuffer(title, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4", margin: MARGIN, bufferPages: false,
      info: { Title: title, Author: "Doravo", Producer: "Doravo", Creator: PLATFORM },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ------------------------------------------------------------ primitives */

function label(doc, text, x, y, width, align = "left") {
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.muted)
    .text(String(text).toUpperCase(), x, y, { width, align, characterSpacing: 0.6, lineBreak: false });
}

function pill(doc, text, color, tint, xRight, y) {
  doc.font("Helvetica-Bold").fontSize(8.5);
  const w = doc.widthOfString(text, { characterSpacing: 0.8 }) + 22;
  const x = xRight - w;
  doc.roundedRect(x, y, w, 20, 10).fillColor(tint).fill();
  doc.roundedRect(x, y, w, 20, 10).lineWidth(0.8).strokeColor(color).stroke();
  doc.fillColor(color).text(text, x, y + 6, { width: w, align: "center", characterSpacing: 0.8, lineBreak: false });
}

/** Maroon accent bar, logo + issuer block on the left, title / status / meta on the right. Returns the y to continue from. */
function drawHeader(doc, issuer, { title, badge, meta }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const pageW = doc.page.width;

  doc.rect(0, 0, pageW, 10).fillColor(COLOR.primary).fill();
  doc.rect(0, 10, pageW, 2.5).fillColor(COLOR.primaryDark).fill();

  const top = 36;
  let leftEnd = top;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, left - 4, top, { width: 130 });
    leftEnd = top + 74;
  } else {
    doc.font("Helvetica-Bold").fontSize(20).fillColor(COLOR.primary).text(issuer.name.toUpperCase(), left, top, { lineBreak: false });
    leftEnd = top + 28;
  }
  let y = leftEnd + 8;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLOR.text).text(issuer.name, left, y, { width: 260, lineBreak: false });
  y += 13;
  doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted);
  [issuer.address, issuer.email, issuer.phone, issuer.taxId && `Tax ID: ${issuer.taxId}`].filter(Boolean).forEach((line) => {
    doc.text(line, left, y, { width: 260, lineBreak: false });
    y += 12;
  });

  // right column
  doc.font("Helvetica-Bold").fontSize(30).fillColor(COLOR.primary)
    .text(title, left, top - 2, { width: right - left, align: "right", characterSpacing: 1.5, lineBreak: false });
  if (badge) pill(doc, badge.text, badge.color, badge.tint, right, top + 40);

  // Explicit label / value cells — pdfkit's `continued` text combined with
  // right alignment overprints lines, so each cell is placed by hand.
  let metaY = top + 72;
  meta.forEach(([k, v]) => {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted).text(k, right - 230, metaY, { width: 85, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLOR.text)
      .text(String(v ?? "-"), right - 140, metaY, { width: 140, align: "right", lineBreak: false });
    metaY += 15;
  });

  const end = Math.max(y, metaY, leftEnd) + 12;
  doc.moveTo(left, end).lineTo(right, end).lineWidth(0.8).strokeColor(COLOR.line).stroke();
  return end + 18;
}

/** Two side-by-side party cards. Returns the y below them. */
function drawParties(doc, y, cards) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const gap = 16;
  const cardW = (width - gap) / cards.length;
  const h = 78;
  cards.forEach((c, i) => {
    const x = left + i * (cardW + gap);
    doc.roundedRect(x, y, cardW, h, 6).fillColor(COLOR.tint).fill();
    doc.rect(x, y + 10, 3, h - 20).fillColor(COLOR.primary).fill();
    label(doc, c.label, x + 16, y + 11, cardW - 24);
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(COLOR.text)
      .text(c.name || "-", x + 16, y + 25, { width: cardW - 28, height: 15, ellipsis: true });
    doc.font("Helvetica").fontSize(9).fillColor(COLOR.body);
    let ly = y + 43;
    (c.lines || []).filter(Boolean).slice(0, 2).forEach((l) => {
      doc.text(l, x + 16, ly, { width: cardW - 28, lineBreak: false, ellipsis: true });
      ly += 12;
    });
  });
  return y + h + 22;
}

function drawFooter(doc, issuer, ref) {
  // The footer sits inside the bottom margin; without this pdfkit would
  // treat the text as overflow and append blank pages.
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const y = doc.page.height - 58;
  doc.moveTo(left, y).lineWidth(0.5).lineTo(left + width, y).strokeColor(COLOR.line).stroke();
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLOR.primary)
    .text("Thank you for choosing Doravo.", left, y + 9, { width, align: "center", lineBreak: false });
  doc.font("Helvetica").fontSize(7.5).fillColor(COLOR.muted)
    .text(`${ref}  |  ${issuer.name}, powered by ${issuer.product}  |  Moving Education Forward`, left, y + 22, { width, align: "center", lineBreak: false });
  doc.rect(0, doc.page.height - 6, doc.page.width, 6).fillColor(COLOR.primary).fill();
  doc.page.margins.bottom = savedBottom;
}

/** Large faint diagonal watermark behind the content. */
function drawWatermark(doc, text, color) {
  doc.save();
  doc.opacity(0.07);
  doc.rotate(-30, { origin: [doc.page.width / 2, 430] });
  doc.font("Helvetica-Bold").fontSize(120).fillColor(color)
    .text(text, 0, 380, { width: doc.page.width, align: "center", lineBreak: false });
  doc.restore();
  doc.opacity(1);
}

function statusStyle(status) {
  if (status === "paid") return { text: "PAID", color: COLOR.paid, tint: COLOR.paidTint };
  if (status === "void") return { text: "VOID", color: COLOR.void, tint: COLOR.voidTint };
  return { text: "AWAITING PAYMENT", color: COLOR.issued, tint: COLOR.issuedTint };
}

function noteBlock(doc, x, y, width, heading, body, color = COLOR.muted) {
  label(doc, heading, x, y, width);
  doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.body);
  const h = doc.heightOfString(body, { width });
  doc.text(body, x, y + 13, { width });
  return y + 13 + h + 14;
}

/* ---------------------------------------------------------------- INVOICE */

/**
 * @param {object} invoice  finance_invoices row (+ optional paid payment fields)
 * @param {object} [opts]   { issuer, paidWith: { payment_reference, method } | null }
 */
function buildInvoicePdf(invoice, { issuer = getIssuerProfile(), paidWith = null } = {}) {
  return toBuffer(`Invoice ${invoice.invoice_number || ""}`.trim(), (doc) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const cur = invoice.currency;
    const st = statusStyle(invoice.status);

    if (invoice.status === "paid") drawWatermark(doc, "PAID", COLOR.paid);
    if (invoice.status === "void") drawWatermark(doc, "VOID", COLOR.void);

    let y = drawHeader(doc, issuer, {
      title: "INVOICE",
      badge: st,
      meta: [
        ["Invoice no.", invoice.invoice_number],
        ["Issue date", fmtDate(invoice.issue_date)],
        ["Due date", invoice.due_date ? fmtDate(invoice.due_date) : "On receipt"],
      ],
    });

    y = drawParties(doc, y, [
      { label: "Billed to", name: invoice.bill_to_name, lines: [invoice.bill_to_email, invoice.bill_to_phone] },
      { label: "Amount due", name: invoice.status === "paid" ? `${cur} 0.00` : fmtMoney(cur, invoice.total_amount),
        lines: [invoice.status === "paid" ? `Settled ${fmtDate(invoice.paid_at)}` : invoice.due_date ? `Due ${fmtDate(invoice.due_date)}` : "Payable on receipt"] },
    ]);

    // line-item table
    const colQty = left + width * 0.52;
    const colPrice = left + width * 0.66;
    const colAmt = left + width * 0.82;
    doc.roundedRect(left, y, width, 26, 4).fillColor(COLOR.primary).fill();
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#FFFFFF");
    doc.text("DESCRIPTION", left + 12, y + 9, { width: width * 0.48, characterSpacing: 0.6, lineBreak: false });
    doc.text("QTY", colQty, y + 9, { width: width * 0.12, align: "right", characterSpacing: 0.6, lineBreak: false });
    doc.text("UNIT PRICE", colPrice, y + 9, { width: width * 0.14, align: "right", characterSpacing: 0.6, lineBreak: false });
    doc.text("AMOUNT", colAmt, y + 9, { width: width * 0.18 - 12, align: "right", characterSpacing: 0.6, lineBreak: false });

    const rowY = y + 38;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLOR.text)
      .text("Doravo examination credits", left + 12, rowY, { width: width * 0.48 });
    doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted)
      .text("One credit funds one student for one complete Main Examination.", left + 12, doc.y + 2, { width: width * 0.46 });
    const rowEnd = doc.y;
    doc.font("Helvetica").fontSize(10.5).fillColor(COLOR.text);
    doc.text(String(invoice.credit_quantity), colQty, rowY, { width: width * 0.12, align: "right", lineBreak: false });
    doc.text(fmt(invoice.unit_price), colPrice, rowY, { width: width * 0.14, align: "right", lineBreak: false });
    doc.font("Helvetica-Bold").text(fmt(invoice.subtotal), colAmt, rowY, { width: width * 0.18 - 12, align: "right", lineBreak: false });

    y = rowEnd + 12;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(COLOR.line).stroke();
    y += 14;

    // totals
    const totalsLeft = left + width * 0.55;
    const totalsW = right - totalsLeft;
    const totalLine = (k, v) => {
      doc.font("Helvetica").fontSize(10).fillColor(COLOR.muted).text(k, totalsLeft + 12, y, { width: totalsW * 0.5, lineBreak: false });
      doc.font("Helvetica-Bold").fillColor(COLOR.text).text(v, totalsLeft, y, { width: totalsW - 12, align: "right", lineBreak: false });
      y += 18;
    };
    totalLine("Subtotal", fmtMoney(cur, invoice.subtotal));
    if (Number(invoice.tax_rate) > 0) totalLine(`Tax (${Number(invoice.tax_rate)}%)`, fmtMoney(cur, invoice.tax_amount));
    y += 4;
    doc.roundedRect(totalsLeft, y, totalsW, 34, 5).fillColor(COLOR.primary).fill();
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#FFFFFF")
      .text(invoice.status === "paid" ? "TOTAL PAID" : "TOTAL DUE", totalsLeft + 12, y + 12, { width: totalsW * 0.4, characterSpacing: 0.6, lineBreak: false });
    doc.fontSize(14).text(fmtMoney(cur, invoice.total_amount), totalsLeft, y + 10, { width: totalsW - 12, align: "right", lineBreak: false });
    y += 34;

    if (invoice.status === "paid") {
      y += 8;
      doc.font("Helvetica").fontSize(9).fillColor(COLOR.paid).text(
        `Paid on ${fmtDate(invoice.paid_at)}${paidWith?.payment_reference ? `  |  ref ${paidWith.payment_reference}` : ""}${paidWith?.method ? ` (${paidWith.method})` : ""}`,
        totalsLeft, y, { width: totalsW, align: "right" });
      y = doc.y;
    }

    y += 26;
    if (invoice.notes) y = noteBlock(doc, left, y, width, "Notes", invoice.notes);
    if (invoice.status === "void" && invoice.void_reason) {
      y = noteBlock(doc, left, y, width, "Voided", `${fmtDate(invoice.voided_at)} - ${invoice.void_reason}`);
    }
    if (invoice.status === "issued") {
      const instructions = issuer.paymentInstructions;
      const body = `${instructions ? `${instructions}\n\n` : ""}Please quote ${invoice.invoice_number} as the payment reference. A receipt is issued once your payment is confirmed.`;
      doc.font("Helvetica").fontSize(9.5);
      const h = doc.heightOfString(body, { width: width - 32 });
      doc.roundedRect(left, y, width, h + 40, 6).fillColor(COLOR.primaryTint).fill();
      label(doc, "How to pay", left + 16, y + 12, width - 32);
      doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.body).text(body, left + 16, y + 26, { width: width - 32 });
    }

    drawFooter(doc, issuer, invoice.invoice_number);
  });
}

/* ---------------------------------------------------------------- RECEIPT */

/**
 * @param {object} receipt  finance_receipts row joined with invoice_number
 * @param {object} [opts]   { issuer, invoice: finance_invoices row | null }
 */
function buildReceiptPdf(receipt, { issuer = getIssuerProfile(), invoice = null } = {}) {
  return toBuffer(`Receipt ${receipt.receipt_number || ""}`.trim(), (doc) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const cur = receipt.currency;

    drawWatermark(doc, "PAID", COLOR.paid);

    let y = drawHeader(doc, issuer, {
      title: "RECEIPT",
      badge: { text: "PAYMENT RECEIVED", color: COLOR.paid, tint: COLOR.paidTint },
      meta: [
        ["Receipt no.", receipt.receipt_number],
        ["Date", fmtDate(receipt.issued_at)],
        ["Payment ref", receipt.payment_reference],
      ],
    });

    y = drawParties(doc, y, [
      { label: "Received from", name: receipt.received_from, lines: [invoice?.bill_to_email, invoice?.bill_to_phone] },
      { label: "Received by", name: issuer.name, lines: [`${issuer.product} Finance`] },
    ]);

    // amount panel
    doc.roundedRect(left, y, width, 84, 8).fillColor(COLOR.paidTint).fill();
    doc.rect(left, y + 12, 4, 60).fillColor(COLOR.paid).fill();
    label(doc, "Amount received", left + 24, y + 16, 300);
    doc.font("Helvetica-Bold").fontSize(30).fillColor(COLOR.paid)
      .text(fmtMoney(cur, receipt.amount), left + 24, y + 34, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.paid)
      .text("VERIFIED", right - 120, y + 20, { width: 100, align: "right", characterSpacing: 1, lineBreak: false });
    doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted)
      .text("by Doravo Finance", right - 140, y + 33, { width: 120, align: "right", lineBreak: false });
    y += 84 + 24;

    // details table (striped rows)
    const rows = [
      ["Payment method", receipt.payment_method || "-"],
      ["Payment reference", receipt.payment_reference],
    ];
    if (receipt.invoice_number) rows.push(["Applied to invoice", receipt.invoice_number]);
    if (invoice) {
      rows.push(["Credits purchased", `${invoice.credit_quantity} @ ${fmtMoney(invoice.currency, invoice.unit_price)}`]);
      rows.push(["Invoice total", fmtMoney(invoice.currency, invoice.total_amount)]);
      if (money2(receipt.amount) > money2(invoice.total_amount)) {
        rows.push(["Overpayment", `${fmtMoney(cur, money2(receipt.amount) - money2(invoice.total_amount))} (carried as credit on account)`]);
      }
    }
    label(doc, "Payment details", left, y, width);
    y += 16;
    rows.forEach(([k, v], i) => {
      if (i % 2 === 0) doc.rect(left, y - 5, width, 24).fillColor(COLOR.tint).fill();
      doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted).text(k, left + 12, y + 1, { width: 150, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR.text).text(String(v ?? "-"), left + 170, y + 1, { width: width - 182, lineBreak: false });
      y += 24;
    });

    y += 18;
    noteBlock(doc, left, y, width, "Please note",
      "This receipt confirms that the payment above was received and verified by Doravo Finance. Credits are added to the institution's wallet separately once issued. Keep this document for your records.");

    drawFooter(doc, issuer, receipt.receipt_number);
  });
}

module.exports = { buildInvoicePdf, buildReceiptPdf, getIssuerProfile, fmt };
