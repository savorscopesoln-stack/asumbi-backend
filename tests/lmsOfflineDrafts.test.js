/* L10.3b + L10.4 - queued offline DRAFT submissions and conflict resolution (D-116): validation, guarded writes (never overwrite), conflict with both versions, idempotency, gate rejections,
   group/closed-window refusals, resolve choices, tenant isolation, routes, schema 044. In-memory tables behind a mock pool; the assignment gate is a per-call stub (the real gate is tested in lmsSubmissions tests).
   SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsOfflineDrafts.test.js");
const D = require("../utils/lmsOfflineDrafts"), schema = require("../utils/lmsSchema");
const NOW = new Date("2026-11-10T09:00:00.000Z"), Q = "2026-11-09T18:00:00.000Z", V0 = "2026-11-09T10:00:00.000Z", V1 = "2026-11-09T12:00:00.000Z";
const A = (o = {}) => ({ clientActionId: "act-00000001", type: "submission_draft", assignmentId: 7, queuedAt: Q, text: "my offline words", baseVersion: V0, ...o });
const gateOk = (o = {}) => async () => ({ ok: true, found: { model: { maxAttempts: o.max || 2, workMode: o.workMode || "individual" } } });
const gateNo = (code, notFound) => async () => (notFound ? { ok: false, notFound: true, errors: ["Assignment not found."] } : { ok: false, code, errors: [code + " message"] });

/* in-memory lms_offline_actions + lms_submissions behind the mock pool */
const world = ({ draft, submitted = 0, actions = [], beforeUpdate } = {}) => {
  const rows = actions.map((r, i) => ({ id: 100 + i, ...r })); let next = 200, sid = 900;
  const st = { draft: draft ? { id: 55, attempt_no: 1, ...draft, updated_at: new Date(draft.updated_at) } : null, writes: 0, audits: [] };
  const m = makeMockPool([
    ["INSERT INTO lms_offline_actions", (i) => { if (rows.some((r) => r.student_id === i.s && r.client_action_id === i.a)) { const e = new Error("dup"); e.number = 2627; throw e; } const r = { id: next++, course_id: i.c, student_id: i.s, client_action_id: i.a, action_type: i.t, assignment_id: i.as, result_state: null, result_code: null, result_version: null }; rows.push(r); return [{ id: r.id }]; }],
    ["SELECT TOP 1 id, course_id, action_type, assignment_id", (i) => rows.filter((r) => r.student_id === i.s && r.client_action_id === i.a)],
    ["UPDATE lms_offline_actions SET result_state = @st", (i) => { const r = rows.find((x) => x.id === i.id && x.student_id === i.s); if (r) { r.result_state = i.st; r.result_code = i.cd; r.result_version = i.v; } return []; }],
    ["UPDATE lms_offline_actions SET result_state = 'resolved'", (i) => { const r = rows.find((x) => x.student_id === i.s && x.client_action_id === i.a && x.course_id === i.c && x.assignment_id === i.as && x.result_state === null); if (r) { r.result_state = "resolved"; r.result_code = i.cd; r.result_version = i.v; } return []; }],
    ["FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft'", () => (st.draft ? [{ ...st.draft }] : [])],
    ["UPDATE lms_submissions SET body_text = @t, updated_at = @now", (i) => { if (beforeUpdate) { beforeUpdate(st); } const d = st.draft; if (!d || d.updated_at.getTime() !== new Date(i.base).getTime()) return []; d.body_text = i.t; d.updated_at = new Date(i.now); st.writes++; return [{ ...d }]; }],
    ["INSERT INTO lms_submissions", (i) => { if (st.draft || submitted >= i.max) return []; st.draft = { id: sid++, attempt_no: submitted + 1, body_text: i.t, updated_at: new Date(i.now) }; st.writes++; return [{ ...st.draft }]; }],
    ["INSERT INTO lms_audit_log", (i) => { st.audits.push(i); return []; }]]);
  return { ...m, rows, st };
};
const run = (w, body, o = {}) => D.replayDrafts(w.pool, o.c || 5, o.s || 21, body, { now: NOW, gate: gateOk(o), ...(o.ctx || {}) });
const user = { id: 21, role: "student", source: "Students" };
const res = (w, body, o = {}) => D.resolveDraft(w.pool, user, 5, body, { now: NOW, gate: gateOk(o) });

