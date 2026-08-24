const express = require("express");
const router = express.Router();
const { authorize } = require("../middleware/authMiddleware");

const VALID_PORTALS = ["student", "teacher"];

// Landing pages a portal can never lose access to — disabling either
// of these would leave that role with nowhere to go after login, so
// it's rejected on the backend even if someone bypasses the UI.
const LOCKED = new Set(["student:/student", "teacher:/teacher/dashboard"]);

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

  /* ================= GET ALL (admin control page) =================
     Every row ever explicitly set, across both portals. Anything not
     in this list is simply enabled by default — the control page
     merges this against its own live page registry.
  */
  router.get("/", authorize("admin", "sub_admin", "sub_admin_2"), async (req, res) => {
    try {
      const pool = await poolPromise;
      const result = await pool.request().query(`SELECT * FROM PortalPageSettings ORDER BY portal, page_key`);
      res.json(result.recordset || []);
    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= GET ONE PORTAL (consumed by the layouts) =================
     Any authenticated user may read this — the student/teacher layout
     needs it just to know what to hide/redirect away from.
  */
  router.get("/:portal", async (req, res) => {
    try {
      const portal = String(req.params.portal || "").toLowerCase();
      if (!VALID_PORTALS.includes(portal)) {
        return res.status(400).json({ message: "Unknown portal" });
      }

      const pool = await poolPromise;
      const result = await pool.request()
        .input("portal", sql.NVarChar, portal)
        .query(`SELECT page_key, enabled FROM PortalPageSettings WHERE portal=@portal`);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= SET ONE PAGE'S STATE =================
     Admin-only, enforced on the backend regardless of what the UI
     shows — a Sub-Admin or anyone else hitting this directly gets a
     403.
  */
  router.put("/", authorize("admin"), async (req, res) => {
    try {
      const { portal, page_key, enabled } = req.body;
      const portalNorm = String(portal || "").toLowerCase();

      if (!VALID_PORTALS.includes(portalNorm)) {
        return res.status(400).json({ message: "Unknown portal" });
      }
      if (!page_key) {
        return res.status(400).json({ message: "page_key is required" });
      }
      if (enabled === false && LOCKED.has(`${portalNorm}:${page_key}`)) {
        return res.status(400).json({ message: "This page is the portal's landing page and can't be disabled." });
      }

      const pool = await poolPromise;
      const actorName = await getActorDisplayName(pool, req.user);

      await pool.request()
        .input("portal", sql.NVarChar, portalNorm)
        .input("pageKey", sql.NVarChar, page_key)
        .input("enabled", sql.Bit, enabled !== false)
        .input("updatedById", sql.Int, req.user.id)
        .input("updatedByName", sql.NVarChar, actorName)
        .query(`
          MERGE PortalPageSettings AS target
          USING (SELECT @portal AS portal, @pageKey AS page_key) AS src
          ON target.portal = src.portal AND target.page_key = src.page_key
          WHEN MATCHED THEN
            UPDATE SET enabled=@enabled, updated_by_id=@updatedById, updated_by_name=@updatedByName, updated_at=GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (portal, page_key, enabled, updated_by_id, updated_by_name, updated_at)
            VALUES (@portal, @pageKey, @enabled, @updatedById, @updatedByName, GETDATE());
        `);

      res.json({ message: "Saved", portal: portalNorm, page_key, enabled: enabled !== false });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Failed to update page setting" });
    }
  });

  return router;
};
