/* L10.1b - offline pack downloads (D-114): lesson content as frozen (hash re-checkable), file bytes with size/hash guards, Range, tenant isolation, route gates and headers.
   Mocked pool; file opener injected per call (no shared global). One test touches the REAL disk under uploads/<school>/lms. SQL NOT verified on a real SQL Server. */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { PassThrough } = require("stream");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsOfflinePackFiles.test.js");
const O = require("../utils/lmsOfflinePacks");

const NOW = new Date("2026-11-10T09:00:00Z");
const B = (t, html, url) => ({ block_type: t, sort_order: 0, html, data: url ? JSON.stringify({ url }) : null });
const BLOCKS = [B("text", "<p>Hi</p>"), B("image", null, "/uploads/s/lms/a.png"), B("embed", null, "https://www.youtube.com/embed/x")];
const SHA = O.lessonContentSha(BLOCKS);
const MAN = { v: 1, packId: 9, courseId: 5, name: "Week 1", lessons: [{ id: 11, title: "Intro", contentVersion: 3, contentSha256: SHA, blocks: 3, onlineOnly: 1 }],
  files: [{ mediaId: 5, name: "a.png", ext: "png", kind: "image", sizeBytes: 10, sha256: "a".repeat(64) }], totalBytes: 10 };
const world = (o = {}) => makeMockPool([
  ["SELECT TOP 1 manifest_json FROM lms_offline_packs", (i) => (i.c === 5 && i.i === 9 && o.pack !== null ? [{ manifest_json: JSON.stringify(o.man || MAN) }] : [])],
  ["SELECT TOP 1 id, content_version FROM lms_lessons", (i) => (i.c === 5 && i.l === 11 && o.live !== null ? [{ id: 11, content_version: o.version ?? 3 }] : [])],
  ["FROM lms_lesson_blocks", () => o.blocks || BLOCKS],
  ["FROM lms_media_files WHERE course_id = @c AND deleted_at IS NULL AND url IN", () => o.media || [{ id: 5, url: "/uploads/s/lms/a.png" }, { id: 77, url: "/uploads/s/lms/other.png" }]],
  ["SELECT TOP 1 stored_name, size_bytes FROM lms_media_files", (i) => (i.c === 5 && (i.m === 5 || i.m === 77) && o.row !== null ? [o.row || { stored_name: "a1.png", size_bytes: "10" }] : [])]]);
const opener = (size = 10, log = []) => async (tenant, name) => { log.push([tenant, name]); return { size, stream: (s, e) => ({ s, e }), close: async () => { log.push("closed"); } }; };

test("parseRange (pure): no header = whole file; one range; suffix; open end; clamps the end; everything odd = bad", () => {
  const P = O.parseRange;
  assert.strictEqual(P(undefined, 10), null); assert.strictEqual(P("", 10), null);
  assert.deepStrictEqual(P("bytes=0-3", 10), { start: 0, end: 3 }); assert.deepStrictEqual(P("bytes=4-", 10), { start: 4, end: 9 });
  assert.deepStrictEqual(P("bytes=-3", 10), { start: 7, end: 9 }); assert.deepStrictEqual(P("bytes=-50", 10), { start: 0, end: 9 }); assert.deepStrictEqual(P("bytes=2-99", 10), { start: 2, end: 9 });
  for (const h of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,3-4", "bytes=a-b", "bytes=0-1 ", "garbage"]) { const r = P(h, 10); if (h === "bytes=0-1 ") assert.deepStrictEqual(r, { start: 0, end: 1 }, "trailing space trimmed"); else assert.strictEqual(r, "bad", h); }
  assert.strictEqual(P("bytes=0-0", 0), "bad", "an empty file has no satisfiable range");
});

test("lesson content: blocks exactly as stored (hash re-checkable), only this pack's files listed, external links need no file, read only, no-store friendly", async () => {
  const m = world(); const r = await O.learnerLesson(m.pool, 5, 9, 11, NOW); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.lesson, { id: 11, title: "Intro", contentVersion: 3, contentSha256: SHA });
  assert.strictEqual(O.lessonContentSha(r.blocks.map((b) => ({ block_type: b.type, html: b.html, data: b.data }))), SHA, "the device can recompute the manifest hash from what it received");
  assert.deepStrictEqual(r.files, [{ url: "/uploads/s/lms/a.png", mediaId: 5 }], "media 77 is not in the manifest, so it is not offered");
  assert.ok(!JSON.stringify(r).includes("stored_name") && !/a1\.png/.test(JSON.stringify(r)));
  const q = m.log.find((x) => /FROM lms_lesson_blocks/.test(x.sql)); assert.ok(/course_id = @c AND lesson_id = @l/.test(q.sql) && /ORDER BY sort_order, id/.test(q.sql) && q.inputs.c === 5 && q.inputs.l === 11);
  const lq = m.log.find((x) => /FROM lms_lessons/.test(x.sql)); assert.ok(/course_id = @c/.test(lq.sql) && /deleted_at IS NULL/.test(lq.sql) && /status = 'published'/.test(lq.sql));
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "read only");
});

