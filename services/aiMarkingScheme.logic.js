const crypto = require("crypto");
const { validateScheme } = require("./aiMarkingEngine.validate");
const { normaliseForMatch } = require("./aiMarkingEngine.prompt");

/* =========================================================================
   AI MARKING — MARKING-SCHEME LOGIC (Phase 8). Pure: no database, no network.

   A "scheme" is the structured version of a question's free-text marking
   guide that AI marking needs: criteria with ids, marks, expected points and
   acceptable alternatives (the shape the Phase 5 engine validates against).

   Findings come in three severities:
     error    blocks approval. The scheme could not be marked against safely
              (empty, marks do not add up to the question, bad structure).
     warning  approval allowed, but only after the teacher acknowledges each
              warning code by name. Their acknowledgement is stored.
     info     a suggestion. Never blocks, never needs acknowledging.

   All checks are deterministic text/number checks. They find structural
   problems and likely problems; they cannot judge whether a scheme is
   academically right. "Duplicate" and "contradiction" detection are
   word-overlap heuristics: expect some misses and some false alarms.
========================================================================= */

const sha256 = (text) => crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

/** Hash of the guide text, stored as source_guide_hash. Whitespace-insensitive so a re-indent is not a "change". */
const hashGuide = (guideText) => sha256(String(guideText ?? "").replace(/\s+/g, " ").trim());
/** Hash of what the scheme was written against: question wording + marks + guide. */
const hashQuestion = ({ text, marks, guideText }) => sha256(JSON.stringify([String(text ?? "").replace(/\s+/g, " ").trim(), Number(marks), String(guideText ?? "").replace(/\s+/g, " ").trim()]));

const cents = (n) => Math.round(Number(n) * 100);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_POINT_CHARS = 300;
const MAX_POINTS = 12;
const MAX_LIST_ITEMS = 30;

/* ------------------------------ normalising what a teacher typed ------------------------------ */

const cleanText = (v, max) => String(v ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);

function cleanList(v, maxItems = MAX_LIST_ITEMS) {
  const arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split(/\r?\n/) : []);
  return arr.map((x) => cleanText(x, MAX_POINT_CHARS)).filter(Boolean).slice(0, maxItems);
}

/**
 * Accepts the editor's payload and returns clean criteria. Never throws; structural
 * problems are reported by lintScheme. Missing ids are generated (c1, c2, ...).
 * Marks are coerced only from real numbers or numeric strings; anything else becomes NaN,
 * which the structure check then rejects instead of silently turning into 0.
 */
function normaliseCriteria(input) {
  if (!Array.isArray(input)) return [];
  const used = new Set();
  return input.slice(0, 40).map((c, i) => {
    const o = c && typeof c === "object" ? c : {};
    let id = cleanText(o.criterionId, 40).replace(/\s+/g, "_");
    if (!id || used.has(id)) id = `c${i + 1}`;
    while (used.has(id)) id += "_";
    used.add(id);
    const m = typeof o.maxMarks === "number" ? o.maxMarks : (typeof o.maxMarks === "string" && o.maxMarks.trim() !== "" ? Number(o.maxMarks) : NaN);
    const out = {
      criterionId: id,
      label: cleanText(o.label, 200),
      maxMarks: m,
      expectedPoints: cleanList(o.expectedPoints),
      acceptableAlternatives: cleanList(o.acceptableAlternatives),
    };
    if (o.allowEvidenceReuse === true) out.allowEvidenceReuse = true;
    return out;
  });
}

