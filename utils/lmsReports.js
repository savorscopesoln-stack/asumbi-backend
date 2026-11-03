/* =========================================================================
   LMS COURSE REPORTS  (L7.6a + L7.6b, D-093, D-094)  STAFF only, READ ONLY, no schema step. Only the CSV download writes one audit row (`report.exported`).
   Routes (flag `lms_gradebook`, then `lms.gradebook.view`, then course owner / co-teacher / admin):
     GET /courses/:id/gradebook/reports/progress          per-learner course progress
     GET /courses/:id/gradebook/reports/progress.csv      the same table as a CSV download (L7.6b)
     GET /courses/:id/gradebook/reports/distribution      grade distribution
     GET /courses/:id/gradebook/reports/submissions       submission status per published assignment (L7.6b)
     GET /courses/:id/gradebook/reports/teacher-activity  counts of what each course staff member did in the last N days (L7.6b)
   Rules (documented, simple, the same numbers a teacher can check by hand):
   - ACTIVE learners of THIS course only, at most 2000 (409 TOO_MANY_LEARNERS), so a report is always bounded. Name order. Works for any live course.
   - PROGRESS: lessons = the lessons a learner can see now (published, not scheduled for later, not deleted), the same set as the learner's own progress (L4.3).
     percent = completed / lessons rounded DOWN (0 when there are no lessons). `lastActivityAt` = the latest time the learner opened any of those lessons.
     Summary: notStarted (0 completed), inProgress, complete (all lessons, at least one lesson), averagePercent (2 decimals). These are PROMPTS for the teacher, not verdicts.
   - DISTRIBUTION uses the STAFF view (Q64 default, same totals as the grid and the CSV export: hidden grades and unreleased items count). A learner with nothing
     counted is `notGraded` and is left out of every statistic (never counted as 0). Statistics: mean, median, min, max (2 decimals), pass rate against the school's
     pass mark (GradingSystem, 50 when none), a 10-bucket histogram (0-9.99 ... 90-100, the last bucket includes 100 and anything above) and a count per grade band of the
     school's own GradingSystem (every band is listed, even with 0 learners). No learner is named in the distribution.
   - SUBMISSIONS (D-094): one row per PUBLISHED, not deleted assignment (at most 200, due date order, no due date last). Counts are for ACTIVE learners and use each learner's
     LATEST SUBMITTED attempt (drafts are not submissions). submitted = learners with a submitted attempt; notSubmitted = learners - submitted; late = latest attempt was handed in
     late; awaitingMarking = submitted with no grade row yet; graded = marked but not yet returned to the learner; returned = marks returned (awaitingMarking + graded + returned = submitted).
     missing = notSubmitted learners AFTER the due date has passed, not counting learners whose extension is still open (0 when there is no due date or it has not passed).
     Counts only: nobody is named. The cutoff date is not used (an assignment past its due date but before its cutoff still counts a learner as missing, which is what a teacher chases).
   - TEACHER ACTIVITY (D-094): counts only, per ACTIVE course staff member (at most 50), for the last `days` days (1-90, default 30), from the SOURCE tables, not the audit log
     (the log is not kept forever and does not say who published a lesson): lessonsPublished = published, not deleted lessons the member AUTHORED whose published time is in the window;
     assignmentsGraded = grade rows the member entered in the window (a regrade counts again); announcementsPosted = published, not deleted course announcements the member wrote in the window.
     An LMS administrator who is not on the course staff is not listed. These are prompts for a conversation, never a score.
   - PROGRESS CSV (D-094): the progress table as a file (Admission no, Name, Lessons completed, Lessons total, Progress %, Last activity). Same formula guard as the gradebook export. Audited.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { computeTotal } = require("./lmsGradeCalc");
const { VISIBLE } = require("./lmsLessons");
const { loadGradingSystem, getGradeForScore } = require("./grading");
const { audit } = require("./lmsAudit");
const { cell } = require("./lmsQuestionCsv");

const MAX_LEARNERS = 2000, MAX_CELLS = 100000, DEFAULT_PASS = 50, MAX_ASSIGNMENTS = 200, MAX_STAFF = 50, DEFAULT_DAYS = 30, MAX_DAYS = 90;
const notFound = () => ({ ok: false, notFound: true, errors: ["Course not found."] });
const tooMany = () => ({ ok: false, code: "TOO_MANY_LEARNERS", errors: [`A report holds at most ${MAX_LEARNERS} learners.`] });
const r2 = (n) => Math.round(n * 100) / 100;
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/* Pure. [{studentId,name,admissionNo,completed,lastActivityAt}], total lessons -> { rows, summary } */
function buildProgress(learners, total) {
  const rows = learners.map((l) => {
    const completed = Math.min(Number(l.completed) || 0, total);
    return { studentId: l.studentId, name: l.name || "", admissionNo: l.admissionNo || "", completed, total, percent: total ? Math.floor((100 * completed) / total) : 0, lastActivityAt: l.lastActivityAt ?? null };
  });
  const sum = rows.reduce((a, r) => a + r.percent, 0);
  return { rows, summary: { learners: rows.length, lessons: total, notStarted: rows.filter((r) => r.completed === 0).length, inProgress: rows.filter((r) => r.completed > 0 && !(total > 0 && r.completed >= total)).length,
    complete: rows.filter((r) => total > 0 && r.completed >= total).length, averagePercent: rows.length ? r2(sum / rows.length) : 0 } };
}

