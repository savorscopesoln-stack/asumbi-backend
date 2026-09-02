const express = require("express");
const router = express.Router();
const { protect, requirePage } = require("../middleware/authMiddleware");
const { runWebsiteImageUpload, websiteImageUrlFor, deleteWebsiteImageByUrl } = require("../middleware/websitePhotoUpload");
const { runWebsiteFileUpload, websiteFileUrlFor, deleteWebsiteFileByUrl } = require("../middleware/websiteFileUpload");
const { runWebsiteVideoUpload, websiteVideoUrlFor, deleteWebsiteVideoByUrl } = require("../middleware/websiteVideoUpload");

/* =========================================================
   WEBSITE CONTENT
   Backs the public marketing site (the separate Next.js
   "asumbi-website" project) so every piece of its copy AND
   its images can be edited from this admin portal's Website
   page instead of requiring a code change + redeploy.

   Storage: one row per section in website_content
   (section_key UNIQUE, content_json NVARCHAR(MAX)) — see
   utils/ensureSchema.js for table creation + default seed,
   which mirrors exactly what's hardcoded in the site's source
   today, so nothing changes on the live site until an admin
   actually edits something.

   Read side is PUBLIC (no auth): the Next.js site fetches
   GET /api/website at build/request time and has no user
   session to send. Write side (including image upload) is
   admin-portal-only, gated by the "Website" page permission
   like any other grantable page.

   NOT covered here (intentionally): site navigation structure
   (which pages exist, the header/footer menu links, routing).
   That's site architecture, not content — editing it wrong
   breaks links across the whole site, so it stays a code change.
========================================================= */

// Sections a caller is allowed to read/write. Keeps the JSON blob
// column from silently accepting an arbitrary key typo'd from the
// frontend and never being seen again.
const VALID_SECTIONS = [
  "announcements",
  "hero",
  "principal",
  "stats",
  "milestones",
  "news",
  "testimonials",
  "faqs",
  "accreditations",
  "departments",
  "academicsIntro",
  "quickLinks",
  "whyUs",
  "gallery",
  "partners",
  "visit",
  "finalCta",
  "siteMeta",
  "aboutIntro",
  "coreValues",
  "admissionSteps",
  "admissionRequirements",
  "programmes",
  "pageHeroes",
  "events",
  "admissionsExternal",
  "downloads",
  "leadership",
  "staff",
  "theme",
];

