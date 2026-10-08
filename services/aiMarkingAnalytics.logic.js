const Cal = require("./aiMarkingCalibration.logic");

/* =========================================================================
   AI MARKING — ANALYTICS LOGIC (Phase 10). PURE: no SQL, no I/O.

   TWO KINDS OF NUMBER, KEPT APART ON PURPOSE
     operational  how marking is going (counts, review outcomes, agreement, turnaround,
                  commonly missed criteria). Safe for teachers and institution admins.
     billing      what an institution/teacher was charged, from the LEDGER.
                  Safe for the people who were charged.
     economics    Doravo's own provider cost, margin and token use. FINANCE ONLY.
   Nothing in this file mixes them: economics is computed only from rows the
   finance store returns, and the operational/billing builders never see a cost.

   MONEY RULES
     - No currency conversion, ever. Amounts are grouped by currency. Provider cost is
       recorded in the provider's currency (token_usage_json.costCurrency); it is compared
       with charges ONLY when the currencies are identical, otherwise the margin is
       reported as unavailable (CURRENCY_MISMATCH). Inventing an FX rate would make the
       margin look precise when it is not.
     - A NULL provider cost means "prices not configured": UNKNOWN, never zero. It is
       counted separately and makes the margin "incomplete" rather than silently flattering.
     - Arithmetic is done in integer 1/10000ths, like the ledger, so sums do not drift.
========================================================================= */

class AnalyticsError extends Error {
  constructor(status, code, message) { super(message); this.name = "AnalyticsError"; this.statusCode = status; this.code = code; }
}

const SCALE = 10000;
const toScaled = (v) => Math.round(Number(v || 0) * SCALE);
const fromScaled = (n) => n / SCALE;
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, dp = 1) => { const f = 10 ** dp; return Math.round((n + Number.EPSILON) * f) / f; };
const pct = (num, den, dp = 1) => (den > 0 ? round((num / den) * 100, dp) : null);

const MIN_CRITERION_SAMPLE = 5;      // a criterion needs this many evaluations before it can be called "commonly missed"
const TOP_CRITERIA = 10;
const DAY_MS = 86400000;

const RULES = {
  period: "AI activity, billing and economics cover AI jobs CREATED in the period (from/to, inclusive, in the database server's local time). Everything about one job — its answers, its charge, its cost — falls in the same period, so the figures belong together.",
  position: "'Where marking stands' is a snapshot of now. It ignores the period because manual marks carry no timestamp.",
  eligible: "Eligible = an essay answer an AI job could be asked to mark right now: not blank, not marked, not released, no live AI evaluation, and its question has an approved marking scheme.",
  processed: "A processed answer is an AI evaluation that produced a suggestion (status success or needs_review). Only these are charged.",
  agreement: "Agreement counts answers where a teacher approved or adjusted the AI's mark (within the larger of 0.5 mark or 10% of the question) plus answers the teacher rejected, which count as disagreements. Waiting, failed and superseded answers are not counted.",
  turnaround: "AI turnaround = job created to job finished. Review turnaround = AI suggestion ready to teacher decision. Manual marking has no timestamp, so it has no turnaround.",
  missedCriteria: "A criterion is 'missed' when the AI awarded less than its full marks. Only criteria with at least " + MIN_CRITERION_SAMPLE + " evaluations are ranked.",
  charges: "Charges come from the wallet ledger: marks actually consumed when jobs finished, less any ledger reversals of those charges.",
};

/* ------------------------------ period ------------------------------ */

function parseDay(value, label) {
  if (value == null || value === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) throw new AnalyticsError(400, "INVALID_DATE", `${label} must be a date like 2026-09-30`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new AnalyticsError(400, "INVALID_DATE", `${label} is not a real calendar date`);
  }
  return d;
}

/** -> { from: Date|null, toExclusive: Date|null, label } . `to` is inclusive for the caller, exclusive in the query. */
function parseRange({ from, to } = {}) {
  const f = parseDay(from, "from");
  const t = parseDay(to, "to");
  if (f && t && f.getTime() > t.getTime()) throw new AnalyticsError(400, "INVALID_RANGE", "from must not be after to");
  return {
    from: f, toExclusive: t ? new Date(t.getTime() + DAY_MS) : null,
    label: { from: f ? f.toISOString().slice(0, 10) : null, to: t ? t.toISOString().slice(0, 10) : null },
  };
}

/* ------------------------------ operational ------------------------------ */

