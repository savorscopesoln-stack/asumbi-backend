-- Adds a per-exam cover page (PDF) and per-question images to the
-- E-Assessment feature.
--
-- Why: teachers had no way to attach a title/instructions page to an
-- individual exam, and questions were text-only — no way to attach a
-- diagram or photo a question refers to.
--
-- This migration is additive and safe to run on a live database:
--   - e_assessments.cover_page_url is a new nullable column; existing
--     rows are unaffected.
--   - e_assessment_question_images is a new table only; nothing
--     existing is touched.
--   - backend/utils/ensureSchema.js also applies both of these
--     automatically on server boot if missing, so running this file
--     by hand is optional — provided for environments that prefer
--     explicit, reviewed migrations.

IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (
    SELECT * FROM sys.columns
    WHERE Name = N'cover_page_url' AND Object_ID = Object_ID(N'e_assessments')
)
BEGIN
    ALTER TABLE e_assessments ADD cover_page_url NVARCHAR(500) NULL;
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_question_images' AND xtype='U')
BEGIN
    CREATE TABLE e_assessment_question_images (
        id INT IDENTITY(1,1) PRIMARY KEY,
        question_id INT NOT NULL,
        image_url NVARCHAR(500) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END;
