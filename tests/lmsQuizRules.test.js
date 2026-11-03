/* L6.2c - random selection from the question bank: rule validation, pure seeded picking, rule CRUD (draft only), publish pool check, picks FROZEN per attempt
   (start, resume, crash repair, too-small pool uses no attempt, bank edits never change a started attempt), grading reads the attempt's own picks, routes, schema 028.
   Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsQuizRules.test.js");
const R = require("../utils/lmsQuizRules");
const A = require("../utils/lmsQuizAttempts");
const Z = require("../utils/lmsQuizzes");
const G = require("../utils/lmsQuizGrading");
const schema = require("../utils/lmsSchema");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = (id = 21) => ({ id, role: "student", source: "Students" });
const T0 = new Date("2026-11-02T10:00:00Z");
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));
const sqlAll = (m, re) => m.log.filter((x) => re.test(x.sql));
const json = (o) => JSON.stringify(o);

/* ---------------- fixtures: course 5, quiz 4 = 1 fixed true/false (2 pts, from bank question 100) + rule 9 "2 true/false questions, 4 points each" ---------------- */
const TF = (correct = true) => json({ correct });
const bankRow = (id, o = {}) => ({ id, version: 3, type: "true_false", stem: `Bank question ${id}`, explanation: `Why ${id}`, difficulty: "easy", spec_json: TF(true), ...o });
const ruleRow = (o = {}) => ({ id: 9, position: 1, pick_count: 2, points_each: "4.00", q_type: "true_false", subject: null, topic: null, difficulty: null, outcome_id: null, ...o });
const quizRow = (o = {}) => ({ id: 4, course_id: 5, title: "Random quiz", instructions: null, assessment_type: "practice", available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 3, shuffle_questions: 0, shuffle_options: 0,
  feedback_timing: "immediate", counts_to_grade: 0, question_count: 3, total_points: "10.00", rule_count: 1, course_status: "published", ...o });
const fixedQ = () => ({ id: 1, position: 1, attempt_id: null, source_question_id: 100, type: "true_false", stem: "Fixed question", explanation: "", points: "2.00", spec_json: TF(true) });

function world(o = {}) {
  const st = { quiz: quizRow(o.quiz), rules: o.rules || [ruleRow()], questions: [fixedQ(), ...(o.extraQuestions || [])], bank: new Map((o.bankIds || [201, 202, 203, 204]).map((id) => [id, bankRow(id)])), poolIds: o.poolIds || [201, 202, 203, 204],
    attempts: (o.attempts || []).map((x) => ({ ...x })), answers: [], nextId: 70, nextQ: 500, dupOnQInsert: o.dupOnQInsert || false, qInserts: 0 };
  const mine = (i) => st.attempts.filter((a) => a.student_id === i.s && a.course_id === i.c && a.quiz_id === i.z);
  const attRow = (x) => ({ id: 70, quiz_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "in_progress", seed: "abcd1234abcd1234", started_at: T0.toISOString(), deadline_at: null, submitted_at: null, auto_submitted: 0, auto_points: null, manual_points: null, total_points: null, max_points: "10.00", needs_marking: 0, ...x });
  const rs = [
    ["FROM lms_quizzes z JOIN lms_courses c", (i) => (i.c === 5 && i.id === 4 ? [st.quiz] : [])],
    ["FROM lms_quiz_rules WHERE quiz_id = @z AND course_id = @c ORDER BY position", (i) => (i.z === 4 && i.c === 5 ? st.rules : [])],
    ["SELECT source_question_id FROM lms_quiz_questions WHERE quiz_id = @z", (i) => (i.z === 4 && i.c === 5 ? st.questions.filter((q) => q.attempt_id === null && q.source_question_id).map((q) => ({ source_question_id: q.source_question_id })) : [])],
    ["SELECT TOP 5000 q.id FROM lms_questions q", () => st.poolIds.map((id) => ({ id }))],
    ["SELECT q.id, q.version, q.type, q.stem", (i) => { const out = []; let k = 0; while (`i${k}` in i) { const b = st.bank.get(i[`i${k}`]); if (b && st.poolIds.includes(b.id)) out.push(b); k += 1; } return out; }],
    ["SELECT TOP 1 id FROM lms_quiz_questions WHERE attempt_id = @a", (i) => st.questions.filter((q) => q.attempt_id === i.a).slice(0, 1).map((q) => ({ id: q.id }))],
    ["INSERT INTO lms_quiz_questions", (i) => {
      if (st.dupOnQInsert) { st.dupOnQInsert = false; const e = new Error("dup"); e.number = 2601; throw e; }
      if (st.questions.some((q) => q.attempt_id === i.a)) return []; // the IF NOT EXISTS guard of the real SQL
      st.qInserts += 1; const base = Math.max(...st.questions.filter((q) => q.attempt_id === null).map((q) => q.position));
      let k = 0; while (`s${k}` in i) { st.questions.push({ id: st.nextQ++, position: base + k + 1, attempt_id: i.a, source_question_id: i[`s${k}`], source_version: i[`v${k}`], type: i[`t${k}`], stem: i[`h${k}`], explanation: i[`e${k}`] || "", points: String(i[`p${k}`]), spec_json: i[`j${k}`] }); k += 1; }
      return [];
    }],
    ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position", (i) => (i.z === 4 && i.c === 5 ? st.questions.filter((q) => q.attempt_id === null || q.attempt_id === i.att) : [])],
    ["FROM lms_quiz_answers WHERE attempt_id = @a", (i) => st.answers.filter((x) => x.attempt_id === i.a && i.s === 21)],
    [`${"attempt_no, status, seed, started_at, deadline_at, submitted_at, auto_submitted, auto_points, manual_points, total_points, max_points, needs_marking"} FROM lms_quiz_attempts WHERE id = @a`, (i) => st.attempts.filter((a) => a.id === i.a && a.quiz_id === i.z && a.course_id === i.c && a.student_id === i.s)],
    ["FROM lms_quiz_attempts WHERE quiz_id = @z AND course_id = @c AND student_id = @s AND status = 'in_progress'", (i) => mine(i).filter((a) => a.status === "in_progress")],
    ["GROUP BY quiz_id, status", () => []],
    ["INSERT INTO lms_quiz_attempts", (i) => { const n = mine(i).length; if (n >= i.max) return []; const row = attRow({ id: st.nextId++, attempt_no: n + 1, seed: i.seed, started_at: i.now.toISOString(), deadline_at: null, max_points: String(i.mp) }); st.attempts.push(row); return [row]; }],
    ["UPDATE lms_quiz_attempts SET status = @st", (i) => {
      const a = st.attempts.find((x) => x.id === i.a && x.student_id === i.s && x.status === "in_progress"); if (!a) return [{ claimed: 0 }];
      Object.assign(a, { status: i.st, submitted_at: i.sub.toISOString(), auto_points: i.ap, total_points: i.tp, max_points: i.mp, needs_marking: i.nm ? 1 : 0 });
      let k = 0; while (`q${k}` in i) { st.answers = st.answers.filter((x) => !(x.attempt_id === a.id && x.quiz_question_id === i[`q${k}`])); st.answers.push({ attempt_id: a.id, quiz_question_id: i[`q${k}`], answer_json: i[`j${k}`], status: i[`t${k}`], points: i[`p${k}`], max_points: i[`x${k}`] }); k += 1; }
      return [{ claimed: 1 }];
    }],
  ];
  return { st, m: makeMockPool(rs) };
}
const ids = (view) => view.questions.map((q) => q.id);

