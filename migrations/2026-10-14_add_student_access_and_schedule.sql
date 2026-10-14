-- Per-assessment "who can sit" list + open/close window.
-- Also created automatically at startup by utils/ensureSchema.js - this file
-- is for running it by hand against a database.
--   restrict_students = 0 (default): every ACTIVE student in the class/year may sit.
--   restrict_students = 1: only students listed in e_assessment_allowed_students.
--   available_from / available_until: East Africa Time wall-clock digits (nullable).
--   schedule_opened_at / schedule_closed_at: scheduler markers (reset on edit).
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'restrict_students' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD restrict_students BIT NOT NULL CONSTRAINT DF_e_assessments_restrict_students DEFAULT 0;
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'available_from' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD available_from DATETIME NULL;
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'available_until' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD available_until DATETIME NULL;
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'schedule_opened_at' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD schedule_opened_at DATETIME NULL;
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'schedule_closed_at' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD schedule_closed_at DATETIME NULL;
GO
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_allowed_students' AND xtype='U')
CREATE TABLE e_assessment_allowed_students (
  id INT IDENTITY(1,1) PRIMARY KEY,
  e_assessment_id INT NOT NULL,
  student_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT GETDATE());
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'UX_ea_allowed_students' AND object_id = Object_ID(N'e_assessment_allowed_students'))
CREATE UNIQUE INDEX UX_ea_allowed_students ON e_assessment_allowed_students (e_assessment_id, student_id);
