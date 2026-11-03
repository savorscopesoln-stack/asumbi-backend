/* L6.1b - question bank storage, visibility, versions, import/export, route wiring. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
suite("lmsQuestionBank.test.js");
const B = require("../utils/lmsQuestionBank");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), admin = { id: 1, role: "admin", source: "Users" }, student = { id: 21, role: "student", source: "Students" };
const ROW = (o = {}) => ({ id: 9, scope: "private", course_id: null, owner_source: "Teachers", owner_id: 7, type: "true_false", stem: "Is it?", explanation: null, points: "1.00", difficulty: null, subject: null, topic: null,
  spec_json: JSON.stringify({ correct: true }), version: 3, source_system: null, source_ref: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...o });
/* LOAD(rowA, rowB...): the n-th load of an id returns the n-th row given for that id (the last one repeats), so "before" and "after" a save can differ. LOAD(null) = nothing visible. */
const LOAD = (...rows) => { const seen = {}; const list = rows.filter(Boolean); return ["FROM lms_questions q WHERE q.id = @id", (i) => { const mine = list.filter((r) => r.id === i.id); if (!mine.length) return []; seen[i.id] = (seen[i.id] || 0) + 1; return [mine[Math.min(seen[i.id], mine.length) - 1]]; }]; };
const NEWID = (id = 9) => ["INSERT INTO lms_questions (scope", () => [{ id }]];
const COUNT = (n) => ["SELECT COUNT(*) AS n FROM lms_questions", () => [{ n }]];
const OUTC = (ids) => ["FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN", () => ids.map((id) => ({ id }))];
const TAGS = (rows = []) => ["FROM lms_outcome_tags t INNER JOIN", () => rows];
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const TF = { type: "true_false", stem: "Is the sky blue?", correct: true };
const sqlOf = (m, re) => m.log.find((x) => re.test(x.sql));

