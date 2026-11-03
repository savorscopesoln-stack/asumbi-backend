/* =========================================================================
   LMS MARKING  (L5.4a, part 1): staff see submitted work, score it (plain points or with the attached rubric), and return it to the student.

   Rules (documented, simple):
   - Staff routes: `lms.submission.grade` + course membership (owner / co-teacher / LMS admin), checked in the route. Every query here also matches
     course_id AND assignment_id, so an id from another course or school finds nothing (same answer as "does not exist").
   - The QUEUE lists ONE row per student: their LATEST submitted attempt. Filters (fixed SQL fragments, never user text): all, ungraded (no grade yet),
     graded (marked, not yet returned), returned, late (the attempt was late), resubmitted (attempt number > 1). Oldest submission first. Paged (max 100).
   - A grade belongs to ONE submitted attempt (unique on submission_id). `draft` is visible to staff only; `returned` is what the student sees.
   - With NO rubric attached the teacher sends `points` (0..assignment maxPoints, 2 decimals). With a rubric attached the teacher sends `scores`
     [{criterionId, levelPosition, comment?}] covering EVERY criterion once; the points come from the stored levels (never from the client) and
     raw = sum / rubric total * maxPoints, rounded to 2 decimals. `points` with a rubric, or `scores` without one, is refused.
   - Late penalty: the percent SNAPSHOT stored on the submission is applied: final = raw * (100 - percent) / 100, rounded to 2 decimals. Raw, percent and
     final are all kept, so nothing is hidden.
   - Once RETURNED a grade is frozen (409 ALREADY_RETURNED). The owner confirmed (Q34, D-064) that a returned grade is NEVER re-opened. Bulk return and scheduled
     release live in lmsRelease.js; every read below first applies a due schedule (`releaseDue`). Marking is refused in an archived or pending course.
   - Staff download of a student's file goes through an authenticated route; the bytes never come from a static URL.
   - Saving emits `lms.submission.graded`, returning emits `lms.grade.released` (ids only).
   Every query is parameterised.
========================================================================= */
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const rubrics = require("./lmsRubrics");
const A = require("./lmsAssignments");
const events = require("./lmsEvents");
const release = require("./lmsRelease");
const { UPLOADS_ROOT, safeTenant } = require("./uploadPaths");

/* D-103: group work shows ONE row per group (the lowest id); `groups=all` shows every member row. Fixed SQL, never user text. */
const GROUP_ONCE = "(s.group_id IS NULL OR s.id = (SELECT MIN(x.id) FROM lms_submissions x WHERE x.assignment_id = s.assignment_id AND x.course_id = s.course_id AND x.group_id = s.group_id AND x.status = 'submitted' AND x.attempt_no = s.attempt_no))";
const FILTER_SQL = {
  all: "1 = 1",
  ungraded: "g.id IS NULL",
  graded: "g.status = 'draft'",
  returned: "g.status = 'returned'",
  late: "s.is_late = 1",
  resubmitted: "s.attempt_no > 1",
};
const MAX_COMMENT = 4000, MAX_CRITERION_COMMENT = 500;
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
const round2 = (n) => Math.round(n * 100) / 100;
const money = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && Math.round(n * 100) / 100 === n ? n : null; };
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);
const notFound = (what = "Submission") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });

/* Pure. Final points after the late penalty. */
function finalOf(raw, penaltyPercent) {
  const pen = Number(penaltyPercent) || 0;
  return pen > 0 ? round2((raw * (100 - pen)) / 100) : round2(raw);
}

/* Pure. Validates the body against the assignment (maxPoints) and the attached rubric (or null).
   Returns { ok, value:{ comment, raw, scores:[{criterionId, levelPosition, points, comment}]|null } }. */