test("lesson content refusals: edited since the freeze (version OR content) = 409 LESSON_CHANGED and no blocks; not in the pack / hidden now / retired, expired, other-course pack = 404; bad ids = 404", async () => {
  const ch = await O.learnerLesson(world({ version: 4 }).pool, 5, 9, 11, NOW); assert.deepStrictEqual([ch.ok, ch.code, ch.blocks], [false, "LESSON_CHANGED", undefined]);
  const ch2 = await O.learnerLesson(world({ blocks: [B("text", "<p>Hi!</p>"), ...BLOCKS.slice(1)] }).pool, 5, 9, 11, NOW); assert.strictEqual(ch2.code, "LESSON_CHANGED", "same version number but different content is still refused");
  for (const [o, c, p, l] of [[{}, 5, 9, 12], [{ live: null }, 5, 9, 11], [{ pack: null }, 5, 9, 11], [{}, 6, 9, 11], [{}, 5, 8, 11], [{}, "x", 9, 11], [{}, 5, 0, 11], [{}, 5, 9, "abc"]]) assert.strictEqual((await O.learnerLesson(world(o).pool, c, p, l, NOW)).notFound, true, JSON.stringify([o, c, p, l]));
  const q = world().log; const m = world(); await O.learnerLesson(m.pool, 5, 9, 11, NOW); const pq = m.log[0]; assert.ok(/status = 'published'/.test(pq.sql) && /deleted_at IS NULL/.test(pq.sql) && /expires_at IS NULL OR expires_at > @now/.test(pq.sql) && /course_id = @c/.test(pq.sql) && pq.inputs.now.toISOString() === NOW.toISOString(), "expiry is checked on every read");
  const T = makeTenants({ A: [["FROM lms_offline_packs", () => []]], B: [] }); assert.strictEqual((await O.learnerLesson(T.A.pool, 5, 9, 11, NOW)).notFound, true); T.assertUntouched("B"); assert.ok(q);
});

