const L = require("./aiMarkingScheme.logic");

/* =========================================================================
   AI MARKING — SCHEME SERVICE (Phase 8)

   Turns a question's free-text marking guide into a structured, versioned,
   teacher-approved scheme, and warns about problems first.

   Lifecycle of a version:   draft --approve--> approved --(next approval)--> superseded
     - There is at most ONE draft per question. Editing a draft changes it in place
       (nothing has used it yet). Approved and superseded versions are never edited
       or deleted: a change is always a NEW version with a reason.
     - Approving needs: no errors, and every warning acknowledged by its code.
       What was acknowledged is stored with the version.
     - Evaluations already running keep the version they were claimed with. Approving a
       new version changes only what is claimed AFTER it.

   WHO MAY: a teacher who set questions for the assessment, or who is assigned
   submissions of it (Decision D23). Anyone else gets "not found". No admin bypass,
   consistent with the other AI marking screens.

   Nothing here moves money, calls the AI provider (except the optional suggestion
   call), writes marks or touches results.
========================================================================= */

class SchemeError extends Error {
  constructor(status, code, message, details = null) { super(message); this.name = "SchemeError"; this.statusCode = status; this.code = code; this.details = details; }
}

const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const NOTE_MAX = 500;
const MAX_JSON_CHARS = 60000;
const DRIFT_CODES = new Set(["APPROVED_MARKS_STALE", "GUIDE_CHANGED", "QUESTION_CHANGED"]);
const LINT_VERSION = "scheme-lint-1";

