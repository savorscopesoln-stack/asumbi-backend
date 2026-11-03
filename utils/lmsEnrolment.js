/* =========================================================================
   LMS ENROLMENT  (L2.3)

   Like lmsCourses.js: routes own WHO may act; this file validates and queries.
   Rules that matter here:
   - Every enrolment row is matched by course_id AND student_id; ids are
     numbers validated before use; all SQL is parameterised.
   - Students are read with EXPLICIT columns only (legacy table has passwords).
   - Only students whose Students.status is 'active' can be enrolled (the same
     literal the rest of the app uses).
   - Students belong to a class by NAME (docs/LEGACY_SCHEMA.md): class-list
     enrolment joins on Students.studentClass = Classes.name, checks
     yearOfStudy against the Classes row and REPORTS every student it skipped.
   - Archived / pending courses are read-only (no enrolment changes).
   - Every change writes lms_enrolment_history; staff-driven bulk changes are
     also audited and emit lms.enrolment.changed (ids only, no personal data).
   - dryRun = validation report only, nothing is written.
   Status model: active | pending | withdrawn | transferred
     pending -> active (approve) | withdrawn (decline);  active|pending -> withdrawn;
     active -> transferred (moved to another course);  withdrawn|transferred -> active (re-enrol)
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const events = require("./lmsEvents");
const { actorOf } = require("./lmsPermissions");

const STATUSES = ["active", "pending", "withdrawn", "transferred"];
const SOURCES = ["manual", "bulk", "class_list", "self", "transfer"];
const MAX_MANUAL = 200, MAX_CSV_ROWS = 500, MAX_CSV_BYTES = 100 * 1024, MAX_CLASS = 1000, CHUNK = 100, MAX_PAGE_SIZE = 100;
const ADMISSION_HEADERS = ["admissionno", "admissionnumber", "admno", "adm"];

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const posInt = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const MSG = {
  STUDENT_NOT_FOUND: "No student found.", STUDENT_INACTIVE: "The student account is not active.", ALREADY_ENROLLED: "Already enrolled.",
  YEAR_MISMATCH: "The student's year of study does not match this class.", AMBIGUOUS: "More than one student has this admission number.",
};

/* The course must exist and be live; archived/pending courses are read-only. */
async function courseGate(pool, courseId) {
  const r = await pool.request().input("c", sql.Int, courseId)
    .query(`SELECT TOP 1 id, status, class_name, visibility FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0];
  if (!row) return { ok: false, notFound: true, errors: ["Course not found."] };
  if (row.status === "archived") return { ok: false, code: "COURSE_ARCHIVED", errors: ["An archived course must be restored before enrolment can change."] };
  if (row.status === "pending") return { ok: false, code: "COURSE_PENDING", errors: ["This course is waiting for approval."] };
  return { ok: true, course: { id: row.id, status: row.status, className: row.class_name || null, visibility: row.visibility } };
}

/* ------------------------------ student lookups ------------------------------ */
const STUDENT_COLS = "id, name, admissionNo, studentClass, yearOfStudy, status";
const isActiveStudent = (s) => String(s?.status || "").toLowerCase() === "active";

async function lookupStudents(pool, ids) {
  const map = new Map();
  for (const part of chunks(ids, CHUNK)) {
    const req = pool.request();
    const names = part.map((id, i) => { req.input(`s${i}`, sql.Int, id); return `@s${i}`; });
    const r = await req.query(`SELECT ${STUDENT_COLS} FROM Students WHERE id IN (${names.join(",")})`);
    for (const row of r.recordset || []) map.set(row.id, row);
  }
  return map;
}

/* Returns Map(lowercased admissionNo -> [rows]); more than one row = ambiguous. */
async function lookupByAdmission(pool, numbers) {
  const map = new Map();
  for (const part of chunks(numbers, CHUNK)) {
    const req = pool.request();
    const names = part.map((n, i) => { req.input(`a${i}`, sql.NVarChar(50), n); return `@a${i}`; });
    const r = await req.query(`SELECT ${STUDENT_COLS} FROM Students WHERE admissionNo IN (${names.join(",")})`);
    for (const row of r.recordset || []) {
      const k = String(row.admissionNo || "").trim().toLowerCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
  }
  return map;
}

async function existingRows(pool, courseId, ids) {
  const map = new Map();
  for (const part of chunks(ids, CHUNK)) {
    const req = pool.request().input("c", sql.Int, courseId);
    const names = part.map((id, i) => { req.input(`s${i}`, sql.Int, id); return `@s${i}`; });
    const r = await req.query(`SELECT student_id, status FROM lms_course_enrolments WHERE course_id = @c AND student_id IN (${names.join(",")})`);
    for (const row of r.recordset || []) map.set(row.student_id, row.status);
  }
  return map;
}

/* ------------------------------ pure planning ------------------------------ */
/* students: Map(id -> row), existing: Map(id -> status).
   Returns { todo:[{id, action, from}], skipped:[{studentId, code, message}], failed:[...] } */
function classify(ids, students, existing, { inactiveIsSkip = false } = {}) {
  const todo = [], skipped = [], failed = [];
  for (const id of ids) {
    const s = students.get(id);
    if (!s) { failed.push({ studentId: id, code: "STUDENT_NOT_FOUND", message: MSG.STUDENT_NOT_FOUND }); continue; }
    if (!isActiveStudent(s)) { (inactiveIsSkip ? skipped : failed).push({ studentId: id, code: "STUDENT_INACTIVE", message: MSG.STUDENT_INACTIVE }); continue; }
    const cur = existing.get(id);
    if (cur === "active") { skipped.push({ studentId: id, code: "ALREADY_ENROLLED", message: MSG.ALREADY_ENROLLED }); continue; }
    if (cur === "pending") todo.push({ id, action: "approved", from: "pending" });
    else if (cur === "withdrawn" || cur === "transferred") todo.push({ id, action: "reenrolled", from: cur });
    else todo.push({ id, action: "enrolled", from: null });
  }
  return { todo, skipped, failed };
}

/* ------------------------------ writing ------------------------------ */
async function writeEnrolments(pool, actor, courseId, todo, source) {
  for (const part of chunks(todo, CHUNK)) {
    const req = pool.request().input("c", sql.Int, courseId).input("src", sql.NVarChar(20), source)
      .input("as", sql.NVarChar(20), actor.source).input("ai", sql.Int, actor.id);
    const stmts = part.map((t, i) => {
      req.input(`s${i}`, sql.Int, t.id).input(`a${i}`, sql.NVarChar(30), t.action).input(`f${i}`, sql.NVarChar(20), t.from);
      const write = t.action === "enrolled"
        ? `INSERT INTO lms_course_enrolments (course_id, student_id, status, source, created_by_source, created_by)
           SELECT @c, @s${i}, 'active', @src, @as, @ai WHERE NOT EXISTS (SELECT 1 FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s${i});`
        : `UPDATE lms_course_enrolments SET status = 'active', source = @src, status_changed_at = SYSUTCDATETIME()
           WHERE course_id = @c AND student_id = @s${i} AND status IN ('pending','withdrawn','transferred');`;
      return `${write}
        INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, detail, actor_source, actor_id)
        VALUES (@c, @s${i}, @a${i}, @f${i}, 'active', @src, @as, @ai);`;
    });
    await req.query(`SET XACT_ABORT ON; BEGIN TRAN; ${stmts.join("\n")} COMMIT;`);
  }
}

const summarise = (todo, skipped, failed, requested) => ({
  requested, enrolled: todo.filter((t) => t.action === "enrolled").length, reenrolled: todo.filter((t) => t.action === "reenrolled").length,
  approved: todo.filter((t) => t.action === "approved").length, skipped: skipped.length, failed: failed.length,
});

/* Shared core: ids already validated, course gated, students loaded. */
async function applyEnrol(pool, user, courseId, ids, students, { source, dryRun, inactiveIsSkip = false }) {
  const actor = actorOf(user);
  if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const existing = await existingRows(pool, courseId, ids.filter((id) => students.has(id)));
  const { todo, skipped, failed } = classify(ids, students, existing, { inactiveIsSkip });
  const report = { ok: true, dryRun: !!dryRun, summary: summarise(todo, skipped, failed, ids.length), enrolled: todo.map((t) => t.id), skipped, failed };
  if (dryRun || !todo.length) return report;
  await writeEnrolments(pool, actor, courseId, todo, source);
  await audit(pool, actor, "enrolment.added", "lms_courses", courseId, { source, ...report.summary });
  events.emit("lms.enrolment.changed", { tenant: user?.tenant, courseId, action: "added", count: todo.length });
  return report;
}

/* ------------------------------ manual add ------------------------------ */
function validateStudentIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, errors: ["studentIds must be a non-empty list."] };
  if (ids.length > MAX_MANUAL) return { ok: false, errors: [`At most ${MAX_MANUAL} students can be added at once; use the CSV import for more.`] };
  const list = ids.map(posInt);
  if (list.some((x) => x === null)) return { ok: false, errors: ["studentIds must be positive integers."] };
  return { ok: true, ids: [...new Set(list)] };
}

async function enrolStudents(pool, user, courseId, body, { dryRun = false } = {}) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["studentIds", "dryRun"].includes(k))) return { ok: false, errors: ["Body must be { studentIds: [...] }."] };
  const v = validateStudentIds(body.studentIds); if (!v.ok) return v;
  const g = await courseGate(pool, courseId); if (!g.ok) return g;
  const students = await lookupStudents(pool, v.ids);
  return applyEnrol(pool, user, courseId, v.ids, students, { source: "manual", dryRun: dryRun || body.dryRun === true });
}

/* ------------------------------ bulk CSV ------------------------------ */
/* Small RFC-4180 reader: quotes, escaped quotes, CRLF, "," or ";" delimiter (decided from the header line). */
function parseCsv(text) {
  if (typeof text !== "string") return { ok: false, errors: ["csv must be text."] };
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) return { ok: false, code: "CSV_TOO_LARGE", errors: [`The CSV is larger than ${MAX_CSV_BYTES / 1024} KB. Split it into smaller files.`] };
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r\n|\n|\r/, 1)[0] || "";
  const delim = firstLine.includes(",") || !firstLine.includes(";") ? "," : ";";
  const rows = []; let row = [], cell = "", q = false, lineNo = 1, rowLine = 1;
  const endRow = () => { row.push(cell); cell = ""; rows.push({ line: rowLine, cells: row }); row = []; rowLine = lineNo + 1; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else { if (ch === "\n") lineNo++; cell += ch; } continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\r" || ch === "\n") { if (ch === "\r" && src[i + 1] === "\n") i++; endRow(); lineNo++; rowLine = lineNo; }
    else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  const header = rows.shift();
  if (!header) return { ok: false, errors: ["The CSV is empty."] };
  const col = header.cells.findIndex((h) => ADMISSION_HEADERS.includes(String(h).toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (col < 0) return { ok: false, code: "CSV_NO_HEADER", errors: ['The first row must be a header with an "admissionNo" column.'] };
  const data = rows.filter((r) => r.cells.some((c) => String(c).trim() !== ""));
  if (data.length > MAX_CSV_ROWS) return { ok: false, code: "CSV_TOO_MANY_ROWS", errors: [`At most ${MAX_CSV_ROWS} rows per file (found ${data.length}).`] };
  if (!data.length) return { ok: false, errors: ["The CSV has a header but no rows."] };
  return { ok: true, rows: data.map((r) => ({ line: r.line, admissionNo: oneLine(r.cells[col]).slice(0, 50) })) };
}

async function bulkEnrol(pool, user, courseId, body, { dryRun = false } = {}) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["csv", "dryRun"].includes(k))) return { ok: false, errors: ["Body must be { csv: \"...\", dryRun?: true }."] };
  const p = parseCsv(body.csv); if (!p.ok) return p;
  const g = await courseGate(pool, courseId); if (!g.ok) return g;
  const rowErrors = [], seen = new Map(), wanted = [];
  for (const r of p.rows) {
    if (!r.admissionNo) { rowErrors.push({ line: r.line, admissionNo: "", code: "EMPTY", message: "Admission number is empty." }); continue; }
    const k = r.admissionNo.toLowerCase();
    if (seen.has(k)) { rowErrors.push({ line: r.line, admissionNo: r.admissionNo, code: "DUPLICATE_IN_FILE", message: `Same admission number as line ${seen.get(k)}.` }); continue; }
    seen.set(k, r.line); wanted.push(r);
  }
  const found = await lookupByAdmission(pool, wanted.map((r) => r.admissionNo));
  const students = new Map(), lineOf = new Map(), ids = [];
  for (const r of wanted) {
    const hits = found.get(r.admissionNo.toLowerCase()) || [];
    if (!hits.length) { rowErrors.push({ line: r.line, admissionNo: r.admissionNo, code: "STUDENT_NOT_FOUND", message: MSG.STUDENT_NOT_FOUND }); continue; }
    if (hits.length > 1) { rowErrors.push({ line: r.line, admissionNo: r.admissionNo, code: "AMBIGUOUS", message: MSG.AMBIGUOUS }); continue; }
    const s = hits[0]; students.set(s.id, s); lineOf.set(s.id, { line: r.line, admissionNo: r.admissionNo }); ids.push(s.id);
  }
  const rep = await applyEnrol(pool, user, courseId, ids, students, { source: "bulk", dryRun: dryRun || body.dryRun === true });
  if (!rep.ok) return rep;
  const tag = (x) => ({ ...x, ...(lineOf.get(x.studentId) || {}) });
  const failed = [...rowErrors, ...rep.failed.map(tag)].sort((a, b) => (a.line || 0) - (b.line || 0));
  return {
    ...rep, skipped: rep.skipped.map(tag), failed,
    summary: { ...rep.summary, requested: p.rows.length, failed: failed.length },
  };
}

/* ------------------------------ class list ------------------------------ */
async function enrolClassList(pool, user, courseId, body, { dryRun = false } = {}) {
  if (body != null && (!isPlainObject(body) || Object.keys(body).some((k) => !["className", "dryRun"].includes(k)))) return { ok: false, errors: ["Body must be { className?: \"...\", dryRun?: true }."] };
  const g = await courseGate(pool, courseId); if (!g.ok) return g;
  const className = oneLine(body?.className ?? g.course.className);
  if (!className || className.length > 50) return { ok: false, code: "CLASS_REQUIRED", errors: ["Choose a class: set className in the request or on the course."] };
  const c = await pool.request().input("n", sql.NVarChar(50), className).query(`SELECT TOP 1 id, name, yearOfStudy FROM Classes WHERE name = @n`);
  const cls = c.recordset && c.recordset[0];
  if (!cls) return { ok: false, code: "CLASS_NOT_FOUND", errors: [`No class named "${className}" exists.`] };
  const r = await pool.request().input("n", sql.NVarChar(50), className)
    .query(`SELECT TOP ${MAX_CLASS + 1} ${STUDENT_COLS} FROM Students WHERE studentClass = @n ORDER BY id`);
  const rows = r.recordset || [];
  if (rows.length > MAX_CLASS) return { ok: false, code: "LIMIT_REACHED", errors: [`A class list can enrol at most ${MAX_CLASS} students at once.`] };
  const students = new Map(), ids = [], unmatched = [];
  for (const s of rows) {
    if (cls.yearOfStudy != null && s.yearOfStudy != null && Number(s.yearOfStudy) !== Number(cls.yearOfStudy)) { unmatched.push({ studentId: s.id, code: "YEAR_MISMATCH", message: MSG.YEAR_MISMATCH }); continue; }
    students.set(s.id, s); ids.push(s.id);
  }
  const rep = await applyEnrol(pool, user, courseId, ids, students, { source: "class_list", dryRun: dryRun || body?.dryRun === true, inactiveIsSkip: true });
  if (!rep.ok) return rep;
  return { ...rep, className, unmatched, summary: { ...rep.summary, requested: rows.length, unmatched: unmatched.length } };
}

/* ------------------------------ status changes ------------------------------ */
const ACTIONS = {
  withdraw: { from: ["active", "pending"], to: "withdrawn", history: "withdrawn" },
  approve: { from: ["pending"], to: "active", history: "approved" },
  decline: { from: ["pending"], to: "withdrawn", history: "declined" },
};

async function changeStatus(pool, user, courseId, studentIdRaw, action) {
  const def = ACTIONS[action]; const studentId = posInt(studentIdRaw);
  if (!def || studentId === null) return { ok: false, notFound: true, errors: ["Not found."] };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const g = await courseGate(pool, courseId); if (!g.ok) return g;
  if (action === "approve") {
    const s = (await lookupStudents(pool, [studentId])).get(studentId);
    if (s && !isActiveStudent(s)) return { ok: false, code: "STUDENT_INACTIVE", errors: [MSG.STUDENT_INACTIVE] };
  }
  const list = def.from.map((x) => `'${x}'`).join(",");
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).input("to", sql.NVarChar(20), def.to)
    .query(`UPDATE lms_course_enrolments SET status = @to, status_changed_at = SYSUTCDATETIME()
            OUTPUT DELETED.status AS from_status
            WHERE course_id = @c AND student_id = @s AND status IN (${list})`);
  const hit = r.recordset && r.recordset[0];
  if (!hit) {
    const cur = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).query(`SELECT TOP 1 status FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s`);
    if (!(cur.recordset && cur.recordset[0])) return { ok: false, notFound: true, errors: ["Enrolment not found."] };
    return { ok: false, code: "BAD_TRANSITION", errors: [`A ${cur.recordset[0].status} enrolment cannot be ${def.history}.`] };
  }
  await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).input("a", sql.NVarChar(30), def.history)
    .input("f", sql.NVarChar(20), hit.from_status).input("t", sql.NVarChar(20), def.to).input("as", sql.NVarChar(20), actor.source).input("ai", sql.Int, actor.id)
    .query(`INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, actor_source, actor_id) VALUES (@c, @s, @a, @f, @t, @as, @ai)`);
  await audit(pool, actor, `enrolment.${def.history}`, "lms_courses", courseId, { studentId });
  events.emit("lms.enrolment.changed", { tenant: user?.tenant, courseId, action: def.history, studentId });
  return { ok: true, status: def.to };
}

/* Moves an ACTIVE enrolment to another course. The caller (route) has already checked that the
   user may manage BOTH courses. One transaction: either both sides change or neither does. */
async function transferStudent(pool, user, fromCourseId, body, studentIdRaw) {
  const studentId = posInt(studentIdRaw);
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "toCourseId") || posInt(body.toCourseId) === null) return { ok: false, errors: ["Body must be { toCourseId: <course id> }."] };
  const toCourseId = posInt(body.toCourseId);
  if (studentId === null) return { ok: false, notFound: true, errors: ["Not found."] };
  if (toCourseId === fromCourseId) return { ok: false, errors: ["Choose a different course to transfer to."] };
  const actor = actorOf(user); if (!actor) return { ok: false, errors: ["Not authenticated."] };
  const gf = await courseGate(pool, fromCourseId); if (!gf.ok) return gf;
  const gt = await courseGate(pool, toCourseId); if (!gt.ok) return gt.notFound ? { ok: false, errors: ["The target course was not found."] } : gt;
  const here = (await existingRows(pool, fromCourseId, [studentId])).get(studentId);
  if (!here) return { ok: false, notFound: true, errors: ["Enrolment not found."] };
  if (here !== "active") return { ok: false, code: "BAD_TRANSITION", errors: [`Only an active enrolment can be transferred (this one is ${here}).`] };
  const s = (await lookupStudents(pool, [studentId])).get(studentId);
  if (!s || !isActiveStudent(s)) return { ok: false, code: "STUDENT_INACTIVE", errors: [MSG.STUDENT_INACTIVE] };
  const there = (await existingRows(pool, toCourseId, [studentId])).get(studentId);
  if (there === "active") return { ok: false, conflict: true, code: "ALREADY_ENROLLED", errors: ["The student is already enrolled in the target course."] };
  const insertOrRevive = there
    ? `UPDATE lms_course_enrolments SET status = 'active', source = 'transfer', status_changed_at = SYSUTCDATETIME() WHERE course_id = @b AND student_id = @s AND status IN ('pending','withdrawn','transferred');`
    : `INSERT INTO lms_course_enrolments (course_id, student_id, status, source, created_by_source, created_by)
       SELECT @b, @s, 'active', 'transfer', @as, @ai WHERE NOT EXISTS (SELECT 1 FROM lms_course_enrolments WHERE course_id = @b AND student_id = @s);`;
  try {
    await pool.request().input("a", sql.Int, fromCourseId).input("b", sql.Int, toCourseId).input("s", sql.Int, studentId)
      .input("as", sql.NVarChar(20), actor.source).input("ai", sql.Int, actor.id)
      .input("da", sql.NVarChar(300), `to course ${toCourseId}`).input("db", sql.NVarChar(300), `from course ${fromCourseId}`).input("tf", sql.NVarChar(20), there || null)
      .query(`SET XACT_ABORT ON; BEGIN TRAN;
        UPDATE lms_course_enrolments SET status = 'transferred', status_changed_at = SYSUTCDATETIME() WHERE course_id = @a AND student_id = @s AND status = 'active';
        IF @@ROWCOUNT = 0 THROW 50001, 'ENROLMENT_NOT_ACTIVE', 1;
        ${insertOrRevive}
        INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, detail, actor_source, actor_id) VALUES (@a, @s, 'transferred_out', 'active', 'transferred', @da, @as, @ai);
        INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, detail, actor_source, actor_id) VALUES (@b, @s, 'transferred_in', @tf, 'active', @db, @as, @ai);
        COMMIT;`);
  } catch (err) {
    if (err && (err.number === 50001 || /ENROLMENT_NOT_ACTIVE/.test(err.message || ""))) return { ok: false, code: "BAD_TRANSITION", errors: ["The enrolment changed while transferring. Please try again."] };
    throw err;
  }
  await audit(pool, actor, "enrolment.transferred", "lms_courses", fromCourseId, { studentId, toCourseId });
  events.emit("lms.enrolment.changed", { tenant: user?.tenant, courseId: fromCourseId, action: "transferred", studentId, toCourseId });
  return { ok: true };
}

/* ------------------------------ student self-service ------------------------------ */
const isStudentActor = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a : null; };

/* mode: 'open' | 'approval' | 'closed' (tenant setting enrolment.defaultMode). A course that is not
   published + listed answers with the same generic refusal as a course that does not exist. */
async function selfEnrol(pool, user, courseId, mode) {
  const actor = isStudentActor(user);
  if (!actor) return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  const r = await pool.request().input("c", sql.Int, courseId).query(`SELECT TOP 1 status, visibility FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const c = r.recordset && r.recordset[0];
  if (!c || c.status !== "published" || c.visibility !== "listed") return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  if (mode !== "open" && mode !== "approval") return { ok: false, forbidden: true, code: "ENROLMENT_CLOSED", errors: ["Enrolment for this course is closed. Please ask your teacher."] };
  const me = (await lookupStudents(pool, [actor.id])).get(actor.id);
  if (!me || !isActiveStudent(me)) return { ok: false, forbidden: true, code: "STUDENT_INACTIVE", errors: [MSG.STUDENT_INACTIVE] };
  const cur = (await existingRows(pool, courseId, [actor.id])).get(actor.id);
  if (cur === "active") return { ok: false, conflict: true, code: "ALREADY_ENROLLED", errors: ["You are already enrolled in this course."] };
  if (cur === "pending") return { ok: false, conflict: true, code: "ALREADY_PENDING", errors: ["Your request is waiting for your teacher's approval."] };
  if (cur) { // withdrawn/transferred: a student may only come back if they left on their own
    const h = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, actor.id)
      .query(`SELECT TOP 1 action FROM lms_enrolment_history WHERE course_id = @c AND student_id = @s ORDER BY id DESC`);
    if (!(h.recordset && h.recordset[0] && h.recordset[0].action === "self_withdrawn")) return { ok: false, forbidden: true, code: "REENROL_BLOCKED", errors: ["Please ask your teacher to enrol you in this course."] };
  }
  const to = mode === "open" ? "active" : "pending";
  const hist = mode === "open" ? "self_enrolled" : "requested";
  await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, actor.id).input("to", sql.NVarChar(20), to).input("a", sql.NVarChar(30), hist).input("f", sql.NVarChar(20), cur || null)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      ${cur ? `UPDATE lms_course_enrolments SET status = @to, source = 'self', status_changed_at = SYSUTCDATETIME() WHERE course_id = @c AND student_id = @s AND status IN ('withdrawn','transferred');`
            : `INSERT INTO lms_course_enrolments (course_id, student_id, status, source, created_by_source, created_by)
               SELECT @c, @s, @to, 'self', 'Students', @s WHERE NOT EXISTS (SELECT 1 FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s);`}
      INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, actor_source, actor_id) VALUES (@c, @s, @a, @f, @to, 'Students', @s);
      COMMIT;`);
  events.emit("lms.enrolment.changed", { tenant: user?.tenant, courseId, action: hist, studentId: actor.id });
  return { ok: true, status: to };
}

async function selfWithdraw(pool, user, courseId) {
  const actor = isStudentActor(user);
  if (!actor) return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, actor.id)
    .query(`UPDATE lms_course_enrolments SET status = 'withdrawn', status_changed_at = SYSUTCDATETIME() OUTPUT DELETED.status AS from_status
            WHERE course_id = @c AND student_id = @s AND status IN ('active','pending')`);
  const hit = r.recordset && r.recordset[0];
  if (!hit) return { ok: false, forbidden: true, code: "COURSE_ACCESS_DENIED", errors: ["You do not have access to this course."] };
  await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, actor.id).input("f", sql.NVarChar(20), hit.from_status)
    .query(`INSERT INTO lms_enrolment_history (course_id, student_id, action, from_status, to_status, actor_source, actor_id) VALUES (@c, @s, 'self_withdrawn', @f, 'withdrawn', 'Students', @s)`);
  events.emit("lms.enrolment.changed", { tenant: user?.tenant, courseId, action: "self_withdrawn", studentId: actor.id });
  return { ok: true };
}

/* ------------------------------ reading ------------------------------ */
const likeEscape = (t) => t.replace(/[\\%_\[]/g, (m) => `\\${m}`);

/* ?status=&q=&page=&pageSize=  (pageSize max 100) */
async function listRoster(pool, courseId, query = {}) {
  const status = query.status ? String(query.status) : null;
  if (status && !STATUSES.includes(status)) return { ok: false, errors: [`status must be one of ${STATUSES.join(", ")}.`] };
  const q = oneLine(query.q).slice(0, 60);
  const page = Math.max(1, posInt(query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, posInt(query.pageSize) || 25);
  const where = [`e.course_id = @c`]; const bind = (req) => { req.input("c", sql.Int, courseId); if (status) req.input("st", sql.NVarChar(20), status); if (q) req.input("q", sql.NVarChar(130), `%${likeEscape(q)}%`); return req; };
  if (status) where.push(`e.status = @st`);
  if (q) where.push(`(s.name LIKE @q ESCAPE '\\' OR s.admissionNo LIKE @q ESCAPE '\\')`);
  const from = `FROM lms_course_enrolments e LEFT JOIN Students s ON s.id = e.student_id WHERE ${where.join(" AND ")}`;
  const total = await bind(pool.request()).query(`SELECT COUNT(*) AS n ${from}`);
  const r = await bind(pool.request()).input("off", sql.Int, (page - 1) * pageSize).input("ps", sql.Int, pageSize)
    .query(`SELECT e.student_id, e.status, e.source, e.enrolled_at, e.status_changed_at, s.name, s.admissionNo, s.studentClass
            ${from} ORDER BY s.name, e.student_id OFFSET @off ROWS FETCH NEXT @ps ROWS ONLY`);
  return {
    ok: true, page, pageSize, total: total.recordset?.[0]?.n || 0,
    students: (r.recordset || []).map((x) => ({ studentId: x.student_id, name: x.name || null, admissionNo: x.admissionNo || null, className: x.studentClass || null, status: x.status, source: x.source, enrolledAt: x.enrolled_at, statusChangedAt: x.status_changed_at })),
  };
}

/* Newest first, keyset paginated: ?studentId=&beforeId=&limit= (max 100) */
async function listHistory(pool, courseId, query = {}) {
  const sid = query.studentId != null && query.studentId !== "" ? posInt(query.studentId) : null;
  if (query.studentId != null && query.studentId !== "" && sid === null) return { ok: false, errors: ["studentId must be a positive integer."] };
  const before = query.beforeId != null && query.beforeId !== "" ? posInt(query.beforeId) : null;
  const limit = Math.min(100, posInt(query.limit) || 50);
  const req = pool.request().input("c", sql.Int, courseId).input("lim", sql.Int, limit + 1);
  const where = [`course_id = @c`];
  if (sid) { req.input("s", sql.Int, sid); where.push(`student_id = @s`); }
  if (before) { req.input("b", sql.Int, before); where.push(`id < @b`); }
  const r = await req.query(`SELECT TOP (@lim) id, student_id, action, from_status, to_status, detail, actor_source, actor_id, created_at FROM lms_enrolment_history WHERE ${where.join(" AND ")} ORDER BY id DESC`);
  const rows = r.recordset || [];
  const page = rows.slice(0, limit);
  return {
    ok: true, nextBeforeId: rows.length > limit ? page[page.length - 1].id : null,
    entries: page.map((x) => ({ id: x.id, studentId: x.student_id, action: x.action, fromStatus: x.from_status || null, toStatus: x.to_status || null, detail: x.detail || null, actorSource: x.actor_source || null, actorId: x.actor_id ?? null, createdAt: x.created_at })),
  };
}

module.exports = {
  STATUSES, SOURCES, MAX_MANUAL, MAX_CSV_ROWS, MAX_CSV_BYTES, MAX_CLASS,
  posInt, classify, parseCsv, validateStudentIds,
  enrolStudents, bulkEnrol, enrolClassList, changeStatus, transferStudent, selfEnrol, selfWithdraw, listRoster, listHistory,
};
