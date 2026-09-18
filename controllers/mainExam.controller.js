const sql = require("mssql");
const { logExamAudit } = require("../utils/examAuditLog");

/* =========================================================================
   MAIN EXAMINATION CRUD
   Phase 2-3 of the Main Examination build: the parent "container"
   examination (§3 of the spec) — e.g. "2026 Second Year Final
   Examination" — that subject sessions (Mathematics, ICT, ...) get
   scheduled into later (next phase). This file deliberately does NOT
   touch e_assessments/questions/submissions/marking at all — those stay
   exactly as they are, per the spec's non-negotiable rule.
========================================================================= */

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

// Kept small and explicit rather than free-text, so the dashboard/status
// badges (§46/§47) always have a known, finite set of values to render.
const VALID_STATUSES = ["draft", "published", "ongoing", "completed", "archived"];

const toDateOnly = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* =========================================================================
   CREATE
========================================================================= */
const createMainExamination = async (req, res) => {
  try {
    const pool = req.pool;
    const {
      name,
      academic_year,
      cohort_year,
      programme,
      department,
      term,
      description,
      start_date,
      end_date,
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Examination name is required" });
    }

    const startDateVal = toDateOnly(start_date);
    const endDateVal = toDateOnly(end_date);
    if (startDateVal && endDateVal && endDateVal < startDateVal) {
      return res.status(400).json({ success: false, message: "End date cannot be before start date" });
    }

    const result = await pool.request()
      .input("name", sql.NVarChar, String(name).trim())
      .input("academic_year", sql.NVarChar, academic_year || null)
      .input("cohort_year", sql.Int, toInt(cohort_year))
      .input("programme", sql.NVarChar, programme || null)
      .input("department", sql.NVarChar, department || null)
      .input("term", sql.NVarChar, term || null)
      .input("description", sql.NVarChar, description || null)
      .input("start_date", sql.Date, startDateVal)
      .input("end_date", sql.Date, endDateVal)
      .input("created_by", sql.Int, req.user?.id || null)
      .query(`
        INSERT INTO main_examinations
          (name, academic_year, cohort_year, programme, department, term, description, start_date, end_date, status, created_by)
        OUTPUT INSERTED.id
        VALUES
          (@name, @academic_year, @cohort_year, @programme, @department, @term, @description, @start_date, @end_date, 'draft', @created_by)
      `);

    const id = result.recordset[0].id;

    await logExamAudit(pool, {
      mainExaminationId: id,
      action: "main_examination_created",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { name },
    });

    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error("CREATE MAIN EXAMINATION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error creating examination" });
  }
};

/* =========================================================================
   LIST
   Deliberately lightweight (§57/§58 — this can be hit often from the
   admin dashboard). Subject counts come from a single grouped
   sub-query rather than N+1 per-row lookups; full candidate/analytics
   aggregation is a later phase and lives on the detail/analytics
   endpoints instead, not here.
========================================================================= */
const getMainExaminations = async (req, res) => {
  try {
    const pool = req.pool;
    const request = pool.request();

    let where = "1=1";
    if (req.query.status) {
      request.input("status", sql.NVarChar, req.query.status);
      where += " AND me.status = @status";
    }
    if (req.query.academic_year) {
      request.input("academic_year", sql.NVarChar, req.query.academic_year);
      where += " AND me.academic_year = @academic_year";
    }

    const result = await request.query(`
      SELECT
        me.*,
        (SELECT COUNT(*) FROM exam_subject_sessions ess WHERE ess.main_examination_id = me.id) AS subject_count,
        (SELECT COUNT(*) FROM exam_subject_sessions ess WHERE ess.main_examination_id = me.id AND ess.status = 'active') AS active_subject_count,
        (SELECT COUNT(*) FROM exam_subject_sessions ess WHERE ess.main_examination_id = me.id AND ess.status IN ('completed','ended')) AS completed_subject_count
      FROM main_examinations me
      WHERE ${where}
      ORDER BY me.start_date DESC, me.id DESC
    `);

    res.json({ success: true, examinations: result.recordset });
  } catch (err) {
    console.error("LIST MAIN EXAMINATIONS ERROR:", err);
    res.status(500).json({ success: false, message: "Server error fetching examinations" });
  }
};

