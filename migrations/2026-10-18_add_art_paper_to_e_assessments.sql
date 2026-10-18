-- "Art & Craft paper" switch: when 1, students get the drawing / colouring pad
-- on the essay questions. Same storage as the music paper (PNG inside the answer).
IF EXISTS (SELECT * FROM sysobjects WHERE name = 'e_assessments' AND xtype = 'U')
AND NOT EXISTS (
  SELECT * FROM sys.columns
  WHERE Name = N'art_paper' AND Object_ID = Object_ID(N'e_assessments')
)
ALTER TABLE e_assessments ADD art_paper BIT NOT NULL CONSTRAINT DF_e_assessments_art_paper DEFAULT 0;
