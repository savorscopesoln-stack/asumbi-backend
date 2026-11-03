/* =========================================================================
   LMS NOTIFICATIONS  (L4.4b)  in-app notifications for LMS events.

   Rides on the EXISTING Notifications table and utils/notify.js (audit S16): rows are written with
   recipientSource 'Students', so they show up in the inbox the school already uses. Email/SMS/WhatsApp are NOT sent here
   (those channels belong to the admin broadcast feature); the setting `notifications.inApp` can switch these off per tenant.

   What notifies whom (documented defaults, open question 26):
   - lms.announcement.published, course announcement  -> students ACTIVELY enrolled in that course.
   - lms.announcement.published, school-wide          -> all active students (staff are not notified).
   - lms.enrolment.changed, action approved / declined -> that one student. Other actions notify nobody
     (self-service and bulk actions are the student's own or already visible).
   - lms.grade.released (L5.4b-3 follow-up, A61) -> that one student, in-app only, students only (never guardians or staff; S19 defaults). The notice carries NO mark
     or comment, only the assignment and course names. It is sent only if the grade is really `returned` NOW, belongs to that student, assignment and course, and the
     course is published, so a notice can never reveal or precede a grade the student cannot yet see. One event per grade (the release UPDATE only changes draft rows).
   - lms.extension.granted (L5.5 follow-up, A65) -> that one student, in-app only. Sent only if the extension row still exists for that student, assignment and course, the
     assignment is published and not deleted and the course is published. The notice states the NEW due date; no reason text (the teacher's reason may be private).

   - lms.discussion.posted (L8.1c, D-097) -> LEARNERS ONLY, in-app only: when someone REPLIES in a thread (the opening post of a new thread notifies nobody), the learner who
     started the thread and the learners who replied before are told, except the poster. Sent only if the reply is live, not hidden and fresh (<= 120 s), its thread is live and not
     hidden, the forum is not staff only, the course is published and the licence flag `lms_discussions` is sold; each recipient must be ACTIVELY enrolled and their own earlier
     post must still be visible. At most one notice per (learner, thread) per 10 minutes, at most 200 recipients. The notice names the thread and the course and carries NO post text and
     NO author name. Staff are never notified (S19 default).

   Safety rules:
   - Subscriber is wired by register(): every event is checked for the `lms` licence first (jobs are gated like routes),
     then for the tenant setting. A failure is logged and never reaches the emitter (the bus already isolates handlers).
   - Events carry ids only; title/body are read back from the database. The announcement must still be published, live,
     and belong to the course named in the event.
   - A re-publish after an unpublish emits the event again; the announcement is only notified if it was first published
     in the last 2 minutes (published_at is kept from the first publish), so no duplicates.
   - Recipients are read in keyset batches (500) and capped (course 10 000, school 20 000) so one event cannot run away.
   - Notification text is plain text, cut to fit; no personal data beyond what the recipient already sees.
========================================================================= */
const sql = require("mssql");
const events = require("./lmsEvents");
const { getSettings } = require("./lmsSettings");

