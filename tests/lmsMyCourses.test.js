/* L2.6a — student course lists (my courses + catalogue). Mocked pool only: SQL syntax NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsMyCourses.test.js");
const M = require("../utils/lmsMyCourses");

const student = (id = 7) => ({ id, role: "student", source: "Students", tenant: "isoA" });
const teacher = { id: 3, role: "teacher", source: "Teachers", tenant: "isoA" };
const row = (o = {}) => ({ id: 5, code: "BIO101", title: "Biology", description: "d", academic_year: 2026, semester: "T1", class_name: "Form 1A", status: "published", my_status: "active", enrolled_at: "2026-01-05", teacher_name: "T. One", total_count: 1, ...o });

/* ---------------- service ---------------- */
test("listMyCourses: student id comes from the token; published only; parameters only; paginated", async () => {
  const m = makeMockPool([["FROM lms_course_enrolments e INNER JOIN lms_courses c", () => [row({ total_count: 2 }), row({ id: 6, my_status: "pending", total_count: 2 })]]]);
  const r = await M.listMyCourses(m.pool, student(7), { q: "bio", page: "2", pageSize: "500", academicYear: "2026", studentId: "99" });
  assert.ok(r.ok); assert.strictEqual(r.items.length, 2); assert.deepStrictEqual([r.items[0].myStatus, r.items[1].myStatus], ["active", "pending"]);
  assert.strictEqual(r.pageSize, M.MAX_PAGE_SIZE); assert.strictEqual(r.page, 2); assert.strictEqual(r.total, 2);
  const q = m.log[0];
  assert.strictEqual(q.inputs.sid, 7, "a ?studentId= in the query must be ignored");
  assert.deepStrictEqual([q.inputs.off, q.inputs.lim, q.inputs.year], [M.MAX_PAGE_SIZE, M.MAX_PAGE_SIZE, 2026]);
  assert.ok(q.sql.includes("c.status IN ('published')") && !q.sql.includes("'archived'"));
  assert.ok(q.sql.includes("c.deleted_at IS NULL") && q.sql.includes("e.status IN ('active','pending')") && !/SELECT\s+\*/i.test(q.sql));
  assert.ok(!q.sql.includes("bio"), "search text must be a parameter");
  assert.ok(q.sql.includes("OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY"));
});

test("listMyCourses: includeArchived adds archived courses; LIKE wildcards in the search are escaped", async () => {
  const m = makeMockPool([["FROM lms_course_enrolments e", () => []]]);
  const r = await M.listMyCourses(m.pool, student(), { includeArchived: "1", q: "50%_[x" });
  assert.deepStrictEqual([r.ok, r.items, r.total], [true, [], 0]);
  assert.ok(m.log[0].sql.includes("'published','archived'")); assert.strictEqual(m.log[0].inputs.q, "%50\\%\\_\\[x%");
  const n = makeMockPool([["FROM lms_course_enrolments e", () => []]]); await M.listMyCourses(n.pool, student(), { includeArchived: "yes'; DROP TABLE x;--" });
  assert.ok(!n.log[0].sql.includes("DROP") && !n.log[0].sql.includes("'archived'"), "only the exact flag values switch it on");
});

test("listMyCourses / listCatalogue: only a student account; staff and malformed users are refused before any query", async () => {
  for (const u of [teacher, null, {}, { id: 1, role: "student", source: "Teachers" }, { id: 1, role: "admin", source: "Users" }]) {
    const a = makeMockPool([]), b = makeMockPool([]);
    for (const [fn, args, mp] of [[M.listMyCourses, [{}], a], [M.listCatalogue, ["open", {}], b]]) {
      const r = await fn(mp.pool, u, ...args); assert.deepStrictEqual([r.ok, r.forbidden, r.code], [false, true, "COURSE_ACCESS_DENIED"]); assert.strictEqual(mp.log.length, 0);
    }
  }
});

test("listMyCourses: description is trimmed for cards; only teacher NAME is exposed (no ids/contact)", async () => {
  const m = makeMockPool([["FROM lms_course_enrolments e", () => [row({ description: "x".repeat(900) })]]]);
  const c = (await M.listMyCourses(m.pool, student(), {})).items[0];
  assert.ok(c.description.length <= 301); assert.strictEqual(c.teacherName, "T. One");
  assert.ok(!("staff" in c) && !("createdBy" in c) && !JSON.stringify(c).includes("password"));
  assert.ok(m.log[0].sql.includes("t.name, u.name") && !/phone|email|password/i.test(m.log[0].sql));
});

