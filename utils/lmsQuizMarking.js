/* =========================================================================
   LMS QUIZ MARKING  (L6.1a)  PURE functions: no database, no clock, no randomness, never throws.
   Used by the question bank (validation) now and by quiz attempts (L6.2) later.

   Question types (the `type` field):
     mcq_single   2-10 options, exactly 1 correct               answer {selected: <option position>}
     mcq_multi    2-10 options, >=1 correct                     answer {selected: [<option position>, ...]}
     true_false   `correct` true|false                          answer {selected: true|false}
     short_answer `accepted` 1-20 strings, `caseSensitive`      answer {text}
     numeric      `value`, `tolerance` (absolute, >= 0)         answer {value}   (number or "12.5"; dot decimal only)
     matching     `pairs` 2-10 {left,right}; pair i is correct  answer {pairs: [<right position for left 1>, ...]}  (null = not set)
     ordering     `items` 2-10 in the CORRECT order             answer {order: [<item position>, ...]}  (a permutation of 1..n)
     essay        not auto-marked (teacher marks it)            answer {text}
   Positions are 1-based and are the identity of an option/item/pair, so showing them shuffled never changes the marking.

   Marking rules (documented, simple, the same for every type):
   - fraction is 0..1; points = round2(fraction * question points). status: unanswered | correct | partial | incorrect | manual.
   - `partialCredit` (mcq_multi, matching, ordering; default false): off = all or nothing.
       mcq_multi   fraction = max(0, (correct picked - wrong picked) / total correct)
       matching    fraction = right pairs / pairs
       ordering    fraction = items in the right place / items
   - A malformed answer (wrong shape, position out of range, duplicates where a permutation is needed) scores 0 as `incorrect`, never an error.
   - short_answer: compared after trimming, collapsing inner whitespace and (unless caseSensitive) lower-casing; exact match with any accepted string.
   - numeric: |answer - value| <= tolerance (+ 1e-9 for float noise). Comma decimals are NOT accepted ("1,5" is incorrect) so "1,000" is never read as 1.
   - essay: status `manual`, fraction null, points null (a teacher decides).
========================================================================= */
const TYPES = ["mcq_single", "mcq_multi", "true_false", "short_answer", "numeric", "matching", "ordering", "essay"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const AUTO_TYPES = TYPES.filter((t) => t !== "essay");

const LIMITS = { stem: 4000, explanation: 2000, option: 500, optionFeedback: 300, label: 100, subject: 100, topic: 100, maxPoints: 100, tags: 5, maxOptions: 10, minOptions: 2, accepted: 20, acceptedLen: 200, pairs: 10, items: 10, words: 10000 };

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
const posInt = (v) => { const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v; return Number.isInteger(n) && n > 0 ? n : null; };
const bool = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

const COMMON = ["type", "stem", "explanation", "points", "difficulty", "subject", "topic", "outcomeIds"];
const BY_TYPE = {
  mcq_single: ["options"], mcq_multi: ["options", "partialCredit"], true_false: ["correct"], short_answer: ["accepted", "caseSensitive"],
  numeric: ["value", "tolerance", "unit"], matching: ["pairs", "partialCredit"], ordering: ["items", "partialCredit"], essay: ["maxWords"],
};

function validateOptions(body, errors, type) {
  const raw = body.options;
  if (!Array.isArray(raw) || raw.length < LIMITS.minOptions || raw.length > LIMITS.maxOptions) { errors.push(`options must be a list of ${LIMITS.minOptions}-${LIMITS.maxOptions} options.`); return null; }
  const options = []; let correct = 0;
  raw.forEach((o, i) => {
    const at = `Option ${i + 1}`;
    if (!isPlainObject(o)) { errors.push(`${at} must be an object.`); return; }
    for (const k of Object.keys(o)) if (!["text", "correct", "feedback"].includes(k)) errors.push(`${at}: unknown field "${k}".`);
    const text = oneLine(o.text); if (text.length < 1 || text.length > LIMITS.option) errors.push(`${at}: text is required, 1-${LIMITS.option} characters.`);
    const c = o.correct === undefined ? false : bool(o.correct); if (c === null) errors.push(`${at}: correct must be true or false.`);
    const feedback = multiLine(o.feedback); if (feedback.length > LIMITS.optionFeedback) errors.push(`${at}: feedback can be at most ${LIMITS.optionFeedback} characters.`);
    if (c) correct += 1;
    options.push({ position: i + 1, text, correct: c === true, feedback });
  });
  const lower = options.map((o) => o.text.toLowerCase());
  if (new Set(lower).size !== lower.length) errors.push("Two options have the same text.");
  if (type === "mcq_single" && correct !== 1) errors.push("Exactly one option must be correct.");
  if (type === "mcq_multi" && correct < 1) errors.push("At least one option must be correct.");
  return options;
}

/* Pure. Whole-question validation + normalisation.
   Returns { ok, errors } or { ok:true, value:{ type, stem, explanation, points, difficulty, subject, topic, outcomeIds, spec } }
   where `spec` holds ONLY the type-specific fields (what is stored as JSON and what markAnswer reads). */
function validateQuestion(body) {
  const errors = [];
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const type = typeof body.type === "string" ? body.type : "";
  if (!TYPES.includes(type)) return { ok: false, errors: [`type must be one of: ${TYPES.join(", ")}.`] };
  for (const k of Object.keys(body)) if (!COMMON.includes(k) && !BY_TYPE[type].includes(k)) errors.push(`Unknown field "${k}" for a ${type} question.`);
  const stem = multiLine(body.stem); if (stem.length < 1 || stem.length > LIMITS.stem) errors.push(`stem is required: 1-${LIMITS.stem} characters.`);
  const explanation = multiLine(body.explanation); if (explanation.length > LIMITS.explanation) errors.push(`explanation can be at most ${LIMITS.explanation} characters.`);
  const points = body.points === undefined ? 1 : num(body.points);
  if (points === null || points <= 0 || points > LIMITS.maxPoints || round2(points) !== points) errors.push(`points must be a number above 0 and at most ${LIMITS.maxPoints}, with at most 2 decimals.`);
  const difficulty = body.difficulty === undefined || body.difficulty === null || body.difficulty === "" ? null : String(body.difficulty).toLowerCase();
  if (difficulty !== null && !DIFFICULTIES.includes(difficulty)) errors.push(`difficulty must be one of: ${DIFFICULTIES.join(", ")}.`);
  const subject = oneLine(body.subject); if (subject.length > LIMITS.subject) errors.push(`subject can be at most ${LIMITS.subject} characters.`);
  const topic = oneLine(body.topic); if (topic.length > LIMITS.topic) errors.push(`topic can be at most ${LIMITS.topic} characters.`);
  let outcomeIds = [];
  if (body.outcomeIds !== undefined) {
    const ids = Array.isArray(body.outcomeIds) ? body.outcomeIds.map(posInt) : null;
    if (!ids || ids.length > LIMITS.tags || ids.some((x) => x === null)) errors.push(`outcomeIds must be a list of at most ${LIMITS.tags} outcome ids.`); else outcomeIds = [...new Set(ids)];
  }
  const spec = {};
  if (type === "mcq_single" || type === "mcq_multi") {
    const options = validateOptions(body, errors, type); if (options) spec.options = options;
    if (type === "mcq_multi") { const p = body.partialCredit === undefined ? false : bool(body.partialCredit); if (p === null) errors.push("partialCredit must be true or false."); spec.partialCredit = p === true; }
  } else if (type === "true_false") {
    const c = bool(body.correct); if (c === null) errors.push("correct is required: true or false."); spec.correct = c === true;
  } else if (type === "short_answer") {
    const raw = body.accepted;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.accepted) errors.push(`accepted must be a list of 1-${LIMITS.accepted} accepted answers.`);
    else {
      const list = raw.map((a) => oneLine(a)); const bad = list.findIndex((a) => a.length < 1 || a.length > LIMITS.acceptedLen);
      if (typeof raw.find((a) => typeof a !== "string") !== "undefined") errors.push("Each accepted answer must be text.");
      else if (bad >= 0) errors.push(`Accepted answer ${bad + 1} must be 1-${LIMITS.acceptedLen} characters.`);
      spec.accepted = [...new Set(list)];
    }
    const cs = body.caseSensitive === undefined ? false : bool(body.caseSensitive); if (cs === null) errors.push("caseSensitive must be true or false."); spec.caseSensitive = cs === true;
  } else if (type === "numeric") {
    const v = num(body.value); if (v === null) errors.push("value is required and must be a number."); spec.value = v;
    const t = body.tolerance === undefined ? 0 : num(body.tolerance); if (t === null || t < 0) errors.push("tolerance must be a number of 0 or more."); spec.tolerance = t;
    const unit = oneLine(body.unit); if (unit.length > 30) errors.push("unit can be at most 30 characters."); spec.unit = unit;
  } else if (type === "matching") {
    const raw = body.pairs;
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > LIMITS.pairs) errors.push(`pairs must be a list of 2-${LIMITS.pairs} pairs.`);
    else {
      const pairs = [];
      raw.forEach((p, i) => {
        const at = `Pair ${i + 1}`;
        if (!isPlainObject(p)) { errors.push(`${at} must be an object.`); return; }
        for (const k of Object.keys(p)) if (!["left", "right"].includes(k)) errors.push(`${at}: unknown field "${k}".`);
        const left = oneLine(p.left), right = oneLine(p.right);
        if (left.length < 1 || left.length > LIMITS.option || right.length < 1 || right.length > LIMITS.option) errors.push(`${at}: left and right are required, 1-${LIMITS.option} characters each.`);
        pairs.push({ position: i + 1, left, right });
      });
      const lefts = pairs.map((p) => p.left.toLowerCase()), rights = pairs.map((p) => p.right.toLowerCase());
      if (new Set(lefts).size !== lefts.length) errors.push("Two pairs have the same left text.");
      if (new Set(rights).size !== rights.length) errors.push("Two pairs have the same right text.");
      spec.pairs = pairs;
    }
    const p = body.partialCredit === undefined ? false : bool(body.partialCredit); if (p === null) errors.push("partialCredit must be true or false."); spec.partialCredit = p === true;
  } else if (type === "ordering") {
    const raw = body.items;
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > LIMITS.items) errors.push(`items must be a list of 2-${LIMITS.items} items in the correct order.`);
    else {
      const items = raw.map((t) => oneLine(t));
      if (raw.some((t) => typeof t !== "string") || items.some((t) => t.length < 1 || t.length > LIMITS.option)) errors.push(`Each item must be text of 1-${LIMITS.option} characters.`);
      if (new Set(items.map((t) => t.toLowerCase())).size !== items.length) errors.push("Two items have the same text.");
      spec.items = items.map((text, i) => ({ position: i + 1, text }));
    }
    const p = body.partialCredit === undefined ? false : bool(body.partialCredit); if (p === null) errors.push("partialCredit must be true or false."); spec.partialCredit = p === true;
  } else if (type === "essay") {
    if (body.maxWords !== undefined && body.maxWords !== null) { const w = posInt(body.maxWords); if (w === null || w > LIMITS.words) errors.push(`maxWords must be a whole number from 1 to ${LIMITS.words}.`); spec.maxWords = w; } else spec.maxWords = null;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { type, stem, explanation, points, difficulty, subject, topic, outcomeIds, spec } };
}

