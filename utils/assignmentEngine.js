/* =========================================================================
   ASSIGNMENT ENGINE
   ─────────────────────────────────────────────────────────
   1. WHICH WAY TO SPLIT THE WORK
      Normally whole submissions are shared out among the teachers
      (e_assessment_submission_assignments). When there are MORE TEACHERS
      THAN SUBMISSIONS that leaves some teachers with nothing, so the work is
      split by ANSWERED QUESTIONS instead (e_assessment_answer_assignments):
      every answered essay question is counted and the total is shared out
      evenly among all the assigned teachers.

      The answers are sorted by question, then student, and cut into
      consecutive blocks — so each teacher gets (almost) the same number of
      answers (the counts differ by at most 1) and mostly the SAME question
      for many students, which keeps marking consistent.

   2. UNDO
      Every assignment / allocation is written to a history batch
      (e_assessment_assignment_batches + _changes) holding what each item
      looked like BEFORE. undoBatch() puts it back — but never takes away
      work a teacher has already done (answers/submissions that have been
      marked stay with the teacher who marked them), and never overwrites a
      later change someone else made to the same item.
========================================================================= */
const sql = require("mssql");

const MODE = { SUBMISSION: "submission", QUESTION: "question" };
const KINDS = new Set(["sub", "ans", "ts_added", "ts_removed"]);
const CHUNK = 400;

/** "More teachers than submissions -> split by questions." */
function chooseMode(teacherCount, submissionCount) {
  return teacherCount > submissionCount ? MODE.QUESTION : MODE.SUBMISSION;
}

