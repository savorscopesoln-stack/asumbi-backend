const sql = require("mssql");
const { generateUniqueReference } = require("../utils/creditReference");
const { logFinanceAudit } = require("../utils/financeAuditLog");

/* =========================================================================
   WALLET LEDGER SERVICE

   The single place institution_wallets.available_credits /
   reserved_credits are ever written from. Nothing else — no
   controller, no route — updates those two columns directly. That's
   the whole point of this file: one code path, so "atomic,
   concurrency-safe and idempotent" (spec, Phase 2) only has to be true
   in one place instead of re-proven in every caller.

   CONCURRENCY: every function here opens a `new sql.Transaction(pool)`
   (same pattern as mainExam.controller.js's setReportCardExam) and
   takes the wallet row with `WITH (UPDLOCK, HOLDLOCK)` as its first
   statement inside that transaction. UPDLOCK stops two concurrent
   callers from both reading the same "available_credits = 40" and
   both deciding they can afford a 30-credit reservation; HOLDLOCK
   (equivalent to SERIALIZABLE on that row) holds the lock until
   commit/rollback rather than releasing it the instant the SELECT
   finishes. This is exactly the "two admins allocating credits
   simultaneously" / "multiple examinations competing for the same
   wallet balance" scenarios from the spec's test list — the second
   transaction simply blocks on the row lock until the first commits
   or rolls back, then sees the up-to-date balance.

   IDEMPOTENCY: every wallet_ledger insert here takes an
   idempotencyKey. wallet_ledger has a unique filtered index on that
   column (ensureSchema.js). Callers that might retry a logical
   operation (a webhook/callback retry, a double-click, a network
   retry after a timed-out response) should pass a stable key derived
   from the operation's own identity (e.g. `issue:${issuanceId}`,
   `reserve:${mainExaminationId}:${studentId}`) — a retry with the same
   key hits the unique-index violation, which every function here
   catches and treats as "already applied, return the existing state"
   rather than an error.

   NOTHING here decides WHETHER a reservation/issuance/release SHOULD
   happen — that's the calling controller's job (Phase 3/4/5: checking
   role, checking exam status, checking cohort eligibility). This file
   only makes sure that once a caller has decided to do it, the
   balance change itself cannot be double-applied, cannot go negative,
   and cannot half-apply under concurrent load.
========================================================================= */

class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletError";
    this.code = code; // 'INSUFFICIENT_CREDITS' | 'DUPLICATE_ENTITLEMENT' | 'ALREADY_APPLIED' | ...
  }
}

/** Read the current wallet snapshot (no lock — for display only, never for a check-then-act decision). */
async function getWalletSnapshot(pool) {
  const result = await pool.request().query(`
    SELECT id, available_credits, reserved_credits, total_purchased, total_allocated, updatedAt
    FROM institution_wallets WHERE id = 1
  `);
  return result.recordset[0] || null;
}

/** Lock and read the wallet row inside an already-open transaction. Always the first statement of any mutating transaction below. */
async function lockWallet(transaction) {
  const result = await new sql.Request(transaction).query(`
    SELECT id, available_credits, reserved_credits, total_purchased, total_allocated
    FROM institution_wallets WITH (UPDLOCK, HOLDLOCK)
    WHERE id = 1
  `);
  return result.recordset[0];
}

/** Was this idempotency key already applied? (checked inside the transaction, right after the lock, before any other write.) */
async function alreadyApplied(transaction, idempotencyKey) {
  if (!idempotencyKey) return null;
  const result = await new sql.Request(transaction)
    .input("key", sql.NVarChar(100), idempotencyKey)
    .query(`SELECT TOP 1 id, entry_type, credit_delta, available_after, reserved_after FROM wallet_ledger WHERE idempotency_key = @key`);
  return result.recordset[0] || null;
}

