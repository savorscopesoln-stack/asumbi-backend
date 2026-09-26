const sql = require("mssql");
const { logExamAudit } = require("../utils/examAuditLog");
const {
  WalletError,
  getWalletSnapshot,
  reserveCreditsForStudents,
  releaseEntitlement,
  consumeEntitlementsForExam,
} = require("./walletLedger.service");

/* =========================================================================
   EXAM FUNDING SERVICE (Phase 5, Part 1)

   Everything in this file is NEW and, as of this part, not yet called
   from anywhere — dropping it into the repo changes no existing
   behavior (same "additive first, wire up second" approach already
   used for the wallet_ledger migration and walletLedger.service.js
   itself). Part 2 wires this into:
     - controllers/mainExam.controller.js  (createMainExamination,
       updateMainExamination, archiveMainExamination,
       deleteMainExamination)
     - middleware/examWalletGuard.js        (the Express-level gate on
       POST /main-exams, added alongside this file — see that file's
       own header for why it's a separate, thin layer)
     - the frontend Main Examination creation flow

   WHAT THIS FILE DOES NOT DO:
     - It never writes to institution_wallets or wallet_ledger
       directly. Every balance-changing operation below is a thin,
       exam-domain-shaped wrapper around a walletLedger.service.js
       function — that file remains the ONLY place those two columns
       are ever written (its own header comment), so "atomic,
       concurrency-safe and idempotent" only has to be proven once.
     - It never decides authorization/role — that's
       middleware/authMiddleware.js's job, same as every other route
       in this app. This file assumes the caller already passed
       protect + requirePage("E-Assessments"), exactly like the rest
       of mainExam.controller.js.

   FUNDING STATE — DELIBERATELY NOT A NEW COLUMN:
   The spec (Phase 5) asks for DRAFT / FUNDED / IN_PROGRESS /
   PROCESSING / COMPLETED / CANCELLED. Rather than add a second,
   separately-written "funding_status" column to main_examinations —
   which would have to be kept in sync with student_exam_entitlements
   by hand and could drift — funding is DERIVED, read live from
   student_exam_entitlements, the same "one source of truth" approach
   already used everywhere else in this codebase (see
   wallet.controller.js's listExamsWithAllocations, or
   mainExam.controller.js's dashboard candidate count). The six spec
   states map onto the EXISTING main_examinations.status column
   (draft / published / ongoing / completed / archived — plus a new
   'cancelled' value, added in Part 2) crossed with "does this exam
   have any active entitlement":

     DRAFT       status='draft'                 + not funded
     FUNDED      status IN ('draft','published') + funded
     IN_PROGRESS status='ongoing'                + funded
     PROCESSING  status='ongoing' (all subject sessions ended) or
                 status='completed' pending finalization — a derived
                 UI label over existing exam_subject_sessions status
                 counts (see getMainExaminationDashboard's
                 subjectCounts), not a new stored value: this app
                 already tracks per-subject progress there, and
                 duplicating it here would be a second source of
                 truth for the exact thing §51 warns against.
     COMPLETED   status='completed'              + funded (credits
                 CONSUMED, see completeExaminationFunding below)
     CANCELLED   status='cancelled'              + entitlements
                 released back to available_credits

   getExaminationFundingState() below returns the derived pieces a
   caller needs to render/enforce this without re-deriving the SQL
   itself.
========================================================================= */

/**
 * Same eligibility rule wallet.controller.js's loadEligibleStudents
 * uses (Students.status='active', yearOfStudy matches cohort_year,
 * NULL cohort_year = institution-wide), intentionally re-stated here
 * rather than imported: loadEligibleStudents is a private closure in
 * wallet.controller.js (not exported), and this rule has to run
 * BEFORE a main_examinations row exists yet (at create time, from the
 * submitted cohort_year, not a stored one) — see the header note in
 * wallet.controller.js flagging this same duplication and asking
 * Phase 5 to reconcile it. Recorded here again rather than silently
 * fixed, since collapsing the two into one shared helper touches a
 * file (wallet.controller.js) this part intentionally leaves alone.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ cohortYear: number|null, excludeMainExaminationId?: number|null }} opts
 * @returns {Promise<Array<{id:number, name:string, admissionNo:string, studentClass:string, yearOfStudy:number}>>}
 */