/* ------------------------------ similarity helpers ------------------------------ */

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "are", "it", "that", "for", "with", "by", "as", "at", "be", "this"]);
const tokens = (s) => new Set(normaliseForMatch(s).split(" ").filter((w) => w && !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
const NEGATION = /^\s*(?:do not|don't|dont|never|not|reject|no mark(?:s)? for|no credit for)\s+(?:accept|award|allow|credit|give)?\s*/i;

/* ------------------------------ the lint ------------------------------ */


const finding = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });

/** Has the question moved on since this approved version was written? (Does not need the criteria.) */
function driftFindings(approved, question) {
  const out = [];
  const marks = Number(question.marks);
  if (Number(approved.max_marks) !== marks) {
    out.push(finding("warning", "APPROVED_MARKS_STALE", `The question is now worth ${marks} but the approved scheme is for ${Number(approved.max_marks)}. Until a new scheme is approved, this question cannot be AI-marked.`));
  }
  if (approved.source_guide_hash && approved.source_guide_hash !== hashGuide(question.guideText)) {
    out.push(finding("warning", "GUIDE_CHANGED", "The marking guide was edited after the approved scheme was written. Review the scheme against the new guide."));
  }
  const qh = parseJson(approved.approval_notes, {}).questionHash;
  if (qh && qh !== hashQuestion({ text: question.text, marks, guideText: question.guideText })) {
    out.push(finding("info", "QUESTION_CHANGED", "The question wording, marks or guide changed since this scheme was approved."));
  }
  return out;
}

/**
 * @param criteria  normalised criteria
 * @param question  { marks, text, type, guideText, imageCount }
 * @param approved  optional: the currently approved version row { max_marks, source_guide_hash, approval_notes }
 *                  — pass it to learn whether the question/guide changed since approval.
 */
function lintScheme(criteria, question, approved = null) {
  const out = [];
  const marks = Number(question.marks);

  /* --- question-level: things that make AI marking unsuitable or uncertain --- */
  if (String(question.type || "").toLowerCase() !== "essay") {
    out.push(finding("error", "NOT_ESSAY", "AI marking only applies to essay questions."));
  }
  if (!String(question.guideText || "").replace(/\s+/g, "").length) {
    out.push(finding("warning", "NO_GUIDE", "This question has no marking guide. The scheme below is written from nothing; check it carefully against what you expect."));
  }
  if (Number(question.imageCount) > 0) {
    out.push(finding("warning", "IMAGE_DEPENDENT",
      `This question has ${question.imageCount} image${question.imageCount > 1 ? "s" : ""} attached. The AI cannot see images, so any mark that depends on a diagram or picture cannot be judged reliably. Mark such answers yourself, or approve only if the written answer stands on its own.`));
  } else if (/\b(?:diagram|figure|graph|chart|table|map|picture|photograph|sketch|drawing|illustration|image)\b[^.?!]{0,40}\b(?:below|above|shown|given|following|opposite)\b|\b(?:below|above|following)\b[^.?!]{0,20}\b(?:diagram|figure|graph|chart|table|map|picture|photograph)\b/i.test(String(question.text || ""))) {
    out.push(finding("warning", "DIAGRAM_REFERENCED",
      "The question text refers to a diagram, graph or table that is not attached as an image. The AI will not see it. Mark answers that depend on it yourself, or include the needed information in the criteria."));
  }

  /* --- structure (shared with the engine, so what passes here also passes there) --- */
  if (!Number.isFinite(marks) || marks <= 0) {
    out.push(finding("error", "QUESTION_MARKS_INVALID", "The question has no valid maximum mark."));
  }
  const structural = validateScheme(criteria, marks);
  const MESSAGES = {
    SCHEME_EMPTY: "Add at least one criterion.",
    SCHEME_TOO_LARGE: "Too many criteria (maximum 30).",
    SCHEME_MAX_INVALID: "The question's maximum mark is not valid.",
    SCHEME_CRITERION_INVALID: "A criterion is malformed.",
    SCHEME_CRITERION_ID: "A criterion has no usable id.",
    SCHEME_DUPLICATE_ID: "Two criteria share an id.",
    SCHEME_LABEL: "Every criterion needs a label.",
    SCHEME_CRITERION_MAX: "Every criterion needs marks above 0, with at most 2 decimal places.",
    SCHEME_LIST: "Expected points and alternatives must be lists of text.",
    SCHEME_EXCEEDS_QUESTION: "The criteria add up to more marks than the question is worth.",
  };
  for (const e of structural) {
    out.push(finding("error", e.code === "SCHEME_EXCEEDS_QUESTION" ? "TOTAL_EXCEEDS_QUESTION" : e.code, MESSAGES[e.code] || e.message, e.path ? { path: e.path } : {}));
  }
  criteria.forEach((c) => {
    if (typeof c.criterionId === "string" && c.criterionId && !ID_PATTERN.test(c.criterionId)) {
      out.push(finding("error", "CRITERION_ID_CHARS", `Criterion id "${c.criterionId}" may only use letters, digits, - and _.`, { criterionId: c.criterionId }));
    }
  });

  const validMarks = criteria.every((c) => Number.isFinite(c.maxMarks) && c.maxMarks > 0);
  if (validMarks && Number.isFinite(marks) && marks > 0) {
    const sum = criteria.reduce((s, c) => s + cents(c.maxMarks), 0);
    if (sum < cents(marks)) {
      out.push(finding("error", "TOTAL_BELOW_QUESTION",
        `The criteria add up to ${sum / 100}, but the question is worth ${marks}. Marks that are not allocated to any criterion can never be awarded, so a perfect answer could not score full marks. Allocate all ${marks} marks, or change the question's marks first.`));
    }
    criteria.forEach((c) => {
      if (cents(c.maxMarks) % 50 !== 0) out.push(finding("error", "MARKS_STEP", `"${c.label || c.criterionId}": marks must be whole numbers or halves (0.5).`, { criterionId: c.criterionId }));
    });
  }

  /* --- per-criterion quality --- */
  const allPoints = [];
  criteria.forEach((c) => {
    const where = { criterionId: c.criterionId };
    const name = c.label || c.criterionId;
    const points = c.expectedPoints || [];
    if (points.length === 0) {
      out.push(finding("warning", "NO_EXPECTED_POINTS", `"${name}" lists no expected points, so the AI has nothing concrete to match. Add the specific points that earn these marks.`, where));
    } else if (Number.isFinite(c.maxMarks)) {
      if (points.length > MAX_POINTS) out.push(finding("warning", "TOO_MANY_POINTS", `"${name}" has ${points.length} expected points. Long lists are marked less consistently; split it into separate criteria.`, where));
      const half = Math.max(1, Math.ceil(c.maxMarks * 2));        // an allowance of two points per mark is generous; beyond it the allocation is a guess
      if (c.maxMarks > points.length * 2) {
        out.push(finding("warning", "UNCLEAR_ALLOCATION", `"${name}" is worth ${c.maxMarks} marks but lists only ${points.length} expected point${points.length > 1 ? "s" : ""}. It is unclear what earns each mark.`, where));
      } else if (points.length > Math.max(half, c.maxMarks + 3)) {
        out.push(finding("info", "MANY_POINTS_FOR_MARKS", `"${name}" lists ${points.length} points for ${c.maxMarks} marks. If any ${c.maxMarks} of them earn full marks, say so in the label (for example "any ${c.maxMarks} of the following").`, where));
      }
    }
    if (points.some((p) => p.length >= MAX_POINT_CHARS)) out.push(finding("info", "LONG_POINT", `"${name}" has a very long expected point. Short, single-idea points are marked more reliably.`, where));
    if (points.length > 0 && (c.acceptableAlternatives || []).length === 0) {
      out.push(finding("info", "NO_ALTERNATIVES", `"${name}" has no acceptable alternatives. Consider adding other correct wordings or answers students commonly give.`, where));
    }
    for (const p of points) allPoints.push({ id: c.criterionId, name, text: p, kind: "point" });
    for (const a of c.acceptableAlternatives || []) allPoints.push({ id: c.criterionId, name, text: a, kind: "alt" });
  });

  /* --- duplicated criteria / points --- */
  const seenLabel = new Map();
  criteria.forEach((c) => {
    const key = normaliseForMatch(c.label || "");
    if (!key) return;
    if (seenLabel.has(key)) out.push(finding("warning", "DUPLICATE_LABEL", `Two criteria are both called "${c.label}". If they are the same idea, the AI may award it twice.`, { criterionId: c.criterionId, other: seenLabel.get(key) }));
    else seenLabel.set(key, c.criterionId);
  });
  const pointRows = allPoints.filter((p) => p.kind === "point").map((p) => ({ ...p, tok: tokens(p.text) }));
  const reported = new Set();
  for (let i = 0; i < pointRows.length; i += 1) {
    for (let j = i + 1; j < pointRows.length; j += 1) {
      const a = pointRows[i], b = pointRows[j];
      const sim = a.tok.size >= 1 && b.tok.size >= 1 ? jaccard(a.tok, b.tok) : 0;
      const same = normaliseForMatch(a.text) === normaliseForMatch(b.text);
      if (!(same || (sim >= 0.8 && Math.min(a.tok.size, b.tok.size) >= 3))) continue;
      const key = `${i}|${j}`;
      if (reported.has(key)) continue;
      reported.add(key);
      out.push(finding("warning", "DUPLICATE_POINT",
        a.id === b.id
          ? `"${a.name}" lists the same point twice: "${a.text.slice(0, 80)}".`
          : `"${a.name}" and "${b.name}" both expect: "${a.text.slice(0, 80)}". The same idea could earn marks twice.`,
        { criterionId: a.id, other: b.id }));
    }
  }

  /* --- contradictions: "do not accept X" where X is something else accepts --- */
  for (const n of allPoints) {
    if (!NEGATION.test(n.text)) continue;
    const forbidden = tokens(n.text.replace(NEGATION, ""));
    if (forbidden.size === 0) continue;
    const clash = allPoints.find((o) => o !== n && !NEGATION.test(o.text) && jaccard(forbidden, tokens(o.text)) >= 0.6);
    if (clash) {
      out.push(finding("warning", "CONTRADICTION",
        `"${n.text.slice(0, 80)}" (${n.name}) appears to rule out something that "${clash.name}" accepts: "${clash.text.slice(0, 80)}". Check these do not contradict.`,
        { criterionId: n.id, other: clash.id }));
    }
  }
  const alts = allPoints.filter((p) => p.kind === "alt").map((p) => ({ ...p, tok: tokens(p.text) }));
  for (const a of alts) {
    const dup = pointRows.find((p) => p.id !== a.id && p.tok.size >= 1 && jaccard(a.tok, p.tok) >= 0.8 && a.tok.size >= 2);
    if (dup) out.push(finding("info", "ALTERNATIVE_IS_ANOTHER_POINT", `The alternative "${a.text.slice(0, 60)}" under "${a.name}" matches an expected point of "${dup.name}". This may let one idea earn marks in two places.`, { criterionId: a.id, other: dup.id }));
  }

  if (approved) out.push(...driftFindings(approved, question));
  return out;
}

function parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch { return fallback; }
}

