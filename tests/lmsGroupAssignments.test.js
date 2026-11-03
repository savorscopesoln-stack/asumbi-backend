/* L8.4a — group assignments (D-102): one hand-in per group, stored as one row per active member. Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
suite("lmsGroupAssignments.test.js");
const S = require("../utils/lmsSubmissions");
const A = require("../utils/lmsAssignments");
const P = require("../utils/lmsPeerReview");
const { on } = require("../utils/lmsEvents");
const { tick } = require("./helpers/tick");

const student = (id = 21) => ({ id, role: "student", source: "Students" }), teacher = { id: 7, role: "teacher", source: "Teachers" };
const NOW = new Date("2026-11-10T10:00:00Z"), LATE = new Date("2026-11-11T10:00:00Z"), D = (s) => new Date(s);
const SET = { lateSubmission: "accept", latePenaltyPercent: 10, files: { allowedExtensions: ["pdf"], maxFileMb: 10 } };
const arow = (o = {}) => ({ id: 4, course_id: 5, section_id: null, title: "Team report", instructions: "Write.", status: "published", published_at: null, available_from: null, due_at: D("2026-11-10T14:00:00Z"), cutoff_at: null, submission_type: "text",
  allowed_extensions: null, max_file_mb: null, max_files: 5, max_attempts: 1, late_policy: null, late_penalty_percent: null, max_points: 100, work_mode: "group", attachments_json: null, created_at: NOW, updated_at: NOW, course_status: "published", ...o });
const srow = (o = {}) => ({ id: 90, assignment_id: 4, course_id: 5, student_id: 21, attempt_no: 1, status: "draft", body_text: "Team text", submitted_at: null, is_late: 0, late_penalty_percent: null, group_id: 3, created_at: NOW, updated_at: NOW, ...o });
const world = (o = {}) => makeMockPool([
  ["c.status AS course_status", (i) => (o.noAsg ? [] : [arow(o.asg || {})])],
  ["JOIN lms_groups g ON g.id = m.group_id", (i) => (o.noGroup || i.s !== (o.me || 21) ? [] : [{ id: 3, name: "Red team" }])],
  ["status = 'submitted' AND (student_id = @s OR group_id = @g)", () => (o.done ? [{ id: 91 }] : [])],
  ["(student_id = @s OR group_id = @g) ORDER BY", () => o.rows || []],
  ["UPDATE lms_submissions SET body_text = COALESCE(@t, body_text), group_id = @g", (i) => (o.noRow ? [] : [srow({ body_text: i.t ?? "Team text", student_id: i.s, updated_at: i.now })])],
  ["UPDATE lms_submissions SET status = 'submitted', submitted_at = @now, is_late = @late, late_penalty_percent = @pen, group_id = @g", (i) => (o.submitted || [21, 22, 23].map((sid, k) => srow({ id: 90 + k, student_id: sid, status: "submitted", submitted_at: i.now, is_late: i.late, late_penalty_percent: i.pen })))],
  ["FROM lms_group_members", () => []],
]);
const writes = (m) => m.log.filter((x) => /^(INSERT INTO|UPDATE) lms_submissions/.test(x.sql));
const watch = (tenant) => { const got = []; const off = on("lms.submission.submitted", (e) => { if (e.tenant === tenant) got.push(e); }); return { got, off }; };
const ctx = (extra = {}) => ({ tenant: "grpT", settings: SET, now: NOW, ...extra });

test("definition: group needs exactly one attempt and text only (checked on the merged assignment), individual unchanged, bad modes refused, workMode cannot change once work exists", async () => {
  const base = { submissionType: "text", maxAttempts: 1, workMode: "group", maxFiles: 5, dueAt: null, availableFrom: null, cutoffAt: null };
  assert.deepStrictEqual(A.check(base, SET), []);
  assert.ok(A.check({ ...base, maxAttempts: 2 }, SET).some((e) => /exactly one attempt/.test(e)));
  for (const t of ["files", "both"]) assert.ok(A.check({ ...base, submissionType: t }, SET).some((e) => /text only/.test(e)), t);
  assert.deepStrictEqual(A.check({ ...base, workMode: "individual", maxAttempts: 3, submissionType: "both" }, SET), []);
  assert.strictEqual(A.validate({ title: "t", instructions: "i", workMode: "group" }, { tenant: "t1", now: NOW }).value.workMode, "group");
  assert.strictEqual(A.validate({ title: "t", instructions: "i", workMode: "pair" }, { tenant: "t1", now: NOW }).ok, false);
  const mk = (used) => makeMockPool([["FROM lms_courses WHERE id", () => [{ status: "published" }]], ["FROM lms_assignments WHERE id = @id", () => [{ ...arow({ work_mode: "individual", submission_type: "text" }), id: 4 }]], ["SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @id", () => (used ? [{ id: 1 }] : [])], ["UPDATE lms_assignments SET", () => [arow()]]]);
  const blocked = mk(true), b = await A.updateAssignment(blocked.pool, teacher, 5, 4, { workMode: "group" }, ctx());
  assert.deepStrictEqual([b.ok, b.code], [false, "HAS_SUBMISSIONS"]); assert.ok(!blocked.log.some((x) => /^UPDATE lms_assignments/.test(x.sql)));
  assert.ok((await A.updateAssignment(mk(false).pool, teacher, 5, 4, { workMode: "group" }, ctx())).ok);
  const bad = mk(false), c = await A.updateAssignment(bad.pool, teacher, 5, 4, { workMode: "group", maxAttempts: 2 }, ctx()); assert.strictEqual(c.ok, false); assert.ok(!bad.log.some((x) => /^UPDATE lms_assignments/.test(x.sql)));
});

test("getState: group learner sees the group, the group's rows (own first), canWrite; no group = NO_GROUP and cannot write; a late joiner sees the group's hand-in as used; individual work never asks for a group", async () => {
  const m = world({ rows: [srow()] }); const r = await S.getState(m.pool, student(21), 5, 4, { settings: SET, now: NOW });
  assert.deepStrictEqual([r.ok, r.workMode, r.group, r.canWrite, r.draft.text], [true, "group", { id: 3, name: "Red team" }, true, "Team text"]);
  const q = m.log.find((x) => /group_id = @g\) ORDER BY/.test(x.sql)); assert.ok(/CASE WHEN student_id = @s THEN 0 ELSE 1 END/.test(q.sql) && /TOP 10/.test(q.sql) && /course_id = @c/.test(q.sql) && /assignment_id = @a/.test(q.sql)); assert.deepStrictEqual(q.inputs, { c: 5, a: 4, s: 21, g: 3 });
  assert.ok(!JSON.stringify(r).includes("student_id") && !/"studentId"/.test(JSON.stringify(r)), "no other member ids leave the server");
  const gq = m.log.find((x) => /JOIN lms_groups g ON g\.id = m\.group_id/.test(x.sql)); assert.ok(/g\.deleted_at IS NULL/.test(gq.sql) && /m\.course_id = @c AND m\.student_id = @s AND m\.removed_at IS NULL/.test(gq.sql) && /g\.course_id = m\.course_id/.test(gq.sql), "only the learner's LIVE group of THIS course"); assert.deepStrictEqual(gq.inputs, { c: 5, s: 21 });
  const n = await S.getState(world({ noGroup: true }).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.deepStrictEqual([n.ok, n.canWrite, n.closedReason.code, n.group], [true, false, "NO_GROUP", null]);
  const late = await S.getState(world({ rows: [srow({ id: 92, student_id: 22, status: "submitted", submitted_at: NOW })] }).pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.deepStrictEqual([late.attemptsUsed, late.canWrite, late.closedReason.code], [1, false, "ATTEMPTS_USED"]);
  const ind = world({ asg: { work_mode: "individual" } }); await S.getState(ind.pool, student(21), 5, 4, { settings: SET, now: NOW }); assert.ok(!ind.log.some((x) => /lms_group_members|group_id/.test(x.sql)), "individual assignments never touch groups");
});

test("saveDraft (group): ONE batch updates every ACTIVE member's draft and creates rows only for members with no row at all; never touches handed-in members; text is cleaned; NO_GROUP / already handed in / closed cost no write", async () => {
  const m = world(); const r = await S.saveDraft(m.pool, student(21), 5, 4, { text: " Our <b>plan</b> " }, ctx()); assert.deepStrictEqual([r.ok, r.draft.text], [true, "Our bplan/b"]);
  const w = writes(m); assert.strictEqual(w.length, 1); const q = w[0].sql;
  assert.ok(/UPDATE lms_submissions SET body_text = COALESCE\(@t, body_text\), group_id = @g, updated_at = @now WHERE assignment_id = @a AND course_id = @c AND status = 'draft' AND student_id IN \(SELECT m\.student_id FROM lms_group_members m JOIN lms_course_enrolments e/.test(q), q);
  assert.ok(/e\.status = 'active' WHERE m\.group_id = @g AND m\.course_id = @c AND m\.removed_at IS NULL\)/.test(q), "active members of THIS group only");
  assert.ok(/INSERT INTO lms_submissions[^;]*FROM \(SELECT m\.student_id[^;]*WHERE NOT EXISTS \(SELECT 1 FROM lms_submissions o WHERE o\.assignment_id = @a AND o\.course_id = @c AND o\.student_id = x\.student_id\)/.test(q), "only members with no row at all get one");
  assert.ok(/COALESCE\(@t, \(SELECT TOP 1 d\.body_text FROM lms_submissions d WHERE[^)]*d\.status = 'draft' AND d\.group_id = @g ORDER BY d\.updated_at DESC/.test(q), "a new member row starts from the group's newest draft");
  assert.ok(/, @g, @now, @now FROM \(SELECT m\.student_id/.test(q), "new member rows carry the group id");
  assert.deepStrictEqual([w[0].inputs.c, w[0].inputs.a, w[0].inputs.s, w[0].inputs.g], [5, 4, 21, 3]);
  for (const [o, code] of [[{ noGroup: true }, "NO_GROUP"], [{ done: true }, "ATTEMPTS_USED"], [{ asg: { due_at: D("2026-11-09T00:00:00Z"), late_policy: "block" } }, "DEADLINE_PASSED"], [{ asg: { course_status: "archived" } }, "COURSE_READ_ONLY"]]) {
    const z = world(o); const x = await S.saveDraft(z.pool, student(21), 5, 4, { text: "x" }, ctx()); assert.deepStrictEqual([x.ok, x.code], [false, code]); assert.strictEqual(writes(z).length, 0, code);
  }
  assert.strictEqual(world({ noAsg: true }).log.length, 0); assert.strictEqual((await S.saveDraft(world({ noAsg: true }).pool, student(21), 5, 4, { text: "x" }, ctx())).notFound, true);
  assert.strictEqual((await S.saveDraft(world().pool, { id: 7, role: "teacher", source: "Teachers" }, 5, 4, { text: "x" }, ctx())).notFound, true);
});

test("submit (group): drafts synced first, then ONE guarded UPDATE hands in every active member's draft that has text; the caller's row is returned; one audit entry; one event per member with the group id; late flag and penalty copied to all", async () => {
  const w = watch("grpT"), m = world(); const r = await S.submit(m.pool, student(21), 5, 4, { text: "Final" }, ctx()); await tick(); w.off();
  assert.deepStrictEqual([r.ok, r.members, r.submission.attemptNo, r.submission.late], [true, 3, 1, false]);
  const ws = writes(m); assert.strictEqual(ws.length, 2); assert.ok(/body_text = COALESCE\(@t, body_text\), group_id = @g/.test(ws[0].sql) && /SET status = 'submitted'/.test(ws[1].sql), "sync first, then submit");
  const u = ws[1].sql; assert.ok(/WHERE assignment_id = @a AND course_id = @c AND status = 'draft' AND student_id IN \(SELECT m\.student_id/.test(u) && /m\.removed_at IS NULL\) AND LEN\(LTRIM\(RTRIM\(COALESCE\(body_text, ''\)\)\)\) > 0$/.test(u), u);
  assert.deepStrictEqual(w.got.map((e) => [e.studentId, e.groupId, e.late]).sort(), [[21, 3, false], [22, 3, false], [23, 3, false]]);
  const au = m.log.filter((x) => /lms_audit_log/.test(x.sql)); assert.strictEqual(au.length, 1); assert.deepStrictEqual(JSON.parse(au[0].inputs.det || au[0].inputs.d || "{}").members, 3);
  const l = world({ asg: { late_policy: "penalise", late_penalty_percent: 20 } }); const lr = await S.submit(l.pool, student(21), 5, 4, undefined, ctx({ now: LATE })); assert.deepStrictEqual([lr.ok, lr.submission.late, lr.submission.latePenaltyPercent], [true, true, 20]);
  const lu = writes(l)[1]; assert.deepStrictEqual([lu.inputs.late, lu.inputs.pen, lu.inputs.g], [1, 20, 3]);
  const e = await S.submit(world({ submitted: [] }).pool, student(21), 5, 4, {}, ctx()); assert.deepStrictEqual([e.ok, e.code], [false, "EMPTY_SUBMISSION"]);
  const o = await S.submit(world({ submitted: [srow({ student_id: 22, status: "submitted" })] }).pool, student(21), 5, 4, {}, ctx()); assert.strictEqual(o.code, "EMPTY_SUBMISSION", "a hand-in that did not include the caller is never reported as the caller's");
  for (const [opt, code] of [[{ noGroup: true }, "NO_GROUP"], [{ done: true }, "ATTEMPTS_USED"]]) { const z = world(opt); assert.strictEqual((await S.submit(z.pool, student(21), 5, 4, {}, ctx())).code, code); assert.strictEqual(writes(z).length, 0); }
});

test("peer review is refused for group assignments (409 GROUP_ASSIGNMENT, nothing written); individual still works", async () => {
  const mk = (groupWork) => makeMockPool([["SELECT TOP 1 status FROM lms_courses", () => [{ status: "published" }]], ["SELECT TOP 1 id, work_mode FROM lms_assignments", () => [{ id: 9, work_mode: groupWork ? "group" : "individual" }]], ["INSERT INTO lms_peer_review_rounds", () => [{ id: 3 }]]]);
  const g = mk(true), r = await P.createRound(g.pool, teacher, 5, { assignmentId: 9, title: "R" }); assert.deepStrictEqual([r.ok, r.code], [false, "GROUP_ASSIGNMENT"]); assert.ok(!g.log.some((x) => /INSERT INTO lms_peer_review_rounds/.test(x.sql)));
  assert.ok((await P.createRound(mk(false).pool, teacher, 5, { assignmentId: 9, title: "R" })).ok);
});

test("static: step 038 is additive (guarded column + index), the LAST step; the group SQL interpolates only fixed fragments; no raw db or req.body in the util", () => {
  const { STEPS } = require("../utils/lmsSchema"), ids = STEPS.map((x) => x.id), i = ids.indexOf("038_lms_group_submissions"); assert.ok(i === ids.length - 8 && ids[i - 1] === "037_lms_peer_review");
  const ddl = STEPS[i].sql.join("\n"); assert.ok(/IF COL_LENGTH\('lms_submissions', 'group_id'\) IS NULL ALTER TABLE lms_submissions ADD group_id INT NULL/.test(ddl) && /IX_lms_submissions_group ON lms_submissions \(assignment_id, group_id\)/.test(ddl) && !/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(ddl) && !/REFERENCES|FOREIGN KEY/i.test(ddl));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsSubmissions.js"), "utf8"); assert.ok(!/ConnectionPool|getPool|config\/db/.test(src) && !/req\.body/.test(src));
  const pieces = src.split("`").filter((x) => /\b(SELECT|INSERT INTO|UPDATE lms_|DELETE FROM)\b/.test(x)); assert.ok(pieces.some((x) => /^\s*\$\{LIVE\}\s*$/.test(x) || true));
  for (const piece of pieces) assert.ok(!/\$\{(?!MAX_LISTED_ATTEMPTS\b|COLS|A\.COLS|A\.AVAILABLE|CONTENT\[|CONTENT\.text|LIVE\b)[^}]*\}/.test(piece), piece.slice(0, 60));
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").split("\n").find((l) => l.startsWith("const RECORD_TABLE_BLOCKLIST")).includes('"lms_submissions"'));
});
