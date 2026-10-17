/* =========================================================================
   Move legacy shared uploads (uploads/<kind>/<file>) into per-school folders
   (uploads/<school>/<kind>/<file>) and rewrite the URLs stored in each
   school's database.

     node scripts/migrateUploadsToTenantFolders.js            # dry run (default)
     node scripts/migrateUploadsToTenantFolders.js --apply    # copy + rewrite
     node scripts/migrateUploadsToTenantFolders.js --apply --purge-legacy
        # also delete the old shared copies (run only after EVERY school
        # has been migrated, and after a backup)

   A file referenced by several schools is copied into each one's folder.
   Each school only ever gets the files ITS OWN database references.
========================================================================= */
const fs = require("fs");
const path = require("path");
const { sql, getPool, listTenantKeys } = require("../config/db");
const { UPLOADS_ROOT, safeTenant } = require("../utils/uploadPaths");

const APPLY = process.argv.includes("--apply");
const PURGE = process.argv.includes("--purge-legacy");
const KINDS = ["photos", "website", "website-files", "website-videos", "cover-pages", "question-images", "violation-photos"];
const URL_RE = new RegExp(`/uploads/(${KINDS.join("|")})/([^\\s"'<>\\\\)?#]+)`, "g");
const TEXT_TYPES = ["char", "varchar", "nchar", "nvarchar", "text", "ntext"];

(async () => {
  const referencedLegacy = new Set();
  const summary = [];
  for (const tenantKey of listTenantKeys()) {
    const tenant = safeTenant(tenantKey);
    const pool = await getPool(tenantKey);
    const cols = (await pool.request().query(`
      SELECT c.TABLE_NAME t, c.COLUMN_NAME c, c.DATA_TYPE d
      FROM INFORMATION_SCHEMA.COLUMNS c
      JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
      WHERE c.DATA_TYPE IN (${TEXT_TYPES.map((x) => `'${x}'`).join(",")})`)).recordset;

    const found = new Map(); // legacy url -> [{t,c,d}]
    for (const { t, c, d } of cols) {
      let rows;
      try {
        rows = (await pool.request().query(
          `SELECT CAST([${c}] AS NVARCHAR(MAX)) v FROM [${t}] WHERE CHARINDEX('/uploads/', CAST([${c}] AS NVARCHAR(MAX))) > 0`)).recordset;
      } catch { continue; }
      for (const r of rows) {
        for (const m of String(r.v || "").matchAll(URL_RE)) {
          const url = m[0];
          if (!found.has(url)) found.set(url, []);
          if (!found.get(url).some((x) => x.t === t && x.c === c)) found.get(url).push({ t, c, d });
        }
      }
    }

    let copied = 0, missing = 0, rewritten = 0, failed = 0;
    for (const [url, places] of found) {
      const [, kind, file] = url.match(/^\/uploads\/([^/]+)\/(.+)$/);
      const src = path.join(UPLOADS_ROOT, kind, file);
      const dstDir = path.join(UPLOADS_ROOT, tenant, kind);
      const dst = path.join(dstDir, file);
      const newUrl = `/uploads/${tenant}/${kind}/${file}`;
      referencedLegacy.add(src);
      if (!fs.existsSync(src)) { missing++; console.log(`[${tenant}] missing file for ${url}`); continue; }
      if (!APPLY) { copied++; continue; }
      fs.mkdirSync(dstDir, { recursive: true });
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      copied++;
      for (const { t, c } of places) {
        try {
          await pool.request().input("o", sql.NVarChar(sql.MAX), url).input("n", sql.NVarChar(sql.MAX), newUrl).query(
            `UPDATE [${t}] SET [${c}] = REPLACE(CAST([${c}] AS NVARCHAR(MAX)), @o, @n) WHERE CHARINDEX(@o, CAST([${c}] AS NVARCHAR(MAX))) > 0`);
          rewritten++;
        } catch (err) { failed++; console.log(`[${tenant}] could not rewrite ${t}.${c}: ${err.message}`); }
      }
    }
    summary.push({ tenant, files: found.size, [APPLY ? "copied" : "wouldCopy"]: copied, missing, rewritten, failed });
  }
  console.table(summary);
  if (APPLY && PURGE) {
    let n = 0;
    for (const f of referencedLegacy) if (fs.existsSync(f)) { fs.unlinkSync(f); n++; }
    console.log(`Deleted ${n} legacy shared files.`);
  }
  if (!APPLY) console.log("Dry run only. Re-run with --apply to copy files and rewrite URLs.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
