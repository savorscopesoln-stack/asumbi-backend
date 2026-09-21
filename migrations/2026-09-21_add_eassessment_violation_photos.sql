-- Adds evidence-photo storage for the E-Assessment webcam eye/gaze check.
--
-- Why: TakeEAssessment.jsx's camera-based "eyes off screen" check used to
-- count toward the same 3-strikes lockout as tab-switching, devtools, etc.
-- That's changed — a camera-based flag never locks the exam by itself now
-- (a false positive from bad lighting or a webcam blip shouldn't cost a
-- student their sitting). Instead it continuously captures a timestamped,
-- captioned snapshot from the student's own camera every time their eyes
-- are off the screen, for an admin/invigilator to review afterward.
--
-- This migration is additive and safe to run on a live database:
--   - e_assessment_violation_photos is a new table only; nothing existing
--     is touched.
--   - backend/utils/ensureSchema.js also applies this automatically on
--     server boot if missing, so running this file by hand is optional —
--     provided for environments that prefer explicit, reviewed migrations.

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_violation_photos' AND xtype='U')
BEGIN
    CREATE TABLE e_assessment_violation_photos (
        id INT IDENTITY(1,1) PRIMARY KEY,
        session_id INT NOT NULL,
        e_assessment_id INT NOT NULL,
        student_id INT NOT NULL,
        device_id NVARCHAR(200) NULL,
        reason NVARCHAR(300) NULL,
        photo_url NVARCHAR(500) NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (
    SELECT * FROM sys.indexes
    WHERE name = 'IX_e_assessment_violation_photos_session'
    AND object_id = OBJECT_ID('e_assessment_violation_photos')
)
BEGIN
    CREATE INDEX IX_e_assessment_violation_photos_session
    ON e_assessment_violation_photos (session_id, createdAt DESC);
END;
