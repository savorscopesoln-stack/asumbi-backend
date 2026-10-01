const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { financeOnly } = require("../middleware/financeAuth");
const {
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
} = require("../controllers/finance.controller");
const {
  createInvoice,
  listInvoices,
  downloadInvoicePdf,
  voidInvoice,
  listReceipts,
  downloadReceiptPdf,
  downloadPaymentReceipt,
} = require("../controllers/financeInvoice.controller");

/* =========================================================================
   Every route below is protect + financeOnly — financeOnly is a
   strict role check with NO admin/module_admin bypass (see
   middleware/financeAuth.js). This is the one router in the app where
   that distinction actually matters: every other financeOnly-adjacent
   check elsewhere in the codebase (authorize("admin"), requirePage)
   deliberately lets admin/module_admin through everything, which is
   correct for ordinary tenant capabilities but must never apply to
   credit issuance.

   MFA enrollment routes are also financeOnly (a finance officer
   managing their own account), but institution-data routes below them
   are the ones that actually cross tenant boundaries — see
   finance.controller.js's header comment.
========================================================================= */

router.use(protect, financeOnly);

router.get("/institutions", listInstitutions);
router.get("/institutions/:tenantKey/wallet", getInstitutionWallet);
router.get("/institutions/:tenantKey/ledger", listLedger);
router.get("/institutions/:tenantKey/payments", listPayments);
router.get("/institutions/:tenantKey/issuances", listIssuances);
router.get("/institutions/:tenantKey/audit-log", listAuditLog);

router.get("/institutions/:tenantKey/invoices", listInvoices);
router.get("/institutions/:tenantKey/invoices/:invoiceId/pdf", downloadInvoicePdf);
router.get("/institutions/:tenantKey/receipts", listReceipts);
router.get("/institutions/:tenantKey/receipts/:receiptId/pdf", downloadReceiptPdf);
router.get("/institutions/:tenantKey/payments/:paymentId/receipt", downloadPaymentReceipt);

router.post("/institutions/:tenantKey/invoices", createInvoice);
router.post("/institutions/:tenantKey/invoices/:invoiceId/void", voidInvoice);
router.post("/institutions/:tenantKey/payments/verify", verifyPayment);
router.post("/institutions/:tenantKey/credits/issue", issueCredits);
router.post("/institutions/:tenantKey/credits/reverse", reverseCredits);

router.post("/mfa/enroll", enrollMfa);
router.post("/mfa/confirm", confirmMfa);

module.exports = router;
