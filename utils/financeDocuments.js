const PDFDocument = require("pdfkit");

/* =========================================================================
   FINANCE DOCUMENTS — invoice & receipt PDFs

   Rendered on demand from the finance_invoices / finance_receipts rows
   (never stored as files), so a document always matches the database and
   survives a Render redeploy with no disk to lose. Built with pdfkit and the
   built-in Helvetica fonts, same as the app's other PDF exports
   (utils/transcriptPdf.js, utils/reportExport.js) — no extra dependency.

   The ISSUER is whoever bills the institution (Doravo, platform
   DoravoCore, by default). Everything about it is overridable via environment variables so
   bank / M-Pesa details never live in code:
     INVOICE_ISSUER_NAME, INVOICE_ISSUER_ADDRESS, INVOICE_ISSUER_EMAIL,
     INVOICE_ISSUER_PHONE, INVOICE_ISSUER_TAX_ID, INVOICE_PAYMENT_INSTRUCTIONS
========================================================================= */

const COLOR = { primary: "#8B1E2D", text: "#0B0F19", muted: "#64748B", line: "#E2E5EA", paid: "#15803D", void: "#B91C1C", tint: "#F8FAFC" };
const MARGIN = 48;

function getIssuerProfile(env = process.env) {
  return {
    name: env.INVOICE_ISSUER_NAME || "Doravo",
    product: "DoravoCore",
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

function fmtDate(d) {
  if (!d) return "-";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function toBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Producer: "Doravo" } });
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

function drawHeader(doc, issuer, title, rightLines) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y;

  doc.font("Helvetica-Bold").fontSize(16).fillColor(COLOR.primary).text(issuer.name, left, top, { width: 280 });
  doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted).text(`${issuer.product} examination platform`, left, doc.y, { width: 280 });
  [issuer.address, issuer.email, issuer.phone, issuer.taxId && `Tax ID: ${issuer.taxId}`]
    .filter(Boolean)
    .forEach((line) => doc.text(line, left, doc.y, { width: 280 }));
  const leftEnd = doc.y;

  doc.font("Helvetica-Bold").fontSize(24).fillColor(COLOR.text).text(title, left, top, { width: right - left, align: "right" });
  // Explicit label / value columns — pdfkit's `continued` text combined with
  // right alignment overprints lines, so each cell is placed by hand.
  const metaLabelX = right - 230;
  const metaLabelW = 80;
  const metaValueX = right - 145;
  const metaValueW = 145;
  let metaY = top + 34;
  rightLines.forEach(([label, value]) => {
    doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted)
      .text(label, metaLabelX, metaY, { width: metaLabelW, align: "left", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLOR.text)
      .text(String(value ?? "-"), metaValueX, metaY, { width: metaValueW, align: "right", lineBreak: false });
    metaY += 15;
  });
  doc.y = metaY;
  doc.y = Math.max(leftEnd, doc.y) + 14;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(COLOR.line).lineWidth(1).stroke();
  doc.y += 16;
}

function drawStamp(doc, text, color) {
  doc.save();
  const x = doc.page.width - doc.page.margins.right - 150;
  const y = 150;
  doc.rotate(-12, { origin: [x + 75, y + 20] });
  doc.roundedRect(x, y, 150, 40, 6).lineWidth(2.5).strokeColor(color).stroke();
  doc.font("Helvetica-Bold").fontSize(24).fillColor(color).text(text, x, y + 8, { width: 150, align: "center" });
  doc.restore();
  doc.fillColor(COLOR.text);
}

function drawParty(doc, label, name, lines) {
  const left = doc.page.margins.left;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLOR.muted).text(label.toUpperCase(), left, doc.y);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLOR.text).text(name || "-", left, doc.y + 2, { width: 300 });
  doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted);
  lines.filter(Boolean).forEach((l) => doc.text(l, left, doc.y, { width: 300 }));
  doc.y += 14;
}

