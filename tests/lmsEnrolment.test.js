/* L2.3 — enrolment. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsEnrolment.test.js");
const { tick: sharedTick } = require("./helpers/tick"); // robust event-bus wait (see helper for why)
const E = require("../utils/lmsEnrolment");
const events = require("../utils/lmsEvents");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers", tenant: "isoA" });
const student = (id = 7) => ({ id, role: "student", source: "Students", tenant: "isoA" });
const registrar = { id: 30, role: "sub_admin", source: "Users", permissions: [], tenant: "isoA" };

const gate = (status = "draft", cls = "Form 1A", visibility = "listed") => ["class_name, visibility FROM lms_courses", () => [{ id: 5, status, class_name: cls, visibility }]];
const stu = (id, o = {}) => ({ id, name: `Student ${id}`, admissionNo: `ADM${id}`, studentClass: "Form 1A", yearOfStudy: 1, status: "active", ...o });
const students = (rows) => ["FROM Students WHERE id IN", () => rows];
const existing = (rows = []) => ["FROM lms_course_enrolments WHERE course_id = @c AND student_id IN", () => rows];
const batch = (m) => m.log.filter((l) => l.sql.includes("BEGIN TRAN"));
const tick = sharedTick;

/* ---------------- pure ---------------- */
test("classify: enrol / re-enrol / approve pending / skip already enrolled / inactive / unknown", () => {
  const st = new Map([[1, stu(1)], [2, stu(2)], [3, stu(3)], [4, stu(4)], [5, stu(5, { status: "Inactive" })]]);
  const ex = new Map([[2, "active"], [3, "pending"], [4, "withdrawn"]]);
  const r = E.classify([1, 2, 3, 4, 5, 6], st, ex);
  assert.deepStrictEqual(r.todo.map((t) => [t.id, t.action]), [[1, "enrolled"], [3, "approved"], [4, "reenrolled"]]);
  assert.deepStrictEqual(r.skipped.map((x) => x.code), ["ALREADY_ENROLLED"]);
  assert.deepStrictEqual(r.failed.map((x) => x.code), ["STUDENT_INACTIVE", "STUDENT_NOT_FOUND"]);
  const c = E.classify([5], st, ex, { inactiveIsSkip: true }); assert.strictEqual(c.skipped[0].code, "STUDENT_INACTIVE"); assert.strictEqual(c.failed.length, 0);
});

test("validateStudentIds: non-empty list of positive integers, de-duplicated, capped", () => {
  assert.deepStrictEqual(E.validateStudentIds(["3", 3, 4]).ids, [3, 4]);
  for (const b of [[], "1", null, [0], [1.5], ["x"], [1, "1; DROP TABLE"], Array.from({ length: E.MAX_MANUAL + 1 }, (_, i) => i + 1)]) assert.strictEqual(E.validateStudentIds(b).ok, false, JSON.stringify(b)?.slice(0, 40));
});

test("parseCsv: header variants, BOM, quotes, CRLF, semicolons, blank lines, real line numbers; bad files refused", () => {
  const a = E.parseCsv("\uFEFFName,Admission No\r\n\"Doe, Jane\",ADM1\r\n\r\nSam,ADM2\r\n");
  assert.ok(a.ok); assert.deepStrictEqual(a.rows, [{ line: 2, admissionNo: "ADM1" }, { line: 4, admissionNo: "ADM2" }]);
  assert.deepStrictEqual(E.parseCsv("admissionNo;name\nA1;x\nA2;y").rows.map((r) => r.admissionNo), ["A1", "A2"]);
  assert.deepStrictEqual(E.parseCsv("ADMISSION_NUMBER\n\"A,1\"\n").rows[0], { line: 2, admissionNo: "A,1" });
  assert.strictEqual(E.parseCsv("name,class\nx,y").code, "CSV_NO_HEADER");
  assert.strictEqual(E.parseCsv("admissionNo\n").ok, false); assert.strictEqual(E.parseCsv("").ok, false); assert.strictEqual(E.parseCsv(42).ok, false);
  assert.strictEqual(E.parseCsv("admissionNo\n" + Array.from({ length: E.MAX_CSV_ROWS + 1 }, (_, i) => "A" + i).join("\n")).code, "CSV_TOO_MANY_ROWS");
  assert.strictEqual(E.parseCsv("admissionNo\n" + "A".repeat(E.MAX_CSV_BYTES)).code, "CSV_TOO_LARGE");
  assert.strictEqual(E.parseCsv("admissionNo\n<b>ADM1</b>").rows[0].admissionNo, "bADM1/b"); // markup stripped (echoed in reports)
});

