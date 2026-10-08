const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { suite, test } = require("./helpers/tinytest");
const L = require("../services/aiMarkingAnalytics.logic");
const { makeOperationalService, makeFinanceService } = require("../services/aiMarkingAnalytics.service");
const { makeAnalyticsController } = require("../controllers/aiMarkingAnalytics.controller");
const { createMemoryAnalytics } = require("./helpers/memoryAnalyticsStore");
const { answerFactsSql } = require("../services/aiMarkingEligibility.service");

suite("aiMarkingAnalytics.test.js");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const keysDeep = (o, out = new Set()) => { if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keysDeep(v, out); } return out; };
async function rejects(p) { try { await p; } catch (e) { return e; } return null; }
const usage = (cur = "USD", i = 1000, o = 200) => JSON.stringify({ inputTokens: i, outputTokens: o, costCurrency: cur });
const FIN = ["providerCost", "estimatedGrossMargin", "estimatedGrossMarginPct", "economics", "tokens", "processing_cost", "token_usage_json", "averageCostPerBilledAnswer", "costOnUnbilledAttempts"];

/* ------------------------------------------------------------------ logic: period */

test("period: valid dates, 'to' becomes exclusive next-day, bad/inverted/impossible dates are 400", () => {
  const r = L.parseRange({ from: "2026-09-01", to: "2026-09-30" });
  assert.strictEqual(r.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.strictEqual(r.toExclusive.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.deepStrictEqual(L.parseRange({}).label, { from: null, to: null });
  for (const bad of [{ from: "yesterday" }, { to: "2026-13-01" }, { from: "2026-02-30" }, { from: "2026-10-02", to: "2026-10-01" }]) {
    try { L.parseRange(bad); assert.fail("should throw"); } catch (e) { assert.strictEqual(e.statusCode, 400); }
  }
});

/* ------------------------------------------------------------------ logic: operational */

test("activity: processed counts success+needs_review only, failure rate ignores cancelled, review outcomes only for answers that had a suggestion", () => {
  const a = L.shapeActivity({
    jobRows: [{ status: "completed", jobs: 2, answers_claimed: 30, avg_ai_seconds: 100 }, { status: "processing", jobs: 1, answers_claimed: 10, avg_ai_seconds: null }],
    evalRows: [
      { status: "success", review_state: "approved", n: 10 }, { status: "success", review_state: "adjusted", n: 5 },
      { status: "needs_review", review_state: "awaiting_review", n: 5 }, { status: "success", review_state: "rejected", n: 2 },
      { status: "failed", review_state: "awaiting_review", n: 4 }, { status: "cancelled", review_state: "awaiting_review", n: 9 },
    ],
    reviewRow: { reviewed: 15, avg_review_seconds: 61.6 },
  });
  assert.strictEqual(a.requests, 3); assert.strictEqual(a.answersRequested, 40);
  assert.strictEqual(a.processed, 22); assert.strictEqual(a.failed, 4); assert.strictEqual(a.cancelled, 9);
  assert.strictEqual(a.failureRatePct, 15.4);                       // 4 / (22 + 4); cancelled never counted
  assert.strictEqual(a.review.teacherApproved, 15); assert.strictEqual(a.review.modifiedByTeacher, 5);
  assert.strictEqual(a.review.modifiedSharePct, 33.3);
  assert.strictEqual(a.review.awaiting, 5);                          // the failed/cancelled 'awaiting_review' rows are not review work
  assert.strictEqual(a.turnaround.aiAverageSeconds, 100); assert.strictEqual(a.turnaround.reviewAverageSeconds, 62);
});

test("activity: no data gives nulls, never invented zeros for rates and averages", () => {
  const a = L.shapeActivity({});
  assert.strictEqual(a.requests, 0); assert.strictEqual(a.failureRatePct, null);
  assert.strictEqual(a.turnaround.aiAverageSeconds, null); assert.strictEqual(a.turnaround.reviewAverageSeconds, null);
  assert.strictEqual(a.review.modifiedSharePct, null);
});

test("agreement: uses the states Phase 7 really writes ('adjusted' = teacher moved the mark) and counts rejections as disagreement", () => {
  const row = (state, ai, fin) => ({ evaluation_id: 1, scheme_version_id: 1, question_id: 1, max_marks: 10, suggested_total: ai, teacher_final_mark: fin, review_state: state });
  const rows = [...Array(6).fill(0).map(() => row("approved", 6, 6)), ...Array(2).fill(0).map(() => row("adjusted", 6, 3)), row("rejected", null, null), row("rejected", null, null)];
  const g = L.shapeAgreement(rows, false);
  assert.strictEqual(g.decisions, 10); assert.strictEqual(g.kept, 6); assert.strictEqual(g.moved, 2); assert.strictEqual(g.rejected, 2);
  assert.strictEqual(g.agreementRatePct, 60);
  assert.ok(g.agreementLowPct < 60 && g.agreementHighPct > 60);
  assert.strictEqual(g.enoughData, true);
  assert.strictEqual(L.shapeAgreement([], false).agreementRatePct, null);
});

test("agreement: a small sample says it has not enough data", () => {
  const g = L.shapeAgreement([{ scheme_version_id: 1, question_id: 1, max_marks: 10, suggested_total: 5, teacher_final_mark: 5, review_state: "approved" }], false);
  assert.strictEqual(g.enoughData, false);
});

test("missed criteria: ranked by how often full marks were NOT awarded, small samples hidden, evidence never read, bad JSON ignored", () => {
  const crit = (id, got, max = 2, extra = {}) => ({ criterionId: id, label: `L-${id}`, maxMarks: max, marksAwarded: got, evidence: ["SECRET STUDENT TEXT"], ...extra });
  const mk = (list) => ({ question_id: 7, scheme_version_id: 3, criteria_json: JSON.stringify({ criteria: list, missingPoints: ["x"] }) });
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(mk([crit("a", i < 8 ? 0 : 2), crit("b", 2)]));   // a missed 80%, b never
  for (let i = 0; i < 4; i += 1) rows.push(mk([crit("rare", 0)]));                             // under the minimum sample
  rows.push({ question_id: 7, scheme_version_id: 3, criteria_json: "{not json" });
  const out = L.missedCriteria(rows, new Map([[7, "Q seven"]]));
  assert.deepStrictEqual(out.map((c) => c.criterionId), ["a", "b"]);
  assert.strictEqual(out[0].missedPct, 80); assert.strictEqual(out[0].zeroPct, 80); assert.strictEqual(out[0].evaluated, 10);
  assert.strictEqual(out[1].missedPct, 0); assert.strictEqual(out[0].questionText, "Q seven");
  assert.ok(!JSON.stringify(out).includes("SECRET STUDENT TEXT"));
});

/* ------------------------------------------------------------------ logic: billing + economics */

test("billing: net = consumed - reversed, per currency, exact to 4 places (no float drift)", () => {
  const b = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 0.1 }, { currency: "KES", amount: 0.2 }, { currency: "USD", amount: 5 }], refundRows: [{ currency: "KES", amount: 0.1 }] });
  assert.deepStrictEqual(b.map((x) => [x.currency, x.charged, x.reversed, x.net]), [["KES", 0.3, 0.1, 0.2], ["USD", 5, 0, 5]]);
});

