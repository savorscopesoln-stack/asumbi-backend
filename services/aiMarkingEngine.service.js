const prompt = require("./aiMarkingEngine.prompt");
const { validateScheme, validateModelOutput, checkEvidence } = require("./aiMarkingEngine.validate");
const { ProviderError } = require("./aiMarkingEngine.providers");
const { computeCost } = require("./aiMarkingEngine.config");

/* =========================================================================
   AI MARKING ENGINE — evaluate ONE answer (Phase 5)

   Pure with respect to the database: no SQL, no wallet, no job state. The
   Phase 6 worker loads an item, calls evaluateAnswer(), and records the
   outcome with toEvaluationRow() / toFailureRow().

   WHAT THE RESULT MEANS
   { ok:true,  status:'success'|'needs_review', suggestedTotal, criteria[], reviewFlags[] ... }
       A validated PROVISIONAL suggestion. 'needs_review' = at least one
       review flag is set. Both are billable under the Phase 4 rule (D9).
   { ok:false, code, retryable, systemic, retryAfterMs, ... }
       No usable suggestion. The caller records 'failed' (never charged)
       and routes the answer to manual marking. There is NO path from a
       failure to a zero mark: suggestedTotal does not exist on failures.

   RETRY DIVISION OF LABOUR
   - This module re-asks the model only when its reply is unusable
     (malformed / failed validation), at most config.formatAttempts calls.
   - Availability problems (timeout, 429, 5xx, network) are returned
     immediately with retryable/retryAfterMs. Backoff, concurrency and rate
     limiting belong to the worker (Phase 6) so a slow provider cannot pin
     a worker slot inside this function.
   - Token usage and cost of EVERY call made, including rejected ones, are
     returned: rejected replies still cost money.

   FLAGS, NOT CONFIDENCE
   The model is never asked for a confidence score. Review flags come from
   (a) the model's own enumerated flags and (b) deterministic checks:
   unsupported or reused evidence, images the model cannot see, suspected
   prompt injection, and two length-vs-mark heuristics. The heuristics are
   uncalibrated; Phase 9 must test them against teacher-marked samples
   before anyone relies on their thresholds.
========================================================================= */

function parseModelJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!t.startsWith("{")) {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a === -1 || b <= a) return { error: "NOT_JSON" };
    t = t.slice(a, b + 1);
  }
  try { return { value: JSON.parse(t) }; } catch { return { error: "NOT_JSON" }; }
}

const round4 = (n) => (n == null ? null : Math.round(n * 1e4) / 1e4);