/* ====================================== pure ====================================== */
test("validateRule: count 1-50, pointsEach REQUIRED 0.01-100 with 2 decimals, optional filters checked, unknown fields refused; PATCH checks only what is sent", () => {
  const ok = R.validateRule({ count: "3", pointsEach: 2.5, type: "mcq_single", difficulty: "hard", subject: "  <b>Maths</b> ", topic: null, outcomeId: "12" });
  assert.ok(ok.ok, json(ok.errors)); assert.deepStrictEqual(ok.value, { count: 3, pointsEach: 2.5, type: "mcq_single", difficulty: "hard", subject: "bMaths/b", topic: null, outcomeId: 12 });
  for (const bad of [{}, { count: 1 }, { pointsEach: 1 }, { count: 0, pointsEach: 1 }, { count: 51, pointsEach: 1 }, { count: 1.5, pointsEach: 1 }, { count: 1, pointsEach: 0 }, { count: 1, pointsEach: 100.01 }, { count: 1, pointsEach: 1.234 }, { count: 1, pointsEach: "abc" },
    { count: 1, pointsEach: 1, type: "poem" }, { count: 1, pointsEach: 1, difficulty: "extreme" }, { count: 1, pointsEach: 1, outcomeId: "x" }, { count: 1, pointsEach: 1, subject: "s".repeat(101) }, { count: 1, pointsEach: 1, subject: 5 }, { count: 1, pointsEach: 1, extra: 1 }, null, []]) {
    assert.strictEqual(R.validateRule(bad).ok, false, json(bad));
  }
  assert.ok(R.validateRule({ count: 4 }, { partial: true }).ok, "partial: only what is sent"); assert.strictEqual(R.validateRule({ pointsEach: 0 }, { partial: true }).ok, false);
});

test("pickIds: reproducible for one seed, independent of candidate order, never repeats a question (across rules and the fixed set), honours counts, reports a short pool", () => {
  const rules = [{ id: 1, count: 3 }, { id: 2, count: 2 }]; const pool1 = [10, 11, 12, 13, 14, 15, 16, 17], pool2 = [14, 15, 16, 17, 18, 19];
  const a = R.pickIds(rules, new Map([[1, pool1], [2, pool2]]), [], "seed-A"), b = R.pickIds(rules, new Map([[1, [...pool1].reverse()], [2, [...pool2].reverse()]]), [], "seed-A");
  assert.ok(a.ok && b.ok); assert.deepStrictEqual(a.picks, b.picks, "same seed = same picks, whatever order the database returned");
  assert.deepStrictEqual([a.picks.filter((p) => p.ruleId === 1).length, a.picks.filter((p) => p.ruleId === 2).length], [3, 2]);
  assert.strictEqual(new Set(a.picks.map((p) => p.sourceId)).size, 5, "no question picked twice even though the pools overlap");
  assert.ok(a.picks.filter((p) => p.ruleId === 1).every((p) => pool1.includes(p.sourceId)) && a.picks.filter((p) => p.ruleId === 2).every((p) => pool2.includes(p.sourceId)));
  const seeds = new Set(); for (let i = 0; i < 12; i += 1) seeds.add(json(R.pickIds(rules, new Map([[1, pool1], [2, pool2]]), [], `seed-${i}`).picks)); assert.ok(seeds.size > 3, "different attempts get different papers");
  const fx = R.pickIds([{ id: 1, count: 2 }], new Map([[1, [1, 2, 3]]]), [1], "s"); assert.ok(fx.ok); assert.deepStrictEqual(fx.picks.map((p) => p.sourceId).sort(), [2, 3], "a question already in the fixed set is never picked");
  const short = R.pickIds([{ id: 7, count: 3 }], new Map([[7, [1, 2, 3]]]), [1], "s"); assert.deepStrictEqual([short.ok, short.ruleId, short.have, short.need], [false, 7, 2, 3]);
  assert.deepStrictEqual(R.pickIds([], new Map(), [], "s"), { ok: true, picks: [] });
});

