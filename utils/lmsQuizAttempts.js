/* =========================================================================
   LMS QUIZ ATTEMPTS  (L6.2b-1, D-077)  the STUDENT side of a quiz: list, start, resume, autosave, submit, auto-mark, result.
   Staff marking of written (essay) answers is L6.2b-2; random selection from the bank is L6.2c (D-080).

   Rules (documented, simple):
   - Students only. The student id ALWAYS comes from the token. Every query also matches quiz_id, course_id and student_id, so one learner can never
     read or change another's attempt. The route guarantees an ACTIVE enrolment; this file re-checks that the quiz is published, already available and
     in a PUBLISHED or ARCHIVED course. An archived course is read-only: results can be read, nothing can be started, saved or submitted.
   - Window (pure `availability`): a quiz with a dueAt is closed after it (no late submissions for quizzes). No dueAt = always open.
   - Attempts: at most `maxAttempts`, counted over ALL of the learner's attempts (in progress, submitted, graded). The limit is enforced inside the same
     SQL statement that creates the attempt, and a UNIQUE index allows only ONE in-progress attempt per learner per quiz, so a double click or a second
     tab cannot start two. Starting while one is in progress RESUMES it (same questions, same order, same saved answers).
   - Time is the SERVER clock. `deadline_at` = start + timeLimitMinutes, but never later than the quiz dueAt (null = no deadline). Answers are accepted up to
     deadline + GRACE_SECONDS (network lag). After that the attempt is closed AUTOMATICALLY with the answers saved so far (`auto_submitted` = 1,
     submitted_at = the deadline). This happens lazily on the next read / save / submit (no timer process); a missed call only delays it.
   - Shuffling is a pure function of the attempt `seed`, so a reload shows the same screen. shuffleQuestions orders the questions; shuffleOptions orders the
     options of multiple-choice questions (off = the teacher's order). Matching and ordering are ALWAYS shuffled (an unshuffled list would show the answer key).
   - A student NEVER receives correct flags, accepted answers, option feedback or explanations while the attempt is in progress (`studentView`).
   - Answers are stored exactly as sent (in the DISPLAY refs the student saw) and translated to positions only when marking (`translateAnswer`).
   - Marking (on submit): every auto-markable type uses `markAnswer` (D-072). An essay with text is `manual` (waits for the teacher, L6.2b-2) and the attempt
     becomes `submitted` with needs_marking = 1; an empty essay is `unanswered` = 0. If nothing needs marking the attempt is `graded` straight away.
     total_points is set only when the attempt is `graded` (no half scores). Short answers ARE auto-marked (accepted-answer list), not queued.
   - Submit is ONE transaction: a guarded UPDATE (only an in-progress attempt) claims the attempt and, only if it did, the answer rows are written.
     A double click / second tab gets the already-submitted attempt back (`alreadySubmitted`).
   - Feedback (pure `feedbackOf`): immediate = result visible after submit; after_close = visible once the quiz dueAt has passed; never = the learner sees the SCORE
     only (Q44 = yes, S33), never answers, keys or explanations (the gradebook, L7, decides what else is released).
     "Visible" means score + per-question result + correct answers + explanations (one switch, deliberately simple; open question Q43).
   - Random questions (L6.2c, D-080): a quiz with rules gets its random questions PICKED when the attempt starts (utils/lmsQuizRules.js) and FROZEN as rows of
     lms_quiz_questions with attempt_id = this attempt. Everything below (take, save, submit, result, marking) reads the fixed set PLUS that attempt's own picks,
     never another attempt's. A pool too small = 409 NOT_ENOUGH_QUESTIONS and no attempt is used. Resuming repairs a start that crashed before the picks were written.
   - Events (ids only): `lms.quiz.attempted` on every submit, `lms.quiz.graded` when the attempt is graded at once. Audit: `quiz.attempt_submitted`.
   Every query is parameterised. Authorisation (role, enrolment, licence flag) lives in the routes.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const M = require("./lmsQuizMarking");
const events = require("./lmsEvents");
const rules = require("./lmsQuizRules");

const GRACE_SECONDS = 30, MAX_ANSWERS_PER_CALL = 100, MAX_ESSAY_CHARS = 20000, MAX_SHORT_CHARS = 500, MAX_ITEMS = 12;
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => Math.round(Number(v) * 100) / 100;
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
/* Two simultaneous writes of the same answer row can collide on the unique index (2601/2627): the loser simply runs again (it then updates). */
const retryDup = async (fn) => { try { return await fn(); } catch (e) { if (!isDup(e)) throw e; return fn(); } };
const notFound = (what = "Quiz") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const studentIdOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a.id : null; };

/* ------------------------------- pure helpers ------------------------------- */

/* quiz = { dueAt: Date|null }. readOnly = archived course. */
function availability(quiz, { readOnly = false, now = new Date() } = {}) {
  if (readOnly) return { open: false, code: "COURSE_READ_ONLY", message: "This course is archived, so quizzes can no longer be taken." };
  if (quiz.dueAt && now > quiz.dueAt) return { open: false, code: "QUIZ_CLOSED", message: "The due date has passed, so this quiz is closed." };
  return { open: true };
}

