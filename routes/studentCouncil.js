const express = require("express");
const router = express.Router();
const { sql } = require("../config/db");
const { protect, requirePage, authorize } = require("../middleware/authMiddleware");
const { notifyUsers } = require("../utils/notify");

/* =========================================================
   STUDENT COUNCIL VOTING SYSTEM
   Mounted at /api/student-council in server.js.

   Reuses the existing Students table for every bit of applicant/
   voter/candidate/running-mate information (name, admissionNo,
   studentClass, gender, yearOfStudy, Phone, photoUrl) — nothing
   about a student is duplicated here. Reuses the existing
   protect/requirePage/authorize middleware and the existing
   photo storage (Students.photoUrl, served from /uploads/photos).

   Officer-side routes: protect + requirePage("Student Council")
   (admin always passes; a sub_admin needs that page granted).
   Student-side routes: protect + authorize("student").
========================================================= */

const officerOnly = requirePage("Student Council");
const studentOnly = authorize("student");

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/* Columns pulled from Students for anything election-facing — the
   full "applicant/voter information" the spec asks for, minus the
   password hash. */
const STUDENT_COLUMNS = `
  s.id AS studentId, s.name, s.admissionNo, s.studentClass, s.gender,
  s.yearOfStudy, s.Phone, s.photoUrl, s.status AS studentStatus
`;

/* =========================================================
   STATE MACHINE HELPERS
========================================================= */
const STATES = [
  "DRAFT",
  "APPLICATIONS_OPEN",
  "APPLICATIONS_CLOSED",
  "CANDIDATES_FINALIZED",
  "VOTING_OPEN",
  "VOTING_CLOSED",
  "RESULTS",
];

async function getElection(pool, electionId) {
  const result = await pool
    .request()
    .input("id", sql.Int, electionId)
    .query(`SELECT * FROM election_elections WHERE id = @id`);
  return result.recordset[0] || null;
}

function requireState(election, allowed, res) {
  if (!election) {
    res.status(404).json({ message: "Election not found" });
    return false;
  }
  if (!allowed.includes(election.status)) {
    res.status(409).json({
      message: `This action isn't allowed while the election is "${election.status}".`,
      currentStatus: election.status,
      allowedStatuses: allowed,
    });
    return false;
  }
  return true;
}

/* =========================================================
   ELECTIONS
========================================================= */

// GET /api/student-council/elections — list (officer)
router.get("/elections", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM election_posts p WHERE p.electionId = e.id) AS postCount,
        (SELECT COUNT(*) FROM election_applications a WHERE a.electionId = e.id) AS applicationCount,
        (SELECT COUNT(*) FROM election_candidates c WHERE c.electionId = e.id) AS candidateCount,
        (SELECT COUNT(*) FROM election_votes v WHERE v.electionId = e.id) AS voteCount
      FROM election_elections e
      ORDER BY e.createdAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.log("ELECTIONS LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load elections" });
  }
});

// POST /api/student-council/elections — create (officer)
router.post("/elections", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const { title, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Election title is required" });
    }

    const result = await pool
      .request()
      .input("title", sql.NVarChar, title.trim())
      .input("description", sql.NVarChar, description || null)
      .input("createdBy", sql.Int, req.user.id)
      .query(`
        INSERT INTO election_elections (title, description, status, createdBy)
        OUTPUT INSERTED.*
        VALUES (@title, @description, 'DRAFT', @createdBy)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.log("ELECTION CREATE ERROR:", err);
    res.status(500).json({ message: "Failed to create election" });
  }
});

// GET /api/student-council/elections/:id — detail + overview stats (officer)
router.get("/elections/:id", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid election id" });

    const election = await getElection(pool, id);
    if (!election) return res.status(404).json({ message: "Election not found" });

    const [posts, applications, candidates, parties, voters, votes, ballot] = await Promise.all([
      pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_posts WHERE electionId=@id ORDER BY displayOrder, id`),
      pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c, status FROM election_applications WHERE electionId=@id GROUP BY status`),
      pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c FROM election_candidates WHERE electionId=@id`),
      pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_parties WHERE electionId=@id ORDER BY name`),
      pool.request().query(`SELECT COUNT(*) c FROM Students WHERE status='active'`),
      pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c FROM election_votes WHERE electionId=@id`),
      pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_ballots WHERE electionId=@id`),
    ]);

    const applicationStatusCounts = {};
    for (const row of applications.recordset) applicationStatusCounts[row.status] = row.c;

    const registeredVoters = voters.recordset[0]?.c || 0;
    const votesSubmitted = votes.recordset[0]?.c || 0;

    res.json({
      election,
      posts: posts.recordset,
      parties: parties.recordset,
      overview: {
        applicationStatusCounts,
        totalApplications: Object.values(applicationStatusCounts).reduce((a, b) => a + b, 0),
        candidateCount: candidates.recordset[0]?.c || 0,
        registeredVoters,
        votesSubmitted,
        remainingVoters: Math.max(registeredVoters - votesSubmitted, 0),
        votingPercentage: registeredVoters > 0 ? Math.round((votesSubmitted / registeredVoters) * 1000) / 10 : 0,
        ballotsGenerated: !!ballot.recordset[0],
      },
    });
  } catch (err) {
    console.log("ELECTION DETAIL ERROR:", err);
    res.status(500).json({ message: "Failed to load election" });
  }
});

// PUT /api/student-council/elections/:id — edit title/description (officer, DRAFT only)
router.put("/elections/:id", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["DRAFT"], res)) return;

    const { title, description } = req.body;
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("title", sql.NVarChar, (title || election.title).trim())
      .input("description", sql.NVarChar, description ?? election.description)
      .query(`
        UPDATE election_elections
        SET title=@title, description=@description, updatedAt=GETDATE()
        WHERE id=@id
      `);

    res.json({ message: "Election updated" });
  } catch (err) {
    console.log("ELECTION UPDATE ERROR:", err);
    res.status(500).json({ message: "Failed to update election" });
  }
});

/* ---- state transitions ---- */

// POST /api/student-council/elections/:id/open-applications
router.post("/elections/:id/open-applications", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["DRAFT"], res)) return;

    const postCount = await pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c FROM election_posts WHERE electionId=@id`);
    if (!postCount.recordset[0].c) {
      return res.status(400).json({ message: "Add at least one post before opening applications" });
    }

    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='APPLICATIONS_OPEN', applicationsOpenAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);
    res.json({ message: "Applications are now open" });
  } catch (err) {
    console.log("OPEN APPLICATIONS ERROR:", err);
    res.status(500).json({ message: "Failed to open applications" });
  }
});

