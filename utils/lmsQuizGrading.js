/* =========================================================================
   LMS QUIZ GRADING  (L6.2b-2, D-078)  staff marking of the WRITTEN answers (essays) of submitted quiz attempts.

   Rules (documented, simple):
   - Staff only: the routes require `lms.submission.grade` + course membership (owner / co-teacher / LMS admin), same as assignment marking. Every query
     matches quiz_id AND course_id, so another course's or another school's attempt id is simply "not found".
   - The queue lists SUBMITTED + GRADED attempts of one quiz (never in-progress ones). Before listing, attempts whose time is up are closed with their saved
     answers (A88, `sweepExpired` in lmsQuizAttempts.js), so a learner who just walked away does not leave an invisible attempt.
   - Only `manual` answers (essays with text) can be marked. Points are 0..the question's max points, at most 2 decimals; a comment is optional (<= 2000 chars).
   - When the LAST manual answer of an attempt is marked, ONE guarded UPDATE finishes the attempt: manual_points = sum of the teacher's marks,
     total_points = auto_points + manual_points, status `graded`, needs_marking 0. The `lms.quiz.graded` event is emitted only by the call that did it.
     Two teachers marking the last two answers at once: SQL Server serialises the row locks, only one of them wins the guarded UPDATE.
   - A graded attempt cannot be re-marked (same default as assignment grades, Q34). A mark on an in-progress attempt is refused.
   - Answers are shown to staff in POSITIONS (via translateAnswer), with the key, like the learner's own result. Student text is never executed or trusted:
     it is only returned as JSON data.
   Every query is parameterised. Authorisation lives in the routes.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const M = require("./lmsQuizMarking");
const A = require("./lmsQuizAttempts");
const events = require("./lmsEvents");

const MAX_COMMENT = 2000;
const FILTERS = ["all", "needs_marking", "graded"];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const notFound = (what = "Attempt") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });
const cleanComment = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim();
const parseJson = (j) => { if (j === null || j === undefined) return null; try { const v = JSON.parse(j); return isPlainObject(v) ? v : null; } catch { return null; } };
const parseSpec = (j) => parseJson(j) || {};

/* Pure. Validate a mark body { points, comment? } against the question's max points. */
function validateMark(body, maxPoints) {
  const errors = [];
  if (!isPlainObject(body)) return { ok: false, errors: ["Send { points, comment? }."] };
  const raw = body.points; const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) errors.push("points must be a number.");
  else if (n < 0 || n > maxPoints) errors.push(`points must be between 0 and ${maxPoints}.`);
  else if (Math.round(n * 100) / 100 !== n) errors.push("points can have at most 2 decimal places.");
  let comment = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== "string") errors.push("comment must be text.");
    else { comment = cleanComment(body.comment); if (comment.length > MAX_COMMENT) errors.push(`comment must be at most ${MAX_COMMENT} characters.`); if (comment === "") comment = null; }
  }
  return errors.length ? { ok: false, errors } : { ok: true, points: n, comment };
}

/* ------------------------------- loading ------------------------------- */
async function loadQuiz(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId)
    .query(`SELECT TOP 1 id, title, shuffle_options, max_attempts FROM lms_quizzes WHERE id = @z AND course_id = @c AND deleted_at IS NULL`);
  const x = r.recordset && r.recordset[0]; return x ? { id: x.id, title: x.title, shuffleOptions: !!x.shuffle_options } : null;
}
async function loadAttemptRow(pool, courseId, quizId, attemptId) {
  const r = await pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId)
    .query(`SELECT TOP 1 id, student_id, attempt_no, status, seed, submitted_at, auto_submitted, auto_points, manual_points, total_points, max_points, needs_marking FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c`);
  return (r.recordset && r.recordset[0]) || null;
}
/* The fixed set + the random questions frozen for THIS attempt (L6.2c). */
async function loadQuestions(pool, courseId, quizId, attemptId) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("att", sql.Int, attemptId)
    .query(`SELECT id, position, type, stem, explanation, points, spec_json FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position, id`);
  return (r.recordset || []).map((x) => ({ id: x.id, position: x.position, type: x.type, stem: x.stem, explanation: x.explanation || "", points: num(x.points), spec: parseSpec(x.spec_json) }));
}
async function loadAnswers(pool, courseId, quizId, attemptId) {
  const r = await pool.request().input("a", sql.Int, attemptId).input("z", sql.Int, quizId).input("c", sql.Int, courseId)
    .query(`SELECT quiz_question_id, answer_json, status, points, max_points, comment, marked_by_source, marked_by, marked_at FROM lms_quiz_answers WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c`);
  const map = new Map();
  for (const x of r.recordset || []) map.set(x.quiz_question_id, { answer: parseJson(x.answer_json), status: x.status || null, points: num(x.points), maxPoints: num(x.max_points) || 0, comment: x.comment || null, markedAt: iso(x.marked_at) });
  return map;
}

