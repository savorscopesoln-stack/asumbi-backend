/* =========================================================================
   EXAM REPORT PERCENTAGES — shared by every main-examination report/export.

   Rules (same for every report the system generates):
   • A paper is always shown as its PERCENTAGE mark, never the raw marks.
   • A compulsory paper the candidate is registered for but did not sit (and
     whose exam session is over) is INCLUDED as 0 — it is counted in the
     total and the average.
   • An OPTIONAL paper (E-Assessments → Report Form Subjects, or a subject
     named "(Optional)") the candidate did not sit is left out entirely
     ("—"): not counted, never a 0.
   • Total = sum of the counted percentages, out of the Grading System's
     "Total Marks That Can Be Achieved" (blank → counted papers x 100).
     Average = mean of the counted percentages.
========================================================================= */
const { getReportFormConfig } = require("./reportFormSubjects");
const { loadGradingSystem, getTotalMarksPossible } = require("./grading");

// Percentages/totals are rounded DOWN to whole numbers everywhere (same as the report cards).
const round2 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.floor(Number(n) + 1e-9));
const norm = (v) => String(v || "").replace(/\(\s*optional\s*\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

// Session statuses after which a missing submission means "did not sit".
const OVER = new Set(["ended", "completed", "done", "closed"]);
const isSessionOver = (status) => OVER.has(String(status || "").toLowerCase());

/** (subjectName) => true when that subject is optional. */
async function loadOptionalMatcher(pool) {
  let names = new Set();
  try {
    const cfg = await getReportFormConfig(pool);
    names = new Set(cfg.subjects.filter((s) => s.optional).map((s) => norm(s.name)));
  } catch (_) { /* optional feature — never break a report */ }
  return (subjectName) => /\(\s*optional\s*\)/i.test(String(subjectName || "")) || names.has(norm(subjectName));
}


/* Split / concurrent papers (exam_subject_sessions.allow_concurrent = 1): one
   subject sat as several papers at the same time (e.g. codes 9819 and 9820).
   In reports every paper/code is still LISTED, but the subject is ONE paper
   in the totals: only the paper the candidate actually sat is counted. */
const { splitBaseName, splitGroupKey } = require("./splitPapers");

/** items: [{ percentage, group, sat }] -> the items that COUNT: ungrouped items as they are,
    and for each split group ONE item (the paper that was sat — highest if several — else the
    first one, i.e. a single absent 0 for the whole subject). */
function countedWithoutSplitDuplicates(items) {
  const out = [];
  const best = new Map(); // group -> chosen item
  items.forEach((it) => {
    if (it.percentage == null) return;
    if (!it.group) { out.push(it); return; }
    const cur = best.get(it.group);
    if (!cur) { best.set(it.group, it); return; }
    const better = (it.sat && !cur.sat) || (it.sat === cur.sat && it.sat && Number(it.percentage) > Number(cur.percentage));
    if (better) best.set(it.group, it);
  });
  return out.concat([...best.values()]);
}

/** items: [{ percentage }] for the papers that COUNT (absent compulsory = 0). */
function summarisePercentages(items, gradingSystem) {
  const counted = items.filter((x) => x.percentage != null);
  if (!counted.length) return { total: null, possible: null, average: null };
  const total = counted.reduce((a, x) => a + Number(x.percentage), 0);
  return {
    total: round2(total),
    possible: getTotalMarksPossible(gradingSystem, counted.length),
    average: round2(total / counted.length),
  };
}

module.exports = { round2, isSessionOver, loadOptionalMatcher, summarisePercentages, loadGradingSystem, splitGroupKey, splitBaseName, countedWithoutSplitDuplicates };
