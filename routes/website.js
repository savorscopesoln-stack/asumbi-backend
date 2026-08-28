const express = require("express");
const router = express.Router();
const { protect, requirePage } = require("../middleware/authMiddleware");
const { runWebsiteImageUpload, websiteImageUrlFor, deleteWebsiteImageByUrl } = require("../middleware/websitePhotoUpload");

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

      await pool.request()
        .input("sectionKey", sql.NVarChar, section)
        .input("contentJson", sql.NVarChar(sql.MAX), JSON.stringify(content))
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

      res.json({ message: "Saved", section_key: section });
    } catch (err) {
      console.log("WEBSITE SAVE SECTION ERROR:", err);
      res.status(500).json({ message: "Failed to save section" });
    }
  });

  return router;
};
