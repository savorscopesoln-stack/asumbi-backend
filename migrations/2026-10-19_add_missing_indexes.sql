-- 2026-10-19 — add missing indexes
--
-- GENERATED from backend/utils/indexSpecs.js by
-- backend/scripts/generateIndexMigration.js — do not edit by hand
-- (tests/indexSpecs.test.js fails if this file and the code disagree).
--
-- Idempotent and non-destructive: plain CREATE NONCLUSTERED INDEX only.
-- Each index is skipped when its table/columns don't exist, when an index of
-- the same name exists, or when an existing index / UNIQUE constraint already
-- leads with the same key columns. A failure on one index never stops the rest.
-- The same indexes are also created automatically at server start-up by
-- ensureSchema() -> ensureIndexes(), so running this by hand is optional
-- (useful to build them off-hours on a large production database).

-- IX_Notifications_recipient_created
IF OBJECT_ID(N'Notifications', N'U') IS NOT NULL
  AND COL_LENGTH(N'Notifications', N'recipientId') IS NOT NULL
  AND COL_LENGTH(N'Notifications', N'recipientSource') IS NOT NULL
  AND COL_LENGTH(N'Notifications', N'createdAt') IS NOT NULL
  AND COL_LENGTH(N'Notifications', N'isRead') IS NOT NULL
  AND COL_LENGTH(N'Notifications', N'archivedAt') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Notifications_recipient_created' AND object_id = OBJECT_ID(N'Notifications'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Notifications') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'recipientId')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'recipientSource')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic2
        JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
        WHERE ic2.object_id = ix.object_id AND ic2.index_id = ix.index_id
          AND ic2.key_ordinal = 3 AND c2.name = N'createdAt')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Notifications_recipient_created ON Notifications (recipientId, recipientSource, createdAt DESC) INCLUDE (isRead, archivedAt)');
    PRINT N'created IX_Notifications_recipient_created';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Notifications_recipient_created: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ScheduledNotifications_status_scheduledFor
IF OBJECT_ID(N'ScheduledNotifications', N'U') IS NOT NULL
  AND COL_LENGTH(N'ScheduledNotifications', N'status') IS NOT NULL
  AND COL_LENGTH(N'ScheduledNotifications', N'scheduledFor') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ScheduledNotifications_status_scheduledFor' AND object_id = OBJECT_ID(N'ScheduledNotifications'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'ScheduledNotifications') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'status')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'scheduledFor')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ScheduledNotifications_status_scheduledFor ON ScheduledNotifications (status, scheduledFor)');
    PRINT N'created IX_ScheduledNotifications_status_scheduledFor';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ScheduledNotifications_status_scheduledFor: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_contact_messages_createdAt
IF OBJECT_ID(N'contact_messages', N'U') IS NOT NULL
  AND COL_LENGTH(N'contact_messages', N'createdAt') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_contact_messages_createdAt' AND object_id = OBJECT_ID(N'contact_messages'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'contact_messages') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'createdAt')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_contact_messages_createdAt ON contact_messages (createdAt DESC)');
    PRINT N'created IX_contact_messages_createdAt';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_contact_messages_createdAt: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_leave_outs_student
IF OBJECT_ID(N'leave_outs', N'U') IS NOT NULL
  AND COL_LENGTH(N'leave_outs', N'student_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_leave_outs_student' AND object_id = OBJECT_ID(N'leave_outs'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'leave_outs') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_leave_outs_student ON leave_outs (student_id)');
    PRINT N'created IX_leave_outs_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_leave_outs_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_leave_outs_status_approved
IF OBJECT_ID(N'leave_outs', N'U') IS NOT NULL
  AND COL_LENGTH(N'leave_outs', N'status') IS NOT NULL
  AND COL_LENGTH(N'leave_outs', N'approved_at') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_leave_outs_status_approved' AND object_id = OBJECT_ID(N'leave_outs'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'leave_outs') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'status')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'approved_at')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_leave_outs_status_approved ON leave_outs (status, approved_at DESC)');
    PRINT N'created IX_leave_outs_status_approved';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_leave_outs_status_approved: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_leave_outs_gate_code
