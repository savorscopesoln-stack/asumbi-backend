-- Music paper marking: marker annotations on drawings + model-answer sheet.
-- Also created automatically at startup by utils/ensureSchema.js.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_answers' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'music_annotations' AND Object_ID = Object_ID(N'e_assessment_answers'))
ALTER TABLE e_assessment_answers ADD music_annotations NVARCHAR(MAX) NULL;
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_questions' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'model_answer_sheet' AND Object_ID = Object_ID(N'e_assessment_questions'))
ALTER TABLE e_assessment_questions ADD model_answer_sheet NVARCHAR(MAX) NULL;
