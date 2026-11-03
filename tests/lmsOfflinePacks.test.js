/* L10.1a - offline resource packs (D-113): validation, create/edit/retire, PUBLISH = frozen manifest with sha256 + sizes + budget, learner list + manifest (stale lessons), tenant isolation, route gates, schema 042.
   Mocked pool and an injected file hasher only: SQL (OPENJSON batches, LEFT JOIN with the visibility rule) NOT verified on a real SQL Server; real disk hashing NOT exercised here (see the hasher test). */
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool, makeRes } = require("./helpers/mockPool");
const { makeTenants } = require("./helpers/tenantHarness");
suite("lmsOfflinePacks.test.js");
const O = require("../utils/lmsOfflinePacks"), schema = require("../utils/lmsSchema"), P = require("../utils/lmsPermissions");

const teacher = { id: 7, role: "teacher", source: "Teachers" }, student = { id: 21, role: "student", source: "Students" };
const NOW = new Date("2026-11-10T09:00:00Z"), FUTURE = "2027-01-01T00:00:00.000Z";
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const audits = (m) => m.log.filter((x) => /lms_audit_log/.test(x.sql));
const isWrite = (x) => !/^\s*SELECT/i.test(x.sql) && !/lms_audit_log/.test(x.sql);

test("validatePack (pure): create needs name + 1-50 distinct lesson ids; defaults 50 MB and no expiry; expiry must be in the future; edit takes any subset; unknown fields refused", () => {
  const ok = (b, e) => O.validatePack(b, e, NOW), bad = (b, e) => { const r = O.validatePack(b, e, NOW); assert.strictEqual(r.ok, false, JSON.stringify(b)); return r.errors.join(" "); };
  assert.deepStrictEqual(ok({ name: " <b>Week 1</b> ", lessonIds: [3, 1] }).value, { name: "bWeek 1/b", maxMb: 50, expiresAt: null, lessonIds: [3, 1] });
  assert.deepStrictEqual(ok({ name: "A", maxMb: 200, expiresAt: FUTURE, lessonIds: [1] }).value, { name: "A", maxMb: 200, expiresAt: FUTURE, lessonIds: [1] });
  for (const b of [{ lessonIds: [1] }, { name: "", lessonIds: [1] }, { name: "x".repeat(101), lessonIds: [1] }, { name: "A" }, { name: "A", lessonIds: [] }, { name: "A", lessonIds: [1, 1] }, { name: "A", lessonIds: [0] }, { name: "A", lessonIds: ["1"] },
    { name: "A", lessonIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { name: "A", lessonIds: [1], maxMb: 0 }, { name: "A", lessonIds: [1], maxMb: 201 }, { name: "A", lessonIds: [1], maxMb: 1.5 }, { name: "A", lessonIds: [1], expiresAt: "2026-11-10T09:00:00Z" },
    { name: "A", lessonIds: [1], expiresAt: "nope" }, { name: "A", lessonIds: [1], expiresAt: 5 }, { name: "A", lessonIds: [1], extra: 1 }, null, [], "x"]) bad(b);
  assert.deepStrictEqual(ok({ expiresAt: null }, true).value, { expiresAt: null }); assert.deepStrictEqual(ok({ maxMb: 10 }, true).value, { maxMb: 10 }); bad({}, true); bad({ name: "" }, true); bad({ maxMb: 0 }, true);
});

test("lessonContentSha + buildManifest (pure): hand-built manifest, files de-duplicated and sorted, external links counted online-only, hash changes when a block changes", () => {
  const B = (t, html, url) => ({ block_type: t, html, data: url ? JSON.stringify({ url }) : null });
  const l1 = { id: 11, title: "Intro", content_version: 3, blocks: [B("text", "<p>Hi</p>"), B("image", null, "/uploads/s/lms/a.png"), B("embed", null, "https://www.youtube.com/embed/x")] };
  const l2 = { id: 12, title: "Notes", content_version: 1, blocks: [B("file", null, "/uploads/s/lms/b.pdf"), B("image", null, "/uploads/s/lms/a.png")] };
  const files = new Map([["/uploads/s/lms/a.png", { mediaId: 5, name: "a.png", ext: "png", kind: "image", sizeBytes: 100, sha256: "aa" }], ["/uploads/s/lms/b.pdf", { mediaId: 6, name: "b.pdf", ext: "pdf", kind: "file", sizeBytes: 300, sha256: "bb" }]]);
  const m = O.buildManifest({ pack: { id: 9, course_id: 5, name: "Week 1", expires_at: FUTURE }, lessons: [l1, l2], fileByUrl: files, builtAt: "T" });
  assert.deepStrictEqual([m.v, m.packId, m.courseId, m.name, m.builtAt, m.expiresAt, m.totalBytes], [1, 9, 5, "Week 1", "T", FUTURE, 400]);
  assert.deepStrictEqual(m.files.map((f) => [f.mediaId, f.sizeBytes, f.sha256]), [[5, 100, "aa"], [6, 300, "bb"]], "a file used twice is listed once");
  assert.deepStrictEqual(m.lessons.map((l) => [l.id, l.contentVersion, l.blocks, l.onlineOnly]), [[11, 3, 3, 1], [12, 1, 2, 0]]);
  assert.strictEqual(m.lessons[0].contentSha256, O.lessonContentSha(l1.blocks)); const l1b = { ...l1, blocks: [B("text", "<p>Hi!</p>"), ...l1.blocks.slice(1)] }; assert.notStrictEqual(O.lessonContentSha(l1b.blocks), O.lessonContentSha(l1.blocks));
  assert.strictEqual(O.lessonContentSha([]), sha("[]"), "an empty lesson hashes the empty list"); assert.ok(!JSON.stringify(m).includes("/uploads/"), "no file path or url is in the manifest");
});

const createWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id, status FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5, status: "published" }] : [])],
  ["SELECT id FROM lms_lessons WHERE course_id = @c", (i) => (i.c === 5 ? JSON.parse(i.ids).filter((x) => (o.valid || [11, 12, 13]).includes(x)).map((id) => ({ id })) : [])],
  ["INSERT INTO lms_offline_packs", () => (o.insert === undefined ? [{ id: 9 }] : o.insert)],
  ["DECLARE @ok INT", () => [{ ok: o.ok ?? 1 }]], ["SELECT TOP 1 status FROM lms_offline_packs", () => (o.exists ? [{ status: "published" }] : [])]]);