test("economics: complete data gives margin and averages; unbilled spend is reported, not hidden", () => {
  const billing = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 100 }], refundRows: [] });
  const e = L.shapeEconomics({ billing, costRows: [
    ...Array(10).fill(0).map(() => ({ currency: "KES", status: "success", processing_cost: 3, token_usage_json: usage("KES") })),
    { currency: "KES", status: "failed", processing_cost: 5, token_usage_json: usage("KES") },
  ] }).byCurrency[0];
  assert.strictEqual(e.marginStatus, "COMPLETE");
  assert.strictEqual(e.billedAnswers, 10);
  assert.strictEqual(e.providerCost[0].total, 35);
  assert.strictEqual(e.costOnUnbilledAttempts, 5);
  assert.strictEqual(e.averageCostPerBilledAnswer, 3);
  assert.strictEqual(e.averageCostFullyLoaded, 3.5);                  // the failed call's cost is carried by the billed answers
  assert.strictEqual(e.estimatedGrossMargin, 65); assert.strictEqual(e.estimatedGrossMarginPct, 65);
  assert.strictEqual(e.averagePricePerAnswer, 10);
  assert.strictEqual(e.tokens.averageInputPerAnswer, 1000);
});

test("economics: unknown cost is never treated as zero — margin is flagged incomplete; reused answers are not 'unknown'", () => {
  const billing = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 40 }], refundRows: [] });
  const e = L.shapeEconomics({ billing, costRows: [
    { currency: "KES", status: "success", processing_cost: 3, token_usage_json: usage("KES") },
    { currency: "KES", status: "success", processing_cost: null, token_usage_json: null },
    { currency: "KES", status: "success", processing_cost: null, token_usage_json: null, reused: 1 },
  ] }).byCurrency[0];
  assert.strictEqual(e.marginStatus, "INCOMPLETE_COST");
  assert.strictEqual(e.billedAnswersWithUnknownCost, 1);
  assert.strictEqual(e.averageCostFullyLoaded, null);                 // refuses to average over a gap
  // Over the 2 billed answers whose cost is known: the real one (3) and the reused copy, which cost nothing (0).
  assert.strictEqual(e.averageCostPerBilledAnswer, 1.5);
});

