/* Report download page: students can fill in their profile while downloads are closed,
   the admin's typed message + logos reach the public page, and the admin can list who has /
   has not updated. Runs the REAL route handlers against a mocked database (see helpers/mockPool.js). */
const Module = require("module");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");

const mssql = require("mssql");
let currentPool = null;
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (/(^|\/)config\/db$/.test(request)) return { sql: mssql, getPool: async () => currentPool, listTenantKeys: () => ["default"] };
  return origLoad.call(this, request, parent, ...rest);
};
const router = require("../routes/reportAccess");
const { getProfileStatusAdmin, cleanNotice } = require("../utils/downloadAccess");
Module._load = origLoad;

const handler = (method, path) => router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]).route.stack[0].handle;
const call = async (fn, req) => {
  const out = { code: 200, body: null };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; } };
  req.headers = req.headers || {};
  req.ip = req.ip || `10.0.0.${Math.floor(Math.random() * 250)}`; // each test is its own client for the rate limit
  await fn(req, res);
  return out;
};

const FUTURE = new Date(Date.now() + 5 * 86400e3);
const PAST = new Date(Date.now() - 5 * 86400e3);

const world = ({ window = {}, student = {}, notice = "Reports open on Monday. Update your details first!" } = {}) => {
  const st = { id: 7, username: "jane", name: "Jane W", status: "active", photoUrl: null, profileCompleted: 0, studentClass: "", gender: "", email: "", phone: "", assessmentNumber: "", ...student };
  const access = { mode: "report", opensAt: FUTURE, closesAt: null, requirePhoto: true, transcriptExamIds: null, pageNotice: notice, ...window };
  const { pool } = makeMockPool([
    ["FROM ReportDownloadAccess WHERE id = 1", () => [access]],
    ["UPDATE Students SET studentClass", () => { st.profileCompleted = 1; return []; }],
    ["FROM Students WHERE username", () => [st]],
    ["FROM Students WHERE id = @id", () => [st]],
    ["FROM Classes", () => []],
    ["FROM SchoolSettings", () => [{ schoolName: "Asumbi Girls", shortName: "AGHS", logoUrl: "/uploads/logo.png", governmentLogoUrl: "/uploads/gov.png" }]],
  ]);
  currentPool = pool;
  return { st, pool };
};

const profileBody = { studentClass: "Form 4", gender: "Female", email: "jane@example.com", phone: "0712345678", assessmentNumber: "AN-1" };
const { signProfileToken } = require("../utils/reportLink");

suite("reportProfileWhileClosed.test.js");

test("closed (not open yet): verify still asks a student with no profile to fill it in", async () => {
  world();
  const r = await call(handler("post", "/verify"), { body: { username: "jane" }, pool: currentPool });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.status, "profile_required");
  assert.strictEqual(r.body.downloadsOpen, false);
  assert.ok(/not open yet/i.test(r.body.downloadsMessage));
  assert.ok(r.body.token);
});

test("closed: a student whose profile is saved is told downloads are closed (403), and that their details are saved", async () => {
  world({ student: { profileCompleted: 1 } });
  const r = await call(handler("post", "/verify"), { body: { username: "jane" } });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.code, "DOWNLOADS_NOT_OPEN");
  assert.ok(/already saved/i.test(r.body.message));
});