test("create: lessons must belong to THIS course, cap of 10 live packs inside the same statement, one atomic batch, audited with counts; list is course scoped", async () => {
  const m = createWorld(); const r = await O.createPack(m.pool, teacher, 5, { name: "Week 1", lessonIds: [11, 12], maxMb: 20, expiresAt: FUTURE }, NOW); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.id, r.pack.status, r.pack.lessons, r.pack.maxMb, r.pack.expiresAt, r.pack.totalBytes], [9, "draft", 2, 20, FUTURE, null]);
  const w = m.log.find((x) => /INSERT INTO lms_offline_packs/.test(x.sql)); assert.ok(/XACT_ABORT ON; BEGIN TRAN/.test(w.sql) && /SELECT COUNT\(\*\) FROM lms_offline_packs WHERE course_id = @c AND deleted_at IS NULL\) < @max/.test(w.sql) && w.inputs.max === 10 && w.inputs.c === 5 && w.inputs.mb === 20);
  assert.deepStrictEqual(JSON.parse(w.inputs.rows), [{ l: 11, o: 0 }, { l: 12, o: 1 }]); assert.deepStrictEqual([w.inputs.src, w.inputs.uid], ["Teachers", 7]);
  assert.ok(/offline_pack\.created/.test(JSON.stringify(audits(m)[0].inputs)) && !/Week/.test(JSON.stringify(audits(m)[0].inputs)));
  const foreign = createWorld(); const f = await O.createPack(foreign.pool, teacher, 5, { name: "x", lessonIds: [11, 99] }, NOW); assert.strictEqual(f.ok, false); assert.ok(!foreign.log.some((x) => /INSERT INTO lms_offline_packs/.test(x.sql)), "a lesson of another course writes nothing");
  const full = createWorld({ insert: [] }); const c = await O.createPack(full.pool, teacher, 5, { name: "x", lessonIds: [11] }, NOW); assert.deepStrictEqual([c.ok, c.code], [false, "PACK_LIMIT"]); assert.strictEqual(audits(full).length, 0);
  for (const [u, id] of [[student, 5], [null, 5], [teacher, 6], [teacher, "x"]]) { const q = createWorld(); assert.strictEqual((await O.createPack(q.pool, u, id, { name: "x", lessonIds: [11] }, NOW)).notFound, true); assert.ok(!q.log.some(isWrite)); }
  assert.strictEqual((await O.createPack(createWorld().pool, teacher, 5, { name: "" }, NOW)).ok, false);
});

