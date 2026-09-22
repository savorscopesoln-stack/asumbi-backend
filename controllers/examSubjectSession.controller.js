const sql = require("mssql");
const { logExamAudit } = require("../utils/examAuditLog");

/* =========================================================================
   SUBJECT / LEARNING AREA SCHEDULING (§4-§6 of the spec)
   Each row here is one examination session (e.g. "Mathematics, 02 Nov
   09:00-11:00") inside a Main Examination. It only ever REFERENCES an
   existing e_assessments row via e_assessment_id (§36) — questions,
   submissions and marking all continue to live entirely inside the
   existing e-assessment engine, untouched.
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// BUGFIX (subject time selection saving 2h off, e.g. typing 7:00 shows
// back as 9:00): the dashboard sends a naive "YYYY-MM-DDTHH:mm:00"
// wall-clock string with NO timezone offset (see combineDateTime in
// MainExaminationDashboard.jsx). Per the ES2015 Date Time String
// Format, a datetime string with no offset is parsed as LOCAL time of
// whatever machine runs the parsing code — i.e. this server's own TZ
// setting, which has nothing to do with the school's timezone. mssql
// then reads that Date back out with its own (default useUTC:true)
// UTC getters when building the value it sends to SQL Server. Those
// two independent, invisible conversions stacking on top of each
// other is exactly what produced the offset. Appending "Z" pins the
// string to be parsed as that literal instant, so the wall-clock
// numbers the admin typed pass through unchanged regardless of this
// server process's TZ — matching how mssql's useUTC:true will read it
// back later (see splitDateTime()'s matching UTC getters on the
// frontend, and fmtTime/fmtDate in shared.jsx).
const toDateTime = (v) => {
  if (!v) return null;
  const s = String(v);
  const isBareDateTime = s.includes("T") && !/Z$|[+-]\d\d:\d\d$/.test(s);
  const d = new Date(isBareDateTime ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Date-only strings ("YYYY-MM-DD") are already spec'd as UTC midnight
// with no ambiguity, so they don't need the "Z" treatment above — kept
// as a separate alias (rather than sharing toDateTime's body) so that
// stays true even if toDateTime's datetime-specific logic changes later.
const toDateOnly = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* Loads the parent Main Examination or null. Used everywhere below so a
   subject session can never be created/edited against a main exam id
   that doesn't exist. */
async function loadMainExam(pool, mainExamId) {
  const result = await pool.request()
    .input("id", sql.Int, mainExamId)
    .query(`SELECT * FROM main_examinations WHERE id = @id`);
  return result.recordset[0] || null;
}

/* =========================================================================
   VALIDATION (§6 — "before saving/publishing the timetable, detect...")
   Returns a plain array of human-readable error strings — empty means
   valid. Deliberately synchronous-looking (awaits inside) so callers can
   just `if (errors.length) return res.status(400)...`.
========================================================================= */
async function validateSessionInput(pool, { mainExam, subject, class_id, exam_date, start_time, end_time, duration_minutes, mainExamId, excludeId }) {
  const errors = [];

  if (!subject || !String(subject).trim()) {
    errors.push("Subject / learning area is required.");
  }

  const hasStart = !!start_time;
  const hasEnd = !!end_time;
  if (hasStart !== hasEnd) {
    errors.push("Both start time and end time are required together.");
  }
  if (hasStart && hasEnd && !(start_time < end_time)) {
    errors.push("End time must be after start time.");
  }
  if (duration_minutes !== null && duration_minutes !== undefined && toInt(duration_minutes) !== null && toInt(duration_minutes) <= 0) {
    errors.push("Duration must be a positive number of minutes.");
  }

  // Scheduling outside the Main Examination's own date range.
  if (exam_date && mainExam?.start_date && exam_date < new Date(mainExam.start_date)) {
    errors.push("Exam date is before the Main Examination's start date.");
  }
  if (exam_date && mainExam?.end_date && exam_date > new Date(mainExam.end_date)) {
    errors.push("Exam date is after the Main Examination's end date.");
  }

  // Duplicate subject scheduling within the same Main Examination.
  if (subject && String(subject).trim()) {
    const dupRequest = pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .input("subject", sql.NVarChar, String(subject).trim());
    let dupQuery = `
      SELECT TOP 1 id FROM exam_subject_sessions
      WHERE main_examination_id = @mainExaminationId
        AND LOWER(LTRIM(RTRIM(subject))) = LOWER(@subject)
    `;
    if (excludeId) {
      dupRequest.input("excludeId", sql.Int, excludeId);
      dupQuery += " AND id <> @excludeId";
    }
    const dup = await dupRequest.query(dupQuery);
    if (dup.recordset[0]) {
      errors.push(`"${subject}" is already scheduled for this Main Examination.`);
    }
  }

  // Overlapping examinations — same Main Examination, same candidate
  // group (class_id), overlapping time ranges. A NULL class_id is
  // treated as "whole cohort" and so is checked for overlap against
  // every other session, since it has no narrower candidate group to
  // distinguish it by.
  if (hasStart && hasEnd) {
    const overlapRequest = pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .input("startTime", sql.DateTime, start_time)
      .input("endTime", sql.DateTime, end_time);
    let overlapQuery = `
      SELECT TOP 1 id, subject FROM exam_subject_sessions
      WHERE main_examination_id = @mainExaminationId
        AND start_time IS NOT NULL AND end_time IS NOT NULL
        AND start_time < @endTime AND end_time > @startTime
    `;
    if (class_id) {
      overlapRequest.input("classId", sql.Int, class_id);
      overlapQuery += " AND (class_id = @classId OR class_id IS NULL)";
    }
    if (excludeId) {
      overlapRequest.input("excludeId", sql.Int, excludeId);
      overlapQuery += " AND id <> @excludeId";
    }
    const overlap = await overlapRequest.query(overlapQuery);
    if (overlap.recordset[0]) {
      errors.push(`Overlaps with "${overlap.recordset[0].subject}", already scheduled at that time.`);
    }
  }

  return errors;
}

