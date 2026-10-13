/* =========================================================================
   E-ASSESSMENT ACTIVITY LOG  —  "who did what, and when"
   ─────────────────────────────────────────────────────────
   One row per meaningful action in the E-Assessment exam module, from all
   three portals:
     • student  — exam login (ok / wrong password / blocked device), start,
                  device bound, lock, submit, remark request, evidence photo
     • teacher  — create/edit assessment, add/edit/delete questions, import,
                  cover page, images, open a script, save marking
     • admin    — approve/reject, Start/Stop, Desktop-only switch, unlock a
                  device, grant/cancel resit, assign teachers/scripts,
                  release marks, grading system, delete

   Stored in e_assessment_activity_log (see ensureSchema.js). Each row has
   the actor (id, role, username, portal), the action, the outcome
   (success / rejected / locked / device_blocked / denied / error), the
   assessment, the IP address, the device, and a small JSON `details`.

   HOW IT HOOKS IN
   ─────────────────────────────────────────────────────────
   routes/eAssessments.js mounts ONE middleware (`activityLogger`) at the
   top of the router. It watches every response finish, looks up
   "METHOD route-path" in ROUTE_ACTIONS below, and writes the row — so no
   controller had to be edited and a new route is logged by adding a
   single line to the table.

   PRIVACY / SAFETY
   ─────────────────────────────────────────────────────────
   • Passwords, tokens and students' ANSWERS are never stored — `details`
     is built by sanitize(), which drops those keys and keeps only counts.
   • Logging never throws and never delays the response (it runs after the
     response has been sent). A logging failure cannot break an exam.
   • High-frequency calls (heartbeat, autosave, evidence photos) are
     either logged only when they FAIL, or de-duplicated for 60 seconds,
     so the table records events rather than noise.
========================================================================= */
const sql = require("mssql");
const { classifyDevice } = require("./deviceRestriction");

/* ─────────────────────────── route → action table ─────────────────────────── */
/*  kind: how to find the assessment this action belongs to
      assessment → req.params.id          session    → exam session row id
      submission → submission row id      question   → question row id (resolved BEFORE the handler, for deletes)
      answer     → first answer id in body.scores     body → body.assessmentId / assessment_id
    onlyFailures: log only non-success responses (heartbeat/autosave)
    dedupeMs:     skip an identical (actor+action+assessment+outcome) within this window
    studentOnly:  only log when the actor is a student (GET /:id is also used by staff) */
