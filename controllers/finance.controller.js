const sql = require("mssql");
const { getPool, listTenantKeys } = require("../config/db");
const {
  getWalletSnapshot,
  createIssuance,
  applyIssuance,
  reverseIssuance,
  WalletError,
} = require("../services/walletLedger.service");
const { generateUniqueReference } = require("../utils/creditReference");
const { logFinanceAudit } = require("../utils/financeAuditLog");
const { generateSecret, verifyToken, otpauthUri } = require("../utils/totp");

/* =========================================================================
   DORAVO FINANCE CONTROLLER

   IMPORTANT DEVIATION FROM THE REST OF THIS CODEBASE: every other
   controller in this project operates on req.pool — the ONE tenant DB
   the logged-in user's own JWT is scoped to (see server.js's DB
   middleware). Finance is structurally different: a Finance officer's
   own login account lives in exactly one tenant DB (Option A, Phase 1
   audit), but their JOB is to act on ANY institution's wallet. So
   every function below that touches institution data takes a
   `:tenantKey` route param, validates it against listTenantKeys(),
   and opens THAT tenant's pool directly via getPool(tenantKey) —
   never req.pool. req.pool here is only ever implicitly relevant to
   the finance ACCOUNT itself (enrollMfa/confirmMfa, which manage the
   logged-in finance user's own Users row in their own tenant).

   Every mutating endpoint here is financeOnly-gated at the route
   level (routes/finance.js) — financeOnly is a strict role check with
   no admin bypass (see middleware/financeAuth.js's header comment for
   why that matters).
========================================================================= */

function assertValidTenant(tenantKey) {
  if (!tenantKey || !listTenantKeys().includes(tenantKey)) {
    const err = new Error(`Unknown institution "${tenantKey}"`);
    err.statusCode = 404;
    throw err;
  }
}

async function loadInstitutionProfile(pool) {
  const result = await pool.request().query(`
    SELECT TOP 1 schoolName, shortName, centreCode, email, phone
    FROM SchoolSettings WHERE id = 1
  `);
  return result.recordset[0] || null;
}

/* ---------------- LIST INSTITUTIONS ----------------
   Doravo has no control database listing institutions (Phase 1 audit)
   — this reads the same DB_TENANTS-driven tenant list every other
   piece of tenant-aware code in this app already reads, and enriches
   each with its own wallet snapshot + institution display name so
   Finance has a single "pick an institution" screen. */
const listInstitutions = async (req, res) => {
  try {
    const tenants = listTenantKeys();
    const rows = await Promise.all(
      tenants.map(async (tenantKey) => {
        try {
          const pool = await getPool(tenantKey);
          const [profile, wallet] = await Promise.all([
            loadInstitutionProfile(pool),
            getWalletSnapshot(pool),
          ]);
          return {
            tenantKey,
            institutionName: profile?.schoolName || tenantKey,
            shortName: profile?.shortName || null,
            availableCredits: wallet?.available_credits ?? 0,
            reservedCredits: wallet?.reserved_credits ?? 0,
            totalPurchased: wallet?.total_purchased ?? 0,
            totalAllocated: wallet?.total_allocated ?? 0,
          };
        } catch (err) {
          // One tenant's DB being unreachable must never hide every
          // other institution from Finance's list.
          return { tenantKey, institutionName: tenantKey, error: "Could not load this institution's wallet" };
        }
      })
    );
    res.json({ success: true, institutions: rows });
  } catch (err) {
    console.error("FINANCE LIST INSTITUTIONS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error listing institutions" });
  }
};

/* ---------------- GET INSTITUTION WALLET DETAIL ---------------- */
const getInstitutionWallet = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const [profile, wallet] = await Promise.all([loadInstitutionProfile(pool), getWalletSnapshot(pool)]);
    res.json({ success: true, tenantKey, institution: profile, wallet });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error loading wallet" });
  }
};

