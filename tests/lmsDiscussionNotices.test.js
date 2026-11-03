/* L8.1c - in-app notices for discussion replies (D-097). Mocked pool only: SQL (UNION derived table, NOT EXISTS on Notifications, DATEDIFF/DATEADD) NOT verified on a real SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
const { tick } = require("./helpers/tick");
suite("lmsDiscussionNotices.test.js");
const N = require("../utils/lmsNotifications"), events = require("../utils/lmsEvents");

const POST = "FROM lms_posts p JOIN lms_threads t ON t.id = p.thread_id", WHO = "FROM ( SELECT th.author_id AS sid";
const SETTINGS = (o) => ["FROM lms_settings", () => (o === undefined ? [] : [{ setting_key: "notifications", value_json: JSON.stringify(o) }])];
const world = (o = {}) => makeMockPool([SETTINGS(o.settings),
  [POST, () => (o.noPost ? [] : [{ author_source: o.src || "Students", author_id: o.author ?? 30, thread_title: o.title || "Question 3", course_title: "Biology F3" }])],
  [WHO, () => (o.ids || [{ student_id: 21 }, { student_id: 22 }]).map((x) => (typeof x === "object" ? x : { student_id: x }))]]);
function deps(pools, { active = true } = {}) {
  const sent = [], asked = [];
  return { sent, asked, getPool: async (t) => { if (!pools[t]) throw new Error(`no pool ${t}`); return pools[t].pool; }, notify: async (pool, rec, opts) => { sent.push({ pool, rec, opts }); },
    isActive: async (pool, t, m, f) => { asked.push([t, m, f]); return typeof active === "function" ? active(t, m, f) : active; } };
}
const evt = (o) => ({ event: "lms.discussion.posted", tenant: "t1", courseId: 5, threadId: 11, postId: 31, ...o });
const sqlOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).sql || "", inOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).inputs || {};

test("a reply tells the thread starter and earlier repliers (learners only), never the poster; text names the thread and course only; type and link are right; ids are parameters", async () => {
  const m = world(); const d = deps({ t1: m }); const r = await N.handle(evt(), d);
  assert.deepStrictEqual([r.sent, d.sent.length], [2, 1]); assert.deepStrictEqual(d.sent[0].rec, [{ id: 21, source: "Students" }, { id: 22, source: "Students" }]);
  const o = d.sent[0].opts; assert.deepStrictEqual([o.type, o.link, o.title], ["lms_discussion", "/student/courses/5/learn?discussion=11", "New reply: Question 3"]);
  assert.strictEqual(o.message, 'There is a new reply in the discussion "Question 3" in "Biology F3". Open the course to read it.', "exactly this text: no post text, no author name or role");
  const w = sqlOf(m, WHO); assert.ok(/th\.author_source = N'Students'/.test(w) && /p2\.author_source = N'Students'/.test(w) && /p2\.deleted_at IS NULL AND p2\.hidden_at IS NULL AND p2\.id < @p/.test(w), "learners only, only visible earlier posts");
  assert.ok(/e\.course_id = @c AND e\.student_id = x\.sid AND e\.status = 'active'/.test(w) && /WHERE x\.sid <> @poster/.test(w) && /SELECT TOP 200/.test(w) && /ORDER BY x\.sid$/.test(w));
  assert.ok(!/\b11\b|\b31\b/.test(w.replace(/TOP 200/, "")), "ids travel as parameters"); const i = inOf(m, WHO); assert.deepStrictEqual([i.p, i.t, i.c, i.poster], [31, 11, 5, 30]);
});

test("the poster is excluded by id only when the poster is a LEARNER; a staff reply excludes nobody (a staff id never equals a learner id)", async () => {
  assert.strictEqual(inOf(world({ src: "Students", author: 30 }), WHO).poster, undefined);
  const a = world({ src: "Teachers", author: 30 }); await N.handle(evt(), deps({ t1: a })); assert.strictEqual(inOf(a, WHO).poster, 0);
  const b = world({ src: "Students", author: 30 }); await N.handle(evt(), deps({ t1: b })); assert.strictEqual(inOf(b, WHO).poster, 30);
  const c = world({ ids: [30, 21] }); const d = deps({ t1: c }); await N.handle(evt(), d); assert.deepStrictEqual(d.sent[0].rec.map((x) => x.id), [21], "a poster id that slips through the query is still dropped");
});

test("only a CURRENT reply notifies: live, visible, fresh, not an opening post, thread not hidden, forum not staff only, course published (all in SQL); nothing found = nothing sent", async () => {
  const m = world(); await N.handle(evt(), deps({ t1: m })); const q = sqlOf(m, POST);
  for (const re of [/p\.is_opening = 0/, /p\.deleted_at IS NULL AND p\.hidden_at IS NULL/, /t\.deleted_at IS NULL AND t\.hidden_at IS NULL/, /f\.deleted_at IS NULL AND f\.staff_only = 0/, /c\.deleted_at IS NULL AND c\.status = 'published'/, /DATEDIFF\(SECOND, p\.created_at, SYSUTCDATETIME\(\)\) <= @fresh/, /p\.id = @p AND p\.thread_id = @t AND p\.course_id = @c/]) assert.ok(re.test(q), String(re));
  assert.strictEqual(inOf(m, POST).fresh, 120);
  const none = world({ noPost: true }); const d = deps({ t1: none }); const r = await N.handle(evt(), d); assert.deepStrictEqual([r.sent, r.skipped, d.sent.length], [0, "NOT_CURRENT", 0]); assert.ok(!none.log.some((x) => x.sql.includes(WHO)));
  const e = world({ ids: [] }); const d2 = deps({ t1: e }); const r2 = await N.handle(evt(), d2); assert.deepStrictEqual([r2.sent, r2.skipped, d2.sent.length], [0, "NO_RECIPIENTS", 0]);
});

test("debounce: a learner already notified about THIS thread in the last 10 minutes is skipped in SQL (same link, Students, type lms_discussion)", async () => {
  const m = world(); await N.handle(evt(), deps({ t1: m })); const w = sqlOf(m, WHO);
  assert.ok(/NOT EXISTS \(SELECT 1 FROM Notifications n WHERE n\.recipientId = x\.sid AND n\.recipientSource = N'Students' AND n\.type = N'lms_discussion' AND n\.link = @link AND n\.createdAt > DATEADD\(MINUTE, -@deb, GETDATE\(\)\)\)/.test(w));
  const i = inOf(m, WHO); assert.deepStrictEqual([i.deb, i.link], [10, "/student/courses/5/learn?discussion=11"]); assert.strictEqual(N.DISC_DEBOUNCE_MINUTES, 10); assert.strictEqual(N.DISC_MAX_RECIPIENTS, 200);
  const big = world({ ids: Array.from({ length: 300 }, (_, k) => k + 1) }); const d = deps({ t1: big }); const r = await N.handle(evt(), d); assert.strictEqual(r.sent, 299, "the cap itself is the SQL TOP (the mock ignores it); only the poster (id 30) is dropped");
});

test("licence: the `lms` module AND the `lms_discussions` flag are asked (per event, per tenant); no licence = nothing read or sent; setting notifications.inApp=false = nothing sent", async () => {
  const m = world(); const d = deps({ t1: m }); await N.handle(evt(), d); assert.deepStrictEqual(d.asked[0], ["t1", "lms", undefined]); assert.deepStrictEqual(d.asked[1], ["t1", "lms", "lms_discussions"]);
  const no = world(); const d2 = deps({ t1: no }, { active: (t, mod, f) => !f }); const r = await N.handle(evt(), d2); assert.deepStrictEqual([r.sent, r.skipped, d2.sent.length], [0, "NO_LICENCE", 0]); assert.ok(!no.log.some((x) => x.sql.includes(POST)), "flag not sold: the post is not even read");
  const off = world({ settings: { inApp: false } }); const d3 = deps({ t1: off }); const r3 = await N.handle(evt(), d3); assert.deepStrictEqual([r3.skipped, d3.sent.length], ["DISABLED", 0]); assert.ok(!off.log.some((x) => x.sql.includes(POST)));
  const nl = world(); const d4 = deps({ t1: nl }, { active: false }); assert.strictEqual((await N.handle(evt(), d4)).skipped, "NO_LICENCE");
});

test("bad events cost no query; a tenant only ever uses its own pool; the bus delivers the event to the subscriber", async () => {
  for (const o of [{ courseId: "x" }, { threadId: 0 }, { postId: null }, { courseId: -1 }]) { const m = world(); const d = deps({ t1: m }); const r = await N.handle(evt(o), d); assert.strictEqual(r.skipped, "BAD_EVENT"); assert.ok(!m.log.some((x) => x.sql.includes(POST))); }
  const A = world(), B = world({ ids: [77] }); const d = deps({ tA: A, tB: B }); const r = await N.handle(evt({ tenant: "tB" }), d); assert.strictEqual(r.sent, 1); assert.strictEqual(d.sent[0].pool, B.pool); assert.strictEqual(A.log.length, 0, "tenant A untouched");
  await assert.rejects(() => N.handle(evt({ tenant: "tX" }), deps({ tA: A })), /no pool/);
  const m = world(); const dd = deps({ t9: m }); const results = []; const off = N.register({ ...dd, onResult: (e, res) => { if (e.tenant === "t9") results.push(res); } });
  events.emit("lms.discussion.posted", { tenant: "t9", courseId: 5, threadId: 11, postId: 31 }); await tick(); await tick(); off();
  assert.strictEqual(results.length, 1); assert.strictEqual(results[0].sent, 2); assert.strictEqual(dd.sent.length, 1);
});
