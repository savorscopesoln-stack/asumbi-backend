const sql = require("mssql");
const { describeError } = require("../utils/safeLog");
const elig = require("./aiMarkingEligibility.service");
const ledger = require("./aiMarkingLedger.service");

/* =========================================================================
   AI MARKING — JOB CREATION, RESERVATION, CANCELLATION, SETTLEMENT (Phase 4)

   This is the ONLY place that turns a teacher's confirmed quote into money
   movement. It sits between the read-only preview (aiMarkingEligibility)
   and the wallet primitives (aiMarkingLedger), and adds the parts neither
   can provide alone: claiming answers atomically, a durable job record, and
   closing a job with "charge successes only".

   NOTHING HERE CALLS AN AI PROVIDER. Processing is Phase 5/6. Until then a
   confirmed job simply sits in 'reserved'; the controller keeps job creation
   behind AI_MARKING_JOBS_ENABLED so credits are not locked up with nothing
   to process them.

   JOB STATES
     pending     row + claimed evaluations exist; credits NOT yet reserved
     reserved    credits reserved, waiting for a worker          (Phase 6 picks up)
     processing  a worker has started                            (Phase 6 sets)
     completed | failed | cancelled     terminal; ledger settled
   Every transition is a compare-and-set (UPDATE ... WHERE status = <expected>)
   so two racing actors can never both win.

   CREATE FLOW (createJob)
     1. replay check on the durable idempotency key
     2. ONE transaction:  insert job -> count -> claim answers -> price the
        claimed count -> compare with the teacher's quote fingerprint ->
        commit.  Any mismatch rolls the WHOLE thing back: no job, no claims.
        Claiming = INSERT of 'pending' evaluations using the SAME predicate
        as the preview; UQ_ai_marking_evaluations_live_answer makes it atomic
        across concurrent jobs (a loser gets SELECTION_CONFLICT).
     3. reserveForJob (its own wallet-locked transaction; idempotent on the job id)
     4. CAS pending -> reserved.
   Steps 2 and 3 cannot share a transaction without rewriting the ledger, so
   the gap is covered explicitly:
     - insufficient credits       -> claims cancelled, job cancelled (definitive)
     - crash / timeout / unknown  -> job stays 'pending'; the same request
                                     replayed RESUMES it; sweepStalledJobs()
                                     resumes or cancels it. A reservation that
                                     lands after a sweep is released by step 4's
                                     failed CAS. Credits are never lost or doubled
                                     because the reserve is keyed on the job id.

   CHARGING RULE (finalizeJob)
     charge = unit_price x answers whose evaluation is 'success' or
     'needs_review' (a validated evaluation was delivered). 'failed' and
     'cancelled' are never charged. unit_price is the price snapshotted at
     confirm time, so the charge can never exceed the quote. The rest of the
     reservation is released in the same ledger transaction (settleJob).
     See Decision D9 in the Phase 4 notes about needs_review.
========================================================================= */

