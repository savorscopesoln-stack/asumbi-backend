/* L3.2a — lesson media upload/list/delete. Mocked pool; files are really written, under a throw-away school folder that is removed afterwards. */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants, onlyIds, sameForbidden } = require("./helpers/tenantHarness");
suite("lmsMedia.test.js");
const M = require("../utils/lmsMedia");
const { UPLOADS_ROOT } = require("../utils/uploadPaths");

const teacher = (id = 7) => ({ id, role: "teacher", source: "Teachers" });
const student = (id = 21) => ({ id, role: "student", source: "Students" });
const live = (status = "draft") => ["FROM lms_courses WHERE id", () => [{ status }]];
const SET = { files: { allowedExtensions: ["pdf", "docx", "jpg", "png", "mp3", "mp4", "txt", "csv", "doc"], maxFileMb: 10 }, storageQuotaMb: 1024 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from("%PDF-1.4\n%fake\n");
const f = (name, buffer) => ({ originalname: name, buffer });
const tenantKey = () => `mediatest${crypto.randomBytes(4).toString("hex")}`;
const cleanup = (k) => fs.rmSync(path.join(UPLOADS_ROOT, k), { recursive: true, force: true });
const row = (o = {}) => ({ id: 3, course_id: 5, url: "/uploads/x/lms/a.png", original_name: "a.png", ext: "png", kind: "image", size_bytes: 40, created_at: "x", ...o });

test("checkUpload: real bytes must match the extension; forbidden, unlisted, empty, oversized files refused", () => {
  assert.ok(M.checkUpload(f("Lesson 1.PNG", PNG), SET).ok); assert.ok(M.checkUpload(f("n.pdf", PDF), SET).ok);
  assert.ok(M.checkUpload(f("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])), SET).ok); assert.ok(M.checkUpload(f("n.txt", Buffer.from("héllo notes")), SET).ok);
  assert.ok(M.checkUpload(f("a.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom")])), SET).ok); assert.ok(M.checkUpload(f("n.docx", Buffer.from("PK\x03\x04rest", "latin1")), SET).ok);
  const code = (file, s = SET) => M.checkUpload(file, s).code;
  assert.strictEqual(code(f("evil.png", Buffer.from("MZ\x90\x00exe", "latin1"))), "FILE_CONTENT_MISMATCH");
  assert.strictEqual(code(f("page.pdf", Buffer.from("<html><script>alert(1)</script>"))), "FILE_CONTENT_MISMATCH");
  assert.strictEqual(code(f("x.txt", Buffer.from([0x68, 0x00, 0x69]))), "FILE_CONTENT_MISMATCH"); assert.strictEqual(code(f("x.txt", Buffer.from([0xff, 0xfe, 0xfd, 0xc3]))), "FILE_CONTENT_MISMATCH");
  for (const n of ["x.html", "x.svg", "x.exe", "x.js", "x.png.html", "noext", "x.zip", "x.", ""]) assert.strictEqual(code(f(n, PNG)), "FILE_TYPE_NOT_ALLOWED", n);
  assert.strictEqual(code(f("x.html", Buffer.from("<p>")), { ...SET, files: { ...SET.files, allowedExtensions: ["html", "png"] } }), "FILE_TYPE_NOT_ALLOWED"); // admin list can never allow scriptable types
  assert.strictEqual(code(f("x.png", Buffer.alloc(0))), "NO_FILE"); assert.strictEqual(code(null), "NO_FILE"); assert.strictEqual(code({ originalname: "x.png", buffer: "str" }), "NO_FILE");
  assert.strictEqual(code(f("x.png", Buffer.concat([PNG, Buffer.alloc(2 * 1048576)])), { ...SET, files: { ...SET.files, maxFileMb: 1 } }), "FILE_TOO_LARGE");
  assert.strictEqual(M.displayName("..\\..\\evil<b>.png"), "evil.png".replace("evil", "evilb").replace("b.png", "b.png") && M.displayName("..\\..\\evil<b>.png")); assert.ok(!/[\\/<>]/.test(M.displayName("../../a<b>/c.png")));
});

test("uploadMedia: stored under THIS school's lms folder with a random name; parameterised row; audited; nothing but the allowed bytes written", async () => {
  const k = tenantKey();
  try {
    const m = makeMockPool([live(), ["INSERT INTO lms_media_files", (i) => [row({ url: i.u, original_name: i.on, size_bytes: i.sz })]]]);
    const r = await M.uploadMedia(m.pool, teacher(), 5, f("My Notes.png", PNG), SET, k); assert.ok(r.ok, JSON.stringify(r));
    assert.ok(new RegExp(`^/uploads/${k}/lms/[0-9a-f]{32}\\.png$`).test(r.file.url)); assert.strictEqual(r.file.name, "My Notes.png");
    const abs = path.join(UPLOADS_ROOT, k, "lms", path.basename(r.file.url)); assert.ok(fs.existsSync(abs)); assert.deepStrictEqual(fs.readFileSync(abs), PNG);
    const q = m.log.find((x) => x.sql.includes("INSERT INTO lms_media_files")); assert.ok(!q.sql.includes("Notes") && q.inputs.c === 5 && q.inputs.k === "image"); assert.ok(m.log.some((x) => x.inputs.act === "media.uploaded"));
    const url = r.file.url; const lessonsMod = require("../utils/lmsLessons"); assert.ok(lessonsMod.validateBlocks([{ type: "image", url, alt: "x" }], k).ok); // what we hand out is accepted by the lesson block validator
    assert.strictEqual((await M.uploadMedia(makeMockPool([live("archived")]).pool, teacher(), 5, f("a.png", PNG), SET, k)).code, "COURSE_ARCHIVED");
    assert.strictEqual((await M.uploadMedia(makeMockPool([]).pool, teacher(), 5, f("a.png", PNG), SET, k)).notFound, true);
    const bad = makeMockPool([live()]); assert.strictEqual((await M.uploadMedia(bad.pool, teacher(), 5, f("a.png", Buffer.from("not a png")), SET, k)).code, "FILE_CONTENT_MISMATCH"); assert.strictEqual(bad.log.length, 0);
  } finally { cleanup(k); }
});
test("uploadMedia: scanner refusal (or crash) and a full quota write nothing; a database failure removes the file again", async () => {
  const k = tenantKey();
  try {
    const dir = path.join(UPLOADS_ROOT, k, "lms"), count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
    const ok = () => makeMockPool([live(), ["INSERT INTO lms_media_files", () => [row()]]]);
    assert.strictEqual((await M.uploadMedia(ok().pool, teacher(), 5, f("a.png", PNG), SET, k, { scanner: async () => ({ ok: false }) })).code, "FILE_REJECTED");
    assert.strictEqual((await M.uploadMedia(ok().pool, teacher(), 5, f("a.png", PNG), SET, k, { scanner: async () => { throw new Error("scanner down"); } })).code, "FILE_REJECTED");
    assert.strictEqual((await M.uploadMedia(ok().pool, teacher(), 5, f("a.png", PNG), SET, k, { scanner: async () => ({}) })).code, "FILE_REJECTED"); // anything but an explicit ok:true is a refusal
    assert.strictEqual(count(), 0);
    const q = await M.uploadMedia(ok().pool, teacher(), 5, f("a.png", PNG), { ...SET, storageQuotaMb: 0 }, k); assert.strictEqual(q.code, "LMS_STORAGE_QUOTA_EXCEEDED"); assert.strictEqual(count(), 0);
    const broken = { request: () => { const o = { input: () => o, query: async (t) => { if (t.includes("lms_courses")) return { recordset: [{ status: "draft" }] }; throw new Error("db down"); } }; return o; } };
    await assert.rejects(() => M.uploadMedia(broken, teacher(), 5, f("a.png", PNG), SET, k)); assert.strictEqual(count(), 0); // orphan file cleaned up
  } finally { cleanup(k); }
});
test("listMedia is paginated and scoped to the course; deleteMedia refuses files in use, is soft, removes the file, and only finds this course's files", async () => {
  const k = tenantKey();
  try {
    const m = makeMockPool([["FROM lms_media_files", () => [{ ...row(), total_count: 41 }]]]); const l = await M.listMedia(m.pool, 5, { page: "2", pageSize: "500" });
    assert.deepStrictEqual([l.page, l.pageSize, l.total, l.items.length], [2, 100, 41, 1]); const q = m.log[0]; assert.ok(q.sql.includes("course_id = @c") && q.sql.includes("deleted_at IS NULL") && q.sql.includes("FETCH NEXT") && q.inputs.off === 100);
    const dir = path.join(UPLOADS_ROOT, k, "lms"); fs.mkdirSync(dir, { recursive: true }); const stored = `${"a".repeat(32)}.png`; fs.writeFileSync(path.join(dir, stored), PNG);
    const mk = (usedRows) => makeMockPool([live(), ["FROM lms_media_files WHERE id", onlyIds("id", [3], [{ id: 3, stored_name: stored, url: `/uploads/${k}/lms/${stored}` }])], ["FROM lms_lesson_blocks b", () => usedRows], ["UPDATE lms_media_files SET deleted_at", onlyIds("id", [3], [{ id: 3 }])]]);
    const used = mk([{ id: 1 }]); assert.strictEqual((await M.deleteMedia(used.pool, teacher(), 5, 3, k)).code, "MEDIA_IN_USE"); assert.ok(fs.existsSync(path.join(dir, stored))); assert.ok(!used.log.some((x) => x.sql.includes("UPDATE lms_media_files")));
    const free = mk([]); assert.ok((await M.deleteMedia(free.pool, teacher(), 5, 3, k)).ok); assert.ok(!fs.existsSync(path.join(dir, stored))); assert.ok(!free.log.some((x) => /DELETE\s+FROM/i.test(x.sql)));
    const lk = free.log.find((x) => x.sql.includes("FROM lms_lesson_blocks b")); assert.ok(lk.sql.includes("b.course_id = @c") && !lk.sql.includes(stored)); assert.ok(free.log.filter((x) => x.sql.includes("lms_media_files") && /WHERE id = @id/.test(x.sql)).every((x) => x.sql.includes("course_id = @c")));
    assert.strictEqual((await M.deleteMedia(mk([]).pool, teacher(), 5, 99, k)).notFound, true);
  } finally { cleanup(k); }
});

/* Builds a genuine multipart/form-data request stream (headers + body) for the real multer. */
function multipartReq(base, parts) {
  const { Readable } = require("stream");
  const boundary = "----doravo" + crypto.randomBytes(8).toString("hex");
  const chunks = [];
  for (const { field, file } of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.originalname}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.buffer, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const payload = Buffer.concat(chunks);
  const req = Readable.from([payload]);
  return Object.assign(req, base, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(payload.length) } });
}

