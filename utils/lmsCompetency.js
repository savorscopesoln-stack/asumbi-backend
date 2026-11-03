/* =========================================================================
   LMS COMPETENCY TRACKING  (L9.4, D-110)  outcome mastery from RELEASED rubric marks and GRADED quiz answers. READ ONLY, no schema step, no AI, nothing audited (a read).
   Routes (flag `lms_competency` FIRST, every answer `no-store`):
     STAFF   GET /courses/:id/competency                      course summary per outcome (counts only, nobody named)   [lms.gradebook.view + course staff]
     STAFF   GET /courses/:id/competency/learners/:studentId  ONE learner's mastery + evidence list                    [lms.gradebook.view + course staff]
     LEARNER GET /courses/:id/learn/competency                MY outcomes + MY evidence only (studentOnly + ACTIVE enrolment)
   EVIDENCE (what counts; the same rules a teacher can check by hand):
   - Rubric: a criterion tagged with an outcome (`lms_outcome_tags`, entity 'rubric_criterion') scored on the learner's LATEST submitted attempt of a non-deleted assignment of
     THIS course, and only when the grade is RETURNED (released). Draft marks never count. Fraction = points / the highest level points of the criterion. When one submission
     has several criteria with the same outcome they form ONE evidence item (sum of points / sum of maxima). The criterion must belong to the rubric the grade used.
   - Quiz: answers to questions tagged with an outcome (entity 'question', through the frozen snapshot's `source_question_id`) in a GRADED attempt (no essay still waiting)
     of a COURSEWORK quiz that counts to the grade (`counts_to_grade` = 1). Practice, revision, mock and flashcards NEVER count (Q96). One evidence item per quiz and outcome:
     the learner's BEST attempt (highest fraction; the earlier attempt wins a tie). Fraction = sum of points / sum of maximum points of the tagged answers.
   - Only ACTIVE learners of the course; only live (not retired) outcomes. Outcome tags are current state: re-tagging later changes what past work counts toward.
   MASTERY RULE: mastery % = the mean of the learner's evidence fractions for the outcome x 100 (rounded to 2 decimals). Fewer than MIN_EVIDENCE (2) items = band
   `insufficient_evidence` and NO number. Bands: below 40 `beginning`, 40 to under 70 `developing`, 70 and above `secure` (DEFAULTS; per-tenant `competency` settings {minEvidence 1-10, developingFrom 1-99, secureFrom 2-100, developingFrom < secureFrom}, D-111 / Q95; a bad stored value = the defaults).
   A band is a summary of the evidence shown beside it, never a verdict: the evidence list (source, title, date, points, percent) is always returned with it.
   LIMITS: staff course summary reads at most 2000 ACTIVE learners and 100000 evidence rows (409 TOO_MANY_LEARNERS / TOO_MUCH_EVIDENCE); a single learner at most 5000 rows.
   Staff summary never names a learner and never returns an admission number; only the per-learner route returns the name. Practicum evidence is not linked (module not
   assumed licensed; logged).
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");

const MIN_EVIDENCE = 2, DEVELOPING_FROM = 40, SECURE_FROM = 70; // the DEFAULTS; a school may change them in `competency` settings (D-111)
const { getSettings } = require("./lmsSettings");
const MAX_LEARNERS = 2000, MAX_ROWS = 100000, MAX_LEARNER_ROWS = 5000, MAX_PAGE = 100, DEFAULT_PAGE = 50;
const BANDS = ["insufficient_evidence", "beginning", "developing", "secure"];
const DEFAULT_TH = Object.freeze({ minEvidence: MIN_EVIDENCE, developingFrom: DEVELOPING_FROM, secureFrom: SECURE_FROM });
/* Pure. Any stored value -> three whole numbers in range with developingFrom < secureFrom, else the defaults (a bad or half-bad setting never breaks a report). */
function normThresholds(v) {
  const x = v && typeof v === "object" ? v : {}, ok = (k, lo, hi) => Number.isInteger(x[k]) && x[k] >= lo && x[k] <= hi;
  if (!ok("minEvidence", 1, 10) || !ok("developingFrom", 1, 99) || !ok("secureFrom", 2, 100) || x.developingFrom >= x.secureFrom) return { ...DEFAULT_TH };
  return { minEvidence: x.minEvidence, developingFrom: x.developingFrom, secureFrom: x.secureFrom };
}
/* Pure. The rule as shown to staff and learners, built from the thresholds actually used. */
const ruleFor = (th = DEFAULT_TH) => ({ minEvidence: th.minEvidence, developingFromPercent: th.developingFrom, secureFromPercent: th.secureFrom,
  text: `Mastery is the mean of your best evidence for the outcome. It needs at least ${th.minEvidence} piece${th.minEvidence === 1 ? "" : "s"} of evidence; below ${th.developingFrom}% is beginning, ${th.developingFrom}% to under ${th.secureFrom}% is developing, ${th.secureFrom}% and above is secure. Only released marks and fully marked coursework quizzes count.` });
