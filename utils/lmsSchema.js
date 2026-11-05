/* =========================================================================
   LMS SCHEMA RUNNER  (L1.2, decision D-002 — owner chose the ensureSchema
   style: in-code, idempotent, additive, run at boot for every tenant DB).

   Differences from a bare ensureSchema block, kept on purpose (master prompt
   rule 5): every step has a numbered id, applied ids are recorded in
   `lms_schema_migrations`, a step that already ran is never run again, and
   `planLmsSchema()` / `node scripts/lmsMigrate.js --dry-run` show what WOULD
   run without changing anything. Steps may only CREATE tables/columns/indexes
   (guarded by IF NOT EXISTS) — never ALTER/DROP existing objects.

   Unlicensed schools also get these (empty) tables; that is the price of the
   ensureSchema style. Access to them stays blocked by requireModule('lms').
========================================================================= */
const crypto = require("crypto");

/* Append-only. Never edit or reorder a released step: add a new one. */
const STEPS = [
  {
    id: "001_lms_audit_and_settings",
    sql: [
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_audit_log' AND xtype='U')
       CREATE TABLE lms_audit_log (
         id BIGINT IDENTITY(1,1) PRIMARY KEY,
         actor_id INT NULL,
         actor_role NVARCHAR(30) NULL,
         action NVARCHAR(100) NOT NULL,
         entity NVARCHAR(60) NULL,
         entity_id NVARCHAR(60) NULL,
         details NVARCHAR(MAX) NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_audit_log_entity' AND object_id=OBJECT_ID('lms_audit_log'))
       CREATE INDEX IX_lms_audit_log_entity ON lms_audit_log (entity, entity_id, created_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_settings' AND xtype='U')
       CREATE TABLE lms_settings (
         setting_key NVARCHAR(100) NOT NULL PRIMARY KEY,
         value_json NVARCHAR(MAX) NULL,
         updated_by INT NULL,
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
    ],
  },
  {
    id: "002_lms_user_permissions",
    sql: [
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_user_permissions' AND xtype='U')
       CREATE TABLE lms_user_permissions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         user_source NVARCHAR(20) NOT NULL,
         user_id INT NOT NULL,
         permission_code NVARCHAR(60) NOT NULL,
         granted_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         CONSTRAINT UQ_lms_user_permissions UNIQUE (user_source, user_id, permission_code)
       )`,
    ],
  },
  {
    id: "003_lms_courses",
    sql: [
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_courses' AND xtype='U')
       CREATE TABLE lms_courses (
         id INT IDENTITY(1,1) PRIMARY KEY,
         code NVARCHAR(30) NOT NULL,
         title NVARCHAR(200) NOT NULL,
         description NVARCHAR(MAX) NULL,
         objectives_json NVARCHAR(MAX) NULL,
         academic_year INT NOT NULL,
         semester NVARCHAR(30) NULL,
         class_name NVARCHAR(50) NULL,
         programme NVARCHAR(100) NULL,
         cohort NVARCHAR(60) NULL,
         subject_id INT NULL,
         visibility NVARCHAR(20) NOT NULL DEFAULT 'enrolled_only',
         status NVARCHAR(20) NOT NULL DEFAULT 'draft',
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         published_at DATETIME2 NULL,
         archived_at DATETIME2 NULL,
         deleted_at DATETIME2 NULL
       )`,
      // one live course per code per academic year (soft-deleted rows do not block re-use)
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_courses_code_year' AND object_id=OBJECT_ID('lms_courses'))
       CREATE UNIQUE INDEX UX_lms_courses_code_year ON lms_courses (academic_year, code) WHERE deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_courses_status' AND object_id=OBJECT_ID('lms_courses'))
       CREATE INDEX IX_lms_courses_status ON lms_courses (status, academic_year, id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_staff' AND xtype='U')
       CREATE TABLE lms_course_staff (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         user_source NVARCHAR(20) NOT NULL,
         user_id INT NOT NULL,
         staff_role NVARCHAR(20) NOT NULL DEFAULT 'teacher',
         is_active BIT NOT NULL DEFAULT 1,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         CONSTRAINT UQ_lms_course_staff UNIQUE (course_id, user_source, user_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_course_staff_user' AND object_id=OBJECT_ID('lms_course_staff'))
       CREATE INDEX IX_lms_course_staff_user ON lms_course_staff (user_source, user_id, is_active, course_id)`,
    ],
  },
  {
    id: "004_lms_sections_and_calendar",
    sql: [
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_sections' AND xtype='U')
       CREATE TABLE lms_course_sections (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         summary NVARCHAR(1000) NULL,
         sort_order INT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_course_sections_course' AND object_id=OBJECT_ID('lms_course_sections'))
       CREATE INDEX IX_lms_course_sections_course ON lms_course_sections (course_id, deleted_at, sort_order, id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_events' AND xtype='U')
       CREATE TABLE lms_course_events (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         description NVARCHAR(1000) NULL,
         event_type NVARCHAR(20) NOT NULL DEFAULT 'event',
         starts_at DATETIME2 NOT NULL,
         ends_at DATETIME2 NULL,
         all_day BIT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_course_events_range' AND object_id=OBJECT_ID('lms_course_events'))
       CREATE INDEX IX_lms_course_events_range ON lms_course_events (course_id, deleted_at, starts_at, id)`,
    ],
  },
  {
    id: "005_lms_enrolments",
    sql: [
      // status: active | pending | withdrawn | transferred.  source: manual | bulk | class_list | self | transfer
      // student_id -> Students.id (no FK, decision D-005). One row per student per course; history is in lms_enrolment_history.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_enrolments' AND xtype='U')
       CREATE TABLE lms_course_enrolments (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         status NVARCHAR(20) NOT NULL DEFAULT 'active',
         source NVARCHAR(20) NOT NULL DEFAULT 'manual',
         enrolled_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         status_changed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         CONSTRAINT UQ_lms_course_enrolments UNIQUE (course_id, student_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_enrolments_student' AND object_id=OBJECT_ID('lms_course_enrolments'))
       CREATE INDEX IX_lms_enrolments_student ON lms_course_enrolments (student_id, status, course_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_enrolments_course_status' AND object_id=OBJECT_ID('lms_course_enrolments'))
       CREATE INDEX IX_lms_enrolments_course_status ON lms_course_enrolments (course_id, status, student_id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_enrolment_history' AND xtype='U')
       CREATE TABLE lms_enrolment_history (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         action NVARCHAR(30) NOT NULL,
         from_status NVARCHAR(20) NULL,
         to_status NVARCHAR(20) NULL,
         detail NVARCHAR(300) NULL,
         actor_source NVARCHAR(20) NULL,
         actor_id INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_enrolment_history_course' AND object_id=OBJECT_ID('lms_enrolment_history'))
       CREATE INDEX IX_lms_enrolment_history_course ON lms_enrolment_history (course_id, student_id, id)`,
    ],
  },
  {
    id: "006_lms_course_templates",
    sql: [
      // content_json = { course: {description, objectives, semester, programme, visibility}, sections: [{title, summary}] }.
      // A template never stores year, code, class, cohort, subject or people (those differ every time it is used).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_templates' AND xtype='U')
       CREATE TABLE lms_course_templates (
         id INT IDENTITY(1,1) PRIMARY KEY,
         name NVARCHAR(120) NOT NULL,
         description NVARCHAR(500) NULL,
         is_shared BIT NOT NULL DEFAULT 0,
         source_course_id INT NULL,
         content_json NVARCHAR(MAX) NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_course_templates_owner_name' AND object_id=OBJECT_ID('lms_course_templates'))
       CREATE UNIQUE INDEX UX_lms_course_templates_owner_name ON lms_course_templates (created_by_source, created_by, name) WHERE deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_course_templates_shared' AND object_id=OBJECT_ID('lms_course_templates'))
       CREATE INDEX IX_lms_course_templates_shared ON lms_course_templates (deleted_at, is_shared, name, id)`,
    ],
  },
  {
    id: "007_lms_course_approvals",
    sql: [
      // action: submitted | approved | returned | withdrawn. One row per step; the course's status lives on lms_courses.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_course_approvals' AND xtype='U')
       CREATE TABLE lms_course_approvals (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         action NVARCHAR(20) NOT NULL,
         reason NVARCHAR(500) NULL,
         actor_source NVARCHAR(20) NULL,
         actor_id INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_course_approvals_course' AND object_id=OBJECT_ID('lms_course_approvals'))
       CREATE INDEX IX_lms_course_approvals_course ON lms_course_approvals (course_id, id)`,
    ],
  },
  {
    id: "008_lms_lessons",
    sql: [
      // status: draft | published. content_version is bumped on every content save (optimistic concurrency: a stale editor gets a conflict, never overwrites).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_lessons' AND xtype='U')
       CREATE TABLE lms_lessons (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         section_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         summary NVARCHAR(1000) NULL,
         status NVARCHAR(20) NOT NULL DEFAULT 'draft',
         estimated_minutes INT NULL,
         sort_order INT NOT NULL DEFAULT 0,
         content_version INT NOT NULL DEFAULT 1,
         published_at DATETIME2 NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_lessons_course' AND object_id=OBJECT_ID('lms_lessons'))
       CREATE INDEX IX_lms_lessons_course ON lms_lessons (course_id, deleted_at, section_id, sort_order, id)`,
      // block_type: text | image | video | audio | file | link | embed | divider. html = sanitised rich text (text blocks only); data = small JSON (url, title, caption, alt ...).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_lesson_blocks' AND xtype='U')
       CREATE TABLE lms_lesson_blocks (
         id INT IDENTITY(1,1) PRIMARY KEY,
         lesson_id INT NOT NULL,
         course_id INT NOT NULL,
         block_type NVARCHAR(20) NOT NULL,
         sort_order INT NOT NULL DEFAULT 0,
         html NVARCHAR(MAX) NULL,
         data NVARCHAR(2000) NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_lesson_blocks_lesson' AND object_id=OBJECT_ID('lms_lesson_blocks'))
       CREATE INDEX IX_lms_lesson_blocks_lesson ON lms_lesson_blocks (lesson_id, sort_order, id)`,
    ],
  },
  {
    id: "009_lms_media",
    sql: [
      // One row per uploaded lesson file. url = /uploads/<school>/lms/<random name>; the stored name is random, original_name is display only.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_media_files' AND xtype='U')
       CREATE TABLE lms_media_files (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         stored_name NVARCHAR(200) NOT NULL,
         url NVARCHAR(400) NOT NULL,
         original_name NVARCHAR(200) NOT NULL,
         ext NVARCHAR(10) NOT NULL,
         kind NVARCHAR(20) NOT NULL,
         size_bytes BIGINT NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_media_files_course' AND object_id=OBJECT_ID('lms_media_files'))
       CREATE INDEX IX_lms_media_files_course ON lms_media_files (course_id, deleted_at, id)`,
    ],
  },
  {
    id: "010_lms_lesson_versions",
    sql: [
      // One snapshot per content save (blocks as JSON). Kept for restore; the live content stays in lms_lesson_blocks.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_lesson_versions' AND xtype='U')
       CREATE TABLE lms_lesson_versions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         lesson_id INT NOT NULL,
         course_id INT NOT NULL,
         version_no INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         label NVARCHAR(100) NULL,
         blocks_json NVARCHAR(MAX) NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_lesson_versions_lesson' AND object_id=OBJECT_ID('lms_lesson_versions'))
       CREATE UNIQUE INDEX IX_lms_lesson_versions_lesson ON lms_lesson_versions (lesson_id, version_no)`,
      // Scheduled publishing: a published lesson with a future publish_at stays hidden from students until that moment (checked at read time; no background job).
      `IF COL_LENGTH('lms_lessons', 'publish_at') IS NULL
       ALTER TABLE lms_lessons ADD publish_at DATETIME2 NULL`,
    ],
  },
  {
    id: "011_lms_lesson_progress",
    sql: [
      // Completion rule per lesson: NULL means 'mark_complete'. Allowed values are validated in code: view | mark_complete | min_time.
      `IF COL_LENGTH('lms_lessons', 'completion_rule') IS NULL
       ALTER TABLE lms_lessons ADD completion_rule NVARCHAR(20) NULL`,
      `IF COL_LENGTH('lms_lessons', 'min_minutes') IS NULL
       ALTER TABLE lms_lessons ADD min_minutes INT NULL`,
      // One row per (lesson, student). status: in_progress | completed. seconds_spent is SERVER-credited (never more than real elapsed time).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_lesson_progress' AND xtype='U')
       CREATE TABLE lms_lesson_progress (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         lesson_id INT NOT NULL,
         student_id INT NOT NULL,
         status NVARCHAR(20) NOT NULL DEFAULT 'in_progress',
         seconds_spent INT NOT NULL DEFAULT 0,
         view_count INT NOT NULL DEFAULT 1,
         first_viewed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         last_viewed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         completed_at DATETIME2 NULL,
         CONSTRAINT UQ_lms_lesson_progress UNIQUE (lesson_id, student_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_lesson_progress_student' AND object_id=OBJECT_ID('lms_lesson_progress'))
       CREATE INDEX IX_lms_lesson_progress_student ON lms_lesson_progress (course_id, student_id, status)`,
    ],
  },
  {
    id: "012_lms_lesson_prerequisites",
    sql: [
      // "lesson_id needs requires_lesson_id completed first". Same course only (checked in code); max 10 per lesson; no loops (checked in code).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_lesson_prerequisites' AND xtype='U')
       CREATE TABLE lms_lesson_prerequisites (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         lesson_id INT NOT NULL,
         requires_lesson_id INT NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         CONSTRAINT UQ_lms_lesson_prerequisites UNIQUE (lesson_id, requires_lesson_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_lesson_prerequisites_course' AND object_id=OBJECT_ID('lms_lesson_prerequisites'))
       CREATE INDEX IX_lms_lesson_prerequisites_course ON lms_lesson_prerequisites (course_id, lesson_id)`,
    ],
  },
  {
    id: "013_lms_learning_outcomes",
    sql: [
      // Lightweight outcomes list owned by the LMS (a curriculum module can later replace/sync it). Tree via parent_id (depth/loops checked in code).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_learning_outcomes' AND xtype='U')
       CREATE TABLE lms_learning_outcomes (
         id INT IDENTITY(1,1) PRIMARY KEY,
         code NVARCHAR(50) NOT NULL,
         title NVARCHAR(300) NOT NULL,
         description NVARCHAR(2000) NULL,
         parent_id INT NULL,
         source NVARCHAR(20) NOT NULL DEFAULT 'manual',
         version INT NOT NULL DEFAULT 1,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_learning_outcomes_code' AND object_id=OBJECT_ID('lms_learning_outcomes'))
       CREATE UNIQUE INDEX UX_lms_learning_outcomes_code ON lms_learning_outcomes (code) WHERE deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_learning_outcomes_parent' AND object_id=OBJECT_ID('lms_learning_outcomes'))
       CREATE INDEX IX_lms_learning_outcomes_parent ON lms_learning_outcomes (parent_id)`,
      // Tags: one table for every taggable thing (entity_type 'lesson' now; question/assignment/rubric_criterion in later phases).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_outcome_tags' AND xtype='U')
       CREATE TABLE lms_outcome_tags (
         id INT IDENTITY(1,1) PRIMARY KEY,
         outcome_id INT NOT NULL,
         entity_type NVARCHAR(30) NOT NULL,
         entity_id INT NOT NULL,
         course_id INT NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         CONSTRAINT UQ_lms_outcome_tags UNIQUE (outcome_id, entity_type, entity_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_outcome_tags_entity' AND object_id=OBJECT_ID('lms_outcome_tags'))
       CREATE INDEX IX_lms_outcome_tags_entity ON lms_outcome_tags (entity_type, entity_id, course_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_outcome_tags_course' AND object_id=OBJECT_ID('lms_outcome_tags'))
       CREATE INDEX IX_lms_outcome_tags_course ON lms_outcome_tags (course_id, outcome_id)`,
    ],
  },
  {
    id: "014_lms_announcements",
    sql: [
      // course_id NULL = school-wide announcement (LMS admins only). status: draft | published. Soft delete.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_announcements' AND xtype='U')
       CREATE TABLE lms_announcements (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         body NVARCHAR(4000) NOT NULL,
         status NVARCHAR(20) NOT NULL DEFAULT 'draft',
         pinned BIT NOT NULL DEFAULT 0,
         published_at DATETIME2 NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_announcements_course' AND object_id=OBJECT_ID('lms_announcements'))
       CREATE INDEX IX_lms_announcements_course ON lms_announcements (course_id, status, pinned, published_at)`,
    ],
  },
  {
    id: "015_lms_calendar_feeds",
    sql: [
      // One subscription feed per student. Only a SHA-256 hash of the secret is stored (the secret is shown once).
      // revoked_at set = feed switched off; creating a new feed clears it and replaces the hash (old link dies).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_calendar_feeds' AND xtype='U')
       CREATE TABLE lms_calendar_feeds (
         id INT IDENTITY(1,1) PRIMARY KEY,
         student_id INT NOT NULL,
         token_hash CHAR(64) NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         last_used_at DATETIME2 NULL,
         revoked_at DATETIME2 NULL,
         CONSTRAINT UQ_lms_calendar_feeds_student UNIQUE (student_id)
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_calendar_feeds_hash' AND object_id=OBJECT_ID('lms_calendar_feeds'))
       CREATE INDEX IX_lms_calendar_feeds_hash ON lms_calendar_feeds (token_hash)`,
    ],
  },
  {
    id: "016_lms_assignments",
    sql: [
      // Assignment DEFINITIONS (L5.1a). Submissions/files arrive in L5.2 as their own tables.
      // status: draft | published. work_mode is 'individual' only until groups exist (L8).
      // NULL late_policy / allowed_extensions / max_file_mb = use the school's LMS settings at read time.
      // attachments_json = [{url,name}] teacher files from the school's own lms upload folder.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_assignments' AND xtype='U')
       CREATE TABLE lms_assignments (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         section_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         instructions NVARCHAR(MAX) NOT NULL,
         status NVARCHAR(20) NOT NULL DEFAULT 'draft',
         published_at DATETIME2 NULL,
         available_from DATETIME2 NULL,
         due_at DATETIME2 NULL,
         cutoff_at DATETIME2 NULL,
         submission_type NVARCHAR(10) NOT NULL DEFAULT 'both',
         allowed_extensions NVARCHAR(400) NULL,
         max_file_mb INT NULL,
         max_files INT NOT NULL DEFAULT 5,
         max_attempts INT NOT NULL DEFAULT 1,
         late_policy NVARCHAR(10) NULL,
         late_penalty_percent INT NULL,
         max_points DECIMAL(7,2) NOT NULL DEFAULT 100,
         work_mode NVARCHAR(10) NOT NULL DEFAULT 'individual',
         attachments_json NVARCHAR(MAX) NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_assignments_course' AND object_id=OBJECT_ID('lms_assignments'))
       CREATE INDEX IX_lms_assignments_course ON lms_assignments (course_id, status, due_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_assignments_due' AND object_id=OBJECT_ID('lms_assignments'))
       CREATE INDEX IX_lms_assignments_due ON lms_assignments (due_at, status)`,
    ],
  },
  {
    id: "017_lms_submissions",
    sql: [
      // Student work (L5.2a, text). status: draft | submitted. One draft per student and assignment (filtered unique index);
      // attempt_no is unique per student and assignment. late_penalty_percent = SNAPSHOT of the rule at submit time.
      // Files arrive in L5.2b as their own table. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_submissions' AND xtype='U')
       CREATE TABLE lms_submissions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         attempt_no INT NOT NULL,
         status NVARCHAR(12) NOT NULL DEFAULT 'draft',
         body_text NVARCHAR(MAX) NULL,
         submitted_at DATETIME2 NULL,
         is_late BIT NOT NULL DEFAULT 0,
         late_penalty_percent INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_submissions_attempt' AND object_id=OBJECT_ID('lms_submissions'))
       CREATE UNIQUE INDEX UX_lms_submissions_attempt ON lms_submissions (assignment_id, student_id, attempt_no)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_submissions_draft' AND object_id=OBJECT_ID('lms_submissions'))
       CREATE UNIQUE INDEX UX_lms_submissions_draft ON lms_submissions (assignment_id, student_id) WHERE status = 'draft'`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submissions_student' AND object_id=OBJECT_ID('lms_submissions'))
       CREATE INDEX IX_lms_submissions_student ON lms_submissions (student_id, course_id, status)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submissions_assignment' AND object_id=OBJECT_ID('lms_submissions'))
       CREATE INDEX IX_lms_submissions_assignment ON lms_submissions (assignment_id, status, submitted_at)`,
    ],
  },
  {
    id: "018_lms_submission_files",
    sql: [
      // Files a student attached to ONE attempt (L5.2b). The bytes live in uploads/<school>/lms-private (never served statically);
      // stored_name is random. A removed file is soft-deleted; files of SUBMITTED attempts are never removed (history is kept).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_submission_files' AND xtype='U')
       CREATE TABLE lms_submission_files (
         id INT IDENTITY(1,1) PRIMARY KEY,
         submission_id INT NOT NULL,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         stored_name NVARCHAR(200) NOT NULL,
         original_name NVARCHAR(200) NOT NULL,
         ext NVARCHAR(10) NOT NULL,
         size_bytes BIGINT NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submission_files_submission' AND object_id=OBJECT_ID('lms_submission_files'))
       CREATE INDEX IX_lms_submission_files_submission ON lms_submission_files (submission_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submission_files_student' AND object_id=OBJECT_ID('lms_submission_files'))
       CREATE INDEX IX_lms_submission_files_student ON lms_submission_files (assignment_id, student_id, deleted_at)`,
    ],
  },
  {
    id: "019_lms_rubrics",
    sql: [
      // Rubrics (L5.3a). course_id NULL = the SCHOOL library (LMS admins write, teachers copy into a course). Soft delete.
      // A criterion's weight = the points available for it; each level carries points 0..weight (the top level = weight).
      // Criteria are unique by (rubric_id, position); levels by (criterion_id, position). Outcome tags use lms_outcome_tags
      // (entity_type 'rubric_criterion'; course_id 0 = school library). One rubric per assignment (lms_assignment_rubrics). No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_rubrics' AND xtype='U')
       CREATE TABLE lms_rubrics (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         description NVARCHAR(1000) NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_rubrics_course' AND object_id=OBJECT_ID('lms_rubrics'))
       CREATE INDEX IX_lms_rubrics_course ON lms_rubrics (course_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_rubric_criteria' AND xtype='U')
       CREATE TABLE lms_rubric_criteria (
         id INT IDENTITY(1,1) PRIMARY KEY,
         rubric_id INT NOT NULL,
         position INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         description NVARCHAR(500) NULL,
         weight DECIMAL(7,2) NOT NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_rubric_criteria_pos' AND object_id=OBJECT_ID('lms_rubric_criteria'))
       CREATE UNIQUE INDEX UX_lms_rubric_criteria_pos ON lms_rubric_criteria (rubric_id, position)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_rubric_levels' AND xtype='U')
       CREATE TABLE lms_rubric_levels (
         id INT IDENTITY(1,1) PRIMARY KEY,
         criterion_id INT NOT NULL,
         position INT NOT NULL,
         label NVARCHAR(100) NOT NULL,
         description NVARCHAR(500) NULL,
         points DECIMAL(7,2) NOT NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_rubric_levels_pos' AND object_id=OBJECT_ID('lms_rubric_levels'))
       CREATE UNIQUE INDEX UX_lms_rubric_levels_pos ON lms_rubric_levels (criterion_id, position)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_assignment_rubrics' AND xtype='U')
       CREATE TABLE lms_assignment_rubrics (
         id INT IDENTITY(1,1) PRIMARY KEY,
         assignment_id INT NOT NULL,
         rubric_id INT NOT NULL,
         course_id INT NOT NULL,
         attached_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_assignment_rubrics_assignment' AND object_id=OBJECT_ID('lms_assignment_rubrics'))
       CREATE UNIQUE INDEX UX_lms_assignment_rubrics_assignment ON lms_assignment_rubrics (assignment_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_assignment_rubrics_rubric' AND object_id=OBJECT_ID('lms_assignment_rubrics'))
       CREATE INDEX IX_lms_assignment_rubrics_rubric ON lms_assignment_rubrics (rubric_id)`,
    ],
  },
  {
    id: "020_lms_marking",
    sql: [
      // Marking (L5.4a). ONE grade row per SUBMITTED attempt (unique on submission_id). status: draft (teacher only) | returned (student sees it).
      // raw_points = before the late penalty; penalty_percent = SNAPSHOT copied from the submission; final_points = raw after penalty; max_points = SNAPSHOT of the
      // assignment's maxPoints at marking time. Rubric scores keep the chosen level's points as a snapshot. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_submission_grades' AND xtype='U')
       CREATE TABLE lms_submission_grades (
         id INT IDENTITY(1,1) PRIMARY KEY,
         submission_id INT NOT NULL,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         rubric_id INT NULL,
         raw_points DECIMAL(9,2) NOT NULL,
         penalty_percent INT NULL,
         final_points DECIMAL(9,2) NOT NULL,
         max_points DECIMAL(7,2) NOT NULL,
         comment NVARCHAR(4000) NULL,
         status NVARCHAR(10) NOT NULL DEFAULT 'draft',
         graded_by_source NVARCHAR(20) NULL,
         graded_by INT NULL,
         graded_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         returned_at DATETIME2 NULL,
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_submission_grades_submission' AND object_id=OBJECT_ID('lms_submission_grades'))
       CREATE UNIQUE INDEX UX_lms_submission_grades_submission ON lms_submission_grades (submission_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submission_grades_assignment' AND object_id=OBJECT_ID('lms_submission_grades'))
       CREATE INDEX IX_lms_submission_grades_assignment ON lms_submission_grades (assignment_id, status)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_submission_rubric_scores' AND xtype='U')
       CREATE TABLE lms_submission_rubric_scores (
         id INT IDENTITY(1,1) PRIMARY KEY,
         submission_id INT NOT NULL,
         criterion_id INT NOT NULL,
         level_position INT NOT NULL,
         points DECIMAL(7,2) NOT NULL,
         comment NVARCHAR(500) NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_submission_rubric_scores' AND object_id=OBJECT_ID('lms_submission_rubric_scores'))
       CREATE UNIQUE INDEX UX_lms_submission_rubric_scores ON lms_submission_rubric_scores (submission_id, criterion_id)`,
    ],
  },
  {
    id: "021_lms_grade_release",
    sql: [
      // Scheduled grade release (L5.4b-2, D-064/D-065). ONE row per assignment: at release_at every graded (draft) grade of the assignment's latest attempts
      // that was saved at or before that time becomes `returned`. The row is removed when the teacher cancels it BEFORE it passes. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_assignment_releases' AND xtype='U')
       CREATE TABLE lms_assignment_releases (
         id INT IDENTITY(1,1) PRIMARY KEY,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         release_at DATETIME2 NOT NULL,
         scheduled_by_source NVARCHAR(20) NULL,
         scheduled_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_assignment_releases_assignment' AND object_id=OBJECT_ID('lms_assignment_releases'))
       CREATE UNIQUE INDEX UX_lms_assignment_releases_assignment ON lms_assignment_releases (assignment_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_assignment_releases_course' AND object_id=OBJECT_ID('lms_assignment_releases'))
       CREATE INDEX IX_lms_assignment_releases_course ON lms_assignment_releases (course_id, release_at)`,
    ],
  },
  {
    id: "022_lms_student_release",
    sql: [
      // Per-student grade release override (L5.4b-3, owner Q36 = BOTH per assignment AND per student; D-066). At most one row per (assignment, student).
      // For work graded at or before release_at it REPLACES the assignment schedule for that student. Removed when cancelled BEFORE it passes. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_student_releases' AND xtype='U')
       CREATE TABLE lms_student_releases (
         id INT IDENTITY(1,1) PRIMARY KEY,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         release_at DATETIME2 NOT NULL,
         scheduled_by_source NVARCHAR(20) NULL,
         scheduled_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_student_releases_assignment_student' AND object_id=OBJECT_ID('lms_student_releases'))
       CREATE UNIQUE INDEX UX_lms_student_releases_assignment_student ON lms_student_releases (assignment_id, student_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_student_releases_course' AND object_id=OBJECT_ID('lms_student_releases'))
       CREATE INDEX IX_lms_student_releases_course ON lms_student_releases (course_id, release_at)`,
    ],
  },
  {
    id: "023_lms_extensions",
    sql: [
      // Per-learner deadline extension (L5.5, D-068). At most one row per (assignment, student). due_at is the learner's later due date; cutoff_at NULL = the assignment's own cutoff applies. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_extensions' AND xtype='U')
       CREATE TABLE lms_extensions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         assignment_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         due_at DATETIME2 NOT NULL,
         cutoff_at DATETIME2 NULL,
         reason NVARCHAR(500) NULL,
         granted_by_source NVARCHAR(20) NULL,
         granted_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_extensions_assignment_student' AND object_id=OBJECT_ID('lms_extensions'))
       CREATE UNIQUE INDEX UX_lms_extensions_assignment_student ON lms_extensions (assignment_id, student_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_extensions_student' AND object_id=OBJECT_ID('lms_extensions'))
       CREATE INDEX IX_lms_extensions_student ON lms_extensions (student_id, course_id)`,
    ],
  },
  {
    id: "024_lms_question_bank",
    sql: [
      // Question bank (L6.1b, D-073). ONE row per question; type-specific content (options, accepted answers, pairs, items, tolerance) is JSON in spec_json,
      // validated by utils/lmsQuizMarking.js before it is stored. scope: private (owner only) | course (staff of course_id) | school (any teacher can read).
      // `version` goes up on every save (optimistic locking); each version is copied to lms_question_versions. Soft delete. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_questions' AND xtype='U')
       CREATE TABLE lms_questions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         scope NVARCHAR(10) NOT NULL DEFAULT 'private',
         course_id INT NULL,
         owner_source NVARCHAR(20) NOT NULL,
         owner_id INT NOT NULL,
         type NVARCHAR(20) NOT NULL,
         stem NVARCHAR(4000) NOT NULL,
         explanation NVARCHAR(2000) NULL,
         points DECIMAL(6,2) NOT NULL DEFAULT 1,
         difficulty NVARCHAR(10) NULL,
         subject NVARCHAR(100) NULL,
         topic NVARCHAR(100) NULL,
         spec_json NVARCHAR(MAX) NOT NULL,
         version INT NOT NULL DEFAULT 1,
         source_system NVARCHAR(20) NULL,
         source_ref INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_questions_owner' AND object_id=OBJECT_ID('lms_questions'))
       CREATE INDEX IX_lms_questions_owner ON lms_questions (owner_source, owner_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_questions_scope' AND object_id=OBJECT_ID('lms_questions'))
       CREATE INDEX IX_lms_questions_scope ON lms_questions (scope, course_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_questions_filter' AND object_id=OBJECT_ID('lms_questions'))
       CREATE INDEX IX_lms_questions_filter ON lms_questions (subject, topic, type)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_question_versions' AND xtype='U')
       CREATE TABLE lms_question_versions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         question_id INT NOT NULL,
         version INT NOT NULL,
         type NVARCHAR(20) NOT NULL,
         stem NVARCHAR(4000) NOT NULL,
         explanation NVARCHAR(2000) NULL,
         points DECIMAL(6,2) NOT NULL,
         difficulty NVARCHAR(10) NULL,
         subject NVARCHAR(100) NULL,
         topic NVARCHAR(100) NULL,
         spec_json NVARCHAR(MAX) NOT NULL,
         changed_by_source NVARCHAR(20) NULL,
         changed_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         CONSTRAINT UQ_lms_question_versions UNIQUE (question_id, version)
       )`,
    ],
  },
  {
    id: "025_lms_quizzes",
    sql: [
      // Quiz definitions (L6.2a, D-076). A quiz belongs to one course. assessment_type is practice | coursework only: a controlled exam is NOT run in the LMS.
      // lms_quiz_questions holds SNAPSHOTS of bank questions (copied at add time, spec_json + version), so a later edit or delete in the bank never changes a quiz
      // or a marked attempt. source_question_id only remembers where the copy came from. No foreign keys (D-005). Attempts come in L6.2b.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_quizzes' AND xtype='U')
       CREATE TABLE lms_quizzes (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         section_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         instructions NVARCHAR(4000) NULL,
         assessment_type NVARCHAR(12) NOT NULL DEFAULT 'practice',
         status NVARCHAR(12) NOT NULL DEFAULT 'draft',
         published_at DATETIME2 NULL,
         available_from DATETIME2 NULL,
         due_at DATETIME2 NULL,
         time_limit_minutes INT NULL,
         max_attempts INT NOT NULL DEFAULT 1,
         shuffle_questions BIT NOT NULL DEFAULT 0,
         shuffle_options BIT NOT NULL DEFAULT 0,
         feedback_timing NVARCHAR(12) NOT NULL DEFAULT 'immediate',
         counts_to_grade BIT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quizzes_course' AND object_id=OBJECT_ID('lms_quizzes'))
       CREATE INDEX IX_lms_quizzes_course ON lms_quizzes (course_id, deleted_at, status)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_quiz_questions' AND xtype='U')
       CREATE TABLE lms_quiz_questions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         quiz_id INT NOT NULL,
         course_id INT NOT NULL,
         position INT NOT NULL,
         source_question_id INT NULL,
         source_version INT NULL,
         type NVARCHAR(20) NOT NULL,
         stem NVARCHAR(4000) NOT NULL,
         explanation NVARCHAR(2000) NULL,
         points DECIMAL(6,2) NOT NULL,
         difficulty NVARCHAR(10) NULL,
         spec_json NVARCHAR(MAX) NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quiz_questions_quiz' AND object_id=OBJECT_ID('lms_quiz_questions'))
       CREATE INDEX IX_lms_quiz_questions_quiz ON lms_quiz_questions (quiz_id, position)`,
    ],
  },
  {
    id: "026_lms_quiz_attempts",
    sql: [
      // Quiz attempts (L6.2b-1, D-077). One row per attempt; status in_progress -> submitted (essays still to mark) | graded (everything marked).
      // `seed` drives the per-attempt shuffle (question order, option order, matching/ordering display), so a reload shows the same screen.
      // `deadline_at` is computed ON THE SERVER at start (start + time limit, never later than the quiz due date). No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_quiz_attempts' AND xtype='U')
       CREATE TABLE lms_quiz_attempts (
         id INT IDENTITY(1,1) PRIMARY KEY,
         quiz_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         attempt_no INT NOT NULL,
         status NVARCHAR(12) NOT NULL DEFAULT 'in_progress',
         seed NVARCHAR(32) NOT NULL,
         started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deadline_at DATETIME2 NULL,
         submitted_at DATETIME2 NULL,
         auto_submitted BIT NOT NULL DEFAULT 0,
         auto_points DECIMAL(8,2) NULL,
         manual_points DECIMAL(8,2) NULL,
         total_points DECIMAL(8,2) NULL,
         max_points DECIMAL(8,2) NOT NULL DEFAULT 0,
         needs_marking BIT NOT NULL DEFAULT 0,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_quiz_attempts_no' AND object_id=OBJECT_ID('lms_quiz_attempts'))
       CREATE UNIQUE INDEX UX_lms_quiz_attempts_no ON lms_quiz_attempts (quiz_id, student_id, attempt_no)`,
      // At most ONE in-progress attempt per learner per quiz (a second tab or a double click cannot start two).
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_quiz_attempts_open' AND object_id=OBJECT_ID('lms_quiz_attempts'))
       CREATE UNIQUE INDEX UX_lms_quiz_attempts_open ON lms_quiz_attempts (quiz_id, student_id) WHERE status = 'in_progress'`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quiz_attempts_student' AND object_id=OBJECT_ID('lms_quiz_attempts'))
       CREATE INDEX IX_lms_quiz_attempts_student ON lms_quiz_attempts (student_id, course_id, status)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_quiz_answers' AND xtype='U')
       CREATE TABLE lms_quiz_answers (
         id INT IDENTITY(1,1) PRIMARY KEY,
         attempt_id INT NOT NULL,
         quiz_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         quiz_question_id INT NOT NULL,
         answer_json NVARCHAR(MAX) NULL,
         status NVARCHAR(12) NULL,
         points DECIMAL(6,2) NULL,
         max_points DECIMAL(6,2) NOT NULL DEFAULT 0,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_quiz_answers_q' AND object_id=OBJECT_ID('lms_quiz_answers'))
       CREATE UNIQUE INDEX UX_lms_quiz_answers_q ON lms_quiz_answers (attempt_id, quiz_question_id)`,
    ],
  },
  {
    id: "027_lms_quiz_marking",
    sql: [
      // Staff marking of written quiz answers (L6.2b-2, D-078). Additive only: four nullable columns on lms_quiz_answers.
      `IF COL_LENGTH('lms_quiz_answers', 'comment') IS NULL ALTER TABLE lms_quiz_answers ADD comment NVARCHAR(2000) NULL`,
      `IF COL_LENGTH('lms_quiz_answers', 'marked_by_source') IS NULL ALTER TABLE lms_quiz_answers ADD marked_by_source NVARCHAR(20) NULL`,
      `IF COL_LENGTH('lms_quiz_answers', 'marked_by') IS NULL ALTER TABLE lms_quiz_answers ADD marked_by INT NULL`,
      `IF COL_LENGTH('lms_quiz_answers', 'marked_at') IS NULL ALTER TABLE lms_quiz_answers ADD marked_at DATETIME2 NULL`,
      // The marking queue lists one quiz's submitted attempts by status.
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quiz_attempts_quiz' AND object_id=OBJECT_ID('lms_quiz_attempts'))
       CREATE INDEX IX_lms_quiz_attempts_quiz ON lms_quiz_attempts (quiz_id, course_id, status, submitted_at)`,
    ],
  },
  {
    id: "028_lms_quiz_rules",
    sql: [
      // Random selection from the question bank (L6.2c, D-080). Additive only.
      // lms_quiz_rules: "pick N questions matching these filters". points_each is REQUIRED so the quiz total is known before anyone starts.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_quiz_rules' AND xtype='U')
       CREATE TABLE lms_quiz_rules (
         id INT IDENTITY(1,1) PRIMARY KEY,
         quiz_id INT NOT NULL,
         course_id INT NOT NULL,
         position INT NOT NULL,
         pick_count INT NOT NULL,
         points_each DECIMAL(6,2) NOT NULL,
         q_type NVARCHAR(20) NULL,
         subject NVARCHAR(100) NULL,
         topic NVARCHAR(100) NULL,
         difficulty NVARCHAR(10) NULL,
         outcome_id INT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quiz_rules_quiz' AND object_id=OBJECT_ID('lms_quiz_rules'))
       CREATE INDEX IX_lms_quiz_rules_quiz ON lms_quiz_rules (quiz_id, course_id, position)`,
      // attempt_id NULL = the quiz's fixed question set; a value = a question PICKED for that one attempt (a frozen snapshot, so a bank edit never changes a marked attempt).
      `IF COL_LENGTH('lms_quiz_questions', 'attempt_id') IS NULL ALTER TABLE lms_quiz_questions ADD attempt_id INT NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_quiz_questions_attempt' AND object_id=OBJECT_ID('lms_quiz_questions'))
       CREATE INDEX IX_lms_quiz_questions_attempt ON lms_quiz_questions (attempt_id)`,
      // The same bank question can be picked only once per attempt (also guards two simultaneous "start" calls).
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_quiz_questions_pick' AND object_id=OBJECT_ID('lms_quiz_questions'))
       CREATE UNIQUE INDEX UX_lms_quiz_questions_pick ON lms_quiz_questions (attempt_id, source_question_id) WHERE attempt_id IS NOT NULL AND source_question_id IS NOT NULL`,
    ],
  },
  {
    id: "029_lms_quiz_mode",
    sql: [
      // Practice centre (L6.3a, D-081). NULL = a normal quiz; otherwise revision | mock. Additive, re-runnable.
      `IF COL_LENGTH('lms_quizzes', 'quiz_mode') IS NULL ALTER TABLE lms_quizzes ADD quiz_mode NVARCHAR(12) NULL`,
    ],
  },
  {
    id: "030_lms_flashcard_ratings",
    sql: [
      // Flashcards (L6.3b, D-082): ONE self-rating per learner per card; never touches marking or grades.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_flashcard_ratings' AND xtype='U')
       CREATE TABLE lms_flashcard_ratings (
         id INT IDENTITY(1,1) PRIMARY KEY,
         quiz_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         quiz_question_id INT NOT NULL,
         rating NVARCHAR(10) NOT NULL,
         rated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_flashcard_ratings_card' AND object_id=OBJECT_ID('lms_flashcard_ratings'))
       CREATE UNIQUE INDEX UX_lms_flashcard_ratings_card ON lms_flashcard_ratings (student_id, quiz_question_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_flashcard_ratings_quiz' AND object_id=OBJECT_ID('lms_flashcard_ratings'))
       CREATE INDEX IX_lms_flashcard_ratings_quiz ON lms_flashcard_ratings (quiz_id, course_id, student_id)`,
    ],
  },
  {
    id: "031_lms_gradebook",
    sql: [
      // Gradebook foundation (L7.1a, D-085). Categories (weights, drop-lowest), grade items (manual now; assignment/quiz links in L7.1c), one grade per learner per item,
      // and an append-only history of every change. No foreign keys (D-005). `source_type` + `source_id` make an item unique per source (filtered unique index).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_grade_categories' AND xtype='U')
       CREATE TABLE lms_grade_categories (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         name NVARCHAR(100) NOT NULL,
         weight DECIMAL(6,2) NOT NULL DEFAULT 0,
         drop_lowest INT NOT NULL DEFAULT 0,
         position INT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_grade_categories_course' AND object_id=OBJECT_ID('lms_grade_categories'))
       CREATE INDEX IX_lms_grade_categories_course ON lms_grade_categories (course_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_grade_items' AND xtype='U')
       CREATE TABLE lms_grade_items (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         category_id INT NULL,
         title NVARCHAR(200) NOT NULL,
         source_type NVARCHAR(12) NOT NULL DEFAULT 'manual',
         source_id INT NULL,
         max_points DECIMAL(8,2) NOT NULL,
         weight DECIMAL(6,2) NOT NULL DEFAULT 1,
         released BIT NOT NULL DEFAULT 0,
         position INT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_grade_items_course' AND object_id=OBJECT_ID('lms_grade_items'))
       CREATE INDEX IX_lms_grade_items_course ON lms_grade_items (course_id, deleted_at, category_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_grade_items_source' AND object_id=OBJECT_ID('lms_grade_items'))
       CREATE UNIQUE INDEX UX_lms_grade_items_source ON lms_grade_items (course_id, source_type, source_id) WHERE source_id IS NOT NULL AND deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_grades' AND xtype='U')
       CREATE TABLE lms_grades (
         id INT IDENTITY(1,1) PRIMARY KEY,
         item_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         points DECIMAL(8,2) NULL,
         excused BIT NOT NULL DEFAULT 0,
         comment NVARCHAR(1000) NULL,
         hidden BIT NOT NULL DEFAULT 0,
         graded_by_source NVARCHAR(20) NULL,
         graded_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_grades_item_student' AND object_id=OBJECT_ID('lms_grades'))
       CREATE UNIQUE INDEX UX_lms_grades_item_student ON lms_grades (item_id, student_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_grades_student' AND object_id=OBJECT_ID('lms_grades'))
       CREATE INDEX IX_lms_grades_student ON lms_grades (course_id, student_id)`,
      // Append-only: every change to a grade (points, excused, hidden, comment) writes one row here with the old and new values and the reason.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_grade_history' AND xtype='U')
       CREATE TABLE lms_grade_history (
         id INT IDENTITY(1,1) PRIMARY KEY,
         grade_id INT NOT NULL,
         item_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         old_points DECIMAL(8,2) NULL,
         new_points DECIMAL(8,2) NULL,
         old_excused BIT NULL,
         new_excused BIT NULL,
         reason NVARCHAR(300) NULL,
         changed_by_source NVARCHAR(20) NULL,
         changed_by INT NULL,
         changed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_grade_history_grade' AND object_id=OBJECT_ID('lms_grade_history'))
       CREATE INDEX IX_lms_grade_history_grade ON lms_grade_history (grade_id, changed_at)`,
    ],
  },
  {
    id: "032_lms_certificates",
    sql: [
      // Course-completion certificates (L7.5a, D-091). One ACTIVE certificate per learner per course (filtered unique index); a revoked one stays as a row (never deleted)
      // and the learner may be issued a new one. `code` is the public verification code (random, unique). No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_certificates' AND xtype='U')
       CREATE TABLE lms_certificates (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         code NVARCHAR(20) NOT NULL,
         final_percent DECIMAL(5,2) NULL,
         grade_label NVARCHAR(50) NULL,
         issued_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         issued_by_source NVARCHAR(20) NULL,
         issued_by INT NULL,
         revoked_at DATETIME2 NULL,
         revoked_reason NVARCHAR(300) NULL,
         revoked_by_source NVARCHAR(20) NULL,
         revoked_by INT NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_certificates_code' AND object_id=OBJECT_ID('lms_certificates'))
       CREATE UNIQUE INDEX UX_lms_certificates_code ON lms_certificates (code)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_certificates_active' AND object_id=OBJECT_ID('lms_certificates'))
       CREATE UNIQUE INDEX UX_lms_certificates_active ON lms_certificates (course_id, student_id) WHERE revoked_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_certificates_student' AND object_id=OBJECT_ID('lms_certificates'))
       CREATE INDEX IX_lms_certificates_student ON lms_certificates (student_id, course_id)`,
    ],
  },
  {
    id: "033_lms_badges",
    sql: [
      // Course badges (L7.5b, D-092). A badge is defined per course with ONE fixed rule (course_complete | grade_at_least | lessons_completed); an award is one row per
      // (badge, learner), unique. Badges are soft deleted, awards are never deleted. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_badges' AND xtype='U')
       CREATE TABLE lms_badges (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         name NVARCHAR(100) NOT NULL,
         description NVARCHAR(300) NULL,
         rule_type NVARCHAR(30) NOT NULL,
         rule_value INT NULL,
         active BIT NOT NULL DEFAULT 1,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_badges_course' AND object_id=OBJECT_ID('lms_badges'))
       CREATE INDEX IX_lms_badges_course ON lms_badges (course_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_badge_awards' AND xtype='U')
       CREATE TABLE lms_badge_awards (
         id INT IDENTITY(1,1) PRIMARY KEY,
         badge_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         awarded_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         awarded_by_source NVARCHAR(20) NULL,
         awarded_by INT NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_badge_awards_badge_student' AND object_id=OBJECT_ID('lms_badge_awards'))
       CREATE UNIQUE INDEX UX_lms_badge_awards_badge_student ON lms_badge_awards (badge_id, student_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_badge_awards_student' AND object_id=OBJECT_ID('lms_badge_awards'))
       CREATE INDEX IX_lms_badge_awards_student ON lms_badge_awards (student_id, course_id)`,
    ],
  },
  {
    id: "034_lms_discussions",
    sql: [
      // Course discussion forums (L8.1, D-095). Forums per course (one default + extras, optionally staff only), flat threads, flat posts (the first post of a thread is the
      // opening post), and learner reports of posts (used by L8.1b moderation). Soft delete everywhere; no foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_forums' AND xtype='U')
       CREATE TABLE lms_forums (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         title NVARCHAR(100) NOT NULL,
         description NVARCHAR(300) NULL,
         staff_only BIT NOT NULL DEFAULT 0,
         locked BIT NOT NULL DEFAULT 0,
         is_default BIT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_forums_course' AND object_id=OBJECT_ID('lms_forums'))
       CREATE INDEX IX_lms_forums_course ON lms_forums (course_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_forums_default' AND object_id=OBJECT_ID('lms_forums'))
       CREATE UNIQUE INDEX UX_lms_forums_default ON lms_forums (course_id) WHERE is_default = 1 AND deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_threads' AND xtype='U')
       CREATE TABLE lms_threads (
         id INT IDENTITY(1,1) PRIMARY KEY,
         forum_id INT NOT NULL,
         course_id INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         pinned BIT NOT NULL DEFAULT 0,
         locked BIT NOT NULL DEFAULT 0,
         hidden_at DATETIME2 NULL,
         hidden_by_source NVARCHAR(20) NULL,
         hidden_by INT NULL,
         hidden_reason NVARCHAR(300) NULL,
         author_source NVARCHAR(20) NOT NULL,
         author_id INT NOT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_threads_forum' AND object_id=OBJECT_ID('lms_threads'))
       CREATE INDEX IX_lms_threads_forum ON lms_threads (forum_id, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_threads_course' AND object_id=OBJECT_ID('lms_threads'))
       CREATE INDEX IX_lms_threads_course ON lms_threads (course_id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_posts' AND xtype='U')
       CREATE TABLE lms_posts (
         id INT IDENTITY(1,1) PRIMARY KEY,
         thread_id INT NOT NULL,
         forum_id INT NOT NULL,
         course_id INT NOT NULL,
         body NVARCHAR(5000) NOT NULL,
         is_opening BIT NOT NULL DEFAULT 0,
         author_source NVARCHAR(20) NOT NULL,
         author_id INT NOT NULL,
         hidden_at DATETIME2 NULL,
         hidden_by_source NVARCHAR(20) NULL,
         hidden_by INT NULL,
         hidden_reason NVARCHAR(300) NULL,
         edited_at DATETIME2 NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_posts_thread' AND object_id=OBJECT_ID('lms_posts'))
       CREATE INDEX IX_lms_posts_thread ON lms_posts (thread_id, created_at)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_posts_author' AND object_id=OBJECT_ID('lms_posts'))
       CREATE INDEX IX_lms_posts_author ON lms_posts (author_source, author_id, created_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_post_reports' AND xtype='U')
       CREATE TABLE lms_post_reports (
         id INT IDENTITY(1,1) PRIMARY KEY,
         post_id INT NOT NULL,
         course_id INT NOT NULL,
         reporter_source NVARCHAR(20) NOT NULL,
         reporter_id INT NOT NULL,
         reason NVARCHAR(300) NULL,
         resolved_at DATETIME2 NULL,
         resolved_by_source NVARCHAR(20) NULL,
         resolved_by INT NULL,
         resolution NVARCHAR(20) NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_post_reports_one' AND object_id=OBJECT_ID('lms_post_reports'))
       CREATE UNIQUE INDEX UX_lms_post_reports_one ON lms_post_reports (post_id, reporter_source, reporter_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_post_reports_course' AND object_id=OBJECT_ID('lms_post_reports'))
       CREATE INDEX IX_lms_post_reports_course ON lms_post_reports (course_id, resolved_at)`,
    ],
  },
  {
    id: "035_lms_groups",
    sql: [
      // Course groups (L8.2a, D-098). ONE set of groups per course: a learner is in at most one live group of a course. Soft delete / soft removal; no foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_groups' AND xtype='U')
       CREATE TABLE lms_groups (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         name NVARCHAR(100) NOT NULL,
         position INT NOT NULL DEFAULT 0,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_groups_name' AND object_id=OBJECT_ID('lms_groups'))
       CREATE UNIQUE INDEX UX_lms_groups_name ON lms_groups (course_id, name) WHERE deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_group_members' AND xtype='U')
       CREATE TABLE lms_group_members (
         id INT IDENTITY(1,1) PRIMARY KEY,
         group_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         removed_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_group_members_one' AND object_id=OBJECT_ID('lms_group_members'))
       CREATE UNIQUE INDEX UX_lms_group_members_one ON lms_group_members (course_id, student_id) WHERE removed_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_group_members_group' AND object_id=OBJECT_ID('lms_group_members'))
       CREATE INDEX IX_lms_group_members_group ON lms_group_members (group_id, removed_at)`,
    ],
  },
  {
    id: "036_lms_group_forums",
    sql: [
      // Group forums (L8.2b, D-099). A forum may belong to ONE group (group_id NULL = a normal forum). Additive only; no foreign keys (D-005).
      `IF COL_LENGTH('lms_forums', 'group_id') IS NULL ALTER TABLE lms_forums ADD group_id INT NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_forums_group' AND object_id=OBJECT_ID('lms_forums'))
       CREATE INDEX IX_lms_forums_group ON lms_forums (course_id, group_id)`,
    ],
  },
  {
    id: "037_lms_peer_review",
    sql: [
      // Peer review (L8.3, D-100). A round belongs to ONE assignment (one live round per assignment); reviews are frozen at OPEN; scores per rubric criterion are kept
      // as rows so they can be queried per learner per outcome later. No foreign keys (D-005). Additive only.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_peer_review_rounds' AND xtype='U')
       CREATE TABLE lms_peer_review_rounds (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         assignment_id INT NOT NULL,
         title NVARCHAR(200) NOT NULL,
         reviews_per_learner INT NOT NULL DEFAULT 2,
         anonymous BIT NOT NULL DEFAULT 1,
         rubric_id INT NULL,
         opens_at DATETIME2 NULL,
         closes_at DATETIME2 NULL,
         seed NVARCHAR(50) NULL,
         status NVARCHAR(10) NOT NULL DEFAULT 'draft',
         opened_at DATETIME2 NULL,
         closed_at DATETIME2 NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         deleted_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_peer_rounds_assignment' AND object_id=OBJECT_ID('lms_peer_review_rounds'))
       CREATE UNIQUE INDEX UX_lms_peer_rounds_assignment ON lms_peer_review_rounds (assignment_id) WHERE deleted_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_peer_rounds_course' AND object_id=OBJECT_ID('lms_peer_review_rounds'))
       CREATE INDEX IX_lms_peer_rounds_course ON lms_peer_review_rounds (course_id, status)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_peer_reviews' AND xtype='U')
       CREATE TABLE lms_peer_reviews (
         id INT IDENTITY(1,1) PRIMARY KEY,
         round_id INT NOT NULL,
         course_id INT NOT NULL,
         reviewer_id INT NOT NULL,
         author_id INT NOT NULL,
         submission_id INT NOT NULL,
         status NVARCHAR(10) NOT NULL DEFAULT 'assigned',
         comment NVARCHAR(2000) NULL,
         total_points DECIMAL(7,2) NULL,
         submitted_at DATETIME2 NULL,
         hidden_at DATETIME2 NULL,
         hidden_by_source NVARCHAR(20) NULL,
         hidden_by INT NULL,
         hidden_reason NVARCHAR(300) NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_peer_reviews_pair' AND object_id=OBJECT_ID('lms_peer_reviews'))
       CREATE UNIQUE INDEX UX_lms_peer_reviews_pair ON lms_peer_reviews (round_id, reviewer_id, submission_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_peer_reviews_reviewer' AND object_id=OBJECT_ID('lms_peer_reviews'))
       CREATE INDEX IX_lms_peer_reviews_reviewer ON lms_peer_reviews (reviewer_id, course_id, status)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_peer_reviews_author' AND object_id=OBJECT_ID('lms_peer_reviews'))
       CREATE INDEX IX_lms_peer_reviews_author ON lms_peer_reviews (author_id, course_id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_peer_review_scores' AND xtype='U')
       CREATE TABLE lms_peer_review_scores (
         id INT IDENTITY(1,1) PRIMARY KEY,
         review_id INT NOT NULL,
         criterion_id INT NOT NULL,
         level_position INT NOT NULL,
         points DECIMAL(7,2) NOT NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_peer_scores_one' AND object_id=OBJECT_ID('lms_peer_review_scores'))
       CREATE UNIQUE INDEX UX_lms_peer_scores_one ON lms_peer_review_scores (review_id, criterion_id)`,
    ],
  },
  {
    id: "038_lms_group_submissions",
    sql: [
      // Group assignments (L8.4a, D-102). A group hand-in is ONE row per live group member (same text, same time), tagged with the group. Additive only; no foreign keys (D-005).
      `IF COL_LENGTH('lms_submissions', 'group_id') IS NULL ALTER TABLE lms_submissions ADD group_id INT NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_submissions_group' AND object_id=OBJECT_ID('lms_submissions'))
       CREATE INDEX IX_lms_submissions_group ON lms_submissions (assignment_id, group_id)`,
    ],
  },
  {
    id: "039_lms_help_requests",
    sql: [
      // Help requests + office-hour lines (L8.5, D-104). A learner asks the course staff one question; staff answer it once (or mark it answered). No foreign keys (D-005). Additive only.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_help_requests' AND xtype='U')
       CREATE TABLE lms_help_requests (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         body NVARCHAR(1000) NOT NULL,
         lesson_id INT NULL,
         assignment_id INT NULL,
         status NVARCHAR(10) NOT NULL DEFAULT N'open',
         reply NVARCHAR(2000) NULL,
         answered_by_source NVARCHAR(20) NULL,
         answered_by INT NULL,
         answered_at DATETIME2 NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_help_course_status' AND object_id=OBJECT_ID('lms_help_requests'))
       CREATE INDEX IX_lms_help_course_status ON lms_help_requests (course_id, status, id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_help_student' AND object_id=OBJECT_ID('lms_help_requests'))
       CREATE INDEX IX_lms_help_student ON lms_help_requests (course_id, student_id, id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_office_hours' AND xtype='U')
       CREATE TABLE lms_office_hours (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         line NVARCHAR(200) NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_office_hours_course' AND object_id=OBJECT_ID('lms_office_hours'))
       CREATE INDEX IX_lms_office_hours_course ON lms_office_hours (course_id, id)`,
    ],
  },
  {
    id: "040_lms_paths",
    sql: [
      // Learning paths (L9.3a, D-108). A path is an ORDERED LIST OF EXISTING LESSONS of one course (kind core | remedial | enrichment) that a teacher can hand to named learners (L9.3b,
      // table lms_path_learners). It never hides or unlocks a lesson: visibility and prerequisites stay with the lesson rules. No foreign keys (D-005). Additive only.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_paths' AND xtype='U')
       CREATE TABLE lms_paths (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         title NVARCHAR(100) NOT NULL,
         description NVARCHAR(500) NULL,
         kind NVARCHAR(12) NOT NULL DEFAULT N'core',
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_paths_course' AND object_id=OBJECT_ID('lms_paths'))
       CREATE INDEX IX_lms_paths_course ON lms_paths (course_id, deleted_at, id)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_path_items' AND xtype='U')
       CREATE TABLE lms_path_items (
         id INT IDENTITY(1,1) PRIMARY KEY,
         path_id INT NOT NULL,
         course_id INT NOT NULL,
         lesson_id INT NOT NULL,
         position INT NOT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_path_items_lesson' AND object_id=OBJECT_ID('lms_path_items'))
       CREATE UNIQUE INDEX UX_lms_path_items_lesson ON lms_path_items (path_id, lesson_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_path_items_pos' AND object_id=OBJECT_ID('lms_path_items'))
       CREATE INDEX IX_lms_path_items_pos ON lms_path_items (path_id, position)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_path_learners' AND xtype='U')
       CREATE TABLE lms_path_learners (
         id INT IDENTITY(1,1) PRIMARY KEY,
         path_id INT NOT NULL,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         reason NVARCHAR(300) NULL,
         assigned_by_source NVARCHAR(20) NULL,
         assigned_by INT NULL,
         assigned_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         withdrawn_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_path_learners_live' AND object_id=OBJECT_ID('lms_path_learners'))
       CREATE UNIQUE INDEX UX_lms_path_learners_live ON lms_path_learners (path_id, student_id) WHERE withdrawn_at IS NULL`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_path_learners_student' AND object_id=OBJECT_ID('lms_path_learners'))
       CREATE INDEX IX_lms_path_learners_student ON lms_path_learners (course_id, student_id, withdrawn_at)`,
    ],
  },
  {
    id: "041_lms_guardian",
    sql: [
      // Guardian links (L9.5a, D-112). A guardian has NO account: the school (an LMS administrator) creates a revocable, expiring secret link for ONE learner; only the SHA-256 hash
      // of the secret is stored (shown once, like the calendar feed). The link opens a read-only view of progress and missed work only. No foreign keys (D-005). Additive only.
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_guardian_links' AND xtype='U')
       CREATE TABLE lms_guardian_links (
         id INT IDENTITY(1,1) PRIMARY KEY,
         student_id INT NOT NULL,
         label NVARCHAR(60) NOT NULL,
         token_hash CHAR(64) NOT NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         expires_at DATETIME2 NOT NULL,
         last_used_at DATETIME2 NULL,
         revoked_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_guardian_links_token' AND object_id=OBJECT_ID('lms_guardian_links'))
       CREATE UNIQUE INDEX UX_lms_guardian_links_token ON lms_guardian_links (token_hash)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_guardian_links_student' AND object_id=OBJECT_ID('lms_guardian_links'))
       CREATE INDEX IX_lms_guardian_links_student ON lms_guardian_links (student_id, revoked_at, expires_at)`,
    ],
  },
  {
    id: "042_lms_offline_packs",
    sql: [
      // Offline resource packs (L10.1a, D-113). A pack is a named, size-budgeted, expiring selection of LESSONS of one course. Publishing FREEZES a manifest (lesson content
      // versions + content hashes, files with sha256 + size) so a learner's device can verify what it downloaded. Lessons are listed in lms_offline_pack_lessons (draft config);
      // the files are never stored here, only referenced from the manifest. Packs are soft deleted. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_offline_packs' AND xtype='U')
       CREATE TABLE lms_offline_packs (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         name NVARCHAR(100) NOT NULL,
         status NVARCHAR(12) NOT NULL DEFAULT 'draft',
         max_mb INT NOT NULL DEFAULT 50,
         expires_at DATETIME2 NULL,
         manifest_json NVARCHAR(MAX) NULL,
         manifest_sha256 NVARCHAR(64) NULL,
         total_bytes BIGINT NULL,
         published_at DATETIME2 NULL,
         retired_at DATETIME2 NULL,
         created_by_source NVARCHAR(20) NULL,
         created_by INT NULL,
         created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         deleted_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_offline_packs_course' AND object_id=OBJECT_ID('lms_offline_packs'))
       CREATE INDEX IX_lms_offline_packs_course ON lms_offline_packs (course_id, status, deleted_at)`,
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_offline_pack_lessons' AND xtype='U')
       CREATE TABLE lms_offline_pack_lessons (
         id INT IDENTITY(1,1) PRIMARY KEY,
         pack_id INT NOT NULL,
         course_id INT NOT NULL,
         lesson_id INT NOT NULL,
         sort_order INT NOT NULL DEFAULT 0
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_offline_pack_lessons' AND object_id=OBJECT_ID('lms_offline_pack_lessons'))
       CREATE UNIQUE INDEX UX_lms_offline_pack_lessons ON lms_offline_pack_lessons (pack_id, lesson_id)`,
    ],
  },
  {
    id: "043_lms_offline_actions",
    sql: [
      // Offline queued learner actions (L10.3a, D-115). One row per action a device replays; (student, client_action_id) is UNIQUE so a replay is idempotent. Holds ids, type and the
      // outcome only (no text, no personal data). result_state NULL = received but not finished (a crash): the next replay finishes it. No foreign keys (D-005).
      `IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_offline_actions' AND xtype='U')
       CREATE TABLE lms_offline_actions (
         id INT IDENTITY(1,1) PRIMARY KEY,
         course_id INT NOT NULL,
         student_id INT NOT NULL,
         client_action_id NVARCHAR(64) NOT NULL,
         action_type NVARCHAR(30) NOT NULL,
         lesson_id INT NULL,
         queued_at DATETIME2 NULL,
         received_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
         result_state NVARCHAR(12) NULL,
         result_code NVARCHAR(40) NULL,
         processed_at DATETIME2 NULL
       )`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_lms_offline_actions_client' AND object_id=OBJECT_ID('lms_offline_actions'))
       CREATE UNIQUE INDEX UX_lms_offline_actions_client ON lms_offline_actions (student_id, client_action_id)`,
      `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_lms_offline_actions_course' AND object_id=OBJECT_ID('lms_offline_actions'))
       CREATE INDEX IX_lms_offline_actions_course ON lms_offline_actions (course_id, received_at)`,
    ],
  },
  {
    id: "044_lms_offline_drafts",
    sql: [
      // Queued draft submissions (L10.3b, D-116): the action row also remembers WHICH assignment and the draft version (the draft's updated_at as ISO text) the action produced, so a replay can answer
      // with the version again. Still no text stored. Two guarded nullable columns, additive only.
      `IF COL_LENGTH('lms_offline_actions', 'assignment_id') IS NULL ALTER TABLE lms_offline_actions ADD assignment_id INT NULL`,
      `IF COL_LENGTH('lms_offline_actions', 'result_version') IS NULL ALTER TABLE lms_offline_actions ADD result_version NVARCHAR(40) NULL`,
    ],
  },
  {
    id: "045_lms_offline_quiz_answers",
    sql: [
      // Queued quiz answers (L10.3c, D-118): the action row also remembers WHICH quiz and attempt, so a reused action id for another quiz/attempt is refused. Still no answers stored here
      // (they live in lms_quiz_answers). Two guarded nullable columns, additive only.
      `IF COL_LENGTH('lms_offline_actions', 'quiz_id') IS NULL ALTER TABLE lms_offline_actions ADD quiz_id INT NULL`,
      `IF COL_LENGTH('lms_offline_actions', 'attempt_id') IS NULL ALTER TABLE lms_offline_actions ADD attempt_id INT NULL`,
    ],
  },
];

const checksum = (step) => crypto.createHash("sha256").update(step.sql.join("\n")).digest("hex").slice(0, 16);

const TRACKING_SQL = `
  IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='lms_schema_migrations' AND xtype='U')
  CREATE TABLE lms_schema_migrations (
    id NVARCHAR(100) NOT NULL PRIMARY KEY,
    checksum NVARCHAR(32) NOT NULL,
    applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  )`;

async function readApplied(pool) {
  const r = await pool.request().query(`SELECT id, checksum FROM lms_schema_migrations`);
  return new Map((r.recordset || []).map((x) => [x.id, x.checksum]));
}

/* Dry run: what would run. Creates nothing (a missing tracking table = everything pending). */
async function planLmsSchema(pool, steps = STEPS) {
  let applied = new Map();
  try { applied = await readApplied(pool); } catch { /* tracking table not there yet */ }
  return {
    pending: steps.filter((s) => !applied.has(s.id)).map((s) => s.id),
    applied: steps.filter((s) => applied.has(s.id)).map((s) => s.id),
    changed: steps.filter((s) => applied.has(s.id) && applied.get(s.id) !== checksum(s)).map((s) => s.id),
  };
}

/* Applies pending steps in order. Never throws (boot must not die); returns a report.
   A failing step is logged (step id + the statement that broke) and left unrecorded so it retries on the next boot,
   but it no longer blocks the steps after it: every step is additive and guarded, so later tables (peer review, paths…)
   still get created. A later step that really needs the failed one fails on its own and retries too. */
async function ensureLmsSchema(pool, tenantKey = "default", steps = STEPS) {
  const report = { tenantKey, ran: [], skipped: [], failed: null, failedSteps: [], changed: [] };
  try {
    await pool.request().query(TRACKING_SQL);
    const applied = await readApplied(pool);
    for (const step of steps) {
      if (applied.has(step.id)) {
        report.skipped.push(step.id);
        if (applied.get(step.id) !== checksum(step)) report.changed.push(step.id); // released step was edited: warn only
        continue;
      }
      let stmt = "";
      try {
        for (stmt of step.sql) await pool.request().query(stmt);
        await pool.request().input("id", require("mssql").NVarChar(100), step.id)
          .input("cs", require("mssql").NVarChar(32), checksum(step))
          .query(`INSERT INTO lms_schema_migrations (id, checksum) VALUES (@id, @cs)`);
        report.ran.push(step.id);
      } catch (err) {
        const snippet = String(stmt).replace(/\s+/g, " ").trim().slice(0, 140);
        report.failedSteps.push({ id: step.id, error: err.message });
        if (report.failed === null) report.failed = err.message;
        console.error(`⚠️  LMS schema [${tenantKey}] step ${step.id} FAILED: ${err.message} | statement: ${snippet}`);
      }
    }
    if (report.changed.length) console.error(`⚠️  LMS schema [${tenantKey}]: released step(s) edited after applying: ${report.changed.join(", ")}`);
  } catch (err) {
    report.failed = err.message;
    console.error(`⚠️  LMS schema [${tenantKey}] failed:`, err.message);
  }
  return report;
}

module.exports = { STEPS, checksum, planLmsSchema, ensureLmsSchema };