async function getEligibleStudentsForCohort(pool, { cohortYear = null, excludeMainExaminationId = null } = {}) {
  const request = pool.request();
  let cohortFilter = "";
  if (cohortYear != null) {
    request.input("cohortYear", sql.Int, cohortYear);
    cohortFilter = "AND s.yearOfStudy = @cohortYear";
  }
  let entitlementFilter = "";
  if (excludeMainExaminationId != null) {
    request.input("mainExamId", sql.Int, excludeMainExaminationId);
    entitlementFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM student_exam_entitlements see
        WHERE see.student_id = s.id AND see.main_examination_id = @mainExamId AND see.status <> 'released'
      )`;
  }
  const result = await request.query(`
    SELECT s.id, s.name, s.admissionNo, s.studentClass, s.yearOfStudy
    FROM Students s
    WHERE s.status = 'active'
      ${cohortFilter}
      ${entitlementFilter}
    ORDER BY s.name ASC
  `);
  return result.recordset;
}

/** Cheap count-only version of the above, for the two simple booleans the create-gate needs first ("no registered eligible students" / "no available credits") before doing any heavier work. */
async function countRegisteredEligibleStudents(pool, { cohortYear = null } = {}) {
  const request = pool.request();
  let cohortFilter = "";
  if (cohortYear != null) {
    request.input("cohortYear", sql.Int, cohortYear);
    cohortFilter = "AND s.yearOfStudy = @cohortYear";
  }
  const result = await request.query(`
    SELECT COUNT(*) AS count FROM Students s WHERE s.status = 'active' ${cohortFilter}
  `);
  return result.recordset[0]?.count || 0;
}

/* =========================================================================
   CREATE-TIME GATE
   The three ACCESS RULES bullets that apply before any row exists:
     "No registered eligible students: disable new exam creation."
     "No available credits: disable new exam creation."
     "Insufficient credits for the selected cohort: reject creation
      and show the credit shortfall."
   This function only DECIDES; it writes nothing. Part 2's
   middleware/examWalletGuard.js calls it pre-flight (so a disallowed
   request never reaches the controller at all), and
   fundNewExamination() below calls it again immediately before
   actually reserving — never trusting that nothing changed between
   the two (per spec: "the React interface must reflect backend
   permissions rather than being the security boundary", and by the
   same logic, a middleware's earlier read is not the security
   boundary either — reserveCreditsForStudents's own row-locked
   transaction is the actual, final word).
========================================================================= */
async function assertCreationAllowed(pool, { cohortYear = null, studentIds = null } = {}) {
  const eligibleCount = await countRegisteredEligibleStudents(pool, { cohortYear });
  if (eligibleCount === 0) {
    throw new WalletError(
      "This examination has no registered eligible students for the selected cohort",
      "NO_ELIGIBLE_STUDENTS"
    );
  }

  const wallet = await getWalletSnapshot(pool);
  const availableCredits = wallet?.available_credits ?? 0;
  if (availableCredits === 0) {
    throw new WalletError(
      "No available wallet credits — request credits from Doravo Finance before creating a new examination",
      "NO_CREDITS"
    );
  }

  // Resolve exactly which students this creation would fund: an
  // explicit selection (the admin picked a subset of the eligible
  // cohort to fund right away — Phase 4's allocation UI already
  // supports adding the rest later), or, when none was submitted,
  // the entire eligible cohort — the simple default for an
  // institution that just wants "fund everyone in this year group".
  let resolvedStudentIds;
  if (Array.isArray(studentIds) && studentIds.length > 0) {
    const eligible = await getEligibleStudentsForCohort(pool, { cohortYear });
    const eligibleIds = new Set(eligible.map((s) => s.id));
    const requested = [...new Set(studentIds.map(Number).filter(Number.isInteger))];
    const invalid = requested.filter((id) => !eligibleIds.has(id));
    if (invalid.length) {
      throw new WalletError(
        `${invalid.length} selected student(s) are not eligible (inactive or wrong cohort) for this examination`,
        "INVALID_STUDENT_SELECTION"
      );
    }
    resolvedStudentIds = requested;
  } else {
    const eligible = await getEligibleStudentsForCohort(pool, { cohortYear });
    resolvedStudentIds = eligible.map((s) => s.id);
  }

  const needed = resolvedStudentIds.length;
  if (needed > availableCredits) {
    throw new WalletError(
      `Insufficient credits: this examination's cohort needs ${needed}, only ${availableCredits} available (short by ${needed - availableCredits})`,
      "INSUFFICIENT_CREDITS"
    );
  }

  return { eligibleCount, availableCredits, studentIds: resolvedStudentIds, needed };
}

/* =========================================================================
   FUND A JUST-CREATED EXAMINATION
   Called by the controller AFTER the main_examinations INSERT
   succeeds (so mainExaminationId exists), inside the same request —
   NOT a separate user-facing step for this initial cohort (Phase 4's
   own /wallet/exams/:id/allocate endpoint remains the way to fund
   ADDITIONAL students later — see the module header). Re-runs
   assertCreationAllowed's checks immediately before reserving, since
   the wallet balance is only ever authoritative at the instant of the
   locked read inside reserveCreditsForStudents itself.

   On any WalletError here, the controller is expected to delete the
   just-inserted draft row (compensating action) rather than leave an
   examination that exists but was never actually funded — see Part
   2's note on this in mainExam.controller.js.
========================================================================= */
async function fundNewExamination(pool, { mainExaminationId, cohortYear = null, studentIds = null, actorId = null, actorRole = null }) {
  const { studentIds: resolvedStudentIds } = await assertCreationAllowed(pool, { cohortYear, studentIds });

  const result = await reserveCreditsForStudents(pool, {
    mainExaminationId,
    studentIds: resolvedStudentIds,
    actorId,
    actorRole,
  });

  await logExamAudit(pool, {
    mainExaminationId,
    action: "examination_funded",
    actorId,
    actorRole,
    details: { studentsFunded: resolvedStudentIds.length, availableCreditsAfter: result.availableCredits },
  });

  return { ...result, studentIds: resolvedStudentIds };
}

