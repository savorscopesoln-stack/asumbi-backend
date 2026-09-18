const sql = require("mssql");

/* =========================================================
   EXAM AUDIT LOG
   Central place every Main Examination controller/scheduler action
   writes a factual event row from — see ensureSchema.js's
   exam_audit_log table and spec §53 ("Auditability").

   Never throws — logging an action failing should never break the
   action itself (an exam should still get created/activated/ended
   even if this insert has a problem), matching utils/notify.js's
   pattern for the same reason.
========================================================= */
async function logExamAudit(pool, {
  mainExaminationId = null,
  examSubjectSessionId = null,
  action,
  actorId = null,
  actorRole = null,
  details = null,
}) {
  try {
    await pool.request()
      .input("mainExaminationId", sql.Int, mainExaminationId)
      .input("examSubjectSessionId", sql.Int, examSubjectSessionId)
      .input("action", sql.NVarChar, action)
      .input("actorId", sql.Int, actorId)
      .input("actorRole", sql.NVarChar, actorRole)
      .input("details", sql.NVarChar, details ? JSON.stringify(details) : null)
      .query(`
        INSERT INTO exam_audit_log
          (main_examination_id, exam_subject_session_id, action, actor_id, actor_role, details)
        VALUES
          (@mainExaminationId, @examSubjectSessionId, @action, @actorId, @actorRole, @details)
      `);
  } catch (err) {
    console.error("⚠️ exam audit log write failed:", err.message);
  }
}

module.exports = { logExamAudit };