/* start + time limit, but never after the due date. Null = no deadline. */
function deadlineOf(quiz, now = new Date()) {
  const cands = [];
  if (quiz.timeLimitMinutes) cands.push(new Date(now.getTime() + quiz.timeLimitMinutes * 60000));
  if (quiz.dueAt) cands.push(quiz.dueAt);
  return cands.length ? new Date(Math.min(...cands.map((d) => d.getTime()))) : null;
}
const pastGrace = (deadline, now) => !!deadline && now.getTime() > deadline.getTime() + GRACE_SECONDS * 1000;

/* Pure. One answer from the browser -> the stored shape for that type, or an error. `null` / empty = "cleared" (value null). */
function cleanAnswer(question, raw) {
  const t = question.type, spec = question.spec || {};
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!isPlainObject(raw)) return { ok: false, message: "An answer must be an object." };
  const only = (key) => { const extra = Object.keys(raw).filter((k) => k !== key); return extra.length ? `Unknown field "${extra[0]}" in an answer to a ${t} question.` : null; };
  const list = (v, allowNull) => {
    if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
    const out = [];
    for (const x of v) { if (allowNull && (x === null || x === undefined || x === "")) { out.push(null); continue; } const n = posInt(x); if (n === null || n > MAX_ITEMS) return null; out.push(n); }
    return out;
  };
  switch (t) {
    case "mcq_single": {
      const e = only("selected"); if (e) return { ok: false, message: e };
      if (raw.selected === null || raw.selected === undefined || raw.selected === "") return { ok: true, value: null };
      const n = posInt(raw.selected); if (n === null || n > MAX_ITEMS) return { ok: false, message: "selected must be an option number." };
      return { ok: true, value: { selected: n } };
    }
    case "mcq_multi": {
      const e = only("selected"); if (e) return { ok: false, message: e };
      const l = list(raw.selected, false); if (!l) return { ok: false, message: "selected must be a list of option numbers." };
      return { ok: true, value: l.length ? { selected: [...new Set(l)] } : null };
    }
    case "true_false": {
      const e = only("selected"); if (e) return { ok: false, message: e };
      if (raw.selected === null || raw.selected === undefined || raw.selected === "") return { ok: true, value: null };
      const b = raw.selected === true || raw.selected === "true" ? true : raw.selected === false || raw.selected === "false" ? false : null;
      if (b === null) return { ok: false, message: "selected must be true or false." };
      return { ok: true, value: { selected: b } };
    }
    case "short_answer": {
      const e = only("text"); if (e) return { ok: false, message: e };
      if (typeof raw.text !== "string") return { ok: false, message: "text must be a string." };
      const s = oneLine(raw.text); if (s.length > MAX_SHORT_CHARS) return { ok: false, message: `A short answer can be at most ${MAX_SHORT_CHARS} characters.` };
      return { ok: true, value: s ? { text: s } : null };
    }
    case "numeric": {
      const e = only("value"); if (e) return { ok: false, message: e };
      if (raw.value === null || raw.value === undefined) return { ok: true, value: null };
      if (typeof raw.value === "number") { if (!Number.isFinite(raw.value)) return { ok: false, message: "value must be a number." }; return { ok: true, value: { value: raw.value } }; }
      if (typeof raw.value !== "string") return { ok: false, message: "value must be a number or text." };
      const s = oneLine(raw.value); if (s.length > 30) return { ok: false, message: "value is too long." };
      return { ok: true, value: s ? { value: s } : null };
    }
    case "matching": {
      const e = only("pairs"); if (e) return { ok: false, message: e };
      const l = list(raw.pairs, true); if (!l) return { ok: false, message: "pairs must be a list of numbers (or null for a pair not set)." };
      return { ok: true, value: l.every((x) => x === null) ? null : { pairs: l } };
    }
    case "ordering": {
      const e = only("order"); if (e) return { ok: false, message: e };
      const l = list(raw.order, false); if (!l) return { ok: false, message: "order must be a list of item numbers." };
      return { ok: true, value: l.length ? { order: l } : null };
    }
    case "essay": {
      const e = only("text"); if (e) return { ok: false, message: e };
      if (typeof raw.text !== "string") return { ok: false, message: "text must be a string." };
      const s = multiLine(raw.text); if (s.length > MAX_ESSAY_CHARS) return { ok: false, message: `An essay answer can be at most ${MAX_ESSAY_CHARS} characters.` };
      const cap = spec.maxWords; if (cap && s.split(/\s+/).filter(Boolean).length > cap) return { ok: false, message: `This answer is limited to ${cap} words.` };
      return { ok: true, value: s ? { text: s } : null };
    }
    default: return { ok: false, message: "Unknown question type." };
  }
}