test("closed: /profile saves the details but gives NO report session or token", async () => {
  const { st, pool } = world();
  const token = signProfileToken({ studentId: 7, tenant: "default" });
  const r = await call(handler("post", "/profile"), { body: profileBody, headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.status, "profile_saved");
  assert.strictEqual(r.body.downloadsOpen, false);
  assert.strictEqual(r.body.token, undefined, "no download session while closed");
  assert.strictEqual(st.profileCompleted, 1);
  assert.ok(pool);
});

test("closed after the window ended: profile still saves", async () => {
  world({ window: { opensAt: new Date(Date.now() - 20 * 86400e3), closesAt: PAST } });
  const token = signProfileToken({ studentId: 7, tenant: "default" });
  const r = await call(handler("post", "/profile"), { body: profileBody, headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.body.status, "profile_saved");
  assert.strictEqual(r.body.code, "DOWNLOADS_CLOSED");
});

test("closed: validation still applies (missing fields are rejected, nothing saved)", async () => {
  const { st } = world();
  const token = signProfileToken({ studentId: 7, tenant: "default" });
  const r = await call(handler("post", "/profile"), { body: { ...profileBody, email: "nope" }, headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(st.profileCompleted, 0);
});

test("open: the profile flow is unchanged (saved -> photo step, then report)", async () => {
  world({ window: { opensAt: null, closesAt: null } });
  const token = signProfileToken({ studentId: 7, tenant: "default" });
  const r = await call(handler("post", "/profile"), { body: profileBody, headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.body.status, "photo_required");
  world({ window: { opensAt: null, closesAt: null }, student: { photoUrl: "/uploads/p.jpg" } });
  const t2 = signProfileToken({ studentId: 7, tenant: "default" });
  const r2 = await call(handler("post", "/profile"), { body: profileBody, headers: { authorization: `Bearer ${t2}` } });
  assert.strictEqual(r2.body.status, "ready");
  assert.ok(r2.body.token);
});

test("inactive students still cannot use the page, closed or not", async () => {
  world({ student: { status: "suspended" } });
  const r = await call(handler("post", "/verify"), { body: { username: "jane" } });
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.code, "STUDENT_INACTIVE");
});

test("GET /info: admin message, state and both logos for the public page (no login)", async () => {
  world();
  const r = await call(handler("get", "/info"), { pool: currentPool });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.state, "not_open");
  assert.strictEqual(r.body.notice, "Reports open on Monday. Update your details first!");
  assert.strictEqual(r.body.school.logoUrl, "/uploads/logo.png");
  assert.strictEqual(r.body.school.governmentLogoUrl, "/uploads/gov.png");
  assert.strictEqual(r.body.school.name, "Asumbi Girls");
  assert.ok(r.body.opensAt);
});

test("GET /info: open window, no message, no school settings -> still answers", async () => {
  world({ window: { opensAt: null, closesAt: null }, notice: null });
  currentPool = makeMockPool([["FROM ReportDownloadAccess WHERE id = 1", () => [{ mode: "both", opensAt: null, closesAt: null }]]]).pool;
  const r = await call(handler("get", "/info"), { pool: currentPool });
  assert.strictEqual(r.body.state, "open");
  assert.strictEqual(r.body.notice, "");
  assert.strictEqual(r.body.school.logoUrl, null);
});

test("cleanNotice trims, normalises line breaks and caps at 1000 characters", () => {
  assert.strictEqual(cleanNotice("  hi\r\nthere  "), "hi\nthere");
  assert.strictEqual(cleanNotice(null), "");
  assert.strictEqual(cleanNotice("x".repeat(1500)).length, 1000);
});

/* ---- admin list ---- */
const listPool = (rows, sum, calls) => ({
  request() {
    const inputs = {};
    const rq = { input(n, _t, v) { inputs[n] = v; return rq; },
      async query(text) {
        calls.push({ text: text.replace(/\s+/g, " "), inputs: { ...inputs } });
        if (/SELECT DISTINCT studentClass/.test(text)) return { recordset: [{ studentClass: "Form 1" }, { studentClass: "Form 4" }] };
        return { recordsets: [rows, [sum]] };
      } };
    return rq;
  },
});

test("admin profile-status: counts, classes, filters (pending only, class, search)", async () => {
  const calls = [];
  const rows = [{ id: 1, name: "A", username: "a", studentClass: "Form 4", phone: "", email: "", profileCompleted: 0, hasPhoto: 0 }];
  const pool = listPool(rows, { total: 10, completed: 7 }, calls);
  const r = await call(getProfileStatusAdmin, { pool, query: { status: "pending", class: "Form 4", search: "ann" } });
  assert.strictEqual(r.body.success, true);
  assert.deepStrictEqual(r.body.summary, { total: 10, completed: 7, pending: 3 });
  assert.deepStrictEqual(r.body.classes, ["Form 1", "Form 4"]);
  assert.strictEqual(r.body.items[0].profileCompleted, false);
  const q = calls[0];
  assert.ok(/ISNULL\(profileCompleted, 0\) = 0/.test(q.text));
  assert.ok(/studentClass = @cls/.test(q.text));
  assert.strictEqual(q.inputs.cls, "Form 4");
  assert.strictEqual(q.inputs.s, "%ann%");
  // the summary (second statement) ignores the status tab, so the tab counts stay right
  const summaryStatement = q.text.split("; ")[1];
  assert.ok(/FROM Students WHERE/.test(summaryStatement));
  assert.ok(!/ISNULL\(profileCompleted, 0\) = 0/.test(summaryStatement), "summary must not be filtered by status");
});

test("admin profile-status: default is everyone active, 'all' class ignored, bad status falls back to all", async () => {
  const calls = [];
  const pool = listPool([], { total: 0, completed: null }, calls);
  const r = await call(getProfileStatusAdmin, { pool, query: { status: "weird", class: "all" } });
  assert.deepStrictEqual(r.body.summary, { total: 0, completed: 0, pending: 0 });
  assert.ok(!/@cls/.test(calls[0].text));
  assert.ok(/IN \('', 'active'\)/.test(calls[0].text));
});

/* ---- admin saves the typed message ---- */
const { putDownloadAccessAdmin } = require("../utils/downloadAccess");
test("admin PUT saves the typed message; leaving it out keeps the saved one", async () => {
  let saved = null;
  const row = { mode: "report", opensAt: null, closesAt: null, requirePhoto: true, transcriptExamIds: null, pageNotice: "old message" };
  const mk = () => ({
    request() {
      const inputs = {};
      const rq = { input(n, _t, v) { inputs[n] = v; return rq; },
        async query(text) {
          if (/UPDATE ReportDownloadAccess/.test(text)) { saved = { ...inputs }; row.pageNotice = inputs.notice; return { recordset: [] }; }
          if (/FROM ReportDownloadAccess WHERE id = 1/.test(text)) return { recordset: [{ ...row }] };
          return { recordset: [] };
        } };
      return rq;
    },
  });
  let r = await call(putDownloadAccessAdmin, { pool: mk(), user: { id: 1 }, body: { mode: "report", notice: "  Reports open Monday 8am.  " } });
  assert.strictEqual(saved.notice, "Reports open Monday 8am.");
  assert.strictEqual(r.body.notice, "Reports open Monday 8am.");
  r = await call(putDownloadAccessAdmin, { pool: mk(), user: { id: 1 }, body: { mode: "report" } }); // no `notice` sent
  assert.strictEqual(saved.notice, "Reports open Monday 8am.");
  r = await call(putDownloadAccessAdmin, { pool: mk(), user: { id: 1 }, body: { mode: "report", notice: "" } }); // cleared on purpose
  assert.strictEqual(saved.notice, null);
  assert.strictEqual(r.body.notice, "");
});
