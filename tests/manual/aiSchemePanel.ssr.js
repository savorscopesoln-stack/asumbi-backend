/* =========================================================================
   MANUAL SSR SMOKE TEST — AiSchemePanel.jsx renders without crashing

   Not part of `node tests/run-all.js`. It needs React, react-dom and a JSX
   loader (tsx). It renders the panel's FIRST paint with react-dom/server and
   checks the output. Effects and clicks do NOT run in server rendering, so
   this proves only: the file compiles, the first screen renders, hostile text
   props cannot inject markup, and nothing throws on missing props.
   It does NOT prove behaviour (open a question, edit, approve) or looks.
   For those, mount the panel in the app and walk the Phase 8 checklist in
   tests/README.md, or add a jsdom test like tests/manual/aiReviewPanel.render.js.

   Run:  npx tsx backend/tests/manual/aiSchemePanel.ssr.js     (repo root, react installed)
   (tsx compiles JSX the classic way, which needs React in scope; the Vite app uses the automatic
   runtime and does not. The line below only bridges that difference for this test.)
========================================================================= */
const React = require("react");
globalThis.React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const Panel = require("../../../frontend/src/components/aiMarking/AiSchemePanel.jsx").default;

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed += 1; };
const api = { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };

const html = renderToStaticMarkup(React.createElement(Panel, { api, assessmentId: 1 }));
check("renders the first screen", html.includes("Marking schemes for AI marking") && html.includes("Loading"));
check("includes its own scoped styles and no script tags", html.includes(".ais") && !/<script/i.test(html));
check("renders with no assessment id and no onChanged", renderToStaticMarkup(React.createElement(Panel, { api })).includes("ais"));
const hostile = renderToStaticMarkup(React.createElement(Panel, { api, assessmentId: 1, basePath: "<img src=x onerror=alert(1)>" }));
check("a hostile prop is never rendered as markup", !/<img/i.test(hostile));
process.exit(failed ? 1 : 0);
