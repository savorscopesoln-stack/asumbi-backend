/* =========================================================================
   LMS OFFLINE QUEUED ACTIONS, LESSON PROGRESS  (L10.3a, D-115)  flag `lms_offline`, schema step 043 (`lms_offline_actions`).
   A learner's device queued "I opened / completed this lesson" while offline and replays the queue here. Rules:
   - Student + ACTIVE enrolment (routes). The student id comes from the token. 1-50 actions per request, processed in order.
   - Each action has a device-made `clientActionId` (8-64 of A-Z a-z 0-9 _ -), a `type` (`lesson_view` | `lesson_complete`), `lessonId`, `queuedAt` (when the learner did it) and,
     for views, `seconds` (0-600). Unknown fields are refused. Only these two types exist; quiz answers and submissions are NOT queued here, controlled exams never.
   - IDEMPOTENT: (student, clientActionId) is unique. A replay returns the stored result with state `duplicate` and changes nothing. Reusing an id for another course/type/lesson
     is `rejected` ACTION_ID_REUSED. A row left unfinished by a crash is finished by the next replay.
   - Results per action: `applied` (the normal progress rules ran and accepted it; `newlyCompleted` says whether it changed anything), `duplicate`, `rejected` with a code
     (STALE_ACTION queuedAt older than 30 days or more than 5 minutes in the future, NOT_FOUND lesson hidden/removed, LESSON_LOCKED, COURSE_ARCHIVED, MIN_TIME_NOT_MET, INVALID).
     `conflict` is reserved for L10.4 (draft text); progress can never conflict because completion only moves forward and never un-completes.
   - The SAME rules as online (`utils/lmsProgress.js`): time credit is decided by the SERVER clock and capped, so study time done offline is NOT credited (Q103); a lesson hidden or
     locked now is refused even if it was open when the pack was built; the event `lms.lesson.completed` fires once. Nothing is silently dropped: every action gets an answer.
   - Stored: ids, type, outcome (no text, no personal data). One batch is NOT a transaction: each action finishes on its own, so a failure in the middle leaves earlier ones applied
     and the response (or a later replay) tells the device which.
========================================================================= */
const sql = require("mssql");
const progressDefault = require("./lmsProgress");
const { posInt } = require("./lmsCourseParts");

const MAX_ACTIONS = 50, MAX_AGE_DAYS = 30, FUTURE_SKEW_MS = 5 * 60 * 1000, ID_RE = /^[A-Za-z0-9_-]{8,64}$/, TYPES = ["lesson_view", "lesson_complete"];
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isDup = (e) => e && (e.number === 2627 || e.number === 2601);
const KEYS = ["clientActionId", "type", "lessonId", "queuedAt", "seconds"];

/* Pure. { ok, actions:[{...}] } or { ok:false, errors }. A bad single action does NOT refuse the batch: it comes back as `invalid` so the device learns which. */
function validateBatch(body, now = new Date()) {
  if (!isObj(body) || Object.keys(body).some((k) => k !== "actions")) return { ok: false, errors: ["Send {actions: [...]} only."] };
  const a = body.actions; if (!Array.isArray(a) || !a.length || a.length > MAX_ACTIONS) return { ok: false, errors: [`actions must hold 1 to ${MAX_ACTIONS} items.`] };
  const seen = new Set(), out = [];
  for (const x of a) {
    const id = isObj(x) && typeof x.clientActionId === "string" && ID_RE.test(x.clientActionId) ? x.clientActionId : null;
    if (id && seen.has(id)) { out.push({ clientActionId: id, invalid: "Repeated clientActionId in one request." }); continue; }
    if (id) seen.add(id);
    const bad = (m) => out.push({ clientActionId: id, invalid: m });
    if (!id) { bad("clientActionId must be 8-64 characters of A-Z a-z 0-9 _ -."); continue; }
    const extra = Object.keys(x).find((k) => !KEYS.includes(k)); if (extra) { bad(`Unknown field: ${extra}.`); continue; }
    if (!TYPES.includes(x.type)) { bad("type must be lesson_view or lesson_complete."); continue; }
    if (!Number.isInteger(x.lessonId) || x.lessonId < 1) { bad("lessonId must be a positive whole number."); continue; }
    const q = typeof x.queuedAt === "string" ? new Date(x.queuedAt) : null; if (!q || Number.isNaN(q.getTime())) { bad("queuedAt must be a date and time."); continue; }
    let seconds = 0;
    if (x.seconds !== undefined) { if (x.type !== "lesson_view" || !Number.isInteger(x.seconds) || x.seconds < 0 || x.seconds > progressDefault.MAX_CLAIM_SECONDS) { bad("seconds is only for lesson_view, a whole number from 0 to 600."); continue; } seconds = x.seconds; }
    out.push({ clientActionId: id, type: x.type, lessonId: x.lessonId, queuedAt: q, seconds });
  }
  return { ok: true, actions: out };
}

