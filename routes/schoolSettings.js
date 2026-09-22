const express = require("express");
const router = express.Router();
const { protect, requirePage } = require("../middleware/authMiddleware");
const { runWebsiteImageUpload, websiteImageUrlFor, deleteWebsiteImageByUrl } = require("../middleware/websitePhotoUpload");

/* =========================================================
   SCHOOL SETTINGS
   Doravo Core (the software) isn't tied to any one school —
   every school-specific fact that used to be typed straight
   into a result slip, certificate, or the login screen (school
   name, address, phone/email, exam-body centre code, number of
   classes, the officials whose names appear on documents) now
   lives in SchoolSettings / SchoolOfficials (see ensureSchema.js)
   and is edited from the admin's School Settings page instead of
   a code change.

   Read side (GET /) is PUBLIC, same reasoning as GET /api/website:
   the login screen and portal report headers need this before
   there's necessarily a session (or across every role — student,
   teacher, admin — that can each download a record), and none of
   it is sensitive. Every write is admin-portal-only, gated by the
   grantable "School Settings" page like any other sub-admin page.
========================================================= */

module.exports = (poolPromise, sql) => {
  /* ================= GET (public) =================
     Returns { settings, officials } in one call so every consumer
     (Login page, StudentReport, TeacherReports, reports.jsx, the
     School Settings admin form) needs exactly one fetch. */
  router.get("/", async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware

      const settingsResult = await pool.request().query(
        `SELECT TOP 1 * FROM SchoolSettings WHERE id = 1`
      );
      const officialsResult = await pool.request().query(
        `SELECT * FROM SchoolOfficials ORDER BY sortOrder ASC, id ASC`
      );

      res.json({
        settings: settingsResult.recordset[0] || null,
        officials: officialsResult.recordset || [],
      });
    } catch (err) {
      console.log("SCHOOL SETTINGS GET ERROR:", err.message);
      // Empty-shaped response, not a 500 — every screen that reads
      // this should fall back to its own generic default rather than
      // breaking a report download just because this lookup hiccups.
      res.json({ settings: null, officials: [] });
    }
  });

  /* ================= UPDATE SETTINGS (admin) ================= */
  router.put("/", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const {
        schoolName, shortName, motto, centreCode,
        address, phone, email, website, numberOfClasses, logoUrl,
      } = req.body || {};

      if (!schoolName || !String(schoolName).trim()) {
        return res.status(400).json({ message: "School name is required" });
      }

      await pool.request()
        .input("schoolName", sql.NVarChar, schoolName)
        .input("shortName", sql.NVarChar, shortName || "")
        .input("motto", sql.NVarChar, motto || null)
        .input("centreCode", sql.NVarChar, centreCode || null)
        .input("address", sql.NVarChar, address || null)
        .input("phone", sql.NVarChar, phone || null)
        .input("email", sql.NVarChar, email || null)
        .input("website", sql.NVarChar, website || null)
        .input("numberOfClasses", sql.Int, numberOfClasses ? parseInt(numberOfClasses, 10) : null)
        .input("logoUrl", sql.NVarChar, logoUrl || null)
        .input("updatedBy", sql.Int, req.user?.id || null)
        .query(`
          UPDATE SchoolSettings SET
            schoolName = @schoolName,
            shortName = @shortName,
            motto = @motto,
            centreCode = @centreCode,
            address = @address,
            phone = @phone,
            email = @email,
            website = @website,
            numberOfClasses = @numberOfClasses,
            logoUrl = @logoUrl,
            updatedAt = GETDATE(),
            updatedBy = @updatedBy
          WHERE id = 1
        `);

      const result = await pool.request().query(`SELECT TOP 1 * FROM SchoolSettings WHERE id = 1`);
      res.json({ success: true, settings: result.recordset[0] });
    } catch (err) {
      console.log("SCHOOL SETTINGS UPDATE ERROR:", err.message);
      res.status(500).json({ message: "Failed to update school settings" });
    }
  });

  /* ================= LOGO UPLOAD (admin) =================
     Reuses the same upload pipeline as the public-website images
     (backend/uploads/website, served at /uploads/website/<file>) —
     one school logo doesn't need its own bucket/middleware. Returns
     the URL; the frontend then PUTs it into logoUrl via the route
     above (kept as two steps, same as every "photo" field on the
     Website page, so a logo can be previewed before saving). */
  router.post("/logo", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      await runWebsiteImageUpload(req, res);
      if (!req.file) return res.status(400).json({ message: "No image file received" });

      const url = websiteImageUrlFor(req.file.filename);

      // Best-effort cleanup of the previous logo file.
      const prev = await pool.request().query(`SELECT logoUrl FROM SchoolSettings WHERE id = 1`);
      const prevUrl = prev.recordset[0]?.logoUrl;
      if (prevUrl && prevUrl !== url) deleteWebsiteImageByUrl(prevUrl);

      res.json({ url });
    } catch (err) {
      console.log("SCHOOL LOGO UPLOAD ERROR:", err.message);
      res.status(400).json({ message: err.message || "Upload failed" });
    }
  });

  /* ================= OFFICIALS (admin) ================= */
  router.post("/officials", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const { title, name, sortOrder, isSignatory } = req.body || {};

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: "Title is required" });
      }

      // Only one signatory at a time — clear any existing one first
      // when this new official is being marked as the signatory.
      if (isSignatory) {
        await pool.request().query(`UPDATE SchoolOfficials SET isSignatory = 0`);
      }

      const result = await pool.request()
        .input("title", sql.NVarChar, title)
        .input("name", sql.NVarChar, name || null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .input("isSignatory", sql.Bit, isSignatory ? 1 : 0)
        .query(`
          INSERT INTO SchoolOfficials (title, name, sortOrder, isSignatory)
          OUTPUT INSERTED.*
          VALUES (@title, @name, @sortOrder, @isSignatory)
        `);

      res.json({ success: true, official: result.recordset[0] });
    } catch (err) {
      console.log("SCHOOL OFFICIAL CREATE ERROR:", err.message);
      res.status(500).json({ message: "Failed to add official" });
    }
  });

  router.put("/officials/:id", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const { title, name, sortOrder, isSignatory } = req.body || {};

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: "Title is required" });
      }

      if (isSignatory) {
        await pool.request().query(`UPDATE SchoolOfficials SET isSignatory = 0`);
      }

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("title", sql.NVarChar, title)
        .input("name", sql.NVarChar, name || null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .input("isSignatory", sql.Bit, isSignatory ? 1 : 0)
        .query(`
          UPDATE SchoolOfficials SET
            title = @title, name = @name, sortOrder = @sortOrder,
            isSignatory = @isSignatory, updatedAt = GETDATE()
          WHERE id = @id
        `);

      res.json({ success: true });
    } catch (err) {
      console.log("SCHOOL OFFICIAL UPDATE ERROR:", err.message);
      res.status(500).json({ message: "Failed to update official" });
    }
  });

  router.delete("/officials/:id", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`DELETE FROM SchoolOfficials WHERE id = @id`);
      res.json({ success: true });
    } catch (err) {
      console.log("SCHOOL OFFICIAL DELETE ERROR:", err.message);
      res.status(500).json({ message: "Failed to delete official" });
    }
  });

  return router;
};
