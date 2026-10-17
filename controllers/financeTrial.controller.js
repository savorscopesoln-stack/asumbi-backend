const sql = require("mssql");
const { getPool } = require("../config/db");
const { assertValidTenant } = require("./finance.controller");
const { logFinanceAudit } = require("../utils/financeAuditLog");
const {
  MAX_TRIAL_DAYS, getTrialStatus, parseDays, planTrial, invalidateTrialCache,
} = require("../utils/tenantLicense");

/* =========================================================================
   FINANCE — TRIAL PERIOD CONTROL
   Same shape as the rest of finance.controller.js: the institution comes
   from :tenantKey and its own pool is opened directly (never req.pool).
   Routes are protect + financeOnly (see routes/finance.js).
========================================================================= */

const fail = (res, err, fallback) =>
  res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : fallback });

const getTrial = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    res.json({ success: true, tenantKey, trial: await getTrialStatus(pool), maxDays: MAX_TRIAL_DAYS });
  } catch (err) {
    fail(res, err, "Server error loading trial");
  }
};

/* body: { mode: "start" | "extend", days, note? } */
const setTrial = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const mode = req.body?.mode === "extend" ? "extend" : "start";
    const days = parseDays(req.body?.days);
    if (!days) {
      return res.status(400).json({ success: false, message: `Days must be a whole number from 1 to ${MAX_TRIAL_DAYS}` });
    }
    const note = String(req.body?.note || "").trim().slice(0, 300) || null;

    const pool = await getPool(tenantKey);
    const cur = await pool.request().query(`SELECT trial_starts_at, trial_ends_at, note FROM tenant_license WHERE id = 1`);
    const current = cur.recordset[0] || null;
    const { startsAt, endsAt } = planTrial({ mode, days, current });

    await pool.request()
      .input("starts", sql.DateTime2, startsAt)
      .input("ends", sql.DateTime2, endsAt)
      .input("note", sql.NVarChar(300), note ?? (mode === "extend" ? current?.note ?? null : null))
      .input("by", sql.Int, Number(req.user?.id) || null)
      .query(`
        MERGE tenant_license AS t
        USING (SELECT 1 AS id) AS s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET trial_starts_at = @starts, trial_ends_at = @ends, note = @note,
                                     set_by = @by, updatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (id, trial_starts_at, trial_ends_at, note, set_by)
                              VALUES (1, @starts, @ends, @note, @by);
      `);

    await logFinanceAudit(pool, {
      action: mode === "extend" ? "trial_extended" : "trial_started",
      actorId: Number(req.user?.id) || null,
      actorRole: "finance",
      details: { days, endsAt: endsAt.toISOString(), note },
    });
    invalidateTrialCache(tenantKey);
    res.json({ success: true, tenantKey, trial: await getTrialStatus(pool) });
  } catch (err) {
    console.error("FINANCE SET TRIAL ERROR:", err);
    fail(res, err, "Server error saving trial");
  }
};

const clearTrial = async (req, res) => {
  try {
    const { tenantKey } = req.params;
    assertValidTenant(tenantKey);
    const pool = await getPool(tenantKey);
    await pool.request().query(`DELETE FROM tenant_license WHERE id = 1`);
    await logFinanceAudit(pool, {
      action: "trial_ended", actorId: Number(req.user?.id) || null, actorRole: "finance", details: {},
    });
    invalidateTrialCache(tenantKey);
    res.json({ success: true, tenantKey, trial: await getTrialStatus(pool) });
  } catch (err) {
    console.error("FINANCE CLEAR TRIAL ERROR:", err);
    fail(res, err, "Server error ending trial");
  }
};

module.exports = { getTrial, setTrial, clearTrial };
