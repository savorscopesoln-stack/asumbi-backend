const { FLAG_CODES, normaliseForMatch } = require("./aiMarkingEngine.prompt");

/* =========================================================================
   AI MARKING ENGINE — STRICT VALIDATION (Phase 5)

   Nothing the model returns is trusted. validateModelOutput() either yields
   a normalised object whose numbers are guaranteed in range and internally
   consistent, or a list of coded errors. There is no "repair": a reply that
   fails is retried (bounded) or sent to manual marking — it is NEVER turned
   into a zero mark.

   Marks are compared as integers in hundredths so 0.1+0.2 style drift
   cannot cause a false pass or fail.
========================================================================= */

const cents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;
const isTwoDp = (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const err = (code, path, message) => ({ code, path, message });

const MAX_CRITERIA = 30;
const MAX_EVIDENCE_ITEMS = 5, MAX_EVIDENCE_CHARS = 500, MAX_EXPLANATION_CHARS = 800;
const MAX_MISSING_ITEMS = 12, MAX_MISSING_CHARS = 300;

/** The scheme comes from an approved ai_marking_scheme_versions row; still checked, because a bad scheme must cost nothing. */
function validateScheme(criteria, questionMax) {
  const errors = [];
  if (!Array.isArray(criteria) || criteria.length === 0) return [err("SCHEME_EMPTY", "criteria", "The marking scheme has no criteria")];
  if (criteria.length > MAX_CRITERIA) errors.push(err("SCHEME_TOO_LARGE", "criteria", `More than ${MAX_CRITERIA} criteria`));
  if (!isTwoDp(questionMax) || !(questionMax > 0)) errors.push(err("SCHEME_MAX_INVALID", "maxMarks", "Question maximum must be a positive number"));
  const seen = new Set();
  let sum = 0;
  criteria.forEach((c, i) => {
    const p = `criteria[${i}]`;
    if (!isPlainObject(c)) { errors.push(err("SCHEME_CRITERION_INVALID", p, "Not an object")); return; }
    if (typeof c.criterionId !== "string" || !c.criterionId.trim() || c.criterionId.length > 40) errors.push(err("SCHEME_CRITERION_ID", p, "criterionId must be a non-empty string up to 40 characters"));
    else if (seen.has(c.criterionId)) errors.push(err("SCHEME_DUPLICATE_ID", p, `Duplicate criterionId ${c.criterionId}`));
    else seen.add(c.criterionId);
    if (typeof c.label !== "string" || !c.label.trim()) errors.push(err("SCHEME_LABEL", p, "label is required"));
    if (!isTwoDp(c.maxMarks) || !(c.maxMarks > 0)) errors.push(err("SCHEME_CRITERION_MAX", p, "maxMarks must be a positive number with at most 2 decimals"));
    else sum += cents(c.maxMarks);
    for (const key of ["expectedPoints", "acceptableAlternatives"]) {
      if (c[key] != null && (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== "string"))) errors.push(err("SCHEME_LIST", `${p}.${key}`, `${key} must be an array of strings`));
    }
  });
  if (isTwoDp(questionMax) && sum > cents(questionMax)) errors.push(err("SCHEME_EXCEEDS_QUESTION", "criteria", "Criterion marks add up to more than the question's maximum"));
  return errors;
}

/**
 * @returns {{ok:true, cannotEvaluate:false, value}|{ok:true, cannotEvaluate:true, reason}|{ok:false, errors}}
 * value = { criteria:[{criterionId,label,maxMarks,marksAwarded,evidence,matchedPoints,explanation}],
 *           missingPoints, suggestedTotal, modelFlags }
 */
