const sql = require("mssql");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/* =========================================================================
   HELPERS
========================================================================= */
const toInt = (v) => {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
};

// 6-char token, uppercase letters + digits, ambiguous chars (0,O,1,I) removed
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const generateToken = () => {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
};

/* =========================================================================
   CORE ASSESSMENT CRUD
========================================================================= */
const createEAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const { title, subject, class_id, duration_minutes, instructions, total_marks, exam_password, questions_deadline, question_setter_teacher_ids } = req.body;
    const teacher_id = req.user?.id || null;

    if (!title || !subject || !class_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const result = await pool.request()
      .input("title", sql.NVarChar, title)
      .input("subject", sql.NVarChar, subject)
      .input("class_id", sql.Int, class_id)
      .input("teacher_id", sql.Int, teacher_id)
      .input("duration_minutes", sql.Int, duration_minutes || 30)
      .input("total_marks", sql.Int, total_marks || 100)
      .input("instructions", sql.NVarChar, instructions || "")
      .input("exam_password", sql.NVarChar, (exam_password || "").trim() || null)
      .input("questions_deadline", sql.DateTime, questions_deadline ? new Date(questions_deadline) : null)
      .query(`
        INSERT INTO e_assessments
          (title, subject, class_id, teacher_id, duration_minutes, total_marks, instructions, status, exam_password, questions_deadline)
        OUTPUT INSERTED.id
        VALUES
          (@title, @subject, @class_id, @teacher_id, @duration_minutes, @total_marks, @instructions, 'pending', @exam_password, @questions_deadline)
      `);

    const assessmentId = result.recordset[0].id;

    if (Array.isArray(question_setter_teacher_ids)) {
      for (const tId of question_setter_teacher_ids) {
        const tid = toInt(tId);
        if (!tid) continue;
        await pool.request()
          .input("e_assessment_id", sql.Int, assessmentId)
          .input("teacher_id", sql.Int, tid)
          .query(`
            INSERT INTO e_assessment_question_setters (e_assessment_id, teacher_id)
            VALUES (@e_assessment_id, @teacher_id)
          `);
      }
    }

    res.status(201).json({ success: true, assessment_id: assessmentId });
  } catch (err) {
    console.error("CREATE E-ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Create assessment failed" });
  }
};
const updateEAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { title, subject, class_id, duration_minutes, instructions, total_marks, exam_password, questions_deadline, question_setter_teacher_ids } = req.body;

    if (!id) return res.status(400).json({ message: "Invalid assessment ID" });
    if (!title || !subject || !class_id) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const existing = await pool.request().input("id", sql.Int, id)
      .query(`SELECT id FROM e_assessments WHERE id = @id`);
    if (!existing.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    await pool.request()
      .input("id", sql.Int, id)
      .input("title", sql.NVarChar, title)
      .input("subject", sql.NVarChar, subject)
      .input("class_id", sql.Int, class_id)
      .input("duration_minutes", sql.Int, duration_minutes || 30)
      .input("total_marks", sql.Int, total_marks || 100)
      .input("instructions", sql.NVarChar, instructions || "")
      .input("exam_password", sql.NVarChar, (exam_password || "").trim() || null)
      .input("questions_deadline", sql.DateTime, questions_deadline ? new Date(questions_deadline) : null)
      .query(`
        UPDATE e_assessments
        SET title = @title,
            subject = @subject,
            class_id = @class_id,
            duration_minutes = @duration_minutes,
            total_marks = @total_marks,
            instructions = @instructions,
            exam_password = @exam_password,
            questions_deadline = @questions_deadline
        WHERE id = @id
      `);

    // Only touch the setter list when the caller explicitly sent one —
    // an array (including empty, to clear it) replaces the list; omitting
    // the field entirely leaves the existing assignments untouched.
    if (Array.isArray(question_setter_teacher_ids)) {
      await pool.request().input("id", sql.Int, id)
        .query(`DELETE FROM e_assessment_question_setters WHERE e_assessment_id = @id`);
      for (const tId of question_setter_teacher_ids) {
        const tid = toInt(tId);
        if (!tid) continue;
        await pool.request()
          .input("e_assessment_id", sql.Int, id)
          .input("teacher_id", sql.Int, tid)
          .query(`
            INSERT INTO e_assessment_question_setters (e_assessment_id, teacher_id)
            VALUES (@e_assessment_id, @teacher_id)
          `);
      }
    }

    res.json({ success: true, message: "Assessment updated successfully" });
  } catch (err) {
    console.error("UPDATE E-ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Update failed", error: err.message });
  }
};

// Students (including exam-only sessions) never receive exam_password or
// correct_answer in a payload — only admin/teacher accounts managing the
// assessment need to see either of those.
const STAFF_ROLES = ["admin", "sub_admin", "teacher"];
const redactForRole = (row, role) => {
  if (STAFF_ROLES.includes(role)) return row;
  const { exam_password, ...rest } = row;
  return rest;
};