class JobError extends Error {
  constructor(message, code, statusCode = 400, details = null) {
    super(message);
    this.name = "AiMarkingJobError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Reserve failures that definitively mean "no ledger row was written".
const DEFINITIVE_RESERVE_FAILURES = new Set(["INSUFFICIENT_CREDITS", "WALLET_NOT_FOUND", "INVALID_AMOUNT"]);
const BENIGN_RELEASE_CODES = new Set(["RESERVATION_NOT_FOUND", "JOB_ALREADY_CLOSED"]);

const SCALE = 10000;
const mulMoney = (unit, qty) => (Math.round(Number(unit) * SCALE) * Number(qty)) / SCALE;

function cleanKey(raw) {
  const k = typeof raw === "string" ? raw.trim() : "";
  if (!KEY_RE.test(k)) {
    throw new JobError("idempotencyKey must be 16-64 characters (letters, digits, - or _), generated once per confirmation", "INVALID_IDEMPOTENCY_KEY", 400);
  }
  return k;
}

/* ------------------------------ reads ------------------------------ */

async function readJobById(pool, jobId) {
  const r = await pool.request().input("id", sql.Int, jobId).query(`
    /*job:read*/
    SELECT id, e_assessment_id, teacher_id, selection_criteria, wallet_id, pricing_id,
           eligible_count, reserved_count, processed_count, failed_count, cancelled_count,
           unit_price, quoted_total, actual_total, currency, status, idempotency_key,
           cancel_requested, last_error, createdAt, completedAt,
           CASE WHEN paused_until IS NOT NULL AND paused_until > GETDATE() THEN 1 ELSE 0 END AS is_paused, pause_reason
    FROM ai_marking_jobs WHERE id = @id
  `);
  return r.recordset[0] || null;
}

async function readOwnedJob(pool, jobId, teacherId) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id < 1) throw new JobError("Job not found", "JOB_NOT_FOUND", 404);
  const job = await readJobById(pool, id);
  // Someone else's job is reported as "not found", never "forbidden": do not confirm it exists.
  if (!job || Number(job.teacher_id) !== Number(teacherId)) throw new JobError("Job not found", "JOB_NOT_FOUND", 404);
  return job;
}

async function findJobByKey(pool, dbKey) {
  const r = await pool.request().input("key", sql.NVarChar(100), dbKey).query(`
    /*job:find-by-key*/
    SELECT id, e_assessment_id, teacher_id, selection_criteria, wallet_id, pricing_id,
           eligible_count, reserved_count, processed_count, failed_count, cancelled_count,
           unit_price, quoted_total, actual_total, currency, status, idempotency_key,
           cancel_requested, last_error, createdAt, completedAt,
           CASE WHEN paused_until IS NOT NULL AND paused_until > GETDATE() THEN 1 ELSE 0 END AS is_paused, pause_reason
    FROM ai_marking_jobs WHERE idempotency_key = @key
  `);
  return r.recordset[0] || null;
}

/** Evaluation counts for one job (authoritative progress; the job's own counters are written at finalize). */
async function evalCounts(pool, jobId) {
  const r = await pool.request().input("jobId", sql.Int, jobId).query(`
    /*eval:counts*/
    SELECT status, COUNT(*) AS n FROM ai_marking_evaluations
    WHERE ai_marking_job_id = @jobId GROUP BY status
  `);
  const c = { pending: 0, success: 0, needs_review: 0, failed: 0, cancelled: 0 };
  for (const row of r.recordset) if (row.status in c) c[row.status] = Number(row.n);
  return c;
}

function parseSelection(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

function presentJob(job, counts = null) {
  const c = counts || { pending: 0, success: 0, needs_review: 0, failed: 0, cancelled: 0 };
  return {
    id: job.id,
    status: job.status,
    assessmentId: job.e_assessment_id ?? null,
    selection: parseSelection(job.selection_criteria),
    quote: {
      unitPrice: Number(job.unit_price),
      quotedTotal: Number(job.quoted_total),
      actualTotal: Number(job.actual_total),
      currency: job.currency,
    },
    progress: {
      eligible: Number(job.eligible_count),
      processed: c.success + c.needs_review,
      awaitingReview: c.needs_review,
      failed: c.failed,
      cancelled: c.cancelled,
      pending: c.pending,
    },
    // A provider/worker problem is paused, not failed: the answers are intact and will resume. Shown so the teacher is told.
    paused: !!job.is_paused,
    pauseReason: job.is_paused ? (job.pause_reason ?? null) : null,
    cancelRequested: !!job.cancel_requested,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
  };
}

async function getJob(pool, { jobId, teacherId }) {
  const job = await readOwnedJob(pool, jobId, teacherId);
  return presentJob(job, await evalCounts(pool, job.id));
}

async function listJobs(pool, { teacherId, limit = 25 }) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const r = await pool.request().input("teacherId", sql.Int, teacherId).input("limit", sql.Int, lim).query(`
    /*job:list*/
    SELECT TOP (@limit) id, e_assessment_id, teacher_id, selection_criteria, wallet_id, pricing_id,
           eligible_count, reserved_count, processed_count, failed_count, cancelled_count,
           unit_price, quoted_total, actual_total, currency, status, idempotency_key,
           cancel_requested, last_error, createdAt, completedAt,
           CASE WHEN paused_until IS NOT NULL AND paused_until > GETDATE() THEN 1 ELSE 0 END AS is_paused, pause_reason
    FROM ai_marking_jobs WHERE teacher_id = @teacherId ORDER BY id DESC
  `);
  const out = [];
  for (const job of r.recordset) out.push(presentJob(job, await evalCounts(pool, job.id)));
  return out;
}

