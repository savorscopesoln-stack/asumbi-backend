-- Speeds up the queries hit on every student's dashboard/timetable load
-- (backend/controllers/mainExamStudent.controller.js, Phase 14) and every
-- scheduler tick (backend/utils/examScheduler.js, Phase 5) — both filter
-- exam_subject_sessions by status/start_time and join e_assessments on
-- class_id/year_of_study, none of which had a dedicated index.
--
-- Same reasoning/safety notes as 2026-09-12_add_exam_login_indexes.sql:
-- additive only, no data changes, no application code changes needed,
-- each guarded by IF NOT EXISTS so this is a safe no-op to re-run.

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('exam_subject_sessions') AND name = 'IX_exam_subject_sessions_status_start'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_exam_subject_sessions_status_start
        ON exam_subject_sessions (status, start_time)
        INCLUDE (end_time, main_examination_id, e_assessment_id, subject);
    -- Covers the scheduler's "due to activate" / "due to end" sweeps
    -- (WHERE status = 'scheduled'/'active' AND start_time/end_time...)
    -- and the student dashboard's "which of my subjects are active right
    -- now" filter, both of which run status-first.
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('exam_subject_sessions') AND name = 'IX_exam_subject_sessions_main_exam'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_exam_subject_sessions_main_exam
        ON exam_subject_sessions (main_examination_id);
    -- SQL Server doesn't auto-index FK columns — every dashboard/
    -- timetable/report query in mainExam*.controller.js filters by this.
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('e_assessments') AND name = 'IX_e_assessments_class_id'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_e_assessments_class_id
        ON e_assessments (class_id);
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('e_assessments') AND name = 'IX_e_assessments_year_of_study'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_e_assessments_year_of_study
        ON e_assessments (year_of_study);
    -- Both of the above back the "which subjects/exams apply to THIS
    -- student's class or year" join used by the scheduler, the Main
    -- Examination dashboard/candidates tab, the reports, and now the
    -- student-facing dashboard/timetable — the single most repeated join
    -- pattern this whole feature introduced.
END;
