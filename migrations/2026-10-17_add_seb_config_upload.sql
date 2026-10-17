-- Admin-uploaded .seb configuration per assessment. Also created automatically
-- at startup by utils/ensureSchema.js.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_seb_configs' AND xtype='U')
CREATE TABLE e_assessment_seb_configs (
  assessment_id INT NOT NULL PRIMARY KEY,
  file_name NVARCHAR(255) NOT NULL,
  data VARBINARY(MAX) NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT GETDATE()
);