const getEAssessments = async (req, res) => {
  try {
    const pool = req.pool;

    // A teacher must see: (a) assessments THEY created/own
    // (e_assessments.teacher_id, set from req.user.id in createEAssessment),
    // (b) assessments they didn't create but where an admin (or another
    // teacher) has assigned them one or more submissions to mark, via
    // e_assessment_submission_assignments, AND (c) assessments where the
    // admin picked them as a permitted question-setter (e_assessment_
    // question_setters) — this is the case that matters BEFORE any
    // submissions exist yet, since a teacher can't be assigned a
    // submission for an exam nobody has taken. Without (b)/(c) a teacher
    // who isn't the creator has no way to ever find the assessment.
    // Admin and sub_admin still see everything (needed for review/
    // approval), and students see everything for their class
    // (redactForRole strips the exam password for them).
    const isTeacher = req.user?.role === "teacher";

    const request = pool.request();
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT ea.*, t.name AS teacher_name, c.name AS class_name,
        ${isTeacher ? "CASE WHEN ea.teacher_id = @teacherId THEN 0 ELSE 1 END" : "0"} AS assigned_only
      FROM e_assessments ea
      LEFT JOIN Teachers t ON ea.teacher_id = t.id
      LEFT JOIN Classes c ON ea.class_id = c.id
      ${isTeacher ? `
      WHERE ea.teacher_id = @teacherId
         OR EXISTS (
              SELECT 1
              FROM e_assessment_submissions s
              INNER JOIN e_assessment_submission_assignments aa
                ON aa.submission_id = s.id AND aa.teacher_id = @teacherId
              WHERE s.e_assessment_id = ea.id
            )
         OR EXISTS (
              SELECT 1 FROM e_assessment_question_setters qs
              WHERE qs.e_assessment_id = ea.id AND qs.teacher_id = @teacherId
            )` : ""}
      ORDER BY ea.id DESC
    `);
    const rows = (result.recordset || []).map((r) => redactForRole(r, req.user?.role));

    // Attach each assessment's permitted question-setter teacher ids
    // (admin/sub_admin only need this — it's what pre-fills the "Teachers
    // allowed to add questions" picker when they reopen Edit).
    if (rows.length && (req.user?.role === "admin" || req.user?.role === "sub_admin")) {
      const setterResult = await pool.request().query(`
        SELECT e_assessment_id, teacher_id FROM e_assessment_question_setters
      `);
      const byAssessment = {};
      for (const s of setterResult.recordset || []) {
        (byAssessment[s.e_assessment_id] ||= []).push(s.teacher_id);
      }
      for (const r of rows) r.question_setter_teacher_ids = byAssessment[r.id] || [];
    }

    res.json(rows);
  } catch (err) {
    console.error("GET ASSESSMENTS ERROR:", err);
    res.status(500).json([]);
  }
};

const getEAssessmentById = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);

    // A student may only ever fetch an assessment's content through the
    // exam-only session created by /e-assessments/exam-login (username +
    // this assessment's admin-set exam password) — and only for the exact
    // assessment that token was scoped to. A regular, otherwise-valid
    // student-portal login session is deliberately NOT enough on its own;
    // this is what stops a student who is simply logged into the portal
    // from opening someone else's — or even their own — exam without the
    // exam password.
    if (req.user?.role === "student") {
      if (!req.user.examOnly || req.user.examAssessmentId !== assessmentId) {
        return res.status(403).json({ message: "You must sign in with your username and this assessment's exam password to view it." });
      }
    }

    const assessmentResult = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT ea.*, c.name AS class_name, t.name AS teacher_name
        FROM e_assessments ea
        LEFT JOIN Classes  c ON ea.class_id   = c.id
        LEFT JOIN Teachers t ON ea.teacher_id = t.id
        WHERE ea.id = @id
      `);

    if (!assessmentResult.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }
    const assessment = redactForRole(assessmentResult.recordset[0], req.user?.role);

    const questionResult = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`
        SELECT q.id AS question_id, q.question_text, q.marks, q.correct_answer,
               q.question_type, o.option_label, o.option_text
        FROM e_assessment_questions q
        LEFT JOIN e_assessment_options o ON q.id = o.question_id
        WHERE q.e_assessment_id = @id
        ORDER BY q.id, o.option_label
      `);

    // Students taking the exam must never receive the answer key —
    // only admin/teacher (building/marking the assessment) get it.
    const includeAnswers = STAFF_ROLES.includes(req.user?.role);

    const map = {};
    questionResult.recordset.forEach((row) => {
      if (!map[row.question_id]) {
        map[row.question_id] = {
          id: row.question_id,
          question_text: row.question_text,
          marks: row.marks,
          ...(includeAnswers ? { correct_answer: row.correct_answer } : {}),
          question_type: row.question_type || "mcq",
          options: [],
        };
      }
      if (row.option_label) {
        map[row.question_id].options.push({ option_label: row.option_label, option_text: row.option_text });
      }
    });

    res.json({ assessment, questions: Object.values(map) });
  } catch (err) {
    console.error("GET ASSESSMENT ERROR:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

/* =========================================================================
   STANDALONE EXAM LOGIN (no portal account session required)
   ─────────────────────────────────────────────────────────
   Body: { assessmentId, username, examPassword }

   Lets a student reach /take-assessment/:id directly (e.g. from a link
   shared by their teacher) using just their username + the exam
   password set on this specific assessment — no prior /login needed.

   Deliberately never responds with HTTP 401/403: the frontend's global
   axios interceptor treats any 401/403 as "session invalid" and wipes
   localStorage + redirects to /login, which would yank a student who
   was never logged in in the first place off of this page. Bad
   credentials here are reported as normal 400-level JSON instead.

   The issued token is a normal student JWT (so all the existing
   protect/authorize("student") routes work unchanged) plus two extra
   claims — examOnly + examAssessmentId — that scope it to this one
   assessment. See redactForRole/getEAssessmentById and the exam-only
   checks in startExamSession/submitEAssessment/getStudentResult below.
========================================================================= */

const examLogin = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.body.assessmentId);
    const username = (req.body.username || "").trim();
    const examPassword = (req.body.examPassword || "").trim();

    if (!assessmentId || !username || !examPassword) {
      return res.status(400).json({ success: false, message: "Assessment, username and exam password are all required" });
    }

    const aRes = await pool.request()
      .input("id", sql.Int, assessmentId)
      .query(`SELECT id, title, subject, duration_minutes, class_id, status, active_status, exam_password FROM e_assessments WHERE id = @id`);

    if (!aRes.recordset.length) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }
    const assessment = aRes.recordset[0];

    if (!assessment.exam_password) {
      return res.status(400).json({ success: false, message: "This assessment has no exam password configured. Ask your teacher to set one, or log in to the student portal normally." });
    }
    if (assessment.exam_password !== examPassword) {
      return res.status(400).json({ success: false, message: "Incorrect exam password" });
    }
    if (assessment.status && assessment.status !== "approved") {
      return res.status(400).json({ success: false, message: "This assessment isn't open yet — check with your teacher." });
    }
    if (assessment.active_status && assessment.active_status !== "Active") {
      return res.status(400).json({ success: false, message: "This assessment isn't active right now." });
    }

    const sRes = await pool.request()
      .input("username", sql.NVarChar, username)
      .query(`SELECT id, username, name FROM Students WHERE username = @username`);

    if (!sRes.recordset.length) {
      return res.status(400).json({ success: false, message: "No student account found with that username" });
    }
    const student = sRes.recordset[0];

    // Short-lived on purpose: just long enough to sit the exam, not a
    // standing session. duration_minutes + 20 min buffer, clamped.
    const minutes = Math.min(Math.max((assessment.duration_minutes || 30) + 20, 30), 240);

    const token = jwt.sign(
      {
        id: student.id,
        username: student.username,
        role: "student",
        permissions: [],
        source: "Students",
        mustChangePassword: false,
        examOnly: true,
        examAssessmentId: assessment.id,
      },
      process.env.JWT_SECRET || "asumbi_secret",
      { expiresIn: `${minutes}m` }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: student.id,
        username: student.username,
        name: student.name || "",
        role: "student",
        permissions: [],
        source: "Students",
        mustChangePassword: false,
        examOnly: true,
        examAssessmentId: assessment.id,
      },
      assessment: {
        id: assessment.id,
        title: assessment.title,
        subject: assessment.subject,
        duration_minutes: assessment.duration_minutes,
      },
    });
  } catch (err) {
    console.error("EXAM LOGIN ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};


/* =========================================================================
   QUESTIONS
========================================================================= */

// Shared gate for add/update/delete question actions. Admin/sub_admin
// always pass. A teacher passes only if they created the assessment
// (legacy path) OR the admin explicitly picked them as a permitted
// question-setter in e_assessment_question_setters. Returns
// { ok: true } or { ok: false, status, message } for the caller to
// respond with directly.
async function canManageAssessmentQuestions(pool, req, e_assessmentId) {
  const role = req.user?.role;
  if (role === "admin" || role === "sub_admin") return { ok: true };

  const teacherId = toInt(req.user?.id);
  const result = await pool.request()
    .input("id", sql.Int, e_assessmentId)
    .input("teacherId", sql.Int, teacherId)
    .query(`
      SELECT
        (SELECT teacher_id FROM e_assessments WHERE id = @id) AS owner_teacher_id,
        (SELECT COUNT(*) FROM e_assessment_question_setters
          WHERE e_assessment_id = @id AND teacher_id = @teacherId) AS is_setter
    `);
  const row = result.recordset[0];
  if (!row || row.owner_teacher_id == null) {
    return { ok: false, status: 404, message: "Assessment not found" };
  }
  if (row.owner_teacher_id === teacherId || row.is_setter > 0) {
    return { ok: true };
  }
  return {
    ok: false, status: 403,
    message: "You have not been assigned to add questions to this assessment.",
  };
}

const addEAssessmentQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    const { question_text, marks, options, correct_answer, question_type, time_limit, marking_guide } = req.body;

    if (!e_assessmentId || !question_text) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const permission = await canManageAssessmentQuestions(pool, req, e_assessmentId);
    if (!permission.ok) {
      return res.status(permission.status).json({ message: permission.message });
    }

    // Enforce the admin-set "add questions by" deadline server-side —
    // the frontend disables the button too, but that alone can always be
    // bypassed by calling the API directly, so the real gate lives here.
    const deadlineCheck = await pool.request().input("id", sql.Int, e_assessmentId)
      .query(`SELECT questions_deadline FROM e_assessments WHERE id = @id`);
    if (!deadlineCheck.recordset.length) {
      return res.status(404).json({ message: "Assessment not found" });
    }
    const deadline = deadlineCheck.recordset[0].questions_deadline;
    if (deadline && new Date(deadline) < new Date()) {
      return res.status(403).json({
        message: `The deadline to add questions to this assessment passed on ${new Date(deadline).toLocaleString()}.`,
      });
    }

    const type = question_type === "essay" ? "essay" : "mcq";

    const questionResult = await pool.request()
      .input("e_assessment_id", sql.Int, e_assessmentId)
      .input("question_text", sql.NVarChar(sql.MAX), question_text)
      .input("marks", sql.Int, marks || 1)
      .input("correct_answer", sql.NVarChar(sql.MAX), type === "mcq" ? correct_answer || null : null)
      .input("marking_guide", sql.NVarChar(sql.MAX), type === "essay" ? marking_guide || null : null)
      .input("question_type", sql.NVarChar(50), type)
      .input("time_limit", sql.Int, time_limit || 60)
      .query(`
        INSERT INTO e_assessment_questions
          (e_assessment_id, question_text, question_type, marks, time_limit, correct_answer, marking_guide)
        OUTPUT INSERTED.id
        VALUES
          (@e_assessment_id, @question_text, @question_type, @marks, @time_limit, @correct_answer, @marking_guide)
      `);

    const questionId = questionResult.recordset[0].id;

    if (type === "mcq" && Array.isArray(options)) {
      for (const o of options) {
        await pool.request()
          .input("question_id", sql.Int, questionId)
          .input("option_label", sql.NVarChar(10), o.label || o.option_label)
          .input("option_text", sql.NVarChar(sql.MAX), o.text || o.option_text)
          .query(`
            INSERT INTO e_assessment_options (question_id, option_label, option_text)
            VALUES (@question_id, @option_label, @option_text)
          `);
      }
    }

    res.json({ success: true, question_id: questionId, question_type: type });
  } catch (err) {
    console.error("ADD QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const getAssessmentQuestions = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);

    const result = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .query(`
        SELECT q.id, q.question_text, q.marks, q.correct_answer, q.marking_guide,
               q.question_type, o.option_label, o.option_text
        FROM e_assessment_questions q
        LEFT JOIN e_assessment_options o ON q.id = o.question_id
        WHERE q.e_assessment_id = @assessmentId
        ORDER BY q.id
      `);

    const map = {};
    result.recordset.forEach((row) => {
      if (!map[row.id]) {
        map[row.id] = {
          id: row.id,
          question_text: row.question_text,
          marks: row.marks,
          correct_answer: row.correct_answer,
          marking_guide: row.marking_guide,
          question_type: row.question_type || "mcq",
          options: [],
        };
      }
      if (row.option_label) {
        map[row.id].options.push({ option_label: row.option_label, option_text: row.option_text });
      }
    });

    res.json(Object.values(map));
  } catch (err) {
    console.error("GET QUESTIONS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    const { question_text, marks, correct_answer, marking_guide, essay_answer, options, question_type, time_limit } = req.body;
    const type = question_type === "essay" || question_type === "descriptive" ? "essay" : "mcq";

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    await pool.request()
      .input("id", sql.Int, questionId)
      .input("question_text", sql.NVarChar(sql.MAX), question_text)
      .input("marks", sql.Int, marks || 1)
      .input("correct_answer", sql.NVarChar(sql.MAX), type === "mcq" ? correct_answer || null : null)
      .input("marking_guide", sql.NVarChar(sql.MAX), type === "essay" ? (marking_guide || essay_answer || null) : null)
      .input("question_type", sql.NVarChar(50), type)
      .input("time_limit", sql.Int, time_limit || 60)
      .query(`
        UPDATE e_assessment_questions
        SET question_text = @question_text, marks = @marks, correct_answer = @correct_answer,
            marking_guide = @marking_guide, question_type = @question_type, time_limit = @time_limit
        WHERE id = @id
      `);

    await pool.request().input("id", sql.Int, questionId)
      .query(`DELETE FROM e_assessment_options WHERE question_id = @id`);

    if (type === "mcq" && Array.isArray(options)) {
      for (const option of options) {
        await pool.request()
          .input("question_id", sql.Int, questionId)
          .input("option_label", sql.NVarChar(10), option.label || option.option_label)
          .input("option_text", sql.NVarChar(sql.MAX), option.text || option.option_text)
          .query(`
            INSERT INTO e_assessment_options (question_id, option_label, option_text)
            VALUES (@question_id, @option_label, @option_text)
          `);
      }
    }

    res.json({ success: true, message: "Question updated successfully" });
  } catch (err) {
    console.error("UPDATE QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const deleteQuestion = async (req, res) => {
  try {
    const pool = req.pool;
    const questionId = toInt(req.params.questionId);
    if (!questionId) return res.status(400).json({ success: false, message: "Invalid question ID" });

    const parent = await pool.request().input("id", sql.Int, questionId)
      .query(`SELECT e_assessment_id FROM e_assessment_questions WHERE id = @id`);
    if (!parent.recordset.length) {
      return res.status(404).json({ success: false, message: "Question not found" });
    }
    const permission = await canManageAssessmentQuestions(pool, req, parent.recordset[0].e_assessment_id);
    if (!permission.ok) {
      return res.status(permission.status).json({ success: false, message: permission.message });
    }

    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_options WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_answers WHERE question_id = @id`);
    await pool.request().input("id", sql.Int, questionId).query(`DELETE FROM e_assessment_questions WHERE id = @id`);

    res.json({ success: true, message: "Question deleted successfully" });
  } catch (err) {
    console.error("DELETE QUESTION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================================
   EXAM SESSION / SINGLE-DEVICE TOKEN LOCK
   ------------------------------------------------------------------------
   Honest limitation: a web page cannot disable a physical device or block
   it "until restart" — no browser API reaches the OS. What this DOES do:
     - issue a one-time 6-character token per (student, assessment)
     - bind that token to the first device that activates it
     - reject / lock the session the instant a second device tries the
       same token (checked continuously via heartbeat)
     - the frontend then shows a full-screen lock overlay that traps
       input on the offending device until the exam ends or an admin
       clears the lock — this is the realistic, honest version of
       "locks the device."
========================================================================= */

// Student starts the exam -> issue (or resume) a token for this device-binding cycle
const startExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessment_id = toInt(req.params.id);
    const student_id = req.user?.id;
    if (!e_assessment_id || !student_id) {
      return res.status(400).json({ message: "Missing assessment or student" });
    }

    // Starting an exam session — the very first step of taking an exam —
    // requires the exam-only token issued by /e-assessments/exam-login for
    // this exact assessment. A general student-portal login is never
    // sufficient by itself: without the admin-set exam password for THIS
    // assessment, a portal session cannot start (or resume) it.
    if (!req.user?.examOnly || req.user.examAssessmentId !== e_assessment_id) {
      return res.status(403).json({ message: "You must sign in with your username and this assessment's exam password to start it." });
    }

    const existing = await pool.request()
      .input("aid", sql.Int, e_assessment_id)
      .input("sid", sql.Int, student_id)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);

    if (existing.recordset.length) {
      const row = existing.recordset[0];
      if (row.status === "ended") {
        return res.status(409).json({ message: "This assessment has already been completed" });
      }
      // Resume: return same token, do not re-issue (keeps device binding intact)
      return res.json({
        success: true,
        token: row.token,
        status: row.status,
        device_bound: !!row.device_id,
      });
    }

    let token, sessionId;
    try {
      token = generateToken();
      const result = await pool.request()
        .input("aid", sql.Int, e_assessment_id)
        .input("sid", sql.Int, student_id)
        .input("token", sql.Char(6), token)
        .query(`
          INSERT INTO e_assessment_exam_sessions (e_assessment_id, student_id, token, status)
          OUTPUT INSERTED.id
          VALUES (@aid, @sid, @token, 'issued')
        `);
      sessionId = result.recordset[0].id;
    } catch (insertErr) {
      // Race condition: another near-simultaneous request (e.g. a double-fired
      // React effect) already inserted the row between our SELECT and INSERT.
      // Instead of failing, just fetch and return the row that won the race.
      if (insertErr.number === 2627) {
        const retry = await pool.request()
          .input("aid", sql.Int, e_assessment_id)
          .input("sid", sql.Int, student_id)
          .query(`SELECT * FROM e_assessment_exam_sessions WHERE e_assessment_id = @aid AND student_id = @sid`);

        if (retry.recordset.length) {
          const row = retry.recordset[0];
          if (row.status === "ended") {
            return res.status(409).json({ message: "This assessment has already been completed" });
          }
          return res.json({
            success: true,
            token: row.token,
            status: row.status,
            device_bound: !!row.device_id,
          });
        }
      }
      throw insertErr; // not a race condition — genuine error, let the outer catch handle it
    }

    res.json({ success: true, session_id: sessionId, token, status: "issued", device_bound: false });
  } catch (err) {
    console.error("START EXAM SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to start exam session" });
  }
};
// Frontend calls this immediately after showing the token, binding this browser as "the device"
const activateExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id, device_label } = req.body;
    const student_id = req.user?.id;
    if (!token || !device_id) return res.status(400).json({ message: "token and device_id are required" });

    const result = await pool.request()
      .input("token", sql.Char(6), token)
      .input("sid", sql.Int, student_id)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token AND student_id = @sid`);

    if (!result.recordset.length) return res.status(404).json({ message: "Invalid or expired token" });
    const row = result.recordset[0];

    if (row.status === "locked") {
      return res.status(423).json({ locked: true, message: "This exam session is locked. Ask an admin to unlock it." });
    }
    if (row.status === "ended") {
      return res.status(409).json({ message: "This assessment has already been completed" });
    }

    if (!row.device_id) {
      // First activation — bind this device
      await pool.request()
        .input("id", sql.Int, row.id)
        .input("device_id", sql.NVarChar(200), device_id)
        .input("device_label", sql.NVarChar(300), device_label || "")
        .query(`
          UPDATE e_assessment_exam_sessions
          SET device_id = @device_id, device_label = @device_label,
              status = 'active', activated_at = GETDATE(), last_heartbeat = GETDATE()
          WHERE id = @id
        `);
      return res.json({ success: true, status: "active" });
    }

    if (row.device_id !== device_id) {
      // A different device tried to use this token — lock it out
      await pool.request()
        .input("id", sql.Int, row.id)
        .query(`
          UPDATE e_assessment_exam_sessions
          SET status = 'locked', locked_at = GETDATE(), lock_reason = 'Token used on a second device'
          WHERE id = @id
        `);
      return res.status(423).json({ locked: true, message: "This exam token is already in use on another device." });
    }

    // Same device resuming
    await pool.request().input("id", sql.Int, row.id)
      .query(`UPDATE e_assessment_exam_sessions SET last_heartbeat = GETDATE() WHERE id = @id`);
    res.json({ success: true, status: "active" });
  } catch (err) {
    console.error("ACTIVATE EXAM SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to activate exam session" });
  }
};

// Frontend pings this every ~10s while the exam is open
const heartbeatExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token, device_id } = req.body;
    if (!token || !device_id) return res.status(400).json({ message: "token and device_id are required" });

    const result = await pool.request().input("token", sql.Char(6), token)
      .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token`);
    if (!result.recordset.length) return res.status(404).json({ locked: false, ended: true, message: "Session not found" });

    const row = result.recordset[0];
    if (row.status === "ended") return res.json({ locked: false, ended: true });
    if (row.status === "locked") return res.status(423).json({ locked: true, ended: false });

    if (row.device_id && row.device_id !== device_id) {
      await pool.request().input("id", sql.Int, row.id).query(`
        UPDATE e_assessment_exam_sessions
        SET status = 'locked', locked_at = GETDATE(), lock_reason = 'Device mismatch on heartbeat'
        WHERE id = @id
      `);
      return res.status(423).json({ locked: true, ended: false });
    }

    await pool.request().input("id", sql.Int, row.id)
      .query(`UPDATE e_assessment_exam_sessions SET last_heartbeat = GETDATE() WHERE id = @id`);
    res.json({ locked: false, ended: false });
  } catch (err) {
    console.error("HEARTBEAT ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Called on submit / time-up to close out the session cleanly
const endExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "token is required" });

    await pool.request().input("token", sql.Char(6), token).query(`
      UPDATE e_assessment_exam_sessions SET status = 'ended', ended_at = GETDATE() WHERE token = @token
    `);
    res.json({ success: true });
  } catch (err) {
    console.error("END EXAM SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

// Admin: list locked/active sessions so a genuinely-affected student can be freed
const getExamSessions = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT es.*, st.name AS student_name, a.title AS assessment_title
      FROM e_assessment_exam_sessions es
      LEFT JOIN Students st ON st.id = es.student_id
      LEFT JOIN e_assessments a ON a.id = es.e_assessment_id
      WHERE es.status IN ('locked','active','issued')
      ORDER BY es.status DESC, es.issued_at DESC
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error("GET EXAM SESSIONS ERROR:", err);
    res.status(500).json([]);
  }
};

// Admin: unlock — clears device binding so the student can resume on a chosen device
const unlockExamSession = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    await pool.request().input("id", sql.Int, id).query(`
      UPDATE e_assessment_exam_sessions
      SET status = 'issued', device_id = NULL, device_label = NULL,
          locked_at = NULL, lock_reason = NULL
      WHERE id = @id
    `);
    res.json({ success: true, message: "Session unlocked" });
  } catch (err) {
    console.error("UNLOCK EXAM SESSION ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   STUDENT — SUBMIT / RESULT
========================================================================= */
const submitEAssessment = async (req, res) => {
  const pool = req.pool;
  const transaction = new sql.Transaction(pool);
  try {
    const { assessment_id, answers, token, device_id } = req.body;
    const student_id = req.user?.id;

    if (!assessment_id || !Array.isArray(answers)) {
      return res.status(400).json({ success: false, message: "Invalid submission payload" });
    }
    if (!student_id) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (req.user?.examOnly && req.user.examAssessmentId !== toInt(assessment_id)) {
      return res.status(403).json({ success: false, message: "This exam session isn't valid for this assessment" });
    }

    // Validate the exam session token/device before accepting the submission
    if (token) {
      const sessionCheck = await pool.request()
        .input("token", sql.Char(6), token)
        .query(`SELECT * FROM e_assessment_exam_sessions WHERE token = @token`);
      const session = sessionCheck.recordset[0];
      if (session) {
        if (session.status === "locked") {
          return res.status(423).json({ success: false, message: "Exam session is locked. Submission rejected." });
        }
        if (session.device_id && device_id && session.device_id !== device_id) {
          return res.status(423).json({ success: false, message: "Device mismatch. Submission rejected." });
        }
      }
    }

    await transaction.begin();

    const existing = await new sql.Request(transaction)
      .input("assessment_id", sql.Int, Number(assessment_id))
      .input("student_id", sql.Int, Number(student_id))
      .query(`SELECT id FROM e_assessment_submissions WHERE e_assessment_id = @assessment_id AND student_id = @student_id`);

    if (existing.recordset.length > 0) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        message: "You have already submitted this assessment",
        submission_id: existing.recordset[0].id,
      });
    }

    const submissionResult = await new sql.Request(transaction)
      .input("e_assessment_id", sql.Int, Number(assessment_id))
      .input("student_id", sql.Int, Number(student_id))
      .query(`
        INSERT INTO e_assessment_submissions (e_assessment_id, student_id, submitted_at, status)
        OUTPUT INSERTED.id
        VALUES (@e_assessment_id, @student_id, GETDATE(), 'submitted')
      `);
    const submissionId = submissionResult.recordset[0].id;
// Pull each question's correct answer & marks once, so we can auto-mark MCQs as they're inserted
const questionRows = await new sql.Request(transaction)
  .input("assessment_id", sql.Int, Number(assessment_id))
  .query(`SELECT id, correct_answer, marks, question_type FROM e_assessment_questions WHERE e_assessment_id = @assessment_id`);
const questionMap = {};
questionRows.recordset.forEach((q) => { questionMap[q.id] = q; });
const hasEssay = questionRows.recordset.some((q) => q.question_type === "essay");
    for (const ans of answers) {
  if (!ans.question_id) continue;
  const isEssay = typeof ans.essay_answer !== "undefined";
  const q = questionMap[ans.question_id];

  let isCorrect = null;
  let marksAwarded = null;
  if (!isEssay && q) {
    const selected = (ans.selected_option || "").toString().trim().toLowerCase();
    const correct  = (q.correct_answer || "").toString().trim().toLowerCase();
    isCorrect = selected.length > 0 && selected === correct;
    marksAwarded = isCorrect ? (q.marks || 0) : 0;
  }

  await new sql.Request(transaction)
    .input("submission_id", sql.Int, submissionId)
    .input("question_id", sql.Int, Number(ans.question_id))
    .input("selected_answer", sql.NVarChar(sql.MAX), isEssay ? null : (ans.selected_option || null))
    .input("essay_answer", sql.NVarChar(sql.MAX), isEssay ? (ans.essay_answer || "") : null)
    .input("is_correct", sql.Bit, isCorrect == null ? null : (isCorrect ? 1 : 0))
    .input("marks_awarded", sql.Int, marksAwarded)
    .query(`
      INSERT INTO e_assessment_answers
        (submission_id, question_id, selected_answer, essay_answer, is_correct, marks_awarded)
      VALUES
        (@submission_id, @question_id, @selected_answer, @essay_answer, @is_correct, @marks_awarded)
    `);
}

// Pure-MCQ assessments need no teacher marking at all — finalize immediately
if (!hasEssay) {
  const mcqTotal = await new sql.Request(transaction)
    .input("submission_id", sql.Int, submissionId)
    .query(`SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`);

  await new sql.Request(transaction)
    .input("submission_id", sql.Int, submissionId)
    .input("score", sql.Int, mcqTotal.recordset[0].total)
    .query(`UPDATE e_assessment_submissions SET score = @score, status = 'marked', remark_completed = 1 WHERE id = @submission_id`);
}

    await transaction.commit();

    if (token) {
      await pool.request().input("token", sql.Char(6), token)
        .query(`UPDATE e_assessment_exam_sessions SET status = 'ended', ended_at = GETDATE() WHERE token = @token`);
    }

    return res.status(201).json({ success: true, submission_id: submissionId, message: "Assessment submitted successfully" });
  } catch (err) {
    console.error("SUBMIT ERROR:", err);
    try { await transaction.rollback(); } catch (_) {}
    return res.status(500).json({ success: false, message: "Submission failed", error: err.message });
  }
};

const getStudentResult = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);
    const studentId = req.user?.id;

    if (req.user?.examOnly && req.user.examAssessmentId !== assessmentId) {
      return res.status(403).json({ message: "This exam session isn't valid for this assessment" });
    }

    const result = await pool.request()
      .input("assessmentId", sql.Int, assessmentId)
      .input("studentId", sql.Int, studentId)
      .query(`
        SELECT * FROM e_assessment_submissions
        WHERE e_assessment_id = @assessmentId AND student_id = @studentId
      `);
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error("GET RESULT ERROR:", err);
    res.status(500).json(null);
  }
};

/* =========================================================================
   ADMIN — REVIEW / TOGGLE / STATS
========================================================================= */
const getPendingAssessments = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT ea.*, t.name AS teacher_name, c.name AS class_name
      FROM e_assessments ea
      LEFT JOIN Teachers t ON ea.teacher_id = t.id
      LEFT JOIN Classes c ON ea.class_id = c.id
      WHERE ea.status = 'pending'
      ORDER BY ea.id DESC
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error("GET PENDING ERROR:", err);
    res.status(500).json([]);
  }
};

const reviewAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.id);
    const { status, admin_comment } = req.body;
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ message: "Invalid status" });

    await pool.request()
      .input("id", sql.Int, assessmentId)
      .input("status", sql.NVarChar, status)
      .input("admin_comment", sql.NVarChar, admin_comment || "")
      .query(`UPDATE e_assessments SET status = @status, admin_comment = @admin_comment WHERE id = @id`);

    res.json({ success: true, message: `Assessment ${status}` });
  } catch (err) {
    console.error("REVIEW ERROR:", err);
    res.status(500).json({ message: "Review failed" });
  }
};

const toggleEAssessmentActive = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const current = await pool.request().input("id", sql.Int, id)
      .query(`SELECT active_status FROM e_assessments WHERE id = @id`);
    if (!current.recordset.length) return res.status(404).json({ message: "Assessment not found" });

    const next = current.recordset[0].active_status === "Active" ? "Inactive" : "Active";
    await pool.request().input("id", sql.Int, id).input("active_status", sql.NVarChar(20), next)
      .query(`UPDATE e_assessments SET active_status = @active_status WHERE id = @id`);

    res.json({ success: true, active_status: next });
  } catch (err) {
    console.error("TOGGLE ACTIVE ERROR:", err);
    res.status(500).json({ message: "Toggle failed" });
  }
};

const getEAssessmentQuickStats = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);

    const result = await pool.request().input("id", sql.Int, id).query(`
      SELECT
        COUNT(*) AS submitted_count,
        SUM(CASE WHEN status = 'marked' OR score IS NOT NULL THEN 1 ELSE 0 END) AS marked_count,
        SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END) AS released_count,
        SUM(CASE WHEN remark_requested = 1 THEN 1 ELSE 0 END) AS remark_count,
        AVG(CAST(score AS FLOAT)) AS average_score,
        MAX(score) AS highest_score,
        MIN(score) AS lowest_score
      FROM e_assessment_submissions
      WHERE e_assessment_id = @id
    `);
    const row = result.recordset[0] || {};

    res.json({
      submitted_count: row.submitted_count || 0,
      marked_count: row.marked_count || 0,
      released_count: row.released_count || 0,
      remark_count: row.remark_count || 0,
      average_score: row.average_score != null ? Math.round(row.average_score) : null,
      highest_score: row.highest_score,
      lowest_score: row.lowest_score,
    });
  } catch (err) {
    console.error("QUICK STATS ERROR:", err);
    res.status(500).json({ message: "Failed to get stats" });
  }
};

/* =========================================================================
   CLASSES / SUBJECTS / TEACHERS
========================================================================= */
const getClasses = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name FROM Classes ORDER BY name ASC`);
    res.json(result.recordset.map((c) => ({ id: c.id, name: c.name, class_id: c.id, class_name: c.name })));
  } catch (err) {
    console.error("GET CLASSES ERROR:", err);
    res.status(500).json([]);
  }
};