/* Pure. body = { answers: { "<quizQuestionId>": answer|null, ... } } -> Map(id -> stored value|null). */
function validateAnswersBody(body, byId) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "answers") || !isPlainObject(body.answers)) return { ok: false, errors: ['Body must be {"answers": {"<question id>": answer}}.'] };
  const keys = Object.keys(body.answers);
  if (keys.length > MAX_ANSWERS_PER_CALL) return { ok: false, errors: [`At most ${MAX_ANSWERS_PER_CALL} answers per call.`] };
  const out = new Map(), errors = [];
  for (const k of keys) {
    const id = /^\d{1,9}$/.test(k) ? Number(k) : null;
    const q = id !== null ? byId.get(id) : null;
    if (!q) { errors.push(`Question ${k.slice(0, 12)} is not part of this quiz.`); continue; }
    const c = cleanAnswer(q, body.answers[k]); if (!c.ok) { errors.push(`Question ${id}: ${c.message}`); continue; }
    out.set(id, c.value);
  }
  return errors.length ? { ok: false, errors } : { ok: true, answers: out };
}

/* Pure. Display order of the quiz's questions for one attempt. */
function orderOf(questions, shuffle, seed) {
  const sorted = [...questions].sort((a, b) => a.position - b.position || a.id - b.id);
  if (!shuffle || sorted.length < 2) return sorted;
  return M.permutation(sorted.length, `${seed}:q`).map((p) => sorted[p - 1]);
}

/* Pure. What the student sees of one question (never the key). Returns { view, refMap }. */
function renderQuestion(q, seed, shuffleOptions) {
  const r = M.studentView({ type: q.type, stem: q.stem, points: q.points, spec: q.spec }, `${seed}:${q.id}`);
  if (!shuffleOptions && (q.type === "mcq_single" || q.type === "mcq_multi") && Array.isArray(r.view.options)) r.view.options = [...r.view.options].sort((a, b) => a.position - b.position);
  return r;
}

/* Pure. The key, shown ONLY when feedback is visible (positions, never display refs). */
function revealQuestion(q) {
  const s = q.spec || {};
  switch (q.type) {
    case "mcq_single": case "mcq_multi": return { options: (s.options || []).map((o) => ({ position: o.position, text: o.text, correct: !!o.correct, feedback: o.feedback || "" })) };
    case "true_false": return { correct: s.correct === true };
    case "short_answer": return { accepted: s.accepted || [] };
    case "numeric": return { value: s.value, tolerance: s.tolerance || 0, unit: s.unit || "" };
    case "matching": return { pairs: (s.pairs || []).map((p) => ({ position: p.position, left: p.left, right: p.right })) };
    case "ordering": return { items: (s.items || []).map((p) => ({ position: p.position, text: p.text })) };
    default: return {};
  }
}

/* Pure. Mark every question of an attempt. answers = Map(quizQuestionId -> stored value|null). Never throws. */
function markAttempt(questions, answers, seed, shuffleOptions = false) {
  const rows = []; let auto = 0, manual = 0, max = 0;
  for (const q of questions) {
    const mx = num(q.points); max += mx; const a = answers.get(q.id) ?? null;
    let status, points;
    if (q.type === "essay") {
      if (a && typeof a.text === "string" && a.text.trim()) { status = "manual"; points = null; manual += 1; } else { status = "unanswered"; points = 0; }
    } else {
      const { refMap } = renderQuestion(q, seed, shuffleOptions);
      const r = M.markAnswer({ type: q.type, points: q.points, spec: q.spec }, M.translateAnswer(q, refMap, a));
      status = r.status; points = r.points === null || r.points === undefined ? 0 : r.points;
    }
    if (points !== null) auto += points;
    rows.push({ quizQuestionId: q.id, answer: a, status, points, maxPoints: mx });
  }
  return { rows, autoPoints: num(auto), maxPoints: num(max), needsMarking: manual > 0, manualCount: manual };
}

/* Pure. Is the result of a submitted attempt visible to the learner now? */
function feedbackOf(quiz, now = new Date()) {
  if (quiz.feedbackTiming === "immediate") return { visible: true, scoreVisible: true };
  if (quiz.feedbackTiming === "after_close") return quiz.dueAt && now > quiz.dueAt ? { visible: true, scoreVisible: true } : { visible: false, scoreVisible: false, reason: "after_close", message: "Your result will be shown after the quiz closes." };
  /* Q44 (owner: yes): with feedback "never" the learner still sees the SCORE, but never the per-question answers, keys or explanations. */
  return { visible: false, scoreVisible: true, reason: "never", message: "Your score is shown below. Answers and explanations are not shared for this quiz." };
}

/* ------------------------------- data access ------------------------------- */
const ATT_COLS = "id, quiz_id, course_id, student_id, attempt_no, status, seed, started_at, deadline_at, submitted_at, auto_submitted, auto_points, manual_points, total_points, max_points, needs_marking";
const QZ_COLS = "z.id, z.course_id, z.title, z.instructions, z.assessment_type, z.quiz_mode, z.available_from, z.due_at, z.time_limit_minutes, z.max_attempts, z.shuffle_questions, z.shuffle_options, z.feedback_timing, z.counts_to_grade";
const QZ_SUMMARY = "(SELECT COUNT(*) FROM lms_quiz_questions k WHERE k.quiz_id = z.id AND k.attempt_id IS NULL) + (SELECT ISNULL(SUM(r.pick_count), 0) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS question_count, (SELECT ISNULL(SUM(k.points), 0) FROM lms_quiz_questions k WHERE k.quiz_id = z.id AND k.attempt_id IS NULL) + (SELECT ISNULL(SUM(r.pick_count * r.points_each), 0) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS total_points, (SELECT COUNT(*) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS rule_count";
const VISIBLE = "z.deleted_at IS NULL AND z.status = 'published' AND (z.available_from IS NULL OR z.available_from <= @now)";
const JOIN_COURSE = "JOIN lms_courses c ON c.id = z.course_id AND c.deleted_at IS NULL AND c.status IN ('published','archived')";

