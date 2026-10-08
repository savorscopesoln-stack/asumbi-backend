const sql = require("mssql");
const { answerFactsSql, applySelection, normaliseSelection, BILLABLE_PREDICATE } = require("./aiMarkingEligibility.service");

/* =========================================================================
   AI MARKING — ANALYTICS STORES (Phase 10). The ONLY SQL for analytics.

   *** THE T-SQL BELOW HAS NEVER BEEN RUN. *** Run
   `node scripts/verifyAiMarkingWorkerSql.js <tenant>` (analytics block) on a
   copy first. It parses and binds each statement and changes nothing.

   READ-ONLY, by construction: no INSERT / UPDATE / DELETE / EXEC in this file
   (a test pins that). Tenant isolation: every query runs on the pool it is
   given — the tenant's own database — so there is no tenant column to filter.

   TWO FACTORIES, ON PURPOSE
     createSqlOperationalStore(pool)  operational + billing. It never SELECTs
                                      processing_cost or token_usage_json, so a
                                      teacher or institution admin response cannot
                                      contain provider cost even by accident.
     createSqlEconomicsStore(pool)    provider cost and token use. Used only by
                                      the finance-only service.

   SCOPE
     { kind: "teacher", teacherId }   jobs created by that teacher, answers on
                                      submissions assigned to them
     { kind: "institution" }          every job and answer in this tenant database
   The scope is built by the service from req.user / the validated tenant, never
   from request parameters.

   NO JSON FUNCTIONS: nothing here uses JSON_VALUE/OPENJSON (the repo uses none);
   JSON columns are parsed in JavaScript.
========================================================================= */

const CRITERIA_ROW_CAP = 10000;
const AGREEMENT_ROW_CAP = 50000;
const COST_PAGE = 5000;
const COST_ROW_CEILING = 500000;
const TEACHER_LIST_CAP = 200;

/** Job-level filter shared by every query: scope + period + optional assessment. Binds parameters, returns a WHERE fragment. */
function jobFilter(request, scope, range, assessmentId, alias = "j") {
  const c = [];
  if (scope.kind === "teacher") { request.input("scopeTeacher", sql.Int, scope.teacherId); c.push(`${alias}.teacher_id = @scopeTeacher`); }
  if (range && range.from) { request.input("rangeFrom", sql.DateTime, range.from); c.push(`${alias}.createdAt >= @rangeFrom`); }
  if (range && range.toExclusive) { request.input("rangeTo", sql.DateTime, range.toExclusive); c.push(`${alias}.createdAt < @rangeTo`); }
  if (assessmentId) { request.input("scopeAssessment", sql.Int, assessmentId); c.push(`${alias}.e_assessment_id = @scopeAssessment`); }
  return c.length ? c.join(" AND ") : "1 = 1";
}

