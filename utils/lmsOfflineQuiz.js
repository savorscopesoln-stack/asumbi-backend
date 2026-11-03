/* =========================================================================
   LMS OFFLINE QUEUED QUIZ ANSWERS  (L10.3c, D-118)  flag `lms_offline`, schema step 045 (two nullable columns on `lms_offline_actions`).
   A learner answered questions of a PRACTICE quiz offline. The device replays them here as an ANSWER AUTOSAVE (the same thing `PUT .../attempts/:id/answers` does online). Rules:
   - Student + ACTIVE enrolment (routes). The student id comes from the token. 1-3 actions per request, in order. Never queued: starting an attempt (the learner opens it online, which
     also freezes the questions and the shuffle seed), SUBMITTING an attempt (online only, like Q104), timed quizzes, coursework, quizzes that count to the grade, flashcards, controlled exams.
   - ELIGIBLE (pure `eligibility`): assessmentType `practice`, mode `quiz` or `revision`, NO time limit, does NOT count to the grade (Q107). Anything else is `rejected` NOT_OFFLINE_ELIGIBLE.
     A mock test always has a timer, so it is excluded by the same rule. The SERVER clock decides everything about time: an attempt past its deadline + grace is `rejected` TIME_UP.
   - Action = { clientActionId, type: "quiz_answers", quizId, attemptId, queuedAt, answers: { "<quizQuestionId>": { value, base } } }. `value` = the answer the learner gave (null = cleared),
     `base` = the answer the device last saw from the server for that question (null = none). Both are in the DISPLAY refs the learner saw, shaped exactly like the online save (`cleanAnswer`).
   - NEVER silently overwrite, per question: the write happens only while the server answer still equals `base` (one guarded UPDATE/INSERT naming the exact stored text it was decided on).
     Server answer == `value` = `unchanged` (a replay, or the same answer from another device). Otherwise that question is a `conflict` with BOTH answers (the learner's own, never a key, never marks).
     Other questions of the same action are still applied. Any conflict makes the action state `conflict`; the action id is NOT used up, so a replay re-checks (answers already saved are `unchanged`).
     The learner settles a conflict with the normal online save; the device then drops the action.
   - The whole action is validated first (unknown question, bad answer shape, base/value shape): one bad answer = the action is `rejected` INVALID and nothing is written.
   - Idempotent: (student, clientActionId) is unique, like the other offline actions. A replay of a finished action is `duplicate` with `firstResult`; the id reused for another course/quiz/attempt/type
     is `rejected` ACTION_ID_REUSED. A stale action (queuedAt older than 30 days or more than 5 min ahead) is `rejected` STALE_ACTION and does not claim its id.
   - Stored: ids, type, outcome. NO answers (the answers live only in `lms_quiz_answers`). No audit (an autosave is not audited online either). No score, key or explanation is ever returned.
========================================================================= */
const sql = require("mssql");
const Q = require("./lmsQuizAttempts");
const { posInt } = require("./lmsCourseParts");

const MAX_ACTIONS = 3, MAX_AGE_DAYS = 30, FUTURE_SKEW_MS = 5 * 60 * 1000, ID_RE = /^[A-Za-z0-9_-]{8,64}$/, TYPE = "quiz_answers";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isDup = (e) => e && (e.number === 2627 || e.number === 2601);
const KEYS = ["clientActionId", "type", "quizId", "attemptId", "queuedAt", "answers"];
const canon = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const parseStored = (json) => { if (json === null || json === undefined) return null; try { const v = JSON.parse(json); return isObj(v) ? v : null; } catch { return null; } };

/* Pure. { ok:true } or { ok:false, code, message }. */
function eligibility(quiz) {
  if (!quiz) return { ok: false, code: "NOT_FOUND", message: "Quiz not found." };
  if (quiz.readOnly) return { ok: false, code: "COURSE_READ_ONLY", message: "This course is archived, so quizzes can no longer be taken." };
  if (quiz.mode === "flashcards") return { ok: false, code: "NOT_OFFLINE_ELIGIBLE", message: "Flashcard decks have no answers to sync." };
  if (quiz.assessmentType !== "practice" || (quiz.mode !== "quiz" && quiz.mode !== "revision") || quiz.timeLimitMinutes || quiz.countsToGrade) return { ok: false, code: "NOT_OFFLINE_ELIGIBLE", message: "Only untimed practice quizzes that do not count towards a grade can be answered offline. Open this quiz online." };
  return { ok: true };
}

