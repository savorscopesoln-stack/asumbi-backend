const L = require("./aiMarkingReview.logic");
const { ReviewError } = L;

/* =========================================================================
   AI MARKING — REVIEW SERVICE (Phase 7)

   What a teacher can do with an AI suggestion, and nothing more:

     accept            take the suggestion as the final mark (only if whole)
     adjust            set their own marks per criterion and/or overall
     reject            "this suggestion is wrong" — no mark is written
     mark manually     same as reject, and points them at the normal marking page
     flag scheme       "this question / scheme needs correcting" — advisory, changes nothing
     request re-eval   supersede this suggestion so the answer can be AI-marked
                       again. This is a NEW paid job by the normal flow (preview,
                       confirm, charge); the original charge is not refunded.

   A teacher is never forced to do any of these: an unreviewed suggestion simply
   stays a suggestion and never reaches a result. Only accept/adjust write a mark,
   and only through store.applyApproval's guarded transaction.

   AUTHORISATION
   Every call is scoped to the authenticated teacher's id. An evaluation of a
   submission not assigned to that teacher behaves exactly like one that does not
   exist (404). There is no admin bypass — consistent with the Phase 3 panel,
   where a user with no assignments sees nothing rather than everything.

   This file adds NO billing, release or exam-approval behaviour: approving a mark
   changes e_assessment_answers like a manual save would, and that is all.
   Results still reach students only through the existing release flow.
========================================================================= */

const VIEWS = new Set(["awaiting", "attention", "failed"]);
const MAX_BULK = 100;
const MAX_QUEUE_PAGE = 100;
const REMARK_MAX = 2000;
const REASON_MAX = 500;

const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function flagCodes(reviewFlags) {
  const f = L.parseJson(reviewFlags, []);
  return (Array.isArray(f) ? f : []).map((x) => x && x.code).filter(Boolean);
}

const REASON_ERRORS = {
  REVIEWED: [409, "ALREADY_REVIEWED", "This suggestion has already been reviewed."],
  ANSWER_MARKED: [409, "ANSWER_ALREADY_MARKED", "This answer has already been marked, so the AI suggestion no longer applies."],
  RELEASED: [409, "SUBMISSION_RELEASED", "This submission's results have been released; the AI suggestion can no longer be applied."],
  ANSWER_CHANGED: [409, "ANSWER_CHANGED", "The student's answer has changed since the AI marked it. Request a new evaluation or mark it yourself."],
  NOT_ASSIGNED: [404, "NOT_FOUND", "Evaluation not found."],
};
function conflictError(reason) {
  const [status, code, message] = REASON_ERRORS[reason] || [409, "CONFLICT", "The answer changed while you were reviewing. Reload and try again."];
  return new ReviewError(status, code, message);
}

async function loadFacts(store, teacherId, evaluationId) {
  const id = toInt(evaluationId);
  if (!id) throw new ReviewError(400, "BAD_ID", "Invalid evaluation id");
  const facts = await store.getForReview({ evaluationId: id, teacherId });
  if (!facts) throw new ReviewError(404, "NOT_FOUND", "Evaluation not found.");
  return facts;
}

/** Everything that currently prevents applying the suggestion, in the order a teacher should hear about it. */
function blockersOf(f) {
  const out = [];
  if (f.status !== "success" && f.status !== "needs_review") out.push("NOT_REVIEWABLE");
  else if (f.reviewState === "approved" || f.reviewState === "adjusted") out.push("ALREADY_REVIEWED");
  else if (f.reviewState !== "awaiting_review") out.push("ALREADY_REVIEWED");
  if (f.submissionStatus === "released") out.push("SUBMISSION_RELEASED");
  if (f.marksAwarded != null && f.reviewState === "awaiting_review") out.push("ANSWER_ALREADY_MARKED");
  if (!f.currentHash || f.currentHash !== f.answerHash) out.push("ANSWER_CHANGED");
  return out;
}

