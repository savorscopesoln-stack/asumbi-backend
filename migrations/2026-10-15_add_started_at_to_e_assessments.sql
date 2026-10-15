-- Exam clock is anchored to when the PAPER started (not when each student
-- logs in). started_at is stamped on manual Start, scheduled open, and Main
-- Examination subject-session activation. Also created automatically at
-- startup by utils/ensureSchema.js.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'started_at' AND Object_ID = Object_ID(N'e_assessments')
)
ALTER TABLE e_assessments ADD started_at DATETIME NULL;