function validateGrade(body, { maxPoints, rubric }) {
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!["points", "comment", "scores"].includes(k)) return { ok: false, errors: [`Unknown field "${k}".`] };
  const comment = multiLine(body.comment);
  if (comment.length > MAX_COMMENT) return { ok: false, errors: [`comment can be at most ${MAX_COMMENT} characters.`] };
  if (!rubric) {
    if (body.scores !== undefined) return { ok: false, errors: ["This assignment has no rubric, so send points, not scores."] };
    const p = money(body.points);
    if (p === null || p < 0 || p > maxPoints) return { ok: false, errors: [`points must be a number from 0 to ${maxPoints} with at most 2 decimals.`] };
    return { ok: true, value: { comment, raw: p, scores: null } };
  }
  if (body.points !== undefined) return { ok: false, errors: ["This assignment is marked with a rubric, so send scores, not points."] };
  if (!Array.isArray(body.scores) || body.scores.length !== rubric.criteria.length) return { ok: false, errors: [`scores must list every criterion once (${rubric.criteria.length}).`] };
  const byId = new Map(rubric.criteria.map((c) => [c.id, c])), seen = new Set(), out = []; let sum = 0;
  for (const [i, s] of body.scores.entries()) {
    if (!isPlainObject(s)) return { ok: false, errors: [`Score ${i + 1} must be an object.`] };
    for (const k of Object.keys(s)) if (!["criterionId", "levelPosition", "comment"].includes(k)) return { ok: false, errors: [`Score ${i + 1}: unknown field "${k}".`] };
    const cid = posInt(s.criterionId), pos = posInt(s.levelPosition), crit = cid && byId.get(cid);
    if (!crit || seen.has(cid)) return { ok: false, errors: [`Score ${i + 1}: criterionId is not a criterion of this rubric, or is repeated.`] };
    const lvl = pos && crit.levels.find((l) => l.position === pos);
    if (!lvl) return { ok: false, errors: [`Score ${i + 1}: levelPosition is not a level of that criterion.`] };
    const c = multiLine(s.comment); if (c.length > MAX_CRITERION_COMMENT) return { ok: false, errors: [`Score ${i + 1}: comment can be at most ${MAX_CRITERION_COMMENT} characters.`] };
    seen.add(cid); sum += lvl.points; out.push({ criterionId: cid, levelPosition: pos, points: lvl.points, comment: c });
  }
  return { ok: true, value: { comment, raw: round2((sum / rubric.maxPoints) * maxPoints), scores: out } };
}

/* ------------------------------- loading -------------------------------- */
async function loadAssignment(pool, courseId, assignmentId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 1 id, title, max_points FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0];
  return row ? { id: row.id, title: row.title, maxPoints: Number(row.max_points) } : null;
}
async function loadSubmission(pool, courseId, assignmentId, submissionId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("sid", sql.Int, submissionId)
    .query(`SELECT TOP 1 id, student_id, attempt_no, body_text, submitted_at, is_late, late_penalty_percent FROM lms_submissions
            WHERE id = @sid AND assignment_id = @a AND course_id = @c AND status = 'submitted'`);
  return (r.recordset && r.recordset[0]) || null;
}
const gradeShape = (g, scores) => g ? {
  status: g.status, rawPoints: Number(g.raw_points), penaltyPercent: g.penalty_percent ?? null, finalPoints: Number(g.final_points), maxPoints: Number(g.max_points),
  comment: g.comment || "", gradedAt: iso(g.graded_at), returnedAt: iso(g.returned_at),
  scores: (scores || []).map((s) => ({ criterionId: s.criterion_id, levelPosition: s.level_position, points: Number(s.points), comment: s.comment || "" })),
} : null;
async function loadGrade(pool, submissionId) {
  const g = await pool.request().input("sid", sql.Int, submissionId)
    .query(`SELECT TOP 1 status, raw_points, penalty_percent, final_points, max_points, comment, graded_at, returned_at FROM lms_submission_grades WHERE submission_id = @sid`);
  const row = g.recordset && g.recordset[0]; if (!row) return null;
  const s = await pool.request().input("sid", sql.Int, submissionId)
    .query(`SELECT TOP 20 criterion_id, level_position, points, comment FROM lms_submission_rubric_scores WHERE submission_id = @sid ORDER BY criterion_id`);
  return gradeShape(row, s.recordset);
}