const getSubjects = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name FROM Subjects ORDER BY name ASC`);
    res.json(result.recordset.map((s) => ({ id: s.id, name: s.name, subject_name: s.name })));
  } catch (err) {
    console.error("GET SUBJECTS ERROR:", err);
    res.status(500).json([]);
  }
};

const getTeachers = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`SELECT id, name, email, subject, staffId FROM Teachers ORDER BY name ASC`);
    res.json(result.recordset);
  } catch (err) {
    console.error("GET TEACHERS ERROR:", err);
    res.status(500).json([]);
  }
};

const assignTeacher = async (req, res) => {
  try {
    const pool = req.pool;
    const { teacher_id, subject_id, class_id } = req.body;
    if (!teacher_id || !subject_id || !class_id) return res.status(400).json({ message: "Missing fields" });

    const exists = await pool.request()
      .input("teacher_id", sql.Int, teacher_id).input("subject_id", sql.Int, subject_id).input("class_id", sql.Int, class_id)
      .query(`SELECT id FROM TeacherSubjects WHERE teacher_id = @teacher_id AND subject_id = @subject_id AND class_id = @class_id`);
    if (exists.recordset.length > 0) return res.status(400).json({ message: "Teacher already assigned" });

    await pool.request()
      .input("teacher_id", sql.Int, teacher_id).input("subject_id", sql.Int, subject_id).input("class_id", sql.Int, class_id)
      .query(`INSERT INTO TeacherSubjects (teacher_id, subject_id, class_id) VALUES (@teacher_id, @subject_id, @class_id)`);

    res.json({ success: true, message: "Teacher assigned successfully" });
  } catch (err) {
    console.error("ASSIGN TEACHER ERROR:", err);
    res.status(500).json({ message: "Assignment failed" });
  }
};

const getAssignedTeachers = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT ts.id, ts.teacher_id, t.name AS teacher_name, t.email, t.staffId,
             ts.subject_id, s.name AS subject_name, ts.class_id, c.name AS class_name
      FROM TeacherSubjects ts
      LEFT JOIN Teachers t ON ts.teacher_id = t.id
      LEFT JOIN Subjects s ON ts.subject_id = s.id
      LEFT JOIN Classes c ON ts.class_id = c.id
      ORDER BY t.name ASC, c.name ASC
    `);
    res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    console.error("GET ASSIGNED TEACHERS ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to fetch assigned teachers" });
  }
};

