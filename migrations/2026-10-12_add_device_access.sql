-- Rejected-device log + per-device allow-list for the "Desktop only" switch.
-- Also created automatically at startup by utils/ensureSchema.js — this file
-- is for running it by hand against a database.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_device_access' AND xtype='U')
CREATE TABLE e_assessment_device_access (
  id INT IDENTITY(1,1) PRIMARY KEY,
  e_assessment_id INT NOT NULL,
  student_id INT NOT NULL DEFAULT 0,
  device_key NVARCHAR(100) NOT NULL,
  platform NVARCHAR(30) NULL,
  user_agent NVARCHAR(400) NULL,
  ip NVARCHAR(64) NULL,
  reason NVARCHAR(200) NULL,
  attempts INT NOT NULL DEFAULT 1,
  first_seen DATETIME NOT NULL DEFAULT GETDATE(),
  last_seen DATETIME NOT NULL DEFAULT GETDATE(),
  status NVARCHAR(10) NOT NULL DEFAULT 'blocked',
  allowed_by INT NULL,
  allowed_at DATETIME NULL
);
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_device_access' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.indexes WHERE name = N'UX_e_assessment_device_access' AND object_id = Object_ID(N'e_assessment_device_access'))
CREATE UNIQUE INDEX UX_e_assessment_device_access ON e_assessment_device_access (e_assessment_id, student_id, device_key);
