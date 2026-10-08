-- Split / concurrent papers: let one subject have several papers at the same time.
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'paper_label' AND Object_ID = Object_ID(N'exam_subject_sessions'))
    ALTER TABLE exam_subject_sessions ADD paper_label NVARCHAR(100) NULL;
IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'allow_concurrent' AND Object_ID = Object_ID(N'exam_subject_sessions'))
    ALTER TABLE exam_subject_sessions ADD allow_concurrent BIT NOT NULL DEFAULT 0;
