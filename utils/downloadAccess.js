/* =========================================================================
   STUDENT DOWNLOAD ACCESS — what students may download through the report
   form links / the public "Download report form" page, and WHEN.

   One row per school database (table ReportDownloadAccess, id = 1):
     mode      'report'     → only the report form
               'transcript' → only the transcript
               'both'       → the student picks (report form or transcript)
     opensAt   downloads open from this moment   (NULL = open straight away)
     closesAt  downloads close at this moment    (NULL = never closes)
     requirePhoto  ON (default) = a student must have a passport photo on file
               before a report form / transcript unlocks. OFF = no photo needed.

   pageNotice  a message the admin types; shown big on the public download page
               (GET /report-access/info) whether downloads are open or not.

   Students whose profile is not filled in yet may still fill it in while
   downloads are CLOSED / NOT OPEN YET (POST /report-access/verify|profile);
   only the report form / transcript itself stays locked. The admin's list of
   who has / has not updated is getProfileStatusAdmin().

   Every successful student download is also written to ReportDownloadLog
   (who, what, when, how) so staff can see the history — see logDownload().

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
  // Added later: the passport-photo on/off switch (existing rows stay ON, as before).
  await pool.request().query(`
    IF COL_LENGTH('ReportDownloadAccess', 'requirePhoto') IS NULL
      ALTER TABLE ReportDownloadAccess ADD requirePhoto BIT NOT NULL CONSTRAINT DF_ReportDownloadAccess_requirePhoto DEFAULT 1
  `);
  // Which exams a student's transcript shows (comma-separated exam ids; NULL = all exams).
  await pool.request().query(`
    IF COL_LENGTH('ReportDownloadAccess', 'transcriptExamIds') IS NULL
      ALTER TABLE ReportDownloadAccess ADD transcriptExamIds NVARCHAR(MAX) NULL
  `);
  // The admin's message shown on the public download page.
  await pool.request().query(`
    IF COL_LENGTH('ReportDownloadAccess', 'pageNotice') IS NULL
      ALTER TABLE ReportDownloadAccess ADD pageNotice NVARCHAR(1000) NULL
  `);
  // Who downloaded what. One row per successful download.
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ReportDownloadLog' AND xtype='U')
    BEGIN
      CREATE TABLE ReportDownloadLog (
        id INT IDENTITY(1,1) PRIMARY KEY,
        studentId INT NULL,
        studentName NVARCHAR(200) NULL,
        username NVARCHAR(100) NULL,
        studentClass NVARCHAR(100) NULL,
        kind NVARCHAR(20) NOT NULL,          -- 'report' | 'transcript'
        method NVARCHAR(20) NULL,            -- 'pdf' | 'print' | 'transcript-pdf'
        source NVARCHAR(30) NULL,            -- 'download-page' | 'report-link' | 'transcript-link'
        ip NVARCHAR(64) NULL,
        userAgent NVARCHAR(300) NULL,
        createdAt DATETIME NOT NULL CONSTRAINT DF_ReportDownloadLog_createdAt DEFAULT GETDATE()
      );
      CREATE INDEX IX_ReportDownloadLog_createdAt ON ReportDownloadLog (createdAt DESC);
      CREATE INDEX IX_ReportDownloadLog_student ON ReportDownloadLog (studentId);
    END
  `);
  ensured.add(pool);
}

const toDate = (v) => {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "3,5,9" -> [3,5,9]; empty / NULL -> null (= every exam). */
const parseIds = (v) => {
  const ids = [...new Set(String(v || "").split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0))];
  return ids.length ? ids : null;
};

const NOTICE_MAX = 1000;
const cleanNotice = (v) => (v == null ? "" : String(v).replace(/\r\n/g, "\n").trim().slice(0, NOTICE_MAX));

async function getDownloadAccess(pool) {
  try {
    await ensureTable(pool);
    const row = (await pool.request().query(`SELECT TOP 1 mode, opensAt, closesAt, requirePhoto, transcriptExamIds, pageNotice FROM ReportDownloadAccess WHERE id = 1`)).recordset[0];
    if (!row) return { mode: "report", opensAt: null, closesAt: null, requirePhoto: true, transcriptExamIds: null, notice: "" };
    return {
      mode: MODES.includes(row.mode) ? row.mode : "report", opensAt: toDate(row.opensAt), closesAt: toDate(row.closesAt),
      requirePhoto: row.requirePhoto == null ? true : !!row.requirePhoto,
      transcriptExamIds: parseIds(row.transcriptExamIds),
      notice: cleanNotice(row.pageNotice),
    };
  } catch (err) {
    // Never lock students out because this optional setting failed to load.
    console.error("DOWNLOAD ACCESS LOAD ERROR (ignored):", err.message);
    return { mode: "report", opensAt: null, closesAt: null, requirePhoto: true, transcriptExamIds: null, notice: "" };
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
  requirePhoto: access.requirePhoto !== false,
  transcriptExamIds: access.transcriptExamIds || null, // null = all exams
});

