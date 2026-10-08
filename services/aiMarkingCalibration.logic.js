/* =========================================================================
   AI MARKING — CALIBRATION LOGIC (Phase 9). Pure: no SQL, no clock, no I/O.

   QUESTION IT ANSWERS
     "For schemes teachers approved, how often did the teacher end up giving the
     mark the AI suggested?" — per scheme version, so a rewritten scheme can be
     compared with the one it replaced.

   WHAT COUNTS
     Only evaluations a teacher has decided on in the Phase 7 review:
       approved  -> there is an AI suggestion AND a final teacher mark: compare them
       rejected  -> the teacher refused the suggestion: counted as a disagreement
     Everything else (awaiting review, superseded by a re-evaluation, marked
     manually, failed) is ignored. It is a statement about teacher DECISIONS, not
     about who is "right".

   DEFINITIONS (all shown to the teacher; nothing hidden)
     difference      = AI suggested mark - teacher final mark   (+ = AI was more generous)
     agrees          = approved AND |difference| <= tolerance, where
                       tolerance = max(0.5 mark, 10% of the question's marks)
     agreement rate  = agrees / (approved + rejected)
     bias            = average difference as % of the question's marks (approved only)

   SMALL SAMPLES
     A rate from 4 answers means almost nothing, so the verdict uses the 95% Wilson
     interval of the agreement rate, and says "not enough data" below MIN_SAMPLE decisions.
     "agrees" needs the LOWER end of the interval to be high; "disagrees" needs the
     UPPER end to be low. Anything in between is "mixed" — not a failure.

   WHAT THIS CANNOT TELL YOU (the screen says so)
     - Agreement is not accuracy. A teacher who accepts suggestions without reading
       them makes any scheme look perfect. Bulk-accept leaves no separate trace here.
     - Disagreement does not say whether the scheme or the AI is at fault, or whether
       the teacher was being inconsistent.
========================================================================= */

const MIN_SAMPLE = 10;                 // decisions needed before any verdict
const TOLERANCE_FLOOR = 0.5;           // marks
const TOLERANCE_FRACTION = 0.1;        // of the question's marks
const AGREE_LOWER = 0.75;              // Wilson lower bound needed for "agrees"
const DISAGREE_UPPER = 0.6;            // Wilson upper bound below which it "disagrees"
const BIAS_OK_PCT = 5;                 // |bias| allowed for "agrees"
const BIAS_BAD_PCT = 10;               // |bias| above which it "disagrees"
const RUBBER_STAMP_SHARE = 0.95;       // share of approvals identical to the AI ...
const RUBBER_STAMP_MIN = 20;           // ... once there are at least this many approvals
const Z95 = 1.96;
const EPS = 1e-9;

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const round = (n, dp = 1) => { const f = 10 ** dp; return Math.round((n + Number.EPSILON) * f) / f; };

function toleranceFor(maxMarks) {
  return Math.max(TOLERANCE_FLOOR, TOLERANCE_FRACTION * maxMarks);
}

