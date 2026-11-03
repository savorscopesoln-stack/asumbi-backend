/* =========================================================================
   LMS SUBMISSIONS  (L5.2a): a student's own work on an assignment. TEXT only in this unit; private file hand-in is L5.2b.

   Rules (documented, simple):
   - Students only. The student id ALWAYS comes from the token; every query also matches course_id, assignment_id and student_id, so one
     student can never read or change another's work. The route guarantees an ACTIVE enrolment; this file re-checks that the assignment is
     published, already available and in a PUBLISHED or archived course. An archived course is read-only: reading is fine, writing is refused.
   - One student has at most ONE draft per assignment, and a draft becomes attempt number (submitted attempts + 1). Attempts are limited by the
     assignment's `maxAttempts`; the limit is enforced inside the same SQL statement that creates the draft.
   - Saving a draft overwrites the draft text (autosave). Submitting turns the draft into a SUBMITTED attempt in ONE guarded statement (only a
     draft with some text can be submitted, so a double click or a second tab cannot submit twice). A submitted attempt is never edited again;
     handing in again means a new attempt, if attempts remain.
   - The window (pure, `windowOf`): no dueAt = always open. On time up to dueAt. After dueAt: policy `block` = closed; `accept` = open and marked
     late; `penalise` = open, marked late and the penalty percent is stored with the submission (a SNAPSHOT, so later setting changes cannot change
     history). After cutoffAt (accept/penalise) = closed. Time is the SERVER clock, never the browser's.
   - A new attempt STARTS WITH the previous attempt's text (owner decision, Q30): while there is no draft and attempts remain, `prefillText` carries the
     last submitted text; the screen puts it in the editor and the first autosave creates the draft. Otherwise `prefillText` is null.
   - Text is plain text, max 20 000 characters, tags stripped, line breaks kept. It must be shown as text, never as HTML.
   - What counts as work: type `text` = some text; `files` = at least one file; `both` = text OR at least one file. The check is part of the SAME guarded
     UPDATE that submits. Files (L5.2b) belong to ONE attempt, sit in uploads/<school>/lms-private under random names (never served statically,
     server.js denies the folder) and are read only through the authenticated download route by the student who owns them (staff access = L5.4).
     Upload checks reuse the media rules: allowed extension (assignment may only narrow the school list), real-bytes check, size, scan hook, school
     storage quota, `maxFiles` per attempt (enforced inside the INSERT). Files of SUBMITTED attempts are never removed; files of a draft can be.
   - GROUP assignments (L8.4a, D-102; workMode `group`, one attempt, text only): the learner's live group (lms_groups / lms_group_members) is the unit. A hand-in is
     ONE ROW PER ACTIVE GROUP MEMBER (same text, same time, same late flag, `group_id` set), so marking, grades, dashboard and planner keep working per learner.
     Anyone in the group saves the shared draft (last write wins; rows are created for members who have none), anyone submits for everybody. No group = 409 NO_GROUP.
     Once the group has handed in, nobody in it can write again (ATTEMPTS_USED). A learner who joins later sees the group's state but gets no row (staff must handle).
   - Submitting emits `lms.submission.submitted` ({tenant, courseId, assignmentId, submissionId, studentId, late}); ids only.
   Every query is parameterised. Staff reading/marking submissions is L5.4.
========================================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const A = require("./lmsAssignments");
const X = require("./lmsExtensions");
const events = require("./lmsEvents");
const media = require("./lmsMedia");
const { UPLOADS_ROOT, safeTenant } = require("./uploadPaths");
const { checkQuota, invalidateStorage } = require("./lmsUsage");

const MAX_TEXT = 20000, MAX_LISTED_ATTEMPTS = 10;
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const cleanText = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);

/* Pure. `text` is optional: PUT draft needs it, submit may carry it. */
function validateText(body, { required }) {
  if (body === undefined || body === null) return required ? { ok: false, errors: ["Send {\"text\": \"...\"}."] } : { ok: true, text: undefined };
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (k !== "text") return { ok: false, errors: [`Unknown field "${k}".`] };
  if (!("text" in body)) return required ? { ok: false, errors: ["text is required."] } : { ok: true, text: undefined };
  if (typeof body.text !== "string") return { ok: false, errors: ["text must be a string."] };
  const t = cleanText(body.text);
  if (t.length > MAX_TEXT) return { ok: false, errors: [`Your text is too long: at most ${MAX_TEXT} characters.`] };
  return { ok: true, text: t };
}

