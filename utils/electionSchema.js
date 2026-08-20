/* =========================================================
   STUDENT COUNCIL VOTING SYSTEM — SCHEMA BOOTSTRAP
   Idempotent, safe to run on every boot (same pattern as
   ensureSchema.js). Creates the election_* tables the module
   needs and nothing else — it deliberately reuses the existing
   Students/Users tables instead of duplicating student data.

   Tables:
     election_elections       — one row per election, drives the
                                 DRAFT → ... → RESULTS state machine
     election_posts           — posts up for election (college-wide
                                 or tied to one studentClass)
     election_parties         — school parties, scoped to an election
     election_applications    — a student's application for one post
     election_candidates      — created automatically when an
                                 application is approved
     election_running_mates   — one running mate per candidate
     election_ballots         — marks that ballots were generated
                                 for an election (gates VOTING_OPEN)
     election_votes           — one row per student per election
                                 (the "has this student voted" record)
     election_vote_items      — the actual post→candidate selections
                                 that make up a submitted vote
========================================================= */

async function ensureElectionSchema(pool, sql) {
  try {
    /* ---------------- election_elections ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_elections' AND xtype='U')
      CREATE TABLE election_elections (
        id INT IDENTITY(1,1) PRIMARY KEY,
        title NVARCHAR(200) NOT NULL,
        description NVARCHAR(MAX) NULL,
        status NVARCHAR(30) NOT NULL DEFAULT 'DRAFT',
        applicationsOpenAt DATETIME NULL,
        applicationsClosedAt DATETIME NULL,
        candidatesFinalizedAt DATETIME NULL,
        ballotsGeneratedAt DATETIME NULL,
        votingOpenAt DATETIME NULL,
        votingClosedAt DATETIME NULL,
        resultsPublishedAt DATETIME NULL,
        createdBy INT NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        updatedAt DATETIME NOT NULL DEFAULT GETDATE()
      )
    `);

    /* ---------------- election_posts ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_posts' AND xtype='U')
      CREATE TABLE election_posts (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        title NVARCHAR(150) NOT NULL,
        description NVARCHAR(500) NULL,
        scope NVARCHAR(20) NOT NULL DEFAULT 'COLLEGE_WIDE',
        studentClass NVARCHAR(100) NULL,
        displayOrder INT NOT NULL DEFAULT 0,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_posts_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_election_posts_election' AND object_id = OBJECT_ID('election_posts'))
      CREATE INDEX IX_election_posts_election ON election_posts(electionId)
    `);

    /* ---------------- election_parties ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_parties' AND xtype='U')
      CREATE TABLE election_parties (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        name NVARCHAR(150) NOT NULL,
        slogan NVARCHAR(300) NULL,
        logoUrl NVARCHAR(500) NULL,
        colorHex NVARCHAR(20) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_parties_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE,
        CONSTRAINT UQ_election_parties_name UNIQUE (electionId, name)
      )
    `);

    /* ---------------- election_applications ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_applications' AND xtype='U')
      CREATE TABLE election_applications (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        postId INT NOT NULL,
        studentId INT NOT NULL,
        manifesto NVARCHAR(MAX) NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'pending',
        rejectionReason NVARCHAR(500) NULL,
        reviewedBy INT NULL,
        reviewedAt DATETIME NULL,
        appliedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_apps_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE,
        CONSTRAINT FK_election_apps_post FOREIGN KEY (postId)
          REFERENCES election_posts(id),
        CONSTRAINT UQ_election_apps_unique UNIQUE (electionId, postId, studentId)
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_election_apps_election' AND object_id = OBJECT_ID('election_applications'))
      CREATE INDEX IX_election_apps_election ON election_applications(electionId)
    `);

    /* ---------------- election_candidates ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_candidates' AND xtype='U')
      CREATE TABLE election_candidates (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        postId INT NOT NULL,
        applicationId INT NOT NULL,
        studentId INT NOT NULL,
        partyId INT NULL,
        manifesto NVARCHAR(MAX) NULL,
        ballotNumber INT NULL,
        isFinalized BIT NOT NULL DEFAULT 0,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_cand_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE,
        CONSTRAINT FK_election_cand_post FOREIGN KEY (postId)
          REFERENCES election_posts(id),
        CONSTRAINT UQ_election_cand_application UNIQUE (applicationId)
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_election_cand_election' AND object_id = OBJECT_ID('election_candidates'))
      CREATE INDEX IX_election_cand_election ON election_candidates(electionId)
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_election_cand_post' AND object_id = OBJECT_ID('election_candidates'))
      CREATE INDEX IX_election_cand_post ON election_candidates(postId)
    `);

    /* ---------------- election_running_mates ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_running_mates' AND xtype='U')
      CREATE TABLE election_running_mates (
        id INT IDENTITY(1,1) PRIMARY KEY,
        candidateId INT NOT NULL,
        studentId INT NOT NULL,
        roleLabel NVARCHAR(100) NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_rm_candidate FOREIGN KEY (candidateId)
          REFERENCES election_candidates(id) ON DELETE CASCADE,
        CONSTRAINT UQ_election_rm_candidate UNIQUE (candidateId)
      )
    `);

    /* ---------------- election_ballots ----------------
       One row = "ballots have been generated for this election".
       Content is derived live from finalized candidates rather
       than duplicated here — this table just gates the
       CANDIDATES_FINALIZED → VOTING_OPEN transition and records
       who generated them and when. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_ballots' AND xtype='U')
      CREATE TABLE election_ballots (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        generatedBy INT NULL,
        generatedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_ballots_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE,
        CONSTRAINT UQ_election_ballots_election UNIQUE (electionId)
      )
    `);

    /* ---------------- election_votes ----------------
       One row per student per election — the durable "this
       student has voted" receipt. The UNIQUE constraint is the
       hard backstop against double voting, on top of the
       application-level checks. */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_votes' AND xtype='U')
      CREATE TABLE election_votes (
        id INT IDENTITY(1,1) PRIMARY KEY,
        electionId INT NOT NULL,
        studentId INT NOT NULL,
        submittedAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_votes_election FOREIGN KEY (electionId)
          REFERENCES election_elections(id) ON DELETE CASCADE,
        CONSTRAINT UQ_election_votes_student UNIQUE (electionId, studentId)
      )
    `);

    /* ---------------- election_vote_items ---------------- */
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='election_vote_items' AND xtype='U')
      CREATE TABLE election_vote_items (
        id INT IDENTITY(1,1) PRIMARY KEY,
        voteId INT NOT NULL,
        electionId INT NOT NULL,
        postId INT NOT NULL,
        candidateId INT NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT FK_election_vi_vote FOREIGN KEY (voteId)
          REFERENCES election_votes(id) ON DELETE CASCADE,
        CONSTRAINT UQ_election_vi_post UNIQUE (voteId, postId)
      )
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_election_vi_candidate' AND object_id = OBJECT_ID('election_vote_items'))
      CREATE INDEX IX_election_vi_candidate ON election_vote_items(candidateId)
    `);

    /* ---------------- election_applications.previousStatus ----------------
       Remembers what status an application had right before it was
       suspended, so "Reactivate" can put it back where it came from
       (pending vs. approved) instead of guessing. */
    await pool.request().query(`
      IF NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'previousStatus' AND Object_ID = Object_ID(N'election_applications')
      )
      ALTER TABLE election_applications ADD previousStatus NVARCHAR(20) NULL
    `);

    /* ---------------- election_candidates.status ----------------
       active | suspended — lets the officer suspend a candidate
       (before or after finalization) without deleting their record.
       Suspended candidates are excluded from ballots/voting. */
    await pool.request().query(`
      IF NOT EXISTS (
        SELECT * FROM sys.columns
        WHERE Name = N'status' AND Object_ID = Object_ID(N'election_candidates')
      )
      ALTER TABLE election_candidates ADD status NVARCHAR(20) NOT NULL CONSTRAINT DF_election_candidates_status DEFAULT 'active'
    `);

    console.log("✅ Student Council schema check complete (election_elections, election_posts, election_parties, election_applications, election_candidates, election_running_mates, election_ballots, election_votes, election_vote_items)");
  } catch (err) {
    console.error("⚠️  Election schema ensure failed:", err.message);
  }
}

module.exports = { ensureElectionSchema };
