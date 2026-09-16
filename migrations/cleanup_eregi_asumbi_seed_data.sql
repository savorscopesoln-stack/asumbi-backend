-- ============================================================================
-- Cleanup: remove Asumbi's seed data that was accidentally written into the
-- eregi tenant database, before ensureSchema.js was made tenant-aware.
--
-- Run this ONCE, against the eregi database specifically (not the default
-- Asumbi database — double-check your connection/database context before
-- running). Safe to re-run: every statement only deletes/resets rows that
-- match Asumbi's exact seeded values, so it won't touch anything an eregi
-- admin has already edited through the app (those rows no longer match the
-- original seed values, so the WHERE clauses below simply won't match them).
-- ============================================================================

USE eregi;  -- <-- confirm this is actually eregi's database name before running
GO

-- ---------------------------------------------------------------------------
-- 1. SchoolSettings — reset row 1 back to blank so eregi's admin sees "not
--    configured yet" instead of Asumbi's identity, only if it still holds
--    exactly the seeded Asumbi values (i.e. nobody has already edited it).
-- ---------------------------------------------------------------------------
UPDATE SchoolSettings
SET schoolName = '',
    shortName = '',
    centreCode = NULL,
    address = NULL,
    phone = NULL,
    email = NULL
WHERE id = 1
  AND schoolName = 'Asumbi Teachers Training College'
  AND shortName = 'ASUMBI TTC'
  AND centreCode = 'ASB-214'
  AND email = 'knec@asumbi.ac.ke';

-- ---------------------------------------------------------------------------
-- 2. website_content — delete every section whose content still contains
--    Asumbi's seeded copy (updated_by_name = 'System (default)' marks a
--    row that has never been edited by an admin through the UI — anything
--    an eregi admin already changed will have a different updated_by_name
--    and is left untouched).
-- ---------------------------------------------------------------------------
DELETE FROM website_content_history
WHERE section_key IN (
  SELECT section_key FROM website_content
  WHERE updated_by_name = 'System (default)'
    AND content_json LIKE '%Asumbi%'
);

DELETE FROM website_content
WHERE updated_by_name = 'System (default)'
  AND content_json LIKE '%Asumbi%';

-- ---------------------------------------------------------------------------
-- 3. SchoolOfficials — NOT included here on purpose: its seeded rows
--    ('Dean of Curriculum' / 'Chief Principal', both with a NULL name)
--    contain no Asumbi-specific data, so there is nothing to clean up.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verify — should return 0 rows / blank values if the cleanup worked.
-- ---------------------------------------------------------------------------
SELECT * FROM SchoolSettings WHERE id = 1;
SELECT section_key, updated_by_name FROM website_content WHERE content_json LIKE '%Asumbi%';
