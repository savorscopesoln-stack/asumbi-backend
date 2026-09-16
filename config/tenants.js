/* =========================================================
   MULTI-DATABASE TENANT CONFIG
   =========================================================
   Historically this backend only ever read DB_USER / DB_PASSWORD /
   DB_SERVER / DB_NAME once at process start, so one running backend
   process could only ever talk to one database. Standing up a second
   school/environment ("eregi") meant spinning up a second full backend
   deployment with its own env vars — and any frontend that wasn't
   rebuilt/pointed at that second backend (or blocked by CORS) would
   silently keep hitting the old database, which is exactly the
   "invalid username or password for a db2-only user" symptom this was
   built to fix.

   This module lets ONE backend process serve MULTIPLE databases,
   selected per-request. The default tenant ("default") keeps using the
   plain DB_* vars exactly as before — nothing breaks for a single-DB
   deployment that changes nothing. Extra tenants are added by:

     1. Adding the tenant's short key to DB_TENANTS (comma-separated),
        e.g.  DB_TENANTS=eregi
     2. Setting that tenant's own DB_*_<KEY> vars, e.g.
          DB_USER_EREGI=...
          DB_PASSWORD_EREGI=...
          DB_SERVER_EREGI=...
          DB_NAME_EREGI=eregi
        (DB_PORT_<KEY>, DB_ENCRYPT_<KEY>, DB_TRUST_CERT_<KEY> are
        optional per-tenant overrides; anything not set falls back to
        the shared/default value — pool sizing and timeouts are always
        shared across tenants, only connection identity differs.)
     3. Telling the server how to recognize a request as belonging to
        that tenant — any one of:
          DB_TENANT_HEADER_MAP=eregi:eregi           (X-Db-Tenant header)
          DB_TENANT_ORIGIN_MAP=https://eregi-portal.vercel.app:eregi
          DB_TENANT_HOST_MAP=eregi.asumbittc.ac.ke:eregi
        (all three are optional and can be combined; first match wins,
        checked in the order: header, then Origin, then Host)

   No other file needs to change — every route/controller that already
   does `const pool = await poolPromise` keeps working unchanged; see
   config/db.js for how poolPromise now resolves per-request.
========================================================= */

function parseListEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Turns "KEY1:val1,KEY2:val2" into { KEY1: "val1", KEY2: "val2" }.
// Used for the header/origin/host -> tenant lookup maps. Keys are
// matched case-insensitively for header/host, exactly for origin.
function parseMapEnv(name) {
  const map = {};
  for (const pair of parseListEnv(name)) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key && value) map[key] = value;
  }
  return map;
}

const DEFAULT_TENANT = "default";

// All tenant keys this process knows about, uppercased for env-var
// lookups but compared case-insensitively everywhere else.
const EXTRA_TENANT_KEYS = parseListEnv("DB_TENANTS");
const ALL_TENANT_KEYS = [DEFAULT_TENANT, ...EXTRA_TENANT_KEYS];

const HEADER_MAP = lowerKeys(parseMapEnv("DB_TENANT_HEADER_MAP"));
const ORIGIN_MAP = parseMapEnv("DB_TENANT_ORIGIN_MAP"); // origins are compared as-is
const HOST_MAP = lowerKeys(parseMapEnv("DB_TENANT_HOST_MAP"));

function lowerKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

