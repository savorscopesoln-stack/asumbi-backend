/* =========================================================================
   SUGGESTED REMARKS — answers a teacher marked 0, sent back to that teacher

   Admin → E-Assessments → Marking → "Suggested Remarks".

   What it does
   - Lists every written (essay / descriptive) answer that was marked 0 by a
     teacher, grouped by the teacher who marked it (e_assessment_answers.marked_by).
   - Lets the admin push one, several, or all of them back to the teacher who
     marked them, with an optional note.

   What a push-back does (it never changes a mark by itself)
   - Flags the answer return_status = 'pending' (+ note, who, when, to whom).
   - Makes sure the marker can open the answer again: if the answer was
     allocated to someone else since, or the marker has no access, an answer
     allocation to the marker is created / moved.
   - Tells the teacher (in-system notification).
   - The teacher marking screens treat a 'pending' answer as still needing a
     mark, so it comes back into their queue with the admin's note shown.
   - When the teacher saves it again, saveMarking flips it to 'done'.

   Left out on purpose
   - Blank answers (nothing to re-mark — they are auto-scored 0).
   - Auto-marked MCQs (no teacher marked them).
   - Submissions already released to the report card (re-marking would silently
     contradict what students and report cards already show).

   Columns are added at startup by utils/ensureSchema.js; the same DDL is in
   migrations/2026-10-19_add_zero_mark_return.sql.
========================================================================= */
const { sql } = require("../config/db");
const { notifyUsers } = require("../utils/notify");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const uniqInts = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(toInt).filter(Boolean))];

const MAX_ROWS = 3000;     // list cap (the response says when it was hit)
const MAX_NOTE = 500;
const PREVIEW_CHARS = 400; // answer text sent to the list; the full answer stays in the DB

// An answer counts as blank when nothing is left after stripping empty-paragraph HTML.
const NON_BLANK = `LEN(LTRIM(RTRIM(
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(CAST(ISNULL(a.essay_answer, '') AS NVARCHAR(MAX)),
    '<p>', ''), '</p>', ''), '<br>', ''), '<br/>', ''), '&nbsp;', '')))) > 0`;

/* The one definition of "suggested": used by the list AND re-checked by the push-back,
   so the client can never push back something that isn't a zero-marked written answer. */
const ELIGIBLE = `
  a.marks_awarded = 0
  AND a.marked_by IS NOT NULL
  AND ISNULL(q.question_type, 'mcq') IN ('essay', 'descriptive')
  AND ISNULL(s.status, '') <> 'released'
  AND ${NON_BLANK}`;

const FROM = `
  FROM e_assessment_answers a
  INNER JOIN e_assessment_questions q ON q.id = a.question_id
  INNER JOIN e_assessment_submissions s ON s.id = a.submission_id
  LEFT JOIN e_assessments ea ON ea.id = s.e_assessment_id
  LEFT JOIN Students st ON st.id = s.student_id
  LEFT JOIN Teachers t ON t.id = a.marked_by`;

const stripHtml = (h) =>
  String(h || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* GET /admin/zero-marked?assessmentId=&teacherId=
   → { total, truncated, pending, groups: [{ teacher_id, teacher_name, count, pending, items: [...] }] } */
const getZeroMarked = async (req, res) => {
  try {
    const assessmentId = toInt(req.query.assessmentId);
    const teacherId = toInt(req.query.teacherId);

    const request = req.pool.request().input("max", sql.Int, MAX_ROWS + 1);
    let where = ELIGIBLE;
    if (assessmentId) { request.input("aid", sql.Int, assessmentId); where += " AND s.e_assessment_id = @aid"; }
    if (teacherId) { request.input("tid", sql.Int, teacherId); where += " AND a.marked_by = @tid"; }

    const r = await request.query(`
      SELECT TOP (@max)
        a.id AS answer_id, a.submission_id, a.question_id, a.marked_by, a.marked_at,
        CAST(a.essay_answer AS NVARCHAR(MAX)) AS essay_answer,
        CAST(a.remarks AS NVARCHAR(MAX)) AS teacher_remark,
        a.return_status, a.return_note, a.returned_at,
        q.marks AS max_marks, CAST(q.question_text AS NVARCHAR(MAX)) AS question_text,
        s.student_id, s.e_assessment_id, st.name AS student_name,
        ea.title AS assessment_title, ea.subject AS subject_name,
        t.name AS teacher_name
      ${FROM}
      WHERE ${where}
      ORDER BY t.name, ea.title, st.name, a.id`);

    const rows = r.recordset;
    const truncated = rows.length > MAX_ROWS;
    if (truncated) rows.pop();

    const byTeacher = new Map();
    for (const row of rows) {
      const key = row.marked_by;
      if (!byTeacher.has(key)) {
        byTeacher.set(key, { teacher_id: key, teacher_name: row.teacher_name || `Teacher #${key}`, count: 0, pending: 0, items: [] });
      }
      const g = byTeacher.get(key);
      g.count += 1;
      if (row.return_status === "pending") g.pending += 1;
      g.items.push({
        answer_id: row.answer_id,
        submission_id: row.submission_id,
        student_id: row.student_id,
        student_name: row.student_name || `Student #${row.student_id}`,
        e_assessment_id: row.e_assessment_id,
        assessment_title: row.assessment_title || "",
        subject_name: row.subject_name || "",
        question_text: stripHtml(row.question_text).slice(0, PREVIEW_CHARS),
        answer_preview: stripHtml(row.essay_answer).slice(0, PREVIEW_CHARS),
        max_marks: row.max_marks,
        teacher_remark: stripHtml(row.teacher_remark).slice(0, PREVIEW_CHARS),
        marked_at: row.marked_at,
        return_status: row.return_status || null,
        return_note: row.return_note || null,
        returned_at: row.returned_at || null,
      });
    }

    const groups = [...byTeacher.values()].sort((a, b) => b.count - a.count);
    res.json({
      success: true,
      total: rows.length,
      pending: groups.reduce((n, g) => n + g.pending, 0),
      truncated,
      groups,
    });
  } catch (err) {
    console.error("GET ZERO MARKED ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load zero-marked answers" });
  }
};

