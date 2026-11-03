/* =========================================================================
   LMS WORD-FILTER HOOK  (L8.1a, D-095)  INTERFACE ONLY: nothing is filtered until a school plugs a filter in.
   `setFilter(fn)`: fn(text, ctx) -> true | { ok: true } | false | { ok: false, message }. `check(text, ctx)` always returns { ok:true } or { ok:false, message }.
   Applied only to LEARNER posts. A filter that throws or returns something odd FAILS OPEN (the post is allowed, the error is logged) so a broken filter never
   blocks a class; the report/hide tools of L8.1b are the safety net.
========================================================================= */
let filter = null;
function setFilter(fn) { if (fn !== null && typeof fn !== "function") throw new TypeError("filter must be a function or null"); filter = fn; }
function check(text, ctx = {}) {
  if (!filter) return { ok: true };
  try {
    const r = filter(String(text || ""), ctx);
    if (r === true || r === undefined || r === null || (r && r.ok === true)) return { ok: true };
    if (r === false || (r && r.ok === false)) return { ok: false, message: (r && typeof r.message === "string" && r.message.slice(0, 200)) || "This message cannot be posted. Please reword it." };
    return { ok: true };
  } catch (e) { console.error("LMS word filter ERROR:", e.message); return { ok: true }; }
}
module.exports = { setFilter, check };