IF OBJECT_ID(N'leave_outs', N'U') IS NOT NULL
  AND COL_LENGTH(N'leave_outs', N'gate_code') IS NOT NULL
  AND COL_LENGTH(N'leave_outs', N'reentry_time') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_leave_outs_gate_code' AND object_id = OBJECT_ID(N'leave_outs'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'leave_outs') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'gate_code')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_leave_outs_gate_code ON leave_outs (gate_code) INCLUDE (reentry_time)');
    PRINT N'created IX_leave_outs_gate_code';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_leave_outs_gate_code: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_meal_daily_codes_date_code
IF OBJECT_ID(N'meal_daily_codes', N'U') IS NOT NULL
  AND COL_LENGTH(N'meal_daily_codes', N'code_date') IS NOT NULL
  AND COL_LENGTH(N'meal_daily_codes', N'code') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_meal_daily_codes_date_code' AND object_id = OBJECT_ID(N'meal_daily_codes'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'meal_daily_codes') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'code_date')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'code')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_meal_daily_codes_date_code ON meal_daily_codes (code_date, code)');
    PRINT N'created IX_meal_daily_codes_date_code';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_meal_daily_codes_date_code: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_meal_cards_student_status
IF OBJECT_ID(N'meal_cards', N'U') IS NOT NULL
  AND COL_LENGTH(N'meal_cards', N'student_id') IS NOT NULL
  AND COL_LENGTH(N'meal_cards', N'status') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_meal_cards_student_status' AND object_id = OBJECT_ID(N'meal_cards'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'meal_cards') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'status')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_meal_cards_student_status ON meal_cards (student_id, status)');
    PRINT N'created IX_meal_cards_student_status';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_meal_cards_student_status: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Attendance_date_session_student
IF OBJECT_ID(N'Attendance', N'U') IS NOT NULL
  AND COL_LENGTH(N'Attendance', N'attendanceDate') IS NOT NULL
  AND COL_LENGTH(N'Attendance', N'session') IS NOT NULL
  AND COL_LENGTH(N'Attendance', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Attendance_date_session_student' AND object_id = OBJECT_ID(N'Attendance'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Attendance') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'attendanceDate')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'session')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic2
        JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
        WHERE ic2.object_id = ix.object_id AND ic2.index_id = ix.index_id
          AND ic2.key_ordinal = 3 AND c2.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Attendance_date_session_student ON Attendance (attendanceDate, session, studentId)');
    PRINT N'created IX_Attendance_date_session_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Attendance_date_session_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Fees_studentId
IF OBJECT_ID(N'Fees', N'U') IS NOT NULL
  AND COL_LENGTH(N'Fees', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Fees_studentId' AND object_id = OBJECT_ID(N'Fees'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Fees') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Fees_studentId ON Fees (studentId)');
    PRINT N'created IX_Fees_studentId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Fees_studentId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Graduations_studentId
IF OBJECT_ID(N'Graduations', N'U') IS NOT NULL
  AND COL_LENGTH(N'Graduations', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Graduations_studentId' AND object_id = OBJECT_ID(N'Graduations'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Graduations') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Graduations_studentId ON Graduations (studentId)');
    PRINT N'created IX_Graduations_studentId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Graduations_studentId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_spcr_student_status
IF OBJECT_ID(N'student_profile_change_requests', N'U') IS NOT NULL
  AND COL_LENGTH(N'student_profile_change_requests', N'student_id') IS NOT NULL
  AND COL_LENGTH(N'student_profile_change_requests', N'status') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_spcr_student_status' AND object_id = OBJECT_ID(N'student_profile_change_requests'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'student_profile_change_requests') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'status')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_spcr_student_status ON student_profile_change_requests (student_id, status)');
    PRINT N'created IX_spcr_student_status';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_spcr_student_status: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_spcr_status_requested
IF OBJECT_ID(N'student_profile_change_requests', N'U') IS NOT NULL
  AND COL_LENGTH(N'student_profile_change_requests', N'status') IS NOT NULL
  AND COL_LENGTH(N'student_profile_change_requests', N'requested_at') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_spcr_status_requested' AND object_id = OBJECT_ID(N'student_profile_change_requests'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'student_profile_change_requests') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'status')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'requested_at')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_spcr_status_requested ON student_profile_change_requests (status, requested_at DESC)');
    PRINT N'created IX_spcr_status_requested';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_spcr_status_requested: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Students_studentClass