/* =========================================================================
   DERIVED FUNDING STATE — read-only, for dashboards/status badges.
   Mirrors wallet.controller.js's listExamsWithAllocations grouping,
   scoped to one exam, so a detail page and the wallet's list page can
   never disagree about what "funded" means for the same exam.
========================================================================= */
async function getExaminationFundingState(pool, mainExaminationId) {
  const result = await pool.request()
    .input("id", sql.Int, mainExaminationId)
    .query(`
      SELECT
        COUNT(CASE WHEN status = 'reserved' THEN 1 END) AS reserved_count,
        COUNT(CASE WHEN status = 'consumed' THEN 1 END) AS consumed_count,
        COUNT(CASE WHEN status = 'released' THEN 1 END) AS released_count
      FROM student_exam_entitlements
      WHERE main_examination_id = @id
    `);
  const row = result.recordset[0] || { reserved_count: 0, consumed_count: 0, released_count: 0 };
  const isFunded = row.reserved_count > 0 || row.consumed_count > 0;
  return {
    isFunded,
    reservedCount: row.reserved_count,
    consumedCount: row.consumed_count,
    releasedCount: row.released_count,
  };
}

/* =========================================================================
   CANCEL — every 'reserved' (not yet consumed) entitlement on this
   exam is released back to available_credits, one at a time through
   walletLedger.service.js's own releaseEntitlement (each call is its
   own small atomic transaction — matching the existing ledger's
   per-student granularity for reserve/release/consume rows, rather
   than inventing a bulk variant that would produce ledger rows this
   codebase doesn't otherwise have a shape for). 'consumed' rows are
   deliberately left untouched: those credits were already spent on
   an exam that (partially) ran, and un-spending them is a Finance
   reverseIssuance decision, not an automatic side effect of
   cancelling the exam.
========================================================================= */
async function cancelExaminationFunding(pool, { mainExaminationId, reason, actorId = null, actorRole = null }) {
  const reservedResult = await pool.request()
    .input("id", sql.Int, mainExaminationId)
    .query(`
      SELECT student_id FROM student_exam_entitlements
      WHERE main_examination_id = @id AND status = 'reserved'
    `);

  let released = 0;
  for (const row of reservedResult.recordset) {
    const outcome = await releaseEntitlement(pool, {
      studentId: row.student_id,
      mainExaminationId,
      reason: reason || "Examination cancelled",
      actorId,
      actorRole,
    });
    if (outcome.released) released += 1;
  }

  await logExamAudit(pool, {
    mainExaminationId,
    action: "examination_cancelled",
    actorId,
    actorRole,
    details: { reason: reason || null, creditsReleased: released },
  });

  return { released };
}

/* =========================================================================
   COMPLETE — the examination ran to completion; every 'reserved'
   entitlement becomes 'consumed' (spent, not returned — see
   consumeEntitlementsForExam's own header). Safe to call more than
   once (idempotent per student on the ledger side).
========================================================================= */
async function completeExaminationFunding(pool, { mainExaminationId, actorId = null, actorRole = null }) {
  const result = await consumeEntitlementsForExam(pool, { mainExaminationId, actorId, actorRole });

  await logExamAudit(pool, {
    mainExaminationId,
    action: "examination_funding_consumed",
    actorId,
    actorRole,
    details: { studentsConsumed: result.consumed },
  });

  return result;
}

module.exports = {
  // Re-exported, not just used internally: both
  // middleware/examWalletGuard.js and controllers/mainExam.controller.js
  // destructure WalletError off THIS module (not off
  // walletLedger.service.js directly), so leaving it out here left both
  // call sites doing `instanceof undefined` in their catch blocks — a
  // TypeError that crashed the request with a raw 500 instead of the
  // clean 400 shortfall response every ACCESS RULE in the spec depends
  // on. Fixed by re-exporting the same class the wallet layer throws.
  WalletError,
  getEligibleStudentsForCohort,
  countRegisteredEligibleStudents,
  assertCreationAllowed,
  fundNewExamination,
  getExaminationFundingState,
  cancelExaminationFunding,
  completeExaminationFunding,
};
