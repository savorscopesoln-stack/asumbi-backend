/* =========================================================================
   SAFE EXAM BROWSER (SEB) REQUIREMENT
   ─────────────────────────────────────────────────────────
   When an admin/teacher switches "Require Safe Exam Browser" ON for an
   assessment (e_assessments.require_seb = 1), every student exam request
   (login, start, activate, heartbeat, autosave, submit, paper fetch) must
   come from SEB. Anything else is answered with 403 + code SEB_REQUIRED.

   HOW IT IS VERIFIED
   ─────────────────────────────────────────────────────────
   SEB adds two HTTP headers to every request it makes:
     X-SafeExamBrowser-RequestHash    = SHA-256( fullRequestURL + BrowserExamKey )
     X-SafeExamBrowser-ConfigKeyHash  = SHA-256( fullRequestURL + ConfigKey )
   The admin pastes the exam's Config Key (stable across SEB versions) and/or
   Browser Exam Key(s) into the assessment (e_assessments.seb_keys, one per
   line). For each request we recompute SHA-256(url + key) for every saved
   key and compare it with the headers. The raw key never travels, so it
   cannot be copied from the network traffic.

   If NO key has been saved yet, we fall back to a weak check: the
   User-Agent must contain "SEB/<version>". That is trivially spoofable, so
   the admin screen warns to save a key.

   THE URL MUST MATCH WHAT SEB REQUESTED
   ─────────────────────────────────────────────────────────
   The server is behind a proxy (Render), so the URL is rebuilt from
   X-Forwarded-Proto / X-Forwarded-Host + the original path. If your public
   API address differs from what the proxy reports (custom domain etc.), set
   PUBLIC_API_ORIGIN=https://api.example.com in the backend env.

   FAILURE MODE: a database hiccup while reading the switch fails OPEN (the
   same choice as the Desktop-only switch) so a glitch can't lock a whole
   class out of an exam.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { deviceKeyFor, isDeviceAllowed, recordRejection, resolveStudentId } = require("./deviceRestriction");

const SEB_REQUIRED_CODE = "SEB_REQUIRED";
const SEB_REQUIRED_MESSAGE =
  "This exam must be taken in Safe Exam Browser (SEB). Open the exam using the SEB file or link from your teacher, then sign in again.";

const HEX64 = /^[0-9a-f]{64}$/;

// "abc…\n def…" -> { keys: [valid lowercase 64-hex], invalid: [rejected tokens] }
function parseKeys(text) {
  const tokens = String(text || "").split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const keys = [];
  const invalid = [];
  for (const t of tokens) {
    if (HEX64.test(t)) { if (!keys.includes(t)) keys.push(t); }
    else invalid.push(t);
  }
  return { keys, invalid };
}

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")); }
  catch { return false; }
}

// Candidate full URLs the browser may have requested (fragment never reaches the server).
function candidateUrls(req) {
  const first = (v) => String(v || "").split(",")[0].trim();
  const path = req.originalUrl || req.url || "/";
  const proto = first(req.get && req.get("x-forwarded-proto")) || req.protocol || "https";
  const host = first(req.get && req.get("x-forwarded-host")) || (req.get && req.get("host")) || "";
  const out = [];
  const pub = String(process.env.PUBLIC_API_ORIGIN || "").trim().replace(/\/+$/, "");
  if (pub) out.push(pub + path);
  if (host) out.push(`${proto}://${host}${path}`);
  return [...new Set(out)];
}

/** True when the request carries a valid SEB hash for one of the saved keys. */
function hasValidSebHash(req, keys) {
  const header = (n) => String((req.get && req.get(n)) || "").trim().toLowerCase();
  const provided = [header("x-safeexambrowser-requesthash"), header("x-safeexambrowser-configkeyhash")].filter(Boolean);
  if (!provided.length) return false;
  for (const url of candidateUrls(req)) {
    for (const key of keys) {
      const expected = sha256hex(url + key);
      if (provided.some((p) => safeEqualHex(p, expected))) return true;
    }
  }
  return false;
}

const looksLikeSeb = (req) => /\bSEB\/\d/i.test(String((req.get && req.get("user-agent")) || ""));

/* ── short-TTL cache of the per-assessment switch + keys ── */
const TTL_MS = 3000;
const cache = new Map();
function invalidateSebCache(tenant, assessmentId) {
  cache.delete(`${tenant || "default"}:${assessmentId}`);
}