/* Pure. A bad single action does NOT refuse the batch: it comes back as `invalid`. Answer SHAPES are checked later, against the real questions. */
function validateBatch(body) {
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
    if (x.type !== TYPE) { bad("type must be quiz_answers."); continue; }
    if (!Number.isInteger(x.quizId) || x.quizId < 1) { bad("quizId must be a positive whole number."); continue; }
    if (!Number.isInteger(x.attemptId) || x.attemptId < 1) { bad("attemptId must be a positive whole number."); continue; }
    const q = typeof x.queuedAt === "string" ? new Date(x.queuedAt) : null; if (!q || Number.isNaN(q.getTime())) { bad("queuedAt must be a date and time."); continue; }
    if (!isObj(x.answers)) { bad('answers must be an object: {"<question id>": {"value": ..., "base": ...}}.'); continue; }
    const keys = Object.keys(x.answers); if (!keys.length || keys.length > Q.MAX_ANSWERS_PER_CALL) { bad(`answers must hold 1 to ${Q.MAX_ANSWERS_PER_CALL} questions.`); continue; }
    let problem = null; const values = {}, bases = {};
    for (const k of keys) {
      const e = x.answers[k];
      if (!/^\d{1,9}$/.test(k)) { problem = `Question ${k.slice(0, 12)} is not a valid question id.`; break; }
      if (!isObj(e) || Object.keys(e).some((f) => f !== "value" && f !== "base") || !("value" in e) || !("base" in e)) { problem = `Question ${k}: send {value, base} (null for none).`; break; }
      values[k] = e.value; bases[k] = e.base;
    }
    if (problem) { bad(problem); continue; }
    out.push({ clientActionId: id, type: TYPE, quizId: x.quizId, attemptId: x.attemptId, queuedAt: q, values, bases });
  }
  return { ok: true, actions: out };
}

const stale = (q, now) => q.getTime() < now.getTime() - MAX_AGE_DAYS * 86400000 || q.getTime() > now.getTime() + FUTURE_SKEW_MS;
const answer = (a, state, code, extra) => ({ clientActionId: a.clientActionId, state, ...(code ? { code } : {}), ...(extra || {}) });

async function finish(pool, rowId, sid, state, code) {
  await pool.request().input("id", sql.Int, rowId).input("s", sql.Int, sid).input("st", sql.NVarChar(12), state).input("cd", sql.NVarChar(40), code || null)
    .query(`UPDATE lms_offline_actions SET result_state = @st, result_code = @cd, processed_at = SYSUTCDATETIME() WHERE id = @id AND student_id = @s`);
}