test("listCatalogue: published + listed only, excludes courses I am in or waiting for, canRequest mirrors selfEnrol", async () => {
  const rows = [row({ id: 10, my_status: null, last_action: null }), row({ id: 11, my_status: "withdrawn", last_action: "self_withdrawn" }),
    row({ id: 12, my_status: "withdrawn", last_action: "withdrawn" }), row({ id: 13, my_status: "transferred", last_action: "transferred_out" })];
  const m = makeMockPool([["FROM lms_courses c LEFT JOIN lms_course_enrolments e", () => rows]]);
  const r = await M.listCatalogue(m.pool, student(7), "open", {});
  assert.deepStrictEqual(r.items.map((i) => i.canRequest), [true, true, false, false]); assert.deepStrictEqual(r.items.map((i) => i.previouslyEnrolled), [false, true, true, true]);
  assert.strictEqual(r.enrolmentMode, "open");
  const q = m.log[0].sql;
  assert.ok(q.includes("c.status = 'published'") && q.includes("c.visibility = 'listed'") && q.includes("c.deleted_at IS NULL") && q.includes("e.status NOT IN ('active','pending')"));
  assert.strictEqual(m.log[0].inputs.sid, 7);
  const a = await M.listCatalogue(makeMockPool([["FROM lms_courses c", () => [row({ my_status: null })]]]).pool, student(), "approval", {}); assert.strictEqual(a.items[0].canRequest, true); assert.strictEqual(a.enrolmentMode, "approval");
});

test("listCatalogue: when the school's mode is not open/approval nothing can be requested", async () => {
  for (const mode of ["closed", "staff_only", undefined, ""]) {
    const r = await M.listCatalogue(makeMockPool([["FROM lms_courses c", () => [row({ my_status: null })]]]).pool, student(), mode, {});
    assert.strictEqual(r.items[0].canRequest, false, String(mode)); assert.strictEqual(r.enrolmentMode, "closed");
  }
});

/* ---------------- routes ---------------- */
async function call(p, { user, pool, query = {}, tenant = "isoA" }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods.get); assert.ok(layer, p);
  const req = { user, pool, params: {}, body: {}, query, tenant }, res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next(); for (let n = 0; n < pending.length; n += 1) await pending[n];
  return res;
}

test("routes: student gets both lists; the catalogue reports the tenant enrolment mode; staff get 403 COURSE_ACCESS_DENIED with no query", async () => {
  const mk = () => makeMockPool([["FROM lms_course_enrolments e INNER JOIN", () => [row()]], ["FROM lms_courses c LEFT JOIN", () => [row({ my_status: null })]]]);
  const a = mk(), r1 = await call("/my/courses", { user: student(), pool: a.pool }); assert.strictEqual(r1.statusCode, 200); assert.strictEqual(r1.body.items.length, 1); assert.strictEqual(r1.body.success, true);
  const b = mk(), r2 = await call("/catalogue", { user: student(), pool: b.pool }); assert.strictEqual(r2.statusCode, 200); assert.ok(["open", "approval", "closed"].includes(r2.body.enrolmentMode)); assert.strictEqual(r2.body.items.length, 1);
  for (const p of ["/my/courses", "/catalogue"]) { const t = makeMockPool([]), r = await call(p, { user: teacher, pool: t.pool }); assert.deepStrictEqual([r.statusCode, r.body.code], [403, "COURSE_ACCESS_DENIED"]); assert.strictEqual(t.log.length, 0, p); }
});

test("routes: a database failure is a clean 500 with no internals", async () => {
  const pool = { request() { const r = { input: () => r, query: async () => { throw new Error("boom: Students.password"); } }; return r; } };
  for (const p of ["/my/courses", "/catalogue"]) { const r = await call(p, { user: student(), pool }); assert.strictEqual(r.statusCode, 500); assert.ok(!JSON.stringify(r.body).includes("boom")); }
});

/* ---------------- isolation ---------------- */
test("isolation: a student of school A only ever queries A's database; B is untouched", async () => {
  const T = makeTenants({ A: [["FROM lms_course_enrolments e INNER JOIN", () => [row()]], ["FROM lms_courses c LEFT JOIN", () => []]], B: [] });
  await call("/my/courses", { user: student(7), pool: T.A.pool }); await call("/catalogue", { user: student(7), pool: T.A.pool });
  T.assertQueried("A"); T.assertUntouched("B");
});

test("static: both routes use studentOnly, read only via req.pool, and the util never selects * or opens its own connection", () => {
  const router = require("../routes/lms");
  for (const p of ["/my/courses", "/catalogue"]) { const l = router.stack.find((x) => x.route && x.route.path === p && x.route.methods.get); assert.ok(l.route.stack.length >= 2, `${p} needs studentOnly before the handler`); }
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsMyCourses.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); // comments may mention these words
  assert.ok(!/config\/db/.test(code) && !/SELECT\s+\*/i.test(code) && !/\b(INSERT|UPDATE|DELETE)\b/.test(code), "read-only");
});