function shapePosition(r = {}) {
  const x = (k) => n0(r[k]);
  return {
    essayAnswers: x("total_answers"), blank: x("blank"), eligibleForAi: x("eligible"), needScheme: x("need_scheme"),
    unmarked: x("unmarked"), manuallyMarked: x("manually_marked"), aiAwaitingReview: x("ai_awaiting_review"),
    approvedAi: x("approved_ai"), needsAttention: x("needs_attention"),
  };
}

/** jobRows: [{status, jobs, answers_claimed, avg_ai_seconds}], evalRows: [{status, review_state, n}], reviewRow: {avg_review_seconds, reviewed}. */
function shapeActivity({ jobRows = [], evalRows = [], reviewRow = {} }) {
  const jobsByStatus = {};
  let jobs = 0, claimed = 0, aiSecSum = 0, aiSecN = 0;
  for (const r of jobRows) {
    const c = n0(r.jobs);
    jobsByStatus[r.status] = (jobsByStatus[r.status] || 0) + c;
    jobs += c; claimed += n0(r.answers_claimed);
    if (r.avg_ai_seconds != null && c > 0 && (r.status === "completed" || r.status === "failed" || r.status === "cancelled")) { aiSecSum += Number(r.avg_ai_seconds) * c; aiSecN += c; }
  }
  const byStatus = { success: 0, needs_review: 0, failed: 0, cancelled: 0, pending: 0 };
  const byReview = { awaiting_review: 0, approved: 0, adjusted: 0, rejected: 0, superseded: 0 };
  for (const r of evalRows) {
    const c = n0(r.n);
    if (r.status in byStatus) byStatus[r.status] += c;
    // Review outcomes are only meaningful for answers that HAD a suggestion.
    if ((r.status === "success" || r.status === "needs_review") && r.review_state in byReview) byReview[r.review_state] += c;
  }
  const processed = byStatus.success + byStatus.needs_review;
  const attempted = processed + byStatus.failed;
  const decided = byReview.approved + byReview.adjusted + byReview.rejected;
  return {
    requests: jobs, requestsByStatus: jobsByStatus, answersRequested: claimed,
    processed, processedClean: byStatus.success, processedFlagged: byStatus.needs_review,
    failed: byStatus.failed, cancelled: byStatus.cancelled, stillPending: byStatus.pending,
    failureRatePct: pct(byStatus.failed, attempted),
    review: {
      awaiting: byReview.awaiting_review, approvedUnchanged: byReview.approved, modifiedByTeacher: byReview.adjusted,
      rejected: byReview.rejected, superseded: byReview.superseded,
      teacherApproved: byReview.approved + byReview.adjusted,
      modifiedSharePct: pct(byReview.adjusted, byReview.approved + byReview.adjusted),
      decidedSharePct: pct(decided, processed),
    },
    turnaround: {
      aiAverageSeconds: aiSecN ? Math.round(aiSecSum / aiSecN) : null,
      reviewAverageSeconds: reviewRow.reviewed > 0 && reviewRow.avg_review_seconds != null ? Math.round(Number(reviewRow.avg_review_seconds)) : null,
      reviewSample: n0(reviewRow.reviewed),
    },
  };
}

function shapeAgreement(rawRows, truncated) {
  const clean = [];
  let skipped = 0;
  for (const r of rawRows || []) { const c = Cal.normaliseRow(r); if (c) clean.push(c); else skipped += 1; }
  const s = Cal.summarise(clean);
  return {
    decisions: s.reviewed, kept: s.unchanged, moved: s.changedByTeacher, rejected: s.rejected,
    agreementRatePct: s.agreementRate == null ? null : round(s.agreementRate * 100, 1),
    agreementLowPct: s.agreementLow == null ? null : round(s.agreementLow * 100, 1),
    agreementHighPct: s.agreementHigh == null ? null : round(s.agreementHigh * 100, 1),
    biasPct: s.biasPct, meanAbsErrorPct: s.meanAbsErrorPct,
    enoughData: s.verdict !== "not_enough_data", notes: s.notes, skipped, truncated: !!truncated,
  };
}

function parseJson(v) { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } }

