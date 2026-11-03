/* =========================================================================
   LMS TEACHER ATTENTION ANALYTICS  (L9.1a, D-105)  STAFF only, READ ONLY, no schema step, nothing is audited (a read).
   Route (flag `lms_analytics`, then `lms.gradebook.view`, then course owner / co-teacher / admin; `no-store`):
     GET /courses/:id/analytics/attention
   WHAT IT IS: a list of learners a teacher may want to look at, each with the NUMBERS behind it. Alerts are PROMPTS for attention, never verdicts:
   - nobody is ranked, scored or labelled; the list is in NAME order, learners with no alert are not listed (they are only counted);
   - every alert carries `reason` (plain language), `data` (the counts / dates) and `threshold` (the setting that triggered it);
   - names only, never admission numbers. A learner who is not ACTIVE in this course is never included. At most 2000 learners (409 TOO_MANY_LEARNERS).
   Thresholds are PER-TENANT settings (`analytics` in lms_settings; defaults inactiveDays 14, lowQuizPercent 50, lateSharePercent 50), validated 1-365 / 1-100 / 1-100 (Q88).
   Alert rules (the same numbers a teacher can check by hand):
   - inactive: last activity = the latest of: a lesson opened, an assignment handed in, a quiz attempt started. No activity at all = the day the learner joined the course.
     Alert when whole days since then >= inactiveDays.
   - missing_work: PUBLISHED assignments whose due date has passed, where the learner has no SUBMITTED attempt and no still-open extension (the same rule as the submissions report).
     Alert when at least 1; data lists up to 5 (oldest due first).
   - late_pattern: of the learner's submitted assignments (latest submitted attempt each), the share handed in late. Alert when at least 3 submitted and late share >= lateSharePercent.
   - low_quiz: fully MARKED quizzes only (latest attempt per quiz that is graded, max points > 0), each as a percent; the learner's average of those. Alert when at least 2 quizzes and average < lowQuizPercent.
     A quiz still waiting for an essay mark is not counted (never a half score).
   Course summary: learners, learnersWithAlerts, alertCounts per type, completion (same lesson rule as the progress report), timeliness counts, quiz average, outcome coverage
   (only when outcome tags exist for this course: visible lessons, lessons tagged, distinct outcomes tagged).
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { VISIBLE } = require("./lmsLessons");
const { getSettings, DEFAULTS } = require("./lmsSettings");
const { buildProgress } = require("./lmsReports");

const MAX_LEARNERS = 2000, MAX_CELLS = 100000, MAX_ASSIGNMENTS = 200, MAX_QUIZ_ROWS = 100000, LATE_MIN_SUBMITTED = 3, QUIZ_MIN_MARKED = 2, MAX_LISTED = 5;
const DAY = 86400000;
const TYPES = ["inactive", "missing_work", "late_pattern", "low_quiz"];
const notFound = () => ({ ok: false, notFound: true, errors: ["Course not found."] });
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const ms = (v) => { if (!v) return null; const t = new Date(v).getTime(); return Number.isNaN(t) ? null : t; };
const gate = (user, courseId) => { const a = actorOf(user); const cid = posInt(courseId); return !a || a.role === "student" || !cid ? null : cid; };

/* Pure. Any stored value -> the three thresholds, each a whole number in range, else the default. */
function normThresholds(v) {
  const d = DEFAULTS.analytics, x = v && typeof v === "object" ? v : {};
  const pick = (k, min, max) => { const n = Number(x[k]); return Number.isInteger(n) && n >= min && n <= max ? n : d[k]; };
  return { inactiveDays: pick("inactiveDays", 1, 365), lowQuizPercent: pick("lowQuizPercent", 1, 100), lateSharePercent: pick("lateSharePercent", 1, 100) };
}

