/* .seb file format: double gzip ("plnd" + gzip(plist)), and upload validation. */
const zlib = require("zlib");
const { suite, test, assert } = require("./helpers/tinytest");
suite("sebConfigFile.test.js");
const { buildSebFile, inspectSebFile } = require("../utils/sebConfigFile");

const PLIST = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>startURL</key><string>https://x.co.ke/take-assessment/5</string></dict></plist>`;

test("built file = gzip('plnd' + gzip(plist))  (two layers, the macOS crash fix)", async () => {
  const outer = zlib.gunzipSync(buildSebFile(PLIST));
  assert.strictEqual(outer.slice(0, 4).toString(), "plnd");
  const inner = outer.slice(4);
  assert.strictEqual(inner[0], 0x1f); assert.strictEqual(inner[1], 0x8b); // inner gzip magic
  assert.strictEqual(zlib.gunzipSync(inner).toString("utf8"), PLIST);
});

test("built file is deterministic (Config Key stays stable)", async () => {
  assert.ok(buildSebFile(PLIST).equals(buildSebFile(PLIST)));
});

test("inspect accepts our own file and reads the start URL", async () => {
  const r = inspectSebFile(buildSebFile(PLIST));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, "plain");
  assert.strictEqual(r.startURL, "https://x.co.ke/take-assessment/5");
});

test("inspect accepts a bare XML plist and an encrypted prefix", async () => {
  assert.strictEqual(inspectSebFile(Buffer.from(PLIST)).ok, true);
  assert.strictEqual(inspectSebFile(zlib.gzipSync(Buffer.from("pswdSECRETDATA"))).kind, "encrypted");
});

test("inspect rejects the OLD broken single-layer format, junk and empty", async () => {
  assert.strictEqual(inspectSebFile(zlib.gzipSync(Buffer.from("plnd" + "garbage"))).ok, false);
  assert.strictEqual(inspectSebFile(Buffer.from("hello world")).ok, false);
  assert.strictEqual(inspectSebFile(Buffer.alloc(0)).ok, false);
});
