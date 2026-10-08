const sql = require("mssql");

/* =========================================================================
   AI MARKING LEDGER SERVICE

   The single place ai_marking_wallets.available_balance/reserved_balance
   are ever written from — same discipline as services/walletLedger.service.js
   for institution_wallets. Nothing else writes those two columns directly.

   WHY A SEPARATE FILE FROM walletLedger.service.js, NOT A SHARED ONE:
   the Master Implementation Prompt is explicit that AI marking credits
   and institution examination credits are different accounting
   concepts that must never be mixed. Keeping them as two separate
   services writing two separate table families makes that boundary
   structural: there is no function in this file that can touch
   institution_wallets, and none in walletLedger.service.js that can
   touch ai_marking_wallets.

   LEDGER MODEL (revised — Phase 2 fixes, audit §6)
   Every ledger row records BOTH balance movements:
     amount_delta    — change to available_balance
     reserved_delta  — change to reserved_balance
   so for any wallet:
     SUM(amount_delta)   == available_balance
     SUM(reserved_delta) == reserved_balance
   (reconcileWallet() checks exactly that.)

     topup    +amount / 0
     reserve  -amount / +amount
     consume  0       / -consumed     (the money actually spent)
     release  +amount / -amount       (unused reservation returned)
     reverse  compensating entry for a topup (-amount / 0) or a consume
              (+refund / 0); each original entry can be reversed at most
              once (unique index on reverses_ledger_id).
   Rows are never updated or deleted — enforced by database triggers
   (utils/aiMarkingSchema.js), not just by convention.

   CONCURRENCY + IDEMPOTENCY (revised)
   Every mutating function goes through withWalletTx():
     1. open a transaction and lock the wallet row (UPDLOCK, HOLDLOCK)
     2. THEN check the idempotency key — after the lock, so two
        simultaneous identical requests are serialised and the second
        deterministically sees the first's row. (Previously the check ran
        before the lock, so both could pass it and the loser failed on
        the unique index with a raw SQL error.)
     3. do the work, commit.
   The unique filtered index on idempotency_key remains the backstop; if
   it ever fires anyway (e.g. two different app servers), the violation
   is caught and converted into the same "already applied" result.

   JOB LIFECYCLE GUARD (revised)
   A job's outstanding reservation is derived from the LEDGER —
   SUM(reserved_delta) over that job's rows — not from caller-supplied
   numbers. settleJob / releaseJobReservation can therefore only ever
   spend or return what that specific job actually reserved, and once a
   job's outstanding amount reaches zero, any further settle/release is
   rejected (JOB_ALREADY_CLOSED) instead of eating into other jobs'
   reservations in the same wallet.

   NOTHING here decides WHETHER a reservation/settlement/top-up SHOULD
   happen — that's the calling controller's job (role, job status,
   eligible-answer count). This file makes sure that once a caller has
   decided to, the balance change cannot be double-applied, cannot go
   negative, and cannot half-apply under concurrent load or a crash.
========================================================================= */

class AiMarkingWalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AiMarkingWalletError";
    // 'INSUFFICIENT_CREDITS' | 'WALLET_NOT_FOUND' | 'INVALID_AMOUNT' |
    // 'IDEMPOTENCY_CONFLICT' | 'RESERVATION_NOT_FOUND' | 'JOB_ALREADY_CLOSED' |
    // 'RESERVATION_MISMATCH' | 'LEDGER_ENTRY_NOT_FOUND' | 'NOT_REVERSIBLE' |
    // 'ALREADY_REVERSED' | 'REASON_REQUIRED' | 'INVALID_PRICING' | 'INVALID_EFFECTIVE_DATE'
    this.code = code;
  }
}

/* ---------------------------- small utilities ---------------------------- */

const UNIQUE_VIOLATION_NUMBERS = new Set([2601, 2627]);

function isUniqueViolation(err) {
  const n = err && (err.number ?? err.originalError?.number ?? err.originalError?.info?.number);
  return UNIQUE_VIOLATION_NUMBERS.has(n);
}

const SCALE = 10000; // DECIMAL(18,4)

/** Money arithmetic on integers at 4dp so 0.1 + 0.2 style drift can never leak into a balance. */
function toScaled(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AiMarkingWalletError("Amount is not a finite number", "INVALID_AMOUNT");
  return Math.round(n * SCALE);
}
function fromScaled(scaled) {
  return scaled / SCALE;
}
function addMoney(a, b) { return fromScaled(toScaled(a) + toScaled(b)); }
function subMoney(a, b) { return fromScaled(toScaled(a) - toScaled(b)); }