/* Pure. in = { learners:[{studentId,name,enrolledAt}], lessonsTotal, lessonStats:Map(studentId->{done,lastAt}), assignments:[{id,title,dueAt}] (due order),
     submitted:Map(studentId->Map(assignmentId->{late,at})), openExt:Set("assignmentId:studentId"), quiz:Map(studentId->[percent,...]), quizActivity:Map(studentId->ms), thresholds, now:Date, outcome|null }
   -> { summary, learners:[{studentId,name,alerts:[{type,reason,data,threshold}]}] } */
function buildAttention(input) {
  const { learners, lessonsTotal, lessonStats, assignments, submitted, openExt, quiz, quizActivity, now } = input;
  const th = normThresholds(input.thresholds), nowMs = now.getTime();
  const pastDue = assignments.filter((a) => { const t = ms(a.dueAt); return t !== null && t < nowMs; });
  const out = [], counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  let submittedTotal = 0, lateTotal = 0, missingTotal = 0, quizPercents = [];
  const progressRows = [];
  for (const l of learners) {
    const ls = lessonStats.get(l.studentId) || {}, mine = submitted.get(l.studentId) || new Map(), alerts = [];
    progressRows.push({ studentId: l.studentId, completed: Number(ls.done) || 0, lastActivityAt: ls.lastAt ?? null });
    const times = [ms(ls.lastAt), quizActivity.get(l.studentId) ?? null];
    for (const s of mine.values()) times.push(ms(s.at));
    const last = Math.max(-Infinity, ...times.filter((t) => t !== null)), lastAt = Number.isFinite(last) ? last : null;
    const ref = lastAt !== null ? lastAt : ms(l.enrolledAt);
    if (ref !== null) {
      const days = Math.max(0, Math.floor((nowMs - ref) / DAY));
      if (days >= th.inactiveDays) { counts.inactive++; alerts.push({ type: "inactive", reason: lastAt !== null ? `No recorded activity for ${days} days (threshold ${th.inactiveDays}).` : `No recorded activity since joining the course ${days} days ago (threshold ${th.inactiveDays}).`,
        data: { lastActivityAt: lastAt !== null ? new Date(lastAt).toISOString() : null, since: new Date(ref).toISOString(), daysInactive: days }, threshold: { inactiveDays: th.inactiveDays } }); }
    }
    const missing = pastDue.filter((a) => !mine.has(a.id) && !openExt.has(`${a.id}:${l.studentId}`));
    missingTotal += missing.length;
    if (missing.length) { counts.missing_work++; alerts.push({ type: "missing_work", reason: `${missing.length} of ${pastDue.length} assignments past their due date have no submission.`,
      data: { missing: missing.length, pastDueAssignments: pastDue.length, items: missing.slice(0, MAX_LISTED).map((a) => ({ assignmentId: a.id, title: a.title, dueAt: iso(a.dueAt) })) }, threshold: { atLeast: 1 } }); }
    const sub = [...mine.values()], late = sub.filter((s) => s.late).length;
    submittedTotal += sub.length; lateTotal += late;
    if (sub.length >= LATE_MIN_SUBMITTED && Math.floor((100 * late) / sub.length) >= th.lateSharePercent) { counts.late_pattern++; alerts.push({ type: "late_pattern", reason: `${late} of ${sub.length} submitted assignments were handed in late (threshold ${th.lateSharePercent}%).`,
      data: { submitted: sub.length, late, latePercent: Math.floor((100 * late) / sub.length) }, threshold: { lateSharePercent: th.lateSharePercent, minSubmitted: LATE_MIN_SUBMITTED } }); }
    const qs = quiz.get(l.studentId) || [];
    if (qs.length) quizPercents.push(...qs);
    if (qs.length >= QUIZ_MIN_MARKED) {
      const avg = r2(qs.reduce((a, b) => a + b, 0) / qs.length);
      if (avg < th.lowQuizPercent) { counts.low_quiz++; alerts.push({ type: "low_quiz", reason: `Average ${avg}% over ${qs.length} marked quizzes (threshold ${th.lowQuizPercent}%).`, data: { quizzesMarked: qs.length, averagePercent: avg }, threshold: { lowQuizPercent: th.lowQuizPercent, minQuizzes: QUIZ_MIN_MARKED } }); }
    }
    if (alerts.length) out.push({ studentId: l.studentId, name: l.name || "", alerts });
  }
  const { summary: comp } = buildProgress(progressRows.map((r) => ({ ...r, name: "", admissionNo: "" })), lessonsTotal);
  return { summary: { learners: learners.length, learnersWithAlerts: out.length, alertCounts: counts,
    completion: { lessons: comp.lessons, notStarted: comp.notStarted, inProgress: comp.inProgress, complete: comp.complete, averagePercent: comp.averagePercent },
    timeliness: { assignmentsPastDue: pastDue.length, submitted: submittedTotal, late: lateTotal, missing: missingTotal },
    quizzes: { marked: quizPercents.length, averagePercent: quizPercents.length ? r2(quizPercents.reduce((a, b) => a + b, 0) / quizPercents.length) : null },
    outcomeCoverage: input.outcome || null, thresholds: th }, learners: out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.studentId - b.studentId)) };
}

