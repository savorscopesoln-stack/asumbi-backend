-- Suggested Remarks: admin pushes answers a teacher marked 0 back to that teacher.
-- Also applied automatically at startup by utils/ensureSchema.js. Safe to re-run.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'return_status' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD return_status NVARCHAR(12) NULL;   -- 'pending' -> 'done'
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'return_note' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD return_note NVARCHAR(500) NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'returned_at' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD returned_at DATETIME NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'returned_by' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD returned_by INT NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'returned_to' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD returned_to INT NULL;