function validateModelOutput(parsed, { criteria, questionMax }) {
  const errors = [];
  if (!isPlainObject(parsed)) return { ok: false, errors: [err("NOT_OBJECT", "", "Reply must be one JSON object")] };

  const ALLOWED_TOP = new Set(["criteria", "missingPoints", "totalMarks", "flags", "cannotEvaluate", "cannotEvaluateReason"]);
  for (const k of Object.keys(parsed)) if (!ALLOWED_TOP.has(k)) errors.push(err("UNKNOWN_KEY", k, `Unexpected key ${k}`));

  if (typeof parsed.cannotEvaluate !== "boolean") errors.push(err("CANNOT_EVALUATE_TYPE", "cannotEvaluate", "cannotEvaluate must be true or false"));

  // flags
  let modelFlags = [];
  if (!Array.isArray(parsed.flags)) errors.push(err("FLAGS_TYPE", "flags", "flags must be an array"));
  else {
    parsed.flags.forEach((f, i) => { if (!FLAG_CODES.includes(f)) errors.push(err("FLAG_UNKNOWN", `flags[${i}]`, "Not one of the permitted flags")); });
    modelFlags = [...new Set(parsed.flags.filter((f) => FLAG_CODES.includes(f)))];
  }

  if (parsed.cannotEvaluate === true) {
    if (!Array.isArray(parsed.criteria) || parsed.criteria.length !== 0) errors.push(err("CANNOT_EVALUATE_CRITERIA", "criteria", "criteria must be empty when cannotEvaluate is true"));
    if (typeof parsed.cannotEvaluateReason !== "string" || !parsed.cannotEvaluateReason.trim()) errors.push(err("CANNOT_EVALUATE_REASON", "cannotEvaluateReason", "A reason is required"));
    if (parsed.totalMarks != null && !(typeof parsed.totalMarks === "number" && parsed.totalMarks === 0)) errors.push(err("CANNOT_EVALUATE_TOTAL", "totalMarks", "No total may be given when cannotEvaluate is true"));
    if (errors.length) return { ok: false, errors };
    return { ok: true, cannotEvaluate: true, reason: parsed.cannotEvaluateReason.trim().slice(0, 300) };
  }
  if (parsed.cannotEvaluate === false && parsed.cannotEvaluateReason != null && parsed.cannotEvaluateReason !== "") {
    errors.push(err("REASON_WITHOUT_FLAG", "cannotEvaluateReason", "cannotEvaluateReason must be null when cannotEvaluate is false"));
  }

  // criteria: exactly the scheme's set, each once
  const byId = new Map(criteria.map((c) => [c.criterionId, c]));
  const out = [];
  if (!Array.isArray(parsed.criteria)) errors.push(err("CRITERIA_TYPE", "criteria", "criteria must be an array"));
  else {
    const seen = new Set();
    parsed.criteria.forEach((r, i) => {
      const p = `criteria[${i}]`;
      if (!isPlainObject(r)) { errors.push(err("CRITERION_TYPE", p, "Not an object")); return; }
      for (const k of Object.keys(r)) if (!["criterionId", "marksAwarded", "evidence", "matchedPoints", "explanation"].includes(k)) errors.push(err("UNKNOWN_KEY", `${p}.${k}`, `Unexpected key ${k}`));
      const scheme = byId.get(r.criterionId);
      if (!scheme) { errors.push(err("CRITERION_UNKNOWN", `${p}.criterionId`, "criterionId is not in the scheme")); return; }
      if (seen.has(r.criterionId)) { errors.push(err("CRITERION_DUPLICATE", `${p}.criterionId`, `${r.criterionId} appears more than once`)); return; }
      seen.add(r.criterionId);

      let awardedOk = true;
      if (typeof r.marksAwarded !== "number" || !Number.isFinite(r.marksAwarded)) { errors.push(err("MARKS_TYPE", `${p}.marksAwarded`, "marksAwarded must be a number")); awardedOk = false; }
      else if (!isTwoDp(r.marksAwarded)) { errors.push(err("MARKS_PRECISION", `${p}.marksAwarded`, "At most 2 decimal places")); awardedOk = false; }
      else if (r.marksAwarded < 0) { errors.push(err("MARKS_NEGATIVE", `${p}.marksAwarded`, "Marks cannot be negative")); awardedOk = false; }
      else if (cents(r.marksAwarded) > cents(scheme.maxMarks)) { errors.push(err("MARKS_EXCEED_CRITERION", `${p}.marksAwarded`, `Exceeds the criterion maximum of ${scheme.maxMarks}`)); awardedOk = false; }

      let evidence = [];
      if (!Array.isArray(r.evidence) || r.evidence.some((x) => typeof x !== "string")) errors.push(err("EVIDENCE_TYPE", `${p}.evidence`, "evidence must be an array of strings"));
      else if (r.evidence.length > MAX_EVIDENCE_ITEMS || r.evidence.some((x) => x.length > MAX_EVIDENCE_CHARS)) errors.push(err("EVIDENCE_SIZE", `${p}.evidence`, "Too many or too long evidence quotes"));
      else evidence = r.evidence.map((x) => x.trim()).filter(Boolean);
      if (awardedOk && r.marksAwarded > 0 && evidence.length === 0) errors.push(err("EVIDENCE_REQUIRED", `${p}.evidence`, "Marks above 0 need at least one quote from the answer"));

      let matched = [];
      const expectedCount = (scheme.expectedPoints || []).length;
      if (!Array.isArray(r.matchedPoints) || r.matchedPoints.some((x) => !Number.isInteger(x))) errors.push(err("MATCHED_TYPE", `${p}.matchedPoints`, "matchedPoints must be an array of integers"));
      else if (r.matchedPoints.some((x) => x < 0 || x >= expectedCount)) errors.push(err("MATCHED_RANGE", `${p}.matchedPoints`, `Indexes must be between 0 and ${Math.max(expectedCount - 1, 0)}`));
      else if (new Set(r.matchedPoints).size !== r.matchedPoints.length) errors.push(err("MATCHED_DUPLICATE", `${p}.matchedPoints`, "Duplicate indexes"));
      else matched = r.matchedPoints;
      if (awardedOk && r.marksAwarded > 0 && expectedCount > 0 && matched.length === 0) errors.push(err("MATCHED_REQUIRED", `${p}.matchedPoints`, "Marks above 0 must cite at least one expected point"));

      if (typeof r.explanation !== "string" || !r.explanation.trim()) errors.push(err("EXPLANATION_REQUIRED", `${p}.explanation`, "explanation is required"));
      else if (r.explanation.length > MAX_EXPLANATION_CHARS) errors.push(err("EXPLANATION_SIZE", `${p}.explanation`, "explanation is too long"));

      if (awardedOk) out.push({
        criterionId: scheme.criterionId, label: scheme.label, maxMarks: scheme.maxMarks, allowEvidenceReuse: !!scheme.allowEvidenceReuse,
        marksAwarded: r.marksAwarded, evidence, matchedPoints: matched, explanation: typeof r.explanation === "string" ? r.explanation.trim() : "",
      });
    });
    for (const id of byId.keys()) if (!seen.has(id)) errors.push(err("CRITERION_MISSING", "criteria", `Missing criterion ${id}`));
  }

  // missingPoints
  let missingPoints = [];
  if (!Array.isArray(parsed.missingPoints) || parsed.missingPoints.some((x) => typeof x !== "string")) errors.push(err("MISSING_TYPE", "missingPoints", "missingPoints must be an array of strings"));
  else if (parsed.missingPoints.length > MAX_MISSING_ITEMS || parsed.missingPoints.some((x) => x.length > MAX_MISSING_CHARS)) errors.push(err("MISSING_SIZE", "missingPoints", "Too many or too long"));
  else missingPoints = parsed.missingPoints.map((x) => x.trim()).filter(Boolean);

  // total: recomputed by us, must agree with the model's own sum
  if (typeof parsed.totalMarks !== "number" || !Number.isFinite(parsed.totalMarks)) errors.push(err("TOTAL_TYPE", "totalMarks", "totalMarks must be a number"));
  if (errors.length) return { ok: false, errors };

  const sum = out.reduce((s, c) => s + cents(c.marksAwarded), 0);
  if (!isTwoDp(parsed.totalMarks) || cents(parsed.totalMarks) !== sum) return { ok: false, errors: [err("TOTAL_MISMATCH", "totalMarks", "totalMarks must equal the sum of marksAwarded")] };
  if (sum > cents(questionMax)) return { ok: false, errors: [err("TOTAL_EXCEEDS_QUESTION", "totalMarks", "Total exceeds the question maximum")] };

  // keep scheme order
  out.sort((a, b) => criteria.findIndex((c) => c.criterionId === a.criterionId) - criteria.findIndex((c) => c.criterionId === b.criterionId));
  return { ok: true, cannotEvaluate: false, value: { criteria: out, missingPoints, suggestedTotal: fromCents(sum), modelFlags } };
}

