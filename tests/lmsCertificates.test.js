/* L7.5a - completion certificates (D-091): rule, codes, issue (explicit, idempotent, atomic), revoke, learner view, PUBLIC verification (minimal data, uniform answers), schema 032, route gates.
   Mocked pool only: SQL (OPENJSON insert, filtered unique index, UPDLOCK/HOLDLOCK) NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsCertificates.test.js");
const C = require("../utils/lmsCertificates"), P = require("../utils/lmsPermissions"), events = require("../utils/lmsEvents");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" };
const CATS = [{ id: 1, weight: 100, drop_lowest: 0 }];
const ITEMS = [{ id: 1, category_id: 1, max_points: 50, weight: 1 }, { id: 2, category_id: 1, max_points: 100, weight: 1 }];
const LEARNERS = [30, 31, 32, 33, 34];
// 30: 3/3 lessons, T1 40 + T2 50 -> 65 (eligible). 31: 2/3 lessons, 100 (lessons incomplete). 32: 3/3, no grades (no grades). 33: 3/3, T1 10 visible + T2 100 HIDDEN -> learner view 20 (below 40; a staff view would pass). 34: eligible but already certified.
const DONE = [{ student_id: 30, n: 3 }, { student_id: 31, n: 2 }, { student_id: 32, n: 3 }, { student_id: 33, n: 3 }, { student_id: 34, n: 3 }];
const GR = [{ item_id: 1, student_id: 30, points: 40, excused: 0, hidden: 0 }, { item_id: 2, student_id: 30, points: 50, excused: 0, hidden: 0 },
  { item_id: 1, student_id: 31, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 31, points: 100, excused: 0, hidden: 0 },
  { item_id: 1, student_id: 33, points: 10, excused: 0, hidden: 0 }, { item_id: 2, student_id: 33, points: 100, excused: 0, hidden: 1 },
  { item_id: 1, student_id: 34, points: 50, excused: 0, hidden: 0 }, { item_id: 2, student_id: 34, points: 100, excused: 0, hidden: 0 }];
const world = (o = {}, extra = []) => makeMockPool([
  ["SELECT TOP 1 id, title, status FROM lms_courses", (i) => (i.c === 5 && o.course !== null ? [o.course || { id: 5, title: "Maths F3", status: "published" }] : [])],
  ["FROM lms_grade_categories", (i) => (i.c === 5 ? CATS : [])], ["FROM lms_grade_items WHERE course_id = @c", (i) => (i.c === 5 ? ITEMS : [])],
  ["FROM lms_course_enrolments WHERE course_id = @c", (i) => (i.c === 5 ? (o.ids || LEARNERS).map((s) => ({ student_id: s })) : [])],
  ["SELECT COUNT(*) AS n FROM lms_lessons", () => [{ n: o.lessons ?? 3 }]],
  ["FROM lms_lesson_progress p", () => DONE], ["FROM lms_grades g JOIN lms_grade_items i", (i) => (i.c === 5 ? GR : [])],
  ["FROM GradingSystem", () => o.gs || []],
  ["FROM lms_certificates WHERE course_id = @c AND revoked_at IS NULL", () => (o.have || [{ student_id: 34 }])],
  ["INSERT INTO lms_certificates (course_id", (i) => { (o.seen = o.seen || []).push(i.rows); if (o.dup && (o.n = (o.n || 0) + 1) <= o.dup) { const e = new Error("dup"); e.number = 2601; throw e; } return [{ inserted: o.inserted ?? 1 }]; }, ...[]],
  ...extra]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const writeOf = (m) => m.log.find((x) => /INSERT INTO lms_certificates \(course_id/.test(x.sql));

test("pure: codes (format, alphabet, no look-alikes, bias-free, unique), normalise, the completion rule, holder name", () => {
  const seen = new Set(); for (let i = 0; i < 300; i += 1) { const c = C.newCode(); assert.ok(C.CODE_RE.test(c), c); assert.ok(!/[01OIL]/.test(c)); seen.add(c); } assert.strictEqual(seen.size, 300);
  let calls = 0; const rand = (n) => { calls += 1; return Buffer.from(Array.from({ length: n }, (_, k) => (calls === 1 ? 250 + (k % 6) : k))); }; // first draw: every byte >= 248 is skipped
  assert.strictEqual(C.newCode(rand), "ABCD-EFGH-JKMN"); assert.strictEqual(calls, 2, "bytes >= 248 rejected (no modulo bias)");
  assert.deepStrictEqual(["abcd efgh-jkmn", "ABCDEFGHJKMN", " abcd-efgh-jkmn "].map(C.normaliseCode), ["ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN", "ABCD-EFGH-JKMN"]);
  for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKM0", "ABCD-EFGH-JKMNP", null, 5, "x".repeat(50), "ABCD-EFGH-JKM1", "ABCD-EFGH-JKMI"]) assert.strictEqual(C.normaliseCode(bad), null, String(bad));
  const ev = (o) => C.evaluate({ lessonsTotal: 3, lessonsDone: 3, percent: 60, passMark: 50, ...o });
  assert.deepStrictEqual([ev({}).eligible, ev({ percent: 50 }).eligible, ev({ percent: 49.99 }).reasons, ev({ lessonsDone: 2 }).reasons, ev({ percent: null }).reasons, ev({ lessonsTotal: 0, lessonsDone: 0 }).eligible, ev({ passMark: undefined, percent: 49 }).reasons, ev({ lessonsDone: 2, percent: null }).reasons],
    [true, true, ["BELOW_PASS_MARK"], ["LESSONS_INCOMPLETE"], ["NO_GRADES"], true, ["BELOW_PASS_MARK"], ["LESSONS_INCOMPLETE", "NO_GRADES"]]);
  assert.deepStrictEqual([C.holderName("Amina Wanjiru Kamau"), C.holderName("Amina"), C.holderName("  "), C.holderName(null), C.holderName("<b>Ali</b> ode")], ["Amina K.", "Amina", null, null, "bAli/b O."]);
});

test("dry run: hand-calculated eligibility (pass mark 40 default), reasons counted, already-issued excluded, nothing written or audited", async () => {
  const m = world(); const r = await C.issueCertificates(m.pool, teacher, 5, { dryRun: true }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.dryRun, r.wouldIssue, r.learners, r.eligible, r.alreadyIssued, r.passMark], [true, 1, 5, 2, 1, 40]);
  assert.deepStrictEqual(r.notEligible, { LESSONS_INCOMPLETE: 1, NO_GRADES: 1, BELOW_PASS_MARK: 1 });
  assert.ok(!writeOf(m) && audits(m).length === 0);
  const hi = await C.issueCertificates(world({ gs: [{ systemName: "S", passMark: 70, gradeBandsJson: "[]", overallBandsJson: "[]" }] }).pool, teacher, 5, { dryRun: true }); assert.deepStrictEqual([hi.passMark, hi.eligible], [70, 1], "a configured pass mark is used (65 < 70)");
  const none = await C.issueCertificates(world({ lessons: 0 }).pool, teacher, 5, { dryRun: true }); assert.strictEqual(none.notEligible.LESSONS_INCOMPLETE, undefined, "no visible lessons = lessons part passes");
});

test("issue: ONE atomic batch for the eligible learners without an active certificate; codes valid + unique; percent and grade frozen; audited; event; counts reported", async () => {
  const m = world(); const got = []; const off = events.on("lms.certificate.issued", (p) => got.push(p));
  const r = await C.issueCertificates(m.pool, teacher, 5, {}, { tenant: "tCert" }); assert.ok(r.ok, JSON.stringify(r)); await tick();
  assert.deepStrictEqual([r.issued, r.eligible, r.alreadyIssued], [1, 2, 1]);
  const w = writeOf(m); const rows = JSON.parse(w.inputs.rows); assert.deepStrictEqual(rows.map((x) => [x.s, x.p, x.gl]), [[30, 65, "Credit"]]); assert.ok(C.CODE_RE.test(rows[0].cd));
  assert.deepStrictEqual([w.inputs.c, w.inputs.src, w.inputs.uid], [5, "Teachers", 7]);
  assert.ok(/UPDLOCK, HOLDLOCK/.test(w.sql) && /NOT EXISTS \(SELECT 1 FROM lms_certificates x/.test(w.sql) && /revoked_at IS NULL/.test(w.sql) && !/DELETE FROM/.test(w.sql) && /XACT_ABORT ON; BEGIN TRAN/.test(w.sql));
  assert.strictEqual(audits(m).length, 1); assert.ok(/certificate\.issued/.test(JSON.stringify(audits(m)[0].inputs)));
  const mine = got.filter((p) => p.tenant === "tCert"); assert.deepStrictEqual([mine.length, mine[0].courseId, mine[0].count], [1, 5, 1]); assert.ok(!/code|name|percent/i.test(Object.keys(mine[0]).join(",")), "ids and counts only"); off();
  const again = world({ have: [{ student_id: 34 }, { student_id: 30 }] }); const r2 = await C.issueCertificates(again.pool, teacher, 5, {}); assert.deepStrictEqual([r2.issued, r2.alreadyIssued], [0, 2]); assert.ok(!writeOf(again), "nothing to issue = no write");
  const raced = await C.issueCertificates(world({ inserted: 0 }).pool, teacher, 5, {}); assert.strictEqual(raced.issued, 0, "a concurrent issue wins: the batch reports what it really inserted");
  const dopts = { dup: 1 }; const dup = world(dopts); const d = await C.issueCertificates(dup.pool, teacher, 5, {}); assert.strictEqual(d.issued, 1);
  assert.strictEqual(dopts.seen.length, 2, "one collision = one retry"); assert.notStrictEqual(JSON.parse(dopts.seen[0])[0].cd, JSON.parse(dopts.seen[1])[0].cd, "a code collision draws a NEW code");
  const dopts3 = { dup: 9 }; let threw = false; try { await C.issueCertificates(world(dopts3).pool, teacher, 5, {}); } catch (e) { threw = true; } assert.ok(threw && dopts3.seen.length === 3, "gives up after 3 attempts, error surfaces (no silent loss)");
});

test("issue refusals: draft/archived rule, too many learners, bad body, students and other courses; nothing written", async () => {
  const d = world({ course: { id: 5, title: "x", status: "draft" } }); assert.strictEqual((await C.issueCertificates(d.pool, teacher, 5, {})).code, "COURSE_NOT_PUBLISHED"); assert.ok(!writeOf(d));
  assert.ok((await C.issueCertificates(world({ course: { id: 5, title: "x", status: "archived" } }).pool, teacher, 5, { dryRun: true })).ok, "archived courses can be certified");
  assert.strictEqual((await C.issueCertificates(world({ ids: Array.from({ length: 2001 }, (_, i) => i + 1) }).pool, teacher, 5, {})).code, "TOO_MANY_LEARNERS");
  for (const b of [[], "x", { dryRun: "yes" }]) { const m = world(); assert.strictEqual((await C.issueCertificates(m.pool, teacher, 5, b)).ok, false); assert.strictEqual(m.log.length, 0); }
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const m = world(); assert.strictEqual((await C.issueCertificates(m.pool, u, id, {})).notFound, true); assert.ok(!writeOf(m)); }
  const T = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await C.issueCertificates(T.A.pool, teacher, 5, {})).notFound, true); T.assertUntouched("B");
  const g = world(); await C.issueCertificates(g.pool, teacher, 5, { dryRun: true });
  assert.ok(/i\.released = 1/.test(g.log.find((x) => /FROM lms_grades g/.test(x.sql)).sql) && /g\.course_id = @c/.test(g.log.find((x) => /FROM lms_grades g/.test(x.sql)).sql), "learner-view grades of THIS course only");
  assert.ok(/released = 1/.test(g.log.find((x) => /FROM lms_grade_items WHERE/.test(x.sql)).sql), "unreleased items are never read");
  assert.ok(/status = 'completed'/.test(g.log.find((x) => /FROM lms_lesson_progress p/.test(x.sql)).sql) && /p\.course_id = @c/.test(g.log.find((x) => /FROM lms_lesson_progress p/.test(x.sql)).sql));
});

test("revoke: reason required, scoped to the course, keeps the row (UPDATE only), audited with the reason; already revoked / other course are distinct and safe", async () => {
  const ok = makeMockPool([["UPDATE lms_certificates SET revoked_at", (i) => (i.c === 5 && i.i === 9 ? [{ id: 9 }] : [])]]);
  const r = await C.revokeCertificate(ok.pool, teacher, 5, 9, { reason: "  Issued in error <b> " }); assert.deepStrictEqual([r.ok, r.revoked], [true, true]);
  const u = ok.log.find((x) => /UPDATE lms_certificates/.test(x.sql)); assert.ok(/course_id = @c AND revoked_at IS NULL/.test(u.sql) && !/DELETE FROM/.test(u.sql)); assert.strictEqual(u.inputs.why, "Issued in error b");
  assert.ok(/certificate\.revoked/.test(JSON.stringify(audits(ok)[0].inputs)));
  for (const b of [{}, { reason: "" }, { reason: "x".repeat(301) }, { reason: "a", extra: 1 }, null, []]) { const m = makeMockPool([]); assert.strictEqual((await C.revokeCertificate(m.pool, teacher, 5, 9, b)).ok, false); assert.strictEqual(m.log.length, 0); }
  const done = makeMockPool([["UPDATE lms_certificates SET revoked_at", () => []], ["SELECT TOP 1 id FROM lms_certificates", () => [{ id: 9 }]]]); assert.strictEqual((await C.revokeCertificate(done.pool, teacher, 5, 9, { reason: "r" })).code, "ALREADY_REVOKED");
  const other = makeMockPool([["UPDATE lms_certificates SET revoked_at", () => []], ["SELECT TOP 1 id FROM lms_certificates", () => []]]); assert.strictEqual((await C.revokeCertificate(other.pool, teacher, 6, 9, { reason: "r" })).notFound, true);
  for (const [u2, c2, i2] of [[student, 5, 9], [null, 5, 9], [teacher, "x", 9], [teacher, 5, 0]]) assert.strictEqual((await C.revokeCertificate(makeMockPool([]).pool, u2, c2, i2, { reason: "r" })).notFound, true);
});

test("list + my certificate: paged and scoped; the learner sees ONLY their own active certificate (id from the token) with no staff fields", async () => {
  const row = { id: 9, student_id: 30, student_name: "Amina K", admission_no: "A1", code: "ABCD-EFGH-JKMN", final_percent: 65, grade_label: "Credit", issued_at: "2026-11-01T10:00:00Z", revoked_at: null, revoked_reason: null };
  const m = makeMockPool([["SELECT COUNT(*) AS n FROM lms_certificates WHERE course_id = @c", () => [{ n: 41 }]], ["FROM lms_certificates k LEFT JOIN Students", () => [row]]]);
  const l = await C.listCertificates(m.pool, 5, { page: "2", pageSize: "500" }); assert.deepStrictEqual([l.page, l.pageSize, l.total, l.hasMore, l.items[0].code, l.items[0].revoked], [2, 100, 41, false, "ABCD-EFGH-JKMN", false]);
  const q = m.log.find((x) => /LEFT JOIN Students/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.off, q.inputs.size], [5, 100, 100]); assert.ok(/k\.course_id = @c/.test(q.sql));
  const me = makeMockPool([["FROM lms_certificates k JOIN lms_courses c", (i) => (i.c === 5 && i.s === 30 ? [{ code: "ABCD-EFGH-JKMN", final_percent: 65, grade_label: "Credit", issued_at: "2026-11-01T10:00:00Z", title: "Maths F3" }] : [])]]);
  const r = await C.myCertificate(me.pool, student, 5); assert.deepStrictEqual([r.certificate.code, r.certificate.courseTitle, r.certificate.percent], ["ABCD-EFGH-JKMN", "Maths F3", 65]);
  assert.ok(/revoked_at IS NULL/.test(me.log[0].sql) && me.log[0].inputs.s === 30 && !/student_id|issued_by|admission/i.test(JSON.stringify(r)));
  assert.strictEqual((await C.myCertificate(me.pool, student, 6)).certificate, null);
  for (const u of [teacher, null, { id: 30, role: "teacher", source: "Students" }]) assert.strictEqual((await C.myCertificate(me.pool, u, 5)).notFound, true);
});

test("PUBLIC verification: valid = course title + issue date + first name and last initial ONLY; revoked, unknown, malformed and broken lookups all answer the same", async () => {
  const hit = { issued_at: "2026-11-01T10:00:00Z", revoked_at: null, title: "Maths F3", student_name: "Amina Wanjiru Kamau", admission_no: "A1", final_percent: 65, student_id: 30 };
  const m = makeMockPool([["FROM lms_certificates k JOIN lms_courses c ON c.id = k.course_id", (i) => (i.k === "ABCD-EFGH-JKMN" ? [hit] : [])]]);
  const v = await C.verifyCertificate(m.pool, "abcd efgh-jkmn"); assert.deepStrictEqual(v, { ok: true, valid: true, courseTitle: "Maths F3", issuedAt: "2026-11-01T10:00:00.000Z", holder: "Amina K." });
  assert.ok(!/A1|65|Wanjiru|30|admission|percent/i.test(JSON.stringify(v)), "no admission number, marks, middle name or id"); assert.strictEqual(m.log[0].inputs.k, "ABCD-EFGH-JKMN", "normalised, parameterised");
  const revoked = makeMockPool([["FROM lms_certificates k", () => [{ ...hit, revoked_at: "2026-11-02T00:00:00Z" }]]]); const rv = await C.verifyCertificate(revoked.pool, "ABCD-EFGH-JKMN");
  const unknown = await C.verifyCertificate(makeMockPool([]).pool, "ZZZZ-ZZZZ-ZZZZ"); const bad = makeMockPool([]); const mal = await C.verifyCertificate(bad.pool, "nope");
  assert.deepStrictEqual([rv, unknown, mal], [{ ok: true, valid: false }, { ok: true, valid: false }, { ok: true, valid: false }]); assert.strictEqual(bad.log.length, 0, "malformed = no query");
  assert.ok(/c\.deleted_at IS NULL/.test(m.log[0].sql), "a deleted course never verifies");
});

test("public route: uniform {valid:false} for bad school / no licence / errors, rate limited, no-store + no-referrer headers, tenant database only", async () => {
  const R = require("../routes/lmsVerify"); R._resetAll();
  const hit = async ({ known = true, licensed = true, pool, code = "ABCD-EFGH-JKMN", ip = "1.1.1.1", tenant = "school1" } = {}) => {
    R._deps.hasTenant = () => known; R._deps.getPool = async () => pool; R._deps.isLicensed = async () => licensed;
    const layer = R.stack.find((l) => l.route && l.route.methods.get); const res = makeRes(); res.out = {}; res.set = (k, v) => { Object.assign(res.out, typeof k === "object" ? k : { [k]: v }); return res; };
    await layer.route.stack[0].handle({ params: { tenant, code }, headers: {}, ip }, res); return res;
  };
  const row = { issued_at: "2026-11-01T10:00:00Z", revoked_at: null, title: "Maths F3", student_name: "Amina Kamau" }; const okPool = () => makeMockPool([["FROM lms_certificates k", () => [row]]]).pool;
  const g = await hit({ pool: okPool() }); assert.deepStrictEqual([g.statusCode, g.body.valid, g.body.holder, g.out["Cache-Control"], g.out["Referrer-Policy"]], [200, true, "Amina K.", "no-store", "no-referrer"]);
  const same = JSON.stringify({ success: true, valid: false });
  for (const o of [{ known: false, pool: okPool() }, { licensed: false, pool: okPool() }, { tenant: "bad/../x", pool: okPool() }, { code: "nope", pool: okPool() }, { pool: { request() { throw new Error("db down"); } } }]) { const r = await hit(o); assert.deepStrictEqual([r.statusCode, JSON.stringify(r.body)], [200, same]); }
  const idle = makeMockPool([]); await hit({ known: false, pool: idle.pool }); await hit({ licensed: false, pool: idle.pool }); assert.strictEqual(idle.log.length, 0, "no query without a known school and a licence");
  R._resetAll(); let last; for (let i = 0; i < 31; i += 1) last = await hit({ pool: okPool(), ip: "9.9.9.9" }); assert.strictEqual(last.statusCode, 429); assert.strictEqual((await hit({ pool: okPool(), ip: "8.8.8.8" })).statusCode, 200, "another client is not limited"); R._resetAll();
  const src = fs.readFileSync(path.join(__dirname, "../routes/lmsVerify.js"), "utf8"); assert.ok(/"lms", "lms_gradebook"/.test(src));
  assert.ok(/app\.use\("\/api\/lms-verify", require\("\.\/routes\/lmsVerify"\)\)/.test(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")));
});

test("schema step 032: additive, one table, unique code, ONE ACTIVE certificate per learner per course (filtered), blocked from the generic record editor, new event registered", () => {
  const schema = require("../utils/lmsSchema"); const i = schema.STEPS.findIndex((x) => x.id === "032_lms_certificates"); assert.ok(i === schema.STEPS.length - 14 && i >= 1 && schema.STEPS[i + 1].id === "033_lms_badges" && schema.STEPS[i + 2].id === "034_lms_discussions" && schema.STEPS[i + 3].id === "035_lms_groups" && schema.STEPS[i + 4].id === "036_lms_group_forums" && schema.STEPS[i + 5].id === "037_lms_peer_review", "032 is followed only by badges 033, discussions 034 and groups 035");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/IF NOT EXISTS \(SELECT \* FROM sysobjects WHERE name='lms_certificates'/.test(t) && !/DROP |DELETE |ALTER TABLE [a-z_]+ DROP/i.test(t));
  assert.ok(/UX_lms_certificates_code ON lms_certificates \(code\)/.test(t) && /UX_lms_certificates_active ON lms_certificates \(course_id, student_id\) WHERE revoked_at IS NULL/.test(t));
  assert.ok(/RECORD_TABLE_BLOCKLIST = new Set\([^)]*"lms_certificates"/.test(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")));
  assert.ok(events.on("lms.certificate.issued", () => {}) instanceof Function);
});

test("routes: each = flag gate + right permission + course access + handler; students hold neither staff permission; learner route is studentOnly; no-store; the 409 shape", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const GB = "/courses/:courseId/gradebook";
  const rs = [["get", `${GB}/certificates`], ["post", `${GB}/certificates/issue`], ["post", `${GB}/certificates/:certId/revoke`], ["get", "/courses/:courseId/learn/certificate"]].map(([m, p]) => find(m, p));
  assert.ok(rs.every(Boolean)); for (const r of rs) assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/certificates`, gbGate, gbView, staffAccess/.test(src) && /certificates\/issue`, gbGate, publishPerm, staffAccess/.test(src) && /:certId\/revoke`, gbGate, publishPerm, staffAccess/.test(src) && /learn\/certificate", gbGate, studentOnly, studentAccess/.test(src));
  assert.ok(!P.roleDefaults({ role: "student" }).some((c) => c === "lms.gradebook.view" || c === "lms.gradebook.publish") && !P.roleDefaults({ role: "teacher" }).includes("lms.gradebook.publish"));
  const res = makeRes(); let hdr = null; res.setHeader = (k, v) => { hdr = [k, v]; };
  await rs[1].route.stack[3].handle({ pool: world().pool, user: teacher, params: { courseId: "5" }, body: { dryRun: true }, tenant: "t" }, res);
  assert.deepStrictEqual([res.statusCode, res.body.success, res.body.wouldIssue, "ok" in res.body, hdr], [200, true, 1, false, ["Cache-Control", "no-store"]]);
  const r2 = makeRes(); r2.setHeader = () => {}; await rs[1].route.stack[3].handle({ pool: world({ course: { id: 5, title: "x", status: "draft" } }).pool, user: teacher, params: { courseId: "5" }, body: {}, tenant: "t" }, r2); assert.deepStrictEqual([r2.statusCode, r2.body.code], [409, "COURSE_NOT_PUBLISHED"]);
  const r3 = makeRes(); r3.setHeader = () => {}; await rs[2].route.stack[3].handle({ pool: makeMockPool([]).pool, user: teacher, params: { courseId: "5", certId: "abc" }, body: { reason: "r" }, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
});
