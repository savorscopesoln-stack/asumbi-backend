const sql = require("mssql");
const crypto = require("crypto");
const ledger = require("./aiMarkingLedger.service");

/* =========================================================================
   AI MARKING — ELIGIBILITY, DASHBOARD COUNTS AND PREVIEW (Phase 3)

   READ-ONLY. Nothing in this file writes, reserves, charges or calls an AI
   provider. It answers three questions for ONE teacher in ONE tenant DB:

     1. dashboardCounts()  — where does my marking stand?
     2. resolveSelectable() — what can I pick (assessments / questions / submissions)?
     3. buildPreview()     — if I asked AI to mark this selection, how many
                             answers would be billed and what would it cost?

   THE ELIGIBILITY RULE (single source of truth: ELIGIBLE_PREDICATE)
   An essay answer is billable only if ALL of these hold:
     a. its question is an essay question and the answer text is not blank
        (whitespace and empty rich-text such as <p><br></p> count as blank);
     b. marks_awarded IS NULL   (nothing — manual or AI-approved — is final yet);
     c. its submission is assigned to THIS teacher
        (e_assessment_submission_assignments) — the same visibility rule the
        existing read routes use, so a teacher can never preview, and later
        pay for, another teacher's scripts;
     d. its submission is not 'released';
     e. it has no live AI evaluation (status pending / success / needs_review,
        in any review_state EXCEPT 'superseded' — a teacher's explicit "request a
        new evaluation" in Phase 7 supersedes the old one, which is the only way
        a once-evaluated answer becomes billable again; a merely 'rejected' one
        still blocks, so it cannot be re-bought by a bulk selection). A *failed* evaluation does not block, because
        failures are never charged. Decision D8: paying for the same answer
        twice requires an explicit "re-evaluate" action (later phase), never
        a fresh bulk selection;
     f. its question has an APPROVED marking-scheme version. Without one the
        engine cannot produce validated criterion-level output (audit §3 /
        D3), so charging for it would be charging for work that cannot be
        done. These answers are reported separately as `needsScheme`.

   The frontend NEVER supplies a count or a price. It supplies a selection
   (ids/filters); everything below is recomputed from the database.

   PHASE 4 NOTE: BILLABLE_PREDICATE below is shared with the job-creation
   claim (aiMarkingJobs.service.js), which re-runs it inside the creation
   transaction. Cross-job atomicity comes from the database index
   UQ_ai_marking_evaluations_live_answer, not from this read.

   KNOWN LIMITS (also listed in the Phase 3 hand-off):
   - This is a point-in-time READ. Two teachers, or a double click, can both
     see the same answers as eligible. That is fine for a preview; Phase 4
     must re-run the same predicate INSIDE the job-creation transaction and
     rely on UQ(job, submission, question) plus this predicate's (e) to make
     the claim atomic. `quoteFingerprint` lets Phase 4 detect "the count or
     price moved since you previewed".
   - Essay detection uses question_type values in ESSAY_TYPES. The real
     values are not visible in this repo; verify against each tenant with
     `SELECT DISTINCT question_type FROM e_assessment_questions`.
========================================================================= */

const ESSAY_TYPES = ["essay"];      // lower-case; compared with LOWER(question_type)
const MAX_ID_LIST = 500;            // per list; keeps the parameter count bounded
const LIVE_EVAL_STATUSES = ["pending", "success", "needs_review"];

/**
 * THE billable test, as SQL over the `f` facts CTE. Used verbatim by the
 * preview (count + quote) AND by Phase 4's claim INSERT, so what the teacher
 * was quoted and what a job actually claims can never drift apart.
 */
const BILLABLE_PREDICATE = "is_blank = 0 AND is_released = 0 AND is_marked = 0 AND has_live_eval = 0 AND has_scheme = 1";

/** One job claims at most this many answers (a 312,500-answer workload is many jobs, never one transaction). */
const DEFAULT_MAX_ANSWERS_PER_JOB = 5000;
function maxAnswersPerJob() {
  const n = Number(process.env.AI_MARKING_MAX_ANSWERS_PER_JOB);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ANSWERS_PER_JOB;
}

