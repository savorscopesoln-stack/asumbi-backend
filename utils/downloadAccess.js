/* =========================================================================
   STUDENT DOWNLOAD ACCESS — what students may download through the report
   form links / the public "Download report form" page, and WHEN.

   One row per school database (table ReportDownloadAccess, id = 1):
     mode      'report'     → only the report form
               'transcript' → only the transcript
               'both'       → the student picks (report form or transcript)
     opensAt   downloads open from this moment   (NULL = open straight away)
     closesAt  downloads close at this moment    (NULL = never closes)

   Nothing saved yet → mode 'report', always open: exactly the behaviour
   before this feature existed.

   The window and the mode are enforced on the server wherever a student
   gets a session or a file: POST /report-access/verify|profile,
   POST /auth/report-link (/r/…), GET /auth/transcript-link (/t/…) and
   GET /report-access/transcript.
========================================================================= */
const sql = require("mssql");

const MODES = ["report", "transcript", "both"];
const ensured = new WeakSet();

async function ensureTable(pool) {
  if (ensured.has(pool)) return;
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ReportDownloadAccess' AND xtype='U')
    BEGIN
      CREATE TABLE ReportDownloadAccess (
        id INT NOT NULL PRIMARY KEY,
        mode NVARCHAR(12) NOT NULL CONSTRAINT DF_ReportDownloadAccess_mode DEFAULT 'report',
        opensAt DATETIME NULL,
        closesAt DATETIME NULL,
        updatedAt DATETIME NOT NULL CONSTRAINT DF_ReportDownloadAccess_updatedAt DEFAULT GETDATE(),
        updatedBy INT NULL
      )
    END
  `);
  ensured.add(pool);
}

const toDate = (v) => {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function getDownloadAccess(pool) {
  try {
    await ensureTable(pool);
    const row = (await pool.request().query(`SELECT TOP 1 mode, opensAt, closesAt FROM ReportDownloadAccess WHERE id = 1`)).recordset[0];
    if (!row) return { mode: "report", opensAt: null, closesAt: null };
    return { mode: MODES.includes(row.mode) ? row.mode : "report", opensAt: toDate(row.opensAt), closesAt: toDate(row.closesAt) };
  } catch (err) {
    // Never lock students out because this optional setting failed to load.
    console.error("DOWNLOAD ACCESS LOAD ERROR (ignored):", err.message);
    return { mode: "report", opensAt: null, closesAt: null };
  }
}

const TZ = process.env.SCHOOL_TIMEZONE || "Africa/Nairobi";
const fmt = (d) => `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(d)} (${TZ === "Africa/Nairobi" ? "EAT" : TZ})`;

/** { open, state: 'open'|'not_open'|'closed', message } for a settings object at `now`. */
function windowState(access, now = Date.now()) {
  if (access.opensAt && now < access.opensAt.getTime()) {
    return { open: false, state: "not_open", message: `Downloads are not open yet. They open on ${fmt(access.opensAt)}.` };
  }
  if (access.closesAt && now >= access.closesAt.getTime()) {
    return { open: false, state: "closed", message: `Downloads are closed. They closed on ${fmt(access.closesAt)}. Please contact the school office.` };
  }
  return { open: true, state: "open", message: "" };
}

/** what: 'report' | 'transcript' | 'any'. -> { ok, status?, code?, message?, access } */
async function checkDownload(pool, what = "any", now = Date.now()) {
  const access = await getDownloadAccess(pool);
  const w = windowState(access, now);
  if (!w.open) return { ok: false, status: 403, code: w.state === "closed" ? "DOWNLOADS_CLOSED" : "DOWNLOADS_NOT_OPEN", message: w.message, access };
  if (what === "report" && access.mode === "transcript") return { ok: false, status: 403, code: "DOWNLOAD_NOT_OFFERED", message: "Only transcripts can be downloaded right now.", access };
  if (what === "transcript" && access.mode === "report") return { ok: false, status: 403, code: "DOWNLOAD_NOT_OFFERED", message: "Transcripts are not available for download right now.", access };
  return { ok: true, access };
}

/** What the student pages are told: the mode and the window. */
const publicView = (access) => ({
  mode: access.mode,
  opensAt: access.opensAt ? access.opensAt.toISOString() : null,
  closesAt: access.closesAt ? access.closesAt.toISOString() : null,
});

/* ── admin endpoints (Main Examinations → Report Download Link) ── */
const getDownloadAccessAdmin = async (req, res) => {
  try {
    const access = await getDownloadAccess(req.pool);
    res.json({ success: true, ...publicView(access), state: windowState(access).state, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error("DOWNLOAD ACCESS GET ERROR:", err.message);
    res.status(500).json({ success: false, message: "Could not load the download settings" });
  }
};

const putDownloadAccessAdmin = async (req, res) => {
  try {
    const pool = req.pool;
    await ensureTable(pool);
    const mode = String(req.body?.mode || "report");
    if (!MODES.includes(mode)) return res.status(400).json({ success: false, message: "Choose report form, transcript or both" });
    const rawOpen = req.body?.opensAt, rawClose = req.body?.closesAt;
    const opensAt = toDate(rawOpen), closesAt = toDate(rawClose);
    if ((rawOpen && !opensAt) || (rawClose && !closesAt)) return res.status(400).json({ success: false, message: "Invalid opening or closing date" });
    if (opensAt && closesAt && closesAt <= opensAt) return res.status(400).json({ success: false, message: "The closing time must be after the opening time" });

    await pool.request()
      .input("mode", sql.NVarChar(12), mode)
      .input("opensAt", sql.DateTime, opensAt)
      .input("closesAt", sql.DateTime, closesAt)
      .input("by", sql.Int, req.user?.id || null)
      .query(`
        IF EXISTS (SELECT 1 FROM ReportDownloadAccess WHERE id = 1)
          UPDATE ReportDownloadAccess SET mode=@mode, opensAt=@opensAt, closesAt=@closesAt, updatedAt=GETDATE(), updatedBy=@by WHERE id = 1
        ELSE
          INSERT INTO ReportDownloadAccess (id, mode, opensAt, closesAt, updatedBy) VALUES (1, @mode, @opensAt, @closesAt, @by)
      `);
    const access = await getDownloadAccess(pool);
    res.json({ success: true, ...publicView(access), state: windowState(access).state, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error("DOWNLOAD ACCESS PUT ERROR:", err.message);
    res.status(500).json({ success: false, message: "Could not save the download settings" });
  }
};

module.exports = { MODES, ensureTable, getDownloadAccess, windowState, checkDownload, publicView, getDownloadAccessAdmin, putDownloadAccessAdmin };