test("economics: provider cost in another currency gives NO margin and NO conversion", () => {
  const billing = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 1300 }], refundRows: [] });
  const e = L.shapeEconomics({ billing, costRows: [{ currency: "KES", status: "success", processing_cost: 0.01, token_usage_json: usage("USD") }] }).byCurrency[0];
  assert.strictEqual(e.marginStatus, "CURRENCY_MISMATCH");
  assert.strictEqual(e.estimatedGrossMargin, null); assert.strictEqual(e.averageCostFullyLoaded, null);
  assert.deepStrictEqual(e.providerCost, [{ costCurrency: "USD", total: 0.01 }]);
});

test("economics: charges but no cost recorded at all -> NO_COST_DATA, not a 100% margin", () => {
  const billing = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 50 }], refundRows: [] });
  const e = L.shapeEconomics({ billing, costRows: [{ currency: "KES", status: "success", processing_cost: null, token_usage_json: null }] }).byCurrency[0];
  assert.strictEqual(e.marginStatus, "NO_COST_DATA");
  assert.strictEqual(e.estimatedGrossMargin, null, "a margin computed from no cost would be a flattering fiction");
  const none = L.shapeEconomics({ billing, costRows: [] }).byCurrency[0];
  assert.strictEqual(none.billedAnswers, 0);
});

test("economics: reversals reduce net charge and therefore margin", () => {
  const billing = L.shapeBilling({ grossRows: [{ currency: "KES", amount: 100 }], refundRows: [{ currency: "KES", amount: 40 }] });
  const e = L.shapeEconomics({ billing, costRows: [{ currency: "KES", status: "success", processing_cost: 10, token_usage_json: usage("KES") }] }).byCurrency[0];
  assert.strictEqual(e.netCharged, 60); assert.strictEqual(e.estimatedGrossMargin, 50);
});

test("economics: folding two tenants into one accumulator equals pooling their rows", () => {
  const rowsA = [{ currency: "KES", status: "success", processing_cost: 2, token_usage_json: usage("KES") }];
  const rowsB = [{ currency: "KES", status: "success", processing_cost: 4, token_usage_json: usage("KES") }, { currency: "KES", status: "failed", processing_cost: 1, token_usage_json: usage("KES") }];
  const bill = (n) => L.shapeBilling({ grossRows: [{ currency: "KES", amount: n }], refundRows: [] });
  const acc = L.newCostAcc(); L.addCostRows(acc, rowsA); L.addCostRows(acc, rowsB);
  const folded = L.finishEconomics(acc, L.mergeBilling([bill(20), bill(30)])).byCurrency[0];
  const pooled = L.shapeEconomics({ costRows: [...rowsA, ...rowsB], billing: bill(50) }).byCurrency[0];
  assert.deepStrictEqual(folded, pooled);
  assert.strictEqual(folded.estimatedGrossMargin, 43);
});

/* ------------------------------------------------------------------ service: scope + separation */

function seed() {
  const m = createMemoryAnalytics();
  m.db.teachers.set(11, "Alice"); m.db.teachers.set(12, "Bob");
  const a = m.addJob({ teacher_id: 11, e_assessment_id: 5, reserved_count: 3, processed_count: 3, actual_total: 30, seconds: 120 });
  const b = m.addJob({ teacher_id: 12, e_assessment_id: 5, reserved_count: 2, processed_count: 2, actual_total: 20, seconds: 60 });
  for (let i = 0; i < 3; i += 1) m.addEval({ job_id: a.id, review_state: i === 0 ? "adjusted" : "approved", suggested_total: 6, teacher_final_mark: i === 0 ? 3 : 6, processing_cost: 1, token_usage_json: usage("KES"), review_seconds: 30 });
  for (let i = 0; i < 2; i += 1) m.addEval({ job_id: b.id, review_state: "approved", suggested_total: 6, teacher_final_mark: 6, processing_cost: 1, token_usage_json: usage("KES") });
  m.addLedger({ job_id: a.id, entry_type: "consume", reserved_delta: -30 });
  m.addLedger({ job_id: b.id, entry_type: "consume", reserved_delta: -20 });
  m.db.position[11] = { total_answers: 10, eligible: 4 }; m.db.position[12] = { total_answers: 6, eligible: 1 }; m.db.position.institution = { total_answers: 16, eligible: 5 };
  return { m, a, b };
}

