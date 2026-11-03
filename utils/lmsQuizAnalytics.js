/* =========================================================================
   LMS QUIZ ANALYTICS  (L6.5, D-084)  per-question and per-quiz statistics for STAFF. Read only: writes nothing, emits nothing.

   Rules (documented, simple, the same for every quiz):
   - Staff only (route: flag `lms_quizzes`, then `lms.course.manage` OR `lms.submission.grade`, then course membership owner/co-teacher/admin).
     Every query matches quiz_id AND course_id, so another course's or another school's quiz is simply "not found".
   - AGGREGATES ONLY. No learner id, name or answer text is ever returned. The statistics are computed from the FROZEN rows of the attempts
     (`lms_quiz_answers` + the per-attempt snapshots in `lms_quiz_questions`), so a later edit in the question bank never changes them.
   - Which attempts count: ALL GRADED attempts of the quiz (every attempt of every learner, not only the best one; an enrolment that was later withdrawn still
     counts, it still happened). Attempts still waiting for teacher marking ("submitted") and in-progress ones are NOT counted; the number waiting is reported.
   - One "question" = one bank question at one version (`source_question_id` + `source_version`), so fixed questions and random picks of the same bank question
     are pooled, and an edited question (new version) is reported separately. A question that has no bank source is reported on its own.
   - A learner who was shown a question and left no answer counts as UNANSWERED (score 0). A question that was not shown to an attempt (random pool) is not a response.
   - difficulty index p = average of (points / max points) over the responses, 0..1 (higher = easier). Label: p >= 0.8 easy, p < 0.3 hard, else medium.
   - discrimination (upper-lower index) = p(top group) - p(bottom group); the groups are the top and bottom 27% of the graded attempts ranked by their quiz percentage
     (ties broken by attempt id, so the result is reproducible). It needs >= 20 graded attempts and >= 5 responses to the question in EACH group; otherwise it is
     `null` with a `reason` (NEEDS_20_GRADED_ATTEMPTS | TOO_FEW_RESPONSES). Rule of thumb shown to teachers: >= 0.30 good, 0.10-0.29 fair, < 0.10 weak, < 0 check the key.
   - distractor use (mcq_single, mcq_multi, true_false only): for every option, how many responses chose it (a multi-answer response counts once per option it ticked).
   - These numbers are prompts for the teacher to look at a question again, never a verdict. The result says so.
   Every query is parameterised; the output is capped (TOP caps, `truncated` flag, page size <= 50).
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");

const MIN_ATTEMPTS = 20, GROUP_SHARE = 0.27, MIN_GROUP = 5;
const MAX_ATTEMPTS = 20000, MAX_ANSWERS = 200000, MAX_QUESTION_ROWS = 50000;
const OPTION_TYPES = ["mcq_single", "mcq_multi", "true_false"];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100; // half-up on the decimal value: 0.525 -> 0.53, not 0.52 from float noise
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const parseJson = (j) => { if (j === null || j === undefined) return null; try { const v = JSON.parse(j); return v === undefined ? null : v; } catch { return null; } };
const paging = (o) => ({ size: Math.min(50, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });
const notFound = () => ({ ok: false, notFound: true, errors: ["Quiz not found."] });

const labelOf = (p) => (p === null ? null : p >= 0.8 ? "easy" : p < 0.3 ? "hard" : "medium");
const rateOf = (d) => (d >= 0.3 ? "good" : d >= 0.1 ? "fair" : d >= 0 ? "weak" : "check_key");
const groupKey = (q) => (q.source_question_id ? `b${q.source_question_id}v${q.source_version || 0}` : `q${q.id}`);

/* Pure. Which option positions did this answer choose? mcq_single {selected: n}, mcq_multi {selected: [n..]}, true_false {selected: true|false}.
   Returns an array of keys ("1", "2", "true", "false") or null when the answer is missing or malformed. */
