const sql = require("mssql");

/* =========================================================================
   MAIN EXAMINATION ANALYTICS (Phase 9 — §15-§26)

   Every number here is derived, at request time, from the SAME tables the
   rest of the app already trusts:
     - exam_subject_sessions / main_examinations  (scheduling context, §36)
     - e_assessments                              (audience, total_marks)
     - e_assessment_questions / e_assessment_options
     - e_assessment_submissions / e_assessment_answers
     - e_assessment_exam_sessions                 (activated_at/ended_at)
     - e_assessment_submission_assignments        (marker assignment)

   There is NO second marks/results calculation anywhere in this file
   (§51 "one source of truth") — every percentage is computed from
   e_assessment_submissions.score, exactly like getMainExaminationDashboard
   and the existing per-assessment quick-stats already do.

   §50 "No Fake Analytics" governs this whole file: any statistic that
   can't be computed from real rows (grade distribution — no grading-scale
   table exists anywhere in this schema; topic analytics — questions have
   no topic/competency column; discrimination/difficulty with too small a
   sample) comes back as `null` with an explanatory `*_note`, never an
   invented number. The frontend is expected to render those as
   "Not enough data" / "Unavailable for this assessment".

   §58 note: none of this is on the student exam-taking path. It's an
   admin/teacher-dashboard-only set of endpoints, each a small, bounded
   number of aggregation queries (never one row per submission pulled
   into Node to sum in JS).
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// §20 "Do not falsely label questions where there is insufficient response
// data" / §22 same rule for discrimination — shared minimum-sample
// thresholds so every endpoint in this file agrees on what "enough data"
// means.
const MIN_DIFFICULTY_SAMPLE = 5;
const MIN_DISCRIMINATION_SAMPLE = 10;
const DISCRIMINATION_GROUP_FRACTION = 0.27; // standard top/bottom 27% split

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const pct = (num, denom) => (denom > 0 ? round1((num / denom) * 100) : null);

// Same default the standalone Grading System settings page falls back to
// (see getGradingSystem in eAssessment.controller.js) — kept in sync so a
// tenant that has never opened that settings page still gets the exact
// same 40% every other report/result screen in the app already assumes.
const DEFAULT_PASS_MARK = 40;

// The pass rate here is now read from the same GradingSystem table the
// admin's "Grading System" settings screen (Admin → E-Assessments →
// Grading System) writes to — not a second, independently-configured
// pass mark. If that row hasn't been saved yet on this tenant, we fall
// back to the same 40% every other screen in the app already defaults
// to, so a fresh tenant never sees a broken/missing pass rate.
async function getPassMark(pool) {
  try {
    const result = await pool.request().query(`SELECT TOP 1 passMark FROM GradingSystem WHERE id = 1`);
    const raw = result.recordset[0]?.passMark;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_PASS_MARK;
  } catch (_) {
    // Table not migrated on this tenant yet — same fallback as above.
    return DEFAULT_PASS_MARK;
  }
}

function difficultyLabel(correctPct, sampleSize) {
  if (sampleSize < MIN_DIFFICULTY_SAMPLE || correctPct == null) return "Insufficient data";
  if (correctPct >= 75) return "Easy";
  if (correctPct >= 40) return "Medium";
  return "Hard";
}

function discriminationLabel(index) {
  if (index == null) return "Insufficient data";
  if (index >= 0.4) return "Good";
  if (index >= 0.2) return "Fair";
  return "Poor";
}

/* -------------------------------------------------------------------------
   Shared helper: load a Main Examination's subject sessions with their
   linked assessment's audience/total_marks — the same join shape
   getMainExaminationDashboard already uses. Returns [] if the exam
   doesn't exist (caller checks examination separately).
------------------------------------------------------------------------- */
async function loadSubjectsWithAssessment(pool, mainExaminationId) {
  const result = await pool.request()
    .input("mainExaminationId", sql.Int, mainExaminationId)
    .query(`
      SELECT
        ess.id AS session_id, ess.subject, ess.status AS session_status,
        ess.exam_date, ess.start_time, ess.end_time, ess.e_assessment_id,
        ea.title AS assessment_title, ea.total_marks, ea.class_id, ea.year_of_study,
        c.name AS class_name
      FROM exam_subject_sessions ess
      LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
      LEFT JOIN Classes c ON c.id = ea.class_id
      WHERE ess.main_examination_id = @mainExaminationId
      ORDER BY ess.start_time ASC, ess.id ASC
    `);
  return result.recordset;
}

