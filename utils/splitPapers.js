/* =========================================================================
   SPLIT / CONCURRENT PAPERS — shared helpers (no database, no requires).

   One subject can be sat as several papers at the same time (codes 9819 and
   9820, "Mathematics Paper 1" / "Mathematics Paper 2"...). Reports LIST every
   paper but count the subject ONCE: the paper the student sat.

   Sessions are flagged in Main Examination -> subject -> Edit ("Concurrent /
   split paper"). Papers whose flag was never saved are spotted by name
   (detectPossibleSplits) so the admin can find and flag them.
========================================================================= */
const norm = (v) => String(v || "").replace(/\(\s*optional\s*\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

// "Mathematics", "Mathematics Paper 2", "Mathematics - Paper 1", "Mathematics P2" -> "mathematics"
function splitBaseName(subject, paperLabel) {
  let n = norm(subject);
  const label = String(paperLabel || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (label && n.endsWith(label)) n = n.slice(0, -label.length);
  n = n.replace(/[\s\-–—:(\[]*\b(paper|pp?|part)(?![a-z])\s*\.?\s*([0-9]+|[ivx]+|[a-d])\s*[)\]]*\s*$/i, "");
  n = n.replace(/[\s\-–—:(\[]+$/, "").replace(/\s+[0-9]+$/, "");
  return n.trim();
}

// Group key for a FLAGGED split paper (row.allow_concurrent), else null.
const splitGroupKey = (row) =>
  (row && row.allow_concurrent ? `split:${splitBaseName(row.subject, row.paper_label)}` : null);

/** items: [{ id, name }] -> Map(id -> baseName) for names that look like papers of one
    subject (two or more share a base name and at least one carries a paper marker). */
function detectPossibleSplits(items) {
  const byBase = new Map();
  (items || []).forEach((it) => {
    const base = splitBaseName(it.name);
    if (!base) return;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(it);
  });
  const out = new Map();
  byBase.forEach((list, base) => {
    if (list.length < 2) return;
    if (!list.some((it) => norm(it.name) !== base)) return; // all identical names: not a paper marker
    list.forEach((it) => out.set(it.id, base));
  });
  return out;
}

module.exports = { norm, splitBaseName, splitGroupKey, detectPossibleSplits };