function chosenOf(type, answerJson) {
  const a = isPlainObject(answerJson) ? answerJson : parseJson(answerJson);
  if (!isPlainObject(a) || a.selected === undefined || a.selected === null) return null;
  if (type === "true_false") return typeof a.selected === "boolean" ? [String(a.selected)] : null;
  const list = Array.isArray(a.selected) ? a.selected : [a.selected];
  if (type === "mcq_single" && list.length !== 1) return null;
  const out = []; for (const v of list) { if (!Number.isInteger(v) || v < 1 || v > 10) return null; if (!out.includes(String(v))) out.push(String(v)); }
  return out.length ? out : null;
}

/* Pure. Option rows for the distractor table from a question spec; counts start at 0. */
function optionsOf(type, spec) {
  const s = isPlainObject(spec) ? spec : {};
  if (type === "true_false") return [{ key: "true", text: "True", correct: s.correct === true, chosen: 0 }, { key: "false", text: "False", correct: s.correct === false, chosen: 0 }];
  if (!Array.isArray(s.options)) return [];
  return s.options.filter((o) => isPlainObject(o) && Number.isInteger(o.position)).map((o) => ({ key: String(o.position), text: String(o.text ?? "").slice(0, 200), correct: o.correct === true, chosen: 0 }));
}

/* Pure. attempts [{id, status, total_points, max_points}], questions [{id, attempt_id, source_question_id, source_version, type, stem, points, position}],
   answers [{attempt_id, quiz_question_id, answer_json, status, points, max_points}]  ->  { summary, groups }
   `groups` holds the numbers for ALL questions (no paging yet) plus `repId` (one snapshot id per group, used to read the options). */
