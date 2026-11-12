/* =========================================================================
   REPORT FORM SUBJECTS — which subjects appear on the report form, and which
   of them are OPTIONAL.

   Configured from E-Assessments → "Report Form Subjects". Stored in its own
   table so saving it can never disturb School Settings:

     ReportFormSubjects (subjectId, isOptional, sortOrder)

   Rules
   • Nothing configured (empty table)  → unchanged behaviour: the report form
     shows whatever the report-card source (the picked main exam) schedules,
     and every subject counts toward the average.
   • Configured (main-exam source)     → the report form shows EXACTLY these
     subjects (CRNM where a COMPULSORY subject has no mark yet).
   • Optional subjects                 → COUNT ONLY IF THE STUDENT DID THEM. A
     student with a mark in an optional subject has it included in the total,
     average, grade/result and position like any other subject. A student
     with no mark in it simply doesn't take it: it is left out for that
     student alone and is NEVER shown as CRNM and never turns the overall
     grade/result into CRNM. (CRNM is only for a compulsory subject that has
     no mark yet.) Applies to every report the system generates.
========================================================================= */
const sql = require("mssql");
const { splitGroupKey, splitBaseName, detectPossibleSplits, norm: normName } = require("./splitPapers");

const ensured = new WeakSet();

async function ensureTable(pool) {
  if (ensured.has(pool)) return;
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ReportFormSubjects' AND xtype='U')
    BEGIN
      CREATE TABLE ReportFormSubjects (
        subjectId INT NOT NULL PRIMARY KEY,
        isOptional BIT NOT NULL CONSTRAINT DF_ReportFormSubjects_isOptional DEFAULT 0,
        sortOrder INT NOT NULL CONSTRAINT DF_ReportFormSubjects_sortOrder DEFAULT 0,
        updatedAt DATETIME NOT NULL CONSTRAINT DF_ReportFormSubjects_updatedAt DEFAULT GETDATE()
      )
    END
  `);
  ensured.add(pool);
}

/** { configured, subjects:[{id,name,code,optional}], optionalIds:[id] } */
async function getReportFormConfig(pool) {
  try {
    await ensureTable(pool);
    const rows = (await pool.request().query(`
      SELECT r.subjectId AS id, s.name, s.code, r.isOptional
      FROM ReportFormSubjects r
      INNER JOIN Subjects s ON s.id = r.subjectId
      ORDER BY r.sortOrder ASC, s.name ASC
    `)).recordset;
    const subjects = rows.map((r) => ({ id: r.id, name: r.name, code: r.code, optional: !!r.isOptional }));
    return {
      configured: subjects.length > 0,
      subjects,
      optionalIds: subjects.filter((s) => s.optional).map((s) => Number(s.id)),
    };
  } catch (err) {
    // Never break a report card because this optional feature failed to load.
    console.error("REPORT FORM SUBJECTS LOAD ERROR (ignored):", err.message);
    return { configured: false, subjects: [], optionalIds: [] };
  }
}

/** The report-card source with the configured subject list applied (main exam only). */
async function applyReportFormSubjects(pool, source) {
  const base = { ...source, configured: false, optionalSubjectIds: [] };
  if (!source || source.mode !== "exam") return base;
  const cfg = await getReportFormConfig(pool);
  if (!cfg.configured) return base;
  return {
    ...source,
    configured: true,
    optionalSubjectIds: cfg.optionalIds,
    subjects: cfg.subjects.map((s) => ({ id: s.id, name: s.name, code: s.code, optional: s.optional })),
  };
}


/** Marks each subject of an exam-mode report-card source with its split-paper info:
    split (flagged on the exam's sessions), paper_label, split_group, and possible_split
    (looks like a split paper by name but is not flagged). Never throws. */
async function annotateSplitSubjects(pool, source) {
  if (!source || source.mode !== "exam" || !Array.isArray(source.subjects)) return source;
  try {
    const rows = (await pool.request().input("id", sql.Int, source.id).query(
      `SELECT subject, allow_concurrent, paper_label FROM exam_subject_sessions WHERE main_examination_id = @id`)).recordset;
    const flagged = new Map();
    rows.filter((r) => r.allow_concurrent).forEach((r) => flagged.set(normName(r.subject), r));
    const possible = detectPossibleSplits(source.subjects.map((s, i) => ({ id: i, name: s.name })));
    return {
      ...source,
      subjects: source.subjects.map((s, i) => {
        const f = flagged.get(normName(s.name));
        if (f) return { ...s, split: true, paper_label: f.paper_label || null, split_group: splitGroupKey({ subject: s.name, paper_label: f.paper_label, allow_concurrent: 1 }) };
        return possible.has(i) ? { ...s, possible_split: true, possible_group: possible.get(i) } : s;
      }),
    };
  } catch (err) {
    console.error("SPLIT ANNOTATE ERROR (ignored):", err.message);
    return source;
  }
}

/** SQL fragment restricting a ranking/average query to the subjects on the
    report form. Optional subjects are INCLUDED: they only produce a Marks row
    for students who did them, so for everyone else they are naturally left
    out (no CRNM, no zero). "" when nothing is configured. Ids are integers,
    so inlining them is safe. */
async function countedSubjectsClause(pool, source, column = "m.subjectId") {
  if (!source || source.mode !== "exam") return "";
  const cfg = await getReportFormConfig(pool);
  if (!cfg.configured) return "";
  const ids = cfg.subjects.map((s) => Number(s.id)).filter(Number.isInteger);
  return ids.length ? `AND ${column} IN (${ids.join(",")})` : "AND 1 = 0";
}

/* ── admin endpoints (E-Assessments → "Report Form Subjects") ── */
const getReportFormSubjectsAdmin = async (req, res) => {
  try {
    const pool = req.pool;
    const cfg = await getReportFormConfig(pool);
    const all = (await pool.request().query(`SELECT id, name, code FROM Subjects ORDER BY name ASC`)).recordset;
    const chosen = new Map(cfg.subjects.map((s) => [s.id, s]));
    // Split papers: flagged on any Main Examination subject session (by name), plus
    // subjects whose names look like papers of one subject but were never flagged.
    let flagged = new Map();
    try {
      const rows = (await pool.request().query(
        `SELECT subject, paper_label FROM exam_subject_sessions WHERE allow_concurrent = 1`)).recordset;
      rows.forEach((r) => flagged.set(normName(r.subject), r.paper_label || null));
    } catch (_) { /* columns not there yet: nothing is flagged */ }
    const possible = detectPossibleSplits(all.map((s) => ({ id: s.id, name: s.name })));
    res.json({
      configured: cfg.configured,
      subjects: all.map((s) => ({
        id: s.id, name: s.name, code: s.code,
        selected: chosen.has(s.id),
        isOptional: !!chosen.get(s.id)?.optional,
        split: flagged.has(normName(s.name)),
        paper_label: flagged.get(normName(s.name)) || null,
        possible_split: !flagged.has(normName(s.name)) && possible.has(s.id),
        split_group: flagged.has(normName(s.name)) || possible.has(s.id) ? splitBaseName(s.name, flagged.get(normName(s.name))) : null,
      })),
    });
  } catch (err) {
    console.error("REPORT FORM SUBJECTS GET ERROR:", err.message);
    res.status(500).json({ message: "Could not load the report form subjects" });
  }
};

const putReportFormSubjectsAdmin = async (req, res) => {
  const pool = req.pool;
  try {
    await ensureTable(pool);
    const incoming = Array.isArray(req.body?.subjects) ? req.body.subjects : [];
    const seen = new Set();
    const clean = [];
    for (const item of incoming) {
      const id = Number.parseInt(item?.id, 10);
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.add(id);
      clean.push({ id, isOptional: !!item?.isOptional });
    }
    if (clean.length) {
      const existing = new Set((await pool.request().query(`SELECT id FROM Subjects`)).recordset.map((r) => r.id));
      const missing = clean.filter((c) => !existing.has(c.id));
      if (missing.length) return res.status(400).json({ message: "One or more selected subjects no longer exist" });
      if (clean.every((c) => c.isOptional)) {
        return res.status(400).json({ message: "At least one subject must be non-optional, or there is nothing to average" });
      }
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).query(`DELETE FROM ReportFormSubjects`);
      for (let i = 0; i < clean.length; i++) {
        await new sql.Request(tx)
          .input("id", sql.Int, clean[i].id)
          .input("opt", sql.Bit, clean[i].isOptional ? 1 : 0)
          .input("ord", sql.Int, i)
          .query(`INSERT INTO ReportFormSubjects (subjectId, isOptional, sortOrder) VALUES (@id, @opt, @ord)`);
      }
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) {}
      throw err;
    }
    res.json({
      success: true,
      configured: clean.length > 0,
      count: clean.length,
      optionalCount: clean.filter((c) => c.isOptional).length,
    });
  } catch (err) {
    console.error("REPORT FORM SUBJECTS PUT ERROR:", err.message);
    res.status(500).json({ message: "Could not save the report form subjects" });
  }
};

module.exports = {
  ensureTable, getReportFormConfig, applyReportFormSubjects, annotateSplitSubjects, countedSubjectsClause,
  getReportFormSubjectsAdmin, putReportFormSubjectsAdmin,
};