/* ====================================== rule CRUD ====================================== */
const draft = (o = {}) => ["FROM lms_quizzes WHERE id = @id AND course_id = @c AND deleted_at IS NULL", (i) => (i.id === 4 && i.c === 5 ? [{ id: 4, status: "draft", ...o }] : [])];
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const tot = (fixed = 1, rules = 0, picked = 0) => ["SELECT (SELECT COUNT(*) FROM lms_quiz_questions WHERE quiz_id = @z", () => [{ fixed_n: fixed, rule_n: rules, picked_n: picked }]];

test("addRule: draft only; inserts with position under a lock; limits (10 rules, 100 questions); unknown outcome; archived/other course/published refused; audited", async () => {
  const ok = makeMockPool([live(), draft(), tot(1, 0, 0), ["INSERT INTO lms_quiz_rules", () => [{ id: 31 }]], ["FROM lms_quiz_rules WHERE quiz_id = @z", () => []], ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL", () => []], ["INSERT INTO lms_audit_log", () => []]]);
  const r = await R.addRule(ok.pool, teacher, 5, 4, { count: 2, pointsEach: 4, type: "true_false" }); assert.ok(r.ok, json(r)); assert.strictEqual(r.ruleId, 31);
  const w = sqlOf(ok, /INSERT INTO lms_quiz_rules/); assert.ok(w && /UPDLOCK, HOLDLOCK/.test(w.sql) && /BEGIN TRAN/.test(w.sql), "position is taken under a lock"); assert.deepStrictEqual([w.inputs.z, w.inputs.c, w.inputs.n, w.inputs.p, w.inputs.ty], [4, 5, 2, 4, "true_false"]);
  assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql) && /quiz\.rule_added/.test(JSON.stringify(x.inputs))), "audited");
  const many = await R.addRule(makeMockPool([live(), draft(), tot(1, 10, 10)]).pool, teacher, 5, 4, { count: 1, pointsEach: 1 }); assert.deepStrictEqual([many.ok, many.code], [false, "RULE_LIMIT"]);
  const big = await R.addRule(makeMockPool([live(), draft(), tot(60, 1, 30)]).pool, teacher, 5, 4, { count: 11, pointsEach: 1 }); assert.deepStrictEqual([big.ok, big.code], [false, "QUIZ_QUESTION_LIMIT"], "60 + 30 + 11 > 100");
  const exact = await R.addRule(makeMockPool([live(), draft(), tot(60, 1, 30), ["INSERT INTO lms_quiz_rules", () => [{ id: 2 }]]]).pool, teacher, 5, 4, { count: 10, pointsEach: 1 }); assert.ok(exact.ok, "exactly 100 is allowed");
  const noOut = await R.addRule(makeMockPool([live(), draft(), ["FROM lms_learning_outcomes WHERE id = @o", () => []]]).pool, teacher, 5, 4, { count: 1, pointsEach: 1, outcomeId: 77 }); assert.strictEqual(noOut.ok, false);
  const pub = await R.addRule(makeMockPool([live(), draft({ status: "published" })]).pool, teacher, 5, 4, { count: 1, pointsEach: 1 }); assert.deepStrictEqual([pub.ok, pub.code], [false, "QUIZ_PUBLISHED"]);
  const arch = await R.addRule(makeMockPool([live("archived"), draft()]).pool, teacher, 5, 4, { count: 1, pointsEach: 1 }); assert.deepStrictEqual([arch.ok, arch.code], [false, "COURSE_ARCHIVED"]);
  const other = await R.addRule(makeMockPool([live(), draft()]).pool, teacher, 5, 99, { count: 1, pointsEach: 1 }); assert.strictEqual(other.notFound, true, "a quiz of another course/id is not found");
  const badBody = await R.addRule(makeMockPool([]).pool, teacher, 5, 4, { count: 0 }); assert.strictEqual(badBody.ok, false);
});

