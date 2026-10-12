/* "Require Safe Exam Browser" switch: real utils/sebRestriction.js against a fake pool. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("sebRestriction.test.js");

const seb = require("../utils/sebRestriction");

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const URL_ = "https://api.example.com/api/e-assessments/5/draft";

const mkReq = ({ headers = {}, user = { id: 7, role: "student" } } = {}) => {
  const h = { host: "api.example.com", "x-forwarded-proto": "https", ...headers };
  return { user, protocol: "http", originalUrl: "/api/e-assessments/5/draft", get: (n) => h[String(n).toLowerCase()] };
};
function mkPool(row) {
  const log = [];
  return { log, request() { const r = { input() { return r; }, async query(q) { log.push(q); return { recordset: row ? [row] : [] }; } }; return r; } };
}
let n = 0;
const tenant = () => `s${++n}`;

test("switch OFF: everything passes", async () => {
  const r = await seb.checkSeb(mkReq(), mkPool({ require_seb: 0, seb_keys: null }), tenant(), 5);
  assert.strictEqual(r.blocked, false);
});

test("switch ON with a key: a correct RequestHash passes", async () => {
  const req = mkReq({ headers: { "x-safeexambrowser-requesthash": seb.sha256hex(URL_ + KEY) } });
  const r = await seb.checkSeb(req, mkPool({ require_seb: 1, seb_keys: KEY }), tenant(), 5);
  assert.strictEqual(r.blocked, false); assert.strictEqual(r.mode, "key");
});

test("a correct ConfigKeyHash also passes", async () => {
  const req = mkReq({ headers: { "x-safeexambrowser-configkeyhash": seb.sha256hex(URL_ + KEY) } });
  const r = await seb.checkSeb(req, mkPool({ require_seb: 1, seb_keys: `${OTHER}\n${KEY}` }), tenant(), 5);
  assert.strictEqual(r.blocked, false);
});

test("a normal browser (no SEB headers) is blocked", async () => {
  const r = await seb.checkSeb(mkReq(), mkPool({ require_seb: 1, seb_keys: KEY }), tenant(), 5);
  assert.strictEqual(r.blocked, true);
});

test("a spoofed 'SEB/3.5' User-Agent is NOT enough once a key is saved", async () => {
  const req = mkReq({ headers: { "user-agent": "Mozilla/5.0 SEB/3.5.0" } });
  const r = await seb.checkSeb(req, mkPool({ require_seb: 1, seb_keys: KEY }), tenant(), 5);
  assert.strictEqual(r.blocked, true);
});

test("a hash made with the wrong key, or for a different URL, is blocked", async () => {
  const wrongKey = mkReq({ headers: { "x-safeexambrowser-requesthash": seb.sha256hex(URL_ + OTHER) } });
  const wrongUrl = mkReq({ headers: { "x-safeexambrowser-requesthash": seb.sha256hex("https://api.example.com/api/other" + KEY) } });
  const pool = () => mkPool({ require_seb: 1, seb_keys: KEY });
  assert.strictEqual((await seb.checkSeb(wrongKey, pool(), tenant(), 5)).blocked, true);
  assert.strictEqual((await seb.checkSeb(wrongUrl, pool(), tenant(), 5)).blocked, true);
});

test("no key saved yet: falls back to the SEB User-Agent token", async () => {
  const pool = () => mkPool({ require_seb: 1, seb_keys: null });
  const ok = await seb.checkSeb(mkReq({ headers: { "user-agent": "Mozilla/5.0 Chrome/120 SEB/3.5.0" } }), pool(), tenant(), 5);
  const no = await seb.checkSeb(mkReq({ headers: { "user-agent": "Mozilla/5.0 Chrome/120" } }), pool(), tenant(), 5);
  assert.strictEqual(ok.blocked, false); assert.strictEqual(no.blocked, true);
});

test("PUBLIC_API_ORIGIN overrides the rebuilt URL", async () => {
  process.env.PUBLIC_API_ORIGIN = "https://custom.example.org";
  try {
    const req = mkReq({ headers: { "x-safeexambrowser-requesthash": seb.sha256hex("https://custom.example.org/api/e-assessments/5/draft" + KEY) } });
    const r = await seb.checkSeb(req, mkPool({ require_seb: 1, seb_keys: KEY }), tenant(), 5);
    assert.strictEqual(r.blocked, false);
  } finally { delete process.env.PUBLIC_API_ORIGIN; }
});

test("a database error fails open", async () => {
  const pool = { request() { const r = { input() { return r; }, async query() { throw new Error("db down"); } }; return r; } };
  const r = await seb.checkSeb(mkReq(), pool, tenant(), 5);
  assert.strictEqual(r.blocked, false);
});

test("parseKeys keeps valid 64-hex keys, lowercases, de-duplicates and reports junk", () => {
  const { keys, invalid } = seb.parseKeys(`${KEY.toUpperCase()}\n${KEY}, ${OTHER}\nnot-a-key`);
  assert.deepStrictEqual(keys, [KEY, OTHER]); assert.deepStrictEqual(invalid, ["not-a-key"]);
});

test("middleware: staff untouched, student blocked with 403 SEB_REQUIRED", async () => {
  const mkRes = () => { const r = { code: null, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  let called = 0;
  const staff = mkReq({ user: { id: 1, role: "admin" } }); staff.pool = mkPool({ require_seb: 1, seb_keys: KEY }); staff.params = { id: "5" };
  await seb.enforceSeb(staff, mkRes(), () => called++); assert.strictEqual(called, 1);
  const stu = mkReq(); stu.pool = mkPool({ require_seb: 1, seb_keys: KEY }); stu.params = { id: "5" }; stu.user.tenant = tenant();
  const res = mkRes(); await seb.enforceSeb(stu, res, () => called++);
  assert.strictEqual(called, 1); assert.strictEqual(res.code, 403); assert.strictEqual(res.body.code, "SEB_REQUIRED");
});
