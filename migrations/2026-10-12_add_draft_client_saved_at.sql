-- Exam answers are now cached on the student's device and synced to the server
-- every 30 seconds. client_saved_at holds the device-side timestamp (ms since
-- epoch) of the answers in each sync so an out-of-order/retried request can
-- never overwrite newer answers. (Also applied automatically by ensureSchema.)
IF EXISTS (SELECT * FROM sysobjects WHERE name = 'e_assessment_drafts' AND xtype = 'U')
AND NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'client_saved_at' AND Object_ID = Object_ID(N'e_assessment_drafts')
)
  ALTER TABLE e_assessment_drafts ADD client_saved_at BIGINT NULL;
