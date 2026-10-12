-- "Require Safe Exam Browser" switch + allowed SEB keys. Also created
-- automatically at startup by utils/ensureSchema.js.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'require_seb' AND Object_ID = Object_ID(N'e_assessments'))
ALTER TABLE e_assessments ADD require_seb BIT NOT NULL CONSTRAINT DF_e_assessments_require_seb DEFAULT 0;

IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'seb_keys' AND Object_ID = Object_ID(N'e_assessments'))
ALTER TABLE e_assessments ADD seb_keys NVARCHAR(MAX) NULL;
