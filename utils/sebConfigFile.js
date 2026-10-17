/* =========================================================================
   .seb FILE FORMAT HELPERS
   ─────────────────────────────────────────────────────────
   A Safe Exam Browser settings file is:

        gzip(  "plnd"  +  gzip( <plist XML> )  )

   i.e. TWO gzip layers: the outer one wraps the whole file, the inner one
   wraps the plist that follows the 4-letter prefix ("plnd" = plain, not
   encrypted). Other prefixes: "pswd" / "pwcc" / "pnnn" = encrypted.

   BUG THIS FIXES: the old code wrote only the OUTER gzip (plist stored raw
   after "plnd"). SEB for macOS then inflated an empty inner block, got nil
   and passed it to +[NSPropertyListSerialization propertyListWithData:...],
   which raises an Objective-C exception -> abort() -> the app "crashes
   instantly" the moment the .seb file is opened.
========================================================================= */
const zlib = require("zlib");

const MAX_SEB_BYTES = 1024 * 1024; // 1 MB is far more than any real .seb file

const isGzip = (b) => b && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const startsWithXml = (b) => /^\s*<\?xml|^\s*<plist/i.test(b.slice(0, 64).toString("utf8"));

/** plist XML (string) -> a .seb file Buffer that SEB (macOS/Windows/iOS) can open. */
function buildSebFile(plistXml) {
  const inner = zlib.gzipSync(Buffer.from(plistXml, "utf8"), { mtime: 0 });
  return zlib.gzipSync(Buffer.concat([Buffer.from("plnd", "ascii"), inner]), { mtime: 0 });
}

/**
 * Checks an uploaded file really is a SEB settings file.
 * Returns { ok: true, kind, startURL? } or { ok: false, message }.
 *   kind: "plain"     – unencrypted (we can read the start URL)
 *         "encrypted" – password / certificate protected (SEB will ask for the password)
 */
function inspectSebFile(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, message: "The file is empty." };
  if (buf.length > MAX_SEB_BYTES) return { ok: false, message: "The file is too large to be a SEB configuration (limit 1 MB)." };
  try {
    let data = buf;
    if (isGzip(data)) data = zlib.gunzipSync(data);

    // A bare XML plist is accepted by SEB too.
    if (startsWithXml(data)) return { ok: true, kind: "plain", startURL: readStartUrl(data.toString("utf8")) };

    const prefix = data.slice(0, 4).toString("ascii");
    if (prefix === "plnd") {
      let body = data.slice(4);
      if (isGzip(body)) body = zlib.gunzipSync(body);
      if (!startsWithXml(body)) {
        return { ok: false, message: "This .seb file has no readable settings inside. Re-save it from the SEB Config Tool." };
      }
      return { ok: true, kind: "plain", startURL: readStartUrl(body.toString("utf8")) };
    }
    if (["pswd", "pwcc", "pnnn"].includes(prefix)) return { ok: true, kind: "encrypted" };
    return { ok: false, message: "This does not look like a Safe Exam Browser (.seb) file." };
  } catch (err) {
    return { ok: false, message: "This file could not be read as a Safe Exam Browser (.seb) file." };
  }
}

function readStartUrl(xml) {
  const m = /<key>startURL<\/key>\s*<string>([^<]*)<\/string>/i.exec(xml);
  return m ? m[1].trim() : "";
}

module.exports = { buildSebFile, inspectSebFile, MAX_SEB_BYTES };