// POST /api/student-council/elections/:id/close-applications
router.post("/elections/:id/close-applications", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["APPLICATIONS_OPEN"], res)) return;

    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='APPLICATIONS_CLOSED', applicationsClosedAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);
    res.json({ message: "Applications are now closed" });
  } catch (err) {
    console.log("CLOSE APPLICATIONS ERROR:", err);
    res.status(500).json({ message: "Failed to close applications" });
  }
});

// POST /api/student-council/elections/:id/finalize-candidates
router.post("/elections/:id/finalize-candidates", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["APPLICATIONS_CLOSED"], res)) return;

    const candCount = await pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c FROM election_candidates WHERE electionId=@id AND status='active'`);
    if (!candCount.recordset[0].c) {
      return res.status(400).json({ message: "Approve at least one active (non-suspended) applicant before finalizing candidates" });
    }

    // Only active candidates get finalized — a suspended one stays
    // un-finalized so it's excluded from ballots/voting entirely.
    await pool.request().input("id", sql.Int, id).query(`UPDATE election_candidates SET isFinalized=1 WHERE electionId=@id AND status='active'`);
    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='CANDIDATES_FINALIZED', candidatesFinalizedAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);
    res.json({ message: "Candidates finalized" });
  } catch (err) {
    console.log("FINALIZE CANDIDATES ERROR:", err);
    res.status(500).json({ message: "Failed to finalize candidates" });
  }
});

// POST /api/student-council/elections/:id/generate-ballots
router.post("/elections/:id/generate-ballots", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["CANDIDATES_FINALIZED"], res)) return;

    const existing = await pool.request().input("id", sql.Int, id).query(`SELECT id FROM election_ballots WHERE electionId=@id`);
    if (!existing.recordset.length) {
      await pool
        .request()
        .input("id", sql.Int, id)
        .input("by", sql.Int, req.user.id)
        .query(`INSERT INTO election_ballots (electionId, generatedBy) VALUES (@id, @by)`);
    }
    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET ballotsGeneratedAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);

    res.json({ message: "Official ballots generated" });
  } catch (err) {
    console.log("GENERATE BALLOTS ERROR:", err);
    res.status(500).json({ message: "Failed to generate ballots" });
  }
});

// POST /api/student-council/elections/:id/open-voting
router.post("/elections/:id/open-voting", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["CANDIDATES_FINALIZED"], res)) return;

    const ballot = await pool.request().input("id", sql.Int, id).query(`SELECT id FROM election_ballots WHERE electionId=@id`);
    if (!ballot.recordset.length) {
      return res.status(400).json({ message: "Generate ballots before opening voting" });
    }

    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='VOTING_OPEN', votingOpenAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);
    res.json({ message: "Voting is now open" });
  } catch (err) {
    console.log("OPEN VOTING ERROR:", err);
    res.status(500).json({ message: "Failed to open voting" });
  }
});

// POST /api/student-council/elections/:id/close-voting
router.post("/elections/:id/close-voting", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["VOTING_OPEN"], res)) return;

    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='VOTING_CLOSED', votingClosedAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);
    res.json({ message: "Voting is now closed" });
  } catch (err) {
    console.log("CLOSE VOTING ERROR:", err);
    res.status(500).json({ message: "Failed to close voting" });
  }
});

// POST /api/student-council/elections/:id/publish-results
router.post("/elections/:id/publish-results", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["VOTING_CLOSED"], res)) return;

    await pool.request().input("id", sql.Int, id).query(`
      UPDATE election_elections SET status='RESULTS', resultsPublishedAt=GETDATE(), updatedAt=GETDATE() WHERE id=@id
    `);

    // Notify every student that results are out, and separately
    // congratulate whoever won each post. Never let a notification
    // problem fail the publish itself — results are already committed
    // above, so this runs best-effort afterwards.
    try {
      const results = await fetchResults(pool, id);

      const activeStudents = await pool.request().query(
        `SELECT id FROM Students WHERE status='active'`
      );
      const voters = (activeStudents.recordset || []).map((s) => ({ id: s.id, source: "Students" }));

      await notifyUsers(pool, voters, {
        title: "Election Results Published",
        message: `Results for "${election.title}" are out. Head to Student Council → Vote to see who won.`,
        type: "election",
        link: "/student/council",
      });

      for (const { post, results: postResults } of results.posts) {
        if (!postResults.length) continue;
        const top = postResults[0];
        if (!top.votes || !top.candidate) continue;
        // Skip a tie for first place — nobody clearly won that post.
        const tied = postResults.filter((r) => r.votes === top.votes).length > 1;
        if (tied) continue;

        await notifyUsers(pool, [{ id: top.candidate.studentId, source: "Students" }], {
          title: "Congratulations! 🎉",
          message: `Congratulations, ${top.candidate.name}! You have been elected ${post.title} in "${election.title}".`,
          type: "election",
          link: "/student/council",
        });
      }
    } catch (notifyErr) {
      console.log("PUBLISH RESULTS NOTIFY ERROR:", notifyErr);
    }

    res.json({ message: "Results published" });
  } catch (err) {
    console.log("PUBLISH RESULTS ERROR:", err);
    res.status(500).json({ message: "Failed to publish results" });
  }
});

/* =========================================================
   POSTS (officer)
========================================================= */

router.get("/elections/:electionId/posts", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const result = await pool
      .request()
      .input("id", sql.Int, electionId)
      .query(`SELECT * FROM election_posts WHERE electionId=@id ORDER BY displayOrder, id`);
    res.json(result.recordset);
  } catch (err) {
    console.log("POSTS LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load posts" });
  }
});

router.post("/elections/:electionId/posts", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const election = await getElection(pool, electionId);
    if (!requireState(election, ["DRAFT", "APPLICATIONS_OPEN"], res)) return;

    const { title, description, scope, studentClass, displayOrder } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ message: "Post title is required" });

    const normalizedScope = scope === "CLASS_BASED" ? "CLASS_BASED" : "COLLEGE_WIDE";
    if (normalizedScope === "CLASS_BASED" && !studentClass) {
      return res.status(400).json({ message: "Class-based posts need a class" });
    }

    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("title", sql.NVarChar, title.trim())
      .input("description", sql.NVarChar, description || null)
      .input("scope", sql.NVarChar, normalizedScope)
      .input("studentClass", sql.NVarChar, normalizedScope === "CLASS_BASED" ? studentClass : null)
      .input("displayOrder", sql.Int, toInt(displayOrder) || 0)
      .query(`
        INSERT INTO election_posts (electionId, title, description, scope, studentClass, displayOrder)
        OUTPUT INSERTED.*
        VALUES (@electionId, @title, @description, @scope, @studentClass, @displayOrder)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.log("POST CREATE ERROR:", err);
    res.status(500).json({ message: "Failed to create post" });
  }
});

