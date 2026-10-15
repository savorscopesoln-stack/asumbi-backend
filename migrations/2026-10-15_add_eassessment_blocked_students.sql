-- Global "Deactivate student" list for ALL e-assessments (admin E-Assessments > Students).
-- Also created automatically at startup by utils/ensureSchema.js.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_blocked_students' AND xtype='U')
CREATE TABLE e_assessment_blocked_students (
  id INT IDENTITY(1,1) PRIMARY KEY,
  student_id INT NOT NULL,
  deactivated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT GETDATE()
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'UX_ea_blocked_students' AND object_id = Object_ID(N'e_assessment_blocked_students'))
CREATE UNIQUE INDEX UX_ea_blocked_students ON e_assessment_blocked_students (student_id);
