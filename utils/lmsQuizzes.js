/* =========================================================================
   LMS QUIZZES  (L6.2a, D-076)  the quiz DEFINITION: settings + the questions in it. Attempts, marking and student delivery are L6.2b+.

   Rules (documented, simple):
   - A quiz belongs to one course. Course staff (owner / co-teacher / LMS admin) with `lms.course.manage` create, edit, publish and delete.
     Archived or pending courses are read-only (same rule as lessons and assignments).
   - assessmentType: `practice` | `coursework`. `controlled_exam` is refused (409 CONTROLLED_EXAM_NOT_IN_LMS): controlled exams are not run in the LMS.
     A practice quiz can never count towards a grade (countsToGrade must be false); coursework may (the gradebook in L7 reads this flag).
   - status draft | published. Publishing needs at least one question (409 NO_QUESTIONS). Questions can only be added, removed or reordered while the
     quiz is a DRAFT (409 QUIZ_PUBLISHED). A quiz that has ANY attempt cannot go back to draft or be deleted (409 HAS_ATTEMPTS, L6.2b-1): learners' marked work must stay readable.
   - Questions are SNAPSHOTS: adding a bank question copies its content (stem, points, spec, version) into lms_quiz_questions. A later edit or delete
     of the bank question never changes the quiz. The same bank question cannot be added twice to one quiz (409 DUPLICATE_QUESTION). You can only add
     questions you can see in the bank (a hidden one is "not found").
   - Settings: timeLimitMinutes 1-600 or null (no limit), maxAttempts 1-20, shuffleQuestions / shuffleOptions booleans, feedbackTiming
     immediate | after_close | never (after_close needs a dueAt), availableFrom / dueAt ISO 8601 WITH time zone (availableFrom <= dueAt).
   - Instructions are PLAIN TEXT (<= 4000). Limits: 200 live quizzes per course, 100 questions per quiz, 50 questions added per call.
   - Delete = soft delete. Publishing emits `lms.quiz.published` ({tenant, courseId, quizId}); nobody subscribes yet.
   - Random selection (L6.2c, D-080, utils/lmsQuizRules.js): a quiz may also have rules "pick N matching questions". They count in questionCount/totalPoints
     (fixed + sum(count * pointsEach)), keep a quiz publishable on their own, and publishing checks every rule's pool (409 RULE_POOL_TOO_SMALL).
     lms_quiz_questions rows with attempt_id NOT NULL belong to ONE attempt (frozen picks); every quiz-definition query here reads only attempt_id IS NULL.
   Authorisation lives in the routes; every query is parameterised and every query also matches course_id.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const { isoDate } = require("./lmsAssignments");
const qbank = require("./lmsQuestionBank");
const events = require("./lmsEvents");
const rules = require("./lmsQuizRules");

const MAX_PER_COURSE = 200, MAX_QUESTIONS = 100, MAX_ADD = 50;
const TYPES = ["practice", "coursework"], MODES = ["quiz", "revision", "mock", "flashcards"], STATUSES = ["draft", "published"], FEEDBACK = ["immediate", "after_close", "never"];
const KEYS = ["title", "instructions", "sectionId", "assessmentType", "mode", "status", "availableFrom", "dueAt", "timeLimitMinutes", "maxAttempts", "shuffleQuestions", "shuffleOptions", "feedbackTiming", "countsToGrade"];
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
const intIn = (v, lo, hi) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });
const iso = (d) => (d ? new Date(d).toISOString() : null);
const num = (v) => Math.round(Number(v) * 100) / 100;

/* Pure. Field checks + cross-field checks on the merged result (`merged` = defaults + stored + changes). */
function validate(body, { partial = false, now = new Date() } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!KEYS.includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "title" in body) { const t = oneLine(body.title); if (t.length < 1 || t.length > 200) errors.push("title is required: 1-200 characters."); else value.title = t; }
  if ("instructions" in body) { if (body.instructions === null) value.instructions = ""; else { const t = multiLine(body.instructions); if (t.length > 4000) errors.push("instructions: at most 4000 characters of plain text."); else value.instructions = t; } }
  if ("sectionId" in body) { if (body.sectionId === null) value.sectionId = null; else { const n = posInt(body.sectionId); if (n === null) errors.push("sectionId must be a section id or null."); else value.sectionId = n; } }
  if ("assessmentType" in body) {
    if (body.assessmentType === "controlled_exam") return { ok: false, code: "CONTROLLED_EXAM_NOT_IN_LMS", errors: ["Controlled examinations are not run in the LMS. Use practice or coursework."] };
    if (!TYPES.includes(body.assessmentType)) errors.push(`assessmentType must be one of ${TYPES.join(", ")}.`); else value.assessmentType = body.assessmentType;
  }
  if ("mode" in body) { if (!MODES.includes(body.mode)) errors.push(`mode must be one of ${MODES.join(", ")}.`); else value.mode = body.mode; }
  if ("status" in body) { if (!STATUSES.includes(body.status)) errors.push('status must be "draft" or "published".'); else value.status = body.status; }
  for (const k of ["availableFrom", "dueAt"]) if (k in body) {
    if (body[k] === null) value[k] = null; else { const d = isoDate(body[k], now); if (!d) errors.push(`${k} must be a date and time in ISO 8601 with a time zone (for example 2026-11-02T17:00:00+03:00), or null.`); else value[k] = d; }
  }
  if ("timeLimitMinutes" in body) { if (body.timeLimitMinutes === null) value.timeLimitMinutes = null; else { const n = intIn(body.timeLimitMinutes, 1, 600); if (n === null) errors.push("timeLimitMinutes must be a whole number 1-600, or null for no limit."); else value.timeLimitMinutes = n; } }
  if ("maxAttempts" in body) { const n = intIn(body.maxAttempts, 1, 20); if (n === null) errors.push("maxAttempts must be a whole number 1-20."); else value.maxAttempts = n; }
  for (const k of ["shuffleQuestions", "shuffleOptions", "countsToGrade"]) if (k in body) { if (typeof body[k] !== "boolean") errors.push(`${k} must be true or false.`); else value[k] = body[k]; }
  if ("feedbackTiming" in body) { if (!FEEDBACK.includes(body.feedbackTiming)) errors.push(`feedbackTiming must be one of ${FEEDBACK.join(", ")}.`); else value.feedbackTiming = body.feedbackTiming; }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
