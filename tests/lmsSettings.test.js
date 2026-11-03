/* L1.4 — LMS settings, grants and router gate order. Mocked pool; no live SQL Server. */
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
suite("lmsSettings.test.js");
const S = require("../utils/lmsSettings");
const G = require("../utils/lmsGrants");

test("defaults are sane and frozen-shaped", () => {
  assert.strictEqual(S.DEFAULTS.lateSubmission, "accept");
  assert.strictEqual(S.DEFAULTS.courseApprovalRequired, false);
  assert.ok(!S.DEFAULTS.files.allowedExtensions.some((e) => S.FORBIDDEN_EXT.has(e)), "default extensions must all be safe");
});

test("valid patch is accepted and normalised", () => {
  const r = S.validateSettingsPatch({ terminology: { course: "  Unit  " }, files: { maxFileMb: "25", allowedExtensions: [".PDF", "docx", "pdf"] }, latePenaltyPercent: 15, gradingSystemId: 3, enrolment: { defaultMode: "approval" }, courseApprovalRequired: true });
  assert.ok(r.ok, r.errors.join("|"));
  assert.strictEqual(r.value.terminology.course, "Unit");
  assert.strictEqual(r.value.files.maxFileMb, 25);
  assert.deepStrictEqual(r.value.files.allowedExtensions, ["pdf", "docx"]);
});

test("unknown keys, bad types and out-of-range values are rejected", () => {
  for (const bad of [{ nope: 1 }, { lateSubmission: "maybe" }, { latePenaltyPercent: 101 }, { latePenaltyPercent: 1.5 }, { files: { maxFileMb: 0 } }, { files: { maxFileMb: 9999 } },
    { terminology: { course: "" } }, { terminology: { bogus: "x" } }, { gradingSystemId: "abc" }, { enrolment: { defaultMode: "x" } }, { courseApprovalRequired: "yes" }, { storageQuotaMb: -1 }, null, [], "str"]) {
    assert.strictEqual(S.validateSettingsPatch(bad).ok, false, JSON.stringify(bad));
  }
});

test("script-capable or executable extensions can never be allowed", () => {
  for (const e of ["html", "SVG", ".js", "exe", "php", "xml"]) assert.strictEqual(S.validateSettingsPatch({ files: { allowedExtensions: ["pdf", e] } }).ok, false, e);
  assert.strictEqual(S.validateSettingsPatch({ files: { allowedExtensions: ["pdf", "../x"] } }).ok, false);
});

test("terminology labels have control characters and angle brackets stripped", () => {
  const r = S.validateSettingsPatch({ terminology: { lesson: "<b>Topic</b>\u0000" } });
  assert.ok(r.ok); assert.strictEqual(r.value.terminology.lesson, "bTopic/b");
});

test("mergeSettings overlays rows on defaults and ignores bad JSON / unknown keys", () => {
  const m = S.mergeSettings([{ setting_key: "terminology", value_json: '{"course":"Unit"}' }, { setting_key: "lateSubmission", value_json: '"block"' }, { setting_key: "files", value_json: "{broken" }, { setting_key: "evil", value_json: "1" }]);
  assert.strictEqual(m.terminology.course, "Unit"); assert.strictEqual(m.terminology.lesson, "Lesson");
  assert.strictEqual(m.lateSubmission, "block");
  assert.strictEqual(m.files.maxFileMb, S.DEFAULTS.files.maxFileMb);
  assert.strictEqual(m.evil, undefined);
});

test("saveSettings validates, upserts only changed keys, merges nested objects, and audits", async () => {
  const { pool, log } = makeMockPool([["FROM lms_settings", () => [{ setting_key: "terminology", value_json: '{"course":"Unit"}' }]]]);
  const r = await S.saveSettings(pool, { id: 5, role: "admin" }, { terminology: { lesson: "Topic" } });
  assert.ok(r.ok);
  const up = log.find((l) => l.sql.includes("UPDATE lms_settings"));
  assert.ok(up, "upsert issued");
  assert.deepStrictEqual(JSON.parse(up.inputs.v), { ...S.DEFAULTS.terminology, course: "Unit", lesson: "Topic" });
  assert.strictEqual(log.filter((l) => l.sql.includes("UPDATE lms_settings")).length, 1);
  const audit = log.find((l) => l.sql.includes("INSERT INTO lms_audit_log"));
  assert.ok(audit); assert.strictEqual(audit.inputs.act, "settings.update"); assert.strictEqual(audit.inputs.a, 5);
});

