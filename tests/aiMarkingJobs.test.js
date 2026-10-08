/* =========================================================================
   AI MARKING — PHASE 4 (confirm -> claim -> reserve -> cancel -> settle)

   Runs the REAL services/aiMarkingJobs.service.js, aiMarkingEligibility
   and aiMarkingLedger against tests/helpers/fakeAiMarkingJobs.js — an
   in-memory model with READ COMMITTED visibility, blocking unique indexes,
   wallet row locks and rollback (see that file's header).

   WHAT THIS PROVES: the control flow and money arithmetic — that a failed or
   mismatched confirm leaves nothing behind, that duplicate / concurrent /
   replayed requests reserve once, that settlement charges successes only and
   releases the rest exactly once, and that every ledger reconciles.

   WHAT THIS DOES NOT PROVE: that the T-SQL is valid or that real SQL Server
   locking matches the model. Run the Phase 4 checklist in tests/README.md on
   a disposable tenant copy before trusting any of this with real credit.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { loadJobsServices } = require("./helpers/fakeAiMarkingJobs");

suite("aiMarkingJobs.test.js");

// Every test builds its own database, but a few touch process.env — run strictly in order.
let chain = Promise.resolve();
const seq = (name, fn) => test(name, () => { const p = chain.then(fn); chain = p.catch(() => {}); return p; });

const KEY = (s) => `${s}-aaaaaaaaaaaaaaaaaaaa`.slice(0, 40);
const ERR = async (promise) => { try { await promise; } catch (e) { return e; } return null; };

/** A tenant with an institution wallet, a price, and `n` billable essay answers for teacher 9. */
async function setup({ balance = 1000, price = 5, tiers = null, n = 10, pricingOverrides = {} } = {}) {
  const ctx = loadJobsServices();
  ctx.addWallet({ id: 1, owner_type: "institution", available_balance: 0 });
  ctx.fund = (amount) => ctx.ledger.topUpWallet(ctx.pool, { walletId: 1, amount, financeReference: `OPEN-${amount}-${Math.random().toString(36).slice(2)}`, actorRole: "finance" });
  if (balance > 0) await ctx.fund(balance);   // a real ledger row, so reconciliation is meaningful
  ctx.state.pricing = {
    id: 7, price_per_answer: price, currency: "KES", volume_discount_json: tiers,
    institution_wallets_enabled: 1, teacher_wallets_enabled: 0, plan_code: null, ...pricingOverrides,
  };
  for (let k = 1; k <= n; k += 1) ctx.addAnswer({ answer_id: k, submission_id: k, question_id: 1 + (k % 2), teacher_id: 9 });
  ctx.wallet = () => ctx.state.wallets.get(1);
  ctx.jobLedger = () => ctx.state.ledger.filter((r) => r.entry_type !== "topup");   // ignore the opening funding row
  ctx.fp = (sel, billable, unit, total) => ctx.elig.quoteFingerprint({
    selection: ctx.elig.normaliseSelection(sel), billable, unitPrice: unit, total, currency: "KES", pricingId: 7,
  });
  ctx.confirm = (key, sel = { eAssessmentId: 1 }, billable = n, unit = price, total = billable * unit, teacherId = 9) =>
    ctx.jobs.createJob(ctx.pool, { teacherId, selection: sel, quoteFingerprint: ctx.fp(sel, billable, unit, total), idempotencyKey: key });
  ctx.reconciles = async () => (await ctx.ledger.reconcileWallet(ctx.pool, 1)).ok;
  ctx.setEvals = (jobId, spec) => {            // simulate a worker's outcomes: { success: 6, needs_review: 1, failed: 2 }
    const mine = ctx.state.evals.filter((e) => e.ai_marking_job_id === jobId && e.status === "pending");
    let idx = 0;
    for (const [status, count] of Object.entries(spec)) for (let k = 0; k < count; k += 1) mine[idx++].status = status;
  };
  return ctx;
}

/* ============================== create / reserve ============================== */

seq("confirm claims only billable answers and reserves exactly the quote", async () => {
  const ctx = await setup({ n: 0 });
  // 4 billable + one of each thing that must NEVER be billed
  [1, 2, 3, 4].forEach((k) => ctx.addAnswer({ answer_id: k, question_id: 1 }));
  ctx.addAnswer({ answer_id: 5, blank: true });
  ctx.addAnswer({ answer_id: 6, marked: true });
  ctx.addAnswer({ answer_id: 7, released: true });
  ctx.addAnswer({ answer_id: 8, has_scheme: false });
  ctx.addAnswer({ answer_id: 9, teacher_id: 77 });               // another teacher's script
  const { job, replayed } = await ctx.confirm(KEY("a"), { eAssessmentId: 1 }, 4, 5, 20);
  assert.strictEqual(replayed, false);
  assert.strictEqual(job.status, "reserved");
  assert.strictEqual(job.progress.eligible, 4);
  assert.strictEqual(job.quote.quotedTotal, 20);
  assert.strictEqual(ctx.wallet().available_balance, 980);
  assert.strictEqual(ctx.wallet().reserved_balance, 20);
  const claimed = ctx.state.evals.map((e) => e.answer_id).sort();
  assert.deepStrictEqual(claimed, [1, 2, 3, 4]);
  assert.ok(await ctx.reconciles());
});

