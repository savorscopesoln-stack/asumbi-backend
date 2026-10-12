-- Admin "Desktop only" switch: when 1, only Windows/macOS laptops & desktops
-- may take the assessment (phones/tablets rejected). Also created
-- automatically at startup by utils/ensureSchema.js — this file is for
-- running it by hand against a database.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'desktop_only' AND Object_ID = Object_ID(N'e_assessments')
)
ALTER TABLE e_assessments ADD desktop_only BIT NOT NULL CONSTRAINT DF_e_assessments_desktop_only DEFAULT 0;
