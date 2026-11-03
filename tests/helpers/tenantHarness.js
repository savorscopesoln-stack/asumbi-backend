/* =========================================================================
   TENANT-ISOLATION TEST HARNESS  (L1.6) — reuse in every LMS phase.

   Database-per-tenant means isolation is mostly "a request only ever touches
   req.pool". This harness makes that provable with mocked pools:

     const T = makeTenants({ schoolA: [responses...], schoolB: [responses...] });
     // act as a user of A (req.pool = T.schoolA.pool), then:
     T.assertUntouched("schoolB");          // B's database was never queried
     T.assertQueried("schoolA");            // A's was

   ID-guessing: each tenant's responses are written so that rows exist only
   for that tenant's own ids (use `onlyIds`). A user of A asking for B's id
   gets nothing back, exactly like a real separate database would.

   Also: tenantFolders() for file-storage isolation and sameForbidden() to
   assert that "not yours" and "does not exist" look identical.
========================================================================= */
const fs = require("fs"), os = require("os"), path = require("path");
const assert = require("assert");
const { makeMockPool } = require("./mockPool");

/* tenants: { name: responses[] }  (responses as in makeMockPool) */
function makeTenants(defs) {
  const out = {};
  for (const [name, responses] of Object.entries(defs)) {
    const { pool, log } = makeMockPool(responses || []);
    out[name] = { name, pool, log };
  }
  out.assertUntouched = (name) => assert.strictEqual(out[name].log.length, 0, `tenant "${name}" database must not be queried, but ${out[name].log.length} quer(ies) ran: ${out[name].log.map((l) => l.sql.slice(0, 60)).join(" | ")}`);
  out.assertQueried = (name) => assert.ok(out[name].log.length > 0, `tenant "${name}" database was expected to be queried`);
  out.reset = () => Object.values(out).forEach((t) => { if (t && t.log) t.log.length = 0; });
  return out;
}

/* A response fn that returns `rows` only when the SQL input `inputName` is one of `ids`
   (this tenant's own ids); otherwise an empty recordset, like a separate database. */
const onlyIds = (inputName, ids, rows) => (inputs) => (ids.includes(Number(inputs[inputName])) ? (typeof rows === "function" ? rows(inputs) : rows) : []);

/* Temp upload root with one `lms` folder per tenant. files: { tenant: { "sub/name": bytes } } */
function tenantFolders(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-iso-"));
  for (const [tenant, list] of Object.entries(files)) {
    for (const [rel, bytes] of Object.entries(list)) {
      const full = path.join(root, tenant, "lms", rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(bytes));
    }
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* Two 403 responses are "the same" if status, code and message match (no existence leak). */
function sameForbidden(a, b) {
  assert.strictEqual(a.statusCode, b.statusCode);
  assert.strictEqual(a.body.code, b.body.code);
  assert.strictEqual(a.body.message, b.body.message);
}

module.exports = { makeTenants, onlyIds, tenantFolders, sameForbidden };