seq("claimed evaluations carry NO suggested mark, pin the approved scheme version, and use the question's max marks", async () => {
  const ctx = await setup({ n: 3 });
  await ctx.confirm(KEY("b"));
  for (const e of ctx.state.evals) {
    assert.strictEqual(e.suggested_total, null, "a claim must never invent a 0 mark");
    assert.strictEqual(e.status, "pending");
    assert.ok(e.scheme_version_id >= 100, "scheme version pinned at claim time");
    assert.strictEqual(e.max_marks, 10);
  }
});

seq("a stale or forged quote is rejected and leaves NOTHING behind (no job, no claims, no ledger rows)", async () => {
  const ctx = await setup({ n: 5 });
  const sel = { eAssessmentId: 1 };
  // teacher was shown a cheaper price than the real one
  const e = await ERR(ctx.jobs.createJob(ctx.pool, { teacherId: 9, selection: sel, quoteFingerprint: ctx.fp(sel, 5, 1, 5), idempotencyKey: KEY("c") }));
  assert.strictEqual(e.code, "QUOTE_CHANGED");
  assert.strictEqual(e.statusCode, 409);
  assert.deepStrictEqual(e.details, { billable: 5, unitPrice: 5, total: 25, currency: "KES" });
  assert.strictEqual(ctx.state.jobs.length, 0);
  assert.strictEqual(ctx.state.evals.length, 0);
  assert.strictEqual(ctx.jobLedger().length, 0);
  assert.strictEqual(ctx.wallet().available_balance, 1000);
  // and the same key is still usable with a correct quote
  const ok = await ctx.confirm(KEY("c"), sel, 5, 5, 25);
  assert.strictEqual(ok.job.status, "reserved");
});

seq("the count at confirm time wins over the count at preview time", async () => {
  const ctx = await setup({ n: 5 });
  // between the teacher's preview (5 answers) and the claim, one answer gets marked by hand
  ctx.state.beforeClaim = async () => { ctx.state.answers[0].marked = true; };
  const e = await ERR(ctx.confirm(KEY("d"), { eAssessmentId: 1 }, 5, 5, 25));
  assert.strictEqual(e.code, "QUOTE_CHANGED");
  assert.strictEqual(e.details.billable, 4);
  assert.strictEqual(ctx.state.evals.length, 0);
  assert.strictEqual(ctx.jobLedger().length, 0);
});

seq("insufficient balance: nothing is charged, claims are cancelled (not billed), answers become claimable again", async () => {
  const ctx = await setup({ n: 10, balance: 30 });                       // needs 50
  const e = await ERR(ctx.confirm(KEY("e")));
  assert.strictEqual(e.code, "INSUFFICIENT_CREDITS");
  assert.strictEqual(e.statusCode, 409);
  assert.strictEqual(ctx.wallet().available_balance, 30);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  assert.strictEqual(ctx.jobLedger().length, 0, "no ledger row for a failed reservation");
  assert.strictEqual(ctx.state.jobs[0].status, "cancelled");
  assert.ok(ctx.state.evals.every((x) => x.status === "cancelled"));
  // after a top-up the same answers can be confirmed under a new key
  await ctx.fund(470);
  const ok = await ctx.confirm(KEY("e2"));
  assert.strictEqual(ok.job.status, "reserved");
  assert.strictEqual(ctx.state.evals.filter((x) => x.status === "pending").length, 10);
});

seq("duplicate request (same key): replayed, reserved once, charged once", async () => {
  const ctx = await setup({ n: 6 });
  const first = await ctx.confirm(KEY("f"));
  const second = await ctx.confirm(KEY("f"));
  assert.strictEqual(first.replayed, false);
  assert.strictEqual(second.replayed, true);
  assert.strictEqual(first.job.id, second.job.id);
  assert.strictEqual(ctx.state.jobs.length, 1);
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "reserve").length, 1);
  assert.strictEqual(ctx.wallet().available_balance, 1000 - 30);
  assert.ok(await ctx.reconciles());
});

seq("simultaneous identical requests (double click): one job, one reservation", async () => {
  const ctx = await setup({ n: 6 });
  const results = await Promise.allSettled([ctx.confirm(KEY("g")), ctx.confirm(KEY("g")), ctx.confirm(KEY("g"))]);
  assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.reason && r.reason.code)));
  assert.strictEqual(new Set(results.map((r) => r.value.job.id)).size, 1);
  assert.strictEqual(results.filter((r) => !r.value.replayed).length, 1, "exactly one request created the job");
  assert.strictEqual(ctx.state.jobs.length, 1);
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "reserve").length, 1);
  assert.strictEqual(ctx.wallet().reserved_balance, 30);
  assert.ok(await ctx.reconciles());
});

seq("the same key with a DIFFERENT selection is an IDEMPOTENCY_CONFLICT, never someone else's job", async () => {
  const ctx = await setup({ n: 4 });
  await ctx.confirm(KEY("h"), { eAssessmentId: 1 });
  const e = await ERR(ctx.confirm(KEY("h"), { eAssessmentId: 1, questionIds: [1] }, 2, 5, 10));
  assert.strictEqual(e.code, "IDEMPOTENCY_CONFLICT");
  assert.strictEqual(ctx.state.jobs.length, 1);
});

