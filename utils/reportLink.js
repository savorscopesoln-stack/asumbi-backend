/* =========================================================================
   REPORT LINKS — a download link for each student's report form.

   A link looks like  https://<school-site>/r/<token>.  The token is a signed
   (JWT) "report-link" that names ONE student and the school database
   (tenant) they belong to, and expires after the number of days the admin
   chose. Opening the link swaps it (POST /api/auth/report-link) for a
   short-lived, REPORT-ONLY session: it is a normal student session, except
   that authMiddleware's `protect` lets it read nothing but the handful of
   endpoints the report form page needs (REPORT_SESSION_ALLOWED_GET below) and
   refuses every write. A link token itself is never accepted as a login.

   Links are stateless: they cannot be revoked one by one, only left to
   expire — so keep the validity short.
========================================================================= */
const jwt = require("jsonwebtoken");

const secret = () => process.env.JWT_SECRET || "doravo_core_secret";
const LINK_TYP = "report-link";
const SESSION_SCOPE = "report";
const SESSION_MINUTES = 120;

// Everything the report form page (StudentReport.jsx) and the hooks it uses
// request. Anything else is refused for a report-only session.
const REPORT_SESSION_ALLOWED_GET = new Set([
  "/api/student/marks",
  "/api/students",
  "/api/subjects",
  "/api/report-card-source",
  "/api/school-settings",
  "/api/school-settings/report-themes",
  "/api/e-assessments/grading-system",
]);

const TRANSCRIPT_TYP = "transcript-link";

/** A link that downloads ONE student's transcript PDF (optionally for one exam) — see GET /api/auth/transcript-link. */
const signTranscriptLink = ({ studentId, tenant, days, examId }) =>
  jwt.sign({ typ: TRANSCRIPT_TYP, sid: studentId, tenant: tenant || "default", exam: examId || null }, secret(), { expiresIn: `${days}d` });

const verifyTranscriptLink = (token) => {
  const d = jwt.verify(String(token || ""), secret());
  if (d.typ !== TRANSCRIPT_TYP || d.sid == null) throw new Error("not a transcript link");
  return d;
};

const signReportLink = ({ studentId, tenant, days }) =>
  jwt.sign({ typ: LINK_TYP, sid: studentId, tenant: tenant || "default" }, secret(), { expiresIn: `${days}d` });

/** Throws (TokenExpiredError / JsonWebTokenError / Error) when the token is not a valid, unexpired report link. */
const verifyReportLink = (token) => {
  const d = jwt.verify(String(token || ""), secret());
  if (d.typ !== LINK_TYP || d.sid == null) throw new Error("not a report link");
  return d;
};

const signReportSession = ({ student, tenant }) =>
  jwt.sign(
    {
      id: student.id, username: student.username, role: "student", source: "Students", tenant: tenant || "default",
      scope: SESSION_SCOPE, mustChangePassword: false, profileIncomplete: false,
    },
    secret(),
    { expiresIn: `${SESSION_MINUTES}m` }
  );

const isAllowedForReportSession = (method, originalUrl) => {
  if (String(method).toUpperCase() !== "GET") return false;
  const path = String(originalUrl || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  return REPORT_SESSION_ALLOWED_GET.has(path);
};

/** {name}, {link}, {days}, {class} placeholders -> the final text for one student. */
const renderMessage = (template, vars) =>
  String(template || "").replace(/\{(name|link|days|class)\}/gi, (_, k) => String(vars[k.toLowerCase()] ?? ""));

module.exports = {
  LINK_TYP, TRANSCRIPT_TYP, SESSION_SCOPE, REPORT_SESSION_ALLOWED_GET,
  signReportLink, signTranscriptLink, verifyTranscriptLink, verifyReportLink, signReportSession, isAllowedForReportSession, renderMessage,
};