/* ------------------------------- queue ------------------------------- */
const FILTER_SQL = { all: "a.status IN ('submitted','graded')", needs_marking: "a.status = 'submitted' AND a.needs_marking = 1", graded: "a.status = 'graded'" };

async function listAttempts(pool, user, courseId, quizId, { filter = "all", page, pageSize, tenant, now = new Date() } = {}) {
  const cid = posInt(courseId), qid = posInt(quizId); if (!cid || !qid) return notFound("Quiz");
  if (!FILTERS.includes(filter)) return { ok: false, errors: [`filter must be one of ${FILTERS.join(", ")}.`] };
  const quiz = await loadQuiz(pool, cid, qid); if (!quiz) return notFound("Quiz");
  const swept = await A.sweepExpired(pool, user, cid, qid, { now, tenant });
  const { size, pg } = paging({ page, pageSize });
  const where = `a.quiz_id = @z AND a.course_id = @c AND ${FILTER_SQL[filter]}`;
  const req = () => pool.request().input("z", sql.Int, qid).input("c", sql.Int, cid);
  const total = await req().query(`SELECT COUNT(*) AS n FROM lms_quiz_attempts a WHERE ${where}`);
  const r = await req().input("off", sql.Int, (pg - 1) * size).input("size", sql.Int, size)
    .query(`SELECT a.id, a.student_id, a.attempt_no, a.status, a.submitted_at, a.auto_submitted, a.auto_points, a.manual_points, a.total_points, a.max_points, a.needs_marking, s.name AS student_name, s.admissionNo AS admission_no
      FROM lms_quiz_attempts a LEFT JOIN Students s ON s.id = a.student_id WHERE ${where} ORDER BY a.needs_marking DESC, a.submitted_at, a.id OFFSET @off ROWS FETCH NEXT @size ROWS ONLY`);
  return { ok: true, quiz: { id: quiz.id, title: quiz.title }, closedExpired: swept.closed, total: Number(total.recordset?.[0]?.n || 0), page: pg, pageSize: size,
    items: (r.recordset || []).map((x) => ({ id: x.id, studentId: x.student_id, studentName: x.student_name || "", admissionNo: x.admission_no || "", attemptNo: x.attempt_no, status: x.status,
      submittedAt: iso(x.submitted_at), autoSubmitted: !!x.auto_submitted, autoPoints: num(x.auto_points), manualPoints: num(x.manual_points), totalPoints: num(x.total_points), maxPoints: num(x.max_points) || 0, needsMarking: !!x.needs_marking })) };
}

/* ------------------------------- one attempt ------------------------------- */
function answerViews(quiz, attempt, questions, answers) {
  /* Staff see the questions in the teacher's order (position); each learner's answer is translated with THAT learner's shuffle seed. */
  return questions.map((q, i) => {
    const a = answers.get(q.id); const { refMap } = A.renderQuestion(q, attempt.seed, quiz.shuffleOptions);
    return { quizQuestionId: q.id, number: i + 1, type: q.type, stem: q.stem, maxPoints: q.points, status: a?.status || "unanswered", points: a?.points ?? null, comment: a?.comment ?? null, markedAt: a?.markedAt ?? null,
      needsMarking: a?.status === "manual", yourAnswer: a?.answer ? M.translateAnswer(q, refMap, a.answer) : null, key: A.revealQuestion(q), explanation: q.explanation };
  });
}

async function getAttempt(pool, courseId, quizId, attemptId, { tenant } = {}) {
  void tenant;
  const cid = posInt(courseId), qid = posInt(quizId), aid = posInt(attemptId); if (!cid || !qid || !aid) return notFound();
  const quiz = await loadQuiz(pool, cid, qid); if (!quiz) return notFound("Quiz");
  const row = await loadAttemptRow(pool, cid, qid, aid); if (!row || row.status === "in_progress") return notFound();
  const st = await pool.request().input("s", sql.Int, row.student_id).query(`SELECT TOP 1 name, admissionNo FROM Students WHERE id = @s`);
  const who = (st.recordset && st.recordset[0]) || {};
  const attempt = { seed: row.seed };
  const questions = await loadQuestions(pool, cid, qid, aid); const answers = await loadAnswers(pool, cid, qid, aid);
  return { ok: true, attempt: { id: row.id, quizId: qid, quizTitle: quiz.title, studentId: row.student_id, studentName: who.name || "", admissionNo: who.admissionNo || "", attemptNo: row.attempt_no, status: row.status,
    submittedAt: iso(row.submitted_at), autoSubmitted: !!row.auto_submitted, autoPoints: num(row.auto_points), manualPoints: num(row.manual_points), totalPoints: num(row.total_points), maxPoints: num(row.max_points) || 0,
    needsMarking: !!row.needs_marking, answers: answerViews(quiz, attempt, questions, answers) } };
}