seq("two confirmations racing for the SAME answers: exactly one wins, the other gets SELECTION_CONFLICT, balance reserved once", async () => {
  const ctx = await setup({ n: 8 });
  const results = await Promise.allSettled([ctx.confirm(KEY("i1")), ctx.confirm(KEY("i2"))]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.strictEqual(won.length, 1);
  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].reason.code, "SELECTION_CONFLICT");
  assert.strictEqual(ctx.state.jobs.filter((j) => j.status === "reserved").length, 1);
  assert.strictEqual(ctx.state.evals.filter((e) => e.status === "pending").length, 8, "each answer has exactly one live claim");
  assert.strictEqual(ctx.wallet().reserved_balance, 40);
  assert.ok(await ctx.reconciles());
});

seq("two teachers cannot spend the same balance twice", async () => {
  const ctx = await setup({ n: 0, balance: 60 });                          // enough for ONE 50-credit job, not two
  for (let k = 1; k <= 10; k += 1) ctx.addAnswer({ answer_id: k, teacher_id: k <= 5 ? 9 : 10, question_id: 1 });
  const mk = (teacher, key) => ctx.jobs.createJob(ctx.pool, { teacherId: teacher, selection: {}, quoteFingerprint: ctx.fp({}, 5, 5, 25), idempotencyKey: key });
  // each teacher has 5 answers = 25 credits; 60 covers two (50) — so make a third demand
  for (let k = 11; k <= 15; k += 1) ctx.addAnswer({ answer_id: k, teacher_id: 11, question_id: 1 });
  const results = await Promise.allSettled([mk(9, KEY("t9")), mk(10, KEY("t10")), mk(11, KEY("t11"))]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const noFunds = results.filter((r) => r.status === "rejected" && r.reason.code === "INSUFFICIENT_CREDITS").length;
  assert.strictEqual(ok, 2);
  assert.strictEqual(noFunds, 1);
  assert.ok(ctx.wallet().available_balance >= 0);
  assert.strictEqual(ctx.wallet().reserved_balance, 50);
  assert.ok(await ctx.reconciles());
});

seq("oversized selection is refused before any claim (TOO_MANY_ANSWERS) and persists nothing", async () => {
  const ctx = await setup({ n: 5 });
  process.env.AI_MARKING_MAX_ANSWERS_PER_JOB = "3";
  try {
    const e = await ERR(ctx.confirm(KEY("j")));
    assert.strictEqual(e.code, "TOO_MANY_ANSWERS");
    assert.strictEqual(e.statusCode, 422);
    assert.strictEqual(ctx.state.evals.length, 0);
    assert.strictEqual(ctx.jobLedger().length, 0);
  } finally { delete process.env.AI_MARKING_MAX_ANSWERS_PER_JOB; }
});

seq("configuration blockers: no price, wallet disabled, currency mismatch, zero price", async () => {
  let ctx = await setup({ n: 2 }); ctx.state.pricing = null;
  assert.strictEqual((await ERR(ctx.confirm(KEY("k1")))).code, "NO_PRICE");

  ctx = await setup({ n: 2, pricingOverrides: { institution_wallets_enabled: 0 } });
  assert.strictEqual((await ERR(ctx.confirm(KEY("k2")))).code, "INSTITUTION_WALLET_DISABLED");

  ctx = await setup({ n: 2, pricingOverrides: { currency: "USD" } });
  assert.strictEqual((await ERR(ctx.confirm(KEY("k3")))).code, "CURRENCY_MISMATCH");

  ctx = await setup({ n: 2, price: 0 });
  const e = await ERR(ctx.jobs.createJob(ctx.pool, { teacherId: 9, selection: { eAssessmentId: 1 }, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 2, 0, 0), idempotencyKey: KEY("k4") }));
  assert.strictEqual(e.code, "ZERO_PRICE");
  assert.strictEqual(ctx.state.evals.length, 0, "zero-price rejection rolls back the claims");
  for (const c of [ctx]) assert.strictEqual(c.jobLedger().length, 0);
});

seq("input validation: bad idempotency key, missing quote fingerprint", async () => {
  const ctx = await setup({ n: 2 });
  for (const bad of [undefined, "", "short", "has spaces in it aaaaaaaaaaaa", "x".repeat(65)]) {
    const e = await ERR(ctx.jobs.createJob(ctx.pool, { teacherId: 9, selection: {}, quoteFingerprint: ctx.fp({}, 2, 5, 10), idempotencyKey: bad }));
    assert.strictEqual(e && e.code, "INVALID_IDEMPOTENCY_KEY");
  }
  const e2 = await ERR(ctx.jobs.createJob(ctx.pool, { teacherId: 9, selection: {}, quoteFingerprint: "nope", idempotencyKey: KEY("l") }));
  assert.strictEqual(e2.code, "QUOTE_REQUIRED");
});

seq("volume tier: reservation uses the tier price; partial completion is charged at that same unit price", async () => {
  const ctx = await setup({ n: 10, tiers: JSON.stringify([{ minQty: 10, pricePerAnswer: 4 }]) });
  const { job } = await ctx.confirm(KEY("m"), { eAssessmentId: 1 }, 10, 4, 40);
  assert.strictEqual(job.quote.unitPrice, 4);
  assert.strictEqual(ctx.wallet().reserved_balance, 40);
  ctx.setEvals(job.id, { success: 3, failed: 7 });
  const { job: done } = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(done.quote.actualTotal, 12, "3 x 4, NOT re-priced at the base 5");
  assert.ok(await ctx.reconciles());
});