const RULE = ruleFor();

const notFound = () => ({ ok: false, notFound: true, errors: ["Course not found."] });
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const staffGate = (user, courseId) => { const a = actorOf(user); const cid = posInt(courseId); return !a || a.role === "student" || !cid ? null : cid; };

/* Pure. mastery percent -> band. null (not enough evidence) is handled by `summarise`. */
function bandFor(percent, th = DEFAULT_TH) { return percent < th.developingFrom ? "beginning" : percent < th.secureFrom ? "developing" : "secure"; }

/* Pure. [{fraction 0..1}] -> {evidenceCount, masteryPercent|null, band}. */
function summarise(items, th = DEFAULT_TH) {
  const n = (items || []).length;
  if (n < th.minEvidence) return { evidenceCount: n, masteryPercent: null, band: "insufficient_evidence" };
  const mean = items.reduce((a, x) => a + clamp01(Number(x.fraction) || 0), 0) / n;
  const p = r2(mean * 100);
  return { evidenceCount: n, masteryPercent: p, band: bandFor(p, th) };
}

/* Pure. Raw SQL rows -> evidence items. Rubric rows are already one per submission and outcome; quiz rows are one per ATTEMPT and outcome, so keep the BEST attempt per
   (learner, outcome, quiz). Rows with no positive maximum are dropped. */
function toEvidence(rubricRows, quizRows) {
  const out = [];
  for (const x of rubricRows || []) {
    const max = Number(x.max_pts); if (!(max > 0)) continue;
    out.push({ studentId: x.student_id, outcomeId: x.outcome_id, code: x.code, outcomeTitle: x.outcome_title, source: "assignment", sourceId: x.source_id, title: x.source_title,
      at: iso(x.at_time), points: r2(Number(x.pts) || 0), maxPoints: r2(max), fraction: clamp01((Number(x.pts) || 0) / max) });
  }
  const best = new Map();
  for (const x of quizRows || []) {
    const max = Number(x.max_pts); if (!(max > 0)) continue;
    const e = { studentId: x.student_id, outcomeId: x.outcome_id, code: x.code, outcomeTitle: x.outcome_title, source: "quiz", sourceId: x.source_id, title: x.source_title,
      at: iso(x.at_time), points: r2(Number(x.pts) || 0), maxPoints: r2(max), fraction: clamp01((Number(x.pts) || 0) / max), attemptId: x.attempt_id };
    const k = `${e.studentId}|${e.outcomeId}|${e.sourceId}`, cur = best.get(k);
    if (!cur || e.fraction > cur.fraction || (e.fraction === cur.fraction && e.attemptId < cur.attemptId)) best.set(k, e);
  }
  for (const e of best.values()) { delete e.attemptId; out.push(e); }
  return out;
}

/* Pure. evidence items of ONE learner -> outcomes (code order), each with its summary and its evidence list (newest first). */
function perLearner(items, th = DEFAULT_TH) {
  const m = new Map();
  for (const e of items) { if (!m.has(e.outcomeId)) m.set(e.outcomeId, { outcomeId: e.outcomeId, code: e.code, title: e.outcomeTitle, list: [] }); m.get(e.outcomeId).list.push(e); }
  return [...m.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)) || a.outcomeId - b.outcomeId).map((o) => ({
    outcomeId: o.outcomeId, code: o.code, title: o.title, ...summarise(o.list, th),
    evidence: o.list.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")) || b.sourceId - a.sourceId)
      .map((e) => ({ source: e.source, sourceId: e.sourceId, title: e.title, at: e.at, points: e.points, maxPoints: e.maxPoints, percent: r2(e.fraction * 100) })),
  }));
}

