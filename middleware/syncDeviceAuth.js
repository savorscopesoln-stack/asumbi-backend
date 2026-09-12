const crypto = require("crypto");

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

    const pool = req.pool;
    const result = await pool.request()
      .input("token_hash", require("mssql").NVarChar(128), hashToken(raw))
      .query(`
        SELECT id, device_name, is_active
        FROM e_assessment_sync_devices
        WHERE token_hash = @token_hash
      `);

    const device = result.recordset[0];
    if (!device || !device.is_active) {
      return res.status(401).json({ success: false, message: "Invalid or revoked sync device token" });
    }

    req.syncDevice = device;
    next();
  } catch (err) {
    console.error("SYNC DEVICE AUTH ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = { authenticateSyncDevice, hashToken };
