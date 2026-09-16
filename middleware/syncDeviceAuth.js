const crypto = require("crypto");
const { getPool } = require("../config/db");

// Local exam servers authenticate with a long-lived opaque token (shown
// once at registration), not a teacher JWT — so a machine sitting in a
// computer lab never holds real admin/teacher credentials. The token is
// stored only as a sha256 hash, same principle as a password hash.
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const authenticateSyncDevice = async (req, res, next) => {
  try {
    const raw = req.headers["x-sync-token"];
    if (!raw) {
      return res.status(401).json({ success: false, message: "Missing X-Sync-Token header" });
    }

    // TENANT FIX: these requests carry no JWT (just the sync token), so
    // server.js's global tenant-resolving middleware has nothing to read
    // a tenant off and always falls back to req.pool = the "default"
    // tenant DB — regardless of which school actually registered this
    // device. That silently broke sync for every non-default tenant: the
    // device row lives in ITS OWN tenant DB and is never found against
    // "default". Resolve the pool from the tenant the local exam server
    // itself tells us (issued to it alongside the token at
    // registration/reissue — see syncController.js) instead of trusting
    // that guess. Falls back to "default" only for devices registered
    // before this fix that haven't been given a tenant key yet.
    const tenantKey = String(req.headers["x-tenant-key"] || "default").toLowerCase();
    const pool = await getPool(tenantKey);
    req.pool = pool;
    req.tenant = tenantKey;

    const result = await pool.request()
      .input("token_hash", require("mssql").NVarChar(128), hashToken(raw))
      .query(`
        SELECT id, device_name, is_active
        FROM e_assessment_sync_devices
        WHERE token_hash = @token_hash
      `);

    const device = result.recordset[0];
    if (!device) {
      return res.status(401).json({ success: false, message: "Invalid sync device token" });
    }
    if (!device.is_active) {
      // Distinct from "invalid": the token used to be valid and the device
      // is known, but an admin revoked it (or it hasn't been reissued yet).
      // The local server should surface this differently from a typo'd
      // token — it means "ask the admin to reissue", not "re-check .env".
      //
      // Also worth a log row: a revoked device that keeps trying to
      // sync is exactly the kind of thing "what's failing and why"
      // should surface in the admin panel, not just in server logs.
      try {
        await pool.request()
          .input("device_id", require("mssql").Int, device.id)
          .input("direction", require("mssql").NVarChar(10), req.method === "GET" ? "pull" : "push")
          .query(`
            INSERT INTO e_assessment_sync_logs (device_id, e_assessment_id, direction, record_count, status, message)
            VALUES (@device_id, NULL, @direction, 0, 'error', 'Rejected: device token is revoked')
          `);
      } catch (logErr) {
        console.error("SYNC LOG WRITE FAILED:", logErr);
      }
      return res.status(401).json({
        success: false,
        revoked: true,
        message: "This device's sync token has been revoked. Ask an admin to reissue a token for it, then update SYNC_TOKEN on this machine.",
      });
    }

    req.syncDevice = device;
    next();
  } catch (err) {
    console.error("SYNC DEVICE AUTH ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { authenticateSyncDevice, hashToken };