IF OBJECT_ID(N'Students', N'U') IS NOT NULL
  AND COL_LENGTH(N'Students', N'studentClass') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Students_studentClass' AND object_id = OBJECT_ID(N'Students'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Students') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentClass')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Students_studentClass ON Students (studentClass)');
    PRINT N'created IX_Students_studentClass';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Students_studentClass: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Students_yearOfStudy
IF OBJECT_ID(N'Students', N'U') IS NOT NULL
  AND COL_LENGTH(N'Students', N'yearOfStudy') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Students_yearOfStudy' AND object_id = OBJECT_ID(N'Students'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Students') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'yearOfStudy')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Students_yearOfStudy ON Students (yearOfStudy)');
    PRINT N'created IX_Students_yearOfStudy';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Students_yearOfStudy: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Students_admissionNo
IF OBJECT_ID(N'Students', N'U') IS NOT NULL
  AND COL_LENGTH(N'Students', N'admissionNo') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Students_admissionNo' AND object_id = OBJECT_ID(N'Students'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Students') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'admissionNo')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Students_admissionNo ON Students (admissionNo)');
    PRINT N'created IX_Students_admissionNo';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Students_admissionNo: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Students_status
IF OBJECT_ID(N'Students', N'U') IS NOT NULL
  AND COL_LENGTH(N'Students', N'status') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Students_status' AND object_id = OBJECT_ID(N'Students'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Students') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'status')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Students_status ON Students (status)');
    PRINT N'created IX_Students_status';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Students_status: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Teachers_staffId
IF OBJECT_ID(N'Teachers', N'U') IS NOT NULL
  AND COL_LENGTH(N'Teachers', N'staffId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Teachers_staffId' AND object_id = OBJECT_ID(N'Teachers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Teachers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'staffId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Teachers_staffId ON Teachers (staffId)');
    PRINT N'created IX_Teachers_staffId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Teachers_staffId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Teachers_username
IF OBJECT_ID(N'Teachers', N'U') IS NOT NULL
  AND COL_LENGTH(N'Teachers', N'username') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Teachers_username' AND object_id = OBJECT_ID(N'Teachers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Teachers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'username')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Teachers_username ON Teachers (username)');
    PRINT N'created IX_Teachers_username';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Teachers_username: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Teachers_regionId
IF OBJECT_ID(N'Teachers', N'U') IS NOT NULL
  AND COL_LENGTH(N'Teachers', N'regionId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Teachers_regionId' AND object_id = OBJECT_ID(N'Teachers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Teachers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'regionId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Teachers_regionId ON Teachers (regionId)');
    PRINT N'created IX_Teachers_regionId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Teachers_regionId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Users_username
IF OBJECT_ID(N'Users', N'U') IS NOT NULL
  AND COL_LENGTH(N'Users', N'username') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Users_username' AND object_id = OBJECT_ID(N'Users'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Users') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'username')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Users_username ON Users (username)');
    PRINT N'created IX_Users_username';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Users_username: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Users_role
IF OBJECT_ID(N'Users', N'U') IS NOT NULL
  AND COL_LENGTH(N'Users', N'role') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Users_role' AND object_id = OBJECT_ID(N'Users'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Users') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'role')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Users_role ON Users (role)');
    PRINT N'created IX_Users_role';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Users_role: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Classes_name
IF OBJECT_ID(N'Classes', N'U') IS NOT NULL
  AND COL_LENGTH(N'Classes', N'name') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Classes_name' AND object_id = OBJECT_ID(N'Classes'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Classes') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'name')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Classes_name ON Classes (name)');
    PRINT N'created IX_Classes_name';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Classes_name: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Subjects_name
IF OBJECT_ID(N'Subjects', N'U') IS NOT NULL
  AND COL_LENGTH(N'Subjects', N'name') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Subjects_name' AND object_id = OBJECT_ID(N'Subjects'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Subjects') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'name')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Subjects_name ON Subjects (name)');
    PRINT N'created IX_Subjects_name';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Subjects_name: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_Schools_regionId
IF OBJECT_ID(N'Schools', N'U') IS NOT NULL
  AND COL_LENGTH(N'Schools', N'regionId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Schools_regionId' AND object_id = OBJECT_ID(N'Schools'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'Schools') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'regionId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_Schools_regionId ON Schools (regionId)');
    PRINT N'created IX_Schools_regionId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_Schools_regionId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ClassTeachers_className
