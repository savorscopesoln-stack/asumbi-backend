const sql = require("mssql");
const { generateUniqueReference } = require("../utils/creditReference");
const { logFinanceAudit } = require("../utils/financeAuditLog");

/* =========================================================================
   FINANCE INVOICING SERVICE

   Invoices and receipts for institutional credit purchases. Sits next to
   walletLedger.service.js and follows the same conventions: every
   multi-statement change runs inside one `new sql.Transaction(pool)` so it
   either fully happens or not at all, and audit-log rows are written after
   commit as best-effort (a logging hiccup must never roll back real money
   state).

   FLOW
     1. createInvoice   — Finance bills an institution for N credits at a
                          unit price. Status 'issued'. Touches no wallet.
     2. recordPayment   — Finance confirms a payment (the existing "verify
                          payment" step). In ONE transaction it inserts the
                          institution_payments row, inserts the receipt, and
                          — if the payment settles an invoice — marks that
                          invoice 'paid'. Receipt generation therefore can
                          never happen without a confirmed payment, and a
                          confirmed payment can never end up without one.
     3. voidInvoice     — cancel an UNPAID invoice (reason required).

   Credits are deliberately NOT issued automatically when an invoice is
   paid: issuance stays its own explicit, confirmed Finance action (see
   finance.controller.js issueCredits — "require confirmation before
   issuance"). A paid invoice's payment can be selected there as usual.

   Documents are stored as data (rows), not files; the PDFs are rendered on
   demand from those rows (utils/financeDocuments.js), so they are always
   reproducible and there is nothing on disk to lose on a Render redeploy.
========================================================================= */

class InvoiceError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "InvoiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDupKey = (err) => err && (err.number === 2601 || err.number === 2627);

function formatDocNumber(prefix, id, date = new Date()) {
  return `${prefix}-${date.getFullYear()}-${String(id).padStart(5, "0")}`;
}

async function safeRollback(transaction) {
  try { await transaction.rollback(); } catch (_) { /* already rolled back / never begun */ }
}

/* ---------------- reads ---------------- */

const INVOICE_COLUMNS = `
  id, invoice_number, credit_quantity, unit_price, currency, subtotal, tax_rate, tax_amount,
  total_amount, status, issue_date, due_date, notes, bill_to_name, bill_to_email, bill_to_phone,
  institution_payment_id, paid_at, voided_at, void_reason, issued_by
`;

async function getInvoice(pool, invoiceId) {
  const result = await pool.request()
    .input("id", sql.Int, invoiceId)
    .query(`SELECT ${INVOICE_COLUMNS} FROM finance_invoices WHERE id = @id`);
  return result.recordset[0] || null;
}

async function listInvoices(pool) {
  const result = await pool.request().query(`
    SELECT ${INVOICE_COLUMNS}, (SELECT TOP 1 id FROM finance_receipts r WHERE r.invoice_id = finance_invoices.id) AS receipt_id
    FROM finance_invoices ORDER BY id DESC
  `);
  return result.recordset;
}

async function getReceipt(pool, receiptId) {
  const result = await pool.request()
    .input("id", sql.Int, receiptId)
    .query(`
      SELECT r.id, r.receipt_number, r.institution_payment_id, r.invoice_id, r.amount, r.currency,
             r.payment_reference, r.payment_method, r.received_from, r.issued_by, r.issued_at,
             i.invoice_number
      FROM finance_receipts r
      LEFT JOIN finance_invoices i ON i.id = r.invoice_id
      WHERE r.id = @id
    `);
  return result.recordset[0] || null;
}

async function listReceipts(pool) {
  const result = await pool.request().query(`
    SELECT r.id, r.receipt_number, r.institution_payment_id, r.invoice_id, r.amount, r.currency,
           r.payment_reference, r.payment_method, r.received_from, r.issued_at,
           i.invoice_number
    FROM finance_receipts r
    LEFT JOIN finance_invoices i ON i.id = r.invoice_id
    ORDER BY r.id DESC
  `);
  return result.recordset;
}

