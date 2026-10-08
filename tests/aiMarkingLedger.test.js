/* =========================================================================
   AI MARKING LEDGER — transactional tests (services/aiMarkingLedger.service.js)

   Runs the real, unmodified service against tests/helpers/fakeAiMarkingDb.js,
   an in-memory model with real row-lock, rollback and unique-index
   semantics. See that file's header for exactly what this does and does
   NOT prove (notably: it cannot validate T-SQL syntax or trigger behaviour
   — those need one run on a real disposable SQL Server).

   Covers the spec's Phase 12 items that live at the wallet layer:
   insufficient balance, concurrent reservations, duplicate requests,
   duplicate delivery, partial processing, financial reconciliation.
========================================================================= */
const { suite, test, assert } = require("./helpers/tinytest");
const { loadLedgerService } = require("./helpers/fakeAiMarkingDb");
const { buildStatements } = require("../utils/aiMarkingSchema");

suite("aiMarkingLedger.test.js");

function setup(balance = 0) {
  const ctx = loadLedgerService();
  ctx.addWallet({ id: 1, available_balance: balance, reserved_balance: 0 });
  ctx.addWallet({ id: 2, available_balance: 0, reserved_balance: 0 });
  return ctx;
}
const wallet = (ctx, id = 1) => ctx.state.wallets.get(id);
async function rejects(promise, code) {
  try { await promise; } catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code || err.message}`);
    return err;
  }
  assert.fail(`expected rejection with ${code}, but it resolved`);
}

/* ------------------------------ top-ups ------------------------------ */

test("topUp credits the wallet, writes a ledger row and reconciles", async () => {
  const ctx = setup(0);
  const r = await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-1", actorId: 7, actorRole: "finance" });
  assert.strictEqual(r.alreadyApplied, false);
  assert.strictEqual(wallet(ctx).available_balance, 100);
  assert.strictEqual(ctx.state.ledger.length, 1);
  assert.strictEqual(ctx.state.ledger[0].reserved_delta, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("topUp replayed with the same finance reference is a no-op (no double credit)", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-1" });
  const again = await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-1" });
  assert.strictEqual(again.alreadyApplied, true);
  assert.strictEqual(wallet(ctx).available_balance, 100);
  assert.strictEqual(ctx.state.ledger.length, 1);
});

test("topUp reusing a reference with a DIFFERENT amount is rejected, not silently ignored", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-1" });
  await rejects(ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 250, financeReference: "PAY-1" }), "IDEMPOTENCY_CONFLICT");
  assert.strictEqual(wallet(ctx).available_balance, 100);
});

test("topUp validates amount and requires a finance reference", async () => {
  const ctx = setup(0);
  await rejects(ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 0, financeReference: "X" }), "INVALID_AMOUNT");
  await rejects(ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: -5, financeReference: "X" }), "INVALID_AMOUNT");
  await rejects(ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 5, financeReference: "  " }), "INVALID_AMOUNT");
  assert.strictEqual(ctx.state.ledger.length, 0);
});

test("topUp on a missing wallet fails cleanly", async () => {
  const ctx = setup(0);
  await rejects(ctx.service.topUpWallet(ctx.pool, { walletId: 99, amount: 5, financeReference: "X" }), "WALLET_NOT_FOUND");
});

/* ------------------------------ reservations ------------------------------ */

test("reserve moves credit from available to reserved and records both deltas", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 50, financeReference: "seed" });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 10, walletId: 1, amount: 30 });
  assert.strictEqual(wallet(ctx).available_balance, 20);
  assert.strictEqual(wallet(ctx).reserved_balance, 30);
  const row = ctx.state.ledger.find((x) => x.entry_type === "reserve");
  assert.strictEqual(row.amount_delta, -30);
  assert.strictEqual(row.reserved_delta, 30);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("reserve with insufficient credits fails and leaves no trace", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 10, financeReference: "seed" });
  const before = ctx.state.ledger.length;
  await rejects(ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: 10.0001 }), "INSUFFICIENT_CREDITS");
  assert.strictEqual(wallet(ctx).available_balance, 10);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual(ctx.state.ledger.length, before);
});

test("reserve with a zero or negative amount is rejected", async () => {
  const ctx = setup(10);
  await rejects(ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: 0 }), "INVALID_AMOUNT");
  await rejects(ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: -1 }), "INVALID_AMOUNT");
});

test("CONCURRENCY: simultaneous reservations can never spend the same balance twice", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 10, financeReference: "seed" });
  // 6 different jobs each want 3 credits from a 10-credit wallet: exactly 3 fit.
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5, 6].map((jobId) => ctx.service.reserveForJob(ctx.pool, { jobId, walletId: 1, amount: 3 }))
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const insufficient = results.filter((r) => r.status === "rejected" && r.reason.code === "INSUFFICIENT_CREDITS").length;
  assert.strictEqual(ok, 3);
  assert.strictEqual(insufficient, 3);
  assert.strictEqual(wallet(ctx).available_balance, 1);
  assert.strictEqual(wallet(ctx).reserved_balance, 9);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("DUPLICATE REQUEST: the same job reserved 5x concurrently is charged exactly once and never errors", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "seed" });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => ctx.service.reserveForJob(ctx.pool, { jobId: 42, walletId: 1, amount: 40 }))
  );
  assert.strictEqual(results.filter((r) => !r.alreadyApplied).length, 1);
  assert.strictEqual(results.filter((r) => r.alreadyApplied).length, 4);
  assert.strictEqual(wallet(ctx).available_balance, 60);
  assert.strictEqual(wallet(ctx).reserved_balance, 40);
  assert.strictEqual(ctx.state.ledger.filter((x) => x.entry_type === "reserve").length, 1);
});

test("DUPLICATE REQUEST backstop: if the unique index fires despite the post-lock check, it becomes 'already applied', not a raw SQL error", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "seed" });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 7, walletId: 1, amount: 10 });
  // Simulate the multi-process race window: the pre-insert key lookup misses
  // (another process committed in between) so the INSERT hits the index.
  ctx.state.skipNextKeyLookup = true;
  const r = await ctx.service.reserveForJob(ctx.pool, { jobId: 7, walletId: 1, amount: 10 });
  assert.strictEqual(r.alreadyApplied, true);
  assert.strictEqual(wallet(ctx).available_balance, 90, "rolled back the second attempt's balance change");
  assert.strictEqual(wallet(ctx).reserved_balance, 10);
});

test("reserve key reused with a different amount or wallet is an IDEMPOTENCY_CONFLICT", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "seed" });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 5, walletId: 1, amount: 10 });
  await rejects(ctx.service.reserveForJob(ctx.pool, { jobId: 5, walletId: 1, amount: 20 }), "IDEMPOTENCY_CONFLICT");
  await ctx.service.topUpWallet(ctx.pool, { walletId: 2, amount: 100, financeReference: "seed2" });
  await rejects(ctx.service.reserveForJob(ctx.pool, { jobId: 5, walletId: 2, amount: 10 }), "IDEMPOTENCY_CONFLICT");
});

/* ------------------------------ settlement ------------------------------ */

async function reserved(ctx, jobId, amount, topup = 100) {
  if (wallet(ctx).available_balance < amount) await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: topup, financeReference: `seed-${jobId}` });
  await ctx.service.reserveForJob(ctx.pool, { jobId, walletId: 1, amount });
}

test("PARTIAL PROCESSING: settle consumes only what was processed and returns the rest", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  const r = await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 4 });
  assert.strictEqual(r.alreadyApplied, false);
  assert.strictEqual(wallet(ctx).available_balance, 100 - 10 + 6);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  const consume = ctx.state.ledger.find((x) => x.entry_type === "consume");
  const release = ctx.state.ledger.find((x) => x.entry_type === "release");
  assert.strictEqual(consume.reserved_delta, -4, "consumed amount is recorded structurally, not only in free text");
  assert.strictEqual(release.amount_delta, 6);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("settle with nothing processed returns the whole reservation (nothing charged)", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 0 });
  assert.strictEqual(wallet(ctx).available_balance, 100);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("settle with everything processed consumes the whole reservation and releases nothing", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 10 });
  assert.strictEqual(wallet(ctx).available_balance, 90);
  assert.strictEqual(ctx.state.ledger.filter((x) => x.entry_type === "release").length, 0);
});

test("DUPLICATE DELIVERY: settling the same job twice (sequentially or concurrently) charges once", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  const results = await Promise.all([1, 2, 3].map(() => ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 4 })));
  assert.strictEqual(results.filter((r) => !r.alreadyApplied).length, 1);
  assert.strictEqual(wallet(ctx).available_balance, 96);
  const again = await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 4 });
  assert.strictEqual(again.alreadyApplied, true);
  assert.strictEqual(wallet(ctx).available_balance, 96);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("settle rejects: no reservation, actual > reserved, mismatching caller amount", async () => {
  const ctx = setup(0);
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 404, walletId: 1, actualAmount: 1 }), "RESERVATION_NOT_FOUND");
  await reserved(ctx, 1, 10);
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 10.5 }), "INVALID_AMOUNT");
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, reservedAmount: 99, actualAmount: 1 }), "RESERVATION_MISMATCH");
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: -1 }), "INVALID_AMOUNT");
  assert.strictEqual(wallet(ctx).reserved_balance, 10, "failed settles changed nothing");
});

/* ------------------------------ release ------------------------------ */

test("release returns the full outstanding reservation", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1, reason: "cancelled" });
  assert.strictEqual(wallet(ctx).available_balance, 100);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("GAP FIX: release then settle (or settle then release) can't double-return funds", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1 });
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 0 }), "JOB_ALREADY_CLOSED");
  assert.strictEqual(wallet(ctx).available_balance, 100);

  const ctx2 = setup(0);
  await reserved(ctx2, 1, 10);
  await ctx2.service.settleJob(ctx2.pool, { jobId: 1, walletId: 1, actualAmount: 3 });
  await rejects(ctx2.service.releaseJobReservation(ctx2.pool, { jobId: 1, walletId: 1 }), "JOB_ALREADY_CLOSED");
  assert.strictEqual(wallet(ctx2).available_balance, 97, "only the 3 consumed credits are gone");
});

test("GAP FIX: closing one job can never eat into ANOTHER job's reservation in the same wallet", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await reserved(ctx, 2, 10);
  assert.strictEqual(wallet(ctx).reserved_balance, 20);
  await ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1 });
  // Previously only a "reserved_balance >= 0" check stood between this and job 2's money.
  await rejects(ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 0 }), "JOB_ALREADY_CLOSED");
  await rejects(ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1, tag: "again" }), "JOB_ALREADY_CLOSED");
  assert.strictEqual(wallet(ctx).reserved_balance, 10, "job 2's reservation is untouched");
  await ctx.service.settleJob(ctx.pool, { jobId: 2, walletId: 1, actualAmount: 10 });
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("release cannot exceed the job's own outstanding reservation", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await rejects(ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1, amount: 10.01 }), "INVALID_AMOUNT");
  await rejects(ctx.service.releaseJobReservation(ctx.pool, { jobId: 77, walletId: 1 }), "RESERVATION_NOT_FOUND");
});

test("partial mid-job release (tagged), then settle the remainder — totals stay exact", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  await ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1, amount: 3, tag: "cancel-batch-1" });
  assert.strictEqual(wallet(ctx).reserved_balance, 7);
  const dup = await ctx.service.releaseJobReservation(ctx.pool, { jobId: 1, walletId: 1, amount: 3, tag: "cancel-batch-1" });
  assert.strictEqual(dup.alreadyApplied, true);
  assert.strictEqual(wallet(ctx).reserved_balance, 7);
  await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 5 });
  assert.strictEqual(wallet(ctx).available_balance, 100 - 10 + 3 + 2);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

/* ------------------------------ reversal ------------------------------ */

test("reverse a top-up: compensating entry, original row untouched, at most once", async () => {
  const ctx = setup(0);
  const top = await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-9" });
  const original = { ...ctx.state.ledger[0] };
  const rev = await ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: top.ledgerRow.id, reason: "Payment bounced", actorId: 3, actorRole: "finance" });
  assert.strictEqual(rev.alreadyApplied, false);
  assert.strictEqual(wallet(ctx).available_balance, 0);
  assert.deepStrictEqual(ctx.state.ledger[0], original, "historical row is never modified");
  assert.strictEqual(ctx.state.ledger[1].entry_type, "reverse");
  assert.strictEqual(ctx.state.ledger[1].reverses_ledger_id, top.ledgerRow.id);
  const again = await ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: top.ledgerRow.id, reason: "retry" });
  assert.strictEqual(again.alreadyApplied, true);
  assert.strictEqual(wallet(ctx).available_balance, 0);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("reverse a top-up that has already been spent/reserved is refused", async () => {
  const ctx = setup(0);
  const top = await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-9" });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: 60 });
  await rejects(ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: top.ledgerRow.id, reason: "oops" }), "INSUFFICIENT_CREDITS");
  assert.strictEqual(wallet(ctx).available_balance, 40);
});

test("reverse a consume refunds exactly the consumed amount", async () => {
  const ctx = setup(0);
  await reserved(ctx, 1, 10);
  const settled = await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 4 });
  await ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: settled.consumeRow.id, reason: "Evaluations found invalid" });
  assert.strictEqual(wallet(ctx).available_balance, 100 - 4 + 4);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("reverse requires a reason, a real entry and a reversible type", async () => {
  const ctx = setup(0);
  const top = await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-9" });
  await rejects(ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: top.ledgerRow.id, reason: "  " }), "REASON_REQUIRED");
  await rejects(ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: 999, reason: "x" }), "LEDGER_ENTRY_NOT_FOUND");
  const res = await ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: 10 });
  await rejects(ctx.service.reverseLedgerEntry(ctx.pool, { ledgerId: res.ledgerRow.id, reason: "x" }), "NOT_REVERSIBLE");
});

/* ------------------------------ money precision & reconciliation ------------------------------ */

test("fractional prices never drift: 0.1 + 0.2 style sums reconcile exactly", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 0.3, financeReference: "frac" });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 1, walletId: 1, amount: 0.1 });
  await ctx.service.reserveForJob(ctx.pool, { jobId: 2, walletId: 1, amount: 0.2 });
  assert.strictEqual(wallet(ctx).available_balance, 0);
  assert.strictEqual(wallet(ctx).reserved_balance, 0.3);
  await ctx.service.settleJob(ctx.pool, { jobId: 1, walletId: 1, actualAmount: 0.0333 });
  await ctx.service.settleJob(ctx.pool, { jobId: 2, walletId: 1, actualAmount: 0.2 });
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual(wallet(ctx).available_balance, 0.0667);
  assert.strictEqual((await ctx.service.reconcileWallet(ctx.pool, 1)).ok, true);
});

test("reconcileWallet detects out-of-band tampering with a balance", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "PAY-1" });
  wallet(ctx).available_balance = 150; // someone edits the balance directly
  const r = await ctx.service.reconcileWallet(ctx.pool, 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.available.ok, false);
});

test("a mixed concurrent workload ends with a balanced ledger", async () => {
  const ctx = setup(0);
  await ctx.service.topUpWallet(ctx.pool, { walletId: 1, amount: 100, financeReference: "seed" });
  const ops = [];
  for (let j = 1; j <= 8; j += 1) ops.push(ctx.service.reserveForJob(ctx.pool, { jobId: j, walletId: 1, amount: 10 }).then(() =>
    j % 2 ? ctx.service.settleJob(ctx.pool, { jobId: j, walletId: 1, actualAmount: j }) : ctx.service.releaseJobReservation(ctx.pool, { jobId: j, walletId: 1 })));
  await Promise.all(ops);
  const r = await ctx.service.reconcileWallet(ctx.pool, 1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(wallet(ctx).reserved_balance, 0);
  assert.strictEqual(wallet(ctx).available_balance, 100 - (1 + 3 + 5 + 7));
});

/* ------------------------------ pricing / quotes ------------------------------ */

const pricing = (extra = {}) => ({ id: 1, price_per_answer: 4, currency: "KES", volume_discount_json: null, ...extra });

test("computeQuote: base price and total, exact arithmetic", async () => {
  const { service } = setup();
  const q = service.computeQuote(pricing({ price_per_answer: 0.1 }), 3);
  assert.strictEqual(q.unitPrice, 0.1);
  assert.strictEqual(q.total, 0.3);
  assert.strictEqual(service.computeQuote(pricing(), 0).total, 0);
});

test("computeQuote: volume tier applies to the whole quantity at the exact boundary, not before", async () => {
  const { service } = setup();
  const p = pricing({ volume_discount_json: JSON.stringify([{ minQty: 100, pricePerAnswer: 3.5 }, { minQty: 500, pricePerAnswer: 3 }]) });
  assert.strictEqual(service.computeQuote(p, 99).unitPrice, 4);
  assert.strictEqual(service.computeQuote(p, 100).unitPrice, 3.5);
  assert.strictEqual(service.computeQuote(p, 100).total, 350);
  assert.strictEqual(service.computeQuote(p, 499).unitPrice, 3.5);
  const big = service.computeQuote(p, 500);
  assert.strictEqual(big.unitPrice, 3);
  assert.strictEqual(big.total, 1500);
  assert.deepStrictEqual(big.appliedTier, { minQty: 500, pricePerAnswer: 3 });
});

test("computeQuote: a corrupt stored tier can never raise the price (falls back to base)", async () => {
  const { service } = setup();
  assert.strictEqual(service.computeQuote(pricing({ volume_discount_json: "not json" }), 1000).unitPrice, 4);
  assert.strictEqual(service.computeQuote(pricing({ volume_discount_json: JSON.stringify([{ minQty: 10, pricePerAnswer: 99 }]) }), 1000).unitPrice, 4);
});

test("computeQuote: no active price, or a bad quantity, is an error", async () => {
  const { service } = setup();
  await rejects(Promise.resolve().then(() => service.computeQuote(null, 5)), "INVALID_PRICING");
  await rejects(Promise.resolve().then(() => service.computeQuote(pricing(), -1)), "INVALID_AMOUNT");
  await rejects(Promise.resolve().then(() => service.computeQuote(pricing(), 1.5)), "INVALID_AMOUNT");
});

test("normaliseVolumeDiscounts rejects malformed, duplicate, dearer-than-base and non-monotonic tiers", async () => {
  const { service } = setup();
  const bad = (v, base = 4) => rejects(Promise.resolve().then(() => service.normaliseVolumeDiscounts(v, base)), "INVALID_PRICING");
  await bad("{");
  await bad({ minQty: 1 });
  await bad([{ minQty: 0, pricePerAnswer: 1 }]);
  await bad([{ minQty: 10, pricePerAnswer: -1 }]);
  await bad([{ minQty: 10, pricePerAnswer: 5 }]);
  await bad([{ minQty: 10, pricePerAnswer: 3 }, { minQty: 10, pricePerAnswer: 2 }]);
  await bad([{ minQty: 10, pricePerAnswer: 2 }, { minQty: 20, pricePerAnswer: 3 }]);
  assert.deepStrictEqual(service.normaliseVolumeDiscounts(null, 4), []);
});

test("setPricing validates before touching the database", async () => {
  const ctx = setup();
  const before = ctx.state.queryLog.length;
  await rejects(ctx.service.setPricing(ctx.pool, { pricePerAnswer: -1 }), "INVALID_PRICING");
  await rejects(ctx.service.setPricing(ctx.pool, { pricePerAnswer: "abc" }), "INVALID_PRICING");
  await rejects(ctx.service.setPricing(ctx.pool, { pricePerAnswer: 4, volumeDiscounts: [{ minQty: 5, pricePerAnswer: 9 }] }), "INVALID_PRICING");
  await rejects(ctx.service.setPricing(ctx.pool, { pricePerAnswer: 4, effectiveFrom: "not a date" }), "INVALID_EFFECTIVE_DATE");
  await rejects(ctx.service.setPricing(ctx.pool, { pricePerAnswer: 4, effectiveFrom: new Date(Date.now() - 86400000).toISOString() }), "INVALID_EFFECTIVE_DATE");
  assert.strictEqual(ctx.state.queryLog.length, before);
});

/* ------------------------------ schema statements (static guards) ------------------------------ */

test("schema upgrade statements: quote balance, ordering and the key safeguards are present", async () => {
  const stmts = buildStatements();
  stmts.forEach((s, idx) => {
    const quotes = (s.match(/'/g) || []).length;
    assert.strictEqual(quotes % 2, 0, `statement #${idx} has unbalanced single quotes (broken EXEC escaping?)`);
  });
  const all = stmts.join("\n");
  for (const needle of [
    "reserved_delta", "reverses_ledger_id", "UQ_ai_marking_ledger_reverses",
    "TR_ai_marking_ledger_append_only", "TR_ai_marking_pricing_append_only", "TR_ai_marking_adjustments_append_only",
    "ai_marking_scheme_versions", "ai_marking_adjustments", "CK_ai_marking_evaluations_final_whole",
    "UQ_ai_marking_scheme_versions_one_approved", "plan_code", "review_state",
  ]) assert.ok(all.includes(needle), `missing: ${needle}`);

  const backfill = stmts.findIndex((s) => s.includes("SET reserved_delta = CASE"));
  const ledgerTrigger = stmts.findIndex((s) => s.includes("TR_ai_marking_ledger_append_only") && s.includes("CREATE TRIGGER"));
  assert.ok(backfill >= 0 && ledgerTrigger > backfill, "backfill (needs UPDATE) must run before the append-only trigger is installed");

  const versions = stmts.findIndex((s) => s.includes("CREATE TABLE ai_marking_scheme_versions"));
  const fk = stmts.findIndex((s) => s.includes("FK_ai_marking_evaluations_scheme_version") && s.includes("ADD CONSTRAINT"));
  assert.ok(versions >= 0 && fk > versions, "scheme_versions table must exist before the FK that references it");
});