router.put("/posts/:postId", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const postId = toInt(req.params.postId);
    const existing = await pool.request().input("id", sql.Int, postId).query(`SELECT * FROM election_posts WHERE id=@id`);
    const post = existing.recordset[0];
    if (!post) return res.status(404).json({ message: "Post not found" });

    const election = await getElection(pool, post.electionId);
    if (!requireState(election, ["DRAFT", "APPLICATIONS_OPEN"], res)) return;

    const { title, description, scope, studentClass, displayOrder } = req.body;
    const normalizedScope = scope === "CLASS_BASED" ? "CLASS_BASED" : scope === "COLLEGE_WIDE" ? "COLLEGE_WIDE" : post.scope;
    if (normalizedScope === "CLASS_BASED" && !(studentClass || post.studentClass)) {
      return res.status(400).json({ message: "Class-based posts need a class" });
    }

    await pool
      .request()
      .input("id", sql.Int, postId)
      .input("title", sql.NVarChar, (title || post.title).trim())
      .input("description", sql.NVarChar, description ?? post.description)
      .input("scope", sql.NVarChar, normalizedScope)
      .input("studentClass", sql.NVarChar, normalizedScope === "CLASS_BASED" ? (studentClass || post.studentClass) : null)
      .input("displayOrder", sql.Int, toInt(displayOrder) ?? post.displayOrder)
      .query(`
        UPDATE election_posts
        SET title=@title, description=@description, scope=@scope,
            studentClass=@studentClass, displayOrder=@displayOrder
        WHERE id=@id
      `);

    res.json({ message: "Post updated" });
  } catch (err) {
    console.log("POST UPDATE ERROR:", err);
    res.status(500).json({ message: "Failed to update post" });
  }
});

router.delete("/posts/:postId", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const postId = toInt(req.params.postId);
    const existing = await pool.request().input("id", sql.Int, postId).query(`SELECT * FROM election_posts WHERE id=@id`);
    const post = existing.recordset[0];
    if (!post) return res.status(404).json({ message: "Post not found" });

    const election = await getElection(pool, post.electionId);
    if (!requireState(election, ["DRAFT", "APPLICATIONS_OPEN"], res)) return;

    const apps = await pool.request().input("id", sql.Int, postId).query(`SELECT COUNT(*) c FROM election_applications WHERE postId=@id`);
    if (apps.recordset[0].c > 0) {
      return res.status(409).json({ message: "Can't delete a post that already has applications" });
    }

    await pool.request().input("id", sql.Int, postId).query(`DELETE FROM election_posts WHERE id=@id`);
    res.json({ message: "Post deleted" });
  } catch (err) {
    console.log("POST DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete post" });
  }
});

/* =========================================================
   PARTIES (officer)
========================================================= */

router.get("/elections/:electionId/parties", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const result = await pool
      .request()
      .input("id", sql.Int, electionId)
      .query(`SELECT * FROM election_parties WHERE electionId=@id ORDER BY name`);
    res.json(result.recordset);
  } catch (err) {
    console.log("PARTIES LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load parties" });
  }
});

router.post("/elections/:electionId/parties", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const { name, slogan, logoUrl, colorHex } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: "Party name is required" });

    const exists = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("name", sql.NVarChar, name.trim())
      .query(`SELECT id FROM election_parties WHERE electionId=@electionId AND name=@name`);
    if (exists.recordset.length) return res.status(400).json({ message: "A party with this name already exists" });

    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("name", sql.NVarChar, name.trim())
      .input("slogan", sql.NVarChar, slogan || null)
      .input("logoUrl", sql.NVarChar, logoUrl || null)
      .input("colorHex", sql.NVarChar, colorHex || null)
      .query(`
        INSERT INTO election_parties (electionId, name, slogan, logoUrl, colorHex)
        OUTPUT INSERTED.*
        VALUES (@electionId, @name, @slogan, @logoUrl, @colorHex)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.log("PARTY CREATE ERROR:", err);
    res.status(500).json({ message: "Failed to create party" });
  }
});

router.put("/parties/:partyId", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const partyId = toInt(req.params.partyId);
    const existing = await pool.request().input("id", sql.Int, partyId).query(`SELECT * FROM election_parties WHERE id=@id`);
    const party = existing.recordset[0];
    if (!party) return res.status(404).json({ message: "Party not found" });

    const { name, slogan, logoUrl, colorHex } = req.body;
    await pool
      .request()
      .input("id", sql.Int, partyId)
      .input("name", sql.NVarChar, (name || party.name).trim())
      .input("slogan", sql.NVarChar, slogan ?? party.slogan)
      .input("logoUrl", sql.NVarChar, logoUrl ?? party.logoUrl)
      .input("colorHex", sql.NVarChar, colorHex ?? party.colorHex)
      .query(`
        UPDATE election_parties SET name=@name, slogan=@slogan, logoUrl=@logoUrl, colorHex=@colorHex
        WHERE id=@id
      `);

    res.json({ message: "Party updated" });
  } catch (err) {
    console.log("PARTY UPDATE ERROR:", err);
    res.status(500).json({ message: "Failed to update party" });
  }
});

router.delete("/parties/:partyId", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const partyId = toInt(req.params.partyId);

    const inUse = await pool.request().input("id", sql.Int, partyId).query(`SELECT COUNT(*) c FROM election_candidates WHERE partyId=@id`);
    if (inUse.recordset[0].c > 0) {
      return res.status(409).json({ message: "Can't delete a party assigned to candidates" });
    }

    await pool.request().input("id", sql.Int, partyId).query(`DELETE FROM election_parties WHERE id=@id`);
    res.json({ message: "Party deleted" });
  } catch (err) {
    console.log("PARTY DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete party" });
  }
});

/* =========================================================
   APPLICATIONS (officer review)
========================================================= */

// GET /api/student-council/elections/:electionId/applications?status=&postId=
router.get("/elections/:electionId/applications", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const request = pool.request().input("electionId", sql.Int, electionId);

    let query = `
      SELECT a.*, p.title AS postTitle, p.scope AS postScope, p.studentClass AS postClass,
        ${STUDENT_COLUMNS},
        c.id AS candidateId, c.isFinalized
      FROM election_applications a
      JOIN election_posts p ON p.id = a.postId
      JOIN Students s ON s.id = a.studentId
      LEFT JOIN election_candidates c ON c.applicationId = a.id
      WHERE a.electionId = @electionId
    `;

    if (req.query.status) {
      request.input("status", sql.NVarChar, req.query.status);
      query += ` AND a.status = @status`;
    }
    if (req.query.postId) {
      request.input("postId", sql.Int, toInt(req.query.postId));
      query += ` AND a.postId = @postId`;
    }

    query += ` ORDER BY a.appliedAt DESC`;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.log("APPLICATIONS LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load applications" });
  }
});

// GET /api/student-council/applications/:id — full detail (officer)
router.get("/applications/:id", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT a.*, p.title AS postTitle, p.scope AS postScope, p.studentClass AS postClass,
          ${STUDENT_COLUMNS}
        FROM election_applications a
        JOIN election_posts p ON p.id = a.postId
        JOIN Students s ON s.id = a.studentId
        WHERE a.id = @id
      `);
    if (!result.recordset.length) return res.status(404).json({ message: "Application not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    console.log("APPLICATION DETAIL ERROR:", err);
    res.status(500).json({ message: "Failed to load application" });
  }
});