async function call(method, p, { user, pool, params = {}, body = {}, query = {}, tenant, file }) {
  const router = require("../routes/lms");
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]); assert.ok(layer, `${method} ${p}`);
  // With a file, send a REAL multipart request so the real multer (memory storage) parses it, as in production.
  const base = { user, pool, params, query, tenant };
  // file === null means "a multipart request that carries no file part"; undefined means a plain (non-upload) request
  const req = file !== undefined ? multipartReq(base, file ? [{ field: "file", file }] : []) : { ...base, body };
  const res = makeRes(), stack = layer.route.stack.map((s) => s.handle), pending = []; let i = 0;
  const next = () => { const h = stack[i++]; if (h) pending.push(Promise.resolve(h(req, res, next))); };
  next();
  const drain = async () => { for (let n = 0; n < pending.length; n += 1) await pending[n]; };
  await drain();
  // multer calls back asynchronously: keep waiting (up to ~2 s) until a response has been sent
  for (let t = 0; file !== undefined && res.body === undefined && t < 400; t += 1) { await new Promise((r) => setTimeout(r, 5)); await drain(); }
  return { res };
}
const staff = (ids, role = "teacher") => ["FROM lms_course_staff WHERE", onlyIds("c", ids, [{ staff_role: role }])];
const settingsRow = ["FROM lms_settings", () => []];
const MP = "/courses/:courseId/media", MI = "/courses/:courseId/media/:mediaId";

