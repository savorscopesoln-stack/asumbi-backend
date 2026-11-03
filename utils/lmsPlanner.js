/* =========================================================================
   LMS STUDENT PLANNER  (L4.5a)  one dated list for the signed-in STUDENT, plus an iCalendar (.ics) download.

   Sources: assignment due dates (L5.1a) and course calendar events (lms_course_events: events, deadlines, lessons, exams) of courses the student is
   ACTIVELY enrolled in and that are PUBLISHED. Later phases plug more sources into SOURCES (assignment due dates in L5,
   quiz windows in L6) without changing the routes.
   Deliberately NOT included: titles of lessons that are scheduled but not yet released (that would leak hidden content).

   Rules:
   - The student id comes from the token (never the request). Enrolment is checked inside the same query (EXISTS), so
     another student's, a withdrawn, a pending or an unpublished/archived/deleted course never appears.
   - Window: default 7 days back to 60 days ahead; `from`/`to` ISO dates; at most 120 days; at most 500 rows
     (`truncated: true` when the cap was hit). Items sorted by start time.
   - .ics: authenticated download only (no public feed URL), CRLF lines, text escaped, lines folded at 75 octets,
     UIDs carry no tenant or personal data.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");

const MAX_ROWS = 500, MAX_WINDOW_DAYS = 120, DEFAULT_BACK = 7, DEFAULT_AHEAD = 60, DAY = 864e5;
const parseDate = (v) => { if (typeof v !== "string" || v.length < 10 || v.length > 40) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

function windowOf({ from, to } = {}, now = new Date()) {
  const f = from ? parseDate(from) : new Date(now.getTime() - DEFAULT_BACK * DAY);
  const t = to ? parseDate(to) : new Date((from && f ? f.getTime() : now.getTime()) + DEFAULT_AHEAD * DAY);
  if (!f || !t) return { ok: false, errors: ["from and to must be ISO dates."] };
  if (t < f) return { ok: false, errors: ["to cannot be before from."] };
  if ((t - f) / DAY > MAX_WINDOW_DAYS) return { ok: false, errors: [`The date range can be at most ${MAX_WINDOW_DAYS} days.`] };
  return { ok: true, f, t };
}

const studentOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a : null; };

async function courseEvents(pool, studentId, f, t) {
  const r = await pool.request().input("s", sql.Int, studentId).input("f", sql.DateTime2, f).input("t", sql.DateTime2, t)
    .query(`SELECT TOP ${MAX_ROWS} e.id, e.course_id, c.title AS course_title, e.title, e.description, e.event_type, e.starts_at, e.ends_at, e.all_day
      FROM lms_course_events e
      JOIN lms_courses c ON c.id = e.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      WHERE e.deleted_at IS NULL AND e.starts_at >= @f AND e.starts_at <= @t
        AND EXISTS (SELECT 1 FROM lms_course_enrolments en WHERE en.course_id = e.course_id AND en.student_id = @s AND en.status = 'active')
      ORDER BY e.starts_at, e.id`);
  return (r.recordset || []).map((x) => ({
    key: `event-${x.id}`, kind: "course_event", eventType: x.event_type, courseId: x.course_id, courseTitle: x.course_title,
    title: x.title, description: x.description || null, startsAt: x.starts_at, endsAt: x.ends_at || null, allDay: !!x.all_day,
  }));
}
/* Assignment deadlines (L5.1a). Only published, already-AVAILABLE assignments with a due date, in published courses the student is
   actively enrolled in. A hidden or not-yet-available assignment never shows (its title would leak). One the student has already handed in (L5.2a) is dropped. */