const ints = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const num = (v) => (Number.isInteger(Number(v)) && v !== null && v !== undefined && v !== "" ? Number(v) : "NULL");
const chunks = (arr, n = CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** items: [{ answer_id, question_id, submission_id }]. Returns [{ answer_id, teacher_id }]. */
function planAllocation(items, teacherIds) {
  const teachers = ints(teacherIds);
  if (!teachers.length || !items.length) return [];
  const sorted = [...items].sort((a, b) => (a.question_id - b.question_id) || (a.submission_id - b.submission_id) || (a.answer_id - b.answer_id));
  const base = Math.floor(sorted.length / teachers.length);
  const extra = sorted.length % teachers.length;
  const plan = [];
  let i = 0;
  teachers.forEach((tid, k) => {
    const take = base + (k < extra ? 1 : 0);
    for (let j = 0; j < take; j++) plan.push({ answer_id: sorted[i++].answer_id, teacher_id: tid });
  });
  return plan;
}

/** Records one history batch with all its changes. Returns the batch id (or null if there was nothing to record). */
async function recordBatch(pool, { kind, summary, userId, changes }) {
  const rows = (changes || []).filter((c) => KINDS.has(c.kind));
  if (!rows.length) return null;
  const b = await pool.request()
    .input("kind", sql.NVarChar(20), String(kind).slice(0, 20))
    .input("summary", sql.NVarChar(300), String(summary || "").slice(0, 300))
    .input("by", sql.Int, userId || null)
    .query(`INSERT INTO e_assessment_assignment_batches (kind, summary, created_by) OUTPUT inserted.id VALUES (@kind, @summary, @by)`);
  const batchId = b.recordset[0].id;
  for (const part of chunks(rows)) {
    // kinds come from a fixed set and every id is validated to an integer or NULL — nothing user-typed is inlined
    const values = part.map((c) => `(${batchId}, '${c.kind}', ${num(c.target_id)}, ${num(c.teacher_id)}, ${num(c.subject_id)}, ${num(c.class_id)}, ${num(c.prev_teacher_id)}, ${num(c.new_teacher_id)})`).join(",");
    await pool.request().query(`
      INSERT INTO e_assessment_assignment_changes (batch_id, kind, target_id, teacher_id, subject_id, class_id, prev_teacher_id, new_teacher_id)
      VALUES ${values}`);
  }
  return batchId;
}

/** Whole-submission round robin (the original "Distribute Equally"). Returns the changes it made. */
async function distributeBySubmission(pool, submissionIds, teacherIds) {
  const subs = ints(submissionIds);
  const teachers = ints(teacherIds);
  const changes = [];
  if (!subs.length || !teachers.length) return changes;
  const prev = {};
  for (const part of chunks(subs, 1000)) {
    const r = await pool.request().query(`SELECT submission_id, teacher_id FROM e_assessment_submission_assignments WHERE submission_id IN (${part.join(",")})`);
    for (const row of r.recordset || []) prev[row.submission_id] = row.teacher_id;
  }
  let i = 0;
  for (const submissionId of subs) {
    const teacherId = teachers[i % teachers.length];
    i++;
    if (prev[submissionId] === teacherId) continue; // already theirs: nothing to change, nothing to undo
    if (prev[submissionId] !== undefined) {
      await pool.request().input("s", sql.Int, submissionId).input("t", sql.Int, teacherId)
        .query(`UPDATE e_assessment_submission_assignments SET teacher_id = @t, assigned_at = GETDATE() WHERE submission_id = @s`);
    } else {
      await pool.request().input("s", sql.Int, submissionId).input("t", sql.Int, teacherId)
        .query(`INSERT INTO e_assessment_submission_assignments (submission_id, teacher_id, assigned_at) VALUES (@s, @t, GETDATE())`);
    }
    changes.push({ kind: "sub", target_id: submissionId, prev_teacher_id: prev[submissionId] ?? null, new_teacher_id: teacherId });
  }
  return changes;
}

/** The answered, still-unmarked, not-yet-allocated essay answers of these submissions. */
async function loadAllocatableAnswers(pool, submissionIds) {
  const out = [];
  for (const part of chunks(ints(submissionIds), 1000)) {
    const r = await pool.request().query(`
      SELECT a.id AS answer_id, a.question_id, a.submission_id, s.e_assessment_id
      FROM e_assessment_answers a
      INNER JOIN e_assessment_submissions s ON s.id = a.submission_id
      INNER JOIN e_assessment_questions q ON q.id = a.question_id
      LEFT JOIN e_assessment_answer_assignments ax ON ax.answer_id = a.id
      WHERE a.submission_id IN (${part.join(",")})
        AND ax.id IS NULL
        AND a.marks_awarded IS NULL
        AND q.question_type IN ('essay', 'descriptive')
        AND LEN(LTRIM(RTRIM(CAST(ISNULL(a.essay_answer, '') AS NVARCHAR(MAX))))) > 0
    `);
    out.push(...(r.recordset || []));
  }
  return out;
}

/** Splits the answered questions among the teachers. Returns { changes, perTeacher, total }. */
async function distributeByQuestion(pool, submissionIds, teacherIds) {
  const answers = await loadAllocatableAnswers(pool, submissionIds);
  const plan = planAllocation(answers, teacherIds);
  const assessmentOf = {};
  answers.forEach((a) => { assessmentOf[a.answer_id] = a.e_assessment_id; });
  for (const part of chunks(plan)) {
    const values = part.map((p) => `(${Number(assessmentOf[p.answer_id])}, ${Number(p.answer_id)}, ${Number(p.teacher_id)})`).join(",");
    await pool.request().query(`INSERT INTO e_assessment_answer_assignments (e_assessment_id, answer_id, teacher_id) VALUES ${values}`);
  }
  const perTeacher = {};
  plan.forEach((p) => { perTeacher[p.teacher_id] = (perTeacher[p.teacher_id] || 0) + 1; });
  return {
    total: plan.length,
    perTeacher,
    changes: plan.map((p) => ({ kind: "ans", target_id: p.answer_id, prev_teacher_id: null, new_teacher_id: p.teacher_id })),
  };
}

/* ── UNDO ───────────────────────────────────────────────────────────────── */
async function undoBatch(pool, batchId, userId) {
  const b = await pool.request().input("id", sql.Int, batchId)
    .query(`SELECT id, kind, summary, undone_at FROM e_assessment_assignment_batches WHERE id = @id`);
  if (!b.recordset.length) return { status: 404, message: "That action was not found" };
  if (b.recordset[0].undone_at) return { status: 400, message: "That action has already been undone" };

  const ch = await pool.request().input("id", sql.Int, batchId)
    .query(`SELECT kind, target_id, teacher_id, subject_id, class_id, prev_teacher_id, new_teacher_id FROM e_assessment_assignment_changes WHERE batch_id = @id`);
  const rows = ch.recordset || [];

  let restored = 0, keptMarked = 0, changedSince = 0;

  // answers handed to teachers -> take them back (never those already marked)
  const ans = rows.filter((r) => r.kind === "ans");
  const byTeacher = {};
  ans.forEach((r) => { (byTeacher[r.new_teacher_id] ||= []).push(r.target_id); });
  for (const [tid, ids] of Object.entries(byTeacher)) {
    for (const part of chunks(ids, 1000)) {
      const del = await pool.request().input("t", sql.Int, Number(tid)).query(`
        DELETE ax OUTPUT deleted.answer_id
        FROM e_assessment_answer_assignments ax
        INNER JOIN e_assessment_answers a ON a.id = ax.answer_id
        WHERE ax.answer_id IN (${part.join(",")}) AND ax.teacher_id = @t AND a.marks_awarded IS NULL`);
      const removed = (del.recordset || []).length;
      restored += removed;
      // not removed = already marked, or someone re-allocated it since
      const left = await pool.request().input("t", sql.Int, Number(tid)).query(`
        SELECT COUNT(*) AS n FROM e_assessment_answer_assignments ax
        INNER JOIN e_assessment_answers a ON a.id = ax.answer_id
        WHERE ax.answer_id IN (${part.join(",")}) AND ax.teacher_id = @t AND a.marks_awarded IS NOT NULL`);
      keptMarked += left.recordset[0]?.n || 0;
      changedSince += part.length - removed - (left.recordset[0]?.n || 0);
    }
  }

  // whole submissions -> back to their previous teacher (or unassigned)
  for (const r of rows.filter((x) => x.kind === "sub")) {
    const cur = await pool.request().input("s", sql.Int, r.target_id)
      .query(`SELECT aa.teacher_id, s.status FROM e_assessment_submission_assignments aa INNER JOIN e_assessment_submissions s ON s.id = aa.submission_id WHERE aa.submission_id = @s`);
    const c = cur.recordset[0];
    if (!c || c.teacher_id !== r.new_teacher_id) { changedSince++; continue; }
    if (c.status && c.status !== "submitted") { keptMarked++; continue; } // already marked/released: stays put
    if (r.prev_teacher_id) {
      await pool.request().input("s", sql.Int, r.target_id).input("t", sql.Int, r.prev_teacher_id)
        .query(`UPDATE e_assessment_submission_assignments SET teacher_id = @t, assigned_at = GETDATE() WHERE submission_id = @s`);
    } else {
      await pool.request().input("s", sql.Int, r.target_id).query(`DELETE FROM e_assessment_submission_assignments WHERE submission_id = @s`);
    }
    restored++;
  }

  // teacher <-> subject/class rows that were ADDED -> remove them
  const added = ints(rows.filter((r) => r.kind === "ts_added").map((r) => r.target_id));
  for (const part of chunks(added, 1000)) {
    const del = await pool.request().query(`DELETE FROM TeacherSubjects OUTPUT deleted.id WHERE id IN (${part.join(",")})`);
    restored += (del.recordset || []).length;
    changedSince += part.length - (del.recordset || []).length;
  }

  // teacher <-> subject/class rows that were REMOVED -> put them back
  const removedRows = rows.filter((r) => r.kind === "ts_removed" && r.teacher_id && r.subject_id && r.class_id);
  for (const part of chunks(removedRows, 300)) {
    const values = part.map((r) => `(${Number(r.teacher_id)}, ${Number(r.subject_id)}, ${Number(r.class_id)})`).join(",");
    const ins = await pool.request().query(`
      INSERT INTO TeacherSubjects (teacher_id, subject_id, class_id)
      OUTPUT inserted.id
      SELECT v.t, v.s, v.c
      FROM (VALUES ${values}) AS v(t, s, c)
      INNER JOIN Teachers t ON t.id = v.t
      INNER JOIN Subjects s ON s.id = v.s
      INNER JOIN Classes c ON c.id = v.c
      WHERE NOT EXISTS (SELECT 1 FROM TeacherSubjects x WHERE x.teacher_id = v.t AND x.subject_id = v.s AND x.class_id = v.c)`);
    restored += (ins.recordset || []).length;
    changedSince += part.length - (ins.recordset || []).length;
  }

  await pool.request().input("id", sql.Int, batchId).input("by", sql.Int, userId || null)
    .query(`UPDATE e_assessment_assignment_batches SET undone_at = GETDATE(), undone_by = @by WHERE id = @id`);

  return { status: 200, restored, keptMarked, changedSince };
}

module.exports = {
  MODE, chooseMode, planAllocation, recordBatch, distributeBySubmission, distributeByQuestion,
  loadAllocatableAnswers, undoBatch, ints,
};