const preview = (text, n = 140) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

/* ------------------------------ queue ------------------------------ */

async function listQueue(store, { teacherId, view = "awaiting", assessmentId, questionId, afterId, limit }) {
  if (!VIEWS.has(view)) throw new ReviewError(400, "BAD_VIEW", "view must be awaiting, attention or failed");
  const take = Math.min(Math.max(toInt(limit) || 25, 1), MAX_QUEUE_PAGE);
  const rows = await store.listQueue({
    teacherId, view, assessmentId: toInt(assessmentId), questionId: toInt(questionId), afterId: Number(afterId) > 0 ? Math.floor(Number(afterId)) : 0, limit: take,
  });
  const items = rows.map((r) => {
    const flags = flagCodes(r.reviewFlags);
    const total = r.suggestedTotal;
    return {
      id: r.id, status: r.status, suggestedTotal: total, maxMarks: r.maxMarks, flags, flagCount: flags.length,
      suggestedIsWhole: total != null && L.isWhole(total),
      // Bulk accept is offered ONLY where nothing needs a human's judgement: clean, unflagged, already whole.
      bulkAcceptable: r.status === "success" && flags.length === 0 && total != null && L.isWhole(total),
      failureNote: r.status === "failed" ? "The AI could not mark this answer. Mark it yourself; nothing was charged." : null,
      questionPreview: preview(L.toPlainText(r.questionHtml).text),
      assessment: { id: r.assessmentId, title: r.assessmentTitle, subject: r.subject },
      questionId: r.questionId, submissionId: r.submissionId,
      student: { name: r.studentName, admissionNo: r.admissionNo },
    };
  });
  return { items, nextCursor: items.length === take ? items[items.length - 1].id : null };
}

/* ------------------------------ detail ------------------------------ */

async function getDetail(store, { teacherId, evaluationId }) {
  const f = await loadFacts(store, teacherId, evaluationId);
  const [history, flagCount] = await Promise.all([
    store.getAdjustments(f.id),
    f.schemeVersionId ? store.countSchemeFlags(f.questionId, f.schemeVersionId) : 0,
  ]);
  const hasSuggestion = f.suggestedTotal != null && f.criteriaJson != null;
  const ai = hasSuggestion
    ? L.presentEvaluation({ criteriaJson: f.criteriaJson, reviewFlags: f.reviewFlags, schemeCriteriaJson: f.schemeCriteriaJson, suggestedTotal: f.suggestedTotal, maxMarks: f.maxMarks })
    : null;
  const q = L.toPlainText(f.questionHtml);
  const a = L.toPlainText(f.answerHtml);
  const blockers = blockersOf(f);
  return {
    evaluation: {
      id: f.id, status: f.status, reviewState: f.reviewState, model: f.model, promptVersion: f.promptVersion,
      failureNote: f.status === "failed" ? "The AI could not mark this answer, so there is no suggestion. Mark it yourself; nothing was charged." : null,
    },
    assessment: { id: f.assessmentId, title: f.assessmentTitle, subject: f.subject },
    student: { name: f.studentName, admissionNo: f.admissionNo },
    question: { id: f.questionId, text: q.text, hasImage: q.hasImage, maxMarks: f.maxMarks },
    // Plain text, never HTML: a student's rich-text answer cannot run anything in the teacher's browser.
    answer: { text: a.text, hasImage: a.hasImage, note: a.hasImage ? "This answer contains an image the AI could not see. Check it in the full marking page." : null },
    ai: ai && {
      criteria: ai.criteria, missingPoints: ai.missingPoints, suggestedTotal: ai.suggestedTotal, suggestedIsWhole: ai.suggestedIsWhole, wholeOptions: ai.wholeOptions,
      flags: ai.flags.map((fl) => ({ code: fl.code, source: fl.source || null, text: L.FLAG_TEXT[fl.code] || null })),
    },
    scheme: { versionId: f.schemeVersionId, versionNo: f.schemeVersionNo ?? null, flaggedByPeople: flagCount },
    final: { teacherFinalMark: f.teacherFinalMark, reviewedByYou: f.teacherApprovedBy != null && Number(f.teacherApprovedBy) === Number(teacherId) },
    existingRemark: f.remarks || null,
    canApprove: blockers.length === 0,
    blockers,
    manualMarking: { assessmentId: f.assessmentId, submissionId: f.submissionId, questionId: f.questionId, answerId: f.answerId },
    history: history.map((h) => ({ id: h.id, action: h.action, finalMark: h.finalMark, reason: h.reason, by: Number(h.actorId) === Number(teacherId) ? "you" : (h.actorRole || "someone else"), at: h.createdAt })),
  };
}

