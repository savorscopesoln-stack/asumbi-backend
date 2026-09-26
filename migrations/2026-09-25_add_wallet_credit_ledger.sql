-- Adds the institution-wallet examination credit & billing system:
-- Doravo Finance manually verifies institutional payments and issues
-- credits into a per-institution wallet; one credit funds one student
-- for one complete Main Examination (every subject paper, scheduling,
-- submissions, marking, analytics, results and report card).
--
-- Why: institutions currently have no wallet at all, and Main
-- Examination creation (main_examinations, added previously) has no
-- concept of "funded" — any admin can create an exam regardless of
-- whether the institution has paid Doravo for it. This migration adds
-- the ledger; the exam-creation GATE itself is wired up separately in
-- controllers/mainExam.controller.js (Phase 5 of the wallet rollout),
-- so running this migration alone changes no existing behavior.
--
-- Key design points (see services/walletLedger.service.js for the
-- code that actually writes these tables):
--   - institution_wallets is a singleton per tenant DB (id=1), same
--     convention as SchoolSettings.
--   - wallet_ledger is append-only and immutable — reversals are new
--     compensating rows (entry_type='reverse'), never edits/deletes.
--   - student_exam_entitlements is the new join between "a wallet
--     credit" and "a specific student sitting a specific Main
--     Examination" — nothing in the existing schema tracked this
--     before; exam audience was computed implicitly by class/year
--     match at read time.
--   - credit_issuances models cross-database (control-side "this
--     issuance happened" vs tenant-side "wallet actually credited")
--     delivery as an explicit state machine, since the two steps can't
--     be one distributed SQL transaction.
--   - institution_exam_billing_settings / student_exam_payments track
--     the institution's OWN student-facing exam fee — a separate
--     accounting concept from Doravo's wholesale credit price and
--     never touches the wallet tables.
--
-- This migration is additive and safe to run on a live database. The
-- app applies this same change automatically on boot via
-- backend/utils/ensureSchema.js (idempotent, safe to run against a DB
-- that already has it applied) — this file is for manual/reference use
-- only, matching every other dated file in this folder.
--
-- Rollback: see the bottom of this file for the reverse (DROP) order.
-- Safe to roll back only if no rows have been written to
-- wallet_ledger/credit_issuances/student_exam_entitlements yet — once
-- real financial data exists, use a compensating entry
-- (reverseIssuance / release), never a DROP.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='institution_wallets' AND xtype='U')
BEGIN
    CREATE TABLE institution_wallets (
        id INT PRIMARY KEY,
        available_credits INT NOT NULL DEFAULT 0,
        reserved_credits INT NOT NULL DEFAULT 0,
        total_purchased INT NOT NULL DEFAULT 0,
        total_allocated INT NOT NULL DEFAULT 0,
        updatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_institution_wallets_available_nonneg CHECK (available_credits >= 0),
        CONSTRAINT CK_institution_wallets_reserved_nonneg CHECK (reserved_credits >= 0)
    );
    INSERT INTO institution_wallets (id, available_credits, reserved_credits, total_purchased, total_allocated)
    VALUES (1, 0, 0, 0, 0);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='wallet_ledger' AND xtype='U')