/* Pure. Can work be handed in at `now`? m = assignment model (dates as Date). */
function windowOf(m, settings, now = new Date()) {
  const eff = A.effectiveOf(m, settings), due = m.dueAt, cut = m.cutoffAt;
  if (!due || now <= due) return { open: true, late: false, penaltyPercent: null };
  if (eff.latePolicy === "block") return { open: false, code: "DEADLINE_PASSED", message: "The deadline has passed and this assignment does not accept late work." };
  if (cut && now > cut) return { open: false, code: "CUTOFF_PASSED", message: "This assignment is now closed." };
  return { open: true, late: true, penaltyPercent: eff.latePolicy === "penalise" ? eff.latePenaltyPercent : null };
}

/* Fixed SQL fragments (never user text): what counts as work for each assignment type. */
const HAS_TEXT = "LEN(LTRIM(RTRIM(COALESCE(body_text, '')))) > 0";
const HAS_FILE = "EXISTS (SELECT 1 FROM lms_submission_files sf WHERE sf.submission_id = lms_submissions.id AND sf.deleted_at IS NULL)";
const CONTENT = { text: HAS_TEXT, files: HAS_FILE, both: `(${HAS_TEXT} OR ${HAS_FILE})` };
const EMPTY_MSG = { text: "Write something before you hand in.", files: "Add at least one file before you hand in.", both: "Write something or add a file before you hand in." };
const COLS = "id, assignment_id, course_id, student_id, attempt_no, status, body_text, submitted_at, is_late, late_penalty_percent, created_at, updated_at";
const attemptShape = (r) => ({ attemptNo: r.attempt_no, text: r.body_text ?? "", submittedAt: iso(r.submitted_at), late: !!r.is_late, latePenaltyPercent: r.late_penalty_percent ?? null });
const studentIdOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a.id : null; };
/* Fixed SQL (never user text). Active members of group @g in course @c. */
const LIVE = `SELECT m.student_id FROM lms_group_members m JOIN lms_course_enrolments e ON e.course_id = m.course_id AND e.student_id = m.student_id AND e.status = 'active' WHERE m.group_id = @g AND m.course_id = @c AND m.removed_at IS NULL`;
async function groupOf(pool, courseId, sid) {
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 g.id, g.name FROM lms_group_members m JOIN lms_groups g ON g.id = m.group_id AND g.course_id = m.course_id AND g.deleted_at IS NULL WHERE m.course_id = @c AND m.student_id = @s AND m.removed_at IS NULL`);
  return r.recordset && r.recordset[0] ? { id: r.recordset[0].id, name: r.recordset[0].name } : null;
}
const NO_GROUP = { code: "NO_GROUP", message: "You are not in a group for this course yet. Ask your teacher." };
const notFound = (what = "Assignment") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });

/* The assignment as THIS student may see it: published, already available, course published or archived. */
async function loadAssignment(pool, courseId, assignmentId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, assignmentId).input("s", sql.Int, studentId)
    .query(`SELECT TOP 1 ${A.COLS.split(", ").map((c) => `a.${c}`).join(", ")}, c.status AS course_status, ${X.EXT_COLS}
      FROM lms_assignments a JOIN lms_courses c ON c.id = a.course_id AND c.deleted_at IS NULL AND c.status IN ('published','archived')
      ${X.joinSql("@s")}
      WHERE a.id = @id AND a.course_id = @c AND ${A.AVAILABLE}`);
  const row = r.recordset && r.recordset[0];
  return row ? { row, model: X.withExtension(A.model(row), row), readOnly: row.course_status === "archived" } : null; // the learner's extension (L5.5) is already applied
}

async function loadMine(pool, courseId, assignmentId, studentId, groupId) {
  if (groupId) { // group work: the learner's own rows first, then the group's (a late joiner still sees the shared draft or the hand-in)
    const g = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, studentId).input("g", sql.Int, groupId)
      .query(`SELECT TOP ${MAX_LISTED_ATTEMPTS} ${COLS} FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND (student_id = @s OR group_id = @g) ORDER BY CASE WHEN student_id = @s THEN 0 ELSE 1 END, updated_at DESC, id DESC`);
    return g.recordset || [];
  }
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, studentId)
    .query(`SELECT TOP ${MAX_LISTED_ATTEMPTS} ${COLS} FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s ORDER BY attempt_no DESC`);
  return r.recordset || [];
}

const fileShape = (f) => ({ id: f.id, name: f.original_name, ext: f.ext, sizeBytes: Number(f.size_bytes) });
async function loadFiles(pool, courseId, assignmentId, studentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, studentId)
    .query(`SELECT TOP 100 id, submission_id, original_name, ext, size_bytes FROM lms_submission_files WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND deleted_at IS NULL ORDER BY id`);
  return r.recordset || [];
}

/* What the student sees about their own work on one assignment. */
async function getState(pool, user, courseId, assignmentId, { settings, now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const found = await loadAssignment(pool, courseId, assignmentId, sid); if (!found) return notFound();
  const grouped = found.model.workMode === "group", grp = grouped ? await groupOf(pool, courseId, sid) : null;
  const mine = await loadMine(pool, courseId, assignmentId, sid, grp && grp.id), files = await loadFiles(pool, courseId, assignmentId, sid);
  const filesOf = (r) => files.filter((f) => f.submission_id === r.id).map(fileShape);
  const submitted = mine.filter((x) => x.status === "submitted").sort((a, b) => a.attempt_no - b.attempt_no), draft = mine.find((x) => x.status === "draft") || null;
  const w = windowOf(found.model, settings, now), left = found.model.maxAttempts - submitted.length;
  const reason = found.readOnly ? { code: "COURSE_READ_ONLY", message: "This course is archived, so work can no longer be handed in." } : !w.open ? w : grouped && !grp ? NO_GROUP : left <= 0 ? { code: "ATTEMPTS_USED", message: "You have used all your attempts." } : null;
  return {
    ok: true, assignmentId, maxAttempts: found.model.maxAttempts, submissionType: found.model.submissionType, maxFiles: found.model.maxFiles, effective: { allowedExtensions: A.effectiveOf(found.model, settings).allowedExtensions, maxFileMb: A.effectiveOf(found.model, settings).maxFileMb }, attemptsUsed: submitted.length, attemptsLeft: Math.max(0, left),
    draft: draft ? { attemptNo: draft.attempt_no, text: draft.body_text ?? "", updatedAt: iso(draft.updated_at), files: filesOf(draft) } : null,
    attempts: submitted.map((x) => ({ ...attemptShape(x), files: filesOf(x) })), window: { open: w.open, late: !!w.late, latePenaltyPercent: w.penaltyPercent ?? null }, dueAt: found.model.dueAt ? found.model.dueAt.toISOString() : null, cutoffAt: found.model.cutoffAt ? found.model.cutoffAt.toISOString() : null, extended: !!found.model.extended,
    prefillText: !draft && !reason && submitted.length ? (submitted[submitted.length - 1].body_text ?? "") : null, // Q30: a new attempt starts from the previous attempt's text
    canWrite: !reason, closedReason: reason ? { code: reason.code, message: reason.message } : null,
    workMode: found.model.workMode, group: grp,
  };
}

/* Shared gate for writing: assignment visible, course open for work, window open. */
async function gate(pool, courseId, assignmentId, sid, settings, now) {
  const found = await loadAssignment(pool, courseId, assignmentId, sid); if (!found) return notFound();
  if (found.readOnly) return { ok: false, code: "COURSE_READ_ONLY", errors: ["This course is archived, so work can no longer be handed in."] };
  const w = windowOf(found.model, settings, now); if (!w.open) return { ok: false, code: w.code, errors: [w.message] };
  if (found.model.workMode === "group") {
    const grp = await groupOf(pool, courseId, sid); if (!grp) return { ok: false, code: NO_GROUP.code, errors: [NO_GROUP.message] };
    const done = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("g", sql.Int, grp.id)
      .query(`SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND status = 'submitted' AND (student_id = @s OR group_id = @g)`);
    if (done.recordset && done.recordset.length) return { ok: false, code: "ATTEMPTS_USED", errors: ["Your group has already handed in this work."] };
    return { ok: true, found, window: w, group: grp };
  }
  return { ok: true, found, window: w };
}

/* Save the draft text. UPDATE the existing draft; otherwise INSERT the next attempt, but only while attempts remain (same statement). */
async function writeDraft(pool, courseId, assignmentId, sid, text, found, now) {
  const upd = () => pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("t", sql.NVarChar(sql.MAX), text).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_submissions SET body_text = COALESCE(@t, body_text), updated_at = @now OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
            WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft'`);
  let r = await upd(); if (r.recordset && r.recordset[0]) return { ok: true, row: r.recordset[0] };
  try {
    r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("t", sql.NVarChar(sql.MAX), text)
      .input("max", sql.Int, found.model.maxAttempts).input("now", sql.DateTime2, now)
      .query(`INSERT INTO lms_submissions (assignment_id, course_id, student_id, attempt_no, status, body_text, created_at, updated_at)
              OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
              SELECT @a, @c, @s, x.n + 1, 'draft', COALESCE(@t, ''), @now, @now
              FROM (SELECT COUNT(*) AS n FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'submitted') x
              WHERE x.n < @max`);
  } catch (e) { if (!isDup(e)) throw e; r = await upd(); } // a parallel save created the draft first: update it instead
  const row = r.recordset && r.recordset[0];
  return row ? { ok: true, row } : { ok: false, code: "ATTEMPTS_USED", errors: ["You have used all your attempts."] };
}