test("file bytes: only a media id listed in THIS pack; library size and real size must equal the manifest; whole file, one range, bad range, empty file; opener gets the tenant and the stored NAME only", async () => {
  const log = []; const r = await O.learnerFile(world().pool, 5, 9, 5, { tenant: "t1", now: NOW, open: opener(10, log) }); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.file.size, r.file.start, r.file.end, r.file.length, r.file.partial, r.file.name, r.file.sha256], [10, 0, 9, 10, false, "a.png", "a".repeat(64)]); assert.deepStrictEqual(log, [["t1", "a1.png"]]);
  const p = await O.learnerFile(world().pool, 5, 9, 5, { tenant: "t1", now: NOW, range: "bytes=2-4", open: opener() }); assert.deepStrictEqual([p.file.partial, p.file.start, p.file.end, p.file.length, p.file.stream], [true, 2, 4, 3, { s: 2, e: 4 }]);
  const bad = []; const b = await O.learnerFile(world().pool, 5, 9, 5, { tenant: "t1", now: NOW, range: "bytes=50-", open: opener(10, bad) }); assert.deepStrictEqual([b.ok, b.rangeError, b.size], [false, true, 10]); assert.ok(bad.includes("closed"), "the handle is closed when nothing is streamed");
  for (const [o, c, p2, mid] of [[{}, 5, 9, 77], [{}, 6, 9, 5], [{}, 5, 8, 5], [{ pack: null }, 5, 9, 5], [{ row: null }, 5, 9, 5], [{ row: { stored_name: "a1.png", size_bytes: "11" } }, 5, 9, 5], [{}, 5, 9, 0], [{}, "x", 9, 5]]) assert.strictEqual((await O.learnerFile(world(o).pool, c, p2, mid, { tenant: "t1", now: NOW, open: opener() })).notFound, true, JSON.stringify([o, c, p2, mid]));
  const foreign = []; assert.strictEqual((await O.learnerFile(world().pool, 5, 9, 77, { tenant: "t1", now: NOW, open: opener(10, foreign) })).notFound, true, "a file of the course that is NOT in this pack"); assert.deepStrictEqual(foreign, [], "and the disk is never touched for it");
  const cl = []; assert.strictEqual((await O.learnerFile(world().pool, 5, 9, 5, { tenant: "t1", now: NOW, open: opener(11, cl) })).notFound, true, "file on disk changed size since the freeze"); assert.ok(cl.includes("closed"));
  assert.strictEqual((await O.learnerFile(world().pool, 5, 9, 5, { tenant: "t1", now: NOW, open: async () => null })).notFound, true, "missing on disk");
  const z = world({ man: { ...MAN, files: [{ ...MAN.files[0], sizeBytes: 0 }] }, row: { stored_name: "e", size_bytes: "0" } }); const e = await O.learnerFile(z.pool, 5, 9, 5, { tenant: "t1", now: NOW, open: opener(0) }); assert.deepStrictEqual([e.ok, e.file.length, e.file.stream], [true, 0, null]);
  const q = world(); await O.learnerFile(q.pool, 5, 9, 5, { tenant: "t1", now: NOW, open: opener() }); const lq = q.log.find((x) => /stored_name, size_bytes/.test(x.sql)); assert.ok(/course_id = @c AND deleted_at IS NULL/.test(lq.sql) && lq.inputs.c === 5); assert.ok(q.log.every((x) => /^\s*SELECT/i.test(x.sql)));
  const T = makeTenants({ A: [["FROM lms_offline_packs", () => []]], B: [] }); assert.strictEqual((await O.learnerFile(T.A.pool, 5, 9, 5, { tenant: "A", open: opener() })).notFound, true); T.assertUntouched("B");
});

test("default opener on the REAL disk: streams the exact bytes (whole and ranged) from uploads/<school>/lms; a traversal stored name is cut to its file name and finds nothing", async () => {
  const { UPLOADS_ROOT, safeTenant } = require("../utils/uploadPaths"); const school = "pack_dl_" + process.pid, dir = path.join(UPLOADS_ROOT, safeTenant(school), "lms");
  fs.mkdirSync(dir, { recursive: true }); const body = Buffer.from("0123456789abcdef"); fs.writeFileSync(path.join(dir, "d1.bin"), body);
  const man = { ...MAN, files: [{ ...MAN.files[0], sizeBytes: body.length }] }; const row = { stored_name: "d1.bin", size_bytes: String(body.length) };
  const read = (s) => new Promise((res, rej) => { const c = []; s.on("data", (d) => c.push(d)); s.on("end", () => res(Buffer.concat(c))); s.on("error", rej); });
  try {
    const a = await O.learnerFile(world({ man, row }).pool, 5, 9, 5, { tenant: school, now: NOW }); assert.ok(a.ok); assert.strictEqual((await read(a.file.stream)).toString(), "0123456789abcdef");
    const b = await O.learnerFile(world({ man, row }).pool, 5, 9, 5, { tenant: school, now: NOW, range: "bytes=4-7" }); assert.strictEqual((await read(b.file.stream)).toString(), "4567");
    const c = await O.learnerFile(world({ man, row }).pool, 5, 9, 5, { tenant: school, now: NOW, range: "bytes=-3" }); assert.strictEqual((await read(c.file.stream)).toString(), "def");
    const decoyName = "decoy_" + process.pid + ".bin", decoy = path.join(UPLOADS_ROOT, decoyName); fs.writeFileSync(decoy, body);
    try { const t = await O.learnerFile(world({ man, row: { stored_name: "../../" + decoyName, size_bytes: String(body.length) } }).pool, 5, 9, 5, { tenant: school, now: NOW }); assert.strictEqual(t.notFound, true, "a same-size file OUTSIDE the school folder is never reachable through a stored name"); } finally { fs.rmSync(decoy, { force: true }); }
    const other = await O.learnerFile(world({ man, row }).pool, 5, 9, 5, { tenant: school + "_other", now: NOW }); assert.strictEqual(other.notFound, true, "another school's folder never holds this file");
  } finally { fs.rmSync(path.join(UPLOADS_ROOT, safeTenant(school)), { recursive: true, force: true }); }
});

