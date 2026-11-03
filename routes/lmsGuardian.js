/* =========================================================================
   /api/lms-guardian  (L9.5a)  PUBLIC read-only guardian view. No login: the secret in the link is the credential.
   GET /api/lms-guardian/:tenant/:secret.json
   Every failure (bad school, bad/revoked secret, no licence, inactive student, rate limited aside) answers the same 404.
   Rate limit (in memory, per server instance): 60 requests a minute per client address plus a ceiling of 1200 a minute for the
   whole feed, so one noisy client cannot load the database. The server has no `trust proxy` setting, so the client address is
   the first X-Forwarded-For entry when present (a spoofed header can only dodge the per-client limit; the 192-bit secret
   cannot be guessed and the global ceiling still holds).
========================================================================= */
const express = require("express");
const router = express.Router();
const { renderView } = require("../utils/lmsGuardian");

/* config/db opens connections when loaded, so it is required lazily (and tests can replace these). */
const deps = { hasTenant: (t) => require("../config/db").hasTenant(t), getPool: (t) => require("../config/db").getPool(t),
  isLicensed: (pool, t) => require("../utils/tenantModules").isModuleActive(pool, t, "lms", "lms_guardian") };
const WINDOW_MS = 60000, MAX_HITS = 60, MAX_KEYS = 5000, GLOBAL_MAX = 1200;
const hits = new Map();
function limited(key, now = Date.now()) {
  if (hitAll(now)) return true;
  const h = hits.get(key);
  if (!h || now - h.start > WINDOW_MS) { if (hits.size >= MAX_KEYS) hits.clear(); hits.set(key, { start: now, n: 1 }); return false; }
  h.n += 1; return h.n > MAX_HITS;
}
let all = { start: 0, n: 0 };
function hitAll(now) { if (now - all.start > WINDOW_MS) all = { start: now, n: 0 }; all.n += 1; return all.n > GLOBAL_MAX; }
const clientOf = (req) => String((req.headers && req.headers["x-forwarded-for"]) || req.ip || "?").split(",")[0].trim().slice(0, 64) || "?";
const notFound = (res) => res.status(404).type("text/plain").set("Cache-Control", "no-store").send("Not found");
const TENANT_RE = /^[A-Za-z0-9_-]{1,40}$/;

router.get("/:tenant/:file", async (req, res) => {
  try {
    if (limited(clientOf(req))) return res.status(429).type("text/plain").set("Retry-After", "60").send("Too many requests");
    const { tenant, file } = req.params;
    const m = /^([a-f0-9]{48})\.json$/.exec(String(file || ""));
    if (!m || !TENANT_RE.test(String(tenant || "")) || !deps.hasTenant(tenant)) return notFound(res);
    const pool = await deps.getPool(tenant);
    if (!(await deps.isLicensed(pool, tenant))) return notFound(res);
    const r = await renderView(pool, m[1]);
    if (!r.ok) return notFound(res);
    res.set({ "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    res.status(200).json({ success: true, ...r.view });
  } catch (e) { console.error("LMS GUARDIAN VIEW ERROR:", e.message); notFound(res); }
});

router._deps = deps; router._limited = limited; router._hits = hits; router._resetAll = () => { all = { start: 0, n: 0 }; hits.clear(); }; // tests only
module.exports = router;
