/* =========================================================================
   DESKTOP-ONLY EXAM RESTRICTION
   ─────────────────────────────────────────────────────────
   When an admin switches "Desktop only" ON for an assessment
   (e_assessments.desktop_only = 1), only Windows and macOS laptops /
   desktops may take it. Phones and tablets (Android, iPhone, iPad),
   plus anything else that isn't Windows/macOS (Linux, ChromeOS, ...),
   are rejected.

   The switch can be flipped at ANY time, including while students are
   mid-exam: the check runs on every student exam call (login, start,
   activate, heartbeat, autosave, submit), so a phone that is already
   inside the exam is kicked out on its next heartbeat (~10s).

   HOW A DEVICE IS CLASSIFIED
   ─────────────────────────────────────────────────────────
   Two signals, combined:
     1. The User-Agent / Sec-CH-UA-* headers the browser always sends.
     2. An `X-Client-Device` header our own frontend adds to every API
        call (see frontend/src/api.js) carrying navigator.platform,
        navigator.userAgentData and navigator.maxTouchPoints.

   Signal 2 exists because of iPadOS: since iPadOS 13, Safari sends a
   *Mac* User-Agent by default, so the header alone can't tell an iPad
   from a MacBook. A "Mac" that reports multi-touch is an iPad.

   ALLOWING A SPECIFIC DEVICE
   ─────────────────────────────────────────────────────────
   Every rejection is recorded in e_assessment_device_access (student,
   assessment, platform, device id, attempts, last seen) and shown on the
   admin Device Locks tab. An admin can click "Allow" on a row: that
   (student, device, assessment) is then let through even while Desktop-only
   is ON, and "Revoke" puts the block back. The device is identified by the
   `exam_device_id` the browser keeps (sent in X-Client-Device); if that's
   missing the User-Agent is hashed instead.

   KNOWN LIMIT: all of this comes from the client, so a determined
   person can spoof it. It reliably stops normal phone/tablet use
   (including "Request Desktop Site"), not a deliberate bypass.

   PERFORMANCE: a device that classifies as an allowed desktop returns
   immediately without touching the database, so students on laptops
   (the normal case) pay nothing. The DB flag is only read for devices
   that WOULD be blocked, and is cached for a few seconds so a toggle
   still takes effect almost instantly.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");

const DEVICE_NOT_ALLOWED_CODE = "DEVICE_NOT_ALLOWED";
const DEVICE_NOT_ALLOWED_MESSAGE =
  "This exam can only be taken on a Windows or Mac laptop/desktop computer. Phones and tablets are not allowed.";

/* ── parse the helper header our frontend sends ── */
function parseClientDevice(req) {
  const raw = req.get("x-client-device");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const stripQuotes = (s) => String(s || "").replace(/"/g, "").trim();

/**
 * Returns { allowed, platform, reason }.
 *   platform: windows | mac | android | ios | ipados | linux | chromeos | unknown
 * Only Windows and macOS non-mobile, non-touch-tablet devices are allowed.
 */
function classifyDevice(req) {
  const ua = String(req.get("user-agent") || "");
  const chPlatform = stripQuotes(req.get("sec-ch-ua-platform")).toLowerCase();
  const chMobile = String(req.get("sec-ch-ua-mobile") || "").trim(); // "?1" = mobile
  const client = parseClientDevice(req) || {};

  const clientPlatform = String(client.uaPlatform || "").toLowerCase(); // navigator.userAgentData.platform
  const navPlatform = String(client.platform || "").toLowerCase();       // navigator.platform
  const touchPoints = Number(client.maxTouchPoints) || 0;

  /* ---- 1. figure out the OS ---- */
  let platform = "unknown";
  const hint = clientPlatform || chPlatform; // client hints are the most trustworthy when present
  if (hint) {
    if (hint.includes("android")) platform = "android";
    else if (hint === "ios" || hint.includes("iphone") || hint.includes("ipad")) platform = "ios";
    else if (hint.includes("windows")) platform = "windows";
    else if (hint.includes("macos") || hint === "mac") platform = "mac";
    else if (hint.includes("chrome os") || hint.includes("chromeos")) platform = "chromeos";
    else if (hint.includes("linux")) platform = "linux";
  }
  if (platform === "unknown") {
    if (/Android/i.test(ua)) platform = "android";
    else if (/iPhone|iPad|iPod/i.test(ua)) platform = "ios";
    else if (/CrOS/i.test(ua)) platform = "chromeos";
    else if (/Windows NT|Win64|Win32/i.test(ua)) platform = "windows";
    else if (/Macintosh|Mac OS X/i.test(ua)) platform = "mac";
    else if (/Linux|X11/i.test(ua)) platform = "linux";
  }

  /* ---- 2. cross-check the OS against what the page itself reported ---- */
  // navigator.platform disagreeing with the UA/hints is a spoofing/odd-device signal.
  if (navPlatform) {
    if (/iphone|ipad|ipod/.test(navPlatform)) platform = "ios";
    else if (/android|arm|linux armv|linux aarch/.test(navPlatform) && /android/i.test(ua)) platform = "android";
  }

  /* ---- 3. iPad pretending to be a Mac ---- */
  // Real Macs have no touchscreen (maxTouchPoints 0); an iPad in "desktop
  // site" mode reports a Mac UA but maxTouchPoints > 1.
  if (platform === "mac" && touchPoints > 1) platform = "ipados";

  /* ---- 4. generic phone/tablet flags ---- */
  const flaggedMobile = chMobile === "?1" || client.mobile === true || /\bMobile\b|\bTablet\b|\bSilk\b|\bKindle\b/i.test(ua);

  if (platform === "windows" || platform === "mac") {
    if (flaggedMobile) {
      return { allowed: false, platform, reason: "Reported as a mobile/tablet device" };
    }
    return { allowed: true, platform, reason: null };
  }

  return {
    allowed: false,
    platform,
    reason: platform === "unknown" ? "Could not identify the device" : `Not a Windows or Mac computer (${platform})`,
  };
}

/* ── short-TTL cache of the per-assessment flag (see PERFORMANCE above) ── */
const FLAG_TTL_MS = 3000;
const flagCache = new Map(); // key -> { value, at }

function invalidateDesktopOnlyCache(tenant, assessmentId) {
  flagCache.delete(`${tenant || "default"}:${assessmentId}`);
}

async function isDesktopOnly(pool, tenant, assessmentId) {
  const key = `${tenant || "default"}:${assessmentId}`;
  const hit = flagCache.get(key);
  if (hit && Date.now() - hit.at < FLAG_TTL_MS) return hit.value;

  let value = false;
  try {
    const r = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`SELECT ISNULL(desktop_only, 0) AS desktop_only FROM e_assessments WHERE id = @id`);
    value = !!(r.recordset[0] && r.recordset[0].desktop_only);
  } catch (err) {
    // Column missing (schema not migrated yet) or transient DB error:
    // fail OPEN so a hiccup can never lock a whole class out of an exam.
    console.error("DESKTOP-ONLY FLAG LOOKUP ERROR:", err.message);
    return false;
  }

  flagCache.set(key, { value, at: Date.now() });
  if (flagCache.size > 2000) flagCache.clear(); // crude bound, entries are tiny and short-lived
  return value;
}


/* ── DEVICE IDENTITY, REJECTION LOG AND ALLOW-LIST ── */
function deviceKeyFor(req) {
  const client = parseClientDevice(req) || {};
  const id = String(client.deviceId || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
  if (id.length >= 8) return id;
  const ua = String(req.get("user-agent") || "");
  return "ua:" + crypto.createHash("sha1").update(ua).digest("hex").slice(0, 20);
}

const ALLOW_TTL_MS = 5000;
const allowCache = new Map(); // `${tenant}:${aid}:${sid}:${key}` -> { value, at }
function invalidateDeviceAccessCache() { allowCache.clear(); }

async function isDeviceAllowed(pool, tenant, assessmentId, studentId, deviceKey) {
  const ck = `${tenant || "default"}:${assessmentId}:${studentId}:${deviceKey}`;
  const hit = allowCache.get(ck);
  if (hit && Date.now() - hit.at < ALLOW_TTL_MS) return hit.value;
  let value = false;
  try {
    const r = await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .input("dk", sql.NVarChar(100), deviceKey)
      .query(`SELECT 1 AS ok FROM e_assessment_device_access
              WHERE e_assessment_id = @aid AND student_id = @sid AND device_key = @dk AND status = 'allowed'`);
    value = r.recordset.length > 0;
  } catch (err) {
    console.error("DEVICE ALLOW LOOKUP ERROR:", err.message);
    return false; // can't prove it was allowed -> the restriction stands
  }
  allowCache.set(ck, { value, at: Date.now() });
  if (allowCache.size > 5000) allowCache.clear();
  return value;
}

// A phone retrying (heartbeat every ~10s) must not hammer the database:
// write at most once a minute per (assessment, student, device).
const REJECT_LOG_WINDOW_MS = 60000;
const rejectSeen = new Map();
async function recordRejection(pool, tenant, assessmentId, studentId, deviceKey, device, req) {
  try {
    const ck = `${tenant || "default"}:${assessmentId}:${studentId}:${deviceKey}`;
    const now = Date.now();
    const last = rejectSeen.get(ck);
    if (last && now - last < REJECT_LOG_WINDOW_MS) return;
    rejectSeen.set(ck, now);
    if (rejectSeen.size > 5000) { for (const [k, t] of rejectSeen) if (now - t > 120000) rejectSeen.delete(k); }

    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "").slice(0, 64) || null;
    await pool.request()
      .input("aid", sql.Int, assessmentId)
      .input("sid", sql.Int, studentId)
      .input("dk", sql.NVarChar(100), deviceKey)
      .input("platform", sql.NVarChar(30), String(device?.platform || "unknown").slice(0, 30))
      .input("ua", sql.NVarChar(400), String(req.get("user-agent") || "").slice(0, 400) || null)
      .input("ip", sql.NVarChar(64), ip)
      .input("reason", sql.NVarChar(200), device?.reason ? String(device.reason).slice(0, 200) : null)
      .query(`
        UPDATE e_assessment_device_access
        SET attempts = attempts + 1, last_seen = GETDATE(), platform = @platform, user_agent = @ua, ip = @ip, reason = @reason
        WHERE e_assessment_id = @aid AND student_id = @sid AND device_key = @dk;
        IF @@ROWCOUNT = 0
          INSERT INTO e_assessment_device_access (e_assessment_id, student_id, device_key, platform, user_agent, ip, reason)
          VALUES (@aid, @sid, @dk, @platform, @ua, @ip, @reason);
      `);
  } catch (err) {
    if (!/duplicate|UX_e_assessment_device_access/i.test(String(err.message))) {
      console.error("DEVICE REJECTION LOG ERROR:", err.message); // never affects the response
    }
  }
}

// Who is behind this request? A logged-in student -> req.user.id. The exam
// login has no token yet, so fall back to the username they typed.
async function resolveStudentId(pool, req, username) {
  if (req.user?.role === "student" && req.user.id) return Number(req.user.id) || 0;
  if (!username) return 0;
  try {
    const r = await pool.request().input("u", sql.NVarChar(150), String(username).slice(0, 150))
      .query(`SELECT id FROM Students WHERE username = @u`);
    return r.recordset[0]?.id || 0;
  } catch { return 0; }
}

/**
 * Core check. Returns { blocked: false } or { blocked: true, device }.
 */
async function checkDesktopOnly(req, pool, tenant, assessmentId, opts = {}) {
  if (!assessmentId) return { blocked: false };
  const device = classifyDevice(req);
  if (device.allowed) return { blocked: false, device }; // normal laptop: no DB hit
  const restricted = await isDesktopOnly(pool, tenant, assessmentId);
  if (!restricted) return { blocked: false, device };

  // A phone/tablet on a restricted exam: let it through only if an admin
  // allowed THIS device for THIS student; otherwise record the attempt (so the
  // admin sees it on the Device Locks tab) and block.
  const studentId = await resolveStudentId(pool, req, opts.username);
  const deviceKey = deviceKeyFor(req);
  if (await isDeviceAllowed(pool, tenant, assessmentId, studentId, deviceKey)) {
    return { blocked: false, device, allowedByAdmin: true };
  }
  recordRejection(pool, tenant, assessmentId, studentId, deviceKey, device, req); // fire-and-forget
  return { blocked: true, device };
}

function sendBlocked(res, device) {
  return res.status(403).json({
    success: false,
    code: DEVICE_NOT_ALLOWED_CODE,
    deviceBlocked: true,
    message: DEVICE_NOT_ALLOWED_MESSAGE,
    detectedPlatform: device?.platform || "unknown",
  });
}

/**
 * Express middleware for the authenticated student exam routes.
 * The assessment id comes from (in order): the route param, the request
 * body, or the exam-only JWT's own examAssessmentId (which covers
 * heartbeat/activate/status/lock/end, whose bodies carry no assessment id).
 * Staff and non-student users are never affected.
 */
async function enforceDesktopOnly(req, res, next) {
  try {
    if (req.user?.role !== "student") return next();

    const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
    const assessmentId =
      toInt(req.params?.id) ||
      toInt(req.body?.assessment_id) ||
      toInt(req.body?.assessmentId) ||
      toInt(req.user?.examAssessmentId);

    const result = await checkDesktopOnly(req, req.pool, req.user?.tenant, assessmentId);
    if (result.blocked) return sendBlocked(res, result.device);
    return next();
  } catch (err) {
    console.error("ENFORCE DESKTOP-ONLY ERROR:", err);
    return next(); // fail open — see isDesktopOnly
  }
}

module.exports = {
  DEVICE_NOT_ALLOWED_CODE,
  DEVICE_NOT_ALLOWED_MESSAGE,
  classifyDevice,
  checkDesktopOnly,
  enforceDesktopOnly,
  sendBlocked,
  invalidateDesktopOnlyCache,
  invalidateDeviceAccessCache,
  deviceKeyFor,
  // shared with utils/sebRestriction.js (same Device Locks list / allow-list)
  isDeviceAllowed, recordRejection, resolveStudentId,
};
