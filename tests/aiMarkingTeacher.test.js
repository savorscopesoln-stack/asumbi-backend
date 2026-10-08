/* =========================================================================
   AI MARKING — PHASE 3 (teacher dashboard counts, selection, preview/quote)

   WHAT THIS PROVES: selection validation, that ids are bound (never
   interpolated), that the eligibility SQL contains every rule in the
   service header, the quote / blocker / fingerprint logic, and that the
   controller trusts only req.pool + req.user (never a client tenant, count
   or price).

   WHAT THIS DOES NOT PROVE: that the T-SQL returns the right rows. There is
   no SQL Server here, so the query text is asserted, not executed. Run the
   manual checklist in tests/README.md (Phase 3) against a tenant copy.
========================================================================= */
const { suite, test, assert } = require("./helpers/tinytest");
const Module = require("module");
const path = require("path");

suite("aiMarkingTeacher.test.js");

/* ---- load the real services with a minimal mssql stand-in ---- */
const fakeSql = new Proxy({}, { get: (_t, k) => (k === "NVarChar" ? () => "NVarChar" : k) });
const svcDir = path.resolve(__dirname, "../services");
const eligPath = path.join(svcDir, "aiMarkingEligibility.service.js");
const ledgerPath = path.join(svcDir, "aiMarkingLedger.service.js");
const ctrlPath = path.resolve(__dirname, "../controllers/aiMarkingTeacher.controller.js");
for (const p of [eligPath, ledgerPath, ctrlPath]) delete require.cache[p];
const originalLoad = Module._load;
Module._load = function patched(request, parent, ...rest) {
  if (request === "mssql") return fakeSql;
  return originalLoad.call(this, request, parent, ...rest);
};
let elig, ledger, controller;
try { elig = require(eligPath); ledger = require(ledgerPath); controller = require(ctrlPath); }
finally { Module._load = originalLoad; }

/* ---- stub pool: records every query, answers by keyword ---- */
function makePool(answers = {}) {
  const log = [];
  const pool = {
    log,
    request() {
      const params = {};
      const req = {
        input(name, _type, value) { params[name] = value; return req; },
        async query(text) {
          log.push({ text, params: { ...params } });
          if (/COUNT\(\*\)\s+AS selected_answers/.test(text)) return { recordset: [answers.preview || {}] };
          if (/total_answers/.test(text)) return { recordset: [answers.dashboard || {}] };
          if (/GROUP BY assessment_id/.test(text)) return { recordset: answers.breakdown || [] };
          if (/FROM e_assessments ea\s+JOIN e_assessment_submissions s ON s\.e_assessment_id = ea\.id/.test(text)) return { recordset: answers.assessments || [] };
          if (/FROM e_assessment_questions q/.test(text)) return { recordset: answers.questions || [] };
          if (/FROM e_assessment_submissions s/.test(text)) return { recordset: answers.submissions || [] };
          return { recordset: [] };
        },
      };
      return req;
    },
  };
  return pool;
}

function stubLedger({ pricing, wallet, affordable = true }) {
  const saved = { p: ledger.getActivePricing, w: ledger.getOrCreateInstitutionWallet, a: ledger.checkAffordability };
  ledger.getActivePricing = async () => pricing;
  ledger.getOrCreateInstitutionWallet = async () => wallet;
  ledger.checkAffordability = async () => ({ affordable });
  return () => { ledger.getActivePricing = saved.p; ledger.getOrCreateInstitutionWallet = saved.w; ledger.checkAffordability = saved.a; };
}
const PRICE = { id: 7, price_per_answer: 5, currency: "KES", volume_discount_json: null, institution_wallets_enabled: true };
const WALLET = { id: 1, available_balance: 1000, reserved_balance: 0, currency: "KES" };

// shares stubbed module state, so run these strictly in order
let chain = Promise.resolve();
const seq = (name, fn) => test(name, () => { const p = chain.then(fn); chain = p.catch(() => {}); return p; });