IF OBJECT_ID(N'ClassTeachers', N'U') IS NOT NULL
  AND COL_LENGTH(N'ClassTeachers', N'className') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ClassTeachers_className' AND object_id = OBJECT_ID(N'ClassTeachers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'ClassTeachers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'className')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ClassTeachers_className ON ClassTeachers (className)');
    PRINT N'created IX_ClassTeachers_className';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ClassTeachers_className: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ClassTeachers_teacherId
IF OBJECT_ID(N'ClassTeachers', N'U') IS NOT NULL
  AND COL_LENGTH(N'ClassTeachers', N'teacherId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ClassTeachers_teacherId' AND object_id = OBJECT_ID(N'ClassTeachers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'ClassTeachers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacherId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ClassTeachers_teacherId ON ClassTeachers (teacherId)');
    PRINT N'created IX_ClassTeachers_teacherId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ClassTeachers_teacherId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_SchoolOfficials_teacherId
IF OBJECT_ID(N'SchoolOfficials', N'U') IS NOT NULL
  AND COL_LENGTH(N'SchoolOfficials', N'teacherId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SchoolOfficials_teacherId' AND object_id = OBJECT_ID(N'SchoolOfficials'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'SchoolOfficials') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacherId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_SchoolOfficials_teacherId ON SchoolOfficials (teacherId)');
    PRINT N'created IX_SchoolOfficials_teacherId';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_SchoolOfficials_teacherId: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_TeacherSubjects_teacher_subject_class
IF OBJECT_ID(N'TeacherSubjects', N'U') IS NOT NULL
  AND COL_LENGTH(N'TeacherSubjects', N'teacher_id') IS NOT NULL
  AND COL_LENGTH(N'TeacherSubjects', N'subject_id') IS NOT NULL
  AND COL_LENGTH(N'TeacherSubjects', N'class_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TeacherSubjects_teacher_subject_class' AND object_id = OBJECT_ID(N'TeacherSubjects'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'TeacherSubjects') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacher_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'subject_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic2
        JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
        WHERE ic2.object_id = ix.object_id AND ic2.index_id = ix.index_id
          AND ic2.key_ordinal = 3 AND c2.name = N'class_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_TeacherSubjects_teacher_subject_class ON TeacherSubjects (teacher_id, subject_id, class_id)');
    PRINT N'created IX_TeacherSubjects_teacher_subject_class';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_TeacherSubjects_teacher_subject_class: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_TeacherSubjects_class
IF OBJECT_ID(N'TeacherSubjects', N'U') IS NOT NULL
  AND COL_LENGTH(N'TeacherSubjects', N'class_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TeacherSubjects_class' AND object_id = OBJECT_ID(N'TeacherSubjects'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'TeacherSubjects') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'class_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_TeacherSubjects_class ON TeacherSubjects (class_id)');
    PRINT N'created IX_TeacherSubjects_class';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_TeacherSubjects_class: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_AssessmentStudents_assessment_student
IF OBJECT_ID(N'AssessmentStudents', N'U') IS NOT NULL
  AND COL_LENGTH(N'AssessmentStudents', N'assessmentId') IS NOT NULL
  AND COL_LENGTH(N'AssessmentStudents', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AssessmentStudents_assessment_student' AND object_id = OBJECT_ID(N'AssessmentStudents'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'AssessmentStudents') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'assessmentId')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_AssessmentStudents_assessment_student ON AssessmentStudents (assessmentId, studentId)');
    PRINT N'created IX_AssessmentStudents_assessment_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_AssessmentStudents_assessment_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_AssessmentStudents_student
IF OBJECT_ID(N'AssessmentStudents', N'U') IS NOT NULL
  AND COL_LENGTH(N'AssessmentStudents', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AssessmentStudents_student' AND object_id = OBJECT_ID(N'AssessmentStudents'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'AssessmentStudents') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_AssessmentStudents_student ON AssessmentStudents (studentId)');
    PRINT N'created IX_AssessmentStudents_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_AssessmentStudents_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_AssessmentSubjects_assessment_subject
IF OBJECT_ID(N'AssessmentSubjects', N'U') IS NOT NULL
  AND COL_LENGTH(N'AssessmentSubjects', N'assessmentId') IS NOT NULL
  AND COL_LENGTH(N'AssessmentSubjects', N'subjectId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AssessmentSubjects_assessment_subject' AND object_id = OBJECT_ID(N'AssessmentSubjects'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'AssessmentSubjects') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'assessmentId')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'subjectId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_AssessmentSubjects_assessment_subject ON AssessmentSubjects (assessmentId, subjectId)');
    PRINT N'created IX_AssessmentSubjects_assessment_subject';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_AssessmentSubjects_assessment_subject: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_PracticumAssignments_session_day_teacher
IF OBJECT_ID(N'PracticumAssignments', N'U') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'sessionId') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'day') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'teacherId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PracticumAssignments_session_day_teacher' AND object_id = OBJECT_ID(N'PracticumAssignments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'PracticumAssignments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'sessionId')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'day')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic2
        JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
        WHERE ic2.object_id = ix.object_id AND ic2.index_id = ix.index_id
          AND ic2.key_ordinal = 3 AND c2.name = N'teacherId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_PracticumAssignments_session_day_teacher ON PracticumAssignments (sessionId, day, teacherId)');
    PRINT N'created IX_PracticumAssignments_session_day_teacher';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_PracticumAssignments_session_day_teacher: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_PracticumAssignments_teacher_session
