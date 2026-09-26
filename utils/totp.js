const crypto = require("crypto");

/* =========================================================================
   TOTP — Time-based One-Time Password (RFC 6238, built on RFC 4226 HOTP)

   Written against Node's built-in `crypto` module only. This repo's
   package.json has no TOTP/2FA library today (checked — no otplib,
   speakeasy, etc.), and this sandbox has no network access to add one,
   so rather than block Finance's MFA requirement on a dependency I
   can't even install to verify, this implements the ~40 lines of
   actual RFC math directly. It's a standard, compact algorithm — any
   authenticator app (Google Authenticator, Authy, 1Password, etc.)
   will generate matching 6-digit codes for a secret produced by
   generateSecret() below, with no proprietary format involved.

   Secrets are stored as Base32 text in Users.mfaSecret (added by
   ensureSchema.js in Phase 2) — Base32 is the standard encoding
   authenticator apps expect when a person types a secret in manually
   (this repo has no QR-code library either, so enrollment shows the
   Base32 secret as text — see finance.controller.js's enrollMfa).
========================================================================= */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(base32) {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Generate a new random Base32 secret (20 bytes / 160 bits — the RFC 4226 recommended minimum). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** RFC 4226 HOTP for a given counter. */
function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; Node's bitwise ops are
  // 32-bit, so it's written as two 32-bit halves.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter % 2 ** 32, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 TOTP for the current time (or a given epoch-seconds timestamp). */
function totp(secretBase32, { stepSeconds = 30, digits = 6, timestampSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const counter = Math.floor(timestampSeconds / stepSeconds);
  return hotp(secretBase32, counter, digits);
}

/**
 * Verify a user-entered code, tolerating clock drift by checking one
 * step before/after the current one (a ±30s window is the standard
 * TOTP allowance most authenticator apps and RFC 6238 implementations
 * use, and matches what a person typing a code by hand needs).
 */
function verifyToken(secretBase32, token, { stepSeconds = 30, digits = 6, window = 1 } = {}) {
  if (!token || !/^\d{6,8}$/.test(String(token).trim())) return false;
  const clean = String(token).trim();
  const now = Math.floor(Date.now() / 1000);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = totp(secretBase32, { stepSeconds, digits, timestampSeconds: now + errorWindow * stepSeconds });
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean.padStart(digits, "0")))) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI for authenticator apps that support scanning/pasting a URI (still no QR rendering here — see the enrollment endpoint's comment). */
function otpauthUri(secretBase32, { accountName, issuer = "Doravo Finance" }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, totp, verifyToken, otpauthUri, base32Encode, base32Decode };