/* ------------------------------ selection ------------------------------ */
seq("normaliseSelection keeps only known keys and de-duplicates ids", () => {
  const s = elig.normaliseSelection({ eAssessmentId: "4", questionIds: [1, 1, "2"], tenantKey: "other", price: 0, count: 9999 });
  assert.deepStrictEqual(s, { eAssessmentId: 4, subject: null, questionIds: [1, 2], submissionIds: null, studentIds: null });
});
seq("normaliseSelection rejects bad ids, non-arrays and oversize lists", () => {
  for (const bad of [{ questionIds: "1,2" }, { questionIds: [0] }, { studentIds: [1.5] }, { eAssessmentId: -3 }, { submissionIds: ["x"] }]) {
    assert.throws(() => elig.normaliseSelection(bad), (e) => e.code === "INVALID_SELECTION" && e.statusCode === 400);
  }
  assert.throws(() => elig.normaliseSelection({ questionIds: Array.from({ length: elig.MAX_ID_LIST + 1 }, (_, i) => i + 1) }));
});
seq("applySelection binds ids as parameters and never interpolates them", () => {
  const params = {};
  const req = { input(n, _t, v) { params[n] = v; return req; } };
  const clause = elig.applySelection(req, elig.normaliseSelection({ eAssessmentId: 4, subject: "Biology'; DROP TABLE x;--", questionIds: [11, 12] }));
  assert.ok(!/DROP|11|12/.test(clause), "no raw values in SQL text: " + clause);
  assert.strictEqual(params.selAssessment, 4);
  assert.strictEqual(params.selSubject, "Biology'; DROP TABLE x;--");
  assert.deepStrictEqual([params.selQ0, params.selQ1], [11, 12]);
});
seq("an explicitly empty id list selects nothing instead of everything", () => {
  const req = { input() { return req; } };
  assert.ok(/1 = 0/.test(elig.applySelection(req, elig.normaliseSelection({ studentIds: [] }))));
});

/* ------------------------------ eligibility SQL ------------------------------ */
seq("facts SQL encodes every eligibility rule", () => {
  const sqlText = elig.answerFactsSql("");
  assert.ok(/e_assessment_submission_assignments asg ON asg\.submission_id = s\.id AND asg\.teacher_id = @teacherId/.test(sqlText), "assignment scoping");
  assert.ok(/a\.marks_awarded IS NOT NULL/.test(sqlText), "marked test");
  assert.ok(/s\.status = 'released'/.test(sqlText), "released test");
  assert.ok(/ev\.status IN \('pending','success','needs_review'\)/.test(sqlText), "live-evaluation exclusion; failed must NOT block");
  assert.ok(!/'failed'\)\s*\n?\s*\) THEN 1 ELSE 0 END AS has_live_eval/.test(sqlText), "failed is not 'live'");
  assert.ok(/sv\.status = 'approved'/.test(sqlText), "approved scheme required");
  assert.ok(/LOWER\(q\.question_type\) IN \('essay'\)/.test(sqlText), "essay only");
  assert.ok(/&nbsp;/.test(sqlText) && /<p>/.test(sqlText), "empty rich text counts as blank");
});
seq("preview filters billable on blank/released/marked/live-eval/scheme", async () => {
  const pool = makePool({ preview: { billable: 3 } });
  const restore = stubLedger({ pricing: PRICE, wallet: WALLET });
  try {
    await elig.buildPreview(pool, { teacherId: 9, selection: {} });
    const q = pool.log.find((l) => /AS selected_answers/.test(l.text)).text;
    const flat = q.replace(/\s+/g, " ");
    assert.ok(/WHEN is_blank = 0 AND is_released = 0 AND is_marked = 0 AND has_live_eval = 0 AND has_scheme = 1 THEN 1 ELSE 0 END\) AS billable/.test(flat), "billable bucket must require every rule");
    assert.strictEqual(pool.log[0].params.teacherId, 9);
  } finally { restore(); }
});

/* ------------------------------ preview ------------------------------ */
const row = (o) => ({ selected_answers: 0, blank: 0, released: 0, already_marked: 0, already_evaluated: 0, needs_scheme: 0, billable: 0, ...o });