test("service: a teacher sees only their own jobs, answers and charges", async () => {
  const { m } = seed();
  const out = await makeOperationalService({ store: m.operational }).forTeacher({ teacherId: 11 });
  assert.strictEqual(out.operational.activity.requests, 1);
  assert.strictEqual(out.operational.activity.processed, 3);
  assert.deepStrictEqual(out.billing.byCurrency.map((x) => x.net), [30]);
  assert.strictEqual(out.operational.position.essayAnswers, 10);
  assert.strictEqual(out.operational.agreement.moved, 1);
  assert.strictEqual(out.byTeacher, undefined, "a teacher gets no per-teacher breakdown");
});

test("service: an institution admin sees all of the institution, with usage and charges per teacher", async () => {
  const { m } = seed();
  const out = await makeOperationalService({ store: m.operational }).forInstitution({});
  assert.strictEqual(out.operational.activity.requests, 2); assert.strictEqual(out.operational.activity.processed, 5);
  assert.strictEqual(out.billing.byCurrency[0].net, 50);
  assert.deepStrictEqual(out.byTeacher.map((t) => [t.name, t.processed, t.billing[0].net]).sort(), [["Alice", 3, 30], ["Bob", 2, 20]]);
  assert.strictEqual(out.operational.position.essayAnswers, 16);
});

test("SEPARATION: teacher and institution responses contain no provider cost, token, economics or margin field anywhere", async () => {
  const { m } = seed();
  const svc = makeOperationalService({ store: m.operational });
  for (const out of [await svc.forTeacher({ teacherId: 11 }), await svc.forInstitution({})]) {
    const keys = keysDeep(out);
    for (const f of FIN) assert.ok(!keys.has(f), `operational response leaks ${f}`);
  }
});

test("service: period filter limits jobs, and a date outside the data gives zeros, not errors", async () => {
  const { m } = seed();
  const svc = makeOperationalService({ store: m.operational });
  assert.strictEqual((await svc.forInstitution({ from: "2026-09-01", to: "2026-09-30" })).operational.activity.requests, 2);
  const empty = await svc.forInstitution({ from: "2025-01-01", to: "2025-01-31" });
  assert.strictEqual(empty.operational.activity.requests, 0);
  assert.deepStrictEqual(empty.billing.byCurrency, []);
  assert.strictEqual((await rejects(svc.forInstitution({ from: "nope" }))).statusCode, 400);
  assert.strictEqual((await rejects(svc.forInstitution({ assessmentId: "abc" }))).statusCode, 400);
});

test("service: teacher id must be a real id (no id, no data)", async () => {
  const { m } = seed();
  const e = await rejects(makeOperationalService({ store: m.operational }).forTeacher({ teacherId: undefined }));
  assert.strictEqual(e.statusCode, 401);
});

test("FINANCE reconciliation: reversing a charge lowers net revenue; a job whose actual_total disagrees with the ledger is reported", async () => {
  const { m, a } = seed();
  const consume = m.db.ledger.find((l) => l.job_id === a.id);
  m.addLedger({ job_id: a.id, entry_type: "reverse", reverses: consume.id, amount_delta: 10 });
  const fin = makeFinanceService({ openTenant: async () => ({ operational: m.operational, economics: m.economics }), listTenants: async () => ["t1"] });
  const r = await fin.forInstitution({ tenantKey: "t1" });
  assert.strictEqual(r.economics.byCurrency[0].netCharged, 40);        // 50 consumed - 10 reversed
  assert.strictEqual(r.economics.byCurrency[0].estimatedGrossMargin, 35); // 40 - 5 x cost 1
  assert.strictEqual(r.reconciliation.ok, true);
  a.actual_total = 29;                                                 // job record drifts from the ledger
  const bad = await fin.forInstitution({ tenantKey: "t1" });
  assert.strictEqual(bad.reconciliation.ok, false); assert.strictEqual(bad.reconciliation.mismatched, 1);
});