/* ------------------------------ read helpers ------------------------------ */

/** Read a wallet by id (no lock — for display only, never for a check-then-act decision). */
async function getWalletSnapshot(pool, walletId) {
  const result = await pool.request()
    .input("id", sql.Int, walletId)
    .query(`
      SELECT id, owner_type, owner_id, available_balance, reserved_balance, currency, updatedAt
      FROM ai_marking_wallets WHERE id = @id
    `);
  return result.recordset[0] || null;
}

/** Convenience: the one singleton institution wallet, creating it if this tenant DB predates the migration somehow (ensureSchema.js already does this on boot, this is just a safety net). */
async function getOrCreateInstitutionWallet(pool) {
  const read = () => pool.request().query(`
    SELECT id, owner_type, owner_id, available_balance, reserved_balance, currency, updatedAt
    FROM ai_marking_wallets WHERE owner_type = 'institution'
  `);
  const existing = await read();
  if (existing.recordset[0]) return existing.recordset[0];
  try {
    const created = await pool.request().query(`
      INSERT INTO ai_marking_wallets (owner_type, owner_id, available_balance, reserved_balance)
      OUTPUT INSERTED.*
      VALUES ('institution', NULL, 0, 0)
    `);
    return created.recordset[0];
  } catch (err) {
    // Two requests raced to create the singleton; the filtered unique
    // index let exactly one win — read the winner.
    if (isUniqueViolation(err)) {
      const again = await read();
      if (again.recordset[0]) return again.recordset[0];
    }
    throw err;
  }
}

/** Lock and read a wallet row inside an already-open transaction. Always the first statement of any mutating transaction below. */
async function lockWallet(transaction, walletId) {
  const result = await new sql.Request(transaction)
    .input("id", sql.Int, walletId)
    .query(`
      SELECT id, owner_type, owner_id, available_balance, reserved_balance, currency
      FROM ai_marking_wallets WITH (UPDLOCK, HOLDLOCK)
      WHERE id = @id
    `);
  return result.recordset[0];
}

/** Was this idempotency key already applied? Called AFTER lockWallet (see header). */
async function alreadyApplied(transaction, idempotencyKey) {
  if (!idempotencyKey) return null;
  const result = await new sql.Request(transaction)
    .input("key", sql.NVarChar(100), idempotencyKey)
    .query(`
      SELECT TOP 1 id, wallet_id, entry_type, amount_delta, reserved_delta, available_after, reserved_after
      FROM ai_marking_ledger WHERE idempotency_key = @key
    `);
  return result.recordset[0] || null;
}

async function readLedgerRowByKey(pool, idempotencyKey) {
  const result = await pool.request()
    .input("key", sql.NVarChar(100), idempotencyKey)
    .query(`
      SELECT TOP 1 id, wallet_id, entry_type, amount_delta, reserved_delta, available_after, reserved_after
      FROM ai_marking_ledger WHERE idempotency_key = @key
    `);
  return result.recordset[0] || null;
}

async function insertLedgerRow(transaction, {
  walletId, entryType, amountDelta, reservedDelta = 0, availableAfter, reservedAfter,
  aiMarkingJobId = null, financeReference = null, reversesLedgerId = null,
  actorId = null, actorRole = null, reason = null, idempotencyKey = null,
}) {
  const result = await new sql.Request(transaction)
    .input("walletId", sql.Int, walletId)
    .input("entryType", sql.NVarChar(30), entryType)
    .input("amountDelta", sql.Decimal(18, 4), amountDelta)
    .input("reservedDelta", sql.Decimal(18, 4), reservedDelta)
    .input("availableAfter", sql.Decimal(18, 4), availableAfter)
    .input("reservedAfter", sql.Decimal(18, 4), reservedAfter)
    .input("aiMarkingJobId", sql.Int, aiMarkingJobId)
    .input("financeReference", sql.NVarChar(100), financeReference)
    .input("reversesLedgerId", sql.Int, reversesLedgerId)
    .input("actorId", sql.Int, actorId)
    .input("actorRole", sql.NVarChar(30), actorRole)
    .input("reason", sql.NVarChar(500), reason)
    .input("idempotencyKey", sql.NVarChar(100), idempotencyKey)
    .query(`
      INSERT INTO ai_marking_ledger
        (wallet_id, entry_type, amount_delta, reserved_delta, available_after, reserved_after,
         ai_marking_job_id, finance_reference, reverses_ledger_id, actor_id, actor_role, reason, idempotency_key)
      OUTPUT INSERTED.*
      VALUES
        (@walletId, @entryType, @amountDelta, @reservedDelta, @availableAfter, @reservedAfter,
         @aiMarkingJobId, @financeReference, @reversesLedgerId, @actorId, @actorRole, @reason, @idempotencyKey)
    `);
  return result.recordset[0];
}

