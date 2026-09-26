const sql = require("mssql");

/* =========================================================================
   FINANCE AUDIT LOG

   Same convention as utils/examAuditLog.js: a factual event row per
   finance action, never throws (a failed audit-log write must never
   block or roll back the real payment/issuance/reversal it's
   describing — matching examAuditLog.js's own stated reasoning and
   utils/notify.js's pattern for the same reason).

   Called from services/walletLedger.service.js after each committed
   transaction, inside the SAME request but as its own best-effort
   statement — never inside the money-moving transaction itself, so an
   audit-log hiccup can't roll back a real wallet mutation.
========================================================================= */
async function logFinanceAudit(pool, {
  action,
  institutionPaymentId = null,
  creditIssuanceId = null,
  walletLedgerId = null,
  actorId = null,
  actorRole = null,
  details = null,
}) {
  try {
    await pool.request()
      .input("action", sql.NVarChar, action)
      .input("institutionPaymentId", sql.Int, institutionPaymentId)
      .input("creditIssuanceId", sql.Int, creditIssuanceId)
      .input("walletLedgerId", sql.Int, walletLedgerId)
      .input("actorId", sql.Int, actorId)
      .input("actorRole", sql.NVarChar, actorRole)
      .input("details", sql.NVarChar, details ? JSON.stringify(details) : null)
      .query(`
        INSERT INTO finance_audit_log
          (action, institution_payment_id, credit_issuance_id, wallet_ledger_id, actor_id, actor_role, details)
        VALUES
          (@action, @institutionPaymentId, @creditIssuanceId, @walletLedgerId, @actorId, @actorRole, @details)
      `);
  } catch (err) {
    console.error("⚠️ finance audit log write failed:", err.message);
  }
}

module.exports = { logFinanceAudit };
