/* =========================================================================
   ASUMBI EXAM LOAD TEST
   ─────────────────────────────────────────────────────────
   Exercises the full exam journey exactly as a real student would:

     exam-login -> start-exam -> activate-session -> fetch-assessment
       -> heartbeat -> submit

   Two modes, selected by the SCENARIO env var (default: staged):

     SCENARIO=staged (default) — the full staged ramp:
         30s  -> 100 VUs
         1m   -> 500 VUs
         1m   -> 1000 VUs
         2m   -> 2000 VUs
         5m   -> 2000 VUs
         1m   -> 0 VUs

     SCENARIO=burst — worst case: everyone hits exam-login at once.
         Uses k6's `per-vu-iterations` / ramping with a near-zero
         ramp-up, to find the maximum *instantaneous* login capacity
         rather than a gradual one.

     SCENARIO=ramp900 — the section-16 "realistic ramp" specifically
         for isolating whether failures are about *arrival rate* rather
         than total concurrency:
         0 -> 100 -> 300 -> 500 -> 700 -> 900, each stage 30s.

   Every HTTP failure is bucketed into a distinct k6 Counter so the
   summary shows *why* requests failed, not just that they failed:

     connection_errors_total  — reset/refused/connection-level failures
     non_ok_status_total      — a real HTTP response, but not 2xx
     login_bad_json_total     — 2xx response that wasn't valid/expected JSON

   IMPORTANT: never blindly call `response.json("token")` before
   confirming status + content-type + that it parses — that turns a
   normal failed-login response into an uncaught k6 exception, which is
   exactly what made earlier runs impossible to diagnose.

   USAGE:
     k6 run .\exam-load-test.js
     k6 run -e SCENARIO=burst .\exam-load-test.js
     k6 run -e SCENARIO=ramp900 .\exam-load-test.js
     k6 run -e BASE_URL=http://localhost:5000 -e ASSESSMENT_ID=4013 .\exam-load-test.js
========================================================================= */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

/* ---------------------------- CONFIG ---------------------------- */

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";
const ASSESSMENT_ID = __ENV.ASSESSMENT_ID || "4013";
const EXAM_PASSWORD = __ENV.EXAM_PASSWORD || "changeme";
// How many distinct student usernames exist to log in as — cycle
// through them so VUs don't all hammer the exact same row (which
// would test SQL row-lock contention rather than the login path).
const STUDENT_POOL_SIZE = parseInt(__ENV.STUDENT_POOL_SIZE || "1000", 10);
const USERNAME_PREFIX = __ENV.USERNAME_PREFIX || "loadtest_student_";

const SCENARIO = __ENV.SCENARIO || "staged";

/* ---------------------------- METRICS ---------------------------- */

const connectionErrors = new Counter("connection_errors_total");
const nonOkStatus = new Counter("non_ok_status_total");
const loginBadJson = new Counter("login_bad_json_total");
const failedExamRequests = new Counter("failed_exam_requests");

const loginTrend = new Trend("login_duration", true);
const journeyTrend = new Trend("journey_duration", true);

/* ---------------------------- SCENARIOS ---------------------------- */

const scenarios = {
  staged: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "30s", target: 100 },
      { duration: "1m", target: 500 },
      { duration: "1m", target: 1000 },
      { duration: "2m", target: 2000 },
      { duration: "5m", target: 2000 },
      { duration: "1m", target: 0 },
    ],
    gracefulRampDown: "30s",
  },

  // Worst case: ramp to 900 VUs as fast as k6 will schedule them, then
  // hold briefly. This is deliberately NOT a smooth ramp — it's meant
  // to answer "what happens if 900 students all click login within the
  // same few seconds", which is the realistic exam-day failure mode.
  burst: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "5s", target: 900 }, // near-instant ramp
      { duration: "30s", target: 900 }, // hold at peak
      { duration: "10s", target: 0 },
    ],
    gracefulRampDown: "10s",
  },

  // Section 16's realistic ramp test: same eventual concurrency as the
  // burst test (900), but arriving gradually, to isolate whether
  // failures are caused by *instantaneous arrival rate* specifically.
  ramp900: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "30s", target: 100 },
      { duration: "30s", target: 300 },
      { duration: "30s", target: 500 },
      { duration: "30s", target: 700 },
      { duration: "30s", target: 900 },
      { duration: "30s", target: 900 },
      { duration: "20s", target: 0 },
    ],
    gracefulRampDown: "20s",
  },
};

export const options = {
  scenarios: { main: scenarios[SCENARIO] || scenarios.staged },
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.02"],
    failed_exam_requests: ["count<100"],
  },
  // Low-VU / smoke runs should be chatty for debugging; large runs
  // should not flood stdout. k6 has no VU-count-aware log level, so we
  // gate our own console.log calls on __ENV.VERBOSE instead (set
  // VERBOSE=1 for a 1-10 VU debugging run).
};

const VERBOSE = __ENV.VERBOSE === "1";

/* ---------------------------- HELPERS ---------------------------- */