/* ------------------------------ approve ------------------------------ */

async function approve(store, { teacherId, role, evaluationId, mode, criteriaMarks, finalMark, remark, reason }) {
  const f = await loadFacts(store, teacherId, evaluationId);
  const remarkText = L.cleanText(remark, { max: REMARK_MAX, field: "remark" });
  const reasonText = L.cleanText(reason, { max: REASON_MAX, field: "reason" });

  if (f.status !== "success" && f.status !== "needs_review") {
    throw new ReviewError(409, "NOT_REVIEWABLE", "There is no AI suggestion to approve for this answer. Mark it yourself.");
  }
  const ev = L.presentEvaluation({ criteriaJson: f.criteriaJson, reviewFlags: f.reviewFlags, schemeCriteriaJson: f.schemeCriteriaJson, suggestedTotal: f.suggestedTotal, maxMarks: f.maxMarks });
  const resolution = L.resolveApproval({ mode, criteriaMarks, finalMark }, ev);

  if (f.reviewState === "approved" || f.reviewState === "adjusted") {
    // A retry/double click of the same decision is a success that changes nothing; a DIFFERENT decision is refused.
    if (Number(f.teacherApprovedBy) === Number(teacherId) && Number(f.teacherFinalMark) === resolution.finalMark) {
      return { replayed: true, finalMark: resolution.finalMark, reviewState: f.reviewState };
    }
    throw conflictError("REVIEWED");
  }
  if (f.reviewState !== "awaiting_review") throw conflictError("REVIEWED");
  if (f.submissionStatus === "released") throw conflictError("RELEASED");
  if (f.marksAwarded != null) throw conflictError("ANSWER_MARKED");
  if (!f.currentHash || f.currentHash !== f.answerHash) throw conflictError("ANSWER_CHANGED");

  const state = resolution.changed ? "adjusted" : "approved";
  const action = resolution.changed ? "adjust" : "accept";
  const out = await store.applyApproval({
    evaluationId: f.id, teacherId, actorRole: role || null, finalMark: resolution.finalMark, state, action,
    remark: remarkText, reason: reasonText, answerId: f.answerId, submissionId: f.submissionId, expectedHash: f.answerHash,
    beforeJson: JSON.stringify({ suggestedTotal: ev.suggestedTotal, criteria: ev.criteria.map((c) => ({ criterionId: c.criterionId, ai: c.aiMarks })) }),
    afterJson: JSON.stringify({ finalMark: resolution.finalMark, criteria: resolution.criteriaFinal, roundedFromSuggestion: resolution.roundedFromSuggestion }),
  });
  if (out.outcome === "conflict") throw conflictError(out.reason);
  return {
    replayed: out.outcome === "replayed", finalMark: resolution.finalMark, reviewState: state, action,
    roundedFromSuggestion: resolution.roundedFromSuggestion, submission: out.submission || null,
  };
}

/**
 * Accept many suggestions at once — only ones the teacher explicitly selected, and only
 * those that need no judgement (clean "success", no flags, already a whole mark).
 * Each is applied individually through approve(), so every guard and log entry is identical
 * to accepting it one by one. One failure never stops the others.
 */