test("update: draft only, course scoped, replaces the lesson list in the same batch, refusals distinct (not draft / not found); retire; list", async () => {
  const m = createWorld(); assert.strictEqual((await O.updatePack(m.pool, teacher, 5, 9, { name: "New", maxMb: 10, expiresAt: null, lessonIds: [13] }, NOW)).ok, true);
  const u = m.log.find((x) => /DECLARE @ok INT/.test(x.sql)); assert.ok(/WHERE id = @i AND course_id = @c AND status = 'draft' AND deleted_at IS NULL;/.test(u.sql) && /DELETE FROM lms_offline_pack_lessons WHERE pack_id = @i AND course_id = @c/.test(u.sql) && /name = @n, max_mb = @mb, expires_at = @exp/.test(u.sql));
  assert.deepStrictEqual([u.inputs.c, u.inputs.i, u.inputs.exp, JSON.parse(u.inputs.rows)], [5, 9, null, [{ l: 13, o: 0 }]]);
  const only = createWorld(); await O.updatePack(only.pool, teacher, 5, 9, { name: "N" }, NOW); const u2 = only.log.find((x) => /DECLARE @ok INT/.test(x.sql)); assert.ok(!/max_mb = @mb|expires_at = @exp/.test(u2.sql) && u2.inputs.rows === null, "only the sent fields change, lessons untouched");
  const notDraft = createWorld({ ok: 0, exists: true }); assert.strictEqual((await O.updatePack(notDraft.pool, teacher, 5, 9, { name: "N" }, NOW)).code, "PACK_NOT_DRAFT");
  assert.strictEqual((await O.updatePack(createWorld({ ok: 0 }).pool, teacher, 5, 9, { name: "N" }, NOW)).notFound, true);
  assert.strictEqual((await O.updatePack(createWorld().pool, teacher, 5, 9, { lessonIds: [11, 99] }, NOW)).ok, false); assert.strictEqual((await O.updatePack(createWorld().pool, teacher, 5, 9, { ruleType: 1 }, NOW)).ok, false);
  for (const [u3, c3, i3] of [[student, 5, 9], [null, 5, 9], [teacher, "x", 9], [teacher, 5, 0]]) assert.strictEqual((await O.updatePack(createWorld().pool, u3, c3, i3, { name: "N" }, NOW)).notFound, true);
  const rm = makeMockPool([["UPDATE lms_offline_packs SET status = 'retired'", (i) => (i.c === 5 && i.i === 9 ? [{ id: 9 }] : [])]]);
  assert.strictEqual((await O.retirePack(rm.pool, teacher, 5, 9)).retired, true); assert.ok(/WHERE id = @i AND course_id = @c AND status <> 'retired' AND deleted_at IS NULL/.test(rm.log[0].sql) && !/DELETE FROM/.test(rm.log[0].sql) && /offline_pack\.retired/.test(JSON.stringify(audits(rm)[0].inputs)));
  assert.deepStrictEqual([(await O.retirePack(rm.pool, teacher, 5, 8)).notFound, (await O.retirePack(rm.pool, student, 5, 9)).notFound], [true, true]);
  const ls = makeMockPool([["FROM lms_offline_packs p WHERE p.course_id = @c", () => [{ id: 9, name: "W1", status: "published", max_mb: 50, expires_at: null, total_bytes: "400", manifest_sha256: "h", published_at: "2026-11-01T00:00:00Z", lessons: 2 }]]]);
  const l = await O.listPacks(ls.pool, 5); assert.deepStrictEqual([l.items[0].totalBytes, l.items[0].lessons, l.items[0].status], [400, 2, "published"]); assert.ok(/p\.course_id = @c AND p\.deleted_at IS NULL/.test(ls.log[0].sql) && /TOP 10/.test(ls.log[0].sql) && !/manifest_json/.test(ls.log[0].sql), "the list never carries the manifest body");
});

