/* L10.3a - queued lesson-progress replay (D-115): validation, idempotency (duplicate / reused id / unfinished row), stale actions, rejections from the normal progress rules, tenant isolation, route gate, schema 043.
   Mocked pool with an in-memory action table; progress rules are a per-call stub (the real rules are tested in lmsProgress tests). SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsOfflineSync.test.js");
const S = require("../utils/lmsOfflineSync"), schema = require("../utils/lmsSchema");
const NOW = new Date("2026-11-10T09:00:00Z"), Q = "2026-11-09T18:00:00Z";
const A = (o = {}) => ({ clientActionId: "act-00000001", type: "lesson_complete", lessonId: 11, queuedAt: Q, ...o });

/* in-memory lms_offline_actions behind the mock pool */
const world = (pre = []) => {
  const rows = pre.map((r, i) => ({ id: 100 + i, ...r })); let next = 200;
  const m = makeMockPool([
    ["INSERT INTO lms_offline_actions", (i) => { if (rows.some((r) => r.student_id === i.s && r.client_action_id === i.a)) { const e = new Error("dup"); e.number = 2627; throw e; } const r = { id: next++, course_id: i.c, student_id: i.s, client_action_id: i.a, action_type: i.t, lesson_id: i.l, result_state: null, result_code: null }; rows.push(r); return [{ id: r.id }]; }],
    ["SELECT TOP 1 id, course_id, action_type", (i) => rows.filter((r) => r.student_id === i.s && r.client_action_id === i.a)],
    ["UPDATE lms_offline_actions SET result_state", (i) => { const r = rows.find((x) => x.id === i.id && x.student_id === i.s); if (r) { r.result_state = i.st; r.result_code = i.cd; } return []; }]]);
  return { ...m, rows };
};
const stub = (o = {}) => { const calls = []; return { calls, progress: { MAX_CLAIM_SECONDS: 600,
  recordView: async (...a) => { calls.push(["view", a[1], a[2], a[3], a[4]]); return o.view || { ok: true, recorded: true, progress: { status: "in_progress", completedAt: null } }; },
  markComplete: async (...a) => { calls.push(["complete", a[1], a[2], a[3]]); return o.complete || { ok: true, newlyCompleted: true, progress: { status: "completed", completedAt: "2026-11-10T08:59:00Z" } }; } } }; };
const run = (w, body, st = stub(), c = 5, s = 21) => S.replayProgress(w.pool, c, s, body, { now: NOW, tenant: "t1", progress: st.progress });

test("validateBatch (pure): 1-50 actions, only known fields/types; a bad single action comes back as invalid, the batch still runs; repeated id in one request flagged", () => {
  const v = (b) => S.validateBatch(b, NOW);
  for (const b of [null, [], {}, { actions: [] }, { actions: "x" }, { actions: [A()], extra: 1 }, { actions: Array.from({ length: 51 }, (_, i) => A({ clientActionId: "act-" + String(i).padStart(8, "0") })) }]) assert.strictEqual(v(b).ok, false, JSON.stringify(b).slice(0, 60));
  const r = v({ actions: [A(), A({ clientActionId: "x" }), A({ clientActionId: "act-00000002", type: "quiz" }), A({ clientActionId: "act-00000003", lessonId: 0 }), A({ clientActionId: "act-00000004", queuedAt: "nope" }), A({ clientActionId: "act-00000005", foo: 1 }),
    A({ clientActionId: "act-00000006", seconds: 5 }), A({ clientActionId: "act-00000007", type: "lesson_view", seconds: 601 }), A({ clientActionId: "act-00000008", type: "lesson_view", seconds: 30 }), A(), null, "x"] });
  assert.ok(r.ok); assert.deepStrictEqual(r.actions.map((x) => !!x.invalid), [false, true, true, true, true, true, true, true, false, true, true, true]);
  assert.deepStrictEqual([r.actions[8].type, r.actions[8].seconds, r.actions[0].seconds], ["lesson_view", 30, 0]); assert.ok(/Repeated/.test(r.actions[9].invalid));
  assert.ok(r.actions[10].clientActionId === null && r.actions[11].clientActionId === null);
});