const deleteAssignments = async (req, res) => {
  try {
    const pool = req.pool;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No ids provided" });

    for (const id of ids) {
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM TeacherSubjects WHERE id = @id`);
    }
    res.json({ success: true, message: "Assignments deleted" });
  } catch (err) {
    console.error("DELETE ASSIGNMENTS ERROR:", err);
    res.status(500).json({ message: "Delete failed" });
  }
};

/* =========================================================================
   DELETE ASSESSMENTS
========================================================================= */
const deleteAssessments = async (req, res) => {
  try {
    const pool = req.pool;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, message: "No assessments selected" });

    for (const id of ids) {
      await pool.request().input("id", sql.Int, id).query(`
        DELETE o FROM e_assessment_options o
        INNER JOIN e_assessment_questions q ON o.question_id = q.id
        WHERE q.e_assessment_id = @id
      `);
      await pool.request().input("id", sql.Int, id).query(`
        DELETE a FROM e_assessment_answers a
        INNER JOIN e_assessment_submissions s ON a.submission_id = s.id
        WHERE s.e_assessment_id = @id
      `);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_submissions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_questions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessment_exam_sessions WHERE e_assessment_id = @id`);
      await pool.request().input("id", sql.Int, id).query(`DELETE FROM e_assessments WHERE id = @id`);
    }

    res.json({ success: true, message: "Assessments deleted successfully" });
  } catch (err) {
    console.error("DELETE ASSESSMENTS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* =========================================================================
   SUBMISSIONS / MARKING / ASSIGNMENT
========================================================================= */
const getAllSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT
  s.id, s.e_assessment_id, s.student_id, s.submitted_at, s.status, s.score,
  s.remark_requested, s.remark_status, s.remark_reason, s.admin_comment, s.released_at,
  a.title AS assessment_title, a.subject AS subject_name, a.total_marks AS total_marks,
  st.name AS student_name,
  aa.teacher_id AS assigned_teacher_id, t.name AS assigned_teacher_name
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
LEFT JOIN Students st ON st.id = s.student_id
LEFT JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id
LEFT JOIN Teachers t ON t.id = aa.teacher_id
ORDER BY s.submitted_at DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("GET ALL SUBMISSIONS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch submissions" });
  }
};

const getAssessmentSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const assessmentId = toInt(req.params.assessmentId);

    // Only show a teacher the submissions that were actually distributed
    // to THEM (e_assessment_submission_assignments.teacher_id). Without
    // this join/filter, every teacher saw every submission for the
    // assessment regardless of who admin assigned it to.
    const isTeacher = req.user?.role === "teacher";

    const request = pool.request().input("assessmentId", sql.Int, assessmentId);
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT
        s.id,
        s.e_assessment_id,
        s.student_id,
        s.submitted_at,
        s.status,
        s.score,
        s.remark_requested,
        s.remark_status,
        s.remark_reason,
        s.admin_comment,
        a.total_marks AS total_marks,
        st.name AS student_name
      FROM e_assessment_submissions s
      LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
      LEFT JOIN Students st ON st.id = s.student_id
      ${isTeacher ? "INNER JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id AND aa.teacher_id = @teacherId" : ""}
      WHERE s.e_assessment_id = @assessmentId
      ORDER BY s.id DESC
    `);
    res.json({ success: true, submissions: result.recordset });
  } catch (err) {
    console.error("GET SUBMISSIONS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const getSubmissionForMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const submissionId = toInt(req.params.id);

    // Direct-by-ID lookup, so it needs its own ownership check: a teacher
    // must not be able to open a submission just by guessing/typing its
    // id if it wasn't distributed to them.
    if (req.user?.role === "teacher") {
      const owns = await pool.request()
        .input("id", sql.Int, submissionId)
        .input("teacherId", sql.Int, toInt(req.user.id))
        .query(`SELECT id FROM e_assessment_submission_assignments WHERE submission_id = @id AND teacher_id = @teacherId`);
      if (!owns.recordset.length) {
        return res.status(403).json({ message: "This submission was not assigned to you." });
      }
    }

    const submission = await pool.request().input("id", sql.Int, submissionId)
      .query(`SELECT * FROM e_assessment_submissions WHERE id = @id`);

    const answers = await pool.request().input("id", sql.Int, submissionId).query(`
      SELECT a.id, a.question_id, a.selected_answer, a.essay_answer, a.is_correct, a.marks_awarded,
             q.question_text, q.correct_answer, q.marks AS max_marks, q.question_type
      FROM e_assessment_answers a
      INNER JOIN e_assessment_questions q ON q.id = a.question_id
      WHERE a.submission_id = @id
      ORDER BY q.id
    `);

    res.json({ submission: submission.recordset[0] || {}, answers: answers.recordset || [] });
  } catch (err) {
    console.error("MARKING FETCH ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const getAllSubmissionsForMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const e_assessmentId = toInt(req.params.id);
    if (!e_assessmentId) return res.status(400).json({ success: false, message: "Invalid e_assessment ID" });

    // Same fix as getAssessmentSubmissions: a teacher can only mark the
    // submissions that were distributed to them, not every submission for
    // the assessment. Admin/sub_admin (who don't hit this teacher-only
    // route in practice) fall back to the unfiltered query.
    const isTeacher = req.user?.role === "teacher";
    const request = pool.request().input("e_assessmentId", sql.Int, e_assessmentId);
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const submissionsResult = await request.query(`
      SELECT s.*
      FROM e_assessment_submissions s
      ${isTeacher ? "INNER JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id AND aa.teacher_id = @teacherId" : ""}
      WHERE s.e_assessment_id = @e_assessmentId
    `);
    const submissions = submissionsResult.recordset;
    if (!submissions.length) return res.status(200).json([]);

    const finalData = [];
    for (const submission of submissions) {
      const answersResult = await pool.request().input("submissionId", sql.Int, submission.id).query(`
        SELECT a.id, a.submission_id, a.question_id, a.essay_answer, a.marks_awarded,
       q.question_text, q.question_type, q.marks AS max_marks, q.marking_guide
