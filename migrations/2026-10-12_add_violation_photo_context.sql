-- Adds question + screenshot context to the E-Assessment camera photos.
-- Safe to run repeatedly; ensureSchema.js also applies it on server boot.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_violation_photos' AND xtype='U')
BEGIN
  IF COL_LENGTH('e_assessment_violation_photos','question_id') IS NULL
    ALTER TABLE e_assessment_violation_photos ADD question_id INT NULL;
  IF COL_LENGTH('e_assessment_violation_photos','question_number') IS NULL
    ALTER TABLE e_assessment_violation_photos ADD question_number INT NULL;
  IF COL_LENGTH('e_assessment_violation_photos','question_text') IS NULL
    ALTER TABLE e_assessment_violation_photos ADD question_text NVARCHAR(MAX) NULL;
  IF COL_LENGTH('e_assessment_violation_photos','answer_text') IS NULL
    ALTER TABLE e_assessment_violation_photos ADD answer_text NVARCHAR(MAX) NULL;
  IF COL_LENGTH('e_assessment_violation_photos','screenshot_url') IS NULL
    ALTER TABLE e_assessment_violation_photos ADD screenshot_url NVARCHAR(500) NULL;
END;
