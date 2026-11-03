/* =========================================================================
   LMS HOD / ADMIN DASHBOARDS  (L9.2a, D-106)  READ ONLY, no schema step, nothing audited (reads). TENANT-WIDE, so no course membership:
   the permission `lms.analytics.department` (held by LMS administrators, and by a head of department when granted) is the gate, after the flag `lms_analytics`.
   Routes:
     GET /analytics/courses   course quality review: one page of courses with plain counts and attention FLAGS
     GET /analytics/staff     what each course staff member did in the last N days (counts only)
     GET /analytics/moderation  (L9.2b, D-107) a WORK LIST for assessment moderation: ?view=awaiting (default) | no_rubric, &days (awaiting only), &page, &pageSize
     GET /analytics/cohorts     (L9.2b, D-107) grade distribution SUMMARY per course (the existing distributionReport), a small page of courses: &academicYear &programme &page &pageSize (<= 10)
   Rules (same spirit as D-105: prompts with their numbers, never a verdict):
   - Paginated: page >= 1, pageSize 1-50 (default 25). No unbounded query. `no-store`.
   - Nothing is ranked or scored. Courses are in year/code order, staff in name order. Learners are never named (counts only); staff are named.
   - COURSE FLAGS (each flag has `type`, `reason`, `data`), only for the lifecycle states where they make sense:
       awaiting_approval   status pending; data {submittedAt, waitingDays}
       no_staff            draft, pending or published with no ACTIVE course staff
       no_published_lessons  published, 0 lessons visible to learners now
       no_assessment       published, 0 published assignments AND 0 published quizzes
       no_learners         published, 0 ACTIVE learners
       no_outcome_tags     published, has lessons, none tagged with a learning outcome; ONLY raised when this tenant uses lesson outcome tags at all
     Archived courses get no flags. A draft only gets `no_staff`.
   - Counts: learners = ACTIVE enrolments; staff = ACTIVE course staff; lessonsPublished = published, not scheduled for later, not deleted (the learner's own lesson rule);
     lessonsTagged = distinct lessons with an outcome tag; assignmentsPublished / quizzesPublished = published, not deleted.
   - SUMMARY covers ALL live courses (not just the page): total and a count per status.
   - STAFF ACTIVITY: per ACTIVE staff member of any live course, for the last `days` days (1-90, default 30): courses (active, not archived), lessonsPublished (authored by the member, published in the window),
     assignmentsGraded (grade rows entered in the window), announcementsPosted. Counts only, from the SOURCE tables. A prompt for a conversation, never a score.
   - MODERATION (D-107): `awaiting` = published assignments of PUBLISHED courses whose latest SUBMITTED attempt (ACTIVE learners only) has NO grade row and was handed in more than `days` days ago
     (days 1-90, default 7): per assignment `awaitingMarking` (those attempts only), `oldestSubmittedAt`, `daysWaiting` (whole days since the oldest). `no_rubric` = published assignments of published courses
     with no row in `lms_assignment_rubrics`, with `submittedLearners` so a teacher can see whether it matters yet. Both are prompts, never verdicts. Ordered by course code, due date (undated last), id: a work list, never a league.
   - COHORTS (D-107): per course (published or archived, filters academicYear/programme, year desc then code) the existing `distributionReport` (STAFF-view totals) reduced to
     {learners, graded, notGraded, mean, median, passMark, passRate}; no learner named, no ranking. At most 10 courses per page (default 5) because every course loads all its learners. A course the
     builder refuses (TOO_MANY_LEARNERS, EXPORT_TOO_LARGE) or that fails is listed with `unavailable: <code>`, never skipped silently and never failing the page.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { VISIBLE } = require("./lmsLessons");
const { normDays, distributionReport } = require("./lmsReports");

const MAX_PAGE_SIZE = 50, DEFAULT_PAGE_SIZE = 25, STATUSES = ["draft", "pending", "published", "archived"], DAY = 86400000;
const notFound = () => ({ ok: false, notFound: true, errors: ["Not found."] });
const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const gate = (user) => { const a = actorOf(user); return !a || a.role === "student" ? null : a; };

/* Pure. Any query value -> {page, pageSize}. */
function normPage(q = {}, max = MAX_PAGE_SIZE, def = DEFAULT_PAGE_SIZE) {
  const p = Number(q.page), s = Number(q.pageSize);
  return { page: Number.isInteger(p) && p >= 1 && p <= 100000 ? p : 1, pageSize: Number.isInteger(s) && s >= 1 && s <= max ? s : def };
}

