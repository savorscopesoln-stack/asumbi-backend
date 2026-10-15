/* =========================================================================
   E-ASSESSMENT CLOCK

   The exam clock is anchored to when the PAPER started, not to when each
   student happened to log in. If a 2-hour paper starts at 1:00 and a student
   signs in at 1:30, they have 1h30m left, not a fresh 2 hours.

   e_assessments.started_at  = real timestamp (same clock as GETDATE()) of the
   moment the paper opened: manual Start, scheduled open (available_from), or a
   Main Examination subject session going live.

   Per-student clock start (SQL fragment below):
     - normal attempt  -> the paper's started_at (if the student entered after
       it; a session older than started_at belongs to an earlier run and keeps
       its own activated_at)
     - resit attempt (attempt_no > 1) -> the student's own activated_at, since
       a resit is granted after the paper is over and gets the full duration
     - legacy papers with no started_at -> activated_at (previous behaviour)
========================================================================= */

// `a` = alias of e_assessments, `es` = alias of e_assessment_exam_sessions.
const clockStartSql = (a = "a", es = "es") => `
  (CASE WHEN ISNULL(${es}.attempt_no, 1) <= 1
         AND ${a}.started_at IS NOT NULL
         AND ${a}.started_at < ${es}.activated_at
        THEN ${a}.started_at ELSE ${es}.activated_at END)`;

// Seconds left (can be negative) for a session row, on the DB clock.
const secondsLeftSql = (a = "a", es = "es") =>
  `DATEDIFF(SECOND, GETDATE(), DATEADD(MINUTE, ISNULL(${a}.duration_minutes, 30), ${clockStartSql(a, es)}))`;

module.exports = { clockStartSql, secondsLeftSql };