const norm = (s, cs) => { const t = String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim(); return cs ? t : t.toLowerCase(); };
const result = (status, fraction, maxPoints) => ({ status, fraction, points: fraction === null ? null : round2(fraction * maxPoints), maxPoints });
const outcome = (fraction, maxPoints) => result(fraction >= 1 ? "correct" : fraction <= 0 ? "incorrect" : "partial", fraction, maxPoints);
const emptyAnswer = (a) => a === undefined || a === null || (isPlainObject(a) && Object.keys(a).length === 0);

/* Pure, never throws. question = { type, points, spec } (spec as produced by validateQuestion). */
function markAnswer(question, answer) {
  const max = Number(question?.points) > 0 ? Number(question.points) : 0;
  try {
    const type = question?.type, spec = question?.spec || {};
    if (type === "essay") return result("manual", null, max);
    if (!AUTO_TYPES.includes(type)) return result("incorrect", 0, max);
    if (emptyAnswer(answer) || !isPlainObject(answer)) return result("unanswered", 0, max);
    switch (type) {
      case "mcq_single": {
        if (answer.selected === undefined || answer.selected === null || answer.selected === "") return result("unanswered", 0, max);
        const p = posInt(answer.selected); const o = (spec.options || []).find((x) => x.position === p);
        return outcome(o && o.correct ? 1 : 0, max);
      }
      case "mcq_multi": {
        if (!Array.isArray(answer.selected)) return result(answer.selected === undefined || answer.selected === null ? "unanswered" : "incorrect", 0, max);
        if (answer.selected.length === 0) return result("unanswered", 0, max);
        const opts = spec.options || []; const picked = answer.selected.map(posInt);
        if (picked.some((p) => p === null || !opts.some((o) => o.position === p))) return outcome(0, max);
        const set = new Set(picked); const totalCorrect = opts.filter((o) => o.correct).length;
        const hits = opts.filter((o) => o.correct && set.has(o.position)).length, wrongs = opts.filter((o) => !o.correct && set.has(o.position)).length;
        if (spec.partialCredit) return outcome(Math.max(0, (hits - wrongs) / totalCorrect), max);
        return outcome(hits === totalCorrect && wrongs === 0 ? 1 : 0, max);
      }
      case "true_false": {
        const s = answer.selected === undefined || answer.selected === null || answer.selected === "" ? undefined : bool(answer.selected);
        if (s === undefined) return result("unanswered", 0, max);
        return outcome(s !== null && s === spec.correct ? 1 : 0, max);
      }
      case "short_answer": {
        if (typeof answer.text !== "string") return result(answer.text === undefined || answer.text === null ? "unanswered" : "incorrect", 0, max);
        const t = norm(answer.text, spec.caseSensitive); if (t === "") return result("unanswered", 0, max);
        return outcome((spec.accepted || []).some((a) => norm(a, spec.caseSensitive) === t) ? 1 : 0, max);
      }
      case "numeric": {
        if (answer.value === undefined || answer.value === null || String(answer.value).trim() === "") return result("unanswered", 0, max);
        const raw = typeof answer.value === "string" ? answer.value.trim().replace(/\s+/g, "") : answer.value;
        if (typeof raw === "string" && !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return outcome(0, max);
        const v = num(raw); if (v === null) return outcome(0, max);
        return outcome(Math.abs(v - spec.value) <= (spec.tolerance || 0) + 1e-9 ? 1 : 0, max);
      }
      case "matching": {
        const n = (spec.pairs || []).length;
        if (!Array.isArray(answer.pairs)) return result(answer.pairs === undefined || answer.pairs === null ? "unanswered" : "incorrect", 0, max);
        if (answer.pairs.every((x) => x === null || x === undefined || x === "")) return result("unanswered", 0, max);
        if (answer.pairs.length !== n) return outcome(0, max);
        const got = answer.pairs.map((x) => (x === null || x === undefined || x === "" ? null : posInt(x)));
        if (got.some((x) => x !== null && x > n)) return outcome(0, max);
        const right = got.filter((x, i) => x === i + 1).length;
        return outcome(spec.partialCredit ? right / n : right === n ? 1 : 0, max);
      }
      case "ordering": {
        const n = (spec.items || []).length;
        if (!Array.isArray(answer.order)) return result(answer.order === undefined || answer.order === null ? "unanswered" : "incorrect", 0, max);
        if (answer.order.length === 0) return result("unanswered", 0, max);
        const got = answer.order.map(posInt);
        if (got.length !== n || got.some((x) => x === null || x > n) || new Set(got).size !== n) return outcome(0, max);
        const right = got.filter((x, i) => x === i + 1).length;
        return outcome(spec.partialCredit ? right / n : right === n ? 1 : 0, max);
      }
      default: return result("incorrect", 0, max);
    }
  } catch { return result("incorrect", 0, max); }
}

/* Deterministic shuffle (mulberry32 over a string seed). Never returns the identity order when n >= 2 (an identity order would show the
   answer key: the right-hand list lined up with the left, or the items already sorted). Returns positions 1..n in display order. */
function permutation(n, seed) {
  let h = 1779033703 ^ String(seed ?? "").length;
  for (const ch of String(seed ?? "")) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^ (h >>> 16)) >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const p = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  if (n >= 2 && p.every((x, i) => x === i + 1)) p.push(p.shift());
  return p;
}

