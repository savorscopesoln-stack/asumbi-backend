const sql = require("mssql");

/* =========================================================================
   E-ASSESSMENT ATTEMPTS — shared by the submit endpoint, the autosave
   finalizer and the admin "resit" feature, so a submission is created the
   exact same way no matter how it was triggered.

   • persistAttempt()  — writes a submission + its answers in ONE
     transaction (auto-marking MCQs like the original submit did), clears
     the autosaved draft and closes the exam session. If the student has
     been granted a resit, the previous submission is first archived
     (e_assessment_attempt_history) and its released Marks row removed so
     the new attempt replaces it instead of double-counting.
   • finalizeExpiredAttempts() — server-side safety net: an ACTIVE exam
     whose time has run out but was never submitted (tab closed, device
     died, network dropped...) is submitted from the last autosave.
========================================================================= */

// Extra minutes after the exam's duration before the server steps in. The
// student's own browser auto-submits at time-up, so this only matters when
// that didn't happen.
const FINALIZE_GRACE_MINUTES = 2;

/* Accepts the answer array the exam page submits:
   [{ question_id, selected_option }] or [{ question_id, essay_answer }] */
async function insertAnswers(transaction, submissionId, assessmentId, answers) {
  const questionRows = await new sql.Request(transaction)
    .input("assessment_id", sql.Int, Number(assessmentId))
    .query(`SELECT id, correct_answer, marks, question_type FROM e_assessment_questions WHERE e_assessment_id = @assessment_id`);
  const questionMap = {};
  questionRows.recordset.forEach((q) => { questionMap[q.id] = q; });
  const hasEssay = questionRows.recordset.some((q) => q.question_type === "essay");

  for (const ans of answers) {
    if (!ans || !ans.question_id) continue;
    const isEssay = typeof ans.essay_answer !== "undefined";
    const q = questionMap[ans.question_id];

    let isCorrect = null;
    let marksAwarded = null;
    if (!isEssay && q) {
      const selected = (ans.selected_option || "").toString().trim().toLowerCase();
      const correct = (q.correct_answer || "").toString().trim().toLowerCase();
      isCorrect = selected.length > 0 && selected === correct;
      marksAwarded = isCorrect ? (q.marks || 0) : 0;
    }

    await new sql.Request(transaction)
      .input("submission_id", sql.Int, submissionId)
      .input("question_id", sql.Int, Number(ans.question_id))
      .input("selected_answer", sql.NVarChar(sql.MAX), isEssay ? null : (ans.selected_option || null))
      .input("essay_answer", sql.NVarChar(sql.MAX), isEssay ? (ans.essay_answer || "") : null)
      .input("is_correct", sql.Bit, isCorrect == null ? null : (isCorrect ? 1 : 0))
      .input("marks_awarded", sql.Int, marksAwarded)
      .query(`
        INSERT INTO e_assessment_answers
          (submission_id, question_id, selected_answer, essay_answer, is_correct, marks_awarded)
        VALUES
          (@submission_id, @question_id, @selected_answer, @essay_answer, @is_correct, @marks_awarded)
      `);
  }

  // Pure-MCQ assessments need no teacher marking at all — finalize immediately
  if (!hasEssay) {
    const mcqTotal = await new sql.Request(transaction)
      .input("submission_id", sql.Int, submissionId)
      .query(`SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`);
    await new sql.Request(transaction)
      .input("submission_id", sql.Int, submissionId)
      .input("score", sql.Int, mcqTotal.recordset[0].total)
      .query(`UPDATE e_assessment_submissions SET score = @score, status = 'marked', remark_completed = 1 WHERE id = @submission_id`);
  }
}

/* Moves a student's previous submission out of the live tables into
   e_assessment_attempt_history (as JSON snapshots) so nothing is lost, and
   removes the Marks row that release created for it. */
