const sql = require("mssql");
const { logExamAudit } = require("../utils/examAuditLog");
const { loadSubjectsWithAssessment, assignSubjectCodes } = require("./mainExamAnalytics.controller");
const { buildCombineMap, validateCombineChanges } = require("../utils/combinedSubjects");

/* =========================================================================
   SUBJECT CODES & KEY (Main Examination reports)
   GET /main-exams/:mainExamId/subject-codes
   PUT /main-exams/:mainExamId/subject-codes   { items: [{ session_id, code, key, combine_with? }] }

   The Nominal Roll / Overall Performance / Class Ranking reports head each
   subject column with a short code and print a "Code = Subject" key
   (on screen, Excel and PDF). Codes used to be generated only; an admin can
   now set the code and the key wording per subject here. Blank = go back
   to the generated code / the subject name. Deliberately NOT blocked once
   an exam is live or finished, because fixing a printed code is exactly
   when it is needed (the schedule-edit freeze does not apply).

   COMBINE: each item may also carry combine_with (a session_id, or null).
   A subject combined into another is shown as ONE subject with it on every
   report (one column, the main subject's code, one key line), and that one
   subject is what the totals and the mean use. See utils/combinedSubjects.js.
========================================================================= */

const MAX_CODE = 20;
const MAX_KEY = 150;
const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };

const getSubjectCodes = async (req, res) => {
  try {
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid id" });
    const all = await loadSubjectsWithAssessment(req.pool, mainExamId);
    // Same subset + order the reports use (only subjects with an attached paper).
    const subjects = all.filter((s) => s.e_assessment_id);
    const effective = assignSubjectCodes(subjects);
    const generated = assignSubjectCodes(subjects, { ignoreOverrides: true });
    const combineMap = buildCombineMap(subjects);
    res.json({
      success: true,
      subjects: subjects.map((s) => ({
        session_id: s.session_id,
        subject: s.subject,
        code: effective.get(s.session_id),
        generated_code: generated.get(s.session_id),
        report_code: s.report_code || "",
        report_key: s.report_key || "",
        combine_with: combineMap.get(s.session_id) || null,
      })),
    });
  } catch (err) {
    console.error("getSubjectCodes error:", err);
    res.status(500).json({ success: false, message: "Failed to load subject codes" });
  }
};

const updateSubjectCodes = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid id" });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ success: false, message: "items array is required" });

    const all = await loadSubjectsWithAssessment(pool, mainExamId);
    const valid = new Set(all.map((s) => s.session_id));

    const clean = [];
    const errors = [];
    const seen = new Map();
    const combineChanges = new Map(); // session_id -> main subject id | null (only when the item carries combine_with)
    for (const it of items) {
      const sessionId = toInt(it?.session_id);
      if (!sessionId || !valid.has(sessionId)) { errors.push("Unknown subject in list."); continue; }
      const code = String(it.code ?? "").replace(/\s+/g, " ").trim().toUpperCase();
      const key = String(it.key ?? "").replace(/\s+/g, " ").trim();
      if (code.length > MAX_CODE) errors.push(`Code "${code}" is longer than ${MAX_CODE} characters.`);
      if (key.length > MAX_KEY) errors.push(`Key text for code "${code}" is longer than ${MAX_KEY} characters.`);
      if (code) {
        if (seen.has(code)) errors.push(`Code "${code}" is used for two subjects — codes must be unique.`);
        seen.set(code, sessionId);
      }
      const hasCombine = it && Object.prototype.hasOwnProperty.call(it, "combine_with");
      const combineWith = hasCombine ? toInt(it.combine_with) : undefined;
      if (hasCombine) combineChanges.set(sessionId, combineWith || null);
      clean.push({ sessionId, code: code || null, key: key || null, hasCombine, combineWith: combineWith || null });
    }
    if (combineChanges.size) {
      const combineError = validateCombineChanges(
        all.map((s) => ({ session_id: s.session_id, subject: s.subject, report_combine_with: s.report_combine_with, has_paper: !!s.e_assessment_id })),
        combineChanges);
      if (combineError) errors.push(combineError);
    }
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const c of clean) {
        await new sql.Request(tx)
          .input("id", sql.Int, c.sessionId)
          .input("mainExaminationId", sql.Int, mainExamId)
          .input("code", sql.NVarChar(MAX_CODE), c.code)
          .input("key", sql.NVarChar(MAX_KEY), c.key)
          .input("combineWith", sql.Int, c.combineWith)
          .query(`UPDATE exam_subject_sessions SET report_code = @code, report_key = @key
                    ${c.hasCombine ? ", report_combine_with = @combineWith" : ""}
                  WHERE id = @id AND main_examination_id = @mainExaminationId`);
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      action: "subject_codes_updated",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { items: clean.map((c) => ({ session_id: c.sessionId, code: c.code, key: c.key, ...(c.hasCombine ? { combine_with: c.combineWith } : {}) })) },
    });
    return getSubjectCodes(req, res);
  } catch (err) {
    console.error("updateSubjectCodes error:", err);
    res.status(500).json({ success: false, message: "Failed to save subject codes" });
  }
};

module.exports = { getSubjectCodes, updateSubjectCodes };