IF OBJECT_ID(N'PracticumAssignments', N'U') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'teacherId') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'sessionId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PracticumAssignments_teacher_session' AND object_id = OBJECT_ID(N'PracticumAssignments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'PracticumAssignments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacherId')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'sessionId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_PracticumAssignments_teacher_session ON PracticumAssignments (teacherId, sessionId)');
    PRINT N'created IX_PracticumAssignments_teacher_session';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_PracticumAssignments_teacher_session: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_PracticumAssignments_student
IF OBJECT_ID(N'PracticumAssignments', N'U') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssignments', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PracticumAssignments_student' AND object_id = OBJECT_ID(N'PracticumAssignments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'PracticumAssignments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_PracticumAssignments_student ON PracticumAssignments (studentId)');
    PRINT N'created IX_PracticumAssignments_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_PracticumAssignments_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_PracticumAssessments_assignment
IF OBJECT_ID(N'PracticumAssessments', N'U') IS NOT NULL
  AND COL_LENGTH(N'PracticumAssessments', N'assignmentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PracticumAssessments_assignment' AND object_id = OBJECT_ID(N'PracticumAssessments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'PracticumAssessments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'assignmentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_PracticumAssessments_assignment ON PracticumAssessments (assignmentId)');
    PRINT N'created IX_PracticumAssessments_assignment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_PracticumAssessments_assignment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_e_assessments_teacher
IF OBJECT_ID(N'e_assessments', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessments', N'teacher_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_e_assessments_teacher' AND object_id = OBJECT_ID(N'e_assessments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacher_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_e_assessments_teacher ON e_assessments (teacher_id)');
    PRINT N'created IX_e_assessments_teacher';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_e_assessments_teacher: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_e_assessments_available_until
IF OBJECT_ID(N'e_assessments', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessments', N'available_until') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_e_assessments_available_until' AND object_id = OBJECT_ID(N'e_assessments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'available_until')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_e_assessments_available_until ON e_assessments (available_until)');
    PRINT N'created IX_e_assessments_available_until';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_e_assessments_available_until: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_options_question
IF OBJECT_ID(N'e_assessment_options', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_options', N'question_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_options_question' AND object_id = OBJECT_ID(N'e_assessment_options'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_options') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'question_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_options_question ON e_assessment_options (question_id)');
    PRINT N'created IX_ea_options_question';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_options_question: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_question_images_question
IF OBJECT_ID(N'e_assessment_question_images', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_images', N'question_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_images', N'sort_order') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_question_images_question' AND object_id = OBJECT_ID(N'e_assessment_question_images'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_question_images') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'question_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'sort_order')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_question_images_question ON e_assessment_question_images (question_id, sort_order)');
    PRINT N'created IX_ea_question_images_question';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_question_images_question: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_answers_question
IF OBJECT_ID(N'e_assessment_answers', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_answers', N'question_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_answers_question' AND object_id = OBJECT_ID(N'e_assessment_answers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_answers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'question_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_answers_question ON e_assessment_answers (question_id)');
    PRINT N'created IX_ea_answers_question';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_answers_question: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_answers_marked_by
IF OBJECT_ID(N'e_assessment_answers', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_answers', N'marked_by') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_answers', N'submission_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_answers', N'marks_awarded') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_answers', N'marked_at') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_answers_marked_by' AND object_id = OBJECT_ID(N'e_assessment_answers'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_answers') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'marked_by')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_answers_marked_by ON e_assessment_answers (marked_by) INCLUDE (submission_id, marks_awarded, marked_at)');
    PRINT N'created IX_ea_answers_marked_by';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_answers_marked_by: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sub_student
IF OBJECT_ID(N'e_assessment_submissions', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_submissions', N'student_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_submissions', N'e_assessment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sub_student' AND object_id = OBJECT_ID(N'e_assessment_submissions'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_submissions') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sub_student ON e_assessment_submissions (student_id) INCLUDE (e_assessment_id)');
    PRINT N'created IX_ea_sub_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sub_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sessions_token
IF OBJECT_ID(N'e_assessment_exam_sessions', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_exam_sessions', N'token') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sessions_token' AND object_id = OBJECT_ID(N'e_assessment_exam_sessions'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_exam_sessions') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'token')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sessions_token ON e_assessment_exam_sessions (token)');
    PRINT N'created IX_ea_sessions_token';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sessions_token: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sessions_student_assessment
IF OBJECT_ID(N'e_assessment_exam_sessions', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_exam_sessions', N'student_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_exam_sessions', N'e_assessment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sessions_student_assessment' AND object_id = OBJECT_ID(N'e_assessment_exam_sessions'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_exam_sessions') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'e_assessment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sessions_student_assessment ON e_assessment_exam_sessions (student_id, e_assessment_id)');
    PRINT N'created IX_ea_sessions_student_assessment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sessions_student_assessment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_exam_subject_sessions_e_assessment
IF OBJECT_ID(N'exam_subject_sessions', N'U') IS NOT NULL
  AND COL_LENGTH(N'exam_subject_sessions', N'e_assessment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_exam_subject_sessions_e_assessment' AND object_id = OBJECT_ID(N'exam_subject_sessions'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'exam_subject_sessions') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'e_assessment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_exam_subject_sessions_e_assessment ON exam_subject_sessions (e_assessment_id)');
    PRINT N'created IX_exam_subject_sessions_e_assessment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_exam_subject_sessions_e_assessment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_allowed_students_student
IF OBJECT_ID(N'e_assessment_allowed_students', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_allowed_students', N'student_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_allowed_students_student' AND object_id = OBJECT_ID(N'e_assessment_allowed_students'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_allowed_students') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'student_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_allowed_students_student ON e_assessment_allowed_students (student_id)');
    PRINT N'created IX_ea_allowed_students_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_allowed_students_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_question_assignments_teacher
IF OBJECT_ID(N'e_assessment_question_assignments', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_assignments', N'teacher_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_assignments', N'e_assessment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_question_assignments_teacher' AND object_id = OBJECT_ID(N'e_assessment_question_assignments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_question_assignments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacher_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'e_assessment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_question_assignments_teacher ON e_assessment_question_assignments (teacher_id, e_assessment_id)');
    PRINT N'created IX_ea_question_assignments_teacher';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_question_assignments_teacher: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_question_setters_assessment_teacher
IF OBJECT_ID(N'e_assessment_question_setters', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_setters', N'e_assessment_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_setters', N'teacher_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_question_setters_assessment_teacher' AND object_id = OBJECT_ID(N'e_assessment_question_setters'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_question_setters') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'e_assessment_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'teacher_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_question_setters_assessment_teacher ON e_assessment_question_setters (e_assessment_id, teacher_id)');
    PRINT N'created IX_ea_question_setters_assessment_teacher';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_question_setters_assessment_teacher: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_question_setters_teacher
IF OBJECT_ID(N'e_assessment_question_setters', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_question_setters', N'teacher_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_question_setters_teacher' AND object_id = OBJECT_ID(N'e_assessment_question_setters'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_question_setters') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'teacher_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_question_setters_teacher ON e_assessment_question_setters (teacher_id)');
    PRINT N'created IX_ea_question_setters_teacher';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_question_setters_teacher: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_attempt_history_assessment_student
IF OBJECT_ID(N'e_assessment_attempt_history', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_attempt_history', N'e_assessment_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_attempt_history', N'student_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_attempt_history', N'attempt_no') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_attempt_history_assessment_student' AND object_id = OBJECT_ID(N'e_assessment_attempt_history'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_attempt_history') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'e_assessment_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'student_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic2
        JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
        WHERE ic2.object_id = ix.object_id AND ic2.index_id = ix.index_id
          AND ic2.key_ordinal = 3 AND c2.name = N'attempt_no')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_attempt_history_assessment_student ON e_assessment_attempt_history (e_assessment_id, student_id, attempt_no)');
    PRINT N'created IX_ea_attempt_history_assessment_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_attempt_history_assessment_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sync_devices_token
IF OBJECT_ID(N'e_assessment_sync_devices', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_devices', N'token_hash') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_devices', N'is_active') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_devices', N'tenant_key') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sync_devices_token' AND object_id = OBJECT_ID(N'e_assessment_sync_devices'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_sync_devices') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'token_hash')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sync_devices_token ON e_assessment_sync_devices (token_hash) INCLUDE (is_active, tenant_key)');
    PRINT N'created IX_ea_sync_devices_token';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sync_devices_token: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sync_device_assessments_assessment
IF OBJECT_ID(N'e_assessment_sync_device_assessments', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_device_assessments', N'e_assessment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sync_device_assessments_assessment' AND object_id = OBJECT_ID(N'e_assessment_sync_device_assessments'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_sync_device_assessments') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'e_assessment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sync_device_assessments_assessment ON e_assessment_sync_device_assessments (e_assessment_id)');
    PRINT N'created IX_ea_sync_device_assessments_assessment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sync_device_assessments_assessment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sync_logs_device_created
IF OBJECT_ID(N'e_assessment_sync_logs', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_logs', N'device_id') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_logs', N'createdAt') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sync_logs_device_created' AND object_id = OBJECT_ID(N'e_assessment_sync_logs'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_sync_logs') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'device_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'createdAt')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sync_logs_device_created ON e_assessment_sync_logs (device_id, createdAt DESC)');
    PRINT N'created IX_ea_sync_logs_device_created';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sync_logs_device_created: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_ea_sync_logs_created
IF OBJECT_ID(N'e_assessment_sync_logs', N'U') IS NOT NULL
  AND COL_LENGTH(N'e_assessment_sync_logs', N'createdAt') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ea_sync_logs_created' AND object_id = OBJECT_ID(N'e_assessment_sync_logs'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'e_assessment_sync_logs') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'createdAt')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_ea_sync_logs_created ON e_assessment_sync_logs (createdAt)');
    PRINT N'created IX_ea_sync_logs_created';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_ea_sync_logs_created: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_exam_audit_log_exam_created
