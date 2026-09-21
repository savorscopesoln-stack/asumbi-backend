-- Labels each Assessments row so Marks — which already carries
-- assessmentId + subjectId per row (see routes/marks.js, and the
-- "MARKS" section of server.js) — can be grouped/filtered meaningfully
-- when generating reports and transcripts.
--
-- examScope:   'main'    = a combined, whole-cohort event spanning many
--                          subjects at once (an Endterm/Midterm series —
--                          one Assessments row per subject paper, same
--                          name/term/year across all of them).
--              'subject' = a one-off, single-subject assessment (a CAT,
--                          an assignment). This is the default for any
--                          existing row; a one-time backfill below
--                          upgrades rows with more than one linked
--                          subject (AssessmentSubjects) to 'main', since
--                          those are almost certainly a paper series.
--                          Staff can relabel any individual assessment
--                          after this runs.
--
-- sourceSystem / sourceRefId: which subsystem produced this assessment
-- record. 'manual' (default) = created directly via POST /api/assessments,
-- the normal teacher/admin flow; sourceRefId stays NULL. 'e_assessment'
-- = auto-provisioned so an online e_assessments exam has a proper
-- Assessments row for its released Marks to hang off of; sourceRefId is
-- that e_assessments.id.
--
-- This also fixes a real bug: releaseMarks()/bulkReleaseMarks() in
-- eAssessment.controller.js used to INSERT INTO Marks with
-- assessmentId = e_assessments.id, while every manually-entered mark
-- uses assessmentId = Assessments.id — the same column pointing into
-- two unrelated id spaces depending on where the mark came from. From
-- this migration on, Marks.assessmentId ALWAYS points at Assessments.id,
-- e_assessment-sourced marks included, via a get-or-create helper
-- (ensureAssessmentForEAssessment() in eAssessment.controller.js).
--
-- This file is for manual/reference use only — the app applies this
-- same change automatically on boot via backend/utils/ensureSchema.js
-- (idempotent, safe to run against a DB that already has it applied).

IF NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'examScope' AND Object_ID = Object_ID(N'Assessments')
)
ALTER TABLE Assessments ADD examScope NVARCHAR(20) NOT NULL DEFAULT 'subject';
GO

IF NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'sourceSystem' AND Object_ID = Object_ID(N'Assessments')
)
ALTER TABLE Assessments ADD sourceSystem NVARCHAR(20) NOT NULL DEFAULT 'manual';
GO

IF NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'sourceRefId' AND Object_ID = Object_ID(N'Assessments')
)
ALTER TABLE Assessments ADD sourceRefId INT NULL;
GO

-- One-time backfill: only ever touches rows still on the DEFAULT
-- 'subject' label, so it never overwrites anything staff have since
-- relabeled by hand.
UPDATE a SET a.examScope = 'main'
FROM Assessments a
WHERE a.examScope = 'subject'
  AND (SELECT COUNT(*) FROM AssessmentSubjects ast WHERE ast.assessmentId = a.id) > 1;
GO

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'IX_Marks_assessmentId_subjectId_studentId' AND object_id = Object_ID(N'Marks')
)
CREATE NONCLUSTERED INDEX IX_Marks_assessmentId_subjectId_studentId
ON Marks(assessmentId, subjectId, studentId);
GO

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'IX_Marks_studentId' AND object_id = Object_ID(N'Marks')
)
CREATE NONCLUSTERED INDEX IX_Marks_studentId
ON Marks(studentId);
GO

IF NOT EXISTS (
  SELECT * FROM sys.indexes
  WHERE name = N'IX_Assessments_sourceSystem_sourceRefId' AND object_id = Object_ID(N'Assessments')
)
CREATE NONCLUSTERED INDEX IX_Assessments_sourceSystem_sourceRefId
ON Assessments(sourceSystem, sourceRefId);
GO