/* GROUP draft (D-102): every ACTIVE member's draft gets the text, members with no row at all get one (starting from the group's newest draft when no text is sent).
   Never touches a member who already handed in. One batch; returns the caller's row. */
async function writeGroupDraft(pool, courseId, assignmentId, sid, gid, text, now) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("g", sql.Int, gid).input("t", sql.NVarChar(sql.MAX), text ?? null).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_submissions SET body_text = COALESCE(@t, body_text), group_id = @g, updated_at = @now
              WHERE assignment_id = @a AND course_id = @c AND status = 'draft' AND student_id IN (${LIVE});
            INSERT INTO lms_submissions (assignment_id, course_id, student_id, attempt_no, status, body_text, group_id, created_at, updated_at)
              SELECT @a, @c, x.student_id, 1, 'draft', COALESCE(@t, (SELECT TOP 1 d.body_text FROM lms_submissions d WHERE d.assignment_id = @a AND d.course_id = @c AND d.status = 'draft' AND d.group_id = @g ORDER BY d.updated_at DESC, d.id DESC), ''), @g, @now, @now
              FROM (${LIVE}) x WHERE NOT EXISTS (SELECT 1 FROM lms_submissions o WHERE o.assignment_id = @a AND o.course_id = @c AND o.student_id = x.student_id);
            SELECT TOP 1 ${COLS} FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft' AND group_id = @g`);
  const row = r.recordset && r.recordset[0];
  return row ? { ok: true, row } : { ok: false, code: "ATTEMPTS_USED", errors: ["You cannot save work for this group right now."] };
}

