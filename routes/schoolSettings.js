const express = require("express");
const router = express.Router();
const { protect, requirePage } = require("../middleware/authMiddleware");
const { runWebsiteImageUpload, websiteImageUrlFor, deleteWebsiteImageByUrl } = require("../middleware/websitePhotoUpload");
const { listReportThemes, DEFAULT_THEME_KEY } = require("../utils/reportThemes");

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
      // LEFT JOIN Teachers so an official linked to a staff record (via
      // teacherId) always shows that teacher's current name, even if it
      // was edited after the official was linked — a hand-typed name
      // (teacherId NULL) is left as-is.
      const officialsResult = await pool.request().query(`
        SELECT so.*, t.name AS teacherName, t.subject AS teacherSubject
        FROM SchoolOfficials so
        LEFT JOIN Teachers t ON t.id = so.teacherId
        ORDER BY so.sortOrder ASC, so.id ASC
      `);

      const officials = (officialsResult.recordset || []).map((o) => ({
        ...o,
        name: o.teacherId ? (o.teacherName || o.name) : o.name,
      }));

      // Same LEFT JOIN pattern as officials above — a class teacher
      // linked to a staff record (teacherId) always shows that
      // teacher's current name; a hand-typed name is left as-is.
      const classTeachersResult = await pool.request().query(`
        SELECT ct.*, t.name AS teacherName, t.subject AS teacherSubject
        FROM ClassTeachers ct
        LEFT JOIN Teachers t ON t.id = ct.teacherId
        ORDER BY ct.className ASC, ct.sortOrder ASC, ct.id ASC
      `);
      const classTeachers = (classTeachersResult.recordset || []).map((c) => ({
        ...c,
        name: c.teacherId ? (c.teacherName || c.name) : c.name,
      }));

      res.json({
        settings: settingsResult.recordset[0] || null,
        officials,
        classTeachers,
      });
    } catch (err) {
      console.log("SCHOOL SETTINGS GET ERROR:", err.message);
      // Empty-shaped response, not a 500 — every screen that reads
      // this should fall back to its own generic default rather than
      // breaking a report download just because this lookup hiccups.
      res.json({ settings: null, officials: [], classTeachers: [] });
    }
  });

  /* ================= REPORT THEMES (public) =================
     The fixed catalog the School Settings "Report Theme" picker and
     admin form render from — see utils/reportThemes.js. Public for the
     same reason GET / is: nothing sensitive, and it's just a static
     list of color swatches. */
  router.get("/report-themes", (req, res) => {
    res.json({ themes: listReportThemes(), default: DEFAULT_THEME_KEY });
  });

  /* ================= UPDATE SETTINGS (admin) ================= */
  router.put("/", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const {
        schoolName, shortName, motto, centreCode,
        address, phone, email, website, numberOfClasses, logoUrl, stampUrl,
        reportTheme,
      } = req.body || {};

      if (!schoolName || !String(schoolName).trim()) {
        return res.status(400).json({ message: "School name is required" });
      }

      // Only ever persist a key from the known catalog (or NULL to fall
      // back to the default look) — never an arbitrary string, since
      // reportExport.js's resolveReportTheme() already treats anything
      // unrecognized as the default, so silently accepting a typo'd key
      // here would just be a no-op that looks like a saved choice.
      const knownKeys = listReportThemes().map((t) => t.key);
      const cleanReportTheme = reportTheme && knownKeys.includes(reportTheme) ? reportTheme : null;

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
        .input("stampUrl", sql.NVarChar, stampUrl || null)
        .input("reportTheme", sql.NVarChar, cleanReportTheme)
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
            stampUrl = @stampUrl,
            reportTheme = @reportTheme,
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

  /* ================= STAMP UPLOAD (admin) =================
     Same pipeline/two-step-then-save pattern as the logo above —
     used at the bottom of a downloaded transcript (utils/transcriptPdf.js)
     next to the signing officials below. */
  router.post("/stamp", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      await runWebsiteImageUpload(req, res);
      if (!req.file) return res.status(400).json({ message: "No image file received" });

      const url = websiteImageUrlFor(req.file.filename);

      // Best-effort cleanup of the previous stamp file.
      const prev = await pool.request().query(`SELECT stampUrl FROM SchoolSettings WHERE id = 1`);
      const prevUrl = prev.recordset[0]?.stampUrl;
      if (prevUrl && prevUrl !== url) deleteWebsiteImageByUrl(prevUrl);

      res.json({ url });
    } catch (err) {
      console.log("SCHOOL STAMP UPLOAD ERROR:", err.message);
      res.status(400).json({ message: err.message || "Upload failed" });
    }
  });

  /* ================= OFFICIALS (admin) ================= */

  /* Teachers picker for the "link to an existing teacher" option below —
     lightweight list (no marks/attendance/etc.), gated by the same
     School Settings page as everything else here. */
  router.get("/officials/teachers", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const result = await pool.request().query(
        `SELECT id, name, subject, staffId FROM Teachers ORDER BY name ASC`
      );
      res.json({ teachers: result.recordset || [] });
    } catch (err) {
      console.log("SCHOOL OFFICIALS TEACHERS LIST ERROR:", err.message);
      res.status(500).json({ message: "Failed to load teachers" });
    }
  });

  router.post("/officials", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const { title, name, teacherId, sortOrder, isSignatory } = req.body || {};

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: "Rank / title is required" });
      }
      if (!teacherId && (!name || !String(name).trim())) {
        return res.status(400).json({ message: "Pick a teacher or type a name" });
      }

      // No more "only one signatory" rule — any number of officials can
      // be flagged isSignatory and will all appear on a report; sortOrder
      // doubles as the order they're signed/listed in.
      const result = await pool.request()
        .input("title", sql.NVarChar, title)
        .input("name", sql.NVarChar, teacherId ? null : name)
        .input("teacherId", sql.Int, teacherId ? parseInt(teacherId, 10) : null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .input("isSignatory", sql.Bit, isSignatory ? 1 : 0)
        .query(`
          INSERT INTO SchoolOfficials (title, name, teacherId, sortOrder, isSignatory)
          OUTPUT INSERTED.*
          VALUES (@title, @name, @teacherId, @sortOrder, @isSignatory)
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
      const { title, name, teacherId, sortOrder, isSignatory } = req.body || {};

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: "Rank / title is required" });
      }
      if (!teacherId && (!name || !String(name).trim())) {
        return res.status(400).json({ message: "Pick a teacher or type a name" });
      }

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("title", sql.NVarChar, title)
        .input("name", sql.NVarChar, teacherId ? null : name)
        .input("teacherId", sql.Int, teacherId ? parseInt(teacherId, 10) : null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .input("isSignatory", sql.Bit, isSignatory ? 1 : 0)
        .query(`
          UPDATE SchoolOfficials SET
            title = @title, name = @name, teacherId = @teacherId, sortOrder = @sortOrder,
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

  /* ================= CLASS TEACHERS / LECTURERS (admin) =================
     Same shape as Officials above, but scoped to one class at a time —
     every class picked up from Students.studentClass (see
     GET /api/meta/classes) can be given its own "Class Teacher /
     Lecturer" (rank/title editable, e.g. "Form Tutor", "Lecturer"),
     optionally more than one per class (sortOrder as rank, e.g. a
     main Class Teacher plus an Assistant). Consumed by the student's
     own report card, which prints the assignment for the student's
     class instead of a blank hand-signed line. */
  router.post("/class-teachers", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const { className, title, name, teacherId, sortOrder } = req.body || {};

      if (!className || !String(className).trim()) {
        return res.status(400).json({ message: "Class is required" });
      }
      if (!teacherId && (!name || !String(name).trim())) {
        return res.status(400).json({ message: "Pick a teacher or type a name" });
      }

      const result = await pool.request()
        .input("className", sql.NVarChar, className)
        .input("title", sql.NVarChar, title && String(title).trim() ? title : "Class Teacher / Lecturer")
        .input("name", sql.NVarChar, teacherId ? null : name)
        .input("teacherId", sql.Int, teacherId ? parseInt(teacherId, 10) : null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .query(`
          INSERT INTO ClassTeachers (className, title, name, teacherId, sortOrder)
          OUTPUT INSERTED.*
          VALUES (@className, @title, @name, @teacherId, @sortOrder)
        `);

      res.json({ success: true, classTeacher: result.recordset[0] });
    } catch (err) {
      console.log("CLASS TEACHER CREATE ERROR:", err.message);
      res.status(500).json({ message: "Failed to add class teacher" });
    }
  });

  router.put("/class-teachers/:id", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      const { className, title, name, teacherId, sortOrder } = req.body || {};

      if (!className || !String(className).trim()) {
        return res.status(400).json({ message: "Class is required" });
      }
      if (!teacherId && (!name || !String(name).trim())) {
        return res.status(400).json({ message: "Pick a teacher or type a name" });
      }

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("className", sql.NVarChar, className)
        .input("title", sql.NVarChar, title && String(title).trim() ? title : "Class Teacher / Lecturer")
        .input("name", sql.NVarChar, teacherId ? null : name)
        .input("teacherId", sql.Int, teacherId ? parseInt(teacherId, 10) : null)
        .input("sortOrder", sql.Int, sortOrder != null ? parseInt(sortOrder, 10) : 0)
        .query(`
          UPDATE ClassTeachers SET
            className = @className, title = @title, name = @name,
            teacherId = @teacherId, sortOrder = @sortOrder, updatedAt = GETDATE()
          WHERE id = @id
        `);

      res.json({ success: true });
    } catch (err) {
      console.log("CLASS TEACHER UPDATE ERROR:", err.message);
      res.status(500).json({ message: "Failed to update class teacher" });
    }
  });

  router.delete("/class-teachers/:id", protect, requirePage("School Settings"), async (req, res) => {
    try {
      const pool = req.pool; // tenant-resolved by server.js DB middleware
      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`DELETE FROM ClassTeachers WHERE id = @id`);
      res.json({ success: true });
    } catch (err) {
      console.log("CLASS TEACHER DELETE ERROR:", err.message);
      res.status(500).json({ message: "Failed to delete class teacher" });
    }
  });

  return router;
};
