/* =========================================================================
   IN-MEMORY REVIEW STORE  (tests only)

   Same interface and the same guarded, all-or-nothing semantics as
   services/aiMarkingReview.store.js:
     - applyApproval claims the evaluation (compare-and-set on review_state),
       writes the mark only if still unmarked / unreleased / same hash / teacher
       assigned, logs the adjustment, recomputes the submission — and if ANY step
       fails everything is rolled back (undo log).
     - a per-evaluation lock serialises concurrent calls, like the row lock the
       real claim UPDATE takes.
     - every step yields to the event loop, so concurrent callers interleave.
   `hooks` inject a race or a failure at an exact step.

   PROVES: the review service is correct GIVEN a store honouring this contract.
   DOES NOT PROVE: that the T-SQL honours it (see tests/README.md Phase 7 checklist;
   the static tests in aiMarkingReview.test.js pin its key guarantees).
========================================================================= */
const crypto = require("crypto");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sha = (text) => crypto.createHash("sha256").update(Buffer.from(String(text), "utf16le")).digest("hex");

const CRITERIA = [
  { criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, expectedPoints: ["light to chemical energy", "in chloroplasts"], acceptableAlternatives: ["makes food from sunlight"] },
  { criterionId: "c2", label: "States the products", maxMarks: 3, expectedPoints: ["glucose", "oxygen"], acceptableAlternatives: [] },
];