/* The raw stored text per question (the guard compares against exactly this text). */
async function loadRaw(pool, courseId, quizId, attemptId, sid) {
  const r = await pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT quiz_question_id, answer_json FROM lms_quiz_answers WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s`);
  const m = new Map(); for (const x of r.recordset || []) m.set(x.quiz_question_id, x.answer_json === null || x.answer_json === undefined ? null : String(x.answer_json)); return m;
}
/* One guarded write, only while the attempt is still in progress and the stored text is still `seen` (null = no text / no row). Returns true when it wrote. */
async function guardedWrite(pool, courseId, quizId, attemptId, sid, qid, value, seen, exists, now) {
  const req = () => pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, sid).input("q", sql.Int, qid)
    .input("j", sql.NVarChar(sql.MAX), value === null ? null : JSON.stringify(value)).input("seen", sql.NVarChar(sql.MAX), seen).input("now", sql.DateTime2, now);
  const live = `EXISTS (SELECT 1 FROM lms_quiz_attempts p WHERE p.id = @a AND p.quiz_id = @z AND p.course_id = @c AND p.student_id = @s AND p.status = 'in_progress')`;
  try {
    const r = exists
      ? await req().query(`UPDATE lms_quiz_answers SET answer_json = @j, updated_at = @now WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s AND quiz_question_id = @q AND (answer_json = @seen OR (answer_json IS NULL AND @seen IS NULL)) AND ${live}; SELECT @@ROWCOUNT AS n;`)
      : await req().query(`INSERT INTO lms_quiz_answers (attempt_id, quiz_id, course_id, student_id, quiz_question_id, answer_json, max_points, created_at, updated_at)
          SELECT @a, @z, @c, @s, @q, @j, 0, @now, @now WHERE ${live} AND NOT EXISTS (SELECT 1 FROM lms_quiz_answers w WHERE w.attempt_id = @a AND w.quiz_question_id = @q); SELECT @@ROWCOUNT AS n;`);
    return Number(r.recordset && r.recordset[0] ? r.recordset[0].n : 0) === 1;
  } catch (e) { if (!isDup(e)) throw e; return false; }
}

/* Decide + write one question. Returns { state: 'applied'|'unchanged'|'conflict', conflict? }. Max two passes (a race can move the stored text once). */
async function applyOne(pool, courseId, quizId, attemptId, sid, qid, value, base, now) {
  for (let pass = 0; pass < 2; pass++) {
    const raw = (await loadRaw(pool, courseId, quizId, attemptId, sid)); const exists = raw.has(qid), seen = exists ? raw.get(qid) : null, serverAnswer = parseStored(seen);
    if (canon(serverAnswer) === canon(value)) return { state: "unchanged" };
    if (canon(serverAnswer) !== canon(base)) return { state: "conflict", conflict: { questionId: qid, serverAnswer, deviceAnswer: value } };
    if (await guardedWrite(pool, courseId, quizId, attemptId, sid, qid, value, seen, exists, now)) return { state: "applied" };
  }
  const raw = await loadRaw(pool, courseId, quizId, attemptId, sid); const serverAnswer = parseStored(raw.has(qid) ? raw.get(qid) : null);
  return canon(serverAnswer) === canon(value) ? { state: "unchanged" } : { state: "conflict", conflict: { questionId: qid, serverAnswer, deviceAnswer: value } };
}

async function processOne(pool, courseId, sid, a, ctx) {
  const now = ctx.now || new Date(), L = ctx.quizzes || Q;
  if (a.invalid) return { clientActionId: a.clientActionId || null, state: "rejected", code: "INVALID", message: a.invalid };
  if (stale(a.queuedAt, now)) return answer(a, "rejected", "STALE_ACTION"); // nothing stored: a stale action never claims its id
  let rowId = null;
  try {
    const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sid).input("a", sql.NVarChar(64), a.clientActionId).input("t", sql.NVarChar(30), TYPE).input("z", sql.Int, a.quizId).input("at", sql.Int, a.attemptId).input("q", sql.DateTime2, a.queuedAt)
      .query(`INSERT INTO lms_offline_actions (course_id, student_id, client_action_id, action_type, quiz_id, attempt_id, queued_at) OUTPUT INSERTED.id VALUES (@c, @s, @a, @t, @z, @at, @q)`);
    rowId = r.recordset && r.recordset[0] ? r.recordset[0].id : null;
  } catch (e) { if (!isDup(e)) throw e; }
  if (rowId === null) {
    const q = await pool.request().input("s", sql.Int, sid).input("a", sql.NVarChar(64), a.clientActionId)
      .query(`SELECT TOP 1 id, course_id, action_type, quiz_id, attempt_id, result_state, result_code FROM lms_offline_actions WHERE student_id = @s AND client_action_id = @a`);
    const old = q.recordset && q.recordset[0]; if (!old) return answer(a, "rejected", "INVALID");
    if (old.course_id !== courseId || old.action_type !== TYPE || old.quiz_id !== a.quizId || old.attempt_id !== a.attemptId) return answer(a, "rejected", "ACTION_ID_REUSED");
    if (old.result_state) return answer(a, "duplicate", old.result_code || null, { firstResult: old.result_state });
    rowId = old.id; // received earlier but never finished (a crash, or an earlier conflict): evaluate it again against the server as it is now
  }
  const reject = async (code, message) => { await finish(pool, rowId, sid, "rejected", code); return answer(a, "rejected", code, message ? { message } : {}); };
  const quiz = await L.loadQuiz(pool, courseId, a.quizId, now); // visible, published, available, course published/archived; null otherwise
  const el = eligibility(quiz); if (!el.ok) return reject(el.code, el.message);
  const attempt = await L.loadAttempt(pool, courseId, a.quizId, sid, a.attemptId); if (!attempt) return reject("NOT_FOUND", "Attempt not found.");
  if (attempt.status !== "in_progress") return reject("ATTEMPT_CLOSED", "This attempt has already been submitted. Your offline answers were not saved.");
  if (Q.pastGrace(attempt.deadlineAt, now)) return reject("TIME_UP", "Time is up for this attempt. Your offline answers were not saved.");
  const questions = await L.loadQuestions(pool, courseId, a.quizId, attempt.id); const byId = new Map(questions.map((x) => [x.id, x]));
  const vv = Q.validateAnswersBody({ answers: a.values }, byId), bb = Q.validateAnswersBody({ answers: a.bases }, byId);
  if (!vv.ok || !bb.ok) return reject("INVALID", (vv.errors || bb.errors)[0]);
  const items = []; let conflicts = 0, applied = 0;
  for (const [qid, value] of vv.answers) {
    const r = await applyOne(pool, courseId, a.quizId, attempt.id, sid, qid, value, bb.answers.get(qid) ?? null, now);
    if (r.state === "conflict") conflicts += 1; if (r.state === "applied") applied += 1;
    items.push({ questionId: qid, state: r.state, ...(r.conflict ? { conflict: { serverAnswer: r.conflict.serverAnswer, deviceAnswer: r.conflict.deviceAnswer } } : {}) });
  }
  if (conflicts) return answer(a, "conflict", "ANSWER_CHANGED", { items, applied, conflicts }); // the row stays unfinished on purpose: the id is not used up
  await finish(pool, rowId, sid, "applied", null);
  return answer(a, "applied", null, { items, applied });
}

async function replayQuizAnswers(pool, courseId, studentId, body, ctx = {}) {
  const cid = posInt(courseId), sid = posInt(studentId); if (!cid || !sid) return { ok: false, notFound: true, errors: ["Course not found."] };
  const v = validateBatch(body); if (!v.ok) return { ok: false, errors: v.errors };
  const results = []; for (const a of v.actions) results.push(await processOne(pool, cid, sid, a, ctx));
  const count = (s) => results.filter((x) => x.state === s).length;
  return { ok: true, results, summary: { applied: count("applied"), duplicate: count("duplicate"), conflict: count("conflict"), rejected: count("rejected") } };
}

module.exports = { MAX_ACTIONS, TYPE, eligibility, validateBatch, replayQuizAnswers };