async function insertLedgerRow(transaction, {
  entryType, creditDelta, availableAfter, reservedAfter,
  mainExaminationId = null, studentId = null, creditIssuanceId = null,
  actorId = null, actorRole = null, reason = null, idempotencyKey = null,
}) {
  const result = await new sql.Request(transaction)
    .input("entryType", sql.NVarChar(30), entryType)
    .input("creditDelta", sql.Int, creditDelta)
    .input("availableAfter", sql.Int, availableAfter)
    .input("reservedAfter", sql.Int, reservedAfter)
    .input("mainExaminationId", sql.Int, mainExaminationId)
    .input("studentId", sql.Int, studentId)
    .input("creditIssuanceId", sql.Int, creditIssuanceId)
    .input("actorId", sql.Int, actorId)
    .input("actorRole", sql.NVarChar(30), actorRole)
    .input("reason", sql.NVarChar(500), reason)
    .input("idempotencyKey", sql.NVarChar(100), idempotencyKey)
    .query(`
      INSERT INTO wallet_ledger
        (entry_type, credit_delta, available_after, reserved_after, main_examination_id,
         student_id, credit_issuance_id, actor_id, actor_role, reason, idempotency_key)
      OUTPUT INSERTED.id
      VALUES
        (@entryType, @creditDelta, @availableAfter, @reservedAfter, @mainExaminationId,
         @studentId, @creditIssuanceId, @actorId, @actorRole, @reason, @idempotencyKey)
    `);
  return result.recordset[0].id;
}

/* =========================================================================
   ISSUE CREDITS — Doravo Finance deposits verified credits into the
   institution's wallet. Two-step by design (create the issuance row,
   THEN apply it) so this survives "Finance deposit interrupted between
   control and tenant databases" (spec test 15): if the process dies
   between the two steps, the issuance row is left 'pending' and a
   reconciliation pass (Phase 3 finance dashboard) can safely retry
   `applyIssuance` — it's idempotent on issuanceReference.
========================================================================= */

/** Step 1: record that Finance verified a payment and is issuing N credits. Does NOT touch the wallet balance yet. */
async function createIssuance(pool, { institutionPaymentId = null, creditQuantity, unitPrice = null, currency = "KES", issuedBy, notes = null }) {
  if (!Number.isInteger(creditQuantity) || creditQuantity <= 0) {
    throw new WalletError("Credit quantity must be a positive integer", "INVALID_QUANTITY");
  }
  const issuanceReference = await generateUniqueReference(pool, "credit_issuances", "issuance_reference", "CR");
  const result = await pool.request()
    .input("issuanceReference", sql.NVarChar(40), issuanceReference)
    .input("institutionPaymentId", sql.Int, institutionPaymentId)
    .input("creditQuantity", sql.Int, creditQuantity)
    .input("unitPrice", sql.Decimal(18, 2), unitPrice)
    .input("currency", sql.NVarChar(3), currency)
    .input("issuedBy", sql.Int, issuedBy)
    .input("notes", sql.NVarChar(500), notes)
    .query(`
      INSERT INTO credit_issuances
        (issuance_reference, institution_payment_id, credit_quantity, unit_price, currency, state, issued_by, notes)
      OUTPUT INSERTED.id, INSERTED.issuance_reference
      VALUES
        (@issuanceReference, @institutionPaymentId, @creditQuantity, @unitPrice, @currency, 'pending', @issuedBy, @notes)
    `);
  return result.recordset[0]; // { id, issuance_reference }
}