async function archiveSubmission(transaction, submissionId, assessmentId, studentId, attemptNo, reason, keepMarks = false) {
  const subRow = await new sql.Request(transaction)
    .input("id", sql.Int, submissionId)
    .query(`SELECT * FROM e_assessment_submissions WHERE id = @id`);
  const ansRows = await new sql.Request(transaction)
    .input("id", sql.Int, submissionId)
    .query(`SELECT * FROM e_assessment_answers WHERE submission_id = @id`);
  const sub = subRow.recordset[0] || {};

  await new sql.Request(transaction)
    .input("aid", sql.Int, Number(assessmentId))
    .input("sid", sql.Int, Number(studentId))
    .input("attempt", sql.Int, Number(attemptNo) || 1)
    .input("score", sql.Int, sub.score == null ? null : Number(sub.score))
    .input("status", sql.NVarChar(30), sub.status || null)
    .input("submitted_at", sql.DateTime, sub.submitted_at || null)
    .input("sub_json", sql.NVarChar(sql.MAX), JSON.stringify(sub))
    .input("ans_json", sql.NVarChar(sql.MAX), JSON.stringify(ansRows.recordset || []))
    .input("reason", sql.NVarChar(200), reason || "resit")
    .query(`
      INSERT INTO e_assessment_attempt_history
        (e_assessment_id, student_id, attempt_no, score, status, submitted_at, submission_json, answers_json, archived_reason)
      VALUES
        (@aid, @sid, @attempt, @score, @status, @submitted_at, @sub_json, @ans_json, @reason)
    `);

  // "Replace" policy: the old paper's released mark is removed so it doesn't
  // double-count next to the resit's. "Keep best" policy: it stays in place,
  // and when the resit is released the higher of the two marks is kept
  // (see writeReleasedMark in the e-assessment controller).
  if (!keepMarks) {
    await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .query(`
        DELETE m FROM Marks m
        INNER JOIN Assessments a ON a.id = m.assessmentId
        WHERE a.sourceSystem = 'e_assessment' AND a.sourceRefId = @aid AND m.studentId = @sid
      `);
  }

  await new sql.Request(transaction).input("id", sql.Int, submissionId)
    .query(`DELETE FROM e_assessment_answers WHERE submission_id = @id`);
  try {
    await new sql.Request(transaction).input("id", sql.Int, submissionId)
      .query(`DELETE FROM e_assessment_submission_assignments WHERE submission_id = @id`);
  } catch (_) { /* table is optional on older databases */ }
  await new sql.Request(transaction).input("id", sql.Int, submissionId)
    .query(`DELETE FROM e_assessment_submissions WHERE id = @id`);
}

/* Creates the submission for one attempt.
   Returns { ok: true, submissionId } or { ok: false, reason: 'duplicate', submissionId }. */
