/* L4.5a — student planner + .ics. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
suite("lmsPlanner.test.js");
const P = require("../utils/lmsPlanner");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-10-29T08:00:00Z");
const ev = (o = {}) => ({ id: 1, course_id: 5, course_title: "Biology F3", title: "Cat 1", description: null, event_type: "exam", starts_at: new Date("2026-11-02T07:00:00Z"), ends_at: null, all_day: 0, ...o });
const EV = (rowsFn) => ["FROM lms_course_events e", (i) => rowsFn(i)];

test("window: default 7 days back, 60 ahead; from alone -> +60 days; bad / reversed / over 120 days refused", () => {
  const d = P.windowOf({}, NOW); assert.ok(d.ok); assert.strictEqual(d.f.toISOString(), "2026-10-22T08:00:00.000Z"); assert.strictEqual(d.t.toISOString(), "2026-12-28T08:00:00.000Z");
  const f = P.windowOf({ from: "2026-11-01T00:00:00Z" }, NOW); assert.strictEqual(f.t.toISOString(), "2026-12-31T00:00:00.000Z");
  for (const q of [{ from: "nope" }, { from: "2026-11-01", to: "2026-10-01" }, { from: "2026-01-01", to: "2026-12-01" }, { to: "zz" }, { from: 5 }]) assert.strictEqual(P.windowOf(q, NOW).ok, false, JSON.stringify(q));
});
test("getPlanner: student id from the token goes in as a parameter; enrolment, published course and not-deleted are enforced INSIDE the query; sorted by start", async () => {
  const m = makeMockPool([EV(() => [ev({ id: 2, starts_at: new Date("2026-11-05T07:00:00Z"), title: "Later" }), ev({ id: 1 })])]);
  const r = await P.getPlanner(m.pool, student(21), {}, NOW);
  assert.ok(r.ok && !r.truncated); assert.deepStrictEqual(r.items.map((x) => x.title), ["Cat 1", "Later"]); assert.deepStrictEqual([r.items[0].kind, r.items[0].courseTitle, r.items[0].eventType], ["course_event", "Biology F3", "exam"]);
  const q = m.log[0]; assert.strictEqual(q.inputs.s, 21);
  assert.ok(/en\.student_id = @s AND en\.status = 'active'/.test(q.sql) && /c\.status = 'published'/.test(q.sql) && /c\.deleted_at IS NULL/.test(q.sql) && /e\.deleted_at IS NULL/.test(q.sql) && /TOP 500/.test(q.sql) && !/\b21\b/.test(q.sql));
  assert.ok(!/SELECT \*/.test(q.sql) && !/password/i.test(q.sql));
});
test("only students have a planner: staff and other roles are refused before any query; a user object with no source is refused", async () => {
  for (const u of [teacher, { id: 1, role: "admin", source: "Users" }, null, {}]) { const m = makeMockPool([EV(() => [ev()])]); const r = await P.getPlanner(m.pool, u, {}, NOW); assert.deepStrictEqual([r.ok, r.forbidden, m.log.length], [false, true, 0]); }
});
test("invalid window asks the database nothing; hitting the 500 cap sets truncated", async () => {
  const m = makeMockPool([EV(() => [ev()])]); assert.strictEqual((await P.getPlanner(m.pool, student(), { from: "bad" }, NOW)).ok, false); assert.strictEqual(m.log.length, 0);
  const many = makeMockPool([EV(() => Array.from({ length: 501 }, (_, i) => ev({ id: i + 1 })))]); const r = await P.getPlanner(many.pool, student(), {}, NOW); assert.deepStrictEqual([r.truncated, r.items.length], [true, 500]);
});
test(".ics: CRLF, required fields, text escaped, all-day uses DATE, long lines folded at 75 octets, UID has no tenant or personal data", () => {
  const items = [
    { key: "event-1", title: "Cat 1; part, A\nB", courseTitle: "Biology \\ F3", description: "Bring ID", eventType: "exam", startsAt: new Date("2026-11-02T07:00:00Z"), endsAt: new Date("2026-11-02T08:30:00Z"), allDay: false },
    { key: "event-2", title: "Holiday", courseTitle: "Math", description: null, eventType: "event", startsAt: new Date("2026-11-03T00:00:00Z"), endsAt: null, allDay: true },
    { key: "event-3", title: "é".repeat(80), courseTitle: "X", description: null, eventType: "event", startsAt: new Date("2026-11-04T07:00:00Z"), endsAt: null, allDay: false },
  ];
  const t = P.toIcs(items, NOW), lines = t.split("\r\n");
  assert.ok(t.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") && t.endsWith("END:VCALENDAR\r\n") && !/[^\r]\n/.test(t));
  assert.ok(t.includes("DTSTART:20261102T070000Z") && t.includes("DTEND:20261102T083000Z") && t.includes("DTSTART;VALUE=DATE:20261103") && t.includes("DTSTAMP:20261029T080000Z"));
  assert.ok(t.includes("SUMMARY:Cat 1\\; part\\, A\\nB (Biology \\\\ F3)")); assert.ok(t.includes("UID:event-1@doravo-lms") && t.includes("CATEGORIES:EXAM"));
  assert.ok(lines.every((l) => Buffer.byteLength(l) <= 75), "folded"); assert.ok(lines.some((l) => l.startsWith(" ")));
  assert.strictEqual((t.match(/BEGIN:VEVENT/g) || []).length, 3); assert.strictEqual(P.toIcs([], NOW).includes("VEVENT"), false);
  const uid = P.toIcs([{ ...items[1], key: "ev;ent\r\n9" }], NOW).split("\r\n").find((l) => l.startsWith("UID:")); assert.ok(/^UID:[A-Za-z0-9_-]+@doravo-lms$/.test(uid), uid);
});

/* ---------------- routes ---------------- */
async function call(p, { user, pool, query = {} }) {
  const router = require("../routes/lms"); const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.get); assert.ok(layer, p);
  const res = makeRes(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; };
  const req = { user, pool, params: {}, body: {}, query }, stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n]; return res;
}
test("routes: student gets JSON and an .ics download with safe headers; staff get 403 with no query; a bad window is 400; a database error is a clean 500", async () => {
  const m = makeMockPool([EV(() => [ev()])]);
  const j = await call("/me/planner", { user: student(), pool: m.pool }); assert.strictEqual(j.statusCode, 200); assert.ok(j.body.success && j.body.items.length === 1 && j.body.items[0].key === "event-1");
  const c = await call("/me/planner.ics", { user: student(), pool: m.pool }); assert.strictEqual(c.statusCode, 200); assert.ok(/^text\/calendar/.test(c.headers["Content-Type"]) && /attachment/.test(c.headers["Content-Disposition"]) && c.headers["X-Content-Type-Options"] === "nosniff" && /no-store/.test(c.headers["Cache-Control"]) && /BEGIN:VCALENDAR/.test(c.body));
  for (const p of ["/me/planner", "/me/planner.ics"]) { const t = makeMockPool([EV(() => [ev()])]); const r = await call(p, { user: teacher, pool: t.pool }); assert.strictEqual(r.statusCode, 403); assert.strictEqual(t.log.length, 0); }
  assert.strictEqual((await call("/me/planner", { user: student(), pool: m.pool, query: { from: "bad" } })).statusCode, 400);
  const bad = { request() { return { input() { return this; }, async query() { throw new Error("boom secret detail"); } }; } };
  const e = await call("/me/planner", { user: student(), pool: bad }); assert.strictEqual(e.statusCode, 500); assert.ok(!/secret detail/.test(JSON.stringify(e.body)));
});
test("static: routes registered behind studentOnly; planner module has no raw db access, no req.body, no user value in SQL text; no schema change", () => {
  const router = require("../routes/lms");
  for (const p of ["/me/planner", "/me/planner.ics"]) { const l = router.stack.find((x) => x.route && x.route.path === p); assert.ok(l && l.route.stack.length >= 2, p); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsPlanner.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db|req\.body/.test(src));
  for (const piece of src.split("`").filter((x) => /\bSELECT\b/.test(x))) assert.ok(!/\$\{[^}]*(studentId|from|to|f|t|query)\b[^}]*\}/.test(piece.replace(/\$\{MAX_ROWS\}/g, "")), "no user value in SQL");
  assert.ok(!require("../utils/lmsSchema").STEPS.some((s) => /planner/i.test(s.id)));
});