/* =========================================================================
   Shared computation — Main Examination level summary (§16-§18).
   Used by BOTH the analytics endpoint (getMainExamAnalytics) and the
   Phase 11 "Main Examination Summary" / "Grade Distribution" reports, so
   the dashboard and the downloadable report can never disagree (§51).
   Returns { notFound: true } if the examination doesn't exist.
========================================================================= */
async function computeMainExaminationSummary(pool, id) {
  const examResult = await pool.request().input("id", sql.Int, id)
    .query(`SELECT * FROM main_examinations WHERE id = @id`);
  const examination = examResult.recordset[0];
  if (!examination) return { notFound: true };

  const subjects = await loadSubjectsWithAssessment(pool, id);
  const eAssessmentIds = [...new Set(subjects.map((s) => s.e_assessment_id).filter(Boolean))];
  const passMark = await getPassMark(pool);

  const emptySummary = {
    examination,
    candidate_stats: { registered: 0, attempted: 0, completed: 0, incomplete: 0, absent: 0 },
    performance: { mean: null, median: null, highest: null, lowest: null, std_dev: null, pass_rate: null,
      pass_rate_note: "Unavailable — no candidates have been scored yet." },
    grade_distribution: null,
    grade_distribution_note: "Unavailable — no grading scale is configured in this system yet (§16).",
    subjects: [],
  };
  if (!eAssessmentIds.length) return emptySummary;

  const idParams = eAssessmentIds.map((_, i) => `@eid${i}`).join(",");
  const withIds = (request) => { eAssessmentIds.forEach((eid, i) => request.input(`eid${i}`, sql.Int, eid)); return request; };

  // ---- Candidate stats (registered / attempted / completed / incomplete / absent) ----
  const registeredResult = await pool.request().input("mainExaminationId", sql.Int, id).query(`
    SELECT COUNT(DISTINCT st.id) AS registered
    FROM Students st
    WHERE EXISTS (
      SELECT 1 FROM exam_subject_sessions ess
      JOIN e_assessments ea ON ea.id = ess.e_assessment_id
      LEFT JOIN Classes c ON c.id = ea.class_id
      WHERE ess.main_examination_id = @mainExaminationId
        AND ( (c.name IS NOT NULL AND c.name = st.studentClass) OR ea.year_of_study = st.yearOfStudy )
    )
  `);
  const registered = registeredResult.recordset[0]?.registered || 0;

  const activityResult = await withIds(pool.request()).query(`
    SELECT
      (SELECT COUNT(DISTINCT student_id) FROM e_assessment_submissions WHERE e_assessment_id IN (${idParams})) AS completed,
      (SELECT COUNT(DISTINCT student_id) FROM (
          SELECT student_id FROM e_assessment_exam_sessions WHERE e_assessment_id IN (${idParams})
          UNION
          SELECT student_id FROM e_assessment_submissions WHERE e_assessment_id IN (${idParams})
      ) x) AS attempted,
      (SELECT COUNT(DISTINCT es.student_id)
       FROM e_assessment_exam_sessions es
       WHERE es.e_assessment_id IN (${idParams})
         AND NOT EXISTS (
           SELECT 1 FROM e_assessment_submissions s
           WHERE s.e_assessment_id = es.e_assessment_id AND s.student_id = es.student_id
         )
      ) AS incomplete
  `);
  const activity = activityResult.recordset[0] || {};
  const attempted = activity.attempted || 0;
  const completed = activity.completed || 0;
  const incomplete = activity.incomplete || 0;
  const absent = Math.max(0, registered - attempted);

  // ---- Overall performance (pooled across all subject submissions, §16) ----
  const perfResult = await withIds(pool.request()).input("passMark", sql.Float, passMark).query(`
    SELECT
      COUNT(*) AS n,
      AVG(pct.p)                                           AS mean,
      MIN(pct.p)                                            AS lowest,
      MAX(pct.p)                                            AS highest,
      STDEV(pct.p)                                          AS std_dev,
      SUM(CASE WHEN pct.p >= @passMark THEN 1 ELSE 0 END)   AS passed,
      (SELECT TOP 1 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pct2.p) OVER () FROM (
          SELECT CAST(s2.score AS FLOAT) * 100.0 / ea2.total_marks AS p
          FROM e_assessment_submissions s2
          JOIN e_assessments ea2 ON ea2.id = s2.e_assessment_id
          WHERE s2.e_assessment_id IN (${idParams}) AND s2.score IS NOT NULL AND ea2.total_marks > 0
      ) pct2) AS median
    FROM (
      SELECT CAST(s.score AS FLOAT) * 100.0 / ea.total_marks AS p
      FROM e_assessment_submissions s
      JOIN e_assessments ea ON ea.id = s.e_assessment_id
      WHERE s.e_assessment_id IN (${idParams}) AND s.score IS NOT NULL AND ea.total_marks > 0
    ) pct
  `);
  const perfRow = perfResult.recordset[0] || {};
  // §51 "one source of truth": the pass mark used here is whatever is
  // currently saved on the admin's Grading System settings screen
  // (falls back to 40% if that's never been configured on this
  // tenant) — never a second, independently-set number.
  const performance = {
    mean: round1(perfRow.mean),
    median: round1(perfRow.median),
    highest: round1(perfRow.highest),
    lowest: round1(perfRow.lowest),
    std_dev: round1(perfRow.std_dev),
    sample_size: perfRow.n || 0,
    pass_mark: passMark,
    pass_rate: perfRow.n ? pct(perfRow.passed, perfRow.n) : null,
    pass_rate_note: perfRow.n ? `Candidates scoring at or above the configured pass mark (${passMark}%).` : "Unavailable — no candidates have been scored yet.",
  };

  // ---- Per-subject performance (§17) ----
  const bySubjectResult = await withIds(pool.request()).input("passMark", sql.Float, passMark).query(`
    SELECT
      s.e_assessment_id,
      COUNT(*) AS completed,
      AVG(CASE WHEN ea.total_marks > 0 THEN CAST(s.score AS FLOAT) * 100.0 / ea.total_marks END) AS mean,
      MIN(CASE WHEN ea.total_marks > 0 THEN CAST(s.score AS FLOAT) * 100.0 / ea.total_marks END) AS lowest,
      MAX(CASE WHEN ea.total_marks > 0 THEN CAST(s.score AS FLOAT) * 100.0 / ea.total_marks END) AS highest,
      SUM(CASE WHEN ea.total_marks > 0 AND (CAST(s.score AS FLOAT) * 100.0 / ea.total_marks) >= @passMark THEN 1 ELSE 0 END) AS passed
    FROM e_assessment_submissions s
    JOIN e_assessments ea ON ea.id = s.e_assessment_id
    WHERE s.e_assessment_id IN (${idParams}) AND s.score IS NOT NULL
    GROUP BY s.e_assessment_id
  `);
  const bySubjectMap = {};
  bySubjectResult.recordset.forEach((r) => { bySubjectMap[r.e_assessment_id] = r; });

  const perSessionResult = await pool.request().input("mainExaminationId", sql.Int, id).query(`
    SELECT ess.id AS session_id, COUNT(DISTINCT st.id) AS registered
    FROM exam_subject_sessions ess
    JOIN e_assessments ea ON ea.id = ess.e_assessment_id
    LEFT JOIN Classes c ON c.id = ea.class_id
    CROSS JOIN Students st
    WHERE ess.main_examination_id = @mainExaminationId
      AND ( (c.name IS NOT NULL AND c.name = st.studentClass) OR ea.year_of_study = st.yearOfStudy )
    GROUP BY ess.id
  `);
  const perSessionMap = {};
  perSessionResult.recordset.forEach((r) => { perSessionMap[r.session_id] = r.registered; });

  const perSessionAttemptedResult = eAssessmentIds.length
    ? await withIds(pool.request()).query(`
        SELECT e_assessment_id, COUNT(DISTINCT student_id) AS attempted FROM (
          SELECT e_assessment_id, student_id FROM e_assessment_exam_sessions WHERE e_assessment_id IN (${idParams})
          UNION
          SELECT e_assessment_id, student_id FROM e_assessment_submissions WHERE e_assessment_id IN (${idParams})
        ) x GROUP BY e_assessment_id
      `)
    : { recordset: [] };
  const attemptedMap = {};
  perSessionAttemptedResult.recordset.forEach((r) => { attemptedMap[r.e_assessment_id] = r.attempted; });

  const subjectsOut = subjects
    .filter((s) => s.e_assessment_id)
    .map((s) => {
      const perf = bySubjectMap[s.e_assessment_id] || {};
      return {
        session_id: s.session_id,
        subject: s.subject,
        e_assessment_id: s.e_assessment_id,
        registered: perSessionMap[s.session_id] || 0,
        attempted: attemptedMap[s.e_assessment_id] || 0,
        completed: perf.completed || 0,
        mean: round1(perf.mean),
        highest: round1(perf.highest),
        lowest: round1(perf.lowest),
        pass_rate: perf.completed ? pct(perf.passed, perf.completed) : null,
      };
    });

  return {
    examination,
    candidate_stats: { registered, attempted, completed, incomplete, absent },
    performance,
    grade_distribution: null,
    grade_distribution_note: "Unavailable — no grading scale is configured in this system yet (§16).",
    subjects: subjectsOut,
  };
}