/* ------------------------- the one transaction shell ------------------------- */

/**
 * Lock the wallet, honour the idempotency key, run `work`, commit.
 *
 * `expect` (optional) = { entryType, amountDelta } — if the key was
 * already used by a DIFFERENT logical operation (other wallet, other
 * amount) that is a caller bug, not a harmless retry, and is reported as
 * IDEMPOTENCY_CONFLICT rather than silently returning someone else's row.
 */
async function withWalletTx(pool, { walletId, idempotencyKey, expect = null }, work) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const wallet = await lockWallet(transaction, walletId);
    if (!wallet) throw new AiMarkingWalletError("Wallet not found", "WALLET_NOT_FOUND");

    const dup = await alreadyApplied(transaction, idempotencyKey);
    if (dup) {
      assertSameOperation(dup, walletId, expect);
      await transaction.rollback();
      return { alreadyApplied: true, ledgerRow: dup };
    }

    const out = await work(transaction, wallet);
    await transaction.commit();
    return { alreadyApplied: false, ...out };
  } catch (err) {
    await transaction.rollback().catch(() => {});
    // Backstop: unique index fired despite the post-lock check (multi-process race).
    if (idempotencyKey && isUniqueViolation(err)) {
      const existing = await readLedgerRowByKey(pool, idempotencyKey);
      if (existing) {
        assertSameOperation(existing, walletId, expect);
        return { alreadyApplied: true, ledgerRow: existing };
      }
    }
    throw err;
  }
}

function assertSameOperation(row, walletId, expect) {
  if (Number(row.wallet_id) !== Number(walletId)) {
    throw new AiMarkingWalletError("Idempotency key was already used for a different wallet", "IDEMPOTENCY_CONFLICT");
  }
  if (expect) {
    if (expect.entryType && row.entry_type !== expect.entryType) {
      throw new AiMarkingWalletError("Idempotency key was already used for a different operation", "IDEMPOTENCY_CONFLICT");
    }
    if (expect.amountDelta != null && toScaled(row.amount_delta) !== toScaled(expect.amountDelta)) {
      throw new AiMarkingWalletError("Idempotency key was already used with a different amount", "IDEMPOTENCY_CONFLICT");
    }
  }
}

/** Net outstanding reservation for one job, derived from the ledger itself (call inside the wallet lock). */
async function getJobOutstanding(transaction, jobId, walletId) {
  const result = await new sql.Request(transaction)
    .input("jobId", sql.Int, jobId)
    .input("walletId", sql.Int, walletId)
    .query(`
      SELECT
        COUNT(CASE WHEN entry_type = 'reserve' THEN 1 END) AS reserve_rows,
        ISNULL(SUM(reserved_delta), 0) AS outstanding
      FROM ai_marking_ledger
      WHERE ai_marking_job_id = @jobId AND wallet_id = @walletId
    `);
  const row = result.recordset[0] || {};
  return { reserveRows: Number(row.reserve_rows || 0), outstanding: Number(row.outstanding || 0) };
}

/* -------------------------------- pricing -------------------------------- */

/**
 * The active price per answer right now. Preference order: a row for the
 * requested plan_code (if any) beats the plan-less default; within that,
 * the latest effective_from that has arrived wins. Callers snapshot the
 * result into ai_marking_jobs.unit_price/pricing_id at quote time so a
 * later price change never alters a past job's cost.
 */
async function getActivePricing(pool, { planCode = null } = {}) {
  const result = await pool.request()
    .input("planCode", sql.NVarChar(50), planCode)
    .query(`
      SELECT TOP 1 id, price_per_answer, currency, volume_discount_json,
             institution_wallets_enabled, teacher_wallets_enabled, plan_code, effective_from
      FROM ai_marking_pricing
      WHERE effective_from <= GETDATE()
        AND (plan_code IS NULL OR plan_code = @planCode)
      ORDER BY CASE WHEN plan_code = @planCode THEN 0 ELSE 1 END, effective_from DESC, id DESC
    `);
  return result.recordset[0] || null;
}