/* Pure. percents = array of number|null (one per learner), gs = grading system -> distribution */
function buildDistribution(percents, gs) {
  const graded = percents.filter((p) => p !== null && p !== undefined).map(Number).sort((a, b) => a - b), n = graded.length;
  const pass = Number(gs.passMark ?? DEFAULT_PASS);
  const histogram = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9.99, count: 0 }));
  for (const p of graded) histogram[Math.min(9, Math.max(0, Math.floor(p / 10)))].count += 1;
  const bands = (gs.gradeBands || []).map((b) => ({ grade: String(b.grade), label: b.label || null, minScore: Number(b.minScore), count: 0 }));
  let unbanded = 0;
  for (const p of graded) { const g = getGradeForScore(p, gs); const hit = g ? bands.find((b) => b.grade === String(g.grade)) : null; if (hit) hit.count += 1; else unbanded += 1; }
  const median = n ? (n % 2 ? graded[(n - 1) / 2] : (graded[n / 2 - 1] + graded[n / 2]) / 2) : null;
  return { learners: percents.length, graded: n, notGraded: percents.length - n, mean: n ? r2(graded.reduce((a, b) => a + b, 0) / n) : null, median: median === null ? null : r2(median), min: n ? r2(graded[0]) : null, max: n ? r2(graded[n - 1]) : null,
    passMark: pass, passed: graded.filter((p) => p >= pass).length, failed: graded.filter((p) => p < pass).length, passRate: n ? r2((100 * graded.filter((p) => p >= pass).length) / n) : null, histogram, bands, unbanded };
}

async function learnersOf(pool, cid) {
  const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_LEARNERS + 1} e.student_id, st.name AS student_name, st.admissionNo AS admission_no
    FROM lms_course_enrolments e LEFT JOIN Students st ON st.id = e.student_id WHERE e.course_id = @c AND e.status = 'active' ORDER BY st.name, e.student_id`);
  return r.recordset || [];
}
async function courseExists(pool, cid) { const r = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL`); return !!(r.recordset && r.recordset[0]); }
const gate = (user, courseId) => { const a = actorOf(user); const cid = posInt(courseId); return !a || a.role === "student" || !cid ? null : cid; };

async function progressReport(pool, user, courseId) {
  const cid = gate(user, courseId); if (!cid) return notFound();
  if (!(await courseExists(pool, cid))) return notFound();
  const lr = await learnersOf(pool, cid); if (lr.length > MAX_LEARNERS) return tooMany();
  const tot = await pool.request().input("c", sql.Int, cid).query(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`);
  const total = Number(tot.recordset && tot.recordset[0] && tot.recordset[0].n) || 0, byStudent = new Map();
  if (lr.length && total) {
    const p = await pool.request().input("c", sql.Int, cid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(lr.map((l) => l.student_id)))
      .query(`SELECT TOP ${MAX_LEARNERS} p.student_id, SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS done, MAX(p.last_viewed_at) AS last_at FROM lms_lesson_progress p
        WHERE p.course_id = @c AND p.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) AND p.lesson_id IN (SELECT id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE})
        GROUP BY p.student_id`);
    for (const x of p.recordset || []) byStudent.set(x.student_id, x);
  }
  const { rows, summary } = buildProgress(lr.map((l) => { const x = byStudent.get(l.student_id); return { studentId: l.student_id, name: l.student_name, admissionNo: l.admission_no, completed: x ? x.done : 0, lastActivityAt: x ? iso(x.last_at) : null }; }), total);
  return { ok: true, summary, learners: rows };
}

async function distributionReport(pool, user, courseId) {
  const cid = gate(user, courseId); if (!cid) return notFound();
  if (!(await courseExists(pool, cid))) return notFound();
  const c = () => pool.request().input("c", sql.Int, cid);
  const [cats, its, lr] = await Promise.all([
    c().query(`SELECT TOP 30 id, weight, drop_lowest FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP 200 id, category_id, max_points, weight, released FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    learnersOf(pool, cid),
  ]);
  if (lr.length > MAX_LEARNERS) return tooMany();
  const categories = (cats.recordset || []).map((k) => ({ id: k.id, weight: Number(k.weight), dropLowest: Number(k.drop_lowest) }));
  const items = (its.recordset || []).map((i) => ({ id: i.id, categoryId: i.category_id ?? null, maxPoints: Number(i.max_points), weight: Number(i.weight), released: !!i.released }));
  if (lr.length * Math.max(1, items.length) > MAX_CELLS) return { ok: false, code: "EXPORT_TOO_LARGE", errors: ["This course is too large to report in one go."] };
  const grades = new Map();
  if (lr.length && items.length) {
    const g = await c().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(lr.map((l) => l.student_id))).query(`SELECT TOP ${MAX_CELLS} g.item_id, g.student_id, g.points, g.excused, g.hidden
      FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL
      WHERE g.course_id = @c AND g.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`);
    for (const r of g.recordset || []) { if (!grades.has(r.student_id)) grades.set(r.student_id, []); grades.get(r.student_id).push({ itemId: r.item_id, points: numOrNull(r.points), excused: !!r.excused, hidden: !!r.hidden }); }
  }
  const gs = await loadGradingSystem(pool);
  const percents = lr.map((l) => computeTotal({ categories, items, grades: grades.get(l.student_id) || [], viewer: "staff" }).percent);
  return { ok: true, view: "staff", distribution: buildDistribution(percents, gs) };
}

