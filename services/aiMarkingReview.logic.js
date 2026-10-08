const { htmlToText } = require("./aiMarkingEngine.prompt");

/* =========================================================================
   AI MARKING — REVIEW LOGIC (Phase 7). Pure functions: no database, no clock.

   A teacher turns a PROVISIONAL AI suggestion into a final mark here (or
   declines to). Everything that decides what number may become a mark lives
   in this file so it can be tested exhaustively.

   THE WHOLE-NUMBER RULE (decision D1)
   Official marks are integers end to end (e_assessment_answers.marks_awarded,
   submission score, the Marks table), and the database refuses a fractional
   teacher_final_mark. The AI may score criteria in halves, so an AI total of
   3.5 is routine. That is NEVER rounded silently:
     - "accept" is allowed only when the suggested total is already whole;
     - otherwise the teacher is told the two nearest whole marks and chooses —
       which is recorded as an adjustment flagged `roundedFromSuggestion`,
       so later agreement statistics can tell rounding from disagreement.

   A teacher may set ANY whole mark from 0 to the question's maximum. The AI
   suggestion is advice, never a ceiling or a floor.
========================================================================= */

class ReviewError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "ReviewError";
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

const cents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;
const isTwoDp = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const isWhole = (n) => Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9;

function parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** The two nearest whole marks to a fractional total, kept inside [0, max]. */
function wholeMarkOptions(total, maxMarks) {
  const t = Number(total);
  const max = Math.floor(Number(maxMarks));
  const floor = Math.max(0, Math.min(max, Math.floor(t)));
  const ceil = Math.max(0, Math.min(max, Math.ceil(t)));
  return floor === ceil ? [floor] : [floor, ceil];
}

/**
 * Turn the stored evaluation + the pinned scheme into one display structure.
 * AI marks come from the evaluation (immutable once written); labels, expected
 * points and alternatives come from the scheme version it was marked against.
 */
function presentEvaluation({ criteriaJson, reviewFlags, schemeCriteriaJson, suggestedTotal, maxMarks }) {
  const stored = parseJson(criteriaJson, null);
  const scheme = parseJson(schemeCriteriaJson, []);
  const schemeById = new Map((Array.isArray(scheme) ? scheme : []).map((c) => [c.criterionId, c]));
  const criteria = ((stored && stored.criteria) || []).map((c) => {
    const s = schemeById.get(c.criterionId) || {};
    return {
      criterionId: c.criterionId,
      label: c.label ?? s.label ?? c.criterionId,
      maxMarks: Number(c.maxMarks ?? s.maxMarks),
      aiMarks: Number(c.marksAwarded),
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
      matchedPoints: Array.isArray(c.matchedPoints) ? c.matchedPoints : [],
      explanation: c.explanation || "",
      expectedPoints: Array.isArray(s.expectedPoints) ? s.expectedPoints : [],
      acceptableAlternatives: Array.isArray(s.acceptableAlternatives) ? s.acceptableAlternatives : [],
    };
  });
  const flags = parseJson(reviewFlags, []);
  const total = suggestedTotal == null ? null : Number(suggestedTotal);
  return {
    criteria,
    missingPoints: (stored && Array.isArray(stored.missingPoints)) ? stored.missingPoints : [],
    flags: Array.isArray(flags) ? flags : [],
    suggestedTotal: total,
    maxMarks: Number(maxMarks),
    suggestedIsWhole: total != null && isWhole(total),
    wholeOptions: total != null && !isWhole(total) ? wholeMarkOptions(total, maxMarks) : [],
  };
}

/**
 * Decide the final mark for an approval request. Throws ReviewError (400/409)
 * with a precise code; returns { finalMark, criteriaFinal, changed, roundedFromSuggestion }.
 *
 * request: { mode: "accept" | "adjust", criteriaMarks?: {id: number}, finalMark?: number }
 * ev:      the object from presentEvaluation (with `suggestedTotal` non-null)
 */
