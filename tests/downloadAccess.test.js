const Module = require("module");
const { suite, test, assert } = require("./helpers/tinytest");
try { require.resolve("mssql"); } catch (_) {
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "mssql") return { DateTime: 1, NVarChar: () => 2, Int: 3 };
    return orig.call(this, request, ...rest);
  };
}
const { checkDownload, windowState, publicView } = require("../utils/downloadAccess");

const poolWith = (row) => ({ request: () => ({ input() { return this; }, query: async () => ({ recordset: row ? [row] : [] }) }) });
const at = (iso) => new Date(iso).getTime();

suite("downloadAccess.test.js");

test("nothing saved: open, report form only (unchanged behaviour)", async () => {
  const r = await checkDownload(poolWith(null), "any");
  assert.strictEqual(r.ok, true);
  assert.strictEqual((await checkDownload(poolWith(null), "transcript")).ok, false);
  assert.strictEqual((await checkDownload(poolWith(null), "report")).ok, true);
});

test("window: not open before opensAt, closed from closesAt", async () => {
  const row = { mode: "both", opensAt: new Date("2026-11-20T06:00:00Z"), closesAt: new Date("2026-11-30T06:00:00Z") };
  const before = await checkDownload(poolWith(row), "any", at("2026-11-19T00:00:00Z"));
  assert.strictEqual(before.code, "DOWNLOADS_NOT_OPEN");
  assert.strictEqual((await checkDownload(poolWith(row), "any", at("2026-11-25T00:00:00Z"))).ok, true);
  assert.strictEqual((await checkDownload(poolWith(row), "any", at("2026-11-30T06:00:00Z"))).code, "DOWNLOADS_CLOSED");
});

test("mode decides what is offered", async () => {
  const both = { mode: "both", opensAt: null, closesAt: null };
  const tr = { mode: "transcript", opensAt: null, closesAt: null };
  assert.strictEqual((await checkDownload(poolWith(both), "report")).ok, true);
  assert.strictEqual((await checkDownload(poolWith(both), "transcript")).ok, true);
  assert.strictEqual((await checkDownload(poolWith(tr), "report")).ok, false);
  assert.strictEqual((await checkDownload(poolWith(tr), "transcript")).ok, true);
});

test("publicView gives ISO times", () => {
  const v = publicView({ mode: "both", opensAt: new Date("2026-11-20T06:00:00Z"), closesAt: null });
  assert.deepStrictEqual(v, { mode: "both", opensAt: "2026-11-20T06:00:00.000Z", closesAt: null, requirePhoto: true, transcriptExamIds: null });
  assert.strictEqual(windowState({ opensAt: null, closesAt: null }).open, true);
});

test("photo requirement defaults ON and can be switched OFF", async () => {
  assert.strictEqual((await checkDownload(poolWith(null), "any")).access.requirePhoto, true);
  const off = await checkDownload(poolWith({ mode: "report", opensAt: null, closesAt: null, requirePhoto: false }), "any");
  assert.strictEqual(off.access.requirePhoto, false);
  assert.strictEqual(publicView(off.access).requirePhoto, false);
});

test("transcript exams: stored list is parsed, empty means all", async () => {
  const one = await checkDownload(poolWith({ mode: "both", opensAt: null, closesAt: null, requirePhoto: true, transcriptExamIds: "4, 7,x,7" }), "any");
  assert.deepStrictEqual(one.access.transcriptExamIds, [4, 7]);
  const none = await checkDownload(poolWith({ mode: "both", opensAt: null, closesAt: null, transcriptExamIds: "" }), "any");
  assert.strictEqual(none.access.transcriptExamIds, null);
});
