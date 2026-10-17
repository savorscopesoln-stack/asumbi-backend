-- Marking leaderboard timestamps + indexes that stop the Device Locks query timing out.
-- Also applied automatically at startup by utils/ensureSchema.js. Safe to re-run.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'marked_by' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD marked_by INT NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'marked_at' AND Object_ID=Object_ID(N'e_assessment_answers'))
  ALTER TABLE e_assessment_answers ADD marked_at DATETIME NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'marking_completed_at' AND Object_ID=Object_ID(N'e_assessment_submissions'))
  ALTER TABLE e_assessment_submissions ADD marking_completed_at DATETIME NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name=N'marking_completed_by' AND Object_ID=Object_ID(N'e_assessment_submissions'))
  ALTER TABLE e_assessment_submissions ADD marking_completed_by INT NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_violation_photos_session')
  CREATE NONCLUSTERED INDEX IX_ea_violation_photos_session ON e_assessment_violation_photos (session_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_answers_submission_cover')
  CREATE NONCLUSTERED INDEX IX_ea_answers_submission_cover ON e_assessment_answers (submission_id) INCLUDE (question_id, selected_answer, marks_awarded);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sessions_status_assessment')
  CREATE NONCLUSTERED INDEX IX_ea_sessions_status_assessment ON e_assessment_exam_sessions (status, e_assessment_id) INCLUDE (student_id, last_heartbeat, ended_at, issued_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_ea_sub_assign_teacher')
  CREATE NONCLUSTERED INDEX IX_ea_sub_assign_teacher ON e_assessment_submission_assignments (teacher_id) INCLUDE (submission_id, assigned_at);
