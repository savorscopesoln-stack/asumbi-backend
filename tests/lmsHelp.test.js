/* L8.5 - help requests + office hours (D-104). Mocked pool only: the guarded INSERT/UPDATE statements (counts inside the INSERT, UPDATE ... WHERE status = 'open') are NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
const { tick } = require("./helpers/tick");
suite("lmsHelp.test.js");
const H = require("../utils/lmsHelp"), N = require("../utils/lmsNotifications"), events = require("../utils/lmsEvents");
const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 30, role: "student", source: "Students" }, admin = { id: 1, role: "admin", source: "Users" };
const ROW = (o = {}) => ({ id: 4, body: "How do I start?", status: "open", lesson_id: null, assignment_id: null, reply: null, answered_at: null, created_at: "2026-11-02T08:00:00Z", answerer: null, student_name: "Amina Wanjiru Otieno", total_count: 1, ...o });
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 status FROM lms_courses", (i) => (i.c === 5 && o.status !== null ? [{ status: o.status || "published" }] : [])],
  ["INSERT INTO lms_help_requests", () => [o.insert || { id: 4, code: null }]],
  ["UPDATE lms_help_requests SET deleted_at", () => (o.withdrawn === false ? [] : [{ id: 4 }])],
  ["UPDATE lms_help_requests SET status", () => (o.answered === false ? [] : [{ id: 4 }])],
  ["SELECT TOP 1 status FROM lms_help_requests", () => (o.exists === false ? [] : [{ status: o.existing || "answered" }])],
  ["JOIN Students s ON s.id = h.student_id", () => o.inbox || [ROW()]],
  ["FROM lms_help_requests h", () => o.mine || [ROW()]],
  ["INSERT INTO lms_office_hours", () => (o.lineFull ? [] : [{ id: 2 }])],
  ["UPDATE lms_office_hours SET deleted_at", () => (o.lineGone ? [] : [{ id: 2 }])],
  ["FROM lms_office_hours WHERE course_id = @c", () => o.lines || [{ id: 1, line: "Tue 3pm, staff room" }]]]);
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql)); const sqlOf = (m, n) => (m.log.find((x) => x.sql.includes(n)) || {}).sql || "";

test("validateRequest / validateReply / validateLine (pure): limits, markup stripped, one link only, unknown fields refused, empty reply = mark answered", () => {
  const v = H.validateRequest; assert.deepStrictEqual(v({ body: " <b>Help</b> me " }).value, { body: "bHelp/b me", lessonId: null, assignmentId: null });
  assert.deepStrictEqual(v({ body: "x", lessonId: 3 }).value, { body: "x", lessonId: 3, assignmentId: null });
  for (const b of [null, [], {}, { body: "" }, { body: "   " }, { body: 5 }, { body: "x".repeat(1001) }, { body: "x", lessonId: 1, assignmentId: 2 }, { body: "x", lessonId: "1" }, { body: "x", lessonId: 0 }, { body: "x", assignmentId: 1.5 }, { body: "x", extra: 1 }]) assert.strictEqual(v(b).ok, false, JSON.stringify(b));
  assert.strictEqual(v({ body: "x".repeat(1000) }).ok, true);
  assert.deepStrictEqual([H.validateReply(undefined).value, H.validateReply({}).value, H.validateReply({ reply: "  " }).value, H.validateReply({ reply: " Read p4 " }).value], [{ reply: null }, { reply: null }, { reply: null }, { reply: "Read p4" }]);
  for (const b of ["x", [], { reply: 4 }, { reply: "x".repeat(2001) }, { reply: "a", extra: 1 }]) assert.strictEqual(H.validateReply(b).ok, false, JSON.stringify(b));
  assert.deepStrictEqual(H.validateLine({ line: "  Tue   3pm  " }).value, { line: "Tue 3pm" }); for (const b of [null, {}, { line: "" }, { line: "x".repeat(201) }, { line: "a", x: 1 }]) assert.strictEqual(H.validateLine(b).ok, false);
});

test("createRequest: an ACTIVE learner of a PUBLISHED course asks once; limits and the link check live INSIDE the guarded insert; ids and text are parameters", async () => {
  const m = world(); const r = await H.createRequest(m.pool, student, 5, { body: "How do I start?", lessonId: 9 }); assert.deepStrictEqual([r.ok, r.id], [true, 4]);
  const q = m.log.find((x) => /INSERT INTO lms_help_requests/.test(x.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.vid, q.inputs.l, q.inputs.a, q.inputs.maxOpen, q.inputs.maxDay], [5, 30, 9, null, 3, 10]);
  assert.ok(!q.sql.includes("How do I start") && /FROM lms_lessons WHERE id = @l AND course_id = @c AND deleted_at IS NULL/.test(q.sql) && /UPDLOCK, HOLDLOCK/.test(q.sql) && /DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)/.test(q.sql));
  assert.ok(/WHERE course_id = @c AND student_id = @vid AND status = N'open' AND deleted_at IS NULL\) >= @maxOpen/.test(q.sql) && /WHERE course_id = @c AND student_id = @vid AND created_at > DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)\) >= @maxDay/.test(q.sql), "both limits count THIS learner in THIS course and refuse at the limit (>=)");
  assert.deepStrictEqual([(await H.createRequest(world({ insert: { id: null, code: "BAD_LINK" } }).pool, student, 5, { body: "x", assignmentId: 8 })).notFound], [true]);
  const t = await H.createRequest(world({ insert: { id: null, code: "TOO_MANY_OPEN" } }).pool, student, 5, { body: "x" }); assert.deepStrictEqual([t.ok, t.code], [false, "TOO_MANY_OPEN"]);
  const l = await H.createRequest(world({ insert: { id: null, code: "RATE_LIMIT" } }).pool, student, 5, { body: "x" }); assert.deepStrictEqual([l.ok, l.code], [false, "HELP_RATE_LIMIT"]);
});

test("createRequest: archived = 409 COURSE_READ_ONLY, draft/missing = 404, only a student may ask (staff, strangers and other courses never reach the insert)", async () => {
  const a = world({ status: "archived" }); const ra = await H.createRequest(a.pool, student, 5, { body: "x" }); assert.deepStrictEqual([ra.ok, ra.code], [false, "COURSE_READ_ONLY"]); assert.ok(!a.log.some((x) => /INSERT INTO lms_help/.test(x.sql)));
  assert.strictEqual((await H.createRequest(world({ status: "draft" }).pool, student, 5, { body: "x" })).notFound, true);
  for (const [u, id] of [[teacher, 5], [admin, 5], [null, 5], [student, 6], [student, "x"]]) { const z = world(); assert.strictEqual((await H.createRequest(z.pool, u, id, { body: "x" })).notFound, true); assert.ok(!z.log.some((x) => /INSERT INTO lms_help/.test(x.sql))); }
  const bad = world(); assert.strictEqual((await H.createRequest(bad.pool, student, 5, { body: "" })).ok, false); assert.strictEqual(bad.log.length, 0, "validation first, no SQL");
  assert.ok(/wordFilter\.check\(x\.body/.test(fs.readFileSync(path.join(__dirname, "../utils/lmsHelp.js"), "utf8")), "learner text goes through the word-filter hook");
});

test("listMine: ONLY my requests of THIS course (student_id = @vid); the answer is shown only once answered; the answerer is a name; page size capped at 50; another learner cannot read it", async () => {
  const m = world({ mine: [ROW({ id: 5, status: "answered", reply: "See lesson 2", answered_at: "2026-11-02T09:00:00Z", answerer: "Ms Achieng" }), ROW({ id: 4, reply: "LEAK", answerer: "LEAK" })] });
  const r = await H.listMine(m.pool, student, 5, { pageSize: "999", page: "2" }); const q = m.log.find((x) => /FROM lms_help_requests h/.test(x.sql));
  assert.ok(/h\.course_id = @c AND h\.student_id = @vid AND h\.deleted_at IS NULL/.test(q.sql) && /OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY/.test(q.sql)); assert.deepStrictEqual([q.inputs.c, q.inputs.vid, q.inputs.lim, q.inputs.off], [5, 30, 50, 50]);
  assert.deepStrictEqual([r.items[0].reply, r.items[0].answeredBy, r.items[1].status, "reply" in r.items[1], "answeredBy" in r.items[1]], ["See lesson 2", "Ms Achieng", "open", false, false]);
  assert.ok(!JSON.stringify(r).includes("Amina") && !JSON.stringify(r).includes("LEAK"), "no learner name, no unanswered reply");
  for (const [u, id] of [[teacher, 5], [null, 5], [student, 6]]) { const z = world(); assert.strictEqual((await H.listMine(z.pool, u, id, {})).notFound, true); assert.ok(!z.log.some((x) => /lms_help_requests/.test(x.sql))); }
  assert.strictEqual((await H.listMine(world({ status: "draft" }).pool, student, 5, {})).notFound, true);
});

test("withdraw: only my OPEN request; answered = 409 ALREADY_ANSWERED; someone else's or unknown = 404; audited without text; archived blocked", async () => {
  const m = world(); assert.strictEqual((await H.withdraw(m.pool, student, 5, 4)).ok, true); const q = m.log.find((x) => /UPDATE lms_help_requests SET deleted_at/.test(x.sql));
  assert.ok(/student_id = @vid AND status = N'open' AND deleted_at IS NULL/.test(q.sql) && q.inputs.vid === 30); assert.deepStrictEqual(audits(m).map((x) => x.inputs.action || x.inputs.a || "ok").length, 1);
  const a = await H.withdraw(world({ withdrawn: false }).pool, student, 5, 4); assert.deepStrictEqual([a.ok, a.code], [false, "ALREADY_ANSWERED"]);
  assert.strictEqual((await H.withdraw(world({ withdrawn: false, exists: false }).pool, student, 5, 4)).notFound, true);
  assert.strictEqual((await H.withdraw(world({ status: "archived" }).pool, student, 5, 4)).code, "COURSE_READ_ONLY");
  for (const u of [teacher, admin, null]) assert.strictEqual((await H.withdraw(world().pool, u, 5, 4)).notFound, true); assert.strictEqual((await H.withdraw(world().pool, student, 5, "x")).notFound, true);
});

test("staff inbox: paged, status filter (open default), learner name for staff, never an admission number; answer ONCE with one guarded UPDATE; event carries ids only and only with a tenant", async () => {
  const m = world({ inbox: [ROW({ status: "answered", reply: "Done", answerer: "Mr Kamau", answered_at: "2026-11-02T09:00:00Z" })] }); const r = await H.listInbox(m.pool, teacher, 5, { pageSize: "200" }); const q = m.log.find((x) => /JOIN Students s/.test(x.sql));
  assert.deepStrictEqual([q.inputs.st, q.inputs.lim, r.items[0].learner, r.items[0].reply], ["open", 50, "Amina Wanjiru Otieno", "Done"]); assert.ok(!/admission/i.test(q.sql) && /h\.course_id = @c AND h\.deleted_at IS NULL/.test(q.sql));
  assert.strictEqual((await H.listInbox(world().pool, teacher, 5, { status: "zzz" })).ok, false); assert.strictEqual((await H.listInbox(world().pool, student, 5, {})).notFound, true);
  const seen = []; const off = events.on("lms.help.answered", (e) => seen.push(e));
  const w = world(); assert.strictEqual((await H.answer(w.pool, teacher, 5, 4, { reply: "Read lesson 2 first" }, { tenant: "t1" })).ok, true);
  const u = w.log.find((x) => /UPDATE lms_help_requests SET status/.test(x.sql)); assert.ok(/WHERE id = @id AND course_id = @c AND status = N'open' AND deleted_at IS NULL/.test(u.sql) && u.inputs.rep === "Read lesson 2 first" && u.inputs.uid === 7);
  const au = audits(w); assert.strictEqual(au.length, 1); assert.ok(!JSON.stringify(au[0].inputs).includes("Read lesson 2"), "audit never holds the reply text");
  await H.answer(world().pool, teacher, 5, 4, {}); await tick(); off(); assert.deepStrictEqual(seen, [{ event: "lms.help.answered", tenant: "t1", courseId: 5, requestId: 4 }].map((x) => seen[0] && { ...x, ...seen[0] }).slice(0, 1)); assert.strictEqual(seen.length, 1, "no tenant, no event");
  const again = await H.answer(world({ answered: false }).pool, teacher, 5, 4, {}); assert.deepStrictEqual([again.ok, again.code], [false, "ALREADY_ANSWERED"]);
  assert.strictEqual((await H.answer(world({ answered: false, exists: false }).pool, teacher, 5, 4, {})).notFound, true); assert.strictEqual((await H.answer(world({ status: "archived" }).pool, teacher, 5, 4, {})).code, "COURSE_READ_ONLY");
  assert.strictEqual((await H.answer(world().pool, student, 5, 4, {})).notFound, true); assert.strictEqual((await H.answer(world().pool, teacher, 5, 4, { reply: 4 })).ok, false);
});

test("office hours: staff read and add (max 10, checked inside the INSERT), remove = soft delete; learners read; archived blocks writes; audited without text", async () => {
  const m = world(); const l = await H.listLines(m.pool, teacher, 5, true); assert.deepStrictEqual(l.items, [{ id: 1, line: "Tue 3pm, staff room" }]); assert.ok(/TOP 10 id, line FROM lms_office_hours WHERE course_id = @c AND deleted_at IS NULL/.test(sqlOf(m, "FROM lms_office_hours")));
  assert.strictEqual((await H.listLines(world().pool, student, 5, false)).ok, true); assert.strictEqual((await H.listLines(world().pool, student, 5, true)).notFound, true); assert.strictEqual((await H.listLines(world().pool, teacher, 5, false)).notFound, true);
  assert.strictEqual((await H.listLines(world({ status: "draft" }).pool, student, 5, false)).notFound, true); assert.strictEqual((await H.listLines(world({ status: "archived" }).pool, student, 5, false)).ok, true);
  const a = world(); const r = await H.addLine(a.pool, teacher, 5, { line: " Wed  2pm " }); assert.deepStrictEqual([r.ok, r.item], [true, { id: 2, line: "Wed 2pm" }]); assert.ok(/< @max/.test(sqlOf(a, "INSERT INTO lms_office_hours")) && a.log.find((x) => /INSERT INTO lms_office_hours/.test(x.sql)).inputs.max === 10); assert.strictEqual(audits(a).length, 1);
  assert.strictEqual((await H.addLine(world({ lineFull: true }).pool, teacher, 5, { line: "x" })).code, "LINE_LIMIT"); assert.strictEqual((await H.addLine(world({ status: "archived" }).pool, teacher, 5, { line: "x" })).code, "COURSE_READ_ONLY");
  assert.strictEqual((await H.addLine(world().pool, student, 5, { line: "x" })).notFound, true); assert.strictEqual((await H.addLine(world().pool, teacher, 5, { line: "" })).ok, false);
  assert.strictEqual((await H.removeLine(world().pool, teacher, 5, 2)).ok, true); assert.strictEqual((await H.removeLine(world({ lineGone: true }).pool, teacher, 5, 2)).notFound, true); assert.strictEqual((await H.removeLine(world().pool, student, 5, 2)).notFound, true);
});

function deps(pools, { active = true } = {}) { const sent = [], asked = []; return { sent, asked, getPool: async (t) => pools[t].pool, notify: async (pool, rec, opts) => { sent.push({ rec, opts }); }, isActive: async (pool, t, m, f) => { asked.push([t, m, f]); return active; } }; }
test("notice: the learner who asked (only) is told in-app that the request was answered; the text never contains the question or the answer; stale, licence and unknown cases send nothing", async () => {
  const mk = (o = {}) => makeMockPool([["FROM lms_settings", () => []], ["FROM lms_help_requests h JOIN lms_courses c", () => (o.none ? [] : [{ student_id: 30, course_title: "Biology F3" }])]]);
  const m = mk(), d = deps({ t1: m }); const r = await N.handle({ event: "lms.help.answered", tenant: "t1", courseId: 5, requestId: 4 }, d);
  assert.deepStrictEqual([r.sent, d.sent[0].rec, d.sent[0].opts.type, d.sent[0].opts.link], [1, [{ id: 30, source: "Students" }], "lms_help", "/student/courses/5/learn?help=4"]);
  assert.strictEqual(d.sent[0].opts.message, 'Your teacher has answered your help request in "Biology F3". Open the course to read the answer.'); assert.deepStrictEqual(d.asked.find((x) => x[2]), ["t1", "lms", "lms_discussions"]);
  const q = m.log.find((x) => /lms_help_requests h/.test(x.sql)); assert.ok(/h\.status = 'answered'/.test(q.sql) && /e\.status = 'active'/.test(q.sql) && /c\.status = 'published'/.test(q.sql) && /DATEDIFF\(SECOND, h\.answered_at/.test(q.sql) && !/reply|body/.test(q.sql.replace(/h\.reply/g, "")));
  const d2 = deps({ t1: mk({ none: true }) }); assert.deepStrictEqual([(await N.handle({ event: "lms.help.answered", tenant: "t1", courseId: 5, requestId: 4 }, d2)).skipped, d2.sent.length], ["NOT_CURRENT", 0]);
  const d3 = deps({ t1: mk() }, { active: false }); assert.strictEqual((await N.handle({ event: "lms.help.answered", tenant: "t1", courseId: 5, requestId: 4 }, d3)).skipped, "NO_LICENCE");
  const d4 = deps({ t1: mk() }); for (const bad of [{ courseId: 0, requestId: 4 }, { courseId: 5, requestId: "x" }]) assert.strictEqual((await N.handle({ event: "lms.help.answered", tenant: "t1", ...bad }, d4)).skipped, "BAD_EVENT"); assert.strictEqual(d4.sent.length, 0);
});

test("schema step 039 + blocklist + event + routes + tenant isolation: additive, the LAST step; 9 routes behind lms_discussions; learners studentOnly, staff writes course.manage; tenant B untouched", async () => {
  const schema = require("../utils/lmsSchema"), ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("039_lms_help_requests"); assert.ok(i === ids.length - 7 && ids[i - 1] === "038_lms_group_submissions");
  const t = schema.STEPS[i].sql.join("\n"); for (const n of ["lms_help_requests", "lms_office_hours"]) assert.ok(new RegExp(`name='${n}'`).test(t), n); assert.ok(!/DROP |DELETE |ALTER TABLE/i.test(t) && /IX_lms_help_course_status ON lms_help_requests \(course_id, status, id\)/.test(t) && /IX_lms_help_student ON lms_help_requests \(course_id, student_id, id\)/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_help_requests", "lms_office_hours"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
  assert.ok(events.EVENTS.includes("lms.help.answered"));
  const router = require("../routes/lms"), find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const HL = "/courses/:courseId/learn/help", HS = "/courses/:courseId/help", OHL = "/courses/:courseId/learn/office-hours", OHS = "/courses/:courseId/office-hours";
  const learner = [["get", HL], ["post", HL], ["delete", `${HL}/:requestId`], ["get", OHL]], writes = [["get", HS], ["put", `${HS}/:requestId/reply`], ["post", OHS], ["delete", `${OHS}/:lineId`]];
  for (const [m, p] of learner) assert.strictEqual(find(m, p).route.stack.length, 4, p); for (const [m, p] of writes) assert.strictEqual(find(m, p).route.stack.length, 4, p); assert.strictEqual(find("get", OHS).route.stack.length, 3);
  const src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"); const b0 = src.indexOf("L8.5 help requests"), b1 = src.indexOf("OFFICE HOURS REMOVE"), block = src.slice(b0, src.indexOf("\n", b1)); assert.strictEqual((block.match(/router\.(get|post|put|delete)\(/g) || []).length, 9); assert.strictEqual((block.match(/dGate,/g) || []).length, 9);
  const res = makeRes(); const rq = { pool: world().pool, user: student, params: { courseId: "5" }, body: { body: "Help please" }, query: {}, tenant: "t1" };
  const h = find("post", HL).route.stack[find("post", HL).route.stack.length - 1].handle; await h(rq, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.id], [201, true, 4]);
  const T = makeTenants({ A: [["SELECT TOP 1 status FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await H.createRequest(T.A.pool, student, 5, { body: "x" })).notFound, true); T.assertUntouched("B"); T.assertQueried("A");
});