/* ------------------------------- the queue ------------------------------- */
async function listQueue(pool, courseId, assignmentId, { filter = "all", groups = "collapse", page, pageSize, tenant } = {}) {
  if (groups !== "collapse" && groups !== "all") return { ok: false, errors: ["groups must be collapse or all."] };
  if (!Object.prototype.hasOwnProperty.call(FILTER_SQL, filter)) return { ok: false, errors: [`filter must be one of: ${Object.keys(FILTER_SQL).join(", ")}.`] };
  if (!(await loadAssignment(pool, courseId, assignmentId))) return notFound("Assignment");
  await release.releaseDue(pool, { courseId, assignmentId }, { tenant });
  const { size, pg } = paging({ page, pageSize });
  const base = `FROM lms_submissions s LEFT JOIN Students st ON st.id = s.student_id LEFT JOIN lms_submission_grades g ON g.submission_id = s.id
    WHERE s.assignment_id = @a AND s.course_id = @c AND s.status = 'submitted'
      AND s.attempt_no = (SELECT MAX(l.attempt_no) FROM lms_submissions l WHERE l.assignment_id = s.assignment_id AND l.student_id = s.student_id AND l.status = 'submitted')
      AND ${groups === "collapse" ? GROUP_ONCE : "1 = 1"}
      AND ${FILTER_SQL[filter]}`;
  const bind = (r) => r.input("c", sql.Int, courseId).input("a", sql.Int, assignmentId);
  const total = await bind(pool.request()).query(`SELECT COUNT(*) AS n ${base}`);
  const rows = await bind(pool.request()).input("off", sql.Int, (pg - 1) * size).input("size", sql.Int, size)
    .query(`SELECT s.id, s.student_id, s.attempt_no, s.submitted_at, s.is_late, s.late_penalty_percent, s.group_id, st.name AS student_name, st.admissionNo AS admission_no,
              g.status AS grade_status, g.final_points, g.max_points ${base} ORDER BY s.submitted_at ASC, s.id ASC OFFSET @off ROWS FETCH NEXT @size ROWS ONLY`);
  const sched = { ok: true, release: await release.peekRelease(pool, courseId, assignmentId) };
  return {
    ok: true, page: pg, pageSize: size, total: Number(total.recordset?.[0]?.n) || 0, release: sched.ok ? sched.release : null,
    items: (rows.recordset || []).map((r) => ({
      submissionId: r.id, groupId: r.group_id ?? null, studentId: r.student_id, studentName: r.student_name || "", admissionNo: r.admission_no || "", attemptNo: r.attempt_no, resubmitted: r.attempt_no > 1,
      submittedAt: iso(r.submitted_at), late: !!r.is_late, latePenaltyPercent: r.late_penalty_percent ?? null,
      gradeStatus: r.grade_status || "ungraded", finalPoints: r.final_points == null ? null : Number(r.final_points), maxPoints: r.max_points == null ? null : Number(r.max_points),
    })),
  };
}

/* One submission for marking: text, files, the grade so far and the rubric to score with. */
async function getForMarking(pool, courseId, assignmentId, submissionId, { tenant } = {}) {
  const a = await loadAssignment(pool, courseId, assignmentId); if (!a) return notFound("Assignment");
  await release.releaseDue(pool, { courseId, assignmentId }, { tenant });
  const s = await loadSubmission(pool, courseId, assignmentId, submissionId); if (!s) return notFound();
  const st = await pool.request().input("s", sql.Int, s.student_id).query(`SELECT TOP 1 name, admissionNo FROM Students WHERE id = @s`);
  const f = await pool.request().input("c", sql.Int, courseId).input("sid", sql.Int, submissionId)
    .query(`SELECT TOP 20 id, original_name, ext, size_bytes FROM lms_submission_files WHERE submission_id = @sid AND course_id = @c AND deleted_at IS NULL ORDER BY id`);
  const rb = await rubrics.getAssignmentRubric(pool, courseId, assignmentId);
  const who = (st.recordset && st.recordset[0]) || {};
  return {
    ok: true,
    assignment: { id: a.id, title: a.title, maxPoints: a.maxPoints },
    submission: {
      id: s.id, studentId: s.student_id, studentName: who.name || "", admissionNo: who.admissionNo || "", attemptNo: s.attempt_no, text: s.body_text ?? "",
      submittedAt: iso(s.submitted_at), late: !!s.is_late, latePenaltyPercent: s.late_penalty_percent ?? null,
      files: (f.recordset || []).map((x) => ({ id: x.id, name: x.original_name, ext: x.ext, sizeBytes: Number(x.size_bytes) })),
    },
    rubric: rb.ok ? rb.rubric : null,
    grade: await loadGrade(pool, submissionId),
  };
}