/* ---- publish ---- */
const B = (lesson, t, html, url) => ({ lesson_id: lesson, block_type: t, sort_order: 0, html, data: url ? JSON.stringify({ url }) : null });
const BLOCKS = [B(11, "text", "<p>Hi</p>"), B(11, "image", null, "/uploads/s/lms/a.png"), B(11, "embed", null, "https://www.youtube.com/embed/x"), B(12, "file", null, "/uploads/s/lms/b.pdf"), B(12, "image", null, "/uploads/s/lms/a.png")];
const MEDIA = [{ id: 5, url: "/uploads/s/lms/a.png", stored_name: "a1.png", original_name: "a.png", ext: "png", kind: "image", size_bytes: 100 }, { id: 6, url: "/uploads/s/lms/b.pdf", stored_name: "b1.pdf", original_name: "b.pdf", ext: "pdf", kind: "file", size_bytes: 300 }];
const pubWorld = (o = {}) => makeMockPool([
  ["SELECT TOP 1 id, status FROM lms_courses WHERE id", (i) => (i.c === 5 ? [{ id: 5, status: o.courseStatus || "published" }] : [])],
  ["SELECT TOP 1 id, course_id, name, status, max_mb, expires_at FROM lms_offline_packs", (i) => (i.c === 5 && i.i === 9 && o.pack !== null ? [{ id: 9, course_id: 5, name: "Week 1", status: "draft", max_mb: 1, expires_at: null, ...(o.pack || {}) }] : [])],
  ["FROM lms_offline_pack_lessons pl LEFT JOIN lms_lessons l", () => o.lessons || [{ lesson_id: 11, sort_order: 0, title: "Intro", content_version: 3, live_id: 11 }, { lesson_id: 12, sort_order: 1, title: "Notes", content_version: 1, live_id: 12 }]],
  ["FROM lms_lesson_blocks WHERE course_id = @c", () => o.blocks || BLOCKS], ["FROM lms_media_files WHERE course_id = @c", () => o.media || MEDIA],
  ["UPDATE lms_offline_packs SET status = 'published'", () => (o.upd === undefined ? [{ id: 9 }] : o.upd)]]);
const H = { "a1.png": { sha256: "a".repeat(64), size: 100 }, "b1.pdf": { sha256: "b".repeat(64), size: 300 } };
const withHasher = async (map, fn) => fn((t, name) => Promise.resolve(map[name] ? { ...map[name], tenant: t } : null)); /* the hasher is passed per call (ctx.hasher): no shared state between tests */