/* ---------------- create invoice ---------------- */

/**
 * @param {object} args
 * @param {number} args.creditQuantity  positive integer
 * @param {number} args.unitPrice       > 0
 * @param {string} [args.currency]      3-letter code, default KES
 * @param {number} [args.taxRate]       percent, 0-100, default 0
 * @param {string|null} [args.dueDate]  YYYY-MM-DD
 * @param {object} [args.billTo]        { name, email, phone } snapshot of the institution
 */
async function createInvoice(pool, {
  creditQuantity, unitPrice, currency = "KES", taxRate = 0, dueDate = null,
  notes = null, billTo = {}, issuedBy = null, actorRole = null,
}) {
  const quantity = Number(creditQuantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvoiceError("Credit quantity must be a positive whole number", "INVALID_QUANTITY");
  }
  const price = Number(unitPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new InvoiceError("Unit price must be greater than zero", "INVALID_UNIT_PRICE");
  }
  const rate = Number(taxRate ?? 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new InvoiceError("Tax rate must be between 0 and 100", "INVALID_TAX_RATE");
  }
  const cur = String(currency || "KES").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) {
    throw new InvoiceError("Currency must be a 3-letter code such as KES", "INVALID_CURRENCY");
  }
  let due = null;
  if (dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate)) || Number.isNaN(Date.parse(dueDate))) {
      throw new InvoiceError("Due date must be a valid date (YYYY-MM-DD)", "INVALID_DUE_DATE");
    }
    due = String(dueDate);
  }

  const subtotal = money(quantity * price);
  const taxAmount = money((subtotal * rate) / 100);
  const total = money(subtotal + taxAmount);

  const transaction = new sql.Transaction(pool);
  let invoiceId;
  try {
    await transaction.begin();
    const inserted = await new sql.Request(transaction)
      .input("quantity", sql.Int, quantity)
      .input("unitPrice", sql.Decimal(18, 2), money(price))
      .input("currency", sql.NVarChar(3), cur)
      .input("subtotal", sql.Decimal(18, 2), subtotal)
      .input("taxRate", sql.Decimal(5, 2), rate)
      .input("taxAmount", sql.Decimal(18, 2), taxAmount)
      .input("total", sql.Decimal(18, 2), total)
      .input("dueDate", sql.Date, due)
      .input("notes", sql.NVarChar(500), notes ? String(notes).slice(0, 500) : null)
      .input("billName", sql.NVarChar(200), billTo.name || null)
      .input("billEmail", sql.NVarChar(200), billTo.email || null)
      .input("billPhone", sql.NVarChar(50), billTo.phone || null)
      .input("issuedBy", sql.Int, issuedBy)
      .query(`
        INSERT INTO finance_invoices
          (credit_quantity, unit_price, currency, subtotal, tax_rate, tax_amount, total_amount,
           status, due_date, notes, bill_to_name, bill_to_email, bill_to_phone, issued_by)
        OUTPUT INSERTED.id, INSERTED.issue_date
        VALUES
          (@quantity, @unitPrice, @currency, @subtotal, @taxRate, @taxAmount, @total,
           'issued', @dueDate, @notes, @billName, @billEmail, @billPhone, @issuedBy)
      `);
    invoiceId = inserted.recordset[0].id;
    const invoiceNumber = formatDocNumber("INV", invoiceId, inserted.recordset[0].issue_date ? new Date(inserted.recordset[0].issue_date) : new Date());
    await new sql.Request(transaction)
      .input("id", sql.Int, invoiceId)
      .input("number", sql.NVarChar(40), invoiceNumber)
      .query(`UPDATE finance_invoices SET invoice_number = @number WHERE id = @id`);
    await transaction.commit();
  } catch (err) {
    await safeRollback(transaction);
    throw err;
  }

  const invoice = await getInvoice(pool, invoiceId);
  await logFinanceAudit(pool, {
    action: "invoice_created",
    actorId: issuedBy, actorRole,
    details: {
      invoice_id: invoiceId, invoice_number: invoice?.invoice_number,
      credit_quantity: quantity, unit_price: money(price), total_amount: total, currency: cur,
    },
  });
  return invoice;
}