async function assignmentDeadlines(pool, studentId, f, t) {
  const r = await pool.request().input("s", sql.Int, studentId).input("f", sql.DateTime2, f).input("t", sql.DateTime2, t)
    .query(`SELECT TOP ${MAX_ROWS} a.id, a.course_id, c.title AS course_title, a.title, CASE WHEN x.due_at IS NOT NULL AND x.due_at > a.due_at THEN x.due_at ELSE a.due_at END AS due_at
      FROM lms_assignments a
      JOIN lms_courses c ON c.id = a.course_id AND c.status = 'published' AND c.deleted_at IS NULL
      LEFT JOIN lms_extensions x ON x.assignment_id = a.id AND x.course_id = a.course_id AND x.student_id = @s
      WHERE a.status = 'published' AND a.deleted_at IS NULL AND a.due_at IS NOT NULL AND CASE WHEN x.due_at IS NOT NULL AND x.due_at > a.due_at THEN x.due_at ELSE a.due_at END >= @f AND CASE WHEN x.due_at IS NOT NULL AND x.due_at > a.due_at THEN x.due_at ELSE a.due_at END <= @t
        AND (a.available_from IS NULL OR a.available_from <= SYSUTCDATETIME())
        AND EXISTS (SELECT 1 FROM lms_course_enrolments en WHERE en.course_id = a.course_id AND en.student_id = @s AND en.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM lms_submissions sb WHERE sb.assignment_id = a.id AND sb.course_id = a.course_id AND sb.student_id = @s AND sb.status = 'submitted')
      ORDER BY CASE WHEN x.due_at IS NOT NULL AND x.due_at > a.due_at THEN x.due_at ELSE a.due_at END, a.id`);
  return (r.recordset || []).map((x) => ({
    key: `assignment-${x.id}`, kind: "assignment_due", eventType: "assignment", courseId: x.course_id, courseTitle: x.course_title,
    title: `Due: ${x.title}`, description: null, startsAt: x.due_at, endsAt: null, allDay: false,
  }));
}
const SOURCES = [courseEvents, assignmentDeadlines];

/* Shared by the signed-in planner and the subscription feed: all sources for ONE student id, one window. */
async function itemsForStudent(pool, studentId, w) {
  let items = [];
  for (const src of SOURCES) items = items.concat(await src(pool, studentId, w.f, w.t));
  items.sort((x, y) => new Date(x.startsAt) - new Date(y.startsAt) || String(x.key).localeCompare(String(y.key)));
  const truncated = items.length > MAX_ROWS; if (truncated) items = items.slice(0, MAX_ROWS);
  return { ok: true, from: w.f.toISOString(), to: w.t.toISOString(), truncated, items };
}

async function getPlanner(pool, user, query = {}, now = new Date()) {
  const a = studentOf(user); if (!a) return { ok: false, forbidden: true, errors: ["Only students have a planner."] };
  const w = windowOf(query, now); if (!w.ok) return w;
  return itemsForStudent(pool, a.id, w);
}

/* ---- iCalendar ---- */
const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) {
  const out = []; let cur = "", bytes = 0;
  for (const ch of line) { const b = Buffer.byteLength(ch); if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; } cur += ch; bytes += b; }
  out.push(cur); return out.join("\r\n ");
}
const stamp = (d) => iso(d).replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (d) => iso(d).slice(0, 10).replace(/-/g, "");

function toIcs(items, now = new Date()) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Doravo//LMS Planner//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const it of items) {
    L.push("BEGIN:VEVENT", `UID:${String(it.key).replace(/[^A-Za-z0-9_-]/g, "")}@doravo-lms`, `DTSTAMP:${stamp(now)}`);
    if (it.allDay) L.push(`DTSTART;VALUE=DATE:${dateOnly(it.startsAt)}`);
    else { L.push(`DTSTART:${stamp(it.startsAt)}`); if (it.endsAt) L.push(`DTEND:${stamp(it.endsAt)}`); }
    L.push(`SUMMARY:${esc(`${it.title} (${it.courseTitle})`)}`);
    if (it.description) L.push(`DESCRIPTION:${esc(it.description)}`);
    L.push(`CATEGORIES:${esc((it.eventType || "event").toUpperCase())}`, "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return `${L.map(fold).join("\r\n")}\r\n`;
}

module.exports = { getPlanner, itemsForStudent, windowOf, toIcs, SOURCES, MAX_ROWS, MAX_WINDOW_DAYS };
