/* =========================================================================
   E-ASSESSMENT ATTENDANCE REGISTER  (PDF)
   ─────────────────────────────────────────────────────────
   A printable list, with the school logo / name / address in the header
   (the same institutional header and theme every other report uses), of:
     • the students who DID the exam      (they have a submission)
     • the students who DID NOT           (and why: never attended, signed in
                                           but never started, started but
                                           nothing was submitted, timed out)

   WHO IS EXPECTED TO SIT IT — the same rule students are shown the exam by
   (see getEAssessments): everyone in the assessment's class (matched by
   Classes.name = Students.studentClass) OR, for a whole-year assessment,
   everyone whose yearOfStudy matches. On top of that, anyone who has a
   submission or an exam session for it is always included, so a student who
   sat the exam but has since moved class never drops off the "did" list.

   The query, the classification and the PDF are kept apart so the
   classification can be tested without a database or a PDF.
========================================================================= */
const sql = require("mssql");
const { getInstitutionHeader, buildReportPdf } = require("./reportExport");

/* ── classification (pure) ──────────────────────────────────────────────── */
const NOT_DONE_LABEL = {
  not_attended: "Did not attend",
  signed_in: "Signed in, did not start",
  in_progress: "Started, not submitted",
  timed_out: "Timed out, nothing saved",
  ended_no_submission: "Session ended, no submission",
};

/** Returns { done: true, note } or { done: false, reason, label }. */
function classifyAttendance(r) {
  if (r.submission_id) {
    const notes = [];
    if (r.auto_submitted) notes.push("Auto-submitted (time up)");
    if (Number(r.attempt_no) > 1) notes.push(`Attempt ${r.attempt_no}`);
    return { done: true, note: notes.join("; ") };
  }
  let reason;
  if (!r.session_id) reason = "not_attended";
  else if (r.session_status === "issued") reason = "signed_in";
  else if (r.session_status === "active" || r.session_status === "locked") reason = "in_progress";
  else if (r.session_status === "ended") reason = r.auto_submitted ? "timed_out" : "ended_no_submission";
  else reason = "signed_in";
  return { done: false, reason, label: NOT_DONE_LABEL[reason] };
}

/* ── data ───────────────────────────────────────────────────────────────── */
async function loadAttendance(pool, assessmentId) {
  const aRes = await pool.request()
    .input("id", sql.Int, assessmentId)
    .query(`
      SELECT ea.id, ea.title, ea.subject, ea.class_id, ea.year_of_study, ea.duration_minutes, c.name AS class_name
      FROM e_assessments ea
      LEFT JOIN Classes c ON c.id = ea.class_id
      WHERE ea.id = @id
    `);
  if (!aRes.recordset.length) return null;
  const assessment = aRes.recordset[0];

  const sRes = await pool.request()
    .input("id", sql.Int, assessmentId)
    .input("className", sql.NVarChar(100), assessment.class_name || null)
    .input("year", sql.Int, assessment.year_of_study || null)
    .query(`
      SELECT st.id, st.name, st.username, st.studentClass, st.yearOfStudy,
             sub.id AS submission_id, sub.submitted_at,
             es.id AS session_id, es.status AS session_status, es.auto_submitted,
             ISNULL(es.attempt_no, 1) AS attempt_no
      FROM Students st
      OUTER APPLY (
        SELECT TOP 1 s.id, s.submitted_at
        FROM e_assessment_submissions s
        WHERE s.e_assessment_id = @id AND s.student_id = st.id
        ORDER BY s.submitted_at DESC, s.id DESC
      ) sub
      LEFT JOIN e_assessment_exam_sessions es
        ON es.e_assessment_id = @id AND es.student_id = st.id
      WHERE (@className IS NOT NULL AND st.studentClass = @className)
         OR (@year IS NOT NULL AND st.yearOfStudy = @year)
         OR sub.id IS NOT NULL
         OR es.id IS NOT NULL
      ORDER BY st.studentClass, st.name
    `);

  const did = [];
  const didNot = [];
  for (const r of sRes.recordset || []) {
    const c = classifyAttendance(r);
    const base = { name: r.name || `Student #${r.id}`, className: r.studentClass || "-", username: r.username || "-" };
    if (c.done) did.push({ ...base, submittedAt: r.submitted_at, note: c.note });
    else didNot.push({ ...base, status: c.label, reason: c.reason });
  }
  return { assessment, did, didNot };
}