/* ---------------- void invoice ---------------- */

async function voidInvoice(pool, { invoiceId, reason, actorId = null, actorRole = null }) {
  if (!reason || !String(reason).trim()) {
    throw new InvoiceError("A reason is required to void an invoice", "REASON_REQUIRED");
  }
  const transaction = new sql.Transaction(pool);
  let invoiceNumber;
  try {
    await transaction.begin();
    const found = await new sql.Request(transaction)
      .input("id", sql.Int, invoiceId)
      .query(`SELECT id, invoice_number, status FROM finance_invoices WITH (UPDLOCK) WHERE id = @id`);
    const invoice = found.recordset[0];
    if (!invoice) throw new InvoiceError("Invoice not found", "NOT_FOUND", 404);
    if (invoice.status === "void") throw new InvoiceError("This invoice is already void", "ALREADY_VOID", 409);
    if (invoice.status === "paid") {
      throw new InvoiceError("A paid invoice cannot be voided — reverse the issued credits instead", "ALREADY_PAID", 409);
    }
    invoiceNumber = invoice.invoice_number;
    await new sql.Request(transaction)
      .input("id", sql.Int, invoiceId)
      .input("reason", sql.NVarChar(500), String(reason).trim().slice(0, 500))
      .query(`UPDATE finance_invoices SET status = 'void', voided_at = GETDATE(), void_reason = @reason WHERE id = @id`);
    await transaction.commit();
  } catch (err) {
    await safeRollback(transaction);
    throw err;
  }
  await logFinanceAudit(pool, {
    action: "invoice_voided",
    actorId, actorRole,
    details: { invoice_id: invoiceId, invoice_number: invoiceNumber, reason: String(reason).trim() },
  });
  return getInvoice(pool, invoiceId);
}

/* ---------------- receipts ---------------- */

/** Insert a receipt row + assign its number, inside an already-open transaction. */
async function insertReceiptRow(transaction, {
  paymentId, invoiceId = null, amount, currency, paymentReference, paymentMethod = null,
  receivedFrom = null, issuedBy = null,
}) {
  const inserted = await new sql.Request(transaction)
    .input("paymentId", sql.Int, paymentId)
    .input("invoiceId", sql.Int, invoiceId)
    .input("amount", sql.Decimal(18, 2), money(amount))
    .input("currency", sql.NVarChar(3), currency)
    .input("reference", sql.NVarChar(80), paymentReference)
    .input("method", sql.NVarChar(50), paymentMethod)
    .input("receivedFrom", sql.NVarChar(200), receivedFrom)
    .input("issuedBy", sql.Int, issuedBy)
    .query(`
      INSERT INTO finance_receipts
        (institution_payment_id, invoice_id, amount, currency, payment_reference, payment_method, received_from, issued_by)
      OUTPUT INSERTED.id, INSERTED.issued_at
      VALUES
        (@paymentId, @invoiceId, @amount, @currency, @reference, @method, @receivedFrom, @issuedBy)
    `);
  const receiptId = inserted.recordset[0].id;
  const receiptNumber = formatDocNumber("RCT", receiptId, inserted.recordset[0].issued_at ? new Date(inserted.recordset[0].issued_at) : new Date());
  await new sql.Request(transaction)
    .input("id", sql.Int, receiptId)
    .input("number", sql.NVarChar(40), receiptNumber)
    .query(`UPDATE finance_receipts SET receipt_number = @number WHERE id = @id`);
  return { id: receiptId, receipt_number: receiptNumber };
}

/* ---------------- confirm payment (+ receipt, + settle invoice) ---------------- */

/**
 * Records a manually-verified payment and, atomically, its receipt and (when
 * `invoiceId` is given) marks the invoice paid.
 *
 * With an invoice: amount defaults to the invoice total, currency defaults to
 * the invoice currency, a different currency is refused, and an amount below
 * the invoice total is refused (overpayment is accepted and shown as-is on the
 * receipt). Only an 'issued' invoice can be settled — never a paid or void one.
 */