async function bulkAccept(store, { teacherId, role, evaluationIds }) {
  if (!Array.isArray(evaluationIds) || evaluationIds.length === 0) throw new ReviewError(400, "NO_SELECTION", "Select at least one suggestion");
  const ids = [...new Set(evaluationIds.map(toInt))];
  if (ids.some((x) => x == null)) throw new ReviewError(400, "BAD_ID", "Invalid evaluation id in the selection");
  if (ids.length > MAX_BULK) throw new ReviewError(400, "TOO_MANY", `Accept at most ${MAX_BULK} at a time`);

  const results = [];
  for (const id of ids) {
    try {
      const f = await loadFacts(store, teacherId, id);
      const flags = flagCodes(f.reviewFlags);
      if (f.status !== "success" || flags.length > 0 || f.suggestedTotal == null || !L.isWhole(f.suggestedTotal)) {
        results.push({ id, ok: false, code: "NEEDS_INDIVIDUAL_REVIEW" });
        continue;
      }
      const r = await approve(store, { teacherId, role, evaluationId: id, mode: "accept", reason: "Bulk accept" });
      results.push({ id, ok: true, finalMark: r.finalMark, replayed: !!r.replayed });
    } catch (err) {
      if (err instanceof ReviewError) results.push({ id, ok: false, code: err.code });
      else throw err;
    }
  }
  return { results, accepted: results.filter((r) => r.ok).length, notAccepted: results.filter((r) => !r.ok).length };
}

/* ------------------------------ decisions ------------------------------ */

async function decide(store, { teacherId, role, evaluationId, action, reason }) {
  const f = await loadFacts(store, teacherId, evaluationId);
  const reasonText = L.cleanText(reason, { max: REASON_MAX, field: "reason", required: L.REASON_REQUIRED.has(action) });

  if (action !== "flag_scheme") {
    if (f.status !== "success" && f.status !== "needs_review") {
      throw new ReviewError(409, "NOT_REVIEWABLE", "There is no AI suggestion for this answer. Mark it yourself.");
    }
    const target = action === "request_reevaluation" ? "superseded" : "rejected";
    if (f.reviewState === target) return { replayed: true, reviewState: target, ...nav(f, action) };
    const allowedFrom = action === "request_reevaluation" ? ["awaiting_review", "rejected"] : ["awaiting_review"];
    if (!allowedFrom.includes(f.reviewState)) throw conflictError("REVIEWED");
    if (action === "request_reevaluation") {
      if (f.submissionStatus === "released") throw conflictError("RELEASED");
      if (f.marksAwarded != null) throw conflictError("ANSWER_MARKED");
    }
  }
  const out = await store.applyDecision({ evaluationId: f.id, teacherId, actorRole: role || null, action, reason: reasonText });
  if (out.outcome === "conflict") throw conflictError(out.reason);
  const reviewState = action === "request_reevaluation" ? "superseded" : action === "flag_scheme" ? f.reviewState : "rejected";
  return { replayed: out.outcome === "replayed", reviewState, ...nav(f, action) };
}

function nav(f, action) {
  if (action === "mark_manually") return { manualMarking: { assessmentId: f.assessmentId, submissionId: f.submissionId, questionId: f.questionId, answerId: f.answerId } };
  if (action === "request_reevaluation") return { note: "The answer can now be selected for a new AI evaluation. That is a new job with its own quote and charge; the original charge is not refunded." };
  return {};
}

const reject = (store, a) => decide(store, { ...a, action: "reject" });
const markManually = (store, a) => decide(store, { ...a, action: "mark_manually" });
const requestReevaluation = (store, a) => decide(store, { ...a, action: "request_reevaluation" });
const flagScheme = (store, a) => decide(store, { ...a, action: "flag_scheme" });

module.exports = {
  listQueue, getDetail, approve, bulkAccept, reject, markManually, requestReevaluation, flagScheme,
  blockersOf, ReviewError, MAX_BULK, VIEWS,
};
