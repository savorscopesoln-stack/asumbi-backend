/* =========================================================================
   LMS QUIZ RULES  (L6.2c, D-080)  random selection from the question bank.

   A quiz may have, besides its fixed questions, up to MAX_RULES RULES: "pick `count` questions matching these filters, each worth `pointsEach` points".

   Rules (documented, simple):
   - Teacher side: same permission as the quiz itself (`lms.course.manage` + course membership; read = any course staff). Rules can only be added, changed or
     removed while the quiz is a DRAFT (409 QUIZ_PUBLISHED); archived/pending courses are read-only. Because a quiz with attempts can never go back to draft
     (D-077), a rule can never change under a learner's feet.
   - Filters (all optional, all must match): type, subject, topic, difficulty, outcomeId. `count` 1-50, `pointsEach` 0.01-100 (2 decimals) and is REQUIRED:
     picked questions are worth exactly pointsEach, so the quiz total (fixed + sum(count * pointsEach)) is known BEFORE anybody starts and every learner
     gets the same maximum.
   - Pool: live bank questions of scope `school`, or scope `course` for THIS course. PRIVATE questions are never in a pool (a learner must not be served a
     question its owner never shared). Bank questions already in the quiz's fixed set are left out, and one bank question is picked at most once per attempt
     (also across rules; rules are served in position order).
   - Picks are made when an attempt STARTS, from the attempt `seed` (pure `pickIds`, reproducible), and are FROZEN: copies are written to lms_quiz_questions with
     attempt_id = that attempt (stem, spec, version snapshot), so a later bank edit or delete never changes a marked attempt, and resuming shows the same questions.
   - If the pool holds fewer questions than `count`, the learner gets 409 NOT_ENOUGH_QUESTIONS and NO attempt is used (every learner has the same maximum;
     better a clear stop than unequal papers). Publishing checks the same thing first (409 RULE_POOL_TOO_SMALL), so a teacher normally sees it before learners do.
   - Limits: 10 rules per quiz; fixed questions + sum(count) at most 100 (409 QUIZ_QUESTION_LIMIT). Candidates are read as ids only (max 5000 per rule).
   Every query is parameterised and matches course_id. Authorisation lives in the routes.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const M = require("./lmsQuizMarking");

const MAX_RULES = 10, MAX_COUNT = 50, MAX_TOTAL = 100, MAX_CANDIDATES = 5000, MAX_POINTS = 100;
const KEYS = ["count", "pointsEach", "type", "subject", "topic", "difficulty", "outcomeId"];
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const num = (v) => Math.round(Number(v) * 100) / 100;
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);
const notFound = (what = "Quiz") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });

/* ------------------------------- pure ------------------------------- */

/* Body -> clean rule fields, or errors. `partial` (PATCH) only checks what is sent. */
function validateRule(body, { partial = false } = {}) {
  const errors = [], value = {};
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!KEYS.includes(k)) errors.push(`Unknown field "${k}".`);
  if (!partial || "count" in body) {
    const n = typeof body.count === "string" && body.count.trim() !== "" ? Number(body.count) : body.count;
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) errors.push(`count must be a whole number 1-${MAX_COUNT}.`); else value.count = n;
  }
  if (!partial || "pointsEach" in body) {
    const n = typeof body.pointsEach === "string" && body.pointsEach.trim() !== "" ? Number(body.pointsEach) : body.pointsEach;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0.01 || n > MAX_POINTS || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) errors.push(`pointsEach is required: a number 0.01-${MAX_POINTS} with at most 2 decimals.`); else value.pointsEach = num(n);
  }
  if ("type" in body) { if (body.type === null) value.type = null; else if (!M.TYPES.includes(body.type)) errors.push(`type must be one of: ${M.TYPES.join(", ")}.`); else value.type = body.type; }
  if ("difficulty" in body) { if (body.difficulty === null) value.difficulty = null; else if (!M.DIFFICULTIES.includes(body.difficulty)) errors.push(`difficulty must be one of: ${M.DIFFICULTIES.join(", ")}.`); else value.difficulty = body.difficulty; }
  for (const k of ["subject", "topic"]) if (k in body) {
    if (body[k] === null || body[k] === "") value[k] = null; else if (typeof body[k] !== "string") errors.push(`${k} must be text or null.`);
    else { const t = oneLine(body[k]); if (t.length > 100) errors.push(`${k}: at most 100 characters.`); else value[k] = t || null; }
  }
  if ("outcomeId" in body) { if (body.outcomeId === null) value.outcomeId = null; else { const n = posInt(body.outcomeId); if (n === null) errors.push("outcomeId must be an outcome id or null."); else value.outcomeId = n; } }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* Pure. rules = [{id, count}] in position order; idsByRule = Map(ruleId -> candidate ids, any order); fixed = ids already in the quiz's fixed set.
   Returns { ok:true, picks:[{ruleId, sourceId}] } or { ok:false, ruleId, have, need }. The seed makes it reproducible; ids are sorted first so the DB order never matters. */