class SelectionError extends Error {
  constructor(message, code = "INVALID_SELECTION") { super(message); this.code = code; this.statusCode = 400; }
}

/* ------------------------------ selection ------------------------------ */

function cleanIdList(value, label) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new SelectionError(`${label} must be an array of ids`);
  if (value.length > MAX_ID_LIST) throw new SelectionError(`${label} may contain at most ${MAX_ID_LIST} ids`);
  const out = [...new Set(value.map((v) => Number(v)))];
  if (out.some((n) => !Number.isInteger(n) || n < 1)) throw new SelectionError(`${label} must contain positive whole-number ids`);
  return out;                       // empty array is meaningful: "nothing selected"
}

/**
 * Validate + normalise whatever the client sent. Unknown keys are dropped.
 * Filters combine with AND. No filters at all means "everything currently
 * eligible for this teacher" (the "all eligible" option).
 */
function normaliseSelection(raw = {}) {
  const sel = {
    eAssessmentId: null, subject: null,
    questionIds: cleanIdList(raw.questionIds, "questionIds"),
    submissionIds: cleanIdList(raw.submissionIds, "submissionIds"),
    studentIds: cleanIdList(raw.studentIds, "studentIds"),
  };
  if (raw.eAssessmentId != null && raw.eAssessmentId !== "") {
    const id = Number(raw.eAssessmentId);
    if (!Number.isInteger(id) || id < 1) throw new SelectionError("eAssessmentId must be a positive whole number");
    sel.eAssessmentId = id;
  }
  if (raw.subject != null && String(raw.subject).trim() !== "") {
    const s = String(raw.subject).trim();
    if (s.length > 200) throw new SelectionError("subject is too long");
    sel.subject = s;
  }
  return sel;
}

/** Append WHERE fragments + bind parameters for a selection. Ids are bound, never interpolated. */
function applySelection(request, selection) {
  const clauses = [];
  if (selection.eAssessmentId != null) {
    request.input("selAssessment", sql.Int, selection.eAssessmentId);
    clauses.push("ea.id = @selAssessment");
  }
  if (selection.subject != null) {
    request.input("selSubject", sql.NVarChar(200), selection.subject);
    clauses.push("ea.subject = @selSubject");
  }
  const lists = [
    ["questionIds", "q.id", "selQ"],
    ["submissionIds", "s.id", "selS"],
    ["studentIds", "s.student_id", "selSt"],
  ];
  for (const [key, column, prefix] of lists) {
    const ids = selection[key];
    if (ids == null) continue;
    if (ids.length === 0) { clauses.push("1 = 0"); continue; }   // explicit empty selection selects nothing
    const names = ids.map((id, i) => { request.input(`${prefix}${i}`, sql.Int, id); return `@${prefix}${i}`; });
    clauses.push(`${column} IN (${names.join(",")})`);
  }
  return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
}

/* ------------------------------ SQL building blocks ------------------------------ */

const essayTypeList = ESSAY_TYPES.map((t) => `'${t}'`).join(",");        // constants, not user input
const liveStatusList = LIVE_EVAL_STATUSES.map((t) => `'${t}'`).join(",");

// Text with common empty rich-text wrappers stripped, then trimmed.
const STRIPPED_ANSWER = `
  LTRIM(RTRIM(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      CAST(a.essay_answer AS NVARCHAR(MAX)),
      '<p>', ''), '</p>', ''), '<br>', ''), '<br/>', ''), '<br />', ''), '&nbsp;', ''), CHAR(160), '')
  ))`;

/**
 * One row per essay answer on a submission assigned to @teacherId, with the
 * facts needed to bucket it. Everything else is derived from these flags so
 * the dashboard and the preview can never disagree about a definition.
 */
