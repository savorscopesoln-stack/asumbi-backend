/* =========================================================================
   AI MARKING — FINANCE CONTROLLER & ROUTE GATING

   Runs the real controllers/aiMarkingFinance.controller.js handlers and the
   real routes/finance.js router. The database is the in-memory fake from
   tests/helpers/fakeAiMarkingDb.js (see its header for what that does and
   does not prove); config/db's tenant list/pool are stubbed to point at it.
========================================================================= */
const { suite, test: rawTest, assert } = require("./helpers/tinytest");
const { makeReq, makeRes } = require("./helpers/mockPool");
const { loadLedgerService } = require("./helpers/fakeAiMarkingDb");

suite("aiMarkingFinance.test.js");

// tinytest starts every test immediately (concurrently). These tests share
// ONE fake database and deliberately build on each other's state (top-up ->
// reverse -> ...), so they must run strictly in order.
let chain = Promise.resolve();
const test = (name, fn) => rawTest(name, () => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
});

const path = require("path");
const dbModule = require("../config/db");
const realGetPool = dbModule.getPool;
const realListTenantKeys = dbModule.listTenantKeys;

const ctx = loadLedgerService();            // leaves the fake-bound service in require.cache
ctx.addWallet({ id: 1, owner_type: "institution", available_balance: 0, reserved_balance: 0 });

dbModule.getPool = async () => ctx.pool;
dbModule.listTenantKeys = () => ["tenantA"];
// Controllers destructure these at require-time, so drop any cached copies first.
for (const f of ["../controllers/finance.controller", "../controllers/aiMarkingFinance.controller", "../routes/finance"]) {
  delete require.cache[require.resolve(f)];
}
const controller = require("../controllers/aiMarkingFinance.controller");
const financeRouter = require("../routes/finance");
const { financeOnly } = require("../middleware/financeAuth");
dbModule.getPool = realGetPool;             // loaded handlers keep the stubs they captured;
dbModule.listTenantKeys = realListTenantKeys; // don't leak them into other test files

const finance = { id: 11, role: "finance" };
const call = async (handler, { params = { tenantKey: "tenantA" }, body = {}, query = {}, user = finance } = {}) => {
  const res = makeRes();
  await handler(makeReq({ pool: null, params, body, query, user }), res);
  return res;
};
const wallet = () => ctx.state.wallets.get(1);

test("ROUTE GATING: every ai-marking route sits behind protect + financeOnly (admins excluded)", async () => {
  const stack = financeRouter.stack;
  const firstRouteIdx = stack.findIndex((l) => l.route);
  assert.ok(firstRouteIdx >= 2, "router.use(protect, financeOnly) must come before any route");
  assert.ok(stack.slice(0, firstRouteIdx).some((l) => l.handle === financeOnly), "financeOnly must be in the pre-route middleware");
  const aiRoutes = stack.filter((l) => l.route && l.route.path.includes("/ai-marking"));
  // 6 wallet/pricing routes + 2 Phase 10 analytics routes (platform-wide and per institution).
  assert.strictEqual(aiRoutes.length, 8);
  assert.strictEqual(aiRoutes.filter((l) => l.route.path.endsWith("/ai-marking/analytics")).length, 2);
  assert.ok(stack.indexOf(aiRoutes[0]) > firstRouteIdx - 1);

  // And financeOnly itself has no admin bypass:
  const resFor = (role) => {
    const res = makeRes(); let nexted = false;
    financeOnly({ user: { role } }, res, () => { nexted = true; });
    return { status: res.statusCode, nexted };
  };
  assert.deepStrictEqual(resFor("admin"), { status: 403, nexted: false });
  assert.deepStrictEqual(resFor("module_admin"), { status: 403, nexted: false });
  assert.deepStrictEqual(resFor("teacher"), { status: 403, nexted: false });
  assert.strictEqual(resFor("finance").nexted, true);
});

test("unknown tenant is a 404 on every handler (tenantKey is validated, never trusted)", async () => {
  for (const h of ["getAiMarkingOverview", "listAiMarkingLedger", "listAiMarkingPricing", "setAiMarkingPricing", "topUpAiMarkingWallet"]) {
    const res = await call(controller[h], { params: { tenantKey: "someone-else" }, body: { confirm: true, amount: 5, financeReference: "x", pricePerAnswer: 1 } });
    assert.strictEqual(res.statusCode, 404, h);
  }
  const res = await call(controller.reverseAiMarkingEntry, { params: { tenantKey: "someone-else", ledgerId: "1" }, body: { confirm: true, reason: "x" } });
  assert.strictEqual(res.statusCode, 404);
});

test("topUp: requires explicit confirmation and a positive amount", async () => {
  assert.strictEqual((await call(controller.topUpAiMarkingWallet, { body: { amount: 100, financeReference: "P1" } })).statusCode, 400);
  const bad = await call(controller.topUpAiMarkingWallet, { body: { amount: -3, financeReference: "P1", confirm: true } });
  assert.strictEqual(bad.statusCode, 400);
  assert.strictEqual(bad.body.code, "INVALID_AMOUNT");
  assert.strictEqual(wallet().available_balance, 0);
});

