/* "Other charges" invoices: invoices that are not for exam credits. */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
suite("customInvoice.test.js");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const inv = require("../services/invoicing.service");

test("lines are validated and priced to the cent", () => {
  const r = inv.buildCustomItems([
    { description: " Setup fee ", quantity: 1, unitPrice: 25000 },
    { description: "Training (days)", quantity: 2.5, unitPrice: 8000.1 },
  ]);
  assert.strictEqual(r.lines[0].description, "Setup fee", "trimmed");
  assert.strictEqual(r.lines[1].amount, 20000.25);
  assert.strictEqual(r.subtotal, 45000.25);
});

test("bad lines are rejected with a specific code", () => {
  const code = (items) => { try { inv.buildCustomItems(items); } catch (e) { return e.code; } return null; };
  const ok = { description: "x", quantity: 1, unitPrice: 1 };
  assert.strictEqual(code([]), "ITEMS_REQUIRED");
  assert.strictEqual(code("nope"), "ITEMS_REQUIRED");
  assert.strictEqual(code([{ ...ok, description: "   " }]), "ITEM_DESCRIPTION_REQUIRED");
  assert.strictEqual(code([{ ...ok, description: "y".repeat(201) }]), "ITEM_DESCRIPTION_TOO_LONG");
  assert.strictEqual(code([{ ...ok, quantity: 0 }]), "INVALID_QUANTITY");
  assert.strictEqual(code([{ ...ok, quantity: 1.234 }]), "INVALID_QUANTITY");
  assert.strictEqual(code([{ ...ok, unitPrice: 0 }]), "INVALID_UNIT_PRICE");
  assert.strictEqual(code([{ ...ok, unitPrice: "abc" }]), "INVALID_UNIT_PRICE");
  assert.strictEqual(code(Array(21).fill(ok)), "TOO_MANY_ITEMS");
});

test("an unknown invoice type is refused before touching the database", async () => {
  let err = null;
  try { await inv.createInvoice({ request() { throw new Error("must not be reached"); } }, { invoiceType: "weird" }); } catch (e) { err = e; }
  assert.strictEqual(err && err.code, "INVALID_TYPE");
});

test("custom invoice creation validates items before any database work", async () => {
  let err = null;
  try { await inv.createInvoice({ request() { throw new Error("must not be reached"); } }, { invoiceType: "custom", items: [] }); } catch (e) { err = e; }
  assert.strictEqual(err && err.code, "ITEMS_REQUIRED");
});

test("schema + wiring: type/items columns, relaxed quantity check, controller passes the type, PDF prints the lines", () => {
  const schema = read("utils/ensureSchema.js").replace(/\s+/g, " ");
  assert.ok(schema.includes("ADD invoice_type NVARCHAR(20) NOT NULL"));
  assert.ok(schema.includes("ADD items_json NVARCHAR(MAX) NULL"));
  assert.ok(schema.includes("DROP CONSTRAINT CK_finance_invoices_quantity"));
  assert.ok(schema.includes("CHECK (credit_quantity > 0 OR (invoice_type = 'custom' AND credit_quantity = 0))"));
  const ctl = read("controllers/financeInvoice.controller.js");
  assert.ok(ctl.includes('invoiceType: invoiceType === "custom" ? "custom" : "credits"') && ctl.includes("items,"));
  assert.ok(read("services/invoicing.service.js").includes("invoice_type, items_json"), "invoice reads include the new columns");
  const pdf = read("utils/financeDocuments.js");
  assert.ok(pdf.includes('invoice.invoice_type === "custom"') && pdf.includes("JSON.parse(invoice.items_json"));
});