test("FINANCE platform: sums tenants; a failing tenant is shown as unavailable and the result is marked incomplete, never as zero", async () => {
  const one = seed(), two = seed();
  two.m.economics.fail = true;
  const stores = { t1: one.m, t2: two.m };
  const fin = makeFinanceService({ openTenant: async (k) => ({ operational: stores[k].operational, economics: stores[k].economics }), listTenants: async () => ["t1", "t2"] });
  const r = await fin.platform({});
  assert.strictEqual(r.complete, false); assert.strictEqual(r.institutionsUnavailable, 1);
  assert.deepStrictEqual(r.institutions.map((i) => [i.tenantKey, i.available]), [["t1", true], ["t2", false]]);
  assert.strictEqual(r.economics.byCurrency[0].netCharged, 50);
  two.m.economics.fail = false;
  const ok = await fin.platform({});
  assert.strictEqual(ok.complete, true); assert.strictEqual(ok.economics.byCurrency[0].netCharged, 100);
  assert.strictEqual(ok.economics.byCurrency[0].estimatedGrossMargin, 90);
});

/* ------------------------------------------------------------------ controller: who may call what */

function mockRes() { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }
function controller(m, extra = {}) {
  return makeAnalyticsController({
    operationalStoreFactory: () => m.operational, economicsStoreFactory: () => m.economics, walletFactory: () => async () => ({ available: 100, currency: "KES" }),
    getPool: async () => ({}), listTenantKeys: () => ["t1"], assertValidTenant: (k) => { if (k !== "t1") { const e = new Error("Unknown institution"); e.statusCode = 404; throw e; } }, ...extra,
  });
}

test("controller: the teacher endpoint is for teachers only — admin, finance and anonymous are refused; the id comes from the login, not the query", async () => {
  const { m } = seed(); const c = controller(m);
  for (const role of ["admin", "module_admin", "finance", "student", ""]) { const res = mockRes(); await c.teacher({ user: { id: 11, role }, query: {} }, res); assert.strictEqual(res.code, 403, role); }
  const res = mockRes();
  await c.teacher({ user: { id: 11, role: "teacher" }, query: { teacherId: "12", scope: "institution" }, pool: {} }, res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.operational.activity.requests, 1, "query-string teacherId must be ignored");
  assert.strictEqual(res.body.wallet.available, 100);
});

test("controller: the institution endpoint is for administrators only; a teacher cannot read institution-wide data", async () => {
  const { m } = seed(); const c = controller(m);
  for (const role of ["teacher", "finance", "student", "sub_admin"]) { const res = mockRes(); await c.institution({ user: { id: 1, role }, query: {} }, res); assert.strictEqual(res.code, 403, role); }
  for (const role of ["admin", "module_admin"]) { const res = mockRes(); await c.institution({ user: { id: 1, role }, query: {}, pool: {} }, res); assert.strictEqual(res.code, 200); assert.strictEqual(res.body.operational.activity.requests, 2); }
});

test("controller: finance analytics are for finance only — institution admins and teachers get 403; unknown tenant is 404", async () => {
  const { m } = seed(); const c = controller(m);
  for (const role of ["admin", "module_admin", "teacher", "student"]) {
    for (const fn of ["financePlatform", "financeInstitution"]) { const res = mockRes(); await c[fn]({ user: { id: 1, role }, query: {}, params: { tenantKey: "t1" } }, res); assert.strictEqual(res.code, 403, `${role}/${fn}`); }
  }
  const ok = mockRes(); await c.financeInstitution({ user: { id: 1, role: "finance" }, query: {}, params: { tenantKey: "t1" } }, ok);
  assert.strictEqual(ok.code, 200); assert.ok(ok.body.economics.byCurrency.length);
  const nf = mockRes(); await c.financeInstitution({ user: { id: 1, role: "finance" }, query: {}, params: { tenantKey: "other" } }, nf);
  assert.strictEqual(nf.code, 404);
});

test("controller: bad input is a 400; an unexpected failure is a generic 500 that leaks nothing", async () => {
  const { m } = seed(); const c = controller(m);
  const bad = mockRes(); await c.institution({ user: { id: 1, role: "admin" }, query: { from: "x" }, pool: {} }, bad);
  assert.strictEqual(bad.code, 400);
  m.operational.position = async () => { throw new Error("SECRET connection string xyz"); };
  const boom = mockRes(); await c.institution({ user: { id: 1, role: "admin" }, query: {}, pool: {} }, boom);
  assert.strictEqual(boom.code, 500); assert.ok(!JSON.stringify(boom.body).includes("SECRET"));
});

