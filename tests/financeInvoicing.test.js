/* =========================================================================
   FINANCE INVOICING — invoices, payment confirmation, receipts.

   Unlike walletLedger.test.js (whose header explains why mockPool.js cannot
   fake `new sql.Transaction(pool)`), this file CAN exercise the
   transactional paths: it swaps mssql's Transaction/Request classes for a
   small scripted fake for the duration of each test. The fake records every
   statement, its inputs, and whether the transaction committed or rolled
   back, so the tests assert the thing that actually matters for money code:
   "these statements ran, in one transaction, and it committed — or it
   rolled back and nothing was left half-done".

   Same caveat as every other test here: this verifies logic and query
   shape against a script, NOT real SQL Server behaviour (HOLDLOCK/UPDLOCK
   semantics, filtered unique indexes, DATE parsing). Those still need the
   manual staging pass listed in tests/README.md.
========================================================================= */
const path = require("path");
const sql = require("mssql");
const { suite, test: rawTest, assert } = require("./helpers/tinytest");
const { makeMockPool, makeReq, makeRes } = require("./helpers/mockPool");

/* ---- stub config/db BEFORE the controllers load it (no env / DB here), then restore ---- */
const dbPath = require.resolve("../config/db");
const hadDb = Object.prototype.hasOwnProperty.call(require.cache, dbPath);
const originalDb = require.cache[dbPath];
let activePool = null;
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getPool: async () => activePool, listTenantKeys: () => ["asumbi"], sql },
};
const invoicing = require("../services/invoicing.service");
const { buildInvoicePdf, buildReceiptPdf } = require("../utils/financeDocuments");
const invoiceController = require("../controllers/financeInvoice.controller");
const financeController = require("../controllers/finance.controller");
if (hadDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];

suite("financeInvoicing.test.js");

/* tinytest starts every test immediately and concurrently (see its header),
   but these tests temporarily replace mssql's Transaction/Request classes and
   a shared `activePool` — global state. Run every test in this file one at a
   time through a promise chain so they cannot clobber each other. */
let lock = Promise.resolve();
const test = (name, fn) => rawTest(name, () => {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
});

/* ---- scripted fake of mssql Transaction/Request ---- */
function withFakeDb(script, fn) {
  const state = { statements: [], began: 0, committed: 0, rolledBack: 0 };
  const RealTransaction = sql.Transaction;
  const RealRequest = sql.Request;

  function run(sqlText, inputs) {
    const normalized = sqlText.replace(/\s+/g, " ").trim();
    state.statements.push({ sql: normalized, inputs: { ...inputs } });
    for (const [match, handler] of script) {
      if (normalized.includes(match)) {
        const out = handler(inputs, state);
        if (out instanceof Error) throw out;
        return { recordset: out || [] };
      }
    }
    return { recordset: [] };
  }

  class FakeTransaction {
    async begin() { state.began += 1; }
    async commit() { state.committed += 1; }
    async rollback() { state.rolledBack += 1; }
  }
  class FakeRequest {
    constructor() { this.inputs = {}; }
    input(name, _type, value) { this.inputs[name] = value; return this; }
    async query(text) { return run(text, this.inputs); }
  }
  const pool = { request: () => new FakeRequest() };

  sql.Transaction = FakeTransaction;
  sql.Request = FakeRequest;
  const restore = () => { sql.Transaction = RealTransaction; sql.Request = RealRequest; };
  return Promise.resolve()
    .then(() => fn(pool, state))
    .then((r) => { restore(); return r; }, (e) => { restore(); throw e; });
}