/* =========================================================================
   ADD SUBJECT SESSION
========================================================================= */
const addSubjectSession = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Main examination not found" });

    const {
      subject, class_id, e_assessment_id, exam_date, start_time, end_time,
      duration_minutes, venue, max_marks, instructions,
    } = req.body;

    const examDateVal = toDateOnly(exam_date);
    const startVal = toDateTime(start_time);
    const endVal = toDateTime(end_time);

    const errors = await validateSessionInput(pool, {
      mainExam, subject, class_id: toInt(class_id), exam_date: examDateVal,
      start_time: startVal, end_time: endVal, duration_minutes, mainExamId,
    });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const derivedDuration = duration_minutes !== undefined && duration_minutes !== null
      ? toInt(duration_minutes)
      : (startVal && endVal ? Math.round((endVal - startVal) / 60000) : null);

    const result = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .input("eAssessmentId", sql.Int, toInt(e_assessment_id))
      .input("subject", sql.NVarChar, String(subject).trim())
      .input("classId", sql.Int, toInt(class_id))
      .input("examDate", sql.Date, examDateVal)
      .input("startTime", sql.DateTime, startVal)
      .input("endTime", sql.DateTime, endVal)
      .input("durationMinutes", sql.Int, derivedDuration)
      .input("venue", sql.NVarChar, venue || null)
      .input("maxMarks", sql.Int, toInt(max_marks))
      .input("instructions", sql.NVarChar, instructions || null)
      .query(`
        INSERT INTO exam_subject_sessions
          (main_examination_id, e_assessment_id, subject, class_id, exam_date, start_time, end_time, duration_minutes, venue, max_marks, instructions, status)
        OUTPUT INSERTED.id
        VALUES
          (@mainExaminationId, @eAssessmentId, @subject, @classId, @examDate, @startTime, @endTime, @durationMinutes, @venue, @maxMarks, @instructions, 'draft')
      `);

    const id = result.recordset[0].id;

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      examSubjectSessionId: id,
      action: "subject_session_added",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { subject },
    });

    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error("ADD SUBJECT SESSION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error adding subject" });
  }
};

/* =========================================================================
   LIST SUBJECT SESSIONS (also doubles as the raw timetable data — §5)
========================================================================= */
const getSubjectSessions = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const result = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`
        SELECT * FROM exam_subject_sessions
        WHERE main_examination_id = @mainExaminationId
        ORDER BY start_time ASC, exam_date ASC, id ASC
      `);

    res.json({ success: true, subjects: result.recordset });
  } catch (err) {
    console.error("LIST SUBJECT SESSIONS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error fetching subjects" });
  }
};