/* ============================== unknown outcomes & recovery ============================== */

seq("reserve outcome unknown: job stays pending, the SAME request resumes it, credit is reserved once", async () => {
  const ctx = await setup({ n: 4 });
  const real = ctx.ledger.reserveForJob;
  ctx.ledger.reserveForJob = async () => { throw new Error("socket hang up"); };
  const origErr = console.error; console.error = () => {};
  let e;
  try { e = await ERR(ctx.confirm(KEY("n"))); } finally { console.error = origErr; ctx.ledger.reserveForJob = real; }
  assert.strictEqual(e.code, "RESERVATION_UNCERTAIN");
  assert.strictEqual(e.statusCode, 503);
  assert.strictEqual(ctx.state.jobs[0].status, "pending", "not cancelled on an unknown outcome");
  assert.strictEqual(ctx.state.evals.filter((x) => x.status === "pending").length, 4);

  const again = await ctx.confirm(KEY("n"));
  assert.strictEqual(again.replayed, true);
  assert.strictEqual(again.job.status, "reserved");
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "reserve").length, 1);
  assert.strictEqual(ctx.wallet().reserved_balance, 20);
});

seq("sweeper resumes a pending job whose reservation DID land (crash before the status update)", async () => {
  const ctx = await setup({ n: 4 });
  const realReserve = ctx.ledger.reserveForJob;
  // reservation lands in the ledger, then the process "dies" before the CAS
  ctx.ledger.reserveForJob = async (...a) => { await realReserve(...a); throw new Error("process killed"); };
  const origErr = console.error; console.error = () => {};
  try { await ERR(ctx.confirm(KEY("o"))); } finally { console.error = origErr; ctx.ledger.reserveForJob = realReserve; }
  assert.strictEqual(ctx.state.jobs[0].status, "pending");
  assert.strictEqual(ctx.wallet().reserved_balance, 20);
  ctx.state.jobs[0].createdAt = new Date(Date.now() - 3600 * 1000);
  const out = await ctx.jobs.sweepStalledJobs(ctx.pool, { olderThanMinutes: 10 });
  assert.deepStrictEqual(out, { resumed: 1, cancelled: 0 });
  assert.strictEqual(ctx.state.jobs[0].status, "reserved");
  assert.strictEqual(ctx.wallet().reserved_balance, 20, "credit untouched, not doubled");
  assert.ok(await ctx.reconciles());
});

seq("sweeper cancels a pending job that never reserved and frees its claims", async () => {
  const ctx = await setup({ n: 4 });
  const real = ctx.ledger.reserveForJob;
  ctx.ledger.reserveForJob = async () => { throw new Error("db down"); };
  const origErr = console.error; console.error = () => {};
  try { await ERR(ctx.confirm(KEY("p"))); } finally { console.error = origErr; ctx.ledger.reserveForJob = real; }
  // young jobs are left alone
  assert.deepStrictEqual(await ctx.jobs.sweepStalledJobs(ctx.pool, { olderThanMinutes: 10 }), { resumed: 0, cancelled: 0 });
  ctx.state.jobs[0].createdAt = new Date(Date.now() - 3600 * 1000);
  assert.deepStrictEqual(await ctx.jobs.sweepStalledJobs(ctx.pool, { olderThanMinutes: 10 }), { resumed: 0, cancelled: 1 });
  assert.strictEqual(ctx.state.jobs[0].status, "cancelled");
  assert.ok(ctx.state.evals.every((x) => x.status === "cancelled"));
  assert.strictEqual(ctx.wallet().available_balance, 1000);
  // claims are free again
  assert.strictEqual((await ctx.confirm(KEY("p2"))).job.status, "reserved");
});

seq("a reservation that lands AFTER the sweeper cancelled the job is released, not leaked", async () => {
  const ctx = await setup({ n: 4 });
  const realReserve = ctx.ledger.reserveForJob;
  let swept = false;
  ctx.ledger.reserveForJob = async (...a) => {
    if (!swept) {                       // the sweeper wins the race first
      swept = true;
      ctx.state.jobs[0].createdAt = new Date(Date.now() - 3600 * 1000);
      await ctx.jobs.sweepStalledJobs(ctx.pool, { olderThanMinutes: 10 });
    }
    return realReserve(...a);           // ...and only then does the original reserve land
  };
  let e;
  try { e = await ERR(ctx.confirm(KEY("q"))); } finally { ctx.ledger.reserveForJob = realReserve; }
  assert.strictEqual(e.code, "JOB_NOT_ACTIVE");
  assert.strictEqual(ctx.state.jobs[0].status, "cancelled");
  assert.strictEqual(ctx.wallet().available_balance, 1000, "the late reservation was handed back");
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  assert.ok(await ctx.reconciles());
});

/* ============================== cancel ============================== */