test("updateRule merges onto the stored rule and re-checks the total (without counting itself); deleteRule is scoped to quiz + course; both draft only; 404 for another quiz's rule", async () => {
  const up = makeMockPool([live(), draft(), tot(5, 1, 90), ["FROM lms_quiz_rules WHERE quiz_id = @z AND course_id = @c ORDER BY position", () => [ruleRow()]], ["UPDATE lms_quiz_rules SET", () => [{ id: 9 }]], ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL", () => []]]);
  const r = await R.updateRule(up.pool, teacher, 5, 4, 9, { count: 5 }); assert.ok(r.ok, json(r));
  const u = sqlOf(up, /^UPDATE lms_quiz_rules SET/); assert.deepStrictEqual([u.inputs.n, u.inputs.p, u.inputs.ty, u.inputs.id, u.inputs.z, u.inputs.c], [5, 4, "true_false", 9, 4, 5], "count changed, everything else kept"); assert.ok(/WHERE id = @id AND quiz_id = @z AND course_id = @c/.test(u.sql));
  assert.strictEqual(sqlOf(up, /SELECT \(SELECT COUNT\(\*\) FROM lms_quiz_questions WHERE quiz_id = @z/).inputs.x, 9, "the rule being edited is left out of the total");
  const over = await R.updateRule(makeMockPool([live(), draft(), tot(5, 1, 96), ["FROM lms_quiz_rules WHERE quiz_id = @z", () => [ruleRow()]]]).pool, teacher, 5, 4, 9, { count: 10 }); assert.strictEqual(over.code, "QUIZ_QUESTION_LIMIT");
  assert.strictEqual((await R.updateRule(makeMockPool([live(), draft(), ["FROM lms_quiz_rules WHERE quiz_id = @z", () => [ruleRow()]]]).pool, teacher, 5, 4, 55, { count: 2 })).notFound, true);
  assert.strictEqual((await R.updateRule(makeMockPool([]).pool, teacher, 5, 4, 9, {})).ok, false, "nothing to change");
  const del = makeMockPool([live(), draft(), ["DELETE FROM lms_quiz_rules OUTPUT", (i) => (i.id === 9 && i.z === 4 && i.c === 5 ? [{ id: 9 }] : [])], ["FROM lms_quiz_rules WHERE quiz_id = @z", () => []]]);
  assert.ok((await R.deleteRule(del.pool, teacher, 5, 4, 9)).ok); assert.ok(/WHERE id = @id AND quiz_id = @z AND course_id = @c/.test(sqlOf(del, /^DELETE FROM lms_quiz_rules/).sql));
  assert.strictEqual((await R.deleteRule(makeMockPool([live(), draft(), ["DELETE FROM lms_quiz_rules OUTPUT", () => []]]).pool, teacher, 5, 4, 8)).notFound, true);
  assert.strictEqual((await R.deleteRule(makeMockPool([live(), draft({ status: "published" })]).pool, teacher, 5, 4, 9)).code, "QUIZ_PUBLISHED");
});

test("listRules: each rule shows how many questions its pool holds (fixed-set questions excluded) and whether that is enough; the pool is school + THIS course, never private", async () => {
  const m = makeMockPool([["FROM lms_quizzes WHERE id = @id AND course_id = @c AND deleted_at IS NULL", () => [{ id: 4 }]], ["FROM lms_quiz_rules WHERE quiz_id = @z", () => [ruleRow({ id: 1, pick_count: 3 }), ruleRow({ id: 2, position: 2, pick_count: 1, difficulty: "hard", outcome_id: 6 })]],
    ["SELECT source_question_id FROM lms_quiz_questions", () => [{ source_question_id: 100 }]], ["SELECT TOP 5000 q.id FROM lms_questions q", (i) => (i.fd0 === "hard" ? [{ id: 100 }] : [{ id: 100 }, { id: 201 }, { id: 202 }])]]);
  const r = await R.listRules(m.pool, 5, 4); assert.ok(r.ok);
  assert.deepStrictEqual(r.rules.map((x) => [x.id, x.count, x.available, x.enough]), [[1, 3, 2, false], [2, 1, 0, false]], "question 100 is in the fixed set, so it is not available to the rules");
  const c = sqlAll(m, /SELECT TOP 5000 q\.id/); assert.strictEqual(c.length, 2); for (const q of c) { assert.ok(/q\.deleted_at IS NULL AND \(q\.scope = 'school' OR \(q\.scope = 'course' AND q\.course_id = @c\)\)/.test(q.sql) && !/private/.test(q.sql), q.sql); assert.strictEqual(q.inputs.c, 5); }
  assert.ok(/EXISTS \(SELECT 1 FROM lms_outcome_tags t WHERE t\.entity_type = 'question' AND t\.entity_id = q\.id AND t\.outcome_id = @fo0\)/.test(c[1].sql) && c[1].inputs.fo0 === 6 && /q\.difficulty = @fd0/.test(c[1].sql));
  assert.strictEqual((await R.listRules(makeMockPool([["FROM lms_quizzes WHERE id = @id", () => []]]).pool, 5, 4)).notFound, true);
});

/* ====================================== publish ====================================== */
test("publishing: a quiz made only of rules can be published (the count includes rules); a rule whose pool is too small blocks it with RULE_POOL_TOO_SMALL; no rules = no pool check", async () => {
  const row = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Q", instructions: null, assessment_type: "practice", status: "draft", published_at: null, available_from: null, due_at: null, time_limit_minutes: null, max_attempts: 1, shuffle_questions: 0, shuffle_options: 0,
    feedback_timing: "immediate", counts_to_grade: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", question_count: 2, total_points: "8.00", rule_count: 1, ...o });
  const loadq = (r) => ["FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c", () => [r]];
  const rules = (n, hard = false) => [["FROM lms_quiz_rules WHERE quiz_id = @z", () => [ruleRow({ pick_count: n })]], ["SELECT source_question_id FROM lms_quiz_questions", () => []], ["SELECT TOP 5000 q.id FROM lms_questions q", () => [{ id: 201 }, { id: 202 }]]];
  const ok = makeMockPool([live(), loadq(row()), ["FROM lms_quiz_attempts WHERE quiz_id = @q", () => []], ["UPDATE lms_quizzes SET", () => []], ...rules(2), ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []]]);
  const r1 = await Z.updateQuiz(ok.pool, teacher, 5, 4, { status: "published" }, { tenant: "qr-1" }); assert.ok(r1.ok, json(r1)); assert.ok(sqlOf(ok, /^UPDATE lms_quizzes SET/), "published");
  const bad = makeMockPool([live(), loadq(row()), ...rules(3)]); const r2 = await Z.updateQuiz(bad.pool, teacher, 5, 4, { status: "published" }, { tenant: "qr-2" });
  assert.deepStrictEqual([r2.ok, r2.code], [false, "RULE_POOL_TOO_SMALL"]); assert.ok(/needs 3 questions but only 2 match/.test(r2.errors[0]), r2.errors[0]); assert.ok(!sqlOf(bad, /^UPDATE lms_quizzes SET/), "nothing was published");
  const none = makeMockPool([live(), loadq(row({ rule_count: 0, question_count: 2 })), ["FROM lms_quiz_attempts WHERE quiz_id = @q", () => []], ["UPDATE lms_quizzes SET", () => []], ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []]]);
  assert.ok((await Z.updateQuiz(none.pool, teacher, 5, 4, { status: "published" }, { tenant: "qr-3" })).ok); assert.ok(!sqlOf(none, /FROM lms_quiz_rules WHERE/), "a quiz without rules never reads the rules for a pool check");
  const empty = makeMockPool([live(), loadq(row({ rule_count: 0, question_count: 0 }))]); assert.strictEqual((await Z.updateQuiz(empty.pool, teacher, 5, 4, { status: "published" })).code, "NO_QUESTIONS");
});

test("the quiz summary SQL counts fixed questions + rules, and the definition queries read only the fixed set (attempt_id IS NULL)", async () => {
  const m = makeMockPool([["FROM lms_quizzes z WHERE z.id = @id AND z.course_id = @c", () => [{ id: 4, course_id: 5, title: "Q", instructions: null, assessment_type: "practice", status: "draft", max_attempts: 1, feedback_timing: "immediate", question_count: 3, total_points: "10", rule_count: 1 }]],
    ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []], ["FROM lms_quiz_rules WHERE quiz_id = @z", () => [ruleRow()]]]);
  const g = await Z.getQuiz(m.pool, 5, 4); assert.ok(g.ok); assert.deepStrictEqual([g.quiz.questionCount, g.quiz.totalPoints, g.quiz.ruleCount, g.quiz.rules.length, g.quiz.rules[0].pointsEach], [3, 10, 1, 1, 4]);
  const head = sqlOf(m, /FROM lms_quizzes z WHERE z\.id = @id/).sql; assert.ok(/k\.attempt_id IS NULL\) \+ \(SELECT ISNULL\(SUM\(r\.pick_count\), 0\) FROM lms_quiz_rules r WHERE r\.quiz_id = z\.id\)/.test(head) && /SUM\(r\.pick_count \* r\.points_each\)/.test(head), head);
  assert.ok(/AND attempt_id IS NULL ORDER BY position/.test(sqlOf(m, /FROM lms_quiz_questions WHERE quiz_id = @id/).sql));
  const plain = makeMockPool([["FROM lms_quizzes z WHERE z.id = @id", () => [{ id: 4, course_id: 5, title: "Q", instructions: null, assessment_type: "practice", status: "draft", max_attempts: 1, feedback_timing: "immediate", question_count: 1, total_points: "2", rule_count: 0 }]], ["FROM lms_quiz_questions WHERE quiz_id = @id", () => []]]);
  const g2 = await Z.getQuiz(plain.pool, 5, 4); assert.ok(g2.ok && g2.quiz.rules === undefined && !sqlOf(plain, /FROM lms_quiz_rules WHERE/), "no rules, no extra query");
  /* a picked row (attempt_id set) can never be removed, reordered or counted as a duplicate by the definition editor */
  const rm = makeMockPool([live(), ["FROM lms_quizzes z WHERE z.id = @id", () => [{ id: 4, course_id: 5, status: "draft", question_count: 1, total_points: "2", rule_count: 0, max_attempts: 1, feedback_timing: "immediate", title: "Q", assessment_type: "practice" }]], ["DELETE FROM lms_quiz_questions OUTPUT", () => []]]);
  const add = makeMockPool([live(), ["FROM lms_quizzes z WHERE z.id = @id", () => [{ id: 4, course_id: 5, status: "draft", question_count: 1, total_points: "2", rule_count: 0, max_attempts: 1, feedback_timing: "immediate", title: "Q", assessment_type: "practice" }]],
    ["FROM lms_questions q WHERE q.id IN", () => [{ id: 11, scope: "school", course_id: null, owner_source: "Teachers", owner_id: 2, type: "true_false", stem: "Is it?", explanation: "", points: "2.00", difficulty: "easy", subject: null, topic: null, spec_json: TF(true), version: 1 }]],
    ["SELECT source_question_id FROM lms_quiz_questions", () => []]]);
  const added = await Z.addQuestions(add.pool, teacher, 5, 4, { questionIds: [11] }, {}); assert.ok(added.ok, json(added));
  assert.ok(/course_id = @c AND attempt_id IS NULL AND source_question_id IS NOT NULL/.test(sqlOf(add, /^SELECT source_question_id FROM lms_quiz_questions/).sql), "the duplicate check looks at the fixed set only, so a question picked for some attempt never blocks adding it");
  assert.ok(/MAX\(position\), 0\) FROM lms_quiz_questions WITH \(UPDLOCK, HOLDLOCK\) WHERE quiz_id = @q AND attempt_id IS NULL/.test(sqlOf(add, /INSERT INTO lms_quiz_questions/).sql), "new fixed questions are numbered after the fixed set only");
  const ord = makeMockPool([live(), ["FROM lms_quizzes z WHERE z.id = @id", () => [{ id: 4, course_id: 5, status: "draft", question_count: 1, total_points: "2", rule_count: 0, max_attempts: 1, feedback_timing: "immediate", title: "Q", assessment_type: "practice" }]], ["SELECT id FROM lms_quiz_questions WHERE quiz_id = @q", () => [{ id: 1 }]]]);
  await Z.reorderQuestions(ord.pool, teacher, 5, 4, { ids: [1] }); assert.ok(/AND attempt_id IS NULL/.test(sqlOf(ord, /^SELECT id FROM lms_quiz_questions WHERE quiz_id = @q/).sql) && /END WHERE quiz_id = @q AND course_id = @c AND attempt_id IS NULL/.test(sqlOf(ord, /^UPDATE lms_quiz_questions SET position/).sql));
  await Z.removeQuestion(rm.pool, teacher, 5, 4, 501); assert.ok(/course_id = @c AND attempt_id IS NULL/.test(sqlOf(rm, /^DELETE FROM lms_quiz_questions/).sql));
});