const quizModel = (r) => ({ id: r.id, courseId: r.course_id, title: r.title, instructions: r.instructions || "", assessmentType: r.assessment_type, mode: r.quiz_mode || "quiz", availableFrom: r.available_from ? new Date(r.available_from) : null,
  dueAt: r.due_at ? new Date(r.due_at) : null, timeLimitMinutes: r.time_limit_minutes ?? null, maxAttempts: r.max_attempts, shuffleQuestions: !!r.shuffle_questions, shuffleOptions: !!r.shuffle_options,
  feedbackTiming: r.feedback_timing, countsToGrade: !!r.counts_to_grade, questionCount: Number(r.question_count || 0), totalPoints: num(r.total_points || 0), ruleCount: Number(r.rule_count || 0), readOnly: r.course_status === "archived" });
const parseSpec = (json) => { try { const v = JSON.parse(json); return isPlainObject(v) ? v : {}; } catch { return {}; } };
const parseAnswer = (json) => { if (json === null || json === undefined) return null; try { const v = JSON.parse(json); return isPlainObject(v) ? v : null; } catch { return null; } };
const attemptModel = (r) => ({ id: r.id, quizId: r.quiz_id, courseId: r.course_id, studentId: r.student_id, attemptNo: r.attempt_no, status: r.status, seed: r.seed, startedAt: new Date(r.started_at),
  deadlineAt: r.deadline_at ? new Date(r.deadline_at) : null, submittedAt: r.submitted_at ? new Date(r.submitted_at) : null, autoSubmitted: !!r.auto_submitted,
  autoPoints: r.auto_points === null || r.auto_points === undefined ? null : num(r.auto_points), totalPoints: r.total_points === null || r.total_points === undefined ? null : num(r.total_points),
  maxPoints: num(r.max_points || 0), needsMarking: !!r.needs_marking });

async function loadQuiz(pool, courseId, quizId, now) {
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, quizId).input("now", sql.DateTime2, now)
    .query(`SELECT TOP 1 ${QZ_COLS}, ${QZ_SUMMARY}, c.status AS course_status FROM lms_quizzes z ${JOIN_COURSE} WHERE z.id = @id AND z.course_id = @c AND ${VISIBLE}`);
  const row = r.recordset && r.recordset[0]; return row ? quizModel(row) : null;
}
/* The fixed set + THIS attempt's frozen random picks (never another attempt's). */
async function loadQuestions(pool, courseId, quizId, attemptId) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("att", sql.Int, attemptId)
    .query(`SELECT id, position, type, stem, explanation, points, spec_json FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position, id`);
  return (r.recordset || []).map((x) => ({ id: x.id, position: x.position, type: x.type, stem: x.stem, explanation: x.explanation || "", points: num(x.points), spec: parseSpec(x.spec_json) }));
}
async function loadAttempt(pool, courseId, quizId, sid, attemptId) {
  const r = await pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 ${ATT_COLS} FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s`);
  const row = r.recordset && r.recordset[0]; return row ? attemptModel(row) : null;
}
async function loadAnswers(pool, courseId, quizId, sid, attemptId) {
  const r = await pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT quiz_question_id, answer_json, status, points, max_points, comment FROM lms_quiz_answers WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s`);
  const map = new Map(); for (const x of r.recordset || []) map.set(x.quiz_question_id, { answer: parseAnswer(x.answer_json), status: x.status || null, points: x.points === null || x.points === undefined ? null : num(x.points), maxPoints: num(x.max_points || 0), comment: x.comment || null });
  return map;
}