async function recordPayment(pool, {
  amount = null, currency = null, method = null, paymentReference = null, notes = null,
  invoiceId = null, institutionName = null, verifiedBy = null, actorRole = null, tenantKey = null,
}) {
  // Reference generation uses the pool, so do it before the transaction begins
  // (same as the pre-invoicing verifyPayment did).
  const reference = (paymentReference && String(paymentReference).trim())
    || await generateUniqueReference(pool, "institution_payments", "payment_reference", "PAY");

  const transaction = new sql.Transaction(pool);
  let payment, receipt, invoiceAfter = null, resolvedAmount, resolvedCurrency, invoiceNumber = null;
  try {
    await transaction.begin();

    let invoice = null;
    if (invoiceId) {
      const found = await new sql.Request(transaction)
        .input("id", sql.Int, invoiceId)
        .query(`SELECT id, invoice_number, total_amount, currency, status FROM finance_invoices WITH (UPDLOCK, HOLDLOCK) WHERE id = @id`);
      invoice = found.recordset[0];
      if (!invoice) throw new InvoiceError("Invoice not found", "NOT_FOUND", 404);
      if (invoice.status === "paid") throw new InvoiceError(`Invoice ${invoice.invoice_number} has already been paid`, "ALREADY_PAID", 409);
      if (invoice.status === "void") throw new InvoiceError(`Invoice ${invoice.invoice_number} is void and cannot be paid`, "INVOICE_VOID", 409);
      invoiceNumber = invoice.invoice_number;
    }

    resolvedCurrency = String(currency || (invoice ? invoice.currency : "KES")).trim().toUpperCase();
    resolvedAmount = (amount === null || amount === undefined || amount === "")
      ? (invoice ? Number(invoice.total_amount) : NaN)
      : Number(amount);
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      throw new InvoiceError("A positive payment amount is required", "INVALID_AMOUNT");
    }
    resolvedAmount = money(resolvedAmount);
    if (invoice) {
      if (resolvedCurrency !== invoice.currency) {
        throw new InvoiceError(`Payment currency ${resolvedCurrency} does not match the invoice currency ${invoice.currency}`, "CURRENCY_MISMATCH");
      }
      if (resolvedAmount < money(invoice.total_amount)) {
        throw new InvoiceError(
          `Payment of ${resolvedCurrency} ${resolvedAmount.toFixed(2)} is less than the invoice total of ${invoice.currency} ${money(invoice.total_amount).toFixed(2)}`,
          "UNDERPAID"
        );
      }
    }

    let paymentId;
    try {
      const inserted = await new sql.Request(transaction)
        .input("paymentReference", sql.NVarChar(80), reference)
        .input("amount", sql.Decimal(18, 2), resolvedAmount)
        .input("currency", sql.NVarChar(3), resolvedCurrency)
        .input("method", sql.NVarChar(50), method)
        .input("notes", sql.NVarChar(500), notes)
        .input("verifiedBy", sql.Int, verifiedBy)
        .query(`
          INSERT INTO institution_payments (payment_reference, amount, currency, method, notes, verified_by)
          OUTPUT INSERTED.id
          VALUES (@paymentReference, @amount, @currency, @method, @notes, @verifiedBy)
        `);
      paymentId = inserted.recordset[0].id;
    } catch (err) {
      if (isDupKey(err)) {
        throw new InvoiceError(`Payment reference "${reference}" has already been verified`, "DUPLICATE_PAYMENT", 409);
      }
      throw err;
    }
    payment = { id: paymentId, payment_reference: reference, amount: resolvedAmount, currency: resolvedCurrency };

    receipt = await insertReceiptRow(transaction, {
      paymentId, invoiceId: invoice ? invoice.id : null, amount: resolvedAmount, currency: resolvedCurrency,
      paymentReference: reference, paymentMethod: method, receivedFrom: institutionName, issuedBy: verifiedBy,
    });

    if (invoice) {
      await new sql.Request(transaction)
        .input("id", sql.Int, invoice.id)
        .input("paymentId", sql.Int, paymentId)
        .query(`UPDATE finance_invoices SET status = 'paid', institution_payment_id = @paymentId, paid_at = GETDATE() WHERE id = @id`);
    }

    await transaction.commit();
  } catch (err) {
    await safeRollback(transaction);
    throw err;
  }

  if (invoiceId) invoiceAfter = await getInvoice(pool, invoiceId);

  await logFinanceAudit(pool, {
    action: "payment_verified",
    institutionPaymentId: payment.id,
    actorId: verifiedBy, actorRole,
    details: { tenantKey, payment_reference: reference, amount: resolvedAmount, currency: resolvedCurrency, invoice_number: invoiceNumber },
  });
  if (invoiceAfter) {
    await logFinanceAudit(pool, {
      action: "invoice_paid",
      institutionPaymentId: payment.id,
      actorId: verifiedBy, actorRole,
      details: { invoice_id: invoiceAfter.id, invoice_number: invoiceAfter.invoice_number, payment_reference: reference },
    });
  }
  await logFinanceAudit(pool, {
    action: "receipt_issued",
    institutionPaymentId: payment.id,
    actorId: verifiedBy, actorRole,
    details: { receipt_id: receipt.id, receipt_number: receipt.receipt_number, payment_reference: reference },
  });

  return { payment, receipt, invoice: invoiceAfter };
}

