-- Marking deadline per e-assessment (also created automatically on first use).
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='marking_deadlines' AND xtype='U')
CREATE TABLE marking_deadlines (
  assessment_id INT NOT NULL PRIMARY KEY,
  deadline_utc DATETIME2 NOT NULL,
  set_by INT NULL,
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
