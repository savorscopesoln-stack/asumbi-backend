const { WalletError, assertCreationAllowed } = require("../services/examFunding.service");

/* =========================================================================
   EXAM WALLET GUARD (Phase 5, Part 1)

   A thin Express middleware, separate from examFunding.service.js on
   purpose: this file's only job is translating a WalletError into the
   right HTTP response shape for the frontend's "disable the button" /
   "show the shortfall" UI (ACCESS RULES bullets 1-3 in the spec).
   examFunding.service.js stays pure Node/SQL with no req/res in it, so
   it's equally callable from a route handler, a script, or a test
   without dragging Express along — same separation this codebase
   already keeps between finance.controller.js (HTTP) and
   walletLedger.service.js (logic).

   NOT YET WIRED UP in this part — routes/mainExams.js still calls
   createMainExamination directly. Part 2 adds:
     router.post("/", requireFundableExamination, createMainExamination);
   and threads req.examFunding (set below) through to the controller so
   the controller doesn't re-run the eligible-student/wallet queries a
   second time for the happy path — it only re-validates the FINAL
   reservation via fundNewExamination's own re-check immediately before
   writing, per this file's closing comment.

   SECURITY NOTE (per spec: "the React interface must reflect backend
   permissions rather than being the security boundary" and "cannot be
   enabled merely by manipulating frontend state or calling APIs
   directly"): this middleware is a pre-flight convenience, not the
   actual gate. The actual gate is reserveCreditsForStudents's own
   row-locked transaction inside walletLedger.service.js. Two requests
   could both pass this middleware's read and then race at the real
   check — that's expected and fine: the loser gets a WalletError from
   fundNewExamination inside the controller, same as if this middleware
   didn't exist at all. Removing this middleware (or an attacker
   bypassing it by calling the route some other way) cannot enable an
   unfunded exam, because createMainExamination in Part 2 calls
   fundNewExamination unconditionally either way.
========================================================================= */

const toIntOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Express middleware for POST /main-exams. Reads cohort_year and the
 * optional studentIds selection straight off req.body — the same
 * fields createMainExamination already reads/will read — checks them
 * against assertCreationAllowed, and either:
 *   - attaches the resolved { eligibleCount, availableCredits,
 *     studentIds, needed } to req.examFunding and calls next(), or
 *   - responds 400 with a structured, frontend-friendly shortfall
 *     payload (code + message + the same numbers) and never calls the
 *     controller at all.
 */
async function requireFundableExamination(req, res, next) {
  try {
    const pool = req.pool;
    const cohortYear = toIntOrNull(req.body?.cohort_year);
    const studentIds = Array.isArray(req.body?.studentIds) ? req.body.studentIds : null;

    const resolved = await assertCreationAllowed(pool, { cohortYear, studentIds });
    req.examFunding = resolved;
    return next();
  } catch (err) {
    if (err instanceof WalletError) {
      return res.status(400).json({
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    console.error("EXAM WALLET GUARD ERROR:", err);
    return res.status(500).json({ success: false, message: "Server error checking examination funding" });
  }
}

module.exports = { requireFundableExamination };
