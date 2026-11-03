/* =========================================================================
   LMS QUESTION CSV  (L6.1b)  PURE: turns questions into CSV text and CSV rows into question bodies. No database, never throws.

   Columns (header row required, any order, case/spacing ignored): type, stem, points, difficulty, subject, topic, explanation, answer,
   partialCredit, caseSensitive, maxWords, unit.   `type` and `stem` are required.
   The `answer` cell holds the type-specific part in ONE cell:
     mcq_single / mcq_multi   option texts separated by |, a correct option starts with *      e.g.  *Nairobi|Mombasa|Kisumu
     true_false               true | false
     short_answer             accepted answers separated by |                                     e.g.  Nairobi|Nairobi City
     numeric                  value or value~tolerance                                           e.g.  9.81~0.01
     matching                 left=>right pairs separated by |                                   e.g.  Kenya=>Nairobi|Uganda=>Kampala
     ordering                 items in the CORRECT order separated by |
     essay                    must be empty
   A backslash makes the next character literal (\\| \\* \\~ \\\\), so any text round-trips. (< and > never occur in stored text: they are stripped on save.)
   Safety: a cell that starts with = + - @ (or a tab/CR) is exported with a leading ' so a spreadsheet cannot run it as a formula; the importer removes
   that one ' again. Option feedback is NOT exported (A71): importing an exported file loses it.
========================================================================= */
const COLUMNS = ["type", "stem", "points", "difficulty", "subject", "topic", "explanation", "answer", "partialCredit", "caseSensitive", "maxWords", "unit"];
const KNOWN = COLUMNS.map((c) => c.toLowerCase());
const REQUIRED = ["type", "stem"];

/* ---------- escaping inside the answer cell ---------- */
const esc = (t) => String(t ?? "").replace(/[\\|*~]/g, (m) => `\\${m}`);
/* tokens: [{ch, lit}] where lit = the character was escaped (or is plain text) */
function tokens(s) {
  const out = []; const str = String(s ?? "");
  for (let i = 0; i < str.length; i += 1) { if (str[i] === "\\" && i + 1 < str.length) { out.push({ ch: str[i + 1], esc: true }); i += 1; } else out.push({ ch: str[i], esc: false }); }
  return out;
}
const text = (toks) => toks.map((t) => t.ch).join("");
function splitOn(toks, ch) {
  const parts = [[]];
  for (const t of toks) { if (!t.esc && t.ch === ch) parts.push([]); else parts[parts.length - 1].push(t); }
  return parts;
}

/* ---------- formula protection ---------- */
const guard = (v) => { const s = String(v ?? ""); return /^'*[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
const unguard = (v) => { const s = String(v ?? ""); return /^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s; };
const cell = (v) => { const s = guard(v); return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function answerCell(q) {
  const s = q.spec || {};
  switch (q.type) {
    case "mcq_single": case "mcq_multi": return (s.options || []).map((o) => `${o.correct ? "*" : ""}${esc(o.text)}`).join("|");
    case "true_false": return s.correct ? "true" : "false";
    case "short_answer": return (s.accepted || []).map(esc).join("|");
    case "numeric": return s.tolerance ? `${s.value}~${s.tolerance}` : String(s.value);
    case "matching": return (s.pairs || []).map((p) => `${esc(p.left)}=>${esc(p.right)}`).join("|");
    case "ordering": return (s.items || []).map((i) => esc(i.text)).join("|");
    default: return "";
  }
}

/* Pure. questions = [{type, stem, points, difficulty, subject, topic, explanation, spec}] -> CSV text (UTF-8 with BOM, \n line ends). */
function toCsv(questions) {
  const lines = [COLUMNS.join(",")];
  for (const q of questions || []) {
    const s = q.spec || {};
    const row = [q.type, q.stem, q.points, q.difficulty || "", q.subject || "", q.topic || "", q.explanation || "", answerCell(q),
      "partialCredit" in s ? String(!!s.partialCredit) : "", "caseSensitive" in s ? String(!!s.caseSensitive) : "", s.maxWords ?? "", s.unit || ""];
    lines.push(row.map(cell).join(","));
  }
  return `﻿${lines.join("\n")}\n`;
}

/* Pure. One parsed answer cell -> the type fields of a question body, or { error }. */
function parseAnswer(type, raw) {
  const toks = tokens(unguard(raw));
  const parts = splitOn(toks, "|");
  const empty = toks.length === 0 || text(toks).trim() === "";
  switch (type) {
    case "mcq_single": case "mcq_multi": {
      if (empty) return { error: "answer is required: options separated by |, correct ones start with *." };
      return { fields: { options: parts.map((p) => { const star = p.length > 0 && !p[0].esc && p[0].ch === "*"; return { text: text(star ? p.slice(1) : p), correct: star }; }) } };
    }
    case "true_false": { const t = text(toks).trim().toLowerCase(); return t === "true" || t === "false" ? { fields: { correct: t === "true" } } : { error: "answer must be true or false." }; }
    case "short_answer": return empty ? { error: "answer is required: the accepted answers separated by |." } : { fields: { accepted: parts.map(text) } };
    case "numeric": {
      if (empty) return { error: "answer is required: a number, or number~tolerance." };
      const [v, t, ...extra] = splitOn(toks, "~").map(text);
      if (extra.length) return { error: "answer can have only one ~ (number~tolerance)." };
      return { fields: t === undefined || t.trim() === "" ? { value: v.trim() } : { value: v.trim(), tolerance: t.trim() } };
    }
    case "matching": {
      if (empty) return { error: "answer is required: pairs written left=>right and separated by |." };
      const pairs = [];
      for (const p of parts) {
        let at = -1; for (let i = 0; i < p.length - 1; i += 1) if (!p[i].esc && p[i].ch === "=" && !p[i + 1].esc && p[i + 1].ch === ">") { at = i; break; }
        if (at < 0) return { error: `"${text(p).slice(0, 40)}" is not a pair: write left=>right.` };
        pairs.push({ left: text(p.slice(0, at)), right: text(p.slice(at + 2)) });
      }
      return { fields: { pairs } };
    }
    case "ordering": return empty ? { error: "answer is required: the items in the correct order separated by |." } : { fields: { items: parts.map(text) } };
    case "essay": return empty ? { fields: {} } : { error: "an essay question has no answer: leave the answer empty." };
    default: return { error: "unknown type." };
  }
}

/* Pure. rows = readCsv(...).rows ([{line, cells}]) -> [{ line, body } | { line, errors }]. The body still goes through validateQuestion. */
function rowsToBodies(rows) {
  return (rows || []).map(({ line, cells }) => {
    const c = (k) => unguard(cells[k.toLowerCase()] ?? "").trim();
    const type = c("type").toLowerCase();
    const a = parseAnswer(type, cells.answer ?? "");
    if (a.error) return { line, errors: [a.error] };
    const body = { type, stem: unguard(cells.stem ?? "").trim(), ...a.fields };
    for (const k of ["points", "difficulty", "subject", "topic", "explanation", "partialCredit", "caseSensitive", "maxWords", "unit"]) { const v = k === "explanation" ? unguard(cells[k.toLowerCase()] ?? "") : c(k); if (String(v).trim() !== "") body[k] = v; }
    return { line, body };
  });
}

module.exports = { COLUMNS, KNOWN, REQUIRED, toCsv, parseAnswer, rowsToBodies, esc, cell };