/** publicView + the admin's typed message (admin settings screen only; the student session never carries it). */
const adminView = (access) => ({ ...publicView(access), notice: access.notice || "" });

/* ── admin endpoints (Main Examinations → Report Download Link) ── */
const getDownloadAccessAdmin = async (req, res) => {
  try {
    const access = await getDownloadAccess(req.pool);
    res.json({ success: true, ...adminView(access), state: windowState(access).state, serverTime: new Date().toISOString() });
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

    // Photo switch: omitted -> keep what is saved; otherwise on/off.
    const current = await getDownloadAccess(pool);
    const requirePhoto = typeof req.body?.requirePhoto === "boolean" ? req.body.requirePhoto : current.requirePhoto;

    // Exams shown on the transcript: omitted -> keep; [] / null -> all exams; [ids] -> only those.
    let transcriptExamIds = current.transcriptExamIds;
    if (Array.isArray(req.body?.transcriptExamIds)) transcriptExamIds = parseIds(req.body.transcriptExamIds.join(","));
    else if (req.body?.transcriptExamIds === null) transcriptExamIds = null;

    // Message on the download page: omitted -> keep what is saved; a string (even empty) replaces it.
    const notice = typeof req.body?.notice === "string" ? cleanNotice(req.body.notice) : current.notice;

    await pool.request()
      .input("notice", sql.NVarChar(NOTICE_MAX), notice || null)
      .input("examIds", sql.NVarChar(sql.MAX), transcriptExamIds ? transcriptExamIds.join(",") : null)
      .input("mode", sql.NVarChar(12), mode)
      .input("requirePhoto", sql.Bit, requirePhoto ? 1 : 0)
      .input("opensAt", sql.DateTime, opensAt)
      .input("closesAt", sql.DateTime, closesAt)
      .input("by", sql.Int, req.user?.id || null)
      .query(`
        IF EXISTS (SELECT 1 FROM ReportDownloadAccess WHERE id = 1)
          UPDATE ReportDownloadAccess SET mode=@mode, opensAt=@opensAt, closesAt=@closesAt, requirePhoto=@requirePhoto, transcriptExamIds=@examIds, pageNotice=@notice, updatedAt=GETDATE(), updatedBy=@by WHERE id = 1
        ELSE
          INSERT INTO ReportDownloadAccess (id, mode, opensAt, closesAt, requirePhoto, transcriptExamIds, pageNotice, updatedBy) VALUES (1, @mode, @opensAt, @closesAt, @requirePhoto, @examIds, @notice, @by)
      `);
    const access = await getDownloadAccess(pool);
    res.json({ success: true, ...adminView(access), state: windowState(access).state, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error("DOWNLOAD ACCESS PUT ERROR:", err.message);
    res.status(500).json({ success: false, message: "Could not save the download settings" });
  }
};

/* ── who has / has not filled in their profile ──
   GET /main-exams/profile-status?status=all|completed|pending&class=&search=&limit=&offset=
   Lists the ACTIVE students only (inactive students cannot use the download page anyway).
   `summary` counts the whole class/search selection, whatever the status tab, so the tabs can show numbers. */
const ACTIVE_STUDENT = `LTRIM(RTRIM(ISNULL(status, ''))) IN ('', 'active')`;

const getProfileStatusAdmin = async (req, res) => {
  try {
    const pool = req.pool;
    const q = req.query || {};
    const status = ["completed", "pending"].includes(q.status) ? q.status : "all";
    const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 300));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    const scope = [ACTIVE_STUDENT];
    const rq = pool.request();
    const cls = String(q.class || "").trim();
    if (cls && cls.toLowerCase() !== "all") { rq.input("cls", sql.NVarChar(100), cls); scope.push("studentClass = @cls"); }
    const search = String(q.search || "").trim().slice(0, 100);
    if (search) { rq.input("s", sql.NVarChar(120), `%${search}%`); scope.push("(name LIKE @s OR username LIKE @s)"); }

    const where = [...scope];
    if (status === "completed") where.push("ISNULL(profileCompleted, 0) = 1");
    if (status === "pending") where.push("ISNULL(profileCompleted, 0) = 0");
    rq.input("limit", sql.Int, limit).input("offset", sql.Int, offset);

    const result = await rq.query(`
      SELECT id, name, username, studentClass, phone, email,
             CASE WHEN ISNULL(profileCompleted, 0) = 1 THEN 1 ELSE 0 END AS profileCompleted,
             CASE WHEN LEN(LTRIM(RTRIM(ISNULL(photoUrl, '')))) > 0 THEN 1 ELSE 0 END AS hasPhoto
      FROM Students WHERE ${where.join(" AND ")}
      ORDER BY studentClass, name, id
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN ISNULL(profileCompleted, 0) = 1 THEN 1 ELSE 0 END) AS completed
      FROM Students WHERE ${scope.join(" AND ")};
    `);
    const sets = result.recordsets || [result.recordset];
    const sum = (sets[1] && sets[1][0]) || { total: 0, completed: 0 };
    const total = Number(sum.total) || 0;
    const completed = Number(sum.completed) || 0;

    let classes = [];
    try {
      const c = await pool.request().query(`SELECT DISTINCT studentClass FROM Students WHERE ${ACTIVE_STUDENT} AND studentClass IS NOT NULL AND studentClass <> '' ORDER BY studentClass`);
      classes = c.recordset.map((r) => r.studentClass);
    } catch { /* the class filter is optional */ }

    res.json({
      success: true,
      summary: { total, completed, pending: total - completed },
      classes,
      items: (sets[0] || []).map((r) => ({ ...r, profileCompleted: !!r.profileCompleted, hasPhoto: !!r.hasPhoto })),
    });
  } catch (err) {
    console.error("PROFILE STATUS ERROR:", err.message);
    res.status(500).json({ success: false, message: "Could not load the profile status list" });
  }
};