function makeSchemeService({ store, suggest = null, config = null, provider = null, now = () => Date.now(), rate = { max: 20, windowMs: 3600000 } }) {
  const hits = new Map();   // teacherId -> timestamps (in-process only; see notes)

  async function loadQuestion(teacherId, questionIdRaw) {
    const id = toInt(questionIdRaw);
    if (!id) throw new SchemeError(400, "BAD_ID", "Invalid question id");
    const row = await store.getQuestion({ teacherId, questionId: id });
    if (!row) throw new SchemeError(404, "NOT_FOUND", "Question not found.");
    return {
      id: row.id, assessmentId: row.assessment_id, text: String(row.question_text ?? ""), type: row.question_type,
      marks: Number(row.marks), guideText: String(row.marking_guide ?? ""), imageCount: Number(row.image_count || 0),
    };
  }
  const lintQ = (q) => ({ marks: q.marks, text: q.text, type: q.type, guideText: q.guideText, imageCount: q.imageCount });
  const parseCriteria = (v) => L.normaliseCriteria(L.parseJson(v.criteria_json, []));

  const publicVersion = (v) => ({
    id: v.id, versionNo: v.version_no, status: v.status, maxMarks: Number(v.max_marks),
    criteria: parseCriteria(v), createdBy: v.created_by, createdAt: v.createdAt, changeNote: v.change_note || null,
    approvedBy: v.approved_by || null, approvedAt: v.approved_at || null,
    acknowledgedWarnings: L.parseJson(v.approval_notes, {}).acknowledged || [],
  });

  async function stateFor(teacherId, q) {
    const versions = await store.listVersions(q.id);
    const approvedRow = versions.find((v) => v.status === "approved") || null;
    const draftRow = versions.find((v) => v.status === "draft") || null;
    const findings = draftRow ? L.lintScheme(parseCriteria(draftRow), lintQ(q)) : [];
    const drift = approvedRow ? L.driftFindings(approvedRow, lintQ(q)) : [];
    const qLevel = !draftRow && !approvedRow ? L.lintScheme([], lintQ(q)).filter((f) => ["NO_GUIDE", "IMAGE_DEPENDENT", "DIAGRAM_REFERENCED", "NOT_ESSAY"].includes(f.code)) : [];
    return {
      question: { id: q.id, assessmentId: q.assessmentId, text: q.text, marks: q.marks, imageCount: q.imageCount, hasGuide: !!q.guideText.trim(), guideText: q.guideText },
      status: L.readinessOf({ guideText: q.guideText, imageCount: q.imageCount, approved: approvedRow, draft: draftRow, findings: drift }),
      approved: approvedRow && publicVersion(approvedRow),
      draft: draftRow && publicVersion(draftRow),
      history: versions.filter((v) => v.status === "superseded").map(publicVersion),
      findings: draftRow ? findings : qLevel,
      summary: L.summarise(draftRow ? findings : qLevel),
      drift,
      inFlightOnApproved: approvedRow ? await store.countPinnedInFlight(approvedRow.id) : 0,
    };
  }

  return {
    /** Checklist for one assessment: which essay questions are ready for AI marking, and why not. */
    async readiness({ teacherId, assessmentId }) {
      const id = toInt(assessmentId);
      if (!id) throw new SchemeError(400, "BAD_ID", "Invalid assessment id");
      const rows = await store.listAssessmentQuestions({ teacherId, assessmentId: id });
      const questions = rows.map((r) => {
        const q = { marks: Number(r.marks), text: String(r.question_text ?? ""), type: r.question_type, guideText: String(r.marking_guide ?? ""), imageCount: Number(r.image_count || 0) };
        const approved = r.approved_id ? { max_marks: r.approved_max, source_guide_hash: r.approved_guide_hash, approval_notes: r.approved_notes } : null;
        const drift = approved ? L.driftFindings(approved, q) : [];
        const status = L.readinessOf({ guideText: q.guideText, imageCount: q.imageCount, approved, draft: r.draft_id, findings: drift });
        const notes = [];
        if (q.imageCount > 0) notes.push("IMAGE_DEPENDENT");
        else if (L.lintScheme([], q).some((f) => f.code === "DIAGRAM_REFERENCED")) notes.push("DIAGRAM_REFERENCED");
        return {
          questionId: r.id, text: q.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160), marks: q.marks,
          status, imageCount: q.imageCount, unmarkedAnswers: Number(r.unmarked_answers || 0),
          approvedVersionNo: r.approved_no || null, hasDraft: !!r.draft_id, notes, driftCodes: drift.map((d) => d.code),
        };
      });
      const count = (s) => questions.filter((q) => q.status === s).length;
      const blocked = questions.filter((q) => ["no_guide", "no_scheme", "draft", "stale"].includes(q.status));
      return {
        questions,
        summary: {
          total: questions.length, ready: count("ready"), review: count("review"), draft: count("draft"),
          noScheme: count("no_scheme"), noGuide: count("no_guide"), stale: count("stale"),
          unmarkedAnswersBlocked: blocked.reduce((s, q) => s + q.unmarkedAnswers, 0),
        },
      };
    },

    async questionState({ teacherId, questionId }) {
      const q = await loadQuestion(teacherId, questionId);
      return stateFor(teacherId, q);
    },

    /** A starting point built from the old guide text. Saves nothing. */
    async draftFromGuide({ teacherId, questionId }) {
      const q = await loadQuestion(teacherId, questionId);
      const d = L.draftFromGuide(q.guideText, q.marks);
      const criteria = L.normaliseCriteria(d.criteria.map((c) => ({ ...c, maxMarks: c.maxMarks == null ? "" : c.maxMarks })));
      return { criteria, notes: d.notes, findings: L.lintScheme(criteria, lintQ(q)) };
    },

    /** Free check of criteria the teacher is typing. Saves nothing. */
    async validate({ teacherId, questionId, criteria }) {
      const q = await loadQuestion(teacherId, questionId);
      const clean = L.normaliseCriteria(criteria);
      const findings = L.lintScheme(clean, lintQ(q));
      return { criteria: clean, findings, summary: L.summarise(findings) };
    },

    /** Create the draft, or update the existing one. Incomplete drafts may be saved; only approval needs a clean scheme. */
    async saveDraft({ teacherId, questionId, criteria, draftId = null, changeNote = null }) {
      const q = await loadQuestion(teacherId, questionId);
      if (!(q.marks > 0)) throw new SchemeError(409, "QUESTION_MARKS_INVALID", "The question has no valid maximum mark, so a scheme cannot be saved.");
      const clean = L.normaliseCriteria(criteria);
      if (!clean.length) throw new SchemeError(400, "EMPTY_SCHEME", "Add at least one criterion before saving.");
      const json = JSON.stringify(clean);
      if (json.length > MAX_JSON_CHARS) throw new SchemeError(400, "SCHEME_TOO_LARGE", "This scheme is too large to save.");
      const note = changeNote == null ? null : String(changeNote).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;
      const versions = await store.listVersions(q.id);
      const draft = versions.find((v) => v.status === "draft") || null;
      const args = { criteriaJson: json, maxMarks: q.marks, guideHash: L.hashGuide(q.guideText), changeNote: note };

      if (draft) {
        if (toInt(draftId) !== draft.id) throw new SchemeError(409, "DRAFT_EXISTS", "A draft for this question already exists (someone else may have started it). Reload to see it before changing it.", { draftId: draft.id });
        const ok = await store.updateDraft({ versionId: draft.id, ...args });
        if (!ok) throw new SchemeError(409, "NOT_A_DRAFT", "That draft was approved or discarded while you were editing. Reload.");
      } else {
        if (draftId != null) throw new SchemeError(409, "DRAFT_GONE", "The draft you were editing no longer exists. Reload.");
        const r = await store.createDraft({ questionId: q.id, createdBy: teacherId, ...args });
        if (!r.ok) throw new SchemeError(409, "DRAFT_EXISTS", "A draft for this question was just created by someone else. Reload.", { draftId: r.versionId });
      }
      return { state: await stateFor(teacherId, q) };
    },

    async discardDraft({ teacherId, versionId }) {
      const id = toInt(versionId);
      if (!id) throw new SchemeError(400, "BAD_ID", "Invalid version id");
      const v = await store.getVersion({ teacherId, versionId: id });
      if (!v) throw new SchemeError(404, "NOT_FOUND", "Scheme version not found.");
      if (v.status !== "draft") throw new SchemeError(409, "NOT_A_DRAFT", "Only a draft can be discarded. Approved schemes are kept for the record.");
      if (!(await store.discardDraft(id))) throw new SchemeError(409, "NOT_A_DRAFT", "That draft was approved or discarded already.");
      return { state: await stateFor(teacherId, await loadQuestion(teacherId, v.question_id)) };
    },

    /** Approve a draft: re-checks everything now, requires acknowledgement of each warning, swaps versions atomically. */
    async approve({ teacherId, versionId, acknowledge = [] }) {
      const id = toInt(versionId);
      if (!id) throw new SchemeError(400, "BAD_ID", "Invalid version id");
      const v = await store.getVersion({ teacherId, versionId: id });
      if (!v) throw new SchemeError(404, "NOT_FOUND", "Scheme version not found.");
      if (v.status !== "draft") throw new SchemeError(409, "NOT_A_DRAFT", v.status === "approved" ? "This version is already approved." : "Only a draft can be approved.");
      const q = await loadQuestion(teacherId, v.question_id);

      const findings = L.lintScheme(parseCriteria(v), lintQ(q));
      const decision = L.approvalDecision(findings, acknowledge);
      if (decision.blockers.length) throw new SchemeError(409, "SCHEME_HAS_ERRORS", "Fix the errors before approving.", { findings });
      if (decision.unacknowledged.length) throw new SchemeError(409, "WARNINGS_NOT_ACKNOWLEDGED", "Read each warning and tick it to confirm before approving.", { codes: decision.unacknowledged, findings });

      const warnings = [...new Set(findings.filter((f) => f.severity === "warning").map((f) => f.code))];
      const notes = JSON.stringify({
        acknowledged: warnings, warnings, lint: LINT_VERSION, questionHash: L.hashQuestion({ text: q.text, marks: q.marks, guideText: q.guideText }),
        counts: L.summarise(findings),
      });
      const r = await store.approveVersion({ versionId: id, approvedBy: teacherId, approvalNotes: notes });
      if (!r.ok) {
        const map = {
          NOT_FOUND: [404, "NOT_FOUND", "Scheme version not found."],
          NOT_A_DRAFT: [409, "NOT_A_DRAFT", "This draft was approved or discarded while you were reviewing. Reload."],
          MARKS_CHANGED: [409, "MARKS_CHANGED", "The question's marks changed while you were reviewing. Reload and check the scheme again."],
        };
        const [s, c, m] = map[r.reason] || [409, "CONFLICT", "Could not approve. Reload and try again."];
        throw new SchemeError(s, c, m);
      }
      return { state: await stateFor(teacherId, q) };
    },

    /** Optional AI review of a scheme. Suggestions only; nothing is saved. */
    async suggest({ teacherId, questionId, criteria }) {
      if (!suggest || !config || !provider) throw new SchemeError(503, "SUGGESTIONS_DISABLED", "AI suggestions are not switched on.");
      const q = await loadQuestion(teacherId, questionId);
      const clean = L.normaliseCriteria(criteria);
      if (!clean.length) throw new SchemeError(400, "EMPTY_SCHEME", "Add at least one criterion first.");
      const t = now();
      const recent = (hits.get(teacherId) || []).filter((x) => t - x < rate.windowMs);
      if (recent.length >= rate.max) throw new SchemeError(429, "RATE_LIMITED", "You have asked for a lot of suggestions recently. Try again later.");
      recent.push(t); hits.set(teacherId, recent);
      const r = await suggest({ question: { text: q.text, marks: q.marks }, criteria: clean }, { config, provider });
      if (!r.ok) throw new SchemeError(r.retryable ? 503 : 502, "SUGGESTION_FAILED", r.retryable ? "The AI service is busy. Try again shortly." : "The AI could not produce usable suggestions.", { code: r.code });
      return { suggestions: r.suggestions, note: "Suggestions only. Nothing has been changed." };
    },
  };
}

module.exports = { SchemeError, makeSchemeService, LINT_VERSION };