/* =========================================================================
   GET ONE SUBJECT SESSION
========================================================================= */
const getSubjectSessionById = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });

    const result = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .input("id", sql.Int, id)
      .query(`SELECT * FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mainExaminationId`);

    if (!result.recordset[0]) return res.status(404).json({ success: false, message: "Subject session not found" });
    res.json({ success: true, subject: result.recordset[0] });
  } catch (err) {
    console.error("GET SUBJECT SESSION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error fetching subject" });
  }
};

/* =========================================================================
   UPDATE / EDIT SCHEDULE
   Full validation re-runs on every edit (not just at publish time) so a
   schedule change after publishing can never silently create a conflict.
========================================================================= */
const updateSubjectSession = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Main examination not found" });

    const existing = await pool.request()
      .input("id", sql.Int, id)
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`SELECT * FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mainExaminationId`);
    const current = existing.recordset[0];
    if (!current) return res.status(404).json({ success: false, message: "Subject session not found" });

    // Once a session is live or past, its schedule is frozen — editing a
    // running/finished exam's time window would contradict §8/§9's
    // backend-is-the-source-of-truth rule and could orphan an
    // in-progress student attempt.
    if (["active", "ended", "marking", "completed"].includes(current.status)) {
      return res.status(409).json({ success: false, message: `Cannot edit schedule once a session is ${current.status}.` });
    }

    const body = req.body;
    const subject = body.subject !== undefined ? body.subject : current.subject;
    const classId = body.class_id !== undefined ? toInt(body.class_id) : current.class_id;
    const examDateVal = body.exam_date !== undefined ? toDateOnly(body.exam_date) : current.exam_date;
    const startVal = body.start_time !== undefined ? toDateTime(body.start_time) : current.start_time;
    const endVal = body.end_time !== undefined ? toDateTime(body.end_time) : current.end_time;
    const durationInput = body.duration_minutes !== undefined ? body.duration_minutes : current.duration_minutes;

    const errors = await validateSessionInput(pool, {
      mainExam, subject, class_id: classId, exam_date: examDateVal,
      start_time: startVal, end_time: endVal, duration_minutes: durationInput,
      mainExamId, excludeId: id,
    });
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const derivedDuration = durationInput !== undefined && durationInput !== null
      ? toInt(durationInput)
      : (startVal && endVal ? Math.round((endVal - startVal) / 60000) : null);

    const request = pool.request()
      .input("id", sql.Int, id)
      .input("subject", sql.NVarChar, String(subject).trim())
      .input("classId", sql.Int, classId)
      .input("examDate", sql.Date, examDateVal)
      .input("startTime", sql.DateTime, startVal)
      .input("endTime", sql.DateTime, endVal)
      .input("durationMinutes", sql.Int, derivedDuration)
      .input("venue", sql.NVarChar, body.venue !== undefined ? (body.venue || null) : current.venue)
      .input("maxMarks", sql.Int, body.max_marks !== undefined ? toInt(body.max_marks) : current.max_marks)
      .input("instructions", sql.NVarChar, body.instructions !== undefined ? (body.instructions || null) : current.instructions)
      .input("eAssessmentId", sql.Int, body.e_assessment_id !== undefined ? toInt(body.e_assessment_id) : current.e_assessment_id);

    await request.query(`
      UPDATE exam_subject_sessions SET
        subject = @subject, class_id = @classId, exam_date = @examDate,
        start_time = @startTime, end_time = @endTime, duration_minutes = @durationMinutes,
        venue = @venue, max_marks = @maxMarks, instructions = @instructions,
        e_assessment_id = @eAssessmentId, updatedAt = GETDATE()
      WHERE id = @id
    `);

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      examSubjectSessionId: id,
      action: "subject_session_schedule_updated",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: req.body,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE SUBJECT SESSION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error updating subject" });
  }
};