/* Pure. row = { status, staff, learners, lessons, lessonsTagged, assignments, quizzes, submittedAt }, ctx = { tenantUsesOutcomes, now } -> [flags] */
function courseFlags(row, ctx) {
  const flags = [], st = row.status, c = (k) => count(row[k]);
  if (st === "archived") return flags;
  if (st === "pending") {
    const t = row.submittedAt ? new Date(row.submittedAt).getTime() : NaN, days = Number.isFinite(t) ? Math.max(0, Math.floor((ctx.now.getTime() - t) / DAY)) : null;
    flags.push({ type: "awaiting_approval", reason: days === null ? "Waiting for a reviewer." : `Waiting for a reviewer for ${days} days.`, data: { submittedAt: Number.isFinite(t) ? new Date(t).toISOString() : null, waitingDays: days } });
  }
  if (c("staff") === 0) flags.push({ type: "no_staff", reason: "No active teacher is assigned to this course.", data: { staff: 0 } });
  if (st !== "published") return flags;
  if (c("lessons") === 0) flags.push({ type: "no_published_lessons", reason: "No lesson is visible to learners yet.", data: { lessonsPublished: 0 } });
  if (c("assignments") + c("quizzes") === 0) flags.push({ type: "no_assessment", reason: "No published assignment or quiz.", data: { assignmentsPublished: 0, quizzesPublished: 0 } });
  if (c("learners") === 0) flags.push({ type: "no_learners", reason: "No active learner is enrolled.", data: { learners: 0 } });
  if (ctx.tenantUsesOutcomes && c("lessons") > 0 && c("lessonsTagged") === 0) flags.push({ type: "no_outcome_tags", reason: `None of the ${c("lessons")} visible lessons has a learning-outcome tag.`, data: { lessonsPublished: c("lessons"), lessonsTagged: 0 } });
  return flags;
}