/* ------------------------------ claiming ------------------------------ */

/** Facts + the shared billable predicate. Selection values are bound by applySelection, never interpolated. */
function countSql(selectionSql) {
  return `
    /*job:precount*/
    WITH f AS (${elig.answerFactsSql(selectionSql)})
    SELECT COUNT(*) AS n FROM f WHERE ${elig.BILLABLE_PREDICATE}
  `;
}

/**
 * Claim = insert a 'pending' evaluation for every currently-billable answer,
 * pinned to the CURRENTLY APPROVED scheme version (so a later scheme edit
 * cannot change what this job marks against). suggested_total/model/prompt are
 * left NULL — nothing has been evaluated yet. max_marks is the question's own
 * mark allocation, the same bound the authoritative marks_awarded must obey.
 */
function claimSql(selectionSql) {
  return `
    /*job:claim*/
    WITH f AS (${elig.answerFactsSql(selectionSql)})
    INSERT INTO ai_marking_evaluations
      (ai_marking_job_id, submission_id, question_id, answer_id, answer_content_hash,
       marking_guide_hash, scheme_version_id, max_marks, status, review_state)
    SELECT @jobId, f.submission_id, f.question_id, f.answer_id,
           LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CAST(a.essay_answer AS NVARCHAR(MAX))), 2)),
           sv.source_guide_hash, sv.id, f.question_marks, 'pending', 'awaiting_review'
    FROM f
    JOIN e_assessment_answers a ON a.id = f.answer_id
    JOIN ai_marking_scheme_versions sv ON sv.question_id = f.question_id AND sv.status = 'approved' AND sv.max_marks = f.question_marks
    WHERE ${elig.BILLABLE_PREDICATE}
  `;
}

/* ------------------------------ create ------------------------------ */

/**
 * Confirm a quote and start a job. The caller (controller) has already
 * verified the explicit `confirm: true`. Everything that matters is
 * recomputed here from the database: the client supplies a selection, the
 * fingerprint of the quote it saw, and an idempotency key — never a count
 * or a price.
 *
 * Returns { job, replayed }.
 */
