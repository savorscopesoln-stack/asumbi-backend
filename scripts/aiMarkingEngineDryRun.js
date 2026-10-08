#!/usr/bin/env node
/* =========================================================================
   AI MARKING ENGINE — DRY RUN (no database, no wallet, no job)

   Marks a small JSON file of answers with the REAL provider so you can
   (1) confirm the adapter works against the live API, (2) measure real
   token use and cost per answer (Phase 12 pilot), and (3) eyeball the
   suggestions next to your own marks. Nothing is stored anywhere.

   Usage (set the same variables the server uses):
     AI_MARKING_PROVIDER=anthropic AI_MARKING_API_KEY=... AI_MARKING_MODEL=<model id> \
     AI_MARKING_COST_INPUT_PER_MTOK=<price> AI_MARKING_COST_OUTPUT_PER_MTOK=<price> \
     node scripts/aiMarkingEngineDryRun.js samples.json

   samples.json: an array of
     { "id": "q1-a", "questionText": "...", "maxMarks": 5,
       "criteria": [ { "criterionId":"c1","label":"...","maxMarks":2,
                       "expectedPoints":["..."],"acceptableAlternatives":["..."] } ],
       "answer": "student's answer text or HTML",
       "teacherMark": 4 }                       // optional, for comparison
   Use ANONYMISED answers only: this sends text to the provider.
========================================================================= */
const fs = require("fs");
const { resolveConfig, publicConfig } = require("../services/aiMarkingEngine.config");
const { createProvider } = require("../services/aiMarkingEngine.providers");
const { evaluateAnswer } = require("../services/aiMarkingEngine.service");

(async () => {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node scripts/aiMarkingEngineDryRun.js samples.json"); process.exit(1); }
  const config = resolveConfig(process.env);
  if (!config.configured) {
    console.error("Engine not configured:", [...config.missing, ...config.errors].join("; "));
    process.exit(1);
  }
  console.log("Config:", JSON.stringify(publicConfig(config)));
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = createProvider(config);
  let tokensIn = 0, tokensOut = 0, cost = 0, costKnown = true, agree = 0, compared = 0, absDiff = 0;

  for (const item of items) {
    const r = await evaluateAnswer(item, { config, provider });
    tokensIn += r.usage.inputTokens; tokensOut += r.usage.outputTokens;
    if (r.cost == null) costKnown = false; else cost += r.cost;
    if (r.ok) {
      const note = item.teacherMark != null ? ` | teacher ${item.teacherMark}` : "";
      console.log(`${item.id}: ${r.status} ${r.suggestedTotal}/${r.maxMarks}${note} | flags: ${r.reviewFlags.map((f) => f.code).join(",") || "-"} | tokens ${r.usage.inputTokens}/${r.usage.outputTokens}`);
      if (item.teacherMark != null) { compared += 1; absDiff += Math.abs(item.teacherMark - r.suggestedTotal); if (item.teacherMark === r.suggestedTotal) agree += 1; }
    } else {
      console.log(`${item.id}: FAILED ${r.code} (${r.message}) retryable=${r.retryable} systemic=${r.systemic}`);
      if (r.systemic) { console.log("Systemic failure — stopping."); break; }
    }
  }
  console.log(`\nTokens in/out: ${tokensIn}/${tokensOut}; avg per answer: ${Math.round(tokensIn / items.length)}/${Math.round(tokensOut / items.length)}`);
  console.log(costKnown ? `Provider cost: ${cost.toFixed(6)} ${config.costCurrency || "(currency not set)"} (avg ${(cost / items.length).toFixed(6)} per answer)` : "Provider cost unknown: set AI_MARKING_COST_*_PER_MTOK");
  if (compared) console.log(`Against ${compared} teacher marks: exact agreement ${agree}/${compared}, mean absolute difference ${(absDiff / compared).toFixed(2)} marks`);
})().catch((e) => { console.error("Dry run crashed:", e.message); process.exit(1); });
