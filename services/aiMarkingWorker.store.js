const sql = require("mssql");

/* =========================================================================
   AI MARKING WORKER — SQL STORE (Phase 6)

   The ONLY file the worker uses to talk to the database. The worker's logic
   (aiMarkingWorker.service.js) is written against this small interface and is
   tested against an in-memory implementation of it
   (tests/helpers/memoryWorkerStore.js). THIS file's T-SQL has never been run
   — see the Phase 6 notes' checklist before enabling the worker.

   RULES THIS FILE KEEPS (asserted statically by tests/aiMarkingWorker.test.js)
   - It never writes e_assessment_answers, e_assessment_submissions or Marks.
     The worker produces PROVISIONAL suggestions only; a teacher's approval is
     what writes marks_awarded (Phase 7). It only READS those tables.
   - It never references the wallet or ledger. Money moves only in
     aiMarkingJobs.service.js (finalizeJob / sweepStalledJobs).
   - Every UPDATE of an evaluation is compare-and-set on its current status
     (WHERE status = 'pending', or 'cancelled' for late spend accounting), so
     two workers, a cancel and a retry can never overwrite one another.
   - ALL time arithmetic uses the database clock (GETDATE / DATEADD), never
     Node's. Leases and backoff are only ever compared with other database
     timestamps, so server clock skew or timezone cannot change behaviour
     (see the timezone note in utils/examScheduler.js).

   Student identity (name, admission number) is read ONLY so the engine can
   mask it inside the answer text; it is never logged and never sent as a field.
========================================================================= */

const num = (v) => (v == null ? null : Number(v));