function answerFactsSql(selectionSql, { institutionWide = false } = {}) {
  // institutionWide is used ONLY by the Phase 10 institution-admin analytics. The default (every
  // teacher-facing caller) keeps the assignment join, so a teacher can still only see their own scripts.
  const assignmentJoin = institutionWide ? "" : "JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id AND asg.teacher_id = @teacherId";
  return `
    SELECT
      a.id AS answer_id, s.id AS submission_id, q.id AS question_id, ea.id AS assessment_id,
      ea.title AS assessment_title, ea.subject AS assessment_subject, q.marks AS question_marks,
      CASE WHEN LEN(${STRIPPED_ANSWER}) = 0 OR a.essay_answer IS NULL THEN 1 ELSE 0 END AS is_blank,
      CASE WHEN a.marks_awarded IS NOT NULL THEN 1 ELSE 0 END AS is_marked,
      CASE WHEN s.status = 'released' THEN 1 ELSE 0 END AS is_released,
      CASE WHEN EXISTS (
        SELECT 1 FROM ai_marking_evaluations ev
        WHERE ev.submission_id = s.id AND ev.question_id = q.id AND ev.status IN (${liveStatusList})
          AND ev.review_state <> 'superseded'
      ) THEN 1 ELSE 0 END AS has_live_eval,
      CASE WHEN EXISTS (
        SELECT 1 FROM ai_marking_evaluations ev
        WHERE ev.submission_id = s.id AND ev.question_id = q.id
          AND ev.status IN ('success','needs_review') AND ev.review_state = 'awaiting_review'
      ) THEN 1 ELSE 0 END AS awaiting_review,
      CASE WHEN EXISTS (
        SELECT 1 FROM ai_marking_evaluations ev
        WHERE ev.submission_id = s.id AND ev.question_id = q.id
          AND ev.review_state IN ('approved','adjusted')
      ) THEN 1 ELSE 0 END AS ai_approved,
      CASE WHEN EXISTS (
        SELECT 1 FROM ai_marking_evaluations ev
        WHERE ev.submission_id = s.id AND ev.question_id = q.id
          AND ev.review_state = 'awaiting_review' AND ev.status IN ('needs_review','failed')
      ) THEN 1 ELSE 0 END AS needs_attention,
      CASE WHEN EXISTS (
        SELECT 1 FROM ai_marking_scheme_versions sv
        WHERE sv.question_id = q.id AND sv.status = 'approved' AND sv.max_marks = q.marks
      ) THEN 1 ELSE 0 END AS has_scheme
    FROM e_assessment_answers a
    JOIN e_assessment_submissions s ON s.id = a.submission_id
    ${assignmentJoin}
    JOIN e_assessment_questions q ON q.id = a.question_id
    JOIN e_assessments ea ON ea.id = s.e_assessment_id
    WHERE LOWER(q.question_type) IN (${essayTypeList})
    ${selectionSql}
  `;
}

/* ------------------------------ 1. dashboard ------------------------------ */

async function dashboardCounts(pool, { teacherId, selection = {} }) {
  const sel = normaliseSelection(selection);
  const request = pool.request().input("teacherId", sql.Int, teacherId);
  const where = applySelection(request, sel);
  const result = await request.query(`
    WITH f AS (${answerFactsSql(where)})
    SELECT
      COUNT(*)                                                                                    AS total_answers,
      SUM(CASE WHEN is_blank = 1 THEN 1 ELSE 0 END)                                               AS blank,
      SUM(CASE WHEN is_marked = 1 AND ai_approved = 0 THEN 1 ELSE 0 END)                          AS manually_marked,
      SUM(CASE WHEN awaiting_review = 1 AND is_marked = 0 THEN 1 ELSE 0 END)                      AS ai_awaiting_review,
      SUM(CASE WHEN ai_approved = 1 THEN 1 ELSE 0 END)                                            AS approved_ai,
      SUM(CASE WHEN is_blank = 0 AND is_marked = 0 AND has_live_eval = 0 THEN 1 ELSE 0 END)       AS unmarked,
      SUM(CASE WHEN needs_attention = 1 AND is_marked = 0 THEN 1 ELSE 0 END)                      AS needs_attention
    FROM f
  `);
  const r = result.recordset[0] || {};
  const n = (v) => Number(v) || 0;
  return {
    totalAnswers: n(r.total_answers),
    blank: n(r.blank),
    manuallyMarked: n(r.manually_marked),
    aiAwaitingReview: n(r.ai_awaiting_review),
    approvedAi: n(r.approved_ai),
    unmarked: n(r.unmarked),
    needsAttention: n(r.needs_attention),
  };
}

/* ------------------------------ 2. what can be picked ------------------------------ */