function check(m) {
  const errors = [];
  if (m.assessmentType === "practice" && m.countsToGrade) errors.push("A practice quiz can never count towards a grade. Make it coursework first.");
  if (m.feedbackTiming === "after_close" && !m.dueAt) errors.push("feedbackTiming after_close needs a dueAt.");
  if (m.availableFrom && m.dueAt && m.availableFrom > m.dueAt) errors.push("availableFrom must not be after dueAt.");
  /* Practice centre (L6.3a, D-081). revision = self-paced practice: always practice, instant feedback, no timer, no due date. mock = a timed run-through: the timer is required. */
  if (m.mode === "revision" || m.mode === "flashcards") {
    const what = m.mode === "revision" ? "A revision set" : "A flashcard deck";
    if (m.assessmentType !== "practice") errors.push(`${what} is always practice, never coursework.`);
    if (m.feedbackTiming !== "immediate") errors.push(`${what} gives feedback immediately.`);
    if (m.timeLimitMinutes) errors.push(`${what} has no time limit.`);
    if (m.dueAt) errors.push(`${what} has no due date.`);
  }
  if (m.mode === "mock" && !m.timeLimitMinutes) errors.push("A mock test needs a time limit (timeLimitMinutes).");
  return errors;
}

const COLS = "z.id, z.course_id, z.section_id, z.title, z.instructions, z.assessment_type, z.quiz_mode, z.status, z.published_at, z.available_from, z.due_at, z.time_limit_minutes, z.max_attempts, z.shuffle_questions, z.shuffle_options, z.feedback_timing, z.counts_to_grade, z.created_at, z.updated_at";
const SUMMARY = `(SELECT COUNT(*) FROM lms_quiz_questions k WHERE k.quiz_id = z.id AND k.attempt_id IS NULL) + (SELECT ISNULL(SUM(r.pick_count), 0) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS question_count,
  (SELECT ISNULL(SUM(k.points), 0) FROM lms_quiz_questions k WHERE k.quiz_id = z.id AND k.attempt_id IS NULL) + (SELECT ISNULL(SUM(r.pick_count * r.points_each), 0) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS total_points,
  (SELECT COUNT(*) FROM lms_quiz_rules r WHERE r.quiz_id = z.id) AS rule_count`;
