-- Admin-editable subject code + key wording for Main Examination reports.
-- Idempotent; ensureSchema.js applies the same change on boot.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'report_code' AND Object_ID = Object_ID(N'exam_subject_sessions'))
  ALTER TABLE exam_subject_sessions ADD report_code NVARCHAR(20) NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'report_key' AND Object_ID = Object_ID(N'exam_subject_sessions'))
  ALTER TABLE exam_subject_sessions ADD report_key NVARCHAR(150) NULL;