/* Close an in-progress attempt: mark, claim, write. `override` = Map of final answers merged over the saved ones. */
async function finalize(pool, user, ctx, attempt, { override = null, auto = false, now, tenant }) {
  const sid = ctx.sid; const questions = await loadQuestions(pool, ctx.courseId, ctx.quiz.id, attempt.id); const saved = await loadAnswers(pool, ctx.courseId, ctx.quiz.id, sid, attempt.id);
  const answers = new Map(); for (const q of questions) answers.set(q.id, saved.get(q.id)?.answer ?? null);
  if (override) for (const [id, v] of override) if (answers.has(id)) answers.set(id, v);
  const m = markAttempt(questions, answers, attempt.seed, ctx.quiz.shuffleOptions);
  const status = m.needsMarking ? "submitted" : "graded"; const submittedAt = auto && attempt.deadlineAt && attempt.deadlineAt < now ? attempt.deadlineAt : now;
  const req = pool.request().input("a", sql.Int, attempt.id).input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, ctx.courseId).input("s", sql.Int, sid).input("now", sql.DateTime2, now)
    .input("st", sql.NVarChar(12), status).input("sub", sql.DateTime2, submittedAt).input("auto", sql.Bit, auto ? 1 : 0).input("ap", sql.Decimal(8, 2), m.autoPoints)
    .input("tp", sql.Decimal(8, 2), m.needsMarking ? null : m.autoPoints).input("mp", sql.Decimal(8, 2), m.maxPoints).input("nm", sql.Bit, m.needsMarking ? 1 : 0);
  const writes = m.rows.map((row, i) => {
    req.input(`q${i}`, sql.Int, row.quizQuestionId).input(`j${i}`, sql.NVarChar(sql.MAX), row.answer ? JSON.stringify(row.answer) : null).input(`t${i}`, sql.NVarChar(12), row.status)
      .input(`p${i}`, sql.Decimal(6, 2), row.points).input(`x${i}`, sql.Decimal(6, 2), row.maxPoints);
    return `UPDATE lms_quiz_answers SET answer_json = @j${i}, status = @t${i}, points = @p${i}, max_points = @x${i}, updated_at = @now WHERE attempt_id = @a AND quiz_question_id = @q${i};
      IF @@ROWCOUNT = 0 INSERT INTO lms_quiz_answers (attempt_id, quiz_id, course_id, student_id, quiz_question_id, answer_json, status, points, max_points, created_at, updated_at) VALUES (@a, @z, @c, @s, @q${i}, @j${i}, @t${i}, @p${i}, @x${i}, @now, @now);`;
  });
  const run = () => req.query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @claimed INT = 0;
    UPDATE lms_quiz_attempts SET status = @st, submitted_at = @sub, auto_submitted = @auto, auto_points = @ap, total_points = @tp, max_points = @mp, needs_marking = @nm, updated_at = @now
      WHERE id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress';
    IF @@ROWCOUNT = 1 BEGIN SET @claimed = 1; ${writes.join("\n")} END
    COMMIT; SELECT @claimed AS claimed;`);
  const r = await retryDup(run);
  const claimed = Number(r.recordset?.[0]?.claimed) === 1;
  if (claimed) {
    await audit(pool, actorOf(user), "quiz.attempt_submitted", "lms_quiz_attempts", attempt.id, { courseId: ctx.courseId, quizId: ctx.quiz.id, auto, needsMarking: m.needsMarking });
    if (tenant) {
      events.emit("lms.quiz.attempted", { tenant, courseId: ctx.courseId, quizId: ctx.quiz.id, attemptId: attempt.id, studentId: sid, autoSubmitted: auto });
      if (!m.needsMarking) events.emit("lms.quiz.graded", { tenant, courseId: ctx.courseId, quizId: ctx.quiz.id, attemptId: attempt.id, studentId: sid });
    }
  }
  return { claimed };
}

/* Common start of every attempt operation. */
async function context(pool, user, courseId, quizId, now) {
  const sid = studentIdOf(user); const qid = posInt(quizId); if (!sid || qid === null) return notFound();
  const quiz = await loadQuiz(pool, courseId, qid, now); if (!quiz) return notFound();
  return { ok: true, sid, courseId, quiz };
}

const scoreOf = (a) => ({ points: a.needsMarking ? a.autoPoints : a.totalPoints, max: a.maxPoints, pending: a.needsMarking });
function attemptSummary(a, quiz, now) {
  const base = { id: a.id, attemptNo: a.attemptNo, status: a.status, startedAt: iso(a.startedAt), submittedAt: iso(a.submittedAt), autoSubmitted: a.autoSubmitted };
  if (a.status === "in_progress") return { ...base, deadlineAt: iso(a.deadlineAt) };
  const f = feedbackOf(quiz, now); return f.scoreVisible ? { ...base, score: scoreOf(a) } : { ...base, score: null };
}

/* ------------------------------- list / detail ------------------------------- */
async function summariseAttempts(pool, courseId, sid, quizIds) {
  const map = new Map(); if (!quizIds.length) return map;
  const req = pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sid); quizIds.forEach((id, i) => req.input(`z${i}`, sql.Int, id));
  const r = await req.query(`SELECT quiz_id, status, COUNT(*) AS n FROM lms_quiz_attempts WHERE course_id = @c AND student_id = @s AND quiz_id IN (${quizIds.map((_, i) => `@z${i}`).join(", ")}) GROUP BY quiz_id, status`);
  for (const x of r.recordset || []) { const cur = map.get(x.quiz_id) || { used: 0, open: false }; cur.used += Number(x.n); if (x.status === "in_progress") cur.open = true; map.set(x.quiz_id, cur); }
  return map;
}
function listItem(q, sum, now) {
  const a = availability(q, { readOnly: q.readOnly, now }); const used = sum?.used || 0, open = !!sum?.open;
  const left = Math.max(0, q.maxAttempts - used);
  const reason = open ? null : q.mode === "flashcards" ? { code: "FLASHCARDS", message: "This is a flashcard deck. Open the cards to study it." } : !a.open ? a : left <= 0 ? { code: "ATTEMPTS_USED", message: "You have used all your attempts." } : null;
  return { id: q.id, title: q.title, instructions: q.instructions, assessmentType: q.assessmentType, mode: q.mode, availableFrom: iso(q.availableFrom), dueAt: iso(q.dueAt), timeLimitMinutes: q.timeLimitMinutes, maxAttempts: q.maxAttempts,
    feedbackTiming: q.feedbackTiming, countsToGrade: q.countsToGrade, questionCount: q.questionCount, totalPoints: q.totalPoints, attemptsUsed: used, attemptsLeft: left, hasOpenAttempt: open,
    status: open ? "in_progress" : used > 0 ? "attempted" : "not_started", canStart: open || !reason, closedReason: reason ? { code: reason.code, message: reason.message } : null };
}

async function listForStudent(pool, user, courseId, query = {}, { now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const size = Math.min(100, Math.max(1, Number.parseInt(query.pageSize, 10) || 20)), pg = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const mode = ["quiz", "revision", "mock", "flashcards"].includes(query.mode) ? query.mode : null; // "quiz" also matches older rows with no mode
  const r = await pool.request().input("c", sql.Int, courseId).input("now", sql.DateTime2, now).input("md", sql.NVarChar(12), mode).input("off", sql.Int, (pg - 1) * size).input("n", sql.Int, size)
    .query(`SELECT ${QZ_COLS}, ${QZ_SUMMARY}, c.status AS course_status, COUNT(*) OVER() AS total_count FROM lms_quizzes z ${JOIN_COURSE} WHERE z.course_id = @c AND ${VISIBLE} AND (@md IS NULL OR ISNULL(z.quiz_mode, 'quiz') = @md)
      ORDER BY CASE WHEN z.due_at IS NULL THEN 1 ELSE 0 END, z.due_at, z.id OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || []; const models = rows.map(quizModel); const sums = await summariseAttempts(pool, courseId, sid, models.map((m) => m.id));
  return { ok: true, items: models.map((m) => listItem(m, sums.get(m.id), now)), total: rows.length ? Number(rows[0].total_count) : 0, page: pg, pageSize: size };
}