test("publish: frozen manifest (lessons with versions + content hashes, files with sha256 + real size), budget, one UPDATE guarded by status = draft, audited; the stored text hashes to manifestSha256", async () => {
  const m = pubWorld(); const r = await withHasher(H, (hasher) => O.publishPack(m.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher })); assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.totalBytes, r.lessons, r.files], [400, 2, 2]);
  const up = m.log.find((x) => /UPDATE lms_offline_packs SET status = 'published'/.test(x.sql)); assert.ok(/status = 'draft' AND deleted_at IS NULL/.test(up.sql) && /course_id = @c/.test(up.sql)); assert.strictEqual(sha(up.inputs.m), up.inputs.h); assert.strictEqual(r.manifestSha256, up.inputs.h); assert.strictEqual(up.inputs.t, 400);
  const man = JSON.parse(up.inputs.m); assert.deepStrictEqual([man.v, man.packId, man.courseId, man.builtAt, man.totalBytes], [1, 9, 5, "2026-11-10T09:00:00.000Z", 400]);
  assert.deepStrictEqual(man.files, [{ mediaId: 5, name: "a.png", ext: "png", kind: "image", sizeBytes: 100, sha256: "a".repeat(64) }, { mediaId: 6, name: "b.pdf", ext: "pdf", kind: "file", sizeBytes: 300, sha256: "b".repeat(64) }]);
  assert.deepStrictEqual(man.lessons.map((l) => [l.id, l.contentVersion, l.blocks, l.onlineOnly]), [[11, 3, 3, 1], [12, 1, 2, 0]]); assert.ok(!/uploads|stored|a1\.png|b1\.pdf/.test(up.inputs.m), "no paths or stored names leak into the manifest");
  const bl = m.log.find((x) => /FROM lms_lesson_blocks/.test(x.sql)); assert.ok(/course_id = @c/.test(bl.sql) && /TOP 5000/.test(bl.sql) && JSON.stringify(JSON.parse(bl.inputs.ids)) === "[11,12]");
  const lj = m.log.find((x) => /FROM lms_offline_pack_lessons pl/.test(x.sql)); assert.ok(/l\.status = 'published'/.test(lj.sql) && /l\.deleted_at IS NULL/.test(lj.sql) && /pl\.course_id = @c/.test(lj.sql), "visibility rule in the JOIN");
  const md = m.log.find((x) => /FROM lms_media_files/.test(x.sql)); assert.ok(/course_id = @c AND deleted_at IS NULL/.test(md.sql)); assert.deepStrictEqual(JSON.parse(md.inputs.urls).sort(), ["/uploads/s/lms/a.png", "/uploads/s/lms/b.pdf"], "only local files are looked up, never external links");
  assert.ok(/offline_pack\.published/.test(JSON.stringify(audits(m)[0].inputs)) && !/Week|a\.png/.test(JSON.stringify(audits(m)[0].inputs))); assert.ok(m.log.filter(isWrite).length === 1, "exactly one write");
  const none = pubWorld({ blocks: [B(11, "text", "<p>x</p>")], media: [] }); const n = await withHasher({}, (hasher) => O.publishPack(none.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher })); assert.deepStrictEqual([n.ok, n.totalBytes, n.files], [true, 0, 0]); assert.ok(!none.log.some((x) => /FROM lms_media_files/.test(x.sql)), "text-only pack: no media lookup");
});

test("publish refusals change NOTHING: course not published, pack not draft / missing, expired, empty, lesson not visible, file missing (library or disk), file size changed, over budget, too many files, lost race", async () => {
  const run = async (o, map = H) => { const m = pubWorld(o); const r = await withHasher(map, (hasher) => O.publishPack(m.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher })); assert.ok(!m.log.some(isWrite) || o.upd !== undefined, "no write"); assert.strictEqual(audits(m).length, 0); return r; };
  assert.strictEqual((await run({ courseStatus: "draft" })).code, "COURSE_NOT_PUBLISHED"); assert.strictEqual((await run({ pack: { status: "published" } })).code, "PACK_NOT_DRAFT"); assert.strictEqual((await run({ pack: null })).notFound, true);
  assert.strictEqual((await run({ pack: { expires_at: "2026-11-01T00:00:00Z" } })).code, "PACK_EXPIRED"); assert.strictEqual((await run({ lessons: [] })).code, "PACK_EMPTY");
  const gone = await run({ lessons: [{ lesson_id: 11, sort_order: 0, title: "I", content_version: 1, live_id: 11 }, { lesson_id: 12, sort_order: 1, title: null, content_version: null, live_id: null }] }); assert.deepStrictEqual([gone.code, gone.lessonIds], ["LESSON_NOT_AVAILABLE", [12]]);
  assert.strictEqual((await run({ media: [MEDIA[0]] })).code, "MEDIA_MISSING"); assert.strictEqual((await run({}, { "a1.png": H["a1.png"] })).code, "MEDIA_MISSING", "in the library but not on disk");
  const ch = await run({}, { "a1.png": { sha256: "x", size: 99 }, "b1.pdf": H["b1.pdf"] }); assert.deepStrictEqual([ch.code, ch.mediaIds], ["MEDIA_CHANGED", [5]]);
  const fit = pubWorld({ pack: { max_mb: 1 } }); assert.ok((await withHasher(H, (hasher) => O.publishPack(fit.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher }))).ok, "400 bytes fits a 1 MB budget (success case, one write)");
  const over = pubWorld({ media: [{ ...MEDIA[0], size_bytes: 2 * 1048576 }, MEDIA[1]] }); const o2 = await withHasher({ "a1.png": { sha256: "a", size: 2 * 1048576 }, "b1.pdf": H["b1.pdf"] }, (hasher) => O.publishPack(over.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher }));
  assert.deepStrictEqual([o2.code, o2.totalBytes, o2.maxBytes], ["PACK_TOO_LARGE", 2 * 1048576 + 300, 1048576]); assert.ok(!over.log.some(isWrite));
  const many = Array.from({ length: 201 }, (_, i) => B(11, "file", null, `/uploads/s/lms/f${i}.pdf`)); assert.strictEqual((await run({ blocks: many })).code, "TOO_MANY_FILES");
  const race = pubWorld({ upd: [] }); const rc = await withHasher(H, (hasher) => O.publishPack(race.pool, teacher, 5, 9, { tenant: "t1", now: NOW, hasher })); assert.deepStrictEqual([rc.ok, rc.code], [false, "PACK_NOT_DRAFT"]); assert.strictEqual(audits(race).length, 0, "a lost race is not audited as published");
  for (const [u, c, i] of [[student, 5, 9], [null, 5, 9], [teacher, 6, 9], [teacher, "x", 9], [teacher, 5, 0]]) { const m = pubWorld(); assert.strictEqual((await withHasher(H, (hasher) => O.publishPack(m.pool, u, c, i, { tenant: "t1", now: NOW, hasher }))).notFound, true, `${JSON.stringify(u)} ${c} ${i}`); assert.ok(!m.log.some(isWrite)); }
  const T = makeTenants({ A: [["FROM lms_courses", () => []]], B: [] }); assert.strictEqual((await O.publishPack(T.A.pool, teacher, 5, 9, { tenant: "A" })).notFound, true); T.assertUntouched("B");
});