BEGIN
    CREATE TABLE wallet_ledger (
        id INT IDENTITY(1,1) PRIMARY KEY,
        entry_type NVARCHAR(30) NOT NULL,              -- issue | reserve | release | consume | reverse
        credit_delta INT NOT NULL,                     -- signed; SUM() reconciles to available_credits
        available_after INT NOT NULL,
        reserved_after INT NOT NULL,
        main_examination_id INT NULL,
        student_id INT NULL,
        credit_issuance_id INT NULL,
        actor_id INT NULL,
        actor_role NVARCHAR(30) NULL,
        reason NVARCHAR(500) NULL,
        idempotency_key NVARCHAR(100) NULL,            -- retried operations are no-ops (see unique index below)
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_wallet_ledger_idempotency_key
        ON wallet_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE NONCLUSTERED INDEX IX_wallet_ledger_main_examination_id ON wallet_ledger(main_examination_id);
    CREATE NONCLUSTERED INDEX IX_wallet_ledger_student_id ON wallet_ledger(student_id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='institution_payments' AND xtype='U')
BEGIN
    CREATE TABLE institution_payments (
        id INT IDENTITY(1,1) PRIMARY KEY,
        payment_reference NVARCHAR(80) NOT NULL,       -- finance-entered bank/M-Pesa ref, or auto-generated
        amount DECIMAL(18,2) NOT NULL,
        currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
        method NVARCHAR(50) NULL,
        notes NVARCHAR(500) NULL,
        verified_by INT NULL,
        verified_at DATETIME NOT NULL DEFAULT GETDATE(),
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_institution_payments_amount_positive CHECK (amount > 0)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_institution_payments_reference ON institution_payments(payment_reference);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='credit_issuances' AND xtype='U')
BEGIN
    CREATE TABLE credit_issuances (
        id INT IDENTITY(1,1) PRIMARY KEY,
        issuance_reference NVARCHAR(40) NOT NULL,       -- shown to the institution as their deposit receipt
        institution_payment_id INT NULL,
        credit_quantity INT NOT NULL,
        unit_price DECIMAL(18,2) NULL,                  -- immutable wholesale-price snapshot at issuance time
        currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
        state NVARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | delivered | failed | reconciled
        reversed_quantity INT NOT NULL DEFAULT 0,
        issued_by INT NULL,
        issued_at DATETIME NOT NULL DEFAULT GETDATE(),
        delivered_at DATETIME NULL,
        notes NVARCHAR(500) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_credit_issuances_quantity_positive CHECK (credit_quantity > 0),
        CONSTRAINT CK_credit_issuances_reversed_valid CHECK (reversed_quantity >= 0 AND reversed_quantity <= credit_quantity),
        CONSTRAINT CK_credit_issuances_state CHECK (state IN ('pending','delivered','failed','reconciled')),
        CONSTRAINT FK_credit_issuances_payment FOREIGN KEY (institution_payment_id) REFERENCES institution_payments(id)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_credit_issuances_reference ON credit_issuances(issuance_reference);
    CREATE NONCLUSTERED INDEX IX_credit_issuances_payment_id ON credit_issuances(institution_payment_id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='student_exam_entitlements' AND xtype='U')
BEGIN
    CREATE TABLE student_exam_entitlements (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        main_examination_id INT NOT NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'reserved', -- reserved | consumed | released
        allocated_by INT NULL,
        allocated_at DATETIME NOT NULL DEFAULT GETDATE(),
        consumed_at DATETIME NULL,
        released_at DATETIME NULL,
        release_reason NVARCHAR(300) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        updatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_student_exam_entitlements_status CHECK (status IN ('reserved','consumed','released')),
        CONSTRAINT FK_student_exam_entitlements_main_exam FOREIGN KEY (main_examination_id) REFERENCES main_examinations(id)
    );
    -- One ACTIVE (non-released) entitlement per student per exam — the
    -- DB-level backstop against duplicate allocation. A student CAN
    -- get a fresh entitlement after a prior one was released (e.g.
    -- re-admitted), since released rows are excluded from the filter.
    CREATE UNIQUE NONCLUSTERED INDEX UQ_student_exam_entitlements_active
        ON student_exam_entitlements(student_id, main_examination_id) WHERE status <> 'released';
    CREATE NONCLUSTERED INDEX IX_student_exam_entitlements_main_exam
        ON student_exam_entitlements(main_examination_id, status);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='institution_exam_billing_settings' AND xtype='U')
BEGIN
    CREATE TABLE institution_exam_billing_settings (
        id INT IDENTITY(1,1) PRIMARY KEY,
        main_examination_id INT NULL,                    -- NULL = institution-wide default fee
        student_fee_amount DECIMAL(18,2) NULL,
        currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
        updated_by INT NULL,
        updatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_institution_exam_billing_main_exam FOREIGN KEY (main_examination_id) REFERENCES main_examinations(id)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_institution_billing_default
        ON institution_exam_billing_settings(main_examination_id) WHERE main_examination_id IS NULL;
    CREATE UNIQUE NONCLUSTERED INDEX UQ_institution_billing_per_exam
        ON institution_exam_billing_settings(main_examination_id) WHERE main_examination_id IS NOT NULL;
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='student_exam_payments' AND xtype='U')
BEGIN
    CREATE TABLE student_exam_payments (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        main_examination_id INT NOT NULL,
        amount DECIMAL(18,2) NULL,
        currency NVARCHAR(3) NOT NULL DEFAULT 'KES',
        status NVARCHAR(20) NOT NULL DEFAULT 'unpaid',    -- unpaid | paid | waived
        payment_reference NVARCHAR(80) NULL,
        recorded_by INT NULL,
        recordedAt DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        updatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT CK_student_exam_payments_status CHECK (status IN ('unpaid','paid','waived')),
        CONSTRAINT FK_student_exam_payments_main_exam FOREIGN KEY (main_examination_id) REFERENCES main_examinations(id)
    );
    CREATE UNIQUE NONCLUSTERED INDEX UQ_student_exam_payments_student_exam ON student_exam_payments(student_id, main_examination_id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='finance_audit_log' AND xtype='U')
BEGIN
    CREATE TABLE finance_audit_log (
        id INT IDENTITY(1,1) PRIMARY KEY,
        action NVARCHAR(100) NOT NULL,
        institution_payment_id INT NULL,
        credit_issuance_id INT NULL,
        wallet_ledger_id INT NULL,
        actor_id INT NULL,
        actor_role NVARCHAR(30) NULL,
        details NVARCHAR(MAX) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

-- Finance role support on the existing Users table (role='finance',
-- same JWT/bcrypt auth every other role already uses — see the Phase 1
-- audit's Option A decision). NULL/0 default is a no-op for every
-- existing account.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'mfaSecret' AND Object_ID = Object_ID(N'Users'))
    ALTER TABLE Users ADD mfaSecret NVARCHAR(100) NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'mfaEnabled' AND Object_ID = Object_ID(N'Users'))
    ALTER TABLE Users ADD mfaEnabled BIT NOT NULL DEFAULT 0;

-- ROLLBACK (manual reference only — see warning above):
-- ALTER TABLE Users DROP COLUMN mfaEnabled;
-- ALTER TABLE Users DROP COLUMN mfaSecret;
-- DROP TABLE finance_audit_log;
-- DROP TABLE student_exam_payments;
-- DROP TABLE institution_exam_billing_settings;
-- DROP TABLE student_exam_entitlements;
-- DROP TABLE credit_issuances;
-- DROP TABLE institution_payments;
-- DROP TABLE wallet_ledger;
-- DROP TABLE institution_wallets;
