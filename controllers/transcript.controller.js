const sql = require("mssql");
const { getInstitutionHeader, getSigningOfficials, getClassTeachers, getFooterStampDiskPath, sendPdfBuffer, urlToDiskPath, loadPdfImage } = require("../utils/reportExport");
const { getReportFormConfig } = require("../utils/reportFormSubjects");
const { splitGroupKey } = require("../utils/splitPapers");
const { countedWithoutSplitDuplicates, loadOptionalMatcher, isSessionOver } = require("../utils/examPercentages");
const { buildGeneralRemarks } = require("../utils/generalRemarks");
const { buildTranscriptPdf } = require("../utils/transcriptPdf");
const { loadGradingSystem, getGradeForScore, getOverallResultForScore, countFailedSubjects, getOverallResultWithFails, getTotalMarksPossible } = require("../utils/grading");

const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const round2 = (n) => (n == null ? null : Math.floor(Number(n) + 1e-9));

/* =========================================================================
   TRANSCRIPT DOWNLOAD
   GET /api/main-exams/transcripts/download
       ?scope=class|all|student  &className=...  &studentId=<id>  &examId=all|<id>  &separate=1

   scope=student gives ONE student's transcript; separate=1 (class / all) returns a
   ZIP with a separate PDF for every student instead of one combined PDF.
   buildTranscripts() below is the shared builder: the admin download, and the
   per-student transcript link a student opens (GET /api/auth/transcript-link,
   routes/auth.js) both use it, so they can never disagree.

   Builds one printable PDF covering every matching student — one page
   (or more, if they've sat enough exams) each — showing either every
   Main Examination they have released marks for, or just one selected
   exam (the "Download Transcripts" button on the Main Examinations
   list — MainExaminations.jsx).

   Deliberately reuses the EXACT SAME released-marks chain as the
   student's own report card (§ student report card exam selection —
   Marks.assessmentId → Assessments(sourceSystem='e_assessment') →
   e_assessments → exam_subject_sessions → main_examinations), so a
   transcript can never show a number the student's own report card
   wouldn't also show (§51 "one source of truth"). Students with no
   released marks for the chosen scope are silently skipped rather
   than given a blank page.
========================================================================= */
const fail = (status, message, code) => ({ ok: false, status, message, code });
const PHOTO_REQUIRED_MESSAGE = "Kindly upload a clear, official passport photo to your profile before downloading. Your report form and transcript need your photo.";
const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** Builds the transcript file for a selection. Returns { ok:true, buffer, filename, contentType } or { ok:false, status, message }. */
const buildTranscripts = async (pool, { scope, className, studentId, examId, separate, requirePhoto, allowedExamIds, selectedExamIds }) => {
  try {
    if (!["all", "class", "student"].includes(scope)) scope = "class";
    if (scope === "class" && !className) return fail(400, "A class is required for a per-class transcript");
    if (scope === "student" && !studentId) return fail(400, "A student is required");

    /* ---------------- 1. Students in scope ---------------- */
    const studentsReq = pool.request();
    let studentsQuery = `SELECT id, name, admissionNo, username, email, studentClass, gender, assessmentNumber, yearOfStudy, photoUrl FROM Students`;
    if (scope === "class") {
      studentsReq.input("className", sql.NVarChar, className);
      studentsQuery += ` WHERE studentClass = @className`;
    } else if (scope === "student") {
      studentsReq.input("studentId", sql.Int, studentId);
      studentsQuery += ` WHERE id = @studentId`;
    }
    studentsQuery += ` ORDER BY studentClass, name`;
    const studentsResult = await studentsReq.query(studentsQuery);
    const students = studentsResult.recordset;
    if (!students.length) return fail(404, "No students found for this selection");

    // Student-facing downloads (report link / report-only session) need a photo on file.
    if (requirePhoto && students.some((s) => !String(s.photoUrl || "").trim())) {
      return fail(409, PHOTO_REQUIRED_MESSAGE, "PHOTO_REQUIRED");
    }

    // Student-facing downloads only show the exams the school picked (Report Download Link → "Exams on the transcript").
    let allowed = Array.isArray(allowedExamIds) && allowedExamIds.length ? allowedExamIds.map(Number).filter(Number.isFinite) : null;
    // The student may narrow it further to one or more of the exams the school allowed.
    const picked = Array.isArray(selectedExamIds) ? [...new Set(selectedExamIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];
    if (picked.length && !examId) {
      const usable = allowed ? picked.filter((id) => allowed.includes(id)) : picked;
      if (!usable.length) return fail(404, "None of the selected exams are available on transcripts.");
      if (usable.length === 1) examId = usable[0]; // one exam: same title/filename as a single-exam transcript
      else allowed = usable;
    }
    const subsetOfExams = !examId && !!allowed;
    // Names of the chosen exams (Report Download Link dropdown / ticked exams), so the transcript title can show them.
    let subsetNames = [];
    if (subsetOfExams && allowed.length) {
      try {
        const nreq = pool.request();
        const ph = allowed.map((id, i) => { nreq.input(`en${i}`, sql.Int, id); return `@en${i}`; });
        const nr = await nreq.query(`SELECT name FROM main_examinations WHERE id IN (${ph.join(",")}) ORDER BY start_date ASC, id ASC`);
        subsetNames = nr.recordset.map((r) => r.name).filter(Boolean);
      } catch (_) { subsetNames = []; }
    }
    if (allowed && examId && !allowed.includes(Number(examId))) {
      return fail(404, "That exam is not available on transcripts.");
    }

    /* ---------------- 2. Resolve the selected exam's name (for the title/filename) ---------------- */
    let singleExam = null;
    if (examId) {
      const examResult = await pool.request().input("id", sql.Int, examId)
        .query(`SELECT id, name FROM main_examinations WHERE id = @id`);
      singleExam = examResult.recordset[0];
      if (!singleExam) return fail(404, "Exam not found");
    }

    /* ---------------- 3. Released marks for every matching student ----------------
       Same chain GET /api/student/marks (routes/marks.js) uses for a
       single student's own report card, just widened to many students
       and (optionally) not filtered to one exam. */
    const studentIds = students.map((s) => s.id);
    const marksReq = pool.request();
    const idParams = studentIds.map((id, i) => { marksReq.input(`sid${i}`, sql.Int, id); return `@sid${i}`; });
    if (examId) marksReq.input("examId", sql.Int, examId);

    let marksQuery = `
      SELECT
        m.studentId,
        me.id AS mainExaminationId, me.name AS examName, me.academic_year, me.term, me.start_date,
        m.subjectId, sub.name AS subjectName, sub.code AS subjectCode,
        ess.allow_concurrent, ess.paper_label,
        m.percentage
      FROM Marks m
      INNER JOIN Assessments a ON a.id = m.assessmentId AND a.sourceSystem = 'e_assessment'
      INNER JOIN e_assessments ea ON ea.id = a.sourceRefId
      INNER JOIN exam_subject_sessions ess ON ess.e_assessment_id = ea.id
      INNER JOIN main_examinations me ON me.id = ess.main_examination_id
      LEFT JOIN Subjects sub ON sub.id = m.subjectId
      WHERE m.studentId IN (${idParams.join(",")})
    `;
    if (examId) marksQuery += ` AND me.id = @examId`;
    if (allowed) marksQuery += ` AND me.id IN (${allowed.join(",")})`; // integers only (sanitised above)
    marksQuery += ` ORDER BY me.start_date ASC, me.id ASC, sub.name ASC`;

    const marksResult = await marksReq.query(marksQuery);
    const marksRows = marksResult.recordset;

    if (!marksRows.length) {
      return fail(404, singleExam
        ? `No released marks found for "${singleExam.name}" for this selection`
        : "No released marks found for this selection");
    }

    /* ---------------- 4. Group rows: studentId → examId → subjects[] ---------------- */
    const gradingSystem = await loadGradingSystem(pool);
    // Report Form Subjects: an optional subject counts toward the averages only
    // when the student actually has a mark in it (a student who didn't take it
    // just doesn't have it listed — never a CRNM), so the transcript always
    // agrees with the report form.
    const optionalSubjectIds = new Set((await getReportFormConfig(pool)).optionalIds.map(Number));
    const isOptionalSubject = (s) => s.subjectId != null && optionalSubjectIds.has(Number(s.subjectId));
    const byStudent = new Map();
    marksRows.forEach((row) => {
      if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, new Map());
      const examsMap = byStudent.get(row.studentId);
      if (!examsMap.has(row.mainExaminationId)) {
        examsMap.set(row.mainExaminationId, {
          examName: row.examName, academic_year: row.academic_year, term: row.term, subjects: [],
        });
      }
      examsMap.get(row.mainExaminationId).subjects.push({
        subjectId: row.subjectId,
        subjectCode: row.subjectCode || null,
        subjectName: row.subjectName || row.subjectCode || "Subject",
        percentage: row.percentage,
        split_group: splitGroupKey({ subject: row.subjectName, paper_label: row.paper_label, allow_concurrent: row.allow_concurrent }),
      });
    });

    /* ---------------- 4b. Absent papers (AB) ----------------
       A compulsory paper of an exam the student has marks in, scheduled for the student's class or year,
       whose session is over and that the student has no mark for, is listed as AB (absent) instead of
       being left out or shown as 0%. Optional subjects are never listed as AB. AB has no percentage, so it
       never changes an average. */
    // A student who sat nothing has no marks, but must still get a transcript: give every student every exam
    // that has released marks (for anyone in scope); exams not scheduled for them are dropped again below.
    const examMeta = new Map();
    marksRows.forEach((row) => {
      if (!examMeta.has(row.mainExaminationId)) examMeta.set(row.mainExaminationId, { examName: row.examName, academic_year: row.academic_year, term: row.term });
    });
    students.forEach((st) => {
      if (!byStudent.has(st.id)) byStudent.set(st.id, new Map());
      const em = byStudent.get(st.id);
      examMeta.forEach((meta, id) => { if (!em.has(id)) em.set(id, { ...meta, subjects: [] }); });
    });
    const examIdsInPlay = [...examMeta.keys()].map(Number).filter(Number.isFinite);
    const isOptionalByName = await loadOptionalMatcher(pool);
    const nm = (v) => String(v || "").replace(/\(\s*optional\s*\)/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (examIdsInPlay.length) {
      try {
        const sessions = (await pool.request().query(`
          SELECT ess.main_examination_id AS examId, ess.subject, ess.paper_label, ess.allow_concurrent, ess.status AS session_status,
                 c.name AS className, ea.year_of_study
          FROM exam_subject_sessions ess
          JOIN e_assessments ea ON ea.id = ess.e_assessment_id
          LEFT JOIN Classes c ON c.id = ea.class_id
          WHERE ess.main_examination_id IN (${examIdsInPlay.join(",")})`)).recordset;
        const codes = new Map((await pool.request().query(`SELECT name, code FROM Subjects`)).recordset.map((r) => [nm(r.name), r.code]));
        students.forEach((st) => {
          const examsMap = byStudent.get(st.id);
          if (!examsMap) return;
          examsMap.forEach((exam, examId) => {
            const have = new Set(exam.subjects.map((x) => nm(x.subjectName)));
            const haveGroups = new Set(exam.subjects.map((x) => x.split_group).filter(Boolean));
            sessions.filter((ss) => Number(ss.examId) === Number(examId)).forEach((ss) => {
              const forThem = (ss.className && ss.className === st.studentClass) || (Number(st.yearOfStudy) > 0 && Number(ss.year_of_study) === Number(st.yearOfStudy));
              if (!forThem || !isSessionOver(ss.session_status) || isOptionalByName(ss.subject)) return;
              const key = nm(ss.subject);
              const group = splitGroupKey({ subject: ss.subject, paper_label: ss.paper_label, allow_concurrent: ss.allow_concurrent });
              if (have.has(key) || (group && haveGroups.has(group))) return;
              have.add(key);
              exam.subjects.push({
                subjectId: null, subjectCode: codes.get(key) || null, subjectName: ss.subject,
                percentage: null, absent: true, split_group: group,
              });
            });
          });
        });
      } catch (err) {
        console.error("TRANSCRIPT ABSENT LOOKUP ERROR (AB rows skipped):", err.message);
      }
    }

    // drop exams that had no subject for the student (not scheduled for their class/year)
    byStudent.forEach((em) => { [...em.keys()].forEach((id) => { if (!em.get(id).subjects.length) em.delete(id); }); });

    /* ---------------- 5. Shape into buildTranscriptPdf's expected format ----------------
       Students in scope with no released marks at all are skipped
       (rather than drawing a blank page for them). */
    const studentPages = [];
    students.forEach((student) => {
      const examsMap = byStudent.get(student.id);
      if (!examsMap || !examsMap.size) return;

      const exams = [...examsMap.values()].map((exam) => {
        // Split papers (e.g. 9819 + 9820) stay listed, but a split subject counts once (the paper sat).
        const counted = countedWithoutSplitDuplicates(exam.subjects.map((s) => ({ percentage: s.percentage == null ? null : Number(s.percentage), group: s.split_group, key: s.subjectId, sat: true })));
        const scores = counted.map((x) => x.percentage).filter((n) => n != null && !Number.isNaN(n));
        const average = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
        // Grading System rule: failing N or more subjects makes the overall result a fail.
        const failedCount = countFailedSubjects(scores, gradingSystem);
        // Total marks (sum of the counted subject percentages) out of the Grading System's total.
        const totalMarks = scores.length ? round2(scores.reduce((a, b) => a + b, 0)) : null;
        const totalPossible = getTotalMarksPossible(gradingSystem, scores.length);

        // Per-subject columns, all from the school's Grading System:
        //   GRADE  = the matched band's grade (e.g. "1".."7")
        //   POINTS = the matched band's label (e.g. "Distinction")
        //   RESULT = the result label for that score (overall bands)
        // The band's numeric grade is also what the exam's aggregate
        // points total below is summed from.
        const orderedSubjects = [...exam.subjects].sort((a, b) => {
          const ca = a.subjectCode ? String(a.subjectCode).trim() : "";
          const cb = b.subjectCode ? String(b.subjectCode).trim() : "";
          if (ca && !cb) return -1;
          if (!ca && cb) return 1;
          return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: "base" })
            || String(a.subjectName).localeCompare(String(b.subjectName), undefined, { numeric: true });
        });
        const subjects = orderedSubjects.map((s) => {
          if (s.absent) return { ...s, optional: false, grade: "—", points: "ABSENT", gradePoints: null, result: "CRNM" };
          const band = s.percentage != null ? getGradeForScore(s.percentage, gradingSystem) : null;
          return {
            ...s,
            optional: isOptionalSubject(s),
            grade: band && band.grade !== "" && band.grade != null ? String(band.grade) : "—",
            points: band ? band.label : "—",
            gradePoints: band ? Number(band.grade) : null,
            result: s.percentage != null ? getOverallResultForScore(s.percentage, gradingSystem) : "—",
          };
        });

        const countedSubjectKeys = new Set(counted.map((x) => x.key));
        const gradePointsList = subjects.filter((s) => !s.split_group || countedSubjectKeys.has(s.subjectId)).map((s) => s.gradePoints).filter((n) => n != null && !Number.isNaN(n));
        const aggregatePoints = gradePointsList.length ? gradePointsList.reduce((a, b) => a + b, 0) : null;

        return {
          ...exam,
          subjects,
          average,
          failedCount,
          totalMarks,
          totalPossible,
          overallResult: subjects.some((x) => x.absent) ? "CRNM" : average != null ? getOverallResultWithFails(average, failedCount, gradingSystem) : "—",
          aggregatePoints,
        };
      });

      const allScores = exams.flatMap((e) => countedWithoutSplitDuplicates(e.subjects.map((s) => ({ percentage: s.percentage == null ? null : Number(s.percentage), group: s.split_group, sat: true }))).map((x) => x.percentage).filter((n) => n != null && !Number.isNaN(n)));
      const cumulativeAverage = allScores.length ? round2(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null;

      // General remarks (replaces the class teacher's remarks): subjects below the pass mark + absent papers.
      const passMark = Number.isFinite(Number(gradingSystem?.passMark)) ? Number(gradingSystem.passMark) : 40;
      const remarkParts = exams.map((e) => {
        const scored = e.subjects.filter((x) => x.percentage != null && !Number.isNaN(Number(x.percentage))).map((x) => ({ name: x.subjectName, score: Number(x.percentage) }));
        const text = buildGeneralRemarks({
          passMark,
          weak: scored.filter((x) => x.score < passMark),
          absent: e.subjects.filter((x) => x.absent).map((x) => x.subjectName),
          all: scored,
        });
        return exams.length > 1 && text ? `${e.examName}: ${text}` : text;
      }).filter(Boolean);

      studentPages.push({
        student,
        generalRemarks: remarkParts.join("\n"),
        exams,
        cumulativeAverage,
        // Failing in any one examination under the minimum-fails rule makes the cumulative result a fail too.
        // A missed (AB) compulsory paper in any exam makes the cumulative result CRNM too.
        cumulativeResult: exams.some((e) => e.subjects.some((x) => x.absent)) ? "CRNM" : cumulativeAverage != null
          ? getOverallResultWithFails(cumulativeAverage, Math.max(0, ...exams.map((e) => e.failedCount || 0)), gradingSystem)
          : "—",
      });
    });

    // Profile photo for each transcript (JPEG/PNG buffer, or null → no photo box).
    for (const page of studentPages) {
      page.student.photoImage = await loadPdfImage(urlToDiskPath(page.student.photoUrl));
    }

    if (!studentPages.length) {
      return fail(404, singleExam
        ? `No released marks found for "${singleExam.name}" for this selection`
        : "No released marks found for this selection");
    }

    /* ---------------- 6. Render ---------------- */
    const institution = await getInstitutionHeader(pool);
    const officials = await getSigningOfficials(pool);
    const classTeachers = await getClassTeachers(pool);
    institution.footerStampDiskPath = await getFooterStampDiskPath(pool);
    const title = singleExam ? singleExam.name : subsetOfExams ? (subsetNames.length && subsetNames.length <= 3 ? subsetNames.join(" & ") : "Academic Transcript (Selected Exams)") : "Full Academic Transcript (All Exams)";
    const subtitle = scope === "class" ? `Class: ${className}`
      : scope === "student" ? `Student: ${studentPages[0].student.name}` : "All Students";
    const examSlug = singleExam ? singleExam.name : subsetOfExams ? "selected-exams" : "all-exams";

    // one PDF per student, zipped
    if (separate && scope !== "student" && studentPages.length > 1) {
      const JSZip = require("jszip");
      const zip = new JSZip();
      const used = new Set();
      for (const page of studentPages) {
        const pdf = await buildTranscriptPdf({ institution, officials, classTeachers, title, subtitle: `Student: ${page.student.name}`, students: [page] });
        let base = slug(`${page.student.name}-${page.student.admissionNo || page.student.id}`) || `student-${page.student.id}`;
        while (used.has(base)) base += "-x";
        used.add(base);
        zip.file(`${base}.pdf`, pdf);
      }
      const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      const filename = `${slug(`Transcripts-${scope === "class" ? className : "all-students"}-${examSlug}`)}.zip`;
      return { ok: true, buffer, filename, contentType: "application/zip" };
    }

    const buffer = await buildTranscriptPdf({ institution, officials, classTeachers, title, subtitle, students: studentPages });
    const filenameBase = scope === "class" ? className : scope === "student" ? studentPages[0].student.name : "all-students";
    const filename = `${slug(`Transcripts-${filenameBase}-${examSlug}`)}.pdf`;
    return { ok: true, buffer, filename, contentType: "application/pdf" };
  } catch (err) {
    console.error("BUILD TRANSCRIPTS ERROR:", err);
    return fail(500, "Server error generating transcripts");
  }
};