function pickIds(rules, idsByRule, fixed, seed) {
  const used = new Set(fixed || []), picks = [];
  for (const r of rules) {
    const pool = [...new Set(idsByRule.get(r.id) || [])].filter((id) => !used.has(id)).sort((a, b) => a - b);
    if (pool.length < r.count) return { ok: false, ruleId: r.id, have: pool.length, need: r.count };
    const order = M.permutation(pool.length, `${seed}:${r.id}`);
    for (let i = 0; i < r.count; i += 1) { const id = pool[order[i] - 1]; used.add(id); picks.push({ ruleId: r.id, sourceId: id }); }
  }
  return { ok: true, picks };
}

/* ------------------------------- data access ------------------------------- */
const RULE_COLS = "id, position, pick_count, points_each, q_type, subject, topic, difficulty, outcome_id";
const ruleModel = (r) => ({ id: r.id, position: r.position, count: r.pick_count, pointsEach: num(r.points_each), type: r.q_type || null, subject: r.subject || null, topic: r.topic || null, difficulty: r.difficulty || null, outcomeId: r.outcome_id ?? null });
const POOL = "q.deleted_at IS NULL AND (q.scope = 'school' OR (q.scope = 'course' AND q.course_id = @c))";

/* Filter fragment for one rule; parameter names carry the suffix so several rules fit one request. */
function filterSql(req, rule, i) {
  const w = [];
  if (rule.type) { req.input(`ft${i}`, sql.NVarChar(20), rule.type); w.push(`q.type = @ft${i}`); }
  if (rule.difficulty) { req.input(`fd${i}`, sql.NVarChar(10), rule.difficulty); w.push(`q.difficulty = @fd${i}`); }
  if (rule.subject) { req.input(`fs${i}`, sql.NVarChar(100), rule.subject); w.push(`q.subject = @fs${i}`); }
  if (rule.topic) { req.input(`fp${i}`, sql.NVarChar(100), rule.topic); w.push(`q.topic = @fp${i}`); }
  if (rule.outcomeId) { req.input(`fo${i}`, sql.Int, rule.outcomeId); w.push(`EXISTS (SELECT 1 FROM lms_outcome_tags t WHERE t.entity_type = 'question' AND t.entity_id = q.id AND t.outcome_id = @fo${i})`); }
  return w.length ? ` AND ${w.join(" AND ")}` : "";
}

async function loadRules(pool, courseId, quizId) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).query(`SELECT ${RULE_COLS} FROM lms_quiz_rules WHERE quiz_id = @z AND course_id = @c ORDER BY position, id`);
  return (r.recordset || []).map(ruleModel);
}
async function fixedSources(pool, courseId, quizId) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).query(`SELECT source_question_id FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL AND source_question_id IS NOT NULL`);
  return (r.recordset || []).map((x) => Number(x.source_question_id));
}
async function candidateIds(pool, courseId, rule) {
  const req = pool.request().input("c", sql.Int, courseId); const f = filterSql(req, rule, 0);
  const r = await req.query(`SELECT TOP ${MAX_CANDIDATES} q.id FROM lms_questions q WHERE ${POOL}${f} ORDER BY q.id`);
  return (r.recordset || []).map((x) => Number(x.id));
}

/* Teacher view: every rule with how many questions its pool holds now (excluding the quiz's fixed questions) and whether that is enough. */
async function rulesWithPool(pool, courseId, quizId) {
  const rules = await loadRules(pool, courseId, quizId); if (!rules.length) return [];
  const fixed = new Set(await fixedSources(pool, courseId, quizId)); const out = [];
  for (const rule of rules) { const ids = (await candidateIds(pool, courseId, rule)).filter((id) => !fixed.has(id)); out.push({ ...rule, available: ids.length, enough: ids.length >= rule.count }); }
  return out;
}