/* =========================================================================
   ATTACH / REPLACE ASSESSMENT
   Split out from the general update above so the frontend's "Assign
   Assessment" action (§41) can be a single lightweight call — and so it
   still works even once the schedule itself is frozen (a completed
   exam's assessment reference shouldn't need to go through the
   active/ended edit-lock above).
========================================================================= */
const attachAssessment = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    const eAssessmentId = toInt(req.body.e_assessment_id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });
    if (!eAssessmentId) return res.status(400).json({ success: false, message: "e_assessment_id is required" });

    // Phase 6 — must reference a real, existing assessment that has
    // cleared the EXISTING approval workflow (§14: "approval workflow
    // where applicable" is preserved, not bypassed by going through a
    // Main Examination instead). Pending/rejected assessments can still
    // be attached to a *draft* subject session while questions are being
    // built, but not once that would let the scheduler auto-activate an
    // unapproved exam.
    const assessment = await pool.request()
      .input("id", sql.Int, eAssessmentId)
      .query(`SELECT id, status, title FROM e_assessments WHERE id = @id`);
    if (!assessment.recordset[0]) {
      return res.status(404).json({ success: false, message: "Assessment not found" });
    }

    // One e_assessment can't be the live paper for two subject sessions
    // at once — the scheduler flips its single active_status column, so
    // two sessions sharing it would fight over that one switch.
    const alreadyUsed = await pool.request()
      .input("eAssessmentId", sql.Int, eAssessmentId)
      .input("excludeId", sql.Int, id)
      .query(`
        SELECT TOP 1 id, main_examination_id FROM exam_subject_sessions
        WHERE e_assessment_id = @eAssessmentId AND id <> @excludeId
      `);
    if (alreadyUsed.recordset[0]) {
      return res.status(409).json({
        success: false,
        message: "This assessment is already attached to another subject session.",
      });
    }

    const result = await pool.request()
      .input("id", sql.Int, id)
      .input("mainExaminationId", sql.Int, mainExamId)
      .input("eAssessmentId", sql.Int, eAssessmentId)
      .query(`
        UPDATE exam_subject_sessions SET e_assessment_id = @eAssessmentId, updatedAt = GETDATE()
        OUTPUT INSERTED.id
        WHERE id = @id AND main_examination_id = @mainExaminationId
      `);

    if (!result.recordset[0]) return res.status(404).json({ success: false, message: "Subject session not found" });

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      examSubjectSessionId: id,
      action: "assessment_attached",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { e_assessment_id: eAssessmentId },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("ATTACH ASSESSMENT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error attaching assessment" });
  }
};

/* =========================================================================
   REMOVE SUBJECT SESSION (safely — §41)
   Blocked once the session is live/past, same reasoning as the edit-lock
   above — never delete out from under a running or finished exam.
========================================================================= */
const deleteSubjectSession = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    const id = toInt(req.params.id);
    if (!mainExamId || !id) return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await pool.request()
      .input("id", sql.Int, id)
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`SELECT status, subject FROM exam_subject_sessions WHERE id = @id AND main_examination_id = @mainExaminationId`);
    const current = existing.recordset[0];
    if (!current) return res.status(404).json({ success: false, message: "Subject session not found" });

    // Only a session that's actually LIVE right now is protected — removing
    // it mid-sitting would pull the rug out from under a student who could
    // be actively taking it. Once a subject is done (ended/marking/
    // completed) there's no live attempt left to disrupt, and the
    // underlying e_assessment/questions/submissions/marks all live on the
    // referenced e_assessments row, not on this scheduling row (§36) — so
    // deleting this row never touches results, it just drops the subject's
    // slot out of this examination's timetable.
    if (current.status === "active") {
      return res.status(409).json({ success: false, message: "Cannot remove a subject while it is active — end it first." });
    }

    await pool.request().input("id", sql.Int, id).query(`DELETE FROM exam_subject_sessions WHERE id = @id`);

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      action: "subject_session_removed",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { subject: current.subject },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE SUBJECT SESSION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error removing subject" });
  }
};

/* =========================================================================
   TIMETABLE (derived — §5, "do not manually duplicate timetable
   information"). Same rows as getSubjectSessions, just explicitly the
   read-only, presentation-oriented endpoint the Timetable tab/print/
   PDF/Excel views (later phase) will call.
========================================================================= */
const getTimetable = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Main examination not found" });

    const result = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`
        SELECT id, subject, class_id, exam_date, start_time, end_time, duration_minutes, venue, status
        FROM exam_subject_sessions
        WHERE main_examination_id = @mainExaminationId
        ORDER BY start_time ASC, exam_date ASC, id ASC
      `);

    res.json({ success: true, examination: { id: mainExam.id, name: mainExam.name }, timetable: result.recordset });
  } catch (err) {
    console.error("GET TIMETABLE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error fetching timetable" });
  }
};