test("validate (pure): 1-5 actions, only known fields, baseVersion REQUIRED (null or the exact server text), text cleaned and capped; a bad single action is reported, the batch still runs", () => {
  for (const b of [null, [], {}, { actions: [] }, { actions: "x" }, { actions: [A()], extra: 1 }, { actions: Array.from({ length: 6 }, (_, i) => A({ clientActionId: "act-0000000" + i })) }]) assert.strictEqual(D.validateBatch(b).ok, false);
  const ok = (x) => !D.validateBatch({ actions: [x] }).actions[0].invalid;
  const noBase = A(); delete noBase.baseVersion;
  assert.ok(ok(A()) && ok(A({ baseVersion: null })));
  for (const x of [noBase, A({ baseVersion: "2026-11-09" }), A({ baseVersion: 5 }), A({ clientActionId: "x" }), A({ type: "lesson_view" }), A({ assignmentId: 0 }), A({ queuedAt: "nope" }), A({ text: 5 }), A({ text: "a".repeat(20001) }), A({ foo: 1 })]) assert.ok(!ok(x), JSON.stringify(x).slice(0, 70));
  const t = D.validateBatch({ actions: [A({ text: "<b>hi</b>\r\nthere" }), A()] }).actions; assert.strictEqual(t[0].text, "bhi/b\nthere"); assert.ok(/Repeated/.test(t[1].invalid), "same id twice in one request");
  assert.strictEqual(D.validateResolve({ assignmentId: 7, choice: "keep_server", serverVersion: V1 }).ok, true);
  for (const b of [null, { assignmentId: 7, choice: "x", serverVersion: V1 }, { assignmentId: 7, choice: "keep_mine", serverVersion: V1 }, { assignmentId: 7, choice: "keep_server", serverVersion: V1, text: "t" }, { assignmentId: 7, choice: "keep_mine", serverVersion: "bad", text: "t" }, { assignmentId: 0, choice: "keep_mine", serverVersion: V1, text: "t" }, { assignmentId: 7, choice: "keep_mine", serverVersion: V1, text: "t", foo: 1 }, { assignmentId: 7, choice: "keep_mine", serverVersion: V1, text: "a".repeat(20001) }]) assert.strictEqual(D.validateResolve(b).ok, false, JSON.stringify(b));
});

test("applied: the first draft (no server draft, baseVersion null) and an update at the SAME version; the guarded UPDATE names the base; the new version is later than the base; the action row keeps ids, outcome and version, NO text", async () => {
  const w = world(); const r = await run(w, { actions: [A({ baseVersion: null })] });
  assert.deepStrictEqual([r.results[0].state, r.results[0].version, w.st.draft.body_text, r.summary], ["applied", NOW.toISOString(), "my offline words", { applied: 1, duplicate: 0, conflict: 0, rejected: 0 }]);
  const w2 = world({ draft: { body_text: "old", updated_at: V0 } }); const r2 = await run(w2, { actions: [A()] });
  assert.deepStrictEqual([r2.results[0].state, w2.st.draft.body_text, w2.st.writes], ["applied", "my offline words", 1]); assert.ok(new Date(r2.results[0].version) > new Date(V0));
  const up = w2.log.find((x) => /UPDATE lms_submissions/.test(x.sql)); assert.ok(/updated_at = @base/.test(up.sql) && /student_id = @s/.test(up.sql) && /course_id = @c/.test(up.sql) && /status = 'draft'/.test(up.sql), "the write is guarded by the version and by the learner's own draft");
  assert.deepStrictEqual([w2.rows[0].result_state, w2.rows[0].result_version], ["applied", r2.results[0].version]);
  const ins = w2.log.find((x) => /INSERT INTO lms_offline_actions/.test(x.sql)); assert.ok(!Object.values(ins.inputs).some((v) => v === "my offline words"), "the text never goes into the action table");
  const skew = world({ draft: { body_text: "old", updated_at: "2026-11-10T09:30:00.000Z" } }); const r3 = await run(skew, { actions: [A({ baseVersion: "2026-11-10T09:30:00.000Z" })] });
  assert.ok(new Date(r3.results[0].version) > new Date("2026-11-10T09:30:00.000Z"), "even with a server clock behind the draft, the version moves forward");
});