/** Parse + validate a volume-discount definition. Returns a normalised, ascending-by-minQty array; throws INVALID_PRICING if malformed. */
function normaliseVolumeDiscounts(raw, basePrice) {
  if (raw == null || raw === "") return [];
  let tiers = raw;
  if (typeof raw === "string") {
    try { tiers = JSON.parse(raw); } catch { throw new AiMarkingWalletError("volumeDiscounts is not valid JSON", "INVALID_PRICING"); }
  }
  if (!Array.isArray(tiers)) throw new AiMarkingWalletError("volumeDiscounts must be an array", "INVALID_PRICING");
  const out = tiers.map((t) => ({ minQty: Number(t?.minQty), pricePerAnswer: Number(t?.pricePerAnswer) }));
  for (const t of out) {
    if (!Number.isInteger(t.minQty) || t.minQty < 1) throw new AiMarkingWalletError("Each discount tier needs a whole-number minQty >= 1", "INVALID_PRICING");
    if (!Number.isFinite(t.pricePerAnswer) || t.pricePerAnswer < 0) throw new AiMarkingWalletError("Each discount tier needs a non-negative pricePerAnswer", "INVALID_PRICING");
    if (basePrice != null && toScaled(t.pricePerAnswer) > toScaled(basePrice)) throw new AiMarkingWalletError("A discount tier cannot cost more than the base price", "INVALID_PRICING");
  }
  out.sort((a, b) => a.minQty - b.minQty);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].minQty === out[i - 1].minQty) throw new AiMarkingWalletError("Duplicate minQty in discount tiers", "INVALID_PRICING");
    if (toScaled(out[i].pricePerAnswer) > toScaled(out[i - 1].pricePerAnswer)) throw new AiMarkingWalletError("Discount tiers must not get more expensive as quantity grows", "INVALID_PRICING");
  }
  return out;
}

/**
 * Pure quote calculation. A volume tier applies to the WHOLE quantity (the
 * tier with the largest minQty <= quantity), not marginally — chosen
 * because it is what a teacher can verify by eye ("500 answers x 4.00").
 * Integer arithmetic at 4dp; no floating-point drift.
 */
function computeQuote(pricing, quantity) {
  if (!pricing) throw new AiMarkingWalletError("No active AI marking price is configured", "INVALID_PRICING");
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 0) throw new AiMarkingWalletError("Quantity must be a non-negative whole number", "INVALID_AMOUNT");

  const base = Number(pricing.price_per_answer);
  let tiers = [];
  try { tiers = normaliseVolumeDiscounts(pricing.volume_discount_json, base); } catch { tiers = []; /* a corrupt stored tier must never raise the price; fall back to base */ }

  let unit = base;
  let appliedTier = null;
  for (const t of tiers) {
    if (qty >= t.minQty) { unit = t.pricePerAnswer; appliedTier = t; }
  }
  const total = fromScaled(toScaled(unit) * qty);
  return {
    quantity: qty,
    unitPrice: unit,
    basePrice: base,
    total,
    currency: pricing.currency,
    appliedTier,
    pricingId: pricing.id ?? null,
  };
}

/* Guard rails against a typo or a compromised finance login (Phase 11). They are ceilings on a single
   action, not business rules: a larger top-up can be made as several entries, each with its own reference.
   Override per deployment with AI_MARKING_MAX_TOPUP / AI_MARKING_MAX_PRICE_PER_ANSWER. */