test("topUp: credits once, audits once; a retry is a 200 'alreadyApplied' with no second credit or audit row", async () => {
  const first = await call(controller.topUpAiMarkingWallet, { body: { amount: 250, financeReference: "PAY-77", confirm: true, notes: "Bank slip 123" } });
  assert.strictEqual(first.statusCode, 201);
  assert.strictEqual(first.body.alreadyApplied, false);
  assert.strictEqual(wallet().available_balance, 250);
  assert.strictEqual(ctx.state.audit.filter((a) => a.action === "ai_marking_topup").length, 1);
  assert.strictEqual(ctx.state.audit[0].actorId, 11);

  const retry = await call(controller.topUpAiMarkingWallet, { body: { amount: 250, financeReference: "PAY-77", confirm: true } });
  assert.strictEqual(retry.statusCode, 200);
  assert.strictEqual(retry.body.alreadyApplied, true);
  assert.strictEqual(wallet().available_balance, 250);
  assert.strictEqual(ctx.state.audit.filter((a) => a.action === "ai_marking_topup").length, 1);

  const conflict = await call(controller.topUpAiMarkingWallet, { body: { amount: 999, financeReference: "PAY-77", confirm: true } });
  assert.strictEqual(conflict.statusCode, 409);
  assert.strictEqual(conflict.body.code, "IDEMPOTENCY_CONFLICT");
});

test("overview reports the wallet and that the ledger reconciles", async () => {
  const res = await call(controller.getAiMarkingOverview);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.reconciliation.ok, true);
  assert.strictEqual(res.body.activePricing, null);
});

test("reverse: needs confirmation, a valid id and a reason; then writes a compensating entry once", async () => {
  const topupId = ctx.state.ledger.find((r) => r.entry_type === "topup").id;
  const p = (id) => ({ tenantKey: "tenantA", ledgerId: String(id) });
  assert.strictEqual((await call(controller.reverseAiMarkingEntry, { params: p(topupId), body: { reason: "x" } })).statusCode, 400);
  assert.strictEqual((await call(controller.reverseAiMarkingEntry, { params: p("abc"), body: { confirm: true, reason: "x" } })).statusCode, 400);
  const noReason = await call(controller.reverseAiMarkingEntry, { params: p(topupId), body: { confirm: true } });
  assert.strictEqual(noReason.statusCode, 400);
  assert.strictEqual(noReason.body.code, "REASON_REQUIRED");
  assert.strictEqual((await call(controller.reverseAiMarkingEntry, { params: p(9999), body: { confirm: true, reason: "x" } })).statusCode, 404);

  const ok = await call(controller.reverseAiMarkingEntry, { params: p(topupId), body: { confirm: true, reason: "Payment bounced" } });
  assert.strictEqual(ok.statusCode, 201);
  assert.strictEqual(wallet().available_balance, 0);
  const again = await call(controller.reverseAiMarkingEntry, { params: p(topupId), body: { confirm: true, reason: "Payment bounced" } });
  assert.strictEqual(again.statusCode, 200);
  assert.strictEqual(again.body.alreadyApplied, true);
  assert.strictEqual(ctx.state.audit.filter((a) => a.action === "ai_marking_reversal").length, 1);
});

test("reversing a credit that was already reserved is a 409, not a negative balance", async () => {
  const top = await call(controller.topUpAiMarkingWallet, { body: { amount: 100, financeReference: "PAY-88", confirm: true } });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 500, walletId: 1, amount: 80 });
  const res = await call(controller.reverseAiMarkingEntry, { params: { tenantKey: "tenantA", ledgerId: String(top.body.ledgerEntry.id) }, body: { confirm: true, reason: "mistake" } });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "INSUFFICIENT_CREDITS");
  assert.strictEqual(wallet().available_balance, 20);
});

test("setPricing: needs confirmation; invalid prices/tiers/dates are 400 INVALID_*; nothing is written", async () => {
  assert.strictEqual((await call(controller.setAiMarkingPricing, { body: { pricePerAnswer: 4 } })).statusCode, 400);
  const neg = await call(controller.setAiMarkingPricing, { body: { pricePerAnswer: -4, confirm: true } });
  assert.strictEqual(neg.statusCode, 400);
  assert.strictEqual(neg.body.code, "INVALID_PRICING");
  const tier = await call(controller.setAiMarkingPricing, { body: { pricePerAnswer: 4, volumeDiscounts: [{ minQty: 10, pricePerAnswer: 9 }], confirm: true } });
  assert.strictEqual(tier.body.code, "INVALID_PRICING");
  const past = await call(controller.setAiMarkingPricing, { body: { pricePerAnswer: 4, effectiveFrom: "2001-01-01", confirm: true } });
  assert.strictEqual(past.body.code, "INVALID_EFFECTIVE_DATE");
  assert.strictEqual(ctx.state.audit.filter((a) => a.action === "ai_marking_price_set").length, 0);
});