const fakeRes = () => { const res = new PassThrough(), h = {}, chunks = []; res.statusCode = 200; res.headers = h; res.setHeader = (k, v) => { h[k] = v; }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; res.end(); return res; }; res.on("data", (d) => chunks.push(d)); res.text = () => Buffer.concat(chunks).toString(); return res; };
test("routes: flag `lms_offline` first, studentOnly + enrolment, 4 handlers; headers attachment/nosniff/private/Content-Length; 206 + Content-Range; 416; 404; lesson route no-store; students cannot reach staff routes", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8");
  const find = (p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods.get);
  const LP = "/courses/:courseId/learn/offline/packs/:packId/lessons/:lessonId", FP = "/courses/:courseId/learn/offline/packs/:packId/files/:mediaId";
  const lr = find(LP), fr = find(FP); assert.ok(lr && fr); assert.strictEqual(lr.route.stack.length, 4); assert.strictEqual(fr.route.stack.length, 4);
  assert.strictEqual((src.match(/olGate, studentOnly, studentAccess/g) || []).length, 8, "lessons + files here, plus the L10.3a sync route, the L10.3b drafts + resolve routes and the L10.3c quiz-answers route");
  const student = { id: 21, role: "student", source: "Students" };
  const lres = makeRes(); let lh = null; lres.setHeader = (k, v) => { lh = [k, v]; }; await lr.route.stack[3].handle({ pool: world().pool, user: student, params: { courseId: "5", packId: "9", lessonId: "11" }, tenant: "t" }, lres);
  assert.deepStrictEqual([lres.statusCode, lres.body.success, lres.body.lesson.contentSha256, lh], [200, true, SHA, ["Cache-Control", "no-store"]]);
  const l2 = makeRes(); await lr.route.stack[3].handle({ pool: world({ version: 9 }).pool, user: student, params: { courseId: "5", packId: "9", lessonId: "11" }, tenant: "t" }, l2); assert.deepStrictEqual([l2.statusCode, l2.body.code], [409, "LESSON_CHANGED"]);
  const l3 = makeRes(); await lr.route.stack[3].handle({ pool: world().pool, user: student, params: { courseId: "5", packId: "9", lessonId: "abc" }, tenant: "t" }, l3); assert.strictEqual(l3.statusCode, 404);
  const { UPLOADS_ROOT, safeTenant } = require("../utils/uploadPaths"); const school = "pack_rt_" + process.pid, dir = path.join(UPLOADS_ROOT, safeTenant(school), "lms"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "r1.bin"), "0123456789");
  try {
    const call = async (headers, params = { courseId: "5", packId: "9", mediaId: "5" }, w = world({ row: { stored_name: "r1.bin", size_bytes: "10" } })) => { const res = fakeRes(); const done = new Promise((r) => res.on("close", r)); await fr.route.stack[3].handle({ pool: w.pool, user: student, params, headers, tenant: school }, res); if (!res.writableEnded && res.statusCode !== 404) await done; return res; };
    const ok = await call({}); assert.strictEqual(ok.statusCode, 200); assert.strictEqual(ok.text(), "0123456789");
    assert.deepStrictEqual([ok.headers["Content-Length"], ok.headers["X-Content-Type-Options"], ok.headers["Cache-Control"], ok.headers["Content-Type"], ok.headers["Accept-Ranges"], ok.headers["X-File-Sha256"]], ["10", "nosniff", "private, no-store", "application/octet-stream", "bytes", "a".repeat(64)]);
    assert.ok(/^attachment; filename="pack-file\.png"/.test(ok.headers["Content-Disposition"]));
    const part = await call({ range: "bytes=2-4" }); assert.deepStrictEqual([part.statusCode, part.headers["Content-Range"], part.headers["Content-Length"], part.text()], [206, "bytes 2-4/10", "3", "234"]);
    const bad = await call({ range: "bytes=99-" }); assert.deepStrictEqual([bad.statusCode, bad.body.code, bad.headers["Content-Range"]], [416, "RANGE_NOT_SATISFIABLE", "bytes */10"]);
    const nf = await call({}, { courseId: "5", packId: "9", mediaId: "77" }); assert.strictEqual(nf.statusCode, 404);
    const nid = await call({}, { courseId: "5", packId: "9", mediaId: "x" }); assert.strictEqual(nid.statusCode, 404);
  } finally { fs.rmSync(path.join(UPLOADS_ROOT, safeTenant(school)), { recursive: true, force: true }); }
});