const stale = (q, now) => q.getTime() < now.getTime() - MAX_AGE_DAYS * 86400000 || q.getTime() > now.getTime() + FUTURE_SKEW_MS;
const codeOf = (r) => (r.notFound ? "NOT_FOUND" : r.code || "INVALID");
const answer = (a, state, code, extra) => ({ clientActionId: a.clientActionId, state, ...(code ? { code } : {}), ...(extra || {}) });

async function finish(pool, rowId, studentId, state, code) {
  await pool.request().input("id", sql.Int, rowId).input("s", sql.Int, studentId).input("st", sql.NVarChar(12), state).input("cd", sql.NVarChar(40), code || null)
    .query(`UPDATE lms_offline_actions SET result_state = @st, result_code = @cd, processed_at = SYSUTCDATETIME() WHERE id = @id AND student_id = @s`);
}

async function processOne(pool, courseId, studentId, a, ctx) {
  const now = ctx.now || new Date(), P = ctx.progress || progressDefault;
  if (a.invalid) return { clientActionId: a.clientActionId || null, state: "rejected", code: "INVALID", message: a.invalid };
  if (stale(a.queuedAt, now)) return answer(a, "rejected", "STALE_ACTION"); // nothing stored: a stale action never claims its id
  let rowId = null;
  try {
    const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, studentId).input("a", sql.NVarChar(64), a.clientActionId).input("t", sql.NVarChar(30), a.type).input("l", sql.Int, a.lessonId).input("q", sql.DateTime2, a.queuedAt)
      .query(`INSERT INTO lms_offline_actions (course_id, student_id, client_action_id, action_type, lesson_id, queued_at) OUTPUT INSERTED.id VALUES (@c, @s, @a, @t, @l, @q)`);
    rowId = r.recordset && r.recordset[0] ? r.recordset[0].id : null;
  } catch (e) { if (!isDup(e)) throw e; }
  if (rowId === null) {
    const q = await pool.request().input("s", sql.Int, studentId).input("a", sql.NVarChar(64), a.clientActionId)
      .query(`SELECT TOP 1 id, course_id, action_type, lesson_id, result_state, result_code FROM lms_offline_actions WHERE student_id = @s AND client_action_id = @a`);
    const old = q.recordset && q.recordset[0]; if (!old) return answer(a, "rejected", "INVALID");
    if (old.course_id !== courseId || old.action_type !== a.type || old.lesson_id !== a.lessonId) return answer(a, "rejected", "ACTION_ID_REUSED");
    if (old.result_state) return answer(a, "duplicate", old.result_code || null, { firstResult: old.result_state });
    rowId = old.id; // received earlier but never finished: finish it now
  }
  const r = a.type === "lesson_view" ? await P.recordView(pool, courseId, a.lessonId, studentId, { seconds: a.seconds }, ctx.tenant) : await P.markComplete(pool, courseId, a.lessonId, studentId, ctx.tenant);
  if (!r.ok) { const code = codeOf(r); await finish(pool, rowId, studentId, "rejected", code); return answer(a, "rejected", code, r.errors && r.errors[0] ? { message: r.errors[0] } : {}); }
  await finish(pool, rowId, studentId, "applied", null);
  return answer(a, "applied", null, { newlyCompleted: !!r.newlyCompleted, ...(r.progress ? { progress: { status: r.progress.status, completedAt: r.progress.completedAt } } : {}) });
}

async function replayProgress(pool, courseId, studentId, body, ctx = {}) {
  const cid = posInt(courseId), sid = posInt(studentId); if (!cid || !sid) return { ok: false, notFound: true, errors: ["Course not found."] };
  const v = validateBatch(body, ctx.now || new Date()); if (!v.ok) return { ok: false, errors: v.errors };
  const results = []; for (const a of v.actions) results.push(await processOne(pool, cid, sid, a, ctx));
  const count = (s) => results.filter((x) => x.state === s).length;
  return { ok: true, results, summary: { applied: count("applied"), duplicate: count("duplicate"), rejected: count("rejected") } };
}

module.exports = { MAX_ACTIONS, MAX_AGE_DAYS, TYPES, validateBatch, replayProgress };