test("create (private): ONE transaction with the question, its first version and tags; text only as parameters; audited; owner is the caller", async () => {
  const m = makeMockPool([COUNT(0), OUTC([3]), NEWID(), LOAD(ROW()), TAGS([{ entity_id: 9, outcome_id: 3, code: "BIO.1", title: "Cells" }])]);
  const r = await B.createQuestion(m.pool, teacher(), { ...TF, stem: " <b>Is</b> it blue? ", subject: "Physics", outcomeIds: [3, 3] }); assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual([r.question.id, r.question.mine, r.question.canEdit, r.question.outcomes[0].code], [9, true, true, "BIO.1"]);
  const w = sqlOf(m, /INSERT INTO lms_questions \(scope/); assert.ok(w);
  assert.ok(/SET XACT_ABORT ON/.test(w.sql) && /BEGIN TRAN/.test(w.sql) && /COMMIT/.test(w.sql) && /SET @qid = SCOPE_IDENTITY\(\)/.test(w.sql));
  assert.ok(/INSERT INTO lms_question_versions[\s\S]*FROM lms_questions WHERE id = @qid/.test(w.sql) && /VALUES \(@sc, NULL, @src, @uid,/.test(w.sql) && /INSERT INTO lms_outcome_tags[\s\S]*VALUES \(3, 'question', @qid, 0\)/.test(w.sql));
  for (const t of ["blue", "Physics", "Is"]) assert.ok(!w.sql.includes(t), `user text in SQL: ${t}`);
  assert.deepStrictEqual([w.inputs.sc, w.inputs.src, w.inputs.uid, w.inputs.st0, w.inputs.sj0, w.inputs.ty0], ["private", "Teachers", 7, "bIs/b it blue?", "Physics", "true_false"]);
  assert.strictEqual(JSON.parse(w.inputs.sp0).correct, true);
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  assert.ok(m.log.findIndex((x) => /FROM lms_outcome_tags|FROM lms_learning_outcomes/.test(x.sql)) < m.log.findIndex((x) => /INSERT INTO lms_questions/.test(x.sql)), "checks happen before the write");
});

test("create: validation, scope rules, outcomes and the per-owner cap are enforced BEFORE any write", async () => {
  const none = (r, m) => { assert.strictEqual(r.ok, false); assert.ok(!m.log.some((x) => /INSERT INTO/.test(x.sql)), "nothing written"); };
  let m = makeMockPool([]); none(await B.createQuestion(m.pool, teacher(), { type: "nope" }), m); assert.strictEqual(m.log.length, 0, "validation first, no query at all");
  m = makeMockPool([]); none(await B.createQuestion(m.pool, teacher(), null), m);
  m = makeMockPool([COUNT(0)]); none(await B.createQuestion(m.pool, teacher(), { ...TF, scope: "world" }), m);
  m = makeMockPool([COUNT(0)]); none(await B.createQuestion(m.pool, teacher(), { ...TF, scope: "school", courseId: 5 }), m);
  m = makeMockPool([COUNT(0)]); none(await B.createQuestion(m.pool, teacher(), { ...TF, scope: "course" }), m);
  m = makeMockPool([COUNT(0)]); none(await B.createQuestion(m.pool, teacher(), { ...TF, who: "me" }), m);
  m = makeMockPool([OUTC([]), COUNT(0)]); const o = await B.createQuestion(m.pool, teacher(), { ...TF, outcomeIds: [3] }); none(o, m); assert.ok(/outcome must exist/.test(o.errors[0]));
  m = makeMockPool([OUTC([]), COUNT(5000)]); const lim = await B.createQuestion(m.pool, teacher(), TF); none(lim, m); assert.strictEqual(lim.code, "QUESTION_LIMIT");
  m = makeMockPool([COUNT(4999), NEWID(), LOAD(ROW()), TAGS()]); assert.ok((await B.createQuestion(m.pool, teacher(), TF)).ok, "4999 < 5000 passes");
  m = makeMockPool([]); none(await B.createQuestion(m.pool, null, TF), m);
});

test("create (course scope): needs course membership (student / stranger / unknown course = the same 'not found'), a course that can change, and writes the course id", async () => {
  const ok = makeMockPool([staff([5]), live(), COUNT(0), NEWID(), LOAD(ROW({ scope: "course", course_id: 5 })), TAGS()]);
  const r = await B.createQuestion(ok.pool, teacher(), { ...TF, scope: "course", courseId: 5 }); assert.ok(r.ok, JSON.stringify(r.errors)); assert.deepStrictEqual([r.question.scope, r.question.courseId], ["course", 5]);
  const w = sqlOf(ok, /INSERT INTO lms_questions \(scope/); assert.ok(/VALUES \(@sc, @c, @src, @uid,/.test(w.sql)); assert.strictEqual(w.inputs.c, 5);
  const stranger = makeMockPool([staff([99]), live()]); const a = await B.createQuestion(stranger.pool, teacher(), { ...TF, scope: "course", courseId: 5 });
  const gone = makeMockPool([staff([99]), live()]); const b = await B.createQuestion(gone.pool, teacher(), { ...TF, scope: "course", courseId: 777 });
  assert.deepStrictEqual([a.ok, a.notFound, a.errors[0]], [false, true, "Course not found."]); assert.deepStrictEqual(a, b, "not yours and does not exist look identical");
  assert.ok(![stranger, gone].some((x) => x.log.some((l) => /INSERT INTO/.test(l.sql))));
  const stu = makeMockPool([["FROM lms_course_enrolments", () => [{ status: "active" }]], live()]); const sr = await B.createQuestion(stu.pool, student, { ...TF, scope: "course", courseId: 5 }); assert.deepStrictEqual([sr.ok, sr.notFound], [false, true], "an enrolled student is not course staff"); assert.ok(!stu.log.some((l) => /INSERT INTO|FROM lms_courses/.test(l.sql)), "stopped before any write or course-state read");
  for (const st of ["archived", "pending"]) { const ro = makeMockPool([staff([5]), live(st)]); const x = await B.createQuestion(ro.pool, teacher(), { ...TF, scope: "course", courseId: 5 }); assert.strictEqual(x.ok, false); assert.ok(!ro.log.some((l) => /INSERT INTO/.test(l.sql)), st); }
  const adm = makeMockPool([live(), COUNT(0), NEWID(), LOAD(ROW({ scope: "course", course_id: 5, owner_source: "Users", owner_id: 1 })), TAGS()]); assert.ok((await B.createQuestion(adm.pool, admin, { ...TF, scope: "course", courseId: 5 }, { admin: true })).ok, "LMS administrators work in any course");
});

test("visibility is decided IN SQL by the caller's identity: private = owner (administrators may read it too), school = everyone, course = staff of that course", async () => {
  const t = makeMockPool([LOAD(ROW())]); await B.getQuestion(t.pool, teacher(7), 9, { admin: false });
  const sT = t.log[0].sql; assert.ok(/q\.deleted_at IS NULL AND \(\(q\.owner_source = @src AND q\.owner_id = @uid\) OR q\.scope = 'school' OR \(q\.scope = 'course' AND EXISTS \(SELECT 1 FROM lms_course_staff s WHERE s\.course_id = q\.course_id AND s\.user_source = @src AND s\.user_id = @uid AND s\.is_active = 1\)\)\)/.test(sT), sT);
  assert.deepStrictEqual([t.log[0].inputs.src, t.log[0].inputs.uid, t.log[0].inputs.id], ["Teachers", 7, 9]);
  const a = makeMockPool([LOAD(ROW())]); await B.getQuestion(a.pool, admin, 9, { admin: true });
  assert.ok(/q\.deleted_at IS NULL/.test(a.log[0].sql) && !/private/.test(a.log[0].sql) && !/lms_course_staff/.test(a.log[0].sql), "admin: every question that is not deleted, private ones included (A75)");
  const spoof = makeMockPool([LOAD(ROW())]); await B.getQuestion(spoof.pool, { id: 8, role: "teacher", source: "Teachers", admin: true, isAdmin: true }, 9, {}); assert.ok(/lms_course_staff/.test(spoof.log[0].sql), "admin comes only from the route's permission check, never from the user object");
});

test("A75: an administrator reading someone else's PRIVATE question succeeds and is audited; reading own or non-private is not audited; a teacher still cannot see it", async () => {
  const other = makeMockPool([LOAD(ROW({ scope: "private", owner_id: 99 })), TAGS()]); const r = await B.getQuestion(other.pool, admin, 9, { admin: true });
  assert.deepStrictEqual([r.ok, r.question.canEdit, r.question.mine, r.question.scopeLabel], [true, true, false, "Private"]);
  const cs = makeMockPool([LOAD(ROW({ scope: "course", course_id: 5 })), TAGS()]); assert.strictEqual((await B.getQuestion(cs.pool, teacher(7), 9, {})).question.scopeLabel, "Course staff / Department", "Q42: both names");
  const a = other.log.find((x) => /lms_audit_log/.test(x.sql)); assert.ok(a, "audit row written"); assert.ok(Object.values(a.inputs).includes("question.viewed_private"), JSON.stringify(a.inputs));
  const own = makeMockPool([LOAD(ROW({ scope: "private", owner_source: "Users", owner_id: 1 })), TAGS()]); await B.getQuestion(own.pool, admin, 9, { admin: true }); assert.ok(!own.log.some((x) => /lms_audit_log/.test(x.sql)), "own private: no audit");
  const sch = makeMockPool([LOAD(ROW({ scope: "school", owner_id: 99 })), TAGS()]); await B.getQuestion(sch.pool, admin, 9, { admin: true }); assert.ok(!sch.log.some((x) => /lms_audit_log/.test(x.sql)), "school: no audit");
  const t = makeMockPool([LOAD(null)]); assert.strictEqual((await B.getQuestion(t.pool, teacher(7), 9, { admin: false })).notFound, true);
});

test("get: hidden, missing, deleted and bad ids all give the same 'not found'; no owner identity is ever returned", async () => {
  const hidden = makeMockPool([LOAD(null)]), missing = makeMockPool([LOAD(null)]);
  const a = await B.getQuestion(hidden.pool, teacher(), 9, {}), b = await B.getQuestion(missing.pool, teacher(), 12345, {}); assert.deepStrictEqual(a, b); assert.strictEqual(a.notFound, true);
  for (const bad of [0, -1, "x", null, undefined, 1.5]) assert.strictEqual((await B.getQuestion(makeMockPool([]).pool, teacher(), bad, {})).notFound, true, String(bad));
  const ok = makeMockPool([LOAD(ROW({ owner_id: 99, scope: "school" })), TAGS()]); const r = await B.getQuestion(ok.pool, teacher(7), 9, {});
  assert.deepStrictEqual([r.question.mine, r.question.canEdit], [false, false]); const s = JSON.stringify(r); assert.ok(!/owner|Teachers|"99"/.test(s), s);
});

test("tenant isolation: tenant A cannot read, change or delete tenant B's question by guessing its id; B's database is never touched", async () => {
  const T = makeTenants({ schoolA: [LOAD(ROW({ id: 4 }))], schoolB: [LOAD(ROW({ id: 9 }))] });
  assert.strictEqual((await B.getQuestion(T.schoolA.pool, teacher(), 9, {})).notFound, true);
  assert.strictEqual((await B.updateQuestion(T.schoolA.pool, teacher(), 9, { baseVersion: 3, ...TF }, {})).notFound, true);
  assert.strictEqual((await B.deleteQuestion(T.schoolA.pool, teacher(), 9, {})).notFound, true);
  assert.strictEqual((await B.listVersions(T.schoolA.pool, teacher(), 9, {})).notFound, true);
  assert.strictEqual((await B.restoreVersion(T.schoolA.pool, teacher(), 9, 1, { baseVersion: 3 }, {})).notFound, true);
  assert.strictEqual((await B.copyQuestion(T.schoolA.pool, teacher(), 9, { scope: "private" }, {})).notFound, true);
  T.assertUntouched("schoolB"); T.assertQueried("schoolA");
  assert.ok(!T.schoolA.log.some((x) => /UPDATE|DELETE|INSERT/.test(x.sql.replace(/^SELECT[\s\S]*/, ""))), "no write ran in A");
});

test("list: paged, every filter is a parameter (hostile values never reach the SQL), LIKE wildcards are escaped, bad filters are refused with no query", async () => {
  const rows = [ROW({ id: 3, total_count: 41 }), ROW({ id: 2, total_count: 41, owner_id: 8, scope: "school" })];
  const m = makeMockPool([["COUNT(*) OVER() AS total_count FROM lms_questions q", () => rows]]);
  const r = await B.listQuestions(m.pool, teacher(), { scope: "mine", type: "mcq_single", difficulty: "hard", subject: "Bio'; DROP TABLE x;--", topic: "T", courseId: "5", outcomeId: "3", q: "50%_[a]\\", page: "2", pageSize: "500" }, {});
  assert.ok(r.ok); assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items.length, r.items[0].mine, r.items[1].mine, r.items[1].canEdit], [41, 2, 100, 2, true, false, false]);
  assert.ok(!("spec" in r.items[0]) && !("explanation" in r.items[0]), "list rows are summaries");
  const l = m.log[0]; assert.ok(!/DROP|Bio|50%/.test(l.sql)); assert.deepStrictEqual([l.inputs.off, l.inputs.lim, l.inputs.ft, l.inputs.fd, l.inputs.fs, l.inputs.fc, l.inputs.fo], [100, 100, "mcq_single", "hard", "Bio'; DROP TABLE x;--", 5, 3]);
  assert.strictEqual(l.inputs.fq, "%50\\%\\_\\[a]\\\\%"); assert.ok(/q\.stem LIKE @fq ESCAPE '\\'/.test(l.sql) && /ORDER BY q\.updated_at DESC, q\.id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY/.test(l.sql));
  assert.ok(/\(q\.owner_source = @src AND q\.owner_id = @uid\)/.test(l.sql));
  for (const bad of [{ scope: "x" }, { type: "x" }, { difficulty: "x" }, { courseId: "abc" }, { outcomeId: "0" }, { subject: "s".repeat(101) }, { q: "q".repeat(101) }]) { const n = makeMockPool([]); const x = await B.listQuestions(n.pool, teacher(), bad, {}); assert.strictEqual(x.ok, false, JSON.stringify(bad)); assert.strictEqual(n.log.length, 0); }
  const empty = makeMockPool([]); assert.deepStrictEqual((await B.listQuestions(empty.pool, teacher(), {}, {})).total, 0);
});

test("update: guarded by baseVersion in the UPDATE itself; version row + tags rewritten in the same transaction; stale = 409 code, never overwrites", async () => {
  const body = { baseVersion: 3, ...TF, stem: "New stem", outcomeIds: [3] };
  const ok = makeMockPool([LOAD(ROW(), ROW({ version: 4, stem: "New stem" })), OUTC([3]), ["UPDATE lms_questions SET type", () => [{ outcome: "OK" }]], TAGS()]);
  const r = await B.updateQuestion(ok.pool, teacher(), 9, body, {}); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.question.version, 4);
  const w = sqlOf(ok, /UPDATE lms_questions SET type/); const at = (re) => w.sql.search(re);
  assert.ok(/WHERE id = @id AND version = @bv AND deleted_at IS NULL/.test(w.sql) && /version = version \+ 1/.test(w.sql) && !w.sql.includes("New stem"));
  assert.ok(at(/BEGIN TRAN/) < at(/UPDATE lms_questions/) && at(/UPDATE lms_questions/) < at(/IF @@ROWCOUNT = 0 BEGIN ROLLBACK/) && at(/ROLLBACK/) < at(/INSERT INTO lms_question_versions/) && at(/INSERT INTO lms_question_versions/) < at(/DELETE FROM lms_outcome_tags/) && at(/DELETE FROM lms_outcome_tags/) < at(/COMMIT/));
  assert.ok(/DELETE FROM lms_question_versions WHERE question_id = @id AND version <= \(SELECT version FROM lms_questions WHERE id = @id\) - 30/.test(w.sql));
  assert.deepStrictEqual([w.inputs.id, w.inputs.bv, w.inputs.st], [9, 3, "New stem"]); assert.ok(ok.log.some((x) => /lms_audit_log/.test(x.sql)));
  const stale = makeMockPool([LOAD(ROW()), OUTC([]), ["UPDATE lms_questions SET type", () => [{ outcome: "CONFLICT" }]]]); const s = await B.updateQuestion(stale.pool, teacher(), 9, { baseVersion: 2, ...TF }, {}); assert.deepStrictEqual([s.ok, s.code], [false, "QUESTION_CONFLICT"]);
  for (const bad of [{ ...TF }, { baseVersion: 0, ...TF }, { baseVersion: "x", ...TF }, { baseVersion: 3, type: "nope" }, { baseVersion: 3, ...TF, scope: "school" }, null]) { const n = makeMockPool([]); assert.strictEqual((await B.updateQuestion(n.pool, teacher(), 9, bad, {})).ok, false); assert.strictEqual(n.log.length, 0, `no query for ${JSON.stringify(bad)?.slice(0, 40)}`); }
});

test("update/delete/restore: a school question of someone else is READ-ONLY (403 code, no write); the owner and an LMS administrator may change it; archived course refuses", async () => {
  const other = ROW({ scope: "school", owner_id: 99 });
  for (const [fn, args] of [["updateQuestion", [{ baseVersion: 3, ...TF }]], ["deleteQuestion", []], ["restoreVersion", [1, { baseVersion: 3 }]]]) {
    const m = makeMockPool([LOAD(other), OUTC([])]); const r = fn === "restoreVersion" ? await B[fn](m.pool, teacher(7), 9, ...args, {}) : await B[fn](m.pool, teacher(7), 9, ...args, {});
    assert.deepStrictEqual([r.ok, r.forbidden, r.code], [false, true, "QUESTION_NOT_EDITABLE"], fn); assert.ok(!m.log.some((x) => /^(SET XACT_ABORT|UPDATE|DELETE)/.test(x.sql)), `${fn} wrote`);
  }
  const adm = makeMockPool([LOAD(other)]); assert.ok((await B.deleteQuestion(adm.pool, admin, 9, { admin: true })).ok);
  const del = sqlOf(adm, /^UPDATE lms_questions SET deleted_at/); assert.ok(del && /WHERE id = @id AND deleted_at IS NULL/.test(del.sql) && !/DELETE FROM/.test(del.sql), "soft delete");
  const mine = makeMockPool([LOAD(ROW())]); assert.ok((await B.deleteQuestion(mine.pool, teacher(7), 9, {})).ok);
  const priv = makeMockPool([LOAD(ROW({ scope: "private", owner_id: 99 }))]); const pr = await B.deleteQuestion(priv.pool, admin, 9, { admin: true });
  assert.ok(pr.ok, "an administrator may delete someone else's private question (A78)"); assert.ok(priv.log.some((x) => /^UPDATE lms_questions SET deleted_at/.test(x.sql)));
  const arch = makeMockPool([LOAD(ROW({ scope: "course", course_id: 5 })), live("archived"), OUTC([])]); const a = await B.updateQuestion(arch.pool, teacher(), 9, { baseVersion: 3, ...TF }, {}); assert.deepStrictEqual([a.ok, a.code], [false, "COURSE_ARCHIVED"]); assert.ok(!arch.log.some((x) => /^UPDATE/.test(x.sql)));
});

test("versions: list needs visibility; restore = a NEW version copied from the old one, guarded by baseVersion, unknown version = not found", async () => {
  const lv = makeMockPool([LOAD(ROW()), ["FROM lms_question_versions WHERE question_id = @id ORDER BY version DESC", () => [{ version: 3, stem: "s".repeat(300), created_at: "2026-01-02T00:00:00Z" }, { version: 2, stem: "old", created_at: "2026-01-01T00:00:00Z" }]]]);
  const l = await B.listVersions(lv.pool, teacher(), 9, {}); assert.deepStrictEqual([l.ok, l.currentVersion, l.versions.length, l.versions[0].stem.length], [true, 3, 2, 120]); assert.ok(/SELECT TOP 30/.test(lv.log[1].sql)); assert.ok(!JSON.stringify(l).match(/changed_by|Teachers/));
  const ok = makeMockPool([LOAD(ROW(), ROW({ version: 4 })), ["FROM lms_question_versions WHERE question_id = @id AND version = @v", () => [{ version: 1 }]], ["UPDATE q SET q.type = v.type", () => [{ outcome: "OK" }]], TAGS()]);
  const r = await B.restoreVersion(ok.pool, teacher(), 9, 1, { baseVersion: 3 }, {}); assert.ok(r.ok, JSON.stringify(r.errors));
  const w = sqlOf(ok, /UPDATE q SET q\.type = v\.type/); assert.ok(/INNER JOIN lms_question_versions v ON v\.question_id = q\.id AND v\.version = @v WHERE q\.id = @id AND q\.version = @bv AND q\.deleted_at IS NULL/.test(w.sql) && /q\.version = q\.version \+ 1/.test(w.sql) && /INSERT INTO lms_question_versions/.test(w.sql));
  assert.deepStrictEqual([w.inputs.id, w.inputs.v, w.inputs.bv], [9, 1, 3]);
  const none = makeMockPool([LOAD(ROW()), ["FROM lms_question_versions WHERE question_id = @id AND version = @v", () => []]]); assert.strictEqual((await B.restoreVersion(none.pool, teacher(), 9, 77, { baseVersion: 3 }, {})).notFound, true);
  const stale = makeMockPool([LOAD(ROW()), ["FROM lms_question_versions WHERE question_id = @id AND version = @v", () => [{ version: 1 }]], ["UPDATE q SET q.type = v.type", () => [{ outcome: "CONFLICT" }]]]); assert.strictEqual((await B.restoreVersion(stale.pool, teacher(), 9, 1, { baseVersion: 1 }, {})).code, "QUESTION_CONFLICT");
  for (const bad of [{}, { baseVersion: 3, x: 1 }, null, { baseVersion: "a" }]) { const n = makeMockPool([LOAD(ROW())]); assert.strictEqual((await B.restoreVersion(n.pool, teacher(), 9, 1, bad, {})).ok, false); }
});

test("copy: an independent copy in the chosen scope, owned by the caller, remembering its source; tags and answers carry over; bad bodies refused", async () => {
  const src = ROW({ id: 9, scope: "school", owner_id: 99, type: "mcq_multi", stem: "Pick", spec_json: JSON.stringify({ partialCredit: true, options: [{ position: 1, text: "A", correct: true, feedback: "yes" }, { position: 2, text: "B", correct: false, feedback: "" }] }) });
  const m = makeMockPool([LOAD(src, ROW({ id: 10 })), TAGS([{ entity_id: 9, outcome_id: 3, code: "X", title: "t" }]), COUNT(0), OUTC([3]), NEWID(10)]);
  const r = await B.copyQuestion(m.pool, teacher(7), 9, { scope: "private" }, {}); assert.ok(r.ok, JSON.stringify(r.errors));
  const w = sqlOf(m, /INSERT INTO lms_questions \(scope/); assert.ok(/'copy', @sr0/.test(w.sql) && /VALUES \(3, 'question', @qid, 0\)/.test(w.sql)); assert.deepStrictEqual([w.inputs.src, w.inputs.uid, w.inputs.sr0, w.inputs.ty0], ["Teachers", 7, 9, "mcq_multi"]);
  const sp = JSON.parse(w.inputs.sp0); assert.deepStrictEqual([sp.partialCredit, sp.options.map((o) => o.correct), sp.options[0].feedback], [true, [true, false], "yes"]);
  for (const bad of [null, { scope: "private", x: 1 }, { scope: "world" }, { scope: "school", courseId: 5 }]) { const n = makeMockPool([LOAD(src), TAGS(), COUNT(0)]); const x = await B.copyQuestion(n.pool, teacher(7), 9, bad, {}); assert.strictEqual(x.ok, false, JSON.stringify(bad)); assert.ok(!n.log.some((l) => /INSERT INTO lms_questions/.test(l.sql))); }
  const dflt = makeMockPool([LOAD(src, ROW({ id: 10 })), TAGS(), COUNT(0), NEWID(10)]); assert.ok((await B.copyQuestion(dflt.pool, teacher(7), 9, {}, {})).ok); assert.strictEqual(sqlOf(dflt, /INSERT INTO lms_questions \(scope/).inputs.sc, "private", "no scope given = a private copy");
  for (const t of ["mcq_single", "mcq_multi", "true_false", "short_answer", "numeric", "matching", "ordering", "essay"]) {
    const spec = { mcq_single: { options: [{ text: "A", correct: true }, { text: "B" }] }, mcq_multi: { options: [{ text: "A", correct: true }, { text: "B" }] }, true_false: { correct: true }, short_answer: { accepted: ["a"] }, numeric: { value: 1 }, matching: { pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }] }, ordering: { items: ["a", "b"] }, essay: {} }[t];
    const v1 = M_validate({ type: t, ...spec }); assert.deepStrictEqual(M_validate({ type: t, ...B.specToFields(t, v1.spec) }).spec, v1.spec, `${t} spec survives specToFields`);
  }
});
function M_validate(b) { const v = require("../utils/lmsQuizMarking").validateQuestion({ stem: "S", ...b }); assert.ok(v.ok, JSON.stringify(v.errors)); return v.value; }

const CSV_OK = (n) => ["type,stem,answer", ...Array.from({ length: n }, (_, i) => `true_false,Question number ${i},${i % 2 ? "true" : "false"}`)].join("\n");
test("import: dry run writes nothing; ONE bad row = nothing created and every bad row is reported; good file = ONE transaction; hostile text only as parameters", async () => {
  const dry = makeMockPool([COUNT(0)]); const d = await B.importCsv(dry.pool, teacher(), { csv: CSV_OK(3), dryRun: true }, {}); assert.deepStrictEqual([d.ok, d.dryRun, d.report.summary], [true, true, { rows: 3, created: 3, failed: 0 }]); assert.ok(!dry.log.some((x) => /INSERT INTO/.test(x.sql)));
  const csv = "type,stem,answer\ntrue_false,Fine,true\ntrue_false,,true\nmcq_single,Q,*only\nweird,Q,x\ntrue_false,Q,maybe\n";
  const bad = makeMockPool([COUNT(0)]); const b = await B.importCsv(bad.pool, teacher(), { csv }, {}); assert.deepStrictEqual([b.ok, b.code, b.extra.report.summary], [false, "IMPORT_HAS_ERRORS", { rows: 5, created: 0, failed: 4 }]);
  assert.deepStrictEqual(b.extra.report.failed.map((f) => f.line), [3, 4, 5, 6]); assert.ok(!bad.log.some((x) => /INSERT INTO/.test(x.sql)), "nothing written");
  const good = makeMockPool([COUNT(0), ["INSERT INTO lms_questions (scope", () => [{ id: 5 }]]]);
  const g = await B.importCsv(good.pool, teacher(), { csv: "type,stem,answer\ntrue_false,\"Evil'; DROP TABLE lms_questions;--\",true\nessay,Discuss,\n" }, {}); assert.ok(g.ok, JSON.stringify(g.errors)); assert.strictEqual(g.report.summary.created, 2);
  const ins = good.log.filter((x) => /INSERT INTO lms_questions \(scope/.test(x.sql)); assert.strictEqual(ins.length, 1, "ONE statement batch for the whole file"); assert.strictEqual((ins[0].sql.match(/BEGIN TRAN/g) || []).length, 1); assert.strictEqual((ins[0].sql.match(/INSERT INTO lms_questions \(/g) || []).length, 2);
  assert.ok(!/DROP|Discuss/.test(ins[0].sql)); assert.ok(/'csv'/.test(ins[0].sql)); assert.strictEqual(ins[0].inputs.st0, "Evil'; DROP TABLE lms_questions;--"); assert.ok(good.log.some((x) => /lms_audit_log/.test(x.sql)));
});

test("import: size/row limits, parameter budget (150 rows fit under SQL Server's 2100), per-owner cap, scope rules and bad bodies", async () => {
  const full = makeMockPool([COUNT(0), ["INSERT INTO lms_questions (scope", () => [{ id: 1 }]]]); assert.ok((await B.importCsv(full.pool, teacher(), { csv: CSV_OK(150) }, {})).ok);
  const q = full.log.find((x) => /INSERT INTO lms_questions \(scope/.test(x.sql)); assert.ok(Object.keys(q.inputs).length < 2100, `params: ${Object.keys(q.inputs).length}`); assert.strictEqual((q.sql.match(/INSERT INTO lms_questions \(/g) || []).length, 150);
  const many = makeMockPool([]); const r151 = await B.importCsv(many.pool, teacher(), { csv: CSV_OK(151) }, {}); assert.strictEqual(r151.ok, false); assert.strictEqual(many.log.length, 0, "too many rows refused before any query");
  const cap = makeMockPool([COUNT(4999)]); const c = await B.importCsv(cap.pool, teacher(), { csv: CSV_OK(2) }, {}); assert.strictEqual(c.code, "QUESTION_LIMIT"); assert.ok(!cap.log.some((x) => /INSERT INTO/.test(x.sql)));
  for (const bad of [null, [], { csv: 5 }, { csv: CSV_OK(1), extra: 1 }, { csv: CSV_OK(1), dryRun: "yes" }, { csv: "" }, { csv: "stem\nQ" }, { csv: CSV_OK(1), scope: "course" }, { csv: CSV_OK(1), scope: "school", courseId: 5 }]) { const n = makeMockPool([COUNT(0)]); const x = await B.importCsv(n.pool, teacher(), bad, {}); assert.strictEqual(x.ok, false, JSON.stringify(bad)?.slice(0, 50)); assert.ok(!n.log.some((l) => /INSERT INTO/.test(l.sql))); }
  const crs = makeMockPool([staff([5]), live(), COUNT(0), ["INSERT INTO lms_questions (scope", () => [{ id: 1 }]]]); assert.ok((await B.importCsv(crs.pool, teacher(), { csv: CSV_OK(2), scope: "course", courseId: 5 }, {})).ok); assert.strictEqual(sqlOf(crs, /INSERT INTO lms_questions \(scope/).inputs.c, 5);
  const out = makeMockPool([staff([99]), live()]); assert.strictEqual((await B.importCsv(out.pool, teacher(), { csv: CSV_OK(2), scope: "course", courseId: 5 }, {})).notFound, true);
});

test("export: only what the caller may see (visibility SQL + filters), capped at 2000, audited, and the CSV re-imports", async () => {
  const rows = [ROW({ id: 1, type: "mcq_single", stem: "Pick", spec_json: JSON.stringify({ options: [{ position: 1, text: "A", correct: true, feedback: "" }, { position: 2, text: "B", correct: false, feedback: "" }] }) }), ROW({ id: 2, stem: "=cmd|' /C calc'!A0" })];
  const m = makeMockPool([["SELECT TOP 2000", () => rows]]); const r = await B.exportCsv(m.pool, teacher(), { type: "mcq_single", subject: "x" }, {}); assert.ok(r.ok); assert.strictEqual(r.count, 2);
  assert.ok(/WHERE q\.deleted_at IS NULL AND \(\(q\.owner_source = @src/.test(m.log[0].sql) && /q\.type = @ft/.test(m.log[0].sql) && /ORDER BY q\.id/.test(m.log[0].sql)); assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  assert.ok(!r.csv.includes("\n=cmd") && r.csv.includes("'=cmd")); const dry = await B.importCsv(makeMockPool([COUNT(0)]).pool, teacher(), { csv: r.csv, dryRun: true }, {}); assert.deepStrictEqual(dry.report.summary, { rows: 2, created: 2, failed: 0 });
  assert.strictEqual((await B.exportCsv(makeMockPool([]).pool, teacher(), { type: "nope" }, {})).ok, false);
  assert.strictEqual((await B.exportCsv(makeMockPool([]).pool, null, {}, {})).count, 0);
});

test("routes: 10 question routes, each runs the licence flag gate (lms_quizzes) and the permission BEFORE the handler; export/import are registered before /:questionId", async () => {
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && /^\/questions/.test(l.route.path));
  assert.strictEqual(mine.length, 10, mine.map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).join(", "));
  assert.ok(mine.every((l) => l.route.stack.length === 3), "gate + permission + handler");
  const paths = mine.map((l) => l.route.path); assert.ok(paths.indexOf("/questions/export.csv") < paths.indexOf("/questions/:questionId") && paths.indexOf("/questions/import") < paths.indexOf("/questions/:questionId"));
  const rows = (flags, enabled = 1) => [["FROM tenant_modules", () => [{ module_key: "lms", enabled, flags_json: JSON.stringify(flags), limits_json: "{}", note: null, updatedAt: null }]]];
  const run = async (tenant, flags, enabled) => { const res = makeRes(); let nexted = false; const m = makeMockPool(rows(flags, enabled)); await mine[0].route.stack[0].handle({ user: teacher(), pool: m.pool, tenant }, res, () => { nexted = true; }); return { res, nexted }; };
  const noFlag = await run("qb-a", ["lms_core", "lms_assignments"]); assert.deepStrictEqual([noFlag.nexted, noFlag.res.statusCode, noFlag.res.body.code, noFlag.res.body.flag], [false, 403, "MODULE_NOT_LICENSED", "lms_quizzes"]);
  const off = await run("qb-b", ["lms_quizzes"], 0); assert.deepStrictEqual([off.nexted, off.res.statusCode], [false, 403]);
  const yes = await run("qb-c", ["lms_core", "lms_quizzes"]); assert.strictEqual(yes.nexted, true);
  let stuNext = false; const sres = makeRes(); await mine[0].route.stack[1].handle({ user: student, pool: makeMockPool([]).pool, tenant: "qb-d" }, sres, () => { stuNext = true; }); assert.deepStrictEqual([stuNext, sres.statusCode], [false, 403]);
  let tNext = false; await mine[0].route.stack[1].handle({ user: teacher(), pool: makeMockPool([]).pool, tenant: "qb-e" }, makeRes(), () => { tNext = true; }); assert.strictEqual(tNext, true, "a teacher passes the permission check");
});