/**
 * Lists for the selectors. Always limited to submissions assigned to this
 * teacher. `eAssessmentId` narrows the question/submission lists.
 */
async function resolveSelectable(pool, { teacherId, eAssessmentId = null }) {
  const assessments = await pool.request().input("teacherId", sql.Int, teacherId).query(`
    SELECT ea.id, ea.title, ea.subject, COUNT(DISTINCT s.id) AS submissions
    FROM e_assessments ea
    JOIN e_assessment_submissions s ON s.e_assessment_id = ea.id
    JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id AND asg.teacher_id = @teacherId
    GROUP BY ea.id, ea.title, ea.subject
    ORDER BY ea.id DESC
  `);
  const out = { assessments: assessments.recordset, questions: [], submissions: [] };
  if (eAssessmentId == null) return out;
  const id = Number(eAssessmentId);
  if (!Number.isInteger(id) || id < 1) throw new SelectionError("eAssessmentId must be a positive whole number");

  const questions = await pool.request().input("id", sql.Int, id).input("teacherId", sql.Int, teacherId).query(`
    SELECT q.id, LEFT(CAST(q.question_text AS NVARCHAR(MAX)), 160) AS question_text, q.marks,
      CASE WHEN EXISTS (SELECT 1 FROM ai_marking_scheme_versions sv WHERE sv.question_id = q.id AND sv.status = 'approved' AND sv.max_marks = q.marks)
           THEN 1 ELSE 0 END AS has_scheme
    FROM e_assessment_questions q
    WHERE q.e_assessment_id = @id AND LOWER(q.question_type) IN (${essayTypeList})
      AND EXISTS (
        SELECT 1 FROM e_assessment_submissions s
        JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id AND asg.teacher_id = @teacherId
        WHERE s.e_assessment_id = q.e_assessment_id)
    ORDER BY q.id
  `);
  const submissions = await pool.request().input("id", sql.Int, id).input("teacherId", sql.Int, teacherId).query(`
    SELECT s.id AS submission_id, s.student_id, s.status
    FROM e_assessment_submissions s
    JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id AND asg.teacher_id = @teacherId
    WHERE s.e_assessment_id = @id
    ORDER BY s.id
  `);
  out.questions = questions.recordset.map((q) => ({ ...q, has_scheme: !!q.has_scheme }));
  out.submissions = submissions.recordset;
  return out;
}

/* ------------------------------ 3. preview + quote ------------------------------ */

/** Stable fingerprint of what the teacher was shown. Phase 4 recomputes it at confirm time. */
function quoteFingerprint({ selection, billable, unitPrice, total, currency, pricingId }) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ selection, billable, unitPrice, total, currency, pricingId }))
    .digest("hex");
}