seq("cancel before processing: nothing charged, full reservation released, claims cancelled; cancel is idempotent", async () => {
  const ctx = await setup({ n: 6 });
  const { job } = await ctx.confirm(KEY("r"));
  const { job: c1 } = await ctx.jobs.cancelJob(ctx.pool, { jobId: job.id, teacherId: 9 });
  assert.strictEqual(c1.status, "cancelled");
  assert.strictEqual(c1.quote.actualTotal, 0);
  assert.strictEqual(c1.progress.cancelled, 6);
  assert.strictEqual(ctx.wallet().available_balance, 1000);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  const rows = ctx.jobLedger().map((r) => r.entry_type);
  assert.deepStrictEqual(rows, ["reserve", "consume", "release"]);
  assert.ok(Math.abs(ctx.jobLedger()[1].reserved_delta) === 0 && ctx.jobLedger()[1].amount_delta === 0, "consume row moves no money");
  const again = await ctx.jobs.cancelJob(ctx.pool, { jobId: job.id, teacherId: 9 });
  assert.strictEqual(again.alreadyFinal, true);
  assert.strictEqual(ctx.jobLedger().length, 3, "second cancel writes nothing");
  assert.ok(await ctx.reconciles());
});

seq("cancel mid-job: answers already evaluated are charged, the rest released", async () => {
  const ctx = await setup({ n: 10 });
  const { job } = await ctx.confirm(KEY("s"));
  ctx.state.jobs[0].status = "processing";                         // a worker started (Phase 6 sets this)
  ctx.setEvals(job.id, { success: 4, needs_review: 1, failed: 1 });  // 4 still pending
  const { job: after } = await ctx.jobs.cancelJob(ctx.pool, { jobId: job.id, teacherId: 9 });
  assert.strictEqual(after.status, "cancelled");
  assert.strictEqual(after.quote.actualTotal, 25, "5 processed x 5");
  assert.strictEqual(after.progress.cancelled, 4);
  assert.strictEqual(ctx.wallet().available_balance, 1000 - 25);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  assert.ok(await ctx.reconciles());
});

seq("a teacher cannot see or cancel another teacher's job (404, not 403)", async () => {
  const ctx = await setup({ n: 3 });
  const { job } = await ctx.confirm(KEY("u"));
  for (const fn of [
    () => ctx.jobs.getJob(ctx.pool, { jobId: job.id, teacherId: 10 }),
    () => ctx.jobs.cancelJob(ctx.pool, { jobId: job.id, teacherId: 10 }),
  ]) {
    const e = await ERR(fn());
    assert.strictEqual(e.code, "JOB_NOT_FOUND");
    assert.strictEqual(e.statusCode, 404);
  }
  assert.strictEqual(ctx.state.jobs[0].status, "reserved", "untouched");
  assert.deepStrictEqual(await ctx.jobs.listJobs(ctx.pool, { teacherId: 10 }), []);
  assert.strictEqual((await ctx.jobs.listJobs(ctx.pool, { teacherId: 9 })).length, 1);
});

seq("cancelling a pending (unreserved) job aborts it and returns any in-flight reservation", async () => {
  const ctx = await setup({ n: 3 });
  const real = ctx.ledger.reserveForJob;
  ctx.ledger.reserveForJob = async () => { throw new Error("db down"); };
  const origErr = console.error; console.error = () => {};
  try { await ERR(ctx.confirm(KEY("v"))); } finally { console.error = origErr; ctx.ledger.reserveForJob = real; }
  const { job } = await ctx.jobs.cancelJob(ctx.pool, { jobId: ctx.state.jobs[0].id, teacherId: 9 });
  assert.strictEqual(job.status, "cancelled");
  assert.ok(ctx.state.evals.every((x) => x.status === "cancelled"));
  assert.strictEqual(ctx.jobLedger().length, 0);
});

/* ============================== settle / finalize ============================== */

seq("partial completion: charge only successful answers (success + needs_review); failed/cancelled are never charged; rest released", async () => {
  const ctx = await setup({ n: 10 });
  const { job } = await ctx.confirm(KEY("w"));
  ctx.setEvals(job.id, { success: 6, needs_review: 1, failed: 2, cancelled: 1 });
  const { job: done } = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.quote.actualTotal, 35, "7 x 5");
  assert.deepStrictEqual(
    { processed: done.progress.processed, failed: done.progress.failed, cancelled: done.progress.cancelled },
    { processed: 7, failed: 2, cancelled: 1 });
  assert.strictEqual(ctx.state.jobs[0].processed_count, 7);
  assert.strictEqual(ctx.wallet().available_balance, 1000 - 35);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  assert.ok(await ctx.reconciles());
});

seq("provider outage (every answer failed): job is 'failed', NOTHING charged, whole reservation released", async () => {
  const ctx = await setup({ n: 5 });
  const { job } = await ctx.confirm(KEY("x"));
  ctx.setEvals(job.id, { failed: 5 });
  const { job: done } = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(done.status, "failed");
  assert.strictEqual(done.quote.actualTotal, 0);
  assert.strictEqual(ctx.wallet().available_balance, 1000);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  assert.ok(await ctx.reconciles());
});

seq("all answers succeed: charge equals the quote, nothing left to release", async () => {
  const ctx = await setup({ n: 4 });
  const { job } = await ctx.confirm(KEY("y"));
  ctx.setEvals(job.id, { success: 4 });
  const { job: done } = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(done.quote.actualTotal, done.quote.quotedTotal);
  assert.deepStrictEqual(ctx.jobLedger().map((r) => r.entry_type), ["reserve", "consume"]);
  assert.strictEqual(ctx.wallet().available_balance, 980);
});

