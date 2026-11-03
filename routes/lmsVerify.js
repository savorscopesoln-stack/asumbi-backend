/* =========================================================================
   /api/lms-verify  (L7.5a, D-091)  PUBLIC certificate verification. No login: the certificate code is the credential.
   GET /api/lms-verify/:tenant/:code  ->  { success: true, valid: false }  or  { success: true, valid: true, courseTitle, issuedAt, holder }
   `holder` = first name + last initial only. Every failure (bad school, no licence, malformed/unknown/revoked code, error) answers the SAME `valid: false`, so the
   route cannot be used to learn anything but "this exact code is genuine". Rate limit (in memory, per server instance): 30 requests a minute per client and
   600 a minute overall (a 60-bit code cannot be guessed at that speed). Licence: the school's `lms` module must be active.
========================================================================= */
const express = require("express");
const router = express.Router();
const { verifyCertificate } = require("../utils/lmsCertificates");

const deps = { hasTenant: (t) => require("../config/db").hasTenant(t), getPool: (t) => require("../config/db").getPool(t),
  isLicensed: (pool, t) => require("../utils/tenantModules").isModuleActive(pool, t, "lms", "lms_gradebook") };
const WINDOW_MS = 60000, MAX_HITS = 30, MAX_KEYS = 5000, GLOBAL_MAX = 600;
const hits = new Map();
let all = { start: 0, n: 0 };
function hitAll(now) { if (now - all.start > WINDOW_MS) all = { start: now, n: 0 }; all.n += 1; return all.n > GLOBAL_MAX; }
function limited(key, now = Date.now()) {
  if (hitAll(now)) return true;
  const h = hits.get(key);
  if (!h || now - h.start > WINDOW_MS) { if (hits.size >= MAX_KEYS) hits.clear(); hits.set(key, { start: now, n: 1 }); return false; }
  h.n += 1; return h.n > MAX_HITS;
}
const clientOf = (req) => String((req.headers && req.headers["x-forwarded-for"]) || req.ip || "?").split(",")[0].trim().slice(0, 64) || "?";
const TENANT_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NO = { success: true, valid: false };

router.get("/:tenant/:code", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
  try {
    if (limited(clientOf(req))) return res.status(429).set("Retry-After", "60").json({ success: false, message: "Too many requests" });
    const { tenant, code } = req.params;
    if (!TENANT_RE.test(String(tenant || "")) || !deps.hasTenant(tenant)) return res.status(200).json(NO);
    const pool = await deps.getPool(tenant);
    if (!(await deps.isLicensed(pool, tenant))) return res.status(200).json(NO);
    const r = await verifyCertificate(pool, code);
    if (!r.valid) return res.status(200).json(NO);
    res.status(200).json({ success: true, valid: true, courseTitle: r.courseTitle, issuedAt: r.issuedAt, holder: r.holder });
  } catch (e) { console.error("LMS VERIFY ERROR:", e.message); res.status(200).json(NO); }
});

router._deps = deps; router._limited = limited; router._resetAll = () => { all = { start: 0, n: 0 }; hits.clear(); }; // tests only
module.exports = router;