async function getForStudent(pool, user, courseId, quizId, { now = new Date() } = {}) {
  const ctx = await context(pool, user, courseId, quizId, now); if (!ctx.ok) return ctx;
  const sums = await summariseAttempts(pool, courseId, ctx.sid, [ctx.quiz.id]);
  const r = await pool.request().input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, courseId).input("s", sql.Int, ctx.sid)
    .query(`SELECT TOP 20 ${ATT_COLS} FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s ORDER BY attempt_no DESC`);
  const attempts = (r.recordset || []).map(attemptModel).map((a) => attemptSummary(a, ctx.quiz, now));
  return { ok: true, quiz: { ...listItem(ctx.quiz, sums.get(ctx.quiz.id), now), attempts } };
}

/* ------------------------------- attempt views ------------------------------- */
function takeView(quiz, attempt, questions, answers, now) {
  const ordered = orderOf(questions, quiz.shuffleQuestions, attempt.seed);
  return { id: attempt.id, quizId: quiz.id, attemptNo: attempt.attemptNo, status: "in_progress", startedAt: iso(attempt.startedAt), deadlineAt: iso(attempt.deadlineAt),
    secondsLeft: attempt.deadlineAt ? Math.max(0, Math.round((attempt.deadlineAt.getTime() - now.getTime()) / 1000)) : null, serverNow: now.toISOString(), title: quiz.title, instructions: quiz.instructions,
    questions: ordered.map((q, i) => ({ id: q.id, number: i + 1, ...renderQuestion(q, attempt.seed, quiz.shuffleOptions).view, answer: answers.get(q.id)?.answer ?? null })) };
}

function resultView(quiz, attempt, questions, answers, now) {
  const f = feedbackOf(quiz, now);
  const base = { id: attempt.id, quizId: quiz.id, attemptNo: attempt.attemptNo, status: attempt.status, startedAt: iso(attempt.startedAt), submittedAt: iso(attempt.submittedAt), autoSubmitted: attempt.autoSubmitted, title: quiz.title };
  if (!f.visible) return { ...base, feedback: { visible: false, reason: f.reason, message: f.message }, score: f.scoreVisible ? scoreOf(attempt) : null, questions: [] };
  const ordered = orderOf(questions, quiz.shuffleQuestions, attempt.seed);
  return { ...base, feedback: { visible: true }, score: scoreOf(attempt), questions: ordered.map((q, i) => {
    const a = answers.get(q.id); const { refMap } = renderQuestion(q, attempt.seed, quiz.shuffleOptions);
    return { id: q.id, number: i + 1, type: q.type, stem: q.stem, maxPoints: q.points, status: a?.status || "unanswered", points: a?.points ?? null, comment: a?.comment ?? null, explanation: q.explanation,
      yourAnswer: a?.answer ? M.translateAnswer(q, refMap, a.answer) : null, key: revealQuestion(q) };
  }) };
}

/* Close an attempt whose time is up (lazy). Returns the reloaded attempt. */
async function closeIfExpired(pool, user, ctx, attempt, now, tenant) {
  if (attempt.status !== "in_progress" || !pastGrace(attempt.deadlineAt, now)) return { attempt, closed: false };
  await finalize(pool, user, ctx, attempt, { auto: true, now, tenant });
  const re = await loadAttempt(pool, ctx.courseId, ctx.quiz.id, ctx.sid, attempt.id);
  return { attempt: re || attempt, closed: true };
}