const ROUTE_ACTIONS = {
  /* ---- student exam flow ---- */
  "POST /exam-login":                    { action: "exam_login",              kind: "body" },
  "POST /:id/start-exam":                { action: "start_exam",              kind: "assessment" },
  "POST /exam-session/activate":         { action: "activate_exam_device",    kind: "token" },
  "POST /exam-session/heartbeat":        { action: "heartbeat",               kind: "token", onlyFailures: true, dedupeMs: 60000 },
  "POST /:id/autosave":                  { action: "autosave",                kind: "assessment", onlyFailures: true, dedupeMs: 60000 },
  "POST /exam-session/lock":             { action: "device_locked_by_student_device", kind: "token" },
  "POST /exam-session/end":              { action: "end_exam_session",        kind: "token" },
  "POST /submit":                        { action: "submit_exam",             kind: "body" },
  "POST /violation-photo":               { action: "violation_photo_captured", kind: "body", dedupeMs: 60000 },
  "POST /submissions/:id/request-remark": { action: "request_remark",         kind: "submission" },
  "GET /:id":                            { action: "open_exam",               kind: "assessment", studentOnly: true, dedupeMs: 60000 },

  /* ---- teacher: assessment & questions ---- */
  "POST /":                              { action: "create_assessment",       kind: "none" },
  "PUT /:id":                            { action: "update_assessment",       kind: "assessment" },
  "POST /:id/questions":                 { action: "add_question",            kind: "assessment" },
  "PUT /questions/:questionId":          { action: "update_question",         kind: "question" },
  "DELETE /questions/:questionId":       { action: "delete_question",         kind: "question" },
  "POST /:id/questions/import-docx":     { action: "import_questions_docx",   kind: "assessment" },
  "POST /:id/questions/bulk":            { action: "bulk_add_questions",      kind: "assessment" },
  "POST /:id/cover-page":                { action: "upload_cover_page",       kind: "assessment" },
  "DELETE /:id/cover-page":              { action: "delete_cover_page",       kind: "assessment" },
  "POST /questions/:questionId/images":  { action: "upload_question_images",  kind: "question" },
  "DELETE /questions/:questionId/images/:imageId": { action: "delete_question_image", kind: "question" },

  /* ---- teacher: marking ---- */
  "GET /marking/submission/:id":         { action: "open_script_for_marking", kind: "submission", dedupeMs: 60000 },
  "GET /marking/:id":                    { action: "open_script_for_marking", kind: "submission", dedupeMs: 60000 },
  "GET /marking/all/:id":                { action: "open_all_scripts_for_marking", kind: "assessment", dedupeMs: 60000 },
  "POST /save-marking":                  { action: "save_marking",            kind: "answer" },
  "POST /save-marking/bulk":             { action: "save_marking_bulk",       kind: "none" },

  /* ---- admin ---- */
  "PUT /admin/:id/review":               { action: "review_assessment",       kind: "assessment" },
  "PUT /admin/:id/toggle-active":        { action: "start_stop_assessment",   kind: "assessment" },
  "PUT /admin/:id/desktop-only":         { action: "set_desktop_only",        kind: "assessment" },
  "PUT /admin/:id/security":             { action: "set_security_settings",   kind: "assessment" },
  "PUT /admin/:id/seb":                  { action: "set_seb_settings",        kind: "assessment" },
  "GET /admin/:id/attendance-pdf":      { action: "download_attendance_pdf", kind: "assessment" },
  "PUT /admin/device-access/:id/allow":  { action: "allow_device",            kind: "device_access" },
  "PUT /admin/device-access/:id/revoke": { action: "revoke_device",           kind: "device_access" },
  "PUT /admin/exam-sessions/:id/unlock": { action: "unlock_device",           kind: "session" },
  "POST /admin/resit":                   { action: "grant_resit",             kind: "body" },
  "POST /admin/resit/cancel":            { action: "cancel_resit",            kind: "body" },
  "POST /admin/assign-teacher":          { action: "assign_teacher",          kind: "body" },
  "POST /admin/assign-teachers-bulk":     { action: "assign_teachers_bulk",    kind: "body" },
  "POST /admin/assign-submission":       { action: "assign_submission",       kind: "submission_body" },
  "POST /admin/bulk-assign-submissions": { action: "bulk_assign_submissions", kind: "none" },
  "PUT /admin/remark-requests/:id/review": { action: "review_remark_request", kind: "submission" },
  "PUT /admin/release-marks":            { action: "release_marks",           kind: "body" },
  "PUT /admin/bulk-release-marks":       { action: "bulk_release_marks",      kind: "none" },
  "PUT /admin/grading-system":           { action: "update_grading_system",   kind: "none" },
  "DELETE /admin/delete-assessments":    { action: "delete_assessments",      kind: "none" },
  "DELETE /admin/delete-assignments":    { action: "delete_assignments",      kind: "none" },
};

/* ─────────────────────────── helpers ─────────────────────────── */
const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const SECRET_KEY = /pass(word)?|token|secret|answer|essay|authorization|html|highlight/i;

/** Safe, small summary of a body: drops secrets/answers, keeps counts. */
function sanitize(obj, depth = 0) {
  if (obj == null) return undefined;
  if (typeof obj === "string") return obj.length > 200 ? obj.slice(0, 200) + "…" : obj;
  if (typeof obj === "number" || typeof obj === "boolean") return obj;
  if (depth >= 2) return undefined;
  if (Array.isArray(obj)) {
    const prim = obj.every((x) => typeof x === "number" || typeof x === "string");
    return prim && obj.length <= 20 ? obj.map((x) => sanitize(x, depth + 1)) : { count: obj.length };
  }
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY.test(k)) {
        if (Array.isArray(v)) out[`${k}_count`] = v.length;
        else if (v && typeof v === "object") out[`${k}_count`] = Object.keys(v).length;
        continue; // never store the value itself
      }
      const s = sanitize(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

function portalFor(role) {
  if (role === "student") return "student";
  if (role === "teacher") return "teacher";
  return "admin";
}

function outcomeFor(status, code) {
  if (status < 400) return "success";
  if (status === 403 && code === "DEVICE_NOT_ALLOWED") return "device_blocked";
  if (status === 423) return "locked";
  if (status === 401 || status === 403) return "denied";
  if (status === 409) return "conflict";
  if (status >= 500) return "error";
  return "rejected"; // 400 / 404 / 422 …
}

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || req.socket?.remoteAddress || null;

/* ── in-memory de-dupe window (per server instance; losing it only means an extra row) ── */
const recent = new Map();
function seenRecently(key, windowMs) {
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < windowMs) return true;
  recent.set(key, now);
  if (recent.size > 5000) {
    for (const [k, t] of recent) if (now - t > 120000) recent.delete(k);
  }
  return false;
}