/* ── download history ── */
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Records one successful download. NEVER throws: a logging problem must not stop a student's download. */
async function logDownload(pool, { student, kind, method, source, req }) {
  try {
    await ensureTable(pool);
    const ip = clip(req?.ip || req?.headers?.["x-forwarded-for"], 64);
    await pool.request()
      .input("sid", sql.Int, student?.id != null ? Number(student.id) : null)
      .input("name", sql.NVarChar(200), clip(student?.name, 200))
      .input("user", sql.NVarChar(100), clip(student?.username, 100))
      .input("cls", sql.NVarChar(100), clip(student?.studentClass, 100))
      .input("kind", sql.NVarChar(20), kind === "transcript" ? "transcript" : "report")
      .input("method", sql.NVarChar(20), clip(method, 20))
      .input("source", sql.NVarChar(30), clip(source, 30))
      .input("ip", sql.NVarChar(64), ip)
      .input("ua", sql.NVarChar(300), clip(req?.headers?.["user-agent"], 300))
      .query(`INSERT INTO ReportDownloadLog (studentId, studentName, username, studentClass, kind, method, source, ip, userAgent)
              VALUES (@sid, @name, @user, @cls, @kind, @method, @source, @ip, @ua)`);
  } catch (err) {
    console.error("DOWNLOAD LOG ERROR (ignored):", err.message);
  }
}

/** GET /main-exams/download-history?kind=&search=&studentId=&from=&to=&limit=&offset= */
const getDownloadHistoryAdmin = async (req, res) => {
  try {
    const pool = req.pool;
    await ensureTable(pool);
    const q = req.query || {};
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const where = ["1 = 1"];
    const rq = pool.request();
    if (q.kind === "report" || q.kind === "transcript") { rq.input("kind", sql.NVarChar(20), q.kind); where.push("kind = @kind"); }
    if (q.studentId && !Number.isNaN(parseInt(q.studentId, 10))) { rq.input("sid", sql.Int, parseInt(q.studentId, 10)); where.push("studentId = @sid"); }
    if (q.search) {
      rq.input("s", sql.NVarChar(120), `%${String(q.search).trim().slice(0, 100)}%`);
      where.push("(studentName LIKE @s OR username LIKE @s OR studentClass LIKE @s)");
    }
    const from = toDate(q.from), to = toDate(q.to);
    if (from) { rq.input("from", sql.DateTime, from); where.push("createdAt >= @from"); }
    if (to) { rq.input("to", sql.DateTime, to); where.push("createdAt < @to"); }
    rq.input("limit", sql.Int, limit).input("offset", sql.Int, offset);
    const cond = where.join(" AND ");
    const rows = (await rq.query(`
      SELECT id, studentId, studentName, username, studentClass, kind, method, source, ip, createdAt
      FROM ReportDownloadLog WHERE ${cond}
      ORDER BY createdAt DESC, id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      SELECT COUNT(*) AS total, COUNT(DISTINCT studentId) AS students FROM ReportDownloadLog WHERE ${cond};
    `));
    const sets = rows.recordsets || [rows.recordset];
    const sum = (sets[1] && sets[1][0]) || { total: 0, students: 0 };
    res.json({ success: true, total: sum.total, students: sum.students, items: sets[0] || [] });
  } catch (err) {
    console.error("DOWNLOAD HISTORY ERROR:", err.message);
    res.status(500).json({ success: false, message: "Could not load the download history" });
  }
};

module.exports = { cleanNotice, adminView, getProfileStatusAdmin, logDownload, getDownloadHistoryAdmin, MODES, ensureTable, getDownloadAccess, windowState, checkDownload, publicView, getDownloadAccessAdmin, putDownloadAccessAdmin };