const dupKeyError = () => Object.assign(new Error("Violation of UNIQUE KEY"), { number: 2627 });
const rejects = async (promise, code) => {
  try { await promise; } catch (err) { assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`); return err; }
  assert.fail(`expected rejection with ${code}`);
};

/* =============================== createInvoice =============================== */

test("createInvoice: validates quantity, price, tax, currency and due date before touching the DB", async () => {
  await withFakeDb([], async (pool, state) => {
    const base = { creditQuantity: 10, unitPrice: 100 };
    await rejects(invoicing.createInvoice(pool, { ...base, creditQuantity: 0 }), "INVALID_QUANTITY");
    await rejects(invoicing.createInvoice(pool, { ...base, creditQuantity: 2.5 }), "INVALID_QUANTITY");
    await rejects(invoicing.createInvoice(pool, { ...base, unitPrice: 0 }), "INVALID_UNIT_PRICE");
    await rejects(invoicing.createInvoice(pool, { ...base, unitPrice: "abc" }), "INVALID_UNIT_PRICE");
    await rejects(invoicing.createInvoice(pool, { ...base, taxRate: 120 }), "INVALID_TAX_RATE");
    await rejects(invoicing.createInvoice(pool, { ...base, taxRate: -1 }), "INVALID_TAX_RATE");
    await rejects(invoicing.createInvoice(pool, { ...base, currency: "KENYA" }), "INVALID_CURRENCY");
    await rejects(invoicing.createInvoice(pool, { ...base, dueDate: "next friday" }), "INVALID_DUE_DATE");
    assert.strictEqual(state.statements.length, 0, "no SQL may run for invalid input");
    assert.strictEqual(state.began, 0);
  });
});

test("createInvoice: computes subtotal/tax/total, numbers the invoice from its id, commits once", async () => {
  await withFakeDb([
    ["INSERT INTO finance_invoices", () => [{ id: 7, issue_date: new Date("2026-09-30T08:00:00Z") }]],
    ["FROM finance_invoices WHERE id", () => [{ id: 7, invoice_number: "INV-2026-00007", total_amount: 34800, status: "issued" }]],
  ], async (pool, state) => {
    const invoice = await invoicing.createInvoice(pool, {
      creditQuantity: 250, unitPrice: 120, taxRate: 16, currency: "kes",
      billTo: { name: "Asumbi Girls", email: "a@b.c", phone: "1" }, issuedBy: 3, actorRole: "finance",
    });
    const insert = state.statements.find((s) => s.sql.includes("INSERT INTO finance_invoices"));
    assert.strictEqual(insert.inputs.subtotal, 30000);
    assert.strictEqual(insert.inputs.taxAmount, 4800);
    assert.strictEqual(insert.inputs.total, 34800);
    assert.strictEqual(insert.inputs.currency, "KES", "currency is normalised to upper case");
    assert.strictEqual(insert.inputs.billName, "Asumbi Girls");
    const number = state.statements.find((s) => s.sql.includes("SET invoice_number"));
    assert.strictEqual(number.inputs.number, `INV-2026-00007`);
    assert.strictEqual(state.committed, 1);
    assert.strictEqual(state.rolledBack, 0);
    assert.strictEqual(invoice.invoice_number, "INV-2026-00007");
    assert.ok(state.statements.some((s) => s.sql.includes("INSERT INTO finance_audit_log")), "audit row written");
  });
});

test("createInvoice: rolls back if numbering the invoice fails", async () => {
  await withFakeDb([
    ["INSERT INTO finance_invoices", () => [{ id: 1, issue_date: new Date() }]],
    ["SET invoice_number", () => new Error("boom")],
  ], async (pool, state) => {
    await assert.rejects(invoicing.createInvoice(pool, { creditQuantity: 1, unitPrice: 1 }), /boom/);
    assert.strictEqual(state.committed, 0);
    assert.strictEqual(state.rolledBack, 1);
  });
});

/* ================================= voidInvoice ================================ */

test("voidInvoice: reason required; unknown/paid/already-void invoices are refused; issued invoices void", async () => {
  await withFakeDb([], async (pool) => {
    await rejects(invoicing.voidInvoice(pool, { invoiceId: 1, reason: "  " }), "REASON_REQUIRED");
  });
  const cases = [
    [[], "NOT_FOUND"],
    [[{ id: 1, invoice_number: "INV-1", status: "paid" }], "ALREADY_PAID"],
    [[{ id: 1, invoice_number: "INV-1", status: "void" }], "ALREADY_VOID"],
  ];
  for (const [rows, code] of cases) {
    await withFakeDb([["FROM finance_invoices WITH (UPDLOCK)", () => rows]], async (pool, state) => {
      await rejects(invoicing.voidInvoice(pool, { invoiceId: 1, reason: "typo" }), code);
      assert.strictEqual(state.rolledBack, 1);
      assert.ok(!state.statements.some((s) => s.sql.includes("SET status = 'void'")), "must not update");
    });
  }
  await withFakeDb([
    ["FROM finance_invoices WITH (UPDLOCK)", () => [{ id: 1, invoice_number: "INV-2026-00001", status: "issued" }]],
    ["FROM finance_invoices WHERE id", () => [{ id: 1, status: "void" }]],
  ], async (pool, state) => {
    const out = await invoicing.voidInvoice(pool, { invoiceId: 1, reason: "Wrong quantity" });
    assert.strictEqual(out.status, "void");
    assert.strictEqual(state.committed, 1);
    assert.strictEqual(state.statements.find((s) => s.sql.includes("SET status = 'void'")).inputs.reason, "Wrong quantity");
  });
});

/* ================================ recordPayment =============================== */

const issuedInvoice = (over = {}) => ({ id: 7, invoice_number: "INV-2026-00007", total_amount: 34800, currency: "KES", status: "issued", ...over });
const paymentScript = (invoiceRow, extra = []) => [
  ["FROM finance_invoices WITH (UPDLOCK, HOLDLOCK)", () => (invoiceRow ? [invoiceRow] : [])],
  ["INSERT INTO institution_payments", () => [{ id: 55 }]],
  ["INSERT INTO finance_receipts", () => [{ id: 9, issued_at: new Date("2026-10-02T10:00:00Z") }]],
  ["FROM finance_invoices WHERE id", () => [{ id: 7, invoice_number: "INV-2026-00007", status: "paid" }]],
  ...extra,
];

test("recordPayment against an invoice: defaults amount+currency, inserts payment AND receipt, marks invoice paid, one commit", async () => {
  await withFakeDb(paymentScript(issuedInvoice()), async (pool, state) => {
    const out = await invoicing.recordPayment(pool, {
      invoiceId: 7, paymentReference: "QWE123", method: "M-Pesa", institutionName: "Asumbi Girls", verifiedBy: 3, actorRole: "finance", tenantKey: "asumbi",
    });
    const pay = state.statements.find((s) => s.sql.includes("INSERT INTO institution_payments"));
    assert.strictEqual(pay.inputs.amount, 34800, "amount defaults to the invoice total");
    assert.strictEqual(pay.inputs.currency, "KES");
    const rec = state.statements.find((s) => s.sql.includes("INSERT INTO finance_receipts"));
    assert.strictEqual(rec.inputs.paymentId, 55);
    assert.strictEqual(rec.inputs.invoiceId, 7);
    assert.strictEqual(rec.inputs.receivedFrom, "Asumbi Girls");
    const paid = state.statements.find((s) => s.sql.includes("SET status = 'paid'"));
    assert.strictEqual(paid.inputs.paymentId, 55);
    assert.strictEqual(state.committed, 1);
    assert.strictEqual(state.rolledBack, 0);
    assert.strictEqual(out.receipt.receipt_number, "RCT-2026-00009");
    assert.strictEqual(out.payment.payment_reference, "QWE123");
    assert.strictEqual(out.invoice.status, "paid");
    const actions = state.statements.filter((s) => s.sql.includes("INSERT INTO finance_audit_log")).map((s) => s.inputs.action);
    assert.deepStrictEqual(actions, ["payment_verified", "invoice_paid", "receipt_issued"]);
  });
});

test("recordPayment: underpayment, wrong currency, paid and void invoices are refused with a rollback and no payment/receipt row", async () => {
  const cases = [
    [issuedInvoice(), { amount: 100 }, "UNDERPAID"],
    [issuedInvoice(), { amount: 34800, currency: "USD" }, "CURRENCY_MISMATCH"],
    [issuedInvoice({ status: "paid" }), {}, "ALREADY_PAID"],
    [issuedInvoice({ status: "void" }), {}, "INVOICE_VOID"],
    [null, {}, "NOT_FOUND"],
  ];
  for (const [row, args, code] of cases) {
    await withFakeDb(paymentScript(row), async (pool, state) => {
      await rejects(invoicing.recordPayment(pool, { invoiceId: 7, paymentReference: "REF1", ...args }), code);
      assert.strictEqual(state.committed, 0);
      assert.strictEqual(state.rolledBack, 1);
      assert.ok(!state.statements.some((s) => s.sql.includes("INSERT INTO institution_payments")), `${code}: no payment row`);
      assert.ok(!state.statements.some((s) => s.sql.includes("INSERT INTO finance_receipts")), `${code}: no receipt row`);
    });
  }
});

test("recordPayment: overpayment is accepted and recorded as paid", async () => {
  await withFakeDb(paymentScript(issuedInvoice()), async (pool, state) => {
    await invoicing.recordPayment(pool, { invoiceId: 7, paymentReference: "OVER1", amount: 40000 });
    assert.strictEqual(state.statements.find((s) => s.sql.includes("INSERT INTO institution_payments")).inputs.amount, 40000);
    assert.strictEqual(state.committed, 1);
  });
});

test("recordPayment: a duplicate payment reference maps to 409 and rolls everything back", async () => {
  // The failing INSERT matcher is listed FIRST so it wins over paymentScript's normal one.
  const script = [["INSERT INTO institution_payments", () => dupKeyError()], ...paymentScript(issuedInvoice())];
  await withFakeDb(script, async (pool, state) => {
    const err = await rejects(invoicing.recordPayment(pool, { invoiceId: 7, paymentReference: "DUP1" }), "DUPLICATE_PAYMENT");
    assert.strictEqual(err.statusCode, 409);
    assert.strictEqual(state.committed, 0);
    assert.strictEqual(state.rolledBack, 1);
    assert.ok(!state.statements.some((s) => s.sql.includes("INSERT INTO finance_receipts")));
  });
});

test("recordPayment without an invoice: needs a positive amount, still issues a receipt (invoice_id null)", async () => {
  await withFakeDb(paymentScript(null), async (pool, state) => {
    await rejects(invoicing.recordPayment(pool, { paymentReference: "X1" }), "INVALID_AMOUNT");
    assert.strictEqual(state.rolledBack, 1);
  });
  await withFakeDb(paymentScript(null), async (pool, state) => {
    const out = await invoicing.recordPayment(pool, { amount: 5000, currency: "KES", paymentReference: "X2", method: "Bank", institutionName: "Asumbi" });
    const rec = state.statements.find((s) => s.sql.includes("INSERT INTO finance_receipts"));
    assert.strictEqual(rec.inputs.invoiceId, null);
    assert.ok(!state.statements.some((s) => s.sql.includes("SET status = 'paid'")), "no invoice to settle");
    assert.strictEqual(out.invoice, null);
    assert.strictEqual(state.committed, 1);
  });
});

test("recordPayment: auto-generates a PAY- reference when none is supplied", async () => {
  await withFakeDb(paymentScript(null), async (pool, state) => {
    const out = await invoicing.recordPayment(pool, { amount: 100 });
    assert.ok(/^PAY-[A-Z0-9]{10}$/.test(out.payment.payment_reference), out.payment.payment_reference);
  });
});

/* ============================ ensureReceiptForPayment ========================= */

test("ensureReceiptForPayment: returns the existing receipt without inserting", async () => {
  await withFakeDb([
    ["SELECT id FROM finance_receipts WHERE institution_payment_id", () => [{ id: 4 }]],
    ["FROM finance_receipts r", () => [{ id: 4, receipt_number: "RCT-2026-00004" }]],
  ], async (pool, state) => {
    const r = await invoicing.ensureReceiptForPayment(pool, { paymentId: 12 });
    assert.strictEqual(r.receipt_number, "RCT-2026-00004");
    assert.ok(!state.statements.some((s) => s.sql.includes("INSERT INTO finance_receipts")));
  });
});

test("ensureReceiptForPayment: backfills a receipt for a pre-invoicing payment; 404 for an unknown payment", async () => {
  await withFakeDb([
    ["SELECT id FROM finance_receipts WHERE institution_payment_id", () => []],
    ["FROM institution_payments p", () => [{ id: 12, payment_reference: "OLD1", amount: 900, currency: "KES", method: "Bank", invoice_id: null }]],
    ["INSERT INTO finance_receipts", () => [{ id: 20, issued_at: new Date("2026-10-01T00:00:00Z") }]],
    ["FROM finance_receipts r", () => [{ id: 20, receipt_number: "RCT-2026-00020" }]],
  ], async (pool, state) => {
    const r = await invoicing.ensureReceiptForPayment(pool, { paymentId: 12, institutionName: "Asumbi" });
    assert.strictEqual(r.receipt_number, "RCT-2026-00020");
    assert.strictEqual(state.statements.find((s) => s.sql.includes("INSERT INTO finance_receipts")).inputs.reference, "OLD1");
    assert.strictEqual(state.committed, 1);
  });
  await withFakeDb([
    ["SELECT id FROM finance_receipts WHERE institution_payment_id", () => []],
    ["FROM institution_payments p", () => []],
  ], async (pool) => {
    await rejects(invoicing.ensureReceiptForPayment(pool, { paymentId: 999 }), "NOT_FOUND");
  });
});

test("ensureReceiptForPayment: a concurrent duplicate insert converges on the winner's receipt", async () => {
  let selects = 0;
  await withFakeDb([
    ["SELECT id FROM finance_receipts WHERE institution_payment_id", () => (++selects === 1 ? [] : [{ id: 31 }])],
    ["FROM institution_payments p", () => [{ id: 12, payment_reference: "R", amount: 1, currency: "KES", method: null, invoice_id: null }]],
    ["INSERT INTO finance_receipts", () => dupKeyError()],
    ["FROM finance_receipts r", () => [{ id: 31, receipt_number: "RCT-2026-00031" }]],
  ], async (pool, state) => {
    const r = await invoicing.ensureReceiptForPayment(pool, { paymentId: 12 });
    assert.strictEqual(r.id, 31);
    assert.strictEqual(state.rolledBack, 1);
  });
});

/* ==================================== PDFs ==================================== */

const sampleInvoice = {
  invoice_number: "INV-2026-00007", credit_quantity: 250, unit_price: 120, currency: "KES", subtotal: 30000, tax_rate: 16,
  tax_amount: 4800, total_amount: 34800, status: "issued", issue_date: new Date("2026-09-30"), due_date: "2026-10-14",
  notes: "n", bill_to_name: "Asumbi", bill_to_email: "a@b.c", bill_to_phone: "1",
};

test("buildInvoicePdf: produces a real PDF for issued, paid and void invoices", async () => {
  for (const status of ["issued", "paid", "void"]) {
    const buf = await buildInvoicePdf({ ...sampleInvoice, status, paid_at: new Date(), voided_at: new Date(), void_reason: "x" });
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.slice(0, 5).toString(), "%PDF-");
    assert.ok(buf.length > 1500, `${status} pdf too small`);
  }
});

test("buildReceiptPdf: produces a real PDF with and without a linked invoice", async () => {
  const receipt = { receipt_number: "RCT-2026-00009", invoice_number: "INV-2026-00007", amount: 34800, currency: "KES", payment_reference: "QWE", payment_method: "M-Pesa", received_from: "Asumbi", issued_at: new Date() };
  const withInvoice = await buildReceiptPdf(receipt, { invoice: sampleInvoice });
  const bare = await buildReceiptPdf({ ...receipt, invoice_number: null }, {});
  for (const buf of [withInvoice, bare]) {
    assert.strictEqual(buf.slice(0, 5).toString(), "%PDF-");
    assert.ok(buf.length > 1500);
  }
});

/* ================================= controllers ================================ */

test("downloadInvoicePdf: 400 for a bad id, 404 when missing, PDF attachment headers when found", async () => {
  const { pool } = makeMockPool([["FROM finance_invoices WHERE id", (inputs) => (inputs.id === 7 ? [{ ...sampleInvoice, id: 7 }] : [])]]);
  activePool = pool;

  let res = makeRes();
  await invoiceController.downloadInvoicePdf(makeReq({ pool, params: { tenantKey: "asumbi", invoiceId: "abc" } }), res);
  assert.strictEqual(res.statusCode, 400);

  res = makeRes();
  await invoiceController.downloadInvoicePdf(makeReq({ pool, params: { tenantKey: "asumbi", invoiceId: "99" } }), res);
  assert.strictEqual(res.statusCode, 404);

  const headers = {};
  res = makeRes();
  res.setHeader = (k, v) => { headers[k] = v; };
  await invoiceController.downloadInvoicePdf(makeReq({ pool, params: { tenantKey: "asumbi", invoiceId: "7" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(headers["Content-Type"], "application/pdf");
  assert.strictEqual(headers["Content-Disposition"], 'attachment; filename="INV-2026-00007.pdf"');
  assert.strictEqual(res.body.slice(0, 5).toString(), "%PDF-");
});

test("tenant wallet documents: serve the caller's own pool only; 400/404/PDF headers", async () => {
  const walletDocs = require("../controllers/walletDocuments.controller");
  const { pool } = makeMockPool([["FROM finance_invoices WHERE id", (inputs) => (inputs.id === 7 ? [{ ...sampleInvoice, id: 7 }] : [])]]);

  let res = makeRes();
  await walletDocs.downloadMyInvoicePdf(makeReq({ pool, params: { invoiceId: "abc" } }), res);
  assert.strictEqual(res.statusCode, 400);

  res = makeRes();
  await walletDocs.downloadMyInvoicePdf(makeReq({ pool, params: { invoiceId: "99" } }), res);
  assert.strictEqual(res.statusCode, 404);

  const headers = {};
  res = makeRes();
  res.setHeader = (k, v) => { headers[k] = v; };
  await walletDocs.downloadMyInvoicePdf(makeReq({ pool, params: { invoiceId: "7" } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(headers["Content-Disposition"], 'attachment; filename="INV-2026-00007.pdf"');
  assert.strictEqual(res.body.slice(0, 5).toString(), "%PDF-");
});

test("issuer profile: defaults to Doravo and never prints the legacy company name", () => {
  const { getIssuerProfile } = require("../utils/financeDocuments");
  assert.strictEqual(getIssuerProfile({}).name, "Doravo");
  assert.strictEqual(getIssuerProfile({ INVOICE_ISSUER_NAME: "Savorscope Solutions" }).name, "Doravo");
  assert.strictEqual(getIssuerProfile({ INVOICE_ISSUER_NAME: "Doravo Ltd" }).name, "Doravo Ltd");
});

test("finance routes: an unknown institution is a 404 for every invoice/receipt endpoint", async () => {
  const { pool } = makeMockPool([]);
  activePool = pool;
  for (const [fn, params] of [
    [invoiceController.listInvoices, {}],
    [invoiceController.createInvoice, {}],
    [invoiceController.downloadInvoicePdf, { invoiceId: "1" }],
    [invoiceController.listReceipts, {}],
    [invoiceController.downloadReceiptPdf, { receiptId: "1" }],
    [invoiceController.downloadPaymentReceipt, { paymentId: "1" }],
  ]) {
    const res = makeRes();
    await fn(makeReq({ pool, params: { tenantKey: "nope", ...params }, body: { creditQuantity: 1, unitPrice: 1 } }), res);
    assert.strictEqual(res.statusCode, 404, fn.name);
  }
});

test("createInvoice controller: invalid input is a 400 with a code, valid input returns 201 + pdfPath", async () => {
  const { pool } = makeMockPool([["FROM SchoolSettings", () => [{ schoolName: "Asumbi Girls", email: "a@b.c", phone: "1" }]]]);
  activePool = pool;
  let res = makeRes();
  await invoiceController.createInvoice(makeReq({ pool, params: { tenantKey: "asumbi" }, body: { creditQuantity: 0, unitPrice: 100 }, user: { id: 3, role: "finance" } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "INVALID_QUANTITY");

  await withFakeDb([
    ["FROM SchoolSettings", () => [{ schoolName: "Asumbi Girls", email: "a@b.c", phone: "1" }]],
    ["INSERT INTO finance_invoices", () => [{ id: 7, issue_date: new Date("2026-09-30") }]],
    ["FROM finance_invoices WHERE id", () => [{ id: 7, invoice_number: "INV-2026-00007", status: "issued" }]],
  ], async (fakePool) => {
    activePool = fakePool;
    res = makeRes();
    await invoiceController.createInvoice(makeReq({ pool: fakePool, params: { tenantKey: "asumbi" }, body: { creditQuantity: 5, unitPrice: 100 }, user: { id: 3, role: "finance" } }), res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.pdfPath, "/finance/institutions/asumbi/invoices/7/pdf");
  });
});

test("verifyPayment controller: amount still required without an invoice; with one it is optional and a receipt pdfPath comes back", async () => {
  const { pool } = makeMockPool([]);
  activePool = pool;
  let res = makeRes();
  await financeController.verifyPayment(makeReq({ pool, params: { tenantKey: "asumbi" }, body: {}, user: { id: 3, role: "finance" } }), res);
  assert.strictEqual(res.statusCode, 400);

  res = makeRes();
  await financeController.verifyPayment(makeReq({ pool, params: { tenantKey: "asumbi" }, body: { invoiceId: "abc" }, user: { id: 3, role: "finance" } }), res);
  assert.strictEqual(res.statusCode, 400);

  await withFakeDb([
    ["FROM SchoolSettings", () => [{ schoolName: "Asumbi Girls" }]],
    ...paymentScript(issuedInvoice()),
  ], async (fakePool) => {
    activePool = fakePool;
    res = makeRes();
    await financeController.verifyPayment(makeReq({ pool: fakePool, params: { tenantKey: "asumbi" }, body: { invoiceId: 7, paymentReference: "QWE1", method: "M-Pesa" }, user: { id: 3, role: "finance" } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.receipt.pdfPath, "/finance/institutions/asumbi/receipts/9/pdf");
    assert.strictEqual(res.body.payment.amount, 34800);
  });

  await withFakeDb([
    ["FROM SchoolSettings", () => [{ schoolName: "Asumbi Girls" }]],
    ...paymentScript(issuedInvoice({ status: "paid" })),
  ], async (fakePool) => {
    activePool = fakePool;
    res = makeRes();
    await financeController.verifyPayment(makeReq({ pool: fakePool, params: { tenantKey: "asumbi" }, body: { invoiceId: 7, paymentReference: "QWE2" }, user: { id: 3, role: "finance" } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "ALREADY_PAID");
  });
});