// PUT /api/student-council/applications/:id/approve — approves & auto-creates the candidate row
router.put("/applications/:id/approve", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    const election = await getElection(pool, application.electionId);
    if (!requireState(election, ["APPLICATIONS_OPEN", "APPLICATIONS_CLOSED"], res)) return;

    if (application.status === "approved") {
      return res.status(400).json({ message: "Application is already approved" });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.Int, id)
        .input("reviewedBy", sql.Int, req.user.id)
        .query(`
          UPDATE election_applications
          SET status='approved', reviewedBy=@reviewedBy, reviewedAt=GETDATE(), rejectionReason=NULL
          WHERE id=@id
        `);

      const existingCandidate = await transaction.request().input("appId", sql.Int, id).query(`SELECT id FROM election_candidates WHERE applicationId=@appId`);
      if (!existingCandidate.recordset.length) {
        await transaction
          .request()
          .input("electionId", sql.Int, application.electionId)
          .input("postId", sql.Int, application.postId)
          .input("applicationId", sql.Int, id)
          .input("studentId", sql.Int, application.studentId)
          .input("manifesto", sql.NVarChar, application.manifesto)
          .query(`
            INSERT INTO election_candidates (electionId, postId, applicationId, studentId, manifesto)
            VALUES (@electionId, @postId, @applicationId, @studentId, @manifesto)
          `);
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ message: "Application approved — candidate created" });
  } catch (err) {
    console.log("APPLICATION APPROVE ERROR:", err);
    res.status(500).json({ message: "Failed to approve application" });
  }
});

// PUT /api/student-council/applications/:id/reject
router.put("/applications/:id/reject", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { reason } = req.body;

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    const election = await getElection(pool, application.electionId);
    if (!requireState(election, ["APPLICATIONS_OPEN", "APPLICATIONS_CLOSED"], res)) return;

    await pool
      .request()
      .input("id", sql.Int, id)
      .input("reviewedBy", sql.Int, req.user.id)
      .input("reason", sql.NVarChar, reason || null)
      .query(`
        UPDATE election_applications
        SET status='rejected', reviewedBy=@reviewedBy, reviewedAt=GETDATE(), rejectionReason=@reason
        WHERE id=@id
      `);

    // If it had already been approved and turned into a candidate (re-review case),
    // remove that candidate row too — a rejected applicant can't stay a candidate.
    await pool.request().input("appId", sql.Int, id).query(`
      DELETE FROM election_candidates WHERE applicationId=@appId AND isFinalized=0
    `);

    res.json({ message: "Application rejected" });
  } catch (err) {
    console.log("APPLICATION REJECT ERROR:", err);
    res.status(500).json({ message: "Failed to reject application" });
  }
});

// PUT /api/student-council/applications/:id/suspend
router.put("/applications/:id/suspend", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { reason } = req.body;

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    const election = await getElection(pool, application.electionId);
    if (!requireState(election, ["APPLICATIONS_OPEN", "APPLICATIONS_CLOSED"], res)) return;

    if (application.status === "suspended") {
      return res.status(400).json({ message: "Application is already suspended" });
    }
    if (application.status === "rejected") {
      return res.status(400).json({ message: "A rejected application can't be suspended" });
    }

    const candCheck = await pool.request().input("appId", sql.Int, id).query(`SELECT isFinalized FROM election_candidates WHERE applicationId=@appId`);
    if (candCheck.recordset[0]?.isFinalized) {
      return res.status(409).json({ message: "This applicant is already a finalized candidate — suspend them from the Candidates tab instead." });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.Int, id)
        .input("previousStatus", sql.NVarChar, application.status)
        .input("reviewedBy", sql.Int, req.user.id)
        .input("reason", sql.NVarChar, reason || null)
        .query(`
          UPDATE election_applications
          SET status='suspended', previousStatus=@previousStatus, reviewedBy=@reviewedBy, reviewedAt=GETDATE(), rejectionReason=@reason
          WHERE id=@id
        `);
      // A suspended applicant can't remain in the candidate list.
      await transaction.request().input("appId", sql.Int, id).query(`
        DELETE FROM election_candidates WHERE applicationId=@appId AND isFinalized=0
      `);
      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ message: "Application suspended" });
  } catch (err) {
    console.log("APPLICATION SUSPEND ERROR:", err);
    res.status(500).json({ message: "Failed to suspend application" });
  }
});

// PUT /api/student-council/applications/:id/reactivate — undoes a suspension,
// restoring whatever status (pending/approved) the applicant had before.
router.put("/applications/:id/reactivate", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    const election = await getElection(pool, application.electionId);
    if (!requireState(election, ["APPLICATIONS_OPEN", "APPLICATIONS_CLOSED"], res)) return;

    if (application.status !== "suspended") {
      return res.status(400).json({ message: "Only a suspended application can be reactivated" });
    }

    const restoredStatus = application.previousStatus === "approved" ? "approved" : "pending";

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.Int, id)
        .input("status", sql.NVarChar, restoredStatus)
        .input("reviewedBy", sql.Int, req.user.id)
        .query(`
          UPDATE election_applications
          SET status=@status, previousStatus=NULL, reviewedBy=@reviewedBy, reviewedAt=GETDATE(), rejectionReason=NULL
          WHERE id=@id
        `);

      if (restoredStatus === "approved") {
        const existingCandidate = await transaction.request().input("appId", sql.Int, id).query(`SELECT id FROM election_candidates WHERE applicationId=@appId`);
        if (!existingCandidate.recordset.length) {
          await transaction
            .request()
            .input("electionId", sql.Int, application.electionId)
            .input("postId", sql.Int, application.postId)
            .input("applicationId", sql.Int, id)
            .input("studentId", sql.Int, application.studentId)
            .input("manifesto", sql.NVarChar, application.manifesto)
            .query(`
              INSERT INTO election_candidates (electionId, postId, applicationId, studentId, manifesto)
              VALUES (@electionId, @postId, @applicationId, @studentId, @manifesto)
            `);
        }
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ message: `Application reactivated — back to ${restoredStatus}` });
  } catch (err) {
    console.log("APPLICATION REACTIVATE ERROR:", err);
    res.status(500).json({ message: "Failed to reactivate application" });
  }
});