/** criteriaRows: [{question_id, scheme_version_id, criteria_json}]. Returns the most often missed criteria. Evidence/explanations are never read. */
function missedCriteria(criteriaRows, questionText = new Map()) {
  const acc = new Map();
  for (const r of criteriaRows || []) {
    const parsed = parseJson(r.criteria_json);
    const list = parsed && Array.isArray(parsed.criteria) ? parsed.criteria : [];
    for (const c of list) {
      const max = Number(c.maxMarks), got = Number(c.marksAwarded);
      if (!c.criterionId || !(max > 0) || !Number.isFinite(got)) continue;
      const key = `${r.question_id}|${r.scheme_version_id}|${c.criterionId}`;
      let a = acc.get(key);
      if (!a) { a = { questionId: Number(r.question_id), schemeVersionId: r.scheme_version_id == null ? null : Number(r.scheme_version_id), criterionId: String(c.criterionId), label: String(c.label || c.criterionId).slice(0, 200), maxMarks: max, n: 0, full: 0, zero: 0, pctSum: 0 }; acc.set(key, a); }
      a.n += 1; if (got >= max - 1e-9) a.full += 1; if (got <= 1e-9) a.zero += 1;
      a.pctSum += Math.min(1, Math.max(0, got / max));
    }
  }
  const rows = [...acc.values()].filter((a) => a.n >= MIN_CRITERION_SAMPLE).map((a) => ({
    questionId: a.questionId, questionText: questionText.get(a.questionId) || null, schemeVersionId: a.schemeVersionId,
    criterionId: a.criterionId, label: a.label, maxMarks: a.maxMarks, evaluated: a.n,
    missedPct: pct(a.n - a.full, a.n), zeroPct: pct(a.zero, a.n), averageAwardedPct: round((a.pctSum / a.n) * 100, 1),
  }));
  rows.sort((x, y) => y.missedPct - x.missedPct || y.evaluated - x.evaluated || x.questionId - y.questionId);
  return rows.slice(0, TOP_CRITERIA);
}

/* ------------------------------ billing (from the ledger) ------------------------------ */