function createSqlOperationalStore(pool) {
  const req = () => pool.request();
  return {
    /** Snapshot of where essay marking stands, using the Phase 3 fact definitions. */
    async position(scope, { assessmentId = null } = {}) {
      const request = req();
      if (scope.kind === "teacher") request.input("teacherId", sql.Int, scope.teacherId);
      const where = applySelection(request, normaliseSelection(assessmentId ? { eAssessmentId: assessmentId } : {}));
      const r = await request.query(`
        /*analytics:position*/
        WITH f AS (${answerFactsSql(where, { institutionWide: scope.kind === "institution" })})
        SELECT
          COUNT(*)                                                                                AS total_answers,
          SUM(CASE WHEN is_blank = 1 THEN 1 ELSE 0 END)                                           AS blank,
          SUM(CASE WHEN ${BILLABLE_PREDICATE} THEN 1 ELSE 0 END)                                  AS eligible,
          SUM(CASE WHEN is_blank = 0 AND is_released = 0 AND is_marked = 0 AND has_live_eval = 0 AND has_scheme = 0 THEN 1 ELSE 0 END) AS need_scheme,
          SUM(CASE WHEN is_blank = 0 AND is_marked = 0 AND has_live_eval = 0 THEN 1 ELSE 0 END)   AS unmarked,
          SUM(CASE WHEN is_marked = 1 AND ai_approved = 0 THEN 1 ELSE 0 END)                      AS manually_marked,
          SUM(CASE WHEN awaiting_review = 1 AND is_marked = 0 THEN 1 ELSE 0 END)                  AS ai_awaiting_review,
          SUM(CASE WHEN ai_approved = 1 THEN 1 ELSE 0 END)                                        AS approved_ai,
          SUM(CASE WHEN needs_attention = 1 AND is_marked = 0 THEN 1 ELSE 0 END)                  AS needs_attention
        FROM f
      `);
      return r.recordset[0] || {};
    },

    /** Jobs by status, evaluations by (status, review_state), and review turnaround, for the period. */
    async activity(scope, range, { assessmentId = null } = {}) {
      const jobsReq = req();
      const jw = jobFilter(jobsReq, scope, range, assessmentId);
      const jobs = await jobsReq.query(`
        /*analytics:jobs*/
        SELECT j.status, COUNT(*) AS jobs, SUM(j.reserved_count) AS answers_claimed,
               AVG(CASE WHEN j.completedAt IS NOT NULL THEN CAST(DATEDIFF(SECOND, j.createdAt, j.completedAt) AS FLOAT) END) AS avg_ai_seconds
        FROM ai_marking_jobs j
        WHERE ${jw}
        GROUP BY j.status
      `);
      const evReq = req();
      const ew = jobFilter(evReq, scope, range, assessmentId);
      const evals = await evReq.query(`
        /*analytics:evaluations*/
        SELECT ev.status, ev.review_state, COUNT(*) AS n
        FROM ai_marking_evaluations ev
        JOIN ai_marking_jobs j ON j.id = ev.ai_marking_job_id
        WHERE ${ew}
        GROUP BY ev.status, ev.review_state
      `);
      const rvReq = req();
      const rw = jobFilter(rvReq, scope, range, assessmentId);
      const review = await rvReq.query(`
        /*analytics:review-turnaround*/
        SELECT COUNT(*) AS reviewed,
               AVG(CAST(DATEDIFF(SECOND, ev.completed_at, ev.teacher_approved_at) AS FLOAT)) AS avg_review_seconds
        FROM ai_marking_evaluations ev
        JOIN ai_marking_jobs j ON j.id = ev.ai_marking_job_id
        WHERE ${rw}
          AND ev.review_state IN ('approved', 'adjusted')
          AND ev.completed_at IS NOT NULL AND ev.teacher_approved_at IS NOT NULL
          AND ev.teacher_approved_at >= ev.completed_at
      `);
      return { jobRows: jobs.recordset, evalRows: evals.recordset, reviewRow: review.recordset[0] || {} };
    },

    /** Decided evaluations (marks only — no answer text, no student or submission id). */
    async agreementRows(scope, range, { assessmentId = null } = {}) {
      const request = req().input("cap", sql.Int, AGREEMENT_ROW_CAP + 1);
      const w = jobFilter(request, scope, range, assessmentId);
      const r = await request.query(`
        /*analytics:agreement-rows*/
        SELECT TOP (@cap) ev.id AS evaluation_id, ISNULL(ev.scheme_version_id, 0) AS scheme_version_id, ev.question_id,
               ev.max_marks, ev.suggested_total, ev.teacher_final_mark, ev.review_state
        FROM ai_marking_evaluations ev
        JOIN ai_marking_jobs j ON j.id = ev.ai_marking_job_id
        WHERE ${w}
          AND ev.review_state IN ('approved', 'adjusted', 'rejected')
          AND ev.status IN ('success', 'needs_review')
        ORDER BY ev.id DESC
      `);
      const truncated = r.recordset.length > AGREEMENT_ROW_CAP;
      return { rows: truncated ? r.recordset.slice(0, AGREEMENT_ROW_CAP) : r.recordset, truncated };
    },

    /** Stored criterion-level results, newest first. The service reads marks and labels only, never evidence. */
    async criteriaRows(scope, range, { assessmentId = null } = {}) {
      const request = req().input("cap", sql.Int, CRITERIA_ROW_CAP + 1);
      const w = jobFilter(request, scope, range, assessmentId);
      const r = await request.query(`
        /*analytics:criteria-rows*/
        SELECT TOP (@cap) ev.question_id, ev.scheme_version_id, ev.criteria_json
        FROM ai_marking_evaluations ev
        JOIN ai_marking_jobs j ON j.id = ev.ai_marking_job_id
        WHERE ${w}
          AND ev.status IN ('success', 'needs_review') AND ev.criteria_json IS NOT NULL
        ORDER BY ev.id DESC
      `);
      const truncated = r.recordset.length > CRITERIA_ROW_CAP;
      return { rows: truncated ? r.recordset.slice(0, CRITERIA_ROW_CAP) : r.recordset, truncated };
    },

    /** Short question text for the questions named in the missed-criteria list. Question text only: no student data. */
    async questionTexts(ids) {
      const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
      if (!list.length) return new Map();
      const request = req();
      const names = list.map((id, i) => { request.input(`q${i}`, sql.Int, id); return `@q${i}`; });
      const r = await request.query(`
        /*analytics:question-texts*/
        SELECT q.id, LEFT(CAST(q.question_text AS NVARCHAR(MAX)), 140) AS question_text
        FROM e_assessment_questions q WHERE q.id IN (${names.join(",")})
      `);
      return new Map(r.recordset.map((x) => [Number(x.id), String(x.question_text || "")]));
    },

    /** Per-teacher usage — institution scope only (the service refuses it for a teacher). */
    async byTeacher(range, { assessmentId = null } = {}) {
      const request = req().input("cap", sql.Int, TEACHER_LIST_CAP);
      const w = jobFilter(request, { kind: "institution" }, range, assessmentId);
      const r = await request.query(`
        /*analytics:by-teacher*/
        SELECT TOP (@cap) j.teacher_id, t.name AS teacher_name, COUNT(*) AS jobs,
               SUM(j.processed_count) AS processed, SUM(j.failed_count) AS failed
        FROM ai_marking_jobs j
        LEFT JOIN Teachers t ON t.id = j.teacher_id
        WHERE ${w}
        GROUP BY j.teacher_id, t.name
        ORDER BY SUM(j.processed_count) DESC, j.teacher_id
      `);
      return r.recordset;
    },

    /** Charges from the ledger for the jobs in scope: consumed, and reversed-back. Per charge currency; optionally per teacher. */
    async charges(scope, range, { assessmentId = null, perTeacher = false } = {}) {
      const g = req();
      const gw = jobFilter(g, scope, range, assessmentId);
      const gross = await g.query(`
        /*analytics:charges-gross*/
        SELECT j.currency, ${perTeacher ? "j.teacher_id," : ""} SUM(-l.reserved_delta) AS amount
        FROM ai_marking_ledger l
        JOIN ai_marking_jobs j ON j.id = l.ai_marking_job_id
        WHERE l.entry_type = 'consume' AND ${gw}
        GROUP BY j.currency${perTeacher ? ", j.teacher_id" : ""}
      `);
      const f = req();
      const fw = jobFilter(f, scope, range, assessmentId);
      const refunds = await f.query(`
        /*analytics:charges-reversed*/
        SELECT j.currency, ${perTeacher ? "j.teacher_id," : ""} SUM(r.amount_delta) AS amount
        FROM ai_marking_ledger r
        JOIN ai_marking_ledger c ON c.id = r.reverses_ledger_id AND c.entry_type = 'consume'
        JOIN ai_marking_jobs j ON j.id = c.ai_marking_job_id
        WHERE r.entry_type = 'reverse' AND ${fw}
        GROUP BY j.currency${perTeacher ? ", j.teacher_id" : ""}
      `);
      return { grossRows: gross.recordset, refundRows: refunds.recordset };
    },
  };
}

