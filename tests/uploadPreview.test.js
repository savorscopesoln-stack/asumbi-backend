/* L11.6: /api/upload/preview (routes/users.js): dry run, admin only, no DB, no disk, no row data in logs.
   Real express + real multer over http. Also guards that the weaker legacy duplicates stay unmounted. */
const { suite, test, assert } = require("./helpers/tinytest");
const fs = require("fs"), path = require("path"), http = require("http");
const express = require("express"); const XLSX = require("xlsx");
const { adminOnly } = require("../middleware/authMiddleware");
suite("uploadPreview.test.js");

const router = require("../routes/users");
const mk = (role) => { const app = express(); app.use((q, r, n) => { q.user = role ? { role, id: 1 } : undefined; n(); }); app.use("/api/upload/preview", adminOnly, router); return app; };
const withServer = async (app, fn) => { const srv = http.createServer(app); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const base = "http://127.0.0.1:" + srv.address().port; try { return await fn(base); } finally { srv.close(); } };
const xbuf = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "S"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };
const post = (base, type, buf, name) => { const f = new FormData(); if (type) f.append("type", type); if (buf) f.append("file", new Blob([buf]), name || "f.xlsx"); return fetch(base + "/api/upload/preview", { method: "POST", body: f }); };

test("admin: a valid students file gets counts, preview and no problems", () => withServer(mk("admin"), async (b) => {
  const r = await post(b, "students", xbuf([{ name: "A", admissionNo: "1" }, { name: "B", admissionNo: "2" }])); const j = await r.json();
  assert.strictEqual(r.status, 200); assert.strictEqual(j.rows, 2); assert.strictEqual(j.valid, 2); assert.strictEqual(j.invalid, 0); assert.deepStrictEqual(j.missingColumns, []); assert.strictEqual(j.preview.length, 2);
}));
test("missing required values and duplicates are reported with row numbers", () => withServer(mk("admin"), async (b) => {
  const r = await post(b, "students", xbuf([{ name: "A", admissionNo: "1" }, { name: "", admissionNo: "2" }, { name: "C", admissionNo: "1" }])); const j = await r.json();
  assert.strictEqual(j.valid, 1); assert.strictEqual(j.invalid, 2); assert.strictEqual(j.duplicates, 1);
  assert.deepStrictEqual(j.problems.map((p) => p.row), [3, 4]);
}));
test("a student row with a name but no admissionNo is invalid (and the reverse)", () => withServer(mk("admin"), async (b) => {
  const j = await (await post(b, "students", xbuf([{ name: "A", admissionNo: "" }, { name: "", admissionNo: "9" }, { name: "B", admissionNo: "2" }]))).json();
  assert.strictEqual(j.valid, 1); assert.strictEqual(j.invalid, 2); assert.ok(/admissionNo/.test(j.problems[0].reason)); assert.ok(/name/.test(j.problems[1].reason));
}));
test("a missing column is named (teachers without staffId)", () => withServer(mk("admin"), async (b) => {
  const j = await (await post(b, "teachers", xbuf([{ name: "T" }]))).json();
  assert.deepStrictEqual(j.missingColumns, ["staffId"]); assert.strictEqual(j.valid, 0);
}));
test("non-admin roles and anonymous are refused before the file is read", () => Promise.all([["teacher", 403], ["student", 403], [null, 401]].map(([role, want]) => withServer(mk(role), async (b) => {
  const r = await post(b, "students", xbuf([{ name: "A", admissionNo: "1" }])); assert.strictEqual(r.status, want, role + " got " + r.status);
}))));
test("bad type, no file, empty file are 400", () => withServer(mk("admin"), async (b) => {
  assert.strictEqual((await post(b, "admins", xbuf([{ a: 1 }]))).status, 400);
  assert.strictEqual((await post(b, "students", null)).status, 400);
  assert.strictEqual((await post(b, "students", Buffer.from("name,admissionNo\n"))).status, 400);
}));
test("over 5 MB is 413 and non-spreadsheet bytes are 400", () => withServer(mk("admin"), async (b) => {
  assert.strictEqual((await post(b, "students", Buffer.alloc(5 * 1024 * 1024 + 10, 65), "big.csv")).status, 413);
  assert.strictEqual((await post(b, "students", Buffer.from([0x4d, 0x5a, 0, 0, 3, 0]))).status, 400);
}));
test("no row data is written to the console or to disk", () => withServer(mk("admin"), async (b) => {
  const seen = []; const orig = { log: console.log, info: console.info, error: console.error }; const before = fs.readdirSync(require("os").tmpdir()).length;
  console.log = console.info = console.error = (...a) => seen.push(a.join(" "));
  try { await post(b, "students", xbuf([{ name: "SecretName", admissionNo: "ADM9" }])); } finally { Object.assign(console, orig); }
  assert.ok(!seen.join(" ").includes("SecretName"), "row data was logged");
  assert.ok(!/readFile|tmpdir|diskStorage|console\./.test(fs.readFileSync(path.join(__dirname, "../routes/users.js"), "utf8").replace(/\/\*[\s\S]*?\*\//, "")), "users.js must not use disk or console");
  assert.ok(fs.readdirSync(require("os").tmpdir()).length <= before + 5, "tmp dir grew");
}));
test("server.js mounts the preview behind protect + adminOnly, before /api/upload", () => {
  const s = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const a = s.indexOf('app.use("/api/upload/preview", protect, adminOnly, require("./routes/users"))'); const b = s.indexOf('app.post("/api/upload", protect, adminOnly');
  assert.ok(a > 0 && b > a, "preview mount missing or after /api/upload");
});
test("GUARD: the weaker legacy duplicates are NOT mounted (role from file, fixed passwords, no admin check)", () => {
  const s = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  for (const f of ["routes/upload", "routes/TeacherRoutes", "routes/uploadRoutes"]) assert.ok(!s.includes('require("./' + f), f + " must stay unmounted (D-145)");
});