const summarise = (findings) => ({
  errors: findings.filter((f) => f.severity === "error").length,
  warnings: findings.filter((f) => f.severity === "warning").length,
  info: findings.filter((f) => f.severity === "info").length,
});

/** Can this be approved, given what the teacher acknowledged? Returns { ok, blockers[], unacknowledged[] }. */
function approvalDecision(findings, acknowledged) {
  const ack = new Set(Array.isArray(acknowledged) ? acknowledged.filter((x) => typeof x === "string") : []);
  const blockers = findings.filter((f) => f.severity === "error");
  const unacknowledged = [...new Set(findings.filter((f) => f.severity === "warning" && !ack.has(f.code)).map((f) => f.code))];
  return { ok: blockers.length === 0 && unacknowledged.length === 0, blockers, unacknowledged };
}

/** What state is a question in, for the teacher's checklist? */
function readinessOf({ guideText, imageCount, approved, draft, findings }) {
  if (approved) {
    const stale = findings.some((f) => f.code === "APPROVED_MARKS_STALE");
    return stale ? "stale" : (findings.some((f) => f.code === "GUIDE_CHANGED") ? "review" : "ready");
  }
  if (draft) return "draft";
  if (!String(guideText || "").trim()) return "no_guide";
  return "no_scheme";
}