/* Publish guard: null = fine; otherwise the refusal. (Pools are re-checked with the same exclusion rule, but each rule alone: the exact picks are made per attempt.) */
async function poolProblem(pool, courseId, quizId) {
  const rules = await rulesWithPool(pool, courseId, quizId); const bad = rules.findIndex((r) => !r.enough);
  if (bad < 0) return null;
  const r = rules[bad];
  return { ok: false, code: "RULE_POOL_TOO_SMALL", errors: [`Random rule ${bad + 1} needs ${r.count} questions but only ${r.available} match. Add questions to the bank (school or this course) or lower the number.`] };
}

/* Common guard: course editable, quiz exists, quiz is a draft. */
async function draftGuard(pool, courseId, quizId) {
  const qid = posInt(quizId); if (qid === null) return notFound();
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const r = await pool.request().input("id", sql.Int, qid).input("c", sql.Int, courseId).query(`SELECT TOP 1 id, status, quiz_mode FROM lms_quizzes WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  const row = r.recordset && r.recordset[0]; if (!row) return notFound();
  if (row.status !== "draft") return { ok: false, code: "QUIZ_PUBLISHED", errors: ["Random rules can only be changed while the quiz is a draft. Unpublish it first."] };
  return { ok: true, qid, mode: row.quiz_mode || "quiz" };
}
async function totals(pool, courseId, quizId, exceptRuleId = null) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("x", sql.Int, exceptRuleId)
    .query(`SELECT (SELECT COUNT(*) FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL) AS fixed_n,
      (SELECT COUNT(*) FROM lms_quiz_rules WHERE quiz_id = @z AND course_id = @c AND (@x IS NULL OR id <> @x)) AS rule_n,
      (SELECT ISNULL(SUM(pick_count), 0) FROM lms_quiz_rules WHERE quiz_id = @z AND course_id = @c AND (@x IS NULL OR id <> @x)) AS picked_n`);
  const x = (r.recordset && r.recordset[0]) || {}; return { fixed: Number(x.fixed_n || 0), rules: Number(x.rule_n || 0), picked: Number(x.picked_n || 0) };
}
async function outcomeOk(pool, id) {
  if (!id) return true;
  const r = await pool.request().input("o", sql.Int, id).query(`SELECT TOP 1 id FROM lms_learning_outcomes WHERE id = @o AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
}

async function listRules(pool, courseId, quizId) {
  const qid = posInt(quizId); if (qid === null) return notFound();
  const r = await pool.request().input("id", sql.Int, qid).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_quizzes WHERE id = @id AND course_id = @c AND deleted_at IS NULL`);
  if (!(r.recordset && r.recordset.length)) return notFound();
  return { ok: true, rules: await rulesWithPool(pool, courseId, qid) };
}

async function addRule(pool, user, courseId, quizId, body) {
  const v = validateRule(body); if (!v.ok) return v;
  const g = await draftGuard(pool, courseId, quizId); if (!g.ok) return g;
  if (g.mode === "flashcards") return { ok: false, code: "RULES_NOT_FOR_FLASHCARDS", errors: ["A flashcard deck cannot have random rules."] };
  if (!(await outcomeOk(pool, v.value.outcomeId))) return { ok: false, errors: ["That outcome does not exist (it may have been retired)."] };
  const t = await totals(pool, courseId, g.qid);
  if (t.rules >= MAX_RULES) return { ok: false, code: "RULE_LIMIT", errors: [`A quiz can have at most ${MAX_RULES} random rules.`] };
  if (t.fixed + t.picked + v.value.count > MAX_TOTAL) return { ok: false, code: "QUIZ_QUESTION_LIMIT", errors: [`A quiz can have at most ${MAX_TOTAL} questions in total (fixed and random).`] };
  const actor = actorOf(user); const m = { type: null, subject: null, topic: null, difficulty: null, outcomeId: null, ...v.value };
  const r = await pool.request().input("z", sql.Int, g.qid).input("c", sql.Int, courseId).input("n", sql.Int, m.count).input("p", sql.Decimal(6, 2), m.pointsEach)
    .input("ty", sql.NVarChar(20), m.type).input("sj", sql.NVarChar(100), m.subject).input("tp", sql.NVarChar(100), m.topic).input("df", sql.NVarChar(10), m.difficulty).input("o", sql.Int, m.outcomeId)
    .input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @pos INT = (SELECT ISNULL(MAX(position), 0) + 1 FROM lms_quiz_rules WITH (UPDLOCK, HOLDLOCK) WHERE quiz_id = @z AND course_id = @c);
      INSERT INTO lms_quiz_rules (quiz_id, course_id, position, pick_count, points_each, q_type, subject, topic, difficulty, outcome_id, created_by_source, created_by)
        OUTPUT INSERTED.id VALUES (@z, @c, @pos, @n, @p, @ty, @sj, @tp, @df, @o, @src, @uid);
      COMMIT;`);
  const id = r.recordset && r.recordset[0] ? r.recordset[0].id : null;
  await audit(pool, actor, "quiz.rule_added", "lms_quiz_rules", id, { courseId, quizId: g.qid, count: m.count });
  return { ok: true, rules: await rulesWithPool(pool, courseId, g.qid), ruleId: id };
}