/* ---------- L7.6b (D-094) ---------- */
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/* Pure. assignments [{id,title,dueAt,pastDue}], agg Map(assignmentId -> {submitted,late,graded,returned}), openExt Map(assignmentId -> learners with no submission and a still-open extension),
   learners = number of ACTIVE learners. Every count is clamped so the parts always add up (a stale row can never make a negative or an impossible number). */
function buildSubmissionStatus(assignments, agg, openExt, learners) {
  const L = count(learners);
  const rows = assignments.map((a) => {
    const x = agg.get(a.id) || {};
    const submitted = Math.min(count(x.submitted), L), notSubmitted = L - submitted;
    const returned = Math.min(count(x.returned), submitted), graded = Math.min(count(x.graded), submitted - returned), late = Math.min(count(x.late), submitted);
    const extended = Math.min(count(openExt.get(a.id)), notSubmitted);
    return { assignmentId: a.id, title: a.title, dueAt: a.dueAt ?? null, pastDue: !!a.pastDue, learners: L, submitted, late, notSubmitted, missing: a.pastDue ? notSubmitted - extended : 0, awaitingMarking: submitted - graded - returned, graded, returned };
  });
  return { rows, summary: { assignments: rows.length, learners: L, awaitingMarking: rows.reduce((n, r) => n + r.awaitingMarking, 0), missing: rows.reduce((n, r) => n + r.missing, 0) } };
}

async function submissionStatusReport(pool, user, courseId) {
  const cid = gate(user, courseId); if (!cid) return notFound();
  if (!(await courseExists(pool, cid))) return notFound();
  const c = () => pool.request().input("c", sql.Int, cid);
  const lr = await learnersOf(pool, cid); if (lr.length > MAX_LEARNERS) return tooMany();
  const asg = await c().query(`SELECT TOP ${MAX_ASSIGNMENTS} a.id, a.title, a.due_at, CASE WHEN a.due_at IS NOT NULL AND a.due_at < SYSUTCDATETIME() THEN 1 ELSE 0 END AS past_due
    FROM lms_assignments a WHERE a.course_id = @c AND a.status = 'published' AND a.deleted_at IS NULL ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at, a.id`);
  const assignments = (asg.recordset || []).map((a) => ({ id: a.id, title: a.title, dueAt: iso(a.due_at), pastDue: !!a.past_due }));
  const agg = new Map(), openExt = new Map();
  if (lr.length && assignments.length) {
    const g = await c().query(`WITH latest AS (
        SELECT s.id AS submission_id, s.assignment_id, s.is_late, ROW_NUMBER() OVER (PARTITION BY s.assignment_id, s.student_id ORDER BY s.attempt_no DESC, s.id DESC) AS rn
        FROM lms_submissions s JOIN lms_course_enrolments e ON e.course_id = s.course_id AND e.student_id = s.student_id AND e.status = 'active'
        WHERE s.course_id = @c AND s.status = 'submitted')
      SELECT TOP ${MAX_ASSIGNMENTS} l.assignment_id, COUNT(*) AS submitted, SUM(CASE WHEN l.is_late = 1 THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN g.status = 'draft' THEN 1 ELSE 0 END) AS graded, SUM(CASE WHEN g.status = 'returned' THEN 1 ELSE 0 END) AS returned
      FROM latest l LEFT JOIN lms_submission_grades g ON g.submission_id = l.submission_id AND g.course_id = @c
      WHERE l.rn = 1 GROUP BY l.assignment_id`);
    for (const x of g.recordset || []) agg.set(x.assignment_id, { submitted: x.submitted, late: x.late, graded: x.graded, returned: x.returned });
    const ex = await c().query(`SELECT TOP ${MAX_ASSIGNMENTS} x.assignment_id, COUNT(*) AS n FROM lms_extensions x
      JOIN lms_course_enrolments e ON e.course_id = x.course_id AND e.student_id = x.student_id AND e.status = 'active'
      WHERE x.course_id = @c AND x.due_at > SYSUTCDATETIME()
        AND NOT EXISTS (SELECT 1 FROM lms_submissions s WHERE s.course_id = @c AND s.assignment_id = x.assignment_id AND s.student_id = x.student_id AND s.status = 'submitted')
      GROUP BY x.assignment_id`);
    for (const x of ex.recordset || []) openExt.set(x.assignment_id, x.n);
  }
  const { rows, summary } = buildSubmissionStatus(assignments, agg, openExt, lr.length);
  return { ok: true, summary, assignments: rows };
}

