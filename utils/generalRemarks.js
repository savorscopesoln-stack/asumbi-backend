/* =========================================================================
   GENERAL REMARKS — the automatic comment printed on the transcript and the
   report card in place of the class teacher's hand-written remarks.

   It names the subjects that fell below the school's pass mark (Grading
   System → pass mark) and advises the student to work on them; subjects the
   student was absent for (AB) are named too. frontend/src/utils/generalRemarks.js
   is the same wording for the on-screen report card — keep the two in step.
========================================================================= */
const MAX_LISTED = 8;
const pct = (n) => `${Math.floor(Number(n) + 1e-9)}%`;
const list = (items) => items.slice(0, MAX_LISTED).join(", ") + (items.length > MAX_LISTED ? ` and ${items.length - MAX_LISTED} more` : "");

/** weak: [{ name, score }] below pass mark; absent: [name]; all: [{ name, score }] every scored subject. */
function buildGeneralRemarks({ passMark = 40, weak = [], absent = [], all = [] } = {}) {
  const parts = [];
  const sortedWeak = [...weak].sort((a, b) => Number(a.score) - Number(b.score));
  if (sortedWeak.length) {
    parts.push(
      `Below the ${passMark}% pass mark: ${list(sortedWeak.map((s) => `${s.name} (${pct(s.score)})`))}. ` +
      `Please give extra time to ${sortedWeak.length === 1 ? "this subject" : "these subjects"}: revise the topics you found difficult, practise past papers and ask your teachers for help.`
    );
  } else if (all.length) {
    const lowest = [...all].sort((a, b) => Number(a.score) - Number(b.score))[0];
    parts.push(`All subjects met the ${passMark}% pass mark. Well done. Keep it up, and keep strengthening your weakest subject, ${lowest.name} (${pct(lowest.score)}).`);
  }
  if (absent.length) {
    parts.push(`Absent (AB): ${list(absent)}. Please make sure you sit every paper.`);
  }
  return parts.join(" ");
}

module.exports = { buildGeneralRemarks };
