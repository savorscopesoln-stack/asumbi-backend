-- Per-assessment exam-security switches (1 = required/ON, 0 = turned OFF).
-- Also created automatically at startup by utils/ensureSchema.js - this file
-- is for running it by hand against a database.
DECLARE @cols TABLE (name sysname);
INSERT INTO @cols VALUES (N'require_camera'), (N'require_screen_share'), (N'require_fullscreen'), (N'lock_on_violations');

DECLARE @c sysname, @sql nvarchar(max);
DECLARE cur CURSOR FOR SELECT name FROM @cols;
OPEN cur; FETCH NEXT FROM cur INTO @c;
WHILE @@FETCH_STATUS = 0
BEGIN
  IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
  AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = @c AND Object_ID = Object_ID(N'e_assessments'))
  BEGIN
    SET @sql = N'ALTER TABLE e_assessments ADD ' + QUOTENAME(@c) + N' BIT NOT NULL CONSTRAINT ' + QUOTENAME(N'DF_e_assessments_' + @c) + N' DEFAULT 1';
    EXEC sp_executesql @sql;
  END
  FETCH NEXT FROM cur INTO @c;
END
CLOSE cur; DEALLOCATE cur;