/* =========================================================================
   GET ONE (dashboard) — includes its subject sessions so the frontend's
   "Overview"/"Subjects" tabs (§10-§12) can render from a single call.
   Subject sessions have no results/candidate data wired in yet — that
   arrives with marking/analytics in a later phase; e_assessment_id here
   is only the reference link (§36), not a join into questions/marks.
========================================================================= */
const getMainExaminationById = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const examResult = await pool.request()
      .input("id", sql.Int, id)
      .query(`SELECT * FROM main_examinations WHERE id = @id`);

    const examination = examResult.recordset[0];
    if (!examination) {
      return res.status(404).json({ success: false, message: "Main examination not found" });
    }

    const subjectsResult = await pool.request()
      .input("mainExaminationId", sql.Int, id)
      .query(`
        SELECT * FROM exam_subject_sessions
        WHERE main_examination_id = @mainExaminationId
        ORDER BY start_time ASC, id ASC
      `);

    res.json({
      success: true,
      examination,
      subjects: subjectsResult.recordset,
    });
  } catch (err) {
    console.error("GET MAIN EXAMINATION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error fetching examination" });
  }
};

/* =========================================================================
   UPDATE
========================================================================= */
const updateMainExamination = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await pool.request()
      .input("id", sql.Int, id)
      .query(`SELECT id FROM main_examinations WHERE id = @id`);
    if (!existing.recordset[0]) {
      return res.status(404).json({ success: false, message: "Main examination not found" });
    }

    const {
      name,
      academic_year,
      cohort_year,
      programme,
      department,
      term,
      description,
      start_date,
      end_date,
      status,
    } = req.body;

    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Examination name cannot be empty" });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    const startDateVal = start_date !== undefined ? toDateOnly(start_date) : undefined;
    const endDateVal = end_date !== undefined ? toDateOnly(end_date) : undefined;
    if (startDateVal && endDateVal && endDateVal < startDateVal) {
      return res.status(400).json({ success: false, message: "End date cannot be before start date" });
    }

    // Build the SET clause dynamically so a PATCH-style partial body only
    // touches the fields actually sent, rather than nulling out anything
    // the frontend didn't include in this particular request.
    const request = pool.request().input("id", sql.Int, id);
    const sets = [];
    const maybeSet = (field, value, type) => {
      if (value === undefined) return;
      request.input(field, type, value);
      sets.push(`${field} = @${field}`);
    };

    maybeSet("name", name !== undefined ? String(name).trim() : undefined, sql.NVarChar);
    maybeSet("academic_year", academic_year, sql.NVarChar);
    maybeSet("cohort_year", cohort_year !== undefined ? toInt(cohort_year) : undefined, sql.Int);
    maybeSet("programme", programme, sql.NVarChar);
    maybeSet("department", department, sql.NVarChar);
    maybeSet("term", term, sql.NVarChar);
    maybeSet("description", description, sql.NVarChar);
    maybeSet("start_date", startDateVal, sql.Date);
    maybeSet("end_date", endDateVal, sql.Date);
    maybeSet("status", status, sql.NVarChar);

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }
    sets.push("updatedAt = GETDATE()");

    await request.query(`UPDATE main_examinations SET ${sets.join(", ")} WHERE id = @id`);

    await logExamAudit(pool, {
      mainExaminationId: id,
      action: "main_examination_updated",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: req.body,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE MAIN EXAMINATION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error updating examination" });
  }
};