test("CONFLICT: the server draft moved AND the text differs -> state conflict with BOTH texts and the server version, nothing written, the id is NOT used up; a later replay re-checks and applies once the texts match", async () => {
  const w = world({ draft: { body_text: "written on the laptop", updated_at: V1 } }); const r = await run(w, { actions: [A()] });
  const c = r.results[0]; assert.deepStrictEqual([c.state, c.code, c.conflict.serverText, c.conflict.deviceText, c.conflict.serverVersion, c.conflict.deviceQueuedAt, r.summary.conflict], ["conflict", "DRAFT_CHANGED", "written on the laptop", "my offline words", V1, Q, 1]);
  assert.deepStrictEqual([w.st.draft.body_text, w.st.writes, w.rows[0].result_state], ["written on the laptop", 0, null], "no write; the action row stays unfinished");
  assert.ok(!w.log.some((l) => /UPDATE lms_submissions|INSERT INTO lms_submissions/.test(l.sql)), "a known conflict does not even attempt a write");

  const again = await run(w, { actions: [A()] }); assert.strictEqual(again.results[0].state, "conflict", "same answer on a replay while the server is unchanged");
  w.st.draft.body_text = "my offline words"; const done = await run(w, { actions: [A()] });
  assert.deepStrictEqual([done.results[0].state, done.results[0].unchanged, w.rows[0].result_state], ["applied", true, "applied"]);
  const none = world({ draft: { body_text: "from another device", updated_at: V1 } }); const r2 = await run(none, { actions: [A({ baseVersion: null })] });
  assert.strictEqual(r2.results[0].state, "conflict", "a device that had no draft but finds one with other text is a conflict, not an overwrite"); assert.strictEqual(none.st.writes, 0);
  const racing = world({ draft: { body_text: "old", updated_at: V0 }, beforeUpdate: (st) => { st.draft.body_text = "slipped in"; st.draft.updated_at = new Date(V1); } }); const r3 = await run(racing, { actions: [A()] });
  assert.deepStrictEqual([r3.results[0].state, r3.results[0].conflict.serverText, racing.st.draft.body_text], ["conflict", "slipped in", "slipped in"], "a change between the read and the write is still never overwritten");
});

test("same text = nothing to fight about: applied + unchanged, no write (a moved version after a file upload, a replay after a lost answer)", async () => {
  const w = world({ draft: { body_text: "my offline words", updated_at: V1 } }); const r = await run(w, { actions: [A()] });
  assert.deepStrictEqual([r.results[0].state, r.results[0].unchanged, r.results[0].version, w.st.writes], ["applied", true, V1, 0]);
});

test("rejections use the NORMAL submission gate and are stored: not found, window closed, cutoff, archived course; group work is not queued; DRAFT_GONE; attempts used; stale queuedAt claims nothing", async () => {
  for (const [g, code] of [[gateNo(null, true), "NOT_FOUND"], [gateNo("DEADLINE_PASSED"), "DEADLINE_PASSED"], [gateNo("CUTOFF_PASSED"), "CUTOFF_PASSED"], [gateNo("COURSE_READ_ONLY"), "COURSE_READ_ONLY"]]) {
    const w = world({ draft: { body_text: "old", updated_at: V0 } }); const r = await D.replayDrafts(w.pool, 5, 21, { actions: [A()] }, { now: NOW, gate: g });
    assert.deepStrictEqual([r.results[0].state, r.results[0].code, w.rows[0].result_state, w.rows[0].result_code, w.st.writes], ["rejected", code, "rejected", code, 0]);
  }
  const grp = world({ draft: { body_text: "old", updated_at: V0 } }); const r = await run(grp, { actions: [A()] }, { workMode: "group" }); assert.deepStrictEqual([r.results[0].code, grp.st.writes], ["GROUP_NOT_SUPPORTED", 0]);
  const gone = world(); assert.strictEqual((await run(gone, { actions: [A()] })).results[0].code, "DRAFT_GONE", "baseVersion says a draft existed; none does: do not invent a new attempt");
  const full = world({ submitted: 2 }); assert.strictEqual((await run(full, { actions: [A({ baseVersion: null })] }, { max: 2 })).results[0].code, "ATTEMPTS_USED");
  const w = world(); const s = await run(w, { actions: [A({ queuedAt: "2026-09-01T00:00:00Z" }), A({ clientActionId: "act-00000002", queuedAt: "2026-11-10T09:06:00Z" }), { clientActionId: "bad" }] });
  assert.deepStrictEqual(s.results.map((x) => x.code), ["STALE_ACTION", "STALE_ACTION", "INVALID"]); assert.strictEqual(w.rows.length, 0, "stale and invalid actions store nothing");
});

