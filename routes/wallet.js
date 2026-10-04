const express = require("express");
const router = express.Router();
const { protect, requirePage } = require("../middleware/authMiddleware");
const {
  getWalletOverview,
  listLedger,
  listExamsWithAllocations,
  getEligibleStudents,
  previewEligibleStudents,
  getAllocatedStudents,
  allocateCredits,
  removeStudentAllocation,
  getCreditRequestInfo,
} = require("../controllers/wallet.controller");
const {
  listMyInvoices,
  listMyReceipts,
  downloadMyInvoicePdf,
  downloadMyReceiptPdf,
} = require("../controllers/walletDocuments.controller");

/* Same pattern as every other admin sub-page in this app: protect +
   requirePage("<Page Key>") — "admin" always passes, sub_admin /
   sub_admin_2 / module_admin only if "Wallet" was granted at setup
   (see utils/pages.js / frontend/src/permissions.js). This is
   deliberately the ordinary authorize()/requirePage() path, NOT
   financeOnly — an institution admin viewing/distributing their own
   credits is exactly the capability this page is for; financeOnly
   (routes/finance.js) is the separate, stricter gate for minting
   credits in the first place. */
router.use(protect, requirePage("Wallet"));

router.get("/", getWalletOverview);
router.get("/ledger", listLedger);
router.get("/exams", listExamsWithAllocations);
// Gap fix: preview eligible students (and current balance) for a given
// cohort year BEFORE a Main Examination exists yet, so the create form
// can offer a "pick specific students" option instead of always
// funding the whole eligible cohort the backend resolves.
router.get("/eligible-students-preview", previewEligibleStudents);
router.get("/exams/:mainExamId/eligible-students", getEligibleStudents);
// Gap fix: who currently holds a reserved (not yet consumed) credit on
// this exam — the list removeStudentAllocation's UI button hangs off.
router.get("/exams/:mainExamId/allocated-students", getAllocatedStudents);
router.post("/exams/:mainExamId/allocate", allocateCredits);
// Phase 5 gap fix: release exactly ONE student's reserved (not yet
// consumed) credit without touching the rest of the exam's funding or
// its status — e.g. the student withdrew/transferred/was allocated by
// mistake. See removeStudentAllocation's own header for why this is
// distinct from cancelling/archiving the whole examination.
router.delete("/exams/:mainExamId/students/:studentId", removeStudentAllocation);
router.get("/credit-request", getCreditRequestInfo);

// Read-only: invoices Doravo Finance raised for this institution and the
// receipts issued on confirmed payments (same PDFs Finance downloads).
router.get("/invoices", listMyInvoices);
router.get("/invoices/:invoiceId/pdf", downloadMyInvoicePdf);
router.get("/receipts", listMyReceipts);
router.get("/receipts/:receiptId/pdf", downloadMyReceiptPdf);

module.exports = router;
