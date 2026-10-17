-- Per-assessment SEB quit password. Also created automatically by utils/ensureSchema.js.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'seb_quit_password' AND Object_ID = Object_ID(N'e_assessments'))
ALTER TABLE e_assessments ADD seb_quit_password NVARCHAR(100) NULL;
