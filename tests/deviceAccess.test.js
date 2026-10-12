/* Desktop-only switch: rejected-device log + per-device allow-list.
   Runs the real utils/deviceRestriction.js and the admin controller handlers
   against a tiny fake pool (no live SQL Server). */
const { suite, test, assert } = require("./helpers/tinytest");
suite("deviceAccess.test.js");

const dr = require("../utils/deviceRestriction");
const ctrl = require("../controllers/eAssessment.controller");

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 13; SM-A137F) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const mkReq = ({ ua = ANDROID_UA, client = null, user = { id: 7, role: "student" } } = {}) => {
  const headers = { "user-agent": ua };
  if (client) headers["x-client-device"] = JSON.stringify(client);
  return { user, headers: {}, ip: "10.0.0.5", get: (n) => headers[String(n).toLowerCase()] };
};

// Fake pool: routes a query to a handler by SQL text; records every query.
function mkPool(handlers) {
  const log = [];
  return { log, request() {
    const inputs = {};
    const r = { input(n, t, v) { inputs[n] = v === undefined ? t : v; return r; },
      async query(q) {
        log.push({ q: q.replace(/\s+/g, " ").trim(), inputs: { ...inputs } });
        for (const [re, fn] of handlers) if (re.test(q)) return fn(inputs, q);
        return { recordset: [] };
      } };
    return r;
  } };
}
let tenantN = 0;
const freshTenant = () => `t${++tenantN}`; // isolates the module's in-memory caches between tests
const flush = () => new Promise((r) => setImmediate(r));
const restricted = [/SELECT ISNULL\(desktop_only/, () => ({ recordset: [{ desktop_only: 1 }] })];
const unrestricted = [/SELECT ISNULL\(desktop_only/, () => ({ recordset: [{ desktop_only: 0 }] })];

test("a Windows laptop never touches the database", async () => {
  const pool = mkPool([]);
  const r = await dr.checkDesktopOnly(mkReq({ ua: WIN_UA }), pool, freshTenant(), 5);
  assert.strictEqual(r.blocked, false); assert.strictEqual(pool.log.length, 0);
});

test("Android on a Desktop-only exam is blocked AND recorded with its platform and device id", async () => {
  const pool = mkPool([restricted]);
  const req = mkReq({ client: { deviceId: "dev-1234567890", uaPlatform: "Android", mobile: true, maxTouchPoints: 5 } });
  const r = await dr.checkDesktopOnly(req, pool, freshTenant(), 5);
  await flush();
  assert.strictEqual(r.blocked, true); assert.strictEqual(r.device.platform, "android");
  const w = pool.log.find((l) => /UPDATE e_assessment_device_access/.test(l.q));
  assert.ok(w, "rejection must be written");
  assert.deepStrictEqual([w.inputs.aid, w.inputs.sid, w.inputs.dk, w.inputs.platform], [5, 7, "dev-1234567890", "android"]);
  assert.ok(/Android/.test(w.inputs.ua) && w.inputs.ip === "10.0.0.5");
});

test("an admin-allowed device (this student + this assessment) gets through while the switch is ON", async () => {
  const pool = mkPool([restricted, [/status = 'allowed'/, () => ({ recordset: [{ ok: 1 }] })]]);
  const r = await dr.checkDesktopOnly(mkReq({ client: { deviceId: "dev-1234567890" } }), pool, freshTenant(), 5);
  await flush();
  assert.strictEqual(r.blocked, false); assert.strictEqual(r.allowedByAdmin, true);
  assert.ok(!pool.log.some((l) => /device_access SET|UPDATE e_assessment_device_access|INSERT/.test(l.q)), "no rejection recorded for an allowed device");
});

test("the allow-list lookup is scoped to assessment, student AND device", async () => {
  const pool = mkPool([restricted]);
  await dr.checkDesktopOnly(mkReq({ client: { deviceId: "dev-AAAAAAAA" }, user: { id: 42, role: "student" } }), pool, freshTenant(), 9);
  const l = pool.log.find((x) => /status = 'allowed'/.test(x.q));
  assert.deepStrictEqual([l.inputs.aid, l.inputs.sid, l.inputs.dk], [9, 42, "dev-AAAAAAAA"]);
});

test("a phone on an exam that is NOT desktop-only passes and nothing is recorded", async () => {
  const pool = mkPool([unrestricted]);
  const r = await dr.checkDesktopOnly(mkReq(), pool, freshTenant(), 5);
  await flush();
  assert.strictEqual(r.blocked, false);
  assert.ok(!pool.log.some((l) => /device_access/.test(l.q)));
});

test("repeated heartbeats from a blocked phone write at most once a minute", async () => {
  const pool = mkPool([restricted]);
  const tenant = freshTenant();
  const req = mkReq({ client: { deviceId: "dev-REPEAT-001" } });
  for (let i = 0; i < 6; i++) await dr.checkDesktopOnly(req, pool, tenant, 5);
  await flush();
  assert.strictEqual(pool.log.filter((l) => /UPDATE e_assessment_device_access/.test(l.q)).length, 1);
});

test("exam-login (no token yet) identifies the student from the username they typed", async () => {
  const pool = mkPool([restricted, [/SELECT id FROM Students WHERE username/, (i) => ({ recordset: i.u === "ama" ? [{ id: 31 }] : [] })]]);
  const req = mkReq({ user: null, client: { deviceId: "dev-LOGIN-0001" } });
  const r = await dr.checkDesktopOnly(req, pool, freshTenant(), 5, { username: "ama" });
  await flush();
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(pool.log.find((l) => /UPDATE e_assessment_device_access/.test(l.q)).inputs.sid, 31);
});

test("if the allow lookup fails the restriction stands (never silently opens the exam)", async () => {
  const pool = mkPool([restricted, [/status = 'allowed'/, () => { throw new Error("db down"); }]]);
  const r = await dr.checkDesktopOnly(mkReq({ client: { deviceId: "dev-FAILFAIL" } }), pool, freshTenant(), 5);
  assert.strictEqual(r.blocked, true);
});

test("device key: the browser's own device id wins; otherwise a stable hash of the User-Agent", () => {
  assert.strictEqual(dr.deviceKeyFor(mkReq({ client: { deviceId: "abc-12345678" } })), "abc-12345678");
  const a = dr.deviceKeyFor(mkReq()), b = dr.deviceKeyFor(mkReq()), c = dr.deviceKeyFor(mkReq({ ua: WIN_UA }));
  assert.ok(a.startsWith("ua:") && a === b && a !== c);
  assert.ok(dr.deviceKeyFor(mkReq({ client: { deviceId: "x'; DROP--" } })).startsWith("ua:"), "junk ids are rejected, not stored");
});

/* ---------------- admin endpoints ---------------- */
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test("GET device-access: filters by status/platform/assessment with bound parameters", async () => {
  const rows = [{ id: 1, platform: "android", status: "blocked" }];
  const pool = mkPool([[/FROM e_assessment_device_access d/, () => ({ recordset: rows })]]);
  const res = mkRes();
  await ctrl.getDeviceAccess({ pool, query: { status: "blocked", platform: "Android", assessmentId: "5" } }, res);
  assert.deepStrictEqual(res.body, rows);
  const q = pool.log[0];
  assert.ok(/d\.status = @status/.test(q.q) && /d\.platform = @platform/.test(q.q) && /d\.e_assessment_id = @aid/.test(q.q));
  assert.deepStrictEqual([q.inputs.status, q.inputs.platform, q.inputs.aid], ["blocked", "android", 5]);
  const bad = mkPool([[/FROM e_assessment_device_access d/, () => ({ recordset: [] })]]);
  await ctrl.getDeviceAccess({ pool: bad, query: { status: "x'; DROP TABLE t;--", platform: "a';--" } }, mkRes());
  assert.ok(!/DROP/.test(bad.log[0].q), "user input is never concatenated into SQL");
});

test("allow / revoke: updates the row, records who allowed it, names the exam for the activity log, takes effect at once", async () => {
  const tenant = freshTenant();
  const pool = mkPool([[/UPDATE e_assessment_device_access\s+SET status/, () => ({ recordset: [{ e_assessment_id: 5 }] })]]);
  const req = { pool, params: { id: "11" }, user: { id: 2, role: "admin" } };
  let res = mkRes();
  await ctrl.allowDevice(req, res);
  assert.strictEqual(res.body.success, true); assert.strictEqual(res.body.status, "allowed");
  assert.strictEqual(req._auditAssessmentId, 5);
  let u = pool.log[0];
  assert.deepStrictEqual([u.inputs.id, u.inputs.status, u.inputs.by], [11, "allowed", 2]);
  res = mkRes();
  await ctrl.revokeDevice({ pool, params: { id: "11" }, user: { id: 2 } }, res);
  u = pool.log[1];
  assert.deepStrictEqual([u.inputs.status, u.inputs.by], ["blocked", null]);
  const missing = mkRes();
  await ctrl.allowDevice({ pool: mkPool([]), params: { id: "99" }, user: { id: 2 } }, missing);
  assert.strictEqual(missing.code, 404);
  const bad = mkRes();
  await ctrl.allowDevice({ pool, params: { id: "abc" }, user: { id: 2 } }, bad);
  assert.strictEqual(bad.code, 400);
});

test("after Allow the very next request from that device passes (cache is cleared)", async () => {
  const tenant = freshTenant();
  let allowed = false;
  // the UPDATE handler must come first: its SQL also contains "status = 'allowed'"
  const pool = mkPool([restricted,
    [/UPDATE e_assessment_device_access\s+SET status/, () => { allowed = true; return { recordset: [{ e_assessment_id: 5 }] }; }],
    [/status = 'allowed'/, () => ({ recordset: allowed ? [{ ok: 1 }] : [] })]]);
  const req = mkReq({ client: { deviceId: "dev-FLIPFLIP1" } });
  assert.strictEqual((await dr.checkDesktopOnly(req, pool, tenant, 5)).blocked, true);
  await ctrl.allowDevice({ pool, params: { id: "11" }, user: { id: 2 } }, mkRes());
  assert.strictEqual((await dr.checkDesktopOnly(req, pool, tenant, 5)).blocked, false);
});