function model(row) {
  return { id: row.id, courseId: row.course_id, sectionId: row.section_id ?? null, title: row.title, instructions: row.instructions || "", assessmentType: row.assessment_type, mode: row.quiz_mode || "quiz", status: row.status,
    publishedAt: iso(row.published_at), availableFrom: iso(row.available_from), dueAt: iso(row.due_at), timeLimitMinutes: row.time_limit_minutes ?? null, maxAttempts: row.max_attempts,
    shuffleQuestions: !!row.shuffle_questions, shuffleOptions: !!row.shuffle_options, feedbackTiming: row.feedback_timing, countsToGrade: !!row.counts_to_grade,
    questionCount: row.question_count === undefined ? undefined : Number(row.question_count), totalPoints: row.total_points === undefined ? undefined : num(row.total_points),
    ruleCount: row.rule_count === undefined ? undefined : Number(row.rule_count),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function parseSpec(json) { try { const v = JSON.parse(json); return isPlainObject(v) ? v : {}; } catch { return {}; } }
const qModel = (r) => ({ id: r.id, position: r.position, type: r.type, stem: r.stem, explanation: r.explanation || "", points: num(r.points), difficulty: r.difficulty || null, spec: parseSpec(r.spec_json),
  sourceQuestionId: r.source_question_id ?? null, sourceVersion: r.source_version ?? null });
const m0 = (row) => row.quiz_mode || "quiz";
const notFound = () => ({ ok: false, notFound: true, errors: ["Quiz not found."] });

async function loadRow(pool, courseId, id) {
  const r = await pool.request().input("id", sql.Int, id).input("c", sql.Int, courseId).query(`SELECT TOP 1 ${COLS}, ${SUMMARY} FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c AND z.deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
async function sectionOk(pool, courseId, sectionId) {
  if (sectionId === null || sectionId === undefined) return true;
  const r = await pool.request().input("s", sql.Int, sectionId).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_course_sections WHERE id = @s AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}

async function hasAttempts(pool, courseId, quizId) {
  const r = await pool.request().input("q", sql.Int, quizId).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_quiz_attempts WHERE quiz_id = @q AND course_id = @c`);
  return !!(r.recordset && r.recordset.length);
}
const HAS_ATTEMPTS = { ok: false, code: "HAS_ATTEMPTS", errors: ["Learners have already attempted this quiz, so it cannot be unpublished or deleted."] };

async function listQuizzes(pool, courseId, query = {}) {
  const { size, pg } = paging(query); const status = STATUSES.includes(query.status) ? query.status : null;
  const mode = MODES.includes(query.mode) ? query.mode : null; // "quiz" matches NULL (older rows) too
  const r = await pool.request().input("c", sql.Int, courseId).input("st", sql.NVarChar(12), status).input("md", sql.NVarChar(12), mode).input("off", sql.Int, (pg - 1) * size).input("n", sql.Int, size)
    .query(`SELECT ${COLS}, ${SUMMARY}, COUNT(*) OVER() AS total_count FROM lms_quizzes z WHERE z.course_id = @c AND z.deleted_at IS NULL AND (@st IS NULL OR z.status = @st) AND (@md IS NULL OR ISNULL(z.quiz_mode, 'quiz') = @md) ORDER BY z.created_at DESC, z.id DESC OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map(model), total: rows.length ? Number(rows[0].total_count) : 0, page: pg, pageSize: size };
}

async function getQuiz(pool, courseId, id) {
  const qid = posInt(id); if (qid === null) return notFound();
  const row = await loadRow(pool, courseId, qid); if (!row) return notFound();
  const k = await pool.request().input("id", sql.Int, qid).input("c", sql.Int, courseId).query(`SELECT id, position, type, stem, explanation, points, difficulty, spec_json, source_question_id, source_version FROM lms_quiz_questions WHERE quiz_id = @id AND course_id = @c AND attempt_id IS NULL ORDER BY position, id`);
  const out = { ...model(row), questions: (k.recordset || []).map(qModel) };
  if (Number(row.rule_count) > 0) out.rules = await rules.loadRules(pool, courseId, qid); // plain rules; pool sizes: GET .../rules
  return { ok: true, quiz: out };
}

async function createQuiz(pool, user, courseId, body, { tenant, now = new Date() } = {}) {
  const v = validate(body, { now }); if (!v.ok) return v;
  if (v.value.status === "published") return { ok: false, code: "NO_QUESTIONS", errors: ["Add questions first, then publish the quiz."] };
  const m = { instructions: "", sectionId: null, assessmentType: "practice", status: "draft", availableFrom: null, dueAt: null, timeLimitMinutes: null, maxAttempts: 1, shuffleQuestions: false, shuffleOptions: false, feedbackTiming: "immediate", countsToGrade: false, mode: "quiz", ...v.value };
  const bad = check(m); if (bad.length) return { ok: false, errors: bad };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (!(await sectionOk(pool, courseId, m.sectionId))) return { ok: false, errors: ["That section is not part of this course."] };
  const n = await pool.request().input("c", sql.Int, courseId).query(`SELECT COUNT(*) AS n FROM lms_quizzes WHERE course_id = @c AND deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= MAX_PER_COURSE) return { ok: false, code: "QUIZ_LIMIT", errors: [`A course can have at most ${MAX_PER_COURSE} quizzes.`] };
  const actor = actorOf(user);
  const r = await pool.request().input("c", sql.Int, courseId).input("sec", sql.Int, m.sectionId).input("t", sql.NVarChar(200), m.title).input("ins", sql.NVarChar(4000), m.instructions || null)
    .input("ty", sql.NVarChar(12), m.assessmentType).input("md", sql.NVarChar(12), m.mode === "quiz" ? null : m.mode).input("af", sql.DateTime2, m.availableFrom).input("due", sql.DateTime2, m.dueAt).input("tl", sql.Int, m.timeLimitMinutes).input("ma", sql.Int, m.maxAttempts)
    .input("sq", sql.Bit, m.shuffleQuestions).input("so", sql.Bit, m.shuffleOptions).input("ft", sql.NVarChar(12), m.feedbackTiming).input("cg", sql.Bit, m.countsToGrade)
    .input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
    .query(`INSERT INTO lms_quizzes (course_id, section_id, title, instructions, assessment_type, quiz_mode, status, available_from, due_at, time_limit_minutes, max_attempts, shuffle_questions, shuffle_options, feedback_timing, counts_to_grade, created_by_source, created_by)
      OUTPUT INSERTED.id VALUES (@c, @sec, @t, @ins, @ty, @md, 'draft', @af, @due, @tl, @ma, @sq, @so, @ft, @cg, @src, @uid)`);
  const id = r.recordset[0].id;
  await audit(pool, actor, "quiz.created", "lms_quizzes", id, { courseId, assessmentType: m.assessmentType });
  return getQuiz(pool, courseId, id);
}

async function updateQuiz(pool, user, courseId, id, body, { tenant, now = new Date() } = {}) {
  const qid = posInt(id); if (qid === null) return notFound();
  const v = validate(body, { partial: true, now }); if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: false, errors: ["Nothing to change."] };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const row = await loadRow(pool, courseId, qid); if (!row) return notFound();
  const m = { ...model(row), ...v.value, availableFrom: "availableFrom" in v.value ? v.value.availableFrom : (row.available_from ? new Date(row.available_from) : null), dueAt: "dueAt" in v.value ? v.value.dueAt : (row.due_at ? new Date(row.due_at) : null) };
  const bad = check(m); if (bad.length) return { ok: false, errors: bad };
  if ("mode" in v.value && v.value.mode !== m0(row) && row.status === "published") return { ok: false, code: "QUIZ_PUBLISHED", errors: ["The mode can only be changed while the quiz is a draft. Unpublish it first."] };
  if (v.value.status === "published" && row.status !== "published" && Number(row.question_count) < 1) return { ok: false, code: "NO_QUESTIONS", errors: ["Add at least one question before publishing."] };
  if (m.mode === "flashcards" && Number(row.rule_count) > 0) return { ok: false, code: "RULES_NOT_FOR_FLASHCARDS", errors: ["A flashcard deck cannot have random rules. Remove the rules first."] };
  if (v.value.status === "published" && row.status !== "published" && Number(row.rule_count) > 0) { const bad = await rules.poolProblem(pool, courseId, qid); if (bad) return bad; }
  if ("sectionId" in v.value && !(await sectionOk(pool, courseId, m.sectionId))) return { ok: false, errors: ["That section is not part of this course."] };
  if (m.status === "draft" && row.status === "published" && (await hasAttempts(pool, courseId, qid))) return HAS_ATTEMPTS;
  const publishing = m.status === "published" && row.status !== "published";
  await pool.request().input("id", sql.Int, qid).input("c", sql.Int, courseId).input("sec", sql.Int, m.sectionId).input("t", sql.NVarChar(200), m.title).input("ins", sql.NVarChar(4000), m.instructions || null)
    .input("ty", sql.NVarChar(12), m.assessmentType).input("md", sql.NVarChar(12), m.mode === "quiz" ? null : m.mode).input("st", sql.NVarChar(12), m.status).input("af", sql.DateTime2, m.availableFrom).input("due", sql.DateTime2, m.dueAt).input("tl", sql.Int, m.timeLimitMinutes)
    .input("ma", sql.Int, m.maxAttempts).input("sq", sql.Bit, m.shuffleQuestions).input("so", sql.Bit, m.shuffleOptions).input("ft", sql.NVarChar(12), m.feedbackTiming).input("cg", sql.Bit, m.countsToGrade)
    .query(`UPDATE lms_quizzes SET section_id = @sec, title = @t, instructions = @ins, assessment_type = @ty, quiz_mode = @md, status = @st, published_at = CASE WHEN @st = 'published' THEN ISNULL(published_at, SYSUTCDATETIME()) ELSE published_at END,
      available_from = @af, due_at = @due, time_limit_minutes = @tl, max_attempts = @ma, shuffle_questions = @sq, shuffle_options = @so, feedback_timing = @ft, counts_to_grade = @cg, updated_at = SYSUTCDATETIME()
      WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  await audit(pool, actorOf(user), "quiz.updated", "lms_quizzes", qid, { courseId, fields: Object.keys(v.value) });
  if (publishing && tenant) events.emit("lms.quiz.published", { tenant, courseId, quizId: qid });
  return getQuiz(pool, courseId, qid);
}

async function deleteQuiz(pool, user, courseId, id) {
  const qid = posInt(id); if (qid === null) return notFound();
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (await hasAttempts(pool, courseId, qid)) return HAS_ATTEMPTS;
  const r = await pool.request().input("id", sql.Int, qid).input("c", sql.Int, courseId).query(`UPDATE lms_quizzes SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return notFound();
  await audit(pool, actorOf(user), "quiz.deleted", "lms_quizzes", qid, { courseId });
  return { ok: true };
}

/* Common guard for question changes: course editable, quiz exists, quiz is a draft. */
async function draftQuiz(pool, courseId, id) {
  const qid = posInt(id); if (qid === null) return notFound();
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const row = await loadRow(pool, courseId, qid); if (!row) return notFound();
  if (row.status !== "draft") return { ok: false, code: "QUIZ_PUBLISHED", errors: ["Questions can only be changed while the quiz is a draft. Unpublish it first."] };
  return { ok: true, row, qid };
}

async function addQuestions(pool, user, courseId, id, body, { admin = false } = {}) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "questionIds") || !Array.isArray(body.questionIds)) return { ok: false, errors: ["Body must be {questionIds: [...]}."] };
  const ids = body.questionIds.map(posInt); if (!ids.length || ids.length > MAX_ADD || ids.some((n) => n === null)) return { ok: false, errors: [`questionIds must list 1-${MAX_ADD} question ids.`] };
  const uniq = [...new Set(ids)]; if (uniq.length !== ids.length) return { ok: false, errors: ["questionIds must not repeat an id."] };
  const g = await draftQuiz(pool, courseId, id); if (!g.ok) return g;
  if (Number(g.row.question_count) + uniq.length > MAX_QUESTIONS) return { ok: false, code: "QUIZ_QUESTION_LIMIT", errors: [`A quiz can have at most ${MAX_QUESTIONS} questions.`] };
  const found = await qbank.fetchVisible(pool, user, uniq, { admin });
  if (found.size !== uniq.length) return { ok: false, notFound: true, errors: ["One or more questions were not found."] };
  const dup = await pool.request().input("q", sql.Int, g.qid).input("c", sql.Int, courseId).query(`SELECT source_question_id FROM lms_quiz_questions WHERE quiz_id = @q AND course_id = @c AND attempt_id IS NULL AND source_question_id IS NOT NULL`);
  const have = new Set((dup.recordset || []).map((x) => Number(x.source_question_id)));
  if (uniq.some((n) => have.has(n))) return { ok: false, code: "DUPLICATE_QUESTION", errors: ["One of these questions is already in the quiz."] };
  const req = pool.request().input("q", sql.Int, g.qid).input("c", sql.Int, courseId);
  const values = uniq.map((qidBank, i) => {
    const row = found.get(qidBank);
    req.input(`s${i}`, sql.Int, qidBank).input(`v${i}`, sql.Int, row.version).input(`t${i}`, sql.NVarChar(20), row.type).input(`h${i}`, sql.NVarChar(4000), row.stem).input(`e${i}`, sql.NVarChar(2000), row.explanation || null)
      .input(`p${i}`, sql.Decimal(6, 2), Number(row.points)).input(`d${i}`, sql.NVarChar(10), row.difficulty || null).input(`j${i}`, sql.NVarChar(sql.MAX), row.spec_json);
    return `(@q, @c, @base + ${i + 1}, @s${i}, @v${i}, @t${i}, @h${i}, @e${i}, @p${i}, @d${i}, @j${i})`;
  });
  await req.query(`SET XACT_ABORT ON; BEGIN TRAN;
    DECLARE @base INT = (SELECT ISNULL(MAX(position), 0) FROM lms_quiz_questions WITH (UPDLOCK, HOLDLOCK) WHERE quiz_id = @q AND attempt_id IS NULL);
    INSERT INTO lms_quiz_questions (quiz_id, course_id, position, source_question_id, source_version, type, stem, explanation, points, difficulty, spec_json) VALUES ${values.join(", ")};
    COMMIT;`);
  await audit(pool, actorOf(user), "quiz.questions_added", "lms_quizzes", g.qid, { courseId, count: uniq.length });
  return getQuiz(pool, courseId, g.qid);
}