async function evaluateAnswer(input, { config, provider }) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const base = () => ({ usage: { ...usage }, cost: computeCost(usage, config), promptVersion: prompt.PROMPT_VERSION, model: provider?.model || config.model || null });
  const fail = (code, message, extra = {}) => ({
    ok: false, code, message, retryable: false, systemic: false, retryAfterMs: null, attempts: 0, ...extra, ...base(),
  });

  if (!config.configured || !provider) {
    return fail("ENGINE_NOT_CONFIGURED", `AI marking is not configured (${[...config.missing, ...config.errors].join("; ") || "no provider"})`, { systemic: true });
  }

  // ---- pre-flight: nothing here calls the provider, so nothing here costs money ----
  const q = prompt.htmlToText(input.questionText);
  const schemeErrors = validateScheme(input.criteria, input.maxMarks);
  if (schemeErrors.length || !q.text) {
    return fail("SCHEME_INVALID", `The question or marking scheme cannot be used: ${[...schemeErrors.map((e) => e.code), ...(q.text ? [] : ["QUESTION_EMPTY"])].join(", ")}`);
  }
  const a = prompt.htmlToText(input.answer);
  const redacted = prompt.redactPersonalData(a.text, input.redact || {});
  const textWithoutPlaceholder = redacted.replace(/\[image omitted\]/g, "").trim();
  if (!textWithoutPlaceholder) return fail(a.hasImage ? "ANSWER_IMAGE_ONLY" : "ANSWER_EMPTY", a.hasImage ? "The answer contains only an image the AI cannot read" : "The answer is blank");
  if (redacted.length > config.maxAnswerChars) return fail("ANSWER_TOO_LONG", `The answer is longer than the ${config.maxAnswerChars}-character limit; mark it manually`);

  const built = prompt.buildMarkingPrompt({
    questionText: q.text, maxMarks: input.maxMarks, criteria: input.criteria, answerText: redacted,
  });

  let messages = built.messages;
  let lastErrors = [];
  const attemptLog = [];
  let responseModel = null;

  for (let attempt = 1; attempt <= config.formatAttempts; attempt += 1) {
    let reply;
    try {
      reply = await provider.complete({
        system: built.system, messages, maxOutputTokens: config.maxOutputTokens, temperature: 0, timeoutMs: config.timeoutMs,
      });
    } catch (e) {
      if (e instanceof ProviderError) {
        return fail(`PROVIDER_${e.kind}`, e.message, { retryable: e.retryable, systemic: e.systemic, retryAfterMs: e.retryAfterMs, attempts: attempt, attemptLog });
      }
      return fail("PROVIDER_UNEXPECTED", `Unexpected error from the provider adapter (${e && e.name ? e.name : "Error"})`, { retryable: true, attempts: attempt, attemptLog });
    }
    usage.inputTokens += reply.usage.inputTokens; usage.outputTokens += reply.usage.outputTokens;
    responseModel = reply.model || responseModel;

    let errors = [];
    let outcome = null;
    if (reply.truncated) errors = [{ code: "TRUNCATED", path: "", message: "The reply was cut off; be more concise" }];
    else {
      const parsed = parseModelJson(reply.text);
      if (parsed.error) errors = [{ code: parsed.error, path: "", message: "Reply must be a single JSON object" }];
      else {
        outcome = validateModelOutput(parsed.value, { criteria: input.criteria, questionMax: input.maxMarks });
        if (!outcome.ok) errors = outcome.errors;
      }
    }
    attemptLog.push({ attempt, errorCodes: errors.map((e) => e.code) });

    if (errors.length === 0) {
      if (outcome.cannotEvaluate) {
        return { ...fail("CANNOT_EVALUATE", `The AI could not mark this answer reliably: ${outcome.reason}`, { attempts: attempt, attemptLog }), model: responseModel || provider.model };
      }
      return finalise(outcome.value, { input, redacted, plain: a.text, hasImage: a.hasImage, config, usage, attempt, attemptLog, model: responseModel || provider.model });
    }

    lastErrors = errors;
    if (attempt < config.formatAttempts) {
      const detail = errors.slice(0, 8).map((e) => `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("\n");
      messages = [
        ...built.messages,
        { role: "assistant", content: reply.text },
        { role: "user", content: `Your reply was rejected by the validator:\n${detail}\nReturn the corrected JSON object only. Quotes in "evidence" must be copied exactly from the student answer.` },
      ];
    }
  }
  return fail("INVALID_OUTPUT", `The AI reply failed validation after ${config.formatAttempts} attempt(s): ${lastErrors.slice(0, 5).map((e) => e.code).join(", ")}`,
    { retryable: false, attempts: config.formatAttempts, attemptLog, model: responseModel || provider.model });
}

function finalise(value, { input, redacted, plain, hasImage, config, usage, attempt, attemptLog, model }) {
  const flags = value.modelFlags.map((code) => ({ code, source: "model" }));
  flags.push(...checkEvidence(value.criteria, redacted));
  if (prompt.looksLikeInjection(plain)) flags.push({ code: "INJECTION_SUSPECTED", source: "engine" });
  if (hasImage) flags.push({ code: "IMAGE_IN_ANSWER", source: "engine", detail: "The answer contains an image the AI could not see" });
  const words = prompt.wordCount(redacted);
  const total = value.suggestedTotal;
  if (total === input.maxMarks && words < config.shortAnswerWords) flags.push({ code: "FULL_MARKS_SHORT_ANSWER", source: "engine", detail: `${words} words` });
  if (total === 0 && words >= config.longZeroWords) flags.push({ code: "ZERO_MARKS_SUBSTANTIAL_ANSWER", source: "engine", detail: `${words} words` });

  return {
    ok: true,
    status: flags.length ? "needs_review" : "success",
    suggestedTotal: total, maxMarks: input.maxMarks,
    criteria: value.criteria.map(({ allowEvidenceReuse, ...c }) => c),
    missingPoints: value.missingPoints,
    reviewFlags: flags,
    usage: { ...usage }, cost: computeCost(usage, config), attempts: attempt, attemptLog,
    model, promptVersion: prompt.PROMPT_VERSION,
  };
}

/* ------------------------------ mapping to ai_marking_evaluations ------------------------------ */

const tokenJson = (r, config) => JSON.stringify({
  inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, attempts: r.attempts,
  costExact: r.cost, costCurrency: config.costCurrency || null,
});

/** Columns to SET on a 'pending' evaluation (always `WHERE status='pending'`). */
function toEvaluationRow(result, config) {
  if (!result.ok) throw new Error("toEvaluationRow: result is a failure; use toFailureRow");
  return {
    status: result.status, model: result.model, prompt_version: result.promptVersion,
    criteria_json: JSON.stringify({ criteria: result.criteria, missingPoints: result.missingPoints }),
    suggested_total: result.suggestedTotal, review_flags: JSON.stringify(result.reviewFlags),
    token_usage_json: tokenJson(result, config), processing_cost: round4(result.cost), last_error: null,
  };
}

/** A failure is never a mark: suggested_total is explicitly NULL. */
function toFailureRow(result, config) {
  if (result.ok) throw new Error("toFailureRow: result is a success; use toEvaluationRow");
  return {
    status: "failed", model: result.model, prompt_version: result.promptVersion,
    criteria_json: null, suggested_total: null, review_flags: JSON.stringify([{ code: result.code, source: "engine" }]),
    token_usage_json: tokenJson(result, config), processing_cost: round4(result.cost),
    last_error: `${result.code}: ${result.message}`.slice(0, 1000),
  };
}

module.exports = { evaluateAnswer, toEvaluationRow, toFailureRow, parseModelJson };