async function createJob(pool, { teacherId, selection, quoteFingerprint, idempotencyKey, planCode = null }) {
  const key = cleanKey(idempotencyKey);
  if (!/^[0-9a-f]{64}$/.test(String(quoteFingerprint || ""))) {
    throw new JobError("A quote from a fresh preview is required before confirming", "QUOTE_REQUIRED", 400);
  }
  const sel = elig.normaliseSelection(selection);
  const dbKey = `job:${teacherId}:${key}`;

  // 1. replay / resume
  const existing = await findJobByKey(pool, dbKey);
  if (existing) return replay(pool, existing, sel, teacherId);

  // 2. server-side price + wallet (never from the client)
  const pricing = await ledger.getActivePricing(pool, { planCode });
  if (!pricing) throw new JobError("AI marking has no price configured", "NO_PRICE", 409);
  if (!pricing.institution_wallets_enabled) throw new JobError("AI marking is not enabled for this institution's wallet", "INSTITUTION_WALLET_DISABLED", 409);
  const wallet = await ledger.getOrCreateInstitutionWallet(pool);
  if (String(pricing.currency) !== String(wallet.currency)) {
    throw new JobError("The configured price currency does not match the wallet currency", "CURRENCY_MISMATCH", 409);
  }

  // 3. claim, price and verify in ONE transaction
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let jobId;
  let quote;
  let claimed;
  try {
    // 3a. the job row (placeholders for count/price; rewritten before commit)
    try {
      const ins = await new sql.Request(tx)
        .input("eAssessmentId", sql.Int, sel.eAssessmentId)
        .input("teacherId", sql.Int, teacherId)
        .input("selection", sql.NVarChar(sql.MAX), JSON.stringify(sel))
        .input("walletId", sql.Int, wallet.id)
        .input("currency", sql.NVarChar(10), pricing.currency)
        .input("key", sql.NVarChar(100), dbKey)
        .query(`
          /*job:insert*/
          INSERT INTO ai_marking_jobs
            (e_assessment_id, teacher_id, selection_criteria, wallet_id, unit_price, quoted_total, currency, status, idempotency_key)
          OUTPUT INSERTED.id
          VALUES (@eAssessmentId, @teacherId, @selection, @walletId, 0, 0, @currency, 'pending', @key)
        `);
      jobId = ins.recordset[0].id;
    } catch (err) {
      if (ledger.isUniqueViolation(err)) {
        // A concurrent identical request won the key. Treat ours as a replay of theirs.
        await tx.rollback().catch(() => {});
        const winner = await findJobByKey(pool, dbKey);
        if (winner) return replay(pool, winner, sel, teacherId);
      }
      throw err;
    }

    // 3b. cheap pre-count so an oversized selection never attempts a huge insert
    const countReq = new sql.Request(tx).input("teacherId", sql.Int, teacherId);
    const countWhere = elig.applySelection(countReq, sel);
    const pre = Number((await countReq.query(countSql(countWhere))).recordset[0]?.n || 0);
    if (pre === 0) throw new JobError("Nothing in this selection can be AI-marked right now", "NOTHING_ELIGIBLE", 409);
    const cap = elig.maxAnswersPerJob();
    if (pre > cap) {
      throw new JobError(`This selection has ${pre} answers; one AI marking job is limited to ${cap}. Narrow the selection (for example by question or subject) and confirm again.`, "TOO_MANY_ANSWERS", 422, { billable: pre, maxAnswersPerJob: cap });
    }

    // 3c. claim
    const claimReq = new sql.Request(tx).input("teacherId", sql.Int, teacherId).input("jobId", sql.Int, jobId);
    const claimWhere = elig.applySelection(claimReq, sel);
    try {
      const claim = await claimReq.query(claimSql(claimWhere));
      claimed = Number(claim.rowsAffected?.[0] || 0);
    } catch (err) {
      if (ledger.isUniqueViolation(err)) {
        throw new JobError("Some of these answers were just claimed by another AI marking request. Preview again.", "SELECTION_CONFLICT", 409);
      }
      throw err;
    }
    if (claimed === 0) throw new JobError("Nothing in this selection can be AI-marked right now", "NOTHING_ELIGIBLE", 409);
    if (claimed > cap) throw new JobError("Selection grew past the per-job limit; preview again", "TOO_MANY_ANSWERS", 422, { billable: claimed, maxAnswersPerJob: cap });

    // 3d. price the CLAIMED count and compare with what the teacher was shown
    quote = ledger.computeQuote(pricing, claimed);
    const fp = elig.quoteFingerprint({
      selection: sel, billable: claimed, unitPrice: quote.unitPrice, total: quote.total,
      currency: quote.currency, pricingId: quote.pricingId,
    });
    if (fp !== quoteFingerprint) {
      throw new JobError("The count or price changed since you previewed. Review the new quote and confirm again.", "QUOTE_CHANGED", 409, {
        billable: claimed, unitPrice: quote.unitPrice, total: quote.total, currency: quote.currency,
      });
    }
    if (!(quote.total > 0)) throw new JobError("The configured price is zero, so there is nothing to reserve", "ZERO_PRICE", 409);

    await new sql.Request(tx)
      .input("id", sql.Int, jobId)
      .input("eligible", sql.Int, claimed)
      .input("unit", sql.Decimal(18, 4), quote.unitPrice)
      .input("total", sql.Decimal(18, 4), quote.total)
      .input("pricingId", sql.Int, quote.pricingId)
      .query(`
        /*job:update-quote*/
        UPDATE ai_marking_jobs
        SET eligible_count = @eligible, unit_price = @unit, quoted_total = @total, pricing_id = @pricingId
        WHERE id = @id
      `);
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});   // job row + every claim vanish together
    throw err;
  }

  // 4. reserve + CAS (shared with replay/resume)
  const job = await readJobById(pool, jobId);
  await completeReservation(pool, job, teacherId);
  const fresh = await readJobById(pool, jobId);
  return { job: presentJob(fresh, await evalCounts(pool, jobId)), replayed: false };
}