async function removeQuestion(pool, user, courseId, id, quizQuestionId) {
  const kid = posInt(quizQuestionId); const g = await draftQuiz(pool, courseId, id); if (!g.ok) return g; if (kid === null) return { ok: false, notFound: true, errors: ["Question not found."] };
  const r = await pool.request().input("k", sql.Int, kid).input("q", sql.Int, g.qid).input("c", sql.Int, courseId).query(`DELETE FROM lms_quiz_questions OUTPUT DELETED.id WHERE id = @k AND quiz_id = @q AND course_id = @c AND attempt_id IS NULL`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, notFound: true, errors: ["Question not found."] };
  await audit(pool, actorOf(user), "quiz.question_removed", "lms_quizzes", g.qid, { courseId, quizQuestionId: kid });
  return getQuiz(pool, courseId, g.qid);
}

/* body {ids: [quiz question ids]} must be EXACTLY the quiz's current questions in the new order. */
async function reorderQuestions(pool, user, courseId, id, body) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "ids") || !Array.isArray(body.ids)) return { ok: false, errors: ["Body must be {ids: [...]}."] };
  const ids = body.ids.map(posInt); if (ids.some((n) => n === null) || new Set(ids).size !== ids.length || ids.length > MAX_QUESTIONS) return { ok: false, errors: ["ids must be distinct question ids."] };
  const g = await draftQuiz(pool, courseId, id); if (!g.ok) return g;
  const cur = await pool.request().input("q", sql.Int, g.qid).input("c", sql.Int, courseId).query(`SELECT id FROM lms_quiz_questions WHERE quiz_id = @q AND course_id = @c AND attempt_id IS NULL`);
  const have = new Set((cur.recordset || []).map((x) => x.id));
  if (have.size !== ids.length || ids.some((n) => !have.has(n))) return { ok: false, code: "ORDER_MISMATCH", errors: ["ids must list every question of the quiz exactly once."] };
  if (ids.length) {
    const req = pool.request().input("q", sql.Int, g.qid).input("c", sql.Int, courseId);
    ids.forEach((n, i) => req.input(`k${i}`, sql.Int, n));
    await req.query(`UPDATE lms_quiz_questions SET position = CASE id ${ids.map((_, i) => `WHEN @k${i} THEN ${i + 1}`).join(" ")} END WHERE quiz_id = @q AND course_id = @c AND attempt_id IS NULL`);
  }
  await audit(pool, actorOf(user), "quiz.questions_reordered", "lms_quizzes", g.qid, { courseId });
  return getQuiz(pool, courseId, g.qid);
}

module.exports = { MAX_PER_COURSE, MAX_QUESTIONS, MAX_ADD, TYPES, MODES, FEEDBACK, validate, check, model, qModel, listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz, addQuestions, removeQuestion, reorderQuestions };