async function courseQualityReport(pool, user, query = {}, { now = new Date() } = {}) {
  if (!gate(user)) return notFound();
  const { page, pageSize } = normPage(query);
  const year = Number(query.academicYear), status = STATUSES.includes(query.status) ? query.status : null;
  const programme = typeof query.programme === "string" && query.programme.trim() ? query.programme.trim().slice(0, 100) : null;
  const rq = () => pool.request().input("y", sql.Int, Number.isInteger(year) && year > 0 ? year : null).input("st", sql.NVarChar(20), status).input("pr", sql.NVarChar(100), programme);
  const r = await rq().input("off", sql.Int, (page - 1) * pageSize).input("n", sql.Int, pageSize).query(`SELECT c.id, c.code, c.title, c.academic_year, c.programme, c.status,
      (SELECT COUNT(*) FROM lms_course_enrolments e WHERE e.course_id = c.id AND e.status = 'active') AS learners,
      (SELECT COUNT(*) FROM lms_course_staff s WHERE s.course_id = c.id AND s.is_active = 1) AS staff,
      (SELECT COUNT(*) FROM lms_lessons WHERE course_id = c.id AND deleted_at IS NULL AND ${VISIBLE}) AS lessons,
      (SELECT COUNT(DISTINCT t.entity_id) FROM lms_outcome_tags t WHERE t.course_id = c.id AND t.entity_type = 'lesson') AS lessons_tagged,
      (SELECT COUNT(*) FROM lms_assignments a WHERE a.course_id = c.id AND a.status = 'published' AND a.deleted_at IS NULL) AS assignments,
      (SELECT COUNT(*) FROM lms_quizzes z WHERE z.course_id = c.id AND z.status = 'published' AND z.deleted_at IS NULL) AS quizzes,
      (SELECT TOP 1 ap.created_at FROM lms_course_approvals ap WHERE ap.course_id = c.id AND ap.action = 'submitted' ORDER BY ap.id DESC) AS submitted_at,
      COUNT(*) OVER() AS total_count
    FROM lms_courses c WHERE c.deleted_at IS NULL AND (@y IS NULL OR c.academic_year = @y) AND (@st IS NULL OR c.status = @st) AND (@pr IS NULL OR c.programme = @pr)
    ORDER BY c.academic_year DESC, c.code, c.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || [];
  const sum = await pool.request().query(`SELECT status, COUNT(*) AS n FROM lms_courses WHERE deleted_at IS NULL GROUP BY status`);
  const uses = await pool.request().query(`SELECT TOP 1 1 AS x FROM lms_outcome_tags WHERE entity_type = 'lesson'`);
  const tenantUsesOutcomes = !!(uses.recordset && uses.recordset.length);
  const byStatus = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  for (const x of sum.recordset || []) if (Object.prototype.hasOwnProperty.call(byStatus, x.status)) byStatus[x.status] = count(x.n);
  const courses = rows.map((x) => {
    const base = { status: x.status, staff: x.staff, learners: x.learners, lessons: x.lessons, lessonsTagged: x.lessons_tagged, assignments: x.assignments, quizzes: x.quizzes, submittedAt: x.submitted_at };
    return { id: x.id, code: x.code, title: x.title, academicYear: x.academic_year, programme: x.programme || null, status: x.status,
      counts: { learners: count(x.learners), staff: count(x.staff), lessonsPublished: count(x.lessons), lessonsTagged: count(x.lessons_tagged), assignmentsPublished: count(x.assignments), quizzesPublished: count(x.quizzes) },
      flags: courseFlags(base, { tenantUsesOutcomes, now }) };
  });
  return { ok: true, page, pageSize, total: rows.length ? count(rows[0].total_count) : 0, generatedAt: now.toISOString(),
    summary: { courses: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, tenantUsesOutcomeTags: tenantUsesOutcomes, flaggedOnThisPage: courses.filter((c) => c.flags.length).length }, courses,
    note: "Flags are prompts to look at a course, with the numbers behind them. Courses are listed by year and code, never ranked." };
}

async function staffActivityReport(pool, user, query = {}, { now = new Date() } = {}) {
  if (!gate(user)) return notFound();
  const { page, pageSize } = normPage(query), days = normDays(query.days), since = new Date(now.getTime() - days * DAY);
  const r = await pool.request().input("since", sql.DateTime2, since).input("off", sql.Int, (page - 1) * pageSize).input("n", sql.Int, pageSize).query(`WITH staff AS (
      SELECT DISTINCT s.user_source, s.user_id FROM lms_course_staff s JOIN lms_courses c ON c.id = s.course_id AND c.deleted_at IS NULL WHERE s.is_active = 1)
    SELECT st.user_source, st.user_id, COALESCE(t.name, u.name) AS name,
      (SELECT COUNT(DISTINCT s2.course_id) FROM lms_course_staff s2 JOIN lms_courses c2 ON c2.id = s2.course_id AND c2.deleted_at IS NULL AND c2.status <> 'archived'
        WHERE s2.user_source = st.user_source AND s2.user_id = st.user_id AND s2.is_active = 1) AS courses,
      (SELECT COUNT(*) FROM lms_lessons l JOIN lms_courses c3 ON c3.id = l.course_id AND c3.deleted_at IS NULL WHERE l.deleted_at IS NULL AND l.status = 'published' AND l.published_at >= @since AND l.created_by_source = st.user_source AND l.created_by = st.user_id) AS lessons_published,
      (SELECT COUNT(*) FROM lms_submission_grades g JOIN lms_courses c4 ON c4.id = g.course_id AND c4.deleted_at IS NULL WHERE g.graded_at >= @since AND g.graded_by_source = st.user_source AND g.graded_by = st.user_id) AS assignments_graded,
      (SELECT COUNT(*) FROM lms_announcements a JOIN lms_courses c5 ON c5.id = a.course_id AND c5.deleted_at IS NULL WHERE a.deleted_at IS NULL AND a.status = 'published' AND a.published_at >= @since AND a.created_by_source = st.user_source AND a.created_by = st.user_id) AS announcements_posted,
      COUNT(*) OVER() AS total_count
    FROM staff st LEFT JOIN Teachers t ON st.user_source = 'Teachers' AND t.id = st.user_id LEFT JOIN users u ON st.user_source = 'Users' AND u.id = st.user_id
    ORDER BY COALESCE(t.name, u.name), st.user_id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, page, pageSize, total: rows.length ? count(rows[0].total_count) : 0, days, since: since.toISOString(),
    staff: rows.map((x) => ({ name: x.name || "", courses: count(x.courses), lessonsPublished: count(x.lessons_published), assignmentsGraded: count(x.assignments_graded), announcementsPosted: count(x.announcements_posted) })),
    note: "Counts only, by name, never scored or ranked. Lessons are credited to their author." };
}