async function replay(pool, existing, sel, teacherId) {
  if (Number(existing.teacher_id) !== Number(teacherId)) {
    throw new JobError("Idempotency key was already used", "IDEMPOTENCY_CONFLICT", 409);
  }
  const stored = parseSelection(existing.selection_criteria);
  if (JSON.stringify(stored) !== JSON.stringify(sel)) {
    throw new JobError("This idempotency key was already used for a different selection", "IDEMPOTENCY_CONFLICT", 409);
  }
  if (existing.status === "pending") await completeReservation(pool, existing, teacherId);   // resume a stalled create
  const job = await readJobById(pool, existing.id);
  return { job: presentJob(job, await evalCounts(pool, job.id)), replayed: true };
}

/** Reserve credits for a committed 'pending' job and flip it to 'reserved'. Safe to run repeatedly. */
async function completeReservation(pool, job, teacherId) {
  try {
    await ledger.reserveForJob(pool, {
      jobId: job.id, walletId: job.wallet_id, amount: Number(job.quoted_total),
      actorId: teacherId, actorRole: "teacher",
    });
  } catch (err) {
    if (err instanceof ledger.AiMarkingWalletError && DEFINITIVE_RESERVE_FAILURES.has(err.code)) {
      await abortUnreservedJob(pool, job.id, err.code);
      if (err.code === "INSUFFICIENT_CREDITS") throw new JobError(err.message, "INSUFFICIENT_CREDITS", 409);
      throw new JobError("The AI marking wallet could not be used for this job", err.code, 409);
    }
    // Unknown outcome (timeout, dropped connection...). The reservation may or may not exist.
    // Do NOT cancel: leave 'pending'; replay or the sweeper settles it without any double reserve.
    console.error("AI MARKING reserve outcome unknown for job", job.id, describeError(err));
    throw new JobError("We could not confirm the credit reservation. Your request is saved; retry in a moment and it will resume without being charged twice.", "RESERVATION_UNCERTAIN", 503);
  }

  const cas = await pool.request().input("id", sql.Int, job.id).query(`
    /*job:cas-reserved*/
    UPDATE ai_marking_jobs SET status = 'reserved', reserved_count = eligible_count
    WHERE id = @id AND status = 'pending'
  `);
  if (!cas.rowsAffected?.[0]) {
    const current = await readJobById(pool, job.id);
    if (current && current.status === "reserved") return;          // someone else already completed it (replay race)
    await releaseQuietly(pool, job);                               // lost to a sweep/cancel: give the credits back
    throw new JobError("This job is no longer active", "JOB_NOT_ACTIVE", 409);
  }
}

