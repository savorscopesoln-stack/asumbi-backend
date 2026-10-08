const sql = require("mssql");

/* =========================================================================
   AI MARKING — SCHEME STORE (Phase 8). The ONLY SQL for marking schemes.

   *** THE T-SQL BELOW HAS NEVER BEEN RUN. *** No SQL Server was available.
   Run `node scripts/verifyAiMarkingWorkerSql.js <tenant>` first: it parses
   and binds every statement here using ids that match nothing, so it
   changes nothing.

   Rules this file enforces so the service cannot get them wrong:
   - Every read/write that takes a teacher id is limited to teachers who
     set questions for the assessment OR are assigned submissions of it.
     Anything else behaves exactly like "does not exist".
   - A scheme version is never edited once approved. Approving replaces the
     old approved version by marking it 'superseded' IN THE SAME TRANSACTION,
     so there is never a moment with zero or two approved versions
     (UQ_ai_marking_scheme_versions_one_approved enforces "at most one").
   - Approval re-checks, inside the lock, that the version is still a draft
     and still matches the question's current marks.
   - Evaluations already created keep the version id they were claimed with,
     so superseding a version never changes work in flight.
========================================================================= */

/** Teachers who may create/approve a scheme for a question: its assessment's question setters, or anyone assigned a submission of it. */
const ACCESS_SQL = `
  EXISTS (SELECT 1 FROM e_assessment_question_setters qs WHERE qs.e_assessment_id = q.e_assessment_id AND qs.teacher_id = @teacherId)
  OR EXISTS (SELECT 1 FROM e_assessment_submissions s
             JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id
             WHERE s.e_assessment_id = q.e_assessment_id AND asg.teacher_id = @teacherId)`;

const VERSION_COLUMNS = `v.id, v.question_id, v.version_no, v.status, v.max_marks, v.criteria_json, v.source_guide_hash,
  v.created_by, v.approved_by, v.approved_at, v.createdAt, v.change_note, v.approval_notes`;