async function loadSebConfig(pool, tenant, assessmentId) {
  const key = `${tenant || "default"}:${assessmentId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = { required: false, keys: [] };
  try {
    const r = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`SELECT ISNULL(require_seb, 0) AS require_seb, seb_keys FROM e_assessments WHERE id = @id`);
    const row = r.recordset[0];
    if (row) value = { required: !!row.require_seb, keys: parseKeys(row.seb_keys).keys };
  } catch (err) {
    console.error("SEB FLAG LOOKUP ERROR:", err.message);
    return { required: false, keys: [] }; // fail open — see header comment
  }
  cache.set(key, { value, at: Date.now() });
  if (cache.size > 2000) cache.clear();
  return value;
}

/* A non-SEB browser that was refused is written to the same Device Locks list as
   rejected phones (platform "noseb"). When an admin presses Allow on that row,
   THIS student on THIS device may take THIS exam in a normal browser. The row's
   device_key is prefixed "seb:" so it never collides with, or accidentally
   unlocks, a Desktop-only row for the same device. */
async function sebExemption(req, pool, tenant, assessmentId, opts, reason) {
  try {
    const studentId = await resolveStudentId(pool, req, opts && opts.username);
    if (!studentId) return false; // unknown student: nothing to record or allow
    const deviceKey = "seb:" + deviceKeyFor(req);
    if (await isDeviceAllowed(pool, tenant, assessmentId, studentId, deviceKey)) return true;
    recordRejection(pool, tenant, assessmentId, studentId, deviceKey, { platform: "noseb", reason: "Not using Safe Exam Browser" + (reason ? ` (${reason})` : "") }, req); // fire-and-forget
  } catch (err) {
    console.error("SEB EXEMPTION CHECK ERROR:", err.message);
  }
  return false;
}

/** Returns { blocked: false } or { blocked: true, reason }. opts.username: for exam-login (no token yet). */
async function checkSeb(req, pool, tenant, assessmentId, opts = {}) {
  if (!assessmentId) return { blocked: false };
  const cfg = await loadSebConfig(pool, tenant, assessmentId);
  if (!cfg.required) return { blocked: false };

  if (cfg.keys.length) {
    if (hasValidSebHash(req, cfg.keys)) return { blocked: false, mode: "key" };
    // SEB itself is running (User-Agent says so) but its key hash does not match: it was
    // started from an OLD / different .seb file or has saved settings of its own.
    const stale = looksLikeSeb(req);
    const reason = stale ? "SEB is running with an old or different configuration (key hash not matching)" : "SEB key hash missing or not matching";
    if (await sebExemption(req, pool, tenant, assessmentId, opts, reason)) return { blocked: false, mode: "admin-allowed" };
    return { blocked: true, reason, stale };
  }
  // No key saved yet: weak User-Agent check only.
  if (looksLikeSeb(req)) return { blocked: false, mode: "user-agent" };
  const reason = "Not Safe Exam Browser (no key saved; User-Agent check)";
  if (await sebExemption(req, pool, tenant, assessmentId, opts, reason)) return { blocked: false, mode: "admin-allowed" };
  return { blocked: true, reason };
}

const SEB_STALE_MESSAGE =
  "Safe Exam Browser is open, but with an old or different exam file. Quit Safe Exam Browser completely (Cmd+Q), delete any older exam .seb files, download the exam file again and open it.";

function sendSebBlocked(res, stale = false) {
  return res.status(403).json({
    success: false,
    code: SEB_REQUIRED_CODE,
    sebRequired: true,
    sebStale: !!stale,
    message: stale ? SEB_STALE_MESSAGE : SEB_REQUIRED_MESSAGE,
  });
}

/** Express middleware for the authenticated student exam routes (staff are never affected). */
async function enforceSeb(req, res, next) {
  try {
    if (req.user?.role !== "student") return next();
    const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
    const assessmentId =
      toInt(req.params?.id) ||
      toInt(req.body?.assessment_id) ||
      toInt(req.body?.assessmentId) ||
      toInt(req.user?.examAssessmentId);
    const result = await checkSeb(req, req.pool, req.user?.tenant, assessmentId);
    if (result.blocked) return sendSebBlocked(res, result.stale);
    return next();
  } catch (err) {
    console.error("ENFORCE SEB ERROR:", err);
    return next(); // fail open
  }
}

module.exports = {
  SEB_REQUIRED_CODE, SEB_REQUIRED_MESSAGE,
  parseKeys, checkSeb, enforceSeb, sendSebBlocked, invalidateSebCache,
  // exported for tests
  hasValidSebHash, candidateUrls, sha256hex,
};