/* ---------- L9.2b (D-107) ---------- */
const COHORT_MAX_PAGE_SIZE = 10, COHORT_DEFAULT_PAGE_SIZE = 5, MOD_VIEWS = ["awaiting", "no_rubric"], MOD_DEFAULT_DAYS = 7;
/* Pure. Any value -> whole days 1..90, else 7 (the moderation default differs from the 30 of the activity report). */
const normModDays = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n >= 1 && n <= 90 ? n : MOD_DEFAULT_DAYS; };
/* Pure. Oldest submitted time + now -> whole days waiting (null when unknown). */
function daysWaiting(oldest, now) { const t = oldest ? new Date(oldest).getTime() : NaN; return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY)) : null; }
/* Pure. distributionReport answer -> the small cohort summary, or {unavailable: code}. */
function cohortSummary(r) {
  if (!r || !r.ok || !r.distribution) return { unavailable: r && r.code ? String(r.code) : r && r.notFound ? "NOT_FOUND" : "UNAVAILABLE" };
  const d = r.distribution;
  return { learners: count(d.learners), graded: count(d.graded), notGraded: count(d.notGraded), mean: d.mean ?? null, median: d.median ?? null, passMark: d.passMark ?? null, passRate: d.passRate ?? null };
}

async function moderationReport(pool, user, query = {}, { now = new Date() } = {}) {
  if (!gate(user)) return notFound();
  const { page, pageSize } = normPage(query), view = MOD_VIEWS.includes(query.view) ? query.view : "awaiting", off = (page - 1) * pageSize;
  if (view === "no_rubric") {
    const r = await pool.request().input("off", sql.Int, off).input("n", sql.Int, pageSize).query(`SELECT a.id, a.title, a.due_at, c.id AS course_id, c.code, c.title AS course_title,
        (SELECT COUNT(DISTINCT s.student_id) FROM lms_submissions s WHERE s.assignment_id = a.id AND s.status = 'submitted') AS submitted_learners, COUNT(*) OVER() AS total_count
      FROM lms_assignments a JOIN lms_courses c ON c.id = a.course_id AND c.deleted_at IS NULL AND c.status = 'published'
      WHERE a.status = 'published' AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM lms_assignment_rubrics ar WHERE ar.assignment_id = a.id)
      ORDER BY c.code, CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at, a.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
    const rows = r.recordset || [];
    return { ok: true, view, page, pageSize, total: rows.length ? count(rows[0].total_count) : 0, generatedAt: now.toISOString(),
      items: rows.map((x) => ({ assignmentId: x.id, title: x.title, dueAt: iso(x.due_at), course: { id: x.course_id, code: x.code, title: x.course_title }, submittedLearners: count(x.submitted_learners) })),
      note: "Assignments with no rubric attached, as a prompt to look at them. Listed by course code and due date, never ranked." };
  }
  const days = normModDays(query.days), cutoff = new Date(now.getTime() - days * DAY);
  const r = await pool.request().input("cut", sql.DateTime2, cutoff).input("off", sql.Int, off).input("n", sql.Int, pageSize).query(`WITH latest AS (
      SELECT s.id AS submission_id, s.assignment_id, s.submitted_at, ROW_NUMBER() OVER (PARTITION BY s.assignment_id, s.student_id ORDER BY s.attempt_no DESC, s.id DESC) AS rn
      FROM lms_submissions s JOIN lms_course_enrolments e ON e.course_id = s.course_id AND e.student_id = s.student_id AND e.status = 'active'
      WHERE s.status = 'submitted'),
    waiting AS (
      SELECT l.assignment_id, COUNT(*) AS awaiting, MIN(l.submitted_at) AS oldest FROM latest l
      WHERE l.rn = 1 AND l.submitted_at < @cut AND NOT EXISTS (SELECT 1 FROM lms_submission_grades g WHERE g.submission_id = l.submission_id)
      GROUP BY l.assignment_id)
    SELECT a.id, a.title, a.due_at, c.id AS course_id, c.code, c.title AS course_title, w.awaiting, w.oldest, COUNT(*) OVER() AS total_count
    FROM waiting w JOIN lms_assignments a ON a.id = w.assignment_id AND a.status = 'published' AND a.deleted_at IS NULL
      JOIN lms_courses c ON c.id = a.course_id AND c.deleted_at IS NULL AND c.status = 'published'
    ORDER BY c.code, CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at, a.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, view, days, page, pageSize, total: rows.length ? count(rows[0].total_count) : 0, generatedAt: now.toISOString(),
    items: rows.map((x) => ({ assignmentId: x.id, title: x.title, dueAt: iso(x.due_at), course: { id: x.course_id, code: x.code, title: x.course_title },
      awaitingMarking: count(x.awaiting), oldestSubmittedAt: iso(x.oldest), daysWaiting: daysWaiting(x.oldest, now) })),
    note: `Work handed in more than ${days} days ago and not yet marked, as a prompt for a conversation. Listed by course code and due date, never ranked.` };
}

async function cohortReport(pool, user, query = {}, { now = new Date(), distribution = distributionReport } = {}) {
  if (!gate(user)) return notFound();
  const { page, pageSize } = normPage(query, COHORT_MAX_PAGE_SIZE, COHORT_DEFAULT_PAGE_SIZE);
  const year = Number(query.academicYear), programme = typeof query.programme === "string" && query.programme.trim() ? query.programme.trim().slice(0, 100) : null;
  const r = await pool.request().input("y", sql.Int, Number.isInteger(year) && year > 0 ? year : null).input("pr", sql.NVarChar(100), programme)
    .input("off", sql.Int, (page - 1) * pageSize).input("n", sql.Int, pageSize).query(`SELECT c.id, c.code, c.title, c.academic_year, c.programme, c.status, COUNT(*) OVER() AS total_count
    FROM lms_courses c WHERE c.deleted_at IS NULL AND c.status IN ('published', 'archived') AND (@y IS NULL OR c.academic_year = @y) AND (@pr IS NULL OR c.programme = @pr)
    ORDER BY c.academic_year DESC, c.code, c.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || [], courses = [];
  for (const x of rows) {
    let out; try { out = cohortSummary(await distribution(pool, user, x.id)); } catch (e) { out = { unavailable: "UNAVAILABLE" }; }
    courses.push({ id: x.id, code: x.code, title: x.title, academicYear: x.academic_year, programme: x.programme || null, status: x.status, ...out });
  }
  return { ok: true, page, pageSize, total: rows.length ? count(rows[0].total_count) : 0, generatedAt: now.toISOString(), courses,
    note: "Grade summaries use the staff view of each course gradebook. No learner is named and courses are never ranked. A course that cannot be summarised says why." };
}

module.exports = { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, COHORT_MAX_PAGE_SIZE, COHORT_DEFAULT_PAGE_SIZE, MOD_VIEWS, STATUSES, normPage, normModDays, daysWaiting, cohortSummary, courseFlags, courseQualityReport, staffActivityReport, moderationReport, cohortReport };