function createSqlWorkerStore(pool) {
  const req = () => pool.request();

  return {
    /* ----------------------------- jobs ----------------------------- */

    /** Jobs the worker may need to look at, oldest first (so nobody starves). Includes cancel-requested ones so a half-finished cancel is completed. */
    async listActiveJobs() {
      const r = await req().query(`
        /*worker:list-jobs*/
        SELECT id, status, cancel_requested,
               CASE WHEN paused_until IS NOT NULL AND paused_until > GETDATE() THEN 1 ELSE 0 END AS paused
        FROM ai_marking_jobs
        WHERE status IN ('reserved','processing')
        ORDER BY createdAt, id
      `);
      return r.recordset.map((j) => ({ id: j.id, status: j.status, cancelRequested: !!j.cancel_requested, paused: !!j.paused }));
    },

    /** Take (or re-take) the job lease. Moves 'reserved' -> 'processing'. Returns null if another live worker holds it, the job is paused or no longer active. */
    async leaseJob(jobId, workerId, leaseMs, { model = null, provider = null } = {}) {
      const r = await req()
        .input("id", sql.Int, jobId).input("w", sql.NVarChar(100), workerId).input("ms", sql.Int, leaseMs)
        .input("model", sql.NVarChar(100), model).input("provider", sql.NVarChar(50), provider)
        .query(`
          /*worker:lease-job*/
          UPDATE ai_marking_jobs
          SET locked_by = @w,
              locked_until = DATEADD(MILLISECOND, @ms, GETDATE()),
              status = CASE WHEN status = 'reserved' THEN 'processing' ELSE status END,
              started_at = ISNULL(started_at, GETDATE()),
              model = ISNULL(model, @model),
              provider = ISNULL(provider, @provider)
          OUTPUT INSERTED.id, INSERTED.status, INSERTED.cancel_requested, INSERTED.pause_count, INSERTED.attempt_count
          WHERE id = @id AND status IN ('reserved','processing')
            AND (locked_until IS NULL OR locked_until <= GETDATE() OR locked_by = @w)
            AND (paused_until IS NULL OR paused_until <= GETDATE())
        `);
      const j = r.recordset[0];
      return j ? { id: j.id, status: j.status, cancelRequested: !!j.cancel_requested, pauseCount: Number(j.pause_count || 0), errorCount: Number(j.attempt_count || 0) } : null;
    },

    async renewLease(jobId, workerId, leaseMs) {
      const r = await req().input("id", sql.Int, jobId).input("w", sql.NVarChar(100), workerId).input("ms", sql.Int, leaseMs).query(`
        /*worker:renew-lease*/
        UPDATE ai_marking_jobs SET locked_until = DATEADD(MILLISECOND, @ms, GETDATE())
        WHERE id = @id AND locked_by = @w AND status IN ('reserved','processing')
      `);
      return Number(r.rowsAffected?.[0] || 0) > 0;
    },

    async releaseLease(jobId, workerId) {
      await req().input("id", sql.Int, jobId).input("w", sql.NVarChar(100), workerId).query(`
        /*worker:release-lease*/
        UPDATE ai_marking_jobs SET locked_by = NULL, locked_until = NULL WHERE id = @id AND locked_by = @w
      `);
    },

    async getJobState(jobId) {
      const r = await req().input("id", sql.Int, jobId).query(`
        /*worker:job-state*/
        SELECT status, cancel_requested,
               CASE WHEN paused_until IS NOT NULL AND paused_until > GETDATE() THEN 1 ELSE 0 END AS paused
        FROM ai_marking_jobs WHERE id = @id
      `);
      const j = r.recordset[0];
      return j ? { status: j.status, cancelRequested: !!j.cancel_requested, paused: !!j.paused } : null;
    },

    /** Pause for a bounded time (the worker escalates the duration) and remember why. */
    async pauseJob(jobId, ms, reason) {
      await req().input("id", sql.Int, jobId).input("ms", sql.Int, Math.min(ms, 2147483000)).input("reason", sql.NVarChar(200), String(reason).slice(0, 200)).query(`
        /*worker:pause-job*/
        UPDATE ai_marking_jobs
        SET paused_until = DATEADD(MILLISECOND, @ms, GETDATE()), pause_reason = @reason,
            pause_count = pause_count + 1, last_error = @reason
        WHERE id = @id AND status IN ('reserved','processing')
      `);
    },

    /** An unexpected worker-side error on a job: count it and keep the message (never student content). Returns the new consecutive-error count. */
    async recordJobError(jobId, message) {
      const r = await req().input("id", sql.Int, jobId).input("e", sql.NVarChar(1000), String(message).slice(0, 1000)).query(`
        /*worker:job-error*/
        UPDATE ai_marking_jobs SET attempt_count = attempt_count + 1, last_error = @e
        OUTPUT INSERTED.attempt_count
        WHERE id = @id
      `);
      return Number(r.recordset[0]?.attempt_count || 0);
    },

    /** Work is flowing again: clear the error streak and the pause escalation. */
    async markJobHealthy(jobId) {
      await req().input("id", sql.Int, jobId).query(`
        /*worker:job-healthy*/
        UPDATE ai_marking_jobs SET attempt_count = 0, pause_count = 0, pause_reason = NULL
        WHERE id = @id AND (attempt_count <> 0 OR pause_count <> 0 OR pause_reason IS NOT NULL)
      `);
    },

    /* ----------------------------- evaluations ----------------------------- */

    /**
     * Atomically claim up to `limit` answers: every claimed row gets an
     * in-flight lease (next_attempt_at = now + leaseMs) and attempt_count + 1.
     * READPAST skips rows another worker is claiming at this very moment.
     */
    async claimEvaluations(jobId, limit, leaseMs) {
      const r = await req().input("jobId", sql.Int, jobId).input("n", sql.Int, limit).input("ms", sql.Int, leaseMs).query(`
        /*worker:claim-evals*/
        ;WITH nxt AS (
          SELECT TOP (@n) id
          FROM ai_marking_evaluations WITH (UPDLOCK, READPAST, ROWLOCK)
          WHERE ai_marking_job_id = @jobId AND status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= GETDATE())
          ORDER BY id
        )
        UPDATE e
        SET next_attempt_at = DATEADD(MILLISECOND, @ms, GETDATE()), attempt_count = e.attempt_count + 1
        OUTPUT INSERTED.id, INSERTED.attempt_count
        FROM ai_marking_evaluations e
        JOIN nxt ON nxt.id = e.id
        WHERE e.status = 'pending'
      `);
      return r.recordset.map((x) => ({ id: x.id, attempt: Number(x.attempt_count) }));
    },

    /** Progress for one job: how many are still pending, how many of those are waiting out a backoff/lease, and how long until the next one is due. */
    async countOpen(jobId) {
      const r = await req().input("jobId", sql.Int, jobId).query(`
        /*worker:count-open*/
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at > GETDATE() THEN 1 ELSE 0 END) AS waiting,
          DATEDIFF(MILLISECOND, GETDATE(), MIN(CASE WHEN status = 'pending' THEN next_attempt_at END)) AS wake_in_ms
        FROM ai_marking_evaluations WHERE ai_marking_job_id = @jobId
      `);
      const x = r.recordset[0] || {};
      return { pending: Number(x.pending || 0), waiting: Number(x.waiting || 0), wakeInMs: x.wake_in_ms == null ? null : Math.max(0, Number(x.wake_in_ms)) };
    },

    /** Everything needed to mark one answer, read fresh (never cached from claim time). */
    async loadWorkItem(evalId) {
      const r = await req().input("id", sql.Int, evalId).query(`
        /*worker:load-item*/
        SELECT e.id, e.ai_marking_job_id AS job_id, e.status, e.attempt_count, e.question_id, e.scheme_version_id,
               e.answer_content_hash, e.max_marks, e.token_usage_json, e.processing_cost,
               q.question_text, q.marks AS question_marks,
               a.essay_answer, a.marks_awarded,
               LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CAST(a.essay_answer AS NVARCHAR(MAX))), 2)) AS current_hash,
               s.status AS submission_status,
               st.name AS student_name, st.admissionNo AS admission_no,
               sv.criteria_json
        FROM ai_marking_evaluations e
        LEFT JOIN e_assessment_answers a ON a.id = e.answer_id
        LEFT JOIN e_assessment_questions q ON q.id = e.question_id
        LEFT JOIN e_assessment_submissions s ON s.id = e.submission_id
        LEFT JOIN Students st ON st.id = s.student_id
        LEFT JOIN ai_marking_scheme_versions sv ON sv.id = e.scheme_version_id
        WHERE e.id = @id
      `);
      const x = r.recordset[0];
      if (!x) return null;
      return {
        id: x.id, jobId: x.job_id, status: x.status, attempt: Number(x.attempt_count || 0),
        questionId: x.question_id, schemeVersionId: x.scheme_version_id,
        answerHash: x.answer_content_hash, currentHash: x.current_hash || null,
        maxMarks: num(x.max_marks), questionMarks: num(x.question_marks),
        questionText: x.question_text, answerHtml: x.essay_answer, marksAwarded: num(x.marks_awarded),
        submissionStatus: x.submission_status, criteriaJson: x.criteria_json,
        studentName: x.student_name || null, admissionNo: x.admission_no || null,
        tokenUsageJson: x.token_usage_json || null, processingCost: num(x.processing_cost),
        answerFound: x.essay_answer !== undefined && x.essay_answer !== null,
      };
    },

    /** An existing usable evaluation of byte-identical work (same question, answer hash, scheme version, prompt version, model) in THIS tenant database. */
    async findReusable(item, { promptVersion, model }) {
      const r = await req()
        .input("id", sql.Int, item.id).input("q", sql.Int, item.questionId).input("hash", sql.Char(64), item.answerHash)
        .input("sv", sql.Int, item.schemeVersionId).input("pv", sql.NVarChar(30), promptVersion).input("model", sql.NVarChar(100), model)
        .input("max", sql.Decimal(6, 2), item.maxMarks)
        .query(`
          /*worker:find-reusable*/
          SELECT TOP 1 id, status, criteria_json, suggested_total, review_flags
          FROM ai_marking_evaluations
          WHERE id <> @id AND question_id = @q AND answer_content_hash = @hash AND scheme_version_id = @sv
            AND prompt_version = @pv AND model = @model AND max_marks = @max
            AND status IN ('success','needs_review') AND review_state NOT IN ('rejected','superseded')
            AND criteria_json IS NOT NULL AND suggested_total IS NOT NULL
            -- A teacher disputed (rejected, or asked to re-evaluate) an evaluation of this EXACT work: never serve a
            -- copy of an identical answer's result in its place — that would hand back the very output they disputed.
            AND NOT EXISTS (SELECT 1 FROM ai_marking_evaluations d
                            WHERE d.question_id = @q AND d.answer_content_hash = @hash AND d.scheme_version_id = @sv
                              AND d.review_state IN ('rejected','superseded'))
          ORDER BY id
        `);
      const x = r.recordset[0];
      return x ? { id: x.id, status: x.status, criteriaJson: x.criteria_json, suggestedTotal: Number(x.suggested_total), reviewFlags: x.review_flags } : null;
    },

    /**
     * Record a finished evaluation. Compare-and-set on status = 'pending'.
     * `guarded` (used for anything that carries a suggested mark) also requires
     * that the answer is STILL unmarked and its submission NOT released, in the
     * very same statement — so there is no window between "check" and "write".
     * Returns 'written' | 'lost' (cancelled/finished meanwhile) | 'answer_marked' | 'released'.
     */
    async recordResult(evalId, row, { guarded }) {
      const guardSql = guarded ? `
            AND EXISTS (SELECT 1 FROM e_assessment_answers a
                        JOIN e_assessment_submissions s ON s.id = a.submission_id
                        WHERE a.id = ai_marking_evaluations.answer_id AND a.marks_awarded IS NULL AND s.status <> 'released')` : "";
      const r = await req()
        .input("id", sql.Int, evalId).input("status", sql.NVarChar(20), row.status)
        .input("model", sql.NVarChar(100), row.model || null).input("pv", sql.NVarChar(30), row.prompt_version || null)
        .input("criteria", sql.NVarChar(sql.MAX), row.criteria_json).input("total", sql.Decimal(6, 2), row.suggested_total)
        .input("flags", sql.NVarChar(sql.MAX), row.review_flags).input("tokens", sql.NVarChar(sql.MAX), row.token_usage_json)
        .input("cost", sql.Decimal(10, 4), row.processing_cost).input("err", sql.NVarChar(1000), row.last_error)
        .input("reused", sql.Int, row.reused_from_evaluation_id ?? null)
        .query(`
          /*worker:record-result${guarded ? "-guarded" : ""}*/
          UPDATE ai_marking_evaluations
          SET status = @status, model = @model, prompt_version = @pv, criteria_json = @criteria, suggested_total = @total,
              review_flags = @flags, token_usage_json = ISNULL(@tokens, token_usage_json), processing_cost = ISNULL(@cost, processing_cost), last_error = @err,
              reused_from_evaluation_id = @reused, next_attempt_at = NULL, completed_at = GETDATE()
          WHERE id = @id AND status = 'pending'${guardSql}
        `);
      if (Number(r.rowsAffected?.[0] || 0) > 0) return "written";
      // Why not? Tell the caller so it can cancel (answer got marked) or just discard (job cancelled).
      const why = await req().input("id", sql.Int, evalId).query(`
        /*worker:why-not-written*/
        SELECT e.status, a.marks_awarded, s.status AS submission_status
        FROM ai_marking_evaluations e
        LEFT JOIN e_assessment_answers a ON a.id = e.answer_id
        LEFT JOIN e_assessment_submissions s ON s.id = e.submission_id
        WHERE e.id = @id
      `);
      const w = why.recordset[0];
      if (!w || w.status !== "pending") return "lost";
      if (w.submission_status === "released") return "released";
      if (w.marks_awarded != null) return "answer_marked";
      return "lost";
    },

    /** Retryable failure: keep the spend, push the answer out by a backoff delay. */
    async scheduleRetry(evalId, delayMs, { error, tokenUsageJson, cost }) {
      const r = await req()
        .input("id", sql.Int, evalId).input("ms", sql.Int, Math.min(delayMs, 2147483000)).input("err", sql.NVarChar(1000), String(error).slice(0, 1000))
        .input("tokens", sql.NVarChar(sql.MAX), tokenUsageJson).input("cost", sql.Decimal(10, 4), cost)
        .query(`
          /*worker:schedule-retry*/
          UPDATE ai_marking_evaluations
          SET next_attempt_at = DATEADD(MILLISECOND, @ms, GETDATE()), last_error = @err,
              token_usage_json = @tokens, processing_cost = @cost
          WHERE id = @id AND status = 'pending'
        `);
      return Number(r.rowsAffected?.[0] || 0) > 0;
    },

    /**
     * Systemic failure: hand the answer back, keeping the spend. By default the
     * attempt is NOT counted against the answer (the fault is the provider's,
     * not the answer's); keepAttempt = true counts it, which is how a single
     * answer that keeps provoking a "bad request" is eventually isolated.
     */
    async releaseClaim(evalId, { error, tokenUsageJson, cost, keepAttempt = false }) {
      const r = await req()
        .input("id", sql.Int, evalId).input("err", sql.NVarChar(1000), String(error).slice(0, 1000))
        .input("tokens", sql.NVarChar(sql.MAX), tokenUsageJson).input("cost", sql.Decimal(10, 4), cost)
        .input("keep", sql.Bit, keepAttempt ? 1 : 0)
        .query(`
          /*worker:release-claim*/
          UPDATE ai_marking_evaluations
          SET next_attempt_at = NULL,
              attempt_count = CASE WHEN @keep = 1 THEN attempt_count WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
              last_error = @err, token_usage_json = ISNULL(@tokens, token_usage_json), processing_cost = ISNULL(@cost, processing_cost)
          WHERE id = @id AND status = 'pending'
        `);
      return Number(r.rowsAffected?.[0] || 0) > 0;
    },

    /** Stop work on an answer (never charged). Keeps whatever was already spent on it. */
    async cancelEvaluation(evalId, reason, { tokenUsageJson, cost }) {
      const r = await req()
        .input("id", sql.Int, evalId).input("reason", sql.NVarChar(1000), String(reason).slice(0, 1000))
        .input("tokens", sql.NVarChar(sql.MAX), tokenUsageJson).input("cost", sql.Decimal(10, 4), cost)
        .query(`
          /*worker:cancel-eval*/
          UPDATE ai_marking_evaluations
          SET status = 'cancelled', last_error = @reason, token_usage_json = ISNULL(@tokens, token_usage_json), processing_cost = ISNULL(@cost, processing_cost),
              next_attempt_at = NULL, completed_at = GETDATE()
          WHERE id = @id AND status = 'pending'
        `);
      return Number(r.rowsAffected?.[0] || 0) > 0;
    },

    /**
     * This worker lost a race (the answer was cancelled mid-call, or another
     * worker finished it first). Its RESULT is discarded and never charged, but
     * the provider call was real: ADD its cost (a delta, never an overwrite —
     * the row's totals belong to whoever won it).
     */
    async addLateSpend(evalId, { cost }) {
      await req().input("id", sql.Int, evalId).input("cost", sql.Decimal(10, 4), cost).query(`
        /*worker:late-spend*/
        UPDATE ai_marking_evaluations SET processing_cost = ISNULL(processing_cost, 0) + @cost
        WHERE id = @id AND status IN ('cancelled','success','needs_review','failed')
      `);
    },

    /* ----------------------------- measurement ----------------------------- */

    /** Measured answers/second from jobs finished in the last 14 days (null until there is enough data to mean anything). */
    async measureThroughput({ minAnswers = 100 } = {}) {
      const r = await req().query(`
        /*worker:throughput*/
        SELECT SUM(processed_count) AS answers,
               SUM(CASE WHEN DATEDIFF(SECOND, started_at, completedAt) > 0 THEN DATEDIFF(SECOND, started_at, completedAt) ELSE 1 END) AS seconds,
               COUNT(*) AS jobs
        FROM ai_marking_jobs
        WHERE status = 'completed' AND started_at IS NOT NULL AND completedAt IS NOT NULL
          AND processed_count > 0 AND completedAt > DATEADD(DAY, -14, GETDATE())
      `);
      const x = r.recordset[0] || {};
      const answers = Number(x.answers || 0), seconds = Number(x.seconds || 0);
      if (answers < minAnswers || seconds <= 0) return null;
      return { answersPerSecond: answers / seconds, sampleAnswers: answers, sampleJobs: Number(x.jobs || 0) };
    },

    /** Answers still waiting across every active job (the queue ahead of a new job). */
    async countQueued() {
      const r = await req().query(`
        /*worker:count-queued*/
        SELECT COUNT(*) AS n FROM ai_marking_evaluations e
        JOIN ai_marking_jobs j ON j.id = e.ai_marking_job_id
        WHERE e.status = 'pending' AND j.status IN ('reserved','processing')
      `);
      return Number(r.recordset[0]?.n || 0);
    },
  };
}

module.exports = { createSqlWorkerStore };
