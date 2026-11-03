/* Finance-controlled page access (utils/tenantPageAccess.js, financePageAccess.controller.js). */
const fs = require("fs");
const path = require("path");
const { suite, test, assert } = require("./helpers/tinytest");
const { makeMockPool } = require("./helpers/mockPool");
suite("tenantPageAccess.test.js");

const P = require("../utils/tenantPageAccess");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("page keys are validated per portal; landing pages are locked", () => {
  assert.ok(P.isValidPageKey("admin", "Meals"));
  assert.ok(!P.isValidPageKey("admin", "/student/meals"));
  assert.ok(!P.isValidPageKey("admin", "Nope"));
  assert.ok(P.isValidPageKey("student", "/student/meals"));
  assert.ok(!P.isValidPageKey("student", "/teacher/courses"));
  assert.ok(P.isValidPageKey("teacher", "/teacher/courses"));
  assert.ok(!P.isValidPageKey("parent", "/x"));
  assert.ok(P.isLocked("admin", "Dashboard") && P.isLocked("student", "/student") && P.isLocked("teacher", "/teacher/dashboard"));
});

test("toDisabledMap: only switched-off rows, never a locked page", () => {
  const m = P.toDisabledMap([
    { portal: "admin", page_key: "Meals", enabled: false },
    { portal: "admin", page_key: "Gate", enabled: true },
    { portal: "admin", page_key: "Dashboard", enabled: false },
    { portal: "student", page_key: "/student/meals", enabled: false },
  ]);
  assert.deepStrictEqual(m, { admin: ["Meals"], student: ["/student/meals"], teacher: [] });
});

test("getDisabledPages reads the tenant's table, caches per tenant, and fails OPEN", async () => {
  const a = makeMockPool([["FROM tenant_page_access", () => [{ portal: "admin", page_key: "Gate", enabled: false }]]]).pool;
  const b = makeMockPool([["FROM tenant_page_access", () => []]]).pool;
  assert.deepStrictEqual((await P.getDisabledPages(a, "tenantA", 1000)).admin, ["Gate"]);
  assert.deepStrictEqual((await P.getDisabledPages(b, "tenantB", 1000)).admin, [], "no leakage between tenants");
  const broken = { request: () => { throw new Error("db down"); } };
  assert.deepStrictEqual(await P.getDisabledPages(broken, "tenantC"), { admin: [], student: [], teacher: [] });
});

test("wiring: finance-only write route, tenant read route, hidden from record editor, school cannot override", () => {
  assert.ok(/router\.put\("\/institutions\/:tenantKey\/pages", setPages\)/.test(read("routes/finance.js")));
  assert.ok(/router\.get\("\/pages", protect/.test(read("routes/tenantLicense.js")));
  assert.ok(read("server.js").includes('"tenant_page_access"'));
  const pp = read("routes/portalPages.js");
  assert.ok(pp.includes("finance_locked") && pp.includes("switched off for your institution by Doravo"));
});