// DELETE /api/student-council/applications/:id — permanent delete.
// Blocked once the applicant has become a finalized candidate, to
// protect ballot/vote integrity; use Suspend/Reject instead at that point.
router.delete("/applications/:id", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    const candCheck = await pool.request().input("appId", sql.Int, id).query(`SELECT isFinalized FROM election_candidates WHERE applicationId=@appId`);
    if (candCheck.recordset[0]?.isFinalized) {
      return res.status(409).json({ message: "This applicant is already a finalized candidate and can't be deleted. Remove them from the Candidates tab first." });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction.request().input("appId", sql.Int, id).query(`DELETE FROM election_candidates WHERE applicationId=@appId AND isFinalized=0`);
      await transaction.request().input("id", sql.Int, id).query(`DELETE FROM election_applications WHERE id=@id`);
      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ message: "Application deleted" });
  } catch (err) {
    console.log("APPLICATION DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete application" });
  }
});

// PUT /api/student-council/applications/:id/manifesto — officer edits the manifesto pre-approval
router.put("/applications/:id/manifesto", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { manifesto } = req.body;

    const appResult = await pool.request().input("id", sql.Int, id).query(`SELECT * FROM election_applications WHERE id=@id`);
    const application = appResult.recordset[0];
    if (!application) return res.status(404).json({ message: "Application not found" });

    await pool.request().input("id", sql.Int, id).input("manifesto", sql.NVarChar, manifesto || null).query(`
      UPDATE election_applications SET manifesto=@manifesto WHERE id=@id
    `);

    res.json({ message: "Manifesto updated" });
  } catch (err) {
    console.log("APPLICATION MANIFESTO ERROR:", err);
    res.status(500).json({ message: "Failed to update manifesto" });
  }
});

/* =========================================================
   CANDIDATES (officer)
========================================================= */

router.get("/elections/:electionId/candidates", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .query(`
        SELECT c.*, p.title AS postTitle, p.scope AS postScope, p.studentClass AS postClass,
          ${STUDENT_COLUMNS},
          party.name AS partyName, party.colorHex AS partyColorHex, party.logoUrl AS partyLogoUrl,
          rm.studentId AS runningMateStudentId, rm.roleLabel AS runningMateRoleLabel,
          rmStudent.name AS runningMateName, rmStudent.photoUrl AS runningMatePhotoUrl,
          rmStudent.admissionNo AS runningMateAdmissionNo, rmStudent.studentClass AS runningMateClass
        FROM election_candidates c
        JOIN election_posts p ON p.id = c.postId
        JOIN Students s ON s.id = c.studentId
        LEFT JOIN election_parties party ON party.id = c.partyId
        LEFT JOIN election_running_mates rm ON rm.candidateId = c.id
        LEFT JOIN Students rmStudent ON rmStudent.id = rm.studentId
        WHERE c.electionId = @electionId
        ORDER BY p.displayOrder, p.id, s.name
      `);
    res.json(result.recordset);
  } catch (err) {
    console.log("CANDIDATES LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load candidates" });
  }
});

async function loadCandidate(pool, candidateId) {
  const result = await pool.request().input("id", sql.Int, candidateId).query(`SELECT * FROM election_candidates WHERE id=@id`);
  return result.recordset[0] || null;
}

// PUT /api/student-council/candidates/:id/party
router.put("/candidates/:id/party", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (candidate.isFinalized) return res.status(409).json({ message: "Candidate is already finalized" });

    const { partyId } = req.body; // null/undefined = Independent
    if (partyId) {
      const party = await pool.request().input("id", sql.Int, toInt(partyId)).input("electionId", sql.Int, candidate.electionId).query(`
        SELECT id FROM election_parties WHERE id=@id AND electionId=@electionId
      `);
      if (!party.recordset.length) return res.status(400).json({ message: "Party not found in this election" });
    }

    await pool.request().input("id", sql.Int, id).input("partyId", sql.Int, partyId ? toInt(partyId) : null).query(`
      UPDATE election_candidates SET partyId=@partyId WHERE id=@id
    `);

    res.json({ message: "Party assigned" });
  } catch (err) {
    console.log("CANDIDATE PARTY ERROR:", err);
    res.status(500).json({ message: "Failed to assign party" });
  }
});

// PUT /api/student-council/candidates/:id/manifesto — officer can touch up the finalized copy
router.put("/candidates/:id/manifesto", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (candidate.isFinalized) return res.status(409).json({ message: "Candidate is already finalized" });

    const { manifesto } = req.body;
    await pool.request().input("id", sql.Int, id).input("manifesto", sql.NVarChar, manifesto || null).query(`
      UPDATE election_candidates SET manifesto=@manifesto WHERE id=@id
    `);

    res.json({ message: "Manifesto updated" });
  } catch (err) {
    console.log("CANDIDATE MANIFESTO ERROR:", err);
    res.status(500).json({ message: "Failed to update manifesto" });
  }
});

// PUT /api/student-council/candidates/:id/running-mate — search/select an existing student
router.put("/candidates/:id/running-mate", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (candidate.isFinalized) return res.status(409).json({ message: "Candidate is already finalized" });

    const { studentId, roleLabel } = req.body;
    const runningMateId = toInt(studentId);
    if (!runningMateId) return res.status(400).json({ message: "studentId is required" });
    if (runningMateId === candidate.studentId) {
      return res.status(400).json({ message: "A candidate can't be their own running mate" });
    }

    const student = await pool.request().input("id", sql.Int, runningMateId).query(`SELECT id FROM Students WHERE id=@id AND status='active'`);
    if (!student.recordset.length) return res.status(404).json({ message: "Student not found" });

    const existing = await pool.request().input("candidateId", sql.Int, id).query(`SELECT id FROM election_running_mates WHERE candidateId=@candidateId`);
    if (existing.recordset.length) {
      await pool
        .request()
        .input("candidateId", sql.Int, id)
        .input("studentId", sql.Int, runningMateId)
        .input("roleLabel", sql.NVarChar, roleLabel || null)
        .query(`UPDATE election_running_mates SET studentId=@studentId, roleLabel=@roleLabel WHERE candidateId=@candidateId`);
    } else {
      await pool
        .request()
        .input("candidateId", sql.Int, id)
        .input("studentId", sql.Int, runningMateId)
        .input("roleLabel", sql.NVarChar, roleLabel || null)
        .query(`INSERT INTO election_running_mates (candidateId, studentId, roleLabel) VALUES (@candidateId, @studentId, @roleLabel)`);
    }

    res.json({ message: "Running mate assigned" });
  } catch (err) {
    console.log("CANDIDATE RUNNING MATE ERROR:", err);
    res.status(500).json({ message: "Failed to assign running mate" });
  }
});

