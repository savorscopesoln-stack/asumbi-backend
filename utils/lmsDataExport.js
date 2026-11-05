/* L11.12 - Learner data export (data-subject access), ADMIN only (D-149 follow-up, D-150).
   One learner's LMS rows as JSON, read-only. LMS tables only: core identity (Students) is NOT included.
   - Tables come from a FIXED allow-list below; the learner id is the only input and is always a bound parameter.
   - Any column whose name looks like a secret (token, secret, hash, password, stored_name, path) is dropped from every row,
     so guardian/calendar link hashes and private file locations never leave the server. Files themselves are not included (names only).
   - Per table cap (default 5000 rows, newest id first); `truncated: true` tells the caller to ask for more by table.
   - Audited with counts only (no content). Mocked pool only in tests: SQL NOT verified on a real SQL Server. */
const sql = require("mssql");
const { audit } = require("./lmsAudit");

const BY_STUDENT = ["lms_course_enrolments", "lms_enrolment_history", "lms_lesson_progress", "lms_calendar_feeds", "lms_submissions", "lms_submission_files",
  "lms_submission_grades", "lms_student_releases", "lms_extensions", "lms_quiz_attempts", "lms_quiz_answers", "lms_flashcard_ratings", "lms_grades",
  "lms_grade_history", "lms_certificates", "lms_badge_awards", "lms_group_members", "lms_help_requests", "lms_path_learners", "lms_guardian_links", "lms_offline_actions"];
const TABLES = [
  ...BY_STUDENT.map((t) => ({ t, where: "student_id = @s" })),
  { t: "lms_threads", where: "author_source = N'Students' AND author_id = @s" },
  { t: "lms_posts", where: "author_source = N'Students' AND author_id = @s" },
  { t: "lms_peer_reviews", where: "(reviewer_id = @s OR author_id = @s)" },
];
const SECRET_COL = /token|secret|hash|password|stored_name|path/i;
const DEFAULT_CAP = 5000;
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const clean = (row) => { const o = {}; for (const [k, v] of Object.entries(row || {})) if (!SECRET_COL.test(k)) o[k] = v; return o; };

async function exportLearner(pool, user, studentId, { cap = DEFAULT_CAP, now = new Date() } = {}) {
  const sid = posInt(studentId); if (!sid || !user) return { ok: false, notFound: true };
  const lim = Math.min(DEFAULT_CAP, Math.max(1, posInt(cap) || DEFAULT_CAP));
  const st = await pool.request().input("s", sql.Int, sid).query(`SELECT TOP 1 id FROM Students WHERE id = @s`);
  if (!(st.recordset && st.recordset[0])) return { ok: false, notFound: true };
  const tables = {}; let total = 0;
  for (const { t, where } of TABLES) {
    const r = await pool.request().input("s", sql.Int, sid).input("lim", sql.Int, lim + 1)
      .query(`SELECT TOP (@lim) * FROM ${t} WHERE ${where} ORDER BY id DESC`);
    const rows = r.recordset || []; const truncated = rows.length > lim; const kept = (truncated ? rows.slice(0, lim) : rows).map(clean);
    tables[t] = { count: kept.length, truncated, rows: kept }; total += kept.length;
  }
  await audit(pool, user, "learner.exported", "student", sid, { tables: TABLES.length, rows: total });
  return { ok: true, export: { scope: "LMS data only (core student record not included)", learnerId: sid, exportedAt: now.toISOString(), perTableCap: lim, tables } };
}
module.exports = { exportLearner, TABLES, SECRET_COL, DEFAULT_CAP };