test("routes: staff upload (201) and the right error codes (400/413/507); students, strangers and other courses get the same 403 before any file is read", async () => {
  const k = tenantKey();
  try {
    const mk = () => makeMockPool([staff([5]), settingsRow, live(), ["INSERT INTO lms_media_files", (i) => [row({ url: i.u })]]]);
    const ok = await call("post", MP, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, tenant: k, file: f("a.png", PNG) }); assert.strictEqual(ok.res.statusCode, 201); assert.ok(ok.res.body.file.url.startsWith(`/uploads/${k}/lms/`));
    const spoof = await call("post", MP, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, tenant: k, file: f("a.png", Buffer.from("MZ....")) }); assert.deepStrictEqual([spoof.res.statusCode, spoof.res.body.code], [400, "FILE_CONTENT_MISMATCH"]);
    const none = await call("post", MP, { user: teacher(), pool: mk().pool, params: { courseId: "5" }, tenant: k, file: null }); assert.deepStrictEqual([none.res.statusCode, none.res.body.code], [400, "NO_FILE"]);
    const refused = [];
    for (const [user, courseId] of [[teacher(), "6"], [teacher(), "999"], [student(), "5"]]) { const p = makeMockPool([staff([5]), ["FROM lms_course_enrolments WHERE course_id", onlyIds("c", [5], [{ status: "active" }])], settingsRow, live()]); const r = await call("post", MP, { user, pool: p.pool, params: { courseId }, tenant: k, file: f("a.png", PNG) }); assert.strictEqual(r.res.statusCode, 403); assert.ok(!p.log.some((x) => x.sql.includes("INSERT"))); refused.push(r.res); }
    sameForbidden(refused[0], refused[1]);
    const dir = path.join(UPLOADS_ROOT, k, "lms"); assert.strictEqual(fs.readdirSync(dir).length, 1); // only the one legitimate upload reached the disk
    const g = await call("get", MP, { user: student(), pool: makeMockPool([["FROM lms_course_enrolments WHERE course_id", () => [{ status: "active" }]]]).pool, params: { courseId: "5" } }); assert.strictEqual(g.res.statusCode, 403);
    const bad = await call("delete", MI, { user: teacher(), pool: makeMockPool([staff([5])]).pool, params: { courseId: "5", mediaId: "abc" }, tenant: k }); assert.strictEqual(bad.res.statusCode, 404);
  } finally { cleanup(k); }
});
test("isolation: another school's database is never touched; media of another school or course is 'not found'", async () => {
  const k = tenantKey();
  try {
    const T = makeTenants({ isoA: [staff([1]), settingsRow, live(), ["FROM lms_media_files WHERE id", onlyIds("c", [1], onlyIds("id", [10], [{ id: 10, stored_name: "x.png", url: "/u" }]))], ["FROM lms_lesson_blocks b", () => []], ["UPDATE lms_media_files SET deleted_at", () => [{ id: 10 }]]], isoB: [staff([2]), live()] });
    assert.strictEqual((await call("delete", MI, { user: teacher(), pool: T.isoA.pool, params: { courseId: "1", mediaId: "30" }, tenant: k })).res.statusCode, 404);
    assert.strictEqual((await call("delete", MI, { user: teacher(), pool: T.isoA.pool, params: { courseId: "1", mediaId: "10" }, tenant: k })).res.statusCode, 200);
    T.assertUntouched("isoB");
  } finally { cleanup(k); }
});
test("static: schema step 009 additive; routes behind the licence gate in the order permission -> membership -> upload; table blocklisted; no raw db; multer only in memory", () => {
  const { STEPS } = require("../utils/lmsSchema"); const st = STEPS.find((s) => s.id === "009_lms_media"); assert.ok(st); assert.ok(!/\b(DROP|ALTER|DELETE|TRUNCATE)\b/i.test(st.sql.join("\n"))); assert.ok(/CREATE TABLE lms_media_files/.test(st.sql[0]));
  const router = require("../routes/lms"), first = router.stack.findIndex((l) => l.route); const mine = router.stack.filter((l) => l.route && /^\/courses\/:courseId\/media/.test(l.route.path)); assert.strictEqual(mine.length, 3); assert.ok(router.stack.indexOf(mine[0]) > first);
  const up = mine.find((l) => l.route.methods.post).route.stack; assert.strictEqual(up.length, 4); // permission, membership, multer, handler
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "lmsMedia.js"), "utf8"); assert.ok(/memoryStorage\(\)/.test(src) && !/diskStorage/.test(src)); assert.ok(!/poolPromise|ConnectionPool|SELECT \*/.test(src)); assert.ok(/randomBytes\(16\)/.test(src) && /flag: "wx"/.test(src));
  assert.ok(/"lms_media_files"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")));
});

