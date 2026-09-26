const sql = require("mssql");
const { getWalletSnapshot, reserveCreditsForStudents, releaseEntitlement, checkAffordability, WalletError } = require("../services/walletLedger.service");
const { buildCreditRequest } = require("../utils/creditRequestMessage.service");

/* =========================================================================
   INSTITUTION WALLET CONTROLLER (admin-facing)

   Unlike finance.controller.js, everything here uses req.pool — the
   logged-in admin's OWN tenant, exactly like every other controller in
   this codebase. An institution admin can view and distribute THEIR
   OWN credits (spec) and nothing here ever touches another tenant's
   database or mints/modifies credits directly — allocation only ever
   moves credits from available -> reserved via
   walletLedger.service.js's reserveCreditsForStudents, which is the
   same atomic/concurrency-safe path Phase 5's exam-creation gate will
   also call.
========================================================================= */

/* Eligibility rule (Phase 1 audit finding: nothing tracked this
   before). main_examinations has no class_id of its own — only
   cohort_year (INT, "same convention as e_assessments.year_of_study",
   per its own schema comment) — so a Main Examination's cohort is
   matched against Students.yearOfStudy. A NULL cohort_year is treated
   as "every active student" (an institution-wide examination).
   This is deliberately the SAME simple year-of-study rule
   mainExamStudent.controller.js's loadMySessions uses for what a
   student sees once subjects are scheduled — but computed here at the
   MAIN EXAMINATION level, before any subject session exists yet,
   since credit allocation has to be possible right after an exam is
   created, not only after its first subject is scheduled. Phase 5
   should double check these two audience computations agree once
   subjects exist; noted, not yet reconciled. */
async function loadMainExam(pool, mainExamId) {
  const result = await pool.request()
    .input("id", sql.Int, mainExamId)
    .query(`SELECT id, name, status, cohort_year, academic_year, programme FROM main_examinations WHERE id = @id`);
  return result.recordset[0] || null;
}

async function loadEligibleStudents(pool, mainExam, { search = "", excludeEntitled = true } = {}) {
  const request = pool.request();
  let cohortFilter = "";
  if (mainExam.cohort_year != null) {
    request.input("cohortYear", sql.Int, mainExam.cohort_year);
    cohortFilter = "AND s.yearOfStudy = @cohortYear";
  }
  let searchFilter = "";
  if (search) {
    request.input("search", sql.NVarChar, `%${search}%`);
    searchFilter = "AND (s.name LIKE @search OR s.admissionNo LIKE @search)";
  }
  let entitlementFilter = "";
  if (excludeEntitled) {
    request.input("mainExamId", sql.Int, mainExam.id);
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
      ${searchFilter}
      ${entitlementFilter}
    ORDER BY s.name ASC
  `);
  return result.recordset;
}

/* ---------------- WALLET OVERVIEW ---------------- */
const getWalletOverview = async (req, res) => {
  try {
    const pool = req.pool;
    const [wallet, profileResult, eligibleCountResult] = await Promise.all([
      getWalletSnapshot(pool),
      pool.request().query(`SELECT TOP 1 schoolName, shortName, email, phone FROM SchoolSettings WHERE id = 1`),
      pool.request().query(`SELECT COUNT(*) AS count FROM Students WHERE status = 'active'`),
    ]);
    res.json({
      success: true,
      wallet,
      institution: profileResult.recordset[0] || null,
      registeredEligibleStudents: eligibleCountResult.recordset[0]?.count || 0,
      tenant: req.tenant,
    });
  } catch (err) {
    console.error("WALLET OVERVIEW ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading wallet" });
  }
};

/* ---------------- LEDGER (own tenant, paged) ---------------- */
const listLedger = async (req, res) => {
  try {
    const pool = req.pool;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await pool.request()
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit) id, entry_type, credit_delta, available_after, reserved_after,
               main_examination_id, student_id, actor_id, actor_role, reason, createdAt
        FROM wallet_ledger ORDER BY id DESC
      `);
    res.json({ success: true, ledger: result.recordset });
  } catch (err) {
    console.error("WALLET LEDGER ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading transaction history" });
  }
};