const BATCH = 500, MAX_COURSE = 10000, MAX_SCHOOL = 20000, FRESH_SECONDS = 120;
const TYPE_ANNOUNCEMENT = "lms_announcement", TYPE_ENROLMENT = "lms_enrolment", TYPE_GRADE = "lms_grade", TYPE_EXTENSION = "lms_extension", TYPE_QUIZ = "lms_quiz", TYPE_DISCUSSION = "lms_discussion", TYPE_HELP = "lms_help", DISC_DEBOUNCE_MINUTES = 10, DISC_MAX_RECIPIENTS = 200;
const cut = (v, n) => { const s = String(v ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/* Reads one batch of student ids after `last`. Keyset paging, parameterised. */
async function nextStudents(pool, courseId, last) {
  const req = pool.request().input("last", sql.Int, last);
  const q = courseId === null
    ? `SELECT TOP ${BATCH} id AS student_id FROM Students WHERE status = 'active' AND id > @last ORDER BY id`
    : (req.input("c", sql.Int, courseId), `SELECT TOP ${BATCH} student_id FROM lms_course_enrolments WHERE course_id = @c AND status = 'active' AND student_id > @last ORDER BY student_id`);
  const r = await req.query(q);
  return (r.recordset || []).map((x) => x.student_id).filter((x) => Number.isInteger(x));
}

async function fanOut(pool, notify, courseId, opts) {
  const cap = courseId === null ? MAX_SCHOOL : MAX_COURSE;
  let last = 0, sent = 0;
  while (sent < cap) {
    const ids = await nextStudents(pool, courseId, last);
    if (!ids.length) break;
    const room = cap - sent, use = ids.slice(0, room);
    await notify(pool, use.map((id) => ({ id, source: "Students" })), opts);
    sent += use.length; last = ids[ids.length - 1];
    if (ids.length < BATCH) break;
  }
  return sent;
}

async function onAnnouncementPublished(evt, deps) {
  const pool = await deps.getPool(evt.tenant);
  const announcementId = posInt(evt.announcementId), courseId = evt.courseId === null || evt.courseId === undefined ? null : posInt(evt.courseId);
  if (!announcementId || (evt.courseId != null && !courseId)) return { sent: 0, skipped: "BAD_EVENT" };
  const req = pool.request().input("id", sql.Int, announcementId).input("fresh", sql.Int, FRESH_SECONDS);
  let where = "a.id = @id AND a.status = 'published' AND a.deleted_at IS NULL AND a.published_at IS NOT NULL AND DATEDIFF(SECOND, a.published_at, SYSUTCDATETIME()) <= @fresh";
  if (courseId === null) where += " AND a.course_id IS NULL"; else { req.input("c", sql.Int, courseId); where += " AND a.course_id = @c"; }
  const r = await req.query(`SELECT a.title, a.body, c.title AS course_title, c.status AS course_status
    FROM lms_announcements a LEFT JOIN lms_courses c ON c.id = a.course_id WHERE ${where}`);
  const a = r.recordset && r.recordset[0];
  if (!a) return { sent: 0, skipped: "NOT_CURRENT" };
  if (courseId !== null && a.course_status !== "published") return { sent: 0, skipped: "COURSE_NOT_PUBLISHED" };
  const title = courseId === null ? cut(a.title, 200) : cut(`${a.course_title}: ${a.title}`, 200);
  const sent = await fanOut(pool, deps.notify, courseId, {
    title, message: cut(a.body, 500), type: TYPE_ANNOUNCEMENT,
    link: courseId === null ? "/student/courses" : `/student/courses/${courseId}/learn`,
  });
  return { sent };
}

async function onEnrolmentChanged(evt, deps) {
  if (evt.action !== "approved" && evt.action !== "declined") return { sent: 0, skipped: "NO_NOTICE" };
  const courseId = posInt(evt.courseId), studentId = posInt(evt.studentId);
  if (!courseId || !studentId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT title FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const course = r.recordset && r.recordset[0];
  if (!course) return { sent: 0, skipped: "NO_COURSE" };
  const ok = evt.action === "approved";
  await deps.notify(pool, [{ id: studentId, source: "Students" }], {
    title: cut(ok ? `Enrolment approved: ${course.title}` : `Enrolment declined: ${course.title}`, 200),
    message: ok ? `Your request to join "${cut(course.title, 150)}" was approved. You can start learning now.` : `Your request to join "${cut(course.title, 150)}" was not approved. Ask your teacher if you have questions.`,
    type: TYPE_ENROLMENT, link: ok ? `/student/courses/${courseId}/learn` : "/student/courses",
  });
  return { sent: 1 };
}

async function onGradeReleased(evt, deps) {
  const courseId = posInt(evt.courseId), assignmentId = posInt(evt.assignmentId), submissionId = posInt(evt.submissionId), studentId = posInt(evt.studentId);
  if (!courseId || !assignmentId || !submissionId || !studentId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  const r = await pool.request().input("sub", sql.Int, submissionId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT a.title AS assignment_title, c.title AS course_title
      FROM lms_submission_grades g JOIN lms_assignments a ON a.id = g.assignment_id JOIN lms_courses c ON c.id = g.course_id
      WHERE g.submission_id = @sub AND g.assignment_id = @a AND g.course_id = @c AND g.student_id = @s AND g.status = 'returned'
        AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = 'published'`);
  const x = r.recordset && r.recordset[0];
  if (!x) return { sent: 0, skipped: "NOT_CURRENT" };
  await deps.notify(pool, [{ id: studentId, source: "Students" }], {
    title: cut(`Feedback returned: ${x.assignment_title}`, 200),
    message: `Your teacher has returned your work for "${cut(x.assignment_title, 150)}" in "${cut(x.course_title, 150)}". Open the course to see your mark and feedback.`,
    type: TYPE_GRADE, link: `/student/courses/${courseId}/learn`,
  });
  return { sent: 1 };
}

async function onExtensionGranted(evt, deps) {
  const courseId = posInt(evt.courseId), assignmentId = posInt(evt.assignmentId), studentId = posInt(evt.studentId);
  if (!courseId || !assignmentId || !studentId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT a.title AS assignment_title, c.title AS course_title, x.due_at
      FROM lms_extensions x JOIN lms_assignments a ON a.id = x.assignment_id AND a.course_id = x.course_id JOIN lms_courses c ON c.id = x.course_id
      WHERE x.assignment_id = @a AND x.course_id = @c AND x.student_id = @s
        AND a.status = 'published' AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = 'published'`);
  const x = r.recordset && r.recordset[0];
  if (!x) return { sent: 0, skipped: "NOT_CURRENT" };
  const due = new Date(x.due_at); if (Number.isNaN(due.getTime())) return { sent: 0, skipped: "NOT_CURRENT" };
  await deps.notify(pool, [{ id: studentId, source: "Students" }], {
    title: cut(`More time: ${x.assignment_title}`, 200),
    message: `Your teacher gave you more time for "${cut(x.assignment_title, 150)}" in "${cut(x.course_title, 150)}". New due date: ${due.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    type: TYPE_EXTENSION, link: `/student/courses/${courseId}/learn`,
  });
  return { sent: 1 };
}

/* lms.quiz.graded (Q46 = yes, S34) -> that one student, in-app only. Only when a TEACHER finished marking (`evt.manual === true`): a quiz that was auto-graded at submit
   is already on the learner's screen. Sent only if the attempt is `graded` NOW and belongs to that student, quiz and course, the quiz is published and not deleted and the
   course is published. The notice carries NO score or comment (feedback timing may hide them), only the quiz and course names. */
async function onQuizGraded(evt, deps) {
  if (evt.manual !== true) return { sent: 0, skipped: "NOT_MANUAL" };
  const courseId = posInt(evt.courseId), quizId = posInt(evt.quizId), attemptId = posInt(evt.attemptId), studentId = posInt(evt.studentId);
  if (!courseId || !quizId || !attemptId || !studentId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  const r = await pool.request().input("at", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, studentId)
    .query(`SELECT z.title AS quiz_title, c.title AS course_title
      FROM lms_quiz_attempts t JOIN lms_quizzes z ON z.id = t.quiz_id AND z.course_id = t.course_id JOIN lms_courses c ON c.id = t.course_id
      WHERE t.id = @at AND t.quiz_id = @z AND t.course_id = @c AND t.student_id = @s AND t.status = 'graded'
        AND z.status = 'published' AND z.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = 'published'`);
  const x = r.recordset && r.recordset[0];
  if (!x) return { sent: 0, skipped: "NOT_CURRENT" };
  await deps.notify(pool, [{ id: studentId, source: "Students" }], {
    title: cut(`Quiz marked: ${x.quiz_title}`, 200),
    message: `Your teacher has marked your written answers for "${cut(x.quiz_title, 150)}" in "${cut(x.course_title, 150)}". Open the course to see your result.`,
    type: TYPE_QUIZ, link: `/student/courses/${courseId}/learn`,
  });
  return { sent: 1 };
}

/* lms.discussion.posted -> see the header. Recipients are decided in ONE query (visibility, enrolment and the 10 minute debounce are all in SQL). */
async function onDiscussionPosted(evt, deps) {
  const courseId = posInt(evt.courseId), threadId = posInt(evt.threadId), postId = posInt(evt.postId);
  if (!courseId || !threadId || !postId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  if (!(await deps.isActive(pool, evt.tenant, "lms", "lms_discussions"))) return { sent: 0, skipped: "NO_LICENCE" };
  const r = await pool.request().input("p", sql.Int, postId).input("t", sql.Int, threadId).input("c", sql.Int, courseId).input("fresh", sql.Int, FRESH_SECONDS)
    .query(`SELECT p.author_source, p.author_id, t.title AS thread_title, c.title AS course_title, f.group_id
      FROM lms_posts p JOIN lms_threads t ON t.id = p.thread_id AND t.course_id = p.course_id
        JOIN lms_forums f ON f.id = t.forum_id AND f.course_id = t.course_id JOIN lms_courses c ON c.id = p.course_id
      WHERE p.id = @p AND p.thread_id = @t AND p.course_id = @c AND p.is_opening = 0 AND p.deleted_at IS NULL AND p.hidden_at IS NULL
        AND t.deleted_at IS NULL AND t.hidden_at IS NULL AND f.deleted_at IS NULL AND f.staff_only = 0
        AND c.deleted_at IS NULL AND c.status = 'published' AND DATEDIFF(SECOND, p.created_at, SYSUTCDATETIME()) <= @fresh`);
  const x = r.recordset && r.recordset[0];
  if (!x) return { sent: 0, skipped: "NOT_CURRENT" };
  const link = `/student/courses/${courseId}/learn?discussion=${threadId}`, poster = x.author_source === "Students" && Number.isInteger(x.author_id) ? x.author_id : 0;
  const rr = await pool.request().input("p", sql.Int, postId).input("t", sql.Int, threadId).input("c", sql.Int, courseId).input("poster", sql.Int, poster).input("link", sql.NVarChar(200), link).input("deb", sql.Int, DISC_DEBOUNCE_MINUTES).input("gid", sql.Int, x.group_id ?? null)
    .query(`SELECT TOP ${DISC_MAX_RECIPIENTS} x.sid AS student_id FROM (
        SELECT th.author_id AS sid FROM lms_threads th WHERE th.id = @t AND th.course_id = @c AND th.author_source = N'Students'
        UNION
        SELECT p2.author_id AS sid FROM lms_posts p2 WHERE p2.thread_id = @t AND p2.course_id = @c AND p2.author_source = N'Students' AND p2.deleted_at IS NULL AND p2.hidden_at IS NULL AND p2.id < @p
      ) x JOIN lms_course_enrolments e ON e.course_id = @c AND e.student_id = x.sid AND e.status = 'active'
      WHERE x.sid <> @poster
        AND (@gid IS NULL OR EXISTS (SELECT 1 FROM lms_group_members gm JOIN lms_groups gg ON gg.id = gm.group_id AND gg.course_id = gm.course_id AND gg.deleted_at IS NULL WHERE gm.group_id = @gid AND gm.course_id = @c AND gm.student_id = x.sid AND gm.removed_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM Notifications n WHERE n.recipientId = x.sid AND n.recipientSource = N'Students' AND n.type = N'lms_discussion' AND n.link = @link AND n.createdAt > DATEADD(MINUTE, -@deb, GETDATE()))
      ORDER BY x.sid`);
  const ids = (rr.recordset || []).map((y) => y.student_id).filter((v) => Number.isInteger(v) && v !== poster);
  if (!ids.length) return { sent: 0, skipped: "NO_RECIPIENTS" };
  await deps.notify(pool, ids.map((id) => ({ id, source: "Students" })), {
    title: cut(`New reply: ${x.thread_title}`, 200),
    message: `There is a new reply in the discussion "${cut(x.thread_title, 150)}" in "${cut(x.course_title, 150)}". Open the course to read it.`,
    type: TYPE_DISCUSSION, link,
  });
  return { sent: ids.length };
}

/* lms.help.answered (L8.5, D-104) -> the ONE learner who asked, in-app only, students only. The notice never carries the reply text. */
async function onHelpAnswered(evt, deps) {
  const courseId = posInt(evt.courseId), requestId = posInt(evt.requestId);
  if (!courseId || !requestId) return { sent: 0, skipped: "BAD_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  if (!(await deps.isActive(pool, evt.tenant, "lms", "lms_discussions"))) return { sent: 0, skipped: "NO_LICENCE" };
  const r = await pool.request().input("h", sql.Int, requestId).input("c", sql.Int, courseId).input("fresh", sql.Int, FRESH_SECONDS)
    .query(`SELECT h.student_id, c.title AS course_title FROM lms_help_requests h JOIN lms_courses c ON c.id = h.course_id
      JOIN lms_course_enrolments e ON e.course_id = h.course_id AND e.student_id = h.student_id AND e.status = 'active'
      WHERE h.id = @h AND h.course_id = @c AND h.status = 'answered' AND h.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = 'published'
        AND DATEDIFF(SECOND, h.answered_at, SYSUTCDATETIME()) <= @fresh`);
  const x = r.recordset && r.recordset[0];
  if (!x || !Number.isInteger(x.student_id)) return { sent: 0, skipped: "NOT_CURRENT" };
  await deps.notify(pool, [{ id: x.student_id, source: "Students" }], {
    title: "Your help request was answered",
    message: `Your teacher has answered your help request in "${cut(x.course_title, 150)}". Open the course to read the answer.`,
    type: TYPE_HELP, link: `/student/courses/${courseId}/learn?help=${requestId}`,
  });
  return { sent: 1 };
}

const HANDLERS = Object.freeze({ "lms.discussion.posted": onDiscussionPosted, "lms.help.answered": onHelpAnswered, "lms.quiz.graded": onQuizGraded, "lms.extension.granted": onExtensionGranted, "lms.grade.released": onGradeReleased, "lms.announcement.published": onAnnouncementPublished, "lms.enrolment.changed": onEnrolmentChanged });

/* One gate for every handler: licence first, then the tenant setting. Returns the handler result (tests read it). */
async function handle(evt, deps) {
  const fn = HANDLERS[evt && evt.event];
  if (!fn) return { sent: 0, skipped: "UNKNOWN_EVENT" };
  const pool = await deps.getPool(evt.tenant);
  if (!(await deps.isActive(pool, evt.tenant, "lms"))) return { sent: 0, skipped: "NO_LICENCE" };
  const s = await getSettings(pool);
  if (!(s.notifications && s.notifications.inApp)) return { sent: 0, skipped: "DISABLED" };
  return fn(evt, deps);
}

/* Subscribes to the bus. Returns an unsubscribe function. deps default to the real helpers; tests pass fakes. */
function register(deps = {}) {
  const d = {
    getPool: deps.getPool || require("../config/db").getPool,
    notify: deps.notify || require("./notify").notifyUsers,
    isActive: deps.isActive || require("./tenantModules").isModuleActive,
    onResult: deps.onResult || null,
  };
  const offs = Object.keys(HANDLERS).map((name) => events.on(name, async (evt) => {
    const res = await handle(evt, d);
    if (d.onResult) d.onResult(evt, res);
  }));
  return () => offs.forEach((off) => off());
}

module.exports = { register, handle, BATCH, MAX_COURSE, MAX_SCHOOL, FRESH_SECONDS, TYPE_ANNOUNCEMENT, TYPE_ENROLMENT, TYPE_GRADE, TYPE_EXTENSION, TYPE_QUIZ, TYPE_DISCUSSION, TYPE_HELP, DISC_DEBOUNCE_MINUTES, DISC_MAX_RECIPIENTS };
