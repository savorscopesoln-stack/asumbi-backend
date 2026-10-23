-- Marking leaderboard (admin E-Assessments > Marking) was lagging: its queries read marked_at /
-- marks_awarded / question_id for every answer of every allocated script, and scan the whole answers
-- table to find "open marking" by marked_by. Also applied automatically at startup (ensureSchema.js +
-- IX_ea_answers_marked_by in utils/indexSpecs.js). Idempotent; safe to run on a live DB.
IF COL_LENGTH(N'e_assessment_answers', N'marked_at') IS NOT NULL
   AND COL_LENGTH(N'e_assessment_answers', N'marked_by') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_answers_submission_marking' AND object_id = OBJECT_ID(N'e_assessment_answers'))
BEGIN
  CREATE NONCLUSTERED INDEX IX_ea_answers_submission_marking ON e_assessment_answers (submission_id)
    INCLUDE (question_id, selected_answer, marks_awarded, marked_at, marked_by);
  IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_answers_submission_cover' AND object_id = OBJECT_ID(N'e_assessment_answers'))
    DROP INDEX IX_ea_answers_submission_cover ON e_assessment_answers;  -- fully replaced by the index above
END
-- IX_ea_answers_marked_by is created by 2026-10-19_add_missing_indexes.sql (re-run it, or restart the server).
