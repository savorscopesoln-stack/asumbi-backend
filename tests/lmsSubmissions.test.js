/* L5.2a — student submissions (text). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsSubmissions.test.js");
const S = require("../utils/lmsSubmissions");
const A = require("../utils/lmsAssignments");
const planner = require("../utils/lmsPlanner");
const { on } = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" }), student = (id = 21) => ({ id, role: "student", source: "Students" }), admin = { id: 1, role: "admin", source: "Users" };
const NOW = new Date("2026-11-10T10:00:00Z"), LATE = new Date("2026-11-11T10:00:00Z"), VERY_LATE = new Date("2026-11-20T10:00:00Z");
const SET = { lateSubmission: "accept", latePenaltyPercent: 10, files: { allowedExtensions: ["pdf"], maxFileMb: 10 } };
const D = (s) => new Date(s);
const arow = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Essay 1", instructions: "Write.", status: "published", published_at: null, available_from: null, due_at: D("2026-11-10T14:00:00Z"), cutoff_at: null, submission_type: "text",
  allowed_extensions: null, max_file_mb: null, max_files: 5, max_attempts: 2, late_policy: null, late_penalty_percent: null, max_points: 100, work_mode: "individual", attachments_json: null, created_at: NOW, updated_at: NOW, course_status: "published", ...o });
const srow = (o = {}) => ({ id: 90, assignment_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "draft", body_text: "My answer", submitted_at: null, is_late: 0, late_penalty_percent: null, created_at: NOW, updated_at: NOW, ...o });
const ASG = (r) => ["c.status AS course_status", (i) => (r && i.id === r.id && i.c === r.course_id ? [r] : [])];
const MINE = (rows) => ["FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s ORDER BY attempt_no DESC", (i) => rows.filter((x) => x.student_id === i.s && x.assignment_id === i.a && x.course_id === i.c)];
const UPD_DRAFT = (r) => ["UPDATE lms_submissions SET body_text", (i) => (r ? [{ ...r, body_text: i.t, updated_at: i.now }] : [])];
const INS = (r) => ["INSERT INTO lms_submissions", (i) => (r ? [{ ...r, body_text: i.t, attempt_no: 2 }] : [])];
const SUBMIT = (r) => ["UPDATE lms_submissions SET status = 'submitted'", (i) => (r ? [{ ...r, status: "submitted", submitted_at: i.now, is_late: i.late, late_penalty_percent: i.pen }] : [])];
const EXISTS_DRAFT = (yes) => ["SELECT TOP 1 id FROM lms_submissions", () => (yes ? [{ id: 90 }] : [])];
const writes = (log) => log.filter((x) => /^(INSERT INTO|UPDATE) lms_submissions/.test(x.sql));
const watch = (tenant) => { const got = []; const off = on("lms.submission.submitted", (e) => { if (e.tenant === tenant) got.push(e); }); return { got, off }; };

test("validateText: tags and control characters stripped, line breaks kept, length capped, unknown fields and non-strings refused; submit may omit text, draft may not", () => {
  const ok = S.validateText({ text: " Hello <b>world</b>\r\n\r\n\r\n\r\n\r\nBye\u0000 " }, { required: true }); assert.ok(ok.ok); assert.strictEqual(ok.text, "Hello bworld/b\n\n\nBye");
  assert.strictEqual(S.validateText({ text: "" }, { required: true }).text, "");
  for (const b of [{ text: "x".repeat(S.MAX_TEXT + 1) }, { text: 5 }, { text: "a", status: "submitted" }, { text: "a", student_id: 9 }, [], "text", undefined, null, {}]) assert.strictEqual(S.validateText(b, { required: true }).ok, false, JSON.stringify(b)?.slice(0, 40));
  assert.strictEqual(S.validateText({ text: "x".repeat(S.MAX_TEXT) }, { required: true }).ok, true);
  for (const b of [undefined, null, {}]) assert.deepStrictEqual(S.validateText(b, { required: false }), { ok: true, text: undefined });
  assert.strictEqual(S.validateText({ x: 1 }, { required: false }).ok, false);
});
test("windowOf: no due date = open; on time; block closes at due; accept = late and open until cutoff; penalise stores the percent; after cutoff closed; exactly at due is on time", () => {
  const m = (o) => ({ ...A.model(arow(o)) }), W = (o, now, set = SET) => S.windowOf(m(o), set, now);
  assert.deepStrictEqual(W({ due_at: null }, VERY_LATE), { open: true, late: false, penaltyPercent: null });
  assert.deepStrictEqual(W({}, NOW), { open: true, late: false, penaltyPercent: null }); assert.strictEqual(W({}, D("2026-11-10T14:00:00Z")).late, false); assert.strictEqual(W({}, D("2026-11-10T14:00:01Z")).late, true);
  assert.deepStrictEqual(W({}, LATE), { open: true, late: true, penaltyPercent: null }); // school default accept
  assert.strictEqual(W({ late_policy: "block" }, LATE).open, false); assert.strictEqual(W({ late_policy: "block" }, LATE).code, "DEADLINE_PASSED");
  assert.deepStrictEqual(W({ late_policy: "penalise", late_penalty_percent: 25 }, LATE), { open: true, late: true, penaltyPercent: 25 });
  assert.strictEqual(W({ late_policy: "penalise" }, LATE).penaltyPercent, 10); // school default percent
  const cut = { late_policy: "accept", cutoff_at: D("2026-11-15T00:00:00Z") }; assert.strictEqual(W(cut, LATE).open, true); assert.strictEqual(W(cut, VERY_LATE).open, false); assert.strictEqual(W(cut, VERY_LATE).code, "CUTOFF_PASSED");
  assert.strictEqual(W({}, LATE, { ...SET, lateSubmission: "block" }).open, false); // school default block applies when the assignment has none
});

test("getState: only this student's own rows (student id from the token, course and assignment in the query); attempts, draft, window and reasons; archived = read only; hidden = not found; non-students get nothing and no query runs", async () => {
  const subs = [srow({ attempt_no: 1, status: "submitted", submitted_at: D("2026-11-09T10:00:00Z"), body_text: "First" }), srow({ id: 91, attempt_no: 2, status: "draft", body_text: "Second try" }), srow({ id: 92, student_id: 22, body_text: "SOMEONE ELSE" })];
  const m = makeMockPool([ASG(arow()), MINE(subs)]); const r = await S.getState(m.pool, student(21), 5, 4, { settings: SET, now: NOW });
  assert.ok(r.ok); assert.deepStrictEqual([r.attemptsUsed, r.attemptsLeft, r.maxAttempts, r.canWrite, r.closedReason], [1, 1, 2, true, null]); assert.strictEqual(r.draft.text, "Second try"); assert.strictEqual(r.attempts[0].text, "First");
  assert.ok(!JSON.stringify(r).includes("SOMEONE ELSE")); assert.deepStrictEqual(m.log[1].inputs, { c: 5, a: 4, s: 21 }); assert.ok(/student_id = @s/.test(m.log[1].sql) && /course_id = @c/.test(m.log[1].sql) && /TOP 10/.test(m.log[1].sql));
  const pre = await S.getState(makeMockPool([ASG(arow()), MINE([srow({ attempt_no: 1, status: "submitted", submitted_at: NOW, body_text: "First answer" })])]).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.deepStrictEqual([pre.draft, pre.prefillText], [null, "First answer"]);
  assert.strictEqual(r.prefillText, null); // a draft already exists
  const preClosed = await S.getState(makeMockPool([ASG(arow({ max_attempts: 1 })), MINE([srow({ status: "submitted", submitted_at: NOW })])]).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.strictEqual(preClosed.prefillText, null);
  assert.strictEqual((await S.getState(makeMockPool([ASG(arow()), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: NOW })).prefillText, null); // first attempt: nothing to copy
  const used = await S.getState(makeMockPool([ASG(arow({ max_attempts: 1 })), MINE([srow({ status: "submitted", submitted_at: NOW })])]).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.deepStrictEqual([used.canWrite, used.closedReason.code, used.attemptsLeft], [false, "ATTEMPTS_USED", 0]);
  const closed = await S.getState(makeMockPool([ASG(arow({ late_policy: "block" })), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: LATE }); assert.deepStrictEqual([closed.canWrite, closed.closedReason.code, closed.window.open], [false, "DEADLINE_PASSED", false]);
  const arch = await S.getState(makeMockPool([ASG(arow({ course_status: "archived" })), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.deepStrictEqual([arch.ok, arch.canWrite, arch.closedReason.code], [true, false, "COURSE_READ_ONLY"]);
  assert.strictEqual((await S.getState(makeMockPool([ASG(null), MINE([])]).pool, student(21), 5, 4, { settings: SET, now: NOW })).notFound, true);
  for (const u of [teacher(), admin, null, { id: 21, role: "student", source: "Teachers" }]) { const k = makeMockPool([ASG(arow()), MINE(subs)]); assert.strictEqual((await S.getState(k.pool, u, 5, 4, { settings: SET, now: NOW })).notFound, true); assert.strictEqual(k.log.length, 0); }
  const q = m.log[0].sql; assert.ok(/a\.status = 'published'/.test(q) && /a\.available_from IS NULL OR a\.available_from <= SYSUTCDATETIME\(\)/.test(q) && /c\.status IN \('published','archived'\)/.test(q) && /a\.course_id = @c/.test(q));
});

test("saveDraft: updates the existing draft; creates the next attempt only while attempts remain (limit inside the SQL); a parallel-save unique violation falls back to an update; nothing is written when the window is closed, the course is archived or the text is bad", async () => {
  const upd = makeMockPool([ASG(arow()), UPD_DRAFT(srow())]); const a = await S.saveDraft(upd.pool, student(21), 5, 4, { text: "New text" }, { settings: SET, now: NOW });
  assert.ok(a.ok && a.draft.text === "New text" && a.draft.attemptNo === 1); assert.strictEqual(writes(upd.log).length, 1); const w = writes(upd.log)[0]; assert.deepStrictEqual([w.inputs.c, w.inputs.a, w.inputs.s], [5, 4, 21]); assert.ok(/status = 'draft'/.test(w.sql));
  const ins = makeMockPool([ASG(arow()), UPD_DRAFT(null), INS(srow())]); const b = await S.saveDraft(ins.pool, student(21), 5, 4, { text: "Second" }, { settings: SET, now: NOW }); assert.ok(b.ok && b.draft.attemptNo === 2);
  const iq = writes(ins.log).find((x) => /^INSERT/.test(x.sql)); assert.strictEqual(iq.inputs.max, 2); assert.ok(/WHERE x\.n < @max/.test(iq.sql) && /status = 'submitted'/.test(iq.sql) && /student_id = @s/.test(iq.sql));
  const none = await S.saveDraft(makeMockPool([ASG(arow()), UPD_DRAFT(null), INS(null)]).pool, student(21), 5, 4, { text: "x" }, { settings: SET, now: NOW }); assert.deepStrictEqual([none.ok, none.code], [false, "ATTEMPTS_USED"]);
  let n = 0; const race = makeMockPool([ASG(arow()), ["UPDATE lms_submissions SET body_text", (i) => { n += 1; return n === 1 ? [] : [{ ...srow(), body_text: i.t }]; }], ["INSERT INTO lms_submissions", () => { const e = new Error("dup"); e.number = 2601; throw e; }]]);
  assert.ok((await S.saveDraft(race.pool, student(21), 5, 4, { text: "race" }, { settings: SET, now: NOW })).ok); assert.strictEqual(n, 2);
  const boom = makeMockPool([ASG(arow()), UPD_DRAFT(null), ["INSERT INTO lms_submissions", () => { throw new Error("db down"); }]]); await assert.rejects(S.saveDraft(boom.pool, student(21), 5, 4, { text: "x" }, { settings: SET, now: NOW }), /db down/);
  for (const [row, now, body, code] of [[arow({ late_policy: "block" }), LATE, { text: "x" }, "DEADLINE_PASSED"], [arow({ cutoff_at: D("2026-11-15T00:00:00Z") }), VERY_LATE, { text: "x" }, "CUTOFF_PASSED"], [arow({ course_status: "archived" }), NOW, { text: "x" }, "COURSE_READ_ONLY"]]) {
    const k = makeMockPool([ASG(row), UPD_DRAFT(srow()), INS(srow())]); const r = await S.saveDraft(k.pool, student(21), 5, 4, body, { settings: SET, now }); assert.strictEqual(r.code, code); assert.strictEqual(writes(k.log).length, 0);
  }
  const k2 = makeMockPool([ASG(arow()), UPD_DRAFT(srow())]); assert.strictEqual((await S.saveDraft(k2.pool, student(21), 5, 4, { text: 3 }, { settings: SET, now: NOW })).ok, false); assert.strictEqual(k2.log.length, 0);
  const k3 = makeMockPool([ASG(null), UPD_DRAFT(srow())]); assert.strictEqual((await S.saveDraft(k3.pool, student(21), 5, 4, { text: "x" }, { settings: SET, now: NOW })).notFound, true); assert.strictEqual(writes(k3.log).length, 0);
  const k4 = makeMockPool([ASG(arow()), UPD_DRAFT(srow())]); assert.strictEqual((await S.saveDraft(k4.pool, teacher(), 5, 4, { text: "x" }, { settings: SET, now: NOW })).notFound, true); assert.strictEqual(k4.log.length, 0);
});

test("submit: on time, late (accept) and late (penalise, percent stored as a snapshot); one guarded statement; event + audit once with ids only", async () => {
  const w = watch("subT1");
  const t1 = makeMockPool([ASG(arow()), SUBMIT(srow())]); const a = await S.submit(t1.pool, student(21), 5, 4, undefined, { tenant: "subT1", settings: SET, now: NOW }); assert.ok(a.ok); assert.deepStrictEqual([a.submission.late, a.submission.latePenaltyPercent, a.submission.attemptNo], [false, null, 1]);
  const q = writes(t1.log)[0]; assert.deepStrictEqual([q.inputs.late, q.inputs.pen, q.inputs.c, q.inputs.a, q.inputs.s], [0, null, 5, 4, 21]); assert.ok(/WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft'/.test(q.sql) && /LEN\(LTRIM\(RTRIM\(COALESCE\(body_text, ''\)\)\)\) > 0/.test(q.sql));
  assert.strictEqual(q.inputs.now.getTime(), NOW.getTime()); // server clock, not client input
  const t2 = makeMockPool([ASG(arow()), SUBMIT(srow())]); const b = await S.submit(t2.pool, student(21), 5, 4, {}, { tenant: "subT1", settings: SET, now: LATE }); assert.deepStrictEqual([b.submission.late, b.submission.latePenaltyPercent], [true, null]);
  const t3 = makeMockPool([ASG(arow({ late_policy: "penalise", late_penalty_percent: 20 })), SUBMIT(srow())]); const c = await S.submit(t3.pool, student(21), 5, 4, undefined, { tenant: "subT1", settings: SET, now: LATE }); assert.deepStrictEqual([writes(t3.log)[0].inputs.late, writes(t3.log)[0].inputs.pen, c.submission.latePenaltyPercent], [1, 20, 20]);
  assert.ok(t1.log.some((x) => /INSERT INTO lms_audit_log/.test(x.sql))); await tick(); assert.strictEqual(w.got.length, 3); assert.deepStrictEqual(Object.keys(w.got[0]).filter((k) => k !== "at" && k !== "event").sort(), ["assignmentId", "courseId", "late", "studentId", "submissionId", "tenant"]); // ids only (the bus adds event + at) assert.strictEqual(w.got[1].late, true); w.off();
});
test("submit: carrying text saves it first; empty text, no draft, closed window, used attempts, file-only assignments, archived course and non-students are refused with nothing submitted and no event", async () => {
  const w = watch("subT2");
  const withText = makeMockPool([ASG(arow()), UPD_DRAFT(srow()), SUBMIT(srow())]); assert.ok((await S.submit(withText.pool, student(21), 5, 4, { text: "Final" }, { tenant: "subT2", settings: SET, now: NOW })).ok); assert.deepStrictEqual(writes(withText.log).map((x) => x.sql.split(" ").slice(0, 3).join(" ")), ["UPDATE lms_submissions SET", "UPDATE lms_submissions SET"]); assert.strictEqual(writes(withText.log)[0].inputs.t, "Final");
  const empty = await S.submit(makeMockPool([ASG(arow()), SUBMIT(null), EXISTS_DRAFT(true)]).pool, student(21), 5, 4, undefined, { tenant: "subT2", settings: SET, now: NOW }); assert.strictEqual(empty.code, "EMPTY_SUBMISSION");
  const nod = await S.submit(makeMockPool([ASG(arow()), SUBMIT(null), EXISTS_DRAFT(false)]).pool, student(21), 5, 4, undefined, { tenant: "subT2", settings: SET, now: NOW }); assert.strictEqual(nod.code, "NO_DRAFT");
  const used = await S.submit(makeMockPool([ASG(arow()), UPD_DRAFT(null), INS(null)]).pool, student(21), 5, 4, { text: "again" }, { tenant: "subT2", settings: SET, now: NOW }); assert.strictEqual(used.code, "ATTEMPTS_USED");
  for (const [row, now, code] of [[arow({ late_policy: "block" }), LATE, "DEADLINE_PASSED"], [arow({ cutoff_at: D("2026-11-15T00:00:00Z") }), VERY_LATE, "CUTOFF_PASSED"], [arow({ course_status: "archived" }), NOW, "COURSE_READ_ONLY"]]) {
    const k = makeMockPool([ASG(row), SUBMIT(srow()), UPD_DRAFT(srow())]); const r = await S.submit(k.pool, student(21), 5, 4, undefined, { tenant: "subT2", settings: SET, now }); assert.strictEqual(r.code, code); assert.strictEqual(writes(k.log).length, 0, code);
  }
  for (const u of [teacher(), admin, null]) { const k = makeMockPool([ASG(arow()), SUBMIT(srow())]); assert.strictEqual((await S.submit(k.pool, u, 5, 4, undefined, { tenant: "subT2", settings: SET, now: NOW })).notFound, true); assert.strictEqual(k.log.length, 0); }
  assert.strictEqual((await S.submit(makeMockPool([ASG(arow()), SUBMIT(srow())]).pool, student(21), 5, 4, { text: 1 }, { tenant: "subT2", settings: SET, now: NOW })).ok, false);
  await tick(); assert.strictEqual(w.got.length, 1); w.off(); // only the first (successful) submit emitted
});

test("deleting an assignment is refused (HAS_SUBMISSIONS) once any work is submitted; drafts alone do not block; the planner drops assignments the student already handed in", async () => {
  const blocked = makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["FROM lms_submissions WHERE assignment_id = @id", (i) => (i.id === 4 && i.c === 5 ? [{ id: 90 }] : [])], ["UPDATE lms_assignments SET deleted_at", () => [{ id: 4 }]]]);
  const r = await A.deleteAssignment(blocked.pool, teacher(), 5, 4); assert.deepStrictEqual([r.ok, r.code], [false, "HAS_SUBMISSIONS"]); assert.ok(!blocked.log.some((x) => /^UPDATE lms_assignments/.test(x.sql)));
  assert.ok(/status = 'submitted'/.test(blocked.log.find((x) => /FROM lms_submissions/.test(x.sql)).sql));
  const free = makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["UPDATE lms_assignments SET deleted_at", () => [{ id: 4 }]]]); assert.ok((await A.deleteAssignment(free.pool, teacher(), 5, 4)).ok);
  const m = makeMockPool([["FROM lms_assignments a", () => []]]); await planner.getPlanner(m.pool, student(21), {}, new Date("2026-10-29T08:00:00Z"));
  const q = m.log.find((x) => /FROM lms_assignments a/.test(x.sql)).sql; assert.ok(/NOT EXISTS \(SELECT 1 FROM lms_submissions sb WHERE sb\.assignment_id = a\.id AND sb\.course_id = a\.course_id AND sb\.student_id = @s AND sb\.status = 'submitted'\)/.test(q));
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
const enrolled = (ids) => ["FROM lms_course_enrolments WHERE course_id", onlyIds("c", ids, [{ status: "active" }])];
const SUBP = "/courses/:courseId/learn/assignments/:assignmentId/submission";
const OPEN_COURSE = ["FROM lms_courses WHERE id", () => [{ status: "published" }]];
test("routes: only ACTIVE students of THIS course; staff, strangers and other courses get the same 403 and nothing is read or written; bad ids 404; bad body 400; closed work 409 with a code; success statuses", async () => {
  const mk = (extra = []) => makeMockPool([enrolled([5]), OPEN_COURSE, ASG(arow()), MINE([srow({ status: "draft" })]), UPD_DRAFT(srow()), SUBMIT(srow()), ...extra]);
  const p = { courseId: "5", assignmentId: "4" };
  const g = await call("get", SUBP, { user: student(), pool: mk().pool, params: p }); assert.strictEqual(g.res.statusCode, 200); assert.ok(g.res.body.success && g.res.body.draft && !("ok" in g.res.body));
  const d = await call("put", `${SUBP}/draft`, { user: student(), pool: mk().pool, params: p, body: { text: "hello" } }); assert.strictEqual(d.res.statusCode, 200); assert.strictEqual(d.res.body.draft.text, "hello");
  const s = await call("post", `${SUBP}/submit`, { user: student(), pool: mk().pool, params: p, body: {} }); assert.strictEqual(s.res.statusCode, 201); assert.strictEqual(s.res.body.submission.attemptNo, 1);
  const refused = [];
  for (const [user, courseId] of [[teacher(), "5"], [admin, "5"], [student(), "6"], [student(), "999"]]) for (const [m, path_, b] of [["get", SUBP, {}], ["put", `${SUBP}/draft`, { text: "x" }], ["post", `${SUBP}/submit`, {}]]) { const k = mk(); const r = await call(m, path_, { user, pool: k.pool, params: { courseId, assignmentId: "4" }, body: b }); assert.strictEqual(r.res.statusCode, 403, `${m} ${courseId}`); assert.strictEqual(writes(k.log).length, 0); assert.ok(!k.log.some((x) => /lms_submissions|lms_assignments/.test(x.sql))); refused.push(r.res); }
  sameForbidden(refused[0], refused[8]); sameForbidden(refused[2], refused[11]);
  for (const [m, path_, b] of [["get", SUBP, {}], ["put", `${SUBP}/draft`, { text: "x" }], ["post", `${SUBP}/submit`, {}]]) assert.strictEqual((await call(m, path_, { user: student(), pool: mk().pool, params: { courseId: "5", assignmentId: "x" }, body: b })).res.statusCode, 404);
  assert.strictEqual((await call("put", `${SUBP}/draft`, { user: student(), pool: mk().pool, params: p, body: { text: 5 } })).res.statusCode, 400); assert.strictEqual((await call("put", `${SUBP}/draft`, { user: student(), pool: mk().pool, params: p, body: { text: "x", status: "submitted" } })).res.statusCode, 400);
  const hidden = makeMockPool([enrolled([5]), OPEN_COURSE, ASG(null)]); assert.strictEqual((await call("get", SUBP, { user: student(), pool: hidden.pool, params: p })).res.statusCode, 404);
  const closed = makeMockPool([enrolled([5]), OPEN_COURSE, ASG(arow({ late_policy: "block", due_at: D("2020-01-01T00:00:00Z") })), UPD_DRAFT(srow())]); const c = await call("put", `${SUBP}/draft`, { user: student(), pool: closed.pool, params: p, body: { text: "late" } }); assert.strictEqual(c.res.statusCode, 409); assert.strictEqual(c.res.body.code, "DEADLINE_PASSED"); assert.strictEqual(writes(closed.log).length, 0);
});
test("tenant isolation: school A's student calls never touch school B's database; B's submissions are invisible to A by id guessing", async () => {
  const T = makeTenants({ A: [enrolled([5]), OPEN_COURSE, ASG(arow({ id: 4 })), UPD_DRAFT(srow())], B: [enrolled([5]), OPEN_COURSE, ASG(arow({ id: 77 })), MINE([srow({ assignment_id: 77, body_text: "B SECRET" })])] });
  const r = await call("put", `${SUBP}/draft`, { user: student(), pool: T.A.pool, params: { courseId: "5", assignmentId: "4" }, body: { text: "mine" }, tenant: "A" }); assert.strictEqual(r.res.statusCode, 200); T.assertQueried("A"); T.assertUntouched("B");
  const g = await call("get", SUBP, { user: student(), pool: T.A.pool, params: { courseId: "5", assignmentId: "77" }, tenant: "A" }); assert.strictEqual(g.res.statusCode, 404); assert.ok(!JSON.stringify(g.res.body).includes("B SECRET")); T.assertUntouched("B");
});
test("static: step 017 additive and ordered after 016 (unique attempt + one-draft indexes, no FKs); table blocklisted; event registered; 3 routes gated by studentOnly + course access; no raw db, no req.body, no interpolated user value in SQL", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((x) => x.id === "017_lms_submissions"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((x) => x.id === "016_lms_assignments") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl) && /CREATE TABLE lms_submissions/.test(ddl) && /UX_lms_submissions_attempt ON lms_submissions \(assignment_id, student_id, attempt_no\)/.test(ddl) && /UX_lms_submissions_draft[^`]*WHERE status = 'draft'/.test(ddl) && !/REFERENCES|FOREIGN KEY/i.test(ddl));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), src0 = server; assert.ok(server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_submissions"')); assert.ok(require("../utils/lmsEvents").EVENTS.includes("lms.submission.submitted"));
  const router = require("../routes/lms"); const mine = router.stack.filter((l) => l.route && l.route.path.startsWith(SUBP)); assert.strictEqual(mine.length, 6); const up = mine.find((l) => l.route.methods.post && /\/files$/.test(l.route.path)); assert.strictEqual(up.route.stack.length, 4); // studentOnly, course access, THEN the upload parser, then the handler
  assert.ok(src0.includes("denyPrivateUploads(req, res, next)") && src0.indexOf("denyPrivateUploads(req, res, next)") < src0.indexOf("express.static(path.join(__dirname, \"uploads\"))"), "guard runs before the static folder"); assert.ok(src0.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_submission_files"'));
  const st18 = STEPS.find((x) => x.id === "018_lms_submission_files"); assert.ok(st18 && STEPS.indexOf(st18) === STEPS.indexOf(st) + 1); const d18 = st18.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(d18) && /CREATE TABLE lms_submission_files/.test(d18) && /deleted_at DATETIME2 NULL/.test(d18) && !/REFERENCES|FOREIGN KEY/i.test(d18)); for (const l of mine) assert.ok(l.route.stack.length >= 3, l.route.path);
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsSubmissions.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src)); assert.ok(!/req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{(?!MAX_LISTED_ATTEMPTS\b|COLS|A\.COLS|A\.AVAILABLE|CONTENT\[|CONTENT\.text|LIVE\b)[^}]*\}/.test(piece), "unexpected interpolation in SQL: " + piece.slice(0, 60));
});

/* ---------------- files (L5.2b) ---------------- */
const os = require("os");
const { UPLOADS_ROOT } = require("../utils/uploadPaths");
const PDF = (n = 100) => ({ originalname: "My Work.pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(n, 65)]) });
const SETF = { ...SET, files: { allowedExtensions: ["pdf", "png", "docx"], maxFileMb: 10 }, storageQuotaMb: 100 };
const FINS = (fn) => ["INSERT INTO lms_submission_files", fn || ((i) => [{ id: 301, original_name: i.on, ext: i.x, size_bytes: i.sz }])];
const folder = (t) => path.join(UPLOADS_ROOT, t, "lms-private"), listing = (t) => (fs.existsSync(folder(t)) ? fs.readdirSync(folder(t)) : []);
const clean = (t) => fs.rmSync(path.join(UPLOADS_ROOT, t), { recursive: true, force: true });
const fileRow = (o = {}) => ({ id: 301, submission_id: 90, stored_name: "abc.pdf", original_name: "My Work.pdf", ext: "pdf", size_bytes: 108, ...o });

test("addFile: stored under lms-private with a random name (never in the public lms folder), row scoped to the student, limit inside the INSERT, audit written; the answer has no stored name", async () => {
  const T = "subfiles1"; try {
    const m = makeMockPool([ASG(arow({ submission_type: "both", max_files: 2 })), UPD_DRAFT(srow()), FINS()]);
    const r = await S.addFile(m.pool, student(21), 5, 4, PDF(), { tenant: T, settings: SETF, now: NOW }); assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(Object.keys(r.file).sort(), ["ext", "id", "name", "sizeBytes"]);
    const q = m.log.find((x) => /INSERT INTO lms_submission_files/.test(x.sql)); assert.ok(/< @max/.test(q.sql) && /status = 'draft'/.test(q.sql) && /student_id = @s/.test(q.sql) && /deleted_at IS NULL/.test(q.sql)); assert.deepStrictEqual([q.inputs.max, q.inputs.s, q.inputs.c, q.inputs.a, q.inputs.sub], [2, 21, 5, 4, 90]);
    assert.ok(/^[0-9a-f]{32}\.pdf$/.test(q.inputs.sn) && !q.inputs.sn.includes("Work")); assert.deepStrictEqual(listing(T), [q.inputs.sn]); assert.ok(!fs.existsSync(path.join(UPLOADS_ROOT, T, "lms")), "never in the public lms folder");
    const dr = m.log.find((x) => /UPDATE lms_submissions SET body_text/.test(x.sql)); assert.strictEqual(dr.inputs.t, null); assert.ok(/COALESCE\(@t, body_text\)/.test(dr.sql)); // existing text is kept
    assert.ok(m.log.some((x) => /INSERT INTO lms_audit_log/.test(x.sql)));
  } finally { clean(T); }
});
test("addFile refusals leave NOTHING on disk or in the database: text-only assignment, type not allowed (assignment narrows the list), fake content, too big, scanner refusal, school storage full, closed window, file limit reached, database error", async () => {
  const T = "subfiles2"; try {
    const run = (row, file, o = {}, extra = []) => { const m = makeMockPool([ASG(row), UPD_DRAFT(srow()), FINS(o.ins), ...extra]); return S.addFile(m.pool, student(21), 5, 4, file, { tenant: T, settings: o.settings || SETF, now: o.now || NOW, scanner: o.scanner }).then((r) => ({ r, m })); };
    const both = arow({ submission_type: "both", max_files: 2 }), fileWrites = (m) => m.log.filter((x) => /INSERT INTO lms_submission_files|UPDATE lms_submissions/.test(x.sql)).length;
    let x = await run(arow({ submission_type: "text" }), PDF()); assert.strictEqual(x.r.code, "FILES_NOT_ALLOWED"); assert.strictEqual(fileWrites(x.m), 0);
    x = await run(arow({ submission_type: "both", allowed_extensions: '["pdf"]' }), { originalname: "p.png", buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]) }); assert.strictEqual(x.r.code, "FILE_TYPE_NOT_ALLOWED");
    x = await run(both, { originalname: "evil.pdf", buffer: Buffer.from("MZ\u0090 not a pdf") }); assert.strictEqual(x.r.code, "FILE_CONTENT_MISMATCH");
    x = await run(arow({ submission_type: "both", max_file_mb: 1 }), PDF(2 * 1048576)); assert.strictEqual(x.r.code, "FILE_TOO_LARGE");
    x = await run(both, PDF(), { scanner: async () => ({ ok: false }) }); assert.strictEqual(x.r.code, "FILE_REJECTED"); x = await run(both, PDF(), { scanner: async () => { throw new Error("scanner down"); } }); assert.strictEqual(x.r.code, "FILE_REJECTED");
    x = await run(both, PDF(), { settings: { ...SETF, storageQuotaMb: 0 } }); assert.strictEqual(x.r.code, "LMS_STORAGE_QUOTA_EXCEEDED");
    for (const e of [{ now: LATE, row: arow({ submission_type: "both", late_policy: "block" }), code: "DEADLINE_PASSED" }, { now: NOW, row: arow({ submission_type: "both", course_status: "archived" }), code: "COURSE_READ_ONLY" }]) { x = await run(e.row, PDF(), { now: e.now }); assert.strictEqual(x.r.code, e.code); assert.strictEqual(fileWrites(x.m), 0); }
    assert.deepStrictEqual(listing(T), [], "nothing was written to disk by any refusal");
    x = await run(both, PDF(), { ins: () => [] }); assert.strictEqual(x.r.code, "FILE_LIMIT"); assert.deepStrictEqual(listing(T), [], "file removed when the row was refused");
    await assert.rejects(run(both, PDF(), { ins: () => { throw new Error("db down"); } }), /db down/); assert.deepStrictEqual(listing(T), [], "no orphan file after a database error");
    for (const u of [teacher(), admin, null]) { const m = makeMockPool([ASG(both)]); assert.strictEqual((await S.addFile(m.pool, u, 5, 4, PDF(), { tenant: T, settings: SETF, now: NOW })).notFound, true); assert.strictEqual(m.log.length, 0); }
  } finally { clean(T); }
});
test("removeFile: only a file of the student's own DRAFT (SQL says so), then the bytes are deleted; a submitted attempt's file, someone else's and unknown ids are 'not found'; closed windows are refused", async () => {
  const T = "subfiles3"; try {
    fs.mkdirSync(folder(T), { recursive: true }); fs.writeFileSync(path.join(folder(T), "abc.pdf"), "x");
    const m = makeMockPool([ASG(arow({ submission_type: "both" })), ["UPDATE sf SET deleted_at", (i) => (i.f === 301 && i.s === 21 && i.c === 5 && i.a === 4 ? [{ stored_name: "abc.pdf" }] : [])]]);
    assert.ok((await S.removeFile(m.pool, student(21), 5, 4, 301, { tenant: T, settings: SETF, now: NOW })).ok); assert.deepStrictEqual(listing(T), []); const q = m.log.find((x) => /UPDATE sf SET/.test(x.sql)).sql;
    assert.ok(/sb\.status = 'draft'/.test(q) && /sf\.student_id = @s/.test(q) && /sf\.course_id = @c/.test(q) && /sf\.assignment_id = @a/.test(q) && /sf\.deleted_at IS NULL/.test(q));
    for (const [u, id] of [[student(22), 301], [student(21), 999]]) assert.strictEqual((await S.removeFile(m.pool, u, 5, 4, id, { tenant: T, settings: SETF, now: NOW })).notFound, true);
    assert.strictEqual((await S.removeFile(makeMockPool([ASG(arow({ late_policy: "block" }))]).pool, student(21), 5, 4, 301, { tenant: T, settings: SETF, now: LATE })).code, "DEADLINE_PASSED");
    assert.strictEqual((await S.removeFile(makeMockPool([ASG(arow())]).pool, teacher(), 5, 4, 301, { tenant: T, settings: SETF, now: NOW })).notFound, true);
  } finally { clean(T); }
});
test("readFile: the student's OWN file from lms-private; other students, other assignments, other schools and a missing file all look the same ('not found'); a stored name can never point outside the folder", async () => {
  const A_ = "subfilesa", B_ = "subfilesb"; try {
    fs.mkdirSync(folder(A_), { recursive: true }); fs.writeFileSync(path.join(folder(A_), "abc.pdf"), "SECRET-A"); fs.mkdirSync(folder(B_), { recursive: true }); fs.writeFileSync(path.join(folder(B_), "abc.pdf"), "SECRET-B");
    const own = (rows) => ["FROM lms_submission_files WHERE id = @f", (i) => (i.f === 301 && i.s === 21 && i.a === 4 && i.c === 5 ? rows : [])];
    const m = makeMockPool([own([fileRow()])]); const r = await S.readFile(m.pool, student(21), 5, 4, 301, { tenant: A_ }); assert.ok(r.ok); assert.strictEqual(r.buffer.toString(), "SECRET-A"); assert.strictEqual(r.name, "My Work.pdf");
    assert.ok(/student_id = @s/.test(m.log[0].sql) && /assignment_id = @a/.test(m.log[0].sql) && /course_id = @c/.test(m.log[0].sql) && /deleted_at IS NULL/.test(m.log[0].sql));
    assert.strictEqual((await S.readFile(m.pool, student(21), 5, 4, 301, { tenant: B_ })).buffer.toString(), "SECRET-B"); // each school reads only its own folder
    for (const [u, a, id] of [[student(22), 4, 301], [student(21), 9, 301], [student(21), 4, 302], [teacher(), 4, 301]]) assert.strictEqual((await S.readFile(m.pool, u, 5, a, id, { tenant: A_ })).notFound, true);
    assert.strictEqual((await S.readFile(makeMockPool([own([fileRow({ stored_name: "gone.pdf" })])]).pool, student(21), 5, 4, 301, { tenant: A_ })).notFound, true);
    fs.writeFileSync(path.join(UPLOADS_ROOT, A_, "outside.txt"), "OUTSIDE"); assert.strictEqual((await S.readFile(makeMockPool([own([fileRow({ stored_name: "../outside.txt" })])]).pool, student(21), 5, 4, 301, { tenant: A_ })).notFound, true);
  } finally { clean(A_); clean(B_); }
});
test("submit by type: text needs text, files needs a file, both needs text OR a file (one fixed SQL condition each); the refusal message names what is missing", async () => {
  const sqlOf = async (type) => { const m = makeMockPool([ASG(arow({ submission_type: type })), SUBMIT(srow())]); await S.submit(m.pool, student(21), 5, 4, undefined, { tenant: "subT3", settings: SET, now: NOW }); return writes(m.log)[0].sql; };
  const t = await sqlOf("text"), f = await sqlOf("files"), b = await sqlOf("both");
  assert.ok(/LEN\(LTRIM/.test(t) && !/lms_submission_files/.test(t)); assert.ok(/EXISTS \(SELECT 1 FROM lms_submission_files sf WHERE sf\.submission_id = lms_submissions\.id AND sf\.deleted_at IS NULL\)/.test(f) && !/LEN\(LTRIM/.test(f)); assert.ok(/\(LEN\(LTRIM[^)]*\)\)\)\) > 0 OR EXISTS \(SELECT 1 FROM lms_submission_files/.test(b));
  for (const [type, word] of [["text", "Write something before"], ["files", "Add at least one file"], ["both", "Write something or add a file"]]) { const r = await S.submit(makeMockPool([ASG(arow({ submission_type: type })), SUBMIT(null), EXISTS_DRAFT(true)]).pool, student(21), 5, 4, undefined, { tenant: "subT3", settings: SET, now: NOW }); assert.strictEqual(r.code, "EMPTY_SUBMISSION"); assert.ok(r.errors[0].startsWith(word), r.errors[0]); }
});
test("getState lists the files of the draft and of each attempt (id, name, type, size only); another student's files never appear; the files query is scoped to course, assignment and student", async () => {
  const subs = [srow({ id: 90, attempt_no: 1, status: "submitted", submitted_at: NOW }), srow({ id: 91, attempt_no: 2, status: "draft" })];
  const m = makeMockPool([ASG(arow({ submission_type: "both" })), MINE(subs), ["FROM lms_submission_files WHERE assignment_id = @a", () => [fileRow({ id: 1, submission_id: 90, stored_name: "secret1.pdf" }), fileRow({ id: 2, submission_id: 91, original_name: "Draft.pdf", stored_name: "secret2.pdf" })]]]);
  const r = await S.getState(m.pool, student(21), 5, 4, { settings: SETF, now: NOW }); assert.deepStrictEqual(r.attempts[0].files.map((f) => f.id), [1]); assert.deepStrictEqual(r.draft.files.map((f) => f.name), ["Draft.pdf"]); assert.ok(!JSON.stringify(r).includes("secret")); assert.deepStrictEqual(r.effective.allowedExtensions, ["pdf", "png", "docx"]);
  const q = m.log.find((x) => /FROM lms_submission_files/.test(x.sql)); assert.deepStrictEqual(q.inputs, { c: 5, a: 4, s: 21 }); assert.ok(/student_id = @s/.test(q.sql) && /deleted_at IS NULL/.test(q.sql) && /TOP 100/.test(q.sql));
});
test("routes: download sends the bytes as an attachment that browsers will not render or cache; staff, strangers, other courses and bad ids are refused; delete is student-only", async () => {
  const T = "subfiles4"; try {
    fs.mkdirSync(folder(T), { recursive: true }); fs.writeFileSync(path.join(folder(T), "abc.pdf"), "%PDF-bytes");
    const F = `${SUBP}/files/:fileId`, mk = () => makeMockPool([enrolled([5]), OPEN_COURSE, ["FROM lms_submission_files WHERE id = @f", () => [fileRow()]], ["UPDATE sf SET deleted_at", () => [{ stored_name: "abc.pdf" }]], ASG(arow({ submission_type: "both" }))]);
    const p = { courseId: "5", assignmentId: "4", fileId: "301" }; const hdr = {}; const g = await call("get", F, { user: student(), pool: mk().pool, params: p, tenant: T }); assert.strictEqual(g.res.statusCode, 200); assert.strictEqual(String(g.res.body), "%PDF-bytes");
    const router = require("../routes/lms"); const layer = router.stack.find((l) => l.route && l.route.path === F && l.route.methods.get); const heads = {}; const res = makeRes(); res.setHeader = (k, v) => { heads[k] = v; }; await (async () => { const st = layer.route.stack.map((x) => x.handle); let i = 0; const req = { user: student(), pool: mk().pool, params: p, body: {}, query: {}, tenant: T }; const pend = []; const next = () => { const h = st[i++]; if (h) pend.push(Promise.resolve(h(req, res, next))); }; next(); for (let n = 0; n < pend.length; n += 1) await pend[n]; })();
    assert.deepStrictEqual([heads["Content-Type"], heads["X-Content-Type-Options"], heads["Cache-Control"]], ["application/octet-stream", "nosniff", "private, no-store"]); assert.ok(/^attachment; filename="submission\.pdf"/.test(heads["Content-Disposition"]) && heads["Content-Disposition"].includes("My%20Work.pdf"));
    assert.strictEqual((await call("delete", F, { user: student(), pool: mk().pool, params: p, tenant: T })).res.statusCode, 200);
    for (const [user, courseId] of [[teacher(), "5"], [admin, "5"], [student(), "6"]]) for (const m of ["get", "delete"]) assert.strictEqual((await call(m, F, { user, pool: mk().pool, params: { ...p, courseId }, tenant: T })).res.statusCode, 403);
    for (const bad of [{ fileId: "x" }, { assignmentId: "x" }, { fileId: "0" }]) assert.strictEqual((await call("get", F, { user: student(), pool: mk().pool, params: { ...p, ...bad }, tenant: T })).res.statusCode, 404);
    const none = makeMockPool([enrolled([5]), OPEN_COURSE, ["FROM lms_submission_files WHERE id = @f", () => []]]); assert.strictEqual((await call("get", F, { user: student(), pool: none.pool, params: p, tenant: T })).res.statusCode, 404);
    const sv = makeMockPool([enrolled([5]), OPEN_COURSE, ASG(arow({ submission_type: "text" }))]); const up = await call("post", `${SUBP}/files`, { user: teacher(), pool: sv.pool, params: p, tenant: T }); assert.strictEqual(up.res.statusCode, 403); assert.ok(!sv.log.some((x) => /lms_submission/.test(x.sql)));
  } finally { clean(T); }
});
test("storage meter counts the private submissions folder too, per school", async () => {
  const U = require("../utils/lmsUsage"), root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-priv-")); try {
    fs.mkdirSync(path.join(root, "sa", "lms"), { recursive: true }); fs.mkdirSync(path.join(root, "sa", "lms-private"), { recursive: true }); fs.mkdirSync(path.join(root, "sb", "lms-private"), { recursive: true });
    fs.writeFileSync(path.join(root, "sa", "lms", "a.bin"), Buffer.alloc(1048576)); fs.writeFileSync(path.join(root, "sa", "lms-private", "b.bin"), Buffer.alloc(2 * 1048576)); fs.writeFileSync(path.join(root, "sb", "lms-private", "c.bin"), Buffer.alloc(4 * 1048576));
    const a = await U.getStorage("sa", { root }), b = await U.getStorage("sb", { root }); assert.deepStrictEqual([a.storageMb, a.fileCount, b.storageMb, b.fileCount], [3, 2, 4, 1]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("static guard: any path naming lms-private is a 404 (letter case, percent-encoding, backslashes, malformed encoding); normal uploads pass; the guard is wired in front of the static folder", () => {
  const { denyPrivateUploads: g } = require("../utils/privateUploadGuard"); const hit = (p) => { let out = "next"; g({ path: p }, { status: (c) => ({ end: () => { out = c; } }) }, () => { out = "next"; }); return out; };
  for (const p of ["/sa/lms-private/abc.pdf", "/SA/LMS-Private/abc.pdf", "/sa/%6Cms-private/abc.pdf", "/sa/lms%2Dprivate/abc.pdf", "/sa/lms-private", "/sa\\lms-private\\abc.pdf", "/sa/%E0%A4%A", "/sa/ lms-private /x"]) assert.strictEqual(hit(p), 404, p);
  for (const p of ["/sa/lms/abc.pdf", "/sa/photos/x.jpg", "/photos/x.jpg", "/"]) assert.strictEqual(hit(p), "next", p);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(/require\("\.\/utils\/privateUploadGuard"\)/.test(server)); const i = server.indexOf("denyPrivateUploads(req, res, next)"); assert.ok(i > 0 && i < server.indexOf("express.static(path.join(__dirname, \"uploads\"))"));
});