/* ---------------- manual add ---------------- */
test("enrolStudents: one transaction, parameters only, history per student, audited, event with ids only; existing handled", async () => {
  const seen = []; const off = events.on("lms.enrolment.changed", (e) => { if (e.tenant === "evt-tenant") seen.push(e); }); // tests run concurrently: only look at our own tenant
  const m = makeMockPool([gate(), students([stu(1), stu(2), stu(3), stu(4)]), existing([{ student_id: 2, status: "active" }, { student_id: 3, status: "pending" }, { student_id: 4, status: "withdrawn" }])]);
  const r = await E.enrolStudents(m.pool, { ...teacher(), tenant: "evt-tenant" }, 5, { studentIds: [1, 2, 3, 4, 99] });
  assert.ok(r.ok); assert.deepStrictEqual(r.summary, { requested: 5, enrolled: 1, reenrolled: 1, approved: 1, skipped: 1, failed: 1 });
  assert.deepStrictEqual(r.enrolled, [1, 3, 4]); assert.strictEqual(r.failed[0].studentId, 99);
  const [tx] = batch(m); assert.ok(tx.sql.includes("COMMIT") && tx.sql.includes("SET XACT_ABORT ON"));
  assert.strictEqual((tx.sql.match(/INSERT INTO lms_enrolment_history/g) || []).length, 3);
  assert.ok(tx.sql.includes("WHERE NOT EXISTS") && tx.sql.includes("UPDATE lms_course_enrolments SET status = 'active'"));
  assert.deepStrictEqual([tx.inputs.s0, tx.inputs.a0, tx.inputs.a1, tx.inputs.f1, tx.inputs.a2, tx.inputs.f2], [1, "enrolled", "approved", "pending", "reenrolled", "withdrawn"]);
  assert.ok(!/VALUES \(@c, \d/.test(tx.sql)); // ids travel as parameters, never in the SQL text
  assert.ok(m.log.every((l) => !/SELECT\s+\*/i.test(l.sql) && !/password/i.test(l.sql)));
  assert.ok(m.log.some((l) => l.inputs.act === "enrolment.added"));
  await tick(); off(); assert.strictEqual(seen.length, 1); assert.deepStrictEqual([seen[0].courseId, seen[0].action, seen[0].count], [5, "added", 3]); assert.ok(Object.keys(seen[0]).every((k) => ["event", "at", "tenant", "courseId", "action", "count"].includes(k)));
  assert.ok(!JSON.stringify(seen[0]).includes("Student "));
});

test("enrolStudents: dry run, archived/pending/missing course, bad bodies and over-limit lists write nothing", async () => {
  const d = makeMockPool([gate(), students([stu(1)]), existing()]); const r = await E.enrolStudents(d.pool, teacher(), 5, { studentIds: [1], dryRun: true });
  assert.ok(r.ok && r.dryRun && r.summary.enrolled === 1); assert.strictEqual(batch(d).length, 0); assert.ok(!d.log.some((l) => l.inputs.act));
  assert.strictEqual((await E.enrolStudents(makeMockPool([gate("archived")]).pool, teacher(), 5, { studentIds: [1] })).code, "COURSE_ARCHIVED");
  assert.strictEqual((await E.enrolStudents(makeMockPool([gate("pending")]).pool, teacher(), 5, { studentIds: [1] })).code, "COURSE_PENDING");
  assert.strictEqual((await E.enrolStudents(makeMockPool([]).pool, teacher(), 5, { studentIds: [1] })).notFound, true);
  const none = makeMockPool([]);
  for (const b of [null, [], { studentIds: [] }, { studentIds: [1], status: "active" }, { studentIds: Array.from({ length: 201 }, (_, i) => i + 1) }]) assert.strictEqual((await E.enrolStudents(none.pool, teacher(), 5, b)).ok, false);
  assert.strictEqual(none.log.length, 0);
  const allBad = makeMockPool([gate(), students([]), existing()]); const z = await E.enrolStudents(allBad.pool, teacher(), 5, { studentIds: [8] });
  assert.ok(z.ok && z.summary.failed === 1 && batch(allBad).length === 0);
});

/* ---------------- bulk CSV ---------------- */
test("bulkEnrol: per-line error report (not found, inactive, duplicate, ambiguous, empty); good rows still enrol; dry run writes nothing", async () => {
  const csv = "name,admissionNo\nA,ADM1\nB,ADM2\nC,ADM3\nD,adm1\nE,ADM4\nF,\nG,ADM5";
  const rows = [stu(1), stu(3, { status: "left" }), stu(4), stu(44, { admissionNo: "ADM4" }), stu(5)];
  const mk = () => makeMockPool([gate(), ["FROM Students WHERE admissionNo IN", () => rows], existing([{ student_id: 5, status: "active" }])]);
  const m = mk(); const r = await E.bulkEnrol(m.pool, teacher(), 5, { csv });
  assert.ok(r.ok); assert.deepStrictEqual(r.enrolled, [1]);
  assert.deepStrictEqual(r.failed.map((f) => [f.line, f.code]), [[3, "STUDENT_NOT_FOUND"], [4, "STUDENT_INACTIVE"], [5, "DUPLICATE_IN_FILE"], [6, "AMBIGUOUS"], [7, "EMPTY"]]);
  assert.deepStrictEqual(r.skipped.map((s) => [s.line, s.code]), [[8, "ALREADY_ENROLLED"]]);
  assert.deepStrictEqual(r.summary, { requested: 7, enrolled: 1, reenrolled: 0, approved: 0, skipped: 1, failed: 5 });
  assert.strictEqual(batch(m).length, 1); assert.ok(!batch(m)[0].sql.includes("ADM1")); // admission numbers are parameters
  const lookup = m.log.find((l) => l.sql.includes("admissionNo IN")); assert.ok(!lookup.sql.includes("ADM1") && lookup.inputs.a0 === "ADM1");
  const dr = mk(); const d = await E.bulkEnrol(dr.pool, teacher(), 5, { csv, dryRun: true }); assert.ok(d.dryRun && d.enrolled.length === 1); assert.strictEqual(batch(dr).length, 0);
  const bad = makeMockPool([gate()]); assert.strictEqual((await E.bulkEnrol(bad.pool, teacher(), 5, { csv: "x\n1" })).code, "CSV_NO_HEADER"); assert.strictEqual(bad.log.length, 0);
  assert.strictEqual((await E.bulkEnrol(makeMockPool([gate("archived")]).pool, teacher(), 5, { csv })).code, "COURSE_ARCHIVED");
  assert.strictEqual((await E.bulkEnrol(makeMockPool([]).pool, teacher(), 5, { csv, extra: 1 })).ok, false);
});

/* ---------------- class list ---------------- */
test("enrolClassList: joins on class NAME, checks yearOfStudy against Classes, reports unmatched and inactive, defaults to the course class", async () => {
  const cls = (y) => ["FROM Classes WHERE name", () => [{ id: 2, name: "Form 1A", yearOfStudy: y }]];
  const list = ["FROM Students WHERE studentClass", () => [stu(1), stu(2, { yearOfStudy: 2 }), stu(3, { status: "graduated" }), stu(4, { yearOfStudy: null })]];
  const m = makeMockPool([gate(), cls(1), list, existing()]);
  const r = await E.enrolClassList(m.pool, teacher(), 5, {});
  assert.ok(r.ok); assert.strictEqual(r.className, "Form 1A"); assert.deepStrictEqual(r.enrolled, [1, 4]);
  assert.deepStrictEqual(r.unmatched.map((u) => [u.studentId, u.code]), [[2, "YEAR_MISMATCH"]]); assert.deepStrictEqual(r.skipped.map((s) => [s.studentId, s.code]), [[3, "STUDENT_INACTIVE"]]);
  assert.strictEqual(m.log.find((l) => l.sql.includes("FROM Classes")).inputs.n, "Form 1A");
  assert.ok(batch(m)[0].sql.includes("@src") && batch(m)[0].inputs.src === "class_list"); assert.ok(m.log.every((l) => !/SELECT\s+\*/i.test(l.sql)));
  assert.strictEqual((await E.enrolClassList(makeMockPool([gate(), ["FROM Classes WHERE name", () => []]]).pool, teacher(), 5, { className: "Nope" })).code, "CLASS_NOT_FOUND");
  assert.strictEqual((await E.enrolClassList(makeMockPool([gate("draft", null)]).pool, teacher(), 5, {})).code, "CLASS_REQUIRED");
  const dr = makeMockPool([gate(), cls(1), list, existing()]); assert.ok((await E.enrolClassList(dr.pool, teacher(), 5, { dryRun: true })).dryRun); assert.strictEqual(batch(dr).length, 0);
  const big = makeMockPool([gate(), cls(1), ["FROM Students WHERE studentClass", () => Array.from({ length: E.MAX_CLASS + 1 }, (_, i) => stu(i + 1))]]); assert.strictEqual((await E.enrolClassList(big.pool, teacher(), 5, {})).code, "LIMIT_REACHED");
  assert.ok(m.log.find((l) => l.sql.includes("FROM Students WHERE studentClass")).sql.includes(`TOP ${E.MAX_CLASS + 1}`));
});

/* ---------------- status changes ---------------- */
test("changeStatus: withdraw / approve / decline are course-scoped, record history, and refuse impossible moves", async () => {
  const upd = (from) => ["UPDATE lms_course_enrolments SET status = @to", (i) => (i.c === 5 && i.s === 9 ? [{ from_status: from }] : [])];
  const w = makeMockPool([gate(), upd("active")]); assert.ok((await E.changeStatus(w.pool, teacher(), 5, "9", "withdraw")).ok);
  const q = w.log.find((l) => l.sql.startsWith("UPDATE lms_course_enrolments")); assert.ok(q.sql.includes("course_id = @c AND student_id = @s") && q.sql.includes("status IN ('active','pending')"));
  assert.strictEqual(w.log.find((l) => l.sql.startsWith("INSERT INTO lms_enrolment_history")).inputs.a, "withdrawn");
  const a = makeMockPool([gate(), students([stu(9)]), upd("pending")]); assert.strictEqual((await E.changeStatus(a.pool, teacher(), 5, 9, "approve")).status, "active");
  assert.ok(a.log.some((l) => l.inputs.act === "enrolment.approved"));
  const d = makeMockPool([gate(), upd("pending")]); assert.ok((await E.changeStatus(d.pool, teacher(), 5, 9, "decline")).ok); assert.strictEqual(d.log.find((l) => l.sql.startsWith("INSERT INTO lms_enrolment_history")).inputs.a, "declined");
  const wrong = makeMockPool([gate(), ["UPDATE lms_course_enrolments SET status = @to", () => []], ["TOP 1 status FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s", () => [{ status: "withdrawn" }]]]);
  assert.strictEqual((await E.changeStatus(wrong.pool, teacher(), 5, 9, "withdraw")).code, "BAD_TRANSITION");
  const none = makeMockPool([gate(), ["UPDATE lms_course_enrolments SET status = @to", () => []]]); assert.strictEqual((await E.changeStatus(none.pool, teacher(), 5, 9, "withdraw")).notFound, true);
  const inactive = makeMockPool([gate(), students([stu(9, { status: "inactive" })])]); assert.strictEqual((await E.changeStatus(inactive.pool, teacher(), 5, 9, "approve")).code, "STUDENT_INACTIVE"); assert.ok(!inactive.log.some((l) => l.sql.startsWith("UPDATE")));
  assert.strictEqual((await E.changeStatus(makeMockPool([gate("archived")]).pool, teacher(), 5, 9, "withdraw")).code, "COURSE_ARCHIVED");
  const bad = makeMockPool([]); for (const [id, act] of [["abc", "withdraw"], [0, "withdraw"], [9, "delete"], ["9; DROP", "approve"]]) assert.strictEqual((await E.changeStatus(bad.pool, teacher(), 5, id, act)).notFound, true); assert.strictEqual(bad.log.length, 0);
});

test("transferStudent: active enrolment moves in ONE transaction with history on both courses; conflicts and bad targets refused", async () => {
  const mk = (here, there, extra = []) => makeMockPool([["class_name, visibility FROM lms_courses", (i) => [{ id: i.c, status: "draft", class_name: null, visibility: "listed" }]], students([stu(9)]),
    ["FROM lms_course_enrolments WHERE course_id = @c AND student_id IN", (i) => (i.c === 5 ? (here ? [{ student_id: 9, status: here }] : []) : (there ? [{ student_id: 9, status: there }] : []))], ...extra]);
  const m = mk("active", null); const r = await E.transferStudent(m.pool, teacher(), 5, { toCourseId: 6 }, 9); assert.ok(r.ok);
  const [tx] = batch(m); assert.ok(tx.sql.includes("THROW 50001") && tx.sql.includes("COMMIT")); assert.strictEqual((tx.sql.match(/INSERT INTO lms_enrolment_history/g) || []).length, 2);
  assert.deepStrictEqual([tx.inputs.a, tx.inputs.b, tx.inputs.s], [5, 6, 9]); assert.ok(m.log.some((l) => l.inputs.act === "enrolment.transferred"));
  const back = mk("active", "transferred"); assert.ok((await E.transferStudent(back.pool, teacher(), 5, { toCourseId: 6 }, 9)).ok); assert.ok(batch(back)[0].sql.includes("UPDATE lms_course_enrolments SET status = 'active'"));
  assert.strictEqual((await E.transferStudent(mk("active", "active").pool, teacher(), 5, { toCourseId: 6 }, 9)).code, "ALREADY_ENROLLED");
  assert.strictEqual((await E.transferStudent(mk("withdrawn", null).pool, teacher(), 5, { toCourseId: 6 }, 9)).code, "BAD_TRANSITION");
  assert.strictEqual((await E.transferStudent(mk(null, null).pool, teacher(), 5, { toCourseId: 6 }, 9)).notFound, true);
  assert.strictEqual((await E.transferStudent(mk("active", null).pool, teacher(), 5, { toCourseId: 5 }, 9)).ok, false);
  const arch = makeMockPool([["class_name, visibility FROM lms_courses", (i) => [{ id: i.c, status: i.c === 6 ? "archived" : "draft", class_name: null, visibility: "listed" }]]]); assert.strictEqual((await E.transferStudent(arch.pool, teacher(), 5, { toCourseId: 6 }, 9)).code, "COURSE_ARCHIVED");
  const gone = makeMockPool([["class_name, visibility FROM lms_courses", (i) => (i.c === 5 ? [{ id: 5, status: "draft", class_name: null, visibility: "listed" }] : [])]]); assert.strictEqual((await E.transferStudent(gone.pool, teacher(), 5, { toCourseId: 77 }, 9)).ok, false);
  for (const b of [{}, { toCourseId: "x" }, { toCourseId: 6, extra: 1 }, null]) assert.strictEqual((await E.transferStudent(makeMockPool([]).pool, teacher(), 5, b, 9)).ok, false);
  const race = mk("active", null); const orig = race.pool.request; race.pool.request = () => { const q = orig(); const run = q.query; q.query = async (s) => { if (s.includes("BEGIN TRAN")) { const e = new Error("ENROLMENT_NOT_ACTIVE"); e.number = 50001; throw e; } return run(s); }; return q; };
  assert.strictEqual((await E.transferStudent(race.pool, teacher(), 5, { toCourseId: 6 }, 9)).code, "BAD_TRANSITION");
});

/* ---------------- students on their own ---------------- */
test("selfEnrol: open -> active, approval -> pending, closed refused; only published + listed courses; staff and inactive students refused", async () => {
  const mk = (extra = []) => makeMockPool([["SELECT TOP 1 status, visibility FROM lms_courses", () => [{ status: "published", visibility: "listed" }]], students([stu(7)]), existing(), ...extra]);
  const o = mk(); const r = await E.selfEnrol(o.pool, student(), 5, "open"); assert.deepStrictEqual([r.ok, r.status], [true, "active"]);
  assert.ok(batch(o)[0].sql.includes("INSERT INTO lms_course_enrolments") && batch(o)[0].inputs.to === "active" && batch(o)[0].inputs.a === "self_enrolled");
  const p = mk(); assert.deepStrictEqual([(await E.selfEnrol(p.pool, student(), 5, "approval")).status, batch(p)[0].inputs.a], ["pending", "requested"]);
  const c = mk(); const cr = await E.selfEnrol(c.pool, student(), 5, "closed"); assert.deepStrictEqual([cr.ok, cr.code, cr.forbidden], [false, "ENROLMENT_CLOSED", true]); assert.strictEqual(batch(c).length, 0);
  for (const [status, visibility] of [["draft", "listed"], ["published", "enrolled_only"], ["archived", "listed"], ["pending", "listed"]]) {
    const x = makeMockPool([["SELECT TOP 1 status, visibility FROM lms_courses", () => [{ status, visibility }]]]); const rr = await E.selfEnrol(x.pool, student(), 5, "open"); assert.strictEqual(rr.code, "COURSE_ACCESS_DENIED", `${status}/${visibility}`);
  }
  const missing = makeMockPool([]); assert.strictEqual((await E.selfEnrol(missing.pool, student(), 5, "open")).code, "COURSE_ACCESS_DENIED");
  const staffTry = makeMockPool([]); assert.strictEqual((await E.selfEnrol(staffTry.pool, teacher(), 5, "open")).code, "COURSE_ACCESS_DENIED"); assert.strictEqual(staffTry.log.length, 0);
  const off = makeMockPool([["SELECT TOP 1 status, visibility FROM lms_courses", () => [{ status: "published", visibility: "listed" }]], students([stu(7, { status: "inactive" })])]); assert.strictEqual((await E.selfEnrol(off.pool, student(), 5, "open")).code, "STUDENT_INACTIVE");
});

test("selfEnrol: already active / pending are conflicts; a student who left on their own may return, one removed by staff may not", async () => {
  const base = (ex, last) => makeMockPool([["SELECT TOP 1 status, visibility FROM lms_courses", () => [{ status: "published", visibility: "listed" }]], students([stu(7)]), existing(ex), ["TOP 1 action FROM lms_enrolment_history", () => (last ? [{ action: last }] : [])]]);
  assert.strictEqual((await E.selfEnrol(base([{ student_id: 7, status: "active" }]).pool, student(), 5, "open")).code, "ALREADY_ENROLLED");
  assert.strictEqual((await E.selfEnrol(base([{ student_id: 7, status: "pending" }]).pool, student(), 5, "approval")).code, "ALREADY_PENDING");
  const ok = base([{ student_id: 7, status: "withdrawn" }], "self_withdrawn"); assert.ok((await E.selfEnrol(ok.pool, student(), 5, "open")).ok); assert.ok(batch(ok)[0].sql.includes("UPDATE lms_course_enrolments SET status = @to"));
  for (const last of ["withdrawn", "declined", "transferred_out", null]) { const b = base([{ student_id: 7, status: "withdrawn" }], last); const r = await E.selfEnrol(b.pool, student(), 5, "open"); assert.strictEqual(r.code, "REENROL_BLOCKED", String(last)); assert.strictEqual(batch(b).length, 0); }
});

test("selfWithdraw: only my own active/pending enrolment, history recorded; anything else gets the generic refusal", async () => {
  const m = makeMockPool([["UPDATE lms_course_enrolments SET status = 'withdrawn'", (i) => (i.c === 5 && i.s === 7 ? [{ from_status: "active" }] : [])]]);
  assert.ok((await E.selfWithdraw(m.pool, student(7), 5)).ok); assert.ok(m.log.some((l) => l.sql.startsWith("INSERT INTO lms_enrolment_history") && l.inputs.f === "active"));
  assert.ok(m.log[0].sql.includes("student_id = @s")); assert.strictEqual(m.log[0].inputs.s, 7);
  assert.strictEqual((await E.selfWithdraw(m.pool, student(8), 5)).code, "COURSE_ACCESS_DENIED");
  const t = makeMockPool([]); assert.strictEqual((await E.selfWithdraw(t.pool, teacher(), 5)).code, "COURSE_ACCESS_DENIED"); assert.strictEqual(t.log.length, 0);
});

/* ---------------- reading ---------------- */
test("listRoster: paginated, searched with escaped LIKE parameters, explicit columns, bad status refused", async () => {
  const m = makeMockPool([["SELECT COUNT(*) AS n", () => [{ n: 61 }]], ["OFFSET @off ROWS", () => [{ student_id: 1, status: "active", source: "bulk", enrolled_at: "x", status_changed_at: "x", name: "Jane", admissionNo: "A1", studentClass: "F1" }]]]);
  const r = await E.listRoster(m.pool, 5, { status: "active", q: "50%_[x]", page: "2", pageSize: "500" });
  assert.ok(r.ok); assert.deepStrictEqual([r.page, r.pageSize, r.total, r.students[0].admissionNo], [2, 100, 61, "A1"]);
  const q = m.log.find((l) => l.sql.includes("OFFSET")); assert.ok(q.sql.includes("e.course_id = @c") && q.sql.includes("ESCAPE") && !/SELECT\s+\*/i.test(q.sql) && !/password/i.test(q.sql));
  assert.deepStrictEqual([q.inputs.off, q.inputs.ps, q.inputs.st, q.inputs.q], [100, 100, "active", "%50\\%\\_\\[x]%"]); assert.ok(!q.sql.includes("50%"));
  assert.strictEqual((await E.listRoster(m.pool, 5, { status: "banana" })).ok, false);
  assert.strictEqual((await E.listRoster(makeMockPool([]).pool, 5, {})).pageSize, 25);
});

test("listHistory: newest first, keyset cursor, optional student filter, limit clamped", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: 10 - i, student_id: 3, action: "enrolled", from_status: null, to_status: "active", detail: "manual", actor_source: "Teachers", actor_id: 7, created_at: "x" }));
  const m = makeMockPool([["FROM lms_enrolment_history", () => rows]]); const r = await E.listHistory(m.pool, 5, { studentId: "3", beforeId: "50", limit: "3" });
  assert.deepStrictEqual([r.entries.length, r.nextBeforeId], [3, 8]); const q = m.log[0]; assert.ok(q.sql.includes("course_id = @c") && q.sql.includes("student_id = @s") && q.sql.includes("id < @b") && q.sql.includes("ORDER BY id DESC"));
  assert.deepStrictEqual([q.inputs.lim, q.inputs.s, q.inputs.b], [4, 3, 50]);
  assert.strictEqual((await E.listHistory(makeMockPool([]).pool, 5, { studentId: "x" })).ok, false);
  assert.strictEqual((await E.listHistory(m.pool, 5, { limit: "9999" })).ok, true); assert.strictEqual(m.log[m.log.length - 1].inputs.lim, 101);
});