/* Staff download of a file of one SUBMITTED attempt in this course/assignment. The route sets the attachment headers. */
async function readFileForStaff(pool, courseId, assignmentId, submissionId, fileId, { tenant } = {}) {
  const r = await pool.request().input("f", sql.Int, fileId).input("sid", sql.Int, submissionId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId)
    .query(`SELECT TOP 1 sf.stored_name, sf.original_name, sf.ext FROM lms_submission_files sf
            INNER JOIN lms_submissions sb ON sb.id = sf.submission_id AND sb.assignment_id = @a AND sb.course_id = @c AND sb.status = 'submitted'
            WHERE sf.id = @f AND sf.submission_id = @sid AND sf.assignment_id = @a AND sf.course_id = @c AND sf.deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound("File");
  let buffer;
  try { buffer = await fs.promises.readFile(path.join(UPLOADS_ROOT, safeTenant(tenant), "lms-private", path.basename(String(row.stored_name)))); }
  catch (e) { if (e.code === "ENOENT") return notFound("File"); throw e; }
  return { ok: true, buffer, name: row.original_name, ext: row.ext };
}

/* ------------------------------- grading -------------------------------- */
const SAVE_SQL = (n) => `
  SET XACT_ABORT ON; BEGIN TRAN;
  DECLARE @ok INT = (SELECT COUNT(*) FROM lms_submissions WHERE id = @sid AND assignment_id = @a AND course_id = @c AND status = 'submitted');
  DECLARE @ret INT = (SELECT COUNT(*) FROM lms_submission_grades WHERE submission_id = @sid AND status = 'returned');
  IF @ok = 1 AND @ret = 0 BEGIN
    UPDATE lms_submission_grades SET rubric_id = @rid, raw_points = @raw, penalty_percent = @pen, final_points = @fin, max_points = @max, comment = @cm,
      graded_by_source = @src, graded_by = @uid, graded_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE submission_id = @sid AND status = 'draft';
    IF @@ROWCOUNT = 0 INSERT INTO lms_submission_grades (submission_id, assignment_id, course_id, student_id, rubric_id, raw_points, penalty_percent, final_points, max_points, comment, graded_by_source, graded_by)
      VALUES (@sid, @a, @c, @stu, @rid, @raw, @pen, @fin, @max, @cm, @src, @uid);
    DELETE FROM lms_submission_rubric_scores WHERE submission_id = @sid;
    ${n ? `INSERT INTO lms_submission_rubric_scores (submission_id, criterion_id, level_position, points, comment) VALUES ${Array.from({ length: n }, (_, i) => `(@sid, @sc${i}, @sl${i}, @sp${i}, @sm${i})`).join(", ")};` : ""}
  END
  COMMIT; SELECT @ok AS ok, @ret AS returned;`;

async function saveGrade(pool, user, courseId, assignmentId, submissionId, body, { tenant } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const a = await loadAssignment(pool, courseId, assignmentId); if (!a) return notFound("Assignment");
  await release.releaseDue(pool, { courseId, assignmentId }, { tenant }); // a schedule that just came due returns this grade first, so it cannot be changed afterwards
  const sub = await loadSubmission(pool, courseId, assignmentId, submissionId); if (!sub) return notFound();
  const rb = await rubrics.getAssignmentRubric(pool, courseId, assignmentId);
  const v = validateGrade(body, { maxPoints: a.maxPoints, rubric: rb.ok ? rb.rubric : null }); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const pen = sub.late_penalty_percent ?? null, fin = finalOf(v.value.raw, pen), scores = v.value.scores || [];
  const run = () => {
    const r = pool.request().input("sid", sql.Int, submissionId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("stu", sql.Int, sub.student_id)
      .input("rid", sql.Int, rb.ok && rb.rubric ? rb.rubric.id : null).input("raw", sql.Decimal(9, 2), v.value.raw).input("pen", sql.Int, pen).input("fin", sql.Decimal(9, 2), fin)
      .input("max", sql.Decimal(7, 2), a.maxPoints).input("cm", sql.NVarChar(4000), v.value.comment || null).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);
    scores.forEach((s, i) => r.input(`sc${i}`, sql.Int, s.criterionId).input(`sl${i}`, sql.Int, s.levelPosition).input(`sp${i}`, sql.Decimal(7, 2), s.points).input(`sm${i}`, sql.NVarChar(500), s.comment || null));
    return r.query(SAVE_SQL(scores.length));
  };
  let res;
  try { res = await run(); } catch (e) { if (!isDup(e)) throw e; res = await run(); } // a parallel first save created the grade row: update it instead
  const out = res.recordset && res.recordset[0];
  if (!out || Number(out.ok) !== 1) return notFound();
  if (Number(out.returned) === 1) return { ok: false, code: "ALREADY_RETURNED", errors: ["This work has already been returned to the student, so its grade can no longer be changed."] };
  await audit(pool, actor, "submission.graded", "lms_submissions", submissionId, { courseId, assignmentId, rubric: !!(rb.ok && rb.rubric), finalPoints: fin });
  if (tenant) events.emit("lms.submission.graded", { tenant, courseId, assignmentId, submissionId, studentId: sub.student_id });
  return { ok: true, grade: await loadGrade(pool, submissionId) };
}

async function returnGrade(pool, user, courseId, assignmentId, submissionId, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const sub = await loadSubmission(pool, courseId, assignmentId, submissionId); if (!sub) return notFound();
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  await release.releaseDue(pool, { courseId, assignmentId }, { tenant, now });
  const r = await pool.request().input("sid", sql.Int, submissionId).input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).input("now", sql.DateTime2, now)
    .query(`UPDATE lms_submission_grades SET status = 'returned', returned_at = @now, updated_at = @now OUTPUT INSERTED.id
            WHERE submission_id = @sid AND assignment_id = @a AND course_id = @c AND status = 'draft'`);
  if (!(r.recordset && r.recordset[0])) {
    const g = await pool.request().input("sid", sql.Int, submissionId).query(`SELECT TOP 1 status FROM lms_submission_grades WHERE submission_id = @sid`);
    return g.recordset && g.recordset[0]
      ? { ok: false, code: "ALREADY_RETURNED", errors: ["This work has already been returned to the student."] }
      : { ok: false, code: "NOT_GRADED", errors: ["Save a grade before returning the work."] };
  }
  await audit(pool, actor, "submission.returned", "lms_submissions", submissionId, { courseId, assignmentId });
  if (tenant) events.emit("lms.grade.released", { tenant, courseId, assignmentId, submissionId, studentId: sub.student_id });
  return { ok: true, grade: await loadGrade(pool, submissionId) };
}

/* ----------------------- what the STUDENT sees (returned only) ----------------------- */
async function feedbackForStudent(pool, user, courseId, assignmentId, { tenant, now } = {}) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student") return notFound("Assignment");
  await release.releaseDue(pool, { courseId, assignmentId, studentId: actor.id }, { tenant, now });
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, actor.id)
    .query(`SELECT TOP 10 sb.id AS submission_id, sb.attempt_no, g.raw_points, g.penalty_percent, g.final_points, g.max_points, g.comment, g.returned_at
            FROM lms_submission_grades g
            INNER JOIN lms_submissions sb ON sb.id = g.submission_id AND sb.student_id = @s AND sb.course_id = @c AND sb.assignment_id = @a AND sb.status = 'submitted'
            INNER JOIN lms_assignments a ON a.id = g.assignment_id AND a.course_id = @c
            WHERE g.assignment_id = @a AND g.course_id = @c AND g.student_id = @s AND g.status = 'returned' AND ${A.AVAILABLE}
            ORDER BY sb.attempt_no DESC`);
  const rows = r.recordset || [];
  if (!rows.length) return { ok: true, items: [] };
  const rb = await rubrics.getAssignmentRubric(pool, courseId, assignmentId), crit = new Map((rb.ok && rb.rubric ? rb.rubric.criteria : []).map((c) => [c.id, c]));
  const items = [];
  for (const g of rows) {
    const sc = await pool.request().input("sid", sql.Int, g.submission_id).query(`SELECT TOP 20 criterion_id, level_position, points, comment FROM lms_submission_rubric_scores WHERE submission_id = @sid ORDER BY criterion_id`);
    items.push({
      attemptNo: g.attempt_no, rawPoints: Number(g.raw_points), latePenaltyPercent: g.penalty_percent ?? null, finalPoints: Number(g.final_points), maxPoints: Number(g.max_points),
      comment: g.comment || "", returnedAt: iso(g.returned_at),
      criteria: (sc.recordset || []).map((s) => {
        const c = crit.get(s.criterion_id), l = c && c.levels.find((x) => x.position === s.level_position);
        return { criterion: c ? c.title : "", level: l ? l.label : "", points: Number(s.points), weight: c ? c.weight : null, comment: s.comment || "" };
      }),
    });
  }
  return { ok: true, items };
}

/* ------------- student: status per assignment + read-only rubric (L5.4b) ------------- */
/* Adds `submissionStatus` to student assignment items: not_started | draft | submitted | returned (+ attemptsUsed, and the final/max points ONLY when the
   latest submitted attempt has been returned). One bounded query for the page's ids; the student id comes from the token. A failed read leaves the items
   without the field (status is a convenience, never blocks the list). */
async function attachStatus(pool, user, courseId, items, { tenant, now } = {}) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student" || !Array.isArray(items) || !items.length) return items;
  const ids = [...new Set(items.map((x) => posInt(x.id)).filter(Boolean))].slice(0, 100); if (!ids.length) return items;
  await release.releaseDue(pool, { courseId, studentId: actor.id }, { tenant, now });
  let rows;
  try {
    const r = ids.reduce((q, id, i) => q.input(`i${i}`, sql.Int, id), pool.request().input("c", sql.Int, courseId).input("s", sql.Int, actor.id));
    rows = (await r.query(`SELECT sb.assignment_id, sb.status, sb.attempt_no, g.final_points, g.max_points FROM lms_submissions sb
        LEFT JOIN lms_submission_grades g ON g.submission_id = sb.id AND g.status = 'returned'
        WHERE sb.course_id = @c AND sb.student_id = @s AND sb.assignment_id IN (${ids.map((_, i) => `@i${i}`).join(", ")})`)).recordset || [];
  } catch { return items; }
  return items.map((it) => {
    const mine = rows.filter((x) => x.assignment_id === it.id), sub = mine.filter((x) => x.status === "submitted").sort((a, b) => b.attempt_no - a.attempt_no), last = sub[0];
    const status = !mine.length ? "not_started" : last && last.final_points != null ? "returned" : last ? "submitted" : "draft";
    return { ...it, submissionStatus: { status, attemptsUsed: sub.length, ...(status === "returned" ? { finalPoints: Number(last.final_points), maxPoints: Number(last.max_points) } : {}) } };
  });
}

/* The rubric of a published, available assignment as the STUDENT sees it (criteria, weights, level labels/descriptions/points; no ids of other tables, no outcome tags). */
async function rubricForStudent(pool, user, courseId, assignmentId) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student") return notFound("Assignment");
  const a = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId)
    .query(`SELECT TOP 1 a.id FROM lms_assignments a WHERE a.id = @a AND a.course_id = @c AND ${A.AVAILABLE}`);
  if (!(a.recordset && a.recordset[0])) return notFound("Assignment");
  const rb = await rubrics.getAssignmentRubric(pool, courseId, assignmentId); if (!rb.ok) return notFound("Assignment");
  if (!rb.rubric) return { ok: true, rubric: null };
  const x = rb.rubric;
  return { ok: true, rubric: { title: x.title, description: x.description, maxPoints: x.maxPoints, criteria: x.criteria.map((c) => ({ title: c.title, description: c.description, weight: c.weight, levels: c.levels.map((l) => ({ label: l.label, description: l.description, points: l.points })) })) } };
}

module.exports = { releaseDue: release.releaseDue, attachStatus, rubricForStudent, FILTERS: Object.keys(FILTER_SQL), finalOf, validateGrade, listQueue, getForMarking, readFileForStaff, saveGrade, returnGrade, feedbackForStudent };