async function buildPreview(pool, { teacherId, selection = {}, planCode = null }) {
  const sel = normaliseSelection(selection);
  const request = pool.request().input("teacherId", sql.Int, teacherId);
  const where = applySelection(request, sel);

  const counts = await request.query(`
    WITH f AS (${answerFactsSql(where)})
    SELECT
      COUNT(*)                                                                                    AS selected_answers,
      SUM(CASE WHEN is_blank = 1 THEN 1 ELSE 0 END)                                               AS blank,
      SUM(CASE WHEN is_blank = 0 AND is_released = 1 THEN 1 ELSE 0 END)                           AS released,
      SUM(CASE WHEN is_blank = 0 AND is_released = 0 AND is_marked = 1 THEN 1 ELSE 0 END)         AS already_marked,
      SUM(CASE WHEN is_blank = 0 AND is_released = 0 AND is_marked = 0 AND has_live_eval = 1
               THEN 1 ELSE 0 END)                                                                 AS already_evaluated,
      SUM(CASE WHEN is_blank = 0 AND is_released = 0 AND is_marked = 0 AND has_live_eval = 0
               AND has_scheme = 0 THEN 1 ELSE 0 END)                                              AS needs_scheme,
      SUM(CASE WHEN ${BILLABLE_PREDICATE} THEN 1 ELSE 0 END)                                      AS billable
    FROM f
  `);
  const c = counts.recordset[0] || {};
  const n = (v) => Number(v) || 0;
  const breakdownRequest = pool.request().input("teacherId", sql.Int, teacherId);
  const breakdownWhere = applySelection(breakdownRequest, sel);
  const breakdown = await breakdownRequest.query(`
    WITH f AS (${answerFactsSql(breakdownWhere)})
    SELECT TOP 200 assessment_id, assessment_title, assessment_subject, question_id, COUNT(*) AS billable
    FROM f
    WHERE ${BILLABLE_PREDICATE}
    GROUP BY assessment_id, assessment_title, assessment_subject, question_id
    ORDER BY assessment_id, question_id
  `);

  const billable = n(c.billable);
  const pricing = await ledger.getActivePricing(pool, { planCode });
  const wallet = await ledger.getOrCreateInstitutionWallet(pool);

  const blockers = [];
  let quote = null;
  if (!pricing) {
    blockers.push("NO_PRICE");
  } else {
    quote = ledger.computeQuote(pricing, billable);
    if (!pricing.institution_wallets_enabled) blockers.push("INSTITUTION_WALLET_DISABLED");
  }
  if (quote && String(pricing.currency) !== String(wallet.currency)) blockers.push("CURRENCY_MISMATCH");
  if (billable === 0) blockers.push("NOTHING_ELIGIBLE");
  if (billable > maxAnswersPerJob()) blockers.push("TOO_MANY_ANSWERS");

  const available = Number(wallet.available_balance);
  const total = quote ? quote.total : null;
  const affordable = quote ? (await ledger.checkAffordability(pool, { walletId: wallet.id, quotedTotal: quote.total })).affordable : false;
  if (quote && billable > 0 && !affordable) blockers.push("INSUFFICIENT_CREDITS");

  return {
    selection: sel,
    counts: {
      selectedAnswers: n(c.selected_answers),
      blank: n(c.blank),
      released: n(c.released),
      alreadyMarked: n(c.already_marked),
      alreadyEvaluated: n(c.already_evaluated),
      needsScheme: n(c.needs_scheme),
      billable,
    },
    breakdown: breakdown.recordset.map((b) => ({
      assessmentId: b.assessment_id, assessmentTitle: b.assessment_title, subject: b.assessment_subject,
      questionId: b.question_id, billable: Number(b.billable),
    })),
    quote: quote && {
      unitPrice: quote.unitPrice, basePrice: quote.basePrice, total: quote.total,
      currency: quote.currency, appliedTier: quote.appliedTier, pricingId: quote.pricingId,
    },
    wallet: {
      available,
      reserved: Number(wallet.reserved_balance),
      currency: wallet.currency,
      // Display only. reserveForJob's locked read is the real gate.
      remainingAfterReservation: total == null ? null : Math.round((available - Number(total)) * 10000) / 10000,
      affordable,
    },
    limits: { maxAnswersPerJob: maxAnswersPerJob() },
    estimatedSeconds: null,                 // no measured queue throughput exists yet; never guess
    blockers,
    canProceed: blockers.length === 0,
    quoteFingerprint: quote
      ? quoteFingerprint({ selection: sel, billable, unitPrice: quote.unitPrice, total: quote.total, currency: quote.currency, pricingId: quote.pricingId })
      : null,
    generatedAt: new Date().toISOString(),
  };
}

/** Teacher-visible wallet info: balance only, never the ledger. */
async function teacherWalletSummary(pool, { planCode = null } = {}) {
  const [wallet, pricing] = await Promise.all([
    ledger.getOrCreateInstitutionWallet(pool),
    ledger.getActivePricing(pool, { planCode }),
  ]);
  return {
    available: Number(wallet.available_balance),
    reserved: Number(wallet.reserved_balance),
    currency: wallet.currency,
    aiMarkingEnabled: !!pricing && !!pricing.institution_wallets_enabled,
    unitPrice: pricing ? Number(pricing.price_per_answer) : null,
  };
}

module.exports = {
  SelectionError, ESSAY_TYPES, MAX_ID_LIST, BILLABLE_PREDICATE, maxAnswersPerJob,
  normaliseSelection, applySelection, answerFactsSql,
  dashboardCounts, resolveSelectable, buildPreview, teacherWalletSummary, quoteFingerprint,
};
