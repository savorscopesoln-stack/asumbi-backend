-- Adds exam_code to main_examinations: a short, human-typeable code an
-- admin generates from the Main Examinations dashboard (Timetable tab)
-- and hands to an invigilator, so the local exam server can pull the
-- WHOLE examination — every subject's questions/roster + the timetable —
-- in one shot via GET /local-sync/pull-exam/:examCode, instead of
-- authorizing and pulling each subject's assessment individually.
--
-- This file is for manual/reference use only — the app applies this
-- same change automatically on boot via backend/utils/ensureSchema.js
-- (idempotent, safe to run against a DB that already has the column).
-- See:
--   - generateExamCode() in backend/controllers/mainExam.controller.js
--   - pullExamPackage() in backend/controllers/syncController.js
--   - ExamCodeCard in frontend/src/pages/MainExaminationDashboard.jsx

IF NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'exam_code' AND Object_ID = Object_ID(N'main_examinations')
)
ALTER TABLE main_examinations ADD exam_code NVARCHAR(20) NULL;
GO

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'UQ_main_examinations_exam_code' AND object_id = Object_ID(N'main_examinations')
)
CREATE UNIQUE NONCLUSTERED INDEX UQ_main_examinations_exam_code
ON main_examinations(exam_code) WHERE exam_code IS NOT NULL;
GO