test("default hasher: real sha256 + size from disk under uploads/<school>/lms, only the file NAME is used (no path tricks), missing file = null", async () => {
  const { UPLOADS_ROOT, safeTenant } = require("../utils/uploadPaths"); const school = "pack_test_" + process.pid, dir = path.join(UPLOADS_ROOT, safeTenant(school), "lms");
  fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, "h1.bin"), body = Buffer.from("offline pack bytes"); fs.writeFileSync(f, body);
  try {
    const m = pubWorld({ blocks: [B(11, "file", null, "/uploads/s/lms/h1.bin")], media: [{ id: 5, url: "/uploads/s/lms/h1.bin", stored_name: "h1.bin", original_name: "h1.bin", ext: "txt", kind: "file", size_bytes: body.length }], lessons: [{ lesson_id: 11, sort_order: 0, title: "I", content_version: 1, live_id: 11 }] });
    const r = await O.publishPack(m.pool, teacher, 5, 9, { tenant: school, now: NOW }); assert.ok(r.ok, JSON.stringify(r));
    const man = JSON.parse(m.log.find((x) => /SET status = 'published'/.test(x.sql)).inputs.m); assert.deepStrictEqual([man.files[0].sha256, man.files[0].sizeBytes], [crypto.createHash("sha256").update(body).digest("hex"), body.length]);
    const trick = pubWorld({ blocks: [B(11, "file", null, "/uploads/s/lms/x")], media: [{ id: 5, url: "/uploads/s/lms/x", stored_name: "../../../../etc/passwd", original_name: "x", ext: "txt", kind: "file", size_bytes: 1 }], lessons: [{ lesson_id: 11, sort_order: 0, title: "I", content_version: 1, live_id: 11 }] });
    assert.strictEqual((await O.publishPack(trick.pool, teacher, 5, 9, { tenant: school, now: NOW })).code, "MEDIA_MISSING", "a traversal name resolves inside the school folder and finds nothing");
  } finally { fs.rmSync(path.join(UPLOADS_ROOT, safeTenant(school)), { recursive: true, force: true }); }
});

const MAN = { v: 1, packId: 9, courseId: 5, name: "Week 1", lessons: [{ id: 11, contentVersion: 3 }, { id: 12, contentVersion: 1 }], files: [], totalBytes: 0 };
const learnWorld = (o = {}) => makeMockPool([
  ["FROM lms_offline_packs p WHERE p.course_id = @c", () => [{ id: 9, name: "Week 1", status: "published", max_mb: 50, expires_at: null, total_bytes: "400", manifest_sha256: "h", published_at: "2026-11-01T00:00:00Z", lessons: 2 }]],
  ["SELECT TOP 1 manifest_json, manifest_sha256 FROM lms_offline_packs", (i) => (i.c === 5 && i.i === 9 && o.pack !== null ? [{ manifest_json: JSON.stringify(o.man || MAN), manifest_sha256: "h" }] : [])],
  ["SELECT id, content_version FROM lms_lessons WHERE course_id = @c", () => o.current || [{ id: 11, content_version: 3 }, { id: 12, content_version: 1 }]]]);

