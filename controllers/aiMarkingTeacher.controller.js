const elig = require("../services/aiMarkingEligibility.service");
const { describeError } = require("../utils/safeLog");
const { estimateSeconds } = require("../services/aiMarkingWorker.service");
const { createSqlWorkerStore } = require("../services/aiMarkingWorker.store");
const jobs = require("../services/aiMarkingJobs.service");

/* =========================================================================
   AI MARKING — TEACHER-FACING READ ENDPOINTS (Phase 3)

   Mounted at /api/e-assessments/ai-marking behind protect + authorize("teacher")
   (routes/aiMarkingTeacher.js). Pool = req.pool, i.e. the authenticated
   request's own tenant database — a tenant key is NEVER read from the body
   or query string. The teacher id is req.user.id, never a client value.

   Phase 3 handlers (dashboard / selectable / preview) are read-only.
   Phase 4 adds the money-moving ones: createJob (confirm + reserve),
   listJobs / getJob (progress) and cancelJob. They take the teacher id from
   req.user.id, the tenant from req.pool, and never a count, price or tenant
   from the client. createJob is OFF unless AI_MARKING_JOBS_ENABLED=true,
   because nothing processes a job until Phase 5/6 and reserved credits
   would otherwise sit idle.
   Manual marking does not pass through this controller at all, so these
   endpoints being down, unpriced or unfunded cannot affect it.
========================================================================= */

function teacherIdOf(req) {
  const id = Number(req.user?.id);
  if (!Number.isInteger(id) || id < 1) { const e = new Error("Not authenticated"); e.statusCode = 401; throw e; }
  return id;
}

function jobsEnabled() {
  return String(process.env.AI_MARKING_JOBS_ENABLED || "").toLowerCase() === "true";
}

function sendError(res, err, fallback) {
  const status = err.statusCode || 500;
  if (status >= 500 && status !== 503) console.error("AI MARKING TEACHER ERROR:", describeError(err));
  // 503 from RESERVATION_UNCERTAIN carries a safe, deliberate message; other 5xx hide internals.
  const expose = status < 500 || err.code === "RESERVATION_UNCERTAIN";
  const body = { success: false, message: expose ? err.message : fallback, code: err.code };
  if (expose && err.details) body.details = err.details;   // e.g. the new count/price on QUOTE_CHANGED
  res.status(status).json(body);
}

/** GET /dashboard?eAssessmentId=&subject= */
const getDashboard = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    const selection = { eAssessmentId: req.query.eAssessmentId, subject: req.query.subject };
    const [counts, wallet] = await Promise.all([
      elig.dashboardCounts(req.pool, { teacherId, selection }),
      elig.teacherWalletSummary(req.pool),
    ]);
    res.json({ success: true, counts, wallet, aiProcessingEnabled: jobsEnabled() });
  } catch (err) { sendError(res, err, "Server error loading marking dashboard"); }
};

/** GET /selectable?eAssessmentId= */
const getSelectable = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    const data = await elig.resolveSelectable(req.pool, { teacherId, eAssessmentId: req.query.eAssessmentId ?? null });
    res.json({ success: true, ...data });
  } catch (err) { sendError(res, err, "Server error loading selectable work"); }
};

/**
 * Fill in the honest ETA from throughput MEASURED on finished jobs (null until there is enough data).
 * An estimate is a nicety: it must never be able to fail or slow a preview, so any problem leaves it null.
 */
async function withEstimate(pool, preview) {
  if (preview && preview.counts && preview.counts.billable > 0) {
    try { preview.estimatedSeconds = await estimateSeconds(createSqlWorkerStore(pool), preview.counts.billable); } catch { /* leave null */ }
  }
  return preview;
}

/** POST /preview  { eAssessmentId?, subject?, questionIds?, submissionIds?, studentIds? }  — no charge, no reservation */
const previewSelection = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    const preview = await elig.buildPreview(req.pool, { teacherId, selection: req.body || {} });
    await withEstimate(req.pool, preview);
    res.json({ success: true, preview });
  } catch (err) { sendError(res, err, "Server error building marking preview"); }
};

/**
 * POST /jobs
 * { ...selection, quoteFingerprint, idempotencyKey, confirm: true }
 * Confirms the quote the teacher saw: claims the answers, reserves the credits.
 * 201 = new job, 200 = same idempotencyKey replayed (no second charge).
 */
const createJob = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    if (!jobsEnabled()) {
      return res.status(503).json({ success: false, code: "FEATURE_DISABLED", message: "AI marking is not switched on yet. Manual marking is unaffected." });
    }
    const body = req.body || {};
    if (body.confirm !== true) {
      return res.status(400).json({ success: false, code: "CONFIRMATION_REQUIRED", message: "Explicit confirmation is required before credits are reserved." });
    }
    const { job, replayed } = await jobs.createJob(req.pool, {
      teacherId, selection: body, quoteFingerprint: body.quoteFingerprint, idempotencyKey: body.idempotencyKey,
    });
    res.status(replayed ? 200 : 201).json({ success: true, replayed, job });
  } catch (err) { sendError(res, err, "Server error starting AI marking"); }
};

/** GET /jobs — the teacher's own jobs, newest first */
const listJobs = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    res.json({ success: true, jobs: await jobs.listJobs(req.pool, { teacherId, limit: req.query.limit }) });
  } catch (err) { sendError(res, err, "Server error loading AI marking jobs"); }
};

/** GET /jobs/:id — progress; someone else's job is a 404 */
const getJob = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    res.json({ success: true, job: await jobs.getJob(req.pool, { jobId: req.params.id, teacherId }) });
  } catch (err) { sendError(res, err, "Server error loading AI marking job"); }
};

/** POST /jobs/:id/cancel — idempotent */
const cancelJob = async (req, res) => {
  try {
    const teacherId = teacherIdOf(req);
    const { job } = await jobs.cancelJob(req.pool, { jobId: req.params.id, teacherId });
    res.json({ success: true, job });
  } catch (err) { sendError(res, err, "Server error cancelling AI marking job"); }
};

module.exports = { withEstimate, getDashboard, getSelectable, previewSelection, createJob, listJobs, getJob, cancelJob, jobsEnabled };
