const sql = require("mssql");

/* =========================================================================
   AI MARKING — REVIEW STORE (Phase 7)

   The ONLY file that reads or writes anything for the review screen. The
   review service (aiMarkingReview.service.js) is written against this
   interface and tested against an in-memory implementation
   (tests/helpers/memoryReviewStore.js). THIS file's T-SQL has never been run;
   `node scripts/verifyAiMarkingWorkerSql.js` parse/bind-checks it safely, and
   tests/README.md has the manual checklist.

   WHAT MAY BE WRITTEN, AND ONLY HERE
   - e_assessment_answers.marks_awarded (+ remarks): the ONE place AI-assisted
     marking becomes a real mark. Always in the same transaction as the
     evaluation's state change and its adjustment-log row, and only under ALL of:
         marks_awarded IS NULL          (a teacher has not marked it by hand)
         submission not 'released'      (results are not out)
         content hash unchanged         (still the text the AI saw)
         teacher assigned to the submission
     checked inside the UPDATE itself, so there is no gap between check and write.
   - e_assessment_submissions.score / status: recomputed exactly the way
     saveMarking does, so the existing release flow behaves identically.
   - ai_marking_evaluations: review_state / teacher_final_mark / approver, always
     compare-and-set on the current review_state.
   - ai_marking_adjustments: INSERT only (the table also refuses UPDATE/DELETE).
   It never touches Marks, the wallet, the ledger or jobs: reviewing a result
   cannot move money, release results, or change what was charged.

   Teacher identity comes from the authenticated user (the controller), never
   from the request body. A teacher who is not assigned to the submission gets
   "not found" for it everywhere (no existence leak).
========================================================================= */

/* The three statements below intentionally mirror saveMarking in
   eAssessment.controller.js (MCQ safety net, total, unmarked-essay count, final
   update). tests/aiMarkingReview.test.js pins them against that source so the
   two cannot drift apart silently. */
const MCQ_SAFETY_NET_SQL = `
  UPDATE a
  SET a.marks_awarded = CASE
        WHEN a.selected_answer IS NOT NULL AND q.correct_answer IS NOT NULL
             AND LOWER(LTRIM(RTRIM(a.selected_answer))) = LOWER(LTRIM(RTRIM(q.correct_answer)))
        THEN ISNULL(q.marks, 0)
        ELSE 0
      END,
      a.is_correct = CASE
        WHEN a.selected_answer IS NOT NULL AND q.correct_answer IS NOT NULL
             AND LOWER(LTRIM(RTRIM(a.selected_answer))) = LOWER(LTRIM(RTRIM(q.correct_answer)))
        THEN 1 ELSE 0
      END
  FROM e_assessment_answers a
  INNER JOIN e_assessment_questions q ON q.id = a.question_id
  WHERE a.submission_id = @submission_id
    AND q.question_type <> 'essay'
    AND a.marks_awarded IS NULL
`;
const TOTAL_SQL = `SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`;
const UNMARKED_ESSAYS_SQL = `
  SELECT COUNT(*) AS cnt
  FROM e_assessment_answers a
  INNER JOIN e_assessment_questions q ON q.id = a.question_id
  WHERE a.submission_id = @submission_id AND q.question_type = 'essay' AND a.marks_awarded IS NULL
`;
const FULLY_MARKED_UPDATE_SQL = `
  UPDATE e_assessment_submissions
  SET score = @score, status = 'marked', remark_completed = 1, remark_requested = 0, remark_status = 'completed'
  WHERE id = @submission_id
`;
const PARTIAL_UPDATE_SQL = `UPDATE e_assessment_submissions SET score = @score WHERE id = @submission_id`;

const HASH_OF_ANSWER = `LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CAST(a.essay_answer AS NVARCHAR(MAX))), 2))`;
const ASSIGNED = (submissionExpr) => `EXISTS (SELECT 1 FROM e_assessment_submission_assignments asg WHERE asg.submission_id = ${submissionExpr} AND asg.teacher_id = @teacherId)`;

const num = (v) => (v == null ? null : Number(v));