function resolveApproval(request, ev) {
  const { mode, criteriaMarks, finalMark } = request || {};
  if (mode !== "accept" && mode !== "adjust") throw new ReviewError(400, "BAD_MODE", 'mode must be "accept" or "adjust"');
  if (ev.suggestedTotal == null) throw new ReviewError(409, "NO_SUGGESTION", "This evaluation has no suggested mark");
  const max = ev.maxMarks;
  const suggestedC = cents(ev.suggestedTotal);

  if (mode === "accept") {
    if (criteriaMarks !== undefined || finalMark !== undefined) {
      throw new ReviewError(400, "ACCEPT_TAKES_NO_MARKS", 'Use mode "adjust" to change marks; "accept" takes the AI suggestion as it is');
    }
    if (!isWhole(ev.suggestedTotal)) {
      throw new ReviewError(409, "NEEDS_WHOLE_MARK",
        `The suggested total ${ev.suggestedTotal} is not a whole number and official marks must be whole. Choose a whole mark.`,
        { suggestedTotal: ev.suggestedTotal, options: wholeMarkOptions(ev.suggestedTotal, max) });
    }
    return {
      finalMark: Math.round(ev.suggestedTotal),
      criteriaFinal: ev.criteria.map((c) => ({ criterionId: c.criterionId, ai: c.aiMarks, final: c.aiMarks })),
      changed: false, roundedFromSuggestion: false,
    };
  }

  // ---- adjust ----
  const hasCriteria = criteriaMarks !== undefined && criteriaMarks !== null;
  const hasFinal = finalMark !== undefined && finalMark !== null;
  if (!hasCriteria && !hasFinal) throw new ReviewError(400, "NOTHING_TO_ADJUST", "Provide criteriaMarks and/or finalMark");

  let criteriaFinal = null;
  let total = null;

  if (hasCriteria) {
    if (typeof criteriaMarks !== "object" || Array.isArray(criteriaMarks)) throw new ReviewError(400, "BAD_CRITERIA_MARKS", "criteriaMarks must be an object of criterionId -> marks");
    const byId = new Map(ev.criteria.map((c) => [c.criterionId, c]));
    for (const [id, v] of Object.entries(criteriaMarks)) {
      const c = byId.get(id);
      if (!c) throw new ReviewError(400, "UNKNOWN_CRITERION", `"${id}" is not a criterion of this question's scheme`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ReviewError(400, "BAD_MARK", `Marks for ${id} must be a number`);
      if (v < 0) throw new ReviewError(400, "MARK_NEGATIVE", `Marks for ${id} cannot be negative`);
      if (!isTwoDp(v)) throw new ReviewError(400, "MARK_PRECISION", `Marks for ${id} can have at most 2 decimal places`);
      if (cents(v) > cents(c.maxMarks)) throw new ReviewError(400, "MARK_EXCEEDS_CRITERION", `Marks for ${id} cannot exceed its maximum of ${c.maxMarks}`);
    }
    criteriaFinal = ev.criteria.map((c) => ({
      criterionId: c.criterionId, ai: c.aiMarks,
      final: Object.prototype.hasOwnProperty.call(criteriaMarks, c.criterionId) ? criteriaMarks[c.criterionId] : c.aiMarks,
    }));
    total = fromCents(criteriaFinal.reduce((s, c) => s + cents(c.final), 0));
  }

  if (hasFinal) {
    if (typeof finalMark !== "number" || !Number.isFinite(finalMark)) throw new ReviewError(400, "BAD_MARK", "finalMark must be a number");
    if (!isWhole(finalMark)) throw new ReviewError(400, "NOT_WHOLE", "The final mark must be a whole number", { options: wholeMarkOptions(finalMark, max) });
    if (finalMark < 0 || finalMark > max) throw new ReviewError(400, "MARK_OUT_OF_RANGE", `The final mark must be between 0 and ${max}`);
    if (total != null && cents(total) !== cents(finalMark)) {
      throw new ReviewError(400, "TOTAL_MISMATCH", `The criterion marks add up to ${total}, which is not the final mark ${finalMark}`, { criteriaTotal: total });
    }
    total = finalMark;
  } else if (!isWhole(total)) {
    throw new ReviewError(400, "NOT_WHOLE", `The criterion marks add up to ${total}; official marks must be whole numbers. Adjust a criterion or choose a whole final mark.`,
      { criteriaTotal: total, options: wholeMarkOptions(total, max) });
  }
  if (total < 0 || total > max) throw new ReviewError(400, "MARK_OUT_OF_RANGE", `The final mark must be between 0 and ${max}`);

  const criteriaChanged = criteriaFinal ? criteriaFinal.some((c) => cents(c.final) !== cents(c.ai)) : false;
  const totalChanged = cents(total) !== suggestedC;
  const roundedFromSuggestion = !criteriaChanged && !isWhole(ev.suggestedTotal) && Math.abs(total - ev.suggestedTotal) < 1;
  return {
    finalMark: Math.round(total), criteriaFinal,
    changed: criteriaChanged || totalChanged, roundedFromSuggestion,
  };
}

/** Reasons are required for every decision that goes against, or asks more of, the AI. */
const REASON_REQUIRED = new Set(["reject", "request_reevaluation", "flag_scheme"]);

function cleanText(value, { max, field, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ReviewError(400, "REASON_REQUIRED", `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new ReviewError(400, "BAD_TEXT", `${field} must be text`);
  const t = value.trim();
  if (!t) {
    if (required) throw new ReviewError(400, "REASON_REQUIRED", `${field} is required`);
    return null;
  }
  if (t.length > max) throw new ReviewError(400, "TEXT_TOO_LONG", `${field} must be at most ${max} characters`);
  return t;
}

/** Plain text for display — student/question HTML is never sent to the review screen as HTML. */
function toPlainText(html) {
  const { text, hasImage } = htmlToText(html);
  return { text, hasImage };
}

/** Facts about one flag, in words a teacher can act on. */
const FLAG_TEXT = {
  ambiguous_answer: "The answer can be read more than one way.",
  alternative_not_in_scheme: "The answer makes a point the scheme does not list. Check it deserves marks.",
  off_topic: "The answer appears to be off topic.",
  partially_illegible: "Part of the answer could not be read.",
  contradictory_answer: "The answer contradicts itself.",
  scheme_unclear: "The AI found the marking scheme unclear for this answer.",
  instructions_in_answer: "The answer contains text that looks like instructions to the marker. It was ignored.",
};

module.exports = {
  ReviewError, REASON_REQUIRED, FLAG_TEXT,
  resolveApproval, presentEvaluation, wholeMarkOptions, cleanText, toPlainText,
  cents, isWhole, parseJson,
};