/** FINANCE ONLY. The sole place analytics reads provider cost and token usage. */
function createSqlEconomicsStore(pool) {
  const req = () => pool.request();
  return {
    /** Every evaluation of the period's jobs, in id order pages, so a large tenant is read completely (or the report says it was cut). */
    async costRows(range) {
      const rows = [];
      let after = 0;
      for (;;) {
        const request = req().input("after", sql.Int, after).input("lim", sql.Int, COST_PAGE);
        const w = jobFilter(request, { kind: "institution" }, range, null);
        const r = await request.query(`
          /*economics:cost-rows*/
          SELECT TOP (@lim) ev.id, j.currency, ev.status, ev.processing_cost, ev.token_usage_json,
                 CASE WHEN ev.reused_from_evaluation_id IS NULL THEN 0 ELSE 1 END AS reused
          FROM ai_marking_evaluations ev
          JOIN ai_marking_jobs j ON j.id = ev.ai_marking_job_id
          WHERE ev.id > @after AND ${w}
          ORDER BY ev.id
        `);
        for (const x of r.recordset) rows.push(x);
        if (r.recordset.length < COST_PAGE) return { rows, truncated: false };
        after = Number(r.recordset[r.recordset.length - 1].id);
        if (rows.length >= COST_ROW_CEILING) return { rows, truncated: true };
      }
    },

    /** Finished jobs whose recorded actual_total differs from what the ledger consumed — should be none. */
    async reconciliation(range) {
      const request = req();
      const w = jobFilter(request, { kind: "institution" }, range, null);
      const r = await request.query(`
        /*economics:reconciliation*/
        SELECT COUNT(*) AS jobs_checked,
               SUM(CASE WHEN ABS(j.actual_total - ISNULL(c.consumed, 0)) > 0.00005 THEN 1 ELSE 0 END) AS mismatched
        FROM ai_marking_jobs j
        OUTER APPLY (SELECT SUM(-l.reserved_delta) AS consumed FROM ai_marking_ledger l
                     WHERE l.ai_marking_job_id = j.id AND l.entry_type = 'consume') c
        WHERE j.status IN ('completed', 'failed', 'cancelled') AND ${w}
      `);
      const x = r.recordset[0] || {};
      return { jobsChecked: Number(x.jobs_checked) || 0, mismatched: Number(x.mismatched) || 0 };
    },
  };
}

module.exports = { createSqlOperationalStore, createSqlEconomicsStore, CRITERIA_ROW_CAP, AGREEMENT_ROW_CAP, COST_PAGE, COST_ROW_CEILING };