/** 95% Wilson score interval for k successes in n trials. n = 0 -> null. */
function wilson(k, n) {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Validate one raw row. Returns a clean row or null (counted as skipped).
 * Raw: { evaluation_id, scheme_version_id, version_no, question_id, max_marks, suggested_total, teacher_final_mark, review_state }
 */
function normaliseRow(r) {
  if (!r || typeof r !== "object") return null;
  // Phase 7 writes review_state='adjusted' when the teacher moved the mark and 'approved' when
  // they kept it. Both are "approved with a final mark"; whether the mark moved is decided below
  // from the numbers, so 'adjusted' must be read here or every changed mark would vanish.
  const rawState = String(r.review_state || "").toLowerCase();
  if (rawState !== "approved" && rawState !== "adjusted" && rawState !== "rejected") return null;
  const state = rawState === "rejected" ? "rejected" : "approved";
  const maxMarks = num(r.max_marks);
  const versionId = Number(r.scheme_version_id);
  const questionId = Number(r.question_id);
  if (!(maxMarks > 0) || !Number.isInteger(versionId) || !Number.isInteger(questionId)) return null;
  if (state === "rejected") {
    return { versionId, versionNo: Number(r.version_no) || null, questionId, maxMarks, state, suggested: null, final: null };
  }
  const suggested = num(r.suggested_total);
  const final = num(r.teacher_final_mark);
  if (!Number.isFinite(suggested) || !Number.isFinite(final)) return null;
  if (suggested < 0 || final < 0 || suggested > maxMarks + EPS || final > maxMarks + EPS) return null;
  return { versionId, versionNo: Number(r.version_no) || null, questionId, maxMarks, state, suggested, final };
}

/** Stats for a set of clean rows (any grouping). */
function summarise(rows) {
  const approved = rows.filter((r) => r.state === "approved");
  const rejected = rows.length - approved.length;
  const reviewed = rows.length;

  let exact = 0, agrees = 0, higher = 0, lower = 0, signedPct = 0, absPct = 0;
  for (const r of approved) {
    const diff = r.suggested - r.final;
    if (Math.abs(diff) <= EPS) exact += 1;
    if (Math.abs(diff) <= toleranceFor(r.maxMarks) + EPS) agrees += 1;
    if (diff > EPS) higher += 1; else if (diff < -EPS) lower += 1;
    signedPct += (diff / r.maxMarks) * 100;
    absPct += (Math.abs(diff) / r.maxMarks) * 100;
  }
  const n = approved.length;
  const interval = wilson(agrees, reviewed);
  const stats = {
    reviewed,
    approved: n,
    rejected,
    unchanged: exact,                       // approved, AI mark == final mark
    changedByTeacher: n - exact,            // approved, but the teacher moved the mark
    withinTolerance: agrees,
    aiHigher: higher,
    aiLower: lower,
    agreementRate: reviewed ? round(agrees / reviewed, 3) : null,
    agreementLow: interval ? round(interval.low, 3) : null,
    agreementHigh: interval ? round(interval.high, 3) : null,
    biasPct: n ? round(signedPct / n, 1) : null,
    meanAbsErrorPct: n ? round(absPct / n, 1) : null,
  };
  const { verdict, reasons } = judge(stats, interval);
  stats.verdict = verdict;
  stats.reasons = reasons;
  stats.notes = notesFor(stats);
  return stats;
}

function judge(s, interval) {
  if (s.reviewed < MIN_SAMPLE) {
    return { verdict: "not_enough_data", reasons: [`Only ${s.reviewed} reviewed answer(s) so far; at least ${MIN_SAMPLE} are needed before this means anything.`] };
  }
  const bias = s.biasPct;
  const biasKnown = s.approved >= MIN_SAMPLE && bias !== null;
  const reasons = [];
  const lowRate = interval.high < DISAGREE_UPPER;
  const badBias = biasKnown && Math.abs(bias) > BIAS_BAD_PCT;
  if (lowRate) reasons.push(`Teachers gave a mark within the tolerance of the AI's in only ${Math.round(s.agreementRate * 100)}% of ${s.reviewed} reviewed answers (even allowing for chance, under ${Math.round(DISAGREE_UPPER * 100)}%).`);
  if (badBias) reasons.push(`The AI is ${bias > 0 ? "more generous" : "stricter"} than teachers by about ${Math.abs(bias)}% of the marks on average.`);
  if (lowRate || badBias) return { verdict: "disagrees", reasons };

  const goodRate = interval.low >= AGREE_LOWER;
  const okBias = !biasKnown || Math.abs(bias) <= BIAS_OK_PCT;
  if (goodRate && okBias) {
    return { verdict: "agrees", reasons: [`Teachers' marks were within the tolerance of the AI's in ${Math.round(s.agreementRate * 100)}% of ${s.reviewed} reviewed answers.`] };
  }
  if (!goodRate) reasons.push(`${Math.round(s.agreementRate * 100)}% agreement over ${s.reviewed} answers is not yet clearly high or clearly low.`);
  if (!okBias) reasons.push(`The AI runs ${bias > 0 ? "generous" : "strict"} by about ${Math.abs(bias)}% of the marks on average.`);
  return { verdict: "mixed", reasons };
}

function notesFor(s) {
  const notes = [];
  if (s.approved >= RUBBER_STAMP_MIN && s.unchanged / s.approved >= RUBBER_STAMP_SHARE) {
    notes.push({
      code: "NEARLY_ALL_UNCHANGED",
      message: "Almost every approved mark is identical to the AI's. That fits an accurate scheme, but also suggestions being accepted without being read. This report cannot tell which.",
    });
  }
  if (s.reviewed >= MIN_SAMPLE && s.rejected / s.reviewed >= 0.3) {
    notes.push({ code: "MANY_REJECTED", message: "Teachers rejected many suggestions outright. Open a few of them to see why before changing the scheme." });
  }
  return notes;
}

/** Group clean rows by a key function -> Map(key -> rows). */
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

/**
 * Build the per-question report.
 * @param {object[]} rawRows   rows for ONE question (any versions)
 * @param {object}   question  { question_id, marks, approved_version_id, approved_version_no }
 */
function questionReport(rawRows, question = {}) {
  let skipped = 0;
  const clean = [];
  for (const r of rawRows) { const c = normaliseRow(r); if (c) clean.push(c); else if (r && ["approved", "adjusted", "rejected"].includes(String(r.review_state || "").toLowerCase())) skipped += 1; }
  const byVersion = groupBy(clean, (r) => r.versionId);
  const versions = [...byVersion.entries()].map(([versionId, rows]) => ({
    versionId,
    versionNo: rows[0].versionNo,
    maxMarks: rows[0].maxMarks,
    isApproved: Number(question.approved_version_id) === versionId,
    ...summarise(rows),
  })).sort((a, b) => (b.versionNo || 0) - (a.versionNo || 0) || b.versionId - a.versionId);

  const current = versions.find((v) => v.isApproved) || null;
  return {
    questionId: Number(question.question_id) || null,
    approvedVersionId: question.approved_version_id ? Number(question.approved_version_id) : null,
    approvedVersionNo: question.approved_version_no ? Number(question.approved_version_no) : null,
    current,                                   // stats of the version in use now (null: nothing reviewed on it yet)
    versions,                                  // newest first
    skippedRows: skipped,
    // Headline = the approved version when it has data, otherwise nothing: an old
    // version's record must never make today's scheme look good or bad.
    verdict: current ? current.verdict : "not_enough_data",
  };
}

/** Roll the question reports up to one assessment summary. */
function assessmentReport(questionReports, allRows) {
  const counts = { agrees: 0, mixed: 0, disagrees: 0, not_enough_data: 0 };
  for (const q of questionReports) counts[q.verdict] = (counts[q.verdict] || 0) + 1;
  const clean = [];
  for (const r of allRows) { const c = normaliseRow(r); if (c) clean.push(c); }
  return { questionVerdicts: counts, overall: clean.length ? summarise(clean) : null };
}

const RULES = {
  minSample: MIN_SAMPLE,
  tolerance: { floorMarks: TOLERANCE_FLOOR, fractionOfMarks: TOLERANCE_FRACTION },
  agreesIfAgreementAtLeast: AGREE_LOWER,
  disagreesIfAgreementBelow: DISAGREE_UPPER,
  biasOkPct: BIAS_OK_PCT,
  biasBadPct: BIAS_BAD_PCT,
};

module.exports = {
  normaliseRow, summarise, questionReport, assessmentReport, wilson, toleranceFor, RULES,
  MIN_SAMPLE, TOLERANCE_FLOOR, TOLERANCE_FRACTION,
};