seq("quote is computed server-side from the billable count and the active price", async () => {
  const pool = makePool({ preview: row({ selected_answers: 30, blank: 2, already_marked: 5, needs_scheme: 3, billable: 20 }) });
  const restore = stubLedger({ pricing: PRICE, wallet: WALLET });
  try {
    const p = await elig.buildPreview(pool, { teacherId: 9, selection: { eAssessmentId: 4, price: 0.01, count: 1 } });
    assert.strictEqual(p.counts.billable, 20);
    assert.strictEqual(p.quote.unitPrice, 5);
    assert.strictEqual(p.quote.total, 100);
    assert.strictEqual(p.wallet.available, 1000);
    assert.strictEqual(p.wallet.remainingAfterReservation, 900);
    assert.deepStrictEqual(p.blockers, []);
    assert.strictEqual(p.canProceed, true);
    assert.strictEqual(p.estimatedSeconds, null);
    assert.ok(/^[0-9a-f]{64}$/.test(p.quoteFingerprint));
  } finally { restore(); }
});
seq("volume discount tiers flow through the quote", async () => {
  const tiered = { ...PRICE, volume_discount_json: JSON.stringify([{ minQty: 10, pricePerAnswer: 4 }]) };
  const restore = stubLedger({ pricing: tiered, wallet: WALLET });
  try {
    const p = await elig.buildPreview(makePool({ preview: row({ billable: 10 }) }), { teacherId: 9 });
    assert.strictEqual(p.quote.unitPrice, 4);
    assert.strictEqual(p.quote.total, 40);
  } finally { restore(); }
});
seq("insufficient balance blocks and reports the shortfall without throwing", async () => {
  const restore = stubLedger({ pricing: PRICE, wallet: { ...WALLET, available_balance: 50 }, affordable: false });
  try {
    const p = await elig.buildPreview(makePool({ preview: row({ billable: 20 }) }), { teacherId: 9 });
    assert.deepStrictEqual(p.blockers, ["INSUFFICIENT_CREDITS"]);
    assert.strictEqual(p.canProceed, false);
    assert.strictEqual(p.wallet.remainingAfterReservation, -50);
  } finally { restore(); }
});
seq("no price configured and disabled institution wallets both block", async () => {
  let restore = stubLedger({ pricing: null, wallet: WALLET });
  try {
    const p = await elig.buildPreview(makePool({ preview: row({ billable: 4 }) }), { teacherId: 9 });
    assert.ok(p.blockers.includes("NO_PRICE")); assert.strictEqual(p.quote, null); assert.strictEqual(p.quoteFingerprint, null);
  } finally { restore(); }
  restore = stubLedger({ pricing: { ...PRICE, institution_wallets_enabled: false }, wallet: WALLET });
  try {
    const p = await elig.buildPreview(makePool({ preview: row({ billable: 4 }) }), { teacherId: 9 });
    assert.ok(p.blockers.includes("INSTITUTION_WALLET_DISABLED"));
  } finally { restore(); }
});
seq("zero billable answers is NOTHING_ELIGIBLE and costs nothing", async () => {
  const restore = stubLedger({ pricing: PRICE, wallet: WALLET });
  try {
    const p = await elig.buildPreview(makePool({ preview: row({ selected_answers: 12, needs_scheme: 12 }) }), { teacherId: 9 });
    assert.strictEqual(p.quote.total, 0);
    assert.deepStrictEqual(p.blockers, ["NOTHING_ELIGIBLE"]);
    assert.strictEqual(p.counts.needsScheme, 12);
  } finally { restore(); }
});
seq("fingerprint changes when the count or price changes, not otherwise", async () => {
  const get = async (billable, price) => {
    const restore = stubLedger({ pricing: { ...PRICE, price_per_answer: price }, wallet: WALLET });
    try { return (await elig.buildPreview(makePool({ preview: row({ billable }) }), { teacherId: 9, selection: { eAssessmentId: 4 } })).quoteFingerprint; }
    finally { restore(); }
  };
  const a = await get(10, 5);
  assert.strictEqual(a, await get(10, 5));
  assert.notStrictEqual(a, await get(11, 5));
  assert.notStrictEqual(a, await get(10, 6));
});