async function persistAttempt(pool, { assessmentId, studentId, answers, auto = false }) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const existing = await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .query(`SELECT id FROM e_assessment_submissions WHERE e_assessment_id = @aid AND student_id = @sid`);

    const sessRow = await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .query(`SELECT id, resit_allowed, attempt_no, resit_policy FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);
    const sess = sessRow.recordset[0];

    if (existing.recordset.length > 0) {
      if (!(sess && sess.resit_allowed)) {
        await transaction.rollback();
        return { ok: false, reason: "duplicate", submissionId: existing.recordset[0].id };
      }
      // Admin-granted resit: archive the previous attempt, then fall
      // through and store this one as the live submission.
      const keepBest = sess.resit_policy === "keep_best";
      await archiveSubmission(
        transaction, existing.recordset[0].id, assessmentId, studentId,
        Math.max(1, (sess.attempt_no || 2) - 1),
        keepBest ? "resit (keep best)" : "resit (replace)",
        keepBest
      );
    }

    const subInsert = await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .query(`
        INSERT INTO e_assessment_submissions (e_assessment_id, student_id, submitted_at, status)
        OUTPUT INSERTED.id
        VALUES (@aid, @sid, GETDATE(), 'submitted')
      `);
    const submissionId = subInsert.recordset[0].id;

    await insertAnswers(transaction, submissionId, assessmentId, answers);

    // The draft has done its job; the exam session is now closed, and any
    // pending resit permission is used up.
    await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .query(`DELETE FROM e_assessment_drafts WHERE e_assessment_id = @aid AND student_id = @sid`);
    await new sql.Request(transaction)
      .input("aid", sql.Int, Number(assessmentId))
      .input("sid", sql.Int, Number(studentId))
      .input("auto", sql.Bit, auto ? 1 : 0)
      .query(`
        UPDATE e_assessment_exam_sessions
        SET status = 'ended', ended_at = GETDATE(), resit_allowed = 0, auto_submitted = @auto
        WHERE e_assessment_id = @aid AND student_id = @sid
      `);

    await transaction.commit();
    return { ok: true, submissionId };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

/* Draft answers are stored as { "<questionId>": value } (the shape the exam
   page keeps in state). Convert to the submit payload shape. */
function draftToAnswerArray(draftObj, questionTypes) {
  return Object.entries(draftObj || {}).map(([qid, val]) => {
    const type = questionTypes[qid];
    return type === "essay"
      ? { question_id: Number(qid), essay_answer: val == null ? "" : String(val) }
      : { question_id: Number(qid), selected_option: val || null };
  });
}

/* Submits, from the last autosave, every exam whose time ran out without a
   submission. Safe to run every minute: it only touches sessions still
   'active' and a finished one drops out of the query. Locked sessions are
   deliberately left alone — an admin may still unlock them. */
async function finalizeExpiredAttempts(pool) {
  const due = await pool.request()
    .input("grace", sql.Int, FINALIZE_GRACE_MINUTES)
    .query(`
      SELECT es.id AS session_id, es.e_assessment_id, es.student_id, d.answers_json
      FROM e_assessment_exam_sessions es
      INNER JOIN e_assessments a ON a.id = es.e_assessment_id
      LEFT JOIN e_assessment_drafts d
        ON d.e_assessment_id = es.e_assessment_id AND d.student_id = es.student_id
      WHERE es.status = 'active'
        AND es.activated_at IS NOT NULL
        AND DATEADD(MINUTE, ISNULL(a.duration_minutes, 30) + @grace, es.activated_at) < GETDATE()
    `);

  let submitted = 0;
  for (const row of due.recordset) {
    try {
      let draft = {};
      try { draft = row.answers_json ? JSON.parse(row.answers_json) : {}; } catch (_) { draft = {}; }

      if (!Object.keys(draft).length) {
        // Nothing was ever saved — just close the session so it stops
        // showing as Active; there is no work to submit.
        await pool.request().input("id", sql.Int, row.session_id).query(`
          UPDATE e_assessment_exam_sessions
          SET status = 'ended', ended_at = GETDATE(), auto_submitted = 1
          WHERE id = @id AND status = 'active'
        `);
        continue;
      }

      const qRows = await pool.request()
        .input("aid", sql.Int, row.e_assessment_id)
        .query(`SELECT id, question_type FROM e_assessment_questions WHERE e_assessment_id = @aid`);
      const types = {};
      qRows.recordset.forEach((q) => { types[q.id] = q.question_type; });

      const result = await persistAttempt(pool, {
        assessmentId: row.e_assessment_id,
        studentId: row.student_id,
        answers: draftToAnswerArray(draft, types),
        auto: true,
      });
      if (result.ok) {
        submitted++;
        console.log(`📥 Auto-submitted unfinished exam from autosave (assessment ${row.e_assessment_id}, student ${row.student_id})`);
      } else {
        await pool.request().input("id", sql.Int, row.session_id).query(`
          UPDATE e_assessment_exam_sessions SET status = 'ended', ended_at = GETDATE() WHERE id = @id AND status = 'active'
        `);
      }
    } catch (err) {
      console.error(`⚠️ Auto-submit failed (session ${row.session_id}):`, err.message);
    }
  }
  return submitted;
}

module.exports = { persistAttempt, finalizeExpiredAttempts, FINALIZE_GRACE_MINUTES };