FROM e_assessment_answers a
INNER JOIN e_assessment_questions q ON a.question_id = q.id
WHERE a.submission_id = @submissionId
      `);
      finalData.push({ submission, answers: answersResult.recordset });
    }
    res.status(200).json(finalData);
  } catch (err) {
    console.error("GET ALL SUBMISSIONS FOR MARKING ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const saveMarking = async (req, res) => {
  try {
    const pool = req.pool;
    const { scores, remarks } = req.body;
    if (!scores || typeof scores !== "object" || !Object.keys(scores).length) {
      return res.status(400).json({ success: false, message: "No scores provided" });
    }

    const answerIds = Object.keys(scores).map(Number).filter((n) => !isNaN(n));
    if (!answerIds.length) return res.status(400).json({ success: false, message: "No valid answer ids provided" });

    for (const answerId of answerIds) {
      const mark = Number(scores[answerId]) || 0;
      await pool.request()
        .input("answerId", sql.Int, answerId)
        .input("mark", sql.Int, mark)
        .input("remarks", sql.NVarChar(sql.MAX), remarks?.[answerId] || "")
        .query(`UPDATE e_assessment_answers SET marks_awarded = @mark, remarks = @remarks WHERE id = @answerId`);
    }

    const idList = answerIds.join(",");
    const subLookup = await pool.request().query(`
      SELECT DISTINCT submission_id FROM e_assessment_answers WHERE id IN (${idList})
    `);
    const submissionIds = subLookup.recordset.map((r) => r.submission_id);

    const results = [];
    for (const submissionId of submissionIds) {
      const totalResult = await pool.request()
        .input("submission_id", sql.Int, submissionId)
        .query(`SELECT ISNULL(SUM(marks_awarded), 0) AS total FROM e_assessment_answers WHERE submission_id = @submission_id`);
      const totalScore = totalResult.recordset[0].total;

      const unmarkedEssays = await pool.request()
        .input("submission_id", sql.Int, submissionId)
        .query(`
          SELECT COUNT(*) AS cnt
          FROM e_assessment_answers a
          INNER JOIN e_assessment_questions q ON q.id = a.question_id
          WHERE a.submission_id = @submission_id AND q.question_type = 'essay' AND a.marks_awarded IS NULL
        `);
      const isFullyMarked = unmarkedEssays.recordset[0].cnt === 0;

      if (isFullyMarked) {
        await pool.request()
          .input("submission_id", sql.Int, submissionId).input("score", sql.Int, totalScore)
          .query(`
            UPDATE e_assessment_submissions
            SET score = @score, status = 'marked', remark_completed = 1, remark_requested = 0, remark_status = 'completed'
            WHERE id = @submission_id
          `);
      } else {
        await pool.request()
          .input("submission_id", sql.Int, submissionId).input("score", sql.Int, totalScore)
          .query(`UPDATE e_assessment_submissions SET score = @score WHERE id = @submission_id`);
      }
      results.push({ submission_id: submissionId, total_score: totalScore, fully_marked: isFullyMarked });
    }

    res.json({ success: true, results, message: "Marked successfully" });
  } catch (err) {
    console.error("SAVE MARKING ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const saveMarkingBulk = saveMarking; // same shape/body contract — kept as distinct route name for the frontend

const assignSubmission = async (req, res) => {
  try {
    const pool = req.pool;
    const { submissionId, teacherId } = req.body;
    if (!submissionId || !teacherId) return res.status(400).json({ success: false, message: "submissionId and teacherId are required" });

    const existing = await pool.request().input("submissionId", sql.Int, submissionId)
      .query(`SELECT id FROM e_assessment_submission_assignments WHERE submission_id = @submissionId`);

    if (existing.recordset.length > 0) {
      await pool.request().input("submissionId", sql.Int, submissionId).input("teacherId", sql.Int, teacherId).query(`
        UPDATE e_assessment_submission_assignments SET teacher_id = @teacherId, assigned_at = GETDATE()
        WHERE submission_id = @submissionId
      `);
    } else {
      await pool.request().input("submissionId", sql.Int, submissionId).input("teacherId", sql.Int, teacherId).query(`
        INSERT INTO e_assessment_submission_assignments (submission_id, teacher_id, assigned_at)
        VALUES (@submissionId, @teacherId, GETDATE())
      `);
    }
    res.json({ success: true, message: "Submission assigned successfully" });
  } catch (err) {
    console.error("ASSIGN SUBMISSION ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const bulkAssignSubmissions = async (req, res) => {
  try {
    const pool = req.pool;
    const { submission_ids, teacher_ids } = req.body;
    if (!Array.isArray(submission_ids) || !submission_ids.length) return res.status(400).json({ message: "No submissions provided" });
    if (!Array.isArray(teacher_ids) || !teacher_ids.length) return res.status(400).json({ message: "No teachers provided" });

    let i = 0;
    for (const submissionId of submission_ids) {
      const teacherId = teacher_ids[i % teacher_ids.length];
      const existing = await pool.request().input("submissionId", sql.Int, submissionId)
        .query(`SELECT id FROM e_assessment_submission_assignments WHERE submission_id = @submissionId`);

      if (existing.recordset.length > 0) {
        await pool.request().input("submissionId", sql.Int, submissionId).input("teacherId", sql.Int, teacherId).query(`
          UPDATE e_assessment_submission_assignments SET teacher_id = @teacherId, assigned_at = GETDATE()
          WHERE submission_id = @submissionId
        `);
      } else {
        await pool.request().input("submissionId", sql.Int, submissionId).input("teacherId", sql.Int, teacherId).query(`
          INSERT INTO e_assessment_submission_assignments (submission_id, teacher_id, assigned_at)
          VALUES (@submissionId, @teacherId, GETDATE())
        `);
      }
      i++;
    }
    res.json({ success: true, message: `${submission_ids.length} submission(s) distributed across ${teacher_ids.length} teacher(s)` });
  } catch (err) {
    console.error("BULK ASSIGN ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const getNextSubmissionForMarking = async (req, res) => {
  try {
    const pool = req.pool;

    // Same distribution rule: a teacher can only be handed a submission
    // that was actually assigned to them, never one assigned to (or
    // unassigned and belonging to) another teacher.
    const isTeacher = req.user?.role === "teacher";
    const request = pool.request();
    if (isTeacher) request.input("teacherId", sql.Int, toInt(req.user.id));

    const result = await request.query(`
      SELECT TOP 1 s.*
      FROM e_assessment_submissions s
      ${isTeacher ? "INNER JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id AND aa.teacher_id = @teacherId" : ""}
      WHERE s.status = 'submitted'
      ORDER BY NEWID()
    `);
    res.json(result.recordset[0] || null);
  } catch (err) {
    console.error("GET NEXT FOR MARKING ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   REMARK REQUESTS
========================================================================= */
const requestRemark = async (req, res) => {
  try {
    const pool = req.pool;
    const submission_id = toInt(req.params.id);
    const { reason } = req.body;

    await pool.request().input("submission_id", sql.Int, submission_id).input("reason", sql.NVarChar(sql.MAX), reason || "").query(`
      UPDATE e_assessment_submissions
      SET remark_requested = 1, remark_reason = @reason, remark_status = 'pending'
      WHERE id = @submission_id
    `);

    res.status(201).json({ success: true, message: "Remark request created successfully" });
  } catch (err) {
    console.error("CREATE REMARK ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

const getRemarkRequests = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT s.*, a.title AS assessment_title, a.subject AS subject_name, st.name AS student_name,
             aa.teacher_id AS assigned_teacher_id, t.name AS teacher_name
      FROM e_assessment_submissions s
      LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
      LEFT JOIN Students st ON st.id = s.student_id
      LEFT JOIN e_assessment_submission_assignments aa ON aa.submission_id = s.id
      LEFT JOIN Teachers t ON t.id = aa.teacher_id
      WHERE s.remark_requested = 1 OR s.remark_status IS NOT NULL
      ORDER BY s.submitted_at DESC
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error("GET REMARK REQUESTS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch remark requests", error: err.message });
  }
};

const reviewRemarkRequest = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    const { status, admin_comment } = req.body;

    const validStatuses = ["approved", "rejected", "revision", "pending"];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: "Invalid status" });

    await pool.request()
      .input("id", sql.Int, id).input("status", sql.NVarChar(50), status)
      .input("admin_comment", sql.NVarChar(sql.MAX), admin_comment || "").query(`
        UPDATE e_assessment_submissions
        SET remark_status = @status, admin_comment = @admin_comment,
            remark_requested = CASE WHEN @status = 'pending' THEN 1 ELSE 0 END,
            reviewed_at = GETDATE()
        WHERE id = @id
      `);

    res.json({ success: true, message: `Remark request ${status}` });
  } catch (err) {
    console.error("REVIEW REMARK ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   RELEASE MARKS
========================================================================= */
const getReleasedMarks = async (req, res) => {
  try {
    const pool = req.pool;
    const result = await pool.request().query(`
      SELECT s.*, a.title AS assessment_title, a.subject AS subject_name, a.total_marks AS total_marks,
       st.name AS student_name
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
LEFT JOIN Students st ON st.id = s.student_id
WHERE s.status = 'released'
ORDER BY s.released_at DESC
    `);
    res.status(200).json(result.recordset);
  } catch (err) {
    console.error("GET RELEASED MARKS ERROR:", err);
    res.status(500).json({ message: "Failed to fetch released marks", error: err.message });
  }
};

const releaseMarks = async (req, res) => {
  const pool = req.pool;
  const transaction = new sql.Transaction(pool);
  try {
    const { submission_id } = req.body;
    if (!submission_id) return res.status(400).json({ message: "submission_id is required" });

    await transaction.begin();

    const subResult = await new sql.Request(transaction).input("id", sql.Int, submission_id).query(`
      SELECT s.id, s.student_id, s.score, ISNULL(a.total_marks, 100) AS total_marks, s.status,
       a.id AS assessment_id, a.subject, a.title