/* ------------------------------ evidence checks (deterministic review flags) ------------------------------ */

function evidenceFragments(quote) {
  return String(quote).split(/\.{3,}|\u2026/).map(normaliseForMatch).filter((f) => f.length >= 4);
}

/**
 * - UNSUPPORTED_EVIDENCE: a quote cited for awarded marks is not found in the answer that was sent.
 * - REUSED_EVIDENCE: the same passage (or a long passage contained in another) backs marks in two criteria
 *   that do not allow reuse — the "same conceptual point twice" risk made checkable.
 */
function checkEvidence(criteriaOut, answerText) {
  const hay = normaliseForMatch(answerText);
  const flags = [];
  const unsupported = [];
  const used = [];
  for (const c of criteriaOut) {
    if (!(c.marksAwarded > 0)) continue;
    for (const q of c.evidence) {
      const frags = evidenceFragments(q);
      if (frags.length === 0 || !frags.every((f) => hay.includes(f))) unsupported.push(c.criterionId);
      else used.push({ id: c.criterionId, reuse: c.allowEvidenceReuse, text: normaliseForMatch(q) });
    }
  }
  if (unsupported.length) flags.push({ code: "UNSUPPORTED_EVIDENCE", source: "engine", detail: [...new Set(unsupported)].join(",") });

  const reused = new Set();
  for (let i = 0; i < used.length; i += 1) {
    for (let j = i + 1; j < used.length; j += 1) {
      const a = used[i], b = used[j];
      if (a.id === b.id || a.reuse || b.reuse) continue;
      const [short, long] = a.text.length <= b.text.length ? [a.text, b.text] : [b.text, a.text];
      if (short === long || (short.length >= 25 && long.includes(short))) { reused.add(a.id); reused.add(b.id); }
    }
  }
  if (reused.size) flags.push({ code: "REUSED_EVIDENCE", source: "engine", detail: [...reused].join(",") });
  return flags;
}

module.exports = { validateScheme, validateModelOutput, checkEvidence, cents, fromCents, isTwoDp };