async function updateRule(pool, user, courseId, quizId, ruleId, body) {
  const rid = posInt(ruleId); if (rid === null) return notFound("Rule");
  const v = validateRule(body, { partial: true }); if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: false, errors: ["Nothing to change."] };
  const g = await draftGuard(pool, courseId, quizId); if (!g.ok) return g;
  const cur = (await loadRules(pool, courseId, g.qid)).find((x) => x.id === rid); if (!cur) return notFound("Rule");
  const m = { ...cur, ...v.value };
  if (v.value.outcomeId && !(await outcomeOk(pool, v.value.outcomeId))) return { ok: false, errors: ["That outcome does not exist (it may have been retired)."] };
  const t = await totals(pool, courseId, g.qid, rid);
  if (t.fixed + t.picked + m.count > MAX_TOTAL) return { ok: false, code: "QUIZ_QUESTION_LIMIT", errors: [`A quiz can have at most ${MAX_TOTAL} questions in total (fixed and random).`] };
  const r = await pool.request().input("id", sql.Int, rid).input("z", sql.Int, g.qid).input("c", sql.Int, courseId).input("n", sql.Int, m.count).input("p", sql.Decimal(6, 2), m.pointsEach)
    .input("ty", sql.NVarChar(20), m.type).input("sj", sql.NVarChar(100), m.subject).input("tp", sql.NVarChar(100), m.topic).input("df", sql.NVarChar(10), m.difficulty).input("o", sql.Int, m.outcomeId)
    .query(`UPDATE lms_quiz_rules SET pick_count = @n, points_each = @p, q_type = @ty, subject = @sj, topic = @tp, difficulty = @df, outcome_id = @o, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = @id AND quiz_id = @z AND course_id = @c`);
  if (!(r.recordset && r.recordset.length)) return notFound("Rule");
  await audit(pool, actorOf(user), "quiz.rule_updated", "lms_quiz_rules", rid, { courseId, quizId: g.qid, fields: Object.keys(v.value) });
  return { ok: true, rules: await rulesWithPool(pool, courseId, g.qid) };
}

async function deleteRule(pool, user, courseId, quizId, ruleId) {
  const rid = posInt(ruleId); if (rid === null) return notFound("Rule");
  const g = await draftGuard(pool, courseId, quizId); if (!g.ok) return g;
  const r = await pool.request().input("id", sql.Int, rid).input("z", sql.Int, g.qid).input("c", sql.Int, courseId).query(`DELETE FROM lms_quiz_rules OUTPUT DELETED.id WHERE id = @id AND quiz_id = @z AND course_id = @c`);
  if (!(r.recordset && r.recordset.length)) return notFound("Rule");
  await audit(pool, actorOf(user), "quiz.rule_removed", "lms_quiz_rules", rid, { courseId, quizId: g.qid });
  return { ok: true, rules: await rulesWithPool(pool, courseId, g.qid) };
}

/* ------------------------------- per attempt ------------------------------- */
const NOT_ENOUGH = { ok: false, code: "NOT_ENOUGH_QUESTIONS", errors: ["This quiz cannot be started right now: its random question pool is too small. Please tell your teacher. No attempt was used."] };