/** Step 2: apply a 'pending' (or retry a 'failed') issuance to the wallet. Idempotent on the issuance's own reference. */
async function applyIssuance(pool, { issuanceId, actorId = null, actorRole = null }) {
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const issuanceResult = await new sql.Request(transaction)
      .input("id", sql.Int, issuanceId)
      .query(`SELECT id, issuance_reference, credit_quantity, state FROM credit_issuances WITH (UPDLOCK) WHERE id = @id`);
    const issuance = issuanceResult.recordset[0];
    if (!issuance) throw new WalletError("Credit issuance not found", "NOT_FOUND");
    if (issuance.state === "delivered" || issuance.state === "reconciled") {
      await transaction.rollback();
      return { alreadyApplied: true, issuance };
    }

    const idempotencyKey = `issue:${issuance.issuance_reference}`;
    const existing = await alreadyApplied(transaction, idempotencyKey);
    if (existing) {
      // Ledger already has this issuance's entry (e.g. a crashed prior
      // attempt got as far as the ledger insert but not the state
      // update) — finish reconciling the issuance row and stop.
      await new sql.Request(transaction)
        .input("id", sql.Int, issuanceId)
        .query(`UPDATE credit_issuances SET state = 'delivered', delivered_at = ISNULL(delivered_at, GETDATE()) WHERE id = @id`);
      await transaction.commit();
      return { alreadyApplied: true, issuance };
    }

    const wallet = await lockWallet(transaction);
    const newAvailable = wallet.available_credits + issuance.credit_quantity;
    const newTotalPurchased = wallet.total_purchased + issuance.credit_quantity;

    await new sql.Request(transaction)
      .input("available", sql.Int, newAvailable)
      .input("totalPurchased", sql.Int, newTotalPurchased)
      .query(`
        UPDATE institution_wallets
        SET available_credits = @available, total_purchased = @totalPurchased, updatedAt = GETDATE()
        WHERE id = 1
      `);

    const ledgerId = await insertLedgerRow(transaction, {
      entryType: "issue",
      creditDelta: issuance.credit_quantity,
      availableAfter: newAvailable,
      reservedAfter: wallet.reserved_credits,
      creditIssuanceId: issuance.id,
      actorId, actorRole,
      idempotencyKey,
    });

    await new sql.Request(transaction)
      .input("id", sql.Int, issuanceId)
      .query(`UPDATE credit_issuances SET state = 'delivered', delivered_at = GETDATE() WHERE id = @id`);

    await transaction.commit();

    await logFinanceAudit(pool, {
      action: "credits_issued",
      creditIssuanceId: issuance.id,
      walletLedgerId: ledgerId,
      actorId, actorRole,
      details: { issuance_reference: issuance.issuance_reference, credit_quantity: issuance.credit_quantity },
    });

    return { alreadyApplied: false, issuance, availableCredits: newAvailable };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    if (err instanceof WalletError) throw err;
    throw err;
  }
}

