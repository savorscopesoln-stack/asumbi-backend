const sql = require("mssql");
const { describeError } = require("../utils/safeLog");
const { getPool } = require("../config/db");
const { assertValidTenant } = require("./finance.controller");
const { logFinanceAudit } = require("../utils/financeAuditLog");
const ledger = require("../services/aiMarkingLedger.service");

const { AiMarkingWalletError } = ledger;

/* =========================================================================
   DORAVO FINANCE — AI MARKING WALLET & PRICING

   Same shape as finance.controller.js, deliberately: every handler takes
   a `:tenantKey`, validates it with the SAME assertValidTenant, opens that
   tenant's pool with getPool(tenantKey) (never req.pool), and is mounted
   behind protect + financeOnly (routes/finance.js — strict role check, no
   admin bypass). An institution administrator therefore cannot top up a
   wallet or change the price they are charged.

   These credits are the AI-marking wallet ONLY. Nothing here can touch
   institution_wallets / exam credits (separate tables, separate service).

   Audit: each mutating action is also written to finance_audit_log
   (best-effort, after the money-moving transaction commits — the same
   convention as the exam wallet). The AI ledger row is the financial
   source of truth; the audit-log row is for the Finance activity feed.
========================================================================= */

const STATUS_BY_CODE = {
  WALLET_NOT_FOUND: 404,
  LEDGER_ENTRY_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_REVERSED: 409,
  INSUFFICIENT_CREDITS: 409,
};

function sendError(res, err, fallbackMessage) {
  if (err instanceof AiMarkingWalletError) {
    return res.status(STATUS_BY_CODE[err.code] || 400).json({ success: false, message: err.message, code: err.code });
  }
  const status = err.statusCode || 500;
  if (status >= 500) console.error("FINANCE AI MARKING ERROR:", describeError(err)); // 4xx (e.g. unknown tenant) is the caller's mistake, not an incident
  return res.status(status).json({ success: false, message: err.message || fallbackMessage });
}

async function institutionWallet(pool) {
  return ledger.getOrCreateInstitutionWallet(pool);
}

/* ---------------- OVERVIEW: wallet + reconciliation + active price ---------------- */
const getAiMarkingOverview = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const wallet = await institutionWallet(pool);
    const [reconciliation, pricing] = await Promise.all([
      ledger.reconcileWallet(pool, wallet.id),
      ledger.getActivePricing(pool, { planCode: req.query.planCode || null }),
    ]);
    res.json({ success: true, wallet, reconciliation, activePricing: pricing });
  } catch (err) {
    sendError(res, err, "Server error loading AI marking wallet");
  }
};