test("saveSettings with invalid or empty patch writes nothing", async () => {
  const { pool, log } = makeMockPool();
  assert.strictEqual((await S.saveSettings(pool, { id: 1 }, { files: { allowedExtensions: ["html"] } })).ok, false);
  assert.strictEqual((await S.saveSettings(pool, { id: 1 }, {})).ok, false);
  assert.strictEqual(log.length, 0);
});

test("getSettings falls back to defaults if the table cannot be read", async () => {
  const broken = { request() { return { input() { return this; }, async query() { throw new Error("no table"); } }; } };
  assert.deepStrictEqual(await S.getSettings(broken), S.mergeSettings([]));
});

test("publicView exposes labels and limits but not quota, grading id or approval flag", () => {
  const v = S.publicView(S.mergeSettings([]));
  assert.ok(v.terminology && v.files); assert.strictEqual(v.storageQuotaMb, undefined); assert.strictEqual(v.gradingSystemId, undefined);
});

test("grants: only Teachers/Users sources; students and injection attempts rejected", () => {
  assert.ok(G.validateGrant({ userSource: "Teachers", userId: 4, permissionCodes: ["lms.course.approve"] }).ok);
  for (const src of ["Students", "Evil", "Teachers; DROP TABLE x", undefined]) assert.strictEqual(G.validateGrant({ userSource: src, userId: 1, permissionCodes: [] }).ok, false, String(src));
  assert.strictEqual(G.validateGrant({ userSource: "Users", userId: "1 OR 1=1", permissionCodes: [] }).ok, false);
  assert.strictEqual(G.validateGrant({ userSource: "Users", userId: 1, permissionCodes: ["lms.root"] }).ok, false);
});

test("setGrants replaces the set, de-duplicates, and audits", async () => {
  const { pool, log } = makeMockPool([["FROM Teachers", () => [{ id: 9 }]]]);
  const r = await G.setGrants(pool, { id: 1, role: "admin" }, { userSource: "Teachers", userId: 9, permissionCodes: ["lms.course.approve", "lms.course.approve", "lms.analytics.department"] });
  assert.ok(r.ok); assert.deepStrictEqual(r.permissionCodes, ["lms.course.approve", "lms.analytics.department"]);
  assert.strictEqual(log.filter((l) => l.sql.startsWith("DELETE FROM lms_user_permissions")).length, 1);
  assert.strictEqual(log.filter((l) => l.sql.startsWith("INSERT INTO lms_user_permissions")).length, 2);
  assert.ok(log.find((l) => l.inputs.act === "permissions.set"));
});

test("setGrants for a user that does not exist changes nothing", async () => {
  const { pool, log } = makeMockPool([["FROM Teachers", () => []]]);
  const r = await G.setGrants(pool, { id: 1 }, { userSource: "Teachers", userId: 999, permissionCodes: ["lms.course.approve"] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.notFound, true);
  assert.ok(!log.some((l) => /DELETE|INSERT/.test(l.sql)));
});

test("router: licence gate is registered before every route (nothing reachable without it)", () => {
  const { protect } = require("../middleware/authMiddleware");
  const router = require("../routes/lms");
  const layers = router.stack;
  const firstRoute = layers.findIndex((l) => l.route);
  assert.ok(firstRoute >= 2, "protect + requireModule must precede all routes");
  assert.strictEqual(layers[0].handle, protect);
  const routes = layers.filter((l) => l.route);
  assert.ok(routes.length >= 6);
  for (const l of routes) if (!/^\/(settings\/public|me\/permissions)$/.test(l.route.path)) assert.ok(l.route.stack.length >= 2, `${l.route.path} must have a permission check`);
});
