const L = require("./aiMarkingCalibration.logic");

/* =========================================================================
   AI MARKING — CALIBRATION SERVICE (Phase 9)

   Read-only. Moves no money, calls no AI provider, writes nothing, and never
   returns student data: the store hands back marks and ids of evaluations only.

   WHO MAY: the same teachers who may manage the assessment's schemes
   (Decision D23). Anyone else gets "not found". The report is aggregate: a
   marker sees how a colleague's question performed, never which student.
========================================================================= */

class CalibrationError extends Error {
  constructor(status, code, message) { super(message); this.name = "CalibrationError"; this.statusCode = status; this.code = code; }
}

const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const SNIPPET = 140;
const snippet = (t) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > SNIPPET ? `${s.slice(0, SNIPPET - 1)}…` : s; };

function makeCalibrationService({ store }) {
  const meta = (truncated) => ({
    rules: L.RULES,
    truncated: !!truncated,
    caveats: [
      "Agreement is not accuracy: suggestions accepted without being read make any scheme look good.",
      "Only answers a teacher has approved or rejected are counted; answers still waiting for review are not.",
    ],
  });

  return {
    /** Per-question summary for one assessment, plus an overall roll-up. */
    async assessmentReport({ teacherId, assessmentId: raw }) {
      const assessmentId = toInt(raw);
      if (!assessmentId) throw new CalibrationError(400, "INVALID_ASSESSMENT", "assessmentId is required");
      const [questions, { rows, truncated }] = await Promise.all([
        store.listQuestions({ teacherId, assessmentId }),
        store.getAgreementRows({ teacherId, assessmentId }),
      ]);
      if (!questions.length) throw new CalibrationError(404, "NOT_FOUND", "Assessment not found");
      const byQuestion = new Map();
      for (const r of rows) { const k = Number(r.question_id); if (!byQuestion.has(k)) byQuestion.set(k, []); byQuestion.get(k).push(r); }
      const reports = questions.map((q) => {
        const rep = L.questionReport(byQuestion.get(Number(q.question_id)) || [], q);
        return { ...rep, questionId: Number(q.question_id), questionText: snippet(q.question_text), marks: Number(q.marks) };
      });
      return { ...L.assessmentReport(reports, rows), questions: reports, ...meta(truncated) };
    },

    /** One question with every version's record. */
    async questionReport({ teacherId, assessmentId: rawA, questionId: rawQ }) {
      const assessmentId = toInt(rawA);
      const questionId = toInt(rawQ);
      if (!assessmentId || !questionId) throw new CalibrationError(400, "INVALID_ID", "assessmentId and questionId are required");
      const questions = await store.listQuestions({ teacherId, assessmentId });
      const q = questions.find((x) => Number(x.question_id) === questionId);
      if (!q) throw new CalibrationError(404, "NOT_FOUND", "Question not found");
      const { rows, truncated } = await store.getAgreementRows({ teacherId, assessmentId, questionId });
      const rep = L.questionReport(rows, q);
      return { question: { ...rep, questionId, questionText: snippet(q.question_text), marks: Number(q.marks) }, ...meta(truncated) };
    },
  };
}

module.exports = { makeCalibrationService, CalibrationError };