/* ====================================== attempts ====================================== */
test("start: the picks are decided first, the attempt is created, then the picks are FROZEN as snapshot rows of THIS attempt (rule points, bank version, positions after the fixed set); the learner sees fixed + picked with no answer key", async () => {
  const w = world(); const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0, tenant: "qr-s1" }); assert.ok(r.ok, json(r)); assert.strictEqual(r.created, true);
  assert.strictEqual(r.attempt.questions.length, 3, "1 fixed + 2 random");
  const frozen = w.st.questions.filter((q) => q.attempt_id !== null); assert.strictEqual(frozen.length, 2); assert.ok(frozen.every((q) => q.attempt_id === r.attempt.id));
  assert.deepStrictEqual(frozen.map((q) => q.position), [2, 3], "picked questions follow the fixed set"); assert.ok(frozen.every((q) => Number(q.points) === 4 && q.source_version === 3), "worth the RULE's points; version snapshot kept");
  assert.ok(frozen.every((q) => [201, 202, 203, 204].includes(q.source_question_id)) && frozen[0].source_question_id !== frozen[1].source_question_id);
  const att = sqlOf(w.m, /INSERT INTO lms_quiz_attempts/); assert.strictEqual(att.inputs.mp, 10, "attempt max = fixed 2 + 2 x 4");
  const order = w.m.log.map((x) => x.sql.slice(0, 40)); assert.ok(order.findIndex((s) => /SELECT TOP 5000/.test(s)) < order.findIndex((s) => /INSERT INTO lms_quiz_attempts/.test(s)) && order.findIndex((s) => /INSERT INTO lms_quiz_attempts/.test(s)) < order.findIndex((s) => /INSERT INTO lms_quiz_questions|SET XACT_ABORT/.test(s) && /lms_quiz_questions/.test(w.m.log[order.indexOf(s)].sql)), "plan, then attempt, then freeze");
  const raw = json(r.attempt); assert.ok(!/"correct"|explanation|Why \d+/.test(raw), "no key or explanation while in progress");
  const ins = sqlOf(w.m, /INSERT INTO lms_quiz_questions/); assert.ok(/IF NOT EXISTS \(SELECT 1 FROM lms_quiz_questions WITH \(UPDLOCK, HOLDLOCK\) WHERE attempt_id = @a/.test(ins.sql) && /@base \+ 1/.test(ins.sql) && /@base \+ 2/.test(ins.sql) && /, @a\)/.test(ins.sql), ins.sql);
});