function createSqlSchemeStore(pool) {
  const req = () => pool.request();

  async function inTransaction(work) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const out = await work(tx);
      await tx.commit();
      return out;
    } catch (err) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      throw err;
    }
  }

  return {
    /** One essay question with its guide and image count — only if this teacher is authorised for its assessment. */
    async getQuestion({ teacherId, questionId }) {
      const r = await req().input("teacherId", sql.Int, teacherId).input("id", sql.Int, questionId).query(`
        /*scheme:get-question*/
        SELECT q.id, q.e_assessment_id AS assessment_id, q.question_text, q.question_type, q.marks, q.marking_guide,
               (SELECT COUNT(*) FROM e_assessment_question_images i WHERE i.question_id = q.id) AS image_count
        FROM e_assessment_questions q
        WHERE q.id = @id AND (${ACCESS_SQL})
      `);
      return r.recordset[0] || null;
    },

    async listVersions(questionId) {
      const r = await req().input("q", sql.Int, questionId).query(`
        /*scheme:list-versions*/
        SELECT ${VERSION_COLUMNS} FROM ai_marking_scheme_versions v WHERE v.question_id = @q ORDER BY v.version_no DESC
      `);
      return r.recordset;
    },

    /** A version, only if its question belongs to an assessment this teacher is authorised for. */
    async getVersion({ teacherId, versionId }) {
      const r = await req().input("teacherId", sql.Int, teacherId).input("id", sql.Int, versionId).query(`
        /*scheme:get-version*/
        SELECT ${VERSION_COLUMNS}, q.e_assessment_id AS assessment_id
        FROM ai_marking_scheme_versions v
        JOIN e_assessment_questions q ON q.id = v.question_id
        WHERE v.id = @id AND (${ACCESS_SQL})
      `);
      return r.recordset[0] || null;
    },

    /** Checklist for an assessment: every essay question with its guide, images and scheme state. Empty if not authorised. */
    async listAssessmentQuestions({ teacherId, assessmentId }) {
      const r = await req().input("teacherId", sql.Int, teacherId).input("a", sql.Int, assessmentId).query(`
        /*scheme:list-assessment*/
        SELECT q.id, q.question_text, q.question_type, q.marks, q.marking_guide,
          (SELECT COUNT(*) FROM e_assessment_question_images i WHERE i.question_id = q.id) AS image_count,
          av.id AS approved_id, av.version_no AS approved_no, av.max_marks AS approved_max,
          av.source_guide_hash AS approved_guide_hash, av.approval_notes AS approved_notes,
          (SELECT TOP 1 d.id FROM ai_marking_scheme_versions d WHERE d.question_id = q.id AND d.status = 'draft') AS draft_id,
          (SELECT COUNT(*) FROM e_assessment_answers a
             JOIN e_assessment_submissions s ON s.id = a.submission_id
             JOIN e_assessment_submission_assignments asg ON asg.submission_id = s.id AND asg.teacher_id = @teacherId
           WHERE a.question_id = q.id AND a.marks_awarded IS NULL AND s.status <> 'released'
             AND LEN(LTRIM(RTRIM(CAST(a.essay_answer AS NVARCHAR(MAX))))) > 0) AS unmarked_answers
        FROM e_assessment_questions q
        LEFT JOIN ai_marking_scheme_versions av ON av.question_id = q.id AND av.status = 'approved'
        WHERE q.e_assessment_id = @a AND LOWER(q.question_type) = 'essay' AND (${ACCESS_SQL})
        ORDER BY q.id
      `);
      return r.recordset;
    },

    /** How many unfinished evaluations are still pinned to this version (they keep using it). */
    async countPinnedInFlight(versionId) {
      const r = await req().input("v", sql.Int, versionId).query(`
        /*scheme:count-pinned*/
        SELECT COUNT(*) AS n FROM ai_marking_evaluations WHERE scheme_version_id = @v AND status = 'pending'
      `);
      return Number(r.recordset[0]?.n || 0);
    },

    /** New draft as the next version number. At most one draft per question: returns { ok:false, reason:'DRAFT_EXISTS' } otherwise. */
    async createDraft({ questionId, criteriaJson, maxMarks, guideHash, createdBy, changeNote }) {
      return inTransaction(async (tx) => {
        const existing = await new sql.Request(tx).input("q", sql.Int, questionId).query(`
          /*scheme:draft-exists*/
          SELECT TOP 1 id FROM ai_marking_scheme_versions WITH (UPDLOCK, HOLDLOCK) WHERE question_id = @q AND status = 'draft'
        `);
        if (existing.recordset[0]) return { ok: false, reason: "DRAFT_EXISTS", versionId: existing.recordset[0].id };
        const r = await new sql.Request(tx)
          .input("q", sql.Int, questionId).input("criteria", sql.NVarChar(sql.MAX), criteriaJson)
          .input("max", sql.Decimal(6, 2), maxMarks).input("hash", sql.Char(64), guideHash)
          .input("by", sql.Int, createdBy).input("note", sql.NVarChar(500), changeNote ?? null).query(`
          /*scheme:create-draft*/
          INSERT INTO ai_marking_scheme_versions (question_id, version_no, criteria_json, max_marks, source_guide_hash, status, created_by, change_note)
          OUTPUT INSERTED.id, INSERTED.version_no
          SELECT @q, ISNULL(MAX(version_no), 0) + 1, @criteria, @max, @hash, 'draft', @by, @note
          FROM ai_marking_scheme_versions WITH (UPDLOCK, HOLDLOCK) WHERE question_id = @q
        `);
        return { ok: true, versionId: r.recordset[0].id, versionNo: r.recordset[0].version_no };
      });
    },

    /** Edit a DRAFT in place. Returns false if it is not (or no longer) a draft. */
    async updateDraft({ versionId, criteriaJson, maxMarks, guideHash, changeNote }) {
      const r = await req().input("id", sql.Int, versionId).input("criteria", sql.NVarChar(sql.MAX), criteriaJson)
        .input("max", sql.Decimal(6, 2), maxMarks).input("hash", sql.Char(64), guideHash).input("note", sql.NVarChar(500), changeNote ?? null).query(`
        /*scheme:update-draft*/
        UPDATE ai_marking_scheme_versions
        SET criteria_json = @criteria, max_marks = @max, source_guide_hash = @hash, change_note = @note
        WHERE id = @id AND status = 'draft'
      `);
      return (r.rowsAffected?.[0] || 0) > 0;
    },

    /** Drafts were never used by any evaluation, so a discarded draft can simply go. Approved/superseded versions are never deleted. */
    async discardDraft(versionId) {
      const r = await req().input("id", sql.Int, versionId).query(`
        /*scheme:discard-draft*/
        DELETE FROM ai_marking_scheme_versions WHERE id = @id AND status = 'draft'
      `);
      return (r.rowsAffected?.[0] || 0) > 0;
    },

    /** Supersede the current approved version and approve this draft — one transaction. */
    async approveVersion({ versionId, approvedBy, approvalNotes }) {
      return inTransaction(async (tx) => {
        const cur = await new sql.Request(tx).input("id", sql.Int, versionId).query(`
          /*scheme:approve-lock*/
          SELECT v.id, v.question_id, v.status, v.max_marks, q.marks
          FROM ai_marking_scheme_versions v WITH (UPDLOCK, HOLDLOCK)
          JOIN e_assessment_questions q ON q.id = v.question_id
          WHERE v.id = @id
        `);
        const row = cur.recordset[0];
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        if (row.status !== "draft") return { ok: false, reason: "NOT_A_DRAFT" };
        if (Number(row.max_marks) !== Number(row.marks)) return { ok: false, reason: "MARKS_CHANGED" };
        await new sql.Request(tx).input("q", sql.Int, row.question_id).query(`
          /*scheme:supersede-old*/
          UPDATE ai_marking_scheme_versions SET status = 'superseded' WHERE question_id = @q AND status = 'approved'
        `);
        const r = await new sql.Request(tx).input("id", sql.Int, versionId).input("by", sql.Int, approvedBy)
          .input("notes", sql.NVarChar(sql.MAX), approvalNotes).query(`
          /*scheme:approve*/
          UPDATE ai_marking_scheme_versions
          SET status = 'approved', approved_by = @by, approved_at = GETDATE(), approval_notes = @notes
          WHERE id = @id AND status = 'draft'
        `);
        if (!(r.rowsAffected?.[0] > 0)) return { ok: false, reason: "NOT_A_DRAFT" };
        return { ok: true, questionId: row.question_id };
      });
    },
  };
}

module.exports = { createSqlSchemeStore, ACCESS_SQL };