/* =========================================================================
   PUBLISH TIMETABLE (§6, §41)
   Validates every subject session as a whole (not just each one in
   isolation) before letting the Main Examination move out of draft:
   every session needs a subject, a full time window and an assessment
   attached. Flips the main examination to 'published' and every
   still-draft subject session to 'scheduled' — from that point on the
   scheduler (next phase) owns activation/ending.
========================================================================= */
const publishTimetable = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Main examination not found" });

    const subjectsResult = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`
        SELECT ess.*, ea.status AS assessment_status, ea.title AS assessment_title
        FROM exam_subject_sessions ess
        LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        WHERE ess.main_examination_id = @mainExaminationId
      `);
    const subjects = subjectsResult.recordset;

    if (subjects.length === 0) {
      return res.status(400).json({ success: false, message: "Add at least one subject before publishing the timetable." });
    }

    const errors = [];
    for (const s of subjects) {
      if (!s.start_time || !s.end_time) errors.push(`${s.subject}: missing exam date/time.`);
      if (!s.e_assessment_id) errors.push(`${s.subject}: no assessment attached.`);
      else if (s.assessment_status !== "approved") errors.push(`${s.subject}: assessment "${s.assessment_title}" is not yet approved.`);
    }
    if (errors.length) {
      return res.status(400).json({ success: false, message: "Timetable is not ready to publish.", errors });
    }

    await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`
        UPDATE exam_subject_sessions SET status = 'scheduled', updatedAt = GETDATE()
        WHERE main_examination_id = @mainExaminationId AND status = 'draft'
      `);

    await pool.request()
      .input("id", sql.Int, mainExamId)
      .query(`UPDATE main_examinations SET status = 'published', updatedAt = GETDATE() WHERE id = @id`);

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      action: "timetable_published",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { subject_count: subjects.length },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("PUBLISH TIMETABLE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error publishing timetable" });
  }
};

/* =========================================================================
   UNPUBLISH (revert to draft)
   The mirror image of publishTimetable — lets an admin walk a published
   timetable back to 'draft' to fix a mistake, as long as nothing has
   actually happened yet: if any subject has gone active/ended/marking/
   completed, the exam is effectively underway/finished and reverting
   would contradict real history (and the auto-activation scheduler,
   which only ever moves a session forward), so that's refused instead.
========================================================================= */
const unpublishTimetable = async (req, res) => {
  try {
    const pool = req.pool;
    const mainExamId = toInt(req.params.mainExamId);
    if (!mainExamId) return res.status(400).json({ success: false, message: "Invalid main examination id" });

    const mainExam = await loadMainExam(pool, mainExamId);
    if (!mainExam) return res.status(404).json({ success: false, message: "Main examination not found" });

    if (mainExam.status !== "published") {
      return res.status(409).json({ success: false, message: `Cannot revert to draft — this examination is ${mainExam.status}.` });
    }

    const subjectsResult = await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`SELECT status, subject FROM exam_subject_sessions WHERE main_examination_id = @mainExaminationId`);

    const started = (subjectsResult.recordset || []).find((s) =>
      ["active", "ended", "marking", "completed"].includes(s.status)
    );
    if (started) {
      return res.status(409).json({
        success: false,
        message: `Cannot revert to draft — "${started.subject}" has already ${started.status === "active" ? "started" : started.status}.`,
      });
    }

    // Only rows the publish step itself flipped (draft -> scheduled) get
    // reversed; anything else is left exactly as it is.
    await pool.request()
      .input("mainExaminationId", sql.Int, mainExamId)
      .query(`
        UPDATE exam_subject_sessions SET status = 'draft', updatedAt = GETDATE()
        WHERE main_examination_id = @mainExaminationId AND status = 'scheduled'
      `);

    await pool.request()
      .input("id", sql.Int, mainExamId)
      .query(`UPDATE main_examinations SET status = 'draft', updatedAt = GETDATE() WHERE id = @id`);

    await logExamAudit(pool, {
      mainExaminationId: mainExamId,
      action: "timetable_reverted_to_draft",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: {},
    });

    res.json({ success: true });
  } catch (err) {
    console.error("UNPUBLISH TIMETABLE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error reverting examination to draft" });
  }
};

module.exports = {
  addSubjectSession,
  getSubjectSessions,
  getSubjectSessionById,
  updateSubjectSession,
  attachAssessment,
  deleteSubjectSession,
  getTimetable,
  publishTimetable,
  unpublishTimetable,
};