/* =========================================================================
   ARCHIVE (safe soft-delete, §41 — "use safe archival/deactivation")
   The normal way to retire a Main Examination that already has subjects/
   candidates attached, without touching any FK-linked data.
========================================================================= */
const archiveMainExamination = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const result = await pool.request()
      .input("id", sql.Int, id)
      .query(`
        UPDATE main_examinations SET status = 'archived', updatedAt = GETDATE()
        OUTPUT INSERTED.id
        WHERE id = @id
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, message: "Main examination not found" });
    }

    await logExamAudit(pool, {
      mainExaminationId: id,
      action: "main_examination_archived",
      actorId: req.user?.id,
      actorRole: req.user?.role,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("ARCHIVE MAIN EXAMINATION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error archiving examination" });
  }
};

/* =========================================================================
   DELETE (hard delete)
   Only allowed while the examination has no subject sessions attached
   yet — i.e. an admin who created it by mistake before scheduling
   anything. Once subjects exist, this refuses and points at the
   archive endpoint instead (§41 — "do not allow deletion that violates
   existing foreign-key relationships").
========================================================================= */
const deleteMainExamination = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const subjectCount = await pool.request()
      .input("id", sql.Int, id)
      .query(`SELECT COUNT(*) AS cnt FROM exam_subject_sessions WHERE main_examination_id = @id`);

    if ((subjectCount.recordset[0]?.cnt || 0) > 0) {
      return res.status(409).json({
        success: false,
        message: "This examination has scheduled subjects and can't be deleted. Archive it instead.",
      });
    }

    const result = await pool.request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM main_examinations OUTPUT DELETED.id WHERE id = @id`);

    if (!result.recordset[0]) {
      return res.status(404).json({ success: false, message: "Main examination not found" });
    }

    await logExamAudit(pool, {
      action: "main_examination_deleted",
      actorId: req.user?.id,
      actorRole: req.user?.role,
      details: { id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE MAIN EXAMINATION ERROR:", err);
    res.status(500).json({ success: false, message: "Server error deleting examination" });
  }
};

/* =========================================================================
   DASHBOARD SUMMARY (§10, Phase 7)
   Powers the Main Examination Dashboard's top summary cards and the
   Overview tab. Everything here is computed from the SAME authoritative
   tables the rest of the app already trusts (§51 — "one source of
   truth"): exam_subject_sessions for schedule/status, e_assessments for
   the audience (class_id/year_of_study) and total_marks, and
   e_assessment_submissions for actual attempts/scores. Nothing is
   calculated a second time or duplicated into a new results table.

   Deliberately NOT called from anywhere in the student exam-taking path
   (§58) — this is an admin/teacher-dashboard-only query, one roundtrip
   of small aggregates rather than pulling every submission row into
   Node to sum in JS.
========================================================================= */
const getMainExaminationDashboard = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const examResult = await pool.request()
      .input("id", sql.Int, id)
      .query(`SELECT * FROM main_examinations WHERE id = @id`);
    const examination = examResult.recordset[0];
    if (!examination) {
      return res.status(404).json({ success: false, message: "Main examination not found" });
    }

    // Subject sessions + the linked assessment's audience/total_marks in
    // one query — small row count (a handful to a few dozen subjects per
    // Main Examination), so this is cheap even joined.
    const subjectsResult = await pool.request()
      .input("mainExaminationId", sql.Int, id)
      .query(`
        SELECT
          ess.id, ess.subject, ess.status, ess.exam_date, ess.start_time, ess.end_time,
          ess.duration_minutes, ess.venue, ess.e_assessment_id,
          ea.title AS assessment_title, ea.total_marks, ea.class_id, ea.year_of_study,
          c.name AS class_name
        FROM exam_subject_sessions ess
        LEFT JOIN e_assessments ea ON ea.id = ess.e_assessment_id
        LEFT JOIN Classes c ON c.id = ea.class_id
        WHERE ess.main_examination_id = @mainExaminationId
        ORDER BY ess.start_time ASC, ess.exam_date ASC, ess.id ASC
      `);
    const subjects = subjectsResult.recordset;

    // §7/§37: only 'active'/'ended' are ever set by the scheduler today;
    // 'scheduled' not yet due reads as "Upcoming" (WAITING has no
    // separate stored status — see examScheduler.js's own comment on
    // this). 'draft' subjects haven't been published yet, so they're
    // excluded from the "Scheduled" published-count on purpose.
    const subjectCounts = {
      total: subjects.length,
      draft: 0,
      scheduled: 0, // published, not yet due
      active: 0,
      ended: 0,
    };
    for (const s of subjects) {
      if (s.status === "draft") subjectCounts.draft++;
      else if (s.status === "active") subjectCounts.active++;
      else if (s.status === "ended" || s.status === "completed") subjectCounts.ended++;
      else subjectCounts.scheduled++;
    }

    const eAssessmentIds = [...new Set(subjects.map((s) => s.e_assessment_id).filter(Boolean))];

    let candidateCount = 0;
    let completedAttempts = 0;
    let averagePerformance = null;

    if (eAssessmentIds.length) {
      // Registered candidates = distinct students whose class or year of
      // study matches ANY of this Main Examination's subject audiences —
      // the same class/year matching rule getEAssessments already uses
      // for a student's own assessment list (§18's "Registered
      // Candidates"), not a re-derived definition.
      const candidatesResult = await pool.request()
        .input("mainExaminationId", sql.Int, id)
        .query(`
          SELECT COUNT(DISTINCT st.id) AS candidate_count
          FROM Students st
          WHERE EXISTS (
            SELECT 1
            FROM exam_subject_sessions ess
            JOIN e_assessments ea ON ea.id = ess.e_assessment_id
            LEFT JOIN Classes c ON c.id = ea.class_id
            WHERE ess.main_examination_id = @mainExaminationId
              AND ( (c.name IS NOT NULL AND c.name = st.studentClass) OR ea.year_of_study = st.yearOfStudy )
          )
        `);
      candidateCount = candidatesResult.recordset[0]?.candidate_count || 0;

      // Completed attempts + overall average performance, both computed
      // directly by SQL over e_assessment_submissions — the SAME table
      // and score column the existing per-assessment quick-stats
      // (getEAssessmentQuickStats) and student result view read from, so
      // this dashboard can never disagree with either (§51). Average is
      // taken over ALL submissions pooled together (score-as-percentage-
      // of-that-subject's-total_marks), not an average of per-subject
      // averages, so a subject with more candidates isn't under- or
      // over-weighted (§17 — "do not create misleading rankings").
      const idParams = eAssessmentIds.map((_, i) => `@eid${i}`).join(",");
      const submissionsRequest = pool.request();
      eAssessmentIds.forEach((eid, i) => submissionsRequest.input(`eid${i}`, sql.Int, eid));
      const submissionsResult = await submissionsRequest.query(`
        SELECT
          COUNT(*) AS total_submissions,
          AVG(CASE WHEN s.score IS NOT NULL AND ea.total_marks > 0
                    THEN CAST(s.score AS FLOAT) * 100.0 / ea.total_marks END) AS avg_percentage
        FROM e_assessment_submissions s
        JOIN e_assessments ea ON ea.id = s.e_assessment_id
        WHERE s.e_assessment_id IN (${idParams})
      `);
      const row = submissionsResult.recordset[0] || {};
      completedAttempts = row.total_submissions || 0;
      averagePerformance = row.avg_percentage != null ? Math.round(row.avg_percentage * 10) / 10 : null;
    }

    // §50 "No Fake Analytics": there is no pass-mark/grading-scale
    // configuration anywhere in the existing e-assessment schema to
    // compute a real pass rate from, so this is reported as
    // unavailable rather than invented from an assumed threshold (e.g.
    // "50%"). If/when a configurable grading scale is added (§16), this
    // is the one place to wire it in.
    const passRate = null;
    const passRateNote = "Unavailable — no pass mark is configured for these assessments.";

    res.json({
      success: true,
      examination,
      summary: {
        subjects_total: subjectCounts.total,
        subjects_scheduled: subjectCounts.total - subjectCounts.draft,
        subjects_active: subjectCounts.active,
        subjects_completed: subjectCounts.ended,
        subjects_upcoming: subjectCounts.scheduled,
        subjects_draft: subjectCounts.draft,
        candidates: candidateCount,
        completed_attempts: completedAttempts,
        average_performance: averagePerformance,
        pass_rate: passRate,
        pass_rate_note: passRateNote,
      },
      subjects,
    });
  } catch (err) {
    console.error("GET MAIN EXAMINATION DASHBOARD ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading dashboard" });
  }
};