// PUT /api/student-council/candidates/:id/suspend — works before or after
// finalization; a suspended candidate is excluded from ballots/voting.
router.put("/candidates/:id/suspend", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });

    const election = await getElection(pool, candidate.electionId);
    if (!requireState(election, ["APPLICATIONS_CLOSED", "CANDIDATES_FINALIZED", "VOTING_OPEN"], res)) return;

    if (candidate.status === "suspended") {
      return res.status(400).json({ message: "Candidate is already suspended" });
    }

    await pool.request().input("id", sql.Int, id).query(`UPDATE election_candidates SET status='suspended' WHERE id=@id`);
    res.json({ message: "Candidate suspended" });
  } catch (err) {
    console.log("CANDIDATE SUSPEND ERROR:", err);
    res.status(500).json({ message: "Failed to suspend candidate" });
  }
});

// PUT /api/student-council/candidates/:id/reactivate
router.put("/candidates/:id/reactivate", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });

    const election = await getElection(pool, candidate.electionId);
    if (!requireState(election, ["APPLICATIONS_CLOSED", "CANDIDATES_FINALIZED", "VOTING_OPEN"], res)) return;

    if (candidate.status !== "suspended") {
      return res.status(400).json({ message: "Only a suspended candidate can be reactivated" });
    }

    await pool.request().input("id", sql.Int, id).query(`UPDATE election_candidates SET status='active' WHERE id=@id`);
    res.json({ message: "Candidate reactivated" });
  } catch (err) {
    console.log("CANDIDATE REACTIVATE ERROR:", err);
    res.status(500).json({ message: "Failed to reactivate candidate" });
  }
});

// PUT /api/student-council/candidates/:id/unfinalize — reopens a finalized
// candidate for editing (party/running mate/manifesto). Blocked once
// official ballots have been generated, to keep ballots trustworthy.
router.put("/candidates/:id/unfinalize", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (!candidate.isFinalized) return res.status(400).json({ message: "Candidate isn't finalized" });

    const election = await getElection(pool, candidate.electionId);
    if (!requireState(election, ["CANDIDATES_FINALIZED"], res)) return;
    if (election.ballotsGeneratedAt) {
      return res.status(409).json({ message: "Ballots have already been generated for this election — this candidate can no longer be unfinalized." });
    }

    await pool.request().input("id", sql.Int, id).query(`UPDATE election_candidates SET isFinalized=0 WHERE id=@id`);
    res.json({ message: "Candidate unfinalized — edits are open again" });
  } catch (err) {
    console.log("CANDIDATE UNFINALIZE ERROR:", err);
    res.status(500).json({ message: "Failed to unfinalize candidate" });
  }
});

// DELETE /api/student-council/candidates/:id — remove a candidate entirely.
// Only allowed pre-finalization; also reverts the source application to
// "rejected" so it doesn't silently reappear as a candidate.
router.delete("/candidates/:id", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (candidate.isFinalized) {
      return res.status(409).json({ message: "This candidate is already finalized. Unfinalize them first if they truly need to be removed." });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction.request().input("id", sql.Int, id).query(`DELETE FROM election_candidates WHERE id=@id`);
      await transaction
        .request()
        .input("appId", sql.Int, candidate.applicationId)
        .input("reason", sql.NVarChar, "Removed from candidacy by the Election Officer")
        .query(`UPDATE election_applications SET status='rejected', rejectionReason=@reason, reviewedAt=GETDATE() WHERE id=@appId`);
      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ message: "Candidate removed" });
  } catch (err) {
    console.log("CANDIDATE DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to remove candidate" });
  }
});

router.delete("/candidates/:id/running-mate", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const candidate = await loadCandidate(pool, id);
    if (!candidate) return res.status(404).json({ message: "Candidate not found" });
    if (candidate.isFinalized) return res.status(409).json({ message: "Candidate is already finalized" });

    await pool.request().input("candidateId", sql.Int, id).query(`DELETE FROM election_running_mates WHERE candidateId=@candidateId`);
    res.json({ message: "Running mate removed" });
  } catch (err) {
    console.log("CANDIDATE RUNNING MATE DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to remove running mate" });
  }
});

/* =========================================================
   STUDENT-SIDE: ELECTIONS / APPLYING
========================================================= */

// GET /api/student-council/student/elections — visible elections + my status
router.get("/student/elections", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT id, title, description, status, applicationsOpenAt, applicationsClosedAt,
        votingOpenAt, votingClosedAt, resultsPublishedAt
      FROM election_elections
      WHERE status <> 'DRAFT'
      ORDER BY createdAt DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.log("STUDENT ELECTIONS LIST ERROR:", err);
    res.status(500).json({ message: "Failed to load elections" });
  }
});

// GET /api/student-council/student/elections/:id/posts — posts I'm eligible to apply for
router.get("/student/elections/:id/posts", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.id);
    const election = await getElection(pool, electionId);
    if (!election || election.status === "DRAFT") return res.status(404).json({ message: "Election not found" });

    const me = await pool.request().input("id", sql.Int, req.user.id).query(`SELECT studentClass FROM Students WHERE id=@id`);
    const myClass = me.recordset[0]?.studentClass;

    const posts = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("myClass", sql.NVarChar, myClass || "")
      .query(`
        SELECT * FROM election_posts
        WHERE electionId = @electionId
          AND (scope = 'COLLEGE_WIDE' OR studentClass = @myClass)
        ORDER BY displayOrder, id
      `);

    const myApps = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("studentId", sql.Int, req.user.id)
      .query(`SELECT postId, status FROM election_applications WHERE electionId=@electionId AND studentId=@studentId`);

    const appliedByPost = {};
    for (const a of myApps.recordset) appliedByPost[a.postId] = a.status;

    res.json(
      posts.recordset.map((p) => ({ ...p, myApplicationStatus: appliedByPost[p.id] || null }))
    );
  } catch (err) {
    console.log("STUDENT ELIGIBLE POSTS ERROR:", err);
    res.status(500).json({ message: "Failed to load posts" });
  }
});