test("resume: starting again shows the SAME questions and writes nothing new; a start that died before its picks were written is repaired on the next call using the attempt's own seed", async () => {
  const w = world(); const a = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); const b = await A.startAttempt(w.m.pool, student(), 5, 4, { now: new Date(T0.getTime() + 5000) });
  assert.ok(b.ok && b.created === false); assert.deepStrictEqual(ids(b.attempt), ids(a.attempt), "same questions"); assert.strictEqual(w.st.qInserts, 1, "frozen once");
  assert.strictEqual(sqlAll(w.m, /INSERT INTO lms_quiz_attempts/).length, 1);
  assert.strictEqual(sqlAll(w.m, /SELECT TOP 5000/).length, 1, "resuming does not re-read the pool or re-plan: the picks already exist");
  const crashed = world({ attempts: [{ id: 70, quiz_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "in_progress", seed: "feedfeedfeedfeed", started_at: T0.toISOString(), deadline_at: null, submitted_at: null, auto_submitted: 0, auto_points: null, manual_points: null, total_points: null, max_points: "10.00", needs_marking: 0 }] });
  const rep = await A.startAttempt(crashed.m.pool, student(), 5, 4, { now: T0 }); assert.ok(rep.ok, json(rep)); assert.strictEqual(rep.attempt.id, 70); assert.strictEqual(rep.attempt.questions.length, 3, "repaired: picks written now");
  assert.strictEqual(crashed.st.qInserts, 1); const again = await A.getAttempt(crashed.m.pool, student(), 5, 4, 70, { now: T0 }); assert.deepStrictEqual(ids(again.attempt), ids(rep.attempt));
  const expect = R.pickIds([{ id: 9, count: 2 }], new Map([[9, [201, 202, 203, 204]]]), [100], "feedfeedfeedfeed").picks.map((p) => p.sourceId).sort();
  assert.deepStrictEqual(crashed.st.questions.filter((q) => q.attempt_id === 70).map((q) => q.source_question_id).sort(), expect, "the repair re-derives the picks from the attempt seed");
});