FROM e_assessment_submissions s
LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
WHERE s.id = @id
    `);

    if (!subResult.recordset.length) { await transaction.rollback(); return res.status(404).json({ message: "Submission not found" }); }
    const sub = subResult.recordset[0];
    if (sub.status === "released") { await transaction.rollback(); return res.status(400).json({ message: "Marks already released" }); }
    if (sub.score == null) { await transaction.rollback(); return res.status(400).json({ message: "Submission has not been marked yet" }); }

    const percentage = sub.total_marks ? (sub.score / sub.total_marks) * 100 : null;

    // e_assessments stores the subject as text, Marks needs the subject's id — look it up
    const subjectLookup = await new sql.Request(transaction)
      .input("subjectName", sql.NVarChar, sub.subject || "")
      .query(`SELECT TOP 1 id FROM Subjects WHERE name = @subjectName`);
    const subjectId = subjectLookup.recordset[0]?.id || null;

    await new sql.Request(transaction)
      .input("studentId", sql.Int, sub.student_id)
      .input("subjectId", sql.Int, subjectId)
      .input("assessmentId", sql.Int, sub.assessment_id)
      .input("score", sql.Int, sub.score)
      .input("percentage", sql.Float, percentage)
      .query(`
        INSERT INTO Marks (studentId, subjectId, assessmentId, score, percentage, createdAt)
        VALUES (@studentId, @subjectId, @assessmentId, @score, @percentage, GETDATE())
      `);

    await new sql.Request(transaction).input("id", sql.Int, submission_id).query(`
      UPDATE e_assessment_submissions SET status = 'released', released_at = GETDATE() WHERE id = @id
    `);

    await transaction.commit();
    res.json({ success: true, message: "Marks released successfully" });
  } catch (err) {
    console.error("RELEASE MARKS ERROR:", err);
    try { await transaction.rollback(); } catch (_) {}
    res.status(500).json({ message: err.message });
  }
};

const bulkReleaseMarks = async (req, res) => {
  const pool = req.pool;
  try {
    const { submission_ids } = req.body;
    if (!Array.isArray(submission_ids) || !submission_ids.length) return res.status(400).json({ message: "No submissions provided" });

    let released = 0;
    for (const id of submission_ids) {
      const transaction = new sql.Transaction(pool);
      try {
        await transaction.begin();
        const subResult = await new sql.Request(transaction).input("id", sql.Int, id).query(`
  SELECT s.id, s.student_id, s.score, ISNULL(a.total_marks, 100) AS total_marks, s.status,
         a.id AS assessment_id, a.subject, a.title
  FROM e_assessment_submissions s
  LEFT JOIN e_assessments a ON a.id = s.e_assessment_id
  WHERE s.id = @id