/** Cancel a job that never reserved: claims -> 'cancelled', job -> 'cancelled'. CAS on 'pending'. */
async function abortUnreservedJob(pool, jobId, reasonCode) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const j = await new sql.Request(tx)
      .input("id", sql.Int, jobId).input("code", sql.NVarChar(1000), reasonCode)
      .query(`
        /*job:abort*/
        UPDATE ai_marking_jobs
        SET status = 'cancelled', cancelled_count = eligible_count, last_error = @code, completedAt = GETDATE()
        WHERE id = @id AND status = 'pending'
      `);
    const won = Number(j.rowsAffected?.[0] || 0) > 0;
    if (won) {
      await new sql.Request(tx).input("id", sql.Int, jobId).input("code", sql.NVarChar(1000), reasonCode).query(`
        /*eval:cancel-pending*/
        UPDATE ai_marking_evaluations SET status = 'cancelled', last_error = @code, completed_at = GETDATE()
        WHERE ai_marking_job_id = @id AND status = 'pending'
      `);
    }
    await tx.commit();
    return won;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/** Return a job's reservation if it has one; "nothing to release" is not an error. */
async function releaseQuietly(pool, job, reason = null) {
  try {
    await ledger.releaseJobReservation(pool, { jobId: job.id, walletId: job.wallet_id, reason, actorRole: "system" });
    return true;
  } catch (err) {
    if (err instanceof ledger.AiMarkingWalletError && BENIGN_RELEASE_CODES.has(err.code)) return false;
    throw err;
  }
}

/* ------------------------------ finalize / settle ------------------------------ */

/**
 * Close a job: charge for successful evaluations, release everything else,
 * and move the job to its terminal state. Idempotent and crash-safe: the
 * ledger settle is keyed on the job id, and the terminal status is written
 * last, so re-running after a crash between the two simply finishes the job.
 * Callable by the worker (Phase 6), by cancelJob, or by an operator.
 */
async function finalizeJob(pool, { jobId, actorId = null, actorRole = "system" }) {
  const job = await readJobById(pool, jobId);
  if (!job) throw new JobError("Job not found", "JOB_NOT_FOUND", 404);
  if (TERMINAL.has(job.status)) return { job: presentJob(job, await evalCounts(pool, job.id)), alreadyFinal: true };
  if (job.status === "pending") throw new JobError("Job has no reservation yet", "JOB_NOT_RESERVED", 409);

  if (job.cancel_requested) {
    await pool.request().input("id", sql.Int, job.id).query(`
      /*eval:cancel-pending*/
      UPDATE ai_marking_evaluations SET status = 'cancelled', completed_at = GETDATE()
      WHERE ai_marking_job_id = @id AND status = 'pending'
    `);
  }
  const c = await evalCounts(pool, job.id);
  if (c.pending > 0) throw new JobError("Job still has unprocessed answers", "JOB_NOT_FINISHED", 409, { pending: c.pending });

  const processed = c.success + c.needs_review;
  if (processed > Number(job.eligible_count)) {
    throw new JobError("More successful evaluations than claimed answers; refusing to settle", "JOB_INVARIANT_VIOLATED", 500);
  }
  const actual = mulMoney(job.unit_price, processed);
  if (actual > Number(job.quoted_total)) {
    throw new JobError("Settlement would exceed the quote; refusing to settle", "JOB_INVARIANT_VIOLATED", 500);
  }

  const settle = await ledger.settleJob(pool, { jobId: job.id, walletId: job.wallet_id, actualAmount: actual, actorId, actorRole });
  // The ledger is the truth for what was consumed (matters on the already-applied retry path).
  const consumed = Math.abs(Number(settle.ledgerRow.reserved_delta));
  if (settle.alreadyApplied && Math.round(consumed * SCALE) !== Math.round(actual * SCALE)) {
    console.error(`AI MARKING: job ${job.id} was settled earlier for ${consumed}, evaluations now imply ${actual}; keeping the ledger figure`);
  }

  const finalStatus = job.cancel_requested ? "cancelled" : processed === 0 ? "failed" : "completed";
  await pool.request()
    .input("id", sql.Int, job.id).input("status", sql.NVarChar(20), finalStatus)
    .input("processed", sql.Int, processed).input("failed", sql.Int, c.failed).input("cancelled", sql.Int, c.cancelled)
    .input("actual", sql.Decimal(18, 4), consumed)
    .query(`
      /*job:finalize*/
      UPDATE ai_marking_jobs
      SET status = @status, processed_count = @processed, failed_count = @failed, cancelled_count = @cancelled,
          actual_total = @actual, completedAt = GETDATE()
      WHERE id = @id AND status IN ('reserved','processing')
    `);
  const done = await readJobById(pool, job.id);
  return { job: presentJob(done, await evalCounts(pool, job.id)), alreadyFinal: false };
}