test("idempotent: a replay of a finished action is `duplicate` with firstResult and the stored version, nothing written again; same id for another assignment/type/course = ACTION_ID_REUSED; a progress action id cannot be replayed as a draft; another learner is independent; a db error is not swallowed", async () => {
  const w = world({ draft: { body_text: "old", updated_at: V0 } }); const first = await run(w, { actions: [A()] }); const again = await run(w, { actions: [A()] });
  assert.deepStrictEqual([again.results[0].state, again.results[0].firstResult, again.results[0].version, w.st.writes], ["duplicate", "applied", first.results[0].version, 1]);
  assert.strictEqual((await run(w, { actions: [A({ assignmentId: 8 })] })).results[0].code, "ACTION_ID_REUSED"); assert.strictEqual((await run(w, { actions: [A()] }, { c: 6 })).results[0].code, "ACTION_ID_REUSED");
  const prog = world({ actions: [{ course_id: 5, student_id: 21, client_action_id: "act-00000001", action_type: "lesson_complete", assignment_id: null, result_state: "applied", result_code: null }] });
  assert.strictEqual((await run(prog, { actions: [A()] })).results[0].code, "ACTION_ID_REUSED");
  const other = await run(w, { actions: [A()] }, { s: 22 }); assert.notStrictEqual(other.results[0].state, "duplicate");
  const rej = world({ draft: { body_text: "old", updated_at: V0 } }); await D.replayDrafts(rej.pool, 5, 21, { actions: [A()] }, { now: NOW, gate: gateNo("DEADLINE_PASSED") }); const r2 = await run(rej, { actions: [A()] });
  assert.deepStrictEqual([r2.results[0].state, r2.results[0].code, r2.results[0].firstResult], ["duplicate", "DEADLINE_PASSED", "rejected"], "a rejection is repeated, not retried");
  const boom = makeMockPool([["INSERT INTO lms_offline_actions", () => { throw new Error("db down"); }]]); let err = null; try { await D.replayDrafts(boom.pool, 5, 21, { actions: [A()] }, { now: NOW, gate: gateOk() }); } catch (e) { err = e; } assert.ok(err && /db down/.test(err.message));
  for (const [c, s, b] of [["x", 21, { actions: [A()] }], [5, 0, { actions: [A()] }], [5, 21, { actions: [] }]]) { const z = world(); const r = await D.replayDrafts(z.pool, c, s, b, { now: NOW, gate: gateOk() }); assert.strictEqual(r.ok, false); assert.ok(!z.log.length); }
});