test("replay: applied once, answered per action in order; progress rules called with the TOKEN student and the lesson; view carries seconds; nothing stored but ids and outcome", async () => {
  const w = world(), st = stub(); const r = await run(w, { actions: [A(), A({ clientActionId: "act-00000002", type: "lesson_view", lessonId: 12, seconds: 40 })] }, st);
  assert.ok(r.ok); assert.deepStrictEqual(r.results.map((x) => [x.clientActionId, x.state, x.newlyCompleted]), [["act-00000001", "applied", true], ["act-00000002", "applied", false]]);
  assert.deepStrictEqual(r.summary, { applied: 2, duplicate: 0, rejected: 0 }); assert.deepStrictEqual(st.calls, [["complete", 5, 11, 21], ["view", 5, 12, 21, { seconds: 40 }]]);
  assert.deepStrictEqual(w.rows.map((x) => [x.student_id, x.course_id, x.result_state]), [[21, 5, "applied"], [21, 5, "applied"]]);
  const up = w.log.find((x) => /UPDATE lms_offline_actions/.test(x.sql)); assert.ok(/WHERE id = @id AND student_id = @s/.test(up.sql), "a result is written only to the learner's own row");
  const ins = w.log.find((x) => /INSERT INTO lms_offline_actions/.test(x.sql)); assert.deepStrictEqual(Object.keys(ins.inputs).sort(), ["a", "c", "l", "q", "s", "t"]);
});

test("idempotent: replaying the same batch changes nothing (duplicate, progress rules NOT called again); same id for another lesson/type/course = ACTION_ID_REUSED; unfinished row is finished; another learner's same id is independent", async () => {
  const w = world(), st = stub(); await run(w, { actions: [A()] }, st); const again = await run(w, { actions: [A()] }, st);
  assert.deepStrictEqual([again.results[0].state, again.results[0].firstResult, again.summary.duplicate], ["duplicate", "applied", 1]); assert.strictEqual(st.calls.length, 1, "progress ran once");
  assert.strictEqual((await run(w, { actions: [A({ lessonId: 99 })] }, st)).results[0].code, "ACTION_ID_REUSED"); assert.strictEqual((await run(w, { actions: [A({ type: "lesson_view" })] }, st)).results[0].code, "ACTION_ID_REUSED");
  assert.strictEqual((await run(w, { actions: [A()] }, st, 6)).results[0].code, "ACTION_ID_REUSED"); assert.strictEqual(st.calls.length, 1);
  const other = await run(w, { actions: [A()] }, st, 5, 22); assert.strictEqual(other.results[0].state, "applied", "a different learner owns a different id space"); assert.strictEqual(st.calls.length, 2);
  const half = world([{ course_id: 5, student_id: 21, client_action_id: "act-00000001", action_type: "lesson_complete", lesson_id: 11, result_state: null, result_code: null }]); const st2 = stub(); const f = await run(half, { actions: [A()] }, st2);
  assert.deepStrictEqual([f.results[0].state, st2.calls.length, half.rows[0].result_state], ["applied", 1, "applied"], "a crash between insert and result is finished by the replay");
  const rej = world(), st3 = stub({ complete: { ok: false, code: "LESSON_LOCKED", errors: ["Finish x first."] } }); await run(rej, { actions: [A()] }, st3); const r2 = await run(rej, { actions: [A()] }, st3);
  assert.deepStrictEqual([r2.results[0].state, r2.results[0].code, r2.results[0].firstResult], ["duplicate", "LESSON_LOCKED", "rejected"], "a replay of a rejected action repeats the rejection, it is not retried");
});

test("rejections come from the NORMAL progress rules (not found, locked, archived, min time) and are stored; stale / future queuedAt rejected WITHOUT claiming the id; invalid reported per action", async () => {
  for (const [res, code] of [[{ ok: false, notFound: true, errors: ["Lesson not found."] }, "NOT_FOUND"], [{ ok: false, code: "LESSON_LOCKED", errors: ["l"] }, "LESSON_LOCKED"], [{ ok: false, code: "COURSE_ARCHIVED", errors: ["a"] }, "COURSE_ARCHIVED"], [{ ok: false, code: "MIN_TIME_NOT_MET", errors: ["m"] }, "MIN_TIME_NOT_MET"], [{ ok: false, errors: ["x"] }, "INVALID"]]) {
    const w = world(); const r = await run(w, { actions: [A()] }, stub({ complete: res })); assert.deepStrictEqual([r.results[0].state, r.results[0].code, w.rows[0].result_state, w.rows[0].result_code], ["rejected", code, "rejected", code]);
  }
  const w = world(), st = stub(); const r = await run(w, { actions: [A({ clientActionId: "act-00000010", queuedAt: "2026-09-01T00:00:00Z" }), A({ clientActionId: "act-00000011", queuedAt: "2026-11-10T09:06:00Z" }), A({ clientActionId: "act-00000012", queuedAt: "2026-11-10T09:04:00Z" }), { clientActionId: "bad" }] }, st);
  assert.deepStrictEqual(r.results.map((x) => [x.state, x.code]), [["rejected", "STALE_ACTION"], ["rejected", "STALE_ACTION"], ["applied", undefined], ["rejected", "INVALID"]]); assert.strictEqual(w.rows.length, 1, "stale and invalid actions store nothing"); assert.strictEqual(st.calls.length, 1);
  assert.strictEqual(r.results[3].clientActionId, null, "an id that fails the format is not echoed back");
});