/* ------------------------------ dashboard ------------------------------ */
seq("dashboard maps SQL aggregates and coerces nulls to zero", async () => {
  const pool = makePool({ dashboard: { total_answers: 40, blank: 3, manually_marked: 10, ai_awaiting_review: 6, approved_ai: 4, unmarked: 14, needs_attention: 2 } });
  const c = await elig.dashboardCounts(pool, { teacherId: 9, selection: { eAssessmentId: "4" } });
  assert.deepStrictEqual(c, { totalAnswers: 40, blank: 3, manuallyMarked: 10, aiAwaitingReview: 6, approvedAi: 4, unmarked: 14, needsAttention: 2 });
  assert.deepStrictEqual(await elig.dashboardCounts(makePool({ dashboard: { total_answers: null } }), { teacherId: 9 }),
    { totalAnswers: 0, blank: 0, manuallyMarked: 0, aiAwaitingReview: 0, approvedAi: 0, unmarked: 0, needsAttention: 0 });
});
seq("dashboard SQL is scoped to the teacher", async () => {
  const pool = makePool({ dashboard: {} });
  await elig.dashboardCounts(pool, { teacherId: 77 });
  assert.strictEqual(pool.log[0].params.teacherId, 77);
  assert.ok(/asg\.teacher_id = @teacherId/.test(pool.log[0].text));
});

/* ------------------------------ controller ------------------------------ */
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

seq("controller uses req.pool and req.user.id; ignores client tenant/teacher/price/count", async () => {
  const pool = makePool({ preview: row({ billable: 2 }) });
  const restore = stubLedger({ pricing: PRICE, wallet: WALLET });
  try {
    const r = res();
    await controller.previewSelection({
      pool, user: { id: 9, role: "teacher" },
      body: { eAssessmentId: 4, tenantKey: "someone-else", teacherId: 1, unitPrice: 0, billable: 99999, quotedTotal: 0 },
    }, r);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.preview.counts.billable, 2);
    assert.strictEqual(r.body.preview.quote.total, 10);
    assert.strictEqual(pool.log[0].params.teacherId, 9);
    assert.ok(!("tenantKey" in r.body.preview.selection) && !("teacherId" in r.body.preview.selection));
  } finally { restore(); }
});
seq("controller: bad selection is a 400, missing user is a 401, DB failure hides internals", async () => {
  const r1 = res();
  await controller.previewSelection({ pool: makePool(), user: { id: 9 }, body: { questionIds: "nope" } }, r1);
  assert.strictEqual(r1.statusCode, 400);
  const r2 = res();
  await controller.getDashboard({ pool: makePool(), user: undefined, query: {} }, r2);
  assert.strictEqual(r2.statusCode, 401);
  const boom = { request() { throw new Error("secret connection string"); } };
  const r3 = res();
  const origErr = console.error; console.error = () => {};
  try { await controller.getDashboard({ pool: boom, user: { id: 9 }, query: {} }, r3); } finally { console.error = origErr; }
  assert.strictEqual(r3.statusCode, 500);
  assert.ok(!/secret/.test(JSON.stringify(r3.body)));
});
seq("selectable lists are assignment-scoped and flag scheme availability", async () => {
  const pool = makePool({
    assessments: [{ id: 4, title: "Biology P2", subject: "Biology", submissions: 30 }],
    questions: [{ id: 11, question_text: "Explain...", marks: 10, has_scheme: 1 }, { id: 12, question_text: "Describe...", marks: 8, has_scheme: 0 }],
    submissions: [{ submission_id: 100, student_id: 5, status: "submitted" }],
  });
  const d = await elig.resolveSelectable(pool, { teacherId: 9, eAssessmentId: 4 });
  assert.strictEqual(d.questions[0].has_scheme, true);
  assert.strictEqual(d.questions[1].has_scheme, false);
  assert.ok(pool.log.every((l) => /@teacherId/.test(l.text)), "every list query is teacher-scoped");
  let threw = null;
  try { await elig.resolveSelectable(pool, { teacherId: 9, eAssessmentId: "x" }); } catch (e) { threw = e; }
  assert.ok(threw && threw.statusCode === 400, "non-numeric assessment id is rejected");
});
