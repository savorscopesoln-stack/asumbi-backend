/* =========================================================================
   LMS STUDENT DASHBOARD  (L4.1a)  one call that feeds the student home screen.

   Sections (each is independent: if one fails it is reported in `errors` and the others still render):
   - continueLearning: up to 3 lessons the student started and has not completed (most recent first), in PUBLISHED courses
     they are ACTIVELY enrolled in, lessons still visible (published and released). Titles shown are lessons already viewed.
   - courses: up to 6 active courses with the SAME progress rule as courseProgress (floor(100 * completed / visible lessons)),
     computed in one query (no per-course round trips). `totalCourses` and `pendingRequests` are counts.
   - upcoming: next 14 days from the planner (max 5 items) - planner rules apply (enrolled, published, bounded).
   - announcements: 5 newest (pinned first) from the existing student feed.
   - pendingTasks (L4.1b): up to 5 published, already-available assignments in courses the student is actively enrolled in that they have NOT
     handed in and can still hand in (same `windowOf` rule as the submission screen, using the school's late-policy default; archived courses excluded
     because they are read-only). Each carries `overdue` (past dueAt but still open, so late work is accepted). Earliest due first, no due date last.
   - recentFeedback (L4.1b): the 5 most recently RETURNED grades (never drafts) for the student's own work, with points and whether a comment exists
     (the comment text itself stays on the assignment's feedback screen).
   The student id comes from the token. No other learner's data is read; every query is parameterised and bounded.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { VISIBLE } = require("./lmsLessons");
const planner = require("./lmsPlanner");
const announce = require("./lmsAnnouncements");
const A = require("./lmsAssignments");
const { windowOf } = require("./lmsSubmissions");
const X = require("./lmsExtensions");
const { getSettings } = require("./lmsSettings");
const { releaseDue } = require("./lmsRelease");

const MAX_CONTINUE = 3, MAX_COURSES = 6, MAX_UPCOMING = 5, MAX_ANNOUNCEMENTS = 5, UPCOMING_DAYS = 14, MAX_PENDING = 5, PENDING_CANDIDATES = 50, MAX_FEEDBACK = 5;
/* Same rule as lmsLessons.VISIBLE, with the lesson alias (a test keeps the two in step). */
const VISIBLE_L = `l.status = 'published' AND (l.publish_at IS NULL OR l.publish_at <= SYSUTCDATETIME())`;
const ENROLLED = (course, s) => `EXISTS (SELECT 1 FROM lms_course_enrolments en WHERE en.course_id = ${course} AND en.student_id = ${s} AND en.status = 'active')`;

async function continueLearning(pool, sid) {
  const r = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT TOP ${MAX_CONTINUE} p.course_id, c.title AS course_title, p.lesson_id, l.title AS lesson_title, p.last_viewed_at
      FROM lms_lesson_progress p
      JOIN lms_lessons l ON l.id = p.lesson_id AND l.course_id = p.course_id AND l.deleted_at IS NULL AND ${VISIBLE_L}
      JOIN lms_courses c ON c.id = p.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      WHERE p.student_id = @s AND p.status = 'in_progress' AND ${ENROLLED("p.course_id", "@s")}
      ORDER BY p.last_viewed_at DESC, p.lesson_id`);
  return (r.recordset || []).map((x) => ({ courseId: x.course_id, courseTitle: x.course_title, lessonId: x.lesson_id, lessonTitle: x.lesson_title, lastViewedAt: x.last_viewed_at || null }));
}

async function courseCards(pool, sid, limit = MAX_COURSES) {
  const top = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : MAX_COURSES;
  const r = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT TOP ${top} c.id, c.title, c.code,
        (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id AND l.deleted_at IS NULL AND ${VISIBLE_L}) AS total_lessons,
        (SELECT COUNT(*) FROM lms_lesson_progress p JOIN lms_lessons l ON l.id = p.lesson_id AND l.course_id = c.id AND l.deleted_at IS NULL AND ${VISIBLE_L}
           WHERE p.student_id = @s AND p.course_id = c.id AND p.status = 'completed') AS completed_lessons
      FROM lms_courses c
      WHERE c.status = 'published' AND c.deleted_at IS NULL AND ${ENROLLED("c.id", "@s")}
      ORDER BY c.academic_year DESC, c.title, c.id`);
  const counts = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT SUM(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) AS active_n, SUM(CASE WHEN e.status = 'pending' THEN 1 ELSE 0 END) AS pending_n
      FROM lms_course_enrolments e JOIN lms_courses c ON c.id = e.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      WHERE e.student_id = @s AND e.status IN ('active','pending')`);
  const k = (counts.recordset && counts.recordset[0]) || {};
  const items = (r.recordset || []).map((x) => {
    const total = Number(x.total_lessons) || 0, done = Math.min(Number(x.completed_lessons) || 0, total);
    return { courseId: x.id, title: x.title, code: x.code || null, totalLessons: total, completedLessons: done, percent: total ? Math.floor((100 * done) / total) : 0 };
  });
  return { items, totalCourses: Number(k.active_n) || 0, pendingRequests: Number(k.pending_n) || 0 };
}

async function upcoming(pool, user, now) {
  const to = new Date(now.getTime() + UPCOMING_DAYS * 864e5);
  const r = await planner.getPlanner(pool, user, { from: now.toISOString(), to: to.toISOString() }, now);
  if (!r.ok) throw new Error("planner refused");
  return { items: r.items.slice(0, MAX_UPCOMING), more: r.items.length > MAX_UPCOMING || r.truncated };
}

async function recentAnnouncements(pool, sid) {
  const r = await announce.listForStudentMe(pool, sid, { page: 1, pageSize: MAX_ANNOUNCEMENTS });
  return { items: r.items, total: r.total };
}

/* Assignments still to do (L4.1b). Candidates come from one bounded query (due soonest first, undated last); the "can it still be handed in?" rule is the
   SAME pure function the submission screen uses, so the two can never disagree. */
async function pendingTasks(pool, sid, now) {
  const settings = await getSettings(pool);
  const r = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT TOP ${PENDING_CANDIDATES} ${A.COLS.split(", ").map((c) => `a.${c}`).join(", ")}, c.title AS course_title, ${X.EXT_COLS}
      FROM lms_assignments a
      JOIN lms_courses c ON c.id = a.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      ${X.joinSql("@s")}
      WHERE ${A.AVAILABLE} AND ${ENROLLED("a.course_id", "@s")}
        AND NOT EXISTS (SELECT 1 FROM lms_submissions sb WHERE sb.assignment_id = a.id AND sb.course_id = a.course_id AND sb.student_id = @s AND sb.status = 'submitted')
      ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, COALESCE(x.due_at, a.due_at), a.id`); // the learner's extension (L5.5) moves the due date
  const rows = r.recordset || [];
  const open = rows.map((x) => ({ x, m: X.withExtension(A.model(x), x) })).filter(({ m }) => windowOf(m, settings, now).open);
  const items = open.slice(0, MAX_PENDING).map(({ x, m }) => ({
    assignmentId: m.id, courseId: m.courseId, courseTitle: x.course_title, title: m.title, dueAt: m.dueAt ? m.dueAt.toISOString() : null,
    overdue: !!(m.dueAt && now > m.dueAt), maxPoints: m.maxPoints,
  }));
  return { items, more: open.length > MAX_PENDING || rows.length >= PENDING_CANDIDATES };
}

