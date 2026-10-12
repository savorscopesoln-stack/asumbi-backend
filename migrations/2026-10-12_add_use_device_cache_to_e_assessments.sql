-- Per-assessment "Device caching" switch (1 = ON, 0 = OFF). Default ON so
-- existing assessments behave exactly as before. Also created automatically
-- at startup by utils/ensureSchema.js - this file is for running it by hand.
IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
AND NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'use_device_cache' AND Object_ID = Object_ID(N'e_assessments'))
  ALTER TABLE e_assessments ADD use_device_cache BIT NOT NULL CONSTRAINT DF_e_assessments_use_device_cache DEFAULT 1;
