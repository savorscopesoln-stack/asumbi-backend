/* "Read notifications are archived": marking read (single or all) must set
   archivedAt; the inbox must hide archived rows; ?archived=1 must return only
   archived rows (capped); unread-count is unaffected. Runs the real router
   against a recording mock pool. */
const Module = require("module");
const { suite, test, assert } = require("./helpers/tinytest");

// The router only needs sql types + an auth passthrough; stub those two requires.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "../middleware/authMiddleware") return { authorize: () => (req, res, next) => next() };
  if (request === "../config/db") return { sql: require("mssql"), poolPromise: null };
  return realLoad.call(this, request, ...rest);
};
const router = require("../routes/notifications.js");
Module._load = realLoad;

suite("notificationsArchive.test.js");

async function call(method, url, query = {}) {
  const log = [];
  const inputs = {};
  const pool = { request() { const r = { input(n, t, v) { inputs[n] = v; return r; }, query: async (q) => { log.push(q.replace(/\s+/g, " ").trim()); return { recordset: [] }; } }; return r; } };
  const layer = router.stack.find((l) => l.route && l.route.path === url && l.route.methods[method]);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  await handle({ pool, user: { id: 1, source: "Students" }, params: { id: 5 }, query, body: {} }, { json() {}, status() { return this; } });
  return { sqlText: log[0], inputs };
}

test("inbox excludes archived notifications", async () => {
  const { sqlText } = await call("get", "/");
  assert.ok(sqlText.includes("archivedAt IS NULL") && !sqlText.includes("TOP"));
});

test("?archived=1 returns only archived rows, newest-archived first, capped", async () => {
  const { sqlText, inputs } = await call("get", "/", { archived: "1" });
  assert.ok(sqlText.includes("archivedAt IS NOT NULL") && sqlText.includes("ORDER BY archivedAt DESC"));
  assert.strictEqual(inputs.limit, 200);
  assert.strictEqual((await call("get", "/", { archived: "1", limit: "99999" })).inputs.limit, 500);
  assert.strictEqual((await call("get", "/", { archived: "true", limit: "-5" })).inputs.limit, 1);
});

test("marking one read archives it (without overwriting an earlier archive time)", async () => {
  const { sqlText } = await call("put", "/:id/read");
  assert.ok(sqlText.includes("isRead = 1") && sqlText.includes("archivedAt = ISNULL(archivedAt, GETDATE())"));
});

test("mark-all-read archives every inbox row for the user only", async () => {
  const { sqlText } = await call("put", "/read-all");
  assert.ok(sqlText.includes("isRead = 1, archivedAt = GETDATE()"));
  assert.ok(sqlText.includes("recipientId = @id AND recipientSource = @source AND archivedAt IS NULL"));
});

test("unread-count still counts unread only", async () => {
  const { sqlText } = await call("get", "/unread-count");
  assert.ok(sqlText.includes("isRead = 0"));
});
