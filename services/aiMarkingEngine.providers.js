/* =========================================================================
   AI MARKING ENGINE — PROVIDER ADAPTERS (Phase 5)

   The engine talks to a provider only through this interface:

     provider.complete({ system, messages, maxOutputTokens, temperature, timeoutMs })
       -> { text, usage:{inputTokens,outputTokens}, model, requestId, truncated }
       throws ProviderError

   Adding another vendor = one function returning that shape. The API key
   lives only inside the adapter closure; it is never returned, logged or
   placed in an error message. Error messages are built from status codes
   and fixed text — a provider's error body is deliberately NOT copied,
   because it can echo request content (student answers).

   ProviderError.kind  retryable  systemic  Meaning
   TIMEOUT             yes        no        call exceeded timeoutMs
   NETWORK             yes        no        connection failed
   RATE_LIMITED        yes        no        429; retryAfterMs from Retry-After when sent
   OVERLOADED          yes        no        529 / provider capacity
   UNAVAILABLE         yes        no        5xx
   AUTH                no         YES       401/403 — every answer will fail until fixed
   BAD_REQUEST         no         YES       400/404/413/422 — model id wrong, request malformed
   INVALID_RESPONSE    no         no        2xx but unusable body
   `systemic` = retrying other answers is pointless: the worker should pause the job.

   Written against the Anthropic Messages API from knowledge of its public
   shape; it has NOT been run against the live service from here (no
   network). Test it with scripts/aiMarkingEngineDryRun.js before relying on it.
========================================================================= */

class ProviderError extends Error {
  constructor(kind, message, { retryable = false, systemic = false, retryAfterMs = null, status = null } = {}) {
    super(message);
    this.name = "ProviderError"; this.kind = kind; this.retryable = retryable; this.systemic = systemic;
    this.retryAfterMs = retryAfterMs; this.status = status;
  }
}

function classifyStatus(status, retryAfterMs) {
  if (status === 401 || status === 403) return new ProviderError("AUTH", `Provider rejected the credentials (HTTP ${status})`, { systemic: true, status });
  if (status === 408) return new ProviderError("TIMEOUT", "Provider timed out (HTTP 408)", { retryable: true, status });
  if (status === 429) return new ProviderError("RATE_LIMITED", "Provider rate limit reached (HTTP 429)", { retryable: true, retryAfterMs, status });
  if (status === 529) return new ProviderError("OVERLOADED", "Provider is overloaded (HTTP 529)", { retryable: true, retryAfterMs, status });
  if (status >= 500) return new ProviderError("UNAVAILABLE", `Provider error (HTTP ${status})`, { retryable: true, retryAfterMs, status });
  if (status === 400 || status === 404 || status === 413 || status === 422) return new ProviderError("BAD_REQUEST", `Provider refused the request (HTTP ${status}); check the model id and request size`, { systemic: true, status });
  return new ProviderError("BAD_REQUEST", `Unexpected provider response (HTTP ${status})`, { status });
}

function parseRetryAfter(headers) {
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(Math.round(secs * 1000), 300000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.min(Math.max(when - Date.now(), 0), 300000) : null;
}

function createAnthropicProvider({ apiKey, model, baseUrl = null, fetchImpl = globalThis.fetch, apiVersion = "2023-06-01" }) {
  if (!apiKey) throw new Error("createAnthropicProvider: apiKey is required");
  if (!model) throw new Error("createAnthropicProvider: model is required");
  if (typeof fetchImpl !== "function") throw new Error("createAnthropicProvider: no fetch implementation (Node 18+ required)");
  const url = `${(baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`;

  return {
    name: "anthropic", model,
    async complete({ system, messages, maxOutputTokens, temperature = 0, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": apiVersion },
          body: JSON.stringify({ model, max_tokens: maxOutputTokens, temperature, system, messages }),
          signal: controller.signal,
          // A redirect would forward the x-api-key header and the student text to whatever host answers.
          // (fetch drops only `Authorization` on cross-origin redirects, not custom headers.)
          redirect: "error",
        });
      } catch (e) {
        if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) throw new ProviderError("TIMEOUT", `Provider call exceeded ${timeoutMs} ms`, { retryable: true });
        throw new ProviderError("NETWORK", "Could not reach the provider", { retryable: true });
      } finally { clearTimeout(timer); }

      if (!res.ok) throw classifyStatus(res.status, parseRetryAfter(res.headers));

      let body;
      try { body = await res.json(); } catch { throw new ProviderError("INVALID_RESPONSE", "Provider returned a body that is not JSON"); }
      const text = Array.isArray(body?.content) ? body.content.filter((b) => b && b.type === "text").map((b) => b.text).join("") : null;
      if (typeof text !== "string" || !text.length) throw new ProviderError("INVALID_RESPONSE", "Provider reply contained no text");
      return {
        text,
        usage: { inputTokens: Number(body?.usage?.input_tokens) || 0, outputTokens: Number(body?.usage?.output_tokens) || 0 },
        model: body?.model || model, requestId: body?.id || null,
        truncated: body?.stop_reason === "max_tokens",
      };
    },
  };
}

/** Deterministic stand-in for development and tests. `script` is an array of replies/errors consumed in order. */
function createMockProvider({ model = "mock-model", script = [] } = {}) {
  const queue = [...script];
  const calls = [];
  return {
    name: "mock", model, calls,
    async complete(req) {
      calls.push(req);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next == null) throw new ProviderError("INVALID_RESPONSE", "mock provider script exhausted");
      const r = typeof next === "string" ? { text: next } : next;
      return { text: r.text, usage: r.usage || { inputTokens: 100, outputTokens: 50 }, model, requestId: "mock", truncated: !!r.truncated };
    },
  };
}

function createProvider(config, deps = {}) {
  if (!config.configured) throw new ProviderError("BAD_REQUEST", "AI marking provider is not configured", { systemic: true });
  if (config.provider === "anthropic") return createAnthropicProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, fetchImpl: deps.fetchImpl });
  if (config.provider === "mock") return createMockProvider({ model: config.model, script: deps.script });
  throw new ProviderError("BAD_REQUEST", `Unknown provider ${config.provider}`, { systemic: true });
}

module.exports = { ProviderError, createAnthropicProvider, createMockProvider, createProvider, classifyStatus, parseRetryAfter };
