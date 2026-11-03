/* =========================================================================
   LMS SETTINGS  (L1.4)  — per-tenant configuration, never hard-coded (rule 10)

   Stored as one row per top-level key in lms_settings (setting_key, value_json).
   Effective settings = DEFAULTS overlaid with stored rows. Validation is pure
   and strict: unknown keys are rejected, values are clamped/typed, and file
   extensions that can run script in a browser are refused outright (uploads
   are served from a public static folder, see decision D-004).
   Later phases add keys here (certificates, guardian visibility, offline, ...).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const events = require("./lmsEvents");

const DEFAULTS = Object.freeze({
  terminology: { course: "Course", section: "Section", lesson: "Lesson", assignment: "Assignment", quiz: "Quiz", student: "Student", teacher: "Teacher" },
  gradingSystemId: null, // reference to legacy GradingSystem.id (no FK, decision D-005)
  lateSubmission: "accept", // accept | penalise | block
  latePenaltyPercent: 10,
  files: { allowedExtensions: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "jpg", "jpeg", "png", "mp3", "mp4"], maxFileMb: 10 },
  storageQuotaMb: 1024,
  enrolment: { defaultMode: "closed" }, // open | approval | closed
  courseApprovalRequired: false,
  notifications: { inApp: true }, // in-app notices for announcements and enrolment decisions (L4.4b)
  analytics: { inactiveDays: 14, lowQuizPercent: 50, lateSharePercent: 50 }, // teacher attention prompts (L9.1a, D-105): thresholds, never verdicts
  competency: { minEvidence: 2, developingFrom: 40, secureFrom: 70 }, // outcome mastery bands (L9.4, D-110 / D-111): evidence needed, and the percent where `developing` and `secure` start
  offline: { retentionDays: 90 }, // how long finished/unfinished offline sync receipts are kept before the admin purge may delete them (L10 retention, D-119, A165)
});

const TERM_KEYS = Object.keys(DEFAULTS.terminology);
const LATE_MODES = ["accept", "penalise", "block"];
const ENROL_MODES = ["open", "approval", "closed"];
/* Anything a browser or server could execute. Refused regardless of what an admin types. */
const FORBIDDEN_EXT = new Set(["html", "htm", "xhtml", "svg", "js", "mjs", "php", "exe", "bat", "cmd", "com", "sh", "jar", "msi", "dll", "ps1", "vbs", "scr", "swf", "xml"]);
const MAX_FILE_MB = 200, MAX_QUOTA_MB = 1024 * 1024;

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const cleanLabel = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
const intIn = (v, min, max) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/* Pure. Returns { ok, errors: [..], value: {key: normalisedPartial} } for a PATCH body. */
function validateSettingsPatch(patch) {
  const errors = [], value = {};
  if (!isPlainObject(patch)) return { ok: false, errors: ["Body must be an object of settings."], value };
  for (const [key, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) { errors.push(`Unknown setting "${key}".`); continue; }
    switch (key) {
      case "terminology": {
        if (!isPlainObject(v)) { errors.push("terminology must be an object."); break; }
        const out = {};
        for (const [k, label] of Object.entries(v)) {
          if (!TERM_KEYS.includes(k)) { errors.push(`Unknown terminology label "${k}".`); continue; }
          const c = cleanLabel(label);
          if (c.length < 1 || c.length > 40) errors.push(`Label "${k}" must be 1-40 characters.`); else out[k] = c;
        }
        value.terminology = out; break;
      }
      case "gradingSystemId": {
        if (v === null) { value.gradingSystemId = null; break; }
        const n = intIn(v, 1, 2147483647); if (n === null) errors.push("gradingSystemId must be a positive integer or null."); else value.gradingSystemId = n; break;
      }
      case "lateSubmission": if (!LATE_MODES.includes(v)) errors.push(`lateSubmission must be one of ${LATE_MODES.join(", ")}.`); else value.lateSubmission = v; break;
      case "latePenaltyPercent": { const n = intIn(v, 0, 100); if (n === null) errors.push("latePenaltyPercent must be a whole number 0-100."); else value.latePenaltyPercent = n; break; }
      case "files": {
        if (!isPlainObject(v)) { errors.push("files must be an object."); break; }
        const out = {};
        for (const [k, x] of Object.entries(v)) {
          if (k === "maxFileMb") { const n = intIn(x, 1, MAX_FILE_MB); if (n === null) errors.push(`files.maxFileMb must be a whole number 1-${MAX_FILE_MB}.`); else out.maxFileMb = n; }
          else if (k === "allowedExtensions") {
            if (!Array.isArray(x) || x.length < 1 || x.length > 50) { errors.push("files.allowedExtensions must be a list of 1-50 extensions."); continue; }
            const exts = [...new Set(x.map((e) => String(e).toLowerCase().replace(/^\./, "").trim()))];
            const bad = exts.filter((e) => !/^[a-z0-9]{1,8}$/.test(e));
            const banned = exts.filter((e) => FORBIDDEN_EXT.has(e));
            if (bad.length) errors.push(`Invalid extension(s): ${bad.join(", ")}.`);
            else if (banned.length) errors.push(`Not allowed for safety: ${banned.join(", ")}.`);
            else out.allowedExtensions = exts;
          } else errors.push(`Unknown files setting "${k}".`);
        }
        value.files = out; break;
      }
      case "storageQuotaMb": { const n = intIn(v, 1, MAX_QUOTA_MB); if (n === null) errors.push(`storageQuotaMb must be a whole number 1-${MAX_QUOTA_MB}.`); else value.storageQuotaMb = n; break; }
      case "enrolment": {
        if (!isPlainObject(v)) { errors.push("enrolment must be an object."); break; }
        const out = {};
        for (const [k, x] of Object.entries(v)) {
          if (k === "defaultMode") { if (!ENROL_MODES.includes(x)) errors.push(`enrolment.defaultMode must be one of ${ENROL_MODES.join(", ")}.`); else out.defaultMode = x; }
          else errors.push(`Unknown enrolment setting "${k}".`);
        }
        value.enrolment = out; break;
      }
      case "notifications": {
        if (!isPlainObject(v)) { errors.push("notifications must be an object."); break; }
        const out = {};
        for (const [k, x] of Object.entries(v)) {
          if (k === "inApp") { if (typeof x !== "boolean") errors.push("notifications.inApp must be true or false."); else out.inApp = x; }
          else errors.push(`Unknown notifications setting "${k}".`);
        }
        value.notifications = out; break;
      }
      case "analytics": {
        if (!isPlainObject(v)) { errors.push("analytics must be an object."); break; }
        const out = {}, RANGE = { inactiveDays: [1, 365], lowQuizPercent: [1, 100], lateSharePercent: [1, 100] };
        for (const [k, x] of Object.entries(v)) {
          if (!RANGE[k]) { errors.push(`Unknown analytics setting "${k}".`); continue; }
          const n = intIn(x, RANGE[k][0], RANGE[k][1]); if (n === null) errors.push(`analytics.${k} must be a whole number ${RANGE[k][0]}-${RANGE[k][1]}.`); else out[k] = n;
        }
        value.analytics = out; break;
      }
      case "competency": {
        if (!isPlainObject(v)) { errors.push("competency must be an object."); break; }
        const out = {}, RANGE = { minEvidence: [1, 10], developingFrom: [1, 99], secureFrom: [2, 100] };
        for (const [k, x] of Object.entries(v)) {
          if (!RANGE[k]) { errors.push(`Unknown competency setting "${k}".`); continue; }
          const n = intIn(x, RANGE[k][0], RANGE[k][1]); if (n === null) errors.push(`competency.${k} must be a whole number ${RANGE[k][0]}-${RANGE[k][1]}.`); else out[k] = n;
        }
        if (out.developingFrom !== undefined && out.secureFrom !== undefined && out.developingFrom >= out.secureFrom) errors.push("competency.developingFrom must be lower than competency.secureFrom.");
        value.competency = out; break;
      }
      case "offline": {
        if (!isPlainObject(v)) { errors.push("offline must be an object."); break; }
        const out = {}, RANGE = { retentionDays: [31, 3650] }; // never below 31: a receipt must outlive the 30-day STALE_ACTION window so a replay can still be recognised
        for (const [k, x] of Object.entries(v)) {
          if (!RANGE[k]) { errors.push(`Unknown offline setting "${k}".`); continue; }
          const n = intIn(x, RANGE[k][0], RANGE[k][1]); if (n === null) errors.push(`offline.${k} must be a whole number ${RANGE[k][0]}-${RANGE[k][1]}.`); else out[k] = n;
        }
        value.offline = out; break;
      }
      case "courseApprovalRequired": if (typeof v !== "boolean") errors.push("courseApprovalRequired must be true or false."); else value.courseApprovalRequired = v; break;
      default: break;
    }
  }
  return { ok: errors.length === 0, errors, value };
}

const safeParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

/* Pure: overlay stored rows on DEFAULTS. Bad stored JSON is ignored (defaults win). */
function mergeSettings(rows = []) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.setting_key)) continue;
    const v = safeParse(r.value_json);
    if (v === undefined) continue;
    out[r.setting_key] = isPlainObject(DEFAULTS[r.setting_key]) && isPlainObject(v) ? { ...DEFAULTS[r.setting_key], ...v } : v;
  }
  return out;
}

async function getSettings(pool) {
  try {
    const r = await pool.request().query(`SELECT setting_key, value_json FROM lms_settings`);
    return mergeSettings(r.recordset);
  } catch (err) {
    console.error("LMS SETTINGS READ ERROR (using defaults):", err.message);
    return mergeSettings([]);
  }
}

/* What every signed-in user of a licensed tenant may see (labels + upload limits). */
const publicView = (s) => ({ terminology: s.terminology, lateSubmission: s.lateSubmission, files: s.files, enrolment: s.enrolment });

async function upsert(pool, key, valueObj, actorId) {
  await pool.request()
    .input("k", sql.NVarChar(100), key)
    .input("v", sql.NVarChar(sql.MAX), JSON.stringify(valueObj))
    .input("by", sql.Int, actorId || null)
    .query(`UPDATE lms_settings SET value_json = @v, updated_by = @by, updated_at = SYSUTCDATETIME() WHERE setting_key = @k;
            IF @@ROWCOUNT = 0 INSERT INTO lms_settings (setting_key, value_json, updated_by) VALUES (@k, @v, @by);`);
}

/* Validates, merges nested objects with what is stored, saves, audits. Returns { ok, errors?, settings? }. */
async function saveSettings(pool, actor, patch, tenant = null) {
  const v = validateSettingsPatch(patch);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (Object.keys(v.value).length === 0) return { ok: false, errors: ["No settings supplied."] };
  const current = await getSettings(pool);
  const changed = [];
  for (const [key, val] of Object.entries(v.value)) {
    const next = isPlainObject(DEFAULTS[key]) ? { ...current[key], ...val } : val;
    await upsert(pool, key, next, actor?.id);
    changed.push(key);
  }
  await audit(pool, actor, "settings.update", "lms_settings", null, { keys: changed });
  if (tenant) events.emit("lms.settings.updated", { tenant, keys: changed });
  return { ok: true, settings: await getSettings(pool) };
}

module.exports = { DEFAULTS, FORBIDDEN_EXT, validateSettingsPatch, mergeSettings, getSettings, publicView, saveSettings };
