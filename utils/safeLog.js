/* =========================================================================
   SAFE ERROR DESCRIPTIONS FOR LOGS (Phase 11)

   Application logs are read by more people, and kept for longer, than the
   student answers they might accidentally contain. An Error can carry content:
     - SQL Server's "String or binary data would be truncated ... Truncated value: '...'"
       quotes the value that did not fit — often a student's text or a name;
     - library errors sometimes echo a request body or a header.
   So AI-marking code never logs an Error object, or err.message, directly. It logs
   describeError(err): the error's class, code and a message with quoted values,
   anything key-like and control characters removed, and a hard length cap.

   This is a safety net, not a licence to put student text in messages.
========================================================================= */

const MAX = 300;

function scrub(msg) {
  return String(msg)
    .replace(/Truncated value:\s*'[^]*?'(?=\.|$)/gi, "Truncated value: [omitted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [omitted]")
    .replace(/\b(sk|key|tok|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, "[key omitted]")
    .replace(/(x-api-key|api[_-]?key|authorization|password|pwd)\s*[:=]\s*\S+/gi, "$1=[omitted]")
    .replace(/'[^']{40,}'/g, "'[omitted]'")
    .replace(/"[^"]{40,}"/g, '"[omitted]"')
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "ErrorName CODE (#number): scrubbed message", at most MAX characters. Never throws. */
function describeError(err) {
  try {
    if (err == null) return "unknown error";
    if (typeof err !== "object") return scrub(err).slice(0, MAX);
    const parts = [err.name || "Error"];
    if (err.code) parts.push(String(err.code));
    if (err.number) parts.push(`(#${err.number})`);
    const head = parts.join(" ");
    const msg = err.message ? `: ${scrub(err.message)}` : "";
    return `${head}${msg}`.slice(0, MAX);
  } catch {
    return "unprintable error";
  }
}

module.exports = { describeError, scrub, MAX };