/* ─────────────────────────── writer ─────────────────────────── */
async function logActivity(pool, e) {
  try {
    await pool.request()
      .input("actor_id", sql.Int, e.actorId ?? null)
      .input("actor_role", sql.NVarChar(30), e.actorRole || null)
      .input("actor_username", sql.NVarChar(150), e.actorUsername || null)
      .input("portal", sql.NVarChar(20), e.portal || null)
      .input("action", sql.NVarChar(60), e.action)
      .input("outcome", sql.NVarChar(20), e.outcome || "success")
      .input("http_status", sql.Int, e.httpStatus ?? null)
      .input("assessment_id", sql.Int, e.assessmentId ?? null)
      .input("student_id", sql.Int, e.studentId ?? null)
      .input("target_id", sql.Int, e.targetId ?? null)
      .input("ip", sql.NVarChar(64), e.ip ? String(e.ip).slice(0, 64) : null)
      .input("device", sql.NVarChar(400), e.device ? String(e.device).slice(0, 400) : null)
      .input("details", sql.NVarChar(sql.MAX), e.details ? JSON.stringify(e.details) : null)
      .query(`
        INSERT INTO e_assessment_activity_log
          (actor_id, actor_role, actor_username, portal, action, outcome, http_status,
           assessment_id, student_id, target_id, ip, device, details)
        VALUES
          (@actor_id, @actor_role, @actor_username, @portal, @action, @outcome, @http_status,
           @assessment_id, @student_id, @target_id, @ip, @device, @details)
      `);
  } catch (err) {
    console.error("⚠️ e-assessment activity log write failed:", err.message);
  }
}

/* best-effort lookup of (assessment, student) for ids that only identify a child row */
async function resolveFromRow(pool, kind, id) {
  if (!id) return {};
  try {
    let q;
    if (kind === "session") q = `SELECT e_assessment_id AS aid, student_id AS sid FROM e_assessment_exam_sessions WHERE id = @id`;
    else if (kind === "submission") q = `SELECT e_assessment_id AS aid, student_id AS sid FROM e_assessment_submissions WHERE id = @id`;
    else if (kind === "answer") q = `SELECT TOP 1 s.e_assessment_id AS aid, s.student_id AS sid FROM e_assessment_answers a JOIN e_assessment_submissions s ON s.id = a.submission_id WHERE a.id = @id`;
    else if (kind === "question") q = `SELECT e_assessment_id AS aid, NULL AS sid FROM e_assessment_questions WHERE id = @id`;
    else if (kind === "token") q = `SELECT e_assessment_id AS aid, student_id AS sid FROM e_assessment_exam_sessions WHERE id = @id`;
    else return {};
    const r = await pool.request().input("id", sql.Int, id).query(q);
    const row = r.recordset[0];
    return row ? { assessmentId: row.aid || null, studentId: row.sid || null } : {};
  } catch {
    return {};
  }
}

async function resolveFromToken(pool, token) {
  if (!token) return {};
  try {
    const r = await pool.request().input("t", sql.Char(6), String(token).slice(0, 6))
      .query(`SELECT e_assessment_id AS aid, student_id AS sid FROM e_assessment_exam_sessions WHERE token = @t`);
    const row = r.recordset[0];
    return row ? { assessmentId: row.aid || null, studentId: row.sid || null } : {};
  } catch {
    return {};
  }
}