/* =========================================================================
   Nominal Roll — the official candidate list for a Main Examination
   (§30.1's "Summary" report), in the school's usual class-list layout:
   one row per candidate (ranked by Class Position), one column per
   subject scheduled in this Main Examination (by a short generated
   code — see assignSubjectCodes() below; this schema has no
   subject-code table of its own, so codes are derived from the name
   and shipped alongside a code→name key so the roll is never ambiguous
   about which column is which subject), with that candidate's mark
   underneath the subject they sat, and "—" under any subject they
   weren't entered for. Uses the exact same class/year "registered
   candidate" / subject-audience matching rule as
   computeMainExaminationSummary's own `registered` count above (§51 —
   so the roll's candidate count always equals the Summary's
   "Registered" figure). Kept out of computeMainExaminationSummary
   itself (and so out of the Analytics tab's payload) because §58 asks
   analytics endpoints to stay small, bounded aggregations — a full
   candidate-by-subject matrix only belongs on the Summary report,
   which already fetches it once.
========================================================================= */

// Standard competition ranking (1, 2, 2, 4, ...) within each class, by
// average_percentage descending. Candidates with no scored subject yet
// get a null position (rendered as "—") rather than a fabricated rank.
function assignClassPositions(rows) {
  const byClass = new Map();
  rows.forEach((r) => {
    const key = r.class || `__year_${r.year_of_study || "unknown"}`;
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(r);
  });
  byClass.forEach((group) => {
    group.sort((a, b) => {
      if (a.average_percentage == null && b.average_percentage == null) return 0;
      if (a.average_percentage == null) return 1;
      if (b.average_percentage == null) return -1;
      return b.average_percentage - a.average_percentage;
    });
    let rank = 0, seen = 0, lastScore = null;
    group.forEach((r) => {
      seen += 1;
      if (r.average_percentage == null) { r.class_position = null; return; }
      if (lastScore === null || r.average_percentage !== lastScore) {
        rank = seen;
        lastScore = r.average_percentage;
      }
      r.class_position = rank;
    });
  });
}

