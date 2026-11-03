/* =========================================================================
   LMS HTML SANITISER  (L3.1)
   Lesson text is rich HTML written by teachers and shown to students, so it is
   rebuilt from an ALLOW-LIST on every save (never trusted on read). Anything not
   on the list is dropped; text is re-escaped; links are limited to http(s),
   mailto and tel. There is no script, style, iframe, form, image, event
   attribute or inline CSS. Images/video/audio/files are separate lesson BLOCKS
   with their own validated URL, not HTML.
   Written without a library on purpose (the build sandbox has no network);
   it is a small tokenizer, not a regex replace, so nesting is rebuilt too.
========================================================================= */
const MAX_HTML = 200000;

const VOID = new Set(["br", "hr"]);
const ALLOWED = new Set(["p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "code", "pre", "a", "table", "thead", "tbody", "tr", "th", "td"]);
const RENAME = { h1: "h2", h5: "h4", h6: "h4" };
/* Contents are dropped together with the tag. */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "textarea", "select", "head", "title", "link", "meta", "form", "button", "applet", "frame", "frameset", "noframes", "xmp", "plaintext"]);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const escText = (s) => s.replace(/&(?!(?:[a-zA-Z]{2,8}|#\d{1,6}|#x[0-9a-fA-F]{1,5});)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const unAmp = (s) => s.replace(/&amp;/gi, "&");

function safeHref(raw) {
  const v = unAmp(String(raw ?? "")).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, "");
  if (!v || v.length > 2000) return null;
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+0-9().-]+)$/i.test(v) ? v : null;
}
const smallInt = (raw) => { const n = Number(String(raw ?? "").trim()); return Number.isInteger(n) && n >= 1 && n <= 50 ? n : null; };

function parseAttrs(src) {
  const out = {}; let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(src))) { const name = m[1].toLowerCase(); if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? ""; }
  return out;
}

function openTag(tag, attrs) {
  if (tag === "a") {
    const href = safeHref(attrs.href);
    return href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">` : "<a>";
  }
  if (tag === "th" || tag === "td") {
    let a = ""; const cs = smallInt(attrs.colspan), rs = smallInt(attrs.rowspan);
    if (cs) a += ` colspan="${cs}"`; if (rs) a += ` rowspan="${rs}"`;
    return `<${tag}${a}>`;
  }
  return VOID.has(tag) ? `<${tag}>` : `<${tag}>`;
}

function sanitizeHtml(input) {
  const src = String(input ?? "").replace(/\u0000/g, "").slice(0, MAX_HTML);
  let out = "", i = 0; const stack = []; let skip = null; // skip = tag name whose content is being dropped
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { if (!skip) out += escText(src.slice(i)); break; }
    if (lt > i && !skip) out += escText(src.slice(i, lt));
    const m = TAG_RE.exec(src.slice(lt, lt + 4000));
    if (!m) { // not a well-formed tag: comments, CDATA, doctype, broken markup -> harmless text
      if (src.startsWith("<!--", lt)) { const end = src.indexOf("-->", lt + 4); i = end === -1 ? src.length : end + 3; continue; }
      if (!skip) out += "&lt;"; i = lt + 1; continue;
    }
    i = lt + m[0].length;
    let tag = m[2].toLowerCase(); const closing = m[1] === "/";
    if (skip) { if (closing && tag === skip) skip = null; continue; }
    if (DROP_WITH_CONTENT.has(tag)) { if (!closing && !m[4]) skip = tag; continue; }
    tag = RENAME[tag] || tag;
    if (!ALLOWED.has(tag)) continue; // unknown tag: drop the tag, keep its text
    if (closing) {
      if (VOID.has(tag)) continue;
      const at = stack.lastIndexOf(tag); if (at === -1) continue; // unmatched closer
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    out += openTag(tag, parseAttrs(m[3] || ""));
    if (!VOID.has(tag)) stack.push(tag);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/* Plain text for previews/search. Never use this output as HTML. */
function htmlToText(html) {
  return sanitizeHtml(html).replace(/<\/(p|li|h2|h3|h4|blockquote|tr|pre)>|<br>|<hr>/g, " ").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

module.exports = { sanitizeHtml, htmlToText, safeHref, MAX_HTML };