/* Pure. evidence of MANY learners -> per outcome counts only (no learner is named or listed). */
function perOutcome(items, th = DEFAULT_TH) {
  const m = new Map();
  for (const e of items) {
    let o = m.get(e.outcomeId); if (!o) { o = { outcomeId: e.outcomeId, code: e.code, title: e.outcomeTitle, byLearner: new Map() }; m.set(e.outcomeId, o); }
    if (!o.byLearner.has(e.studentId)) o.byLearner.set(e.studentId, []); o.byLearner.get(e.studentId).push(e);
  }
  return [...m.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)) || a.outcomeId - b.outcomeId).map((o) => {
    const bands = { insufficient_evidence: 0, beginning: 0, developing: 0, secure: 0 }; let evidenceItems = 0;
    for (const list of o.byLearner.values()) { bands[summarise(list, th).band] += 1; evidenceItems += list.length; }
    return { outcomeId: o.outcomeId, code: o.code, title: o.title, learnersWithEvidence: o.byLearner.size, evidenceItems, bands };
  });
}

/* Fixed SQL: `@c` course, `@s` one learner or NULL. ACTIVE enrolment is part of every query. `top` is a validated integer. */
const rubricSql = (top) => `SELECT TOP ${top} s.student_id, t.outcome_id, o.code, o.title AS outcome_title, a.id AS source_id, a.title AS source_title, MAX(g.returned_at) AS at_time,
    SUM(sc.points) AS pts, SUM(mx.max_points) AS max_pts
  FROM lms_submissions s
  JOIN lms_submission_grades g ON g.submission_id = s.id AND g.status = 'returned' AND g.rubric_id IS NOT NULL
  JOIN lms_assignments a ON a.id = s.assignment_id AND a.course_id = @c AND a.deleted_at IS NULL
  JOIN lms_course_enrolments e ON e.course_id = @c AND e.student_id = s.student_id AND e.status = 'active'
  JOIN lms_submission_rubric_scores sc ON sc.submission_id = s.id
  JOIN lms_rubric_criteria c ON c.id = sc.criterion_id AND c.rubric_id = g.rubric_id
  CROSS APPLY (SELECT MAX(l.points) AS max_points FROM lms_rubric_levels l WHERE l.criterion_id = c.id) mx
  JOIN lms_outcome_tags t ON t.entity_type = 'rubric_criterion' AND t.entity_id = c.id
  JOIN lms_learning_outcomes o ON o.id = t.outcome_id AND o.deleted_at IS NULL
  WHERE s.course_id = @c AND s.status = 'submitted' AND (@s IS NULL OR s.student_id = @s)
    AND s.attempt_no = (SELECT MAX(l2.attempt_no) FROM lms_submissions l2 WHERE l2.assignment_id = s.assignment_id AND l2.student_id = s.student_id AND l2.status = 'submitted')
  GROUP BY s.student_id, t.outcome_id, o.code, o.title, a.id, a.title
  HAVING SUM(mx.max_points) > 0 ORDER BY s.student_id, o.code, a.id`;
const quizSql = (top) => `SELECT TOP ${top} at.student_id, at.id AS attempt_id, q.id AS source_id, q.title AS source_title, t.outcome_id, o.code, o.title AS outcome_title, MAX(at.submitted_at) AS at_time,
    SUM(ans.points) AS pts, SUM(ans.max_points) AS max_pts
  FROM lms_quiz_attempts at
  JOIN lms_quizzes q ON q.id = at.quiz_id AND q.course_id = @c AND q.deleted_at IS NULL AND q.assessment_type = 'coursework' AND q.counts_to_grade = 1
  JOIN lms_course_enrolments e ON e.course_id = @c AND e.student_id = at.student_id AND e.status = 'active'
  JOIN lms_quiz_answers ans ON ans.attempt_id = at.id AND ans.points IS NOT NULL
  JOIN lms_quiz_questions qq ON qq.id = ans.quiz_question_id AND qq.source_question_id IS NOT NULL
  JOIN lms_outcome_tags t ON t.entity_type = 'question' AND t.entity_id = qq.source_question_id
  JOIN lms_learning_outcomes o ON o.id = t.outcome_id AND o.deleted_at IS NULL
  WHERE at.course_id = @c AND at.status = 'graded' AND at.needs_marking = 0 AND (@s IS NULL OR at.student_id = @s)
  GROUP BY at.student_id, at.id, q.id, q.title, t.outcome_id, o.code, o.title
  HAVING SUM(ans.max_points) > 0 ORDER BY at.student_id, o.code, q.id, at.id`;