function drawFooter(doc, issuer, line) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const y = doc.page.height - doc.page.margins.bottom - 28;
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor(COLOR.line).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(COLOR.muted)
    .text(`${line}  -  ${issuer.name}, powered by ${issuer.product}`, left, y + 6, { width, align: "center", lineBreak: false });
}

/* ---------------------------------------------------------------- INVOICE */

/**
 * @param {object} invoice  finance_invoices row (+ optional paid payment fields)
 * @param {object} [opts]   { issuer, paidWith: { payment_reference, method } | null }
 */
function buildInvoicePdf(invoice, { issuer = getIssuerProfile(), paidWith = null } = {}) {
  return toBuffer((doc) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const cur = invoice.currency;

    drawHeader(doc, issuer, "INVOICE", [
      ["Invoice no.", invoice.invoice_number],
      ["Issued", fmtDate(invoice.issue_date)],
      ["Due", invoice.due_date ? fmtDate(invoice.due_date) : "On receipt"],
      ["Status", String(invoice.status).toUpperCase()],
    ]);

    drawParty(doc, "Bill to", invoice.bill_to_name, [invoice.bill_to_email, invoice.bill_to_phone]);

    // line-item table
    const colQty = left + width * 0.55;
    const colPrice = left + width * 0.7;
    const colAmt = left + width * 0.85;
    const tableTop = doc.y + 4;
    doc.rect(left, tableTop, width, 22).fillColor(COLOR.tint).fill();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.muted);
    doc.text("DESCRIPTION", left + 8, tableTop + 7, { width: width * 0.5, lineBreak: false });
    doc.text("QTY", colQty, tableTop + 7, { width: width * 0.13, align: "right", lineBreak: false });
    doc.text("UNIT PRICE", colPrice, tableTop + 7, { width: width * 0.13, align: "right", lineBreak: false });
    doc.text("AMOUNT", colAmt, tableTop + 7, { width: width * 0.15 - 8, align: "right", lineBreak: false });

    const rowY = tableTop + 30;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLOR.text)
      .text("Doravo examination credits", left + 8, rowY, { width: width * 0.5 });
    doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted)
      .text("One credit funds one student for one complete Main Examination.", left + 8, doc.y + 1, { width: width * 0.5 });
    const rowEnd = doc.y;
    doc.font("Helvetica").fontSize(10.5).fillColor(COLOR.text);
    doc.text(String(invoice.credit_quantity), colQty, rowY, { width: width * 0.13, align: "right", lineBreak: false });
    doc.text(fmt(invoice.unit_price), colPrice, rowY, { width: width * 0.13, align: "right", lineBreak: false });
    doc.text(fmt(invoice.subtotal), colAmt, rowY, { width: width * 0.15 - 8, align: "right", lineBreak: false });

    doc.y = rowEnd + 10;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(COLOR.line).lineWidth(1).stroke();
    doc.y += 12;

    // totals
    const totalsLeft = left + width * 0.55;
    const totalsW = right - totalsLeft;
    const line = (label, value, bold = false, big = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(big ? 12 : 10).fillColor(bold ? COLOR.text : COLOR.muted)
        .text(label, totalsLeft, y, { width: totalsW * 0.5, lineBreak: false });
      doc.fillColor(COLOR.text).text(value, totalsLeft + totalsW * 0.4, y, { width: totalsW * 0.6, align: "right", lineBreak: false });
      doc.y = y + (big ? 20 : 16);
    };
    line("Subtotal", fmtMoney(cur, invoice.subtotal));
    if (Number(invoice.tax_rate) > 0) line(`Tax (${Number(invoice.tax_rate)}%)`, fmtMoney(cur, invoice.tax_amount));
    doc.moveTo(totalsLeft, doc.y).lineTo(right, doc.y).strokeColor(COLOR.line).stroke();
    doc.y += 6;
    line("Total due", fmtMoney(cur, invoice.total_amount), true, true);

    if (invoice.status === "paid") {
      doc.y += 4;
      doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.paid)
        .text(`Paid on ${fmtDate(invoice.paid_at)}${paidWith?.payment_reference ? ` - ref ${paidWith.payment_reference}` : ""}${paidWith?.method ? ` (${paidWith.method})` : ""}`,
          totalsLeft, doc.y, { width: totalsW, align: "right" });
    }

    doc.y += 24;
    if (invoice.notes) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.muted).text("NOTES", left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(COLOR.text).text(invoice.notes, left, doc.y + 2, { width });
      doc.y += 12;
    }
    if (invoice.status === "void" && invoice.void_reason) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.void).text("VOIDED", left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(COLOR.text).text(`${fmtDate(invoice.voided_at)} - ${invoice.void_reason}`, left, doc.y + 2, { width });
      doc.y += 12;
    }
    if (issuer.paymentInstructions && invoice.status === "issued") {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.muted).text("HOW TO PAY", left, doc.y);
      doc.font("Helvetica").fontSize(10).fillColor(COLOR.text).text(issuer.paymentInstructions, left, doc.y + 2, { width });
      doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted)
        .text(`Please quote ${invoice.invoice_number} as the payment reference. A receipt is issued once your payment is confirmed.`, left, doc.y + 6, { width });
    }

    if (invoice.status === "paid") drawStamp(doc, "PAID", COLOR.paid);
    if (invoice.status === "void") drawStamp(doc, "VOID", COLOR.void);
    drawFooter(doc, issuer, invoice.invoice_number);
  });
}

