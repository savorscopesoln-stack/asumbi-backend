/* =========================================================================
   LMS PLAGIARISM-CHECKER HOOK  (L5.5): INTERFACE ONLY. No checker is built or bundled; nothing calls this yet.

   A school (or a later module) may register ONE checker: `async ({ tenant, courseId, assignmentId, submissionId, text }) => ({ score?: number 0-100, reportUrl?: string })`.
   `check()` never throws, never sends anything anywhere when no checker is registered (`not_configured`), enforces a time limit, clamps the score and keeps only an
   http(s) report link. A result is ADVICE FOR THE TEACHER, never a grade or a verdict. Wiring it into marking would be a later, owner-approved unit (the text of a
   student's work would leave the school's database, so a data-protection decision comes first).
========================================================================= */
let checker = null;
const TIMEOUT_MS = 15000;

function registerChecker(fn) { if (fn !== null && typeof fn !== "function") throw new TypeError("checker must be a function or null"); checker = fn; return () => { if (checker === fn) checker = null; }; }
const isConfigured = () => typeof checker === "function";

async function check(input, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!isConfigured()) return { status: "not_configured" };
  let timer;
  try {
    const res = await Promise.race([Promise.resolve(checker(input)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); })]);
    const score = res && Number.isFinite(Number(res.score)) ? Math.min(100, Math.max(0, Number(res.score))) : null;
    const reportUrl = res && typeof res.reportUrl === "string" && /^https?:\/\//i.test(res.reportUrl) && res.reportUrl.length <= 2000 ? res.reportUrl : null;
    return { status: "done", score, reportUrl };
  } catch (e) { return { status: e && e.message === "timeout" ? "timeout" : "error" }; } finally { clearTimeout(timer); }
}

module.exports = { registerChecker, isConfigured, check, TIMEOUT_MS };