/* ------------------------------ drafting from the existing free-text guide ------------------------------ */

const NUM = "(\\d+(?:\\.\\d+)?)";
const EACH = new RegExp(`${NUM}\\s*marks?\\s*(?:each|for\\s+each|per)(?:\\s+(?:correct|valid|relevant)\\s+\\w+)?(?:\\s*\\(\\s*(?:max(?:imum)?\\.?)\\s*(?:of\\s*)?${NUM}\\s*\\))?`, "i");
const TRAILING_NOISE = /\b(?:a short answer is enough|accept any other (?:correct|valid) (?:answer|response)s?)\.?\s*$/i;

/**
 * Turns the old free-text guide into a STARTING POINT for the teacher to edit.
 * It never invents marks: if a segment states no marks, maxMarks is left null and the
 * teacher must fill it in. Heuristic, built for guides shaped like
 *   "Marking guide: 1 mark each for any two: a; b; c"   or   "(a) 1 mark each: P – x; Q – y (b) ..."
 */
function draftFromGuide(guideText, questionMarks) {
  const notes = [];
  let text = String(guideText ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().replace(/^marking\s*guide\s*[:\-–]?\s*/i, "");
  if (!text) return { criteria: [], notes: ["There is no marking guide to start from."] };

  const segments = [];
  const split = text.split(/(?:^|\s)\(([a-z]|[ivx]+)\)\s+/i);
  if (split.length > 1) {
    if (split[0].trim()) segments.push({ tag: null, body: split[0].trim() });
    for (let i = 1; i < split.length; i += 2) segments.push({ tag: split[i], body: (split[i + 1] || "").trim() });
  } else segments.push({ tag: null, body: text });

  const criteria = [];
  for (const seg of segments) {
    let body = seg.body.replace(TRAILING_NOISE, "").trim();
    let maxMarks = null, perPoint = null;
    const m = body.match(EACH);
    if (m) {
      perPoint = Number(m[1]);
      if (m[2] != null) maxMarks = Number(m[2]);
      body = body.slice(m.index + m[0].length).replace(/^[^:]*:/, (x) => (x.length < 40 ? "" : x)).replace(/^\s*(?:for\s+)?any\s+\w+\s*:?/i, "").trim();
      const anyN = seg.body.match(/for\s+any\s+(one|two|three|four|five|six|\d+)/i);
      if (maxMarks == null && anyN) {
        const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
        const n = words[anyN[1].toLowerCase()] ?? Number(anyN[1]);
        if (Number.isFinite(n)) maxMarks = perPoint * n;
      }
    } else {
      const total = seg.body.match(new RegExp(`\\(\\s*${NUM}\\s*marks?\\s*\\)`, "i")) || seg.body.match(new RegExp(`^${NUM}\\s*marks?\\b`, "i"));
      if (total) maxMarks = Number(total[1]);
    }
    const items = body.split(/\s*;\s*|\s*\n\s*|\s+\u2022\s+/).map((x) => x.replace(/^[-•*\d.)\s]+/, "").trim()).filter((x) => x.length > 1);
    if (!items.length) continue;
    if (maxMarks == null && perPoint != null) { maxMarks = perPoint * items.length; notes.push(`Part ${seg.tag ? `(${seg.tag})` : criteria.length + 1}: marks were worked out as ${perPoint} x ${items.length} points. Check it.`); }
    if (maxMarks == null) notes.push(`Part ${seg.tag ? `(${seg.tag})` : criteria.length + 1}: the guide does not say how many marks this is worth. Fill it in.`);
    criteria.push({
      criterionId: `c${criteria.length + 1}`,
      label: seg.tag ? `Part (${seg.tag})` : `Criterion ${criteria.length + 1}`,
      maxMarks, expectedPoints: items.slice(0, MAX_LIST_ITEMS), acceptableAlternatives: [],
    });
  }
  const known = criteria.filter((c) => c.maxMarks != null).reduce((s, c) => s + cents(c.maxMarks), 0);
  if (criteria.length && criteria.every((c) => c.maxMarks != null) && Number.isFinite(Number(questionMarks)) && known !== cents(questionMarks)) {
    notes.push(`The marks found in the guide add up to ${known / 100}, but the question is worth ${questionMarks}. Adjust before approving.`);
  }
  if (criteria.length) notes.push("This is a first draft made from the text of the guide. Read every criterion before saving.");
  else notes.push("Could not find any points in the guide. Add criteria by hand.");
  return { criteria, notes };
}

module.exports = {
  driftFindings, sha256, hashGuide, hashQuestion, normaliseCriteria, lintScheme, summarise, approvalDecision, readinessOf, draftFromGuide, parseJson,
  MAX_POINTS, MAX_POINT_CHARS,
};
