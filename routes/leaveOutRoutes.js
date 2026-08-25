const express = require("express");
const router = express.Router();
const { authorize } = require("../middleware/authMiddleware");
const { notifyUsers } = require("../utils/notify");

const VALID_LEAVE_TYPES = ["short_stay", "long", "emergency"];

// Sensible default durations (minutes) per leave type, used whenever
// the caller doesn't supply an explicit duration.
const DEFAULT_DURATION_BY_TYPE = {
  short_stay: 120,   // 2 hours
  long: 2880,        // 2 days
  emergency: 60,     // 1 hour — fast turnaround
};

const LEAVE_TYPE_LABEL = {
  short_stay: "Short Stay",
  long: "Long-Stay Leave",
  emergency: "Emergency Leave",
};

// Roles allowed to open the Leave-out admin dashboard at all.
const LEAVE_STAFF_ROLES = ["admin", "sub_admin", "sub_admin_2"];

// The specific (status, leave_type) combinations where Sub-Admin 1
// ("sub_admin") is the one expected to act next — this is exactly
// where the code-gate applies. Once a leave has moved past this
// stage, there's nothing left to gate: the review already happened.
const isSubAdmin1GateStage = (row) =>
  (row.leave_type !== "long") &&
  ((row.status === "pending" && row.leave_type === "short_stay") ||
   (row.status === "pending_final" && row.leave_type === "emergency"));

// The in-app route the notification's "click through" should land on.
// Every role has its own leave page, so pick the right one per source.
const LEAVE_LINK_BY_SOURCE = {
  Students: "/student/leave",
  Users: "/leave-out",
};

