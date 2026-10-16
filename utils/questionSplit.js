const sql = require("mssql");
const assignmentEngine = require("./assignmentEngine");

/* =========================================================================
   MANUAL SPLIT MARKING (by question)
   The admin picks, for ONE assessment, which teacher marks which questions
   (e.g. Section A -> Teacher 1, Section B -> Teacher 2). The choice is kept as
   a rule per question (e_assessment_question_assignments) and is applied to:
     • every answer already submitted (and still unmarked), and
     • every submission that arrives later (applyRulesToSubmission, called after
       each submission is stored) — so replays / late / auto-submitted papers
       follow the same split.
   The per-answer rows it writes are the same ones the automatic split uses
   (e_assessment_answer_assignments), so teacher marking screens, the
   "By question" chip and the assignment history/undo all work unchanged.
========================================================================= */

const ints = assignmentEngine.ints;
const MARKABLE = `q.question_type IN ('essay', 'descriptive')`;

async function ensureTable(pool) {
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_question_assignments' AND xtype='U')
    CREATE TABLE e_assessment_question_assignments (
      id INT IDENTITY(1,1) PRIMARY KEY,
      e_assessment_id INT NOT NULL,
      question_id INT NOT NULL,
      teacher_id INT NOT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT GETDATE()
    )`);
  await pool.request().query(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_question_assignments' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'UX_question_assignments_q' AND object_id = Object_ID(N'e_assessment_question_assignments'))
    CREATE UNIQUE INDEX UX_question_assignments_q ON e_assessment_question_assignments (question_id)`);
}

/** Questions of the assessment + who currently marks each + how many answers are waiting. */
async function getSplitInfo(pool, assessmentId) {
  await ensureTable(pool);
  const qs = await pool.request().input("aid", sql.Int, assessmentId).query(`
    SELECT q.id, q.question_text, q.question_type, q.marks,
           r.teacher_id AS rule_teacher_id, t.name AS rule_teacher_name,
           (SELECT COUNT(*) FROM e_assessment_answers a
              INNER JOIN e_assessment_submissions s ON s.id = a.submission_id
             WHERE a.question_id = q.id AND s.e_assessment_id = @aid) AS answers,
           (SELECT COUNT(*) FROM e_assessment_answers a
              INNER JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id
             WHERE a.question_id = q.id) AS allocated
    FROM e_assessment_questions q
    LEFT JOIN e_assessment_question_assignments r ON r.question_id = q.id
    LEFT JOIN Teachers t ON t.id = r.teacher_id
    WHERE q.e_assessment_id = @aid
    ORDER BY q.id`);
  return qs.recordset.map((q, i) => ({
    id: q.id,
    number: i + 1,
    text: String(q.question_text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140),
    type: q.question_type,
    marks: q.marks,
    splittable: ["essay", "descriptive"].includes(q.question_type), // other types are auto-marked
    teacher_id: q.rule_teacher_id || null,
    teacher_name: q.rule_teacher_name || null,
    answers: q.answers,
    allocated: q.allocated,
  }));
}

/**
 * parts: [{ teacher_id, question_ids: [..] }]. Saves the rules and (re)allocates the
 * unmarked answers of those questions. Returns { allocated, perTeacher, changes, skipped }.
 */