/* Newest returned grades (L4.1b). Returned only; enrolment, published course and available assignment are enforced in SQL; the student id is the token's. */
async function recentFeedback(pool, sid, { tenant, now } = {}) {
  await releaseDue(pool, { studentId: sid }, { tenant, now }); // grades whose scheduled release time has passed are returned first
  const r = await pool.request().input("s", sql.Int, sid)
    .query(`SELECT TOP ${MAX_FEEDBACK} g.assignment_id, g.course_id, c.title AS course_title, a.title AS assignment_title, sb.attempt_no, g.final_points, g.max_points, g.returned_at,
        CASE WHEN LEN(LTRIM(RTRIM(COALESCE(g.comment, '')))) > 0 THEN 1 ELSE 0 END AS has_comment
      FROM lms_submission_grades g
      JOIN lms_submissions sb ON sb.id = g.submission_id AND sb.student_id = @s AND sb.course_id = g.course_id AND sb.assignment_id = g.assignment_id AND sb.status = 'submitted'
      JOIN lms_assignments a ON a.id = g.assignment_id AND a.course_id = g.course_id AND ${A.AVAILABLE}
      JOIN lms_courses c ON c.id = g.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      WHERE g.student_id = @s AND g.status = 'returned' AND ${ENROLLED("g.course_id", "@s")}
      ORDER BY g.returned_at DESC, g.id DESC`);
  return (r.recordset || []).map((x) => ({
    assignmentId: x.assignment_id, courseId: x.course_id, courseTitle: x.course_title, title: x.assignment_title, attemptNo: x.attempt_no,
    finalPoints: Number(x.final_points), maxPoints: Number(x.max_points), returnedAt: x.returned_at || null, hasComment: !!x.has_comment,
  }));
}

async function getDashboard(pool, user, now = new Date(), { tenant } = {}) {
  const a = actorOf(user);
  if (!a || a.source !== "Students" || a.role !== "student") return { ok: false, forbidden: true, errors: ["Only students have a dashboard."] };
  const errors = {};
  const part = async (name, fn, fallback) => { try { return await fn(); } catch (e) { console.error(`LMS DASHBOARD ${name} ERROR:`, e.message); errors[name] = "UNAVAILABLE"; return fallback; } };
  const cont = await part("continueLearning", () => continueLearning(pool, a.id), []);
  const cards = await part("courses", () => courseCards(pool, a.id), { items: [], totalCourses: 0, pendingRequests: 0 });
  const soon = await part("upcoming", () => upcoming(pool, user, now), { items: [], more: false });
  const news = await part("announcements", () => recentAnnouncements(pool, a.id), { items: [], total: 0 });
  const todo = await part("pendingTasks", () => pendingTasks(pool, a.id, now), { items: [], more: false });
  const fb = await part("recentFeedback", () => recentFeedback(pool, a.id, { tenant, now }), []);
  return { ok: true, continueLearning: cont, courses: cards.items, totalCourses: cards.totalCourses, pendingRequests: cards.pendingRequests, upcoming: soon.items, upcomingMore: soon.more, announcements: news.items, announcementsTotal: news.total, pendingTasks: todo.items, pendingTasksMore: todo.more, recentFeedback: fb, errors };
}

module.exports = { courseCards, getDashboard, VISIBLE_L, VISIBLE, MAX_CONTINUE, MAX_COURSES, MAX_UPCOMING, MAX_ANNOUNCEMENTS, UPCOMING_DAYS, MAX_PENDING, PENDING_CANDIDATES, MAX_FEEDBACK };