IF OBJECT_ID(N'exam_audit_log', N'U') IS NOT NULL
  AND COL_LENGTH(N'exam_audit_log', N'main_examination_id') IS NOT NULL
  AND COL_LENGTH(N'exam_audit_log', N'createdAt') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_exam_audit_log_exam_created' AND object_id = OBJECT_ID(N'exam_audit_log'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'exam_audit_log') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'main_examination_id')
        AND EXISTS (SELECT 1 FROM sys.index_columns ic1
        JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
        WHERE ic1.object_id = ix.object_id AND ic1.index_id = ix.index_id
          AND ic1.key_ordinal = 2 AND c1.name = N'createdAt')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_exam_audit_log_exam_created ON exam_audit_log (main_examination_id, createdAt DESC)');
    PRINT N'created IX_exam_audit_log_exam_created';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_exam_audit_log_exam_created: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_exam_audit_log_session
IF OBJECT_ID(N'exam_audit_log', N'U') IS NOT NULL
  AND COL_LENGTH(N'exam_audit_log', N'exam_subject_session_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_exam_audit_log_session' AND object_id = OBJECT_ID(N'exam_audit_log'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'exam_audit_log') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'exam_subject_session_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_exam_audit_log_session ON exam_audit_log (exam_subject_session_id)');
    PRINT N'created IX_exam_audit_log_session';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_exam_audit_log_session: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_finance_audit_log_payment
