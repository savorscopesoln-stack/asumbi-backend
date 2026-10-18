/* =========================================================================
   REPORT CARD SOURCE — what the student report card is allowed to show.
   Exactly one of:
     • none        — nothing selected: the report card stays blank
     • assessment  — ONE e-assessment: only its subject and marks appear
                     (no CRNM for any other subject)
     • exam        — ONE main examination: every subject scheduled in it,
                     with that subject's mark (CRNM where not marked yet)
   Stored as flags: e_assessments.is_report_assessment (new) and
   main_examinations.is_report_exam (existing "Show on Report Cards").
   Selecting one source always clears the other flag, so there is never
   more than one source.
========================================================================= */
const sql = require("mssql");

const ensured = new WeakSet();
async function ensureColumn(pool) {
  if (ensured.has(pool)) return;
  await pool.request().query(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'is_report_assessment' AND Object_ID = Object_ID(N'e_assessments'))
      ALTER TABLE e_assessments ADD is_report_assessment BIT NOT NULL CONSTRAINT DF_e_assessments_is_report_assessment DEFAULT 0;
    IF EXISTS (SELECT * FROM sysobjects WHERE name='main_examinations' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'is_report_exam' AND Object_ID = Object_ID(N'main_examinations'))
      ALTER TABLE main_examinations ADD is_report_exam BIT NOT NULL CONSTRAINT DF_main_examinations_is_report_exam DEFAULT 0;
  `);
  ensured.add(pool);
}

const subjectsByNames = async (pool, names) => {
  const clean = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))];
  if (!clean.length) return [];
  const req = pool.request();
  const ph = clean.map((n, i) => { req.input(`n${i}`, sql.NVarChar, n); return `@n${i}`; });
  const r = await req.query(`SELECT id, name, code FROM Subjects WHERE name IN (${ph.join(",")})`);
  const found = new Map(r.recordset.map((s) => [String(s.name).toLowerCase(), s]));
  // keep every scheduled subject, even one with no Subjects row (shown as CRNM)
  return clean.map((n) => found.get(n.toLowerCase()) || { id: null, name: n, code: null });
};

/** { mode, id, name, subjects:[{id,name,code}] } — what the report card may show right now. */
async function getReportCardSource(pool) {
  await ensureColumn(pool);
  const a = (await pool.request().query(
    `SELECT TOP 1 id, title, subject FROM e_assessments WHERE is_report_assessment = 1`)).recordset[0];
  if (a) {
    return { mode: "assessment", id: a.id, name: a.title, subjects: await subjectsByNames(pool, [a.subject]) };
  }
  const e = (await pool.request().query(
    `SELECT TOP 1 id, name FROM main_examinations WHERE is_report_exam = 1`)).recordset[0];
  if (e) {
    const subs = (await pool.request().input("id", sql.Int, e.id).query(
      `SELECT subject FROM exam_subject_sessions WHERE main_examination_id = @id`)).recordset;
    return { mode: "exam", id: e.id, name: e.name, subjects: await subjectsByNames(pool, subs.map((s) => s.subject)) };
  }
  return { mode: "none", id: null, name: null, subjects: [] };
}

/** Applies one selection atomically. mode: none | assessment | exam */
async function setReportCardSource(pool, mode, id) {
  await ensureColumn(pool);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query(`UPDATE e_assessments SET is_report_assessment = 0 WHERE is_report_assessment = 1`);
    await new sql.Request(tx).query(`UPDATE main_examinations SET is_report_exam = 0 WHERE is_report_exam = 1`);
    if (mode === "assessment") {
      await new sql.Request(tx).input("id", sql.Int, id).query(`UPDATE e_assessments SET is_report_assessment = 1 WHERE id = @id`);
    } else if (mode === "exam") {
      await new sql.Request(tx).input("id", sql.Int, id).query(`UPDATE main_examinations SET is_report_exam = 1, updatedAt = GETDATE() WHERE id = @id`);
    }
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (_) {}
    throw err;
  }
}

/* ── admin endpoints (E-Assessments page → "Report card marks") ── */
const getReportCardOptions = async (req, res) => {
  try {
    const pool = req.pool;
    await ensureColumn(pool);
    const current = await getReportCardSource(pool);
    const assessments = (await pool.request().query(`
      SELECT TOP 500 a.id, a.title, a.subject, c.name AS class_name
      FROM e_assessments a LEFT JOIN Classes c ON c.id = a.class_id
      ORDER BY a.id DESC`)).recordset;
    const exams = (await pool.request().query(`
      SELECT m.id, m.name, m.term, m.academic_year, m.status,
             (SELECT COUNT(*) FROM exam_subject_sessions s WHERE s.main_examination_id = m.id) AS subject_count
      FROM main_examinations m
      WHERE ISNULL(m.status,'') <> 'archived'
      ORDER BY m.id DESC`)).recordset;
    res.json({ current: { mode: current.mode, id: current.id, name: current.name, subjects: current.subjects.map((s) => s.name) }, assessments, exams });
  } catch (err) {
    console.error("REPORT CARD OPTIONS ERROR:", err.message);
    res.status(500).json({ message: "Could not load report card options" });
  }
};

const putReportCardSource = async (req, res) => {
  try {
    const pool = req.pool;
    const mode = String(req.body?.mode || "none");
    const id = Number.parseInt(req.body?.id, 10);
    if (!["none", "assessment", "exam"].includes(mode)) return res.status(400).json({ message: "Invalid mode" });
    if (mode !== "none") {
      if (!id) return res.status(400).json({ message: "Pick an assessment or examination" });
      const table = mode === "assessment" ? "e_assessments" : "main_examinations";
      const ok = (await pool.request().input("id", sql.Int, id).query(`SELECT id FROM ${table} WHERE id = @id`)).recordset[0];
      if (!ok) return res.status(404).json({ message: "Selection not found" });
    }
    await setReportCardSource(pool, mode, id);
    const current = await getReportCardSource(pool);
    res.json({ success: true, current: { mode: current.mode, id: current.id, name: current.name, subjects: current.subjects.map((s) => s.name) } });
  } catch (err) {
    console.error("SET REPORT CARD SOURCE ERROR:", err.message);
    res.status(500).json({ message: "Could not update the report card source" });
  }
};

module.exports = { getReportCardSource, setReportCardSource, getReportCardOptions, putReportCardSource, ensureColumn };
