const crypto = require("crypto");

/* =========================================================================
   CREDIT / PAYMENT REFERENCE GENERATOR

   Same alphabet/shape convention as controllers/mainExam.controller.js's
   EXAM_CODE_ALPHABET + randomExamCode() (upper-case, no ambiguous
   0/O/1/I/L characters — these get read aloud over the phone and typed
   into WhatsApp/email by non-technical finance/admin staff, so keeping
   the exact same alphabet the app already uses elsewhere avoids two
   different "which characters are allowed" conventions in one product).

   A prefix distinguishes what kind of reference this is at a glance in
   UI/receipts/logs: "CR-" for a credit_issuances.issuance_reference,
   "PAY-" for an institution_payments.payment_reference when the
   institution didn't supply their own bank/M-Pesa code.
========================================================================= */
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomReferenceSuffix(length = 10) {
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += REFERENCE_ALPHABET[bytes[i] % REFERENCE_ALPHABET.length];
  return out;
}

/**
 * Generate a reference guaranteed unique against `table.column`, retrying
 * a handful of times on the (astronomically unlikely) collision — same
 * retry-loop shape as generateExamCode in mainExam.controller.js, kept
 * here so both credit_issuances and institution_payments can share one
 * implementation instead of two near-identical copies.
 *
 * @param {import('mssql').ConnectionPool} pool  tenant-scoped pool (req.pool)
 * @param {string} table   table to check uniqueness against
 * @param {string} column  column to check uniqueness against
 * @param {string} prefix  short human-readable prefix, e.g. "CR", "PAY"
 * @returns {Promise<string>} a reference like "CR-7K4Q9XZP2M"
 */
async function generateUniqueReference(pool, table, column, prefix) {
  const sql = require("mssql");
  // Table/column names are always one of our own fixed literals below,
  // never user input — interpolated safely for that reason (parameterized
  // identifiers aren't supported by mssql template queries).
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${prefix}-${randomReferenceSuffix(10)}`;
    const clash = await pool.request()
      .input("candidate", sql.NVarChar(80), candidate)
      .query(`SELECT 1 FROM ${table} WHERE ${column} = @candidate`);
    if (!clash.recordset.length) return candidate;
  }
  throw new Error(`Could not generate a unique ${prefix} reference — please try again`);
}

module.exports = { generateUniqueReference, randomReferenceSuffix, REFERENCE_ALPHABET };
