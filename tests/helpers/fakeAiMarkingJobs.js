/* =========================================================================
   FAKE jobs / evaluations / answers FOR PHASE 4

   Layers on tests/helpers/fakeAiMarkingDb.js (wallet + ledger, with real
   lock / rollback / unique-index semantics) and adds the tables
   services/aiMarkingJobs.service.js touches. It dispatches on the
   job:/eval:/ledger: comment tags the service puts at the top of each
   statement (e.g. a job:insert tag), so it is
   a model of THOSE statements, not a T-SQL engine.

   WHAT IT MODELS ON PURPOSE (these are what the tests lean on)
   - READ COMMITTED visibility: a row written inside an open transaction is
     invisible to other connections until it commits.
   - Blocking on uniqueness: inserting a key that an OPEN transaction holds
     waits for that transaction to finish, then fails (committed) or succeeds
     (rolled back) — what SQL Server does, not an instant error.
   - Rollback undoes every write of the transaction.
   - The unique index on jobs.idempotency_key and the cross-job unique index
     UQ_ai_marking_evaluations_live_answer (live status, not superseded).
   - The billable predicate (blank / released / marked / live evaluation /
     approved scheme / assigned teacher / selection filters) evaluated in JS.

   WHAT IT DOES NOT PROVE: that the T-SQL parses or performs, that the real
   index/locking behaves identically, HASHBYTES availability, or anything
   about CHECK constraints. Those need one run on a real SQL Server copy
   (see tests/README.md, Phase 4 checklist).
========================================================================= */
const Module = require("module");
const path = require("path");
const { createFakeDb } = require("./fakeAiMarkingDb");

const LIVE = new Set(["pending", "success", "needs_review"]);

function uniqueError(index) {
  const err = new Error(`Violation of UNIQUE KEY constraint ${index}. Cannot insert duplicate key.`);
  err.number = 2627;
  return err;
}