async function startAttempt(pool, user, courseId, quizId, { now = new Date(), tenant } = {}) {
  const ctx = await context(pool, user, courseId, quizId, now); if (!ctx.ok) return ctx;
  if (ctx.quiz.mode === "flashcards") return { ok: false, code: "USE_CARDS", errors: ["This is a flashcard deck. Open the cards to study it; there is no attempt to start."] };
  const open = async () => { const r = await pool.request().input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, courseId).input("s", sql.Int, ctx.sid).query(`SELECT TOP 1 ${ATT_COLS} FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress'`); return r.recordset && r.recordset[0] ? attemptModel(r.recordset[0]) : null; };
  let cur = await open();
  if (cur) { const e = await closeIfExpired(pool, user, ctx, cur, now, tenant); if (!e.closed) return resumed(pool, ctx, cur, now); cur = null; }
  const a = availability(ctx.quiz, { readOnly: ctx.quiz.readOnly, now }); if (!a.open) return { ok: false, code: a.code, errors: [a.message] };
  const seed = crypto.randomBytes(8).toString("hex"); const deadline = deadlineOf(ctx.quiz, now);
  let plan = null; // random questions are decided BEFORE the attempt is created, so a too-small pool never uses up an attempt
  if (ctx.quiz.ruleCount > 0) { plan = await rules.planPicks(pool, courseId, ctx.quiz.id, seed); if (!plan.ok) return plan; }
  let row;
  try {
    const r = await pool.request().input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, courseId).input("s", sql.Int, ctx.sid).input("seed", sql.NVarChar(32), seed).input("now", sql.DateTime2, now)
      .input("dl", sql.DateTime2, deadline).input("mp", sql.Decimal(8, 2), ctx.quiz.totalPoints).input("max", sql.Int, ctx.quiz.maxAttempts)
      .query(`INSERT INTO lms_quiz_attempts (quiz_id, course_id, student_id, attempt_no, status, seed, started_at, deadline_at, max_points, created_at, updated_at)
        OUTPUT ${ATT_COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
        SELECT @z, @c, @s, x.n + 1, 'in_progress', @seed, @now, @dl, @mp, @now, @now
        FROM (SELECT COUNT(*) AS n FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s) x WHERE x.n < @max`);
    row = r.recordset && r.recordset[0];
  } catch (e) { if (!isDup(e)) throw e; const again = await open(); if (again) return resumed(pool, ctx, again, now); throw e; } // a parallel click started it first: resume that one
  if (!row) return { ok: false, code: "ATTEMPTS_USED", errors: ["You have used all your attempts."] };
  return resumed(pool, ctx, attemptModel(row), now, true, plan);
}
async function resumed(pool, ctx, attempt, now, created = false, plan = null) {
  const frozen = await rules.ensurePicks(pool, ctx, attempt, plan); if (!frozen.ok) return frozen; // repairs a start that stopped before the picks were written
  const questions = await loadQuestions(pool, ctx.courseId, ctx.quiz.id, attempt.id); const answers = await loadAnswers(pool, ctx.courseId, ctx.quiz.id, ctx.sid, attempt.id);
  return { ok: true, created, attempt: takeView(ctx.quiz, attempt, questions, answers, now) };
}

async function getAttempt(pool, user, courseId, quizId, attemptId, { now = new Date(), tenant } = {}) {
  const ctx = await context(pool, user, courseId, quizId, now); if (!ctx.ok) return ctx;
  const aid = posInt(attemptId); if (aid === null) return notFound("Attempt");
  let attempt = await loadAttempt(pool, courseId, ctx.quiz.id, ctx.sid, aid); if (!attempt) return notFound("Attempt");
  attempt = (await closeIfExpired(pool, user, ctx, attempt, now, tenant)).attempt;
  const questions = await loadQuestions(pool, courseId, ctx.quiz.id, attempt.id); const answers = await loadAnswers(pool, courseId, ctx.quiz.id, ctx.sid, attempt.id);
  if (attempt.status === "in_progress") return { ok: true, attempt: takeView(ctx.quiz, attempt, questions, answers, now) };
  return { ok: true, attempt: resultView(ctx.quiz, attempt, questions, answers, now) };
}