/* Decide the picks for an attempt seed. Returns { ok:true, items:[{rule, row}] } (full bank rows, in serve order) or NOT_ENOUGH. Writes nothing. */
async function planPicks(pool, courseId, quizId, seed) {
  const rules = await loadRules(pool, courseId, quizId); if (!rules.length) return { ok: true, items: [] };
  const fixed = await fixedSources(pool, courseId, quizId); const idsByRule = new Map();
  for (const rule of rules) idsByRule.set(rule.id, await candidateIds(pool, courseId, rule));
  const p = pickIds(rules, idsByRule, fixed, seed); if (!p.ok) return NOT_ENOUGH;
  const ids = p.picks.map((x) => x.sourceId); const req = pool.request().input("c", sql.Int, courseId); ids.forEach((id, i) => req.input(`i${i}`, sql.Int, id));
  const r = await req.query(`SELECT q.id, q.version, q.type, q.stem, q.explanation, q.difficulty, q.spec_json FROM lms_questions q WHERE ${POOL} AND q.id IN (${ids.map((_, i) => `@i${i}`).join(", ")})`);
  const byId = new Map((r.recordset || []).map((x) => [Number(x.id), x]));
  if (byId.size !== ids.length) return NOT_ENOUGH; // a question vanished between the two reads
  const byRule = new Map(rules.map((x) => [x.id, x]));
  return { ok: true, items: p.picks.map((x) => ({ rule: byRule.get(x.ruleId), row: byId.get(x.sourceId) })) };
}

/* Freeze the picks of ONE attempt. Idempotent: if the attempt already has picked rows nothing is written (a double click, a second tab, or a crash between
   "attempt created" and "picks written" are all repaired by simply calling this again). `plan` may be passed when the caller already made it. */
async function ensurePicks(pool, ctx, attempt, plan = null) {
  if (!ctx.quiz.ruleCount) return { ok: true, count: 0 };
  const have = await pool.request().input("a", sql.Int, attempt.id).input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, ctx.courseId)
    .query(`SELECT TOP 1 id FROM lms_quiz_questions WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c`);
  if (have.recordset && have.recordset.length) return { ok: true, count: 0 };
  const p = plan || (await planPicks(pool, ctx.courseId, ctx.quiz.id, attempt.seed)); if (!p.ok) return p;
  if (!p.items.length) return { ok: true, count: 0 };
  const run = () => {
    const req = pool.request().input("a", sql.Int, attempt.id).input("z", sql.Int, ctx.quiz.id).input("c", sql.Int, ctx.courseId);
    const values = p.items.map(({ rule, row }, i) => {
      req.input(`s${i}`, sql.Int, Number(row.id)).input(`v${i}`, sql.Int, row.version).input(`t${i}`, sql.NVarChar(20), row.type).input(`h${i}`, sql.NVarChar(4000), row.stem).input(`e${i}`, sql.NVarChar(2000), row.explanation || null)
        .input(`p${i}`, sql.Decimal(6, 2), rule.pointsEach).input(`d${i}`, sql.NVarChar(10), row.difficulty || null).input(`j${i}`, sql.NVarChar(sql.MAX), row.spec_json);
      return `(@z, @c, @base + ${i + 1}, @s${i}, @v${i}, @t${i}, @h${i}, @e${i}, @p${i}, @d${i}, @j${i}, @a)`;
    });
    return req.query(`SET XACT_ABORT ON; BEGIN TRAN;
      IF NOT EXISTS (SELECT 1 FROM lms_quiz_questions WITH (UPDLOCK, HOLDLOCK) WHERE attempt_id = @a AND quiz_id = @z AND course_id = @c)
      BEGIN
        DECLARE @base INT = (SELECT ISNULL(MAX(position), 0) FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL);
        INSERT INTO lms_quiz_questions (quiz_id, course_id, position, source_question_id, source_version, type, stem, explanation, points, difficulty, spec_json, attempt_id) VALUES ${values.join(", ")};
      END
      COMMIT;`);
  };
  try { await run(); } catch (e) { if (!isDup(e)) throw e; await run(); } // two simultaneous starts: the loser re-runs and finds the rows
  return { ok: true, count: p.items.length };
}

module.exports = { MAX_RULES, MAX_COUNT, MAX_TOTAL, MAX_CANDIDATES, validateRule, pickIds, ruleModel, loadRules, rulesWithPool, poolProblem, listRules, addRule, updateRule, deleteRule, planPicks, ensurePicks, NOT_ENOUGH };
