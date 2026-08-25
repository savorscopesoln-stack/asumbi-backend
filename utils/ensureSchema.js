/* =========================================================
   ENSURE SCHEMA
   Idempotent startup checks so the app works whether these
   tables/columns already exist in the DB or not. Safe to run
   on every server boot.
========================================================= */

const { ensureElectionSchema } = require("./electionSchema");

async function ensureSchema(pool, sql) {
  try {
    // Student Council Voting System — its own file since it owns a
    // self-contained set of tables; kept as a separate module so it's
    // easy to find/maintain without wading through the rest of this file.
    await ensureElectionSchema(pool, sql);

    /* ---------------- e_assessments.exam_password ----------------
       Lets a student join a single assessment via the standalone
       /take-assessment/:id page (no portal account login) using
       their username + this per-assessment password, set by the
       admin/teacher when creating or editing the assessment. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'exam_password' AND Object_ID = Object_ID(N'e_assessments')
      )
      ALTER TABLE e_assessments ADD exam_password NVARCHAR(50) NULL
    `);

    /* ---------------- e_assessment_question_setters ----------------
       Admin picks, at create/edit time, exactly which teacher(s) are
       allowed to add/edit/delete questions on an assessment — separate
       from e_assessments.teacher_id (whoever's account created the row,
       which for admin-created assessments is the admin's own id and
       isn't a teacher at all). Enforced in addEAssessmentQuestion /
       updateQuestion / deleteQuestion, and used to decide which teachers
       see the assessment on their E-Assessments page. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='e_assessment_question_setters' AND xtype='U')
      CREATE TABLE e_assessment_question_setters (
        id INT IDENTITY(1,1) PRIMARY KEY,
        e_assessment_id INT NOT NULL,
        teacher_id INT NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    /* ---------------- e_assessments.questions_deadline ----------------
       Admin-set cutoff for when a teacher can still add/edit questions
       on an assessment. NULL = no deadline (always open), matching prior
       behavior for existing rows. Enforced server-side in
       addEAssessmentQuestion; the frontend also disables the "Add
       Questions" button once this has passed. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'questions_deadline' AND Object_ID = Object_ID(N'e_assessments')
      )
      ALTER TABLE e_assessments ADD questions_deadline DATETIME NULL
    `);

    /* ---------------- Notifications table ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Notifications' AND xtype='U')
      CREATE TABLE Notifications (
        id INT IDENTITY(1,1) PRIMARY KEY,
        recipientId INT NOT NULL,
        recipientSource NVARCHAR(20) NOT NULL,
        title NVARCHAR(200) NULL,
        message NVARCHAR(MAX) NOT NULL,
        type NVARCHAR(50) NULL,
        isRead BIT NOT NULL DEFAULT 0,
        createdBy INT NULL,
        createdBySource NVARCHAR(20) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    // In case an older/partial "Notifications" table already existed
    // (e.g. only had the columns the old TOP-10 endpoint used),
    // patch in any columns we now depend on.
    const notifColumns = [
      ["recipientId", "INT NULL"],
      ["recipientSource", "NVARCHAR(20) NULL"],
      ["title", "NVARCHAR(200) NULL"],
      ["message", "NVARCHAR(MAX) NULL"],
      ["type", "NVARCHAR(50) NULL"],
      ["isRead", "BIT NOT NULL DEFAULT 0"],
      ["createdBy", "INT NULL"],
      ["createdBySource", "NVARCHAR(20) NULL"],
      // Human-readable name/username of whoever sent this (or NULL for
      // system-generated notifications) — so the recipient's inbox can
      // show "From: Jane Admin" instead of just a source/id pair.
      ["createdByName", "NVARCHAR(200) NULL"],
      ["createdAt", "DATETIME NULL DEFAULT GETDATE()"],
    ];

    for (const [name, type] of notifColumns) {
      await pool.request().query(`
        IF NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE Name = N'${name}' AND Object_ID = Object_ID(N'Notifications')
        )
        ALTER TABLE Notifications ADD ${name} ${type}
      `);
    }

    /* ---------------- leave_outs table ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='leave_outs' AND xtype='U')
      CREATE TABLE leave_outs (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        reason NVARCHAR(500) NULL,
        leave_type NVARCHAR(20) NOT NULL DEFAULT 'short_stay',
        request_date DATETIME NULL,
        duration INT NULL DEFAULT 120,
        status NVARCHAR(20) NOT NULL DEFAULT 'pending',
        approved_at DATETIME NULL,
        deny_reason NVARCHAR(500) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    // Add leave_type to a pre-existing leave_outs table that predates
    // the short_stay / long / emergency feature.
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='leave_outs' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'leave_type' AND Object_ID = Object_ID(N'leave_outs')
      )
      ALTER TABLE leave_outs ADD leave_type NVARCHAR(20) NOT NULL CONSTRAINT DF_leave_outs_leave_type DEFAULT 'short_stay'
    `);

    /* ---------------- leave_outs: multi-stage approval workflow ----------------
       Emergency Leave: Student -> Sub-Admin 2 (stage 1) -> Sub-Admin 1 OR Admin
       (final stage). Long-Stay Leave: Student -> Admin only, never touches the
       sub-admin queues. Admin can also "force grant" a leave directly (no
       workflow at all). Every actor identity below is captured at the moment
       of the action (id + source + resolved display name), so notifications
       and history never have to guess who did what. */
    const leaveOutColumns = [
      ["subadmin2_approver_id", "INT NULL"],
      ["subadmin2_approver_source", "NVARCHAR(20) NULL"],
      ["subadmin2_approver_name", "NVARCHAR(200) NULL"],
      ["subadmin2_approved_at", "DATETIME NULL"],

      ["final_approver_id", "INT NULL"],
      ["final_approver_source", "NVARCHAR(20) NULL"],
      ["final_approver_name", "NVARCHAR(200) NULL"],
      ["final_approved_at", "DATETIME NULL"],

      ["rejected_by_id", "INT NULL"],
      ["rejected_by_source", "NVARCHAR(20) NULL"],
      ["rejected_by_name", "NVARCHAR(200) NULL"],
      ["rejected_at", "DATETIME NULL"],
      ["reject_stage", "NVARCHAR(30) NULL"],

      ["is_admin_granted", "BIT NOT NULL CONSTRAINT DF_leave_outs_is_admin_granted DEFAULT 0"],
      ["granted_by_id", "INT NULL"],
      ["granted_by_source", "NVARCHAR(20) NULL"],
      ["granted_by_name", "NVARCHAR(200) NULL"],
      ["granted_at", "DATETIME NULL"],

      ["submitted_by_name", "NVARCHAR(200) NULL"],
      ["end_date", "DATETIME NULL"],

      // Flags a leave that skipped the Sub-Admin 2 review stage because
      // the student was on the Sub-Admin 2 auto-approve list at submit
      // time — see leave_auto_approve below. subadmin2_approver_name is
      // still populated (with a "(Auto-Approved)" label) so the existing
      // ApprovalHistory UI needs no changes; this flag is just for a
      // clear badge on the request itself.
      ["subadmin2_auto_approved", "BIT NOT NULL CONSTRAINT DF_leave_outs_subadmin2_auto_approved DEFAULT 0"],
    ];

    for (const [name, type] of leaveOutColumns) {
      await pool.request().query(`
        IF EXISTS (SELECT * FROM sysobjects WHERE name='leave_outs' AND xtype='U')
        AND NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE Name = N'${name}' AND Object_ID = Object_ID(N'leave_outs')
        )
        ALTER TABLE leave_outs ADD ${name} ${type}
      `);
    }

    /* ---------------- Users.name ----------------
       Display name for admin / sub_admin / sub_admin_2 accounts, used
       any time a notification needs to name the actual authenticated
       account that performed an action (never a role label, never
       hard-coded). Falls back to username wherever this is NULL, so
       existing accounts keep working immediately without needing to be
       edited first. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'name' AND Object_ID = Object_ID(N'Users')
      )
      ALTER TABLE Users ADD name NVARCHAR(200) NULL
    `);

    /* ---------------- Notifications.link ----------------
       Optional in-app route the notification should take the user to
       when clicked (e.g. the Leave-out page for a leave-related
       notification). NULL for notifications with nothing to link to. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Notifications' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'link' AND Object_ID = Object_ID(N'Notifications')
      )
      ALTER TABLE Notifications ADD link NVARCHAR(300) NULL
    `);

    /* ---------------- PortalPageSettings ----------------
       Admin-controlled on/off switch for individual pages inside the
       Student and Teacher portals. Keyed by (portal, page_key) where
       page_key is just that page's route (e.g. "/student/meals") —
       an open key/value store, not a fixed enum, so any page added
       to a portal's nav array in the future is automatically
       controllable here with zero backend changes. A page with no
       row yet is treated as enabled by default (see the route
       handler) — only explicit rows turn a page off. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='PortalPageSettings' AND xtype='U')
      CREATE TABLE PortalPageSettings (
        portal NVARCHAR(20) NOT NULL,
        page_key NVARCHAR(200) NOT NULL,
        enabled BIT NOT NULL DEFAULT 1,
        updated_by_id INT NULL,
        updated_by_name NVARCHAR(200) NULL,
        updated_at DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT PK_PortalPageSettings PRIMARY KEY (portal, page_key)
      )
    `);

    /* ---------------- mustChangePassword (Users / Students / Teachers) ----------------
       Drives the "must change password on next login" flow: set to 1 whenever an
       admin creates an account or resets a password to the default, cleared back
       to 0 the moment that account successfully changes its own password. */
    for (const table of ["Users", "Students", "Teachers"]) {
      await pool.request().query(`
        IF EXISTS (SELECT * FROM sysobjects WHERE name='${table}' AND xtype='U')
        AND NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE Name = N'mustChangePassword' AND Object_ID = Object_ID(N'${table}')
        )
        ALTER TABLE ${table} ADD mustChangePassword BIT NOT NULL CONSTRAINT DF_${table}_mustChangePassword DEFAULT 0
      `);
    }

    /* ---------------- Users.permissions (sub-admin page access) ----------------
       Stores a JSON array of page keys (see backend/utils/pages.js) that a
       "sub_admin" account is allowed to open. NULL/empty for a plain "admin"
       account, which always has full access regardless of this column. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'permissions' AND Object_ID = Object_ID(N'Users')
      )
      ALTER TABLE Users ADD permissions NVARCHAR(MAX) NULL
    `);

    /* ---------------- Retire the old "staff" role ----------------
       The system used to have a flat "staff" role with no configurable
       access. Any existing accounts of that role become "sub_admin"
       with no pages granted yet — an admin should open Users/Registration
       and assign the pages that account needs. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U')
      UPDATE Users SET role = 'sub_admin' WHERE LOWER(role) = 'staff'
    `);

    /* ---------------- ScheduledNotifications table ----------------
       Backs the admin "Notifications" broadcast page: pick a set of
       recipients (everyone / all students / all teachers / admins /
       one class / hand-picked accounts), a message, which channels to
       fan it out over (in-app, email, SMS, WhatsApp), and either send
       right away or schedule it for later. A background tick in
       utils/notificationScheduler.js sweeps for due rows. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ScheduledNotifications' AND xtype='U')
      CREATE TABLE ScheduledNotifications (
        id INT IDENTITY(1,1) PRIMARY KEY,
        title NVARCHAR(200) NULL,
        message NVARCHAR(MAX) NOT NULL,
        channels NVARCHAR(200) NOT NULL DEFAULT '["in_app"]',
        recipientType NVARCHAR(30) NOT NULL,
        recipientIds NVARCHAR(MAX) NULL,
        studentClass NVARCHAR(50) NULL,
        scheduledFor DATETIME NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'pending',
        recipientCount INT NULL,
        resultSummary NVARCHAR(MAX) NULL,
        createdBy INT NULL,
        createdBySource NVARCHAR(20) NULL,
        createdByName NVARCHAR(200) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        sentAt DATETIME NULL
      )
    `);

    // Patch createdByName onto a pre-existing ScheduledNotifications table
    // (same reasoning as the Notifications table above — the sender's
    // display name so both the broadcast history and every recipient's
    // in-app notification can show who sent it).
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='ScheduledNotifications' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'createdByName' AND Object_ID = Object_ID(N'ScheduledNotifications')
      )
      ALTER TABLE ScheduledNotifications ADD createdByName NVARCHAR(200) NULL
    `);

    /* ---------------- NotificationSettings table ----------------
       Single-row table holding the API credentials for the outbound
       notification channels (email/SMTP, SMS + WhatsApp via Twilio),
       so an admin can wire these up from the "Notification Settings"
       config page instead of needing server/.env access. Secret
       columns (passwords/tokens) are only ever written here, never
       read back to the browser in plain text — see
       controllers/notificationSettings.controller.js.
       backend/services/notificationChannels.js falls back to the
       equivalent environment variable whenever a column is NULL, so
       nothing already relying on .env breaks. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='NotificationSettings' AND xtype='U')
      CREATE TABLE NotificationSettings (
        id INT NOT NULL PRIMARY KEY DEFAULT 1,
        emailHost NVARCHAR(200) NULL,
        emailPort INT NULL,
        emailSecure BIT NULL,
        emailUser NVARCHAR(200) NULL,
        emailPassword NVARCHAR(500) NULL,
        emailFrom NVARCHAR(200) NULL,
        twilioAccountSid NVARCHAR(200) NULL,
        twilioAuthToken NVARCHAR(500) NULL,
        twilioSmsFrom NVARCHAR(50) NULL,
        twilioWhatsappFrom NVARCHAR(50) NULL,
        updatedAt DATETIME NULL,
        updatedByName NVARCHAR(200) NULL,
        CONSTRAINT CK_NotificationSettings_singleton CHECK (id = 1)
      )
    `);

    /* ---------------- Students.photoUrl / Teachers.photoUrl ----------------
       Profile photo, required at registration time for both portals (see
       backend/routes/register.js) and replaceable later from the
       student/teacher's own profile page. Stores the relative URL path
       returned by the photo upload middleware (e.g. /uploads/photos/xyz.jpg),
       not the file itself. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Students' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'photoUrl' AND Object_ID = Object_ID(N'Students')
      )
      ALTER TABLE Students ADD photoUrl NVARCHAR(500) NULL
    `);

    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='Teachers' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'photoUrl' AND Object_ID = Object_ID(N'Teachers')
      )
      ALTER TABLE Teachers ADD photoUrl NVARCHAR(500) NULL
    `);

    /* ---------------- leave_outs gate-verification columns ----------------
       Once a leave reaches 'approved' or 'admin_granted', the approving
       route generates a one-time gate_code. The Gate page (security desk)
       verifies that code: first scan records exit_time, second scan
       (same code) records reentry_time. gate_status tracks where in that
       cycle the leave currently sits, purely for the Gate report/list —
       the authoritative state is still exit_time/reentry_time being
       null or not. */
    const leaveGateColumns = [
      ["gate_code", "NVARCHAR(12) NULL"],
      ["gate_status", "NVARCHAR(20) NULL"], // 'not_out' | 'out' | 'returned'
      ["exit_time", "DATETIME NULL"],
      ["exit_verified_by_name", "NVARCHAR(200) NULL"],
      ["reentry_time", "DATETIME NULL"],
      ["reentry_verified_by_name", "NVARCHAR(200) NULL"],
    ];
    for (const [name, type] of leaveGateColumns) {
      await pool.request().query(`
        IF EXISTS (SELECT * FROM sysobjects WHERE name='leave_outs' AND xtype='U')
        AND NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE Name = N'${name}' AND Object_ID = Object_ID(N'leave_outs')
        )
        ALTER TABLE leave_outs ADD ${name} ${type}
      `);
    }

    /* ---------------- leave_outs code-verification columns (Sub-Admin 1 gate) ----------------
       gate_code is now generated the moment a leave is SUBMITTED, not
       just on approval (see leaveOutRoutes.js) — the student hands that
       same code to Sub-Admin 1 in person. Sub-Admin 1 can't see a
       request's reason or act on it until they've entered the correct
       code via PUT /:id/verify-code, which flips code_verified to 1
       permanently for that one request. Admin is never subject to this
       gate (GET / never redacts anything for admin), and once verified
       a request stays unlocked — there's no need to re-enter the code. */
    const leaveCodeGateColumns = [
      ["code_verified", "BIT NOT NULL CONSTRAINT DF_leave_outs_code_verified DEFAULT 0"],
      ["code_verified_by_name", "NVARCHAR(200) NULL"],
      ["code_verified_at", "DATETIME NULL"],
    ];
    for (const [name, type] of leaveCodeGateColumns) {
      await pool.request().query(`
        IF EXISTS (SELECT * FROM sysobjects WHERE name='leave_outs' AND xtype='U')
        AND NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE Name = N'${name}' AND Object_ID = Object_ID(N'leave_outs')
        )
        ALTER TABLE leave_outs ADD ${name} ${type}
      `);
    }

    /* ---------------- meal_daily_codes table ----------------
       3 single-use codes generated per student per calendar day
       (breakfast/lunch/supper), shown on the student's meal card page
       and typed in at the Kitchen page to verify + decrement the
       student's meal_cards balance. A code can never be reused once
       usedAt is set, and is unique across ALL students for that day so
       kitchen staff can verify by code alone without also needing to
       know whose it is. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='meal_daily_codes' AND xtype='U')
      CREATE TABLE meal_daily_codes (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        meal_card_id INT NULL,
        slot NVARCHAR(20) NOT NULL,
        code NVARCHAR(10) NOT NULL,
        code_date DATE NOT NULL,
        usedAt DATETIME NULL,
        usedByName NVARCHAR(200) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_meal_daily_codes_student_day_slot UNIQUE (student_id, code_date, slot)
      )
    `);

    /* ---------------- leave_auto_approve table ----------------
       Sub-Admin 2's pre-approved list (Admin can manage it too). A
       student_id in this table has any Emergency Leave they submit
       skip the Sub-Admin 2 review stage entirely — it's created
       already sitting at 'pending_final', ready for Sub-Admin 1 /
       Admin's final sign-off, instead of waiting in Sub-Admin 2's
       queue. See leaveOutRoutes.js for where this is read/written. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='leave_auto_approve' AND xtype='U')
      CREATE TABLE leave_auto_approve (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        added_by_id INT NULL,
        added_by_name NVARCHAR(200) NULL,
        added_at DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UQ_leave_auto_approve_student UNIQUE (student_id)
      )
    `);

    console.log("✅ Schema check complete (election_* Student Council tables, Notifications, Notifications.link, Notifications/ScheduledNotifications.createdByName, ScheduledNotifications, NotificationSettings, PortalPageSettings, e_assessment_question_setters, questions_deadline, leave_outs.leave_type, leave_outs approval-workflow columns, leave_outs gate-verification columns, leave_outs code-verification columns, meal_daily_codes, leave_auto_approve, mustChangePassword, Users.permissions, Users.name, staff→sub_admin migration, Students/Teachers.photoUrl)");
  } catch (err) {
    console.error("⚠️  Schema ensure failed:", err.message);
  }
}

module.exports = { ensureSchema };