/* What a STUDENT may see of a question before answering: no correct flags, no accepted answers, no feedback, no explanation.
   Returns { view, refMap }. For matching and ordering a position IS the answer key, so the student gets opaque display refs (1..n in the order
   shown) and the server keeps `refMap` ({ rights|items: [position for display ref 1, 2, ...] }); `translateAnswer` turns the student's answer
   back into positions before markAnswer. The shuffle is a pure function of (question, seed): the attempt service passes e.g. attemptId+questionId. */
function studentView(question, seed = "") {
  const spec = question?.spec || {}; const base = { type: question.type, stem: question.stem, points: question.points };
  switch (question.type) {
    case "mcq_single": case "mcq_multi": {
      const opts = spec.options || []; const perm = permutation(opts.length, seed);
      return { view: { ...base, options: perm.map((pos) => { const o = opts.find((x) => x.position === pos); return { position: o.position, text: o.text }; }) }, refMap: {} };
    }
    case "matching": {
      const pairs = spec.pairs || []; const perm = permutation(pairs.length, seed);
      return { view: { ...base, lefts: pairs.map((p) => ({ position: p.position, text: p.left })), rights: perm.map((pos, i) => ({ ref: i + 1, text: pairs.find((x) => x.position === pos).right })) }, refMap: { rights: perm } };
    }
    case "ordering": {
      const items = spec.items || []; const perm = permutation(items.length, seed);
      return { view: { ...base, items: perm.map((pos, i) => ({ ref: i + 1, text: items.find((x) => x.position === pos).text })) }, refMap: { items: perm } };
    }
    case "numeric": return { view: { ...base, unit: spec.unit || "" }, refMap: {} };
    case "essay": return { view: { ...base, maxWords: spec.maxWords ?? null }, refMap: {} };
    default: return { view: base, refMap: {} };
  }
}

/* Pure. Student answer in display refs -> answer in positions (what markAnswer reads). Other types pass through. A ref that does not exist
   becomes n+1 (out of range, so the answer scores 0 instead of being read as "not set"). */
function translateAnswer(question, refMap, answer) {
  if (!isPlainObject(answer)) return answer;
  const to = (list, ref) => { const r = ref === null || ref === undefined || ref === "" ? null : posInt(ref); if (r === null) return null; return list && r <= list.length ? list[r - 1] : (list ? list.length : 0) + 1; };
  if (question?.type === "matching" && Array.isArray(answer.pairs)) return { pairs: answer.pairs.map((r) => to(refMap?.rights, r)) };
  if (question?.type === "ordering" && Array.isArray(answer.order)) return { order: answer.order.map((r) => { const t = to(refMap?.items, r); return t === null ? 0 : t; }) };
  return answer;
}

module.exports = { TYPES, AUTO_TYPES, DIFFICULTIES, LIMITS, validateQuestion, markAnswer, studentView, translateAnswer, permutation, round2 };
