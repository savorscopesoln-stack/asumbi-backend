/* =========================================================================
   IN-MEMORY WORKER STORE + FAKE CLOCK  (tests only)

   Implements the same interface as services/aiMarkingWorker.store.js, with
   the same compare-and-set semantics, so the worker's LOGIC can be tested
   (leases, backoff, restarts, duplicate delivery, cancellation, pauses)
   without a database or a provider.

   WHAT THIS PROVES: the worker behaves correctly GIVEN a store that honours
   the contract written in the SQL file's comments.
   WHAT IT DOES NOT PROVE: that the T-SQL in the real store honours it. That
   needs a real SQL Server — tests/README.md "Phase 6 checklist". The
   contract's most important clauses are asserted statically against the SQL
   text in aiMarkingWorker.test.js (every evaluation UPDATE is
   compare-and-set; nothing writes marks or touches money).

   Every method yields to the event loop first, so two workers sharing one
   store genuinely interleave. `hooks` let a test inject a race at an exact
   moment (e.g. a teacher marks the answer between the model call and the write).
========================================================================= */
const crypto = require("crypto");

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Time only moves when a test (or a sleeping worker) moves it. Doubles as "database time". */
function createFakeClock(start = 1_000_000) {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms) => { await tick(); c.t += Math.max(0, ms); },
    advance: (ms) => { c.t += ms; },
    sleeps: [],
  };
  const realSleep = c.sleep;
  c.sleep = async (ms) => { c.sleeps.push(ms); return realSleep(ms); };
  return c;
}

const sha = (text) => crypto.createHash("sha256").update(Buffer.from(String(text), "utf16le")).digest("hex");