// POST /api/student-council/student/elections/:id/apply
router.post("/student/elections/:id/apply", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.id);
    const { postId, manifesto } = req.body;
    const post = toInt(postId);
    if (!post) return res.status(400).json({ message: "postId is required" });

    const election = await getElection(pool, electionId);
    if (!requireState(election, ["APPLICATIONS_OPEN"], res)) return;

    // Never trust postId blindly — confirm it belongs to this election and
    // that the logged-in student is eligible for it (class-based check).
    const postResult = await pool.request().input("id", sql.Int, post).input("electionId", sql.Int, electionId).query(`
      SELECT * FROM election_posts WHERE id=@id AND electionId=@electionId
    `);
    const postRow = postResult.recordset[0];
    if (!postRow) return res.status(404).json({ message: "Post not found in this election" });

    if (postRow.scope === "CLASS_BASED") {
      const me = await pool.request().input("id", sql.Int, req.user.id).query(`SELECT studentClass FROM Students WHERE id=@id`);
      if ((me.recordset[0]?.studentClass || "") !== postRow.studentClass) {
        return res.status(403).json({ message: "You are not eligible to apply for this post" });
      }
    }

    const existing = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("postId", sql.Int, post)
      .input("studentId", sql.Int, req.user.id)
      .query(`SELECT id FROM election_applications WHERE electionId=@electionId AND postId=@postId AND studentId=@studentId`);
    if (existing.recordset.length) {
      return res.status(400).json({ message: "You've already applied for this post" });
    }

    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("postId", sql.Int, post)
      .input("studentId", sql.Int, req.user.id)
      .input("manifesto", sql.NVarChar, manifesto || null)
      .query(`
        INSERT INTO election_applications (electionId, postId, studentId, manifesto)
        OUTPUT INSERTED.*
        VALUES (@electionId, @postId, @studentId, @manifesto)
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(400).json({ message: "You've already applied for this post" });
    }
    console.log("STUDENT APPLY ERROR:", err);
    res.status(500).json({ message: "Failed to submit application" });
  }
});

// GET /api/student-council/student/elections/:id/my-applications
router.get("/student/elections/:id/my-applications", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.id);
    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("studentId", sql.Int, req.user.id)
      .query(`
        SELECT a.*, p.title AS postTitle
        FROM election_applications a
        JOIN election_posts p ON p.id = a.postId
        WHERE a.electionId=@electionId AND a.studentId=@studentId
        ORDER BY a.appliedAt DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.log("STUDENT MY APPLICATIONS ERROR:", err);
    res.status(500).json({ message: "Failed to load your applications" });
  }
});

/* =========================================================
   BALLOTS
========================================================= */

// GET /api/student-council/elections/:electionId/ballots — officer preview, all posts/candidates
router.get("/elections/:electionId/ballots", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.electionId);
    const ballot = await buildBallot(pool, electionId, null);
    res.json(ballot);
  } catch (err) {
    console.log("BALLOTS PREVIEW ERROR:", err);
    res.status(500).json({ message: "Failed to load ballots" });
  }
});

// GET /api/student-council/student/elections/:id/ballot — my eligible ballot
router.get("/student/elections/:id/ballot", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.id);
    const election = await getElection(pool, electionId);
    if (!election || !["VOTING_OPEN", "VOTING_CLOSED", "RESULTS"].includes(election.status)) {
      return res.status(404).json({ message: "Ballot isn't available yet" });
    }

    const ballot = await buildBallot(pool, electionId, req.user.id);
    res.json(ballot);
  } catch (err) {
    console.log("STUDENT BALLOT ERROR:", err);
    res.status(500).json({ message: "Failed to load your ballot" });
  }
});

// Shared helper — builds { election, posts: [{ post, candidates: [...] }] },
// optionally filtered to one student's class eligibility (studentId != null).
async function buildBallot(pool, electionId, studentId) {
  const election = await getElection(pool, electionId);

  let myClass = null;
  if (studentId) {
    const me = await pool.request().input("id", sql.Int, studentId).query(`SELECT studentClass FROM Students WHERE id=@id`);
    myClass = me.recordset[0]?.studentClass || null;
  }

  const postsRequest = pool.request().input("electionId", sql.Int, electionId);
  let postsQuery = `SELECT * FROM election_posts WHERE electionId=@electionId`;
  if (studentId) {
    postsRequest.input("myClass", sql.NVarChar, myClass || "");
    postsQuery += ` AND (scope='COLLEGE_WIDE' OR studentClass=@myClass)`;
  }
  postsQuery += ` ORDER BY displayOrder, id`;
  const posts = (await postsRequest.query(postsQuery)).recordset;

  const candidatesResult = await pool
    .request()
    .input("electionId", sql.Int, electionId)
    .query(`
      SELECT c.*, ${STUDENT_COLUMNS},
        party.name AS partyName, party.colorHex AS partyColorHex, party.logoUrl AS partyLogoUrl, party.slogan AS partySlogan,
        rm.studentId AS runningMateStudentId, rm.roleLabel AS runningMateRoleLabel,
        rmStudent.name AS runningMateName, rmStudent.photoUrl AS runningMatePhotoUrl
      FROM election_candidates c
      JOIN Students s ON s.id = c.studentId
      LEFT JOIN election_parties party ON party.id = c.partyId
      LEFT JOIN election_running_mates rm ON rm.candidateId = c.id
      LEFT JOIN Students rmStudent ON rmStudent.id = rm.studentId
      WHERE c.electionId = @electionId AND c.isFinalized = 1 AND c.status = 'active'
      ORDER BY s.name
    `);

  const candidatesByPost = {};
  for (const c of candidatesResult.recordset) {
    if (!candidatesByPost[c.postId]) candidatesByPost[c.postId] = [];
    candidatesByPost[c.postId].push(c);
  }

  return {
    election,
    posts: posts.map((p) => ({ post: p, candidates: candidatesByPost[p.id] || [] })),
  };
}

/* =========================================================
   VOTING
========================================================= */

// GET /api/student-council/student/elections/:id/vote-status
router.get("/student/elections/:id/vote-status", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const electionId = toInt(req.params.id);
    const result = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("studentId", sql.Int, req.user.id)
      .query(`SELECT id, submittedAt FROM election_votes WHERE electionId=@electionId AND studentId=@studentId`);
    res.json({ hasVoted: !!result.recordset.length, submittedAt: result.recordset[0]?.submittedAt || null });
  } catch (err) {
    console.log("VOTE STATUS ERROR:", err);
    res.status(500).json({ message: "Failed to load vote status" });
  }
});