/** Which of these students have at least one released mark (for the chosen exam)? -> Set of student ids. */
const studentIdsWithTranscript = async (pool, studentIds, examId) => {
  const ids = [...new Set((studentIds || []).map(Number).filter(Number.isFinite))];
  const out = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rq = pool.request();
    const params = part.map((id, k) => { rq.input(`s${k}`, sql.Int, id); return `@s${k}`; });
    if (examId) rq.input("examId", sql.Int, examId);
    const r = await rq.query(`
      SELECT DISTINCT m.studentId
      FROM Marks m
      INNER JOIN Assessments a ON a.id = m.assessmentId AND a.sourceSystem = 'e_assessment'
      INNER JOIN e_assessments ea ON ea.id = a.sourceRefId
      INNER JOIN exam_subject_sessions ess ON ess.e_assessment_id = ea.id
      INNER JOIN main_examinations me ON me.id = ess.main_examination_id
      WHERE m.studentId IN (${params.join(",")}) ${examId ? "AND me.id = @examId" : ""}`);
    (r.recordset || []).forEach((row) => out.add(row.studentId));
  }
  return out;
};

const downloadTranscripts = async (req, res) => {
  const examIdRaw = req.query.examId ? String(req.query.examId) : "all";
  const examId = examIdRaw === "all" ? null : toInt(examIdRaw);
  if (examIdRaw !== "all" && !examId) return res.status(400).json({ success: false, message: "Invalid exam selection" });

  const result = await buildTranscripts(req.pool, {
    scope: String(req.query.scope || "class"),
    className: req.query.className ? String(req.query.className) : null,
    studentId: toInt(req.query.studentId),
    examId,
    separate: String(req.query.separate || "") === "1",
  });
  if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
  if (result.contentType === "application/pdf") return sendPdfBuffer(res, result.buffer, result.filename);
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename.replace(/"/g, "")}"`);
  res.send(result.buffer);
};

/** Exams a student can pick from: those the school allows (or all) that have released marks for them. */
const examsForStudentTranscript = async (pool, studentId, allowedExamIds) => {
  const allowed = Array.isArray(allowedExamIds) && allowedExamIds.length ? allowedExamIds.map(Number).filter(Number.isFinite) : null;
  const r = await pool.request().input("sid", sql.Int, Number(studentId)).query(`
    SELECT DISTINCT me.id, me.name, me.academic_year, me.term, me.start_date
    FROM Marks m
    INNER JOIN Assessments a ON a.id = m.assessmentId AND a.sourceSystem = 'e_assessment'
    INNER JOIN e_assessments ea ON ea.id = a.sourceRefId
    INNER JOIN exam_subject_sessions ess ON ess.e_assessment_id = ea.id
    INNER JOIN main_examinations me ON me.id = ess.main_examination_id
    WHERE m.studentId = @sid ${allowed ? `AND me.id IN (${allowed.join(",")})` : ""}
    ORDER BY me.start_date DESC, me.id DESC`);
  return r.recordset || [];
};

module.exports = { examsForStudentTranscript, downloadTranscripts, buildTranscripts, studentIdsWithTranscript };