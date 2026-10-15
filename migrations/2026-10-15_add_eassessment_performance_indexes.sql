-- Performance indexes for the E-Assessments admin page.
-- Safe to run on a live DB (each index is created only if missing).
-- Run once against your production database (and each tenant DB).

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sub_assessment_student')
  CREATE NONCLUSTERED INDEX IX_ea_sub_assessment_student
  ON e_assessment_submissions (e_assessment_id, student_id) INCLUDE (status, score, submitted_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sub_status_released')
  CREATE NONCLUSTERED INDEX IX_ea_sub_status_released
  ON e_assessment_submissions (status, released_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_answers_submission')
  CREATE NONCLUSTERED INDEX IX_ea_answers_submission
  ON e_assessment_answers (submission_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_questions_assessment')
  CREATE NONCLUSTERED INDEX IX_ea_questions_assessment
  ON e_assessment_questions (e_assessment_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sessions_assessment_student')
  CREATE NONCLUSTERED INDEX IX_ea_sessions_assessment_student
  ON e_assessment_exam_sessions (e_assessment_id, student_id) INCLUDE (status);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sessions_status')
  CREATE NONCLUSTERED INDEX IX_ea_sessions_status
  ON e_assessment_exam_sessions (status);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_violation_photos_assessment_student')
  CREATE NONCLUSTERED INDEX IX_ea_violation_photos_assessment_student
  ON e_assessment_violation_photos (e_assessment_id, student_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sub_assign_submission')
  CREATE NONCLUSTERED INDEX IX_ea_sub_assign_submission
  ON e_assessment_submission_assignments (submission_id) INCLUDE (teacher_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_allowed_students_assessment')
  CREATE NONCLUSTERED INDEX IX_ea_allowed_students_assessment
  ON e_assessment_allowed_students (e_assessment_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_device_access_last_seen')
  CREATE NONCLUSTERED INDEX IX_ea_device_access_last_seen
  ON e_assessment_device_access (status, last_seen DESC);