// POST /api/student-council/student/elections/:id/vote
// Body: { selections: [{ postId, candidateId }, ...] }
router.post("/student/elections/:id/vote", protect, studentOnly, async (req, res) => {
  const pool = req.pool;
  const electionId = toInt(req.params.id);
  const studentId = req.user.id; // never trust a studentId from the body — use the authenticated user

  try {
    const election = await getElection(pool, electionId);
    if (!requireState(election, ["VOTING_OPEN"], res)) return;

    const alreadyVoted = await pool
      .request()
      .input("electionId", sql.Int, electionId)
      .input("studentId", sql.Int, studentId)
      .query(`SELECT id FROM election_votes WHERE electionId=@electionId AND studentId=@studentId`);
    if (alreadyVoted.recordset.length) {
      return res.status(409).json({ message: "You have already voted in this election" });
    }

    const selections = Array.isArray(req.body.selections) ? req.body.selections : [];
    if (!selections.length) return res.status(400).json({ message: "No selections submitted" });

    // Rebuild this student's eligible ballot server-side and check the
    // submission against it — never trust postId/candidateId from the client.
    const ballot = await buildBallot(pool, electionId, studentId);
    const eligiblePostIds = ballot.posts.map((p) => p.post.id);
    const candidatesByPost = {};
    for (const p of ballot.posts) candidatesByPost[p.post.id] = new Set(p.candidates.map((c) => c.id));

    if (eligiblePostIds.length === 0) {
      return res.status(400).json({ message: "There are no posts available for you to vote on" });
    }

    // Every eligible post must have exactly one valid selection.
    const submittedPostIds = new Set();
    for (const sel of selections) {
      const postId = toInt(sel.postId);
      const candidateId = toInt(sel.candidateId);
      if (!postId || !candidateId) {
        return res.status(400).json({ message: "Invalid selection payload" });
      }
      if (!eligiblePostIds.includes(postId)) {
        return res.status(403).json({ message: "One of your selections is for a post you're not eligible to vote on" });
      }
      if (!candidatesByPost[postId]?.has(candidateId)) {
        return res.status(400).json({ message: "One of your selected candidates isn't valid for that post" });
      }
      if (submittedPostIds.has(postId)) {
        return res.status(400).json({ message: "Only one candidate can be selected per post" });
      }
      submittedPostIds.add(postId);
    }

    const missing = eligiblePostIds.filter((id) => !submittedPostIds.has(id));
    if (missing.length) {
      return res.status(400).json({ message: "You must select a candidate for every post before submitting" });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const voteResult = await transaction
        .request()
        .input("electionId", sql.Int, electionId)
        .input("studentId", sql.Int, studentId)
        .query(`
          INSERT INTO election_votes (electionId, studentId)
          OUTPUT INSERTED.id
          VALUES (@electionId, @studentId)
        `);
      const voteId = voteResult.recordset[0].id;

      for (const sel of selections) {
        await transaction
          .request()
          .input("voteId", sql.Int, voteId)
          .input("electionId", sql.Int, electionId)
          .input("postId", sql.Int, toInt(sel.postId))
          .input("candidateId", sql.Int, toInt(sel.candidateId))
          .query(`
            INSERT INTO election_vote_items (voteId, electionId, postId, candidateId)
            VALUES (@voteId, @electionId, @postId, @candidateId)
          `);
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.status(201).json({ message: "VOTE SUBMITTED" });
  } catch (err) {
    // The UNIQUE(electionId, studentId) constraint on election_votes is the
    // hard backstop — a race between two requests from the same student
    // lands here as a constraint violation rather than two vote rows.
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ message: "You have already voted in this election" });
    }
    console.log("VOTE SUBMIT ERROR:", err);
    res.status(500).json({ message: "Failed to submit vote" });
  }
});

/* =========================================================
   MONITORING / RESULTS
========================================================= */

// GET /api/student-council/elections/:id/progress — officer, live during voting
router.get("/elections/:id/progress", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!election) return res.status(404).json({ message: "Election not found" });

    const [voters, votes] = await Promise.all([
      pool.request().query(`SELECT COUNT(*) c FROM Students WHERE status='active'`),
      pool.request().input("id", sql.Int, id).query(`SELECT COUNT(*) c FROM election_votes WHERE electionId=@id`),
    ]);

    const registeredVoters = voters.recordset[0]?.c || 0;
    const votesSubmitted = votes.recordset[0]?.c || 0;

    res.json({
      status: election.status,
      registeredVoters,
      votesSubmitted,
      remainingVoters: Math.max(registeredVoters - votesSubmitted, 0),
      votingPercentage: registeredVoters > 0 ? Math.round((votesSubmitted / registeredVoters) * 1000) / 10 : 0,
    });
  } catch (err) {
    console.log("PROGRESS ERROR:", err);
    res.status(500).json({ message: "Failed to load progress" });
  }
});

// GET /api/student-council/elections/:id/results — officer, full breakdown (VOTING_CLOSED or RESULTS)
router.get("/elections/:id/results", protect, officerOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!requireState(election, ["VOTING_CLOSED", "RESULTS"], res)) return;

    const results = await fetchResults(pool, id);
    res.json(results);
  } catch (err) {
    console.log("RESULTS ERROR:", err);
    res.status(500).json({ message: "Failed to load results" });
  }
});

// GET /api/student-council/student/elections/:id/results — student-facing, only once published
router.get("/student/elections/:id/results", protect, studentOnly, async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const election = await getElection(pool, id);
    if (!election || election.status !== "RESULTS") {
      return res.status(404).json({ message: "Results haven't been published yet" });
    }

    const results = await fetchResults(pool, id);
    res.json(results);
  } catch (err) {
    console.log("STUDENT RESULTS ERROR:", err);
    res.status(500).json({ message: "Failed to load results" });
  }
});

async function fetchResults(pool, electionId) {
  const posts = await pool
    .request()
    .input("id", sql.Int, electionId)
    .query(`SELECT * FROM election_posts WHERE electionId=@id ORDER BY displayOrder, id`);

  const tally = await pool
    .request()
    .input("id", sql.Int, electionId)
    .query(`
      SELECT vi.postId, vi.candidateId, COUNT(*) AS votes
      FROM election_vote_items vi
      WHERE vi.electionId = @id
      GROUP BY vi.postId, vi.candidateId
    `);

  const candidates = await pool
    .request()
    .input("id", sql.Int, electionId)
    .query(`
      SELECT c.id, c.postId, ${STUDENT_COLUMNS}, party.name AS partyName
      FROM election_candidates c
      JOIN Students s ON s.id = c.studentId
      LEFT JOIN election_parties party ON party.id = c.partyId
      WHERE c.electionId = @id AND c.isFinalized = 1
    `);

  const candidateById = {};
  for (const c of candidates.recordset) candidateById[c.id] = c;

  const tallyByPost = {};
  for (const t of tally.recordset) {
    if (!tallyByPost[t.postId]) tallyByPost[t.postId] = [];
    tallyByPost[t.postId].push({ candidate: candidateById[t.candidateId], votes: t.votes });
  }
  for (const postId of Object.keys(tallyByPost)) {
    tallyByPost[postId].sort((a, b) => b.votes - a.votes);
  }

  return {
    posts: posts.recordset.map((p) => ({
      post: p,
      results: (tallyByPost[p.id] || []).length
        ? tallyByPost[p.id]
        : candidates.recordset.filter((c) => c.postId === p.id).map((c) => ({ candidate: c, votes: 0 })),
    })),
  };
}

module.exports = router;