/* ------------------------------- mark one written answer ------------------------------- */
async function markAnswer(pool, user, courseId, quizId, attemptId, quizQuestionId, body, { tenant, now = new Date() } = {}) {
  const cid = posInt(courseId), qid = posInt(quizId), aid = posInt(attemptId), kid = posInt(quizQuestionId); if (!cid || !qid || !aid || !kid) return notFound();
  const quiz = await loadQuiz(pool, cid, qid); if (!quiz) return notFound("Quiz");
  const row = await loadAttemptRow(pool, cid, qid, aid); if (!row) return notFound();
  if (row.status === "in_progress") return { ok: false, code: "ATTEMPT_NOT_SUBMITTED", errors: ["This attempt has not been submitted yet."] };
  const questions = await loadQuestions(pool, cid, qid, aid); const q = questions.find((x) => x.id === kid); if (!q) return notFound("Question");
  const answers = await loadAnswers(pool, cid, qid, aid); const a = answers.get(kid);
  if (row.status === "graded") return { ok: false, code: "ATTEMPT_GRADED", errors: ["This attempt is already graded and cannot be changed."] };
  if (!a || a.status !== "manual") return { ok: false, code: "NOT_MANUAL", errors: ["Only written answers waiting for a teacher can be marked."] };
  const v = validateMark(body, q.points); if (!v.ok) return v;
  const actor = actorOf(user);
  const r = await pool.request().input("a", sql.Int, aid).input("z", sql.Int, qid).input("c", sql.Int, cid).input("q", sql.Int, kid).input("p", sql.Decimal(6, 2), v.points)
    .input("cm", sql.NVarChar(2000), v.comment).input("src", sql.NVarChar(20), actor?.source || null).input("by", sql.Int, Number.isInteger(actor?.id) ? actor.id : null).input("now", sql.DateTime2, now)
    .query(`SET XACT_ABORT ON; BEGIN TRAN; DECLARE @marked INT = 0, @graded INT = 0;
      UPDATE lms_quiz_answers SET points = @p, status = 'marked', comment = @cm, marked_by_source = @src, marked_by = @by, marked_at = @now, updated_at = @now
        WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c AND quiz_question_id = @q AND status = 'manual'
          AND EXISTS (SELECT 1 FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c AND status = 'submitted');
      SET @marked = @@ROWCOUNT;
      IF @marked = 1 BEGIN
        UPDATE lms_quiz_attempts SET manual_points = (SELECT ISNULL(SUM(points), 0) FROM lms_quiz_answers WHERE attempt_id = @a AND marked_by_source IS NOT NULL),
            total_points = ISNULL(auto_points, 0) + (SELECT ISNULL(SUM(points), 0) FROM lms_quiz_answers WHERE attempt_id = @a AND marked_by_source IS NOT NULL),
            status = 'graded', needs_marking = 0, updated_at = @now
          WHERE id = @a AND quiz_id = @z AND course_id = @c AND status = 'submitted' AND NOT EXISTS (SELECT 1 FROM lms_quiz_answers WHERE attempt_id = @a AND status = 'manual');
        SET @graded = @@ROWCOUNT;
      END
      COMMIT; SELECT @marked AS marked, @graded AS graded;`);
  const out = r.recordset && r.recordset[0]; const marked = Number(out?.marked) === 1, graded = Number(out?.graded) === 1;
  if (!marked) return { ok: false, code: "CHANGED", errors: ["This answer was changed by someone else. Reload and try again."] };
  await audit(pool, actor, "quiz.answer_marked", "lms_quiz_answers", kid, { courseId: cid, quizId: qid, attemptId: aid, points: v.points, graded });
  if (graded && tenant) events.emit("lms.quiz.graded", { tenant, courseId: cid, quizId: qid, attemptId: aid, studentId: row.student_id, manual: true });
  const re = await getAttempt(pool, cid, qid, aid);
  return { ok: true, graded, attempt: re.ok ? re.attempt : null };
}

module.exports = { MAX_COMMENT, FILTERS, validateMark, listAttempts, getAttempt, markAnswer };
