/* L5.4a — marking workspace part 1 (queue, staff file download, score, return, student feedback). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsMarking.test.js");
const M = require("../utils/lmsMarking"), events = require("../utils/lmsEvents"), { UPLOADS_ROOT } = require("../utils/uploadPaths");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "published") => ["FROM lms_courses WHERE id", () => [{ status }]];
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const ASSIGN = (max = "20.00") => ["title, max_points FROM lms_assignments WHERE id = @a AND course_id = @c", onlyIds("c", [5], (i) => (i.a === 4 ? [{ id: 4, title: "Essay", max_points: max }] : []))];
const SUBROW = (o = {}) => ({ id: 31, student_id: 21, attempt_no: 1, body_text: "My answer", submitted_at: "2026-10-01T08:00:00Z", is_late: 0, late_penalty_percent: null, ...o });
const SUB = (o) => ["SELECT TOP 1 id, student_id, attempt_no, body_text", (i) => (i.c === 5 && i.a === 4 && i.sid === 31 ? [SUBROW(o)] : [])];
const NORUBRIC = ["FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r", () => []];
const LIVEA = ["SELECT TOP 1 id FROM lms_assignments WHERE id = @a", () => [{ id: 4 }]];
const RROW = { id: 9, course_id: 5, title: "Essay rubric", description: null, created_at: "x", updated_at: "x" };
const CRIT = [{ id: 31, position: 1, title: "Argument", description: "", weight: "10.00" }, { id: 32, position: 2, title: "Language", description: "", weight: "5.00" }];
const LEV = [{ criterion_id: 31, position: 1, label: "Strong", description: "", points: "10.00" }, { criterion_id: 31, position: 2, label: "Weak", description: "", points: "2.00" }, { criterion_id: 32, position: 1, label: "Good", description: "", points: "5.00" }, { criterion_id: 32, position: 2, label: "Poor", description: "", points: "0.00" }];
const RUBRIC = [["FROM lms_assignment_rubrics ar INNER JOIN lms_rubrics r", () => [RROW]], ["FROM lms_rubric_criteria WHERE rubric_id = @rid ORDER", () => CRIT], ["FROM lms_rubric_levels l", () => LEV], ["FROM lms_outcome_tags t", () => []]];
const SAVE = (out = { ok: 1, returned: 0 }) => ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @ok", () => [out]];
const GRADE = (o = {}) => ["graded_at, returned_at FROM lms_submission_grades", () => [{ status: "draft", raw_points: "15.00", penalty_percent: null, final_points: "15.00", max_points: "20.00", comment: "Good", graded_at: "2026-10-02T08:00:00Z", returned_at: null, ...o }]];
const SCORES = (rows = []) => ["FROM lms_submission_rubric_scores WHERE submission_id = @sid ORDER", () => rows];
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE lms_|DELETE FROM|SET XACT_ABORT/.test(x.sql) && !/lms_audit_log/.test(x.sql));

test("pure: finalOf applies the stored late percent and rounds to 2 decimals; validateGrade enforces points bounds, rubric coverage and refuses the wrong mode", () => {
  assert.strictEqual(M.finalOf(15, null), 15); assert.strictEqual(M.finalOf(15, 0), 15); assert.strictEqual(M.finalOf(15, 10), 13.5); assert.strictEqual(M.finalOf(13.33, 15), 11.33); assert.strictEqual(M.finalOf(10, 100), 0);
  const ok = (b, ctx) => M.validateGrade(b, ctx), P = { maxPoints: 20, rubric: null };
  assert.deepStrictEqual([ok({ points: 0 }, P).ok, ok({ points: 20 }, P).ok, ok({ points: "12.5", comment: " <b>Nice</b> " }, P).value.comment], [true, true, "bNice/b"]);
  for (const b of [null, [], {}, { points: -1 }, { points: 20.01 }, { points: 1.234 }, { points: "x" }, { points: null }, { points: 5, extra: 1 }, { points: 5, scores: [] }, { points: 5, comment: "c".repeat(4001) }]) assert.strictEqual(ok(b, P).ok, false, JSON.stringify(b));
  const rubric = { maxPoints: 15, criteria: [{ id: 31, levels: [{ position: 1, points: 10 }, { position: 2, points: 2 }] }, { id: 32, levels: [{ position: 1, points: 5 }, { position: 2, points: 0 }] }] }, R = { maxPoints: 20, rubric };
  const good = ok({ scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 32, levelPosition: 2, comment: "Fix" }] }, R); assert.ok(good.ok); assert.strictEqual(good.value.raw, 13.33); assert.deepStrictEqual(good.value.scores.map((s) => s.points), [10, 0]);
  assert.strictEqual(ok({ scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 32, levelPosition: 1 }] }, R).value.raw, 20);
  assert.strictEqual(ok({ points: 5, scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 32, levelPosition: 1 }] }, R).ok, false, "points together with VALID scores is still refused");
  for (const b of [{}, { points: 5, scores: [] }, { scores: [] }, { scores: [{ criterionId: 31, levelPosition: 1 }] }, { scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 31, levelPosition: 2 }] },
    { scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 99, levelPosition: 1 }] }, { scores: [{ criterionId: 31, levelPosition: 3 }, { criterionId: 32, levelPosition: 1 }] },
    { scores: [{ criterionId: 31, levelPosition: 1, points: 10 }, { criterionId: 32, levelPosition: 1 }] }, { scores: [{ criterionId: 31, levelPosition: 1, comment: "c".repeat(501) }, { criterionId: 32, levelPosition: 1 }] }, { scores: ["x", "y"] }, { points: 5 }])
    assert.strictEqual(ok(b, R).ok, false, JSON.stringify(b));
});

test("saveGrade (no rubric): ONE guarded batch, all values as parameters, late penalty applied to the stored snapshot, audited, event with ids only; the grade comes back", async () => {
  const seen = []; const off = events.on("lms.submission.graded", (p) => seen.push(p));
  const m = makeMockPool([live(), ASSIGN(), SUB({ late_penalty_percent: 10 }), NORUBRIC, LIVEA, SAVE(), GRADE({ raw_points: "15.00", penalty_percent: 10, final_points: "13.50", comment: "Good" }), SCORES()]);
  const r = await M.saveGrade(m.pool, teacher(), 5, 4, 31, { points: 15, comment: "Good <script>" }, { tenant: "t1" }); off();
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.deepStrictEqual([r.grade.rawPoints, r.grade.penaltyPercent, r.grade.finalPoints, r.grade.status], [15, 10, 13.5, "draft"]);
  const w = writes(m); assert.strictEqual(w.length, 1); const q = w[0];
  assert.ok(/SET XACT_ABORT ON/.test(q.sql) && /BEGIN TRAN/.test(q.sql) && /COMMIT/.test(q.sql) && /IF @ok = 1 AND @ret = 0/.test(q.sql), "guard + transaction in one batch");
  assert.ok(/UPDATE lms_submission_grades SET[\s\S]*WHERE submission_id = @sid AND status = 'draft'[\s\S]*IF @@ROWCOUNT = 0 INSERT INTO lms_submission_grades/.test(q.sql));
  assert.ok(!q.sql.includes("Good") && !q.sql.includes("script") && !/\b15\b|13\.5/.test(q.sql.replace(/@\w+/g, "")), "no user value in the SQL text");
  assert.deepStrictEqual([q.inputs.sid, q.inputs.a, q.inputs.c, q.inputs.stu, q.inputs.rid, q.inputs.raw, q.inputs.pen, q.inputs.fin, q.inputs.max, q.inputs.cm, q.inputs.src, q.inputs.uid], [31, 4, 5, 21, null, 15, 10, 13.5, 20, "Good script", "Teachers", 7]);
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql))); await tick();
  assert.deepStrictEqual(seen.filter((p) => p.tenant === "t1").map((p) => Object.keys(p).sort().join()), ["assignmentId,at,courseId,event,studentId,submissionId,tenant"]);
});

test("saveGrade (rubric): points come from the STORED level, never from the client; scores are one row each in the same batch; raw is scaled to maxPoints", async () => {
  const m = makeMockPool([live(), ASSIGN(), SUB(), ...RUBRIC, LIVEA, SAVE(), GRADE({ raw_points: "13.33", final_points: "13.33" }), SCORES([{ criterion_id: 31, level_position: 1, points: "10.00", comment: null }, { criterion_id: 32, level_position: 2, points: "0.00", comment: "Fix" }])]);
  const r = await M.saveGrade(m.pool, teacher(), 5, 4, 31, { scores: [{ criterionId: 31, levelPosition: 1 }, { criterionId: 32, levelPosition: 2, comment: "Fix" }] }); assert.ok(r.ok, JSON.stringify(r.errors));
  const q = writes(m)[0]; assert.deepStrictEqual([q.inputs.rid, q.inputs.raw, q.inputs.fin, q.inputs.sc0, q.inputs.sl0, q.inputs.sp0, q.inputs.sc1, q.inputs.sl1, q.inputs.sp1, q.inputs.sm1], [9, 13.33, 13.33, 31, 1, 10, 32, 2, 0, "Fix"]);
  assert.ok(/DELETE FROM lms_submission_rubric_scores WHERE submission_id = @sid;[\s\S]*INSERT INTO lms_submission_rubric_scores[\s\S]*VALUES \(@sid, @sc0, @sl0, @sp0, @sm0\), \(@sid, @sc1, @sl1, @sp1, @sm1\)/.test(q.sql));
  assert.strictEqual(r.grade.scores.length, 2); assert.strictEqual(r.grade.scores[1].comment, "Fix");
  const bad = makeMockPool([live(), ASSIGN(), SUB(), ...RUBRIC, LIVEA]); const e = await M.saveGrade(bad.pool, teacher(), 5, 4, 31, { points: 10 }); assert.strictEqual(e.ok, false); assert.strictEqual(writes(bad).length, 0);
  const sp = makeMockPool([live(), ASSIGN(), SUB(), ...RUBRIC, LIVEA]); const e2 = await M.saveGrade(sp.pool, teacher(), 5, 4, 31, { scores: [{ criterionId: 31, levelPosition: 1, points: 99 }, { criterionId: 32, levelPosition: 1 }] }); assert.strictEqual(e2.ok, false, "a client-sent points field is refused"); assert.strictEqual(writes(sp).length, 0);
});

test("saveGrade refusals: bad input, unknown/other-course submission, archived or pending course, already returned; nothing is written and validation never reaches a write", async () => {
  const inv = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA]); assert.strictEqual((await M.saveGrade(inv.pool, teacher(), 5, 4, 31, { points: 21 })).ok, false); assert.strictEqual(writes(inv).length, 0);
  const nf = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA]); const a = await M.saveGrade(nf.pool, teacher(), 5, 4, 99, { points: 5 }); assert.strictEqual(a.notFound, true); assert.strictEqual(writes(nf).length, 0);
  const oc = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA]); assert.strictEqual((await M.saveGrade(oc.pool, teacher(), 6, 4, 31, { points: 5 })).notFound, true, "assignment of another course"); assert.strictEqual(writes(oc).length, 0);
  for (const st of ["archived", "pending"]) { const ar = makeMockPool([live(st), ASSIGN(), SUB(), NORUBRIC, LIVEA]); const r = await M.saveGrade(ar.pool, teacher(), 5, 4, 31, { points: 5 }); assert.strictEqual(r.ok, false, st); assert.strictEqual(writes(ar).length, 0, st); }
  const ret = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA, SAVE({ ok: 1, returned: 1 })]); const rr = await M.saveGrade(ret.pool, teacher(), 5, 4, 31, { points: 5 }); assert.deepStrictEqual([rr.ok, rr.code], [false, "ALREADY_RETURNED"]);
  assert.ok(!ret.log.some((x) => /lms_audit_log/.test(x.sql)), "a refused save is not audited as graded");
  const gone = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA, SAVE({ ok: 0, returned: 0 })]); assert.strictEqual((await M.saveGrade(gone.pool, teacher(), 5, 4, 31, { points: 5 })).notFound, true);
  let n = 0; const dup = makeMockPool([live(), ASSIGN(), SUB(), NORUBRIC, LIVEA, GRADE(), SCORES(), ["SET XACT_ABORT ON; BEGIN TRAN; DECLARE @ok", () => { n += 1; if (n === 1) { const e = new Error("dup"); e.number = 2601; throw e; } return [{ ok: 1, returned: 0 }]; }]]);
  assert.ok((await M.saveGrade(dup.pool, teacher(), 5, 4, 31, { points: 5 })).ok); assert.strictEqual(n, 2, "a parallel first save is retried once as an update");
});

test("returnGrade: one guarded UPDATE (draft -> returned), event + audit; no grade -> NOT_GRADED; already returned -> ALREADY_RETURNED; unknown submission and archived course refused", async () => {
  const seen = []; const off = events.on("lms.grade.released", (p) => seen.push(p));
  const m = makeMockPool([live(), SUB(), ["UPDATE lms_submission_grades SET status = 'returned'", () => [{ id: 1 }]], GRADE({ status: "returned", returned_at: "2026-10-03T08:00:00Z" }), SCORES()]);
  const r = await M.returnGrade(m.pool, teacher(), 5, 4, 31, { tenant: "t2" }); off(); assert.ok(r.ok); assert.strictEqual(r.grade.status, "returned");
  const u = m.log.find((x) => /UPDATE lms_submission_grades SET status = 'returned'/.test(x.sql)); assert.ok(/WHERE submission_id = @sid AND assignment_id = @a AND course_id = @c AND status = 'draft'/.test(u.sql)); assert.deepStrictEqual([u.inputs.sid, u.inputs.a, u.inputs.c], [31, 4, 5]);
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql))); await tick(); assert.strictEqual(seen.filter((p) => p.tenant === "t2").length, 1);
  const ng = makeMockPool([live(), SUB(), ["UPDATE lms_submission_grades SET status = 'returned'", () => []], ["SELECT TOP 1 status FROM lms_submission_grades", () => []]]); assert.strictEqual((await M.returnGrade(ng.pool, teacher(), 5, 4, 31)).code, "NOT_GRADED");
  const ar = makeMockPool([live(), SUB(), ["UPDATE lms_submission_grades SET status = 'returned'", () => []], ["SELECT TOP 1 status FROM lms_submission_grades", () => [{ status: "returned" }]]]); assert.strictEqual((await M.returnGrade(ar.pool, teacher(), 5, 4, 31)).code, "ALREADY_RETURNED");
  const un = makeMockPool([live(), SUB()]); assert.strictEqual((await M.returnGrade(un.pool, teacher(), 5, 4, 99)).notFound, true); assert.ok(!un.log.some((x) => /UPDATE lms_submission_grades/.test(x.sql)));
  const ac = makeMockPool([live("archived"), SUB()]); assert.strictEqual((await M.returnGrade(ac.pool, teacher(), 5, 4, 31)).ok, false); assert.ok(!ac.log.some((x) => /UPDATE lms_submission_grades/.test(x.sql)));
});

test("listQueue: latest submitted attempt per student, scoped to course + assignment, each filter is a fixed fragment, paged and bounded; a bad filter never reaches the database", async () => {
  const row = { id: 31, student_id: 21, attempt_no: 2, submitted_at: "2026-10-01T08:00:00Z", is_late: 1, late_penalty_percent: 10, student_name: "Amina W", admission_no: "A-1", grade_status: null, final_points: null, max_points: null };
  const mk = () => makeMockPool([ASSIGN(), ["SELECT COUNT(*) AS n FROM lms_submissions s", () => [{ n: 41 }]], ["FROM lms_submissions s LEFT JOIN Students st", () => [row]]]);
  const m = mk(); const r = await M.listQueue(m.pool, 5, 4, { filter: "late", page: "2", pageSize: "500" }); assert.ok(r.ok);
  assert.deepStrictEqual([r.total, r.page, r.pageSize, r.items[0].gradeStatus, r.items[0].resubmitted, r.items[0].studentName, r.items[0].finalPoints], [41, 2, 100, "ungraded", true, "Amina W", null]);
  const q = m.log.find((x) => /OFFSET/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.a, q.inputs.off, q.inputs.size], [5, 4, 100, 100]);
  assert.ok(/s\.assignment_id = @a AND s\.course_id = @c AND s\.status = 'submitted'/.test(q.sql) && /s\.attempt_no = \(SELECT MAX\(l\.attempt_no\)/.test(q.sql) && /AND s\.is_late = 1/.test(q.sql) && /ORDER BY s\.submitted_at ASC, s\.id ASC OFFSET/.test(q.sql));
  assert.ok(/SELECT COUNT\(\*\) AS n FROM lms_submissions s[\s\S]*s\.is_late = 1/.test(m.log.find((x) => /COUNT/.test(x.sql)).sql), "the count uses the same filter");
  const frag = { ungraded: "g.id IS NULL", graded: "g.status = 'draft'", returned: "g.status = 'returned'", resubmitted: "s.attempt_no > 1", all: "1 = 1" };
  for (const [f, s] of Object.entries(frag)) { const x = mk(); assert.ok((await M.listQueue(x.pool, 5, 4, { filter: f })).ok); assert.ok(x.log.find((l) => /OFFSET/.test(l.sql)).sql.includes(`AND ${s}`), f); }
  assert.deepStrictEqual(M.FILTERS.sort(), ["all", "graded", "late", "resubmitted", "returned", "ungraded"]);
  for (const bad of ["x", "all; DROP TABLE x", "", "toString", "__proto__", "constructor"]) { const x = mk(); const e = await M.listQueue(x.pool, 5, 4, { filter: bad }); assert.strictEqual(e.ok, false, bad); assert.strictEqual(x.log.length, 0, bad); }
  const oc = mk(); assert.strictEqual((await M.listQueue(oc.pool, 6, 4, {})).notFound, true); assert.ok(!oc.log.some((x) => /FROM lms_submissions s/.test(x.sql)));
});

test("getForMarking: text, files, student name, rubric and grade; a submission of another course/assignment looks like 'not found'", async () => {
  const mkp = (sub = SUB()) => makeMockPool([ASSIGN(), sub, ["FROM Students WHERE id = @s", () => [{ name: "Amina W", admissionNo: "A-1" }]], ["FROM lms_submission_files WHERE submission_id = @sid", () => [{ id: 8, original_name: "essay.pdf", ext: "pdf", size_bytes: "1234" }]], ...RUBRIC, LIVEA, GRADE(), SCORES()]);
  const m = mkp(); const r = await M.getForMarking(m.pool, 5, 4, 31); assert.ok(r.ok);
  assert.deepStrictEqual([r.assignment.maxPoints, r.submission.studentName, r.submission.text, r.submission.files[0].name, r.rubric.criteria.length, r.grade.status], [20, "Amina W", "My answer", "essay.pdf", 2, "draft"]);
  assert.ok(!JSON.stringify(r).includes("stored_name") && !JSON.stringify(r).includes("password"));
  const f = m.log.find((x) => /lms_submission_files/.test(x.sql)); assert.ok(/course_id = @c AND deleted_at IS NULL/.test(f.sql)); assert.strictEqual(f.inputs.c, 5);
  assert.strictEqual((await M.getForMarking(mkp().pool, 5, 4, 99)).notFound, true); assert.strictEqual((await M.getForMarking(mkp().pool, 6, 4, 31)).notFound, true); assert.strictEqual((await M.getForMarking(mkp().pool, 5, 5, 31)).notFound, true);
});

const T = "marking-test-school", folder = path.join(UPLOADS_ROOT, T, "lms-private"), clean = () => fs.rmSync(path.join(UPLOADS_ROOT, T), { recursive: true, force: true });
test("readFileForStaff: the file must belong to THIS submitted attempt, assignment and course; the bytes come from lms-private; a missing file and a stored name pointing outside the folder look like 'not found'", async () => {
  clean(); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, "abc.pdf"), Buffer.from("PDFDATA")); fs.writeFileSync(path.join(UPLOADS_ROOT, T, "outside.pdf"), Buffer.from("SECRET"));
  try {
    const q = (stored) => ["FROM lms_submission_files sf INNER JOIN lms_submissions sb", (i) => (i.f === 8 && i.sid === 31 && i.a === 4 && i.c === 5 ? [{ stored_name: stored, original_name: "essay.pdf", ext: "pdf" }] : [])];
    const m = makeMockPool([q("abc.pdf")]); const r = await M.readFileForStaff(m.pool, 5, 4, 31, 8, { tenant: T }); assert.ok(r.ok); assert.strictEqual(r.buffer.toString(), "PDFDATA"); assert.strictEqual(r.name, "essay.pdf");
    const s = m.log[0].sql; assert.ok(/sb\.assignment_id = @a AND sb\.course_id = @c AND sb\.status = 'submitted'/.test(s) && /sf\.submission_id = @sid AND sf\.assignment_id = @a AND sf\.course_id = @c AND sf\.deleted_at IS NULL/.test(s));
    for (const args of [[6, 4, 31, 8], [5, 5, 31, 8], [5, 4, 32, 8], [5, 4, 31, 9]]) assert.strictEqual((await M.readFileForStaff(makeMockPool([q("abc.pdf")]).pool, ...args, { tenant: T })).notFound, true, args.join());
    assert.strictEqual((await M.readFileForStaff(makeMockPool([q("gone.pdf")]).pool, 5, 4, 31, 8, { tenant: T })).notFound, true);
    const esc = await M.readFileForStaff(makeMockPool([q("../outside.pdf")]).pool, 5, 4, 31, 8, { tenant: T }); assert.strictEqual(esc.notFound, true, "path traversal is cut to the base name");
    assert.strictEqual((await M.readFileForStaff(makeMockPool([q("abc.pdf")]).pool, 5, 4, 31, 8, { tenant: "other-school" })).notFound, true, "another school's folder does not have the file");
  } finally { clean(); }
});

test("feedbackForStudent: students only, own RETURNED grades of an available assignment (never drafts), criteria named from the rubric; staff get 'not found'", async () => {
  const FB = ["FROM lms_submission_grades g INNER JOIN lms_submissions sb", (i) => (i.s === 21 && i.c === 5 && i.a === 4 ? [{ submission_id: 31, attempt_no: 1, raw_points: "13.33", penalty_percent: 10, final_points: "12.00", max_points: "20.00", comment: "Well done", returned_at: "2026-10-03T08:00:00Z" }] : [])];
  const m = makeMockPool([FB, ...RUBRIC, LIVEA, SCORES([{ criterion_id: 31, level_position: 1, points: "10.00", comment: null }, { criterion_id: 32, level_position: 2, points: "0.00", comment: "Fix" }])]);
  const r = await M.feedbackForStudent(m.pool, student(21), 5, 4); assert.ok(r.ok); const it = r.items[0];
  assert.deepStrictEqual([it.rawPoints, it.latePenaltyPercent, it.finalPoints, it.maxPoints, it.comment], [13.33, 10, 12, 20, "Well done"]); assert.deepStrictEqual(it.criteria.map((c) => [c.criterion, c.level, c.points, c.comment]), [["Argument", "Strong", 10, ""], ["Language", "Poor", 0, "Fix"]]);
  const fbq = m.log.find((x) => /FROM lms_submission_grades g INNER JOIN lms_submissions sb/.test(x.sql)); const q = fbq.sql; assert.ok(/g\.status = 'returned'/.test(q) && /g\.student_id = @s/.test(q) && /sb\.student_id = @s/.test(q) && /a\.status = 'published'/.test(q), "only returned, only own, only published"); assert.strictEqual(fbq.inputs.s, 21);
  assert.ok(!/stored_name|graded_by/.test(JSON.stringify(r)));
  const other = makeMockPool([FB]); assert.deepStrictEqual((await M.feedbackForStudent(other.pool, student(22), 5, 4)).items, []);
  const st = makeMockPool([FB]); assert.strictEqual((await M.feedbackForStudent(st.pool, teacher(), 5, 4)).notFound, true); assert.strictEqual(st.log.length, 0);
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const MK = "/courses/:courseId/assignments/:assignmentId/submissions", MI = `${MK}/:submissionId`, FBP = "/courses/:courseId/learn/assignments/:assignmentId/feedback";
const P = { courseId: "5", assignmentId: "4", submissionId: "31" };
const full = () => makeMockPool([staff([5]), live(), ASSIGN(), SUB(), NORUBRIC, LIVEA, SAVE(), GRADE(), SCORES(), ["SELECT COUNT(*) AS n FROM lms_submissions s", () => [{ n: 0 }]], ["FROM lms_submissions s LEFT JOIN Students st", () => []],
  ["UPDATE lms_submission_grades SET status = 'returned'", () => [{ id: 1 }]], ["FROM Students WHERE id = @s", () => [{ name: "A", admissionNo: "1" }]], ["FROM lms_submission_files WHERE submission_id = @sid", () => []]]);
test("routes: course staff with lms.submission.grade mark; students and non-members get 403 and nothing is read or written; bad ids are 404; bad filter and bad body are 400", async () => {
  const ok = [["get", MK, 200], ["get", MI, 200], ["put", `${MI}/grade`, 200, { points: 12 }], ["post", `${MI}/return`, 200]];
  for (const [method, p, code, body] of ok) { const r = await call(method, p, { user: teacher(), pool: full().pool, params: P, body: body || {} }); assert.strictEqual(r.res.statusCode, code, `${method} ${p}: ${JSON.stringify(r.res.body)}`); }
  for (const [method, p, , body] of ok) {
    const st = full(); const r = await call(method, p, { user: student(), pool: st.pool, params: P, body: body || {} }); assert.strictEqual(r.res.statusCode, 403, `student ${method} ${p}`); assert.strictEqual(writes(st).length, 0);
    const ns = makeMockPool([staff([6]), live(), ASSIGN(), SUB()]); const n = await call(method, p, { user: teacher(), pool: ns.pool, params: P, body: body || {} }); assert.strictEqual(n.res.statusCode, 403, `non-member ${method} ${p}`); assert.ok(!ns.log.some((x) => /lms_submission|lms_submissions/.test(x.sql)), "no submission data read for a non-member");
  }
  const files = await call("get", `${MI}/files/:fileId`, { user: teacher(), pool: makeMockPool([staff([6]), live()]).pool, params: { ...P, fileId: "8" } }); assert.strictEqual(files.res.statusCode, 403);
  assert.strictEqual((await call("get", MI, { user: teacher(), pool: full().pool, params: { ...P, submissionId: "abc" } })).res.statusCode, 404);
  assert.strictEqual((await call("get", MK, { user: teacher(), pool: full().pool, params: P, query: { filter: "nope" } })).res.statusCode, 400);
  assert.strictEqual((await call("put", `${MI}/grade`, { user: teacher(), pool: full().pool, params: P, body: { points: 99 } })).res.statusCode, 400);
  const ret = await call("post", `${MI}/return`, { user: teacher(), pool: makeMockPool([staff([5]), live(), SUB(), ["UPDATE lms_submission_grades SET status = 'returned'", () => []], ["SELECT TOP 1 status FROM lms_submission_grades", () => []]]).pool, params: P }); assert.deepStrictEqual([ret.res.statusCode, ret.res.body.code], [409, "NOT_GRADED"]);
});
test("routes: the student feedback route is student-only; the teacher is refused before any query", async () => {
  const t = makeMockPool([]); const r = await call("get", FBP, { user: teacher(), pool: t.pool, params: { courseId: "5", assignmentId: "4" } }); assert.strictEqual(r.res.statusCode, 403); assert.strictEqual(t.log.length, 0);
});
test("tenant isolation: school A's marking calls never touch school B's database; school B's submission is invisible to A by id guessing", async () => {
  const resp = (own) => [staff([5]), live(), ASSIGN(), ["SELECT TOP 1 id, student_id, attempt_no, body_text", onlyIds("sid", own, [SUBROW({ body_text: "B secret" })])], NORUBRIC, LIVEA, ["FROM Students WHERE id = @s", () => []], ["FROM lms_submission_files WHERE submission_id = @sid", () => []], GRADE(), SCORES()];
  const Tn = makeTenants({ A: resp([31]), B: resp([77]) });
  const a = await call("get", MI, { user: teacher(), pool: Tn.A.pool, params: P, tenant: "A" }); assert.strictEqual(a.res.statusCode, 200); Tn.assertQueried("A"); Tn.assertUntouched("B");
  const g = await call("get", MI, { user: teacher(), pool: Tn.A.pool, params: { ...P, submissionId: "77" }, tenant: "A" }); assert.strictEqual(g.res.statusCode, 404); assert.ok(!JSON.stringify(g.res.body).includes("B secret")); Tn.assertUntouched("B");
});
test("static: step 020 is additive and follows 019; unique grade per submission; both tables blocklisted; all 6 routes gated and registered after the router guards; no raw db, no req.body, no user value in SQL text", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "020_lms_marking"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "019_lms_rubrics") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl)); for (const t of ["lms_submission_grades", "lms_submission_rubric_scores"]) assert.ok(new RegExp(`CREATE TABLE ${t} `).test(ddl), t);
  for (const ix of ["UX_lms_submission_grades_submission", "UX_lms_submission_rubric_scores"]) assert.ok(new RegExp(`CREATE UNIQUE INDEX ${ix}`).test(ddl), ix);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), line = server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")); for (const t of ["lms_submission_grades", "lms_submission_rubric_scores"]) assert.ok(line.includes(`"${t}"`), t);
  const router = require("../routes/lms"), mine = router.stack.filter((l) => l.route && (l.route.path.startsWith(MK) || l.route.path === FBP)); assert.strictEqual(mine.length, 8, "6 marking routes + 2 group routes (L8.4b)");
  const first = router.stack.findIndex((l) => l.route); for (const l of mine) { assert.ok(router.stack.indexOf(l) > first, l.route.path); assert.ok(l.route.stack.length >= 3, `${l.route.path} needs permission + membership`); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsMarking.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{(?!base|FILTER_SQL\[filter\]|groups ===|A\.AVAILABLE|n \?|Array\.from|i\b)[^}]*\}/.test(piece), "unexpected interpolation in SQL: " + piece.slice(0, 70));
});

/* ---------------- L5.4b: student status + read-only rubric ---------------- */
test("attachStatus: not_started / draft / submitted / returned from the student's OWN rows (id from the token, one bounded query); points shown only when the latest attempt is returned; staff untouched; a failed read leaves the list as it was", async () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const rows = [{ assignment_id: 2, status: "draft", attempt_no: 1, final_points: null, max_points: null }, { assignment_id: 3, status: "submitted", attempt_no: 1, final_points: null, max_points: null },
    { assignment_id: 4, status: "submitted", attempt_no: 1, final_points: "12.00", max_points: "20.00" }, { assignment_id: 4, status: "submitted", attempt_no: 2, final_points: null, max_points: null },
    { assignment_id: 5, status: "submitted", attempt_no: 1, final_points: "5.00", max_points: "10.00" }, { assignment_id: 5, status: "draft", attempt_no: 2, final_points: null, max_points: null }];
  const m = makeMockPool([["FROM lms_submissions sb LEFT JOIN lms_submission_grades g", (i) => (i.s === 21 && i.c === 5 ? rows : [])]]);
  const out = await M.attachStatus(m.pool, student(21), 5, items); const st = (id) => out.find((x) => x.id === id).submissionStatus;
  assert.deepStrictEqual(st(1), { status: "not_started", attemptsUsed: 0 }); assert.deepStrictEqual(st(2), { status: "draft", attemptsUsed: 0 }); assert.deepStrictEqual(st(3), { status: "submitted", attemptsUsed: 1 });
  assert.deepStrictEqual(st(4), { status: "submitted", attemptsUsed: 2 }, "a newer unmarked attempt hides the older grade"); assert.deepStrictEqual(st(5), { status: "returned", attemptsUsed: 1, finalPoints: 5, maxPoints: 10 });
  assert.deepStrictEqual(m.log.filter((x) => !/lms_assignment_releases/.test(x.sql)).length, 1, "one bounded status query (plus the lazy release update, L5.4b-2)"); const q = m.log.find((x) => !/lms_assignment_releases/.test(x.sql)); assert.ok(/sb\.course_id = @c AND sb\.student_id = @s AND sb\.assignment_id IN \(@i0, @i1, @i2, @i3, @i4\)/.test(q.sql) && /g\.status = 'returned'/.test(q.sql)); assert.deepStrictEqual([q.inputs.s, q.inputs.c], [21, 5]);
  const t = makeMockPool([]); assert.deepStrictEqual(await M.attachStatus(t.pool, teacher(), 5, items), items); assert.strictEqual(t.log.length, 0);
  const e = makeMockPool([["FROM lms_submissions sb LEFT JOIN", () => { throw new Error("db down"); }]]); assert.deepStrictEqual(await M.attachStatus(e.pool, student(21), 5, items), items);
  const big = makeMockPool([["FROM lms_submissions sb LEFT JOIN", () => []]]); await M.attachStatus(big.pool, student(21), 5, Array.from({ length: 150 }, (_, i) => ({ id: i + 1 }))); assert.ok(!("i100" in (big.log.find((x) => /sb\.assignment_id IN/.test(x.sql))).inputs) && "i99" in (big.log.find((x) => /sb\.assignment_id IN/.test(x.sql))).inputs, "at most 100 ids");
});
test("rubricForStudent: only for an available published assignment of this course, no table ids or outcome tags in the answer, null when none attached, staff and other courses 'not found'", async () => {
  const AV = ["SELECT TOP 1 a.id FROM lms_assignments a WHERE a.id = @a AND a.course_id = @c", onlyIds("c", [5], (i) => (i.a === 4 ? [{ id: 4 }] : []))];
  const m = makeMockPool([AV, ...RUBRIC, LIVEA]); const r = await M.rubricForStudent(m.pool, student(), 5, 4); assert.ok(r.ok);
  assert.deepStrictEqual([r.rubric.maxPoints, r.rubric.criteria.length, r.rubric.criteria[0].levels.map((l) => l.label)], [15, 2, ["Strong", "Weak"]]);
  const j = JSON.stringify(r); assert.ok(!/"id"|outcomes|createdAt|courseId/.test(j), j); assert.ok(/a\.status = 'published'/.test(m.log[0].sql));
  assert.strictEqual((await M.rubricForStudent(makeMockPool([AV]).pool, student(), 6, 4)).notFound, true); assert.strictEqual((await M.rubricForStudent(makeMockPool([AV]).pool, student(), 5, 9)).notFound, true);
  const t = makeMockPool([AV]); assert.strictEqual((await M.rubricForStudent(t.pool, teacher(), 5, 4)).notFound, true); assert.strictEqual(t.log.length, 0);
  const none = await M.rubricForStudent(makeMockPool([AV, NORUBRIC, LIVEA]).pool, student(), 5, 4); assert.deepStrictEqual([none.ok, none.rubric], [true, null]);
});
test("routes: student list/detail carry submissionStatus; the student rubric route is student-only", async () => {
  const pool = () => makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["FROM lms_course_enrolments", () => [{ status: "active" }]], ["FROM lms_assignments a WHERE a.course_id = @c", () => []], ["FROM lms_submissions sb LEFT JOIN", () => [{ assignment_id: 4, status: "draft", attempt_no: 1 }]]]);
  const t = makeMockPool([]); assert.strictEqual((await call("get", "/courses/:courseId/learn/assignments/:assignmentId/rubric", { user: teacher(), pool: t.pool, params: { courseId: "5", assignmentId: "4" } })).res.statusCode, 403); assert.strictEqual(t.log.length, 0);
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", "lms.js"), "utf8"); assert.ok(/marking\.attachStatus\(req\.pool, req\.user, cid\(req\), r\.items, \{ tenant: tenantOf\(req\) \}\)/.test(src) && /marking\.attachStatus\(req\.pool, req\.user, cid\(req\), \[r\.assignment\], \{ tenant: tenantOf\(req\) \}\)/.test(src)); void pool;
});