function createMemoryWorkerStore(clock) {
  const db = {
    jobs: new Map(), evals: new Map(), answers: new Map(), submissions: new Map(),
    questions: new Map(), students: new Map(), schemes: new Map(),
    nextEval: 1,
  };
  const hooks = {};   // name -> async (arg) => void
  const calls = [];   // method log, for assertions
  const hook = async (name, arg) => { if (hooks[name]) await hooks[name](arg); };
  const paused = (j) => j.paused_until != null && j.paused_until > clock.now();

  const jobView = (j) => ({ id: j.id, status: j.status, cancelRequested: !!j.cancel_requested, paused: paused(j) });

  const store = {
    db, hooks, calls,

    /* ------- fixtures ------- */
    addJob(over = {}) {
      const id = over.id || db.jobs.size + 1;
      const j = { id, status: "reserved", cancel_requested: 0, locked_by: null, locked_until: null, paused_until: null, pause_reason: null,
        pause_count: 0, attempt_count: 0, started_at: null, model: null, provider: null, last_error: null, createdAt: clock.now(), ...over };
      db.jobs.set(id, j);
      return j;
    },
    /** One answer + its pending evaluation, fully wired. */
    addAnswer(over = {}) {
      const n = db.nextEval;
      const o = {
        jobId: 1, essay: `<p>Answer number ${n} about photosynthesis in plants.</p>`, marksAwarded: null, submissionStatus: "submitted",
        questionId: 100, questionMarks: 10, maxMarks: 10, studentName: `Student${n} Person${n}`, admissionNo: `ADM${1000 + n}`,
        schemeVersionId: 7, criteria: [{ criterionId: "C1", label: "x", maxMarks: 10, expectedPoints: ["p"] }], ...over,
      };
      const evalId = db.nextEval++;
      db.answers.set(n, { id: n, submission_id: n, essay_answer: o.essay, marks_awarded: o.marksAwarded });
      db.submissions.set(n, { id: n, status: o.submissionStatus, student_id: n });
      db.students.set(n, { name: o.studentName, admissionNo: o.admissionNo });
      if (!db.questions.has(o.questionId)) db.questions.set(o.questionId, { id: o.questionId, question_text: "<p>Explain photosynthesis.</p>", marks: o.questionMarks });
      else if (over.questionMarks != null) db.questions.get(o.questionId).marks = o.questionMarks;
      if (!db.schemes.has(o.schemeVersionId)) db.schemes.set(o.schemeVersionId, { id: o.schemeVersionId, criteria_json: o.criteria == null ? null : JSON.stringify(o.criteria) });
      const e = {
        id: evalId, job_id: o.jobId, submission_id: n, question_id: o.questionId, answer_id: n, answer_content_hash: sha(o.essay),
        max_marks: o.maxMarks, scheme_version_id: o.schemeVersionId, status: "pending", attempt_count: 0, next_attempt_at: null,
        token_usage_json: null, processing_cost: null, criteria_json: null, suggested_total: null, review_flags: null, review_state: "awaiting_review",
        model: null, prompt_version: null, last_error: null, reused_from_evaluation_id: null, completed_at: null,
      };
      db.evals.set(evalId, e);
      return { evalId, answerId: n, submissionId: n, eval: e };
    },
    evalsOf: (jobId) => [...db.evals.values()].filter((e) => e.job_id === jobId),
    countBy: (jobId, status) => [...db.evals.values()].filter((e) => e.job_id === jobId && e.status === status).length,

    /* ------- the store contract ------- */
    async listActiveJobs() {
      await tick(); calls.push("listActiveJobs");
      return [...db.jobs.values()].filter((j) => j.status === "reserved" || j.status === "processing").sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).map(jobView);
    },
    async leaseJob(jobId, workerId, leaseMs, { model = null, provider = null } = {}) {
      await tick(); calls.push("leaseJob");
      const j = db.jobs.get(jobId);
      if (!j || !(j.status === "reserved" || j.status === "processing")) return null;
      const free = j.locked_until == null || j.locked_until <= clock.now() || j.locked_by === workerId;
      if (!free || paused(j)) return null;
      j.locked_by = workerId; j.locked_until = clock.now() + leaseMs;
      if (j.status === "reserved") j.status = "processing";
      j.started_at = j.started_at ?? clock.now(); j.model = j.model ?? model; j.provider = j.provider ?? provider;
      return { id: j.id, status: j.status, cancelRequested: !!j.cancel_requested, pauseCount: j.pause_count, errorCount: j.attempt_count };
    },
    async renewLease(jobId, workerId, leaseMs) {
      await tick();
      const j = db.jobs.get(jobId);
      if (!j || j.locked_by !== workerId || !(j.status === "reserved" || j.status === "processing")) return false;
      j.locked_until = clock.now() + leaseMs; return true;
    },
    async releaseLease(jobId, workerId) {
      await tick(); const j = db.jobs.get(jobId);
      if (j && j.locked_by === workerId) { j.locked_by = null; j.locked_until = null; }
    },
    async getJobState(jobId) {
      await tick(); const j = db.jobs.get(jobId);
      return j ? { status: j.status, cancelRequested: !!j.cancel_requested, paused: paused(j) } : null;
    },
    async pauseJob(jobId, ms, reason) {
      await tick(); calls.push("pauseJob");
      const j = db.jobs.get(jobId);
      if (j && (j.status === "reserved" || j.status === "processing")) { j.paused_until = clock.now() + ms; j.pause_reason = reason; j.pause_count += 1; j.last_error = reason; }
    },
    async recordJobError(jobId, message) {
      await tick(); const j = db.jobs.get(jobId); if (!j) return 0; j.attempt_count += 1; j.last_error = message; return j.attempt_count;
    },
    async markJobHealthy(jobId) {
      await tick(); const j = db.jobs.get(jobId); if (!j) return; j.attempt_count = 0; j.pause_count = 0; j.pause_reason = null;
    },

    async claimEvaluations(jobId, limit, leaseMs) {
      await tick(); calls.push("claimEvaluations");
      const out = [];
      for (const e of [...db.evals.values()].sort((a, b) => a.id - b.id)) {
        if (out.length >= limit) break;
        if (e.job_id !== jobId || e.status !== "pending") continue;
        if (e.next_attempt_at != null && e.next_attempt_at > clock.now()) continue;
        e.next_attempt_at = clock.now() + leaseMs; e.attempt_count += 1;
        out.push({ id: e.id, attempt: e.attempt_count });
      }
      return out;
    },
    async countOpen(jobId) {
      await tick();
      const pend = [...db.evals.values()].filter((e) => e.job_id === jobId && e.status === "pending");
      const waiting = pend.filter((e) => e.next_attempt_at != null && e.next_attempt_at > clock.now());
      const dues = pend.filter((e) => e.next_attempt_at != null).map((e) => e.next_attempt_at - clock.now());
      return { pending: pend.length, waiting: waiting.length, wakeInMs: dues.length ? Math.max(0, Math.min(...dues)) : null };
    },
    async loadWorkItem(evalId) {
      await tick(); calls.push("loadWorkItem");
      await hook("beforeLoad", evalId);
      const e = db.evals.get(evalId); if (!e) return null;
      const a = db.answers.get(e.answer_id), q = db.questions.get(e.question_id), s = db.submissions.get(e.submission_id);
      const st = s && db.students.get(s.student_id), sv = db.schemes.get(e.scheme_version_id);
      return {
        id: e.id, jobId: e.job_id, status: e.status, attempt: e.attempt_count, questionId: e.question_id, schemeVersionId: e.scheme_version_id,
        answerHash: e.answer_content_hash, currentHash: a ? sha(a.essay_answer) : null, maxMarks: Number(e.max_marks),
        questionMarks: q ? Number(q.marks) : null, questionText: q && q.question_text, answerHtml: a && a.essay_answer,
        marksAwarded: a && a.marks_awarded != null ? Number(a.marks_awarded) : null, submissionStatus: s && s.status,
        criteriaJson: sv && sv.criteria_json, studentName: st ? st.name : null, admissionNo: st ? st.admissionNo : null,
        tokenUsageJson: e.token_usage_json, processingCost: e.processing_cost, answerFound: !!a && a.essay_answer != null,
      };
    },
    async findReusable(item, { promptVersion, model }) {
      await tick(); calls.push("findReusable");
      const r = [...db.evals.values()].filter((e) => e.id !== item.id && e.question_id === item.questionId && e.answer_content_hash === item.answerHash
        && e.scheme_version_id === item.schemeVersionId && e.prompt_version === promptVersion && e.model === model && Number(e.max_marks) === Number(item.maxMarks)
        && (e.status === "success" || e.status === "needs_review") && !["rejected", "superseded"].includes(e.review_state)
        && e.criteria_json != null && e.suggested_total != null).sort((a, b) => a.id - b.id)[0];
      // mirrors the SQL: disputed exact work is never copied
      const disputed = [...db.evals.values()].some((d) => d.question_id === item.questionId && d.answer_content_hash === item.answerHash
        && d.scheme_version_id === item.schemeVersionId && ["rejected", "superseded"].includes(d.review_state));
      if (disputed) return null;
      return r ? { id: r.id, status: r.status, criteriaJson: r.criteria_json, suggestedTotal: Number(r.suggested_total), reviewFlags: r.review_flags } : null;
    },
    async recordResult(evalId, row, { guarded }) {
      await tick(); calls.push(`recordResult${guarded ? ":guarded" : ""}`);
      await hook("beforeRecordResult", evalId);
      const e = db.evals.get(evalId);
      const a = e && db.answers.get(e.answer_id), s = e && db.submissions.get(e.submission_id);
      const guardOk = !guarded || (a && a.marks_awarded == null && s && s.status !== "released");
      if (e && e.status === "pending" && guardOk) {
        Object.assign(e, {
          status: row.status, model: row.model || null, prompt_version: row.prompt_version || null, criteria_json: row.criteria_json,
          suggested_total: row.suggested_total, review_flags: row.review_flags,
          token_usage_json: row.token_usage_json ?? e.token_usage_json, processing_cost: row.processing_cost ?? e.processing_cost,
          last_error: row.last_error, reused_from_evaluation_id: row.reused_from_evaluation_id ?? null, next_attempt_at: null, completed_at: clock.now(),
        });
        return "written";
      }
      if (!e || e.status !== "pending") return "lost";
      if (s && s.status === "released") return "released";
      if (a && a.marks_awarded != null) return "answer_marked";
      return "lost";
    },
    async scheduleRetry(evalId, delayMs, { error, tokenUsageJson, cost }) {
      await tick(); calls.push("scheduleRetry");
      const e = db.evals.get(evalId); if (!e || e.status !== "pending") return false;
      e.next_attempt_at = clock.now() + delayMs; e.last_error = error; e.token_usage_json = tokenUsageJson; e.processing_cost = cost; return true;
    },
    async releaseClaim(evalId, { error, tokenUsageJson, cost, keepAttempt = false }) {
      await tick(); calls.push("releaseClaim");
      const e = db.evals.get(evalId); if (!e || e.status !== "pending") return false;
      e.next_attempt_at = null; if (!keepAttempt && e.attempt_count > 0) e.attempt_count -= 1;
      e.last_error = error; e.token_usage_json = tokenUsageJson ?? e.token_usage_json; e.processing_cost = cost ?? e.processing_cost; return true;
    },
    async cancelEvaluation(evalId, reason, { tokenUsageJson, cost }) {
      await tick(); calls.push("cancelEvaluation");
      const e = db.evals.get(evalId); if (!e || e.status !== "pending") return false;
      Object.assign(e, { status: "cancelled", last_error: reason, token_usage_json: tokenUsageJson ?? e.token_usage_json, processing_cost: cost ?? e.processing_cost, next_attempt_at: null, completed_at: clock.now() });
      return true;
    },
    async addLateSpend(evalId, { cost }) {
      await tick(); calls.push("addLateSpend");
      const e = db.evals.get(evalId);
      if (e && ["cancelled", "success", "needs_review", "failed"].includes(e.status)) e.processing_cost = (e.processing_cost ?? 0) + cost;
    },
    async measureThroughput() { await tick(); return store.throughput || null; },
    async countQueued() { await tick(); return [...db.evals.values()].filter((e) => e.status === "pending" && ["reserved", "processing"].includes(db.jobs.get(e.job_id)?.status)).length; },
  };
  return store;
}

module.exports = { createMemoryWorkerStore, createFakeClock, sha };