/* ---------------------------------------------------------------- RECEIPT */

/**
 * @param {object} receipt  finance_receipts row joined with invoice_number
 * @param {object} [opts]   { issuer, invoice: finance_invoices row | null }
 */
function buildReceiptPdf(receipt, { issuer = getIssuerProfile(), invoice = null } = {}) {
  return toBuffer((doc) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const cur = receipt.currency;

    drawHeader(doc, issuer, "RECEIPT", [
      ["Receipt no.", receipt.receipt_number],
      ["Date", fmtDate(receipt.issued_at)],
      ["Payment ref", receipt.payment_reference],
    ]);

    drawParty(doc, "Received from", receipt.received_from, []);

    // amount panel
    const panelTop = doc.y + 4;
    doc.roundedRect(left, panelTop, width, 74, 8).fillColor(COLOR.tint).fill();
    doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted).text("AMOUNT RECEIVED", left + 18, panelTop + 14, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(26).fillColor(COLOR.paid).text(fmtMoney(cur, receipt.amount), left + 18, panelTop + 30, { lineBreak: false });
    doc.y = panelTop + 74 + 18;

    const row = (label, value) => {
      const y = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor(COLOR.muted).text(label, left, y, { width: 140, lineBreak: false });
      doc.font("Helvetica-Bold").fillColor(COLOR.text).text(String(value ?? "-"), left + 150, y, { width: width - 150, lineBreak: false });
      doc.y = y + 18;
    };
    row("Payment method", receipt.payment_method || "-");
    row("Payment reference", receipt.payment_reference);
    if (receipt.invoice_number) row("Applied to invoice", receipt.invoice_number);
    if (invoice) {
      row("Credits purchased", `${invoice.credit_quantity} @ ${fmtMoney(invoice.currency, invoice.unit_price)}`);
      row("Invoice total", fmtMoney(invoice.currency, invoice.total_amount));
      if (money2(receipt.amount) > money2(invoice.total_amount)) {
        row("Balance", `${fmtMoney(cur, money2(receipt.amount) - money2(invoice.total_amount))} overpaid`);
      }
    }

    doc.y += 14;
    doc.font("Helvetica").fontSize(10).fillColor(COLOR.muted)
      .text("This receipt confirms that the payment above was received and verified by Doravo Finance. Credits are added to the institution's wallet separately once issued.", left, doc.y, { width });

    drawStamp(doc, "PAID", COLOR.paid);
    drawFooter(doc, issuer, receipt.receipt_number);
  });
}

const money2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { buildInvoicePdf, buildReceiptPdf, getIssuerProfile, fmt };