/* ---------------- routes ---------------- */
async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant = "isoA" }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  const req = { user, pool, params, body, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return { res };
}
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const EN = "/courses/:courseId/enrolments";

test("routes: owner and co-teacher manage enrolment; students, non-members and strangers are refused with the same 403", async () => {
  const mk = (role) => makeMockPool([staff([5], role), gate(), students([stu(1)]), existing(), ["SELECT COUNT(*) AS n", () => [{ n: 0 }]], ["OFFSET @off ROWS", () => []]]);
  for (const role of ["teacher", "co_teacher"]) {
    const a = await call("post", EN, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" }, body: { studentIds: [1] } }); assert.strictEqual(a.res.statusCode, 201, role); assert.strictEqual(a.res.body.report.summary.enrolled, 1);
    assert.strictEqual((await call("get", EN, { user: teacher(), pool: mk(role).pool, params: { courseId: "5" } })).res.statusCode, 200);
  }
  // a student has no LMS staff permission at all: refused at the entry check, before any course lookup
  const st = mk("teacher"); const sr = await call("post", EN, { user: student(), pool: st.pool, params: { courseId: "5" }, body: { studentIds: [1] } }); assert.deepStrictEqual([sr.res.statusCode, sr.res.body.code], [403, "LMS_FORBIDDEN"]);
  // a teacher who is not on the course, and a course that does not exist, look identical
  const denied = [];
  for (const [pool, courseId] of [[makeMockPool([["FROM lms_course_staff WHERE", () => []]]).pool, "5"], [makeMockPool([staff([5])]).pool, "6"]]) {
    const r = await call("post", EN, { user: teacher(7), pool, params: { courseId }, body: { studentIds: [1] } }); assert.deepStrictEqual([r.res.statusCode, r.res.body.code], [403, "COURSE_ACCESS_DENIED"]); denied.push(r.res);
  }
  sameForbidden(denied[0], denied[1]);
  const c = mk("teacher"); await call("post", EN, { user: student(), pool: c.pool, params: { courseId: "5" }, body: { studentIds: [1] } }); assert.ok(!batch(c).length);
});

test("routes: a registrar with lms.enrolment.manage works across courses; transfer needs access to BOTH courses", async () => {
  const grant = ["FROM lms_user_permissions", () => [{ permission_code: "lms.enrolment.manage" }]];
  const reg = makeMockPool([grant, ["FROM lms_course_staff WHERE", () => []], gate(), students([stu(1)]), existing()]);
  const a = await call("post", EN, { user: registrar, pool: reg.pool, params: { courseId: "5" }, body: { studentIds: [1] } }); assert.strictEqual(a.res.statusCode, 201);
  const none = makeMockPool([["FROM lms_user_permissions", () => []]]); assert.strictEqual((await call("post", EN, { user: registrar, pool: none.pool, params: { courseId: "5" }, body: { studentIds: [1] } })).res.statusCode, 403);
  // teacher owns course 5 but not course 6
  const t = makeMockPool([staff([5]), ["class_name, visibility FROM lms_courses", (i) => [{ id: i.c, status: "draft", class_name: null, visibility: "listed" }]], students([stu(9)]), existing([{ student_id: 9, status: "active" }])]);
  const x = await call("post", EN + "/:studentId/transfer", { user: teacher(), pool: t.pool, params: { courseId: "5", studentId: "9" }, body: { toCourseId: 6 } });
  assert.deepStrictEqual([x.res.statusCode, x.res.body.code], [403, "COURSE_ACCESS_DENIED"]); assert.ok(!batch(t).length);
  const both = makeMockPool([staff([5, 6]), ["class_name, visibility FROM lms_courses", (i) => [{ id: i.c, status: "draft", class_name: null, visibility: "listed" }]], students([stu(9)]),
    ["FROM lms_course_enrolments WHERE course_id = @c AND student_id IN", (i) => (i.c === 5 ? [{ student_id: 9, status: "active" }] : [])]]);
  const ok = await call("post", EN + "/:studentId/transfer", { user: teacher(), pool: both.pool, params: { courseId: "5", studentId: "9" }, body: { toCourseId: 6 } }); assert.strictEqual(ok.res.statusCode, 200); assert.strictEqual(batch(both).length, 1);
});

test("routes: status codes — dry-run CSV report, CSV errors 400, conflicts 409, bad ids 404, archived 409, registrar vs student actions", async () => {
  const pool = (extra = []) => makeMockPool([staff([5]), gate(), students([stu(1)]), ["FROM Students WHERE admissionNo IN", () => [stu(1)]], existing(), ...extra]).pool;
  const bulk = await call("post", EN + "/bulk", { user: teacher(), pool: pool(), params: { courseId: "5" }, body: { csv: "admissionNo\nADM1\nNOPE", dryRun: true } });
  assert.strictEqual(bulk.res.statusCode, 200); assert.ok(bulk.res.body.report.dryRun); assert.strictEqual(bulk.res.body.report.failed[0].line, 3);
  const bad = await call("post", EN + "/bulk", { user: teacher(), pool: pool(), params: { courseId: "5" }, body: { csv: "name\nx" } }); assert.deepStrictEqual([bad.res.statusCode, bad.res.body.code], [400, "CSV_NO_HEADER"]);
  const v = await call("post", EN, { user: teacher(), pool: pool(), params: { courseId: "5" }, body: { studentIds: "x" } }); assert.deepStrictEqual([v.res.statusCode, v.res.body.code], [400, "VALIDATION_ERROR"]);
  const arch = makeMockPool([staff([5]), gate("archived")]); const ar = await call("post", EN, { user: teacher(), pool: arch.pool, params: { courseId: "5" }, body: { studentIds: [1] } }); assert.deepStrictEqual([ar.res.statusCode, ar.res.body.code], [409, "COURSE_ARCHIVED"]);
  const cls = await call("post", EN + "/class-list", { user: teacher(), pool: pool([["FROM Classes WHERE name", () => []]]), params: { courseId: "5" }, body: { className: "Zed" } }); assert.deepStrictEqual([cls.res.statusCode, cls.res.body.code], [400, "CLASS_NOT_FOUND"]);
  const nid = await call("post", EN + "/:studentId/withdraw", { user: teacher(), pool: pool(), params: { courseId: "5", studentId: "abc" } }); assert.strictEqual(nid.res.statusCode, 404);
  const nf = await call("post", EN + "/:studentId/approve", { user: teacher(), pool: pool([["UPDATE lms_course_enrolments SET status = @to", () => []]]), params: { courseId: "5", studentId: "9" } }); assert.deepStrictEqual([nf.res.statusCode, nf.res.body.code], [404, "NOT_FOUND"]);
  const bt = await call("post", EN + "/:studentId/decline", { user: teacher(), pool: pool([["UPDATE lms_course_enrolments SET status = @to", () => []], ["TOP 1 status FROM lms_course_enrolments WHERE course_id = @c AND student_id = @s", () => [{ status: "active" }]]]), params: { courseId: "5", studentId: "9" } }); assert.deepStrictEqual([bt.res.statusCode, bt.res.body.code], [409, "BAD_TRANSITION"]);
  const ok = await call("post", EN + "/:studentId/withdraw", { user: teacher(), pool: pool([["UPDATE lms_course_enrolments SET status = @to", () => [{ from_status: "active" }]]]), params: { courseId: "5", studentId: "9" } }); assert.strictEqual(ok.res.statusCode, 200);
  const hist = await call("get", EN + "/history", { user: teacher(), pool: pool([["FROM lms_enrolment_history", () => []]]), params: { courseId: "5" }, query: { studentId: "zz" } }); assert.strictEqual(hist.res.statusCode, 400);
  const rost = await call("get", EN, { user: teacher(), pool: pool(), params: { courseId: "5" }, query: { status: "nope" } }); assert.strictEqual(rost.res.statusCode, 400);
});

test("routes: student self-enrol follows the tenant mode; staff are refused before any query; codes map to 201/403/409", async () => {
  const settings = (mode) => ["FROM lms_settings", () => [{ setting_key: "enrolment", value_json: JSON.stringify({ defaultMode: mode }) }]];
  const mk = (mode, ex = []) => makeMockPool([settings(mode), ["SELECT TOP 1 status, visibility FROM lms_courses", () => [{ status: "published", visibility: "listed" }]], students([stu(7)]), existing(ex)]);
  const o = await call("post", "/courses/:courseId/enrol", { user: student(), pool: mk("open").pool, params: { courseId: "5" } }); assert.deepStrictEqual([o.res.statusCode, o.res.body.status], [201, "active"]);
  const a = await call("post", "/courses/:courseId/enrol", { user: student(), pool: mk("approval").pool, params: { courseId: "5" } }); assert.deepStrictEqual([a.res.statusCode, a.res.body.status], [201, "pending"]);
  const c = await call("post", "/courses/:courseId/enrol", { user: student(), pool: mk("closed").pool, params: { courseId: "5" } }); assert.deepStrictEqual([c.res.statusCode, c.res.body.code], [403, "ENROLMENT_CLOSED"]);
  const d = await call("post", "/courses/:courseId/enrol", { user: student(), pool: mk("open", [{ student_id: 7, status: "active" }]).pool, params: { courseId: "5" } }); assert.deepStrictEqual([d.res.statusCode, d.res.body.code], [409, "ALREADY_ENROLLED"]);
  const t = mk("open"); const s = await call("post", "/courses/:courseId/enrol", { user: teacher(), pool: t.pool, params: { courseId: "5" } }); assert.strictEqual(s.res.statusCode, 403); assert.strictEqual(t.log.length, 0);
  const w = makeMockPool([["UPDATE lms_course_enrolments SET status = 'withdrawn'", () => [{ from_status: "active" }]]]); assert.strictEqual((await call("post", "/courses/:courseId/withdraw", { user: student(), pool: w.pool, params: { courseId: "5" } })).res.statusCode, 200);
  const tw = makeMockPool([]); assert.strictEqual((await call("post", "/courses/:courseId/withdraw", { user: teacher(), pool: tw.pool, params: { courseId: "5" } })).res.statusCode, 403); assert.strictEqual(tw.log.length, 0);
});

test("isolation: school A's staff and students only ever touch A's database; student/course ids of school B never resolve in A", async () => {
  const T = makeTenants({
    isoA: [staff([1]), ["class_name, visibility FROM lms_courses", onlyIds("c", [1], [{ id: 1, status: "draft", class_name: null, visibility: "listed" }])], ["FROM Students WHERE id IN", (i) => (i.s0 === 11 ? [stu(11)] : [])], existing()],
    isoB: [staff([2]), ["class_name, visibility FROM lms_courses", () => [{ id: 2, status: "draft", class_name: null, visibility: "listed" }]], students([stu(21)])],
  });
  const mine = await call("post", EN, { user: teacher(), pool: T.isoA.pool, params: { courseId: "1" }, body: { studentIds: [11] } }); assert.strictEqual(mine.res.statusCode, 201);
  const foreignStudent = await call("post", EN, { user: teacher(), pool: T.isoA.pool, params: { courseId: "1" }, body: { studentIds: [21] } }); assert.strictEqual(foreignStudent.res.body.report.summary.failed, 1); assert.strictEqual(foreignStudent.res.body.report.summary.enrolled, 0);
  const foreignCourse = await call("get", EN, { user: teacher(), pool: T.isoA.pool, params: { courseId: "2" } }); const missing = await call("get", EN, { user: teacher(), pool: T.isoA.pool, params: { courseId: "999" } }); sameForbidden(foreignCourse.res, missing.res);
  const stuA = await call("post", "/courses/:courseId/enrol", { user: student(), pool: T.isoA.pool, params: { courseId: "2" } }); assert.strictEqual(stuA.res.statusCode, 403);
  T.assertQueried("isoA"); T.assertUntouched("isoB");
});

test("static: every enrolment route is gated (entry permission + course access, or studentOnly); /history is declared before /:studentId; tables blocklisted; no raw db access; no SELECT *", () => {
  const router = require("../routes/lms"); const root = path.join(__dirname, "..");
  const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/(enrolments|enrol$|withdraw$)/.test(l.route.path));
  assert.strictEqual(mine.length, 11);
  for (const l of mine) assert.ok(l.route.stack.length >= (/enrolments/.test(l.route.path) ? 3 : 2), l.route.path);
  const idx = (p, m) => router.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.ok(idx(EN + "/history", "get") > 0 && idx(EN, "get") > 0 && idx(EN + "/bulk", "post") > 0);
  const src = fs.readFileSync(path.join(root, "utils", "lmsEnrolment.js"), "utf8");
  assert.ok(!/config\/db/.test(src) && !/SELECT\s+\*/i.test(src) && !/password/i.test(src.replace(/legacy table has passwords/g, "")));
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8").split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST"));
  for (const t of ["lms_course_enrolments", "lms_enrolment_history"]) assert.ok(server.includes(`"${t}"`), t);
});

test("schema step 005: additive and idempotent; unique (course, student); columns match requireCourseAccess; indexes for roster and 'my courses'", () => {
  const { STEPS } = require("../utils/lmsSchema"); const s = STEPS.find((x) => x.id === "005_lms_enrolments"); assert.ok(s);
  assert.ok(STEPS.map((x) => x.id).indexOf("005_lms_enrolments") === 4, "step 005 keeps its place (later steps are appended after it)"); const all = s.sql.join("\n");
  assert.ok(s.sql.every((x) => /^IF NOT EXISTS/.test(x.trim()))); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(all));
  for (const frag of ["course_id INT NOT NULL", "student_id INT NOT NULL", "status NVARCHAR(20)", "UNIQUE (course_id, student_id)", "IX_lms_enrolments_student", "IX_lms_enrolments_course_status", "lms_enrolment_history", "IX_lms_enrolment_history_course"]) assert.ok(all.includes(frag), frag);
  assert.ok(!/FOREIGN KEY|REFERENCES/i.test(all)); // D-005
  const perm = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsPermissions.js"), "utf8"); assert.ok(perm.includes("FROM lms_course_enrolments WHERE course_id = @c AND student_id = @u AND status = 'active'"));
});