test("learner: lists only PUBLISHED, unexpired packs of their course; manifest is the frozen text + staleLessons (version moved on or no longer visible); retired / expired / draft / other course = same 404; read only", async () => {
  const m = learnWorld(); const l = await O.learnerPacks(m.pool, 5, NOW); assert.deepStrictEqual(Object.keys(l.items[0]).sort(), ["expiresAt", "id", "lessons", "manifestSha256", "name", "publishedAt", "totalBytes"]);
  assert.ok(/p\.course_id = @c/.test(m.log[0].sql) && /p\.status = 'published'/.test(m.log[0].sql) && /p\.deleted_at IS NULL/.test(m.log[0].sql) && /p\.expires_at IS NULL OR p\.expires_at > @now/.test(m.log[0].sql) && m.log[0].inputs.now.toISOString() === NOW.toISOString());
  const r = await O.learnerManifest(m.pool, 5, 9, NOW); assert.deepStrictEqual([r.ok, r.manifestSha256, r.staleLessons, r.manifest.name], [true, "h", [], "Week 1"]);
  const q = m.log.find((x) => /SELECT TOP 1 manifest_json/.test(x.sql)); assert.ok(/status = 'published'/.test(q.sql) && /deleted_at IS NULL/.test(q.sql) && /expires_at IS NULL OR expires_at > @now/.test(q.sql) && /course_id = @c/.test(q.sql));
  const stale = await O.learnerManifest(learnWorld({ current: [{ id: 11, content_version: 4 }] }).pool, 5, 9, NOW); assert.deepStrictEqual(stale.staleLessons, [11, 12], "11 changed, 12 is no longer visible");
  assert.strictEqual((await O.learnerManifest(learnWorld({ pack: null }).pool, 5, 9, NOW)).notFound, true); assert.strictEqual((await O.learnerManifest(learnWorld().pool, 6, 9, NOW)).notFound, true); assert.strictEqual((await O.learnerManifest(learnWorld().pool, 5, 8, NOW)).notFound, true);
  const bad = makeMockPool([["SELECT TOP 1 manifest_json", () => [{ manifest_json: "{not json", manifest_sha256: "h" }]]]); assert.strictEqual((await O.learnerManifest(bad.pool, 5, 9, NOW)).notFound, true);
  assert.deepStrictEqual([(await O.learnerManifest(learnWorld().pool, "x", 9, NOW)).notFound, (await O.learnerManifest(learnWorld().pool, 5, 0, NOW)).notFound, (await O.learnerPacks(learnWorld().pool, 0, NOW)).notFound], [true, true, true]);
  assert.ok(m.log.every((x) => /^\s*SELECT/i.test(x.sql)), "learner routes are read only");
  const T = makeTenants({ A: [["FROM lms_offline_packs", () => []]], B: [] }); assert.strictEqual((await O.learnerManifest(T.A.pool, 5, 9, NOW)).notFound, true); T.assertUntouched("B");
});