function ceiling(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const maxTopUp = () => ceiling("AI_MARKING_MAX_TOPUP", 5000000);
const maxPricePerAnswer = () => ceiling("AI_MARKING_MAX_PRICE_PER_ANSWER", 10000);

/** Append a new price row (never edits an existing one). Finance-only at the route layer. */
async function setPricing(pool, {
  pricePerAnswer, currency = "KES", volumeDiscounts = null,
  institutionWalletsEnabled = true, teacherWalletsEnabled = false,
  effectiveFrom = null, planCode = null, setBy = null, notes = null,
}) {
  const price = Number(pricePerAnswer);
  if (!Number.isFinite(price) || price < 0) throw new AiMarkingWalletError("Price per answer must be a non-negative number", "INVALID_PRICING");
  if (price > maxPricePerAnswer()) throw new AiMarkingWalletError(`Price per answer cannot exceed ${maxPricePerAnswer()} in one change`, "INVALID_PRICING");
  const tiers = normaliseVolumeDiscounts(volumeDiscounts, price);

  let effective = null;
  if (effectiveFrom != null && effectiveFrom !== "") {
    effective = new Date(effectiveFrom);
    if (Number.isNaN(effective.getTime())) throw new AiMarkingWalletError("effectiveFrom is not a valid date", "INVALID_EFFECTIVE_DATE");
    // No back-dating: a price must never retroactively become "the price that was active".
    if (effective.getTime() < Date.now() - 60 * 1000) throw new AiMarkingWalletError("effectiveFrom cannot be in the past", "INVALID_EFFECTIVE_DATE");
  }

  const result = await pool.request()
    .input("price", sql.Decimal(18, 4), price)
    .input("currency", sql.NVarChar(10), currency)
    .input("tiers", sql.NVarChar(sql.MAX), tiers.length ? JSON.stringify(tiers) : null)
    .input("instEnabled", sql.Bit, institutionWalletsEnabled ? 1 : 0)
    .input("teacherEnabled", sql.Bit, teacherWalletsEnabled ? 1 : 0)
    .input("effective", sql.DateTime, effective)
    .input("planCode", sql.NVarChar(50), planCode)
    .input("setBy", sql.Int, setBy)
    .input("notes", sql.NVarChar(500), notes)
    .query(`
      INSERT INTO ai_marking_pricing
        (price_per_answer, currency, volume_discount_json, institution_wallets_enabled,
         teacher_wallets_enabled, effective_from, plan_code, set_by, notes)
      OUTPUT INSERTED.*
      VALUES
        (@price, @currency, @tiers, @instEnabled, @teacherEnabled, ISNULL(@effective, GETDATE()), @planCode, @setBy, @notes)
    `);
  return result.recordset[0];
}

/* ------------------------------ wallet operations ------------------------------ */

/**
 * Finance manually crediting a wallet. Idempotent on (wallet, financeReference).
 */
async function topUpWallet(pool, { walletId, amount, financeReference, actorId = null, actorRole = null, notes = null }) {
  if (!(Number(amount) > 0) || !Number.isFinite(Number(amount))) throw new AiMarkingWalletError("Top-up amount must be a positive number", "INVALID_AMOUNT");
  if (Number(amount) > maxTopUp()) throw new AiMarkingWalletError(`A single top-up cannot exceed ${maxTopUp()}; split it into separate entries, each with its own finance reference`, "INVALID_AMOUNT");
  if (!financeReference || !String(financeReference).trim()) {
    throw new AiMarkingWalletError("A finance reference is required for a top-up", "INVALID_AMOUNT");
  }
  const idempotencyKey = `topup:${walletId}:${String(financeReference).trim()}`;

  return withWalletTx(pool, { walletId, idempotencyKey, expect: { entryType: "topup", amountDelta: Number(amount) } }, async (transaction, wallet) => {
    const availableAfter = addMoney(wallet.available_balance, amount);
    await new sql.Request(transaction)
      .input("id", sql.Int, walletId)
      .input("available", sql.Decimal(18, 4), availableAfter)
      .query(`UPDATE ai_marking_wallets SET available_balance = @available, updatedAt = GETDATE() WHERE id = @id`);

    const ledgerRow = await insertLedgerRow(transaction, {
      walletId, entryType: "topup", amountDelta: Number(amount), reservedDelta: 0,
      availableAfter, reservedAfter: Number(wallet.reserved_balance),
      financeReference: String(financeReference).trim(), actorId, actorRole, reason: notes, idempotencyKey,
    });
    return { ledgerRow };
  });
}

/**
 * Reserve `amount` for a job right after the teacher confirms the quote.
 * All-or-nothing: a job gets its full quote reserved or none of it.
 */
async function reserveForJob(pool, { jobId, walletId, amount, actorId = null, actorRole = null }) {
  if (!(Number(amount) > 0)) throw new AiMarkingWalletError("Reservation amount must be positive", "INVALID_AMOUNT");
  const idempotencyKey = `reserve-job:${jobId}`;

  return withWalletTx(pool, { walletId, idempotencyKey, expect: { entryType: "reserve", amountDelta: -Number(amount) } }, async (transaction, wallet) => {
    if (toScaled(wallet.available_balance) < toScaled(amount)) {
      throw new AiMarkingWalletError(
        `Insufficient AI marking credits: need ${amount}, have ${wallet.available_balance} available`,
        "INSUFFICIENT_CREDITS"
      );
    }
    const availableAfter = subMoney(wallet.available_balance, amount);
    const reservedAfter = addMoney(wallet.reserved_balance, amount);
    await new sql.Request(transaction)
      .input("id", sql.Int, walletId)
      .input("available", sql.Decimal(18, 4), availableAfter)
      .input("reserved", sql.Decimal(18, 4), reservedAfter)
      .query(`UPDATE ai_marking_wallets SET available_balance = @available, reserved_balance = @reserved, updatedAt = GETDATE() WHERE id = @id`);

    const ledgerRow = await insertLedgerRow(transaction, {
      walletId, entryType: "reserve", amountDelta: -Number(amount), reservedDelta: Number(amount),
      availableAfter, reservedAfter, aiMarkingJobId: jobId,
      actorId, actorRole, reason: `Reserved for AI marking job #${jobId}`, idempotencyKey,
    });
    return { ledgerRow };
  });
}

/**
 * Settle a job once processing finishes: `actualAmount` is consumed for
 * good, the rest of THIS JOB's outstanding reservation returns to
 * available — one atomic step, so partial completion is exact.
 *
 * `reservedAmount` is optional and only used as a cross-check: the real
 * figure is derived from the ledger (see header). If the caller passes
 * one and it disagrees, that is a bug upstream and is rejected.
 */
async function settleJob(pool, { jobId, walletId, reservedAmount = null, actualAmount, actorId = null, actorRole = null }) {
  const actualScaled = toScaled(actualAmount);
  if (actualScaled < 0) throw new AiMarkingWalletError("actualAmount cannot be negative", "INVALID_AMOUNT");
  const idempotencyKey = `settle-job:${jobId}`;

  return withWalletTx(pool, { walletId, idempotencyKey, expect: { entryType: "consume" } }, async (transaction, wallet) => {
    const { reserveRows, outstanding } = await getJobOutstanding(transaction, jobId, walletId);
    if (reserveRows === 0) throw new AiMarkingWalletError(`Job #${jobId} has no reservation on this wallet`, "RESERVATION_NOT_FOUND");
    const outstandingScaled = toScaled(outstanding);
    if (outstandingScaled <= 0) throw new AiMarkingWalletError(`Job #${jobId} is already settled or released`, "JOB_ALREADY_CLOSED");
    if (reservedAmount != null && toScaled(reservedAmount) !== outstandingScaled) {
      throw new AiMarkingWalletError(
        `Caller reservedAmount ${reservedAmount} does not match the ${outstanding} actually outstanding for job #${jobId}`,
        "RESERVATION_MISMATCH"
      );
    }
    if (actualScaled > outstandingScaled) {
      throw new AiMarkingWalletError(`actualAmount ${actualAmount} exceeds the ${outstanding} reserved for job #${jobId}`, "INVALID_AMOUNT");
    }

    const unusedScaled = outstandingScaled - actualScaled;
    const walletAvailable = Number(wallet.available_balance);
    const walletReserved = Number(wallet.reserved_balance);

    const availableFinal = fromScaled(toScaled(walletAvailable) + unusedScaled);
    const reservedFinal = fromScaled(toScaled(walletReserved) - outstandingScaled);
    if (reservedFinal < 0) throw new AiMarkingWalletError("Settlement would drive reserved_balance negative", "RESERVATION_MISMATCH");

    await new sql.Request(transaction)
      .input("id", sql.Int, walletId)
      .input("available", sql.Decimal(18, 4), availableFinal)
      .input("reserved", sql.Decimal(18, 4), reservedFinal)
      .query(`UPDATE ai_marking_wallets SET available_balance = @available, reserved_balance = @reserved, updatedAt = GETDATE() WHERE id = @id`);

    // Consume row: carries the amount actually spent structurally.
    const reservedAfterConsume = fromScaled(toScaled(walletReserved) - actualScaled);
    const consumeRow = await insertLedgerRow(transaction, {
      walletId, entryType: "consume", amountDelta: 0, reservedDelta: -fromScaled(actualScaled),
      availableAfter: walletAvailable, reservedAfter: reservedAfterConsume, aiMarkingJobId: jobId,
      actorId, actorRole, reason: `Consumed ${fromScaled(actualScaled)} for completed AI marking job #${jobId}`,
      idempotencyKey,
    });

    let releaseRow = null;
    if (unusedScaled > 0) {
      releaseRow = await insertLedgerRow(transaction, {
        walletId, entryType: "release", amountDelta: fromScaled(unusedScaled), reservedDelta: -fromScaled(unusedScaled),
        availableAfter: availableFinal, reservedAfter: reservedFinal, aiMarkingJobId: jobId,
        actorId, actorRole,
        reason: `Released ${fromScaled(unusedScaled)} unused reservation from AI marking job #${jobId}`,
        idempotencyKey: `${idempotencyKey}:release`,
      });
    }
    return { ledgerRow: consumeRow, consumeRow, releaseRow };
  });
}

/**
 * Release a job's reservation with no consumption — cancelled before
 * processing, or a provider outage meant nothing could be attempted.
 * `amount` defaults to everything still outstanding for the job; pass a
 * smaller amount (with a distinct `tag`) to release part of it mid-job
 * (e.g. some answers cancelled). It can never exceed that job's own
 * outstanding reservation.
 */
async function releaseJobReservation(pool, { jobId, walletId, amount = null, reason = null, tag = null, actorId = null, actorRole = null }) {
  const idempotencyKey = tag ? `release-job:${jobId}:${tag}` : `release-job:${jobId}`;
  if (amount != null && !(Number(amount) > 0)) throw new AiMarkingWalletError("Release amount must be positive", "INVALID_AMOUNT");

  return withWalletTx(pool, { walletId, idempotencyKey, expect: { entryType: "release" } }, async (transaction, wallet) => {
    const { reserveRows, outstanding } = await getJobOutstanding(transaction, jobId, walletId);
    if (reserveRows === 0) throw new AiMarkingWalletError(`Job #${jobId} has no reservation on this wallet`, "RESERVATION_NOT_FOUND");
    const outstandingScaled = toScaled(outstanding);
    if (outstandingScaled <= 0) throw new AiMarkingWalletError(`Job #${jobId} is already settled or released`, "JOB_ALREADY_CLOSED");

    const releaseScaled = amount == null ? outstandingScaled : toScaled(amount);
    if (releaseScaled > outstandingScaled) {
      throw new AiMarkingWalletError(`Cannot release ${fromScaled(releaseScaled)}: only ${outstanding} is outstanding for job #${jobId}`, "INVALID_AMOUNT");
    }

    const availableAfter = fromScaled(toScaled(wallet.available_balance) + releaseScaled);
    const reservedAfter = fromScaled(toScaled(wallet.reserved_balance) - releaseScaled);
    if (reservedAfter < 0) throw new AiMarkingWalletError("Release would drive reserved_balance negative", "RESERVATION_MISMATCH");

    await new sql.Request(transaction)
      .input("id", sql.Int, walletId)
      .input("available", sql.Decimal(18, 4), availableAfter)
      .input("reserved", sql.Decimal(18, 4), reservedAfter)
      .query(`UPDATE ai_marking_wallets SET available_balance = @available, reserved_balance = @reserved, updatedAt = GETDATE() WHERE id = @id`);

    const ledgerRow = await insertLedgerRow(transaction, {
      walletId, entryType: "release", amountDelta: fromScaled(releaseScaled), reservedDelta: -fromScaled(releaseScaled),
      availableAfter, reservedAfter, aiMarkingJobId: jobId,
      actorId, actorRole, reason: reason || `Released reservation for cancelled/failed AI marking job #${jobId}`, idempotencyKey,
    });
    return { ledgerRow };
  });
}

/**
 * Compensating entry for a past ledger row — the only way to "correct" a
 * balance, since rows are never edited or deleted. Supported:
 *   - topup   -> debits the same amount (fails if that credit is already spent)
 *   - consume -> refunds the consumed amount to available (e.g. a bad charge)
 * Everything else is already handled by the job flows. A mandatory reason
 * is recorded; each original entry can be reversed at most once (unique
 * index on reverses_ledger_id + idempotency key `reverse:<ledgerId>`).
 */
async function reverseLedgerEntry(pool, { ledgerId, reason, actorId = null, actorRole = null }) {
  if (!reason || !String(reason).trim()) throw new AiMarkingWalletError("A reason is required to reverse a ledger entry", "REASON_REQUIRED");

  // Ledger rows are immutable, so reading the original without a lock is safe.
  const found = await pool.request()
    .input("id", sql.Int, ledgerId)
    .query(`SELECT id, wallet_id, entry_type, amount_delta, reserved_delta, ai_marking_job_id FROM ai_marking_ledger WHERE id = @id`);
  const original = found.recordset[0];
  if (!original) throw new AiMarkingWalletError(`Ledger entry #${ledgerId} not found`, "LEDGER_ENTRY_NOT_FOUND");
  if (original.entry_type !== "topup" && original.entry_type !== "consume") {
    throw new AiMarkingWalletError(`Entries of type "${original.entry_type}" cannot be reversed directly`, "NOT_REVERSIBLE");
  }

  const walletId = original.wallet_id;
  const idempotencyKey = `reverse:${ledgerId}`;
  const delta = original.entry_type === "topup"
    ? -Number(original.amount_delta)       // take the topped-up credit back
    : -Number(original.reserved_delta);    // consume rows hold -consumed in reserved_delta -> refund +consumed
  if (!(Math.abs(delta) > 0)) throw new AiMarkingWalletError("Nothing to reverse: entry moved no money", "NOT_REVERSIBLE");

  return withWalletTx(pool, { walletId, idempotencyKey, expect: { entryType: "reverse", amountDelta: delta } }, async (transaction, wallet) => {
    // Belt and braces alongside the unique index: friendlier error than a SQL violation.
    const prior = await new sql.Request(transaction)
      .input("id", sql.Int, ledgerId)
      .query(`SELECT TOP 1 id FROM ai_marking_ledger WHERE reverses_ledger_id = @id`);
    if (prior.recordset[0]) throw new AiMarkingWalletError(`Ledger entry #${ledgerId} was already reversed`, "ALREADY_REVERSED");

    if (toScaled(wallet.available_balance) + toScaled(delta) < 0) {
      throw new AiMarkingWalletError("Cannot reverse: that credit has already been spent or reserved", "INSUFFICIENT_CREDITS");
    }
    const availableAfter = addMoney(wallet.available_balance, delta);
    await new sql.Request(transaction)
      .input("id", sql.Int, walletId)
      .input("available", sql.Decimal(18, 4), availableAfter)
      .query(`UPDATE ai_marking_wallets SET available_balance = @available, updatedAt = GETDATE() WHERE id = @id`);

    const ledgerRow = await insertLedgerRow(transaction, {
      walletId, entryType: "reverse", amountDelta: delta, reservedDelta: 0,
      availableAfter, reservedAfter: Number(wallet.reserved_balance),
      aiMarkingJobId: original.ai_marking_job_id || null, reversesLedgerId: ledgerId,
      actorId, actorRole, reason: `Reversal of ledger #${ledgerId}: ${String(reason).trim()}`.slice(0, 500), idempotencyKey,
    });
    return { ledgerRow };
  });
}

/* ------------------------- reconciliation & display ------------------------- */

/**
 * Does the ledger add up to the wallet? Both balances must equal the sum
 * of their respective ledger deltas. Read-only; a mismatch means a bug or
 * out-of-band tampering and should page someone.
 */
async function reconcileWallet(pool, walletId) {
  const wallet = await getWalletSnapshot(pool, walletId);
  if (!wallet) throw new AiMarkingWalletError("Wallet not found", "WALLET_NOT_FOUND");
  const sums = await pool.request()
    .input("walletId", sql.Int, walletId)
    .query(`
      SELECT ISNULL(SUM(amount_delta), 0) AS available_sum, ISNULL(SUM(reserved_delta), 0) AS reserved_sum
      FROM ai_marking_ledger WHERE wallet_id = @walletId
    `);
  const row = sums.recordset[0] || { available_sum: 0, reserved_sum: 0 };
  const availableOk = toScaled(row.available_sum) === toScaled(wallet.available_balance);
  const reservedOk = toScaled(row.reserved_sum) === toScaled(wallet.reserved_balance);
  return {
    ok: availableOk && reservedOk,
    available: { wallet: Number(wallet.available_balance), ledger: Number(row.available_sum), ok: availableOk },
    reserved: { wallet: Number(wallet.reserved_balance), ledger: Number(row.reserved_sum), ok: reservedOk },
  };
}

/** No-lock affordability check for display purposes (e.g. disabling a button) — the authoritative check is still reserveForJob's locked read; this is never the actual gate. */
async function checkAffordability(pool, { walletId, quotedTotal }) {
  const wallet = await getWalletSnapshot(pool, walletId);
  if (!wallet) return { affordable: false, available: 0 };
  return { affordable: toScaled(wallet.available_balance) >= toScaled(quotedTotal), available: Number(wallet.available_balance) };
}

module.exports = {
  AiMarkingWalletError,
  isUniqueViolation,
  getWalletSnapshot,
  getOrCreateInstitutionWallet,
  lockWallet,
  alreadyApplied,
  insertLedgerRow,
  getActivePricing,
  normaliseVolumeDiscounts,
  computeQuote,
  setPricing,
  topUpWallet,
  reserveForJob,
  settleJob,
  releaseJobReservation,
  reverseLedgerEntry,
  reconcileWallet,
  checkAffordability,
};
