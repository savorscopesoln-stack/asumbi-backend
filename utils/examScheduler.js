const sql = require("mssql");
const { logExamAudit } = require("./examAuditLog");
const { notifyUsers } = require("./notify");

/* =========================================================================
   EXAM SUBJECT SESSION SCHEDULER (§7-§9, §37-§38)
   Polls exam_subject_sessions once a minute, same TICK_MS/setInterval/
   multi-tenant shape as notificationScheduler.js — deliberately not a
   second scheduling mechanism, just another tick function using the
   exact same pattern already proven in this codebase.

   SCHEDULED → ACTIVE happens when start_time arrives; ACTIVE → ENDED
   happens when end_time arrives. The admin never has to click
   "Approve" for a Main Examination subject (§7) — this is what makes
   that automatic. WAITING/MARKING/COMPLETED are the rest of the
   lifecycle (§7) but aren't time-driven, so they aren't touched here:
   WAITING is just how a 'scheduled' row not yet due is displayed;
   MARKING/COMPLETED follow from the existing marking workflow in a
   later phase.

   §8 SECURITY RULE: this — server time vs. the stored start_time/
   end_time — is the ONLY thing that ever flips a session's status.
   Nothing here trusts anything the frontend sent.

   IDEMPOTENT (§38): every UPDATE's WHERE clause only matches rows still
   in the prior state, so running the tick twice (or every tick, forever)
   never re-activates/re-ends the same row or writes a duplicate audit
   row — a row only matches once, on the tick where its state actually
   changes.
========================================================================= */
const TICK_MS = 60 * 1000;

/* -------------------------------------------------------------------------
   TIMEZONE — this is what was actually causing "subjects don't go active
   at the set time".

   The dashboard's Start/End Time fields are explicitly labelled "(EAT)"
   (see MainExaminationDashboard.jsx) and every stored start_time/end_time
   is the East Africa Time wall-clock digits the admin typed, saved as a
   "labelled UTC" instant on purpose (see toDateTime() in
   examSubjectSession.controller.js and HANDOFF_NOTES_EXAMCODE_AND_
   TIMEZONE_FIX.md) — the point being: whatever number the admin typed is
   the number that comes back, everywhere in the app, regardless of what
   timezone the server or the viewer's browser happens to be in.

   This file was the one place that broke that rule: it compared those
   "labelled EAT" columns straight against SQL Server's own GETDATE(),
   which carries no such label — it's just whatever real-world instant
   the SQL Server *process's own clock* says right now, in whatever
   timezone that machine happens to be set to. Azure SQL Database's
   GETDATE() in particular is always UTC, no matter where the resource is
   hosted. So a subject with start_time "09:00" (meaning 9am EAT) never
   satisfied `start_time <= GETDATE()` until the server's clock itself
   reached "09:00" — which, on a UTC server, is 12:00 EAT: three hours
   late. On a different server clock it'd be off by some other amount.
   Either way, the DB server's own timezone was silently deciding when
   exams opened, not the time the admin actually typed.

   Fix: never ask the database "what time is it" for this comparison.
   Compute "right now, relabelled as EAT wall-clock digits" here in Node
   from Date.now() (a real, timezone-agnostic instant) and pass it in as
   a parameter, in the exact same "labelled UTC" shape start_time/end_time
   are already stored in — so the WHERE clause is always comparing two
   values on the same clock, independent of whatever timezone the
   database server process itself happens to be running in.
------------------------------------------------------------------------- */
const EAT_OFFSET_MINUTES = 3 * 60; // East Africa Time is UTC+3, no DST
function nowAsSchoolWallClock() {
  return new Date(Date.now() + EAT_OFFSET_MINUTES * 60 * 1000);
}

