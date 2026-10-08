/* MANUAL render check for the Phase 10 panels (not part of `npm test`: needs react, react-dom, esbuild, jsdom,
   which the backend does not depend on). It feeds the panels REAL output of the backend analytics services
   (in-memory store) through a fake axios client, mounts them in jsdom and prints what a user would read.

   Usage (from backend/):  FE_NODE_MODULES=/path/with/react+esbuild+jsdom node tests/manual/aiAnalyticsPanels.render.js */
const path = require("path");
const NM = process.env.FE_NODE_MODULES;
if (!NM) { console.error("Set FE_NODE_MODULES to a node_modules containing react, react-dom, esbuild and jsdom"); process.exit(2); }
const req = (m) => require(require.resolve(m, { paths: [NM, path.dirname(NM)] }));
const esbuild = req("esbuild"); const { JSDOM } = req("jsdom");
const { makeOperationalService, makeFinanceService } = require("../../services/aiMarkingAnalytics.service");
const { createMemoryAnalytics } = require("../helpers/memoryAnalyticsStore");

(async () => {
  const m = createMemoryAnalytics();
  m.db.teachers.set(11, "Alice");
  const j = m.addJob({ teacher_id: 11, e_assessment_id: 5, reserved_count: 12, processed_count: 12, actual_total: 120, seconds: 95 });
  const crit = JSON.stringify({ criteria: [{ criterionId: "c1", label: "Defines osmosis", maxMarks: 2, marksAwarded: 0, evidence: ["x"] }, { criterionId: "c2", label: "Gives an example", maxMarks: 2, marksAwarded: 2 }] });
  for (let i = 0; i < 12; i += 1) m.addEval({ job_id: j.id, review_state: i < 3 ? "adjusted" : "approved", suggested_total: 6, teacher_final_mark: i < 3 ? 4 : 6, processing_cost: 0.5, token_usage_json: JSON.stringify({ inputTokens: 900, outputTokens: 150, costCurrency: "KES" }), criteria_json: crit, review_seconds: 40 });
  m.addLedger({ job_id: j.id, entry_type: "consume", reserved_delta: -120 });
  m.db.position[11] = { total_answers: 40, eligible: 9, unmarked: 12, manually_marked: 7, blank: 2 }; m.db.position.institution = m.db.position[11];
  m.db.texts.set(1, "Explain osmosis.");
  const wallet = async () => ({ available: 340, currency: "KES", unitPrice: 10, aiMarkingEnabled: true });
  const ops = makeOperationalService({ store: m.operational, walletSummary: wallet });
  const fin = makeFinanceService({ openTenant: async () => ({ operational: m.operational, economics: m.economics }), listTenants: async () => ["demo"] });
  const routes = {
    "/ai-marking-analytics/teacher": async () => ops.forTeacher({ teacherId: 11 }),
    "/ai-marking-analytics/institution": async () => ops.forInstitution({}),
    "/finance/ai-marking/analytics": async () => fin.platform({}),
    "/finance/institutions/demo/ai-marking/analytics": async () => fin.forInstitution({ tenantKey: "demo" }),
  };
  const calls = [];
  const api = { get: async (url) => { calls.push(url); if (!routes[url]) throw new Error("unexpected url " + url); return { data: JSON.parse(JSON.stringify({ success: true, ...(await routes[url]()) })) }; } };

  const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true });
  Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const entry = `
    import React from "react"; import { createRoot } from "react-dom/client"; import { act } from "react";
    import A from ${JSON.stringify(path.resolve(__dirname, "../../../frontend/src/components/aiMarking/AiAnalyticsPanel.jsx"))};
    import F from ${JSON.stringify(path.resolve(__dirname, "../../../frontend/src/components/aiMarking/AiFinanceAnalyticsPanel.jsx"))};
    export async function mount(kind, props) { const el = document.createElement("div"); document.body.appendChild(el); const root = createRoot(el);
      await act(async () => { root.render(React.createElement(kind === "A" ? A : F, props)); }); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); el.querySelectorAll("style").forEach((n) => n.remove()); return el.textContent; }`;
  const out = await esbuild.build({ stdin: { contents: entry, resolveDir: __dirname, loader: "jsx" }, bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], nodePaths: [NM], logLevel: "error" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (id) => req(id));
  const show = (title, text, must, mustNot = []) => {
    const miss = must.filter((x) => !text.includes(x)), bad = mustNot.filter((x) => text.includes(x));
    console.log(`${miss.length || bad.length ? "FAIL" : "ok  "} ${title}${miss.length ? `  missing: ${miss.join(" | ")}` : ""}${bad.length ? `  LEAKED: ${bad.join(" | ")}` : ""}`);
    if (miss.length || bad.length) process.exitCode = 1;
  };
  const FIN_WORDS = ["Estimated gross margin", "Provider cost", "tokens per answer", "Finance view"];
  let t = await mod.exports.mount("A", { api, audience: "teacher" });
  show("teacher panel", t, ["Where marking stands now", "Eligible for AI marking", "Successfully processed", "Defines osmosis", "100%", "Mark moved by teacher", "KES", "AI marking credits available"], FIN_WORDS);
  t = await mod.exports.mount("A", { api, audience: "institution" });
  show("institution panel", t, ["Usage by teacher", "Alice", "Net charged"], FIN_WORDS);
  t = await mod.exports.mount("F", { api });
  show("finance platform panel", t, ["Finance view", "Estimated gross margin", "Ledger reconciliation", "By institution", "demo", "Complete."], []);
  t = await mod.exports.mount("F", { api, tenantKey: "demo" });
  show("finance institution panel", t, ["Charges in KES", "Spent on answers not charged", "Operational detail for this institution", "Defines osmosis"], []);
  console.log("requested:", calls.join(", "));
  console.log("\n--- finance institution panel text (first 700 chars) ---\n" + t.slice(0, 1400));
})().catch((e) => { console.error(e); process.exit(1); });
