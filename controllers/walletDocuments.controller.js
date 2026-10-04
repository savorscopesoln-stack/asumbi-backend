const sql = require("mssql");
const invoicing = require("../services/invoicing.service");
const { buildInvoicePdf, buildReceiptPdf, getIssuerProfile } = require("../utils/financeDocuments");

/* =========================================================================
   INSTITUTION WALLET — INVOICES & RECEIPTS (tenant-facing, read-only)

   The institution admin sees, and can download, the invoices Doravo Finance
   raised for THEIR institution and the receipts issued when payments were
   confirmed. Same data and same PDFs as the Finance dashboard
   (financeInvoice.controller.js), but everything here runs on req.pool —
   the logged-in admin's own tenant — so there is no way to name another
   institution. Nothing here creates, changes or voids a document; that stays
   Finance-only (routes/finance.js).
========================================================================= */

function sendPdf(res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.setHeader("Content-Length", buffer.length);
  res.send(buffer);
}

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const listMyInvoices = async (req, res) => {
  try {
    res.json({ success: true, invoices: await invoicing.listInvoices(req.pool) });
  } catch (err) {
    console.error("WALLET INVOICES ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading invoices" });
  }
};

const listMyReceipts = async (req, res) => {
  try {
    res.json({ success: true, receipts: await invoicing.listReceipts(req.pool) });
  } catch (err) {
    console.error("WALLET RECEIPTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading receipts" });
  }
};

const downloadMyInvoicePdf = async (req, res) => {
  try {
    const invoiceId = parseId(req.params.invoiceId);
    if (!invoiceId) return res.status(400).json({ success: false, message: "Invalid invoice id" });
    const invoice = await invoicing.getInvoice(req.pool, invoiceId);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });

    let paidWith = null;
    if (invoice.institution_payment_id) {
      const p = await req.pool.request()
        .input("id", sql.Int, invoice.institution_payment_id)
        .query(`SELECT payment_reference, method FROM institution_payments WHERE id = @id`);
      paidWith = p.recordset[0] || null;
    }
    const pdf = await buildInvoicePdf(invoice, { issuer: getIssuerProfile(), paidWith });
    sendPdf(res, pdf, `${invoice.invoice_number || `invoice-${invoice.id}`}.pdf`);
  } catch (err) {
    console.error("WALLET INVOICE PDF ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating invoice PDF" });
  }
};

const downloadMyReceiptPdf = async (req, res) => {
  try {
    const receiptId = parseId(req.params.receiptId);
    if (!receiptId) return res.status(400).json({ success: false, message: "Invalid receipt id" });
    const receipt = await invoicing.getReceipt(req.pool, receiptId);
    if (!receipt) return res.status(404).json({ success: false, message: "Receipt not found" });
    const invoice = receipt.invoice_id ? await invoicing.getInvoice(req.pool, receipt.invoice_id) : null;
    const pdf = await buildReceiptPdf(receipt, { issuer: getIssuerProfile(), invoice });
    sendPdf(res, pdf, `${receipt.receipt_number || `receipt-${receipt.id}`}.pdf`);
  } catch (err) {
    console.error("WALLET RECEIPT PDF ERROR:", err);
    res.status(500).json({ success: false, message: "Server error generating receipt PDF" });
  }
};

module.exports = { listMyInvoices, listMyReceipts, downloadMyInvoicePdf, downloadMyReceiptPdf };
