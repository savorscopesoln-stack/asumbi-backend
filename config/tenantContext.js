const { AsyncLocalStorage } = require("async_hooks");

// One shared AsyncLocalStorage instance for the whole process. Any code
// running inside `tenantContext.run(key, fn)` — and anything that code
// calls, however deep (route handler -> controller -> pool.request()) —
// can read the active tenant key back out with `tenantContext.getTenant()`
// without it being threaded through every function signature.
const als = new AsyncLocalStorage();

function run(tenantKey, fn) {
  return als.run(tenantKey, fn);
}

function getTenant() {
  return als.getStore();
}

module.exports = { run, getTenant };