async function saveAnswers(pool, user, courseId, quizId, attemptId, body, { now = new Date(), tenant } = {}) {
  const ctx = await context(pool, user, courseId, quizId, now); if (!ctx.ok) return ctx;
  const aid = posInt(attemptId); if (aid === null) return notFound("Attempt");
  const attempt = await loadAttempt(pool, courseId, ctx.quiz.id, ctx.sid, aid); if (!attempt) return notFound("Attempt");
  if (ctx.quiz.readOnly) return { ok: false, code: "COURSE_READ_ONLY", errors: ["This course is archived, so quizzes can no longer be taken."] };
  if (attempt.status !== "in_progress") return { ok: false, code: "ATTEMPT_CLOSED", errors: ["This attempt has already been submitted."] };
  if (pastGrace(attempt.deadlineAt, now)) { await closeIfExpired(pool, user, ctx, attempt, now, tenant); return { ok: false, code: "TIME_UP", errors: ["Time is up. Your saved answers were submitted."] }; }
  const questions = await loadQuestions(pool, courseId, ctx.quiz.id, attempt.id); const v = validateAnswersBody(body, new Map(questions.map((q) => [q.id, q]))); if (!v.ok) return v;
  if (!v.answers.size) return { ok: true, saved: 0, serverNow: now.toISOString() };
  const req = pool.request().input("a", sql.Int, attempt.id).input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, courseId).input("s", sql.Int, ctx.sid).input("now", sql.DateTime2, now);
  const writes = [...v.answers].map(([id, val], i) => {
    req.input(`q${i}`, sql.Int, id).input(`j${i}`, sql.NVarChar(sql.MAX), val ? JSON.stringify(val) : null);
    return `UPDATE lms_quiz_answers SET answer_json = @j${i}, updated_at = @now WHERE attempt_id = @a AND quiz_question_id = @q${i};
      IF @@ROWCOUNT = 0 INSERT INTO lms_quiz_answers (attempt_id, quiz_id, course_id, student_id, quiz_question_id, answer_json, max_points, created_at, updated_at) VALUES (@a, @z, @c, @s, @q${i}, @j${i}, 0, @now, @now);`;
  });
  const run = () => req.query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @ok INT = 0;
    IF EXISTS (SELECT 1 FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress') BEGIN SET @ok = 1; ${writes.join("\n")} END
    COMMIT; SELECT @ok AS ok;`);
  const r = await retryDup(run);
  if (Number(r.recordset?.[0]?.ok) !== 1) return { ok: false, code: "ATTEMPT_CLOSED", errors: ["This attempt has already been submitted."] };
  return { ok: true, saved: v.answers.size, serverNow: now.toISOString() };
}

async function submitAttempt(pool, user, courseId, quizId, attemptId, body, { now = new Date(), tenant } = {}) {
  const ctx = await context(pool, user, courseId, quizId, now); if (!ctx.ok) return ctx;
  const aid = posInt(attemptId); if (aid === null) return notFound("Attempt");
  const attempt = await loadAttempt(pool, courseId, ctx.quiz.id, ctx.sid, aid); if (!attempt) return notFound("Attempt");
  if (ctx.quiz.readOnly) return { ok: false, code: "COURSE_READ_ONLY", errors: ["This course is archived, so quizzes can no longer be taken."] };
  const done = async (extra = {}) => { const re = (await loadAttempt(pool, courseId, ctx.quiz.id, ctx.sid, attempt.id)) || attempt; const questions = await loadQuestions(pool, courseId, ctx.quiz.id, attempt.id); const answers = await loadAnswers(pool, courseId, ctx.quiz.id, ctx.sid, attempt.id); return { ok: true, ...extra, attempt: resultView(ctx.quiz, re, questions, answers, now) }; };
  if (attempt.status !== "in_progress") return done({ alreadySubmitted: true });
  if (pastGrace(attempt.deadlineAt, now)) { await finalize(pool, user, ctx, attempt, { auto: true, now, tenant }); return done({ autoSubmitted: true }); } // late answers in the body are ignored
  let override = null;
  if (body !== undefined && body !== null && !(isPlainObject(body) && Object.keys(body).length === 0)) {
    const questions = await loadQuestions(pool, courseId, ctx.quiz.id, attempt.id); const v = validateAnswersBody(body, new Map(questions.map((q) => [q.id, q]))); if (!v.ok) return v; override = v.answers;
  }
  const f = await finalize(pool, user, ctx, attempt, { override, auto: false, now, tenant });
  return done(f.claimed ? {} : { alreadySubmitted: true });
}

/* Staff marking queue (L6.2b-2, A88): close up to 50 in-progress attempts of ONE quiz whose time is up (deadline + grace has passed) using the answers the learner
   had saved, exactly like the learner's own lazy close. Never touches an attempt still inside its time. Returns how many were closed. */
async function sweepExpired(pool, user, courseId, quizId, { now = new Date(), tenant } = {}) {
  const qid = posInt(quizId); const cid = posInt(courseId); if (!qid || !cid) return { closed: 0 };
  const quiz = await loadQuiz(pool, cid, qid, now); if (!quiz) return { closed: 0 };
  const cut = new Date(now.getTime() - GRACE_SECONDS * 1000);
  const r = await pool.request().input("z", sql.Int, qid).input("c", sql.Int, cid).input("cut", sql.DateTime2, cut)
    .query(`SELECT TOP 50 ${ATT_COLS} FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND status = 'in_progress' AND deadline_at IS NOT NULL AND deadline_at < @cut ORDER BY id`);
  let closed = 0;
  for (const row of r.recordset || []) {
    const attempt = attemptModel(row);
    const f = await finalize(pool, user, { sid: attempt.studentId, courseId: cid, quiz }, attempt, { auto: true, now, tenant });
    if (f.claimed) closed += 1;
  }
  return { closed };
}

module.exports = { loadQuiz, loadAttempt, loadQuestions, sweepExpired, GRACE_SECONDS, MAX_ANSWERS_PER_CALL, availability, deadlineOf, pastGrace, cleanAnswer, validateAnswersBody, orderOf, renderQuestion, revealQuestion, markAttempt, feedbackOf,
  listForStudent, getForStudent, startAttempt, getAttempt, saveAnswers, submitAttempt };