module.exports = (poolPromise, sql) => {
  const getActorDisplayName = async (pool, user) => {
    try {
      if (!user || !user.id) return "Unknown";
      const r = await pool.request().input("id", sql.Int, user.id).query(`SELECT name, username FROM Users WHERE id=@id`);
      const row = r.recordset[0];
      if (!row) return user.username || `User ${user.id}`;
      return row.name || row.username || user.username || `User ${user.id}`;
    } catch (err) {
      console.log("GET ACTOR NAME ERROR:", err.message);
      return user?.username || "Unknown";
    }
  };

  /* ================= GET ALL SECTIONS (public) =================
     Consumed by the public website's server-side fetch. Returns
     everything as { section_key: <parsed content>, ... } so the
     site can destructure exactly the sections it needs. No auth —
     this is public marketing copy, same as if it were compiled
     into the site directly. */
  router.get("/", async (req, res) => {
    try {
      const pool = await poolPromise;
      const result = await pool.request().query(`SELECT section_key, content_json, updated_at FROM website_content`);

      const bySection = {};
      for (const row of result.recordset || []) {
        try {
          bySection[row.section_key] = JSON.parse(row.content_json);
        } catch {
          // Skip a row that somehow holds invalid JSON rather than
          // failing the whole response — the site falls back to its
          // own bundled defaults for that one section.
        }
      }
      res.json(bySection);
    } catch (err) {
      console.log("WEBSITE GET ALL ERROR:", err);
      // Empty object, not a 500 — the public site treats a missing
      // section as "use my bundled default" and should never break
      // just because this admin feature or the DB briefly hiccups.
      res.json({});
    }
  });

  /* ================= IMAGE UPLOAD (admin) =================
     Used by every "image" field in the admin's Website page (hero
     background, principal photo, news thumbnails, gallery photos,
     testimonial photos, site logo, campus map). Returns a relative
     URL that gets stored directly in that section's content_json;
     the public website prefixes it with the backend's origin when
     rendering <img>, since the two are separate deployments. */
  router.post("/upload", protect, requirePage("Website"), async (req, res) => {
    try {
      await runWebsiteImageUpload(req, res);
      if (!req.file) return res.status(400).json({ message: "No image file received" });

      const url = websiteImageUrlFor(req.file.filename);
      res.json({ url });
    } catch (err) {
      console.log("WEBSITE IMAGE UPLOAD ERROR:", err.message);
      res.status(400).json({ message: err.message || "Upload failed" });
    }
  });

  /* ================= DELETE AN UPLOADED IMAGE (admin) =================
     Best-effort cleanup, called by the admin page when a field's image
     is removed/replaced. Not load-bearing (an orphaned file on disk is
     harmless), so failures are swallowed rather than surfaced. */
  router.post("/delete-image", protect, requirePage("Website"), async (req, res) => {
    const { url } = req.body || {};
    deleteWebsiteImageByUrl(url);
    res.json({ message: "OK" });
  });

  /* ================= FILE UPLOAD (admin) =================
     Used by the "file" field type in the admin's Downloads section
     (prospectuses, handbooks, forms, policies — PDF/Word/Excel).
     Same pattern as image upload, separate directory/MIME allowlist. */
  router.post("/upload-file", protect, requirePage("Website"), async (req, res) => {
    try {
      await runWebsiteFileUpload(req, res);
      if (!req.file) return res.status(400).json({ message: "No file received" });

      const url = websiteFileUrlFor(req.file.filename);
      res.json({ url, originalName: req.file.originalname, size: req.file.size });
    } catch (err) {
      console.log("WEBSITE FILE UPLOAD ERROR:", err.message);
      res.status(400).json({ message: err.message || "Upload failed" });
    }
  });

  /* ================= DELETE AN UPLOADED FILE (admin) ================= */
  router.post("/delete-file", protect, requirePage("Website"), async (req, res) => {
    const { url } = req.body || {};
    deleteWebsiteFileByUrl(url);
    res.json({ message: "OK" });
  });

  /* ================= VIDEO UPLOAD (admin) =================
     Used by the "video" field type — currently the Gallery section's
     "Watch tour" tiles, which used to be a bare checkbox with no
     actual clip behind it. Same pattern as image upload: returns a
     relative URL stored directly in that section's content_json,
     which the public website prefixes with the backend's origin when
     rendering <video>. */
  router.post("/upload-video", protect, requirePage("Website"), async (req, res) => {
    try {
      await runWebsiteVideoUpload(req, res);
      if (!req.file) return res.status(400).json({ message: "No video file received" });

      const url = websiteVideoUrlFor(req.file.filename);
      res.json({ url, originalName: req.file.originalname, size: req.file.size });
    } catch (err) {
      console.log("WEBSITE VIDEO UPLOAD ERROR:", err.message);
      res.status(400).json({ message: err.message || "Upload failed" });
    }
  });

  /* ================= DELETE AN UPLOADED VIDEO (admin) ================= */
  router.post("/delete-video", protect, requirePage("Website"), async (req, res) => {
    const { url } = req.body || {};
    deleteWebsiteVideoByUrl(url);
    res.json({ message: "OK" });
  });

  /* ================= GET ONE SECTION (admin — populates the edit form) ================= */
  router.get("/:section", protect, requirePage("Website"), async (req, res) => {
    try {
      const section = String(req.params.section || "");
      if (!VALID_SECTIONS.includes(section)) {
        return res.status(400).json({ message: "Unknown section" });
      }

      const pool = await poolPromise;
      const result = await pool.request()
        .input("sectionKey", sql.NVarChar, section)
        .query(`SELECT section_key, content_json, updated_by_name, updated_at FROM website_content WHERE section_key=@sectionKey`);

      const row = result.recordset[0];
      if (!row) return res.json({ section_key: section, content: null, updated_by_name: null, updated_at: null });

      let content = null;
      try {
        content = JSON.parse(row.content_json);
      } catch {
        content = null;
      }

      res.json({ section_key: section, content, updated_by_name: row.updated_by_name, updated_at: row.updated_at });
    } catch (err) {
      console.log("WEBSITE GET SECTION ERROR:", err);
      res.status(500).json({ message: "Failed to load section" });
    }
  });

  /* ================= SAVE ONE SECTION (admin) =================
     Whole-section replace — the admin page sends the full edited
     array/object for that section each time, same pattern as every
     other list editor in this app (simpler and less error-prone
     than diffing individual array items server-side). */
  router.put("/:section", protect, requirePage("Website"), async (req, res) => {
    try {
      const section = String(req.params.section || "");
      if (!VALID_SECTIONS.includes(section)) {
        return res.status(400).json({ message: "Unknown section" });
      }

      const { content } = req.body;
      if (content === undefined) {
        return res.status(400).json({ message: "content is required" });
      }

      const pool = await poolPromise;
      const actorName = await getActorDisplayName(pool, req.user);
      const contentJson = JSON.stringify(content);

      await pool.request()
        .input("sectionKey", sql.NVarChar, section)
        .input("contentJson", sql.NVarChar(sql.MAX), contentJson)
        .input("updatedById", sql.Int, req.user.id)
        .input("updatedByName", sql.NVarChar, actorName)
        .query(`
          MERGE website_content AS target
          USING (SELECT @sectionKey AS section_key) AS src
          ON target.section_key = src.section_key
          WHEN MATCHED THEN
            UPDATE SET content_json=@contentJson, updated_by_id=@updatedById, updated_by_name=@updatedByName, updated_at=GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (section_key, content_json, updated_by_id, updated_by_name, updated_at)
            VALUES (@sectionKey, @contentJson, @updatedById, @updatedByName, GETDATE());
        `);

      // Version history / audit trail — append-only snapshot of this
      // save. Best-effort: a failure here must never block the actual
      // content save above, which is why it's in its own try/catch
      // rather than sharing the outer one.
      try {
        await pool.request()
          .input("sectionKey", sql.NVarChar, section)
          .input("contentJson", sql.NVarChar(sql.MAX), contentJson)
          .input("updatedById", sql.Int, req.user.id)
          .input("updatedByName", sql.NVarChar, actorName)
          .query(`
            INSERT INTO website_content_history (section_key, content_json, updated_by_id, updated_by_name, updated_at)
            VALUES (@sectionKey, @contentJson, @updatedById, @updatedByName, GETDATE())
          `);

        // Keep at most the 20 most recent versions per section so the
        // table doesn't grow unbounded — an editable CMS field gets
        // saved a lot over a site's lifetime.
        await pool.request()
          .input("sectionKey", sql.NVarChar, section)
          .query(`
            DELETE FROM website_content_history
            WHERE section_key=@sectionKey
              AND id NOT IN (
                SELECT TOP 20 id FROM website_content_history
                WHERE section_key=@sectionKey
                ORDER BY updated_at DESC
              )
          `);
      } catch (histErr) {
        console.log("WEBSITE CONTENT HISTORY WRITE ERROR:", histErr.message);
      }

      res.json({ message: "Saved", section_key: section });
    } catch (err) {
      console.log("WEBSITE SAVE SECTION ERROR:", err);
      res.status(500).json({ message: "Failed to save section" });
    }
  });

  /* ================= VERSION HISTORY (admin) =================
     Returns up to the 20 most recent saved snapshots for a section,
     newest first — who changed it and when (master instructions
     §50, audit log), and enough to restore an earlier version (§49,
     content versioning). Snapshot content itself is included so the
     admin page can show a preview/diff without a second round trip. */
  router.get("/:section/history", protect, requirePage("Website"), async (req, res) => {
    try {
      const section = String(req.params.section || "");
      if (!VALID_SECTIONS.includes(section)) {
        return res.status(400).json({ message: "Unknown section" });
      }

      const pool = await poolPromise;
      const result = await pool.request()
        .input("sectionKey", sql.NVarChar, section)
        .query(`
          SELECT TOP 20 id, content_json, updated_by_name, updated_at
          FROM website_content_history
          WHERE section_key=@sectionKey
          ORDER BY updated_at DESC
        `);

      const versions = (result.recordset || []).map((row) => {
        let content = null;
        try { content = JSON.parse(row.content_json); } catch { content = null; }
        return { id: row.id, content, updated_by_name: row.updated_by_name, updated_at: row.updated_at };
      });

      res.json({ section_key: section, versions });
    } catch (err) {
      console.log("WEBSITE HISTORY GET ERROR:", err);
      res.status(500).json({ message: "Failed to load history" });
    }
  });

  /* ================= RESTORE A VERSION (admin) =================
     Re-saves an earlier snapshot as the current content — implemented
     as a normal save (through the same MERGE + history-append as
     PUT /:section above) rather than a special-cased update, so a
     restore is itself just another entry in the history, and can in
     turn be undone the same way. */
  router.post("/:section/restore/:historyId", protect, requirePage("Website"), async (req, res) => {
    try {
      const section = String(req.params.section || "");
      const historyId = parseInt(req.params.historyId, 10);
      if (!VALID_SECTIONS.includes(section)) {
        return res.status(400).json({ message: "Unknown section" });
      }
      if (!Number.isInteger(historyId)) {
        return res.status(400).json({ message: "Invalid history id" });
      }

      const pool = await poolPromise;
      const found = await pool.request()
        .input("id", sql.Int, historyId)
        .input("sectionKey", sql.NVarChar, section)
        .query(`SELECT content_json FROM website_content_history WHERE id=@id AND section_key=@sectionKey`);

      const row = found.recordset[0];
      if (!row) return res.status(404).json({ message: "Version not found" });

      let content;
      try { content = JSON.parse(row.content_json); } catch { return res.status(500).json({ message: "Stored version is corrupt" }); }

      const actorName = await getActorDisplayName(pool, req.user);
      const contentJson = JSON.stringify(content);

      await pool.request()
        .input("sectionKey", sql.NVarChar, section)
        .input("contentJson", sql.NVarChar(sql.MAX), contentJson)
        .input("updatedById", sql.Int, req.user.id)
        .input("updatedByName", sql.NVarChar, actorName)
        .query(`
          MERGE website_content AS target
          USING (SELECT @sectionKey AS section_key) AS src
          ON target.section_key = src.section_key
          WHEN MATCHED THEN
            UPDATE SET content_json=@contentJson, updated_by_id=@updatedById, updated_by_name=@updatedByName, updated_at=GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (section_key, content_json, updated_by_id, updated_by_name, updated_at)
            VALUES (@sectionKey, @contentJson, @updatedById, @updatedByName, GETDATE());
        `);

      try {
        await pool.request()
          .input("sectionKey", sql.NVarChar, section)
          .input("contentJson", sql.NVarChar(sql.MAX), contentJson)
          .input("updatedById", sql.Int, req.user.id)
          .input("updatedByName", sql.NVarChar, `${actorName} (restored)`)
          .query(`
            INSERT INTO website_content_history (section_key, content_json, updated_by_id, updated_by_name, updated_at)
            VALUES (@sectionKey, @contentJson, @updatedById, @updatedByName, GETDATE())
          `);
      } catch (histErr) {
        console.log("WEBSITE CONTENT HISTORY WRITE ERROR:", histErr.message);
      }

      res.json({ message: "Restored", section_key: section, content });
    } catch (err) {
      console.log("WEBSITE RESTORE ERROR:", err);
      res.status(500).json({ message: "Failed to restore version" });
    }
  });

  return router;
};