seq("finalize refuses while answers are still pending (and writes nothing)", async () => {
  const ctx = await setup({ n: 4 });
  const { job } = await ctx.confirm(KEY("z"));
  ctx.setEvals(job.id, { success: 2 });
  const before = ctx.jobLedger().length;
  const e = await ERR(ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id }));
  assert.strictEqual(e.code, "JOB_NOT_FINISHED");
  assert.strictEqual(ctx.jobLedger().length, before);
  assert.strictEqual(ctx.state.jobs[0].status, "reserved");
});

seq("duplicate worker delivery: two simultaneous finalizes charge once", async () => {
  const ctx = await setup({ n: 6 });
  const { job } = await ctx.confirm(KEY("aa"));
  ctx.setEvals(job.id, { success: 4, failed: 2 });
  const results = await Promise.allSettled([
    ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id }),
    ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id }),
    ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id }),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.reason && r.reason.code)));
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "consume").length, 1);
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "release").length, 1);
  assert.strictEqual(ctx.wallet().available_balance, 1000 - 20);
  assert.ok(results.every((r) => r.value.job.quote.actualTotal === 20));
  assert.ok(await ctx.reconciles());
});

seq("worker restart between ledger settle and status write: re-running finalize completes the job without a second charge", async () => {
  const ctx = await setup({ n: 6 });
  const { job } = await ctx.confirm(KEY("bb"));
  ctx.setEvals(job.id, { success: 5, failed: 1 });
  let armed = true;
  ctx.state.extra.unshift(async (q) => {                              // crash exactly at the status write, once
    if (armed && q.includes("/*job:finalize*/")) { armed = false; throw new Error("process killed"); }
    return undefined;
  });
  const e = await ERR(ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id }));
  assert.ok(e && /process killed/.test(e.message));
  assert.strictEqual(ctx.state.jobs[0].status, "reserved", "terminal status is written last, so it is still open");
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "consume").length, 1, "money already settled");

  const { job: done } = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.quote.actualTotal, 25);
  assert.strictEqual(ctx.state.ledger.filter((r) => r.entry_type === "consume").length, 1, "no second charge");
  assert.ok(await ctx.reconciles());
});

seq("finalize on an already-final job is a no-op; on a pending job it is refused", async () => {
  const ctx = await setup({ n: 3 });
  const { job } = await ctx.confirm(KEY("cc"));
  ctx.setEvals(job.id, { success: 3 });
  await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  const n = ctx.jobLedger().length;
  const again = await ctx.jobs.finalizeJob(ctx.pool, { jobId: job.id });
  assert.strictEqual(again.alreadyFinal, true);
  assert.strictEqual(ctx.jobLedger().length, n);
  assert.strictEqual((await ERR(ctx.jobs.finalizeJob(ctx.pool, { jobId: 9999 }))).code, "JOB_NOT_FOUND");

  const c2 = await setup({ n: 2 });
  const real = c2.ledger.reserveForJob; c2.ledger.reserveForJob = async () => { throw new Error("x"); };
  const origErr = console.error; console.error = () => {};
  try { await ERR(c2.confirm(KEY("dd"))); } finally { console.error = origErr; c2.ledger.reserveForJob = real; }
  assert.strictEqual((await ERR(c2.jobs.finalizeJob(c2.pool, { jobId: c2.state.jobs[0].id }))).code, "JOB_NOT_RESERVED");
});

seq("financial reconciliation over a mixed day: topup, confirm, partial settle, cancel, failed reserve", async () => {
  const ctx = await setup({ n: 0, balance: 0 });
  await ctx.ledger.topUpWallet(ctx.pool, { walletId: 1, amount: 200, financeReference: "MPESA-1", actorRole: "finance" });
  for (let k = 1; k <= 12; k += 1) ctx.addAnswer({ answer_id: k, question_id: 1 });
  const a = await ctx.confirm(KEY("ee"), { questionIds: [1], eAssessmentId: 1 }, 12, 5, 60);
  ctx.setEvals(a.job.id, { success: 9, failed: 3 });
  await ctx.jobs.finalizeJob(ctx.pool, { jobId: a.job.id });                     // consumes 45, releases 15
  for (let k = 13; k <= 18; k += 1) ctx.addAnswer({ answer_id: k, question_id: 2 });
  const b = await ctx.confirm(KEY("ff"), { questionIds: [2], eAssessmentId: 1 }, 6, 5, 30);
  await ctx.jobs.cancelJob(ctx.pool, { jobId: b.job.id, teacherId: 9 });         // all released
  for (let k = 19; k <= 60; k += 1) ctx.addAnswer({ answer_id: k, question_id: 3 });
  const c = await ERR(ctx.confirm(KEY("gg"), { questionIds: [3], eAssessmentId: 1 }, 42, 5, 210));  // 210 > 155
  assert.strictEqual(c.code, "INSUFFICIENT_CREDITS");
  assert.strictEqual(ctx.wallet().available_balance, 200 - 45);
  assert.strictEqual(ctx.wallet().reserved_balance, 0);
  const consumed = ctx.state.ledger.filter((r) => r.entry_type === "consume").reduce((s, r) => s - r.reserved_delta, 0);
  assert.strictEqual(consumed, 45, "money actually spent = 9 successful answers x 5");
  assert.ok(await ctx.reconciles());
});

