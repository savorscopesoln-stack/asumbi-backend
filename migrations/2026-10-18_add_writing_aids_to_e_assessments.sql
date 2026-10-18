-- Per-paper switches for the essay box typing helps (both ON by default):
--   auto_capitalize: first letter of each sentence becomes a capital
--   auto_fullstop:   pressing Enter adds the full stop to an unfinished line
IF EXISTS (SELECT * FROM sysobjects WHERE name = 'e_assessments' AND xtype = 'U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'auto_capitalize' AND Object_ID = Object_ID(N'e_assessments'))
ALTER TABLE e_assessments ADD auto_capitalize BIT NOT NULL CONSTRAINT DF_e_assessments_auto_capitalize DEFAULT 1;

IF EXISTS (SELECT * FROM sysobjects WHERE name = 'e_assessments' AND xtype = 'U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'auto_fullstop' AND Object_ID = Object_ID(N'e_assessments'))
ALTER TABLE e_assessments ADD auto_fullstop BIT NOT NULL CONSTRAINT DF_e_assessments_auto_fullstop DEFAULT 1;