test("RESOLVE (L10.4): keep_server writes nothing and closes the queued action; keep_mine writes the device text; keep_both = server text + divider + device text; every write is guarded by the version the learner was shown; audit holds ids and the choice, never text", async () => {
  const body = (o) => ({ assignmentId: 7, choice: "keep_server", serverVersion: V1, ...o });
  const pending = { course_id: 5, student_id: 21, client_action_id: "act-00000001", action_type: "submission_draft", assignment_id: 7, result_state: null, result_code: null };
  const w1 = world({ draft: { body_text: "laptop text", updated_at: V1 }, actions: [pending] }); const k = await res(w1, body({ clientActionId: "act-00000001" }));
  assert.deepStrictEqual([k.ok, k.choice, k.draft.text, w1.st.writes, w1.rows[0].result_state, w1.rows[0].result_code], [true, "keep_server", "laptop text", 0, "resolved", "keep_server"]);
  const replay = await run(w1, { actions: [A()] }); assert.deepStrictEqual([replay.results[0].state, replay.results[0].firstResult], ["duplicate", "resolved"], "the original queued action is closed for good");
  const w2 = world({ draft: { body_text: "laptop text", updated_at: V1 } }); const m = await res(w2, body({ choice: "keep_mine", text: "phone text" }));
  assert.deepStrictEqual([m.ok, m.draft.text, w2.st.draft.body_text, w2.st.writes, m.unchanged], [true, "phone text", "phone text", 1, undefined]); assert.ok(new Date(m.draft.version) > new Date(V1));
  assert.ok(/updated_at = @base/.test(w2.log.find((x) => /UPDATE lms_submissions/.test(x.sql)).sql));
  assert.deepStrictEqual(w2.st.audits.length && JSON.parse(w2.st.audits[0].details || w2.st.audits[0].d || "{}") !== null, true);
  assert.ok(!JSON.stringify(w2.st.audits).includes("phone text") && !JSON.stringify(w2.st.audits).includes("laptop text"), "no text in the audit");
  const w3 = world({ draft: { body_text: "laptop text", updated_at: V1 } }); const b = await res(w3, body({ choice: "keep_both", text: "phone text" })); assert.strictEqual(w3.st.draft.body_text, "laptop text" + D.DIVIDER + "phone text");
  const again = await res(w3, body({ choice: "keep_both", text: "phone text" })); assert.deepStrictEqual([again.ok, again.unchanged, w3.st.writes], [true, true, 1], "repeating the same resolve changes nothing");
  const same = world({ draft: { body_text: "same", updated_at: V1 } }); await res(same, body({ choice: "keep_both", text: "same" })); assert.strictEqual(same.st.draft.body_text, "same", "identical texts are not doubled");
  const moved = world({ draft: { body_text: "third device", updated_at: "2026-11-09T13:00:00.000Z" } }); const c = await res(moved, body({ choice: "keep_mine", text: "phone text" }));
  assert.deepStrictEqual([c.ok, c.conflict, c.serverText, c.deviceText, moved.st.writes], [true, true, "third device", "phone text", 0], "the server draft moved again: both versions again, nothing written");
  assert.ok(!moved.log.some((l) => /UPDATE lms_submissions/.test(l.sql)), "the version check happens BEFORE any write is attempted");
  const racing = world({ draft: { body_text: "laptop text", updated_at: V1 }, beforeUpdate: (st) => { st.draft.body_text = "slipped"; st.draft.updated_at = new Date("2026-11-09T14:00:00.000Z"); } }); const rc = await res(racing, body({ choice: "keep_mine", text: "phone text" }));
  assert.deepStrictEqual([rc.conflict, racing.st.draft.body_text], [true, "slipped"]);
  const big = world({ draft: { body_text: "a".repeat(15000), updated_at: V1 } }); const t = await res(big, body({ choice: "keep_both", text: "b".repeat(15000) })); assert.deepStrictEqual([t.ok, t.code, big.st.writes], [false, "TOO_LONG", 0]);
  const none = world(); assert.strictEqual((await res(none, body({ choice: "keep_mine", text: "x" }))).code, "DRAFT_GONE");
  const closed = world({ draft: { body_text: "laptop text", updated_at: V1 } }); const cm = await D.resolveDraft(closed.pool, user, 5, body({ choice: "keep_mine", text: "x" }), { now: NOW, gate: gateNo("DEADLINE_PASSED") }); assert.deepStrictEqual([cm.ok, cm.code, closed.st.writes], [false, "DEADLINE_PASSED", 0]);
  const ks = await D.resolveDraft(closed.pool, user, 5, body(), { now: NOW, gate: gateNo("DEADLINE_PASSED") }); assert.strictEqual(ks.ok, true, "keep_server is only a read: a closed window does not stop the learner dropping their offline text");
  const nf = await D.resolveDraft(closed.pool, user, 5, body(), { now: NOW, gate: gateNo(null, true) }); assert.strictEqual(nf.notFound, true);
  const grp = world({ draft: { body_text: "x", updated_at: V1 } }); assert.strictEqual((await res(grp, body({ choice: "keep_mine", text: "y" }), { workMode: "group" })).code, "GROUP_NOT_SUPPORTED");
  assert.strictEqual((await D.resolveDraft(world().pool, { id: 3, role: "teacher", source: "Teachers" }, 5, body(), { now: NOW, gate: gateOk() })).notFound, true, "only a student can resolve");
});