test("batch edge cases: bad ids / bad body are refused before any write; a thrown database error is NOT swallowed; tenant isolation", async () => {
  for (const [c, s, b] of [["x", 21, { actions: [A()] }], [5, 0, { actions: [A()] }], [5, 21, { actions: [] }], [0, 21, { actions: [A()] }]]) { const w = world(), st = stub(); const r = await run(w, b, st, c, s); assert.strictEqual(r.ok, false); assert.ok(!w.log.length && !st.calls.length); }
  const boom = makeMockPool([["INSERT INTO lms_offline_actions", () => { throw new Error("db down"); }]]); let err = null; try { await run(boom, { actions: [A()] }); } catch (e) { err = e; } assert.ok(err && /db down/.test(err.message));
  const T = makeTenants({ A: [["INSERT INTO lms_offline_actions", () => [{ id: 1 }]], ["UPDATE lms_offline_actions", () => []]], B: [] }); const st = stub(); const r = await S.replayProgress(T.A.pool, 5, 21, { actions: [A()] }, { now: NOW, progress: st.progress }); assert.strictEqual(r.results[0].state, "applied"); T.assertUntouched("B");
});

test("route: flag `lms_offline` first, studentOnly + enrolment, no-store, 200 with results / 400 on a bad body; schema 043 is additive, unique (student, client id), LAST, blocked from the record editor", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const lr = router.stack.find((l) => l.route && l.route.path === "/courses/:courseId/learn/offline/sync/progress" && l.route.methods.post); assert.ok(lr && lr.route.stack.length === 4);
  assert.ok(/"\/courses\/:courseId\/learn\/offline\/sync\/progress", olGate, studentOnly, studentAccess/.test(src));
  const stu = { id: 21, role: "student", source: "Students" };
  const w = world(); let h = null; const ok = makeRes(); ok.setHeader = (k, v) => { h = [k, v]; };
  await lr.route.stack[3].handle({ pool: w.pool, user: stu, params: { courseId: "5" }, body: { actions: [A({ queuedAt: new Date(Date.now() - 60000).toISOString() })] }, tenant: "t" }, ok); /* real clock in the route */
  assert.deepStrictEqual([ok.statusCode, ok.body.success, ok.body.results[0].state, ok.body.results[0].code, ok.body.summary.rejected, h], [200, true, "rejected", "NOT_FOUND", 1, ["Cache-Control", "no-store"]], "real progress rules: the mock has no course, so the answer is a stored NOT_FOUND rejection");
  assert.strictEqual(w.rows[0].result_state, "rejected");
  const w2 = world(); const bad = makeRes(); await lr.route.stack[3].handle({ pool: w2.pool, user: stu, params: { courseId: "5" }, body: { actions: [] }, tenant: "t" }, bad); assert.strictEqual(bad.statusCode, 400); assert.ok(!w2.log.length, "a refused body touches nothing");
  const ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("043_lms_offline_actions"); assert.ok(i === ids.length - 3 && ids[i - 1] === "042_lms_offline_packs" && ids[i + 1] === "044_lms_offline_drafts" && ids[i + 2] === "045_lms_offline_quiz_answers");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/name='lms_offline_actions'/.test(t) && !/DROP |DELETE |ALTER TABLE/i.test(t) && /UX_lms_offline_actions_client ON lms_offline_actions \(student_id, client_action_id\)/.test(t) && !/text|body|answer/i.test(t.replace(/--.*$/gm, "")));
  assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_offline_actions"/.test(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")));
});