// Classifies ANY k6 http response/exception into exactly one bucket,
// and never throws — a bad response is data, not a script crash.
function classifyAndCheck(res, label) {
  if (!res) {
    connectionErrors.add(1);
    failedExamRequests.add(1);
    if (VERBOSE) console.log(`[${label}] no response object (connection-level failure)`);
    return { ok: false, json: null };
  }

  // k6 sets status 0 for connection-level failures: reset, refused,
  // DNS failure, timeout before any HTTP response was received.
  if (res.status === 0) {
    connectionErrors.add(1);
    failedExamRequests.add(1);
    if (VERBOSE) console.log(`[${label}] connection error: ${res.error} (${res.error_code})`);
    return { ok: false, json: null };
  }

  if (res.status < 200 || res.status >= 300) {
    nonOkStatus.add(1);
    failedExamRequests.add(1);
    if (VERBOSE) console.log(`[${label}] non-OK status ${res.status}: ${res.body?.slice(0, 200)}`);
    return { ok: false, json: null, status: res.status };
  }

  let json = null;
  try {
    json = res.json();
  } catch (e) {
    loginBadJson.add(1);
    failedExamRequests.add(1);
    if (VERBOSE) console.log(`[${label}] 2xx but invalid JSON: ${res.body?.slice(0, 200)}`);
    return { ok: false, json: null };
  }

  return { ok: true, json };
}

function studentCreds(vuId, iterId) {
  const idx = (vuId * 997 + iterId) % STUDENT_POOL_SIZE; // spread across pool, avoid hot-row clustering
  return { username: `${USERNAME_PREFIX}${idx}` };
}

/* ---------------------------- MAIN JOURNEY ---------------------------- */

export default function () {
  const journeyStart = Date.now();
  const { username } = studentCreds(__VU, __ITER);

  /* ---- 1. exam-login ---- */
  const loginStart = Date.now();
  const loginRes = http.post(
    `${BASE_URL}/api/e-assessments/exam-login`,
    JSON.stringify({ assessmentId: ASSESSMENT_ID, username, examPassword: EXAM_PASSWORD }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "exam-login" } }
  );
  loginTrend.add(Date.now() - loginStart);

  const login = classifyAndCheck(loginRes, "exam-login");
  check(loginRes, { "login: got a response": () => login.ok !== undefined });

  if (!login.ok || !login.json?.token) {
    // Login itself failed (bad creds, DB busy, connection error, etc) —
    // nothing downstream can proceed. Record it and stop this iteration
    // cleanly rather than throwing.
    if (login.ok && !login.json?.token) {
      loginBadJson.add(1);
      failedExamRequests.add(1);
      if (VERBOSE) console.log(`[exam-login] 2xx JSON but no token field: ${JSON.stringify(login.json).slice(0, 200)}`);
    }
    sleep(1);
    return;
  }

  const token = login.json.token;
  const authHeaders = { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } };

  check(loginRes, { "login: status is 200": (r) => r.status === 200 });

  /* ---- 2. start-exam ---- */
  const startRes = http.post(
    `${BASE_URL}/api/e-assessments/${ASSESSMENT_ID}/start-exam`,
    null,
    { ...authHeaders, tags: { name: "start-exam" } }
  );
  const start = classifyAndCheck(startRes, "start-exam");
  check(startRes, { "start-exam: ok": () => start.ok });
  if (!start.ok || !start.json?.token) { sleep(1); return; }
  const sessionToken = start.json.token;
  const deviceId = `k6-${__VU}-${__ITER}`;

  /* ---- 3. activate-session ---- */
  const activateRes = http.post(
    `${BASE_URL}/api/e-assessments/exam-session/activate`,
    JSON.stringify({ token: sessionToken, device_id: deviceId, device_label: "k6 load test" }),
    { ...authHeaders, tags: { name: "activate-session" } }
  );
  const activate = classifyAndCheck(activateRes, "activate-session");
  check(activateRes, { "activate-session: ok": () => activate.ok });

  /* ---- 4. fetch-assessment / questions ---- */
  const fetchRes = http.get(
    `${BASE_URL}/api/e-assessments/${ASSESSMENT_ID}`,
    { ...authHeaders, tags: { name: "fetch-assessment" } }
  );
  const fetched = classifyAndCheck(fetchRes, "fetch-assessment");
  check(fetchRes, { "fetch-assessment: ok": () => fetched.ok });

  sleep(1); // simulate a moment of the student reading/answering

  /* ---- 5. heartbeat ---- */
  const heartbeatRes = http.post(
    `${BASE_URL}/api/e-assessments/exam-session/heartbeat`,
    JSON.stringify({ token: sessionToken, device_id: deviceId }),
    { ...authHeaders, tags: { name: "heartbeat" } }
  );
  const heartbeat = classifyAndCheck(heartbeatRes, "heartbeat");
  check(heartbeatRes, { "heartbeat: ok": () => heartbeat.ok });

  /* ---- 6. submit ---- */
  const submitRes = http.post(
    `${BASE_URL}/api/e-assessments/submit`,
    JSON.stringify({
      assessment_id: ASSESSMENT_ID,
      token: sessionToken,
      device_id: deviceId,
      answers: [], // load test doesn't need real answers to exercise the write path
    }),
    { ...authHeaders, tags: { name: "submit" } }
  );
  const submit = classifyAndCheck(submitRes, "submit");
  check(submitRes, { "submit: ok": () => submit.ok });

  journeyTrend.add(Date.now() - journeyStart);
}

/* ---------------------------- SUMMARY ----------------------------
   No custom handleSummary here — k6's default end-of-run text summary
   already reports connection_errors_total, non_ok_status_total,
   login_bad_json_total, failed_exam_requests, and the login/journey
   Trends by name. For the before/after comparison table (section 19),
   run with `--summary-export=results-before.json` /
   `--summary-export=results-after.json` and diff the two JSON files —
   see the TEST COMMANDS section of the accompanying report.
========================================================================= */