test("tenant isolation: every draft query is scoped to the token student AND course; another tenant's pool is never touched", async () => {
  const w = world({ draft: { body_text: "old", updated_at: V0 } }); await run(w, { actions: [A()] }); await res(w, { assignmentId: 7, choice: "keep_server", serverVersion: V1 });
  for (const x of w.log.filter((l) => /lms_submissions/.test(l.sql))) assert.ok(/student_id = @s/.test(x.sql) && /course_id = @c/.test(x.sql) && /assignment_id = @a/.test(x.sql), x.sql.slice(0, 80));
  assert.ok(!w.log.some((l) => /\$\{|\+ *@/.test(l.sql)), "parameterised only");
  const T = makeTenants({ A: [["INSERT INTO lms_offline_actions", () => [{ id: 1 }]], ["UPDATE lms_offline_actions", () => []], ["INSERT INTO lms_submissions", () => [{ id: 1, updated_at: NOW, body_text: "x" }]], ["status = 'draft'", () => []]], B: [] });
  const r = await D.replayDrafts(T.A.pool, 5, 21, { actions: [A({ baseVersion: null })] }, { now: NOW, gate: gateOk() }); assert.strictEqual(r.results[0].state, "applied"); T.assertUntouched("B");
});

test("routes: flag `lms_offline` first, studentOnly + enrolment, no-store; bad body = 400 touching nothing; conflict answers 200 (it is information, not a failure); schema 044 is additive (two guarded nullable columns), LAST, and the table stays blocked from the record editor", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  for (const p of ["/courses/:courseId/learn/offline/sync/drafts", "/courses/:courseId/learn/offline/sync/drafts/resolve"]) {
    const lr = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.post); assert.ok(lr && lr.route.stack.length === 4, p);
    assert.ok(src.includes(`"${p}", olGate, studentOnly, studentAccess`), p);
  }
  const lr = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/offline/sync/drafts" && l.route.methods.post);
  const bad = makeRes(); let h = null; bad.setHeader = (k, v) => { h = [k, v]; }; const w = world(); await lr.route.stack[3].handle({ pool: w.pool, user, params: { courseId: "5" }, body: { actions: [] }, tenant: "t" }, bad);
  assert.deepStrictEqual([bad.statusCode, h], [400, ["Cache-Control", "no-store"]]); assert.ok(!w.log.length);
  const lr2 = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/offline/sync/drafts/resolve" && l.route.methods.post); const bad2 = makeRes(); await lr2.route.stack[3].handle({ pool: w.pool, user, params: { courseId: "5" }, body: { choice: "keep_mine" }, tenant: "t" }, bad2); assert.strictEqual(bad2.statusCode, 400);
  const ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("044_lms_offline_drafts"); assert.ok(i === ids.length - 2 && ids[i - 1] === "043_lms_offline_actions" && ids[i + 1] === "045_lms_offline_quiz_answers");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(schema.STEPS[i].sql.every((s) => /^IF COL_LENGTH\('lms_offline_actions', '\w+'\) IS NULL ALTER TABLE lms_offline_actions ADD \w+ [A-Z0-9]+(\(\d+\))? NULL$/.test(s.replace(/\s+/g, " ").trim())) && !/DROP |DELETE |UPDATE /i.test(t));
  assert.ok(/assignment_id INT NULL/.test(t) && /result_version NVARCHAR\(40\) NULL/.test(t) && !/text|body|answer/i.test(t.replace(/--.*$/gm, "")), "no column can hold the learner's text");
  assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_offline_actions"/.test(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")));
});
