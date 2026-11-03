/* =========================================================================
   LMS STUDENT COURSE LISTS  (L2.6a)

   Two read-only, paginated lists for the signed-in STUDENT:
     - listMyCourses:  courses I am enrolled in (active) or have asked to join (pending)
     - listCatalogue:  published, listed courses I could join

   Rules that matter here:
   - The student id comes from the token (actorOf), never from the request, so
     one student can never read another's list by changing a parameter.
   - Students only ever see PUBLISHED courses (archived ones only when they ask
     for them, and only courses they were enrolled in). Drafts, pending-approval
     and deleted courses never appear.
   - The catalogue never shows courses the student is already in or waiting for.
     `canRequest` mirrors selfEnrol() in lmsEnrolment.js: no row, or they left on
     their own; and the tenant enrolment mode is open/approval.
   - Teacher names only (no ids, no contact details). Explicit columns, no SELECT *.
   - Every query is parameterised and bounded (pageSize max 50).
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");

const MAX_PAGE_SIZE = 50;
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const posInt = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
const likeEscape = (t) => t.replace(/[\\%_\[]/g, (m) => `\\${m}`);
const truthy = (v) => v === true || v === "1" || v === "true" || v === 1;

const studentOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a : null; };

/* First 300 characters of the description: enough for a card, keeps the payload small. */
const blurb = (d) => { const t = String(d || ""); return t.length > 300 ? `${t.slice(0, 300).trimEnd()}…` : t; };

const TEACHER_SUBQUERY = `(SELECT TOP 1 COALESCE(t.name, u.name)
    FROM lms_course_staff s
    LEFT JOIN Teachers t ON s.user_source = 'Teachers' AND t.id = s.user_id
    LEFT JOIN users u ON s.user_source = 'Users' AND u.id = s.user_id
    WHERE s.course_id = c.id AND s.is_active = 1 AND s.staff_role = 'owner' ORDER BY s.id)`;

function paging(query) {
  return {
    page: Math.max(1, posInt(query.page) || 1),
    pageSize: Math.min(MAX_PAGE_SIZE, posInt(query.pageSize) || 12),
    q: oneLine(query.q).slice(0, 100),
    year: posInt(query.academicYear),
  };
}

const card = (r) => ({
  id: r.id, code: r.code, title: r.title, description: blurb(r.description),
  academicYear: r.academic_year, semester: r.semester || null, className: r.class_name || null,
  teacherName: r.teacher_name || null,
});

/* Enrolled (active) or requested (pending) courses. ?q=&academicYear=&includeArchived=1&page=&pageSize= */
async function listMyCourses(pool, user, query = {}) {
  const me = studentOf(user);
  if (!me) return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  const { page, pageSize, q, year } = paging(query);
  const statuses = truthy(query.includeArchived) ? `'published','archived'` : `'published'`; // fixed literals, never user text
  const where = [`e.student_id = @sid`, `e.status IN ('active','pending')`, `c.deleted_at IS NULL`, `c.status IN (${statuses})`];
  const req = pool.request().input("sid", sql.Int, me.id);
  if (year !== null) { where.push("c.academic_year = @year"); req.input("year", sql.Int, year); }
  if (q) { where.push("(c.title LIKE @q ESCAPE '\\' OR c.code LIKE @q ESCAPE '\\')"); req.input("q", sql.NVarChar(210), `%${likeEscape(q)}%`); }
  req.input("off", sql.Int, (page - 1) * pageSize).input("lim", sql.Int, pageSize);
  const r = await req.query(`
    SELECT c.id, c.code, c.title, c.description, c.academic_year, c.semester, c.class_name, c.status,
           e.status AS my_status, e.enrolled_at, ${TEACHER_SUBQUERY} AS teacher_name, COUNT(*) OVER() AS total_count
    FROM lms_course_enrolments e
    INNER JOIN lms_courses c ON c.id = e.course_id
    WHERE ${where.join(" AND ")}
    ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, c.academic_year DESC, c.title ASC, c.id ASC
    OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return {
    ok: true, page, pageSize, total: rows.length ? rows[0].total_count : 0,
    items: rows.map((x) => ({ ...card(x), courseStatus: x.status, myStatus: x.my_status, enrolledAt: x.enrolled_at })),
  };
}

/* Published + listed courses the student is NOT already in or waiting for. mode = tenant enrolment default. */
async function listCatalogue(pool, user, mode, query = {}) {
  const me = studentOf(user);
  if (!me) return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  const { page, pageSize, q, year } = paging(query);
  const where = [`c.deleted_at IS NULL`, `c.status = 'published'`, `c.visibility = 'listed'`,
    `(e.id IS NULL OR e.status NOT IN ('active','pending'))`];
  const req = pool.request().input("sid", sql.Int, me.id);
  if (year !== null) { where.push("c.academic_year = @year"); req.input("year", sql.Int, year); }
  if (q) { where.push("(c.title LIKE @q ESCAPE '\\' OR c.code LIKE @q ESCAPE '\\')"); req.input("q", sql.NVarChar(210), `%${likeEscape(q)}%`); }
  req.input("off", sql.Int, (page - 1) * pageSize).input("lim", sql.Int, pageSize);
  const r = await req.query(`
    SELECT c.id, c.code, c.title, c.description, c.academic_year, c.semester, c.class_name,
           e.status AS my_status,
           (SELECT TOP 1 h.action FROM lms_enrolment_history h WHERE h.course_id = c.id AND h.student_id = @sid ORDER BY h.id DESC) AS last_action,
           ${TEACHER_SUBQUERY} AS teacher_name, COUNT(*) OVER() AS total_count
    FROM lms_courses c
    LEFT JOIN lms_course_enrolments e ON e.course_id = c.id AND e.student_id = @sid
    WHERE ${where.join(" AND ")}
    ORDER BY c.academic_year DESC, c.title ASC, c.id ASC
    OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  const open = mode === "open" || mode === "approval";
  return {
    ok: true, page, pageSize, total: rows.length ? rows[0].total_count : 0, enrolmentMode: open ? mode : "closed",
    items: rows.map((x) => ({
      ...card(x),
      // Mirrors selfEnrol(): a student who was removed by staff cannot come back on their own.
      canRequest: open && (!x.my_status || x.last_action === "self_withdrawn"),
      previouslyEnrolled: !!x.my_status,
    })),
  };
}

module.exports = { MAX_PAGE_SIZE, listMyCourses, listCatalogue, blurb };
