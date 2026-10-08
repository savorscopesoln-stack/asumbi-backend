/* =========================================================================
   IN-MEMORY CALIBRATION STORE (tests only)

   Same interface and guarantees as services/aiMarkingCalibration.store.js:
   - access = question setter OR assigned a submission of the assessment, else nothing;
   - only decided evaluations (approved / rejected, status success / needs_review);
   - returns no student data.
   PROVES: the service is correct GIVEN a store honouring this contract.
   DOES NOT PROVE: that the T-SQL honours it (see tests/README.md, Phase 9).
========================================================================= */
function createMemoryCalibrationStore() {
  const db = { questions: new Map(), evaluations: [], setters: new Set(), assigned: new Set(), nextId: 1, calls: [] };
  const allowed = (a, t) => db.setters.has(`${a}:${t}`) || db.assigned.has(`${a}:${t}`);
  return {
    db,
    addQuestion(q) { db.questions.set(q.question_id, { question_text: "Q", marks: 5, approved_version_id: null, approved_version_no: null, ...q }); },
    addSetter(a, t) { db.setters.add(`${a}:${t}`); },
    assign(a, t) { db.assigned.add(`${a}:${t}`); },
    addEval(e) { db.evaluations.push({ evaluation_id: db.nextId++, status: "success", review_state: "approved", version_no: 1, max_marks: 5, ...e }); },

    async listQuestions({ teacherId, assessmentId }) {
      db.calls.push(["listQuestions", teacherId, assessmentId]);
      if (!allowed(assessmentId, teacherId)) return [];
      return [...db.questions.values()].filter((q) => q.assessment_id === assessmentId).sort((a, b) => a.question_id - b.question_id).map((q) => ({ ...q }));
    },
    async getAgreementRows({ teacherId, assessmentId, questionId = null }) {
      db.calls.push(["getAgreementRows", teacherId, assessmentId, questionId]);
      if (!allowed(assessmentId, teacherId)) return { rows: [], truncated: false };
      const qids = new Set([...db.questions.values()].filter((q) => q.assessment_id === assessmentId && (!questionId || q.question_id === questionId)).map((q) => q.question_id));
      const rows = db.evaluations
        .filter((e) => qids.has(e.question_id) && ["approved", "adjusted", "rejected"].includes(e.review_state) && ["success", "needs_review"].includes(e.status))
        .map(({ status, ...rest }) => ({ ...rest }));
      return { rows, truncated: false };
    },
  };
}
module.exports = { createMemoryCalibrationStore };