/* ---------------- LIST WALLET LEDGER (paged) ---------------- */
const listLedger = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await pool.request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit) id, entry_type, credit_delta, available_after, reserved_after,
               main_examination_id, student_id, credit_issuance_id, actor_id, actor_role, reason, createdAt
        FROM wallet_ledger ORDER BY id DESC
      `);
    res.json({ success: true, ledger: result.recordset });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error loading ledger" });
  }
};

/* ---------------- LIST PAYMENTS ---------------- */
const listPayments = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const result = await pool.request().query(`
      SELECT id, payment_reference, amount, currency, method, notes, verified_by, verified_at, createdAt
      FROM institution_payments ORDER BY id DESC
    `);
    res.json({ success: true, payments: result.recordset });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error loading payments" });
  }
};

/* ---------------- LIST ISSUANCES ---------------- */
const listIssuances = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const result = await pool.request().query(`
      SELECT id, issuance_reference, institution_payment_id, credit_quantity, unit_price, currency,
             state, reversed_quantity, issued_by, issued_at, delivered_at, notes
      FROM credit_issuances ORDER BY id DESC
    `);
    res.json({ success: true, issuances: result.recordset });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error loading issuances" });
  }
};

/* ---------------- LIST FINANCE AUDIT LOG ---------------- */
const listAuditLog = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const result = await pool.request().query(`
      SELECT TOP 200 id, action, institution_payment_id, credit_issuance_id, wallet_ledger_id,
             actor_id, actor_role, details, createdAt
      FROM finance_audit_log ORDER BY id DESC
    `);
    res.json({ success: true, auditLog: result.recordset });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error loading audit log" });
  }
};

/* ---------------- RECORD & VERIFY A PAYMENT ----------------
   Finance has already manually confirmed this payment happened
   outside Doravo (bank/mobile-money reconciliation) — this endpoint
   just records that fact. The unique index on payment_reference
   (ensureSchema.js) is the hard backstop against re-verifying the
   same real-world payment twice (spec test 5/6); a caller-supplied
   duplicate reference is rejected here with a clear message rather
   than a raw SQL error. */
const verifyPayment = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const { amount, currency = "KES", method = null, paymentReference = null, notes = null } = req.body || {};

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: "A positive payment amount is required" });
    }

    const pool = await getPool(tenantKey);
    const reference = paymentReference?.trim() || await generateUniqueReference(pool, "institution_payments", "payment_reference", "PAY");

    let paymentId;
    try {
      const result = await pool.request()
        .input("paymentReference", sql.NVarChar(80), reference)
        .input("amount", sql.Decimal(18, 2), numericAmount)
        .input("currency", sql.NVarChar(3), currency)
        .input("method", sql.NVarChar(50), method)
        .input("notes", sql.NVarChar(500), notes)
        .input("verifiedBy", sql.Int, req.user?.id || null)
        .query(`
          INSERT INTO institution_payments (payment_reference, amount, currency, method, notes, verified_by)
          OUTPUT INSERTED.id
          VALUES (@paymentReference, @amount, @currency, @method, @notes, @verifiedBy)
        `);
      paymentId = result.recordset[0].id;
    } catch (err) {
      if (err.number === 2601 || err.number === 2627) {
        return res.status(409).json({ success: false, message: `Payment reference "${reference}" has already been verified` });
      }
      throw err;
    }

    await logFinanceAudit(pool, {
      action: "payment_verified",
      institutionPaymentId: paymentId,
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { tenantKey, payment_reference: reference, amount: numericAmount, currency },
    });

    res.json({ success: true, payment: { id: paymentId, payment_reference: reference, amount: numericAmount, currency } });
  } catch (err) {
    console.error("FINANCE VERIFY PAYMENT ERROR:", err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error verifying payment" });
  }
};

/* ---------------- ISSUE CREDITS ----------------
   "Require confirmation before issuance" (spec) — the frontend shows
   a confirmation step and this endpoint refuses to issue anything
   unless `confirm: true` is explicitly sent, so a stray/duplicate
   click on a non-confirming call can never issue credits. */
const issueCredits = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const { paymentId = null, creditQuantity, unitPrice = null, currency = "KES", notes = null, confirm } = req.body || {};

    if (confirm !== true) {
      return res.status(400).json({ success: false, message: "Issuance requires explicit confirmation" });
    }
    const quantity = Number(creditQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Credit quantity must be a positive whole number" });
    }

    const pool = await getPool(tenantKey);

    if (paymentId) {
      const paymentCheck = await pool.request()
        .input("id", sql.Int, paymentId)
        .query(`SELECT id FROM institution_payments WHERE id = @id`);
      if (!paymentCheck.recordset[0]) {
        return res.status(404).json({ success: false, message: "Linked payment not found for this institution" });
      }
    }

    const issuance = await createIssuance(pool, {
      institutionPaymentId: paymentId,
      creditQuantity: quantity,
      unitPrice: unitPrice != null ? Number(unitPrice) : null,
      currency,
      issuedBy: req.user?.id || null,
      notes,
    });

    const applied = await applyIssuance(pool, { issuanceId: issuance.id, actorId: req.user?.id, actorRole: req.user?.role });

    res.json({
      success: true,
      receipt: {
        issuance_reference: issuance.issuance_reference,
        credit_quantity: quantity,
        availableCredits: applied.availableCredits,
      },
    });
  } catch (err) {
    console.error("FINANCE ISSUE CREDITS ERROR:", err);
    if (err instanceof WalletError) {
      return res.status(400).json({ success: false, message: err.message, code: err.code });
    }
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error issuing credits" });
  }
};

/* ---------------- REVERSE UNUSED CREDITS ----------------
   "Support controlled corrections and reversals of unused credits
   with mandatory reasons" (spec) — reason is required and enforced
   again inside walletLedger.service.js's reverseIssuance. */
const reverseCredits = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const { issuanceId, quantity, reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: "A reason is required to reverse credits" });
    }
    const pool = await getPool(tenantKey);
    const result = await reverseIssuance(pool, {
      issuanceId: Number(issuanceId),
      quantity: Number(quantity),
      reason: String(reason).trim(),
      actorId: req.user?.id,
      actorRole: req.user?.role,
    });
    res.json({ success: true, availableCredits: result.availableCredits });
  } catch (err) {
    console.error("FINANCE REVERSE CREDITS ERROR:", err);
    if (err instanceof WalletError) {
      return res.status(400).json({ success: false, message: err.message, code: err.code });
    }
    res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error reversing credits" });
  }
};

/* =========================================================================
   MFA ENROLLMENT — self-service, for the CURRENTLY LOGGED IN finance
   user's own account, in their own tenant DB. Uses req.pool (not
   getPool(tenantKey)) since this is about the account itself, not an
   institution's wallet.

   No QR code library exists in this project and none can be installed
   here (no network access) — enrollment returns the Base32 secret as
   text plus an otpauth:// URI, both of which every mainstream
   authenticator app accepts via manual entry or "paste a setup key".
   A QR-rendering step (e.g. drawn client-side with a small JS QR
   library) can be layered on top later without changing this
   endpoint's contract.
========================================================================= */
const enrollMfa = async (req, res) => {
  try {
    const pool = req.pool;
    const secret = generateSecret();
    await pool.request()
      .input("id", sql.Int, req.user.id)
      .input("secret", sql.NVarChar(100), secret)
      .query(`UPDATE Users SET mfaSecret = @secret, mfaEnabled = 0 WHERE id = @id`);

    res.json({
      success: true,
      secret,
      otpauthUri: otpauthUri(secret, { accountName: req.user.username || `user${req.user.id}` }),
      message: "Enter the 6-digit code from your authenticator app to finish enabling MFA.",
    });
  } catch (err) {
    console.error("FINANCE MFA ENROLL ERROR:", err);
    res.status(500).json({ success: false, message: "Server error starting MFA enrollment" });
  }
};

const confirmMfa = async (req, res) => {
  try {
    const pool = req.pool;
    const { code } = req.body || {};
    const userResult = await pool.request()
      .input("id", sql.Int, req.user.id)
      .query(`SELECT mfaSecret FROM Users WHERE id = @id`);
    const mfaSecret = userResult.recordset[0]?.mfaSecret;
    if (!mfaSecret) {
      return res.status(400).json({ success: false, message: "Start MFA enrollment first" });
    }
    if (!verifyToken(mfaSecret, code)) {
      return res.status(400).json({ success: false, message: "Incorrect or expired code" });
    }
    await pool.request()
      .input("id", sql.Int, req.user.id)
      .query(`UPDATE Users SET mfaEnabled = 1 WHERE id = @id`);
    res.json({ success: true, mfaEnabled: true });
  } catch (err) {
    console.error("FINANCE MFA CONFIRM ERROR:", err);
    res.status(500).json({ success: false, message: "Server error confirming MFA" });
  }
};

module.exports = {
  listInstitutions,
  getInstitutionWallet,
  listLedger,
  listPayments,
  listIssuances,
  listAuditLog,
  verifyPayment,
  issueCredits,
  reverseCredits,
  enrollMfa,
  confirmMfa,
};
