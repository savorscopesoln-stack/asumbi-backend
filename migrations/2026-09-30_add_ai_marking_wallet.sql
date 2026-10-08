-- Adds the AI-assisted essay marking credit/billing system (Master
-- Implementation Prompt, Phase 2). This is DELIBERATELY separate from
-- institution_wallets/wallet_ledger (2026-09-25_add_wallet_credit_ledger.sql)
-- per the spec's explicit rule: "An institution's examination credits
-- must never be consumed by AI marking unless an explicit future
-- business rule authorizes it." Same rows are never touched by both
-- systems; the only thing shared is the *pattern* (see
-- services/aiMarkingLedger.service.js's header comment for why it
-- mirrors services/walletLedger.service.js's transaction/lock
-- approach instead of inventing a new one).
--
-- ASSUMPTION (Phase 1 audit could not confirm — see
-- PHASE1_AI_MARKING_AUDIT.md §2): e_assessments, e_assessment_questions,
-- e_assessment_submissions and e_assessment_answers have no CREATE TABLE
-- in this codebase's tracked migrations, yet e_assessment_question_images
-- (which IS tracked) references e_assessment_questions.question_id as a
-- plain INT with no FOREIGN KEY constraint — the established convention
-- for this table family. ai_marking_evaluations below follows that same
-- convention for submission_id/question_id/answer_id rather than adding
-- an FK SQL Server can't verify against an unconfirmed table. If those
-- core tables' real definition turns out to use different PK types,
-- only this file needs revisiting — nothing here assumes column types
-- beyond INT IDENTITY, which is what every other reference to them in
-- the existing codebase already assumes too.
--
-- Owner model: ai_marking_wallets.owner_type is 'institution' (one row,
-- owner_id NULL) or 'teacher' (owner_id = Users.id). The spec asks for
-- "institution-funded wallet initially, with the ability to allocate
-- marking credits to teachers... without rebuilding the billing
-- system" — the teacher branch is schema-complete now but has no
-- issuance UI yet (that's a later phase); the unique filtered indexes
-- below already enforce "one wallet per teacher" so turning it on
-- later is additive, not a migration.
--
-- DECIMAL not INT for balances (unlike institution_wallets' whole-
-- number "one exam = one credit" model): AI marking is priced per
-- answer and Finance may set a fractional unit price, so balances need
-- to hold fractional amounts precisely.
--
-- This migration is additive and safe to run on a live database — it
-- only CREATEs new tables, never ALTERs an existing one. Applied
-- automatically on boot via ensureSchema.js (idempotent). This file is
-- for manual/reference use only, matching every other dated file here.
--
-- ROLLBACK: see the bottom of this file. Safe only if no rows exist in
-- ai_marking_ledger/ai_marking_evaluations yet — once real financial or
-- marking data exists, use a compensating ledger entry, never a DROP.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_wallets' AND xtype='U')
BEGIN
    CREATE TABLE ai_marking_wallets (
        id INT IDENTITY(1,1) PRIMARY KEY,
        owner_type NVARCHAR(20) NOT NULL,          -- 'institution' | 'teacher'
        owner_id INT NULL,                          -- NULL for the institution wallet; Users.id for a teacher wallet
        available_balance DECIMAL(18,4) NOT NULL DEFAULT 0,
        reserved_balance DECIMAL(18,4) NOT NULL DEFAULT 0,
        currency NVARCHAR(10) NOT NULL DEFAULT 'KES',
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        updatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_ai_marking_wallets_owner_type CHECK (owner_type IN ('institution','teacher')),
        CONSTRAINT CK_ai_marking_wallets_owner_id_teacher CHECK (owner_type <> 'teacher' OR owner_id IS NOT NULL),
        CONSTRAINT CK_ai_marking_wallets_available_nonneg CHECK (available_balance >= 0),
        CONSTRAINT CK_ai_marking_wallets_reserved_nonneg CHECK (reserved_balance >= 0)
    );
    -- Singleton institution wallet, same convention as institution_wallets(id=1) —
    -- kept as a filtered unique index (not a hardcoded id) since this
    -- table also holds teacher rows, unlike institution_wallets.
    CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_wallets_institution
        ON ai_marking_wallets(owner_type) WHERE owner_type = 'institution';
    CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_wallets_teacher
        ON ai_marking_wallets(owner_id) WHERE owner_type = 'teacher';

    INSERT INTO ai_marking_wallets (owner_type, owner_id, available_balance, reserved_balance)
    VALUES ('institution', NULL, 0, 0);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_ledger' AND xtype='U')
BEGIN
    CREATE TABLE ai_marking_ledger (
        id INT IDENTITY(1,1) PRIMARY KEY,
        wallet_id INT NOT NULL,
        entry_type NVARCHAR(30) NOT NULL,           -- topup | reserve | release | consume | reverse
        amount_delta DECIMAL(18,4) NOT NULL,        -- signed; SUM() per wallet_id reconciles to available_balance
        available_after DECIMAL(18,4) NOT NULL,
        reserved_after DECIMAL(18,4) NOT NULL,
        ai_marking_job_id INT NULL,
        finance_reference NVARCHAR(100) NULL,       -- links a topup back to whatever Finance's own record of payment is
        actor_id INT NULL,
        actor_role NVARCHAR(30) NULL,
        reason NVARCHAR(500) NULL,
        idempotency_key NVARCHAR(100) NULL,         -- retried operations are no-ops (unique index below)
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_ai_marking_ledger_entry_type CHECK (entry_type IN ('topup','reserve','release','consume','reverse')),
        CONSTRAINT FK_ai_marking_ledger_wallet FOREIGN KEY (wallet_id) REFERENCES ai_marking_wallets(id)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_ledger_idempotency_key
        ON ai_marking_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE NONCLUSTERED INDEX IX_ai_marking_ledger_wallet_id ON ai_marking_ledger(wallet_id);
    CREATE NONCLUSTERED INDEX IX_ai_marking_ledger_job_id ON ai_marking_ledger(ai_marking_job_id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_pricing' AND xtype='U')
BEGIN
    -- Finance-configurable price per successfully processed answer.
    -- Multiple rows = price history (never edited in place); the
    -- active price for a given moment is "the row with the latest
    -- effective_from <= now" — same append-only, no-silent-overwrite
    -- philosophy as the ledger tables.
    CREATE TABLE ai_marking_pricing (
        id INT IDENTITY(1,1) PRIMARY KEY,
        price_per_answer DECIMAL(18,4) NOT NULL,
        currency NVARCHAR(10) NOT NULL DEFAULT 'KES',
        volume_discount_json NVARCHAR(MAX) NULL,     -- optional [{minQty, pricePerAnswer}, ...]
        institution_wallets_enabled BIT NOT NULL DEFAULT 1,
        teacher_wallets_enabled BIT NOT NULL DEFAULT 0,
        effective_from DATETIME NOT NULL DEFAULT GETDATE(),
        set_by INT NULL,
        notes NVARCHAR(500) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_ai_marking_pricing_price_nonneg CHECK (price_per_answer >= 0)
    );
    CREATE NONCLUSTERED INDEX IX_ai_marking_pricing_effective ON ai_marking_pricing(effective_from DESC);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_jobs' AND xtype='U')
BEGIN
    CREATE TABLE ai_marking_jobs (
        id INT IDENTITY(1,1) PRIMARY KEY,
        e_assessment_id INT NULL,                    -- scope: e_assessments.id (no FK — see file header)
        main_examination_id INT NULL,                -- optional broader scope; DOES exist in ensureSchema.js so this one IS FK'd below
        teacher_id INT NOT NULL,                      -- Users.id of the requesting teacher
        selection_criteria NVARCHAR(MAX) NULL,        -- JSON: {questionIds:[...], studentIds:[...], scope:'assessment'|'subject'|'questions'|'students'|'eligible'}
        wallet_id INT NOT NULL,                       -- which wallet this job charges (institution's, or in future a teacher's)
        pricing_id INT NULL,                          -- which ai_marking_pricing row's price_per_answer was used (immutable snapshot reference)
        eligible_count INT NOT NULL DEFAULT 0,
        reserved_count INT NOT NULL DEFAULT 0,
        processed_count INT NOT NULL DEFAULT 0,
        failed_count INT NOT NULL DEFAULT 0,
        cancelled_count INT NOT NULL DEFAULT 0,
        unit_price DECIMAL(18,4) NOT NULL,            -- snapshot, not a live lookup — price changes later never alter a past job's cost
        quoted_total DECIMAL(18,4) NOT NULL,
        actual_total DECIMAL(18,4) NOT NULL DEFAULT 0, -- settled amount = unit_price * processed_count, updated as processing completes
        currency NVARCHAR(10) NOT NULL DEFAULT 'KES',
        model NVARCHAR(100) NULL,
        provider NVARCHAR(50) NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|reserved|processing|completed|failed|cancelled
        idempotency_key NVARCHAR(100) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        completedAt DATETIME NULL,
        CONSTRAINT CK_ai_marking_jobs_status CHECK (status IN ('pending','reserved','processing','completed','failed','cancelled')),
        CONSTRAINT CK_ai_marking_jobs_counts_nonneg CHECK (eligible_count >= 0 AND reserved_count >= 0 AND processed_count >= 0 AND failed_count >= 0 AND cancelled_count >= 0),
        CONSTRAINT FK_ai_marking_jobs_wallet FOREIGN KEY (wallet_id) REFERENCES ai_marking_wallets(id),
        CONSTRAINT FK_ai_marking_jobs_pricing FOREIGN KEY (pricing_id) REFERENCES ai_marking_pricing(id),
        CONSTRAINT FK_ai_marking_jobs_main_exam FOREIGN KEY (main_examination_id) REFERENCES main_examinations(id)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_jobs_idempotency_key
        ON ai_marking_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE NONCLUSTERED INDEX IX_ai_marking_jobs_status ON ai_marking_jobs(status);
    CREATE NONCLUSTERED INDEX IX_ai_marking_jobs_teacher ON ai_marking_jobs(teacher_id);
    CREATE NONCLUSTERED INDEX IX_ai_marking_jobs_assessment ON ai_marking_jobs(e_assessment_id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
BEGIN
    CREATE TABLE ai_marking_evaluations (
        id INT IDENTITY(1,1) PRIMARY KEY,
        ai_marking_job_id INT NOT NULL,
        submission_id INT NOT NULL,                   -- e_assessment_submissions.id (no FK — see file header)
        question_id INT NOT NULL,                     -- e_assessment_questions.id (no FK — see file header)
        answer_id INT NULL,                            -- e_assessment_answers.id (no FK — see file header)
        answer_content_hash CHAR(64) NOT NULL,          -- SHA-256 of the essay_answer text this evaluation was run against
        marking_guide_hash CHAR(64) NULL,               -- SHA-256 of the marking_guide text used, for later drift detection if the guide changes
        model NVARCHAR(100) NOT NULL,
        prompt_version NVARCHAR(30) NOT NULL,
        criteria_json NVARCHAR(MAX) NULL,               -- [{criterionId, label, maxMarks, awardedMarks, evidence, explanation}, ...]
        suggested_total DECIMAL(6,2) NOT NULL,
        max_marks DECIMAL(6,2) NOT NULL,
        review_flags NVARCHAR(MAX) NULL,                -- JSON array of flag strings, e.g. ["low_confidence","ambiguous_scheme"]
        token_usage_json NVARCHAR(MAX) NULL,            -- {promptTokens, completionTokens, ...} — actual measured usage, for cost forecasting
        processing_cost DECIMAL(10,4) NULL,             -- Doravo's actual provider cost for this one evaluation, separate from what the teacher/institution is charged
        status NVARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|success|failed|needs_review
        teacher_final_mark DECIMAL(6,2) NULL,           -- NULL until a teacher approves/overrides — this, not suggested_total, is what may ever reach e_assessment_answers.marks_awarded
        teacher_approved_by INT NULL,
        teacher_approved_at DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_ai_marking_evaluations_status CHECK (status IN ('pending','success','failed','needs_review')),
        CONSTRAINT CK_ai_marking_evaluations_marks_bounds CHECK (suggested_total >= 0 AND suggested_total <= max_marks),
        CONSTRAINT FK_ai_marking_evaluations_job FOREIGN KEY (ai_marking_job_id) REFERENCES ai_marking_jobs(id)
    );
    CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_job ON ai_marking_evaluations(ai_marking_job_id);
    -- One evaluation per (submission, question) WITHIN a given job — the
    -- DB-level backstop against "duplicate submission of identical work
    -- triggering unnecessary API charges" (spec, Phase 6) for retries of
    -- the SAME job. A teacher deliberately requesting a fresh evaluation
    -- later creates a new job (and therefore a new row) — that's a
    -- legitimate re-request, not a duplicate charge, so this constraint
    -- is scoped per-job rather than globally.
    CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_evaluations_job_submission_question
        ON ai_marking_evaluations(ai_marking_job_id, submission_id, question_id);
END;

-- ROLLBACK (manual reference only — see warning above):
-- DROP TABLE ai_marking_evaluations;
-- DROP TABLE ai_marking_jobs;
-- DROP TABLE ai_marking_pricing;
-- DROP TABLE ai_marking_ledger;
-- DROP TABLE ai_marking_wallets;
