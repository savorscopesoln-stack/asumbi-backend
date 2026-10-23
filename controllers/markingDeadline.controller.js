/* =========================================================================
   MARKING DEADLINE (per e-assessment)
   An admin sets a deadline for finishing the marking of an assessment from
   the E-Assessments > Marking tab. Teachers then see a live countdown on
   their marking screens.

   - Stored in UTC (DATETIME2) so server / admin / teacher time zones never
     disagree. "Seconds left" is worked out by SQL Server (SYSUTCDATETIME),
     so a teacher's wrong device clock cannot change the countdown.
   - A deadline is only a reminder: marking is never blocked after it passes.
   - An assessment with no row has no deadline, so nothing changes until an
     admin sets one.
========================================================================= */
const { sql } = require("../config/db");

const ensured = new WeakSet(); // one check per connection pool (= per tenant)

async function ensureTable(pool) {
  if (ensured.has(pool)) return;
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='marking_deadlines' AND xtype='U')
    CREATE TABLE marking_deadlines (
      assessment_id INT NOT NULL PRIMARY KEY,
      deadline_utc DATETIME2 NOT NULL,
      set_by INT NULL,
      updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    )`);
  ensured.add(pool);
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Teacher / admin: the deadline for the assessment being marked.
// Any failure answers "no deadline" so the marking screen never breaks because of this.
const getMarkingDeadline = async (req, res) => {
  try {
    const id = toInt(req.params.assessmentId);
    if (id === null) return res.json({ deadline: null, seconds_left: null });
    await ensureTable(req.pool);
    const r = await req.pool.request().input("id", sql.Int, id).query(`
      SELECT deadline_utc, DATEDIFF(SECOND, SYSUTCDATETIME(), deadline_utc) AS seconds_left
      FROM marking_deadlines WHERE assessment_id = @id`);
    const row = r.recordset[0];
    if (!row) return res.json({ deadline: null, seconds_left: null });
    res.json({ deadline: iso(row.deadline_utc), seconds_left: row.seconds_left });
  } catch (e) {
    console.warn("getMarkingDeadline failed:", e.message);
    res.json({ deadline: null, seconds_left: null });
  }
};

// Admin: every assessment with its deadline (if any)
const listMarkingDeadlines = async (req, res) => {
  try {
    await ensureTable(req.pool);
    const r = await req.pool.request().query(`
      SELECT ea.id, ea.title, ea.subject, d.deadline_utc,
             CASE WHEN d.deadline_utc IS NULL THEN NULL
                  ELSE DATEDIFF(SECOND, SYSUTCDATETIME(), d.deadline_utc) END AS seconds_left
      FROM e_assessments ea
      LEFT JOIN marking_deadlines d ON d.assessment_id = ea.id
      ORDER BY ea.id DESC`);
    res.json({
      items: r.recordset.map((x) => ({
        id: x.id, title: x.title, subject: x.subject,
        deadline: iso(x.deadline_utc), seconds_left: x.seconds_left,
      })),
    });
  } catch (e) {
    console.error("listMarkingDeadlines failed:", e.message);
    res.status(500).json({ message: "Could not load marking deadlines" });
  }
};

// Admin: PUT { deadline: ISO string | null, assessmentIds: [...] }  (null clears the deadline)
const setMarkingDeadline = async (req, res) => {
  try {
    const ids = (req.body?.assessmentIds || []).map(toInt).filter((x) => x !== null);
    if (!ids.length) return res.status(400).json({ message: "No assessment chosen" });
    const raw = req.body?.deadline;
    await ensureTable(req.pool);

    if (raw === null || raw === "" || raw === undefined) {
      for (const aid of ids) {
        await req.pool.request().input("a", sql.Int, aid)
          .query("DELETE FROM marking_deadlines WHERE assessment_id = @a");
      }
      return res.json({ message: `Deadline cleared for ${ids.length} assessment${ids.length === 1 ? "" : "s"}`, deadline: null, assessmentIds: ids });
    }

    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "Invalid deadline date" });

    for (const aid of ids) {
      await req.pool.request()
        .input("a", sql.Int, aid).input("d", sql.DateTime2, when).input("by", sql.Int, toInt(req.user?.id))
        .query(`
          MERGE marking_deadlines AS x
          USING (SELECT @a AS assessment_id) AS s ON x.assessment_id = s.assessment_id
          WHEN MATCHED THEN UPDATE SET deadline_utc = @d, set_by = @by, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (assessment_id, deadline_utc, set_by) VALUES (@a, @d, @by);`);
    }
    res.json({ message: `Marking deadline saved for ${ids.length} assessment${ids.length === 1 ? "" : "s"}`, deadline: when.toISOString(), assessmentIds: ids });
  } catch (e) {
    console.error("setMarkingDeadline failed:", e.message);
    res.status(500).json({ message: "Could not save marking deadline" });
  }
};

module.exports = { ensureTable, getMarkingDeadline, listMarkingDeadlines, setMarkingDeadline };