/* =========================================================================
   AUDIT LOG (§53, Audit Log tab)
   Read-only tail of exam_audit_log for this Main Examination — every
   controller/scheduler action in this file, examSubjectSession.controller.js
   and examScheduler.js already writes here via logExamAudit(); this just
   reads it back, newest first.
========================================================================= */
const getMainExaminationAuditLog = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid id" });

    const limit = Math.min(toInt(req.query.limit) || 200, 500);

    const result = await pool.request()
      .input("mainExaminationId", sql.Int, id)
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          al.id, al.exam_subject_session_id, al.action, al.actor_id, al.actor_role,
          al.details, al.createdAt,
          COALESCE(u.name, u.username) AS actor_name,
          ess.subject AS subject_name
        FROM exam_audit_log al
        LEFT JOIN Users u ON u.id = al.actor_id
        LEFT JOIN exam_subject_sessions ess ON ess.id = al.exam_subject_session_id
        WHERE al.main_examination_id = @mainExaminationId
        ORDER BY al.createdAt DESC, al.id DESC
      `);

    res.json({ success: true, events: result.recordset });
  } catch (err) {
    console.error("GET MAIN EXAMINATION AUDIT LOG ERROR:", err);
    res.status(500).json({ success: false, message: "Server error loading audit log" });
  }
};

module.exports = {
  createMainExamination,
  getMainExaminations,
  getMainExaminationById,
  updateMainExamination,
  archiveMainExamination,
  deleteMainExamination,
  getMainExaminationDashboard,
  getMainExaminationAuditLog,
};