/* ─────────────────────────── middleware ─────────────────────────── */
/** router.param("questionId") hook: resolve the question's assessment BEFORE a
 *  delete handler removes the row (otherwise the log couldn't say which exam). */
async function preResolveQuestion(req, res, next, val) {
  try {
    const found = await resolveFromRow(req.pool, "question", toInt(val));
    if (found.assessmentId) req._auditAssessmentId = found.assessmentId;
  } catch { /* never block the request */ }
  next();
}

function activityLogger(req, res, next) {
  // Capture the response body's message/code so a failure's REASON is logged
  // (e.g. "Incorrect exam password") without any controller changes.
  let respMessage = null;
  let respCode = null;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    try {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        respMessage = body.message ? String(body.message).slice(0, 300) : null;
        respCode = body.code || null;
      }
    } catch { /* ignore */ }
    return origJson(body);
  };

  res.on("finish", () => {
    // Deliberately fire-and-forget, after the response has gone out.
    (async () => {
      try {
        const routePath = req.route?.path;
        if (!routePath) return;
        const def = ROUTE_ACTIONS[`${req.method} ${routePath}`];
        if (!def) return;

        const status = res.statusCode;
        const outcome = outcomeFor(status, respCode);
        if (def.onlyFailures && outcome === "success") return;

        const user = req.user || null;
        const auditActor = req.auditActor || null; // exam-login sets this (no JWT yet)
        const body = req.body && typeof req.body === "object" ? req.body : {};

        const actorRole = user?.role || (def.action === "exam_login" ? "student" : null);
        if (def.studentOnly && actorRole !== "student") return;

        const pool = req.auditPool || req.pool;
        if (!pool) return;

        /* ---- which assessment? ---- */
        let assessmentId = req._auditAssessmentId || req.auditAssessmentId || null;
        let studentId = null;
        const targetId = toInt(req.params?.id) || toInt(req.params?.questionId) || null;

        if (!assessmentId) {
          switch (def.kind) {
            case "assessment": assessmentId = toInt(req.params.id); break;
            case "body": assessmentId = toInt(body.assessment_id) || toInt(body.assessmentId); break;
            case "session": case "submission": {
              const f = await resolveFromRow(pool, def.kind, toInt(req.params.id));
              assessmentId = f.assessmentId || null; studentId = f.studentId || null; break;
            }
            case "submission_body": {
              const f = await resolveFromRow(pool, "submission", toInt(body.submissionId));
              assessmentId = f.assessmentId || null; studentId = f.studentId || null; break;
            }
            case "answer": {
              const firstAnswer = body.scores && typeof body.scores === "object" ? toInt(Object.keys(body.scores)[0]) : null;
              const f = await resolveFromRow(pool, "answer", firstAnswer);
              assessmentId = f.assessmentId || null; studentId = f.studentId || null; break;
            }
            case "token": {
              assessmentId = toInt(user?.examAssessmentId);
              if (!assessmentId) {
                const f = await resolveFromToken(pool, body.token);
                assessmentId = f.assessmentId || null; studentId = f.studentId || null;
              }
              break;
            }
            default: break;
          }
        }
        if (!assessmentId && user?.examOnly) assessmentId = toInt(user.examAssessmentId);
        if (!studentId && actorRole === "student") studentId = user?.id || auditActor?.id || null;
        if (!studentId) studentId = toInt(body.studentId) || toInt(body.student_id) || null;

        const actorId = user?.id ?? auditActor?.id ?? null;
        const actorUsername = user?.username || auditActor?.username || (def.action === "exam_login" ? String(body.username || "").slice(0, 150) : null);

        if (def.dedupeMs) {
          const key = [actorId || actorUsername, def.action, assessmentId, outcome].join("|");
          if (seenRecently(key, def.dedupeMs)) return;
        }

        /* ---- details: small, sanitized, never secrets/answers ---- */
        const details = {};
        const cleanBody = sanitize(body);
        if (cleanBody && Object.keys(cleanBody).length) details.request = cleanBody;
        if (def.action === "save_marking" && body.scores && typeof body.scores === "object") {
          const vals = Object.values(body.scores).map(Number).filter((n) => !Number.isNaN(n));
          details.questions_marked = vals.length;
          details.total_marks_given = vals.reduce((a, b) => a + b, 0);
        }
        if (def.action === "submit_exam" && Array.isArray(body.answers)) details.questions_in_submission = body.answers.length;
        if (respMessage) details.response = respMessage;
        if (req.params?.id && def.kind !== "assessment") details.param_id = toInt(req.params.id);
        const device = classifyDevice(req);
        details.platform = device.platform;

        await logActivity(pool, {
          actorId,
          actorRole,
          actorUsername,
          portal: portalFor(actorRole),
          action: def.action,
          outcome,
          httpStatus: status,
          assessmentId,
          studentId,
          targetId,
          ip: clientIp(req),
          device: req.get("user-agent") || null,
          details: Object.keys(details).length ? details : null,
        });
      } catch (err) {
        console.error("⚠️ activityLogger error:", err.message);
      }
    })();
  });

  next();
}