test("two simultaneous starts: the loser's insert hits the unique index (2601), re-runs and finds the rows (idempotent freeze)", async () => {
  const w = world({ dupOnQInsert: true }); const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); assert.ok(r.ok, json(r)); assert.strictEqual(r.attempt.questions.length, 3); assert.strictEqual(w.st.qInserts, 1);
  const hard = world(); hard.m = makeMockPool([["INSERT INTO lms_quiz_questions", () => { const e = new Error("other"); e.number = 547; throw e; }], ["FROM lms_quizzes z JOIN lms_courses c", () => [quizRow()]], ["FROM lms_quiz_rules WHERE", () => [ruleRow()]], ["SELECT source_question_id", () => []], ["SELECT TOP 5000", () => [{ id: 201 }, { id: 202 }]], ["SELECT q.id, q.version", (i) => [bankRow(i.i0), bankRow(i.i1)]],
    ["INSERT INTO lms_quiz_attempts", () => [{ id: 70, quiz_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "in_progress", seed: "s", started_at: T0.toISOString(), deadline_at: null, submitted_at: null, auto_submitted: 0, max_points: "10", needs_marking: 0 }]], ["SELECT TOP 1 id FROM lms_quiz_questions WHERE attempt_id", () => []]]);
  let threw = false; try { await A.startAttempt(hard.m.pool, student(), 5, 4, { now: T0 }); } catch (e) { threw = e.number === 547; } assert.ok(threw, "other database errors are not swallowed");
});

test("a pool smaller than the rule's count: 409 NOT_ENOUGH_QUESTIONS, NO attempt is created or used up, nothing is frozen", async () => {
  for (const poolIds of [[201], []]) {
    const w = world({ poolIds }); const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); assert.deepStrictEqual([r.ok, r.code], [false, "NOT_ENOUGH_QUESTIONS"]);
    assert.strictEqual(sqlAll(w.m, /INSERT INTO lms_quiz_attempts/).length, 0, "no attempt row"); assert.strictEqual(w.st.attempts.length, 0); assert.strictEqual(w.st.qInserts, 0);
  }
  const gone = world({ poolIds: [201, 202] }); gone.st.bank.delete(202); // pool = exactly the 2 needed, so 202 is always picked const g = await A.startAttempt(gone.m.pool, student(), 5, 4, { now: T0 }); assert.strictEqual(g.code, "NOT_ENOUGH_QUESTIONS", "a question deleted between the id read and the row read");
  assert.strictEqual(gone.st.attempts.length, 0);
  const fixedOnly = world({ rules: [], quiz: { rule_count: 0, question_count: 1, total_points: "2.00" } }); const f = await A.startAttempt(fixedOnly.m.pool, student(), 5, 4, { now: T0 }); assert.ok(f.ok && f.attempt.questions.length === 1, "a quiz without rules behaves exactly as before");
  assert.strictEqual(sqlAll(fixedOnly.m, /FROM lms_quiz_rules WHERE|SELECT TOP 5000|INSERT INTO lms_quiz_questions/).length, 0, "no rule queries for a plain quiz");
});

test("frozen: a bank edit or delete after the attempt started changes nothing the learner sees or is marked on; picks of one attempt never show in another attempt", async () => {
  const w = world(); const a = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); const picked = w.st.questions.filter((q) => q.attempt_id === a.attempt.id);
  const srcId = picked[0].source_question_id; w.st.bank.set(srcId, bankRow(srcId, { stem: "EDITED IN BANK", spec_json: TF(false), version: 4 })); w.st.poolIds = w.st.poolIds.filter((id) => id !== picked[1].source_question_id);
  const again = await A.getAttempt(w.m.pool, student(), 5, 4, a.attempt.id, { now: T0 }); assert.ok(again.attempt.questions.some((q) => q.stem === `Bank question ${srcId}`) && !again.attempt.questions.some((q) => /EDITED/.test(q.stem)));
  assert.strictEqual(again.attempt.questions.length, 3, "a deleted bank question does not shrink a started attempt");
  w.st.questions.push({ id: 900, position: 2, attempt_id: 4242, source_question_id: 555, type: "true_false", stem: "SOMEONE ELSE'S PICK", explanation: "", points: "4.00", spec_json: TF(true) });
  const view = await A.getAttempt(w.m.pool, student(), 5, 4, a.attempt.id, { now: T0 }); assert.ok(!json(view.attempt).includes("SOMEONE ELSE"), "another attempt's picks are never loaded");
  const q = sqlOf(w.m, /\(attempt_id IS NULL OR attempt_id = @att\)/); assert.strictEqual(q.inputs.att, a.attempt.id);
  /* answer the picked questions correctly (frozen spec: true) and submit: auto-marked with the rule's points */
  const answers = {}; for (const x of view.attempt.questions) answers[x.id] = { selected: true };
  const done = await A.submitAttempt(w.m.pool, student(), 5, 4, a.attempt.id, { answers }, { now: new Date(T0.getTime() + 60000), tenant: "qr-f1" }); assert.ok(done.ok, json(done));
  assert.deepStrictEqual([done.attempt.status, done.attempt.score.points, done.attempt.score.max, done.attempt.questions.length], ["graded", 10, 10, 3], "2 + 4 + 4 of 10; the edited bank question did not change the marked spec");
  assert.deepStrictEqual(done.attempt.questions.map((x) => x.maxPoints).sort(), [2, 4, 4]);
});

