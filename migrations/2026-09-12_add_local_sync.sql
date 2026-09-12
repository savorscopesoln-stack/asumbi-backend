-- Adds "Local Sync" support to the E-Assessment feature: lets a
-- lightweight, offline-capable local exam server pull an assessment
-- package (questions + roster) and later push collected results back.
--
-- Why: schools without reliable internet during the exam window need
-- students to sit exams on a LAN server, then sync results once
-- connectivity returns. Each physical local server is registered here
-- as a "sync device" scoped to specific assessments (not a full
-- teacher/admin login), so a compromised or lost local machine only
-- exposes the assessments it was explicitly authorized for.
--
-- This migration is additive and safe to run on a live database.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_sync_devices' AND xtype='U')
BEGIN
    CREATE TABLE e_assessment_sync_devices (
        id INT IDENTITY(1,1) PRIMARY KEY,
        device_name NVARCHAR(200) NOT NULL,
        token_hash NVARCHAR(128) NOT NULL,        -- sha256 of the raw token; raw token is shown once, never stored
        created_by INT NULL,                       -- user id of the admin/teacher who registered it
        is_active BIT NOT NULL DEFAULT 1,
        last_pull_at DATETIME NULL,
        last_push_at DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

-- Which assessments a given device is authorized to pull/push (the
-- "modular — only the module it needs" scoping).
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_sync_device_assessments' AND xtype='U')
BEGIN
    CREATE TABLE e_assessment_sync_device_assessments (
        id INT IDENTITY(1,1) PRIMARY KEY,
        device_id INT NOT NULL,
        e_assessment_id INT NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_sync_device_assessment UNIQUE (device_id, e_assessment_id)
    );
END;

-- Audit trail of every pull/push, and a de-dupe guard so re-running a
-- push after a network hiccup doesn't double-insert submissions.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_sync_logs' AND xtype='U')
BEGIN
    CREATE TABLE e_assessment_sync_logs (
        id INT IDENTITY(1,1) PRIMARY KEY,
        device_id INT NOT NULL,
        e_assessment_id INT NULL,
        direction NVARCHAR(10) NOT NULL,           -- 'pull' | 'push'
        batch_id NVARCHAR(64) NULL,                -- idempotency key the local server generates per push
        record_count INT NOT NULL DEFAULT 0,
        status NVARCHAR(20) NOT NULL DEFAULT 'ok', -- 'ok' | 'error' | 'duplicate'
        message NVARCHAR(500) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

-- Lets a push be replayed safely (network drop mid-upload) without
-- creating duplicate submissions.
IF NOT EXISTS (
    SELECT * FROM sys.columns
    WHERE Name = N'sync_batch_id' AND Object_ID = Object_ID(N'e_assessment_submissions')
)
BEGIN
    ALTER TABLE e_assessment_submissions ADD sync_batch_id NVARCHAR(64) NULL;
END;