async function saveDraft(pool, user, courseId, assignmentId, body, { settings, now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const v = validateText(body, { required: true }); if (!v.ok) return v;
  const g = await gate(pool, courseId, assignmentId, sid, settings, now); if (!g.ok) return g;
  const w = g.group ? await writeGroupDraft(pool, courseId, assignmentId, sid, g.group.id, v.text, now) : await writeDraft(pool, courseId, assignmentId, sid, v.text, g.found, now); if (!w.ok) return w;
  return { ok: true, draft: { attemptNo: w.row.attempt_no, text: w.row.body_text ?? "", updatedAt: iso(w.row.updated_at) } };
}

async function submit(pool, user, courseId, assignmentId, body, { tenant, settings, now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const v = validateText(body, { required: false }); if (!v.ok) return v;
  const g = await gate(pool, courseId, assignmentId, sid, settings, now); if (!g.ok) return g;
  if (g.group) return submitGroup(pool, user, courseId, assignmentId, sid, v.text, g, { tenant, now });
  if (v.text !== undefined) { const w = await writeDraft(pool, courseId, assignmentId, sid, v.text, g.found, now); if (!w.ok) return w; }
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid)
    .input("late", sql.Bit, g.window.late ? 1 : 0).input("pen", sql.Int, g.window.late ? g.window.penaltyPercent ?? null : null).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_submissions SET status = 'submitted', submitted_at = @now, is_late = @late, late_penalty_percent = @pen, updated_at = @now
            OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
            WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft' AND ${CONTENT[g.found.model.submissionType] || CONTENT.text}`);
  const row = r.recordset && r.recordset[0];
  if (!row) {
    const d = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid)
      .query(`SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft'`);
    return d.recordset && d.recordset.length ? { ok: false, code: "EMPTY_SUBMISSION", errors: [EMPTY_MSG[g.found.model.submissionType] || EMPTY_MSG.text] } : { ok: false, code: "NO_DRAFT", errors: ["There is no work to hand in. Save a draft first."] };
  }
  await audit(pool, actorOf(user), "submission.submitted", "lms_submissions", row.id, { courseId, assignmentId, attemptNo: row.attempt_no, late: !!row.is_late });
  if (tenant) events.emit("lms.submission.submitted", { tenant, courseId, assignmentId, submissionId: row.id, studentId: sid, late: !!row.is_late });
  return { ok: true, submission: attemptShape(row) };
}