/* =========================================================================
   REVERSE (UNUSED) CREDITS — a compensating transaction, never a
   deletion of the original issuance (spec: "Never delete financial
   ledger entries; use compensating transactions for reversals").
   Only ever reduces available_credits, and only by up to what's
   currently available AND up to what that issuance hasn't already had
   reversed — reversing more credits than are sitting unreserved is
   refused outright rather than pulling from reserved credits, since
   those are already committed to a specific student+exam.
========================================================================= */
async function reverseIssuance(pool, { issuanceId, quantity, reason, actorId = null, actorRole = null }) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new WalletError("Reversal quantity must be a positive integer", "INVALID_QUANTITY");
  }
  if (!reason || !reason.trim()) {
    throw new WalletError("A reason is required to reverse credits", "REASON_REQUIRED");
  }
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const issuanceResult = await new sql.Request(transaction)
      .input("id", sql.Int, issuanceId)
      .query(`SELECT id, issuance_reference, credit_quantity, reversed_quantity, state FROM credit_issuances WITH (UPDLOCK) WHERE id = @id`);
    const issuance = issuanceResult.recordset[0];
    if (!issuance) throw new WalletError("Credit issuance not found", "NOT_FOUND");
    if (issuance.state !== "delivered" && issuance.state !== "reconciled") {
      throw new WalletError("Only a delivered issuance can be reversed", "INVALID_STATE");
    }
    const remainingReversible = issuance.credit_quantity - issuance.reversed_quantity;
    if (quantity > remainingReversible) {
      throw new WalletError(`Cannot reverse ${quantity} credits — only ${remainingReversible} of this issuance remain unreversed`, "EXCEEDS_ISSUANCE");
    }

    const wallet = await lockWallet(transaction);
    if (quantity > wallet.available_credits) {
      throw new WalletError(`Cannot reverse ${quantity} credits — only ${wallet.available_credits} are currently available (unreserved)`, "INSUFFICIENT_AVAILABLE");
    }

    const newAvailable = wallet.available_credits - quantity;

    await new sql.Request(transaction)
      .input("available", sql.Int, newAvailable)
      .query(`UPDATE institution_wallets SET available_credits = @available, updatedAt = GETDATE() WHERE id = 1`);

    await new sql.Request(transaction)
      .input("id", sql.Int, issuanceId)
      .input("reversedQuantity", sql.Int, issuance.reversed_quantity + quantity)
      .query(`UPDATE credit_issuances SET reversed_quantity = @reversedQuantity WHERE id = @id`);

    const ledgerId = await insertLedgerRow(transaction, {
      entryType: "reverse",
      creditDelta: -quantity,
      availableAfter: newAvailable,
      reservedAfter: wallet.reserved_credits,
      creditIssuanceId: issuance.id,
      actorId, actorRole, reason,
    });

    await transaction.commit();

    await logFinanceAudit(pool, {
      action: "credits_reversed",
      creditIssuanceId: issuance.id,
      walletLedgerId: ledgerId,
      actorId, actorRole,
      details: { issuance_reference: issuance.issuance_reference, quantity, reason },
    });

    return { availableCredits: newAvailable };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

/* =========================================================================
   RESERVE CREDITS FOR A COHORT — the exam-creation gate (Phase 5 will
   call this from controllers/mainExam.controller.js's
   createMainExamination). Reserves exactly one credit per student in
   `studentIds` for `mainExaminationId`, or reserves NONE of them if
   the wallet can't cover the whole cohort (spec: "reject creation and
   show the credit shortfall" — an exam is never partially funded).
   Duplicate students in the input, or a student who already holds a
   non-released entitlement for this exam, are rejected before any
   balance change — caught by both an application-level check and the
   DB's own filtered unique index as the hard backstop.
========================================================================= */
async function reserveCreditsForStudents(pool, { mainExaminationId, studentIds, actorId = null, actorRole = null }) {
  const uniqueStudentIds = [...new Set(studentIds)];
  if (uniqueStudentIds.length === 0) {
    throw new WalletError("No eligible students to reserve credits for", "NO_STUDENTS");
  }

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    // Any of these students already actively entitled for this exam? (belt-and-braces alongside the unique filtered index.)
    const idList = uniqueStudentIds.join(",");
    const dupeCheck = await new sql.Request(transaction)
      .input("mainExaminationId", sql.Int, mainExaminationId)
      .query(`
        SELECT student_id FROM student_exam_entitlements WITH (UPDLOCK, HOLDLOCK)
        WHERE main_examination_id = @mainExaminationId
          AND status <> 'released'
          AND student_id IN (${idList})
      `);
    if (dupeCheck.recordset.length) {
      throw new WalletError(
        `${dupeCheck.recordset.length} of these students already have an active entitlement for this examination`,
        "DUPLICATE_ENTITLEMENT"
      );
    }

    const wallet = await lockWallet(transaction);
    const needed = uniqueStudentIds.length;
    if (wallet.available_credits < needed) {
      throw new WalletError(
        `Insufficient credits: need ${needed}, only ${wallet.available_credits} available`,
        "INSUFFICIENT_CREDITS"
      );
    }

    const newAvailable = wallet.available_credits - needed;
    const newReserved = wallet.reserved_credits + needed;
    const newTotalAllocated = wallet.total_allocated + needed;

    await new sql.Request(transaction)
      .input("available", sql.Int, newAvailable)
      .input("reserved", sql.Int, newReserved)
      .input("totalAllocated", sql.Int, newTotalAllocated)
      .query(`
        UPDATE institution_wallets
        SET available_credits = @available, reserved_credits = @reserved, total_allocated = @totalAllocated, updatedAt = GETDATE()
        WHERE id = 1
      `);

    let runningAvailable = wallet.available_credits;
    let runningReserved = wallet.reserved_credits;
    for (const studentId of uniqueStudentIds) {
      await new sql.Request(transaction)
        .input("studentId", sql.Int, studentId)
        .input("mainExaminationId", sql.Int, mainExaminationId)
        .input("allocatedBy", sql.Int, actorId)
        .query(`
          INSERT INTO student_exam_entitlements (student_id, main_examination_id, status, allocated_by)
          VALUES (@studentId, @mainExaminationId, 'reserved', @allocatedBy)
        `);

      runningAvailable -= 1;
      runningReserved += 1;
      await insertLedgerRow(transaction, {
        entryType: "reserve",
        creditDelta: -1,
        availableAfter: runningAvailable,
        reservedAfter: runningReserved,
        mainExaminationId, studentId,
        actorId, actorRole,
        idempotencyKey: `reserve:${mainExaminationId}:${studentId}`,
      });
    }

    await transaction.commit();
    return { reserved: needed, availableCredits: newAvailable, reservedCredits: newReserved };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    if (err.number === 2601 || err.number === 2627) {
      // Unique-index violation on the filtered UQ_student_exam_entitlements_active
      // index — a concurrent request won the race for the same student+exam.
      throw new WalletError("One or more students were just allocated to this examination by another request", "DUPLICATE_ENTITLEMENT");
    }
    throw err;
  }
}