async function loadEvidence(pool, courseId, studentId, cap) {
  const run = async (text) => { const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).query(text); return r.recordset || []; };
  const [rub, qz] = await Promise.all([run(rubricSql(cap + 1)), run(quizSql(cap + 1))]);
  if (rub.length > cap || qz.length > cap) return null;
  return toEvidence(rub, qz);
}
async function courseStatus(pool, cid) {
  const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0].status : null;
}
const learnerShape = (items, th) => ({ rule: ruleFor(th), outcomes: perLearner(items, th) });
const thresholdsOf = async (pool) => normThresholds((await getSettings(pool)).competency);

/* STAFF. Course summary per outcome. Counts only. */
async function courseCompetency(pool, user, courseId, query = {}) {
  const cid = staffGate(user, courseId); if (!cid) return notFound(); if (!(await courseStatus(pool, cid))) return notFound();
  const pageSize = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE)), page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const n = await pool.request().input("c", sql.Int, cid).query(`SELECT COUNT(*) AS n FROM lms_course_enrolments WHERE course_id = @c AND status = 'active'`);
  const learners = Number(n.recordset?.[0]?.n) || 0; if (learners > MAX_LEARNERS) return { ok: false, code: "TOO_MANY_LEARNERS", errors: [`This report reads at most ${MAX_LEARNERS} active learners.`] };
  const ev = await loadEvidence(pool, cid, null, MAX_ROWS); if (!ev) return { ok: false, code: "TOO_MUCH_EVIDENCE", errors: ["Too much evidence for one report. Narrow the course first."] };
  const th = await thresholdsOf(pool), all = perOutcome(ev, th), start = (page - 1) * pageSize;
  return { ok: true, rule: ruleFor(th), learners, outcomes: all.slice(start, start + pageSize), total: all.length, page, pageSize };
}

/* STAFF. One learner (must be ACTIVE in this course; anyone else = 404). */
async function learnerCompetency(pool, user, courseId, studentId) {
  const cid = staffGate(user, courseId), sid = posInt(studentId); if (!cid || !sid) return notFound(); if (!(await courseStatus(pool, cid))) return notFound();
  const st = await pool.request().input("c", sql.Int, cid).input("s", sql.Int, sid).query(`SELECT TOP 1 s.name AS student_name FROM lms_course_enrolments e JOIN Students s ON s.id = e.student_id WHERE e.course_id = @c AND e.student_id = @s AND e.status = 'active'`);
  const row = st.recordset && st.recordset[0]; if (!row) return notFound();
  const ev = await loadEvidence(pool, cid, sid, MAX_LEARNER_ROWS); if (!ev) return { ok: false, code: "TOO_MUCH_EVIDENCE", errors: ["Too much evidence for one learner."] };
  return { ok: true, student: { id: sid, name: row.student_name }, ...learnerShape(ev, await thresholdsOf(pool)) };
}

/* LEARNER. Always the token's own id, never a parameter. */
async function myCompetency(pool, user, courseId) {
  const a = actorOf(user), cid = posInt(courseId); if (!a || a.source !== "Students" || a.role !== "student" || !cid) return notFound();
  const s = await courseStatus(pool, cid); if (!s || !["published", "archived"].includes(s)) return notFound();
  const ev = await loadEvidence(pool, cid, a.id, MAX_LEARNER_ROWS); if (!ev) return { ok: false, code: "TOO_MUCH_EVIDENCE", errors: ["Too much evidence to show."] };
  return { ok: true, ...learnerShape(ev, await thresholdsOf(pool)) };
}

module.exports = { MIN_EVIDENCE, DEVELOPING_FROM, SECURE_FROM, DEFAULT_TH, BANDS, RULE, normThresholds, ruleFor, bandFor, summarise, toEvidence, perLearner, perOutcome, courseCompetency, learnerCompetency, myCompetency };
