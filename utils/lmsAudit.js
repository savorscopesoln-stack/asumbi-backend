/* =========================================================================
   LMS AUDIT HELPER  (L1.5, master prompt rules 7 + 11)
   One place that writes lms_audit_log. Details are sanitised so the log never
   stores secrets or contact details, and size-capped. A failed audit write is
   logged to the server console but never breaks the action being audited.
   Convention: action = "<area>.<verb>" (settings.update, permissions.set,
   course.publish, grade.override ...); entity = table/concept; entityId = id.
========================================================================= */
const sql = require("mssql");

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|email|phone|msisdn|address|national|idnumber/i;
const MAX_DETAILS_CHARS = 4000;
const MAX_DEPTH = 4;

/* Pure: removes sensitive keys (any depth), trims long strings, caps total size. */
function sanitizeDetails(details, depth = 0) {
  if (details == null) return null;
  if (typeof details === "string") return details.length > 300 ? details.slice(0, 300) + "…" : details;
  if (typeof details !== "object") return details;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(details)) return details.slice(0, 50).map((v) => sanitizeDetails(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = "[redacted]"; continue; }
    out[k] = sanitizeDetails(v, depth + 1);
  }
  return out;
}

function serializeDetails(details) {
  let txt = JSON.stringify(sanitizeDetails(details) ?? {});
  if (txt.length > MAX_DETAILS_CHARS) txt = JSON.stringify({ truncated: true, preview: txt.slice(0, MAX_DETAILS_CHARS - 60) });
  return txt;
}

/* Never throws. Returns true when written. */
async function audit(pool, actor, action, entity = null, entityId = null, details = null) {
  if (!action || typeof action !== "string") return false;
  try {
    await pool.request()
      .input("a", sql.Int, Number.isInteger(actor?.id) ? actor.id : null)
      .input("r", sql.NVarChar(30), actor?.role ? String(actor.role).slice(0, 30) : null)
      .input("act", sql.NVarChar(100), action.slice(0, 100))
      .input("e", sql.NVarChar(60), entity ? String(entity).slice(0, 60) : null)
      .input("eid", sql.NVarChar(60), entityId == null ? null : String(entityId).slice(0, 60))
      .input("d", sql.NVarChar(sql.MAX), serializeDetails(details))
      .query(`INSERT INTO lms_audit_log (actor_id, actor_role, action, entity, entity_id, details) VALUES (@a, @r, @act, @e, @eid, @d)`);
    return true;
  } catch (err) {
    console.error("LMS AUDIT WRITE ERROR:", err.message);
    return false;
  }
}

/* Keyset-paginated read (newest first). limit is clamped 1-100; beforeId pages backwards. */
async function listAudit(pool, { entity, entityId, action, limit = 50, beforeId } = {}) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const before = Number.isInteger(Number(beforeId)) && Number(beforeId) > 0 ? Number(beforeId) : null;
  const r = pool.request().input("lim", sql.Int, lim);
  const where = [];
  if (entity) { r.input("e", sql.NVarChar(60), String(entity).slice(0, 60)); where.push("entity = @e"); }
  if (entityId != null && entityId !== "") { r.input("eid", sql.NVarChar(60), String(entityId).slice(0, 60)); where.push("entity_id = @eid"); }
  if (action) { r.input("act", sql.NVarChar(100), String(action).slice(0, 100)); where.push("action = @act"); }
  if (before) { r.input("b", sql.BigInt, before); where.push("id < @b"); }
  const res = await r.query(`SELECT TOP (@lim) id, actor_id, actor_role, action, entity, entity_id, details, created_at FROM lms_audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`);
  const rows = res.recordset || [];
  return { rows, nextBeforeId: rows.length === lim ? rows[rows.length - 1].id : null };
}

module.exports = { audit, listAudit, sanitizeDetails, serializeDetails };
