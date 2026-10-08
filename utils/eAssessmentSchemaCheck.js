/* =========================================================================
   E-ASSESSMENT CORE SCHEMA CHECK

   e_assessments, e_assessment_questions, e_assessment_submissions,
   e_assessment_answers and e_assessment_submission_assignments have NO
   CREATE TABLE in this repo's tracked migrations (audit §2) — they exist
   only in the live databases. The AI-marking tables reference their ids
   without foreign keys because of that. This module turns "we assume" into
   "we checked": it compares a live database's INFORMATION_SCHEMA against
   the columns the application code demonstrably reads/writes today.

   EXPECTED below was derived by reading eAssessment.controller.js (every
   column it SELECTs/INSERTs/UPDATEs on these tables), not guessed. `types`
   lists the acceptable DATA_TYPEs; a mismatch on a column the AI feature
   depends on is reported as an ERROR, a missing non-critical one as a WARN.

   Run against a real database:  node scripts/verifyEAssessmentSchema.js [tenantKey]
========================================================================= */

const INT = ["int"];
const TEXT = ["nvarchar", "varchar", "ntext", "text"];

const EXPECTED = {
  e_assessments: {
    id: { types: INT, critical: true },
    title: { types: TEXT },
    subject: { types: TEXT, critical: true },
    total_marks: { types: [...INT, "decimal", "numeric", "float"] },
  },
  e_assessment_questions: {
    id: { types: INT, critical: true },
    e_assessment_id: { types: INT, critical: true },
    question_text: { types: TEXT, critical: true },
    question_type: { types: TEXT, critical: true },
    marks: { types: [...INT, "decimal", "numeric", "float"], critical: true },
    marking_guide: { types: TEXT, critical: true },
  },
  e_assessment_submissions: {
    id: { types: INT, critical: true },
    e_assessment_id: { types: INT, critical: true },
    student_id: { types: INT, critical: true },
    score: { types: [...INT, "decimal", "numeric", "float"] },
    status: { types: TEXT, critical: true },
    released_at: { types: ["datetime", "datetime2"] },
    remark_status: { types: TEXT },
  },
  e_assessment_answers: {
    id: { types: INT, critical: true },
    submission_id: { types: INT, critical: true },
    question_id: { types: INT, critical: true },
    essay_answer: { types: TEXT, critical: true },
    // The authoritative final mark. Decision D1 in the audit depends on this being an integer type.
    marks_awarded: { types: [...INT, "decimal", "numeric", "float"], critical: true },
    remarks: { types: TEXT },
    highlights: { types: TEXT },
    highlighted_html: { types: TEXT },
  },
  e_assessment_submission_assignments: {
    submission_id: { types: INT, critical: true },
    teacher_id: { types: INT, critical: true },
  },
};

/**
 * @param {Array<{TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE}>} actualRows INFORMATION_SCHEMA.COLUMNS rows
 * @returns {{ok:boolean, errors:string[], warnings:string[], marksAwardedType:string|null}}
 */
function compareSchema(actualRows) {
  const byTable = {};
  for (const r of actualRows) {
    const t = String(r.TABLE_NAME).toLowerCase();
    (byTable[t] ||= {})[String(r.COLUMN_NAME).toLowerCase()] = String(r.DATA_TYPE).toLowerCase();
  }
  const errors = [];
  const warnings = [];
  for (const [table, cols] of Object.entries(EXPECTED)) {
    if (!byTable[table]) { errors.push(`table ${table} does not exist`); continue; }
    for (const [col, spec] of Object.entries(cols)) {
      const actual = byTable[table][col];
      if (!actual) { (spec.critical ? errors : warnings).push(`${table}.${col} is missing`); continue; }
      if (!spec.types.includes(actual)) {
        (spec.critical ? errors : warnings).push(`${table}.${col} is ${actual}, expected one of ${spec.types.join("/")}`);
      }
    }
  }
  const marksAwardedType = byTable.e_assessment_answers?.marks_awarded || null;
  if (marksAwardedType && !INT.includes(marksAwardedType)) {
    warnings.push(`e_assessment_answers.marks_awarded is ${marksAwardedType}, not int — Decision D1 (whole-number final marks) may be revisitable`);
  }
  return { ok: errors.length === 0, errors, warnings, marksAwardedType };
}

async function loadActualColumns(pool) {
  const tables = Object.keys(EXPECTED).map((t) => `'${t}'`).join(",");
  const result = await pool.request().query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${tables})
  `);
  return result.recordset;
}

module.exports = { EXPECTED, compareSchema, loadActualColumns };