/* ------------------------------ cancel ------------------------------ */

/**
 * Teacher cancels their own job. Unprocessed answers are cancelled (never
 * charged) and their share of the reservation returns to the wallet;
 * evaluations that already succeeded stay and are charged. A worker that is
 * mid-answer loses its compare-and-set (status is no longer 'pending') and its
 * result is discarded, so a cancelled answer can never be billed.
 */
async function cancelJob(pool, { jobId, teacherId }) {
  const job = await readOwnedJob(pool, jobId, teacherId);
  if (TERMINAL.has(job.status)) return { job: presentJob(job, await evalCounts(pool, job.id)), alreadyFinal: true };

  if (job.status === "pending") {
    await abortUnreservedJob(pool, job.id, "CANCELLED_BY_TEACHER");
    await releaseQuietly(pool, job, "Cancelled by teacher before reservation completed");
    const after = await readJobById(pool, job.id);
    return { job: presentJob(after, await evalCounts(pool, job.id)), alreadyFinal: false };
  }

  await pool.request().input("id", sql.Int, job.id).query(`
    /*job:request-cancel*/
    UPDATE ai_marking_jobs SET cancel_requested = 1 WHERE id = @id AND status IN ('reserved','processing')
  `);
  return finalizeJob(pool, { jobId: job.id, actorId: teacherId, actorRole: "teacher" });
}

/* ------------------------------ recovery ------------------------------ */

/**
 * Settle jobs stuck in 'pending' (process died between commit and reserve, or
 * the reserve outcome was unknown). A job that DID reserve is resumed; one that
 * did not is cancelled and its claims freed. Safe to run on any schedule and
 * from several processes: every step is a compare-and-set.
 * Intended caller: a per-tenant ticker added in Phase 6 (not wired here).
 */
async function sweepStalledJobs(pool, { olderThanMinutes = 10 } = {}) {
  const stale = await pool.request().input("minutes", sql.Int, olderThanMinutes).query(`
    /*job:stale*/
    SELECT id, wallet_id FROM ai_marking_jobs
    WHERE status = 'pending' AND createdAt < DATEADD(MINUTE, -@minutes, GETDATE())
  `);
  const out = { resumed: 0, cancelled: 0 };
  for (const job of stale.recordset) {
    const has = await pool.request().input("id", sql.Int, job.id).query(`
      /*ledger:has-reserve*/
      SELECT COUNT(*) AS n FROM ai_marking_ledger WHERE ai_marking_job_id = @id AND entry_type = 'reserve'
    `);
    if (Number(has.recordset[0]?.n || 0) > 0) {
      const cas = await pool.request().input("id", sql.Int, job.id).query(`
        /*job:cas-reserved*/
        UPDATE ai_marking_jobs SET status = 'reserved', reserved_count = eligible_count
        WHERE id = @id AND status = 'pending'
      `);
      if (cas.rowsAffected?.[0]) out.resumed += 1;
    } else if (await abortUnreservedJob(pool, job.id, "STALLED_BEFORE_RESERVATION")) {
      // A reserve may land between the check and the abort; its own CAS then fails and releases it.
      await releaseQuietly(pool, job, "Released stalled AI marking job");
      out.cancelled += 1;
    }
  }
  return out;
}

module.exports = {
  JobError, createJob, getJob, listJobs, cancelJob, finalizeJob, sweepStalledJobs,
  // exported for tests / Phase 6
  presentJob, countSql, claimSql, mulMoney,
};