function envKeySuffix(tenantKey) {
  return tenantKey === DEFAULT_TENANT
    ? ""
    : `_${tenantKey.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// Reads TENANT-specific env var, falling back to the shared/default
// one when the tenant hasn't overridden it. `required` vars (identity:
// user/password/server/name) do NOT fall back — each tenant must set
// its own, or it's a config error caught at pool-creation time.
function readEnv(base, tenantKey, { required = false } = {}) {
  const suffix = envKeySuffix(tenantKey);
  const scoped = process.env[`${base}${suffix}`];
  if (scoped !== undefined && scoped !== "") return scoped;
  if (required && tenantKey !== DEFAULT_TENANT) return undefined;
  return process.env[base];
}

function isKnownTenant(tenantKey) {
  return ALL_TENANT_KEYS.some(
    (k) => k.toLowerCase() === String(tenantKey || "").toLowerCase()
  );
}

// Builds the mssql `config` object for one tenant. Pool sizing/timeouts
// are intentionally always shared (DB_POOL_MAX etc, no per-tenant
// override) — those tune Node/SQL Server resource limits for this one
// process, not per-database identity.
function buildTenantConfig(tenantKey) {
  const key = ALL_TENANT_KEYS.find(
    (k) => k.toLowerCase() === String(tenantKey || "").toLowerCase()
  );
  if (!key) {
    throw new Error(
      `Unknown DB tenant "${tenantKey}". Known tenants: ${ALL_TENANT_KEYS.join(", ")}. ` +
        `Add it to DB_TENANTS if it's meant to exist.`
    );
  }

  const user = readEnv("DB_USER", key, { required: true });
  const password = readEnv("DB_PASSWORD", key, { required: true });
  const server = readEnv("DB_SERVER", key, { required: true });
  const database = readEnv("DB_NAME", key, { required: true });

  if (!user || !password || !server || !database) {
    const suffix = envKeySuffix(key);
    throw new Error(
      `❌ Missing DB config for tenant "${key}". Check DB_USER${suffix}, ` +
        `DB_PASSWORD${suffix}, DB_SERVER${suffix}, DB_NAME${suffix} in your .env file.`
    );
  }

  const portStr = readEnv("DB_PORT", key);
  const encryptStr = readEnv("DB_ENCRYPT", key);
  const trustCertStr = readEnv("DB_TRUST_CERT", key);

  return {
    user,
    password,
    server,
    database,
    port: portStr ? parseInt(portStr, 10) : 1433,
    options: {
      encrypt: encryptStr === "true",
      trustServerCertificate: trustCertStr !== "false",
    },
    pool: {
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 50,
      min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN, 10) : 2,
      idleTimeoutMillis: process.env.DB_POOL_IDLE_MS
        ? parseInt(process.env.DB_POOL_IDLE_MS, 10)
        : 30000,
      acquireTimeoutMillis: process.env.DB_POOL_ACQUIRE_TIMEOUT_MS
        ? parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS, 10)
        : 8000,
    },
    connectionTimeout: process.env.DB_CONNECT_TIMEOUT_MS
      ? parseInt(process.env.DB_CONNECT_TIMEOUT_MS, 10)
      : 45000,
    requestTimeout: process.env.DB_REQUEST_TIMEOUT_MS
      ? parseInt(process.env.DB_REQUEST_TIMEOUT_MS, 10)
      : 45000,
  };
}

// Resolves which tenant a request belongs to. Checked in order —
// first match wins — so an explicit header always lets you override
// (handy for testing a second DB from the same frontend/origin):
//   1. X-Db-Tenant header
//   2. Origin header (the frontend's own domain)
//   3. Host header (this API's own domain, for path/subdomain-per-tenant setups)
// Falls back to DEFAULT_TENANT if nothing matches or no extra tenants
// are configured at all.
function resolveTenantKey(req) {
  if (EXTRA_TENANT_KEYS.length === 0) return DEFAULT_TENANT;

  const headerTenant = (req.headers["x-db-tenant"] || "").toString().trim();
  if (headerTenant) {
    const mapped = HEADER_MAP[headerTenant.toLowerCase()] || headerTenant;
    if (isKnownTenant(mapped)) return mapped;
  }

  const origin = req.headers.origin;
  if (origin && ORIGIN_MAP[origin] && isKnownTenant(ORIGIN_MAP[origin])) {
    return ORIGIN_MAP[origin];
  }

  const host = (req.headers.host || "").toLowerCase();
  if (host && HOST_MAP[host] && isKnownTenant(HOST_MAP[host])) {
    return HOST_MAP[host];
  }

  return DEFAULT_TENANT;
}

module.exports = {
  DEFAULT_TENANT,
  ALL_TENANT_KEYS,
  buildTenantConfig,
  resolveTenantKey,
  isKnownTenant,
};