async function applySplit(pool, assessmentId, parts) {
  await ensureTable(pool);
  const valid = await pool.request().input("aid", sql.Int, assessmentId)
    .query(`SELECT q.id FROM e_assessment_questions q WHERE q.e_assessment_id = @aid AND ${MARKABLE}`);
  const okQuestions = new Set(valid.recordset.map((r) => r.id));

  const cleaned = [];
  const seen = new Set();
  let skipped = 0;
  for (const p of parts || []) {
    const teacherId = ints([p.teacher_id])[0];
    if (!teacherId) continue;
    const qids = ints(p.question_ids).filter((q) => {
      if (!okQuestions.has(q) || seen.has(q)) { skipped++; return false; }
      seen.add(q);
      return true;
    });
    if (qids.length) cleaned.push({ teacherId, qids });
  }
  if (!cleaned.length) return { allocated: 0, perTeacher: {}, changes: [], skipped, saved: 0 };

  const tIds = ints(cleaned.map((c) => c.teacherId));
  const known = await pool.request().query(`SELECT id FROM Teachers WHERE id IN (${tIds.join(",")})`);
  if (known.recordset.length !== tIds.length) {
    const err = new Error("One of the chosen teachers no longer exists.");
    err.status = 400;
    throw err;
  }

  const changes = [];
  const perTeacher = {};
  let saved = 0;
  for (const { teacherId, qids } of cleaned) {
    // 1. the rule (one per question)
    await pool.request().query(`DELETE FROM e_assessment_question_assignments WHERE question_id IN (${qids.join(",")})`);
    await pool.request().input("aid", sql.Int, assessmentId).input("t", sql.Int, teacherId)
      .query(`INSERT INTO e_assessment_question_assignments (e_assessment_id, question_id, teacher_id)
              VALUES ${qids.map((q) => `(@aid, ${q}, @t)`).join(",")}`);
    saved += qids.length;

    // 2. unmarked, answered answers of those questions: handed over to this teacher
    const rows = await pool.request().input("aid", sql.Int, assessmentId).query(`
      SELECT a.id AS answer_id, ax.id AS ax_id, ax.teacher_id AS prev_teacher
      FROM e_assessment_answers a
      INNER JOIN e_assessment_submissions s ON s.id = a.submission_id AND s.e_assessment_id = @aid
      LEFT JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id
      WHERE a.question_id IN (${qids.join(",")})
        AND a.marks_awarded IS NULL
        AND LEN(LTRIM(RTRIM(CAST(ISNULL(a.essay_answer, '') AS NVARCHAR(MAX))))) > 0`);
    const fresh = rows.recordset.filter((r) => !r.ax_id);
    const moving = rows.recordset.filter((r) => r.ax_id && r.prev_teacher !== teacherId);

    for (let i = 0; i < fresh.length; i += 400) {
      const part = fresh.slice(i, i + 400);
      await pool.request().input("aid", sql.Int, assessmentId).input("t", sql.Int, teacherId)
        .query(`INSERT INTO e_assessment_answer_assignments (e_assessment_id, answer_id, teacher_id)
                VALUES ${part.map((r) => `(@aid, ${Number(r.answer_id)}, @t)`).join(",")}`);
    }
    for (let i = 0; i < moving.length; i += 1000) {
      const part = moving.slice(i, i + 1000);
      await pool.request().input("t", sql.Int, teacherId)
        .query(`UPDATE e_assessment_answer_assignments SET teacher_id = @t, assigned_at = GETDATE()
                WHERE answer_id IN (${part.map((r) => Number(r.answer_id)).join(",")})`);
    }
    fresh.forEach((r) => changes.push({ kind: "ans", target_id: r.answer_id, prev_teacher_id: null, new_teacher_id: teacherId }));
    moving.forEach((r) => changes.push({ kind: "ans", target_id: r.answer_id, prev_teacher_id: r.prev_teacher, new_teacher_id: teacherId }));
    perTeacher[teacherId] = (perTeacher[teacherId] || 0) + fresh.length + moving.length;
  }
  return { allocated: changes.length, perTeacher, changes, skipped, saved };
}

/** Removes the split rules and the still-unmarked allocations they created. */
async function clearSplit(pool, assessmentId) {
  await ensureTable(pool);
  const del = await pool.request().input("aid", sql.Int, assessmentId).query(`
    DELETE ax FROM e_assessment_answer_assignments ax
    INNER JOIN e_assessment_answers a ON a.id = ax.answer_id
    INNER JOIN e_assessment_question_assignments r ON r.question_id = a.question_id AND r.e_assessment_id = @aid
    WHERE ax.e_assessment_id = @aid AND a.marks_awarded IS NULL;
    DELETE FROM e_assessment_question_assignments WHERE e_assessment_id = @aid;`);
  return del.rowsAffected.reduce((a, b) => a + b, 0);
}

/** Gives a freshly stored submission's essay answers to the teachers the split names. Never throws. */
async function applyRulesToSubmission(pool, submissionId) {
  try {
    const r = await pool.request().input("sid", sql.Int, submissionId).query(`
      INSERT INTO e_assessment_answer_assignments (e_assessment_id, answer_id, teacher_id)
      SELECT s.e_assessment_id, a.id, r.teacher_id
      FROM e_assessment_answers a
      INNER JOIN e_assessment_submissions s ON s.id = a.submission_id
      INNER JOIN e_assessment_question_assignments r ON r.question_id = a.question_id
      LEFT JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id
      WHERE a.submission_id = @sid AND ax.id IS NULL
        AND LEN(LTRIM(RTRIM(CAST(ISNULL(a.essay_answer, '') AS NVARCHAR(MAX))))) > 0`);
    return r.rowsAffected[0] || 0;
  } catch (e) {
    if (!(e && (e.number === 208 || e.number === 207))) console.error("APPLY SPLIT RULES ERROR:", e.message); // 208: no rules table yet = nothing to apply
    return 0;
  }
}

module.exports = { getSplitInfo, applySplit, clearSplit, applyRulesToSubmission, ensureTable };
