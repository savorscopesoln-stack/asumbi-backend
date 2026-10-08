/* =========================================================================
   IN-MEMORY SCHEME STORE (tests only)

   Same interface and the same guarantees as services/aiMarkingScheme.store.js:
   - access = question setter OR assigned a submission of the assessment;
   - one draft per question; one approved per question (a second approval
     supersedes the first in the same step, or fails and changes nothing);
   - approval re-checks "still a draft" and "marks still match" under a
     per-question lock; every step yields to the event loop so concurrent
     callers interleave.
   PROVES: the service is correct GIVEN a store honouring this contract.
   DOES NOT PROVE: that the T-SQL honours it (see tests/README.md, Phase 8).
========================================================================= */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createMemorySchemeStore() {
  const db = { questions: new Map(), versions: [], setters: new Set(), assigned: new Set(), unmarked: new Map(), pending: new Map(), nextId: 1 };
  const locks = new Map();
  const hooks = {};
  async function withLock(key, fn) {
    while (locks.get(key)) await locks.get(key);
    let release; locks.set(key, new Promise((r) => { release = r; }));
    try { return await fn(); } finally { locks.delete(key); release(); }
  }
  const allowed = (teacherId, q) => db.setters.has(`${q.e_assessment_id}:${teacherId}`) || db.assigned.has(`${q.e_assessment_id}:${teacherId}`);
  const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);

  return {
    db, hooks,
    // ---- test setup ----
    addQuestion(q) { db.questions.set(q.id, { question_type: "essay", marks: 5, marking_guide: "", image_count: 0, question_text: "Q", ...q }); },
    addSetter(a, t) { db.setters.add(`${a}:${t}`); },
    assign(a, t) { db.assigned.add(`${a}:${t}`); },
    setUnmarked(qid, n) { db.unmarked.set(qid, n); },
    setPending(versionId, n) { db.pending.set(versionId, n); },
    addVersion(v) { const row = { id: db.nextId++, version_no: 1, status: "draft", max_marks: 5, criteria_json: "[]", source_guide_hash: null, created_by: 1, approved_by: null, approved_at: null, createdAt: new Date(), change_note: null, approval_notes: null, ...v }; db.versions.push(row); return row; },

    // ---- the store interface ----
    async getQuestion({ teacherId, questionId }) {
      await tick();
      const q = db.questions.get(questionId);
      return q && allowed(teacherId, q) ? { id: q.id, assessment_id: q.e_assessment_id, ...q } : null;
    },
    async listVersions(questionId) { await tick(); return clone(db.versions.filter((v) => v.question_id === questionId).sort((a, b) => b.version_no - a.version_no)); },
    async getVersion({ teacherId, versionId }) {
      await tick();
      const v = db.versions.find((x) => x.id === versionId);
      const q = v && db.questions.get(v.question_id);
      return v && q && allowed(teacherId, q) ? { ...clone(v), assessment_id: q.e_assessment_id } : null;
    },
    async listAssessmentQuestions({ teacherId, assessmentId }) {
      await tick();
      return [...db.questions.values()].filter((q) => q.e_assessment_id === assessmentId && String(q.question_type).toLowerCase() === "essay" && allowed(teacherId, q)).map((q) => {
        const av = db.versions.find((v) => v.question_id === q.id && v.status === "approved");
        const d = db.versions.find((v) => v.question_id === q.id && v.status === "draft");
        return {
          id: q.id, question_text: q.question_text, question_type: q.question_type, marks: q.marks, marking_guide: q.marking_guide, image_count: q.image_count,
          approved_id: av ? av.id : null, approved_no: av ? av.version_no : null, approved_max: av ? av.max_marks : null,
          approved_guide_hash: av ? av.source_guide_hash : null, approved_notes: av ? av.approval_notes : null,
          draft_id: d ? d.id : null, unmarked_answers: db.unmarked.get(q.id) || 0,
        };
      });
    },
    async countPinnedInFlight(versionId) { await tick(); return db.pending.get(versionId) || 0; },
    async createDraft({ questionId, criteriaJson, maxMarks, guideHash, createdBy, changeNote }) {
      return withLock(`q${questionId}`, async () => {
        await tick();
        const existing = db.versions.find((v) => v.question_id === questionId && v.status === "draft");
        if (existing) return { ok: false, reason: "DRAFT_EXISTS", versionId: existing.id };
        const no = Math.max(0, ...db.versions.filter((v) => v.question_id === questionId).map((v) => v.version_no)) + 1;
        const row = { id: db.nextId++, question_id: questionId, version_no: no, status: "draft", max_marks: maxMarks, criteria_json: criteriaJson, source_guide_hash: guideHash, created_by: createdBy, approved_by: null, approved_at: null, createdAt: new Date(), change_note: changeNote ?? null, approval_notes: null };
        db.versions.push(row);
        return { ok: true, versionId: row.id, versionNo: no };
      });
    },
    async updateDraft({ versionId, criteriaJson, maxMarks, guideHash, changeNote }) {
      await tick();
      const v = db.versions.find((x) => x.id === versionId);
      if (!v || v.status !== "draft") return false;
      Object.assign(v, { criteria_json: criteriaJson, max_marks: maxMarks, source_guide_hash: guideHash, change_note: changeNote ?? null });
      return true;
    },
    async discardDraft(versionId) {
      await tick();
      const i = db.versions.findIndex((x) => x.id === versionId && x.status === "draft");
      if (i < 0) return false;
      db.versions.splice(i, 1);
      return true;
    },
    async approveVersion({ versionId, approvedBy, approvalNotes }) {
      const probe = db.versions.find((x) => x.id === versionId);
      if (!probe) return { ok: false, reason: "NOT_FOUND" };
      return withLock(`q${probe.question_id}`, async () => {
        await tick();
        if (hooks.afterLock) await hooks.afterLock(versionId);
        const v = db.versions.find((x) => x.id === versionId);
        if (!v) return { ok: false, reason: "NOT_FOUND" };
        if (v.status !== "draft") return { ok: false, reason: "NOT_A_DRAFT" };
        const q = db.questions.get(v.question_id);
        if (Number(v.max_marks) !== Number(q.marks)) return { ok: false, reason: "MARKS_CHANGED" };
        for (const o of db.versions) if (o.question_id === v.question_id && o.status === "approved") o.status = "superseded";
        await tick();
        Object.assign(v, { status: "approved", approved_by: approvedBy, approved_at: new Date(), approval_notes: approvalNotes });
        return { ok: true, questionId: v.question_id };
      });
    },
  };
}
module.exports = { createMemorySchemeStore };
