/* =========================================================
   GRADING UTILITIES (server-side)
   ---------------------------------------------------------
   Same scale and matching logic as frontend/src/utils/grading.js
   (Admin → E-Assessments → Grading System), ported here because PDF
   generation (transcripts, report exports) happens server-side where
   the frontend module isn't reachable. Kept byte-for-byte equivalent
   to the frontend version's matchBand/getGradeForScore/
   getOverallResultForScore so a downloaded transcript can never
   disagree with what the student portal shows for the same marks
   (§51 "one source of truth").
========================================================== */

// Identical fallback to frontend/src/utils/grading.js's
// DEFAULT_GRADING_SYSTEM and to getGradingSystem's no-row fallback in
// eAssessment.controller.js — every "no GradingSystem row yet" path in
// the app already agrees on these numbers.
const DEFAULT_GRADING_SYSTEM = {
  systemName: "KNEC Standard",
  passMark: 40,
  gradeBands: [
    { minScore: 80, grade: "1", label: "Distinction", remark: "Excellent Performance" },
    { minScore: 75, grade: "2", label: "Distinction", remark: "Good Performance" },
    { minScore: 70, grade: "3", label: "Credit", remark: "Good Performance" },
    { minScore: 60, grade: "4", label: "Credit", remark: "Fair Performance" },
    { minScore: 50, grade: "5", label: "Pass", remark: "Weak Performance" },
    { minScore: 40, grade: "6", label: "Pass", remark: "Needs Improvement" },
    { minScore: 0, grade: "7", label: "Fail", remark: "Needs Improvement" },
  ],
  overallBands: [
    { minScore: 75, label: "DISTINCTION" },
    { minScore: 60, label: "CREDIT" },
    { minScore: 40, label: "PASS" },
    { minScore: 0, label: "REFERRED" },
  ],
};

const sortedDesc = (bands) =>
  Array.isArray(bands) && bands.length
    ? [...bands].sort((a, b) => Number(b.minScore) - Number(a.minScore))
    : [];

const matchBand = (score, bands) => {
  const list = sortedDesc(bands);
  if (!list.length) return null;
  const n = Number(score) || 0;
  return list.find((b) => n >= Number(b.minScore)) || list[list.length - 1];
};

function getGradeForScore(score, gradingSystem) {
  const bands = gradingSystem?.gradeBands?.length ? gradingSystem.gradeBands : DEFAULT_GRADING_SYSTEM.gradeBands;
  const band = matchBand(score, bands);
  return band ? { grade: band.grade, label: band.label, remark: band.remark || "" } : { grade: "", label: "", remark: "" };
}

function getOverallResultForScore(avg, gradingSystem) {
  const bands = gradingSystem?.overallBands?.length ? gradingSystem.overallBands : DEFAULT_GRADING_SYSTEM.overallBands;
  const band = matchBand(avg, bands);
  return band?.label || "";
}

// Reads the exact same GradingSystem row getGradingSystem() (the
// admin settings endpoint) reads, with the exact same no-row
// fallback, so a transcript generated before/after that endpoint is
// ever hit always agrees with it.
async function loadGradingSystem(pool) {
  try {
    const result = await pool.request().query(`SELECT TOP 1 * FROM GradingSystem WHERE id = 1`);
    const row = result.recordset[0];
    if (!row) return DEFAULT_GRADING_SYSTEM;
    let gradeBands = [];
    let overallBands = [];
    try { gradeBands = JSON.parse(row.gradeBandsJson || "[]"); } catch (_) {}
    try { overallBands = JSON.parse(row.overallBandsJson || "[]"); } catch (_) {}
    return {
      systemName: row.systemName,
      passMark: row.passMark,
      gradeBands: gradeBands.length ? gradeBands : DEFAULT_GRADING_SYSTEM.gradeBands,
      overallBands: overallBands.length ? overallBands : DEFAULT_GRADING_SYSTEM.overallBands,
    };
  } catch (_) {
    // Table not migrated yet on this tenant — same fallback as every
    // other "no grading system configured" path in the app.
    return DEFAULT_GRADING_SYSTEM;
  }
}

module.exports = { DEFAULT_GRADING_SYSTEM, getGradeForScore, getOverallResultForScore, loadGradingSystem };