IF OBJECT_ID(N'finance_audit_log', N'U') IS NOT NULL
  AND COL_LENGTH(N'finance_audit_log', N'institution_payment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_finance_audit_log_payment' AND object_id = OBJECT_ID(N'finance_audit_log'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'finance_audit_log') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'institution_payment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_finance_audit_log_payment ON finance_audit_log (institution_payment_id)');
    PRINT N'created IX_finance_audit_log_payment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_finance_audit_log_payment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_finance_invoices_payment
IF OBJECT_ID(N'finance_invoices', N'U') IS NOT NULL
  AND COL_LENGTH(N'finance_invoices', N'institution_payment_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_finance_invoices_payment' AND object_id = OBJECT_ID(N'finance_invoices'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'finance_invoices') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'institution_payment_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_finance_invoices_payment ON finance_invoices (institution_payment_id)');
    PRINT N'created IX_finance_invoices_payment';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_finance_invoices_payment: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_finance_receipts_invoice
IF OBJECT_ID(N'finance_receipts', N'U') IS NOT NULL
  AND COL_LENGTH(N'finance_receipts', N'invoice_id') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_finance_receipts_invoice' AND object_id = OBJECT_ID(N'finance_receipts'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'finance_receipts') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'invoice_id')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_finance_receipts_invoice ON finance_receipts (invoice_id)');
    PRINT N'created IX_finance_receipts_invoice';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_finance_receipts_invoice: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_apps_post
