/* =========================================================================
   LMS USAGE METER (L1.5): storage (MB, file count) and active learners.
   Storage = size of uploads/<tenant>/lms on the persistent disk (bounded walk,
   cached 60 s per tenant). Active learners = distinct students with LMS
   activity in the last 30 days; null until lms_activity_events exists (L4).
   checkQuota() is what upload endpoints will call before accepting a file.
========================================================================= */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const sql = require("mssql");
const { UPLOADS_ROOT, safeTenant } = require("./uploadPaths");

const CACHE_MS = 60 * 1000;
const MAX_ENTRIES = 200000; // bound the walk so a huge folder can never stall the server
const cache = new Map();

async function measureFolder(dir) {
  let bytes = 0, files = 0, seen = 0, truncated = false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) { truncated = true; stack.length = 0; break; }
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the folder
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { bytes += (await fsp.stat(full)).size; files++; } catch { /* file vanished */ } }
    }
  }
  return { bytes, files, truncated };
}

async function getStorage(tenant, { root = UPLOADS_ROOT, now = Date.now() } = {}) {
  const t = safeTenant(tenant);
  const hit = cache.get(t);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  // `lms` = course media (public URLs); `lms-private` = student submissions (served only through an authenticated route, L5.2b). Both count against the quota.
  const [pub, priv] = await Promise.all([measureFolder(path.join(root, t, "lms")), measureFolder(path.join(root, t, "lms-private"))]);
  const m = { bytes: pub.bytes + priv.bytes, files: pub.files + priv.files, truncated: pub.truncated || priv.truncated };
  const value = { storageMb: Math.round((m.bytes / 1048576) * 100) / 100, bytes: m.bytes, fileCount: m.files, truncated: m.truncated };
  cache.set(t, { at: now, value });
  return value;
}
const invalidateStorage = (tenant) => { if (tenant) cache.delete(safeTenant(tenant)); else cache.clear(); };

async function getActiveLearners(pool, days = 30) {
  try {
    const r = await pool.request().input("d", sql.Int, days).query(
      `IF OBJECT_ID('lms_activity_events','U') IS NULL SELECT CAST(NULL AS INT) AS n
       ELSE SELECT COUNT(DISTINCT student_id) AS n FROM lms_activity_events WHERE created_at >= DATEADD(day, -@d, SYSUTCDATETIME())`);
    const n = r.recordset?.[0]?.n;
    return n == null ? null : Number(n);
  } catch (err) { console.error("LMS ACTIVE LEARNERS ERROR:", err.message); return null; }
}

async function getUsage(pool, tenant, quotaMb, opts) {
  const storage = await getStorage(tenant, opts);
  return {
    storageMb: storage.storageMb, fileCount: storage.fileCount, storageTruncated: storage.truncated,
    storageQuotaMb: quotaMb ?? null,
    storagePercent: quotaMb ? Math.min(100, Math.round((storage.storageMb / quotaMb) * 1000) / 10) : null,
    activeLearners30d: await getActiveLearners(pool),
  };
}

/* Fresh (uncached) check used before accepting an upload of `incomingBytes`. */
async function checkQuota(tenant, quotaMb, incomingBytes, opts = {}) {
  invalidateStorage(tenant);
  const s = await getStorage(tenant, opts);
  const incomingMb = Math.max(0, Number(incomingBytes) || 0) / 1048576;
  const ok = !!quotaMb && s.storageMb + incomingMb <= quotaMb;
  return { ok, usedMb: s.storageMb, quotaMb: quotaMb ?? null, code: ok ? null : "LMS_STORAGE_QUOTA_EXCEEDED" };
}

module.exports = { measureFolder, getStorage, invalidateStorage, getActiveLearners, getUsage, checkQuota };
