/* =========================================================================
   MANUAL RENDER TEST — the real AiReviewPanel in a real DOM (jsdom)

   NOT part of `node tests/run-all.js`: it needs React, a DOM and a JSX compiler,
   which the backend does not depend on. Run it when you change AiReviewPanel.jsx
   or the review endpoints:

     mkdir /tmp/rt && cd /tmp/rt && npm init -y && npm i react@18.3.1 react-dom@18.3.1 jsdom esbuild
     RENDER_TEST_DIR=/tmp/rt node <repo>/backend/tests/manual/aiReviewPanel.render.js

   What it does: bundles frontend/AiReviewPanel.jsx, mounts it, and gives it an
   axios-shaped `api` whose backend is the REAL review controller + service over
   the in-memory store (so the screen and the server contract are tested together).
   It then clicks through: queue, open, evidence highlighting, accept, the
   fractional-mark rule, editing + validation, reject with a required reason,
   a hostile (XSS) answer, a race with hand-marking, mark-it-myself, the failed
   tab, bulk accept, and an unavailable server.

   It proves the screen behaves as designed in jsdom. It does NOT prove layout,
   colour, dark mode, mobile, or behaviour in a real browser — look at it once
   by eye (tests/README.md Phase 7 checklist).
========================================================================= */
const path = require("path");
const ROOT = path.resolve(__dirname, "../../..");                       // repo root (backend/tests/manual -> ..)
const BACK = path.join(ROOT, "backend");
const FRONT = process.env.AI_REVIEW_FRONTEND_DIR || path.join(ROOT, "frontend");
if (!process.env.RENDER_TEST_DIR) { console.error("Set RENDER_TEST_DIR to a folder where you ran: npm i react@18.3.1 react-dom@18.3.1 jsdom esbuild"); process.exit(2); }
const need = require("module").createRequire(path.join(process.env.RENDER_TEST_DIR, "noop.js"));
const esbuild = need("esbuild");
// Written INSIDE the scratch dir so the bundle and this harness resolve the very same copy of React (two copies => broken hooks).
const OUT = path.join(process.env.RENDER_TEST_DIR, `ai-review-panel-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [path.join(FRONT, "AiReviewPanel.jsx")], outfile: OUT, bundle: true, format: "cjs", platform: "node",
  external: ["react", "react-dom"], loader: { ".jsx": "jsx", ".mjs": "js" }, jsx: "automatic", logLevel: "error", nodePaths: [path.join(process.env.RENDER_TEST_DIR, "node_modules")] });
const { JSDOM } = need("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement; global.Node = dom.window.Node; global.MouseEvent = dom.window.MouseEvent; global.Event = dom.window.Event;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.getComputedStyle = dom.window.getComputedStyle;

const React = need("react");
const { createRoot } = need("react-dom/client");
const { act } = need("react");
const Panel = require(OUT).default;
const { makeReviewController } = require(`${BACK}/controllers/aiMarkingReview.controller`);
const { createMemoryReviewStore } = require(`${BACK}/tests/helpers/memoryReviewStore`);
const { makeReq, makeRes } = require(`${BACK}/tests/helpers/mockPool`);

let failures = 0, passed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log("  ✓", msg); } else { failures++; console.log("  ✗", msg); } };
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = (el = document.body) => el.textContent.replace(/\s+/g, " ");
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const byText = (sel, t) => $$(sel).find((e) => e.textContent.includes(t));
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); await flush(); };
const type = async (el, value) => {
  await act(async () => {
    const proto = el.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush(1);
};

function makeApi(store, user = { id: 5, role: "teacher" }) {
  const c = makeReviewController({ storeFactory: () => store });
  const calls = [];
  const dispatch = async (method, url, { params, body } = {}) => {
    const path = url.replace("/api/e-assessments/ai-marking", "");
    calls.push([method, path, body]);
    let handler, p = {};
    let m;
    if (method === "GET" && path === "/review/queue") handler = "getQueue";
    else if (method === "POST" && path === "/review/bulk-accept") handler = "bulkAccept";
    else if ((m = path.match(/^\/review\/(\d+)(?:\/([a-z-]+))?$/))) {
      p = { id: m[1] };
      handler = method === "GET" ? "getDetail" : { approve: "approve", reject: "reject", "mark-manually": "markManually", "flag-scheme": "flagScheme", "request-reevaluation": "requestReevaluation" }[m[2]];
    }
    if (!handler) throw new Error(`unrouted ${method} ${path}`);
    const res = makeRes();
    await c[handler](makeReq({ pool: {}, user, params: p, query: params || {}, body: body || {} }), res);
    if (res.statusCode >= 400) { const e = new Error(`HTTP ${res.statusCode}`); e.response = { status: res.statusCode, data: res.body }; throw e; }
    return { data: res.body };
  };
  return { get: (u, o) => dispatch("GET", u, o), post: (u, b) => dispatch("POST", u, { body: b }), calls };
}

const half = (c1, c2) => [
  { criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, marksAwarded: c1, evidence: ["make glucose and oxygen"], matchedPoints: [0], explanation: "Defines it." },
  { criterionId: "c2", label: "States the products", maxMarks: 3, marksAwarded: c2, evidence: ["glucose and oxygen"], matchedPoints: [0, 1], explanation: "Names both." },
];

(async () => {
  const container = document.getElementById("root");
  const root = createRoot(container);
  let changed = 0; const manual = [];

  const store = createMemoryReviewStore();
  const a = store.add({ studentName: "Amina Otieno", admissionNo: "A101", essay: "<p>Plants make glucose and oxygen using light energy.</p>" });
  const b = store.add({ studentName: "Brian Kiptoo", admissionNo: "A102", suggestedTotal: 3.5, criteria: half(1.5, 2), essay: "<p>Plants make glucose and oxygen with light.</p>" });
  const c = store.add({ studentName: "Cynthia Wanjiru", admissionNo: "A103", flags: ["ambiguous_answer"], essay: "<p>Photosynthesis is how plants eat.</p>" });
  const x = store.add({ studentName: "Xavier Mallory", admissionNo: "A104", essay: `<p>Plants make glucose and oxygen.</p><script>window.PWNED=1</script><img src=x onerror="window.PWNED=2"><b onmouseover="window.PWNED=3">bold</b>` });
  const f = store.add({ studentName: "Fatuma Ali", admissionNo: "A105", status: "failed" });
  const api = makeApi(store);

  console.log("MOUNT + QUEUE");
  await act(async () => { root.render(React.createElement(Panel, { api, onChanged: () => { changed++; }, onMarkManually: (m) => manual.push(m) })); });
  await flush();
  ok(text().includes("Amina Otieno") && text().includes("Brian Kiptoo") && text().includes("Cynthia Wanjiru"), "queue lists the suggestions with student names");
  ok(!text().includes("Fatuma Ali"), "a failed answer is not in 'To review'");
  ok(text().includes("ambiguous answer"), "flags are shown as chips on the row");
  const boxes = $$("input[type=checkbox]");
  ok(boxes.length === 4 && boxes.filter((e) => e.disabled).length === 2, "bulk checkboxes only enabled for clean rows (flagged + fractional are disabled)");
  ok($$("[role=tab]").length === 3, "three tabs");

  console.log("OPEN + HIGHLIGHT + ACCEPT");
  await click(byText("button.air-open", "Amina Otieno"));
  ok(text().includes("Explain photosynthesis") && text().includes("5 marks"), "question and max marks shown");
  ok($$(".air-paper mark").some((m) => /glucose and oxygen/i.test(m.textContent)), "AI evidence is highlighted inside the student's answer");
  ok(text().includes("AI suggests 5 / 5") && text().includes("Defines photosynthesis") && text().includes("Names both."), "total, criteria and explanations shown");
  const accept = byText("button", "Accept 5 / 5");
  ok(accept && !accept.disabled, "Accept is enabled for a whole-number suggestion");
  await click(accept);
  ok(a.answer.marks_awarded === 5 && a.eval.review_state === "approved", "accepting wrote the mark and approved the evaluation (real controller)");
  ok(text().includes("Accepted: 5 / 5"), "success message shown");
  ok(!text().includes("Amina Otieno") || $$("button.air-open").every((e) => !e.textContent.includes("Amina Otieno")), "accepted item left the queue");
  ok(changed === 1, "onChanged called so the dashboard can refresh");
  ok(text().includes("Brian Kiptoo") && $(".air-paper") && text().includes("is not a whole number"), "the next suggestion opened automatically");

  console.log("FRACTIONAL (D1)");
  const acc2 = byText("button", "Accept AI mark");
  ok(acc2 && acc2.disabled, "Accept is disabled when the AI total is 3.5");
  ok(byText("button", "Give 3 / 5") && byText("button", "Give 4 / 5"), "the two whole-mark choices are offered");
  await click(byText("button", "Give 4 / 5"));
  ok(b.answer.marks_awarded === 4 && b.eval.review_state === "adjusted", "choosing 4 wrote it as an adjustment");
  ok(JSON.parse(store.adjustmentsOf(b.id)[0].after_json).roundedFromSuggestion === true, "recorded as rounding, not disagreement");

  console.log("EDIT CRITERIA + VALIDATION");
  await click(byText("button.air-open", "Cynthia Wanjiru"));
  ok(text().includes("Look closely at this one") && text().includes("can be read more than one way"), "the flag is explained in words");
  const c1 = $("#m-c1"), save = () => byText("button", "Save my mark");
  await type(c1, "2.5");
  ok(text().includes("at most 2") && save().disabled, "an out-of-range criterion mark is explained and Save stays disabled");
  await type(c1, "1.5");
  ok(text().includes("not a whole number") && save().disabled, "a fractional total is explained and Save stays disabled");
  await type(c1, "1");
  ok(!save().disabled && text().includes("Your mark: 4 / 5"), "a valid edit enables Save and shows the live total");
  await type($("#air-remark"), "Check the second point");
  await click(save());
  ok(c.answer.marks_awarded === 4 && c.eval.review_state === "adjusted" && c.answer.remarks === "Check the second point", "edited marks + remark saved");

  console.log("REJECT + REASON REQUIRED");
  await click(byText("button.air-open", "Xavier Mallory"));
  await click(byText("button", "Reject suggestion"));
  const confirm = byText("button", "Confirm");
  ok(confirm && confirm.disabled, "Confirm is disabled until a reason is typed");
  await type($("#air-reason"), "The model ignored my scheme");
  await click(byText("button", "Confirm"));
  ok(x.eval.review_state === "rejected" && x.answer.marks_awarded === null, "rejected: no mark written");
  ok(store.adjustmentsOf(x.id)[0].reason === "The model ignored my scheme", "reason stored");

  console.log("XSS");
  store.db.evals.get(x.id).review_state = "awaiting_review";            // reopen it for the check
  await act(async () => { root.render(React.createElement(Panel, { api: makeApi(store), key: "again" })); });
  await flush();
  await click(byText("button.air-open", "Xavier Mallory"));
  ok(!$(".air-paper img") && !$(".air-paper script") && !$(".air-paper b"), "no element from the student's HTML exists in the DOM");
  ok(window.PWNED === undefined && global.PWNED === undefined, "no script or event handler from the answer ran");
  ok(text($(".air-paper")).includes("glucose and oxygen"), "the readable text is still shown");

  console.log("RACE: marked by hand behind the UI's back");
  store.db.answers.get(x.answerId).marks_awarded = 2;
  await click(byText("button", "Accept 5 / 5"));
  ok(text().includes("already been marked"), "the teacher is told, in words");
  ok(x.answer.marks_awarded === 2 && x.eval.review_state === "awaiting_review", "their mark is untouched and nothing was claimed");
  ok(byText("button", "Accept 5 / 5") === undefined, "the screen reloaded: the blocker is shown and the Accept button is gone");
  ok(text().includes("Marking sheet") || $("[aria-label='Marking sheet']"), "the sheet is still there for reading");

  console.log("MARK IT MYSELF + FAILED TAB");
  const s2 = createMemoryReviewStore();
  const m1 = s2.add({ studentName: "Mary Njeri", assessmentId: 9 });
  const fail = s2.add({ studentName: "Fatuma Ali", status: "failed" });
  const api2 = makeApi(s2);
  const manual2 = [];
  await act(async () => { root.render(React.createElement(Panel, { api: api2, onMarkManually: (m) => manual2.push(m), key: "m2" })); });
  await flush();
  await click(byText("button.air-open", "Mary Njeri"));
  await click(byText("button", "Reject & mark it myself"));
  ok(manual2.length === 1 && manual2[0].assessmentId === 9 && manual2[0].answerId === m1.answerId, "onMarkManually receives where to go");
  ok(m1.eval.review_state === "rejected" && m1.answer.marks_awarded === null, "the suggestion was set aside, nothing marked for them");
  await click(byText("[role=tab]", "Could not be marked"));
  ok(text().includes("Fatuma Ali") && text().includes("nothing was charged"), "failed tab lists it and says nothing was charged");
  await click(byText("button.air-open", "Fatuma Ali"));
  const before = s2.db.adjustments.length;
  await click(byText("button", "Mark it myself"));
  ok(manual2.length === 2 && s2.db.adjustments.length === before, "for a failed answer it just navigates; nothing to reject");
  ok(!byText("button", "Accept"), "no Accept button when there is no suggestion");

  console.log("BULK ACCEPT");
  const s3 = createMemoryReviewStore();
  const k1 = s3.add({ studentName: "Kamau One" }), k2 = s3.add({ studentName: "Kamau Two" }), k3 = s3.add({ studentName: "Kamau Flagged", flags: ["off_topic"] });
  await act(async () => { root.render(React.createElement(Panel, { api: makeApi(s3), key: "m3" })); });
  await flush();
  const bulkBtn = () => byText("button", "selected");
  ok(bulkBtn() && bulkBtn().disabled, "bulk accept disabled with nothing selected");
  await click(byText("button", "Select all clean ones"));
  ok(!bulkBtn().disabled && bulkBtn().textContent.includes("2"), "selecting all clean picks only the two clean rows");
  await click(bulkBtn());
  ok(k1.answer.marks_awarded === 5 && k2.answer.marks_awarded === 5 && k3.answer.marks_awarded === null, "bulk accepted the clean ones only");
  ok(text().includes("Accepted 2"), "summary shown");
  ok(s3.adjustmentsOf(k1.id)[0].reason === "Bulk accept", "each is logged individually");

  console.log("HOSTILE STRINGS straight into every field (the panel must be safe on its own, whatever the server sends)");
  const EVIL = (n) => `<img src=x onerror="window.PWNED=${n}"><script>window.PWNED=${n}</script><b onmouseover="window.PWNED=${n}">x</b>`;
  const hostileApi = {
    get: async (url) => {
      if (url.endsWith("/review/queue")) return { data: { success: true, nextCursor: null, items: [{ id: 1, status: "success", suggestedTotal: 3, maxMarks: 5, flags: ["off_topic"], flagCount: 1, suggestedIsWhole: true, bulkAcceptable: false,
        failureNote: null, questionPreview: EVIL(1), assessment: { id: 1, title: EVIL(2), subject: EVIL(3) }, questionId: 1, submissionId: 1, student: { name: EVIL(4), admissionNo: EVIL(5) } }] } };
      return { data: { success: true, review: {
        evaluation: { id: 1, status: "success", reviewState: "awaiting_review", model: EVIL(6), failureNote: null },
        assessment: { id: 1, title: EVIL(7), subject: EVIL(8) }, student: { name: EVIL(9), admissionNo: EVIL(10) },
        question: { id: 1, text: EVIL(11), hasImage: false, maxMarks: 5 }, answer: { text: `Plants ${EVIL(12)} glucose`, hasImage: false, note: EVIL(13) },
        ai: { suggestedTotal: 3, suggestedIsWhole: true, wholeOptions: [], missingPoints: [EVIL(14)], flags: [{ code: "off_topic", text: EVIL(15) }],
          criteria: [{ criterionId: "c1", label: EVIL(16), maxMarks: 5, aiMarks: 3, evidence: [EVIL(17), "Plants"], matchedPoints: [0], explanation: EVIL(18), expectedPoints: [EVIL(19)], acceptableAlternatives: [EVIL(20)] }] },
        scheme: { versionId: 1, versionNo: 1, flaggedByPeople: 0 }, final: { teacherFinalMark: null, reviewedByYou: false }, existingRemark: EVIL(21),
        canApprove: true, blockers: [], manualMarking: { assessmentId: 1, submissionId: 1, questionId: 1, answerId: 1 },
        history: [{ id: 1, action: "reject", finalMark: null, reason: EVIL(22), by: EVIL(23), at: "x" }] } } };
    },
    post: async () => ({ data: { success: true } }),
  };
  await act(async () => { root.render(React.createElement(Panel, { api: hostileApi, key: "evil" })); });
  await flush();
  await click(byText("button.air-open", "<img"));
  const live = document.querySelector(".air");
  ok(live && live.querySelectorAll("img,script,iframe,object,embed,svg").length === 0, "no element from any hostile string exists anywhere in the panel");
  ok(live.querySelectorAll("[onerror],[onmouseover],[onclick]:not(button):not(input)").length === 0, "no injected event-handler attribute exists");
  ok(window.PWNED === undefined && global.PWNED === undefined, "nothing ran");
  ok(text(live).includes('<img src=x onerror="window.PWNED=12">'), "the hostile text is displayed literally, as harmless text");

  console.log("ERRORS DON'T BREAK MANUAL MARKING");
  const dead = { get: async () => { const e = new Error("net"); e.response = { status: 500, data: { message: "SELECT secret FROM x" } }; throw e; }, post: async () => { throw new Error("x"); } };
  await act(async () => { root.render(React.createElement(Panel, { api: dead, key: "dead" })); });
  await flush();
  ok(text().includes("Manual marking is not affected") && !text().includes("secret"), "an unavailable review list says so and leaks nothing");

  await act(async () => root.unmount());
  console.log(`\n${passed} passed, ${failures} failed`);
  try { require("fs").unlinkSync(OUT); } catch { /* scratch file */ }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