IF OBJECT_ID(N'election_applications', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_applications', N'postId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_apps_post' AND object_id = OBJECT_ID(N'election_applications'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_applications') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'postId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_apps_post ON election_applications (postId)');
    PRINT N'created IX_election_apps_post';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_apps_post: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_apps_student
IF OBJECT_ID(N'election_applications', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_applications', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_apps_student' AND object_id = OBJECT_ID(N'election_applications'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_applications') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_apps_student ON election_applications (studentId)');
    PRINT N'created IX_election_apps_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_apps_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_cand_application
IF OBJECT_ID(N'election_candidates', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_candidates', N'applicationId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_cand_application' AND object_id = OBJECT_ID(N'election_candidates'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_candidates') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'applicationId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_cand_application ON election_candidates (applicationId)');
    PRINT N'created IX_election_cand_application';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_cand_application: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_cand_party
IF OBJECT_ID(N'election_candidates', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_candidates', N'partyId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_cand_party' AND object_id = OBJECT_ID(N'election_candidates'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_candidates') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'partyId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_cand_party ON election_candidates (partyId)');
    PRINT N'created IX_election_cand_party';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_cand_party: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_cand_student
IF OBJECT_ID(N'election_candidates', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_candidates', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_cand_student' AND object_id = OBJECT_ID(N'election_candidates'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_candidates') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_cand_student ON election_candidates (studentId)');
    PRINT N'created IX_election_cand_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_cand_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_rm_student
IF OBJECT_ID(N'election_running_mates', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_running_mates', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_rm_student' AND object_id = OBJECT_ID(N'election_running_mates'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_running_mates') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_rm_student ON election_running_mates (studentId)');
    PRINT N'created IX_election_rm_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_rm_student: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_vi_election
IF OBJECT_ID(N'election_vote_items', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_vote_items', N'electionId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_vi_election' AND object_id = OBJECT_ID(N'election_vote_items'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_vote_items') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'electionId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_vi_election ON election_vote_items (electionId)');
    PRINT N'created IX_election_vi_election';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_vi_election: ' + ERROR_MESSAGE();
  END CATCH
END

-- IX_election_votes_student
IF OBJECT_ID(N'election_votes', N'U') IS NOT NULL
  AND COL_LENGTH(N'election_votes', N'studentId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_election_votes_student' AND object_id = OBJECT_ID(N'election_votes'))
  AND NOT EXISTS (
    SELECT 1 FROM sys.indexes ix
    WHERE ix.object_id = OBJECT_ID(N'election_votes') AND ix.index_id > 0
      AND EXISTS (SELECT 1 FROM sys.index_columns ic0
        JOIN sys.columns c0 ON c0.object_id = ic0.object_id AND c0.column_id = ic0.column_id
        WHERE ic0.object_id = ix.object_id AND ic0.index_id = ix.index_id
          AND ic0.key_ordinal = 1 AND c0.name = N'studentId')
  )
BEGIN
  BEGIN TRY
    EXEC(N'CREATE NONCLUSTERED INDEX IX_election_votes_student ON election_votes (studentId)');
    PRINT N'created IX_election_votes_student';
  END TRY
  BEGIN CATCH
    PRINT N'index skipped IX_election_votes_student: ' + ERROR_MESSAGE();
  END CATCH
END
