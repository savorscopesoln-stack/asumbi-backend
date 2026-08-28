const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");

/* =========================================================
   CONTACT
   Backs the public marketing site's Contact page form and the
   Footer newsletter field (the separate Next.js "asumbi-website"
   project). Both of those are "use client" components, so the
   POSTs below happen straight from the visitor's browser — unlike
   lib/content.ts's GET /api/website, which runs server-side.
   That's why the two forms need CORS to actually allow the
   website's origin (see corsOptions in server.js /
   WEBSITE_URL in .env), not just a public route here.

   Read/manage side is admin-only, same as every other list in
   this app — an admin can see who has written in and who has
   subscribed from here, even though there's no dedicated admin
   page for it yet.
========================================================= */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = (poolPromise, sql) => {
  /* ================= SUBMIT CONTACT FORM (public) ================= */
  router.post("/", async (req, res) => {
    try {
      const { name, email, phone, message } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({ message: "Name is required" });
      }
      if (!email || !EMAIL_RE.test(String(email).trim())) {
        return res.status(400).json({ message: "A valid email address is required" });
      }
      if (!message || !String(message).trim()) {
        return res.status(400).json({ message: "Message is required" });
      }

      const pool = await poolPromise;
      await pool
        .request()
        .input("name", sql.NVarChar, String(name).trim().slice(0, 200))
        .input("email", sql.NVarChar, String(email).trim().slice(0, 200))
        .input("phone", sql.NVarChar, phone ? String(phone).trim().slice(0, 50) : null)
        .input("message", sql.NVarChar(sql.MAX), String(message).trim())
        .query(`
          INSERT INTO contact_messages (name, email, phone, message, createdAt)
          VALUES (@name, @email, @phone, @message, GETDATE())
        `);

      res.json({ message: "Sent" });
    } catch (err) {
      console.log("CONTACT SUBMIT ERROR:", err);
      res.status(500).json({ message: "Failed to send message. Please try again shortly." });
    }
  });

  /* ================= NEWSLETTER SIGNUP (public) =================
     Footer's email field. Silently no-ops on a duplicate email
     instead of erroring, so re-submitting is harmless. */
  router.post("/newsletter", async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email || !EMAIL_RE.test(String(email).trim())) {
        return res.status(400).json({ message: "A valid email address is required" });
      }

      const pool = await poolPromise;
      await pool
        .request()
        .input("email", sql.NVarChar, String(email).trim().toLowerCase().slice(0, 200))
        .query(`
          IF NOT EXISTS (SELECT 1 FROM newsletter_subscribers WHERE email = @email)
          INSERT INTO newsletter_subscribers (email, createdAt) VALUES (@email, GETDATE())
        `);

      res.json({ message: "Subscribed" });
    } catch (err) {
      console.log("NEWSLETTER SUBSCRIBE ERROR:", err);
      res.status(500).json({ message: "Failed to subscribe. Please try again shortly." });
    }
  });

  /* ================= LIST SUBMISSIONS (admin) ================= */
  router.get("/", protect, adminOnly, async (req, res) => {
    try {
      const pool = await poolPromise;
      const result = await pool.request().query(`SELECT * FROM contact_messages ORDER BY createdAt DESC`);
      res.json(result.recordset);
    } catch (err) {
      console.log("CONTACT LIST ERROR:", err);
      res.status(500).json({ message: "Failed to load messages" });
    }
  });

  /* ================= MARK READ (admin) ================= */
  router.put("/:id/read", protect, adminOnly, async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request().input("id", sql.Int, req.params.id).query(`UPDATE contact_messages SET isRead = 1 WHERE id = @id`);
      res.json({ message: "OK" });
    } catch (err) {
      console.log("CONTACT MARK READ ERROR:", err);
      res.status(500).json({ message: "Failed to update message" });
    }
  });

  /* ================= DELETE (admin) ================= */
  router.delete("/:id", protect, adminOnly, async (req, res) => {
    try {
      const pool = await poolPromise;
      await pool.request().input("id", sql.Int, req.params.id).query(`DELETE FROM contact_messages WHERE id = @id`);
      res.json({ message: "Deleted" });
    } catch (err) {
      console.log("CONTACT DELETE ERROR:", err);
      res.status(500).json({ message: "Failed to delete message" });
    }
  });

  /* ================= LIST NEWSLETTER SUBSCRIBERS (admin) ================= */
  router.get("/newsletter", protect, adminOnly, async (req, res) => {
    try {
      const pool = await poolPromise;
      const result = await pool.request().query(`SELECT * FROM newsletter_subscribers ORDER BY createdAt DESC`);
      res.json(result.recordset);
    } catch (err) {
      console.log("NEWSLETTER LIST ERROR:", err);
      res.status(500).json({ message: "Failed to load subscribers" });
    }
  });

  return router;
};
