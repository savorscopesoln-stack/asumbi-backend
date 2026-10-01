const sql = require("mssql");
const { getPool } = require("../config/db");
const { assertValidTenant, loadInstitutionProfile } = require("./finance.controller");
const invoicing = require("../services/invoicing.service");
const { buildInvoicePdf, buildReceiptPdf, getIssuerProfile } = require("../utils/financeDocuments");

/* =========================================================================
   FINANCE INVOICE & RECEIPT CONTROLLER

   Same shape as finance.controller.js: every handler takes a :tenantKey,
   validates it against the configured tenant list and opens THAT tenant's
   pool directly (Finance is the one role that acts across institutions —
   see the header comment in finance.controller.js). All routes are mounted
   behind protect + financeOnly in routes/finance.js.

   PDFs are sent as attachments with a Content-Disposition filename; the
   frontend reads that header (it is already in server.js's CORS
   exposedHeaders) and triggers the browser download automatically.
========================================================================= */

function sendPdf(res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.setHeader("Content-Length", buffer.length);
  res.send(buffer);
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function fail(res, err, fallback) {
  if (err && err.name === "InvoiceError") {
    return res.status(err.statusCode || 400).json({ success: false, code: err.code, message: err.message });
  }
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  console.error(`FINANCE INVOICING ERROR (${fallback}):`, err);
  return res.status(500).json({ success: false, message: fallback });
}

/* ---------------- INVOICES ---------------- */

const createInvoice = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const { creditQuantity, unitPrice, currency, taxRate, dueDate, notes } = req.body || {};
    const pool = await getPool(tenantKey);
    const profile = await loadInstitutionProfile(pool);
    const invoice = await invoicing.createInvoice(pool, {
      creditQuantity, unitPrice, currency, taxRate, dueDate, notes,
      billTo: { name: profile?.schoolName || tenantKey, email: profile?.email, phone: profile?.phone },
      issuedBy: req.user?.id || null,
      actorRole: req.user?.role,
    });
    res.status(201).json({ success: true, invoice, pdfPath: `/finance/institutions/${tenantKey}/invoices/${invoice.id}/pdf` });
  } catch (err) {
    fail(res, err, "Server error creating invoice");
  }
};

const listInvoices = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    res.json({ success: true, invoices: await invoicing.listInvoices(pool) });
  } catch (err) {
    fail(res, err, "Server error loading invoices");
  }
};

const downloadInvoicePdf = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const invoiceId = parseId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ success: false, message: "Invalid invoice id" });
    const pool = await getPool(tenantKey);
    const invoice = await invoicing.getInvoice(pool, invoiceId);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });

    let paidWith = null;
    if (invoice.institution_payment_id) {
      const p = await pool.request()
        .input("id", sql.Int, invoice.institution_payment_id)
        .query(`SELECT payment_reference, method FROM institution_payments WHERE id = @id`);
      paidWith = p.recordset[0] || null;
    }
    const pdf = await buildInvoicePdf(invoice, { issuer: getIssuerProfile(), paidWith });
    sendPdf(res, pdf, `${invoice.invoice_number || `invoice-${invoice.id}`}.pdf`);
  } catch (err) {
    fail(res, err, "Server error generating invoice PDF");
  }
};

const voidInvoice = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const invoiceId = parseId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ success: false, message: "Invalid invoice id" });
    const pool = await getPool(tenantKey);
    const invoice = await invoicing.voidInvoice(pool, {
      invoiceId, reason: req.body?.reason, actorId: req.user?.id || null, actorRole: req.user?.role,
    });
    res.json({ success: true, invoice });
  } catch (err) {
    fail(res, err, "Server error voiding invoice");
  }
};

/* ---------------- RECEIPTS ---------------- */

const listReceipts = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    res.json({ success: true, receipts: await invoicing.listReceipts(pool) });
  } catch (err) {
    fail(res, err, "Server error loading receipts");
  }
};

async function renderReceipt(pool, receipt) {
  const invoice = receipt.invoice_id ? await invoicing.getInvoice(pool, receipt.invoice_id) : null;
  return buildReceiptPdf(receipt, { issuer: getIssuerProfile(), invoice });
}

const downloadReceiptPdf = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const receiptId = parseId(req.params.receiptId);
    if (!receiptId) return res.status(400).json({ success: false, message: "Invalid receipt id" });
    const pool = await getPool(tenantKey);
    const receipt = await invoicing.getReceipt(pool, receiptId);
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt not found" });
    sendPdf(res, await renderReceipt(pool, receipt), `${receipt.receipt_number || `receipt-${receipt.id}`}.pdf`);
  } catch (err) {
    fail(res, err, "Server error generating receipt PDF");
  }
};

/* Receipt by PAYMENT id. Payments verified before invoicing existed have no
   receipt row yet — this creates it on first request (idempotent), so every
   confirmed payment, old or new, can produce a receipt. */
const downloadPaymentReceipt = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const paymentId = parseId(req.params.paymentId);
    if (!paymentId) return res.status(400).json({ success: false, message: "Invalid payment id" });
    const pool = await getPool(tenantKey);
    const profile = await loadInstitutionProfile(pool);
    const receipt = await invoicing.ensureReceiptForPayment(pool, {
      paymentId, institutionName: profile?.schoolName || tenantKey,
      issuedBy: req.user?.id || null, actorRole: req.user?.role,
    });
    sendPdf(res, await renderReceipt(pool, receipt), `${receipt.receipt_number}.pdf`);
  } catch (err) {
    fail(res, err, "Server error generating receipt PDF");
  }
};

module.exports = {
  createInvoice,
  listInvoices,
  downloadInvoicePdf,
  voidInvoice,
  listReceipts,
  downloadReceiptPdf,
  downloadPaymentReceipt,
};
