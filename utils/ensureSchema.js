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

    /* ---------------- e_assessments.year_of_study ----------------
       Lets ONE assessment target every class in a year of study (1/2/3)
       instead of needing one row per class. NULL (the default, and what
       every pre-existing row has) means "targets exactly its class_id"
       — unchanged old behavior. When set, class_id is still populated
       with one representative class (so every existing query/join that
       reads ea.class_id keeps working for display), but student
       eligibility/notification is decided by Students.yearOfStudy
       matching this value instead of a single class — see
       toggleEAssessmentActive below. Kept as a plain INT (1/2/3) rather
       than a class-name-parsing scheme, since Students.yearOfStudy is
       already the school's authoritative year field. */
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='e_assessments' AND xtype='U')
      AND NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'year_of_study' AND Object_ID = Object_ID(N'e_assessments')
      )
      ALTER TABLE e_assessments ADD year_of_study INT NULL
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

      // Flags a leave that bypassed the entire approval workflow because
      // the student was on the Sub-Admin 2 auto-approve list at submit
      // time — see leave_auto_approve below. subadmin2_approver_name /
      // final_approver_name are still populated (with an "Auto-Approved"
      // label) so the existing ApprovalHistory UI needs no changes; this
      // flag is just for a clear badge on the request itself.
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
       bypass the entire approval workflow — created already fully
       'approved', gate code active immediately, no manual step
       needed from Sub-Admin 2, Sub-Admin 1, or Admin. See
       leaveOutRoutes.js for where this is read/written. */
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

    /* ---------------- Students.profileCompleted ----------------
       Drives the "complete your profile" step shown right after a
       student's first (forced) password change — see
       ForcePasswordChange.jsx and CompleteProfile.jsx on the
       frontend. Set to 1 the moment PUT /api/student/profile is
       saved successfully.

       Backfill on first creation of the column: any student who has
       *already* changed their password (mustChangePassword = 0) is
       treated as already onboarded, so existing/active students are
       never suddenly interrupted by this new step — only brand-new
       accounts (mustChangePassword still 1, meaning they've never
       even logged in yet) start with profileCompleted = 0. */
    const studentsTableExists = await pool.request().query(`
      SELECT * FROM sysobjects WHERE name='Students' AND xtype='U'
    `);

    if (studentsTableExists.recordset.length > 0) {
      const hasProfileCompleted = await pool.request().query(`
        SELECT * FROM sys.columns
        WHERE Name = N'profileCompleted' AND Object_ID = Object_ID(N'Students')
      `);

      if (hasProfileCompleted.recordset.length === 0) {
        await pool.request().query(`
          ALTER TABLE Students ADD profileCompleted BIT NOT NULL CONSTRAINT DF_Students_profileCompleted DEFAULT 0
        `);

        await pool.request().query(`
          UPDATE Students SET profileCompleted = 1 WHERE mustChangePassword = 0
        `);
      }
    }

    /* ---------------- student_profile_change_requests table ----------------
       After a student's very first profile save (right after their
       forced password change), every later edit is queued here for
       admin approval instead of being applied immediately — see
       backend/routes/profileChangeRequests.js and
       PUT /api/student/profile's profileCompleted check. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='student_profile_change_requests' AND xtype='U')
      CREATE TABLE student_profile_change_requests (
        id INT IDENTITY(1,1) PRIMARY KEY,
        student_id INT NOT NULL,
        requested_studentClass NVARCHAR(100) NULL,
        requested_gender NVARCHAR(20) NULL,
        requested_email NVARCHAR(200) NULL,
        requested_phone NVARCHAR(30) NULL,
        requested_assessmentNumber NVARCHAR(100) NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_at DATETIME NOT NULL DEFAULT GETDATE(),
        reviewed_by_id INT NULL,
        reviewed_by_name NVARCHAR(200) NULL,
        reviewed_at DATETIME NULL,
        rejection_reason NVARCHAR(500) NULL
      )
    `);

    /* ---------------- website_content table ----------------
       Backs the public marketing website's editable sections (see
       routes/website.js + frontend Website.jsx admin page). One row
       per named section ("hero", "announcements", "principal",
       "stats", "milestones", "news", "testimonials", "faqs"); the
       actual content is stored as a JSON blob per row so new fields
       can be added on either side without a migration. Seeded with
       the same defaults the public site ships with, so the site
       renders identically before an admin ever touches this page. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='website_content' AND xtype='U')
      CREATE TABLE website_content (
        id INT IDENTITY(1,1) PRIMARY KEY,
        section_key NVARCHAR(50) NOT NULL UNIQUE,
        content_json NVARCHAR(MAX) NOT NULL,
        updated_by_id INT NULL,
        updated_by_name NVARCHAR(200) NULL,
        updated_at DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    const websiteDefaults = {
      announcements: [
        "2027 intake applications are now open — apply before 15 September",
        "Founders' Day & Graduation Ceremony holds 14 November 2026",
        "New ICT Resource Centre now open to all students",
      ],
      hero: {
        kicker: "Karibu — welcome to Asumbi",
        eyebrow: "Asumbi Teachers Training College · Est. 1968",
        headline: "Forming the teachers\nwho form the nation.",
        subtitle:
          "A rigorous, faith-rooted college in Homa Bay County preparing Kenya's next generation of primary and ECDE teachers — in classroom craft, character, and calling.",
        backgroundImage: null,
      },
      principal: {
        name: "Dr. [Principal's Name]",
        title: "Principal, Asumbi Teachers Training College · PhD Education Administration",
        yearsLabel: "15 yrs",
        quote: "We do not simply teach subjects. We form teachers.",
        photo: null,
        bio: [
          "Welcome to Asumbi Teachers Training College. For over five decades, this institution has held to one conviction: that the quality of a nation's classrooms depends entirely on the quality of its teachers' preparation. Every tutor, every timetable, and every teaching-practice placement here is built around that conviction.",
          "Our graduates leave not only with sound pedagogical technique, but with the discipline, empathy, and moral seriousness that the profession demands. I invite you to explore what we do, visit our campus, and consider joining a college that takes the formation of teachers as seriously as you do.",
        ],
      },
      stats: [
        { label: "Years Forming Teachers", value: 58 },
        { label: "Students in Training", value: 1400 },
        { label: "Graduates Serving Kenya", value: 6200 },
        { label: "Teaching & Support Staff", value: 74 },
        { label: "Academic Departments", value: 9 },
      ],
      milestones: [
        { year: "1968", text: "Founded by the Diocese of Homa Bay as a teacher-training centre for the region." },
        { year: "1985", text: "Awarded full Teachers Training College status by the Ministry of Education." },
        { year: "2003", text: "Introduced the Diploma in Teacher Education alongside the founding Certificate track." },
        { year: "2015", text: "Opened the ICT Resource Centre, bringing digital pedagogy into every department." },
        { year: "2021", text: "Introduced the Certificate in Early Childhood Development & Education (ECDE)." },
        { year: "2024", text: "TVETA accreditation renewed following an institutional quality audit." },
        { year: "2026", text: "Over 6,200 graduates now teaching in classrooms across Kenya.", current: true },
      ],
      news: [
        {
          slug: "2027-intake-applications-now-open",
          tag: "Admissions",
          tagColor: "maroon",
          title: "2027 intake applications now open",
          excerpt: "Prospective students can now apply for the Diploma in Teacher Education and Certificate in ECDE for the January 2027 intake.",
          body: "Prospective students can now apply for the Diploma in Teacher Education and Certificate in ECDE for the January 2027 intake. See the Admissions page for entry requirements and how to reach the official admissions channel.",
          date: "24 July 2026",
          image: null,
        },
        {
          slug: "founders-day-graduation-set-for-november",
          tag: "Events",
          tagColor: "green",
          title: "Founders' Day & graduation set for November",
          excerpt: "The College will mark 58 years of service alongside this year's graduating class on 14 November 2026.",
          body: "The College will mark 58 years of service alongside this year's graduating class on 14 November 2026. Further details on the programme of events will be published closer to the date.",
          date: "18 July 2026",
          image: null,
        },
        {
          slug: "new-ict-resource-centre-now-open",
          tag: "Facilities",
          tagColor: "gold",
          title: "New ICT Resource Centre now open",
          excerpt: "A fully equipped computer lab and digital learning space is now available to all students and staff.",
          body: "A fully equipped computer lab and digital learning space is now available to all students and staff, supporting digital literacy and ICT integration across every department.",
          date: "2 July 2026",
          image: null,
        },
      ],
      testimonials: [
        {
          initials: "GA",
          quote: "Teaching practice at Asumbi wasn't a formality — it's where I actually learned to run a classroom. I walked into my first posting already confident.",
          name: "Grace A.",
          detail: "Diploma in Teacher Education, 2022",
          photo: null,
        },
        {
          initials: "BO",
          quote: "The tutors know your name and your weaknesses, and they don't let you graduate until both are addressed. That is rare, and it matters.",
          name: "Brian O.",
          detail: "Diploma in Teacher Education, 2021",
          photo: null,
        },
        {
          initials: "FM",
          quote: "I came in unsure if teaching was really for me. I left certain of it, and with the classroom management skills to prove it.",
          name: "Faith M.",
          detail: "Certificate in ECDE, 2023",
          photo: null,
        },
      ],
      faqs: [
        {
          q: "What qualifications do I need to apply?",
          a: "A minimum KCSE mean grade of C- (minus) for the Diploma programme, or D+ for Certificate programmes, meeting the specific subject requirements listed on our Admissions page.",
        },
        {
          q: "When does the next intake begin?",
          a: "Our next intake begins in January 2027. Applications close on 15 September 2026, and early application is strongly encouraged as placements are limited.",
        },
        {
          q: "Is accommodation available on campus?",
          a: "Yes. On-campus hostels are available for both male and female students on a first-come, first-served basis, with day-scholar options also available.",
        },
        {
          q: "How long is the teaching practice placement?",
          a: "Teaching practice runs for 12 weeks in a supervised primary school placement, with a tutor visiting and assessing each student multiple times during the term.",
        },
      ],
      accreditations: [
        "TVETA Accredited",
        "Ministry of Education Registered",
        "Sponsored by the Diocese of Homa Bay",
        "KNEC Examination Centre",
      ],
      // All 9 departments in one list — the homepage preview shows the
      // first 6, the full Academics page shows all 9. Editing here
      // updates both.
      departments: [
        { index: "01", slug: "languages-literature", name: "Languages & Literature", description: "English and Kiswahili methodology, literature, and communication skills for the primary classroom.", overview: "English and Kiswahili methodology, literature, and communication skills for the primary classroom." },
        { index: "02", slug: "sciences-mathematics", name: "Sciences & Mathematics", description: "Integrated science, mathematics pedagogy, and practical laboratory-based teaching methods.", overview: "Integrated science, mathematics pedagogy, and practical laboratory-based teaching methods." },
        { index: "03", slug: "education-foundations", name: "Education Foundations", description: "Educational psychology, philosophy, curriculum studies, and professional ethics.", overview: "Educational psychology, philosophy, curriculum studies, and professional ethics." },
        { index: "04", slug: "ict-innovation", name: "ICT & Innovation", description: "Digital literacy, ICT integration in teaching, and modern classroom technology.", overview: "Digital literacy, ICT integration in teaching, and modern classroom technology." },
        { index: "05", slug: "home-science-creative-arts", name: "Home Science & Creative Arts", description: "Practical life skills, art, music, and creative pedagogy for holistic learner development.", overview: "Practical life skills, art, music, and creative pedagogy for holistic learner development." },
        { index: "06", slug: "guidance-counseling", name: "Guidance & Counseling", description: "Learner support, pastoral care methods, and counseling skills for the classroom teacher.", overview: "Learner support, pastoral care methods, and counseling skills for the classroom teacher." },
        { index: "07", slug: "physical-education", name: "Physical Education", description: "Sports pedagogy, games coaching, and health education for the primary curriculum.", overview: "Sports pedagogy, games coaching, and health education for the primary curriculum." },
        { index: "08", slug: "library-information-science", name: "Library & Information Science", description: "Information literacy and library-based learning support for trainee teachers.", overview: "Information literacy and library-based learning support for trainee teachers." },
        { index: "09", slug: "student-affairs-administration", name: "Student Affairs & Administration", description: "Pastoral care, discipline, and welfare structures supporting student life.", overview: "Pastoral care, discipline, and welfare structures supporting student life." },
      ],
      academicsIntro: {
        kicker: "Academic Excellence",
        heading: "Departments built around the classroom",
        intro: "Every department exists to answer one question: what does a first-year teacher actually need on day one in front of a class?",
      },
      quickLinks: [
        { icon: "Compass", title: "Our Vision", text: "To be a centre of excellence in teacher education, recognised nationally for the quality, character, and competence of its graduates.", linkHref: "", linkLabel: "" },
        { icon: "FileText", title: "Our Mission", text: "To train, mentor, and form competent, ethical, and reflective teachers equipped to serve Kenya's learners with skill and integrity.", linkHref: "", linkLabel: "" },
        { icon: "Users", title: "Principal's Office", text: "A message on our history, our standards, and where the College is headed next.", linkHref: "/about#principal", linkLabel: "Read the message" },
      ],
      whyUs: {
        kicker: "Why Asumbi TTC",
        heading: "What sets our formation apart",
        items: [
          { num: "58", title: "Years of consistent formation", text: "A long, unbroken record of preparing teachers for Kenyan classrooms since 1968." },
          { num: "12", title: "Weeks of supervised teaching practice", text: "Real classroom placements with structured supervision, not simulated practice alone." },
          { num: "1:14", title: "Tutor-to-student ratio", text: "Small enough that no student passes through unnoticed or unmentored." },
          { num: "92%", title: "Graduate placement rate", text: "Most graduates are teaching within a year of completing the programme." },
        ],
      },
      gallery: [
        { label: "Campus aerial view", image: null, tall: true, video: true },
        { label: "Teaching practice session", image: null, tall: false, video: false },
        { label: "Library reading hall", image: null, tall: false, video: false },
        { label: "Graduation ceremony", image: null, tall: true, video: false },
        { label: "ICT resource centre", image: null, tall: false, video: false },
        { label: "Student sports day", image: null, tall: false, video: false },
      ],
      partners: ["Ministry of Education", "TSC Kenya", "Diocese of Homa Bay", "KICD", "TVETA", "County Government"],
      visit: {
        kicker: "Plan Your Visit",
        heading: "Come see the campus for yourself",
        intro: "Prospective students and parents are welcome on campus on weekdays — no appointment needed for a walking tour, though booking ahead means a tutor can meet you.",
        mapImage: null,
      },
      finalCta: {
        kicker: "2027 Intake Now Open",
        heading: "Your classroom is waiting for you to be ready for it.",
        // "Prospective Students", not "Apply Now" — Asumbi doesn't
        // process applications directly (see admissionsExternal).
        primaryLabel: "Prospective Students",
        secondaryLabel: "Visit Campus",
      },
      // Shared by the Header (logo/name) and Footer (address/contact/social)
      // so both stay in sync from one place instead of duplicated fields.
      siteMeta: {
        schoolName: "Asumbi TTC",
        tagline: "Teachers Training College",
        logoUrl: null,
        addressLine1: "Asumbi Teachers Training College, Asumbi, Homa Bay County, Kenya",
        addressLine2: "P.O. Box 000, Homa Bay County, Kenya",
        officeHours: "Monday – Friday, 8:00 AM – 5:00 PM",
        phone: "+254 700 000 000",
        email: "info@asumbittc.ac.ke",
        copyrightText: "© 2026 Asumbi Teachers Training College. All rights reserved.",
        socialLinks: [
          { platform: "F", url: "#" },
          { platform: "X", url: "#" },
          { platform: "Y", url: "#" },
          { platform: "I", url: "#" },
        ],
      },
      aboutIntro: {
        visionHeading: "Our Vision",
        visionText: "To be a centre of excellence in teacher education, recognised nationally for the quality, character, and competence of its graduates.",
        missionHeading: "Our Mission",
        missionText: "To train, mentor, and form competent, ethical, and reflective teachers equipped to serve Kenya's learners with skill and integrity.",
      },
      coreValues: [
        { title: "Integrity", text: "We hold ourselves and our students to a consistent standard of honesty and professional ethics." },
        { title: "Excellence", text: "We pursue rigorous academic and pedagogical standards in everything we teach." },
        { title: "Service", text: "We form teachers who see the classroom as a place of vocation, not just employment." },
        { title: "Community", text: "We build a close-knit college where staff and students know and support one another." },
      ],
      // Deliberately informational, not transactional — Asumbi does not
      // process applications directly (see admissionsExternal below).
      // No "submit application" / "pay application fee" steps here.
      admissionSteps: [
        { step: "1", title: "Check requirements", text: "Confirm your KCSE grade meets the minimum for your chosen programme." },
        { step: "2", title: "Prepare your documents", text: "Gather your KCSE certificate, result slip, ID/birth certificate, and passport photos ahead of applying." },
        { step: "3", title: "Apply through the official channel", text: "Applications and placement are handled by the relevant official admissions authority — use the link below to apply." },
        { step: "4", title: "Await your admission outcome", text: "Successful applicants receive an official admission letter with reporting date from the admissions authority." },
      ],
      admissionRequirements: [
        "Diploma in Teacher Education: KCSE mean grade C- (minus) or above",
        "Certificate in ECDE: KCSE mean grade D+ (plus) or above",
        "Certified copies of KCSE certificate and result slip",
        "National ID or birth certificate",
        "Two passport-size photographs",
        "Completed medical examination form",
      ],
      programmes: [
        {
          slug: "diploma-in-teacher-education",
          name: "Diploma in Teacher Education",
          duration: "2 years",
          entry: "KCSE mean grade C- (minus)",
          overview: "A two-year programme preparing primary-school teachers in classroom craft, pedagogy, and professional practice.",
          subjects: "",
          careerPathways: "",
          entryRequirements: "KCSE mean grade C- (minus) or above",
        },
        {
          slug: "certificate-in-ecde",
          name: "Certificate in ECDE",
          duration: "2 years",
          entry: "KCSE mean grade D+ (plus)",
          overview: "A two-year programme in Early Childhood Development & Education, preparing teachers for the pre-primary classroom.",
          subjects: "",
          careerPathways: "",
          entryRequirements: "KCSE mean grade D+ (plus) or above",
        },
        {
          slug: "teaching-practice",
          name: "Teaching Practice",
          duration: "12 weeks (embedded)",
          entry: "Enrolled Diploma/Certificate students",
          overview: "A supervised classroom placement embedded within the Diploma and Certificate programmes.",
          subjects: "",
          careerPathways: "",
          entryRequirements: "Enrolled Diploma/Certificate students",
        },
        {
          slug: "professional-development-short-courses",
          name: "Professional Development (Short Courses)",
          duration: "1–4 weeks",
          entry: "Serving teachers, open enrolment",
          overview: "Short, focused courses for serving teachers looking to update their classroom skills.",
          subjects: "",
          careerPathways: "",
          entryRequirements: "Open enrolment for serving teachers",
        },
      ],
      // One eyebrow/title/lead per inner page's banner (PageHero).
      pageHeroes: {
        about: { eyebrow: "About Asumbi TTC", title: "Fifty-eight years of forming teachers with purpose", lead: "A faith-rooted institution in Homa Bay County, built on one conviction: the quality of a nation's classrooms depends on the quality of its teachers' preparation." },
        academics: { eyebrow: "Academics", title: "Nine departments, one classroom-first standard", lead: "Every course of study is built around what a first-year teacher actually needs on day one in front of a class." },
        admissions: { eyebrow: "2027 Intake Now Open", title: "Start your journey to becoming a teacher", lead: "Applications for the January 2027 intake close on 15 September 2026. Early application is strongly encouraged." },
        contact: { eyebrow: "Contact Us", title: "We'd love to hear from you", lead: "" },
        news: { eyebrow: "News & Events", title: "What's happening at Asumbi TTC", lead: "" },
        programmes: { eyebrow: "Academic Programmes", title: "Choose your path", lead: "Every course of study is built around what a first-year teacher actually needs on day one in front of a class." },
        departments: { eyebrow: "Academic Departments", title: "Nine departments, one classroom-first standard", lead: "Every department exists to answer one question: what does a first-year teacher actually need on day one in front of a class?" },
        gallery: { eyebrow: "Campus Life", title: "Campus Gallery", lead: "A look at life on campus — teaching practice, facilities, and student activities." },
        events: { eyebrow: "Events", title: "What's on at Asumbi TTC", lead: "Upcoming college events, ceremonies, and open days." },
        downloads: { eyebrow: "Resources", title: "Downloads & Documents", lead: "Prospectuses, forms, policies, and other official documents." },
        leadership: { eyebrow: "Leadership", title: "College Leadership", lead: "The people leading Asumbi Teachers Training College." },
      },
      // Empty by default — real, dated events are entered by an admin
      // rather than fabricated. The public Events page simply shows
      // nothing until one is added.
      events: [],
      // Asumbi does not process applications directly (see master
      // instructions). `url` starts blank rather than pointing at an
      // invented admissions body — the Admissions page hides the
      // button (shows only the note) until an admin sets a real URL.
      admissionsExternal: {
        url: "",
        label: "Official Admissions Information",
        note: "Applications and placement are handled through the relevant official admissions authority. Please use the official admissions channel for current application and placement information.",
      },
      // Both empty by default — real files/profiles are added by an
      // admin rather than fabricated.
      downloads: [],
      leadership: [],
    };

    for (const [sectionKey, defaultContent] of Object.entries(websiteDefaults)) {
      await pool.request()
        .input("sectionKey", sql.NVarChar, sectionKey)
        .input("contentJson", sql.NVarChar(sql.MAX), JSON.stringify(defaultContent))
        .query(`
          IF NOT EXISTS (SELECT 1 FROM website_content WHERE section_key = @sectionKey)
          INSERT INTO website_content (section_key, content_json, updated_by_name, updated_at)
          VALUES (@sectionKey, @contentJson, 'System (default)', GETDATE())
        `);
    }

    /* ---------------- website_content additive migration ----------------
       "programmes", "departments" and "news" gained new fields (slug,
       overview, subjects, careerPathways, entryRequirements, body) for
       the detail pages. The seed loop above only inserts a section that
       doesn't exist at all — a DB that already had these sections from
       before keeps its old shape forever otherwise. This patches ONLY
       the missing keys onto each existing item, so anything an admin
       already edited is left exactly as they left it. Runs every boot
       but is a no-op once every row has caught up. */
    const slugify = (s) =>
      String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    const patchMissingFields = async (sectionKey, defaultsFor) => {
      try {
        const existing = await pool.request()
          .input("sectionKey", sql.NVarChar, sectionKey)
          .query(`SELECT content_json FROM website_content WHERE section_key=@sectionKey`);
        const row = existing.recordset[0];
        if (!row) return;

        let items;
        try { items = JSON.parse(row.content_json); } catch { return; }
        if (!Array.isArray(items)) return;

        let changed = false;
        const patched = items.map((item) => {
          const merged = { ...defaultsFor(item), ...item }; // existing fields always win
          if (JSON.stringify(merged) !== JSON.stringify(item)) changed = true;
          return merged;
        });
        if (!changed) return;

        await pool.request()
          .input("sectionKey", sql.NVarChar, sectionKey)
          .input("contentJson", sql.NVarChar(sql.MAX), JSON.stringify(patched))
          .query(`UPDATE website_content SET content_json=@contentJson WHERE section_key=@sectionKey`);
      } catch (err) {
        console.log(`WEBSITE CONTENT MIGRATION (${sectionKey}) ERROR:`, err.message);
      }
    };

    await patchMissingFields("programmes", (p) => ({
      slug: slugify(p.name),
      overview: "",
      subjects: "",
      careerPathways: "",
      entryRequirements: p.entry || "",
    }));
    await patchMissingFields("departments", (d) => ({
      slug: slugify(d.name),
      overview: d.description || "",
      staff: "",
    }));
    await patchMissingFields("news", (n) => ({
      slug: slugify(n.title),
      body: n.excerpt || "",
    }));

    // pageHeroes is a single object (not an array of items), so it
    // needs its own patcher: fill in only the new page keys that
    // don't exist yet on an already-deployed DB, leaving any edited
    // existing page heroes untouched.
    const patchMissingObjectKeys = async (sectionKey, extraKeys) => {
      try {
        const existing = await pool.request()
          .input("sectionKey", sql.NVarChar, sectionKey)
          .query(`SELECT content_json FROM website_content WHERE section_key=@sectionKey`);
        const row = existing.recordset[0];
        if (!row) return;

        let content;
        try { content = JSON.parse(row.content_json); } catch { return; }
        if (!content || typeof content !== "object" || Array.isArray(content)) return;

        const merged = { ...extraKeys, ...content };
        if (JSON.stringify(merged) === JSON.stringify(content)) return;

        await pool.request()
          .input("sectionKey", sql.NVarChar, sectionKey)
          .input("contentJson", sql.NVarChar(sql.MAX), JSON.stringify(merged))
          .query(`UPDATE website_content SET content_json=@contentJson WHERE section_key=@sectionKey`);
      } catch (err) {
        console.log(`WEBSITE CONTENT MIGRATION (${sectionKey}) ERROR:`, err.message);
      }
    };

    await patchMissingObjectKeys("pageHeroes", {
      programmes: { eyebrow: "Academic Programmes", title: "Choose your path", lead: "Every course of study is built around what a first-year teacher actually needs on day one in front of a class." },
      departments: { eyebrow: "Academic Departments", title: "Nine departments, one classroom-first standard", lead: "Every department exists to answer one question: what does a first-year teacher actually need on day one in front of a class?" },
      gallery: { eyebrow: "Campus Life", title: "Campus Gallery", lead: "A look at life on campus — teaching practice, facilities, and student activities." },
      events: { eyebrow: "Events", title: "What's on at Asumbi TTC", lead: "Upcoming college events, ceremonies, and open days." },
      downloads: { eyebrow: "Resources", title: "Downloads & Documents", lead: "Prospectuses, forms, policies, and other official documents." },
      leadership: { eyebrow: "Leadership", title: "College Leadership", lead: "The people leading Asumbi Teachers Training College." },
    });

    /* ---------------- contact_messages table ----------------
       Backs POST /api/contact (public) — submissions from the public
       marketing website's Contact page form. That form used to be a
       client-side-only stub with no backend at all (see routes/contact.js);
       this is where those submissions now actually land so an admin can
       read them, instead of silently vanishing on every page refresh. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='contact_messages' AND xtype='U')
      CREATE TABLE contact_messages (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(200) NOT NULL,
        email NVARCHAR(200) NOT NULL,
        phone NVARCHAR(50) NULL,
        message NVARCHAR(MAX) NOT NULL,
        isRead BIT NOT NULL DEFAULT 0,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    /* ---------------- newsletter_subscribers table ----------------
       Backs POST /api/contact/newsletter (public) — the email field in
       the public website's Footer, same "used to go nowhere" gap as
       contact_messages above. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='newsletter_subscribers' AND xtype='U')
      CREATE TABLE newsletter_subscribers (
        id INT IDENTITY(1,1) PRIMARY KEY,
        email NVARCHAR(200) NOT NULL UNIQUE,
        createdAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    console.log("✅ Schema check complete (election_* Student Council tables, Notifications, Notifications.link, Notifications/ScheduledNotifications.createdByName, ScheduledNotifications, NotificationSettings, PortalPageSettings, e_assessment_question_setters, questions_deadline, leave_outs.leave_type, leave_outs approval-workflow columns, leave_outs gate-verification columns, leave_outs code-verification columns, meal_daily_codes, leave_auto_approve, mustChangePassword, Users.permissions, Users.name, staff→sub_admin migration, Students/Teachers.photoUrl, Students.profileCompleted, student_profile_change_requests, website_content, contact_messages, newsletter_subscribers)");
  } catch (err) {
    console.error("⚠️  Schema ensure failed:", err.message);
  }
}

module.exports = { ensureSchema };