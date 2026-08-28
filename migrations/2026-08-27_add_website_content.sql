-- Adds the website_content table backing the public marketing site's
-- editable sections (announcements, hero, principal, stats,
-- milestones, news, testimonials, faqs).
--
-- Why: the public Next.js website previously had all of its copy
-- hardcoded in lib/data.ts + a few components — any change needed a
-- code edit and redeploy. This table lets the admin portal's new
-- Website page edit that copy directly; the public site reads it via
-- GET /api/website (public, unauthenticated) at request time.
--
-- This migration is additive and safe to run on a live database:
--   - Creates one new table only; nothing existing is touched.
--   - backend/utils/ensureSchema.js also creates this table
--     automatically on server boot if it's missing, AND seeds the
--     default rows below — so running this migration by hand is
--     optional. It's provided for environments that prefer explicit,
--     reviewed migrations over the app's own idempotent startup check.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='website_content' AND xtype='U')
BEGIN
    CREATE TABLE website_content (
        id INT IDENTITY(1,1) PRIMARY KEY,
        section_key NVARCHAR(50) NOT NULL UNIQUE,
        content_json NVARCHAR(MAX) NOT NULL,
        updated_by_id INT NULL,
        updated_by_name NVARCHAR(200) NULL,
        updated_at DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

-- Default rows are seeded automatically by ensureSchema.js on next
-- server boot (INSERT ... WHERE NOT EXISTS per section_key), so no
-- default-content INSERTs are duplicated here — running this file
-- then starting the server once is enough to get identical defaults
-- to what the public site currently ships with.
