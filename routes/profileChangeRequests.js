const express = require("express");
const router = express.Router();
const { sql } = require("../config/db");
const { protect, authorize, requirePage } = require("../middleware/authMiddleware");

/* =========================================================
   PROFILE CHANGE REQUESTS
   A student's FIRST-EVER profile save (right after their forced
   password change, see PUT /api/student/profile) applies straight
   away. Every save after that is no longer applied directly —
   instead it's queued here as a pending request, and an admin has
   to approve it before it lands on the Students row. Rejecting it
   just closes the request out with no change made.
========================================================= */

/* ---------------- STUDENT: submit a change request ----------------
   Called by StudentProfile.jsx once profileCompleted is already 1.
   Only one pending request per student at a time — resubmitting
   while one is still pending just overwrites the proposed values on
   that same pending row instead of piling up duplicates. */
router.post("/", protect, authorize("student"), async (req, res) => {
  try {
    const pool = req.pool;
    const studentId = req.user.id;

    let { studentClass, gender, email, phone, assessmentNumber } = req.body;

    studentClass = (studentClass || "").toString().trim();
    gender = (gender || "").toString().trim();
    email = (email || "").toString().trim();
    phone = (phone || "").toString().trim();
    assessmentNumber = (assessmentNumber || "").toString().trim();

    if (!studentClass || !gender || !email || !phone) {
      return res.status(400).json({
        message: "Class, gender, email, and phone are required",
      });
    }

    let cleanPhone = phone;
    if (cleanPhone.startsWith("0")) {
      cleanPhone = "+254" + cleanPhone.substring(1);
    }

    const existing = await pool
      .request()
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT id FROM student_profile_change_requests
        WHERE student_id = @studentId AND status = 'pending'
      `);

    if (existing.recordset.length > 0) {
      // update the same pending row rather than creating a second one
      await pool
        .request()
        .input("id", sql.Int, existing.recordset[0].id)
        .input("studentClass", sql.NVarChar, studentClass)
        .input("gender", sql.NVarChar, gender)
        .input("email", sql.NVarChar, email)
        .input("phone", sql.NVarChar, cleanPhone)
        .input("assessmentNumber", sql.NVarChar, assessmentNumber || null)
        .query(`
          UPDATE student_profile_change_requests
          SET requested_studentClass = @studentClass,
              requested_gender = @gender,
              requested_email = @email,
              requested_phone = @phone,
              requested_assessmentNumber = @assessmentNumber,
              requested_at = GETDATE()
          WHERE id = @id
        `);

      return res.json({
        message: "Your change request was updated and is awaiting admin approval",
        pending: true,
      });
    }

    await pool
      .request()
      .input("studentId", sql.Int, studentId)
      .input("studentClass", sql.NVarChar, studentClass)
      .input("gender", sql.NVarChar, gender)
      .input("email", sql.NVarChar, email)
      .input("phone", sql.NVarChar, cleanPhone)
      .input("assessmentNumber", sql.NVarChar, assessmentNumber || null)
      .query(`
        INSERT INTO student_profile_change_requests
          (student_id, requested_studentClass, requested_gender, requested_email, requested_phone, requested_assessmentNumber, status)
        VALUES
          (@studentId, @studentClass, @gender, @email, @phone, @assessmentNumber, 'pending')
      `);

    res.json({
      message: "Your change request has been submitted for admin approval",
      pending: true,
    });
  } catch (err) {
    console.log("PROFILE CHANGE REQUEST SUBMIT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------- STUDENT: check their own latest request ----------------
   Lets StudentProfile.jsx show "pending approval" / "rejected" banners
   without an admin page. Only ever returns the logged-in student's own
   most recent request. */
router.get("/mine", protect, authorize("student"), async (req, res) => {
  try {
    const pool = req.pool;

    const result = await pool
      .request()
      .input("studentId", sql.Int, req.user.id)
      .query(`
        SELECT TOP 1 *
        FROM student_profile_change_requests
        WHERE student_id = @studentId
        ORDER BY requested_at DESC
      `);

    res.json(result.recordset[0] || null);
  } catch (err) {
    console.log("PROFILE CHANGE REQUEST (MINE) ERROR:", err);
    res.status(500).json({});
  }
});

/* ---------------- ADMIN: list requests ----------------
   ?status=pending|approved|rejected — defaults to pending. */
router.get("/", protect, requirePage("Profile Change Requests"), async (req, res) => {
  try {
    const pool = req.pool;
    const status = (req.query.status || "pending").toString().toLowerCase();

    const result = await pool
      .request()
      .input("status", sql.NVarChar, status)
      .query(`
        SELECT r.*,
               s.name AS studentName,
               s.admissionNo,
               s.studentClass AS currentClass,
               s.gender AS currentGender,
               s.email AS currentEmail,
               s.phone AS currentPhone,
               s.assessmentNumber AS currentAssessmentNumber
        FROM student_profile_change_requests r
        JOIN Students s ON s.id = r.student_id
        WHERE r.status = @status
        ORDER BY r.requested_at DESC
      `);

    res.json(result.recordset);
  } catch (err) {
    console.log("PROFILE CHANGE REQUESTS LIST ERROR:", err);
    res.status(500).json([]);
  }
});

/* ---------------- ADMIN: approve ----------------
   Applies the requested_* values onto the Students row, then closes
   the request out as approved. */
router.put("/:id/approve", protect, requirePage("Profile Change Requests"), async (req, res) => {
  try {
    const pool = req.pool;
    const id = parseInt(req.params.id, 10);

    if (!id) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    const reqRes = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`SELECT * FROM student_profile_change_requests WHERE id = @id`);

    const changeRequest = reqRes.recordset[0];

    if (!changeRequest) {
      return res.status(404).json({ message: "Request not found" });
    }

    if (changeRequest.status !== "pending") {
      return res.status(400).json({ message: `Request already ${changeRequest.status}` });
    }

    await pool
      .request()
      .input("studentId", sql.Int, changeRequest.student_id)
      .input("studentClass", sql.NVarChar, changeRequest.requested_studentClass)
      .input("gender", sql.NVarChar, changeRequest.requested_gender)
      .input("email", sql.NVarChar, changeRequest.requested_email)
      .input("phone", sql.NVarChar, changeRequest.requested_phone)
      .input("assessmentNumber", sql.NVarChar, changeRequest.requested_assessmentNumber)
      .query(`
        UPDATE Students
        SET studentClass = @studentClass,
            gender = @gender,
            email = @email,
            phone = @phone,
            assessmentNumber = @assessmentNumber
        WHERE id = @studentId
      `);

    await pool
      .request()
      .input("id", sql.Int, id)
      .input("reviewedById", sql.Int, req.user.id)
      .input("reviewedByName", sql.NVarChar, req.user.username || "")
      .query(`
        UPDATE student_profile_change_requests
        SET status = 'approved',
            reviewed_by_id = @reviewedById,
            reviewed_by_name = @reviewedByName,
            reviewed_at = GETDATE()
        WHERE id = @id
      `);

    res.json({ message: "Change request approved and applied" });
  } catch (err) {
    console.log("PROFILE CHANGE REQUEST APPROVE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------------- ADMIN: reject ----------------
   Body: { reason } (optional). Never touches the Students row. */
router.put("/:id/reject", protect, requirePage("Profile Change Requests"), async (req, res) => {
  try {
    const pool = req.pool;
    const id = parseInt(req.params.id, 10);
    const reason = (req.body?.reason || "").toString().trim();

    if (!id) {
      return res.status(400).json({ message: "Invalid request id" });
    }

    const reqRes = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`SELECT status FROM student_profile_change_requests WHERE id = @id`);

    const changeRequest = reqRes.recordset[0];

    if (!changeRequest) {
      return res.status(404).json({ message: "Request not found" });
    }

    if (changeRequest.status !== "pending") {
      return res.status(400).json({ message: `Request already ${changeRequest.status}` });
    }

    await pool
      .request()
      .input("id", sql.Int, id)
      .input("reviewedById", sql.Int, req.user.id)
      .input("reviewedByName", sql.NVarChar, req.user.username || "")
      .input("reason", sql.NVarChar, reason || null)
      .query(`
        UPDATE student_profile_change_requests
        SET status = 'rejected',
            reviewed_by_id = @reviewedById,
            reviewed_by_name = @reviewedByName,
            reviewed_at = GETDATE(),
            rejection_reason = @reason
        WHERE id = @id
      `);

    res.json({ message: "Change request rejected" });
  } catch (err) {
    console.log("PROFILE CHANGE REQUEST REJECT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
