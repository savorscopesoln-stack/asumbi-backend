-- Combine two subjects into one on the Main Examination reports.
-- report_combine_with = session id of the main subject this subject is merged into (NULL = not combined).
-- Idempotent; ensureSchema.js applies the same change on boot.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'report_combine_with' AND Object_ID = Object_ID(N'exam_subject_sessions'))
  ALTER TABLE exam_subject_sessions ADD report_combine_with INT NULL;