// Short column codes for the Nominal Roll (§30.1) — this schema has no
// subject-code table, so codes are derived deterministically from the
// subject name (first 4 letters/digits, uppercased) and de-duplicated
// within THIS exam's subject list only. Re-derived on every request
// rather than stored, so renaming a subject or adding a new one that
// happens to collide never leaves a stale code lying around — the
// trade-off is a subject's code can shift if another subject with a
// clashing prefix is added/removed later in the same exam, which is
// why the roll always ships a code→name key alongside it (§51 — never
// show a code without also showing what it means).
function assignSubjectCodes(subjects) {
  const taken = new Set();
  const codeBySessionId = new Map();
  subjects.forEach((s) => {
    const clean = String(s.subject || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const base = clean.slice(0, 4) || "SUBJ";
    let code = base;
    let suffix = 1;
    while (taken.has(code)) {
      suffix += 1;
      code = `${base.slice(0, 3)}${suffix}`;
    }
    taken.add(code);
    codeBySessionId.set(s.session_id, code);
  });
  return codeBySessionId;
}

async function loadNominalRoll(pool, mainExaminationId) {
  const allSubjects = await loadSubjectsWithAssessment(pool, mainExaminationId);
  const subjects = allSubjects.filter((s) => s.e_assessment_id);
  if (!subjects.length) return { subjects: [], rows: [] };

  const subjectCodes = assignSubjectCodes(subjects);
  const eAssessmentIds = [...new Set(subjects.map((s) => s.e_assessment_id))];

  // Every registered candidate — same EXISTS matching rule as
  // computeMainExaminationSummary's `registered` count (§51).
  const candidatesResult = await pool.request().input("mainExaminationId", sql.Int, mainExaminationId).query(`
    SELECT DISTINCT st.id AS student_id, st.name, st.admissionNo, st.gender, st.studentClass, st.yearOfStudy
    FROM Students st
    WHERE EXISTS (
      SELECT 1 FROM exam_subject_sessions ess
      JOIN e_assessments ea ON ea.id = ess.e_assessment_id
      LEFT JOIN Classes c ON c.id = ea.class_id
      WHERE ess.main_examination_id = @mainExaminationId
        AND ( (c.name IS NOT NULL AND c.name = st.studentClass) OR ea.year_of_study = st.yearOfStudy )
    )
  `);
  const candidates = candidatesResult.recordset;
  if (!candidates.length) return { subjects: subjects.map((s) => ({ session_id: s.session_id, subject: s.subject, code: subjectCodes.get(s.session_id), total_marks: s.total_marks })), rows: [] };

  const idParams = eAssessmentIds.map((_, i) => `@eid${i}`).join(",");
  const subReq = pool.request();
  eAssessmentIds.forEach((eid, i) => subReq.input(`eid${i}`, sql.Int, eid));
  const submissionsResult = await subReq.query(`
    SELECT student_id, e_assessment_id, score
    FROM e_assessment_submissions
    WHERE e_assessment_id IN (${idParams})
  `);
  const scoreMap = new Map(); // `${student_id}:${e_assessment_id}` -> score
  submissionsResult.recordset.forEach((r) => scoreMap.set(`${r.student_id}:${r.e_assessment_id}`, r.score));

  const rows = candidates.map((st) => {
    let totalObtained = 0, totalPossible = 0, anyScored = false;
    const marks = subjects.map((subj) => {
      const registered = (subj.class_name && subj.class_name === st.studentClass) || subj.year_of_study === st.yearOfStudy;
      if (!registered) return { session_id: subj.session_id, not_registered: true, score: null, total_marks: subj.total_marks, percentage: null };
      const score = scoreMap.has(`${st.student_id}:${subj.e_assessment_id}`) ? scoreMap.get(`${st.student_id}:${subj.e_assessment_id}`) : null;
      if (score != null) {
        totalObtained += score;
        totalPossible += subj.total_marks || 0;
        anyScored = true;
      }
      return {
        session_id: subj.session_id,
        not_registered: false,
        score,
        total_marks: subj.total_marks,
        percentage: score != null && subj.total_marks > 0 ? round1((score / subj.total_marks) * 100) : null,
      };
    });
    return {
      student_id: st.student_id,
      name: st.name,
      admission_no: st.admissionNo,
      gender: st.gender,
      class: st.studentClass,
      year_of_study: st.yearOfStudy,
      marks,
      total_obtained: anyScored ? totalObtained : null,
      total_possible: anyScored ? totalPossible : null,
      average_percentage: anyScored && totalPossible > 0 ? round1((totalObtained / totalPossible) * 100) : null,
    };
  });

  assignClassPositions(rows);
  rows.sort((a, b) => {
    const classCmp = String(a.class || "").localeCompare(String(b.class || ""));
    if (classCmp !== 0) return classCmp;
    if (a.class_position == null && b.class_position == null) return String(a.name || "").localeCompare(String(b.name || ""));
    if (a.class_position == null) return 1;
    if (b.class_position == null) return -1;
    return a.class_position - b.class_position;
  });

  return {
    subjects: subjects.map((s) => ({ session_id: s.session_id, subject: s.subject, code: subjectCodes.get(s.session_id), total_marks: s.total_marks })),
    rows,
  };
}

/* =========================================================================
   1. MAIN EXAMINATION ANALYTICS  (§16-§18)
   GET /main-exams/:id/analytics
========================================================================= */
const getMainExamAnalytics = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const summary = await computeMainExaminationSummary(pool, id);
    if (summary.notFound) return res.status(404).json({ success: false, message: "Main examination not found" });

    res.json({ success: true, ...summary });
  } catch (err) {
    console.error("GET MAIN EXAM ANALYTICS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading analytics" });
  }
};

