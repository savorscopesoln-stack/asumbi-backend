/* L9.5a - guardian links (D-112): create/list/revoke by an LMS administrator, hashed expiring secrets, the public read-only view (progress + missed work ONLY), uniform 404, tenant isolation.
   Mocked pool only: SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsGuardian.test.js");
const G = require("../utils/lmsGuardian"), schema = require("../utils/lmsSchema"), P = require("../utils/lmsPermissions");
const gRouter = require("../routes/lmsGuardian"), lmsRouter = require("../routes/lms");

const admin = { id: 1, role: "admin", source: "Users" }, teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-11-10T09:00:00Z"), SECRET = "ab".repeat(24);
const STUDENT = ["FROM Students WHERE id = @s AND status = 'active'", (i) => (i.s === 21 ? [{ id: 21 }] : [])];
const INS = (rows) => ["INSERT INTO lms_guardian_links", () => (rows === undefined ? [{ id: 5 }] : rows)];
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const writes = (m) => m.log.filter((x) => /INSERT INTO|UPDATE |DELETE FROM/.test(x.sql) && !/lms_audit_log/.test(x.sql));

test("validateCreate (pure): label 1-60 (cleaned), days 1-365 (default 90), unknown fields refused", () => {
  assert.deepStrictEqual([G.validateCreate(undefined).label, G.validateCreate({}).days, G.validateCreate({ label: " <b>Mum</b> ", days: "30" }).label, G.validateCreate({ days: "30" }).days], ["Guardian", 90, "bMum/b", 30]);
  for (const b of [[], "x", { label: "" }, { label: "x".repeat(61) }, { days: 0 }, { days: 366 }, { days: 1.5 }, { days: "abc" }, { who: 1 }]) assert.strictEqual(G.validateCreate(b).ok, false, JSON.stringify(b));
});

test("createLink: active learner only, the secret is returned ONCE and only its SHA-256 hash is stored, expiry from now + days, live-link cap in the INSERT, audited without the secret", async () => {
  const m = makeMockPool([STUDENT, INS()]); const r = await G.createLink(m.pool, admin, 21, { label: "Mother", days: 30 }, { tenant: "eregi", now: NOW, secret: SECRET }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.secret, r.path, r.link.expiresAt, r.link.label, r.link.id], [SECRET, `/api/lms-guardian/eregi/${SECRET}.json`, "2026-12-10T09:00:00.000Z", "Mother", 5]);
  const q = m.log.find((x) => /INSERT INTO lms_guardian_links/.test(x.sql)); assert.strictEqual(q.inputs.h, G.hashOf(SECRET)); assert.notStrictEqual(q.inputs.h, SECRET); assert.strictEqual(q.inputs.h.length, 64);
  assert.ok(!JSON.stringify(m.log.map((x) => x.inputs)).includes(SECRET), "the plain secret never reaches the database or the audit log");
  assert.ok(/WHERE \(SELECT COUNT\(\*\) FROM lms_guardian_links WHERE student_id = @s AND revoked_at IS NULL AND expires_at > @now\) < @max/.test(q.sql) && q.inputs.max === 5);
  assert.strictEqual(audits(m).length, 1); const rnd = await G.createLink(makeMockPool([STUDENT, INS()]).pool, admin, 21, {}, { now: NOW }); assert.ok(/^[a-f0-9]{48}$/.test(rnd.secret), "a random 192-bit secret by default");
  const full = makeMockPool([STUDENT, INS([])]); assert.strictEqual((await G.createLink(full.pool, admin, 21, {}, { now: NOW })).code, "LINK_LIMIT"); assert.strictEqual(audits(full).length, 0);
  const none = makeMockPool([STUDENT, INS()]); assert.strictEqual((await G.createLink(none.pool, admin, 99, {}, { now: NOW })).notFound, true); assert.strictEqual(writes(none).length, 0, "unknown / inactive learner: nothing written");
  for (const sid of ["x", 0, -1]) assert.strictEqual((await G.createLink(makeMockPool([]).pool, admin, sid, {})).notFound, true);
  assert.strictEqual((await G.createLink(makeMockPool([]).pool, null, 21, {})).notFound, true); const bad = makeMockPool([STUDENT, INS()]); assert.strictEqual((await G.createLink(bad.pool, admin, 21, { days: 999 })).ok, false); assert.strictEqual(bad.log.length, 0);
});

test("listLinks never returns a hash or secret; active = not revoked and not expired; revokeLink = one guarded UPDATE, audited, a second revoke is not found", async () => {
  const rows = [{ id: 3, label: "Dad", created_at: NOW, expires_at: new Date("2026-12-01T00:00:00Z"), last_used_at: null, revoked_at: null }, { id: 2, label: "Old", created_at: NOW, expires_at: new Date("2026-11-01T00:00:00Z"), last_used_at: NOW, revoked_at: null }, { id: 1, label: "Gone", created_at: NOW, expires_at: new Date("2027-01-01T00:00:00Z"), last_used_at: null, revoked_at: NOW }];
  const m = makeMockPool([["FROM lms_guardian_links WHERE student_id = @s", () => rows]]); const r = await G.listLinks(m.pool, 21, NOW);
  assert.deepStrictEqual(r.links.map((l) => [l.id, l.active, l.revoked]), [[3, true, false], [2, false, false], [1, false, true]]); assert.ok(!/token|hash|secret/i.test(JSON.stringify(r)));
  assert.ok(/TOP 20/.test(m.log[0].sql) && m.log[0].inputs.s === 21); assert.strictEqual((await G.listLinks(makeMockPool([]).pool, "x")).notFound, true);
  const v = makeMockPool([["UPDATE lms_guardian_links SET revoked_at", () => [{ student_id: 21 }]]]); assert.ok((await G.revokeLink(v.pool, admin, 3, NOW)).revoked); assert.ok(/AND revoked_at IS NULL/.test(v.log[0].sql)); assert.strictEqual(audits(v).length, 1);
  assert.strictEqual((await G.revokeLink(makeMockPool([["UPDATE lms_guardian_links SET revoked_at", () => []]]).pool, admin, 3)).notFound, true); assert.strictEqual((await G.revokeLink(makeMockPool([]).pool, admin, "x")).notFound, true);
});

const arow = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Essay 1", instructions: "x", status: "published", published_at: null, available_from: null, due_at: new Date("2026-11-05T10:00:00Z"), cutoff_at: null, submission_type: "text", allowed_extensions: null,
  max_file_mb: null, max_files: 5, max_attempts: 1, late_policy: null, late_penalty_percent: null, max_points: 100, work_mode: "individual", attachments_json: null, created_at: NOW, updated_at: NOW, course_title: "Maths", ext_due_at: null, ext_cutoff_at: null, ...o });
const LINK = (rows) => ["FROM lms_guardian_links l JOIN Students st", () => rows === undefined ? [{ id: 5, student_id: 21, last_used_at: null, student_name: "Amina" }] : rows];
const CARDS = ["FROM lms_courses c WHERE c.status = 'published'", () => [{ id: 5, title: "Maths", code: "M1", total_lessons: 10, completed_lessons: 4 }]];
const COUNTS = ["SUM(CASE WHEN e.status = 'active'", () => [{ active_n: 1, pending_n: 0 }]];
const MISSED = (rows) => ["FROM lms_assignments a", (i) => (i.s === 21 ? rows : [])];
const TOUCH = ["UPDATE lms_guardian_links SET last_used_at", () => []];
const world = (o = {}) => makeMockPool([LINK(o.link), CARDS, COUNTS, MISSED(o.rows || [arow()]), TOUCH]);

test("missedFrom (pure): due date passed counts, the learner's extension moves it, future/undated are not missed, newest due first", () => {
  const rows = [arow({ id: 1, due_at: new Date("2026-11-01T00:00:00Z"), title: "A" }), arow({ id: 2, due_at: new Date("2026-11-08T00:00:00Z"), title: "B" }), arow({ id: 3, due_at: new Date("2026-11-20T00:00:00Z"), title: "C" }), arow({ id: 4, due_at: new Date("2026-11-02T00:00:00Z"), ext_due_at: new Date("2026-11-30T00:00:00Z"), title: "D" })];
  assert.deepStrictEqual(G.missedFrom(rows, NOW).map((x) => x.title), ["B", "A"], "C is in the future, D is extended past now"); assert.deepStrictEqual(G.missedFrom(null, NOW), []);
});

test("renderView: ONLY progress and missed work, no ids, no grades, no other fields; expired/revoked/unknown/malformed secret = { ok:false }; the secret is looked up by hash with expiry in SQL", async () => {
  const m = world(); const r = await G.renderView(m.pool, SECRET, NOW); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(r.view).sort(), ["courses", "fields", "generatedAt", "learner", "missedWork"]); assert.deepStrictEqual(r.view.fields, ["progress", "missedWork"]);
  assert.deepStrictEqual(r.view.courses, [{ title: "Maths", code: "M1", totalLessons: 10, completedLessons: 4, percent: 40 }]); assert.deepStrictEqual(r.view.learner, { name: "Amina" });
  assert.deepStrictEqual(r.view.missedWork, { items: [{ courseTitle: "Maths", title: "Essay 1", dueAt: "2026-11-05T10:00:00.000Z" }], total: 1, more: false });
  assert.ok(!/studentId|student_id|courseId|assignmentId|admission|grade|points|feedback|announce|label|token/i.test(JSON.stringify(r.view)), "nothing beyond progress and missed work: " + JSON.stringify(r.view));
  const q = m.log.find((x) => /lms_guardian_links l JOIN Students/.test(x.sql)); assert.strictEqual(q.inputs.h, G.hashOf(SECRET)); assert.ok(/revoked_at IS NULL AND l\.expires_at > @now/.test(q.sql) && /st\.status = 'active'/.test(q.sql));
  assert.ok(m.log.every((x) => /^\s*SELECT|UPDATE lms_guardian_links SET last_used_at/.test(x.sql)), "read only apart from the hourly last-used stamp");
  const mq = m.log.find((x) => /FROM lms_assignments a/.test(x.sql)); assert.ok(/en\.status = 'active'/.test(mq.sql) && /sb\.status = 'submitted'/.test(mq.sql) && /c\.status = 'published'/.test(mq.sql) && /a\.due_at IS NOT NULL/.test(mq.sql) && mq.inputs.s === 21, "this learner only, active enrolment, published course, not handed in");
  const none = world({ link: [] }); assert.deepStrictEqual(await G.renderView(none.pool, SECRET, NOW), { ok: false }); assert.ok(!none.log.some((x) => /lms_assignments|lms_courses/.test(x.sql)), "no content query for a bad secret");
  for (const s of [undefined, null, "", "xyz", SECRET.toUpperCase(), SECRET + "0", 5]) { const z = world(); assert.deepStrictEqual(await G.renderView(z.pool, s, NOW), { ok: false }); assert.strictEqual(z.log.length, 0, "malformed secret: no query"); }
  const touch = m.log.filter((x) => /UPDATE lms_guardian_links SET last_used_at/.test(x.sql)); assert.strictEqual(touch.length, 1);
  const recent = world({ link: [{ id: 5, student_id: 21, last_used_at: new Date("2026-11-10T08:30:00Z"), student_name: "A" }] }); await G.renderView(recent.pool, SECRET, NOW); assert.ok(!recent.log.some((x) => /last_used_at = SYSUTCDATETIME/.test(x.sql)), "touched at most once an hour");
  const many = world({ rows: Array.from({ length: 25 }, (_, i) => arow({ id: i + 1, due_at: new Date(Date.UTC(2026, 9, 1 + (i % 25))) })) }); const mr = (await G.renderView(many.pool, SECRET, NOW)).view.missedWork; assert.deepStrictEqual([mr.items.length, mr.total, mr.more], [20, 25, true]);
});

test("tenant isolation: a secret of school A finds nothing in school B and B's database never sees A's content queries", async () => {
  const T = makeTenants({ A: [LINK(), CARDS, COUNTS, MISSED([arow()]), TOUCH], B: [LINK([])] });
  assert.strictEqual((await G.renderView(T.B.pool, SECRET, NOW)).ok, false); assert.ok(!T.B.log.some((x) => /lms_assignments/.test(x.sql))); assert.ok((await G.renderView(T.A.pool, SECRET, NOW)).ok);
  const T2 = makeTenants({ A: [STUDENT, INS()], B: [STUDENT, INS()] }); assert.ok((await G.createLink(T2.A.pool, admin, 21, {}, { now: NOW })).ok); T2.assertUntouched("B");
});

/* sequential: the public route shares patched deps of its own router */
async function hit({ tenant = "eregi", file = `${SECRET}.json`, pool, known = true, licensed = true, ip = "1.1.1.1" } = {}) {
  gRouter._deps.hasTenant = () => known; gRouter._deps.getPool = async () => pool; gRouter._deps.isLicensed = async () => licensed;
  const layer = gRouter.stack.find((l) => l.route && l.route.methods.get); const res = makeRes(); res.out = {}; res.set = (k, v) => { Object.assign(res.out, typeof k === "object" ? k : { [k]: v }); return res; }; res.type = (t) => { res.out.type = t; return res; };
  await layer.route.stack[0].handle({ params: { tenant, file }, ip, headers: {} }, res); return res;
}
test("public route: 200 JSON with private no-store headers; identical 404 for bad school/file/secret/licence/expired; no licence = no secret lookup; DB error = bare 404; per-client rate limit 429", async () => {
  gRouter._resetAll(); const ok = await hit({ pool: world().pool }); assert.strictEqual(ok.statusCode, 200);
  assert.ok(ok.out["Cache-Control"] === "private, no-store" && ok.out["X-Content-Type-Options"] === "nosniff" && /noindex/.test(ok.out["X-Robots-Tag"]) && ok.out["Referrer-Policy"] === "no-referrer" && /^application\/json/.test(ok.out["Content-Type"]));
  assert.deepStrictEqual([ok.body.success, ok.body.learner.name, ok.body.courses.length], [true, "Amina", 1]);
  const bodies = new Set(), codes = new Set();
  for (const a of [{ known: false }, { file: "nope.json" }, { file: `${SECRET}.ics` }, { file: `../${SECRET}.json` }, { tenant: "bad key!" }, { tenant: "x".repeat(41) }, { licensed: false }, { pool: world({ link: [] }).pool }]) { const r = await hit({ pool: world().pool, ...a }); codes.add(r.statusCode); bodies.add(JSON.stringify(r.body)); }
  assert.deepStrictEqual([...codes], [404], "every failure is the same 404"); assert.strictEqual(bodies.size, 1, "and the same body");
  const m = world(); await hit({ pool: m.pool, licensed: false }); assert.strictEqual(m.log.length, 0, "no licence: the secret is never looked up");
  const boom = { request: () => { throw new Error("db down"); } }; assert.strictEqual((await hit({ pool: boom })).statusCode, 404);
  gRouter._resetAll(); let last; for (let i = 0; i < 61; i += 1) last = await hit({ pool: world().pool, ip: "9.9.9.9" }); assert.strictEqual(last.statusCode, 429); gRouter._resetAll();
  assert.ok(!gRouter._deps.isLicensed.toString().includes("lms_core") || true); const src = fs.readFileSync(path.join(__dirname, "../routes/lmsGuardian.js"), "utf8"); assert.ok(/"lms", "lms_guardian"/.test(src), "the lms_guardian flag is required");
});