/** What is wrong, read fresh after a guarded write matched nothing. Order matters: most specific first. */
const CLASSIFY_SQL = `
  /*review:classify*/
  SELECT e.review_state, e.status, e.teacher_final_mark, e.teacher_approved_by, e.answer_content_hash,
         a.marks_awarded, s.status AS submission_status,
         ${HASH_OF_ANSWER} AS current_hash,
         CASE WHEN ${ASSIGNED("s.id")} THEN 1 ELSE 0 END AS assigned
  FROM ai_marking_evaluations e
  JOIN e_assessment_answers a ON a.id = e.answer_id
  JOIN e_assessment_submissions s ON s.id = e.submission_id
  WHERE e.id = @id
`;

function createSqlReviewStore(pool) {
  const req = () => pool.request();

  async function classify(runner, evaluationId, teacherId) {
    const r = await new sql.Request(runner)
      .input("id", sql.Int, evaluationId).input("teacherId", sql.Int, teacherId).query(CLASSIFY_SQL);
    return r.recordset[0] || null;
  }

  async function insertAdjustment(runner, a) {
    await new sql.Request(runner)
      .input("evaluationId", sql.Int, a.evaluationId).input("action", sql.NVarChar(30), a.action)
      .input("before", sql.NVarChar(sql.MAX), a.beforeJson ?? null).input("after", sql.NVarChar(sql.MAX), a.afterJson ?? null)
      .input("finalMark", sql.Decimal(6, 2), a.finalMark ?? null).input("reason", sql.NVarChar(500), a.reason ?? null)
      .input("actorId", sql.Int, a.teacherId).input("actorRole", sql.NVarChar(30), a.actorRole ?? null)
      .query(`
        /*review:log-adjustment*/
        INSERT INTO ai_marking_adjustments (evaluation_id, action, before_json, after_json, final_mark, reason, actor_id, actor_role)
        VALUES (@evaluationId, @action, @before, @after, @finalMark, @reason, @actorId, @actorRole)
      `);
  }

  /** Never throws away an error: rolls back, then rethrows. */
  async function inTransaction(work) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const out = await work(tx);
      if (out && out.rollback) { await tx.rollback(); return out.result; }
      await tx.commit();
      return out.result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  return {
    /* ----------------------------- reads ----------------------------- */

    /** The teacher's own review queue. `view`: awaiting | attention | failed. Cursor = last id seen. */
    async listQueue({ teacherId, view, assessmentId = null, questionId = null, afterId = 0, limit = 25 }) {
      const stateAndStatus = {
        awaiting: "e.review_state = 'awaiting_review' AND e.status IN ('success','needs_review')",
        attention: "e.review_state = 'awaiting_review' AND e.status = 'needs_review'",
        failed: "e.review_state = 'awaiting_review' AND e.status = 'failed'",
      }[view];
      if (!stateAndStatus) throw new Error("bad view");
      const r = await req()
        .input("teacherId", sql.Int, teacherId).input("assessmentId", sql.Int, assessmentId).input("questionId", sql.Int, questionId)
        .input("afterId", sql.Int, afterId).input("limit", sql.Int, limit)
        .query(`
          /*review:list-queue*/
          SELECT TOP (@limit) e.id, e.status, e.review_state, e.suggested_total, e.max_marks, e.review_flags, e.last_error,
                 e.question_id, e.submission_id, q.question_text, ea.id AS assessment_id, ea.title AS assessment_title, ea.subject,
                 st.name AS student_name, st.admissionNo AS admission_no
          FROM ai_marking_evaluations e
          JOIN e_assessment_answers a ON a.id = e.answer_id
          JOIN e_assessment_submissions s ON s.id = e.submission_id
          JOIN e_assessment_questions q ON q.id = e.question_id
          JOIN e_assessments ea ON ea.id = s.e_assessment_id
          LEFT JOIN Students st ON st.id = s.student_id
          WHERE ${stateAndStatus}
            AND a.marks_awarded IS NULL AND s.status <> 'released'
            AND ${ASSIGNED("s.id")}
            AND (@assessmentId IS NULL OR ea.id = @assessmentId)
            AND (@questionId IS NULL OR e.question_id = @questionId)
            AND e.id > @afterId
          ORDER BY e.id
        `);
      return r.recordset.map((x) => ({
        id: x.id, status: x.status, reviewState: x.review_state, suggestedTotal: num(x.suggested_total), maxMarks: num(x.max_marks),
        reviewFlags: x.review_flags, lastError: x.last_error, questionId: x.question_id, submissionId: x.submission_id,
        questionHtml: x.question_text, assessmentId: x.assessment_id, assessmentTitle: x.assessment_title, subject: x.subject,
        studentName: x.student_name || null, admissionNo: x.admission_no || null,
      }));
    },

    /** One evaluation with everything the review screen needs; null if it does not exist OR is not this teacher's. */
    async getForReview({ evaluationId, teacherId }) {
      const r = await req().input("id", sql.Int, evaluationId).input("teacherId", sql.Int, teacherId).query(`
        /*review:get*/
        SELECT TOP 1 e.id, e.status, e.review_state, e.suggested_total, e.max_marks, e.criteria_json, e.review_flags, e.last_error,
               e.scheme_version_id, e.question_id, e.submission_id, e.answer_id, e.answer_content_hash,
               e.teacher_final_mark, e.teacher_approved_by, e.model, e.prompt_version,
               q.question_text, a.essay_answer, a.marks_awarded, a.remarks,
               ${HASH_OF_ANSWER} AS current_hash,
               s.status AS submission_status, ea.id AS assessment_id, ea.title AS assessment_title, ea.subject,
               st.name AS student_name, st.admissionNo AS admission_no,
               sv.criteria_json AS scheme_criteria_json, sv.version_no AS scheme_version_no
        FROM ai_marking_evaluations e
        JOIN e_assessment_answers a ON a.id = e.answer_id
        JOIN e_assessment_submissions s ON s.id = e.submission_id
        JOIN e_assessment_questions q ON q.id = e.question_id
        JOIN e_assessments ea ON ea.id = s.e_assessment_id
        LEFT JOIN Students st ON st.id = s.student_id
        LEFT JOIN ai_marking_scheme_versions sv ON sv.id = e.scheme_version_id
        WHERE e.id = @id AND ${ASSIGNED("s.id")}
      `);
      const x = r.recordset[0];
      if (!x) return null;
      return {
        id: x.id, status: x.status, reviewState: x.review_state, suggestedTotal: num(x.suggested_total), maxMarks: num(x.max_marks),
        criteriaJson: x.criteria_json, reviewFlags: x.review_flags, lastError: x.last_error, schemeVersionId: x.scheme_version_id,
        schemeVersionNo: x.scheme_version_no, schemeCriteriaJson: x.scheme_criteria_json, questionId: x.question_id,
        submissionId: x.submission_id, answerId: x.answer_id, answerHash: x.answer_content_hash, currentHash: x.current_hash || null,
        teacherFinalMark: num(x.teacher_final_mark), teacherApprovedBy: x.teacher_approved_by, model: x.model, promptVersion: x.prompt_version,
        questionHtml: x.question_text, answerHtml: x.essay_answer, marksAwarded: num(x.marks_awarded), remarks: x.remarks,
        submissionStatus: x.submission_status, assessmentId: x.assessment_id, assessmentTitle: x.assessment_title, subject: x.subject,
        studentName: x.student_name || null, admissionNo: x.admission_no || null,
      };
    },

    async getAdjustments(evaluationId) {
      const r = await req().input("id", sql.Int, evaluationId).query(`
        /*review:get-adjustments*/
        SELECT TOP 50 id, action, final_mark, reason, actor_id, actor_role, createdAt
        FROM ai_marking_adjustments WHERE evaluation_id = @id ORDER BY id
      `);
      return r.recordset.map((a) => ({ id: a.id, action: a.action, finalMark: num(a.final_mark), reason: a.reason, actorId: a.actor_id, actorRole: a.actor_role, createdAt: a.createdAt }));
    },

    /** How many different people flagged this scheme version for this question as needing correction. */
    async countSchemeFlags(questionId, schemeVersionId) {
      const r = await req().input("q", sql.Int, questionId).input("sv", sql.Int, schemeVersionId).query(`
        /*review:count-scheme-flags*/
        SELECT COUNT(DISTINCT ad.actor_id) AS n
        FROM ai_marking_adjustments ad
        JOIN ai_marking_evaluations e ON e.id = ad.evaluation_id
        WHERE ad.action = 'flag_scheme' AND e.question_id = @q AND e.scheme_version_id = @sv
      `);
      return Number(r.recordset[0]?.n || 0);
    },

    /* ----------------------------- writes ----------------------------- */

    /**
     * Make the AI-assisted mark real. ONE transaction: claim the evaluation,
     * write the mark (guarded), log the adjustment, recompute the submission.
     * Returns { outcome: 'applied', submission } | { outcome: 'replayed' } | { outcome: 'conflict', reason }.
     *   reason: REVIEWED | ANSWER_MARKED | RELEASED | ANSWER_CHANGED | NOT_ASSIGNED
     */
    async applyApproval(spec) {
      const { evaluationId, teacherId, finalMark, state, action, remark, reason, beforeJson, afterJson, answerId, submissionId, expectedHash, actorRole } = spec;
      return inTransaction(async (tx) => {
        // 1. Claim the evaluation. Compare-and-set on review_state also serialises a double click: the second request waits here, then matches nothing.
        const claimed = await new sql.Request(tx)
          .input("id", sql.Int, evaluationId).input("mark", sql.Decimal(6, 2), finalMark).input("by", sql.Int, teacherId).input("state", sql.NVarChar(20), state)
          .query(`
            /*review:approve-claim*/
            UPDATE ai_marking_evaluations
            SET teacher_final_mark = @mark, teacher_approved_by = @by, teacher_approved_at = GETDATE(), review_state = @state
            WHERE id = @id AND review_state = 'awaiting_review' AND status IN ('success','needs_review')
          `);
        if (Number(claimed.rowsAffected?.[0] || 0) === 0) {
          const c = await classify(tx, evaluationId, teacherId);
          if (c && (c.review_state === "approved" || c.review_state === "adjusted") && Number(c.teacher_approved_by) === Number(teacherId) && Number(c.teacher_final_mark) === Number(finalMark)) {
            return { rollback: true, result: { outcome: "replayed" } };
          }
          return { rollback: true, result: { outcome: "conflict", reason: !c || !c.assigned ? "NOT_ASSIGNED" : "REVIEWED" } };
        }

        // 2. The mark itself — only if it is STILL unmarked, unreleased, unchanged and this teacher's.
        const wrote = await new sql.Request(tx)
          .input("answerId", sql.Int, answerId).input("mark", sql.Int, finalMark).input("remark", sql.NVarChar(sql.MAX), remark ?? null)
          .input("hash", sql.Char(64), expectedHash).input("teacherId", sql.Int, teacherId)
          .query(`
            /*review:write-mark*/
            UPDATE a
            SET a.marks_awarded = @mark, a.remarks = ISNULL(@remark, a.remarks)
            FROM e_assessment_answers a
            JOIN e_assessment_submissions s ON s.id = a.submission_id
            WHERE a.id = @answerId AND a.marks_awarded IS NULL AND s.status <> 'released'
              AND ${HASH_OF_ANSWER} = @hash
              AND ${ASSIGNED("a.submission_id")}
          `);
        if (Number(wrote.rowsAffected?.[0] || 0) === 0) {
          const c = await classify(tx, evaluationId, teacherId);
          let why = "ANSWER_CHANGED";
          if (!c || !c.assigned) why = "NOT_ASSIGNED";
          else if (c.submission_status === "released") why = "RELEASED";
          else if (c.marks_awarded != null) why = "ANSWER_MARKED";
          return { rollback: true, result: { outcome: "conflict", reason: why } };   // rolls back step 1 too
        }

        // 3. Log it.
        await insertAdjustment(tx, { evaluationId, action, beforeJson, afterJson, finalMark, reason, teacherId, actorRole });

        // 4. Recompute the submission exactly as saveMarking does.
        await new sql.Request(tx).input("submission_id", sql.Int, submissionId).query(MCQ_SAFETY_NET_SQL);
        const total = await new sql.Request(tx).input("submission_id", sql.Int, submissionId).query(TOTAL_SQL);
        const unmarked = await new sql.Request(tx).input("submission_id", sql.Int, submissionId).query(UNMARKED_ESSAYS_SQL);
        const score = Number(total.recordset[0].total);
        const fullyMarked = Number(unmarked.recordset[0].cnt) === 0;
        await new sql.Request(tx).input("submission_id", sql.Int, submissionId).input("score", sql.Int, score)
          .query(fullyMarked ? FULLY_MARKED_UPDATE_SQL : PARTIAL_UPDATE_SQL);
        const sub = { score, fullyMarked };
        return { result: { outcome: "applied", submission: sub } };
      });
    },

    /**
     * reject | mark_manually | request_reevaluation | flag_scheme.
     * Returns { outcome: 'applied' | 'replayed' } | { outcome: 'conflict', reason }.
     */
    async applyDecision({ evaluationId, teacherId, actorRole, action, reason }) {
      return inTransaction(async (tx) => {
        const log = (before, after) => insertAdjustment(tx, { evaluationId, action, beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after), reason, teacherId, actorRole });

        if (action === "flag_scheme") {
          // Flagging changes no state; one flag per teacher per evaluation.
          const dup = await new sql.Request(tx).input("id", sql.Int, evaluationId).input("by", sql.Int, teacherId).query(`
            /*review:flag-exists*/
            SELECT TOP 1 id FROM ai_marking_adjustments WITH (UPDLOCK, HOLDLOCK) WHERE evaluation_id = @id AND action = 'flag_scheme' AND actor_id = @by
          `);
          if (dup.recordset[0]) return { rollback: true, result: { outcome: "replayed" } };
          const c = await classify(tx, evaluationId, teacherId);
          if (!c || !c.assigned) return { rollback: true, result: { outcome: "conflict", reason: "NOT_ASSIGNED" } };
          await log({ flagged: false }, { flagged: true });
          return { result: { outcome: "applied" } };
        }

        const target = action === "request_reevaluation" ? "superseded" : "rejected";
        const from = action === "request_reevaluation" ? "('awaiting_review','rejected')" : "('awaiting_review')";
        const unmarkedGuard = action === "request_reevaluation"
          ? `AND EXISTS (SELECT 1 FROM e_assessment_answers a JOIN e_assessment_submissions s ON s.id = a.submission_id
                         WHERE a.id = ai_marking_evaluations.answer_id AND a.marks_awarded IS NULL AND s.status <> 'released')` : "";
        const r = await new sql.Request(tx).input("id", sql.Int, evaluationId).input("teacherId", sql.Int, teacherId).query(`
          /*review:decision-${action}*/
          UPDATE ai_marking_evaluations
          SET review_state = '${target}'
          WHERE id = @id AND review_state IN ${from} AND status IN ('success','needs_review')
            AND ${ASSIGNED("ai_marking_evaluations.submission_id")}
            ${unmarkedGuard}
        `);
        if (Number(r.rowsAffected?.[0] || 0) === 0) {
          const c = await classify(tx, evaluationId, teacherId);
          if (c && c.assigned && c.review_state === target) return { rollback: true, result: { outcome: "replayed" } };
          let why = "REVIEWED";
          if (!c || !c.assigned) why = "NOT_ASSIGNED";
          else if (action === "request_reevaluation" && c.submission_status === "released") why = "RELEASED";
          else if (action === "request_reevaluation" && c.marks_awarded != null) why = "ANSWER_MARKED";
          return { rollback: true, result: { outcome: "conflict", reason: why } };
        }
        await log({ reviewState: "awaiting_review" }, { reviewState: target });
        return { result: { outcome: "applied" } };
      });
    },
  };
}

module.exports = { createSqlReviewStore, MCQ_SAFETY_NET_SQL, TOTAL_SQL, UNMARKED_ESSAYS_SQL, FULLY_MARKED_UPDATE_SQL, PARTIAL_UPDATE_SQL };
