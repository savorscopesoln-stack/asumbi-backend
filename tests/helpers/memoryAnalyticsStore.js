/* In-memory stand-in for the Phase 10 analytics stores. It honours SCOPE (teacher vs institution)
   and the period filter the way the SQL does, so service/controller tests can prove who sees what.
   It does NOT prove the T-SQL — see scripts/verifyAiMarkingWorkerSql.js for that. */
function createMemoryAnalytics() {
  const db = { jobs: [], evals: [], ledger: [], teachers: new Map(), texts: new Map(), position: {}, nextId: 1 };
  const inScope = (j, scope, range, assessmentId) => {
    if (scope.kind === "teacher" && Number(j.teacher_id) !== Number(scope.teacherId)) return false;
    if (range && range.from && j.createdAt < range.from) return false;
    if (range && range.toExclusive && j.createdAt >= range.toExclusive) return false;
    if (assessmentId && Number(j.e_assessment_id) !== Number(assessmentId)) return false;
    return true;
  };
  const jobsIn = (scope, range, a) => db.jobs.filter((j) => inScope(j, scope, range, a));
  const evalsIn = (scope, range, a) => { const ids = new Set(jobsIn(scope, range, a).map((j) => j.id)); return db.evals.filter((e) => ids.has(e.job_id)); };
  const operational = {
    calls: [],
    async position(scope) { this.calls.push(["position", scope]); return (scope.kind === "teacher" ? db.position[scope.teacherId] : db.position.institution) || {}; },
    async activity(scope, range, o = {}) {
      const jobs = jobsIn(scope, range, o.assessmentId); const by = {};
      for (const j of jobs) { const k = j.status; by[k] = by[k] || { status: k, jobs: 0, answers_claimed: 0, secs: [] }; by[k].jobs += 1; by[k].answers_claimed += j.reserved_count || 0; if (j.seconds != null) by[k].secs.push(j.seconds); }
      const jobRows = Object.values(by).map((x) => ({ status: x.status, jobs: x.jobs, answers_claimed: x.answers_claimed, avg_ai_seconds: x.secs.length ? x.secs.reduce((a, b) => a + b, 0) / x.secs.length : null }));
      const ev = evalsIn(scope, range, o.assessmentId); const g = {};
      for (const e of ev) { const k = `${e.status}|${e.review_state}`; g[k] = g[k] || { status: e.status, review_state: e.review_state, n: 0 }; g[k].n += 1; }
      const rv = ev.filter((e) => (e.review_state === "approved" || e.review_state === "adjusted") && e.review_seconds != null);
      return { jobRows, evalRows: Object.values(g), reviewRow: { reviewed: rv.length, avg_review_seconds: rv.length ? rv.reduce((a, e) => a + e.review_seconds, 0) / rv.length : null } };
    },
    async agreementRows(scope, range, o = {}) { return { rows: evalsIn(scope, range, o.assessmentId).filter((e) => ["approved", "adjusted", "rejected"].includes(e.review_state) && ["success", "needs_review"].includes(e.status)).map((e) => ({ evaluation_id: e.id, scheme_version_id: e.scheme_version_id || 1, question_id: e.question_id, max_marks: e.max_marks, suggested_total: e.suggested_total, teacher_final_mark: e.teacher_final_mark, review_state: e.review_state })), truncated: false }; },
    async criteriaRows(scope, range, o = {}) { return { rows: evalsIn(scope, range, o.assessmentId).filter((e) => e.criteria_json && ["success", "needs_review"].includes(e.status)).map((e) => ({ question_id: e.question_id, scheme_version_id: e.scheme_version_id || 1, criteria_json: e.criteria_json })), truncated: false }; },
    async questionTexts(ids) { return new Map(ids.filter((i) => db.texts.has(i)).map((i) => [i, db.texts.get(i)])); },
    async byTeacher(range, o = {}) {
      const by = new Map();
      for (const j of jobsIn({ kind: "institution" }, range, o.assessmentId)) { const t = by.get(j.teacher_id) || { teacher_id: j.teacher_id, teacher_name: db.teachers.get(j.teacher_id) || null, jobs: 0, processed: 0, failed: 0 }; t.jobs += 1; t.processed += j.processed_count || 0; t.failed += j.failed_count || 0; by.set(j.teacher_id, t); }
      return [...by.values()];
    },
    async charges(scope, range, o = {}) {
      const jobs = new Map(jobsIn(scope, range, o.assessmentId).map((j) => [j.id, j]));
      const agg = (rows, pick) => { const m = new Map(); for (const r of rows) { const j = jobs.get(pick(r)); if (!j) continue; const k = `${j.currency}|${o.perTeacher ? j.teacher_id : ""}`; const cur = m.get(k) || { currency: j.currency, ...(o.perTeacher ? { teacher_id: j.teacher_id } : {}), amount: 0 }; cur.amount += r.amount; m.set(k, cur); } return [...m.values()]; };
      const consume = db.ledger.filter((l) => l.entry_type === "consume").map((l) => ({ job: l.job_id, amount: -l.reserved_delta }));
      const reversed = db.ledger.filter((l) => l.entry_type === "reverse").map((r) => { const orig = db.ledger.find((x) => x.id === r.reverses); return orig && orig.entry_type === "consume" ? { job: orig.job_id, amount: r.amount_delta } : null; }).filter(Boolean);
      return { grossRows: agg(consume, (r) => r.job), refundRows: agg(reversed, (r) => r.job) };
    },
  };
  const economics = {
    fail: false,
    async costRows(range) {
      if (this.fail) throw new Error("tenant down");
      const jobs = new Map(jobsIn({ kind: "institution" }, range).map((j) => [j.id, j]));
      return { rows: db.evals.filter((e) => jobs.has(e.job_id)).map((e) => ({ id: e.id, currency: jobs.get(e.job_id).currency, status: e.status, processing_cost: e.processing_cost ?? null, token_usage_json: e.token_usage_json ?? null, reused: e.reused ? 1 : 0 })), truncated: false };
    },
    async reconciliation(range) {
      const jobs = jobsIn({ kind: "institution" }, range).filter((j) => ["completed", "failed", "cancelled"].includes(j.status));
      let bad = 0;
      for (const j of jobs) { const c = db.ledger.filter((l) => l.entry_type === "consume" && l.job_id === j.id).reduce((a, l) => a - l.reserved_delta, 0); if (Math.abs((j.actual_total || 0) - c) > 0.00005) bad += 1; }
      return { jobsChecked: jobs.length, mismatched: bad };
    },
  };
  return {
    db, operational, economics,
    addJob(j) { const job = { id: db.nextId++, currency: "KES", status: "completed", createdAt: new Date("2026-09-15T10:00:00Z"), reserved_count: 0, processed_count: 0, failed_count: 0, actual_total: 0, ...j }; db.jobs.push(job); return job; },
    addEval(e) { const ev = { id: db.nextId++, status: "success", review_state: "awaiting_review", question_id: 1, max_marks: 10, ...e }; db.evals.push(ev); return ev; },
    addLedger(l) { const row = { id: db.nextId++, ...l }; db.ledger.push(row); return row; },
  };
}
module.exports = { createMemoryAnalytics };