function createJobsFake() {
  const base = createFakeDb();
  const { state } = base;
  Object.assign(state, {
    answers: [],        // the e_assessment_answers universe (see addAnswer)
    jobs: [],
    evals: [],
    nextJobId: 1,
    nextEvalId: 1,
    beforeClaim: null,  // async (tx) => void  — lets a test interleave a competing writer
    jobQueryLog: [],
  });

  function addAnswer(a) {
    const row = {
      answer_id: a.answer_id ?? state.answers.length + 1,
      submission_id: a.submission_id ?? a.answer_id ?? state.answers.length + 1,
      question_id: a.question_id ?? 1,
      assessment_id: a.assessment_id ?? 1,
      subject: a.subject ?? "Biology",
      student_id: a.student_id ?? a.submission_id ?? a.answer_id,
      teacher_id: a.teacher_id ?? 9,
      question_marks: a.question_marks ?? 10,
      blank: !!a.blank, marked: !!a.marked, released: !!a.released,
      has_scheme: a.has_scheme !== false, scheme_id: a.scheme_id ?? 100 + (a.question_id ?? 1),
    };
    state.answers.push(row);
    return row;
  }

  /* ---- visibility / waiting helpers ---- */
  const visible = (row, tx) => !row._tx || !row._tx.active || row._tx === tx;
  async function waitFor(row) {
    while (row._tx && row._tx.active) await new Promise((resolve) => row._tx.after.push(resolve));
  }
  const clone = (r) => { const { _tx, ...rest } = r; return { ...rest }; };
  function write(tx, row, patch) {
    const prev = {}; for (const k of Object.keys(patch)) prev[k] = row[k];
    Object.assign(row, patch);
    if (tx) tx.undo.push(() => Object.assign(row, prev));
  }

  /* ---- the billable predicate over the answers universe ---- */
  function selectionMatches(a, i) {
    const vals = (re) => Object.keys(i).filter((k) => re.test(k)).map((k) => i[k]);
    if (i.selAssessment != null && a.assessment_id !== i.selAssessment) return false;
    if (i.selSubject != null && a.subject !== i.selSubject) return false;
    const qs = vals(/^selQ\d+$/), subs = vals(/^selS\d+$/), studs = vals(/^selSt\d+$/);
    if (qs.length && !qs.includes(a.question_id)) return false;
    if (subs.length && !subs.includes(a.submission_id)) return false;
    if (studs.length && !studs.includes(a.student_id)) return false;
    return true;
  }
  function billableRows(i, tx) {
    return state.answers.filter((a) => {
      if (a.teacher_id !== i.teacherId) return false;
      if (!selectionMatches(a, i)) return false;
      const liveEval = state.evals.some((e) => e.submission_id === a.submission_id && e.question_id === a.question_id && LIVE.has(e.status) && e.review_state !== "superseded" && visible(e, tx));
      return !a.blank && !a.released && !a.marked && !liveEval && a.has_scheme;
    });
  }

  /* ---- statement handlers ---- */
  const ok = (recordset = [], affected = recordset.length) => ({ recordset, rowsAffected: [affected] });

  state.extra.push(async (q, i, tx) => {
    const tag = (q.match(/\/\*(job:[\w-]+|eval:[\w-]+|ledger:[\w-]+)\*\//) || [])[1];
    if (!tag) return undefined;
    state.jobQueryLog.push(tag);

    switch (tag) {
      case "job:find-by-key": {
        const row = state.jobs.find((j) => j.idempotency_key === i.key);
        if (row) await waitFor(row);
        const again = state.jobs.find((j) => j.idempotency_key === i.key);
        return ok(again ? [clone(again)] : []);
      }
      case "job:read": {
        const row = state.jobs.find((j) => j.id === i.id);
        if (row) await waitFor(row);
        const again = state.jobs.find((j) => j.id === i.id);
        return ok(again ? [clone(again)] : []);
      }
      case "job:list": {
        const rows = state.jobs.filter((j) => j.teacher_id === i.teacherId && visible(j, tx)).sort((a, b) => b.id - a.id).slice(0, i.limit);
        return ok(rows.map(clone));
      }
      case "job:insert": {
        if (!tx) throw new Error("job INSERT outside a transaction");
        for (;;) {
          const dup = state.jobs.find((j) => j.idempotency_key === i.key);
          if (!dup) break;
          if (dup._tx && dup._tx.active && dup._tx !== tx) { await waitFor(dup); continue; }   // block, then re-check
          throw uniqueError("UQ_ai_marking_jobs_idempotency_key");
        }
        const row = {
          id: state.nextJobId++, e_assessment_id: i.eAssessmentId, teacher_id: i.teacherId, selection_criteria: i.selection,
          wallet_id: i.walletId, pricing_id: null, eligible_count: 0, reserved_count: 0, processed_count: 0, failed_count: 0, cancelled_count: 0,
          unit_price: 0, quoted_total: 0, actual_total: 0, currency: i.currency, status: "pending", idempotency_key: i.key,
          cancel_requested: 0, last_error: null, createdAt: new Date(), completedAt: null, _tx: tx,
        };
        state.jobs.push(row);
        tx.undo.push(() => { state.jobs.splice(state.jobs.indexOf(row), 1); });
        return ok([{ id: row.id }]);
      }
      case "job:precount": {
        if (!tx) throw new Error("precount outside a transaction");
        return ok([{ n: billableRows(i, tx).length }]);
      }
      case "job:claim": {
        if (!tx) throw new Error("claim outside a transaction");
        if (state.beforeClaim) { const hook = state.beforeClaim; state.beforeClaim = null; await hook(tx); }
        const rows = billableRows(i, tx);
        // unique-index check for the whole statement first (block on open transactions, then fail)
        for (const a of rows) {
          for (;;) {
            const clash = state.evals.find((e) => e.submission_id === a.submission_id && e.question_id === a.question_id && LIVE.has(e.status) && e.review_state !== "superseded");
            if (!clash) break;
            if (clash._tx && clash._tx.active && clash._tx !== tx) { await waitFor(clash); continue; }
            throw uniqueError("UQ_ai_marking_evaluations_live_answer");
          }
        }
        for (const a of rows) {
          const e = {
            id: state.nextEvalId++, ai_marking_job_id: i.jobId, submission_id: a.submission_id, question_id: a.question_id,
            answer_id: a.answer_id, scheme_version_id: a.scheme_id, max_marks: a.question_marks, status: "pending",
            review_state: "awaiting_review", suggested_total: null, model: null, prompt_version: null, last_error: null, _tx: tx,
          };
          state.evals.push(e);
          tx.undo.push(() => { state.evals.splice(state.evals.indexOf(e), 1); });
        }
        return ok([], rows.length);
      }
      case "job:update-quote": {
        const row = state.jobs.find((j) => j.id === i.id);
        write(tx, row, { eligible_count: i.eligible, unit_price: Number(i.unit), quoted_total: Number(i.total), pricing_id: i.pricingId });
        return ok([], 1);
      }
      case "job:cas-reserved": {
        const row = state.jobs.find((j) => j.id === i.id && j.status === "pending");
        if (!row) return ok([], 0);
        write(tx, row, { status: "reserved", reserved_count: row.eligible_count });
        return ok([], 1);
      }
      case "job:abort": {
        const row = state.jobs.find((j) => j.id === i.id && j.status === "pending");
        if (!row) return ok([], 0);
        write(tx, row, { status: "cancelled", cancelled_count: row.eligible_count, last_error: i.code, completedAt: new Date() });
        return ok([], 1);
      }
      case "eval:cancel-pending": {
        let n = 0;
        for (const e of state.evals.filter((x) => x.ai_marking_job_id === i.id && x.status === "pending")) { write(tx, e, { status: "cancelled", last_error: i.code ?? e.last_error }); n += 1; }
        return ok([], n);
      }
      case "job:request-cancel": {
        const row = state.jobs.find((j) => j.id === i.id && ["reserved", "processing"].includes(j.status));
        if (!row) return ok([], 0);
        write(tx, row, { cancel_requested: 1 });
        return ok([], 1);
      }
      case "job:finalize": {
        const row = state.jobs.find((j) => j.id === i.id && ["reserved", "processing"].includes(j.status));
        if (!row) return ok([], 0);
        write(tx, row, { status: i.status, processed_count: i.processed, failed_count: i.failed, cancelled_count: i.cancelled, actual_total: Number(i.actual), completedAt: new Date() });
        return ok([], 1);
      }
      case "eval:counts": {
        const by = {};
        for (const e of state.evals.filter((x) => x.ai_marking_job_id === i.jobId && visible(x, tx))) by[e.status] = (by[e.status] || 0) + 1;
        return ok(Object.entries(by).map(([status, n]) => ({ status, n })));
      }
      case "job:stale": {
        const cutoff = Date.now() - i.minutes * 60000;
        return ok(state.jobs.filter((j) => j.status === "pending" && j.createdAt.getTime() < cutoff).map((j) => ({ id: j.id, wallet_id: j.wallet_id })));
      }
      case "ledger:has-reserve":
        return ok([{ n: state.ledger.filter((r) => r.ai_marking_job_id === i.id && r.entry_type === "reserve").length }]);
      default:
        throw new Error(`fakeAiMarkingJobs: unhandled tag ${tag}`);
    }
  });

  return { ...base, addAnswer, billableRows };
}

/** Load the three real services bound to ONE fake database. Service code is unmodified. */
function loadJobsServices() {
  const svcDir = path.resolve(__dirname, "../../services");
  const files = ["aiMarkingLedger.service.js", "aiMarkingEligibility.service.js", "aiMarkingJobs.service.js"].map((f) => path.join(svcDir, f));
  const fake = createJobsFake();
  files.forEach((f) => { delete require.cache[f]; });
  const original = Module._load;
  Module._load = function patched(request, parent, ...rest) {
    if (request === "mssql" && parent && files.includes(parent.filename)) return fake.sql;
    return original.call(this, request, parent, ...rest);
  };
  let jobs, ledger, elig;
  try {
    jobs = require(files[2]); ledger = require(files[0]); elig = require(files[1]);
  } finally { Module._load = original; }
  return { jobs, ledger, elig, ...fake };
}

module.exports = { createJobsFake, loadJobsServices };