/* ---------------- CURRENT EXAMINATIONS + ALLOCATED CREDITS ---------------- */
const listExamsWithAllocations = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT
        me.id, me.name, me.status, me.cohort_year, me.academic_year,
        COUNT(CASE WHEN see.status = 'reserved' THEN 1 END) AS reserved_count,
        COUNT(CASE WHEN see.status = 'consumed' THEN 1 END) AS consumed_count,
        COUNT(CASE WHEN see.status = 'released' THEN 1 END) AS released_count
      FROM main_examinations me
      LEFT JOIN student_exam_entitlements see ON see.main_examination_id = me.id
      WHERE me.status <> 'archived'
      GROUP BY me.id, me.name, me.status, me.cohort_year, me.academic_year, me.createdAt
      ORDER BY me.createdAt DESC
    `);
    res.json({ success: true, examinations: result.recordset });
  } catch (err) {
    console.error("WALLET LIST EXAMS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading examinations" });
  }
};

/* ---------------- ELIGIBLE STUDENTS FOR ONE EXAM ---------------- */
const getEligibleStudents = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = parseInt(req.params.mainExamId, 10);
    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Examination not found" });

    const students = await loadEligibleStudents(pool, mainExam, { search: req.query.search || "" });
    const wallet = await getWalletSnapshot(pool);
    res.json({
      success: true,
      examination: mainExam,
      students,
      availableCredits: wallet?.available_credits ?? 0,
    });
  } catch (err) {
    console.error("WALLET ELIGIBLE STUDENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading eligible students" });
  }
};

/* ---------------- ELIGIBLE STUDENTS PREVIEW (before creation) ----------------
   Gap fix: the "Create Main Examination" form needs to let an admin
   hand-pick a subset of the eligible cohort BEFORE the examination
   (and its id) exist — getEligibleStudents above needs an existing
   mainExamId, so it can't serve this. Reuses loadEligibleStudents
   with excludeEntitled: false (there's no entitlement to exclude
   against yet — entitlements are per-main-examination, so a student
   already funded on a DIFFERENT exam is still eligible here) and a
   synthetic { cohort_year } in place of a real exam row. */
const previewEligibleStudents = async (req, res) => {
  try {
    const pool = req.pool;
    const cohortYearRaw = req.query.cohortYear;
    const cohortYear = cohortYearRaw !== undefined && cohortYearRaw !== "" ? parseInt(cohortYearRaw, 10) : null;
    const students = await loadEligibleStudents(
      pool,
      { id: null, cohort_year: Number.isInteger(cohortYear) ? cohortYear : null },
      { search: req.query.search || "", excludeEntitled: false }
    );
    const wallet = await getWalletSnapshot(pool);
    res.json({ success: true, students, availableCredits: wallet?.available_credits ?? 0 });
  } catch (err) {
    console.error("WALLET PREVIEW ELIGIBLE STUDENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading eligible students" });
  }
};

/* ---------------- CURRENTLY ALLOCATED (reserved) STUDENTS FOR ONE EXAM ----------------
   Gap fix: without this, there was no way for the frontend to show
   WHO currently holds a reserved credit on an exam, so there was
   nothing to attach a "remove" action to — removeStudentAllocation
   below existed but was unreachable from the UI. Deliberately only
   'reserved' rows: 'consumed' credits are past the point an admin
   should be un-spending them from this screen (see
   removeStudentAllocation's own comment), and 'released' rows are
   history, shown in the ledger tab instead of here. */
const getAllocatedStudents = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = parseInt(req.params.mainExamId, 10);
    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Examination not found" });

    const result = await pool.request()
      .input("mainExamId", sql.Int, mainExamId)
      .query(`
        SELECT s.id, s.name, s.admissionNo, s.studentClass, see.allocated_at
        FROM student_exam_entitlements see
        JOIN Students s ON s.id = see.student_id
        WHERE see.main_examination_id = @mainExamId AND see.status = 'reserved'
        ORDER BY s.name ASC
      `);
    res.json({ success: true, examination: mainExam, students: result.recordset });
  } catch (err) {
    console.error("WALLET ALLOCATED STUDENTS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading allocated students" });
  }
};

/* ---------------- BULK ALLOCATE CREDITS ----------------
   "Never allow allocation beyond the available wallet balance" (spec)
   — enforced atomically inside reserveCreditsForStudents itself (the
   real gate); the checkAffordability call here is only to return a
   clear, specific shortfall message instead of a generic failure,
   consistent with "Confirmation preview" — the frontend is expected
   to call getEligibleStudents + this same affordability check before
   showing its own confirm step, and this endpoint re-validates
   regardless, since (per §5) the frontend is never the security
   boundary. */
const allocateCredits = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = parseInt(req.params.mainExamId, 10);
    const studentIds = Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(Number).filter(Number.isInteger) : [];

    if (!studentIds.length) {
      return res.status(400).json({ success: false, message: "Select at least one student to allocate credits to" });
    }

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Examination not found" });
    if (mainExam.status === "archived" || mainExam.status === "cancelled") {
      return res.status(400).json({ success: false, message: `Cannot allocate credits to a ${mainExam.status} examination` });
    }

    // Defense in depth: re-derive the actually-eligible set server-side
    // rather than trusting the frontend's student-id list at face value.
    const eligible = await loadEligibleStudents(pool, mainExam, { excludeEntitled: true });
    const eligibleIds = new Set(eligible.map((s) => s.id));
    const invalid = studentIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length) {
      return res.status(400).json({
        success: false,
        message: `${invalid.length} selected student(s) are not eligible (inactive, wrong cohort, or already allocated) for this examination`,
        invalidStudentIds: invalid,
      });
    }

    const affordability = await checkAffordability(pool, { mainExaminationId: mainExamId, studentIds });
    if (!affordability.sufficient) {
      return res.status(400).json({
        success: false,
        code: "INSUFFICIENT_CREDITS",
        message: `Insufficient credits: need ${affordability.needed}, only ${affordability.available} available (short by ${affordability.shortfall})`,
        ...affordability,
      });
    }

    const result = await reserveCreditsForStudents(pool, {
      mainExaminationId: mainExamId,
      studentIds,
      actorId: req.user?.id,
      actorRole: req.user?.role,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("WALLET ALLOCATE ERROR:", err);
    if (err instanceof WalletError) {
      return res.status(400).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: "Server error allocating credits" });
  }
};

/* ---------------- REMOVE ONE STUDENT'S ALLOCATION ----------------
   Spec: "Define explicit policies for ... student removal" as one of
   the funding-state transitions Phase 5 must cover. Distinct from
   cancelling/archiving a whole examination (mainExam.controller.js) —
   this releases exactly ONE student's reserved credit (e.g. the
   student withdrew, transferred, or was allocated by mistake) without
   touching anyone else's entitlement or the exam's own status.

   Only a 'reserved' entitlement can be released this way, same rule
   walletLedger.service.js's releaseEntitlement itself enforces: once
   an entitlement is 'consumed' (the exam actually ran for that
   student), un-spending it is a Finance-side reverseIssuance
   decision, never a side effect of an admin editing a class list. */
const removeStudentAllocation = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = parseInt(req.params.mainExamId, 10);
    const studentId = parseInt(req.params.studentId, 10);
    if (!studentId) {
      return res.status(400).json({ success: false, message: "Invalid student id" });
    }

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Examination not found" });

    const result = await releaseEntitlement(pool, {
      studentId,
      mainExaminationId: mainExamId,
      reason: req.body?.reason || "Student removed from examination by administrator",
      actorId: req.user?.id,
      actorRole: req.user?.role,
    });

    if (!result.released) {
      return res.status(400).json({
        success: false,
        message: "This student has no active reserved credit on this examination — it may already be consumed (the exam ran for them), already released, or never allocated. A consumed credit can only be reversed by Doravo Finance.",
      });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("WALLET REMOVE ALLOCATION ERROR:", err);
    if (err instanceof WalletError) {
      return res.status(400).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: "Server error removing student allocation" });
  }
};

/* ---------------- REQUEST CREDITS (email/WhatsApp prefill) ---------------- */
const getCreditRequestInfo = async (req, res) => {
  try {
    const pool = req.pool;
    const requestedQuantity = req.query.requestedQuantity ? parseInt(req.query.requestedQuantity, 10) : null;

    const [profileResult, wallet] = await Promise.all([
      pool.request().query(`SELECT TOP 1 schoolName, email, phone FROM SchoolSettings WHERE id = 1`),
      getWalletSnapshot(pool),
    ]);
    const profile = profileResult.recordset[0];

    const request = buildCreditRequest({
      institutionName: profile?.schoolName,
      tenantKey: req.tenant,
      institutionContact: profile?.email || profile?.phone || null,
      requestedQuantity,
      currentAvailableCredits: wallet?.available_credits ?? 0,
    });

    res.json({ success: true, ...request });
  } catch (err) {
    console.error("WALLET CREDIT REQUEST INFO ERROR:", err);
    res.status(500).json({ success: false, message: "Server error preparing credit request" });
  }
};

module.exports = {
  getWalletOverview,
  listLedger,
  listExamsWithAllocations,
  getEligibleStudents,
  previewEligibleStudents,
  getAllocatedStudents,
  allocateCredits,
  removeStudentAllocation,
  getCreditRequestInfo,
};
