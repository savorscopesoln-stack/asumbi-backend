/* =========================================================================
   MOCK POOL — a stand-in for the mssql ConnectionPool used everywhere in
   this codebase as `req.pool`. No live SQL Server is reachable from this
   environment, so every test in this directory runs the REAL controller
   code (real mssql/xlsx/pdfkit/jszip packages, real query strings) against
   this mock instead of a live database.

   This intentionally only fakes the query *transport*, never any
   business logic: `responses` is an ordered list of
   [matchSubstring, (inputs, callCount) => recordset] pairs. The first
   entry whose substring appears in the issued SQL text wins — write
   matchers specific enough (a distinctive WHERE/column list) that two
   different queries in the same test never collide.
========================================================================= */
function makeMockPool(responses = []) {
  const log = [];
  const matchCounts = {};

  const pool = {
    request() {
      const inputs = {};
      const reqObj = {
        input(name, _type, val) {
          inputs[name] = val;
          return reqObj;
        },
        async query(sqlText) {
          const normalized = sqlText.replace(/\s+/g, " ").trim();
          for (const [match, fn] of responses) {
            if (normalized.includes(match)) {
              matchCounts[match] = (matchCounts[match] || 0) + 1;
              const recordset = fn(inputs, matchCounts[match]) || [];
              log.push({ matched: match, sql: normalized, inputs: { ...inputs }, recordset });
              return { recordset };
            }
          }
          log.push({ matched: null, sql: normalized, inputs: { ...inputs }, recordset: [] });
          return { recordset: [] };
        },
      };
      return reqObj;
    },
  };

  return { pool, log };
}

/* Minimal Express req/res stand-ins — every controller in this project
   only ever touches req.pool/req.params/req.query/req.body/req.user and
   res.json()/res.status().json(), so these are enough to call a real
   handler directly without an HTTP server. */
function makeReq({ pool, params = {}, query = {}, body = {}, user = null }) {
  return { pool, params, query, body, user };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  res.send = (payload) => { res.body = payload; return res; };
  return res;
}

module.exports = { makeMockPool, makeReq, makeRes };
