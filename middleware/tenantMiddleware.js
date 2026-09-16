const { resolveTenantKey } = require("../config/tenants");
const tenantContext = require("../config/tenantContext");

// Must run BEFORE any route/DB-touching middleware (but after CORS/body
// parsing, since tenant resolution can look at headers already present
// by then). Everything downstream — including `req.pool = await
// poolPromise` in server.js and every route/controller that does the
// same — automatically gets the right tenant's database because it's
// all running inside `tenantContext.run(...)` for the duration of this
// request.
function tenantMiddleware(req, res, next) {
  const tenantKey = resolveTenantKey(req);
  req.dbTenant = tenantKey; // handy for logging/debugging which DB a request used
  tenantContext.run(tenantKey, next);
}

module.exports = { tenantMiddleware };
