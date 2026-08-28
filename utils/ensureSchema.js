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
      },
      principal: {
        name: "Dr. [Principal's Name]",
        title: "Principal, Asumbi Teachers Training College · PhD Education Administration",
        yearsLabel: "15 yrs",
        quote: "We do not simply teach subjects. We form teachers.",
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
          tag: "Admissions",
          tagColor: "maroon",
          title: "2027 intake applications now open",
          excerpt: "Prospective students can now apply for the Diploma in Teacher Education and Certificate in ECDE for the January 2027 intake.",
          date: "24 July 2026",
        },
        {
          tag: "Events",
          tagColor: "green",
          title: "Founders' Day & graduation set for November",
          excerpt: "The College will mark 58 years of service alongside this year's graduating class on 14 November 2026.",
          date: "18 July 2026",
        },
        {
          tag: "Facilities",
          tagColor: "gold",
          title: "New ICT Resource Centre now open",
          excerpt: "A fully equipped computer lab and digital learning space is now available to all students and staff.",
          date: "2 July 2026",
        },
      ],
      testimonials: [
        {
          initials: "GA",
          quote: "Teaching practice at Asumbi wasn't a formality — it's where I actually learned to run a classroom. I walked into my first posting already confident.",
          name: "Grace A.",
          detail: "Diploma in Teacher Education, 2022",
        },
        {
          initials: "BO",
          quote: "The tutors know your name and your weaknesses, and they don't let you graduate until both are addressed. That is rare, and it matters.",
          name: "Brian O.",
          detail: "Diploma in Teacher Education, 2021",
        },
        {
          initials: "FM",
          quote: "I came in unsure if teaching was really for me. I left certain of it, and with the classroom management skills to prove it.",
          name: "Faith M.",
          detail: "Certificate in ECDE, 2023",
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

    console.log("✅ Schema check complete (election_* Student Council tables, Notifications, Notifications.link, Notifications/ScheduledNotifications.createdByName, ScheduledNotifications, NotificationSettings, PortalPageSettings, e_assessment_question_setters, questions_deadline, leave_outs.leave_type, leave_outs approval-workflow columns, leave_outs gate-verification columns, leave_outs code-verification columns, meal_daily_codes, leave_auto_approve, mustChangePassword, Users.permissions, Users.name, staff→sub_admin migration, Students/Teachers.photoUrl, Students.profileCompleted, student_profile_change_requests, website_content)");
  } catch (err) {
    console.error("⚠️  Schema ensure failed:", err.message);
  }
}

module.exports = { ensureSchema };