async function attentionReport(pool, user, courseId, { now = new Date() } = {}) {
  const cid = gate(user, courseId); if (!cid) return notFound();
  const c = () => pool.request().input("c", sql.Int, cid);
  const ex = await c().query(`SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL`); if (!(ex.recordset && ex.recordset[0])) return notFound();
  const lrq = await c().query(`SELECT TOP ${MAX_LEARNERS + 1} e.student_id, st.name AS student_name, e.enrolled_at FROM lms_course_enrolments e LEFT JOIN Students st ON st.id = e.student_id
    WHERE e.course_id = @c AND e.status = 'active' ORDER BY st.name, e.student_id`);
  const lr = lrq.recordset || []; if (lr.length > MAX_LEARNERS) return { ok: false, code: "TOO_MANY_LEARNERS", errors: [`A report holds at most ${MAX_LEARNERS} learners.`] };
  const settings = await getSettings(pool), thresholds = normThresholds(settings.analytics);
  const learners = lr.map((l) => ({ studentId: l.student_id, name: l.student_name || "", enrolledAt: l.enrolled_at }));
  const lessonStats = new Map(), submitted = new Map(), openExt = new Set(), quiz = new Map(), quizActivity = new Map();
  const tot = await c().query(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`);
  const lessonsTotal = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0;
  const asg = await c().query(`SELECT TOP ${MAX_ASSIGNMENTS} id, title, due_at FROM lms_assignments WHERE course_id = @c AND status = 'published' AND deleted_at IS NULL ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id`);
  const assignments = (asg.recordset || []).map((a) => ({ id: a.id, title: a.title, dueAt: iso(a.due_at) }));
  if (lr.length * Math.max(1, assignments.length) > MAX_CELLS) return { ok: false, code: "EXPORT_TOO_LARGE", errors: ["This course is too large to analyse in one go."] };
  if (lr.length) {
    const ids = JSON.stringify(lr.map((l) => l.student_id)), withIds = () => c().input("ids", sql.NVarChar(sql.MAX), ids);
    if (lessonsTotal) {
      const p = await withIds().query(`SELECT TOP ${MAX_LEARNERS} p.student_id, SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS done, MAX(p.last_viewed_at) AS last_at FROM lms_lesson_progress p
        WHERE p.course_id = @c AND p.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) AND p.lesson_id IN (SELECT id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE})
        GROUP BY p.student_id`);
      for (const x of p.recordset || []) lessonStats.set(x.student_id, { done: x.done, lastAt: iso(x.last_at) });
    }
    if (assignments.length) {
      const s = await withIds().query(`WITH latest AS (
          SELECT s.assignment_id, s.student_id, s.is_late, s.submitted_at, ROW_NUMBER() OVER (PARTITION BY s.assignment_id, s.student_id ORDER BY s.attempt_no DESC, s.id DESC) AS rn
          FROM lms_submissions s JOIN lms_assignments a ON a.id = s.assignment_id AND a.course_id = s.course_id AND a.status = 'published' AND a.deleted_at IS NULL
          WHERE s.course_id = @c AND s.status = 'submitted' AND s.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)))
        SELECT TOP ${MAX_CELLS} assignment_id, student_id, is_late, submitted_at FROM latest WHERE rn = 1`);
      for (const x of s.recordset || []) { if (!submitted.has(x.student_id)) submitted.set(x.student_id, new Map()); submitted.get(x.student_id).set(x.assignment_id, { late: !!x.is_late, at: iso(x.submitted_at) }); }
      const e = await c().input("now", sql.DateTime2, now).query(`SELECT TOP ${MAX_CELLS} assignment_id, student_id FROM lms_extensions WHERE course_id = @c AND due_at > @now`);
      for (const x of e.recordset || []) openExt.add(`${x.assignment_id}:${x.student_id}`);
    }
    const q = await withIds().query(`WITH latest AS (
        SELECT t.student_id, t.total_points, t.max_points, ROW_NUMBER() OVER (PARTITION BY t.quiz_id, t.student_id ORDER BY t.attempt_no DESC, t.id DESC) AS rn
        FROM lms_quiz_attempts t JOIN lms_quizzes z ON z.id = t.quiz_id AND z.course_id = t.course_id AND z.status = 'published' AND z.deleted_at IS NULL
        WHERE t.course_id = @c AND t.status = 'graded' AND t.max_points > 0 AND t.total_points IS NOT NULL AND t.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)))
      SELECT TOP ${MAX_QUIZ_ROWS} student_id, total_points, max_points FROM latest WHERE rn = 1`);
    for (const x of q.recordset || []) { if (!quiz.has(x.student_id)) quiz.set(x.student_id, []); quiz.get(x.student_id).push(Math.max(0, Math.min(100, r2((100 * Number(x.total_points)) / Number(x.max_points))))); }
    const qa = await withIds().query(`SELECT TOP ${MAX_LEARNERS} student_id, MAX(started_at) AS last_at FROM lms_quiz_attempts WHERE course_id = @c AND student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) GROUP BY student_id`);
    for (const x of qa.recordset || []) quizActivity.set(x.student_id, ms(x.last_at));
  }
  let outcome = null;
  const oc = await c().query(`SELECT COUNT(*) AS tags FROM lms_outcome_tags WHERE course_id = @c AND entity_type = 'lesson'`);
  if (Number(oc.recordset && oc.recordset[0] && oc.recordset[0].tags) > 0) {
    const o = await c().query(`SELECT (SELECT COUNT(*) FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE}) AS lessons_visible,
      (SELECT COUNT(DISTINCT t.entity_id) FROM lms_outcome_tags t JOIN lms_lessons l ON l.id = t.entity_id AND l.course_id = @c AND l.deleted_at IS NULL AND ${VISIBLE} WHERE t.course_id = @c AND t.entity_type = 'lesson') AS lessons_tagged,
      (SELECT COUNT(DISTINCT outcome_id) FROM lms_outcome_tags WHERE course_id = @c AND entity_type = 'lesson') AS outcomes_tagged`);
    const x = (o.recordset && o.recordset[0]) || {}; outcome = { lessonsVisible: Number(x.lessons_visible) || 0, lessonsTagged: Number(x.lessons_tagged) || 0, outcomesTagged: Number(x.outcomes_tagged) || 0 };
  }
  const r = buildAttention({ learners, lessonsTotal, lessonStats, assignments, submitted, openExt, quiz, quizActivity, thresholds, now, outcome });
  return { ok: true, generatedAt: now.toISOString(), summary: r.summary, learners: r.learners, note: "These are prompts for a conversation, not verdicts. Each alert shows the numbers behind it; learners are listed by name, never ranked." };
}

module.exports = { MAX_LEARNERS, TYPES, LATE_MIN_SUBMITTED, QUIZ_MIN_MARKED, normThresholds, buildAttention, attentionReport };