/**
 * Get — or lazily create — the receipt for an already-verified payment.
 * Payments verified before invoicing existed have no receipt row; this gives
 * them one on first request. Idempotent: the unique index on
 * institution_payment_id means concurrent callers converge on one receipt.
 */
async function ensureReceiptForPayment(pool, { paymentId, institutionName = null, issuedBy = null, actorRole = null }) {
  const existing = await pool.request()
    .input("paymentId", sql.Int, paymentId)
    .query(`SELECT id FROM finance_receipts WHERE institution_payment_id = @paymentId`);
  if (existing.recordset[0]) return getReceipt(pool, existing.recordset[0].id);

  const paymentRow = await pool.request()
    .input("paymentId", sql.Int, paymentId)
    .query(`
      SELECT p.id, p.payment_reference, p.amount, p.currency, p.method,
             (SELECT TOP 1 id FROM finance_invoices WHERE institution_payment_id = p.id) AS invoice_id
      FROM institution_payments p WHERE p.id = @paymentId
    `);
  const payment = paymentRow.recordset[0];
  if (!payment) throw new InvoiceError("Payment not found", "NOT_FOUND", 404);

  const transaction = new sql.Transaction(pool);
  let created;
  try {
    await transaction.begin();
    created = await insertReceiptRow(transaction, {
      paymentId: payment.id, invoiceId: payment.invoice_id || null, amount: payment.amount,
      currency: payment.currency, paymentReference: payment.payment_reference,
      paymentMethod: payment.method, receivedFrom: institutionName, issuedBy,
    });
    await transaction.commit();
  } catch (err) {
    await safeRollback(transaction);
    if (isDupKey(err)) {
      // Someone else generated it a moment ago — return theirs.
      const again = await pool.request()
        .input("paymentId", sql.Int, paymentId)
        .query(`SELECT id FROM finance_receipts WHERE institution_payment_id = @paymentId`);
      if (again.recordset[0]) return getReceipt(pool, again.recordset[0].id);
    }
    throw err;
  }
  await logFinanceAudit(pool, {
    action: "receipt_issued",
    institutionPaymentId: payment.id,
    actorId: issuedBy, actorRole,
    details: { receipt_id: created.id, receipt_number: created.receipt_number, payment_reference: payment.payment_reference, backfilled: true },
  });
  return getReceipt(pool, created.id);
}

module.exports = {
  InvoiceError,
  createInvoice,
  getInvoice,
  listInvoices,
  voidInvoice,
  recordPayment,
  getReceipt,
  listReceipts,
  ensureReceiptForPayment,
  formatDocNumber,
};
