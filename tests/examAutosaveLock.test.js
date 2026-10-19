/* Autosave while locked + resume: progress must reach the server before anything else.
   Runs the real autosaveExamAnswers against a mocked pool (no live SQL Server needed). */
const { suite, test, assert } = require("./helpers/tinytest");
suite("examAutosaveLock.test.js");
const Module = require("module");
const orig = Module._load;
// Any module that isn't installed here (mssql, jszip, …) becomes a harmless stub.
const stub = () => new Proxy(function () {}, { get: (t, k) => (k === "__esModule" ? false : k === Symbol.toPrimitive ? () => "" : stub()), apply: () => stub(), construct: () => stub() });
const sqlFake = { Int: 1, BigInt: 2, Bit: 3, Char: () => 4, NVarChar: () => 5, MAX: 6, Request: class {}, Transaction: class {} };
Module._load = function (name, parent, ...r) {
  if (name === "mssql") return sqlFake;
  if (/config\/db(\.js)?$/.test(name)) return { sql: sqlFake, poolPromise: Promise.resolve({}), getPool: () => ({}), listTenantKeys: () => [], hasTenant: () => true };
  try { return orig.call(this, name, parent, ...r); } catch (e) { if (e.code === "MODULE_NOT_FOUND") return stub(); throw e; }
};
process.env.JWT_SECRET = "x";
const { autosaveExamAnswers } = require("../controllers/eAssessment.controller.js");
Module._load = orig; // stubs were only for loading the controller; never leak into other test files

function makePool(session, draft) {
  const writes = [];
  return {
    writes,
    request() {
      const r = { inputs: {}, input(n, t, v) { this.inputs[n] = v; return this; },
        async query(q) {
          if (/FROM e_assessment_exam_sessions WHERE e_assessment_id/.test(q) && /SELECT status, token, device_id/.test(q)) return { recordset: session ? [session] : [] };
          if (/SELECT answers_json FROM e_assessment_drafts/.test(q)) return { recordset: draft ? [{ answers_json: JSON.stringify(draft) }] : [] };
          if (/UPDATE e_assessment_drafts/.test(q)) { writes.push(JSON.parse(this.inputs.json)); return { recordset: [{ applied: 1 }] }; }
          return { recordset: [] };
        } };
      return r;
    },
  };
}
const call = async (pool, body) => {
  const out = {};
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await autosaveExamAnswers({ pool, params: { id: "7" }, user: { id: 3 }, body }, res);
  return out;
};

const sess = (status, device_id) => ({ status, token: "ABC123", device_id });

test("locked session + the bound device: answers are saved before anything else", async () => {
  const p = makePool(sess("locked", "devA"));
  const r = await call(p, { answers: { 1: "a", 2: "b" }, token: "ABC123", device_id: "devA" });
  assert.ok(r.body && r.body.success);
  assert.strictEqual(p.writes.length, 1);
});
test("locked session + a different device: refused, nothing written", async () => {
  const p = makePool(sess("locked", "devA"));
  const r = await call(p, { answers: { 1: "x" }, token: "ABC123", device_id: "devB" });
  assert.strictEqual(r.status, 423);
  assert.strictEqual(p.writes.length, 0);
});
test("locked session + no device id: refused", async () => {
  const p = makePool(sess("locked", "devA"));
  const r = await call(p, { answers: { 1: "x" }, token: "ABC123" });
  assert.strictEqual(r.status, 423);
  assert.strictEqual(p.writes.length, 0);
});
test("ended session: refused with 409", async () => {
  const p = makePool(sess("ended", "devA"));
  const r = await call(p, { answers: { 1: "x" }, token: "ABC123", device_id: "devA" });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(p.writes.length, 0);
});
test("first sync after resume merges: saved answers kept, the device's newer answer wins", async () => {
  const p = makePool(sess("active", "devB"), { 1: "a", 2: "b", 3: "c" });
  await call(p, { answers: { 3: "C-new" }, token: "ABC123", device_id: "devB", merge_existing: true });
  assert.deepStrictEqual(p.writes[0], { 1: "a", 2: "b", 3: "C-new" });
});
test("a normal later sync replaces, so a cleared answer stays cleared", async () => {
  const p = makePool(sess("active", "devB"), { 1: "a", 2: "b", 3: "c" });
  await call(p, { answers: { 3: "c" }, token: "ABC123", device_id: "devB" });
  assert.deepStrictEqual(Object.keys(p.writes[0]), ["3"]);
});
