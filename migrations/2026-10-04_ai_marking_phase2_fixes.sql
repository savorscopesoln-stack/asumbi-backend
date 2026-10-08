-- AI-assisted marking — Phase 2 fixes + Phase 4 job/billing columns + Phase 6 worker columns (additive; safe on a live database).
-- GENERATED from utils/aiMarkingSchema.js by scripts/generateAiMarkingMigration.js
-- — do not hand-edit; change the JS and regenerate. The JS is what actually
-- runs on server boot (ensureSchema.js); this file is for manual/reference use.
--
-- Fixes (see PHASE1_AI_MARKING_AUDIT.md section 6): ledger reserved_delta +
-- reverses_ledger_id, append-only triggers (ledger, pricing, adjustments),
-- pricing.plan_code, worker columns on jobs/evaluations, evaluations
-- review_state + whole-number final-mark CHECK + scheme-version link,
-- ai_marking_scheme_versions, ai_marking_adjustments.
-- Phase 4: evaluations.suggested_total/model/prompt_version become NULLable,
-- status gains 'cancelled', UQ_ai_marking_evaluations_live_answer (one live
-- evaluation per answer across all jobs), IX_ai_marking_jobs_status_created.
-- Phase 6: evaluations.next_attempt_at (per-answer lease + backoff) and
-- reused_from_evaluation_id; jobs.paused_until / pause_reason / pause_count;
-- IX_ai_marking_evaluations_work and IX_ai_marking_evaluations_reuse.
-- (The file keeps its original name; it is regenerated, not versioned.)
--
-- ROLLBACK (manual, only while the new tables/columns hold no real data —
-- once they do, use compensating entries instead):
--   DROP TRIGGER TR_ai_marking_adjustments_append_only;
--   DROP TRIGGER TR_ai_marking_pricing_append_only;
--   DROP TRIGGER TR_ai_marking_ledger_append_only;
--   -- then drop the new tables/constraints/columns in reverse order of creation.

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_ledger' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'reserved_delta' AND Object_ID = Object_ID(N'ai_marking_ledger')
)
ALTER TABLE ai_marking_ledger ADD reserved_delta DECIMAL(18,4) NOT NULL DEFAULT 0
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_ledger' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'reverses_ledger_id' AND Object_ID = Object_ID(N'ai_marking_ledger')
)
ALTER TABLE ai_marking_ledger ADD reverses_ledger_id INT NULL
GO

IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'TR_ai_marking_ledger_append_only')
AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'reserved_delta' AND Object_ID = Object_ID(N'ai_marking_ledger'))
EXEC('UPDATE ai_marking_ledger
      SET reserved_delta = CASE WHEN entry_type IN (''reserve'',''release'') THEN -amount_delta ELSE 0 END
      WHERE reserved_delta = 0 AND entry_type IN (''reserve'',''release'') AND amount_delta <> 0')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_ai_marking_ledger_reverses')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_ledger' AND xtype='U')
EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_ledger_reverses
       ON ai_marking_ledger(reverses_ledger_id) WHERE reverses_ledger_id IS NOT NULL')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_pricing' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'plan_code' AND Object_ID = Object_ID(N'ai_marking_pricing')
)
ALTER TABLE ai_marking_pricing ADD plan_code NVARCHAR(50) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'attempt_count' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD attempt_count INT NOT NULL DEFAULT 0
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'last_error' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD last_error NVARCHAR(1000) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'locked_by' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD locked_by NVARCHAR(100) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'locked_until' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD locked_until DATETIME NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'provider_batch_id' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD provider_batch_id NVARCHAR(100) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'started_at' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD started_at DATETIME NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'cancel_requested' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD cancel_requested BIT NOT NULL DEFAULT 0
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
CREATE TABLE ai_marking_scheme_versions (
  id INT IDENTITY(1,1) PRIMARY KEY,
  question_id INT NOT NULL,                 -- e_assessment_questions.id (no FK: table not tracked in migrations, see audit §2)
  version_no INT NOT NULL,
  criteria_json NVARCHAR(MAX) NOT NULL,     -- [{criterionId,label,maxMarks,expectedPoints[],acceptableAlternatives[]}]
  max_marks DECIMAL(6,2) NOT NULL,
  source_guide_hash CHAR(64) NULL,          -- SHA-256 of the free-text marking_guide this version was derived from
  status NVARCHAR(20) NOT NULL DEFAULT 'draft',
  created_by INT NULL,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  createdAt DATETIME NOT NULL DEFAULT GETDATE(),
  CONSTRAINT CK_ai_marking_scheme_versions_status CHECK (status IN ('draft','approved','superseded')),
  CONSTRAINT CK_ai_marking_scheme_versions_approved CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT CK_ai_marking_scheme_versions_max CHECK (max_marks > 0)
)
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_ai_marking_scheme_versions_question_version')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_scheme_versions_question_version
       ON ai_marking_scheme_versions(question_id, version_no)')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_ai_marking_scheme_versions_one_approved')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_scheme_versions_one_approved
       ON ai_marking_scheme_versions(question_id) WHERE status = ''approved''')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'change_note' AND Object_ID = Object_ID(N'ai_marking_scheme_versions')
)
ALTER TABLE ai_marking_scheme_versions ADD change_note NVARCHAR(500) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'approval_notes' AND Object_ID = Object_ID(N'ai_marking_scheme_versions')
)
ALTER TABLE ai_marking_scheme_versions ADD approval_notes NVARCHAR(MAX) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'scheme_version_id' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD scheme_version_id INT NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'attempt_count' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD attempt_count INT NOT NULL DEFAULT 0
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'last_error' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD last_error NVARCHAR(1000) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'completed_at' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD completed_at DATETIME NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'review_state' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD review_state NVARCHAR(20) NOT NULL CONSTRAINT DF_ai_marking_evaluations_review_state DEFAULT 'awaiting_review'
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'review_state' AND Object_ID = Object_ID(N'ai_marking_evaluations'))
AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_review_state')
EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_review_state
      CHECK (review_state IN (''awaiting_review'',''approved'',''adjusted'',''rejected'',''superseded''))')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_final_whole')
EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_final_whole
      CHECK (teacher_final_mark IS NULL OR (teacher_final_mark = ROUND(teacher_final_mark, 0)
             AND teacher_final_mark >= 0 AND teacher_final_mark <= max_marks))')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'scheme_version_id' AND Object_ID = Object_ID(N'ai_marking_evaluations'))
AND NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE name = 'FK_ai_marking_evaluations_scheme_version')
EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT FK_ai_marking_evaluations_scheme_version
      FOREIGN KEY (scheme_version_id) REFERENCES ai_marking_scheme_versions(id)')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_evaluations_review_state')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_review_state
       ON ai_marking_evaluations(review_state, status)')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_evaluations_answer')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_answer
       ON ai_marking_evaluations(submission_id, question_id)')
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_adjustments' AND xtype='U')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
CREATE TABLE ai_marking_adjustments (
  id INT IDENTITY(1,1) PRIMARY KEY,
  evaluation_id INT NOT NULL,
  action NVARCHAR(30) NOT NULL,
  before_json NVARCHAR(MAX) NULL,
  after_json NVARCHAR(MAX) NULL,
  final_mark DECIMAL(6,2) NULL,
  reason NVARCHAR(500) NULL,
  actor_id INT NOT NULL,
  actor_role NVARCHAR(30) NULL,
  createdAt DATETIME NOT NULL DEFAULT GETDATE(),
  CONSTRAINT CK_ai_marking_adjustments_action CHECK (action IN
    ('accept','adjust','reject','mark_manually','request_reevaluation','flag_scheme')),
  CONSTRAINT FK_ai_marking_adjustments_evaluation FOREIGN KEY (evaluation_id) REFERENCES ai_marking_evaluations(id)
)
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_adjustments_evaluation')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_adjustments' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_adjustments_evaluation ON ai_marking_adjustments(evaluation_id)')
GO

IF EXISTS (SELECT * FROM sys.columns WHERE Name = N'suggested_total' AND Object_ID = Object_ID(N'ai_marking_evaluations') AND is_nullable = 0)
EXEC('
  BEGIN TRY
    BEGIN TRANSACTION;
    IF EXISTS (SELECT * FROM sys.check_constraints WHERE name = ''CK_ai_marking_evaluations_marks_bounds'')
    ALTER TABLE ai_marking_evaluations DROP CONSTRAINT CK_ai_marking_evaluations_marks_bounds;
  ALTER TABLE ai_marking_evaluations ALTER COLUMN suggested_total DECIMAL(6,2) NULL;
  ALTER TABLE ai_marking_evaluations ALTER COLUMN model NVARCHAR(100) NULL;
  ALTER TABLE ai_marking_evaluations ALTER COLUMN prompt_version NVARCHAR(30) NULL;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_marks_bounds')
EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_marks_bounds
      CHECK (suggested_total IS NULL OR (suggested_total >= 0 AND suggested_total <= max_marks))')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_status' AND definition LIKE '%cancelled%')
EXEC('
  BEGIN TRY
    BEGIN TRANSACTION;
    IF EXISTS (SELECT * FROM sys.check_constraints WHERE name = ''CK_ai_marking_evaluations_status'')
    ALTER TABLE ai_marking_evaluations DROP CONSTRAINT CK_ai_marking_evaluations_status;
  ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_status
    CHECK (status IN (''pending'',''success'',''failed'',''needs_review'',''cancelled''));
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_ai_marking_evaluations_live_answer')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_evaluations_live_answer
       ON ai_marking_evaluations(submission_id, question_id)
       WHERE status IN (''pending'',''success'',''needs_review'') AND review_state <> ''superseded''')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_jobs_status_created')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_jobs_status_created ON ai_marking_jobs(status, createdAt)')
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'next_attempt_at' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD next_attempt_at DATETIME NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'reused_from_evaluation_id' AND Object_ID = Object_ID(N'ai_marking_evaluations')
)
ALTER TABLE ai_marking_evaluations ADD reused_from_evaluation_id INT NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'paused_until' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD paused_until DATETIME NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'pause_reason' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD pause_reason NVARCHAR(200) NULL
GO

IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns WHERE Name = N'pause_count' AND Object_ID = Object_ID(N'ai_marking_jobs')
)
ALTER TABLE ai_marking_jobs ADD pause_count INT NOT NULL DEFAULT 0
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_evaluations_work')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_work
       ON ai_marking_evaluations(ai_marking_job_id, status, next_attempt_at)')
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ai_marking_evaluations_reuse')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_reuse
       ON ai_marking_evaluations(question_id, answer_content_hash, scheme_version_id)')
GO

IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'TR_ai_marking_ledger_append_only')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_ledger' AND xtype='U')
EXEC('
CREATE TRIGGER TR_ai_marking_ledger_append_only ON ai_marking_ledger
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW 51000, ''ai_marking_ledger is append-only table: UPDATE and DELETE are not allowed, use a compensating entry instead'', 1;
END
  ')
GO

IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'TR_ai_marking_pricing_append_only')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_pricing' AND xtype='U')
EXEC('
CREATE TRIGGER TR_ai_marking_pricing_append_only ON ai_marking_pricing
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW 51000, ''ai_marking_pricing is append-only table: UPDATE and DELETE are not allowed, use a compensating entry instead'', 1;
END
  ')
GO

IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'TR_ai_marking_adjustments_append_only')
AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_adjustments' AND xtype='U')
EXEC('
CREATE TRIGGER TR_ai_marking_adjustments_append_only ON ai_marking_adjustments
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW 51000, ''ai_marking_adjustments is append-only table: UPDATE and DELETE are not allowed, use a compensating entry instead'', 1;
END
  ')
GO