/* Pure. Any value -> whole days 1..90, else 30. */
const normDays = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS; };

async function teacherActivityReport(pool, user, courseId, opts = {}) {
  const cid = gate(user, courseId); if (!cid) return notFound();
  if (!(await courseExists(pool, cid))) return notFound();
  const days = normDays(opts.days), now = opts.now instanceof Date ? opts.now : new Date(), since = new Date(now.getTime() - days * 86400000);
  const r = await pool.request().input("c", sql.Int, cid).input("since", sql.DateTime2, since).query(`SELECT TOP ${MAX_STAFF} s.staff_role, COALESCE(t.name, u.name) AS name,
      (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = @c AND l.deleted_at IS NULL AND l.status = 'published' AND l.published_at >= @since AND l.created_by_source = s.user_source AND l.created_by = s.user_id) AS lessons_published,
      (SELECT COUNT(*) FROM lms_submission_grades g WHERE g.course_id = @c AND g.graded_at >= @since AND g.graded_by_source = s.user_source AND g.graded_by = s.user_id) AS assignments_graded,
      (SELECT COUNT(*) FROM lms_announcements a WHERE a.course_id = @c AND a.deleted_at IS NULL AND a.status = 'published' AND a.published_at >= @since AND a.created_by_source = s.user_source AND a.created_by = s.user_id) AS announcements_posted
    FROM lms_course_staff s LEFT JOIN Teachers t ON s.user_source = 'Teachers' AND t.id = s.user_id LEFT JOIN users u ON s.user_source = 'Users' AND u.id = s.user_id
    WHERE s.course_id = @c AND s.is_active = 1 ORDER BY s.staff_role, s.id`);
  const staff = (r.recordset || []).map((x) => ({ name: x.name || "", role: x.staff_role === "co_teacher" ? "co_teacher" : "owner", lessonsPublished: count(x.lessons_published), assignmentsGraded: count(x.assignments_graded), announcementsPosted: count(x.announcements_posted) }));
  return { ok: true, days, since: since.toISOString(), staff, note: "Counts only. Lessons are credited to their author; an administrator who is not on the course staff is not listed." };
}

/* Pure. rows from buildProgress -> CSV text (CRLF, formula guard on every cell). */
function buildProgressCsv(rows) {
  const lines = [["Admission no", "Name", "Lessons completed", "Lessons total", "Progress %", "Last activity"].map(cell).join(",")];
  for (const r of rows) lines.push([r.admissionNo ?? "", r.name ?? "", String(r.completed), String(r.total), String(r.percent), r.lastActivityAt ?? ""].map(cell).join(","));
  return lines.join("\r\n") + "\r\n";
}

async function exportProgressCsv(pool, user, courseId) {
  const r = await progressReport(pool, user, courseId); if (!r.ok) return r;
  const cid = posInt(courseId), actor = actorOf(user);
  const csv = buildProgressCsv(r.learners);
  await audit(pool, actor, "report.exported", "lms_courses", cid, { courseId: cid, report: "progress", learners: r.learners.length });
  return { ok: true, csv, filename: `progress-course-${cid}.csv`, learners: r.learners.length };
}

module.exports = { MAX_LEARNERS, MAX_ASSIGNMENTS, MAX_STAFF, buildProgress, buildDistribution, progressReport, distributionReport, buildSubmissionStatus, submissionStatusReport, normDays, teacherActivityReport, buildProgressCsv, exportProgressCsv };