function compute(attempts, questions, answers) {
  const graded = (attempts || []).filter((a) => a && a.status === "graded").map((a) => ({ id: Number(a.id), max: Number(a.max_points), tot: Number(a.total_points) }))
    .filter((a) => Number.isInteger(a.id));
  const waiting = (attempts || []).filter((a) => a && a.status === "submitted").length;
  const pct = new Map(); for (const a of graded) pct.set(a.id, a.max > 0 && Number.isFinite(a.tot) ? Math.min(1, Math.max(0, a.tot / a.max)) : 0);

  const fixed = [], picks = new Map();
  for (const q of questions || []) {
    if (q.attempt_id === null || q.attempt_id === undefined) fixed.push(q);
    else { const k = Number(q.attempt_id); if (!picks.has(k)) picks.set(k, []); picks.get(k).push(q); }
  }
  const byAnswer = new Map(); for (const x of answers || []) byAnswer.set(`${x.attempt_id}:${x.quiz_question_id}`, x);

  // ranking for the upper / lower groups
  const ranked = [...graded].sort((x, y) => pct.get(y.id) - pct.get(x.id) || x.id - y.id);
  const canDiscriminate = ranked.length >= MIN_ATTEMPTS, k = Math.floor(ranked.length * GROUP_SHARE);
  const top = new Set(canDiscriminate ? ranked.slice(0, k).map((a) => a.id) : []), bottom = new Set(canDiscriminate ? ranked.slice(ranked.length - k).map((a) => a.id) : []);

  const groups = new Map();
  for (const a of graded) {
    for (const q of [...fixed, ...(picks.get(a.id) || [])]) {
      const key = groupKey(q);
      const g = groups.get(key) || { key, repId: q.id, questionId: q.source_question_id || null, sourceVersion: q.source_version || null, type: q.type, stem: String(q.stem || ""), points: Number(q.points) || 0, position: Number(q.position) || 0,
        responses: 0, unanswered: 0, fractions: [], top: [], bottom: [], chosen: new Map(), noChoice: 0 };
      const x = byAnswer.get(`${a.id}:${q.id}`);
      const max = x && Number(x.max_points) > 0 ? Number(x.max_points) : Number(q.points) || 0;
      const empty = !x || x.status === "unanswered" || x.answer_json === null || x.answer_json === undefined;
      const fr = max > 0 && x && x.points !== null && x.points !== undefined && Number.isFinite(Number(x.points)) ? Math.min(1, Math.max(0, Number(x.points) / max)) : 0;
      g.responses += 1; if (empty) g.unanswered += 1; g.fractions.push(fr);
      if (top.has(a.id)) g.top.push(fr); if (bottom.has(a.id)) g.bottom.push(fr);
      if (OPTION_TYPES.includes(q.type)) { const c = empty ? null : chosenOf(q.type, x.answer_json); if (c) for (const o of c) g.chosen.set(o, (g.chosen.get(o) || 0) + 1); else g.noChoice += 1; }
      groups.set(key, g);
    }
  }
  const out = [...groups.values()].sort((x, y) => x.position - y.position || x.repId - y.repId).map((g) => {
    const p = mean(g.fractions), pr = p === null ? null : round2(p);
    let disc;
    if (!canDiscriminate) disc = { value: null, reason: "NEEDS_20_GRADED_ATTEMPTS" };
    else if (g.top.length < MIN_GROUP || g.bottom.length < MIN_GROUP) disc = { value: null, reason: "TOO_FEW_RESPONSES" };
    else { const d = round2(mean(g.top) - mean(g.bottom)); disc = { value: d, rating: rateOf(d) }; }
    return { key: g.key, repId: g.repId, questionId: g.questionId, sourceVersion: g.sourceVersion, type: g.type, stem: g.stem.slice(0, 300), points: g.points, position: g.position,
      responses: g.responses, unanswered: g.unanswered, unansweredRate: g.responses ? round2(g.unanswered / g.responses) : null,
      difficulty: pr, difficultyLabel: labelOf(pr), discrimination: disc, _chosen: g.chosen, _noChoice: g.noChoice };
  });
  const pcts = graded.map((a) => pct.get(a.id) * 100);
  const sorted = [...pcts].sort((x, y) => x - y), mid = Math.floor(sorted.length / 2);
  const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
  const summary = { gradedAttempts: graded.length, waitingForMarking: waiting, meanPercent: pcts.length ? round2(mean(pcts)) : null, medianPercent: median === null ? null : round2(median),
    lowestPercent: pcts.length ? round2(Math.min(...pcts)) : null, highestPercent: pcts.length ? round2(Math.max(...pcts)) : null,
    discriminationAvailable: canDiscriminate, groupSize: canDiscriminate ? k : 0, questionCount: out.length };
  return { summary, groups: out };
}

/* Pure. Attach the option table to ONE group once its snapshot spec is known; removes the private fields. */
function finishGroup(g, spec) {
  const { _chosen, _noChoice, repId, ...rest } = g;
  if (!OPTION_TYPES.includes(g.type)) return rest;
  const options = optionsOf(g.type, spec); for (const o of options) o.chosen = _chosen.get(o.key) || 0;
  const hasKey = options.some((o) => o.correct);
  return { ...rest, options, noValidChoice: _noChoice, keyed: hasKey };
}

