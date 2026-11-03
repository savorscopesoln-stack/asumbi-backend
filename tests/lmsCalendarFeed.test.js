/* L4.5b — calendar subscription feed. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsCalendarFeed.test.js");
const F = require("../utils/lmsCalendarFeed");
const feedRouter = require("../routes/lmsFeed");
const { STEPS } = require("../utils/lmsSchema");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-10-29T08:00:00Z");
const SECRET = "a".repeat(48);
const FEEDROW = (o = {}) => ({ student_id: 21, last_used_at: null, ...o });
const LOOKUP = (rows) => ["FROM lms_calendar_feeds f JOIN Students st", (i) => rows(i)];
const EVQ = (rows) => ["FROM lms_course_events e", () => rows];
const ev = { id: 1, course_id: 5, course_title: "Biology F3", title: "Cat 1", description: null, event_type: "exam", starts_at: new Date("2026-11-02T07:00:00Z"), ends_at: null, all_day: 0 };

test("createFeed: secret is 48 hex, only its SHA-256 hash is stored (never the secret), student id from the token, path carries the school key, audit written", async () => {
  const m = makeMockPool([["UPDATE lms_calendar_feeds SET token_hash", () => []]]);
  const r = await F.createFeed(m.pool, student(21), "eregi");
  assert.ok(r.ok && /^[a-f0-9]{48}$/.test(r.secret)); assert.strictEqual(r.path, `/api/lms-feed/eregi/${r.secret}.ics`);
  const q = m.log[0]; assert.strictEqual(q.inputs.s, 21); assert.strictEqual(q.inputs.h, F.hashOf(r.secret)); assert.notStrictEqual(q.inputs.h, r.secret); assert.strictEqual(q.inputs.h.length, 64);
  assert.ok(!q.sql.includes(r.secret) && !/\b21\b/.test(q.sql)); assert.ok(/IF @@ROWCOUNT = 0 INSERT/.test(q.sql));
  assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)), "audited"); assert.ok(!m.log.some((x) => x.sql.includes(r.secret) || JSON.stringify(x.inputs).includes(r.secret) && !/token_hash/.test(x.sql)), "secret never in audit");
  const again = await F.createFeed(makeMockPool().pool, student(21), "eregi"); assert.notStrictEqual(again.secret, r.secret);
});
test("create / status / revoke: staff and other roles are refused before any query", async () => {
  for (const u of [teacher, { id: 1, role: "admin", source: "Users" }, null, {}]) for (const fn of [F.createFeed, F.feedStatus, F.revokeFeed]) { const m = makeMockPool(); const r = await fn(m.pool, u, "x"); assert.deepStrictEqual([r.ok, r.forbidden, m.log.length], [false, true, 0]); }
});
test("feedStatus never returns the secret or the hash; revoked = inactive; missing = inactive", async () => {
  const a = await F.feedStatus(makeMockPool([["FROM lms_calendar_feeds WHERE student_id", () => [{ created_at: "c", last_used_at: null, revoked_at: null, token_hash: "h".repeat(64) }]]]).pool, student());
  assert.deepStrictEqual([a.ok, a.active, a.createdAt], [true, true, "c"]); assert.ok(!JSON.stringify(a).includes("hhhh"));
  assert.strictEqual((await F.feedStatus(makeMockPool([["FROM lms_calendar_feeds WHERE student_id", () => [{ created_at: "c", last_used_at: null, revoked_at: "r" }]]]).pool, student())).active, false);
  assert.strictEqual((await F.feedStatus(makeMockPool().pool, student())).active, false);
});
test("revokeFeed: only touches the caller's own live feed; audits only when something changed", async () => {
  const m = makeMockPool(); m.pool.request = ((orig) => () => { const r = orig(); const q = r.query; r.query = async (t) => { const x = await q(t); return /UPDATE lms_calendar_feeds SET revoked_at/.test(t) ? { ...x, rowsAffected: [1] } : x; }; return r; })(m.pool.request);
  const r = await F.revokeFeed(m.pool, student(21)); assert.deepStrictEqual([r.ok, r.revoked], [true, true]);
  assert.strictEqual(m.log[0].inputs.s, 21); assert.ok(/student_id = @s AND revoked_at IS NULL/.test(m.log[0].sql)); assert.ok(m.log.some((x) => /lms_audit_log/.test(x.sql)));
  const none = makeMockPool(); const r2 = await F.revokeFeed(none.pool, student(21)); assert.strictEqual(r2.revoked, false); assert.ok(!none.log.some((x) => /lms_audit_log/.test(x.sql)));
});
test("renderFeed: malformed secrets never reach the database; unknown / revoked / inactive student = not ok; the lookup itself enforces revoked_at IS NULL and an ACTIVE student", async () => {
  for (const s of [undefined, null, "", "short", "A".repeat(48), "g".repeat(48), SECRET + "0", `${SECRET}'; DROP TABLE x;--`, 123, {}]) { const m = makeMockPool(); const r = await F.renderFeed(m.pool, s, NOW); assert.deepStrictEqual([r.ok, m.log.length], [false, 0], String(s)); }
  const m = makeMockPool([LOOKUP(() => [])]); const r = await F.renderFeed(m.pool, SECRET, NOW); assert.strictEqual(r.ok, false); assert.strictEqual(m.log.length, 1);
  const q = m.log[0]; assert.strictEqual(q.inputs.h, F.hashOf(SECRET)); assert.ok(/f\.revoked_at IS NULL/.test(q.sql) && /st\.status = 'active'/.test(q.sql) && !q.sql.includes(SECRET));
});
test("renderFeed: valid secret returns a calendar built from the SAME planner query (enrolled + published); window = 14 days back, 120 days span; last_used touched when stale, not when fresh", async () => {
  const m = makeMockPool([LOOKUP(() => [FEEDROW()]), EVQ([ev]), ["UPDATE lms_calendar_feeds SET last_used_at", () => []]]);
  const r = await F.renderFeed(m.pool, SECRET, NOW); assert.ok(r.ok && /^BEGIN:VCALENDAR/.test(r.ics) && r.ics.includes("SUMMARY:Cat 1 (Biology F3)"));
  const pq = m.log.find((x) => /FROM lms_course_events e/.test(x.sql)); assert.strictEqual(pq.inputs.s, 21); assert.ok(/en\.status = 'active'/.test(pq.sql) && /c\.status = 'published'/.test(pq.sql));
  assert.strictEqual(new Date(pq.inputs.f).toISOString(), "2026-10-15T08:00:00.000Z"); assert.strictEqual(new Date(pq.inputs.t).toISOString(), "2027-02-12T08:00:00.000Z");
  assert.ok(m.log.some((x) => /SET last_used_at/.test(x.sql)), "touched (never used)");
  const fresh = makeMockPool([LOOKUP(() => [FEEDROW({ last_used_at: new Date("2026-10-29T07:30:00Z") })]), EVQ([ev])]); await F.renderFeed(fresh.pool, SECRET, NOW); assert.ok(!fresh.log.some((x) => /SET last_used_at/.test(x.sql)), "no write within the hour");
});
test("renderFeed: a failing last_used write never breaks the feed; a failing lookup throws (route turns it into 404)", async () => {
  const base = makeMockPool([LOOKUP(() => [FEEDROW()]), EVQ([])]); const orig = base.pool.request;
  base.pool.request = () => { const r = orig(); const q = r.query; r.query = async (t) => { if (/SET last_used_at/.test(t)) throw new Error("deadlock"); return q(t); }; return r; };
  assert.ok((await F.renderFeed(base.pool, SECRET, NOW)).ok);
  const bad = { request() { return { input() { return this; }, async query() { throw new Error("down"); } }; } }; await assert.rejects(() => F.renderFeed(bad, SECRET, NOW));
});
test("tenant isolation: a secret created in school A finds nothing in school B's database, and B's database is never written by A's calls", async () => {
  const T = makeTenants({ A: [["UPDATE lms_calendar_feeds SET token_hash", () => []], LOOKUP(() => [FEEDROW()]), EVQ([])], B: [LOOKUP(() => []), EVQ([ev])] });
  const made = await F.createFeed(T.A.pool, student(21), "A"); T.assertQueried("A"); T.assertUntouched("B");
  assert.ok((await F.renderFeed(T.A.pool, made.secret, NOW)).ok);
  const inB = await F.renderFeed(T.B.pool, made.secret, NOW); assert.strictEqual(inB.ok, false);
  assert.ok(!T.B.log.some((x) => /FROM lms_course_events/.test(x.sql)), "no content query when the secret is unknown");
});

/* ---------------- public route ---------------- */
async function hit({ tenant = "eregi", file = `${SECRET}.ics`, pool, known = true, licensed = true, ip = "1.1.1.1", headers = {} } = {}) {
  feedRouter._deps.hasTenant = () => known; feedRouter._deps.getPool = async () => pool; feedRouter._deps.isLicensed = async () => licensed;
  const layer = feedRouter.stack.find((l) => l.route && l.route.methods.get); const res = makeRes(); res.out = {}; res.set = (k, v) => { Object.assign(res.out, typeof k === "object" ? k : { [k]: v }); return res; }; res.type = (t) => { res.out.type = t; return res; };
  await layer.route.stack[0].handle({ params: { tenant, file }, ip, headers }, res);
  return res;
}
const okPool = () => makeMockPool([LOOKUP(() => [FEEDROW()]), EVQ([ev]), ["UPDATE lms_calendar_feeds SET last_used_at", () => []]]).pool;
test("public route (sequential, shares patched deps): 200 with private headers; identical 404 for every failure; no licence = no secret lookup; DB error = bare 404; rate limits", async () => {
  feedRouter._resetAll();
  const ok = await hit({ pool: okPool() }); assert.strictEqual(ok.statusCode, 200); assert.ok(/^text\/calendar/.test(ok.out["Content-Type"]) && /private/.test(ok.out["Cache-Control"]) && ok.out["X-Content-Type-Options"] === "nosniff" && /noindex/.test(ok.out["X-Robots-Tag"]) && ok.out["Referrer-Policy"] === "no-referrer"); assert.ok(/BEGIN:VCALENDAR/.test(ok.body));
  const bodies = new Set();
  for (const a of [{ known: false }, { file: "nope.ics" }, { file: `${SECRET}.txt` }, { file: `../${SECRET}.ics` }, { tenant: "bad key!" }, { tenant: "x".repeat(41) }, { licensed: false }, { pool: makeMockPool([LOOKUP(() => [])]).pool }]) {
    const r = await hit({ pool: okPool(), ...a }); assert.strictEqual(r.statusCode, 404, JSON.stringify(a).slice(0, 60)); bodies.add(r.body); assert.ok(!/BEGIN:VCALENDAR/.test(String(r.body)));
  }
  assert.strictEqual(bodies.size, 1, "identical answer for every failure");
  feedRouter._resetAll(); const m = makeMockPool([LOOKUP(() => [FEEDROW()])]); const r = await hit({ pool: m.pool, licensed: false }); assert.strictEqual(r.statusCode, 404); assert.strictEqual(m.log.length, 0);
  const bad = { request() { return { input() { return this; }, async query() { throw new Error("secret sql detail"); } }; } }; const e = await hit({ pool: bad }); assert.strictEqual(e.statusCode, 404); assert.ok(!/detail/.test(String(e.body)));
  feedRouter._resetAll(); let last;
  for (let i = 0; i < 61; i += 1) last = await hit({ pool: okPool(), ip: "9.9.9.9" }); assert.strictEqual(last.statusCode, 429); assert.strictEqual(last.out["Retry-After"], "60");
  assert.strictEqual((await hit({ pool: okPool(), ip: "8.8.8.8" })).statusCode, 200);
  assert.strictEqual((await hit({ pool: okPool(), ip: "proxy", headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.1" } })).statusCode, 200);
  feedRouter._resetAll(); let ceiling = 0; for (let i = 0; i < 1250; i += 1) { const r = await hit({ pool: okPool(), ip: "a", headers: { "x-forwarded-for": `7.7.${i % 250}.${Math.floor(i / 250)}` } }); if (r.statusCode === 429) ceiling += 1; } assert.ok(ceiling >= 40 && ceiling <= 60, "global ceiling reached: " + ceiling);
  feedRouter._resetAll();
});
test("management routes: studentOnly, 201 returns the path once with no-store; staff get 403 with no query; GET status has no secret", async () => {
  const router = require("../routes/lms");
  const run = async (method, p, user, pool) => { const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, method + p); const res = makeRes(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; }; const req = { user, pool, params: {}, body: {}, query: {}, tenant: "eregi" }, stack = layer.route.stack.map((s) => s.handle), pend = []; let i = 0; const next = () => { const h = stack[i++]; if (h) pend.push(Promise.resolve(h(req, res, next))); }; next(); for (let n = 0; n < pend.length; n += 1) await pend[n]; return res; };
  const c = await run("post", "/me/planner/feed", student(), makeMockPool().pool); assert.strictEqual(c.statusCode, 201); assert.ok(/^\/api\/lms-feed\/eregi\/[a-f0-9]{48}\.ics$/.test(c.body.path)); assert.strictEqual(c.headers["Cache-Control"], "no-store");
  const g = await run("get", "/me/planner/feed", student(), makeMockPool([["FROM lms_calendar_feeds WHERE student_id", () => [{ created_at: "c", last_used_at: null, revoked_at: null }]]]).pool); assert.strictEqual(g.statusCode, 200); assert.ok(g.body.active && !("path" in g.body) && !/[a-f0-9]{48}/.test(JSON.stringify(g.body)));
  const d = await run("delete", "/me/planner/feed", student(), makeMockPool().pool); assert.strictEqual(d.statusCode, 200);
  for (const [m, p] of [["get", "/me/planner/feed"], ["post", "/me/planner/feed"], ["delete", "/me/planner/feed"]]) { const mp = makeMockPool(); const r = await run(m, p, teacher, mp.pool); assert.strictEqual(r.statusCode, 403); assert.strictEqual(mp.log.length, 0); }
});
test("static: step 015 additive and ordered after 014; table blocklisted; public router mounted BEFORE the licence-gated router and does not use protect; service has no raw db / req.body / user values in SQL", () => {
  const st = STEPS.find((s) => s.id === "015_lms_calendar_feeds"); assert.ok(st && STEPS.indexOf(st) === STEPS.findIndex((s) => s.id === "014_lms_announcements") + 1);
  const ddl = st.sql.join("\n"); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl) && /UQ_lms_calendar_feeds_student/.test(ddl) && /token_hash CHAR\(64\)/.test(ddl) && !/\bsecret\b/i.test(ddl));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"); assert.ok(server.split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_calendar_feeds"'));
  assert.ok(server.indexOf('"/api/lms-feed"') > 0 && server.indexOf('"/api/lms-feed"') < server.indexOf('app.use("/api/lms",'));
  const route = fs.readFileSync(path.join(__dirname, "..", "routes", "lmsFeed.js"), "utf8"); assert.ok(!/\bprotect\b\s*[,)]/.test(route.replace(/\/\*[\s\S]*?\*\//g, "")) && !/req\.body/.test(route));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsCalendarFeed.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db|req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x))) assert.ok(!/\$\{[^}]*\b(secret|studentId|hash|token|id)\b/.test(piece), "no user value in SQL: " + piece.slice(0, 50));
  const lms = require("../routes/lms"); for (const m of ["get", "post", "delete"]) { const l = lms.stack.find((x) => x.route && x.route.path === "/me/planner/feed" && x.route.methods[m]); assert.ok(l && l.route.stack.length >= 2, m); }
});