/* =========================================================================
   2. SUBJECT ANALYTICS  (§19-§25)
   GET /main-exams/:mainExamId/subjects/:subjectId/analytics
========================================================================= */
const getSubjectAnalytics = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const subjectId = toInt(req.params.subjectId);
    if (!mainExamId || !subjectId) return res.status(400).json({ success: false, message: "Invalid id" });

    const sessionResult = await pool.request()
      .input("id", sql.Int, subjectId).input("mainExamId", sql.Int, mainExamId)
      .query(`
        SELECT ess.*, ea.title AS assessment_title, ea.total_marks, ea.class_id, ea.year_of_study, c.name AS class_name
        FROM exam_subject_sessions ess
        LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        LEFT JOIN Classes c ON c.id = ea.class_id
        WHERE ess.id = @id AND ess.main_examination_id = @mainExamId
      `);
    const session = sessionResult.recordset[0];
    if (!session) return res.status(404).json({ success: false, message: "Subject session not found" });

    if (!session.e_assessment_id) {
      return res.json({
        success: true,
        subject: session,
        candidate_stats: null,
        performance: null,
        questions: [],
        mcq_distractors: [],
        discrimination_note: "Unavailable for this assessment — no assessment is attached to this subject yet.",
        topic_analytics: null,
        topic_analytics_note: "Unavailable — this question schema has no topic/competency field.",
        time_analytics: null,
        marking: null,
        note: "No assessment attached to this subject yet — nothing to analyze.",
      });
    }
    const eAssessmentId = session.e_assessment_id;

    // ---- Candidate stats ----
    const registeredResult = await pool.request()
      .input("classId", sql.Int, session.class_id || 0)
      .input("year", sql.Int, session.year_of_study || 0)
      .query(`
        SELECT COUNT(DISTINCT st.id) AS registered
        FROM Students st
        LEFT JOIN Classes c ON c.id = @classId
        WHERE (c.name IS NOT NULL AND c.name = st.studentClass) OR st.yearOfStudy = @year
      `);
    const registered = registeredResult.recordset[0]?.registered || 0;

    const activityResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT
        (SELECT COUNT(DISTINCT student_id) FROM e_assessment_submissions WHERE e_assessment_id = @eid) AS completed,
        (SELECT COUNT(DISTINCT student_id) FROM (
            SELECT student_id FROM e_assessment_exam_sessions WHERE e_assessment_id = @eid
            UNION
            SELECT student_id FROM e_assessment_submissions WHERE e_assessment_id = @eid
        ) x) AS attempted
    `);
    const activity = activityResult.recordset[0] || {};
    const attempted = activity.attempted || 0;
    const completed = activity.completed || 0;
    const absent = Math.max(0, registered - attempted);
    const candidate_stats = { registered, attempted, completed, absent };

    // ---- Performance ----
    const passMark = await getPassMark(pool);
    const perfResult = await pool.request().input("eid", sql.Int, eAssessmentId).input("passMark", sql.Float, passMark).query(`
      SELECT
        COUNT(*) AS n,
        AVG(pct.p) AS mean, MIN(pct.p) AS lowest, MAX(pct.p) AS highest, STDEV(pct.p) AS std_dev,
        SUM(CASE WHEN pct.p >= @passMark THEN 1 ELSE 0 END) AS passed,
        (SELECT TOP 1 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pct2.p) OVER () FROM (
            SELECT CAST(s2.score AS FLOAT) * 100.0 / ea2.total_marks AS p
            FROM e_assessment_submissions s2 JOIN e_assessments ea2 ON ea2.id = s2.e_assessment_id
            WHERE s2.e_assessment_id = @eid AND s2.score IS NOT NULL AND ea2.total_marks > 0
        ) pct2) AS median
      FROM (
        SELECT CAST(s.score AS FLOAT) * 100.0 / ea.total_marks AS p
        FROM e_assessment_submissions s JOIN e_assessments ea ON ea.id = s.e_assessment_id
        WHERE s.e_assessment_id = @eid AND s.score IS NOT NULL AND ea.total_marks > 0
      ) pct
    `);
    const perfRow = perfResult.recordset[0] || {};
    const performance = {
      mean: round1(perfRow.mean), median: round1(perfRow.median),
      highest: round1(perfRow.highest), lowest: round1(perfRow.lowest),
      std_dev: round1(perfRow.std_dev), sample_size: perfRow.n || 0,
      pass_mark: passMark,
      pass_rate: perfRow.n ? pct(perfRow.passed, perfRow.n) : null,
      pass_rate_note: perfRow.n ? `Candidates scoring at or above the configured pass mark (${passMark}%).` : "Unavailable — no candidates have been scored yet.",
    };

    // ---- Question-level analytics (§19-§21) ----
    const questionsResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT id, question_text, question_type, marks FROM e_assessment_questions
      WHERE e_assessment_id = @eid ORDER BY id
    `);
    const questions = questionsResult.recordset;

    const totalSubmissionsResult = await pool.request().input("eid", sql.Int, eAssessmentId)
      .query(`SELECT COUNT(*) AS n FROM e_assessment_submissions WHERE e_assessment_id = @eid`);
    const totalSubmissions = totalSubmissionsResult.recordset[0]?.n || 0;

    let questionStats = [];
    let mcqDistractors = [];
    if (questions.length) {
      const answerStatsResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
        SELECT
          a.question_id,
          COUNT(*) AS answer_rows,
          SUM(CASE WHEN q.question_type <> 'essay' AND a.selected_answer IS NOT NULL AND LTRIM(RTRIM(a.selected_answer)) <> '' THEN 1 ELSE 0 END) AS mcq_answered,
          SUM(CASE WHEN q.question_type <> 'essay' AND a.is_correct = 1 THEN 1 ELSE 0 END) AS mcq_correct,
          SUM(CASE WHEN q.question_type <> 'essay' AND a.is_correct = 0 THEN 1 ELSE 0 END) AS mcq_incorrect,
          SUM(CASE WHEN q.question_type = 'essay' AND a.essay_answer IS NOT NULL AND LTRIM(RTRIM(a.essay_answer)) <> '' THEN 1 ELSE 0 END) AS essay_answered,
          AVG(CASE WHEN a.marks_awarded IS NOT NULL THEN CAST(a.marks_awarded AS FLOAT) END) AS avg_marks_awarded
        FROM e_assessment_answers a
        JOIN e_assessment_questions q ON q.id = a.question_id
        JOIN e_assessment_submissions s ON s.id = a.submission_id
        WHERE q.e_assessment_id = @eid
        GROUP BY a.question_id
      `);
      const answerStatsMap = {};
      answerStatsResult.recordset.forEach((r) => { answerStatsMap[r.question_id] = r; });

      const optionsResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
        SELECT q.id AS question_id, q.correct_answer, o.option_label, o.option_text,
          (SELECT COUNT(*) FROM e_assessment_answers a2
             WHERE a2.question_id = q.id AND a2.selected_answer = o.option_label) AS picked
        FROM e_assessment_questions q
        JOIN e_assessment_options o ON o.question_id = q.id
        WHERE q.e_assessment_id = @eid
        ORDER BY q.id, o.id
      `);
      const optionsByQuestion = {};
      optionsResult.recordset.forEach((r) => {
        if (!optionsByQuestion[r.question_id]) optionsByQuestion[r.question_id] = { correct_answer: r.correct_answer, options: [] };
        optionsByQuestion[r.question_id].options.push({ option_label: r.option_label, option_text: r.option_text, picked: r.picked || 0 });
      });

      questionStats = questions.map((q) => {
        const st = answerStatsMap[q.id] || {};
        const isEssay = q.question_type === "essay";
        const answered = isEssay ? (st.essay_answered || 0) : (st.mcq_answered || 0);
        const unanswered = Math.max(0, totalSubmissions - answered);
        const correctPct = isEssay ? null : pct(st.mcq_correct || 0, totalSubmissions);
        const incorrectPct = isEssay ? null : pct(st.mcq_incorrect || 0, totalSubmissions);
        return {
          question_id: q.id,
          question_text: q.question_text,
          question_type: q.question_type,
          marks: q.marks,
          attempts: answered,
          correct_pct: correctPct,
          incorrect_pct: incorrectPct,
          unanswered_pct: pct(unanswered, totalSubmissions),
          avg_marks_awarded: round1(st.avg_marks_awarded),
          difficulty: isEssay
            ? (st.avg_marks_awarded != null && totalSubmissions >= MIN_DIFFICULTY_SAMPLE
                ? difficultyLabel(pct(st.avg_marks_awarded, q.marks || 1), totalSubmissions)
                : "Insufficient data")
            : difficultyLabel(correctPct, totalSubmissions),
        };
      });

      mcqDistractors = questions
        .filter((q) => q.question_type !== "essay" && optionsByQuestion[q.id])
        .map((q) => {
          const entry = optionsByQuestion[q.id];
          const denom = (answerStatsMap[q.id]?.mcq_answered) || 0;
          return {
            question_id: q.id,
            question_text: q.question_text,
            options: entry.options.map((o) => ({
              option_label: o.option_label,
              option_text: o.option_text,
              is_correct: entry.correct_answer && o.option_label &&
                String(entry.correct_answer).trim().toLowerCase() === String(o.option_label).trim().toLowerCase(),
              pct_selected: denom > 0 ? pct(o.picked, denom) : null,
            })),
          };
        });
    }

    // ---- Discrimination (§22) — top/bottom 27% split on scored submissions ----
    let discrimination = [];
    let discriminationNote = null;
    const scoredResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT id AS submission_id, score FROM e_assessment_submissions
      WHERE e_assessment_id = @eid AND score IS NOT NULL ORDER BY score DESC
    `);
    const scored = scoredResult.recordset;
    if (scored.length < MIN_DISCRIMINATION_SAMPLE) {
      discriminationNote = "Insufficient data — discrimination needs at least 10 scored submissions.";
    } else {
      const groupSize = Math.max(1, Math.round(scored.length * DISCRIMINATION_GROUP_FRACTION));
      const topIds = scored.slice(0, groupSize).map((r) => r.submission_id);
      const bottomIds = scored.slice(-groupSize).map((r) => r.submission_id);
      const idList = (arr, prefix) => arr.map((_, i) => `@${prefix}${i}`).join(",");
      const req1 = pool.request().input("eid", sql.Int, eAssessmentId);
      topIds.forEach((v, i) => req1.input(`top${i}`, sql.Int, v));
      bottomIds.forEach((v, i) => req1.input(`bot${i}`, sql.Int, v));
      const discResult = await req1.query(`
        SELECT
          a.question_id,
          SUM(CASE WHEN a.submission_id IN (${idList(topIds, "top")}) AND a.is_correct = 1 THEN 1 ELSE 0 END) AS top_correct,
          SUM(CASE WHEN a.submission_id IN (${idList(bottomIds, "bot")}) AND a.is_correct = 1 THEN 1 ELSE 0 END) AS bottom_correct
        FROM e_assessment_answers a
        JOIN e_assessment_questions q ON q.id = a.question_id
        WHERE q.e_assessment_id = @eid AND q.question_type <> 'essay'
          AND (a.submission_id IN (${idList(topIds, "top")}) OR a.submission_id IN (${idList(bottomIds, "bot")}))
        GROUP BY a.question_id
      `);
      discrimination = discResult.recordset.map((r) => {
        const index = round1((r.top_correct - r.bottom_correct) / groupSize);
        return { question_id: r.question_id, discrimination_index: index, label: discriminationLabel(index) };
      });
    }

    // ---- Time analytics (§24) — from real activated_at/ended_at timestamps ----
    const timeResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT DATEDIFF(minute, es.activated_at, COALESCE(sub.submitted_at, es.ended_at)) AS minutes
      FROM e_assessment_exam_sessions es
      LEFT JOIN e_assessment_submissions sub ON sub.e_assessment_id = es.e_assessment_id AND sub.student_id = es.student_id
      WHERE es.e_assessment_id = @eid AND es.activated_at IS NOT NULL
        AND COALESCE(sub.submitted_at, es.ended_at) IS NOT NULL
    `);
    const minutesList = timeResult.recordset.map((r) => r.minutes).filter((m) => m != null && m >= 0);
    let timeAnalytics = null;
    if (minutesList.length) {
      const sorted = [...minutesList].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      timeAnalytics = {
        average_minutes: round1(minutesList.reduce((a, b) => a + b, 0) / minutesList.length),
        median_minutes: sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2),
        fastest_minutes: sorted[0],
        longest_minutes: sorted[sorted.length - 1],
        sample_size: minutesList.length,
      };
    }

    // ---- Marking analytics (§25) ----
    const markingResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT
        (SELECT COUNT(*) FROM e_assessment_submissions WHERE e_assessment_id = @eid) AS total_submissions,
        (SELECT COUNT(*) FROM e_assessment_submissions WHERE e_assessment_id = @eid AND status IN ('marked','released')) AS submissions_marked,
        (SELECT COUNT(*) FROM e_assessment_submissions WHERE e_assessment_id = @eid AND status = 'submitted') AS submissions_awaiting,
        (SELECT COUNT(*) FROM e_assessment_answers a JOIN e_assessment_questions q ON q.id = a.question_id
           WHERE q.e_assessment_id = @eid AND q.question_type <> 'essay' AND a.is_correct IS NOT NULL) AS mcq_auto_marked,
        (SELECT COUNT(*) FROM e_assessment_answers a JOIN e_assessment_questions q ON q.id = a.question_id
           JOIN e_assessment_submissions s2 ON s2.id = a.submission_id
           WHERE q.e_assessment_id = @eid AND q.question_type = 'essay') AS essays_total,
        (SELECT COUNT(*) FROM e_assessment_answers a JOIN e_assessment_questions q ON q.id = a.question_id
           WHERE q.e_assessment_id = @eid AND q.question_type = 'essay' AND a.marks_awarded IS NOT NULL) AS essays_marked
    `);
    const mk = markingResult.recordset[0] || {};
    const essaysAwaiting = Math.max(0, (mk.essays_total || 0) - (mk.essays_marked || 0));

    const markersResult = await pool.request().input("eid", sql.Int, eAssessmentId).query(`
      SELECT t.id AS teacher_id, t.name AS teacher_name,
        COUNT(DISTINCT aa.submission_id) AS assigned,
        SUM(CASE WHEN s.status IN ('marked','released') THEN 1 ELSE 0 END) AS marked
      FROM e_assessment_submission_assignments aa
      JOIN e_assessment_submissions s ON s.id = aa.submission_id
      LEFT JOIN Teachers t ON t.id = aa.teacher_id
      WHERE s.e_assessment_id = @eid
      GROUP BY t.id, t.name
    `);
    const markers = markersResult.recordset.map((r) => ({
      teacher_id: r.teacher_id,
      teacher_name: r.teacher_name || "Unassigned",
      assigned: r.assigned || 0,
      marked: r.marked || 0,
      remaining: Math.max(0, (r.assigned || 0) - (r.marked || 0)),
      average_marking_time: null, // not tracked anywhere in the schema — never invented (§50)
    }));

    const marking = {
      total_submissions: mk.total_submissions || 0,
      submissions_marked: mk.submissions_marked || 0,
      submissions_awaiting: mk.submissions_awaiting || 0,
      mcq_auto_marked: mk.mcq_auto_marked || 0,
      essays_total: mk.essays_total || 0,
      essays_marked: mk.essays_marked || 0,
      essays_awaiting: essaysAwaiting,
      marking_completion_pct: mk.essays_total ? pct(mk.essays_marked || 0, mk.essays_total) : 100,
      markers,
    };

    res.json({
      success: true,
      subject: session,
      candidate_stats,
      performance,
      questions: questionStats,
      mcq_distractors: mcqDistractors,
      discrimination,
      discrimination_note: discriminationNote,
      topic_analytics: null,
      topic_analytics_note: "Unavailable — this question schema has no topic/competency field yet (§23).",
      time_analytics: timeAnalytics,
      time_analytics_note: timeAnalytics ? null : "Not enough data — no completed sessions have both a start and end timestamp yet.",
      marking,
    });
  } catch (err) {
    console.error("GET SUBJECT ANALYTICS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading subject analytics" });
  }
};

/* =========================================================================
   3. STUDENT ANALYTICS LIST  (§18)
   GET /main-exams/:id/analytics/students
========================================================================= */
const getMainExamStudentAnalytics = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const search = (req.query.search || "").trim();
    const request = pool.request().input("mainExaminationId", sql.Int, id);
    let searchClause = "";
    if (search) {
      request.input("search", sql.NVarChar, `%${search}%`);
      searchClause = "AND (st.name LIKE @search OR st.admissionNo LIKE @search)";
    }

    const result = await request.query(`
      WITH registered AS (
        SELECT DISTINCT st.id AS student_id, ess.id AS session_id, ess.e_assessment_id
        FROM Students st
        JOIN exam_subject_sessions ess ON ess.main_examination_id = @mainExaminationId
        JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        LEFT JOIN Classes c ON c.id = ea.class_id
        WHERE (c.name IS NOT NULL AND c.name = st.studentClass) OR ea.year_of_study = st.yearOfStudy
      )
      SELECT
        r.student_id, st.name, st.admissionNo,
        COUNT(DISTINCT r.session_id) AS subjects_registered,
        COUNT(DISTINCT sub.id) AS subjects_completed,
        AVG(CASE WHEN sub.score IS NOT NULL AND ea2.total_marks > 0
                  THEN CAST(sub.score AS FLOAT) * 100.0 / ea2.total_marks END) AS overall_average
      FROM registered r
      JOIN Students st ON st.id = r.student_id
      LEFT JOIN e_assessment_submissions sub ON sub.e_assessment_id = r.e_assessment_id AND sub.student_id = r.student_id
      LEFT JOIN e_assessments ea2 ON ea2.id = r.e_assessment_id
      WHERE 1=1 ${searchClause}
      GROUP BY r.student_id, st.name, st.admissionNo
      ORDER BY st.name
    `);

    const students = result.recordset.map((r) => ({
      student_id: r.student_id,
      name: r.name,
      admission_no: r.admissionNo,
      subjects_registered: r.subjects_registered,
      subjects_completed: r.subjects_completed,
      subjects_incomplete: Math.max(0, r.subjects_registered - r.subjects_completed),
      overall_average: round1(r.overall_average),
    }));

    res.json({ success: true, students });
  } catch (err) {
    console.error("GET MAIN EXAM STUDENT ANALYTICS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading student analytics" });
  }
};

/* =========================================================================
   4. STUDENT EXAMINATION PROFILE  (§18 drill-down)
   GET /main-exams/:id/analytics/students/:studentId
========================================================================= */
const getStudentExaminationProfile = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const studentId = toInt(req.params.studentId);
    if (!id || !studentId) return res.status(400).json({ success: false, message: "Invalid id" });

    const studentResult = await pool.request().input("studentId", sql.Int, studentId)
      .query(`SELECT id, name, admissionNo, studentClass, yearOfStudy FROM Students WHERE id = @studentId`);
    const student = studentResult.recordset[0];
    if (!student) return res.status(404).json({ success: false, message: "Student not found" });

    const rowsResult = await pool.request()
      .input("mainExaminationId", sql.Int, id)
      .input("studentId", sql.Int, studentId)
      .input("studentClass", sql.NVarChar, student.studentClass || "")
      .input("yearOfStudy", sql.Int, student.yearOfStudy || 0)
      .query(`
        SELECT
          ess.id AS session_id, ess.subject, ess.status AS session_status, ess.exam_date,
          ea.total_marks,
          sub.score, sub.status AS submission_status, sub.submitted_at
        FROM exam_subject_sessions ess
        JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        LEFT JOIN Classes c ON c.id = ea.class_id
        LEFT JOIN e_assessment_submissions sub ON sub.e_assessment_id = ess.e_assessment_id AND sub.student_id = @studentId
        WHERE ess.main_examination_id = @mainExaminationId
          AND ( (c.name IS NOT NULL AND c.name = @studentClass) OR ea.year_of_study = @yearOfStudy )
        ORDER BY ess.start_time ASC, ess.id ASC
      `);

    const subjects = rowsResult.recordset.map((r) => {
      const percentage = r.score != null && r.total_marks > 0 ? round1((r.score / r.total_marks) * 100) : null;
      let status;
      if (r.score != null) status = "completed";
      else if (r.session_status === "ended" || r.session_status === "completed") status = "absent";
      else status = "upcoming";
      return {
        session_id: r.session_id,
        subject: r.subject,
        exam_date: r.exam_date,
        status,
        score: r.score,
        total_marks: r.total_marks,
        percentage,
      };
    });

    const scored = subjects.filter((s) => s.percentage != null);
    const overallAverage = scored.length ? round1(scored.reduce((a, s) => a + s.percentage, 0) / scored.length) : null;

    res.json({
      success: true,
      student: { id: student.id, name: student.name, admission_no: student.admissionNo, class: student.studentClass, year_of_study: student.yearOfStudy },
      overall_average: overallAverage,
      subjects_completed: scored.length,
      subjects_absent: subjects.filter((s) => s.status === "absent").length,
      subjects_upcoming: subjects.filter((s) => s.status === "upcoming").length,
      subjects,
    });
  } catch (err) {
    console.error("GET STUDENT EXAMINATION PROFILE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading student profile" });
  }
};

module.exports = {
  getMainExamAnalytics,
  getSubjectAnalytics,
  getMainExamStudentAnalytics,
  getStudentExaminationProfile,
  // Exported for Phase 11 report generation — same computation, so the
  // dashboard and the downloadable "Main Examination Summary" /
  // "Grade Distribution" reports can never disagree (§51).
  computeMainExaminationSummary,
  loadSubjectsWithAssessment,
  loadNominalRoll,
  // Exported so the Overview dashboard (mainExam.controller.js's
  // getMainExaminationDashboard) reads the pass mark from the exact
  // same place Analytics does, instead of a second copy of this
  // lookup drifting out of sync with it.
  getPassMark,
};