/* ------------------------------- loading ------------------------------- */
async function loadQuiz(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP 1 z.id, z.title, z.assessment_type, z.status, ISNULL(z.quiz_mode, 'quiz') AS quiz_mode, z.counts_to_grade
       FROM lms_quizzes z JOIN lms_courses c ON c.id = z.course_id
      WHERE z.id = @z AND z.course_id = @c AND z.deleted_at IS NULL AND c.deleted_at IS NULL`);
  const x = r.recordset && r.recordset[0]; return x || null;
}
async function loadAttempts(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP ${MAX_ATTEMPTS} id, status, total_points, max_points FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND status IN ('submitted', 'graded') ORDER BY id`);
  return r.recordset || [];
}
async function loadQuestions(pool, courseId, quizId) {
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP ${MAX_QUESTION_ROWS} id, attempt_id, source_question_id, source_version, type, stem, points, position FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c ORDER BY id`);
  return r.recordset || [];
}
async function loadAnswers(pool, courseId, quizId) {
  // the answer text is only read for the types that have options; essays and typed answers are never loaded
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).query(
    `SELECT TOP ${MAX_ANSWERS} a.attempt_id, a.quiz_question_id, a.status, a.points, a.max_points,
            CASE WHEN q.type IN ('mcq_single', 'mcq_multi', 'true_false') THEN a.answer_json ELSE CASE WHEN a.answer_json IS NULL THEN NULL ELSE N'{}' END END AS answer_json
       FROM lms_quiz_answers a
       JOIN lms_quiz_attempts t ON t.id = a.attempt_id AND t.quiz_id = @z AND t.course_id = @c AND t.status = 'graded'
       JOIN lms_quiz_questions q ON q.id = a.quiz_question_id AND q.quiz_id = @z AND q.course_id = @c
      WHERE a.quiz_id = @z AND a.course_id = @c`);
  return r.recordset || [];
}
async function loadSpecs(pool, courseId, quizId, ids) {
  if (!ids.length) return new Map();
  const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, quizId).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(
    `SELECT id, spec_json FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`);
  const m = new Map(); for (const x of r.recordset || []) m.set(x.id, parseJson(x.spec_json)); return m;
}

/* ------------------------------- the report ------------------------------- */
/* opts: { page, pageSize, questionId } ; questionId = a BANK question id, narrows the list to that question (any version). */
async function quizAnalytics(pool, user, courseId, quizId, opts = {}) {
  const cid = posInt(courseId), qid = posInt(quizId); if (!cid || !qid) return notFound();
  const actor = actorOf(user); if (!actor || actor.role === "student") return notFound();
  let only = null;
  if (opts.questionId !== undefined && opts.questionId !== null && opts.questionId !== "") { only = posInt(opts.questionId); if (!only) return { ok: false, errors: ["questionId must be a positive whole number."] }; }

  const quiz = await loadQuiz(pool, cid, qid); if (!quiz) return notFound();
  const attempts = await loadAttempts(pool, cid, qid);
  const gradedIds = attempts.some((a) => a.status === "graded");
  const [questions, answers] = gradedIds ? [await loadQuestions(pool, cid, qid), await loadAnswers(pool, cid, qid)] : [[], []];
  const truncated = attempts.length >= MAX_ATTEMPTS || answers.length >= MAX_ANSWERS || questions.length >= MAX_QUESTION_ROWS;
  const { summary, groups } = compute(attempts, questions, answers);

  const list = only ? groups.filter((g) => g.questionId === only) : groups;
  const { size, pg } = paging(opts); const total = list.length, from = (pg - 1) * size, slice = list.slice(from, from + size);
  const specs = await loadSpecs(pool, cid, qid, slice.filter((g) => OPTION_TYPES.includes(g.type)).map((g) => g.repId));
  const items = slice.map((g) => finishGroup(g, specs.get(g.repId)));
  return {
    ok: true,
    quiz: { id: quiz.id, title: quiz.title, assessmentType: quiz.assessment_type, status: quiz.status, mode: quiz.quiz_mode },
    summary: { ...summary, truncated, limits: { attempts: MAX_ATTEMPTS, answers: MAX_ANSWERS, questionRows: MAX_QUESTION_ROWS } },
    countedAttempts: "all graded attempts of every learner (not only the best one)",
    note: "These numbers are prompts to look at a question again, not verdicts. Small groups give unstable figures.",
    questions: items, total, page: pg, pageSize: size, hasMore: from + size < total,
  };
}

module.exports = { MIN_ATTEMPTS, GROUP_SHARE, MIN_GROUP, chosenOf, optionsOf, compute, finishGroup, quizAnalytics };