/* ── per-class breakdown (pure) ─────────────────────────────────────────── */
function byClass(did, didNot) {
  const m = new Map();
  const bump = (cls, k) => { const e = m.get(cls) || { cls, did: 0, didNot: 0 }; e[k]++; m.set(cls, e); };
  did.forEach((d) => bump(d.className, "did"));
  didNot.forEach((d) => bump(d.className, "didNot"));
  return [...m.values()].sort((a, b) => String(a.cls).localeCompare(String(b.cls), undefined, { numeric: true }));
}

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : "0%");

function fmtWhen(value, tz) {
  if (!value) return "-";
  const d = new Date(value);
  if (isNaN(d)) return "-";
  const opts = { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  // The browser tells us its own time zone so the PDF shows the same times as the screen.
  const zone = typeof tz === "string" && /^[A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+){0,2}$/.test(tz) ? tz : undefined;
  try { return d.toLocaleString("en-GB", { ...opts, timeZone: zone }); }
  catch { return d.toLocaleString("en-GB", opts); }
}

/* ── PDF ────────────────────────────────────────────────────────────────── */
async function buildAttendancePdf({ institution, assessment, did, didNot, tz }) {
  const total = did.length + didNot.length;
  const audience = assessment.year_of_study ? `Year ${assessment.year_of_study} (all classes)` : (assessment.class_name || "");
  const num = (rows) => rows.map((r, i) => ({ ...r, n: i + 1 }));

  const sections = [
    {
      heading: "Summary",
      text: `Expected: ${total}     Did the exam: ${did.length} (${pct(did.length, total)})     Did not do the exam: ${didNot.length} (${pct(didNot.length, total)})`,
    },
  ];

  const classes = byClass(did, didNot);
  if (classes.length > 1) {
    sections.push({
      heading: "By class",
      columns: [
        { key: "cls", header: "Class" },
        { key: "expected", header: "Expected", align: "right" },
        { key: "did", header: "Did the exam", align: "right" },
        { key: "didNot", header: "Did not", align: "right" },
        { key: "rate", header: "Attendance", align: "right" },
      ],
      rows: classes.map((c) => ({ cls: c.cls, expected: String(c.did + c.didNot), did: String(c.did), didNot: String(c.didNot), rate: pct(c.did, c.did + c.didNot) })),
    });
  }

  sections.push({
    heading: `Students who did the exam (${did.length})`,
    columns: [
      { key: "n", header: "#", align: "right" },
      { key: "name", header: "Student" },
      { key: "className", header: "Class" },
      { key: "username", header: "Username" },
      { key: "submittedAt", header: "Submitted" },
      { key: "note", header: "Note" },
    ],
    rows: num(did).map((r) => ({ ...r, submittedAt: fmtWhen(r.submittedAt, tz) })),
  });

  sections.push({
    heading: `Students who did not do the exam (${didNot.length})`,
    columns: [
      { key: "n", header: "#", align: "right" },
      { key: "name", header: "Student" },
      { key: "className", header: "Class" },
      { key: "username", header: "Username" },
      { key: "status", header: "Status" },
    ],
    rows: num(didNot),
  });

  return buildReportPdf({
    institution,
    examinationName: assessment.title || "E-Assessment",
    reportTitle: "Exam Attendance Register",
    subtitle: [assessment.subject, audience].filter(Boolean).join("  ·  "),
    sections,
    landscape: false, // a name list reads better on a portrait page
  });
}

/** One call for the controller: load + header + PDF. Returns { buffer, filename } or null if no such assessment. */
async function generateAttendancePdf(pool, assessmentId, tz) {
  const data = await loadAttendance(pool, assessmentId);
  if (!data) return null;
  const institution = await getInstitutionHeader(pool);
  const buffer = await buildAttendancePdf({ institution, ...data, tz });
  const safeTitle = String(data.assessment.title || "assessment").replace(/[^A-Za-z0-9 _.-]+/g, "_").trim().slice(0, 60) || "assessment";
  return { buffer, filename: `Attendance - ${safeTitle}.pdf`, counts: { did: data.did.length, didNot: data.didNot.length } };
}

module.exports = { classifyAttendance, loadAttendance, byClass, buildAttendancePdf, generateAttendancePdf, fmtWhen, NOT_DONE_LABEL };