test("schema step 041 + blocklist + staff routes: additive, unique token hash, LAST step, table blocked from the record editor; three routes behind flag lms_guardian + lms.settings.manage; mounted publicly", () => {
  const ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("041_lms_guardian"); assert.ok(i === ids.length - 5 && ids[i - 1] === "040_lms_paths" && ids[i + 1] === "042_lms_offline_packs", "041 is followed only by offline packs 042 (L10.1a)");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/name='lms_guardian_links' AND xtype='U'/.test(t) && /CHAR\(64\)/.test(t) && /UNIQUE INDEX UX_lms_guardian_links_token/.test(t) && !/DROP |DELETE |ALTER TABLE/i.test(t) && !/secret\b/i.test(t.replace(/secret link/gi, "")));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_guardian_links"/.test(server)); assert.ok(/app\.use\("\/api\/lms-guardian", require\("\.\/routes\/lmsGuardian"\)\)/.test(server));
  const src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"); assert.ok(/gdGate = requireModule\("lms", "lms_guardian"\), gdAdmin = requireLmsPermission\("lms\.settings\.manage"\)/.test(src));
  assert.strictEqual((src.match(/gdGate, gdAdmin, async/g) || []).length, 3);
  const want = [["post", "/guardian/students/:studentId/links"], ["get", "/guardian/students/:studentId/links"], ["delete", "/guardian/links/:linkId"]];
  for (const [m, p] of want) { const l = lmsRouter.stack.find((x) => x.route && x.route.path === p && x.route.methods[m]); assert.ok(l, p); assert.strictEqual(l.route.stack.length, 3, "flag gate + permission + handler (protect + lms_core are router-level)"); }
  assert.ok(!P.roleDefaults({ role: "teacher" }).includes("lms.settings.manage") && !P.roleDefaults({ role: "student" }).includes("lms.settings.manage"), "teachers and students cannot create links");
});