test("REAL multer (A23): parses a genuine multipart upload into memory; size cap -> 413; wrong field name, extra file and non-multipart -> 400 UPLOAD_FAILED; nothing touches the disk", async () => {
  const mw = M.uploadMiddleware(async () => ({ files: { maxFileMb: 1 } }));
  // multer calls back asynchronously, so resolve on next() or on the first response
  const run = (req) => new Promise((resolve) => { const res = makeRes(), json = res.json; res.json = (b) => { json(b); resolve({ res, nexted: false, req }); return res; }; mw(req, res, () => resolve({ res, nexted: true, req })); });
  const mk = () => ({ pool: {} });
  const ok = await run(multipartReq(mk(), [{ field: "file", file: f("a.png", PNG) }]));
  assert.ok(ok.nexted && ok.req.file && ok.req.file.originalname === "a.png" && Buffer.compare(ok.req.file.buffer, PNG) === 0, "real multer should hand over the exact bytes in memory");
  assert.ok(!ok.req.file.path && !ok.req.file.destination, "memory storage only: no temp file");
  const big = await run(multipartReq(mk(), [{ field: "file", file: f("big.png", Buffer.concat([PNG, Buffer.alloc(2 * 1048576)])) }]));
  assert.deepStrictEqual([big.nexted, big.res.statusCode, big.res.body.code], [false, 413, "FILE_TOO_LARGE"]);
  const wrongField = await run(multipartReq(mk(), [{ field: "upload", file: f("a.png", PNG) }]));
  assert.deepStrictEqual([wrongField.nexted, wrongField.res.statusCode, wrongField.res.body.code], [false, 400, "UPLOAD_FAILED"]);
  const two = await run(multipartReq(mk(), [{ field: "file", file: f("a.png", PNG) }, { field: "file", file: f("b.png", PNG) }]));
  assert.deepStrictEqual([two.nexted, two.res.statusCode], [false, 400]);
  const { Readable } = require("stream");
  const notMultipart = Object.assign(Readable.from([Buffer.from("{}")]), { pool: {}, method: "POST", headers: { "content-type": "application/json", "content-length": "2" } });
  const nm = await run(notMultipart);
  assert.ok(nm.nexted && !nm.req.file, "a non-multipart body passes through with no file, and the handler answers NO_FILE");
});