/* ─────────────────────────── viewer query ─────────────────────────── */
/**
 * Filters: assessmentId, portal (student|teacher|admin), action, outcome,
 *          actor (matches name or username), from, to (ISO dates), page, limit.
 * Actor/student display names are joined from the right table per role.
 */
async function queryActivityLog(pool, f = {}, { forCsv = false } = {}) {
  const limit = forCsv ? 5000 : Math.min(Math.max(toInt(f.limit) || 50, 1), 200);
  const page = Math.max(toInt(f.page) || 1, 1);
  const offset = forCsv ? 0 : (page - 1) * limit;

  const req = pool.request();
  const where = [];
  if (toInt(f.assessmentId)) { req.input("aid", sql.Int, toInt(f.assessmentId)); where.push("l.assessment_id = @aid"); }
  if (f.portal && ["student", "teacher", "admin"].includes(f.portal)) { req.input("portal", sql.NVarChar(20), f.portal); where.push("l.portal = @portal"); }
  if (f.action) { req.input("action", sql.NVarChar(60), String(f.action).slice(0, 60)); where.push("l.action = @action"); }
  if (f.outcome) { req.input("outcome", sql.NVarChar(20), String(f.outcome).slice(0, 20)); where.push("l.outcome = @outcome"); }
  if (f.actor) {
    req.input("actor", sql.NVarChar(160), `%${String(f.actor).slice(0, 150)}%`);
    where.push("(l.actor_username LIKE @actor OR st.name LIKE @actor OR te.name LIKE @actor OR us.name LIKE @actor)");
  }
  if (f.from) { const d = new Date(f.from); if (!isNaN(d)) { req.input("from", sql.DateTime, d); where.push("l.created_at >= @from"); } }
  if (f.to) { const d = new Date(f.to); if (!isNaN(d)) { d.setHours(23, 59, 59, 999); req.input("to", sql.DateTime, d); where.push("l.created_at <= @to"); } }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const from = `
    FROM e_assessment_activity_log l
    LEFT JOIN Students  st ON l.actor_role = 'student' AND st.id = l.actor_id
    LEFT JOIN Teachers  te ON l.actor_role = 'teacher' AND te.id = l.actor_id
    LEFT JOIN Users     us ON l.actor_role NOT IN ('student','teacher') AND us.id = l.actor_id
    LEFT JOIN Students  tgt ON tgt.id = l.student_id
    LEFT JOIN e_assessments ea ON ea.id = l.assessment_id
    ${whereSql}`;

  req.input("offset", sql.Int, offset);
  req.input("limit", sql.Int, limit);
  const result = await req.query(`
    SELECT l.id, l.created_at, l.portal, l.actor_id, l.actor_role, l.actor_username,
           COALESCE(st.name, te.name, us.name) AS actor_name,
           l.action, l.outcome, l.http_status, l.assessment_id, ea.title AS assessment_title,
           l.student_id, tgt.name AS student_name, tgt.username AS student_username,
           l.target_id, l.ip, l.device, l.details
    ${from}
    ORDER BY l.created_at DESC, l.id DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

    SELECT COUNT(*) AS total ${from};
  `);

  return { rows: result.recordsets[0], total: result.recordsets[1][0].total, page, limit };
}

module.exports = {
  ROUTE_ACTIONS,
  logActivity,
  activityLogger,
  preResolveQuestion,
  queryActivityLog,
  sanitize,
  outcomeFor,
};
