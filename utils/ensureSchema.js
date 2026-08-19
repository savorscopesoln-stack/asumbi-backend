/* =========================================================
   ENSURE SCHEMA
   Idempotent startup checks so the app works whether these
   tables/columns already exist in the DB or not. Safe to run
   on every server boot.
========================================================= */

async function ensureSchema(pool, sql) {
  try {
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

    console.log("✅ Schema check complete (Notifications, leave_outs.leave_type, mustChangePassword, Users.permissions, staff→sub_admin migration)");
  } catch (err) {
    console.error("⚠️  Schema ensure failed:", err.message);
  }
}

module.exports = { ensureSchema };