function createMemoryReviewStore() {
  const db = {
    evals: new Map(), answers: new Map(), submissions: new Map(), questions: new Map(), assessments: new Map(),
    students: new Map(), schemes: new Map(), assignments: new Set(), adjustments: [], nextId: 1, nextAdj: 1,
  };
  const hooks = {};
  const hook = async (name, arg) => { if (hooks[name]) await hooks[name](arg); };
  const locks = new Map();
  let clockTick = 0;

  async function withLock(key, fn) {
    while (locks.get(key)) await locks.get(key);
    let release;
    locks.set(key, new Promise((r) => { release = r; }));
    try { return await fn(); } finally { locks.delete(key); release(); }
  }

  function snapshotFor(undo, obj) { const copy = { ...obj }; undo.push(() => Object.assign(obj, copy)); }

  const store = {
    db, hooks,

    /* ---- fixtures ---- */
    /** One essay answer + its AI evaluation. All knobs overridable. Returns ids. */
    add(over = {}) {
      const n = db.nextId++;
      const o = {
        teacherId: 5, assigned: true, essay: `<p>Plants make glucose and oxygen using light energy ${n}.</p>`, marksAwarded: null, submissionStatus: "submitted",
        questionId: 100, questionHtml: "<p>Explain <b>photosynthesis</b>.</p>", maxMarks: 5, assessmentId: 1, submissionId: n,
        status: "success", reviewState: "awaiting_review", suggestedTotal: 5, criteria: null, flags: [], schemeVersionId: 7, studentName: `Student ${n}`, admissionNo: `ADM${n}`,
        missingPoints: [], teacherFinalMark: null, teacherApprovedBy: null, ...over,
      };
      const aiCriteria = o.criteria || [
        { criterionId: "c1", label: "Defines photosynthesis", maxMarks: 2, marksAwarded: 2, evidence: ["make glucose and oxygen"], matchedPoints: [0], explanation: "Defines it." },
        { criterionId: "c2", label: "States the products", maxMarks: 3, marksAwarded: 3, evidence: ["glucose and oxygen"], matchedPoints: [0, 1], explanation: "Names both." },
      ];
      db.assessments.set(o.assessmentId, { id: o.assessmentId, title: "Biology Paper 1", subject: "Biology" });
      if (!db.questions.has(o.questionId)) db.questions.set(o.questionId, { id: o.questionId, question_text: o.questionHtml, question_type: "essay", marks: o.maxMarks });
      if (!db.schemes.has(o.schemeVersionId)) db.schemes.set(o.schemeVersionId, { id: o.schemeVersionId, version_no: 1, criteria_json: JSON.stringify(CRITERIA) });
      db.answers.set(n, { id: n, submission_id: o.submissionId, question_id: o.questionId, essay_answer: o.essay, marks_awarded: o.marksAwarded, remarks: null, question_type: "essay" });
      if (!db.submissions.has(o.submissionId)) db.submissions.set(o.submissionId, { id: o.submissionId, status: o.submissionStatus, score: 0, assessment_id: o.assessmentId, student_id: n, remark_completed: 0 });
      db.students.set(n, { name: o.studentName, admissionNo: o.admissionNo });
      if (o.assigned) db.assignments.add(`${o.teacherId}:${o.submissionId}`);
      const failed = o.status === "failed";
      const e = {
        id: n, status: o.status, review_state: o.reviewState, suggested_total: failed ? null : o.suggestedTotal, max_marks: o.maxMarks,
        criteria_json: failed ? null : JSON.stringify({ criteria: aiCriteria, missingPoints: o.missingPoints }),
        review_flags: JSON.stringify(o.flags.map((code) => ({ code, source: "model" }))), last_error: failed ? "PROVIDER_TIMEOUT: gave up" : null,
        scheme_version_id: o.schemeVersionId, question_id: o.questionId, submission_id: o.submissionId, answer_id: n, answer_content_hash: sha(o.essay),
        teacher_final_mark: o.teacherFinalMark, teacher_approved_by: o.teacherApprovedBy, model: "test-model", prompt_version: "mark-v1.0",
      };
      db.evals.set(n, e);
      return { id: n, answerId: n, submissionId: o.submissionId, eval: e, answer: db.answers.get(n), submission: db.submissions.get(o.submissionId) };
    },
    adjustmentsOf: (evalId) => db.adjustments.filter((a) => a.evaluation_id === evalId),

    /* ---- reads ---- */
    async listQueue({ teacherId, view, assessmentId = null, questionId = null, afterId = 0, limit = 25 }) {
      await tick();
      const ok = {
        awaiting: (e) => e.review_state === "awaiting_review" && ["success", "needs_review"].includes(e.status),
        attention: (e) => e.review_state === "awaiting_review" && e.status === "needs_review",
        failed: (e) => e.review_state === "awaiting_review" && e.status === "failed",
      }[view];
      return [...db.evals.values()].sort((a, b) => a.id - b.id).filter((e) => {
        const a = db.answers.get(e.answer_id), s = db.submissions.get(e.submission_id);
        return ok(e) && a.marks_awarded == null && s.status !== "released" && db.assignments.has(`${teacherId}:${s.id}`)
          && (assessmentId == null || s.assessment_id === assessmentId) && (questionId == null || e.question_id === questionId) && e.id > afterId;
      }).slice(0, limit).map((e) => {
        const s = db.submissions.get(e.submission_id), st = db.students.get(s.student_id), as = db.assessments.get(s.assessment_id);
        return { id: e.id, status: e.status, reviewState: e.review_state, suggestedTotal: e.suggested_total == null ? null : Number(e.suggested_total), maxMarks: Number(e.max_marks),
          reviewFlags: e.review_flags, lastError: e.last_error, questionId: e.question_id, submissionId: e.submission_id, questionHtml: db.questions.get(e.question_id).question_text,
          assessmentId: as.id, assessmentTitle: as.title, subject: as.subject, studentName: st.name, admissionNo: st.admissionNo };
      });
    },
    async getForReview({ evaluationId, teacherId }) {
      await tick();
      const e = db.evals.get(evaluationId);
      if (!e) return null;
      const a = db.answers.get(e.answer_id), s = db.submissions.get(e.submission_id);
      if (!db.assignments.has(`${teacherId}:${s.id}`)) return null;
      const sv = db.schemes.get(e.scheme_version_id), st = db.students.get(s.student_id), as = db.assessments.get(s.assessment_id), q = db.questions.get(e.question_id);
      return {
        id: e.id, status: e.status, reviewState: e.review_state, suggestedTotal: e.suggested_total == null ? null : Number(e.suggested_total), maxMarks: Number(e.max_marks),
        criteriaJson: e.criteria_json, reviewFlags: e.review_flags, lastError: e.last_error, schemeVersionId: e.scheme_version_id, schemeVersionNo: sv && sv.version_no,
        schemeCriteriaJson: sv && sv.criteria_json, questionId: e.question_id, submissionId: e.submission_id, answerId: e.answer_id, answerHash: e.answer_content_hash,
        currentHash: sha(a.essay_answer), teacherFinalMark: e.teacher_final_mark == null ? null : Number(e.teacher_final_mark), teacherApprovedBy: e.teacher_approved_by,
        model: e.model, promptVersion: e.prompt_version, questionHtml: q.question_text, answerHtml: a.essay_answer, marksAwarded: a.marks_awarded == null ? null : Number(a.marks_awarded),
        remarks: a.remarks, submissionStatus: s.status, assessmentId: as.id, assessmentTitle: as.title, subject: as.subject, studentName: st.name, admissionNo: st.admissionNo,
      };
    },
    async getAdjustments(evaluationId) {
      await tick();
      return db.adjustments.filter((a) => a.evaluation_id === evaluationId).map((a) => ({ id: a.id, action: a.action, finalMark: a.final_mark, reason: a.reason, actorId: a.actor_id, actorRole: a.actor_role, createdAt: a.createdAt }));
    },
    async countSchemeFlags(questionId, schemeVersionId) {
      await tick();
      const actors = new Set(db.adjustments.filter((a) => a.action === "flag_scheme").filter((a) => { const e = db.evals.get(a.evaluation_id); return e.question_id === questionId && e.scheme_version_id === schemeVersionId; }).map((a) => a.actor_id));
      return actors.size;
    },

    /* ---- writes ---- */
    async applyApproval(spec) {
      const { evaluationId, teacherId, finalMark, state, action, remark, reason, beforeJson, afterJson, answerId, submissionId, expectedHash, actorRole } = spec;
      return withLock(`eval:${evaluationId}`, async () => {
        await tick();
        await hook("beforeClaim", evaluationId);
        const undo = [];
        try {
          const e = db.evals.get(evaluationId), a = db.answers.get(answerId), s = db.submissions.get(submissionId);
          if (!e || !a || !s) return { outcome: "conflict", reason: "NOT_ASSIGNED" };   // like SQL: nothing matched
          const assigned = db.assignments.has(`${teacherId}:${s.id}`);
          // 1. claim
          if (!(e.review_state === "awaiting_review" && ["success", "needs_review"].includes(e.status))) {
            if (["approved", "adjusted"].includes(e.review_state) && Number(e.teacher_approved_by) === Number(teacherId) && Number(e.teacher_final_mark) === Number(finalMark)) return { outcome: "replayed" };
            return { outcome: "conflict", reason: assigned ? "REVIEWED" : "NOT_ASSIGNED" };
          }
          snapshotFor(undo, e);
          Object.assign(e, { teacher_final_mark: finalMark, teacher_approved_by: teacherId, teacher_approved_at: ++clockTick, review_state: state });
          await tick();
          await hook("afterClaim", evaluationId);
          // 2. guarded mark write
          const ok = a.marks_awarded == null && s.status !== "released" && sha(a.essay_answer) === expectedHash && assigned;
          if (!ok) {
            undo.reverse().forEach((u) => u());
            let why = "ANSWER_CHANGED";
            if (!assigned) why = "NOT_ASSIGNED"; else if (s.status === "released") why = "RELEASED"; else if (a.marks_awarded != null) why = "ANSWER_MARKED";
            return { outcome: "conflict", reason: why };
          }
          snapshotFor(undo, a);
          a.marks_awarded = finalMark; if (remark != null) a.remarks = remark;
          await tick();
          await hook("afterMarkWrite", evaluationId);         // tests may throw here to prove atomicity
          // 3. log
          const adj = { id: db.nextAdj++, evaluation_id: evaluationId, action, before_json: beforeJson, after_json: afterJson, final_mark: finalMark, reason: reason ?? null, actor_id: teacherId, actor_role: actorRole ?? null, createdAt: ++clockTick };
          db.adjustments.push(adj); undo.push(() => db.adjustments.splice(db.adjustments.indexOf(adj), 1));
          await hook("afterLog", evaluationId);
          // 4. recompute exactly like saveMarking
          snapshotFor(undo, s);
          const mine = [...db.answers.values()].filter((x) => x.submission_id === submissionId);
          for (const x of mine) if (x.question_type !== "essay" && x.marks_awarded == null) { snapshotFor(undo, x); x.marks_awarded = 0; }
          const score = mine.reduce((t, x) => t + Number(x.marks_awarded || 0), 0);
          const fullyMarked = mine.filter((x) => x.question_type === "essay" && x.marks_awarded == null).length === 0;
          s.score = score;
          if (fullyMarked) Object.assign(s, { status: "marked", remark_completed: 1 });
          return { outcome: "applied", submission: { score, fullyMarked } };
        } catch (err) {
          undo.reverse().forEach((u) => u());
          throw err;
        }
      });
    },

    async applyDecision({ evaluationId, teacherId, actorRole, action, reason }) {
      return withLock(`eval:${evaluationId}`, async () => {
        await tick();
        await hook("beforeDecision", evaluationId);
        const e = db.evals.get(evaluationId);
        if (!e) return { outcome: "conflict", reason: "NOT_ASSIGNED" };
        const a = db.answers.get(e.answer_id), s = db.submissions.get(e.submission_id);
        const assigned = db.assignments.has(`${teacherId}:${s.id}`);
        const log = (before, after) => db.adjustments.push({ id: db.nextAdj++, evaluation_id: evaluationId, action, before_json: JSON.stringify(before), after_json: JSON.stringify(after), final_mark: null, reason: reason ?? null, actor_id: teacherId, actor_role: actorRole ?? null, createdAt: ++clockTick });
        if (action === "flag_scheme") {
          if (db.adjustments.some((x) => x.evaluation_id === evaluationId && x.action === "flag_scheme" && x.actor_id === teacherId)) return { outcome: "replayed" };
          if (!assigned) return { outcome: "conflict", reason: "NOT_ASSIGNED" };
          log({ flagged: false }, { flagged: true });
          return { outcome: "applied" };
        }
        const target = action === "request_reevaluation" ? "superseded" : "rejected";
        const from = action === "request_reevaluation" ? ["awaiting_review", "rejected"] : ["awaiting_review"];
        const guardOk = action !== "request_reevaluation" || (a.marks_awarded == null && s.status !== "released");
        if (from.includes(e.review_state) && ["success", "needs_review"].includes(e.status) && assigned && guardOk) {
          e.review_state = target;
          log({ reviewState: "awaiting_review" }, { reviewState: target });
          return { outcome: "applied" };
        }
        if (assigned && e.review_state === target) return { outcome: "replayed" };
        let why = "REVIEWED";
        if (!assigned) why = "NOT_ASSIGNED"; else if (action === "request_reevaluation" && s.status === "released") why = "RELEASED"; else if (action === "request_reevaluation" && a.marks_awarded != null) why = "ANSWER_MARKED";
        return { outcome: "conflict", reason: why };
      });
    },
  };
  return store;
}

module.exports = { createMemoryReviewStore, sha, CRITERIA };