/* ============================== static guards ============================== */

seq("job service never touches exam credits, the official Marks table, or authoritative marks", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../services/aiMarkingJobs.service.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // ignore comments
  for (const forbidden of [/\binstitution_wallets\b/i, /wallet_ledger\b/, /\bMarks\b/, /UPDATE\s+e_assessment_answers/i, /UPDATE\s+e_assessment_submissions/i, /marks_awarded\s*=/i]) {
    assert.ok(!forbidden.test(code), `forbidden reference: ${forbidden}`);
  }
  assert.ok(!/walletLedger\.service/.test(code));
});

seq("preview, pre-count and claim share ONE billable predicate; selection values are bound, never interpolated", async () => {
  const ctx = await setup({ n: 1 });
  const P = ctx.elig.BILLABLE_PREDICATE;
  const sel = ctx.elig.normaliseSelection({ subject: "x'; DROP TABLE y;--", questionIds: [41, 42] });
  const params = {}; const reqStub = { input(n, _t, v) { params[n] = v; return reqStub; } };
  const where = ctx.elig.applySelection(reqStub, sel);
  const flat = (t) => t.replace(/\s+/g, " ");
  assert.ok(flat(ctx.jobs.claimSql(where)).includes(`WHERE ${P}`));
  assert.ok(flat(ctx.jobs.countSql(where)).includes(`WHERE ${P}`));
  const eligSrc = fs.readFileSync(path.join(__dirname, "../services/aiMarkingEligibility.service.js"), "utf8");
  assert.ok((eligSrc.match(/\$\{BILLABLE_PREDICATE\}/g) || []).length >= 2, "preview uses the shared constant");
  const claim = flat(ctx.jobs.claimSql(where));
  assert.ok(!/DROP TABLE|41|42/.test(claim), "no raw selection values in SQL text");
  assert.ok(/sv\.status = 'approved'/.test(claim) && /scheme_version_id/.test(claim), "pins the approved scheme version");
  assert.ok(/'pending', 'awaiting_review'/.test(claim));
  assert.ok(!/suggested_total/.test(claim), "a claim never writes a suggested mark");
});

seq("schema: nullable suggested_total, 'cancelled' status, cross-job live-answer unique index", async () => {
  const stmts = require("../utils/aiMarkingSchema").buildStatements().join("\n");
  assert.ok(/ALTER COLUMN suggested_total DECIMAL\(6,2\) NULL/.test(stmts));
  assert.ok(/ALTER COLUMN model NVARCHAR\(100\) NULL/.test(stmts) && /ALTER COLUMN prompt_version NVARCHAR\(30\) NULL/.test(stmts));
  assert.ok(/CHECK \(status IN \(''pending'',''success'',''failed'',''needs_review'',''cancelled''\)\)/.test(stmts));
  assert.ok(/CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_evaluations_live_answer\s+ON ai_marking_evaluations\(submission_id, question_id\)/.test(stmts));
  assert.ok(/status IN \(''pending'',''success'',''needs_review''\) AND review_state <> ''superseded''/.test(stmts));
  assert.ok(/suggested_total IS NULL OR/.test(stmts), "bounds CHECK re-added NULL-tolerant");
});

/* ============================== controller ============================== */

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function loadController() {
  const p = path.resolve(__dirname, "../controllers/aiMarkingTeacher.controller.js");
  delete require.cache[p];
  return require(p);                       // resolves the already-loaded, fake-bound services
}

seq("controller: switched OFF by default (503) and manual marking is not involved", async () => {
  const ctx = await setup({ n: 3 });
  const controller = loadController();
  delete process.env.AI_MARKING_JOBS_ENABLED;
  const r = res();
  await controller.createJob({ pool: ctx.pool, user: { id: 9 }, body: { confirm: true } }, r);
  assert.strictEqual(r.statusCode, 503);
  assert.strictEqual(r.body.code, "FEATURE_DISABLED");
  assert.strictEqual(ctx.state.jobs.length, 0);
});

seq("controller: explicit confirmation required; teacher/price/count/tenant from the client are ignored", async () => {
  const ctx = await setup({ n: 3 });
  const controller = loadController();
  process.env.AI_MARKING_JOBS_ENABLED = "true";
  try {
    const r1 = res();
    await controller.createJob({ pool: ctx.pool, user: { id: 9 }, body: { eAssessmentId: 1, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 3, 5, 15), idempotencyKey: KEY("hh") } }, r1);
    assert.strictEqual(r1.statusCode, 400);
    assert.strictEqual(r1.body.code, "CONFIRMATION_REQUIRED");
    assert.strictEqual(ctx.state.jobs.length, 0);

    const r2 = res();
    await controller.createJob({
      pool: ctx.pool, user: { id: 9 },
      body: {
        confirm: true, eAssessmentId: 1, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 3, 5, 15), idempotencyKey: KEY("ii"),
        teacherId: 1, tenantKey: "other-school", unitPrice: 0.01, quotedTotal: 0.03, billable: 99999, walletId: 77,
      },
    }, r2);
    assert.strictEqual(r2.statusCode, 201, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.job.quote.quotedTotal, 15);
    assert.strictEqual(ctx.state.jobs[0].teacher_id, 9, "teacher id comes from the session");
    assert.strictEqual(ctx.state.jobs[0].wallet_id, 1, "wallet chosen by the server");
    assert.strictEqual(ctx.state.jobs[0].unit_price, 5);

    const r3 = res();                                                   // replay -> 200
    await controller.createJob({ pool: ctx.pool, user: { id: 9 }, body: { confirm: true, eAssessmentId: 1, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 3, 5, 15), idempotencyKey: KEY("ii") } }, r3);
    assert.strictEqual(r3.statusCode, 200);
    assert.strictEqual(r3.body.replayed, true);
  } finally { delete process.env.AI_MARKING_JOBS_ENABLED; }
});