`);
        const sub = subResult.recordset[0];
        if (!sub || sub.status === "released" || sub.score == null) { await transaction.rollback(); continue; }

        const percentage = sub.total_marks ? (sub.score / sub.total_marks) * 100 : null;

        // e_assessments stores the subject as text, Marks needs the subject's id — look it up
        const subjectLookup = await new sql.Request(transaction)
          .input("subjectName", sql.NVarChar, sub.subject || "")
          .query(`SELECT TOP 1 id FROM Subjects WHERE name = @subjectName`);
        const subjectId = subjectLookup.recordset[0]?.id || null;

        await new sql.Request(transaction)
          .input("studentId", sql.Int, sub.student_id)
          .input("subjectId", sql.Int, subjectId)
          .input("assessmentId", sql.Int, sub.assessment_id)
          .input("score", sql.Int, sub.score)
          .input("percentage", sql.Float, percentage)
          .query(`
            INSERT INTO Marks (studentId, subjectId, assessmentId, score, percentage, createdAt)
            VALUES (@studentId, @subjectId, @assessmentId, @score, @percentage, GETDATE())
          `);

        await new sql.Request(transaction).input("id", sql.Int, id).query(`
          UPDATE e_assessment_submissions SET status = 'released', released_at = GETDATE() WHERE id = @id
        `);
        await transaction.commit();
        released++;
      } catch (innerErr) {
        try { await transaction.rollback(); } catch (_) {}
        console.error("BULK RELEASE ITEM ERROR:", innerErr);
      }
    }
    res.json({ success: true, released_count: released });
  } catch (err) {
    console.error("BULK RELEASE MARKS ERROR:", err);
    res.status(500).json({ message: err.message });
  }
};

/* =========================================================================
   EXPORTS (single source of truth — no other module.exports in this file)
========================================================================= */
module.exports = {
  // core
  createEAssessment, updateEAssessment, getEAssessments, getEAssessmentById,
  addEAssessmentQuestion, getAssessmentQuestions, updateQuestion, deleteQuestion,

  // standalone exam-password login (no portal account session)
  examLogin,

  // exam session / device lock
  startExamSession, activateExamSession, heartbeatExamSession, endExamSession,
  getExamSessions, unlockExamSession,

  // student
  submitEAssessment, getStudentResult,

  // admin review / stats
  getPendingAssessments, reviewAssessment, toggleEAssessmentActive, getEAssessmentQuickStats,
  deleteAssessments, deleteAssignments,

  // support data
  getClasses, getSubjects, getTeachers, assignTeacher, getAssignedTeachers,

  // submissions / marking
  getAllSubmissions, getAssessmentSubmissions, getSubmissionForMarking, getAllSubmissionsForMarking,
  saveMarking, saveMarkingBulk, assignSubmission, bulkAssignSubmissions, getNextSubmissionForMarking,

  // remarks
  requestRemark, getRemarkRequests, reviewRemarkRequest,

  // release
  getReleasedMarks, releaseMarks, bulkReleaseMarks,
};