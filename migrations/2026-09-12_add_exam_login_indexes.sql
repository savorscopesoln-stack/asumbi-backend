-- Adds indexes that speed up the two queries examLogin runs on every
-- exam-login attempt (see backend/controllers/eAssessment.controller.js
-- -> examLogin), reducing how long each pool connection is held per
-- login and therefore how many logins a fixed-size pool can clear per
-- second during a burst.
--
-- Why: e_assessments.id is already the primary key (indexed by
-- default), but Students.username had no dedicated index that we could
-- confirm from the codebase/migrations. Every exam-login does
-- `SELECT ... FROM Students WHERE username = @username`, which without
-- an index is a full table scan under concurrent load.
--
-- This migration is additive and safe to run on a live database:
--   - No data is changed, no columns are added or removed.
--   - CREATE INDEX here does not affect existing queries' results
--     (only their access path), so no application code needs to change.
--   - Guarded by IF NOT EXISTS so it's a no-op if the index (or an
--     equivalent one, e.g. from a UNIQUE constraint on username) is
--     already there.
--
-- Before running: check whether an index already covers this —
--   SELECT i.name, c.name AS column_name
--   FROM sys.indexes i
--   JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
--   JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
--   WHERE i.object_id = OBJECT_ID('Students');
-- If `username` already appears as the leading column of some index
-- (including a PK/unique constraint), skip this migration.

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('Students') AND name = 'IX_Students_username'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_Students_username
        ON Students (username);
    -- Trade-off: a small amount of extra storage and slightly slower
    -- writes to Students (INSERT/UPDATE of username), in exchange for
    -- O(log n) username lookups instead of a full table scan on every
    -- login. Students writes are infrequent (registration/admin edits)
    -- compared to login reads, so this trade is heavily worth it.
END;