/* ------------------------------------------------------------------ SQL text + wiring (not behaviour) */

test("SQL: analytics is read-only; the operational store never selects provider cost or tokens; cost lives only in the economics store", () => {
  const src = stripComments(read("services/aiMarkingAnalytics.store.js"));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXEC)\b/i.test(src), "analytics SQL must be read-only");
  assert.ok(!/JSON_VALUE|OPENJSON|ISJSON|PERCENTILE_CONT/i.test(src));
  const split = src.indexOf("function createSqlEconomicsStore");
  const operationalPart = src.slice(0, split), economicsPart = src.slice(split);
  for (const col of ["processing_cost", "token_usage_json"]) { assert.ok(!operationalPart.includes(col), `operational store reads ${col}`); assert.ok(economicsPart.includes(col)); }
  const selects = operationalPart.match(/SELECT[\s\S]*?FROM/g).join(" ");
  for (const col of ["essay_answer", "answer_content_hash", "student_id", "submission_id", "evidence", "ev.answer_id"]) assert.ok(!selects.includes(col), `selects ${col}`);
});

test("SQL: every query is scoped — teacher scope filters on the teacher, 'by teacher' is institution-only, ledger charges join the job", () => {
  const src = stripComments(read("services/aiMarkingAnalytics.store.js"));
  assert.ok(/\.teacher_id = @scopeTeacher/.test(src) && /scope\.kind === "teacher"/.test(src));
  assert.ok(/byTeacher\(range[^)]*\)\s*\{[\s\S]*?kind: "institution"/.test(src));
  const raw = read("services/aiMarkingAnalytics.store.js");
  const grossQuery = raw.slice(raw.indexOf("analytics:charges-gross"), raw.indexOf("analytics:charges-reversed"));
  assert.ok(grossQuery.length > 50, "query markers moved");
  assert.ok(/WHERE l\.entry_type = 'consume' AND/.test(grossQuery), "gross charges must count consume rows only (not topups, reserves or releases)");
  assert.ok(/JOIN ai_marking_jobs j ON j\.id = l\.ai_marking_job_id/.test(grossQuery));
  assert.ok(/JOIN ai_marking_ledger c ON c\.id = r\.reverses_ledger_id AND c\.entry_type = 'consume'/.test(src));
  assert.ok(/ev\.review_state IN \('approved', 'adjusted', 'rejected'\)/.test(src));
  assert.ok(/ev\.status IN \('success', 'needs_review'\)/.test(src));
});

test("SQL: answerFactsSql keeps the teacher-assignment join by default and drops it only when asked for institution-wide", () => {
  assert.ok(answerFactsSql("").includes("asg.teacher_id = @teacherId"));
  assert.ok(!answerFactsSql("", { institutionWide: true }).includes("e_assessment_submission_assignments"));
  const eligUsers = read("services/aiMarkingEligibility.service.js");
  assert.ok(!/institutionWide:\s*true/.test(eligUsers.replace(/\/\/.*$/gm, "")), "no teacher-facing caller may pass institutionWide");
});

test("wiring: routes are mounted, guarded and finance-only where required", () => {
  const server = read("server.js");
  assert.ok(server.includes('app.use("/api/ai-marking-analytics"'));
  const router = read("routes/aiMarkingAnalytics.js");
  assert.ok(router.includes("router.use(protect)"));
  assert.ok(/router\.get\("\/teacher", authorize\("teacher"\), heavy, c\.teacher\)/.test(router));
  assert.ok(/router\.get\("\/institution", authorize\("admin"\), heavy, c\.institution\)/.test(router));
  const fin = read("routes/finance.js");
  assert.ok(fin.indexOf("router.use(protect, financeOnly)") < fin.indexOf("analytics.financePlatform"));
  assert.ok(/router\.get\("\/ai-marking\/analytics", aiFinanceLimit, analytics\.financePlatform\)/.test(fin));
  assert.ok(/"\/institutions\/:tenantKey\/ai-marking\/analytics", aiFinanceLimit, analytics\.financeInstitution/.test(fin));
  assert.ok(!/finance/i.test(router.replace(/\/\*[\s\S]*?\*\//g, "")), "teacher/institution router must not expose finance handlers");
});
