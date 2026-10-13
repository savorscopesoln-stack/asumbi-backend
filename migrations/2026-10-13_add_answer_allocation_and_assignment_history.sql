-- Question-level allocation + undo history for teacher assignments.
-- Also created automatically at startup by utils/ensureSchema.js.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_answer_assignments' AND xtype='U')
CREATE TABLE e_assessment_answer_assignments (
  id INT IDENTITY(1,1) PRIMARY KEY, e_assessment_id INT NOT NULL, answer_id INT NOT NULL,
  teacher_id INT NOT NULL, assigned_at DATETIME NOT NULL DEFAULT GETDATE());
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'UX_answer_assignments_answer' AND object_id = Object_ID(N'e_assessment_answer_assignments'))
CREATE UNIQUE INDEX UX_answer_assignments_answer ON e_assessment_answer_assignments (answer_id);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'IX_answer_assignments_teacher' AND object_id = Object_ID(N'e_assessment_answer_assignments'))
CREATE INDEX IX_answer_assignments_teacher ON e_assessment_answer_assignments (teacher_id, e_assessment_id);
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_assignment_batches' AND xtype='U')
CREATE TABLE e_assessment_assignment_batches (
  id INT IDENTITY(1,1) PRIMARY KEY, kind NVARCHAR(20) NOT NULL, summary NVARCHAR(300) NULL, created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT GETDATE(), undone_at DATETIME NULL, undone_by INT NULL);
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_assignment_changes' AND xtype='U')
CREATE TABLE e_assessment_assignment_changes (
  id INT IDENTITY(1,1) PRIMARY KEY, batch_id INT NOT NULL, kind NVARCHAR(12) NOT NULL, target_id INT NULL,
  teacher_id INT NULL, subject_id INT NULL, class_id INT NULL, prev_teacher_id INT NULL, new_teacher_id INT NULL);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'IX_assignment_changes_batch' AND object_id = Object_ID(N'e_assessment_assignment_changes'))
CREATE INDEX IX_assignment_changes_batch ON e_assessment_assignment_changes (batch_id);