/* ---------------- LEDGER (paged, newest first) ---------------- */
const listAiMarkingLedger = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const wallet = await institutionWallet(pool);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const result = await pool.request()
      .input("walletId", sql.Int, wallet.id)
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit) id, entry_type, amount_delta, reserved_delta, available_after, reserved_after,
               ai_marking_job_id, finance_reference, reverses_ledger_id, actor_id, actor_role, reason, createdAt
        FROM ai_marking_ledger WHERE wallet_id = @walletId ORDER BY id DESC
      `);
    res.json({ success: true, ledger: result.recordset });
  } catch (err) {
    sendError(res, err, "Server error loading AI marking ledger");
  }
};

/* ---------------- PRICING HISTORY ---------------- */
const listAiMarkingPricing = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const result = await pool.request().query(`
      SELECT id, price_per_answer, currency, volume_discount_json, institution_wallets_enabled,
             teacher_wallets_enabled, plan_code, effective_from, set_by, notes, createdAt
      FROM ai_marking_pricing ORDER BY effective_from DESC, id DESC
    `);
    res.json({ success: true, pricing: result.recordset });
  } catch (err) {
    sendError(res, err, "Server error loading AI marking pricing");
  }
};

/* ---------------- SET PRICE (append-only; never edits history) ---------------- */
const setAiMarkingPricing = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const {
      pricePerAnswer, currency = "KES", volumeDiscounts = null,
      institutionWalletsEnabled = true, teacherWalletsEnabled = false,
      effectiveFrom = null, planCode = null, notes = null, confirm,
    } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({ success: false, message: "Changing the AI marking price requires explicit confirmation" });
    }
    const pool = await getPool(tenantKey);
    const row = await ledger.setPricing(pool, {
      pricePerAnswer, currency, volumeDiscounts, institutionWalletsEnabled, teacherWalletsEnabled,
      effectiveFrom, planCode, setBy: req.user?.id || null, notes,
    });
    await logFinanceAudit(pool, {
      action: "ai_marking_price_set", actorId: req.user?.id, actorRole: req.user?.role,
      details: { pricingId: row.id, pricePerAnswer: Number(row.price_per_answer), currency: row.currency, planCode: row.plan_code, effectiveFrom: row.effective_from },
    });
    res.status(201).json({ success: true, pricing: row });
  } catch (err) {
    sendError(res, err, "Server error saving AI marking price");
  }
};

/* ---------------- TOP UP (manual, after Finance verified payment out-of-band) ---------------- */
const topUpAiMarkingWallet = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const { amount, financeReference, notes = null, confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({ success: false, message: "Top-up requires explicit confirmation" });
    }
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return res.status(400).json({ success: false, message: "A positive top-up amount is required", code: "INVALID_AMOUNT" });
    }
    const pool = await getPool(tenantKey);
    const wallet = await institutionWallet(pool);
    const result = await ledger.topUpWallet(pool, {
      walletId: wallet.id, amount: numeric, financeReference,
      actorId: req.user?.id || null, actorRole: req.user?.role || null, notes,
    });
    if (!result.alreadyApplied) {
      await logFinanceAudit(pool, {
        action: "ai_marking_topup", actorId: req.user?.id, actorRole: req.user?.role,
        details: { aiLedgerId: result.ledgerRow.id, amount: numeric, financeReference },
      });
    }
    const snapshot = await ledger.getWalletSnapshot(pool, wallet.id);
    // 200 either way: a retried request is a success that changed nothing — the caller can tell from alreadyApplied.
    res.status(result.alreadyApplied ? 200 : 201).json({ success: true, alreadyApplied: result.alreadyApplied, ledgerEntry: result.ledgerRow, wallet: snapshot });
  } catch (err) {
    sendError(res, err, "Server error topping up AI marking wallet");
  }
};

/* ---------------- REVERSE (compensating entry; reason mandatory) ---------------- */
const reverseAiMarkingEntry = async (req, res) => {
  try {
    const { tenantKey, ledgerId } = req.params;
    assertValidTenant(tenantKey);
    const id = Number(ledgerId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid ledger entry id" });
    }
    const { reason, confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({ success: false, message: "Reversal requires explicit confirmation" });
    }
    const pool = await getPool(tenantKey);
    const result = await ledger.reverseLedgerEntry(pool, {
      ledgerId: id, reason, actorId: req.user?.id || null, actorRole: req.user?.role || null,
    });
    if (!result.alreadyApplied) {
      await logFinanceAudit(pool, {
        action: "ai_marking_reversal", actorId: req.user?.id, actorRole: req.user?.role,
        details: { reversedLedgerId: id, aiLedgerId: result.ledgerRow.id, reason: String(reason).trim() },
      });
    }
    res.status(result.alreadyApplied ? 200 : 201).json({ success: true, alreadyApplied: result.alreadyApplied, ledgerEntry: result.ledgerRow });
  } catch (err) {
    sendError(res, err, "Server error reversing AI marking ledger entry");
  }
};

module.exports = {
  getAiMarkingOverview,
  listAiMarkingLedger,
  listAiMarkingPricing,
  setAiMarkingPricing,
  topUpAiMarkingWallet,
  reverseAiMarkingEntry,
};
