/* =========================================================================
   Marking attribution backfill

   Work marked BEFORE the leaderboard shipped has no marked_by on its answers,
   so every teacher showed 0. The one place that still remembers who worked on
   what is e_assessment_marking_sessions: one row per (assessment, teacher)
   holding the teacher's working draft, whose `dismissed` list is the answers
   they moved past (marked) in the marking screen.

   backfillMarkersFromSessions() credits those answers to the teacher by
   writing answers.marked_by (only where it is still empty, earliest session
   first, and only for answers that really have a mark in the database).
   It is idempotent and is also called just before a finished session is
   deleted (clearMarkingSession), so that history is no longer lost then.

   Limit: a draft only lists answers the teacher's screen skipped past, which
   includes answers that were already marked when they opened it. Credit is
   therefore first-come (earliest session wins) and best-effort for old work;
   everything marked from now on is attributed exactly.
========================================================================= */
const { sql } = require("../config/db");

const intsOf = (v) => (Array.isArray(v) ? v : [])
  .map((x) => (typeof x === "number" ? x : /^\d+$/.test(String(x)) ? parseInt(x, 10) : NaN))
  .filter((n) => Number.isInteger(n) && n > 0);

async function readSessions(pool, teacherId, assessmentId) {
  const where = [];
  if (teacherId) where.push("teacher_id = @t");
  if (assessmentId) where.push("e_assessment_id = @a");
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const mk = () => {
    const r = pool.request();
    if (teacherId) r.input("t", sql.Int, teacherId);
    if (assessmentId) r.input("a", sql.Int, assessmentId);
    return r;
  };
  try {
    // JSON_QUERY pulls out just the small `dismissed` array instead of the whole (large) draft
    const r = await mk().query(`SELECT teacher_id, e_assessment_id, createdAt, JSON_QUERY(state, '$.dismissed') AS dismissed
                                FROM e_assessment_marking_sessions ${w} ORDER BY createdAt`);
    return r.recordset.map((x) => {
      let ids = [];
      try { ids = intsOf(JSON.parse(x.dismissed || "[]")); } catch { ids = []; }
      return { teacher_id: x.teacher_id, e_assessment_id: x.e_assessment_id, ids };
    });
  } catch (e) {
    // very old SQL compatibility level without JSON functions — parse the draft here instead
    const r = await mk().query(`SELECT teacher_id, e_assessment_id, createdAt, state
                                FROM e_assessment_marking_sessions ${w} ORDER BY createdAt`);
    return r.recordset.map((x) => {
      let ids = [];
      try { ids = intsOf(JSON.parse(x.state || "{}").dismissed); } catch { ids = []; }
      return { teacher_id: x.teacher_id, e_assessment_id: x.e_assessment_id, ids };
    });
  }
}

async function backfillMarkersFromSessions(pool, { teacherId = null, assessmentId = null } = {}) {
  let credited = 0;
  let sessions;
  try { sessions = await readSessions(pool, teacherId, assessmentId); } catch { return 0; } // table missing etc.
  for (const s of sessions) {
    for (let i = 0; i < s.ids.length; i += 500) {
      const part = s.ids.slice(i, i + 500);
      if (!part.length) continue;
      try {
        const r = await pool.request()
          .input("t", sql.Int, s.teacher_id)
          .input("a", sql.Int, s.e_assessment_id)
          .query(`
            UPDATE an SET marked_by = @t
            FROM e_assessment_answers an
            INNER JOIN e_assessment_submissions sub ON sub.id = an.submission_id AND sub.e_assessment_id = @a
            WHERE an.id IN (${part.join(",")}) AND an.marked_by IS NULL AND an.marks_awarded IS NOT NULL
          `);
        credited += (r.rowsAffected && r.rowsAffected[0]) || 0;
      } catch (e) {
        if (/invalid column name/i.test(String(e.message))) return credited; // columns not created yet
        console.warn("[markingBackfill] chunk skipped:", e.message);
      }
    }
  }
  return credited;
}

module.exports = { backfillMarkersFromSessions };