module.exports = (poolPromise, sql) => {

  /* ================= NAME RESOLUTION HELPER =================
     Every notification / history entry must show the *actual*
     authenticated account name, never a role label and never a
     hard-coded string. Resolved fresh from the DB using the actor's
     id + source (never trusted purely off the JWT), per instruction
     to "use that ID to retrieve the actual account/display name."
  */
  const getActorDisplayName = async (pool, user) => {
    try {
      if (!user || !user.id) return "Unknown";
      const source = user.source || (user.role === "student" ? "Students" : user.role === "teacher" ? "Teachers" : "Users");

      if (source === "Students") {
        const r = await pool.request().input("id", sql.Int, user.id).query(`SELECT name FROM Students WHERE id=@id`);
        return r.recordset[0]?.name || user.username || `Student ${user.id}`;
      }

      if (source === "Teachers") {
        const r = await pool.request().input("id", sql.Int, user.id).query(`SELECT name FROM Teachers WHERE id=@id`);
        return r.recordset[0]?.name || user.username || `Teacher ${user.id}`;
      }

      // Users table: admin / sub_admin / sub_admin_2
      const r = await pool.request().input("id", sql.Int, user.id).query(`SELECT name, username FROM Users WHERE id=@id`);
      const row = r.recordset[0];
      if (!row) return user.username || `User ${user.id}`;
      return row.name || row.username || user.username || `User ${user.id}`;
    } catch (err) {
      console.log("GET ACTOR NAME ERROR:", err.message);
      return user?.username || "Unknown";
    }
  };

  /* Every Users-table account (admin/sub_admin/sub_admin_2) currently
     holding a given role, for fanning a notification out to "everyone
     who can act on this next". */
  const getUsersByRole = async (pool, role) => {
    try {
      const r = await pool.request()
        .input("role", sql.NVarChar, role)
        .query(`SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM Users WHERE LOWER(role) = LOWER(@role)`);
      return (r.recordset || []).map((u) => ({ id: u.id, source: "Users" }));
    } catch (err) {
      console.log("GET USERS BY ROLE ERROR:", err.message);
      return [];
    }
  };

  const getStudentName = async (pool, studentId) => {
    try {
      const r = await pool.request().input("id", sql.Int, studentId).query(`SELECT name FROM Students WHERE id=@id`);
      return r.recordset[0]?.name || `Student ${studentId}`;
    } catch {
      return `Student ${studentId}`;
    }
  };

  /* ================= CODE GENERATION =================
     Generated the moment a leave is SUBMITTED (not on approval) —
     this one code now serves three purposes end-to-end:
       1. The student shares it with Sub-Admin 1 in person; Sub-Admin 1
          must enter it correctly before they can see the request's
          reason or act on it (see isSubAdmin1GateStage / the
          /verify-code route / the GET / redaction below).
       2. It's the same code shown on the approved permit.
       3. It's the code the Gate page verifies for exit/reentry —
          gate.js's /verify route reads this exact gate_code column
          unchanged, so nothing there needed to change; it now just
          additionally requires the leave to be approved first (see
          the note in DEBUG_REPORT / gate.js).
     6 digits, retried on the rare collision against any other
     currently-unresolved code (a leave whose reentry_time is still
     null), since only unresolved codes are ever looked up at the gate.
  */
  const generateGateCode = async (pool, leaveId) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const clash = await pool.request().input("code", sql.NVarChar, code).query(`
        SELECT id FROM leave_outs WHERE gate_code = @code AND reentry_time IS NULL
      `);
      if (clash.recordset.length === 0) {
        await pool.request()
          .input("id", sql.Int, leaveId)
          .input("code", sql.NVarChar, code)
          .query(`UPDATE leave_outs SET gate_code = @code, gate_status = 'not_out' WHERE id = @id`);
        return code;
      }
    }
    return null;
  };

  // Fallback for any leave that somehow doesn't have a code yet (rows
  // created before this feature existed) — approve/force-grant call
  // this instead of unconditionally generating a fresh one, since the
  // code normally already exists from submission time.
  const ensureGateCode = async (pool, leaveId, existingCode) => {
    if (existingCode) return existingCode;
    return generateGateCode(pool, leaveId);
  };

  /* ================= CREATE LEAVE =================
     Student-only. The workflow's starting stage depends entirely on
     leave_type — this is the one place that decides it, so it can
     never be skipped or forged from the client:
       short_stay -> pending            (unchanged single-stage flow)
       emergency  -> pending_subadmin2  (Sub-Admin 2 first)
       long       -> pending_admin      (Admin only, bypasses sub-admins)
  */
  router.post("/", authorize("student"), async (req, res) => {
    try {
      const pool = await poolPromise;

      const { reason, request_date, duration, leave_type } = req.body;
      // The requester is always the authenticated student — never
      // trust a student_id supplied in the body.
      const student_id = req.user.id;

      if (!reason) {
        return res.status(400).json({ message: "reason is required" });
      }

      const type = VALID_LEAVE_TYPES.includes(leave_type) ? leave_type : "short_stay";
      const finalDuration = duration || DEFAULT_DURATION_BY_TYPE[type];

      const initialStatus =
        type === "emergency" ? "pending_subadmin2" :
        type === "long" ? "pending_admin" :
        "pending";

      const studentName = await getActorDisplayName(pool, req.user);

      const inserted = await pool.request()
        .input("student_id", sql.Int, student_id)
        .input("reason", sql.NVarChar, reason)
        .input("request_date", sql.Date, request_date)
        .input("duration", sql.Int, finalDuration)
        .input("leave_type", sql.NVarChar, type)
        .input("status", sql.NVarChar, initialStatus)
        .input("submitted_by_name", sql.NVarChar, studentName)
        .query(`
          INSERT INTO leave_outs
          (student_id, reason, request_date, duration, status, leave_type, submitted_by_name)
          OUTPUT INSERTED.id
          VALUES
          (@student_id, @reason, @request_date, @duration, @status, @leave_type, @submitted_by_name)
        `);

      const newId = inserted.recordset[0]?.id;

      // Generate the code right away — this is what the student will
      // hand to Sub-Admin 1 in person, and later use at the gate.
      const code = await generateGateCode(pool, newId);

      // Notify whoever owns the next approval stage. Short-stay keeps
      // its existing (no-notification-on-submit) behavior — Sub-Admin 1
      // finds it in their list and unlocks it with the code directly.
      if (type === "emergency") {
        const recipients = await getUsersByRole(pool, "sub_admin_2");
        await notifyUsers(pool, recipients, {
          title: "New Emergency Leave Request",
          message: `New Emergency Leave request from ${studentName} requires your approval.`,
          type: "leave_emergency_new",
          createdBy: student_id,
          createdBySource: "Students",
          link: LEAVE_LINK_BY_SOURCE.Users,
        });
      } else if (type === "long") {
        const recipients = await getUsersByRole(pool, "admin");
        await notifyUsers(pool, recipients, {
          title: "New Long-Stay Leave Request",
          message: `New Long-Stay Leave request from ${studentName} requires your approval.`,
          type: "leave_long_new",
          createdBy: student_id,
          createdBySource: "Students",
          link: LEAVE_LINK_BY_SOURCE.Users,
        });
      }

      res.json({ message: "Leave request submitted", id: newId, status: initialStatus, code });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Failed to submit leave" });
    }
  });

  /* ================= STUDENT LEAVES ================= */
  router.get("/student", async (req, res) => {
    try {
      const pool = await poolPromise;

      // A student may only ever read their own leave history — the
      // query param is honored only for staff roles.
      const studentId = req.user.role === "student" ? req.user.id : req.query.studentId;

      if (!studentId) {
        return res.status(400).json({ message: "studentId is required" });
      }

      const result = await pool.request()
        .input("studentId", sql.Int, studentId)
        .query(`
          SELECT *
          FROM leave_outs
          WHERE student_id = @studentId
          ORDER BY id DESC
        `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= ADMIN GET ALL =================
     admin sees every leave, fully. sub_admin never sees Long-Stay
     Leave. sub_admin_2 is scoped even tighter — Emergency-only.

     Sub-Admin 1 ("sub_admin") additionally gets its "reason" field
     (and student_id, so the row can't be reasoned-out) blanked out —
     replaced with `locked: true` — for any request still sitting at
     the stage where sub_admin is expected to act, until they've
     entered that leave's code via /:id/verify-code. Everything else
     (student name isn't sent here at all — the frontend resolves it
     from its own /students list — status, leave type) stays visible
     so the row is still findable in the list; only the sensitive
     "why" and the ability to approve/reject are gated.
  */
  router.get("/", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;

      const role = req.user.role;
      let where = "";
      if (role === "sub_admin_2") where = "WHERE leave_type = 'emergency'";
      else if (role === "sub_admin") where = "WHERE leave_type <> 'long'";

      const result = await pool.request().query(`
        SELECT *
        FROM leave_outs
        ${where}
        ORDER BY id DESC
      `);

      let rows = result.recordset || [];

      if (role === "sub_admin") {
        rows = rows.map((row) => {
          if (isSubAdmin1GateStage(row) && !row.code_verified) {
            return { ...row, reason: null, locked: true };
          }
          return { ...row, locked: false };
        });
      }

      res.json(rows);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= VERIFY CODE (Sub-Admin 1 unlock) =================
     Sub-Admin 1 enters the code the student handed them. Correct code
     permanently unlocks this one request for every sub_admin from
     then on (no need to re-enter it) — the check is per-leave, not
     per-session, matching "can only see a leave after they have typed
     in the approval code". Admin can also call this (harmless no-op
     for them since GET / never redacts anything for admin anyway).
  */
  router.put("/:id/verify-code", authorize("sub_admin", "admin"), async (req, res) => {
    try {
      const pool = await poolPromise;
      const code = String(req.body.code || "").trim();
      if (!code) return res.status(400).json({ message: "Code is required" });

      const existing = await pool.request().input("id", sql.Int, req.params.id)
        .query(`SELECT * FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const row = existing.recordset[0];

      if (!row.gate_code) {
        return res.status(400).json({ message: "No code has been generated for this request." });
      }
      if (String(row.gate_code) !== code) {
        return res.status(400).json({ message: "Incorrect code." });
      }

      const actorName = await getActorDisplayName(pool, req.user);

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("name", sql.NVarChar, actorName)
        .query(`
          UPDATE leave_outs
          SET code_verified = 1, code_verified_by_name = @name, code_verified_at = GETDATE()
          WHERE id = @id
        `);

      res.json({ message: "Code verified", leave: { ...row, reason: row.reason, locked: false, code_verified: true } });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Verification failed" });
    }
  });

  /* ================= APPROVE =================
     Stage- and role-aware. Every transition is a single conditional
     UPDATE keyed on the exact status it must be leaving, so a
     duplicate/racing approval simply affects 0 rows instead of
     silently re-approving or skipping a stage.
  */
  router.put("/:id/approve", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;
      const role = req.user.role;
      const { approvedAt, duration } = req.body;

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id, leave_type, status, gate_code, code_verified FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const { student_id, leave_type, status, gate_code, code_verified } = existing.recordset[0];
      const actorName = await getActorDisplayName(pool, req.user);
      const finalDuration = duration || DEFAULT_DURATION_BY_TYPE[leave_type] || 120;

      // Sub-Admin 1 must have unlocked this specific request with its
      // code before they can approve it — mirrors the GET / redaction
      // so the API can't be called directly to skip the gate.
      if (role === "sub_admin" && isSubAdmin1GateStage({ leave_type, status }) && !code_verified) {
        return res.status(403).json({ message: "Enter this request's code before approving it." });
      }

      /* ---------- LONG-STAY: Admin only, single stage ---------- */
      if (leave_type === "long") {
        if (status !== "pending_admin") {
          return res.status(409).json({ message: `This request is already ${status}.` });
        }
        if (role !== "admin") {
          return res.status(403).json({ message: "Only Admin can approve Long-Stay Leave." });
        }

        const upd = await pool.request()
          .input("id", sql.Int, req.params.id)
          .input("approvedAt", sql.DateTime, approvedAt || new Date())
          .input("duration", sql.Int, finalDuration)
          .input("finalApproverId", sql.Int, req.user.id)
          .input("finalApproverSource", sql.NVarChar, "Users")
          .input("finalApproverName", sql.NVarChar, actorName)
          .query(`
            UPDATE leave_outs
            SET status='approved', approved_at=@approvedAt, duration=@duration,
                final_approver_id=@finalApproverId, final_approver_source=@finalApproverSource,
                final_approver_name=@finalApproverName, final_approved_at=GETDATE()
            WHERE id=@id AND status='pending_admin'
          `);

        if (upd.rowsAffected[0] === 0) {
          return res.status(409).json({ message: "This request was already processed." });
        }

        const code = await ensureGateCode(pool, req.params.id, gate_code);

        await notifyUsers(pool, [{ id: student_id, source: "Students" }], {
          title: "Long-Stay Leave Approved",
          message: `Your Long-Stay Leave has been approved by ${actorName}.${code ? ` Your code ${code} is now valid at the gate.` : ""}`,
          type: "leave",
          createdBy: req.user.id,
          createdBySource: "Users",
          link: LEAVE_LINK_BY_SOURCE.Students,
        });

        return res.json({ message: "Approved", gate_code: code });
      }

      /* ---------- EMERGENCY: Sub-Admin 2 (stage 1) then Sub-Admin 1 OR Admin (final) ---------- */
      if (leave_type === "emergency") {

        if (status === "pending_subadmin2") {
          if (!["sub_admin_2", "admin"].includes(role)) {
            return res.status(403).json({ message: "Only Sub-Admin 2 (or Admin) can process this stage of Emergency Leave." });
          }

          const upd = await pool.request()
            .input("id", sql.Int, req.params.id)
            .input("subId", sql.Int, req.user.id)
            .input("subSource", sql.NVarChar, "Users")
            .input("subName", sql.NVarChar, actorName)
            .query(`
              UPDATE leave_outs
              SET status='pending_final',
                  subadmin2_approver_id=@subId, subadmin2_approver_source=@subSource,
                  subadmin2_approver_name=@subName, subadmin2_approved_at=GETDATE()
              WHERE id=@id AND status='pending_subadmin2'
            `);

          if (upd.rowsAffected[0] === 0) {
            return res.status(409).json({ message: "This request was already processed." });
          }

          const studentName = await getStudentName(pool, student_id);
          const recipients = [
            ...(await getUsersByRole(pool, "sub_admin")),
            ...(await getUsersByRole(pool, "admin")),
          ];
          await notifyUsers(pool, recipients, {
            title: "Emergency Leave Awaiting Final Approval",
            message: `Emergency Leave for ${studentName} was approved by ${actorName} and is awaiting final approval.`,
            type: "leave_emergency_stage2",
            createdBy: req.user.id,
            createdBySource: "Users",
            link: LEAVE_LINK_BY_SOURCE.Users,
          });

          return res.json({ message: "Approved — awaiting final approval" });
        }

        if (status === "pending_final") {
          if (!["sub_admin", "admin"].includes(role)) {
            return res.status(403).json({ message: "Only Sub-Admin 1 (or Admin) can give final approval for Emergency Leave." });
          }

          const upd = await pool.request()
            .input("id", sql.Int, req.params.id)
            .input("approvedAt", sql.DateTime, approvedAt || new Date())
            .input("duration", sql.Int, finalDuration)
            .input("finalApproverId", sql.Int, req.user.id)
            .input("finalApproverSource", sql.NVarChar, "Users")
            .input("finalApproverName", sql.NVarChar, actorName)
            .query(`
              UPDATE leave_outs
              SET status='approved', approved_at=@approvedAt, duration=@duration,
                  final_approver_id=@finalApproverId, final_approver_source=@finalApproverSource,
                  final_approver_name=@finalApproverName, final_approved_at=GETDATE()
              WHERE id=@id AND status='pending_final'
            `);

          if (upd.rowsAffected[0] === 0) {
            return res.status(409).json({ message: "This request was already processed." });
          }

          const code = await ensureGateCode(pool, req.params.id, gate_code);

          await notifyUsers(pool, [{ id: student_id, source: "Students" }], {
            title: "Emergency Leave Approved",
            message: `Your Emergency Leave has been approved by ${actorName}.${code ? ` Your code ${code} is now valid at the gate.` : ""}`,
            type: "leave",
            createdBy: req.user.id,
            createdBySource: "Users",
            link: LEAVE_LINK_BY_SOURCE.Students,
          });

          return res.json({ message: "Approved", gate_code: code });
        }

        return res.status(409).json({ message: `This request is already ${status}.` });
      }

      /* ---------- SHORT STAY (and any legacy type): unchanged single stage ---------- */
      if (status !== "pending") {
        return res.status(409).json({ message: `This request is already ${status}.` });
      }

      const upd = await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("approvedAt", sql.DateTime, approvedAt || new Date())
        .input("duration", sql.Int, finalDuration)
        .input("finalApproverId", sql.Int, req.user.id)
        .input("finalApproverSource", sql.NVarChar, "Users")
        .input("finalApproverName", sql.NVarChar, actorName)
        .query(`
          UPDATE leave_outs
          SET status='approved', approved_at=@approvedAt, duration=@duration,
              final_approver_id=@finalApproverId, final_approver_source=@finalApproverSource,
              final_approver_name=@finalApproverName, final_approved_at=GETDATE()
          WHERE id=@id AND status='pending'
        `);

      if (upd.rowsAffected[0] === 0) {
        return res.status(409).json({ message: "This request was already processed." });
      }

      const code = await ensureGateCode(pool, req.params.id, gate_code);

      await notifyUsers(pool, [{ id: student_id, source: "Students" }], {
        title: "Leave Request Approved",
        message: `Your ${LEAVE_TYPE_LABEL[leave_type] || "leave"} request has been approved by ${actorName}.${code ? ` Your code ${code} is now valid at the gate.` : ""} You may print your leave permit from the Leave & Gate Pass page.`,
        type: "leave",
        createdBy: req.user.id,
        createdBySource: "Users",
        link: LEAVE_LINK_BY_SOURCE.Students,
      });

      res.json({ message: "Approved", gate_code: code });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Approve failed" });
    }
  });

  /* ================= DENY / REJECT =================
     Same stage/role gating as approve, so a request can be rejected
     from whichever stage it currently sits at but never from the
     wrong one.
  */
  router.put("/:id/deny", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;
      const role = req.user.role;
      const { reason } = req.body;
      const denyReason = reason || "No reason provided";

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id, leave_type, status, code_verified FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const { student_id, leave_type, status, code_verified } = existing.recordset[0];

      if (role === "sub_admin" && isSubAdmin1GateStage({ leave_type, status }) && !code_verified) {
        return res.status(403).json({ message: "Enter this request's code before rejecting it." });
      }

      // Which stages this leave_type can currently be rejected from, and
      // who's allowed to reject at that stage.
      const REJECTABLE_STAGES = {
        long: { pending_admin: ["admin"] },
        emergency: { pending_subadmin2: ["sub_admin_2", "admin"], pending_final: ["sub_admin", "admin"] },
        short_stay: { pending: ["admin", "sub_admin", "sub_admin_2"] },
      };
      const stages = REJECTABLE_STAGES[leave_type] || REJECTABLE_STAGES.short_stay;
      const allowedRoles = stages[status];

      if (!allowedRoles) {
        return res.status(409).json({ message: `This request is already ${status}.` });
      }
      if (!allowedRoles.includes(role)) {
        return res.status(403).json({ message: "You are not authorized to reject this request at its current stage." });
      }

      const actorName = await getActorDisplayName(pool, req.user);

      const upd = await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("reason", sql.NVarChar, denyReason)
        .input("rejectedById", sql.Int, req.user.id)
        .input("rejectedBySource", sql.NVarChar, "Users")
        .input("rejectedByName", sql.NVarChar, actorName)
        .input("rejectStage", sql.NVarChar, status)
        .input("status", sql.NVarChar, status)
        .query(`
          UPDATE leave_outs
          SET status='rejected',
              deny_reason=@reason,
              rejected_by_id=@rejectedById, rejected_by_source=@rejectedBySource,
              rejected_by_name=@rejectedByName, rejected_at=GETDATE(), reject_stage=@rejectStage
          WHERE id=@id AND status=@status
        `);

      if (upd.rowsAffected[0] === 0) {
        return res.status(409).json({ message: "This request was already processed." });
      }

      await notifyUsers(pool, [{ id: student_id, source: "Students" }], {
        title: "Leave Request Rejected",
        message: `Your ${LEAVE_TYPE_LABEL[leave_type] || "leave"} request was rejected by ${actorName}. Reason: ${denyReason}`,
        type: "leave",
        createdBy: req.user.id,
        createdBySource: "Users",
        link: LEAVE_LINK_BY_SOURCE.Students,
      });

      res.json({ message: "Rejected" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Deny failed" });
    }
  });

  /* ================= STUDENT CANCEL =================
     A student may cancel only their own, still-pending request.
  */
  router.put("/:id/cancel", authorize("student"), async (req, res) => {
    try {
      const pool = await poolPromise;

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id, status FROM leave_outs WHERE id=@id`);

      if (!existing.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const { student_id, status } = existing.recordset[0];

      if (student_id !== req.user.id) {
        return res.status(403).json({ message: "You can only cancel your own leave requests." });
      }

      const CANCELLABLE = ["pending", "pending_subadmin2", "pending_final", "pending_admin"];
      if (!CANCELLABLE.includes(status)) {
        return res.status(409).json({ message: `This request can no longer be cancelled (currently ${status}).` });
      }

      const upd = await pool.request()
        .input("id", sql.Int, req.params.id)
        .input("status", sql.NVarChar, status)
        .query(`UPDATE leave_outs SET status='cancelled' WHERE id=@id AND status=@status`);

      if (upd.rowsAffected[0] === 0) {
        return res.status(409).json({ message: "This request was already processed." });
      }

      res.json({ message: "Cancelled" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Cancel failed" });
    }
  });

  /* ================= ADMIN FORCE GRANT =================
     Admin-only, enforced on the backend (authorize("admin")) — a
     Sub-Admin or Student hitting this endpoint directly gets a 403
     regardless of what the UI shows them. Leave becomes Approved /
     Admin Granted immediately; no approval workflow runs at all.
  */
  router.post("/force-grant", authorize("admin"), async (req, res) => {
    try {
      const pool = await poolPromise;

      const { student_id, leave_type, request_date, duration, end_date, reason } = req.body;

      if (!student_id) {
        return res.status(400).json({ message: "student_id is required" });
      }

      const type = VALID_LEAVE_TYPES.includes(leave_type) ? leave_type : "short_stay";
      const startDate = request_date ? new Date(request_date) : new Date();

      let finalDuration = duration || DEFAULT_DURATION_BY_TYPE[type];
      if (!duration && end_date) {
        const end = new Date(end_date);
        const diffMinutes = Math.round((end.getTime() - startDate.getTime()) / 60000);
        if (diffMinutes > 0) finalDuration = diffMinutes;
      }

      const adminName = await getActorDisplayName(pool, req.user);

      const inserted = await pool.request()
        .input("student_id", sql.Int, student_id)
        .input("reason", sql.NVarChar, reason || "Granted by Admin")
        .input("request_date", sql.Date, startDate)
        .input("duration", sql.Int, finalDuration)
        .input("end_date", sql.DateTime, end_date ? new Date(end_date) : null)
        .input("leave_type", sql.NVarChar, type)
        .input("grantedById", sql.Int, req.user.id)
        .input("grantedBySource", sql.NVarChar, "Users")
        .input("grantedByName", sql.NVarChar, adminName)
        .query(`
          INSERT INTO leave_outs
            (student_id, reason, request_date, duration, end_date, status, leave_type,
             is_admin_granted, granted_by_id, granted_by_source, granted_by_name, granted_at, approved_at,
             code_verified, code_verified_by_name, code_verified_at)
          OUTPUT INSERTED.id
          VALUES
            (@student_id, @reason, @request_date, @duration, @end_date, 'admin_granted', @leave_type,
             1, @grantedById, @grantedBySource, @grantedByName, GETDATE(), GETDATE(),
             1, @grantedByName, GETDATE())
        `);

      const newId = inserted.recordset[0]?.id;
      const code = await generateGateCode(pool, newId);

      await notifyUsers(pool, [{ id: student_id, source: "Students" }], {
        title: "Leave Granted by Admin",
        message: `You have been granted ${LEAVE_TYPE_LABEL[type] || "leave"} by ${adminName}.${reason ? ` Reason: ${reason}` : ""}${code ? ` Your gate code: ${code}.` : ""}`,
        type: "leave_admin_granted",
        createdBy: req.user.id,
        createdBySource: "Users",
        link: LEAVE_LINK_BY_SOURCE.Students,
      });

      res.json({ message: "Leave granted", id: newId, gate_code: code });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Force grant failed" });
    }
  });

  /* ================= REVOKE ================= */
  router.put("/:id/revoke", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;

      // Get student info first (for WhatsApp + in-app notification)
      const leave = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          SELECT student_id, reason, status, leave_type
          FROM leave_outs
          WHERE id=@id
        `);

      if (!leave.recordset.length) {
        return res.status(404).json({ message: "Leave not found" });
      }

      const data = leave.recordset[0];

      // Prevent double revoke
      if (data.status === "revoked") {
        return res.status(400).json({ message: "Already revoked" });
      }

      // Sub-admins may never revoke a Long-Stay Leave (same rule as
      // approve/deny) — only Admin manages that workflow end-to-end.
      if (data.leave_type === "long" && req.user.role !== "admin") {
        return res.status(403).json({ message: "Only Admin can manage Long-Stay Leave." });
      }

      // Update status
      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          UPDATE leave_outs
          SET status='revoked'
          WHERE id=@id
        `);

      /* ================= WHATSAPP HOOK =================
         Replace this with real WhatsApp API (Twilio / Meta Cloud API)
      */
      console.log(`📲 WhatsApp to Student ${data.student_id}:`);
      console.log(`Your leave has been REVOKED. Please report back immediately.`);

      await notifyUsers(pool, [{ id: data.student_id, source: "Students" }], {
        title: "Leave Revoked",
        message: "Your leave has been revoked by the administration. Please report back to the institution immediately.",
        type: "leave_urgent",
        createdBy: req.user.id,
        createdBySource: "Users",
        link: LEAVE_LINK_BY_SOURCE.Students,
      });

      res.json({ message: "Leave revoked & student notified" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Revoke failed" });
    }
  });

  /* ================= EXPIRE ================= */
  router.put("/:id/expire", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;

      const existing = await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`SELECT student_id FROM leave_outs WHERE id=@id`);

      await pool.request()
        .input("id", sql.Int, req.params.id)
        .query(`
          UPDATE leave_outs
          SET status='expired'
          WHERE id=@id
        `);

      if (existing.recordset.length) {
        await notifyUsers(pool, [{ id: existing.recordset[0].student_id, source: "Students" }], {
          title: "Leave Expired",
          message: "Your approved leave duration has expired. Please report back to the institution.",
          type: "leave_urgent",
          link: LEAVE_LINK_BY_SOURCE.Students,
        });
      }

      res.json({ message: "Expired" });

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Expire failed" });
    }
  });

  /* ================= APPROVED LEAVES (report / download) =================
     Every approved / admin_granted leave, resolved to student name +
     admission number server-side so the frontend's CSV export doesn't
     need a second round trip against /students to fill those in.
     Same role/type scoping as GET / (sub_admin never sees Long-Stay;
     sub_admin_2 sees Emergency only) — but never redacted, since these
     are already-resolved records, not pending review.
  */
  router.get("/approved", authorize(...LEAVE_STAFF_ROLES), async (req, res) => {
    try {
      const pool = await poolPromise;
      const role = req.user.role;

      let where = "WHERE lo.status IN ('approved','admin_granted')";
      if (role === "sub_admin_2") where += " AND lo.leave_type = 'emergency'";
      else if (role === "sub_admin") where += " AND lo.leave_type <> 'long'";

      const result = await pool.request().query(`
        SELECT lo.*, s.name AS student_name, s.admissionNo, s.studentClass
        FROM leave_outs lo
        LEFT JOIN Students s ON s.id = lo.student_id
        ${where}
        ORDER BY lo.approved_at DESC
      `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  /* ================= ANALYTICS ================= */
  /* sub_admin_2 is intentionally excluded here (admin / sub_admin only).
     That role can only ever see a raw list of Emergency requests, never
     totals/counts/analytics of any kind — see LeaveOut.jsx, which also
     never calls this endpoint for that role. Enforced here too so it
     can't be reached by calling the API directly. */
  router.get("/analytics", authorize("admin", "sub_admin"), async (req, res) => {
    try {
      const pool = await poolPromise;

      const role = req.user.role;
      const excludeLong = role === "sub_admin";

      const result = await pool.request().query(`
        SELECT 
          student_id,
          COUNT(*) AS totalLeaves,
          SUM(CASE WHEN status IN ('approved','admin_granted') THEN 1 ELSE 0 END) AS approvedLeaves,
          SUM(CASE WHEN status IN ('pending','pending_subadmin2','pending_final','pending_admin') THEN 1 ELSE 0 END) AS pendingLeaves,
          SUM(CASE WHEN status IN ('denied','rejected') THEN 1 ELSE 0 END) AS deniedLeaves,
          SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expiredLeaves,
          SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revokedLeaves
        FROM leave_outs
        ${excludeLong ? "WHERE leave_type <> 'long'" : ""}
        GROUP BY student_id
        ORDER BY totalLeaves DESC
      `);

      res.json(result.recordset || []);

    } catch (err) {
      console.log(err);
      res.status(500).json([]);
    }
  });

  return router;
};