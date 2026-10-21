/* =========================================================================
   MARKING OPTION (per teacher)
   Three ways of marking an answer exist on the marking screens:
     option 1 (default) - select words, a small ✓ / ✗ box pops up and the
                          choice made there decides the point.
     option 2           - select words and a ✓ highlight is added straight
                          away; tap the ✓ afterwards to flip it to ✗.
     option 3           - works exactly like option 1; only the layout differs:
                          the ✓ / ✗ buttons sit on top of the answer editor and
                          the extra "R" button is gone.
   The admin chooses which one each teacher uses. A teacher with no row
   uses option 1, so nothing changes until an admin switches someone.
========================================================================= */
const { sql } = require("../config/db");

const ensured = new WeakSet(); // one check per connection pool (= per tenant)

async function ensureTable(pool) {
  if (ensured.has(pool)) return;
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='teacher_marking_options' AND xtype='U')
    CREATE TABLE teacher_marking_options (
      teacher_id INT NOT NULL PRIMARY KEY,
      option_no TINYINT NOT NULL CONSTRAINT DF_teacher_marking_options_opt DEFAULT 1,
      updated_by INT NULL,
      updated_at DATETIME NOT NULL DEFAULT GETDATE()
    )`);
  ensured.add(pool);
}

const clean = (v) => (Number(v) === 3 ? 3 : Number(v) === 2 ? 2 : 1);

// Teacher: which option do I use? (any failure falls back to option 1)
const getMyMarkingOption = async (req, res) => {
  try {
    const id = parseInt(req.user?.id, 10);
    if (!Number.isFinite(id)) return res.json({ option: 1 });
    await ensureTable(req.pool);
    const r = await req.pool.request().input("id", sql.Int, id)
      .query("SELECT option_no FROM teacher_marking_options WHERE teacher_id = @id");
    res.json({ option: clean(r.recordset[0]?.option_no) });
  } catch (e) {
    console.warn("getMyMarkingOption failed:", e.message);
    res.json({ option: 1 });
  }
};

// Admin: every teacher that has been switched away from the default
const listMarkingOptions = async (req, res) => {
  try {
    await ensureTable(req.pool);
    const r = await req.pool.request().query("SELECT teacher_id, option_no FROM teacher_marking_options");
    const options = {};
    r.recordset.forEach((row) => { options[row.teacher_id] = clean(row.option_no); });
    res.json({ options });
  } catch (e) {
    res.status(500).json({ message: "Could not load marking options" });
  }
};

// Admin: PUT { option: 1|2|3 } for one teacher, or { option, teacherIds: [...] } on the bulk route
const setMarkingOption = async (req, res) => {
  try {
    const opt = Number(req.body?.option);
    if (opt !== 1 && opt !== 2 && opt !== 3) return res.status(400).json({ message: "option must be 1, 2 or 3" });
    const ids = (req.params.teacherId ? [req.params.teacherId] : (req.body?.teacherIds || []))
      .map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ message: "No teacher chosen" });
    await ensureTable(req.pool);
    for (const tid of ids) {
      await req.pool.request()
        .input("t", sql.Int, tid).input("o", sql.TinyInt, opt).input("by", sql.Int, parseInt(req.user?.id, 10) || null)
        .query(`
          MERGE teacher_marking_options AS x
          USING (SELECT @t AS teacher_id) AS s ON x.teacher_id = s.teacher_id
          WHEN MATCHED THEN UPDATE SET option_no = @o, updated_by = @by, updated_at = GETDATE()
          WHEN NOT MATCHED THEN INSERT (teacher_id, option_no, updated_by) VALUES (@t, @o, @by);`);
    }
    res.json({ message: `Marking option ${opt} saved for ${ids.length} teacher${ids.length === 1 ? "" : "s"}`, option: opt, teacherIds: ids });
  } catch (e) {
    console.error("setMarkingOption failed:", e.message);
    res.status(500).json({ message: "Could not save marking option" });
  }
};

module.exports = { ensureTable, getMyMarkingOption, listMarkingOptions, setMarkingOption };