/* =========================================================================
   RELEASE A RESERVATION — an unused reservation is freed (student
   removed from a funded exam before it ran, or the exam was cancelled
   before completion) and the credit genuinely returns to
   available_credits, per spec. Only a 'reserved' entitlement can be
   released — an already-'consumed' one is spent and not reversible
   through this path (that's a Finance-side reverseIssuance decision,
   not an automatic release).
========================================================================= */
async function releaseEntitlement(pool, { studentId, mainExaminationId, reason, actorId = null, actorRole = null }) {
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const entitlementResult = await new sql.Request(transaction)
      .input("studentId", sql.Int, studentId)
      .input("mainExaminationId", sql.Int, mainExaminationId)
      .query(`
        SELECT id, status FROM student_exam_entitlements WITH (UPDLOCK)
        WHERE student_id = @studentId AND main_examination_id = @mainExaminationId AND status = 'reserved'
      `);
    const entitlement = entitlementResult.recordset[0];
    if (!entitlement) {
      await transaction.rollback();
      return { released: false, reason: "No active reserved entitlement found" };
    }

    const wallet = await lockWallet(transaction);
    const newAvailable = wallet.available_credits + 1;
    const newReserved = wallet.reserved_credits - 1;

    await new sql.Request(transaction)
      .input("available", sql.Int, newAvailable)
      .input("reserved", sql.Int, newReserved)
      .query(`
        UPDATE institution_wallets
        SET available_credits = @available, reserved_credits = @reserved, updatedAt = GETDATE()
        WHERE id = 1
      `);

    await new sql.Request(transaction)
      .input("id", sql.Int, entitlement.id)
      .input("releaseReason", sql.NVarChar(300), reason || null)
      .query(`
        UPDATE student_exam_entitlements
        SET status = 'released', released_at = GETDATE(), release_reason = @releaseReason, updatedAt = GETDATE()
        WHERE id = @id
      `);

    await insertLedgerRow(transaction, {
      entryType: "release",
      creditDelta: 1,
      availableAfter: newAvailable,
      reservedAfter: newReserved,
      mainExaminationId, studentId,
      actorId, actorRole, reason,
      idempotencyKey: `release:${mainExaminationId}:${studentId}:${entitlement.id}`,
    });

    await transaction.commit();
    return { released: true, availableCredits: newAvailable, reservedCredits: newReserved };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

/* =========================================================================
   CONSUME RESERVATIONS — a funded examination's reserved credits are
   realized (the exam actually ran to completion). reserved_credits
   goes down; available_credits does NOT go up — the credit was spent,
   not freed (this is what makes "Already funded examinations continue
   normally even if available wallet credits become zero" safe: their
   credits were reserved, not available, from the moment of funding,
   and consuming them never touches available_credits at all).
   Idempotent per student — already-'consumed' rows are silently
   skipped, so this is safe to call again on a retry.
========================================================================= */
async function consumeEntitlementsForExam(pool, { mainExaminationId, actorId = null, actorRole = null }) {
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const reservedResult = await new sql.Request(transaction)
      .input("mainExaminationId", sql.Int, mainExaminationId)
      .query(`
        SELECT id, student_id FROM student_exam_entitlements WITH (UPDLOCK)
        WHERE main_examination_id = @mainExaminationId AND status = 'reserved'
      `);
    const rows = reservedResult.recordset;
    if (rows.length === 0) {
      await transaction.rollback();
      return { consumed: 0 };
    }

    const wallet = await lockWallet(transaction);
    const newReserved = wallet.reserved_credits - rows.length;

    await new sql.Request(transaction)
      .input("reserved", sql.Int, newReserved)
      .query(`UPDATE institution_wallets SET reserved_credits = @reserved, updatedAt = GETDATE() WHERE id = 1`);

    let runningReserved = wallet.reserved_credits;
    for (const row of rows) {
      await new sql.Request(transaction)
        .input("id", sql.Int, row.id)
        .query(`UPDATE student_exam_entitlements SET status = 'consumed', consumed_at = GETDATE(), updatedAt = GETDATE() WHERE id = @id`);

      runningReserved -= 1;
      await insertLedgerRow(transaction, {
        entryType: "consume",
        creditDelta: 0,
        availableAfter: wallet.available_credits,
        reservedAfter: runningReserved,
        mainExaminationId, studentId: row.student_id,
        actorId, actorRole,
        idempotencyKey: `consume:${mainExaminationId}:${row.student_id}`,
      });
    }

    await transaction.commit();
    return { consumed: rows.length, reservedCredits: newReserved };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

/** How many credits would a given list of (as-yet-unallocated) student IDs need? Read-only helper for the frontend's "shortfall" display — never used as the actual gate (that's reserveCreditsForStudents's own atomic check). */
async function checkAffordability(pool, { mainExaminationId, studentIds }) {
  const uniqueStudentIds = [...new Set(studentIds)];
  const wallet = await getWalletSnapshot(pool);
  const idList = uniqueStudentIds.length ? uniqueStudentIds.join(",") : "-1";
  const already = await pool.request()
    .input("mainExaminationId", sql.Int, mainExaminationId)
    .query(`
      SELECT student_id FROM student_exam_entitlements
      WHERE main_examination_id = @mainExaminationId AND status <> 'released' AND student_id IN (${idList})
    `);
  const alreadyEntitled = new Set(already.recordset.map(r => r.student_id));
  const needed = uniqueStudentIds.filter(id => !alreadyEntitled.has(id)).length;
  return {
    needed,
    available: wallet.available_credits,
    sufficient: wallet.available_credits >= needed,
    shortfall: Math.max(0, needed - wallet.available_credits),
    alreadyEntitledCount: alreadyEntitled.size,
  };
}

module.exports = {
  WalletError,
  getWalletSnapshot,
  createIssuance,
  applyIssuance,
  reverseIssuance,
  reserveCreditsForStudents,
  releaseEntitlement,
  consumeEntitlementsForExam,
  checkAffordability,
};