/* GROUP submit (D-102): sync the drafts first, then ONE guarded UPDATE hands in every active member's draft. */
async function submitGroup(pool, user, courseId, assignmentId, sid, text, g, { tenant, now }) {
  const gid = g.group.id, w = await writeGroupDraft(pool, courseId, assignmentId, sid, gid, text, now); if (!w.ok) return w;
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("g", sql.Int, gid)
    .input("late", sql.Bit, g.window.late ? 1 : 0).input("pen", sql.Int, g.window.late ? g.window.penaltyPercent ?? null : null).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_submissions SET status = 'submitted', submitted_at = @now, is_late = @late, late_penalty_percent = @pen, group_id = @g, updated_at = @now
            OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
            WHERE assignment_id = @a AND course_id = @c AND status = 'draft' AND student_id IN (${LIVE}) AND ${CONTENT.text}`);
  const rows = r.recordset || [], mine = rows.find((x) => x.student_id === sid);
  if (!mine) return { ok: false, code: "EMPTY_SUBMISSION", errors: [EMPTY_MSG.text] };
  await audit(pool, actorOf(user), "submission.submitted", "lms_submissions", mine.id, { courseId, assignmentId, groupId: gid, members: rows.length, late: !!mine.is_late });
  if (tenant) for (const x of rows) events.emit("lms.submission.submitted", { tenant, courseId, assignmentId, submissionId: x.id, studentId: x.student_id, groupId: gid, late: !!x.is_late });
  return { ok: true, submission: attemptShape(mine), members: rows.length };
}

/* ------------------------------ files (L5.2b) ------------------------------ */
const privateDir = (tenant) => path.join(UPLOADS_ROOT, safeTenant(tenant), "lms-private");
const storedPath = (tenant, stored) => path.join(privateDir(tenant), path.basename(String(stored)));

async function addFile(pool, user, courseId, assignmentId, file, { tenant, settings, now = new Date(), scanner } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const g = await gate(pool, courseId, assignmentId, sid, settings, now); if (!g.ok) return g;
  const m = g.found.model; if (m.submissionType === "text") return { ok: false, code: "FILES_NOT_ALLOWED", errors: ["This assignment is handed in as text only."] };
  const eff = A.effectiveOf(m, settings);
  const c = media.checkUpload(file, { files: { allowedExtensions: eff.allowedExtensions, maxFileMb: eff.maxFileMb || 10 } }); if (!c.ok) return c;
  if (!(await media.runScan(file.buffer, { ext: c.ext, name: media.displayName(file.originalname) }, scanner))) return { ok: false, code: "FILE_REJECTED", errors: ["This file was rejected by the safety check."] };
  const q = await checkQuota(tenant, settings?.storageQuotaMb, file.buffer.length); if (!q.ok) return { ok: false, code: "LMS_STORAGE_QUOTA_EXCEEDED", errors: ["This school's LMS storage is full."] };
  const d = await writeDraft(pool, courseId, assignmentId, sid, null, g.found, now); if (!d.ok) return d; // the file needs a draft; the text is left as it was
  const stored = `${crypto.randomBytes(16).toString("hex")}.${c.ext}`, abs = path.join(privateDir(tenant), stored);
  await fs.promises.mkdir(privateDir(tenant), { recursive: true });
  await fs.promises.writeFile(abs, file.buffer, { flag: "wx" });
  try {
    const r = await pool.request().input("sub", sql.Int, d.row.id).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
      .input("sn", sql.NVarChar(200), stored).input("on", sql.NVarChar(200), media.displayName(file.originalname)).input("x", sql.NVarChar(10), c.ext).input("sz", sql.BigInt, c.size).input("max", sql.Int, m.maxFiles)
      .query(`INSERT INTO lms_submission_files (submission_id, assignment_id, course_id, student_id, stored_name, original_name, ext, size_bytes)
              OUTPUT INSERTED.id, INSERTED.original_name, INSERTED.ext, INSERTED.size_bytes
              SELECT @sub, @a, @c, @s, @sn, @on, @x, @sz
              WHERE EXISTS (SELECT 1 FROM lms_submissions WHERE id = @sub AND student_id = @s AND course_id = @c AND status = 'draft')
                AND (SELECT COUNT(*) FROM lms_submission_files WHERE submission_id = @sub AND deleted_at IS NULL) < @max`);
    const row = r.recordset && r.recordset[0];
    if (!row) { await fs.promises.unlink(abs).catch(() => {}); return { ok: false, code: "FILE_LIMIT", errors: [`You can add at most ${m.maxFiles} files to one attempt.`] }; }
    invalidateStorage(tenant);
    await audit(pool, actorOf(user), "submission.file_added", "lms_submission_files", row.id, { courseId, assignmentId, ext: c.ext, bytes: c.size });
    return { ok: true, file: fileShape(row) };
  } catch (err) { await fs.promises.unlink(abs).catch(() => {}); throw err; } // never leave an orphan file without a row
}

/* Only a file of the student's own DRAFT can be removed; files of submitted attempts stay (history). */
async function removeFile(pool, user, courseId, assignmentId, fileId, { tenant, settings, now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound("File");
  const g = await gate(pool, courseId, assignmentId, sid, settings, now); if (!g.ok) return g;
  const r = await pool.request().input("f", sql.Int, fileId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`UPDATE sf SET deleted_at = SYSUTCDATETIME() OUTPUT INSERTED.stored_name
            FROM lms_submission_files sf
            WHERE sf.id = @f AND sf.assignment_id = @a AND sf.course_id = @c AND sf.student_id = @s AND sf.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM lms_submissions sb WHERE sb.id = sf.submission_id AND sb.student_id = @s AND sb.course_id = @c AND sb.status = 'draft')`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("File");
  await fs.promises.unlink(storedPath(tenant, row.stored_name)).catch(() => {}); invalidateStorage(tenant);
  await audit(pool, actorOf(user), "submission.file_removed", "lms_submission_files", fileId, { courseId, assignmentId });
  return { ok: true };
}

/* The student's OWN file, any attempt. Returns the bytes; the route sets the download headers. */
async function readFile(pool, user, courseId, assignmentId, fileId, { tenant } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound("File");
  const r = await pool.request().input("f", sql.Int, fileId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 stored_name, original_name, ext FROM lms_submission_files WHERE id = @f AND assignment_id = @a AND course_id = @c AND student_id = @s AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("File");
  let buffer; try { buffer = await fs.promises.readFile(storedPath(tenant, row.stored_name)); } catch (e) { if (e.code === "ENOENT") return notFound("File"); throw e; }
  return { ok: true, buffer, name: row.original_name, ext: row.ext };
}

module.exports = { MAX_TEXT, addFile, removeFile, readFile, validateText, windowOf, getState, saveDraft, submit, cleanText, gate, COLS, iso, studentIdOf };
