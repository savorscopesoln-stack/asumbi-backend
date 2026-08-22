-- Adds real calendar-date tracking to practicum deployments.
--
-- Why: PracticumAssignments.day only ever stored a weekday NAME
-- ("Monday") or a session day number (1, 2, 3...). There was no way to
-- tell a one-off "extra day" deployment apart from a standing weekly
-- research-day deployment once both just say "Monday" — so a
-- date-based report couldn't distinguish "deployed once, on 25 Aug"
-- from "deployed every Monday, including 25 Aug".
--
-- This migration is additive and safe to run on a live database:
--   - Both new columns are nullable / defaulted, so existing rows are
--     unaffected and no existing query breaks.
--   - No data is deleted or rewritten.
--
-- Run this once against your SQL Server database before deploying the
-- updated backend code.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('PracticumAssignments') AND name = 'deployDate'
)
BEGIN
    ALTER TABLE PracticumAssignments ADD deployDate DATE NULL;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('PracticumAssignments') AND name = 'isExtra'
)
BEGIN
    ALTER TABLE PracticumAssignments ADD isExtra BIT NOT NULL CONSTRAINT DF_PracticumAssignments_isExtra DEFAULT (0);
END;
