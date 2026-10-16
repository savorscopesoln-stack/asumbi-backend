-- "Music paper" switch: when 1, students get the drawing pad (staves, notes,
-- rests, free drawing) on the essay questions of this assessment. Also created
-- automatically at startup by utils/ensureSchema.js - this file is for running
-- it by hand against a database.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'music_paper' AND Object_ID = Object_ID(N'e_assessments')
)
ALTER TABLE e_assessments ADD music_paper BIT NOT NULL CONSTRAINT DF_e_assessments_music_paper DEFAULT 0;