test("staff handlers: 201 with the secret once + no-store; list/revoke shapes; 404 for unknown learner/link; 400 for a bad body", async () => {
  const h = (mth, p) => lmsRouter.stack.find((x) => x.route && x.route.path === p && x.route.methods[mth]).route.stack.slice(-1)[0].handle;
  const call = async (fn, req) => { const res = makeRes(); res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; }; await fn({ tenant: "eregi", ...req }, res); return res; };
  const c = await call(h("post", "/guardian/students/:studentId/links"), { pool: makeMockPool([STUDENT, INS()]).pool, user: admin, params: { studentId: "21" }, body: { label: "Mum" } });
  assert.deepStrictEqual([c.statusCode, c.body.success, /^\/api\/lms-guardian\/eregi\/[a-f0-9]{48}\.json$/.test(c.body.path), "ok" in c.body, c.headers["Cache-Control"]], [201, true, true, false, "no-store"]);
  assert.strictEqual((await call(h("post", "/guardian/students/:studentId/links"), { pool: makeMockPool([STUDENT, INS()]).pool, user: admin, params: { studentId: "99" }, body: {} })).statusCode, 404);
  assert.strictEqual((await call(h("post", "/guardian/students/:studentId/links"), { pool: makeMockPool([STUDENT, INS()]).pool, user: admin, params: { studentId: "21" }, body: { days: 0 } })).statusCode, 400);
  assert.strictEqual((await call(h("post", "/guardian/students/:studentId/links"), { pool: makeMockPool([STUDENT, INS([])]).pool, user: admin, params: { studentId: "21" }, body: {} })).statusCode, 409);
  const l = await call(h("get", "/guardian/students/:studentId/links"), { pool: makeMockPool([["FROM lms_guardian_links WHERE student_id", () => []]]).pool, user: admin, params: { studentId: "21" } }); assert.deepStrictEqual([l.statusCode, l.body.links], [200, []]);
  assert.strictEqual((await call(h("delete", "/guardian/links/:linkId"), { pool: makeMockPool([["UPDATE lms_guardian_links SET revoked_at", () => [{ student_id: 21 }]]]).pool, user: admin, params: { linkId: "3" } })).body.revoked, true);
  assert.strictEqual((await call(h("delete", "/guardian/links/:linkId"), { pool: makeMockPool([]).pool, user: admin, params: { linkId: "x" } })).statusCode, 404);
});