seq("controller: QUOTE_CHANGED returns the fresh numbers; RESERVATION_UNCERTAIN is explained; other 5xx hide internals", async () => {
  const ctx = await setup({ n: 3 });
  const controller = loadController();
  process.env.AI_MARKING_JOBS_ENABLED = "true";
  const origErr = console.error; console.error = () => {};
  try {
    const r1 = res();
    await controller.createJob({ pool: ctx.pool, user: { id: 9 }, body: { confirm: true, eAssessmentId: 1, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 3, 1, 3), idempotencyKey: KEY("jj") } }, r1);
    assert.strictEqual(r1.statusCode, 409);
    assert.strictEqual(r1.body.code, "QUOTE_CHANGED");
    assert.strictEqual(r1.body.details.total, 15);

    const real = ctx.ledger.reserveForJob;
    ctx.ledger.reserveForJob = async () => { throw new Error("socket hang up"); };
    const r2 = res();
    try { await controller.createJob({ pool: ctx.pool, user: { id: 9 }, body: { confirm: true, eAssessmentId: 1, quoteFingerprint: ctx.fp({ eAssessmentId: 1 }, 3, 5, 15), idempotencyKey: KEY("kk") } }, r2); }
    finally { ctx.ledger.reserveForJob = real; }
    assert.strictEqual(r2.statusCode, 503);
    assert.strictEqual(r2.body.code, "RESERVATION_UNCERTAIN");
    assert.ok(!/socket/.test(JSON.stringify(r2.body)));

    const boom = { request() { throw new Error("secret connection string"); } };
    const r3 = res();
    await controller.createJob({ pool: boom, user: { id: 9 }, body: { confirm: true, eAssessmentId: 1, quoteFingerprint: "a".repeat(64), idempotencyKey: KEY("ll") } }, r3);
    assert.strictEqual(r3.statusCode, 500);
    assert.ok(!/secret/.test(JSON.stringify(r3.body)));
  } finally { console.error = origErr; delete process.env.AI_MARKING_JOBS_ENABLED; }
});

seq("controller: job reads and cancel are scoped to the signed-in teacher; unauthenticated is 401", async () => {
  const ctx = await setup({ n: 3 });
  const controller = loadController();
  const { job } = await ctx.confirm(KEY("mm"));
  const mine = res(); await controller.getJob({ pool: ctx.pool, user: { id: 9 }, params: { id: String(job.id) } }, mine);
  assert.strictEqual(mine.statusCode, 200);
  assert.strictEqual(mine.body.job.progress.eligible, 3);
  const theirs = res(); await controller.getJob({ pool: ctx.pool, user: { id: 10 }, params: { id: String(job.id) } }, theirs);
  assert.strictEqual(theirs.statusCode, 404);
  const steal = res(); await controller.cancelJob({ pool: ctx.pool, user: { id: 10 }, params: { id: String(job.id) } }, steal);
  assert.strictEqual(steal.statusCode, 404);
  assert.strictEqual(ctx.state.jobs[0].status, "reserved");
  const list = res(); await controller.listJobs({ pool: ctx.pool, user: { id: 9 }, query: {} }, list);
  assert.strictEqual(list.body.jobs.length, 1);
  const cancel = res(); await controller.cancelJob({ pool: ctx.pool, user: { id: 9 }, params: { id: String(job.id) } }, cancel);
  assert.strictEqual(cancel.body.job.status, "cancelled");
  const anon = res(); await controller.listJobs({ pool: ctx.pool, user: undefined, query: {} }, anon);
  assert.strictEqual(anon.statusCode, 401);
  assert.ok(!JSON.stringify(mine.body).match(/idempotency|wallet_id|locked_by|last_error/i), "internal columns are not exposed");
});

seq("route: every Phase 4 endpoint is behind protect + authorize('teacher')", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../routes/aiMarkingTeacher.js"), "utf8");
  assert.ok(/router\.use\(protect, authorize\("teacher"\)(, general)?\)/.test(src), "protect and authorize must come first; the Phase 11 rate limiter may follow");
  const uses = src.indexOf("router.use(");
  for (const route of ['router.post("/jobs"', 'router.get("/jobs"', 'router.get("/jobs/:id"', 'router.post("/jobs/:id/cancel"']) {
    const at = src.indexOf(route);
    assert.ok(at > uses, `${route} registered after the auth middleware`);
  }
});
