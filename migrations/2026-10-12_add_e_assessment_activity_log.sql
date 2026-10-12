-- E-Assessment activity log ("who did what, and when"). Also created
-- automatically at startup by utils/ensureSchema.js — this file is for
-- running it by hand against a database.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_activity_log' AND xtype='U')
CREATE TABLE e_assessment_activity_log (
  id BIGINT IDENTITY(1,1) PRIMARY KEY,
  created_at DATETIME NOT NULL DEFAULT GETDATE(),
  actor_id INT NULL, actor_role NVARCHAR(30) NULL, actor_username NVARCHAR(150) NULL,
  portal NVARCHAR(20) NULL, action NVARCHAR(60) NOT NULL, outcome NVARCHAR(20) NOT NULL DEFAULT 'success',
  http_status INT NULL, assessment_id INT NULL, student_id INT NULL, target_id INT NULL,
  ip NVARCHAR(64) NULL, device NVARCHAR(400) NULL, details NVARCHAR(MAX) NULL
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_ea_activity_created' AND object_id=OBJECT_ID('e_assessment_activity_log'))
  CREATE INDEX IX_ea_activity_created ON e_assessment_activity_log (created_at DESC);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_ea_activity_assessment' AND object_id=OBJECT_ID('e_assessment_activity_log'))
  CREATE INDEX IX_ea_activity_assessment ON e_assessment_activity_log (assessment_id, created_at DESC);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_ea_activity_actor' AND object_id=OBJECT_ID('e_assessment_activity_log'))
  CREATE INDEX IX_ea_activity_actor ON e_assessment_activity_log (actor_id, actor_role, created_at DESC);