/* POST /admin/zero-marked/push-back
   body: { answerIds?: number[], all?: boolean, teacherId?: number, assessmentId?: number, note?: string }
   - answerIds → exactly those answers (one or several)
   - all: true → every currently suggested answer, optionally limited to one teacher / assessment
   Answers already waiting on the teacher (pending) are skipped, not re-sent. */
const pushBackZeroMarked = async (req, res) => {
  try {
    const pool = req.pool;
    const { answerIds, all } = req.body || {};
    const note = String(req.body?.note || "").trim().slice(0, MAX_NOTE) || null;
    const adminId = toInt(req.user?.id);

    const ids = uniqInts(answerIds);
    if (!ids.length && !all) {
      return res.status(400).json({ success: false, message: "Choose at least one answer, or push back all." });
    }

    // Resolve the target set with the SAME eligibility rule the list uses.
    const pick = pool.request();
    let where = `${ELIGIBLE} AND ISNULL(a.return_status, '') <> 'pending'`;
    if (ids.length) {
      where += ` AND a.id IN (${ids.join(",")})`; // integers only (uniqInts) — safe to inline
    } else {
      const tid = toInt(req.body?.teacherId);
      const aid = toInt(req.body?.assessmentId);
      if (tid) { pick.input("tid", sql.Int, tid); where += " AND a.marked_by = @tid"; }
      if (aid) { pick.input("aid", sql.Int, aid); where += " AND s.e_assessment_id = @aid"; }
    }
    const found = await pick.query(`
      SELECT a.id, a.marked_by, s.e_assessment_id, ea.title AS assessment_title
      ${FROM}
      WHERE ${where}`);

    const targets = found.recordset;
    if (!targets.length) {
      return res.json({ success: true, returned: 0, teachers: 0, skipped: ids.length || 0,
        message: "Nothing to push back — those answers are already with the teacher or no longer qualify." });
    }

    const targetIds = targets.map((t) => t.id);
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // inline integer lists are chunked to keep statements a sane size
      for (let i = 0; i < targetIds.length; i += 800) {
        const list = targetIds.slice(i, i + 800).join(",");

        await new sql.Request(tx)
          .input("note", sql.NVarChar(MAX_NOTE), note)
          .input("by", sql.Int, adminId)
          .query(`
            UPDATE e_assessment_answers
            SET return_status = 'pending', return_note = @note,
                returned_at = GETDATE(), returned_by = @by, returned_to = marked_by
            WHERE id IN (${list})`);

        // 1) an allocation that moved to someone else goes back to the marker
        await new sql.Request(tx).query(`
          UPDATE ax SET teacher_id = a.marked_by
          FROM e_assessment_answer_assignments ax
          INNER JOIN e_assessment_answers a ON a.id = ax.answer_id
          WHERE a.id IN (${list}) AND ax.teacher_id <> a.marked_by`);

        // 2) no allocation and the marker isn't the whole-submission assignee → allocate to the marker
        await new sql.Request(tx).query(`
          INSERT INTO e_assessment_answer_assignments (e_assessment_id, answer_id, teacher_id)
          SELECT s.e_assessment_id, a.id, a.marked_by
          FROM e_assessment_answers a
          INNER JOIN e_assessment_submissions s ON s.id = a.submission_id
          WHERE a.id IN (${list})
            AND NOT EXISTS (SELECT 1 FROM e_assessment_answer_assignments x WHERE x.answer_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM e_assessment_submission_assignments y
                            WHERE y.submission_id = a.submission_id AND y.teacher_id = a.marked_by)`);
      }
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      throw e;
    }

    // Notify each teacher once (a failure here never undoes the push-back).
    const perTeacher = new Map();
    for (const t of targets) {
      if (!perTeacher.has(t.marked_by)) perTeacher.set(t.marked_by, { count: 0, titles: new Set(), assessmentIds: new Set() });
      const p = perTeacher.get(t.marked_by);
      p.count += 1;
      if (t.assessment_title) p.titles.add(t.assessment_title);
      p.assessmentIds.add(t.e_assessment_id);
    }
    for (const [teacherId, p] of perTeacher) {
      const where = [...p.titles].slice(0, 2).join(", ") + (p.titles.size > 2 ? ` +${p.titles.size - 2} more` : "");
      await notifyUsers(pool, [{ id: teacherId, source: "Teachers" }], {
        title: "Answers returned for re-marking",
        message: `Admin returned ${p.count} answer${p.count === 1 ? "" : "s"} you marked 0${where ? ` (${where})` : ""} for another look.${note ? ` Note: ${note}` : ""}`,
        type: "exam",
        createdBy: adminId,
        link: p.assessmentIds.size === 1 ? `/teacher/e-assessments/${[...p.assessmentIds][0]}/all-questions-marking` : null,
      });
    }

    res.json({
      success: true,
      returned: targets.length,
      teachers: perTeacher.size,
      skipped: ids.length ? Math.max(ids.length - targets.length, 0) : 0,
      message: `Pushed back ${targets.length} answer${targets.length === 1 ? "" : "s"} to ${perTeacher.size} teacher${perTeacher.size === 1 ? "" : "s"}`,
    });
  } catch (err) {
    console.error("PUSH BACK ZERO MARKED ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to push answers back" });
  }
};

module.exports = { getZeroMarked, pushBackZeroMarked };