test("routes: licence flag `lms_offline` FIRST on every route, then permission + course access; learner routes studentOnly; shapes (201, no-store, 404, 409); students hold no manage permission", async () => {
  const router = require("../routes/lms"), src = fs.readFileSync(path.join(__dirname, "../routes/lms.js"), "utf8"), OL = "/courses/:courseId/offline/packs";
  const find = (m, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  const rs = [["get", OL], ["post", OL], ["patch", `${OL}/:packId`], ["post", `${OL}/:packId/publish`], ["post", `${OL}/:packId/retire`], ["get", "/courses/:courseId/learn/offline/packs"], ["get", "/courses/:courseId/learn/offline/packs/:packId/manifest"]].map(([m, p]) => find(m, p));
  assert.ok(rs.every(Boolean)); for (const r of rs) assert.strictEqual(r.route.stack.length, 4);
  assert.ok(/const olGate = requireModule\("lms", "lms_offline"\), olManage = requireLmsPermission\("lms\.course\.manage"\)/.test(src));
  assert.strictEqual((src.match(/olGate, olManage, staffAccess/g) || []).length, 5); assert.strictEqual((src.match(/olGate, studentOnly, studentAccess/g) || []).length, 8) /* L10.1b lessons + files (D-114), L10.3a sync (D-115), L10.3b drafts + resolve (D-116), L10.3c quiz answers (D-118) */;
  assert.ok(P.roleDefaults({ role: "teacher" }).includes("lms.course.manage") && !P.roleDefaults({ role: "student" }).includes("lms.course.manage"));
  const res = makeRes(); await rs[1].route.stack[3].handle({ pool: createWorld().pool, user: teacher, params: { courseId: "5" }, body: { name: "W", lessonIds: [11] }, tenant: "t" }, res); assert.deepStrictEqual([res.statusCode, res.body.success, res.body.id, "ok" in res.body], [201, true, 9, false]);
  const r2 = makeRes(); await rs[1].route.stack[3].handle({ pool: createWorld().pool, user: teacher, params: { courseId: "5" }, body: { name: "W" }, tenant: "t" }, r2); assert.strictEqual(r2.statusCode, 400);
  const r3 = makeRes(); await rs[3].route.stack[3].handle({ pool: pubWorld().pool, user: teacher, params: { courseId: "5", packId: "abc" }, body: {}, tenant: "t" }, r3); assert.strictEqual(r3.statusCode, 404);
  const r4 = makeRes(); r4.setHeader = () => {}; await rs[3].route.stack[3].handle({ pool: pubWorld({ courseStatus: "draft" }).pool, user: teacher, params: { courseId: "5", packId: "9" }, body: {}, tenant: "t" }, r4); assert.deepStrictEqual([r4.statusCode, r4.body.code], [409, "COURSE_NOT_PUBLISHED"]);
  let hdr = null; const r5 = makeRes(); r5.setHeader = (k, v) => { hdr = [k, v]; }; await rs[6].route.stack[3].handle({ pool: learnWorld().pool, user: student, params: { courseId: "5", packId: "9" }, tenant: "t" }, r5);
  assert.deepStrictEqual([r5.statusCode, r5.body.success, r5.body.manifest.name, r5.body.staleLessons, hdr], [200, true, "Week 1", [], ["Cache-Control", "no-store"]]);
  const r6 = makeRes(); r6.setHeader = () => {}; await rs[6].route.stack[3].handle({ pool: learnWorld({ pack: null }).pool, user: student, params: { courseId: "5", packId: "9" }, tenant: "t" }, r6); assert.strictEqual(r6.statusCode, 404);
});

test("schema step 042: additive, two tables, unique (pack, lesson), LAST step; both tables blocked from the generic record editor; the flag exists in the manifest and the add-on list", () => {
  const ids = schema.STEPS.map((s) => s.id), i = ids.indexOf("042_lms_offline_packs"); assert.ok(i === ids.length - 4 && ids[i - 1] === "041_lms_guardian" && ids[i + 1] === "043_lms_offline_actions");
  const t = schema.STEPS[i].sql.join("\n"); assert.ok(/name='lms_offline_packs'/.test(t) && /name='lms_offline_pack_lessons'/.test(t) && !/DROP |DELETE |ALTER TABLE/i.test(t) && /UX_lms_offline_pack_lessons ON lms_offline_pack_lessons \(pack_id, lesson_id\)/.test(t) && /manifest_json NVARCHAR\(MAX\) NULL/.test(t));
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"); for (const n of ["lms_offline_packs", "lms_offline_pack_lessons"]) assert.ok(new RegExp(`RECORD_TABLE_BLOCKLIST = new Set\\([^)]*"${n}"`).test(server), n);
  assert.ok(/"lms_offline"/.test(fs.readFileSync(path.join(__dirname, "../../lms.module.manifest.json"), "utf8")));
  assert.ok(/addons: \["lms_offline"/.test(fs.readFileSync(path.join(__dirname, "../utils/tenantModules.js"), "utf8")));
});