test("two learners get their own papers (picked per attempt seed) and each paper is internally stable", async () => {
  const seen = new Set();
  for (let n = 0; n < 8; n += 1) { const w = world(); const r = await A.startAttempt(w.m.pool, student(), 5, 4, { now: T0 }); seen.add(w.st.questions.filter((q) => q.attempt_id !== null).map((q) => q.source_question_id).sort().join(",")); }
  assert.ok(seen.size > 1, `different attempts drew different papers: ${[...seen].join(" | ")}`);
});

test("staff marking and the learner result read the attempt's own picks: the grading loader passes the attempt id", async () => {
  const m = makeMockPool([["FROM lms_quizzes WHERE id = @z AND course_id = @c AND deleted_at IS NULL", () => [{ id: 4, title: "Q", shuffle_options: 0, max_attempts: 2 }]],
    ["FROM lms_quiz_attempts WHERE id = @a AND quiz_id = @z AND course_id = @c", () => [{ id: 70, student_id: 21, attempt_no: 1, status: "submitted", seed: "abcd1234abcd1234", submitted_at: T0.toISOString(), auto_submitted: 0, auto_points: "2.00", manual_points: null, total_points: null, max_points: "10.00", needs_marking: 1 }]],
    ["FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND (attempt_id IS NULL OR attempt_id = @att) ORDER BY position", () => [{ id: 1, position: 1, type: "true_false", stem: "Fixed", explanation: "", points: "2.00", spec_json: TF(true) }, { id: 501, position: 2, type: "essay", stem: "Picked essay", explanation: "", points: "8.00", spec_json: json({ maxWords: 50 }) }]],
    ["FROM lms_quiz_answers WHERE attempt_id = @a", () => [{ quiz_question_id: 501, answer_json: json({ text: "My essay" }), status: "manual", points: null, max_points: "8.00", comment: null, marked_by_source: null, marked_by: null, marked_at: null }]],
    ["FROM Students WHERE id = @s", () => [{ name: "Amina Test", admissionNo: "A-001" }]]]);
  const r = await G.getAttempt(m.pool, 5, 4, 70, {}); assert.ok(r.ok, json(r)); assert.ok(r.attempt.answers.some((a) => a.quizQuestionId === 501 && a.maxPoints === 8), "the picked essay is in the marking view");
  assert.strictEqual(sqlOf(m, /\(attempt_id IS NULL OR attempt_id = @att\)/).inputs.att, 70);
});

/* ====================================== routes + schema ====================================== */
test("routes: 4 rule routes behind the lms_quizzes gate, reads = course staff, writes need the permission; ids in the path are validated", async () => {
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && /\/quizzes\/:quizId\/rules/.test(l.route.path));
  assert.deepStrictEqual(mine.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).sort(), ["delete /courses/:courseId/quizzes/:quizId/rules/:ruleId", "get /courses/:courseId/quizzes/:quizId/rules", "patch /courses/:courseId/quizzes/:quizId/rules/:ruleId", "post /courses/:courseId/quizzes/:quizId/rules"]);
  for (const l of mine) assert.strictEqual(l.route.stack.length, l.route.methods.get ? 3 : 4, "gate (+ permission) + course access + handler");
  const get = mine.find((l) => l.route.methods.get); const res = makeRes(); let nexted = false;
  await get.route.stack[0].handle({ user: teacher, pool: makeMockPool([["FROM tenant_modules", () => [{ module_key: "lms", enabled: 1, flags_json: json(["lms_core"]), limits_json: "{}", note: null, updatedAt: null }]]]).pool, tenant: "qr-route" }, res, () => { nexted = true; });
  assert.deepStrictEqual([nexted, res.statusCode, res.body.code, res.body.flag], [false, 403, "MODULE_NOT_LICENSED", "lms_quizzes"]);
});

test("schema step 028: additive and idempotent (rules table, attempt_id column, indexes incl. the unique pick index); the new table is blocked from the generic record editor; limits stay in step with lmsQuizzes", () => {
  const step = schema.STEPS.find((s) => s.id === "028_lms_quiz_rules"); assert.ok(step, "step exists"); assert.ok(schema.STEPS.findIndex((x) => x.id === "028_lms_quiz_rules") < schema.STEPS.length - 1 || schema.STEPS[schema.STEPS.length - 1].id === "028_lms_quiz_rules", "028 is not removed or reordered");
  const text = step.sql.join("\n"); assert.ok(/IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_quiz_rules'/.test(text) && /IF COL_LENGTH\('lms_quiz_questions', 'attempt_id'\) IS NULL ALTER TABLE lms_quiz_questions ADD attempt_id INT NULL/.test(text));
  assert.ok(/CREATE UNIQUE INDEX UX_lms_quiz_questions_pick ON lms_quiz_questions \(attempt_id, source_question_id\) WHERE attempt_id IS NOT NULL AND source_question_id IS NOT NULL/.test(text));
  assert.ok(!/DROP |DELETE |FOREIGN KEY|REFERENCES/i.test(text), "additive: no drops, no foreign keys (D-005)"); assert.ok(step.sql.every((s) => /^IF /.test(s)), "every statement is guarded");
  assert.ok(/"lms_quiz_questions", "lms_quiz_rules"/.test(require("fs").readFileSync(require.resolve("../server.js"), "utf8")));
  assert.strictEqual(R.MAX_TOTAL, Z.MAX_QUESTIONS, "the 100-question cap is the same in both modules");
});
