const sql = require("mssql");
const { ACCESS_SQL } = require("./aiMarkingScheme.store");

/* =========================================================================
   AI MARKING — CALIBRATION STORE (Phase 9). The ONLY SQL for calibration.

   *** THE T-SQL BELOW HAS NEVER BEEN RUN. *** Run
   `node scripts/verifyAiMarkingWorkerSql.js <tenant>` first: it parses and
   binds every statement with ids that match nothing, and changes nothing.

   READ-ONLY, by construction: there is no INSERT, UPDATE or DELETE in this
   file (a test pins that). It selects NO student data: no submission id,
   answer id, answer text or student id leaves the database — only
   (evaluation id, version, question, marks, AI mark, teacher mark, state).

   Access is the same rule as schemes (Phase 8 ACCESS_SQL): a teacher who set
   questions for the assessment, or is assigned submissions of it. Anyone else
   gets nothing, exactly like "does not exist".

   COLUMN ASSUMPTIONS taken from the Phase 7 checklist (tests/README.md), not
   from the Phase 7 source, which was not in the upload:
     ai_marking_evaluations: id, scheme_version_id, question_id, status,
       review_state ('approved' | 'rejected' | ...), suggested_total, teacher_final_mark
     ai_marking_scheme_versions: id, question_id, version_no, status, max_marks
   If the smoke check reports a missing column, that list is where to look.
========================================================================= */

const ESSAY_TYPES = ["essay"];            // same as aiMarkingEligibility.service.js
const ROW_CAP = 50000;                    // enough for ~hundreds of scripts x questions; the report says if it was cut

function createSqlCalibrationStore(pool) {
  const req = () => pool.request();
  const essayIn = ESSAY_TYPES.map((t) => `'${t}'`).join(",");   // constants above, never user input

  return {
    /** Decided evaluations for one assessment (optionally one question), only if this teacher is authorised. */
    async getAgreementRows({ teacherId, assessmentId, questionId = null }) {
      const request = req().input("teacherId", sql.Int, teacherId).input("a", sql.Int, assessmentId).input("cap", sql.Int, ROW_CAP + 1);
      let questionFilter = "";
      if (questionId) { request.input("qid", sql.Int, questionId); questionFilter = "AND q.id = @qid"; }
      const r = await request.query(`
        /*calibration:agreement-rows*/
        SELECT TOP (@cap)
               ev.id AS evaluation_id, ev.scheme_version_id, sv.version_no, ev.question_id,
               sv.max_marks, ev.suggested_total, ev.teacher_final_mark, ev.review_state
        FROM ai_marking_evaluations ev
        JOIN ai_marking_scheme_versions sv ON sv.id = ev.scheme_version_id
        JOIN e_assessment_questions q ON q.id = ev.question_id
        WHERE q.e_assessment_id = @a ${questionFilter}
          AND ev.review_state IN ('approved', 'adjusted', 'rejected')
          AND ev.status IN ('success', 'needs_review')
          AND (${ACCESS_SQL})
        ORDER BY ev.id DESC
      `);
      const rows = r.recordset;
      const truncated = rows.length > ROW_CAP;
      return { rows: truncated ? rows.slice(0, ROW_CAP) : rows, truncated };
    },

    /** The assessment's essay questions with the version in use now — only if this teacher is authorised. */
    async listQuestions({ teacherId, assessmentId }) {
      const r = await req().input("teacherId", sql.Int, teacherId).input("a", sql.Int, assessmentId).query(`
        /*calibration:list-questions*/
        SELECT q.id AS question_id, q.question_text, q.marks,
               ap.id AS approved_version_id, ap.version_no AS approved_version_no
        FROM e_assessment_questions q
        LEFT JOIN ai_marking_scheme_versions ap ON ap.question_id = q.id AND ap.status = 'approved'
        WHERE q.e_assessment_id = @a AND LOWER(q.question_type) IN (${essayIn}) AND (${ACCESS_SQL})
        ORDER BY q.id
      `);
      return r.recordset;
    },
  };
}

module.exports = { createSqlCalibrationStore, ROW_CAP };