/** grossRows/refundRows: [{currency, amount, answers?}] -> per currency. */
function shapeBilling({ grossRows = [], refundRows = [] }) {
  const by = new Map();
  const slot = (cur) => { const k = cur || "UNSPECIFIED"; if (!by.has(k)) by.set(k, { currency: k, gross: 0, refunded: 0 }); return by.get(k); };
  for (const r of grossRows) slot(r.currency).gross += toScaled(r.amount);
  for (const r of refundRows) slot(r.currency).refunded += toScaled(r.amount);
  return [...by.values()].map((s) => ({
    currency: s.currency, charged: fromScaled(s.gross), reversed: fromScaled(s.refunded), net: fromScaled(s.gross - s.refunded),
  })).sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ------------------------------ economics (FINANCE ONLY) ------------------------------ */

/** Accumulator so several tenants' cost rows can be folded into ONE economics result with the same rules. */
function newCostAcc() { return new Map(); }

/**
 * costRows: [{ currency (the job's charge currency), status, processing_cost, token_usage_json, reused }]
 */
function addCostRows(acc, costRows) {
  const slot = (cur) => {
    const k = cur || "UNSPECIFIED";
    if (!acc.has(k)) acc.set(k, { billed: 0, costByCur: new Map(), billedCost: 0, unbilledCost: 0, unknown: 0, input: 0, output: 0, tokenAnswers: 0 });
    return acc.get(k);
  };
  for (const r of costRows || []) {
    const s = slot(r.currency);
    const billed = r.status === "success" || r.status === "needs_review";
    if (billed) s.billed += 1;
    const t = parseJson(r.token_usage_json) || {};
    const inTok = n0(t.inputTokens), outTok = n0(t.outputTokens);
    if (inTok || outTok) { s.input += inTok; s.output += outTok; s.tokenAnswers += 1; }
    if (r.processing_cost == null) {
      // A billed answer with no cost and no reuse marker really did cost something we cannot see.
      if (billed && !r.reused) s.unknown += 1;
      continue;
    }
    const costCur = (t.costCurrency && String(t.costCurrency)) || "UNSPECIFIED";
    const scaled = toScaled(r.processing_cost);
    s.costByCur.set(costCur, (s.costByCur.get(costCur) || 0) + scaled);
    if (billed) s.billedCost += scaled; else s.unbilledCost += scaled;
  }
  return acc;
}

/** Add several tenants' billing results (each from shapeBilling) into one list, per currency. */
function mergeBilling(lists) {
  const by = new Map();
  for (const list of lists) for (const b of list || []) {
    const cur = by.get(b.currency) || { currency: b.currency, gross: 0, refunded: 0 };
    cur.gross += toScaled(b.charged); cur.refunded += toScaled(b.reversed);
    by.set(b.currency, cur);
  }
  return shapeBilling({ grossRows: [...by.values()].map((x) => ({ currency: x.currency, amount: fromScaled(x.gross) })), refundRows: [...by.values()].map((x) => ({ currency: x.currency, amount: fromScaled(x.refunded) })) });
}

function finishEconomics(acc, billing = [], truncated = false) {
  const money = new Map(billing.map((b) => [b.currency, b]));
  const currencies = new Set([...acc.keys(), ...money.keys()]);
  const out = [];
  for (const cur of [...currencies].sort()) {
    const s = acc.get(cur) || { billed: 0, costByCur: new Map(), billedCost: 0, unbilledCost: 0, unknown: 0, input: 0, output: 0, tokenAnswers: 0 };
    const b = money.get(cur) || { charged: 0, reversed: 0, net: 0 };
    const costCurrencies = [...s.costByCur.keys()];
    const sameOnly = costCurrencies.length === 0 || (costCurrencies.length === 1 && costCurrencies[0] === cur);
    const totalCostScaled = costCurrencies.reduce((a, k) => a + s.costByCur.get(k), 0);
    let status, margin = null, marginPct = null;
    if (!sameOnly) status = "CURRENCY_MISMATCH";
    else if (costCurrencies.length === 0 && s.billed > 0) status = "NO_COST_DATA";
    else if (s.unknown > 0) status = "INCOMPLETE_COST";
    else status = "COMPLETE";
    if (sameOnly && (status === "COMPLETE" || status === "INCOMPLETE_COST") && (b.net !== 0 || totalCostScaled !== 0)) {
      margin = fromScaled(toScaled(b.net) - totalCostScaled);
      marginPct = b.net > 0 ? round((margin / b.net) * 100, 1) : null;
    }
    out.push({
      chargeCurrency: cur,
      charged: b.charged, reversed: b.reversed, netCharged: b.net,
      billedAnswers: s.billed,
      averagePricePerAnswer: s.billed > 0 && b.net > 0 ? round(b.net / s.billed, 4) : null,
      providerCost: costCurrencies.map((k) => ({ costCurrency: k, total: fromScaled(s.costByCur.get(k)) })),
      costOnUnbilledAttempts: sameOnly ? fromScaled(s.unbilledCost) : null,   // spend that earned nothing: failed / cancelled answers
      billedAnswersWithUnknownCost: s.unknown,
      averageCostPerBilledAnswer: sameOnly && s.billed - s.unknown > 0 ? round(fromScaled(s.billedCost) / (s.billed - s.unknown), 4) : null,
      averageCostFullyLoaded: sameOnly && s.billed > 0 && s.unknown === 0 ? round(fromScaled(totalCostScaled) / s.billed, 4) : null,
      estimatedGrossMargin: margin, estimatedGrossMarginPct: marginPct, marginStatus: status,
      tokens: {
        input: s.input, output: s.output,
        averageInputPerAnswer: s.tokenAnswers ? Math.round(s.input / s.tokenAnswers) : null,
        averageOutputPerAnswer: s.tokenAnswers ? Math.round(s.output / s.tokenAnswers) : null,
      },
    });
  }
  return { byCurrency: out, truncated: !!truncated };
}

function shapeEconomics({ costRows = [], billing = [], truncated = false }) {
  return finishEconomics(addCostRows(newCostAcc(), costRows), billing, truncated);
}

const MARGIN_STATUS_TEXT = {
  COMPLETE: "Every billed answer has a known provider cost.",
  INCOMPLETE_COST: "Some billed answers have no recorded provider cost (provider prices not configured when they ran). The margin is overstated by that missing cost.",
  CURRENCY_MISMATCH: "Provider cost is recorded in a different currency from the charge. No exchange rate is applied, so no margin is shown.",
  NO_COST_DATA: "No provider cost has been recorded. Set the provider price variables to measure cost and margin.",
};

module.exports = {
  AnalyticsError, RULES, MARGIN_STATUS_TEXT, MIN_CRITERION_SAMPLE, TOP_CRITERIA,
  parseRange, shapePosition, shapeActivity, shapeAgreement, missedCriteria, shapeBilling, shapeEconomics,
  newCostAcc, addCostRows, finishEconomics, mergeBilling,
  toScaled, fromScaled,
};