async function activateDueSessions(pool, tenantKey, io) {
  const now = nowAsSchoolWallClock();
  // Pulls in the linked assessment's approval status/audience in the same
  // query — §8's security rule means this decision has to be made here,
  // server-side, at activation time, not trusted from whatever attach/
  // publish already checked earlier (an assessment can't currently be
  // un-approved after publish, but this stays correct even if that ever
  // changes).
  const due = await pool.request()
    .input("now", sql.DateTime, now)
    .query(`
    SELECT ess.id, ess.main_examination_id, ess.subject,
           ea.id AS e_assessment_id, ea.status AS assessment_status,
           ea.title AS assessment_title, ea.class_id, ea.year_of_study
    FROM exam_subject_sessions ess
    LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
    WHERE ess.status = 'scheduled'
      AND ess.start_time IS NOT NULL AND ess.start_time <= @now
      AND (ess.end_time IS NULL OR ess.end_time > @now)
  `);

  for (const row of due.recordset || []) {
    try {
      if (!row.e_assessment_id || row.assessment_status !== "approved") {
        // Left as 'scheduled' on purpose — publishTimetable should have
        // prevented this, but if it ever happens the session just waits
        // (and gets re-checked every tick) instead of silently opening
        // an unapproved exam to students.
        console.warn(`⚠️ Subject session #${row.id} (${row.subject}) is due but its assessment isn't approved — holding, not activating (tenant "${tenantKey}")`);
        continue;
      }

      // WHERE status = 'scheduled' here (not just id = @id) keeps this
      // idempotent even against a rare concurrent tick — only the tick
      // that actually flips the row's status performs the follow-up work.
      const updated = await pool.request()
        .input("id", sql.Int, row.id)
        .input("now", sql.DateTime, now)
        .query(`
          UPDATE exam_subject_sessions
          SET status = 'active', activated_at = @now, updatedAt = @now
          OUTPUT INSERTED.id
          WHERE id = @id AND status = 'scheduled'
        `);
      if (!updated.recordset[0]) continue;

      await pool.request()
        .input("id", sql.Int, row.e_assessment_id)
        .query(`UPDATE e_assessments SET active_status = 'Active' WHERE id = @id`);

      // Same "exam is now open" notification the existing manual
      // Start/Stop toggle sends (toggleEAssessmentActive in
      // eAssessment.controller.js) — a student shouldn't get a
      // different experience just because a Main Examination schedule
      // opened the exam instead of an admin's click (§45).
      if (row.class_id || row.year_of_study) {
        const students = row.year_of_study
          ? await pool.request().input("year", sql.Int, row.year_of_study)
              .query(`SELECT id FROM Students WHERE yearOfStudy = @year`)
          : await pool.request().input("classId", sql.Int, row.class_id)
              .query(`
                SELECT st.id
                FROM Students st
                JOIN Classes c ON c.id = @classId
                WHERE st.studentClass = c.name
              `);
        await notifyUsers(
          pool,
          (students.recordset || []).map((s) => ({ id: s.id, source: "Students" })),
          {
            title: "Examination Now Open",
            message: `"${row.assessment_title}" is now open — you can take it from your E-Assessments page.`,
            type: "exam",
          }
        );
      }

      await logExamAudit(pool, {
        mainExaminationId: row.main_examination_id,
        examSubjectSessionId: row.id,
        action: "subject_session_auto_activated",
        details: { subject: row.subject },
      });

      if (io) {
        io.emit("main-exam:subject-activated", {
          mainExaminationId: row.main_examination_id,
          subjectSessionId: row.id,
          subject: row.subject,
          tenant: tenantKey,
        });
      }

      console.log(`🟢 Subject session #${row.id} (${row.subject}) auto-activated (tenant "${tenantKey}")`);
    } catch (err) {
      console.error(`⚠️ Auto-activation follow-up failed for session #${row.id} (tenant "${tenantKey}"):`, err.message);
    }
  }
}

async function endDueSessions(pool, tenantKey, io) {
  const now = nowAsSchoolWallClock();
  const result = await pool.request()
    .input("now", sql.DateTime, now)
    .query(`
    UPDATE exam_subject_sessions
    SET status = 'ended', ended_at = @now, updatedAt = @now
    OUTPUT INSERTED.id, INSERTED.main_examination_id, INSERTED.subject, INSERTED.e_assessment_id
    WHERE status = 'active'
      AND end_time IS NOT NULL AND end_time <= @now
  `);

  for (const row of result.recordset || []) {
    try {
      // Deactivates the linked assessment so no NEW attempt can start
      // (§9 — "students must no longer be allowed to begin the
      // examination"). Students already mid-attempt are governed
      // entirely by the EXISTING exam-session/heartbeat/auto-submit
      // logic in eAssessment.controller.js, which this never touches —
      // an in-progress e_assessment_exam_sessions row still finishes
      // out its own timer/auto-submit exactly as it does today.
      if (row.e_assessment_id) {
        await pool.request()
          .input("id", sql.Int, row.e_assessment_id)
          .query(`UPDATE e_assessments SET active_status = 'Inactive' WHERE id = @id`);
      }

      await logExamAudit(pool, {
        mainExaminationId: row.main_examination_id,
        examSubjectSessionId: row.id,
        action: "subject_session_auto_ended",
        details: { subject: row.subject },
      });

      if (io) {
        io.emit("main-exam:subject-ended", {
          mainExaminationId: row.main_examination_id,
          subjectSessionId: row.id,
          subject: row.subject,
          tenant: tenantKey,
        });
      }

      console.log(`🔴 Subject session #${row.id} (${row.subject}) auto-ended (tenant "${tenantKey}")`);
    } catch (err) {
      console.error(`⚠️ Auto-end follow-up failed for session #${row.id} (tenant "${tenantKey}"):`, err.message);
    }
  }
}

const startExamScheduler = (getPool, listTenantKeys, io) => {
  const tick = async () => {
    for (const tenantKey of listTenantKeys()) {
      try {
        const pool = await getPool(tenantKey);
        await activateDueSessions(pool, tenantKey, io);
        await endDueSessions(pool, tenantKey, io);
      } catch (err) {
        // Same reasoning as notificationScheduler.js: one tenant's DB
        // being briefly unreachable (e.g. a serverless DB waking up)
        // just retries next tick instead of crashing the process or
        // blocking every other tenant's check.
        console.error(`⚠️ Exam scheduler tick skipped (tenant "${tenantKey}"):`, err.message);
      }
    }
  };

  setInterval(tick, TICK_MS);
  // Also run shortly after boot, so a session whose start/end time
  // passed while the server was down (or is due within the first
  // minute) is caught promptly rather than waiting a full TICK_MS.
  setTimeout(tick, 5000);
};

module.exports = { startExamScheduler };
