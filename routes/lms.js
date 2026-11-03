/* =========================================================================
   /api/lms  — first mounted LMS router (L1.4)
   Every route runs, in this order (master prompt rule 2 + 7):
     protect -> requireModule('lms','lms_core') -> [requireLmsPermission(...)]
   A tenant without the licence gets 403 MODULE_NOT_LICENSED before anything
   else runs. Later phases mount their routers under this one.
========================================================================= */
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { requireModule } = require("../utils/tenantModules");
const { requireLmsPermission, requireCourseAccess, getEffectivePermissions, courseRole, actorOf } = require("../utils/lmsPermissions");
const courses = require("../utils/lmsCourses");
const parts = require("../utils/lmsCourseParts");
const enrol = require("../utils/lmsEnrolment");
const copy = require("../utils/lmsCourseCopy");
const approval = require("../utils/lmsApproval");
const myCourses = require("../utils/lmsMyCourses");
const lessons = require("../utils/lmsLessons");
const progress = require("../utils/lmsProgress");
const offlineSync = require("../utils/lmsOfflineSync");
const offlineDrafts = require("../utils/lmsOfflineDrafts");
const offlineQuiz = require("../utils/lmsOfflineQuiz");
const offlineRetention = require("../utils/lmsOfflineRetention");
const prereq = require("../utils/lmsPrerequisites");
const outcomes = require("../utils/lmsOutcomes");
const announce = require("../utils/lmsAnnouncements");
const assignments = require("../utils/lmsAssignments");
const rubrics = require("../utils/lmsRubrics");
const qbank = require("../utils/lmsQuestionBank");
const quizzes = require("../utils/lmsQuizzes");
const quizRules = require("../utils/lmsQuizRules");
const quizAttempts = require("../utils/lmsQuizAttempts");
const flashcards = require("../utils/lmsFlashcards");
const quizGrading = require("../utils/lmsQuizGrading");
const resultsAdapter = require("../utils/lmsResultsAdapter");
const quizAnalytics = require("../utils/lmsQuizAnalytics");
const gradebook = require("../utils/lmsGradebook");
const gbExport = require("../utils/lmsGradebookExport");
const gbResults = require("../utils/lmsGradebookResults");
const certs = require("../utils/lmsCertificates");
const badges = require("../utils/lmsBadges");
const reports = require("../utils/lmsReports");
const packs = require("../utils/lmsOfflinePacks");
const analytics = require("../utils/lmsAnalytics");
const paths = require("../utils/lmsPaths");
const pathLearners = require("../utils/lmsPathLearners");
const competency = require("../utils/lmsCompetency");
const dashboards = require("../utils/lmsDashboards");
const disc = require("../utils/lmsDiscussions");
const help = require("../utils/lmsHelp");
const discMod = require("../utils/lmsDiscussionMod");
const groups = require("../utils/lmsGroups");
const peer = require("../utils/lmsPeerReview");
const peerL = require("../utils/lmsPeerReviewLearner");
const guardian = require("../utils/lmsGuardian");
const gbLinks = require("../utils/lmsGradebookLinks");
const gradeView = require("../utils/lmsGradeView");
const submissions = require("../utils/lmsSubmissions");
const groupMarking = require("../utils/lmsGroupMarking");
const marking = require("../utils/lmsMarking");
const media = require("../utils/lmsMedia");
const planner = require("../utils/lmsPlanner");
const dashboard = require("../utils/lmsDashboard");
const gradeRelease = require("../utils/lmsRelease");
const extensions = require("../utils/lmsExtensions");
const calFeed = require("../utils/lmsCalendarFeed");
const { getSettings, publicView, saveSettings } = require("../utils/lmsSettings");
const { listGrants, setGrants } = require("../utils/lmsGrants");
const { listAudit } = require("../utils/lmsAudit");
const { getUsage } = require("../utils/lmsUsage");

router.use(protect, requireModule("lms", "lms_core"));

const bad = (res, errors, code = 400) => res.status(code).json({ success: false, code: code === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", message: errors[0], errors });
const fail = (res, err, what) => { console.error(`LMS ${what} ERROR:`, err.message); res.status(500).json({ success: false, message: "Something went wrong. Please try again." }); };

/* Labels + upload limits: any signed-in user of a licensed tenant. */
router.get("/settings/public", async (req, res) => {
  try { res.json({ success: true, settings: publicView(await getSettings(req.pool)) }); } catch (e) { fail(res, e, "SETTINGS PUBLIC"); }
});

/* What can I do in the LMS? (drives menus; the server still re-checks every action) */
router.get("/me/permissions", async (req, res) => {
  try { res.json({ success: true, permissions: [...(await getEffectivePermissions(req.pool, req.user))].sort() }); } catch (e) { fail(res, e, "PERMISSIONS ME"); }
});

router.get("/settings", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try { res.json({ success: true, settings: await getSettings(req.pool) }); } catch (e) { fail(res, e, "SETTINGS GET"); }
});

router.put("/settings", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const r = await saveSettings(req.pool, req.user, req.body, req.tenant || req.user?.tenant);
    if (!r.ok) return bad(res, r.errors);
    res.json({ success: true, settings: r.settings });
  } catch (e) { fail(res, e, "SETTINGS PUT"); }
});

/* Read-only list so the admin can pick the tenant's grading scale (legacy GradingSystem table). */
router.get("/grading-systems", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const r = await req.pool.request().query(`SELECT TOP 100 id, systemName FROM GradingSystem ORDER BY systemName`);
    res.json({ success: true, gradingSystems: r.recordset });
  } catch (e) { console.error("LMS GRADING SYSTEMS ERROR:", e.message); res.json({ success: true, gradingSystems: [] }); }
});

router.get("/grants", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const r = await listGrants(req.pool, { userSource: req.query.userSource, userId: req.query.userId });
    if (!r.ok) return bad(res, r.errors);
    res.json({ success: true, permissionCodes: r.permissionCodes });
  } catch (e) { fail(res, e, "GRANTS GET"); }
});

router.put("/grants", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const r = await setGrants(req.pool, req.user, req.body || {});
    if (!r.ok) return bad(res, r.errors, r.notFound ? 404 : 400);
    res.json({ success: true, permissionCodes: r.permissionCodes });
  } catch (e) { fail(res, e, "GRANTS PUT"); }
});

/* Audit trail (newest first, keyset paginated: ?limit=50&beforeId=123&entity=&entityId=&action=). */
router.get("/audit", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const { rows, nextBeforeId } = await listAudit(req.pool, req.query);
    res.json({ success: true, entries: rows, nextBeforeId });
  } catch (e) { fail(res, e, "AUDIT"); }
});

/* Usage meters: storage vs quota, file count, active learners (30 days). */
router.get("/usage", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const settings = await getSettings(req.pool);
    res.json({ success: true, usage: await getUsage(req.pool, req.tenant || req.user?.tenant, settings.storageQuotaMb) });
  } catch (e) { fail(res, e, "USAGE"); }
});

/* ---- Courses (L2.1) ------------------------------------------------------
   Staff only for now; student "My courses" arrives with enrolment (L2.3/L2.6).
   Course-scoped routes check role AND membership; "not yours" and "does not
   exist" give the identical 403 (see requireCourseAccess). */
const tenantOf = (req) => req.tenant || req.user?.tenant;
const conflict = (res, errors) => res.status(409).json({ success: false, code: "COURSE_CONFLICT", message: errors[0], errors });
const rejected = (res, r) => (r.conflict ? conflict(res, r.errors) : r.notFound ? bad(res, r.errors, 404) : r.code ? res.status(409).json({ success: false, code: r.code, message: r.errors[0], errors: r.errors, ...(r.extra || {}) }) : bad(res, r.errors));

router.post("/courses", requireLmsPermission("lms.course.create"), async (req, res) => {
  try {
    const r = await courses.createCourse(req.pool, req.user, req.body, tenantOf(req));
    if (!r.ok) return rejected(res, r);
    res.status(201).json({ success: true, course: await courses.getCourse(req.pool, r.id) });
  } catch (e) { fail(res, e, "COURSE CREATE"); }
});

/* ?scope=mine (default) | all (LMS administrators only) &q=&status=&academicYear=&page=&pageSize= */
router.get("/courses", requireLmsPermission("lms.course.create", "lms.course.manage"), async (req, res) => {
  try {
    const scope = req.query.scope === "all" && req.lmsPermissions.has("lms.settings.manage") ? "all" : "mine";
    res.json({ success: true, scope, ...(await courses.listCourses(req.pool, req.user, { ...req.query, scope })) });
  } catch (e) { fail(res, e, "COURSE LIST"); }
});

router.get("/courses/:courseId", requireCourseAccess({ roles: ["owner", "co_teacher", "admin"] }), async (req, res) => {
  try {
    const course = await courses.getCourse(req.pool, Number(req.params.courseId));
    if (!course) return bad(res, ["Course not found."], 404);
    res.json({ success: true, course, myRole: req.courseRole });
  } catch (e) { fail(res, e, "COURSE GET"); }
});

router.patch("/courses/:courseId", requireLmsPermission("lms.course.manage"), requireCourseAccess({ roles: ["owner", "co_teacher", "admin"] }), async (req, res) => {
  try {
    const settings = await getSettings(req.pool);
    const r = await courses.updateCourse(req.pool, req.user, Number(req.params.courseId), req.body, { approvalRequired: settings.courseApprovalRequired, tenant: tenantOf(req) });
    if (!r.ok) return rejected(res, r);
    res.json({ success: true, course: await courses.getCourse(req.pool, Number(req.params.courseId)) });
  } catch (e) { fail(res, e, "COURSE PATCH"); }
});

/* Owner or LMS administrator only (a co-teacher cannot delete the course). */
router.delete("/courses/:courseId", requireLmsPermission("lms.course.manage"), requireCourseAccess({ roles: ["owner", "admin"] }), async (req, res) => {
  try {
    const r = await courses.deleteCourse(req.pool, req.user, Number(req.params.courseId));
    if (!r.ok) return rejected(res, r);
    res.json({ success: true });
  } catch (e) { fail(res, e, "COURSE DELETE"); }
});

/* ---- Sections, co-teachers, calendar (L2.2) -------------------------------
   Staff-side. Section/event ids are always matched together with the course id
   in the URL, so an id from another course or school finds nothing. */
const staffAccess = requireCourseAccess({ roles: ["owner", "co_teacher", "admin"] });
const ownerAccess = requireCourseAccess({ roles: ["owner", "admin"] });
const manage = requireLmsPermission("lms.course.manage");
const cid = (req) => Number(req.params.courseId);
const subId = (req, name) => parts.posInt(req.params[name]);
const send = (res, r, okBody, okStatus = 200) => (r.ok ? res.status(okStatus).json({ success: true, ...okBody }) : rejected(res, r));
const bad404 = (res) => bad(res, ["Not found."], 404);

router.get("/courses/:courseId/sections", staffAccess, async (req, res) => {
  try { res.json({ success: true, sections: await parts.listSections(req.pool, cid(req)) }); } catch (e) { fail(res, e, "SECTION LIST"); }
});
router.post("/courses/:courseId/sections", manage, staffAccess, async (req, res) => {
  try { const r = await parts.createSection(req.pool, req.user, cid(req), req.body); send(res, r, { section: r.section }, 201); } catch (e) { fail(res, e, "SECTION CREATE"); }
});
/* Declared before /:sectionId so "order" is never read as an id. */
router.put("/courses/:courseId/sections/order", manage, staffAccess, async (req, res) => {
  try { const r = await parts.reorderSections(req.pool, req.user, cid(req), req.body?.ids); if (!r.ok) return rejected(res, r); res.json({ success: true, sections: await parts.listSections(req.pool, cid(req)) }); } catch (e) { fail(res, e, "SECTION ORDER"); }
});
router.patch("/courses/:courseId/sections/:sectionId", manage, staffAccess, async (req, res) => {
  try { const id = subId(req, "sectionId"); if (!id) return bad404(res); const r = await parts.updateSection(req.pool, req.user, cid(req), id, req.body); send(res, r, { section: r.section }); } catch (e) { fail(res, e, "SECTION PATCH"); }
});
router.delete("/courses/:courseId/sections/:sectionId", manage, staffAccess, async (req, res) => {
  try { const id = subId(req, "sectionId"); if (!id) return bad404(res); send(res, await parts.deleteSection(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "SECTION DELETE"); }
});

/* Co-teachers: only the owner (or an LMS administrator) may change who teaches the course. */
router.post("/courses/:courseId/staff", manage, ownerAccess, async (req, res) => {
  try { const r = await parts.addCoTeacher(req.pool, req.user, cid(req), req.body); if (!r.ok) return rejected(res, r); res.status(201).json({ success: true, course: await courses.getCourse(req.pool, cid(req)) }); } catch (e) { fail(res, e, "COTEACHER ADD"); }
});
router.delete("/courses/:courseId/staff/:source/:userId", manage, ownerAccess, async (req, res) => {
  try { const r = await parts.removeCoTeacher(req.pool, req.user, cid(req), req.params.source, req.params.userId); if (!r.ok) return rejected(res, r); res.json({ success: true, course: await courses.getCourse(req.pool, cid(req)) }); } catch (e) { fail(res, e, "COTEACHER REMOVE"); }
});

/* Calendar: ?from=&to= (ISO, max 400 days; default 30 days back to 180 ahead). */
router.get("/courses/:courseId/calendar", staffAccess, async (req, res) => {
  try { const r = await parts.listEvents(req.pool, cid(req), { from: req.query.from, to: req.query.to }); if (!r.ok) return bad(res, r.errors); res.json({ success: true, events: r.events }); } catch (e) { fail(res, e, "CALENDAR LIST"); }
});
router.post("/courses/:courseId/calendar", manage, staffAccess, async (req, res) => {
  try { const r = await parts.createEvent(req.pool, req.user, cid(req), req.body); send(res, r, { event: r.event }, 201); } catch (e) { fail(res, e, "CALENDAR CREATE"); }
});
router.patch("/courses/:courseId/calendar/:eventId", manage, staffAccess, async (req, res) => {
  try { const id = subId(req, "eventId"); if (!id) return bad404(res); const r = await parts.updateEvent(req.pool, req.user, cid(req), id, req.body); send(res, r, { event: r.event }); } catch (e) { fail(res, e, "CALENDAR PATCH"); }
});
router.delete("/courses/:courseId/calendar/:eventId", manage, staffAccess, async (req, res) => {
  try { const id = subId(req, "eventId"); if (!id) return bad404(res); send(res, await parts.deleteEvent(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "CALENDAR DELETE"); }
});

/* ---- Enrolment (L2.3) -------------------------------------------------------
   Staff side: the course owner / co-teacher / LMS administrator, OR anyone holding
   lms.enrolment.manage (a registrar-type grant that works across courses; decision D-022).
   Student side: self-enrol / self-withdraw follow the tenant's enrolment mode
   (open | approval | closed) and only work for published, listed courses. */
const ENROL_ROLES = ["owner", "co_teacher", "admin"];
const enrolEntry = requireLmsPermission("lms.course.manage", "lms.enrolment.manage");
const denyCourse = (res) => res.status(403).json({ success: false, code: "COURSE_ACCESS_DENIED", message: "You do not have access to this course." });
async function canManageEnrolment(req, courseId) {
  const role = await courseRole(req.pool, req.user, courseId);
  return { role, ok: ENROL_ROLES.includes(role) || (req.lmsPermissions && req.lmsPermissions.has("lms.enrolment.manage")) };
}
const enrolAccess = async (req, res, next) => {
  try {
    const a = await canManageEnrolment(req, req.params.courseId);
    if (!a.ok) return denyCourse(res);
    req.courseRole = a.role || "enrolment_manager";
    next();
  } catch (e) { fail(res, e, "ENROLMENT ACCESS"); }
};
const CLIENT_CODES = new Set(["CSV_TOO_LARGE", "CSV_NO_HEADER", "CSV_TOO_MANY_ROWS", "CLASS_REQUIRED", "CLASS_NOT_FOUND"]);
const enrolRejected = (res, r) => {
  const body = { success: false, code: r.code || (r.notFound ? "NOT_FOUND" : "VALIDATION_ERROR"), message: r.errors[0], errors: r.errors };
  if (r.forbidden) return res.status(403).json(body);
  if (r.notFound) return res.status(404).json(body);
  if (r.conflict || (r.code && !CLIENT_CODES.has(r.code))) return res.status(409).json(body);
  return res.status(400).json(body);
};
const enrolSend = (res, r, extra = {}, status = 200) => (r.ok ? res.status(status).json({ success: true, ...(r.summary ? { report: r } : {}), ...extra }) : enrolRejected(res, r));
const studentParam = (req) => enrol.posInt(req.params.studentId);

/* Roster + history (declared before the /:studentId routes). ?status=&q=&page=&pageSize= */
router.get("/courses/:courseId/enrolments", enrolEntry, enrolAccess, async (req, res) => {
  try { const r = await enrol.listRoster(req.pool, cid(req), req.query); if (!r.ok) return bad(res, r.errors); res.json({ success: true, page: r.page, pageSize: r.pageSize, total: r.total, students: r.students }); } catch (e) { fail(res, e, "ENROLMENT LIST"); }
});
router.get("/courses/:courseId/enrolments/history", enrolEntry, enrolAccess, async (req, res) => {
  try { const r = await enrol.listHistory(req.pool, cid(req), req.query); if (!r.ok) return bad(res, r.errors); res.json({ success: true, entries: r.entries, nextBeforeId: r.nextBeforeId }); } catch (e) { fail(res, e, "ENROLMENT HISTORY"); }
});
router.post("/courses/:courseId/enrolments", enrolEntry, enrolAccess, async (req, res) => {
  try { enrolSend(res, await enrol.enrolStudents(req.pool, req.user, cid(req), req.body), {}, 201); } catch (e) { fail(res, e, "ENROLMENT ADD"); }
});
/* { csv: "admissionNo\nADM001\n...", dryRun?: true } -> validation/error report with line numbers */
router.post("/courses/:courseId/enrolments/bulk", enrolEntry, enrolAccess, async (req, res) => {
  try { enrolSend(res, await enrol.bulkEnrol(req.pool, req.user, cid(req), req.body)); } catch (e) { fail(res, e, "ENROLMENT BULK"); }
});
/* { className?: "...", dryRun?: true } (defaults to the course's class) */
router.post("/courses/:courseId/enrolments/class-list", enrolEntry, enrolAccess, async (req, res) => {
  try { enrolSend(res, await enrol.enrolClassList(req.pool, req.user, cid(req), req.body)); } catch (e) { fail(res, e, "ENROLMENT CLASS LIST"); }
});
for (const action of ["withdraw", "approve", "decline"]) {
  router.post(`/courses/:courseId/enrolments/:studentId/${action}`, enrolEntry, enrolAccess, async (req, res) => {
    try { const id = studentParam(req); if (!id) return bad404(res); enrolSend(res, await enrol.changeStatus(req.pool, req.user, cid(req), id, action), { status: undefined }); } catch (e) { fail(res, e, `ENROLMENT ${action.toUpperCase()}`); }
  });
}
/* The caller must be allowed to manage BOTH courses. */
router.post("/courses/:courseId/enrolments/:studentId/transfer", enrolEntry, enrolAccess, async (req, res) => {
  try {
    const id = studentParam(req); if (!id) return bad404(res);
    const to = enrol.posInt(req.body?.toCourseId);
    if (to && to !== cid(req) && !(await canManageEnrolment(req, to)).ok) return denyCourse(res);
    enrolSend(res, await enrol.transferStudent(req.pool, req.user, cid(req), req.body, id));
  } catch (e) { fail(res, e, "ENROLMENT TRANSFER"); }
});

/* Students: any signed-in student of a licensed tenant may ask; the service refuses anything but published + listed courses.
   studentOnly runs first so staff and other roles are refused before any query. */
const studentOnly = (req, res, next) => { const a = actorOf(req.user); return a && a.source === "Students" && a.role === "student" ? next() : denyCourse(res); };
router.post("/courses/:courseId/enrol", studentOnly, async (req, res) => {
  try {
    const mode = (await getSettings(req.pool)).enrolment.defaultMode;
    const r = await enrol.selfEnrol(req.pool, req.user, cid(req), mode);
    r.ok ? res.status(201).json({ success: true, status: r.status }) : enrolRejected(res, r);
  } catch (e) { fail(res, e, "SELF ENROL"); }
});
/* ---- Student course lists (L2.6a) -------------------------------------------
   The student id always comes from the token. studentOnly refuses staff before any query runs.
   GET /my/courses     ?q=&academicYear=&includeArchived=1&page=&pageSize=   enrolled + requested
   GET /catalogue      ?q=&academicYear=&page=&pageSize=                     published + listed, not yet joined */
router.get("/my/courses", studentOnly, async (req, res) => {
  try {
    const r = await myCourses.listMyCourses(req.pool, req.user, req.query);
    r.ok ? res.json({ success: true, page: r.page, pageSize: r.pageSize, total: r.total, items: r.items }) : enrolRejected(res, r);
  } catch (e) { fail(res, e, "MY COURSES"); }
});
router.get("/catalogue", studentOnly, async (req, res) => {
  try {
    const mode = (await getSettings(req.pool)).enrolment.defaultMode;
    const r = await myCourses.listCatalogue(req.pool, req.user, mode, req.query);
    r.ok ? res.json({ success: true, page: r.page, pageSize: r.pageSize, total: r.total, enrolmentMode: r.enrolmentMode, items: r.items }) : enrolRejected(res, r);
  } catch (e) { fail(res, e, "CATALOGUE"); }
});

router.post("/courses/:courseId/withdraw", studentOnly, async (req, res) => {
  try { const r = await enrol.selfWithdraw(req.pool, req.user, cid(req)); r.ok ? res.json({ success: true }) : enrolRejected(res, r); } catch (e) { fail(res, e, "SELF WITHDRAW"); }
});

/* ---- Templates, duplicate, rollover (L2.4) ----------------------------------
   Templates: private to the creator unless shared with the school; only the creator or an LMS
   administrator can change or delete one. Creating a course from a template or duplicating a course needs
   lms.course.create; duplicating also needs staff access to the SOURCE course. Rollover is LMS-administrator only.
   Everything created is a DRAFT owned by the caller (rollover: staff copied unless told not to). */
const isLmsAdmin = (req) => !!(req.lmsPermissions && req.lmsPermissions.has("lms.settings.manage"));
const createCourse = requireLmsPermission("lms.course.create");
const tplId = (req) => copy.posInt(req.params.templateId);

router.get("/course-templates", createCourse, async (req, res) => {
  try { res.json({ success: true, ...(await copy.listTemplates(req.pool, req.user, { ...req.query, isAdmin: isLmsAdmin(req) })) }); } catch (e) { fail(res, e, "TEMPLATE LIST"); }
});
router.get("/course-templates/:templateId", createCourse, async (req, res) => {
  try { const id = tplId(req); if (!id) return bad404(res); const t = await copy.getTemplate(req.pool, req.user, id, isLmsAdmin(req)); if (!t) return bad(res, ["Template not found."], 404); res.json({ success: true, template: t }); } catch (e) { fail(res, e, "TEMPLATE GET"); }
});
router.patch("/course-templates/:templateId", createCourse, async (req, res) => {
  try { const id = tplId(req); if (!id) return bad404(res); const r = await copy.updateTemplate(req.pool, req.user, id, req.body, isLmsAdmin(req)); send(res, r, { template: r.template }); } catch (e) { fail(res, e, "TEMPLATE PATCH"); }
});
router.delete("/course-templates/:templateId", createCourse, async (req, res) => {
  try { const id = tplId(req); if (!id) return bad404(res); send(res, await copy.deleteTemplate(req.pool, req.user, id, isLmsAdmin(req)), {}); } catch (e) { fail(res, e, "TEMPLATE DELETE"); }
});
router.post("/courses/from-template", createCourse, async (req, res) => {
  try {
    const r = await copy.createFromTemplate(req.pool, req.user, req.body, { isAdmin: isLmsAdmin(req), tenant: tenantOf(req) });
    if (!r.ok) return rejected(res, r);
    res.status(201).json({ success: true, course: await courses.getCourse(req.pool, r.id) });
  } catch (e) { fail(res, e, "COURSE FROM TEMPLATE"); }
});
router.post("/courses/:courseId/save-as-template", createCourse, staffAccess, async (req, res) => {
  try { const r = await copy.saveAsTemplate(req.pool, req.user, cid(req), req.body); send(res, r, { template: r.template }, 201); } catch (e) { fail(res, e, "SAVE AS TEMPLATE"); }
});
router.post("/courses/:courseId/duplicate", createCourse, staffAccess, async (req, res) => {
  try {
    const r = await copy.duplicateCourse(req.pool, req.user, cid(req), req.body, tenantOf(req));
    if (!r.ok) return rejected(res, r);
    res.status(201).json({ success: true, course: await courses.getCourse(req.pool, r.id) });
  } catch (e) { fail(res, e, "COURSE DUPLICATE"); }
});
/* { fromYear, toYear, courseIds?, copyStaff? (default true), copyEnrolments? (default false), dryRun? } */
router.post("/rollover", requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try {
    const r = await copy.rolloverCourses(req.pool, req.user, req.body, tenantOf(req));
    if (!r.ok) return rejected(res, r);
    res.json({ success: true, report: { dryRun: r.dryRun, summary: r.summary, courses: r.courses } });
  } catch (e) { fail(res, e, "ROLLOVER"); }
});

/* ---- Course approval (L2.5) ---------------------------------------------------
   Only meaningful when the tenant setting courseApprovalRequired is on. Teachers (course staff) submit and
   withdraw; reviewers holding lms.course.approve approve or return ANY course (they need not be on it: D-030).
   The person who submitted a course cannot approve it unless they are an LMS administrator. */
const approver = requireLmsPermission("lms.course.approve");
const apRejected = (res, r) => (r.forbidden ? res.status(403).json({ success: false, code: r.code, message: r.errors[0], errors: r.errors }) : rejected(res, r));
const apSend = async (req, res, r) => (r.ok ? res.json({ success: true, course: await courses.getCourse(req.pool, cid(req)) }) : apRejected(res, r));

router.post("/courses/:courseId/submit", manage, staffAccess, async (req, res) => {
  try { const s = await getSettings(req.pool); await apSend(req, res, await approval.submitForApproval(req.pool, req.user, cid(req), { approvalRequired: s.courseApprovalRequired })); } catch (e) { fail(res, e, "APPROVAL SUBMIT"); }
});
router.post("/courses/:courseId/withdraw-submission", manage, staffAccess, async (req, res) => {
  try { await apSend(req, res, await approval.withdrawSubmission(req.pool, req.user, cid(req))); } catch (e) { fail(res, e, "APPROVAL WITHDRAW"); }
});
router.post("/courses/:courseId/approve", approver, async (req, res) => {
  try { await apSend(req, res, await approval.approveCourse(req.pool, req.user, cid(req), req.body, { isAdmin: isLmsAdmin(req), tenant: tenantOf(req) })); } catch (e) { fail(res, e, "APPROVAL APPROVE"); }
});
router.post("/courses/:courseId/return", approver, async (req, res) => {
  try { await apSend(req, res, await approval.returnCourse(req.pool, req.user, cid(req), req.body)); } catch (e) { fail(res, e, "APPROVAL RETURN"); }
});
/* Reviewer queue (?q=&page=&pageSize=) */
router.get("/course-approvals", approver, async (req, res) => {
  try { res.json({ success: true, ...(await approval.listPending(req.pool, req.query)) }); } catch (e) { fail(res, e, "APPROVAL QUEUE"); }
});
/* History: course staff, LMS administrators, or reviewers (access check is its own middleware, like enrolAccess). */
const approvalViewAccess = async (req, res, next) => {
  try {
    const have = await getEffectivePermissions(req.pool, req.user);
    const role = have.has("lms.course.approve") ? "reviewer" : await courseRole(req.pool, req.user, cid(req));
    if (!role || !["reviewer", "owner", "co_teacher", "admin"].includes(role)) return denyCourse(res);
    next();
  } catch (e) { fail(res, e, "APPROVAL ACCESS"); }
};
router.get("/courses/:courseId/approval", approvalViewAccess, async (req, res) => {
  try { res.json({ success: true, history: await approval.listHistory(req.pool, cid(req)) }); } catch (e) { fail(res, e, "APPROVAL HISTORY"); }
});

/* ---- Lessons and lesson content (L3.1a) -------------------------------------
   Staff: owner / co-teacher / LMS admin who also hold lms.lesson.edit (teachers do by default).
   Lesson ids are always matched together with the course id in the URL. Text blocks are rebuilt from an
   allow-list on every save; media blocks only accept this school's LMS uploads or YouTube/Vimeo links.
   Students (studentOnly + ACTIVE enrolment): published lessons of a published/archived course only. */
const editLesson = requireLmsPermission("lms.lesson.edit");
const studentAccess = requireCourseAccess({ roles: ["student"] });
const lessonId = (req) => parts.posInt(req.params.lessonId);
const L = "/courses/:courseId/lessons";

router.get(L, staffAccess, async (req, res) => {
  try { res.json({ success: true, lessons: await lessons.listLessons(req.pool, cid(req)) }); } catch (e) { fail(res, e, "LESSON LIST"); }
});
router.post(L, editLesson, staffAccess, async (req, res) => {
  try { const r = await lessons.createLesson(req.pool, req.user, cid(req), req.body); send(res, r, { lesson: r.lesson }, 201); } catch (e) { fail(res, e, "LESSON CREATE"); }
});
/* Declared before /:lessonId so "order" is never read as an id. */
router.put(`${L}/order`, editLesson, staffAccess, async (req, res) => {
  try {
    const r = await lessons.reorderLessons(req.pool, req.user, cid(req), req.body?.sectionId ?? null, req.body?.ids);
    if (!r.ok) return rejected(res, r);
    res.json({ success: true, lessons: await lessons.listLessons(req.pool, cid(req)) });
  } catch (e) { fail(res, e, "LESSON ORDER"); }
});
router.get(`${L}/:lessonId`, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await lessons.getLesson(req.pool, cid(req), id); send(res, r, { lesson: r.lesson, blocks: r.blocks }); } catch (e) { fail(res, e, "LESSON GET"); }
});
router.patch(`${L}/:lessonId`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await lessons.updateLesson(req.pool, req.user, cid(req), id, req.body, tenantOf(req)); send(res, r, { lesson: r.lesson }); } catch (e) { fail(res, e, "LESSON PATCH"); }
});
router.delete(`${L}/:lessonId`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); send(res, await lessons.deleteLesson(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "LESSON DELETE"); }
});
router.put(`${L}/:lessonId/content`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await lessons.saveBlocks(req.pool, req.user, cid(req), id, req.body, tenantOf(req)); send(res, r, { contentVersion: r.contentVersion, blocks: r.blocks }); } catch (e) { fail(res, e, "LESSON CONTENT"); }
});

/* L3.3a: history, restore and student preview. Reading = any course staff; restoring needs lms.lesson.edit.
   versionNo is a plain positive integer; anything else is "not found". */
const versionNo = (req) => parts.posInt(req.params.versionNo);
router.get(`${L}/:lessonId/versions`, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await lessons.listVersions(req.pool, cid(req), id); send(res, r, { versions: r.versions }); } catch (e) { fail(res, e, "LESSON VERSIONS"); }
});
router.get(`${L}/:lessonId/versions/:versionNo`, staffAccess, async (req, res) => {
  try { const id = lessonId(req), n = versionNo(req); if (!id || !n) return bad404(res); const r = await lessons.getVersion(req.pool, cid(req), id, n, tenantOf(req)); send(res, r, { version: r.version, blocks: r.blocks }); } catch (e) { fail(res, e, "LESSON VERSION"); }
});
router.post(`${L}/:lessonId/versions/:versionNo/restore`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req), n = versionNo(req); if (!id || !n) return bad404(res); const r = await lessons.restoreVersion(req.pool, req.user, cid(req), id, n, req.body, tenantOf(req)); send(res, r, { contentVersion: r.contentVersion, blocks: r.blocks }); } catch (e) { fail(res, e, "LESSON RESTORE"); }
});
router.get(`${L}/:lessonId/prerequisites`, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await prereq.getPrerequisites(req.pool, cid(req), id); send(res, r, { prerequisites: r.prerequisites }); } catch (e) { fail(res, e, "PREREQ GET"); }
});
router.put(`${L}/:lessonId/prerequisites`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await prereq.setPrerequisites(req.pool, req.user, cid(req), id, req.body); send(res, r, { prerequisites: r.prerequisites }); } catch (e) { fail(res, e, "PREREQ SET"); }
});
/* ---- Learning outcomes + lesson tags (L3.6) ----------------------------------
   Reading the list (to tag lessons) needs lms.lesson.edit; creating/editing/retiring/importing needs lms.settings.manage (LMS admin).
   /outcomes/import is registered before /outcomes/:outcomeId so it can never be read as an id. */
const manageOutcomes = requireLmsPermission("lms.settings.manage");
const outcomeId = (req) => parts.posInt(req.params.outcomeId);
router.get("/outcomes", editLesson, async (req, res) => {
  try { res.json({ success: true, ...(await outcomes.listOutcomes(req.pool, { q: req.query.q, parent: req.query.parent, page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "OUTCOMES LIST"); }
});
router.post("/outcomes/import", manageOutcomes, async (req, res) => {
  try { const r = await outcomes.importOutcomes(req.pool, req.user, req.body); send(res, r, { dryRun: r.dryRun, summary: r.summary, created: r.created, updated: r.updated, failed: r.failed }); } catch (e) { fail(res, e, "OUTCOMES IMPORT"); }
});
router.post("/outcomes", manageOutcomes, async (req, res) => {
  try { const r = await outcomes.createOutcome(req.pool, req.user, req.body); send(res, r, { outcome: r.outcome }, 201); } catch (e) { fail(res, e, "OUTCOME CREATE"); }
});
router.get("/outcomes/:outcomeId", editLesson, async (req, res) => {
  try { const id = outcomeId(req); if (!id) return bad404(res); const r = await outcomes.getOutcome(req.pool, id); send(res, r, { outcome: r.outcome }); } catch (e) { fail(res, e, "OUTCOME GET"); }
});
router.patch("/outcomes/:outcomeId", manageOutcomes, async (req, res) => {
  try { const id = outcomeId(req); if (!id) return bad404(res); const r = await outcomes.updateOutcome(req.pool, req.user, id, req.body); send(res, r, { outcome: r.outcome }); } catch (e) { fail(res, e, "OUTCOME PATCH"); }
});
router.delete("/outcomes/:outcomeId", manageOutcomes, async (req, res) => {
  try { const id = outcomeId(req); if (!id) return bad404(res); send(res, await outcomes.deleteOutcome(req.pool, req.user, id), {}); } catch (e) { fail(res, e, "OUTCOME DELETE"); }
});
router.get(`${L}/:lessonId/outcomes`, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await outcomes.getLessonOutcomes(req.pool, cid(req), id); send(res, r, { outcomes: r.outcomes }); } catch (e) { fail(res, e, "LESSON OUTCOMES GET"); }
});
router.put(`${L}/:lessonId/outcomes`, editLesson, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await outcomes.setLessonOutcomes(req.pool, req.user, cid(req), id, req.body); send(res, r, { outcomes: r.outcomes }); } catch (e) { fail(res, e, "LESSON OUTCOMES SET"); }
});
router.get(`${L}/:lessonId/preview`, staffAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await lessons.previewLesson(req.pool, cid(req), id); send(res, r, { lesson: r.lesson, blocks: r.blocks, preview: r.preview }); } catch (e) { fail(res, e, "LESSON PREVIEW"); }
});

router.get("/courses/:courseId/learn/lessons", studentOnly, studentAccess, async (req, res) => {
  try { const r = await prereq.studentListView(req.pool, cid(req), Number(req.user.id)); send(res, r, { sections: r.sections, unsectioned: r.unsectioned }); } catch (e) { fail(res, e, "LEARN LIST"); }
});
router.get("/courses/:courseId/learn/lessons/:lessonId", studentOnly, studentAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await prereq.studentLessonView(req.pool, cid(req), id, Number(req.user.id)); send(res, r, { lesson: r.lesson, blocks: r.blocks }); } catch (e) { fail(res, e, "LEARN GET"); }
});

/* ---- Lesson progress and completion rules (L3.4a) ---------------------------
   Students only (studentOnly + ACTIVE enrolment). The student id always comes from the token, never the URL or body. */
router.post("/courses/:courseId/learn/lessons/:lessonId/view", studentOnly, studentAccess, async (req, res) => {
  try { const id = lessonId(req); if (!id) return bad404(res); const r = await progress.recordView(req.pool, cid(req), id, Number(req.user.id), req.body, tenantOf(req)); send(res, r, { recorded: r.recorded, progress: r.progress, completionRule: r.rule }); } catch (e) { fail(res, e, "LESSON VIEW"); }
});
router.post("/courses/:courseId/learn/lessons/:lessonId/complete", studentOnly, studentAccess, async (req, res) => {
  try {
    const id = lessonId(req); if (!id) return bad404(res);
    const r = await progress.markComplete(req.pool, cid(req), id, Number(req.user.id), tenantOf(req));
    send(res, r, { progress: r.progress, newlyCompleted: r.newlyCompleted });
  } catch (e) { fail(res, e, "LESSON COMPLETE"); }
});
router.get("/courses/:courseId/learn/progress", studentOnly, studentAccess, async (req, res) => {
  try { const r = await progress.courseProgress(req.pool, cid(req), Number(req.user.id)); send(res, r, { percent: r.percent, completed: r.completed, total: r.total, lessons: r.lessons, resumeLessonId: r.resumeLessonId }); } catch (e) { fail(res, e, "LEARN PROGRESS"); }
});

/* ---- Lesson media (L3.2a) ---------------------------------------------------
   POST /courses/:id/media (multipart field "file"), GET list, DELETE. Same access as lesson editing.
   Order matters: licence gate -> permission -> course membership -> upload parsing, so a refused user
   never gets a byte read. The file's real bytes must match its extension; see utils/lmsMedia.js. */
const MEDIA_STATUS = { NO_FILE: 400, FILE_TYPE_NOT_ALLOWED: 400, FILE_CONTENT_MISMATCH: 400, FILE_REJECTED: 400, FILE_TOO_LARGE: 413, LMS_STORAGE_QUOTA_EXCEEDED: 507 };
const mediaRejected = (res, r) => (MEDIA_STATUS[r.code] ? res.status(MEDIA_STATUS[r.code]).json({ success: false, code: r.code, message: r.errors[0], errors: r.errors }) : rejected(res, r));
router.post("/courses/:courseId/media", editLesson, staffAccess, media.uploadMiddleware(getSettings), async (req, res) => {
  try {
    const r = await media.uploadMedia(req.pool, req.user, cid(req), req.file, await getSettings(req.pool), tenantOf(req));
    r.ok ? res.status(201).json({ success: true, file: r.file }) : mediaRejected(res, r);
  } catch (e) { fail(res, e, "MEDIA UPLOAD"); }
});
router.get("/courses/:courseId/media", staffAccess, async (req, res) => {
  try { res.json({ success: true, ...(await media.listMedia(req.pool, cid(req), req.query)) }); } catch (e) { fail(res, e, "MEDIA LIST"); }
});
router.delete("/courses/:courseId/media/:mediaId", editLesson, staffAccess, async (req, res) => {
  try { const id = parts.posInt(req.params.mediaId); if (!id) return bad404(res); send(res, await media.deleteMedia(req.pool, req.user, cid(req), id, tenantOf(req)), {}); } catch (e) { fail(res, e, "MEDIA DELETE"); }
});

/* ---- Announcements (L4.4a) ---------------------------------------------------
   Course announcements: any course staff read; writing needs lms.course.manage + course membership.
   School-wide announcements (course_id NULL): LMS administrators only (lms.settings.manage).
   Students read through studentOnly (+ active enrolment for the course list); the student id always comes from the token. */
const manageCourseAnn = requireLmsPermission("lms.course.manage"), manageSchoolAnn = requireLmsPermission("lms.settings.manage");
const annId = (req) => parts.posInt(req.params.announcementId);
const AC = "/courses/:courseId/announcements";
router.get(AC, staffAccess, async (req, res) => {
  try { res.json({ success: true, ...(await announce.listForStaff(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "ANNOUNCEMENTS LIST"); }
});
router.post(AC, manageCourseAnn, staffAccess, async (req, res) => {
  try { const r = await announce.createAnnouncement(req.pool, req.user, cid(req), req.body, tenantOf(req)); send(res, r, { announcement: r.announcement }, 201); } catch (e) { fail(res, e, "ANNOUNCEMENT CREATE"); }
});
router.get(`${AC}/:announcementId`, staffAccess, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); const r = await announce.getOne(req.pool, cid(req), id); send(res, r, { announcement: r.announcement }); } catch (e) { fail(res, e, "ANNOUNCEMENT GET"); }
});
router.patch(`${AC}/:announcementId`, manageCourseAnn, staffAccess, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); const r = await announce.updateAnnouncement(req.pool, req.user, cid(req), id, req.body, tenantOf(req)); send(res, r, { announcement: r.announcement }); } catch (e) { fail(res, e, "ANNOUNCEMENT PATCH"); }
});
router.delete(`${AC}/:announcementId`, manageCourseAnn, staffAccess, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); send(res, await announce.deleteAnnouncement(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "ANNOUNCEMENT DELETE"); }
});
router.get("/announcements", manageSchoolAnn, async (req, res) => {
  try { res.json({ success: true, ...(await announce.listForStaff(req.pool, null, { page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "SCHOOL ANNOUNCEMENTS LIST"); }
});
router.post("/announcements", manageSchoolAnn, async (req, res) => {
  try { const r = await announce.createAnnouncement(req.pool, req.user, null, req.body, tenantOf(req)); send(res, r, { announcement: r.announcement }, 201); } catch (e) { fail(res, e, "SCHOOL ANNOUNCEMENT CREATE"); }
});
router.get("/announcements/:announcementId", manageSchoolAnn, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); const r = await announce.getOne(req.pool, null, id); send(res, r, { announcement: r.announcement }); } catch (e) { fail(res, e, "SCHOOL ANNOUNCEMENT GET"); }
});
router.patch("/announcements/:announcementId", manageSchoolAnn, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); const r = await announce.updateAnnouncement(req.pool, req.user, null, id, req.body, tenantOf(req)); send(res, r, { announcement: r.announcement }); } catch (e) { fail(res, e, "SCHOOL ANNOUNCEMENT PATCH"); }
});
router.delete("/announcements/:announcementId", manageSchoolAnn, async (req, res) => {
  try { const id = annId(req); if (!id) return bad404(res); send(res, await announce.deleteAnnouncement(req.pool, req.user, null, id), {}); } catch (e) { fail(res, e, "SCHOOL ANNOUNCEMENT DELETE"); }
});
router.get("/courses/:courseId/learn/announcements", studentOnly, studentAccess, async (req, res) => {
  try { const r = await announce.listForStudentCourse(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize }); send(res, r, { items: r.items, total: r.total, page: r.page, pageSize: r.pageSize }); } catch (e) { fail(res, e, "LEARN ANNOUNCEMENTS"); }
});
router.get("/me/announcements", studentOnly, async (req, res) => {
  try { res.json({ success: true, ...(await announce.listForStudentMe(req.pool, Number(req.user.id), { page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "ME ANNOUNCEMENTS"); }
});

/* ---- Assignments (L5.1a) -----------------------------------------------------
   Definitions only (no submissions yet). Course staff read; writing needs lms.course.manage + course membership.
   Students read through studentOnly + an ACTIVE enrolment; they only ever get published, already-available assignments. */
const manageAssignments = requireLmsPermission("lms.course.manage");
const asId = (req) => parts.posInt(req.params.assignmentId);
const AS = "/courses/:courseId/assignments";
router.get(AS, staffAccess, async (req, res) => {
  try { res.json({ success: true, ...(await assignments.listForStaff(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize, status: req.query.status }, await getSettings(req.pool))) }); } catch (e) { fail(res, e, "ASSIGNMENTS LIST"); }
});
router.post(AS, manageAssignments, staffAccess, async (req, res) => {
  try { const settings = await getSettings(req.pool); const r = await assignments.createAssignment(req.pool, req.user, cid(req), req.body, { tenant: tenantOf(req), settings }); send(res, r, { assignment: r.assignment }, 201); } catch (e) { fail(res, e, "ASSIGNMENT CREATE"); }
});
router.get(`${AS}/:assignmentId`, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await assignments.getOne(req.pool, cid(req), id, await getSettings(req.pool)); send(res, r, { assignment: r.assignment }); } catch (e) { fail(res, e, "ASSIGNMENT GET"); }
});
router.patch(`${AS}/:assignmentId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const settings = await getSettings(req.pool); const r = await assignments.updateAssignment(req.pool, req.user, cid(req), id, req.body, { tenant: tenantOf(req), settings }); send(res, r, { assignment: r.assignment }); } catch (e) { fail(res, e, "ASSIGNMENT PATCH"); }
});
router.delete(`${AS}/:assignmentId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); send(res, await assignments.deleteAssignment(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "ASSIGNMENT DELETE"); }
});
router.get("/courses/:courseId/learn/assignments", studentOnly, studentAccess, async (req, res) => {
  try { const r = await assignments.listForStudentCourse(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize }, await getSettings(req.pool)); if (r.ok) r.items = await marking.attachStatus(req.pool, req.user, cid(req), r.items, { tenant: tenantOf(req) }); send(res, r, { items: r.items, total: r.total, page: r.page, pageSize: r.pageSize }); } catch (e) { fail(res, e, "LEARN ASSIGNMENTS"); }
});
router.get("/courses/:courseId/learn/assignments/:assignmentId", studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await assignments.getForStudent(req.pool, cid(req), id, await getSettings(req.pool)); if (r.ok) r.assignment = (await marking.attachStatus(req.pool, req.user, cid(req), [r.assignment], { tenant: tenantOf(req) }))[0]; send(res, r, { assignment: r.assignment }); } catch (e) { fail(res, e, "LEARN ASSIGNMENT"); }
});

/* ---- Rubrics (L5.3a) ---------------------------------------------------------
   Definitions only (scoring is L5.4). Course rubrics: staff read, `lms.course.manage` + membership write. The SCHOOL library (/rubric-library):
   teachers (`lms.course.manage`) read, LMS administrators (`lms.settings.manage`) write; a teacher COPIES a library rubric into the course
   (POST .../rubrics/copy) and only course rubrics are ever attached to an assignment. `/rubrics/copy` is registered before `/rubrics/:rubricId`. */
const rbId = (req) => parts.posInt(req.params.rubricId);
const manageLibrary = requireLmsPermission("lms.settings.manage");
const RB = "/courses/:courseId/rubrics", LIB = "/rubric-library";
router.get(RB, staffAccess, async (req, res) => {
  try { res.json({ success: true, ...(await rubrics.listRubrics(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "RUBRICS LIST"); }
});
router.post(RB, manageAssignments, staffAccess, async (req, res) => {
  try { const r = await rubrics.createRubric(req.pool, req.user, cid(req), req.body); send(res, r, { rubric: r.rubric }, 201); } catch (e) { fail(res, e, "RUBRIC CREATE"); }
});
router.post(`${RB}/copy`, manageAssignments, staffAccess, async (req, res) => {
  try { const r = await rubrics.copyRubric(req.pool, req.user, cid(req), req.body); send(res, r, { rubric: r.rubric }, 201); } catch (e) { fail(res, e, "RUBRIC COPY"); }
});
router.get(`${RB}/:rubricId`, staffAccess, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); const r = await rubrics.getRubric(req.pool, cid(req), id); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "RUBRIC GET"); }
});
router.put(`${RB}/:rubricId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); const r = await rubrics.replaceRubric(req.pool, req.user, cid(req), id, req.body); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "RUBRIC PUT"); }
});
router.delete(`${RB}/:rubricId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); send(res, await rubrics.deleteRubric(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "RUBRIC DELETE"); }
});
router.get(`${AS}/:assignmentId/rubric`, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await rubrics.getAssignmentRubric(req.pool, cid(req), id); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "ASSIGNMENT RUBRIC GET"); }
});
router.put(`${AS}/:assignmentId/rubric`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await rubrics.setAssignmentRubric(req.pool, req.user, cid(req), id, req.body); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "ASSIGNMENT RUBRIC PUT"); }
});
router.get(LIB, manageAssignments, async (req, res) => {
  try { res.json({ success: true, ...(await rubrics.listRubrics(req.pool, null, { page: req.query.page, pageSize: req.query.pageSize })) }); } catch (e) { fail(res, e, "RUBRIC LIBRARY LIST"); }
});
router.post(LIB, manageLibrary, async (req, res) => {
  try { const r = await rubrics.createRubric(req.pool, req.user, null, req.body); send(res, r, { rubric: r.rubric }, 201); } catch (e) { fail(res, e, "RUBRIC LIBRARY CREATE"); }
});
router.get(`${LIB}/:rubricId`, manageAssignments, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); const r = await rubrics.getRubric(req.pool, null, id); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "RUBRIC LIBRARY GET"); }
});
router.put(`${LIB}/:rubricId`, manageLibrary, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); const r = await rubrics.replaceRubric(req.pool, req.user, null, id, req.body); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "RUBRIC LIBRARY PUT"); }
});
router.delete(`${LIB}/:rubricId`, manageLibrary, async (req, res) => {
  try { const id = rbId(req); if (!id) return bad404(res); send(res, await rubrics.deleteRubric(req.pool, req.user, null, id), {}); } catch (e) { fail(res, e, "RUBRIC LIBRARY DELETE"); }
});

/* ---- Student submissions (L5.2a, text) ---------------------------------------
   studentOnly + ACTIVE enrolment; the student id always comes from the token. Text drafts, submit (late rule applied with the SERVER clock),
   attempts. Files = L5.2b. */
const SUB = "/courses/:courseId/learn/assignments/:assignmentId/submission";
router.get(SUB, studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await submissions.getState(req.pool, req.user, cid(req), id, { settings: await getSettings(req.pool) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "SUBMISSION GET"); }
});
router.put(`${SUB}/draft`, studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await submissions.saveDraft(req.pool, req.user, cid(req), id, req.body, { settings: await getSettings(req.pool) }); send(res, r, { draft: r.draft }); } catch (e) { fail(res, e, "SUBMISSION DRAFT"); }
});
router.post(`${SUB}/submit`, studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await submissions.submit(req.pool, req.user, cid(req), id, req.body, { tenant: tenantOf(req), settings: await getSettings(req.pool) }); send(res, r, { submission: r.submission }, 201); } catch (e) { fail(res, e, "SUBMISSION SUBMIT"); }
});

const subFileId = (req) => parts.posInt(req.params.fileId);
router.post(`${SUB}/files`, studentOnly, studentAccess, media.uploadMiddleware(getSettings), async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await submissions.addFile(req.pool, req.user, cid(req), id, req.file, { tenant: tenantOf(req), settings: await getSettings(req.pool) }); r.ok ? res.status(201).json({ success: true, file: r.file }) : mediaRejected(res, r); } catch (e) { fail(res, e, "SUBMISSION FILE ADD"); }
});
router.delete(`${SUB}/files/:fileId`, studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req), f = subFileId(req); if (!id || !f) return bad404(res); send(res, await submissions.removeFile(req.pool, req.user, cid(req), id, f, { tenant: tenantOf(req), settings: await getSettings(req.pool) }), {}); } catch (e) { fail(res, e, "SUBMISSION FILE REMOVE"); }
});
/* Authenticated download of the student's OWN file: always an attachment, never rendered by the browser, never cached. */
router.get(`${SUB}/files/:fileId`, studentOnly, studentAccess, async (req, res) => {
  try {
    const id = asId(req), f = subFileId(req); if (!id || !f) return bad404(res);
    const r = await submissions.readFile(req.pool, req.user, cid(req), id, f, { tenant: tenantOf(req) }); if (!r.ok) return rejected(res, r);
    res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="submission.${r.ext}"; filename*=UTF-8''${encodeURIComponent(r.name)}`);
    res.status(200).send(r.buffer);
  } catch (e) { fail(res, e, "SUBMISSION FILE GET"); }
});

/* ---- Marking workspace, part 1 (L5.4a) ----------------------------------------
   Staff: `lms.submission.grade` + course membership (owner / co-teacher / LMS admin). Queue = latest submitted attempt per student; staff download of
   a student's file is authenticated and always an attachment. A grade is saved as a DRAFT (staff only) and becomes visible to the student on RETURN. */
const gradePerm = requireLmsPermission("lms.submission.grade");
const MK = `${AS}/:assignmentId/submissions`, mkId = (req) => parts.posInt(req.params.submissionId);
router.get(MK, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await marking.listQueue(req.pool, cid(req), id, { filter: req.query.filter || "all", groups: req.query.groups || "collapse", page: req.query.page, pageSize: req.query.pageSize, tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "MARKING QUEUE"); }
});
router.get(`${MK}/:submissionId`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = mkId(req); if (!id || !sid) return bad404(res); const r = await marking.getForMarking(req.pool, cid(req), id, sid, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "MARKING GET"); }
});
router.get(`${MK}/:submissionId/files/:fileId`, gradePerm, staffAccess, async (req, res) => {
  try {
    const id = asId(req), sid = mkId(req), f = subFileId(req); if (!id || !sid || !f) return bad404(res);
    const r = await marking.readFileForStaff(req.pool, cid(req), id, sid, f, { tenant: tenantOf(req) }); if (!r.ok) return rejected(res, r);
    res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="submission.${r.ext}"; filename*=UTF-8''${encodeURIComponent(r.name)}`);
    res.status(200).send(r.buffer);
  } catch (e) { fail(res, e, "MARKING FILE GET"); }
});
router.put(`${MK}/:submissionId/grade`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = mkId(req); if (!id || !sid) return bad404(res); const r = await marking.saveGrade(req.pool, req.user, cid(req), id, sid, req.body, { tenant: tenantOf(req) }); send(res, r, { grade: r.grade }); } catch (e) { fail(res, e, "MARKING SAVE"); }
});
router.post(`${MK}/:submissionId/return`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = mkId(req); if (!id || !sid) return bad404(res); const r = await marking.returnGrade(req.pool, req.user, cid(req), id, sid, { tenant: tenantOf(req) }); send(res, r, { grade: r.grade }); } catch (e) { fail(res, e, "MARKING RETURN"); }
});
router.put(`${MK}/:submissionId/group-grade`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = mkId(req); if (!id || !sid) return bad404(res); const r = await groupMarking.saveGroupGrade(req.pool, req.user, cid(req), id, sid, req.body, { tenant: tenantOf(req) }); send(res, r, { grade: r.grade, members: r.members }); } catch (e) { fail(res, e, "MARKING GROUP SAVE"); }
});
router.post(`${MK}/:submissionId/group-return`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = mkId(req); if (!id || !sid) return bad404(res); const r = await groupMarking.returnGroup(req.pool, req.user, cid(req), id, sid, { tenant: tenantOf(req) }); send(res, r, { grade: r.grade, members: r.members }); } catch (e) { fail(res, e, "MARKING GROUP RETURN"); }
});
/* ---- Bulk return and scheduled release (L5.4b-2; owner Q35 = both, Q34 = never re-open; D-064/D-065) ----
   Same guard chain as the marking routes. Kept OFF the `/submissions` path on purpose. */
router.post(`${AS}/:assignmentId/return-all`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await gradeRelease.returnAll(req.pool, req.user, cid(req), id, { tenant: tenantOf(req) }); send(res, r, { returned: r.returned, skippedUngraded: r.skippedUngraded }); } catch (e) { fail(res, e, "GRADES RETURN ALL"); }
});
router.get(`${AS}/:assignmentId/grade-release`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await gradeRelease.getRelease(req.pool, cid(req), id, { tenant: tenantOf(req) }); send(res, r, { release: r.release }); } catch (e) { fail(res, e, "GRADE RELEASE GET"); }
});
router.put(`${AS}/:assignmentId/grade-release`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await gradeRelease.setRelease(req.pool, req.user, cid(req), id, req.body, { tenant: tenantOf(req) }); send(res, r, { release: r.release }); } catch (e) { fail(res, e, "GRADE RELEASE SET"); }
});
router.delete(`${AS}/:assignmentId/grade-release`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await gradeRelease.cancelRelease(req.pool, req.user, cid(req), id, { tenant: tenantOf(req) }); send(res, r, { cancelled: r.cancelled }); } catch (e) { fail(res, e, "GRADE RELEASE CANCEL"); }
});
/* Per-student release override (L5.4b-3; owner Q36 = both; D-066). Same guard chain. */
const stId = (req) => parts.posInt(req.params.studentId);
router.get(`${AS}/:assignmentId/grade-release/students`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await gradeRelease.listStudentReleases(req.pool, cid(req), id, { tenant: tenantOf(req) }); send(res, r, { releases: r.releases }); } catch (e) { fail(res, e, "STUDENT RELEASE LIST"); }
});
router.put(`${AS}/:assignmentId/grade-release/students/:studentId`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = stId(req); if (!id || !sid) return bad404(res); const r = await gradeRelease.setStudentRelease(req.pool, req.user, cid(req), id, sid, req.body, { tenant: tenantOf(req) }); send(res, r, { release: r.release }); } catch (e) { fail(res, e, "STUDENT RELEASE SET"); }
});
router.delete(`${AS}/:assignmentId/grade-release/students/:studentId`, gradePerm, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = stId(req); if (!id || !sid) return bad404(res); const r = await gradeRelease.cancelStudentRelease(req.pool, req.user, cid(req), id, sid, { tenant: tenantOf(req) }); send(res, r, { cancelled: r.cancelled }); } catch (e) { fail(res, e, "STUDENT RELEASE CANCEL"); }
});
/* Per-learner deadline extensions (L5.5, D-068). Read = course staff; grant/revoke = lms.course.manage + course staff (same as editing assignments). */
router.get(`${AS}/:assignmentId/extensions`, staffAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await extensions.listExtensions(req.pool, cid(req), id); send(res, r, { extensions: r.extensions }); } catch (e) { fail(res, e, "EXTENSION LIST"); }
});
router.put(`${AS}/:assignmentId/extensions/:studentId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = stId(req); if (!id || !sid) return bad404(res); const r = await extensions.setExtension(req.pool, req.user, cid(req), id, sid, req.body, { tenant: tenantOf(req) }); send(res, r, { extension: r.extension }); } catch (e) { fail(res, e, "EXTENSION SET"); }
});
router.delete(`${AS}/:assignmentId/extensions/:studentId`, manageAssignments, staffAccess, async (req, res) => {
  try { const id = asId(req), sid = stId(req); if (!id || !sid) return bad404(res); const r = await extensions.revokeExtension(req.pool, req.user, cid(req), id, sid); send(res, r, { revoked: r.revoked }); } catch (e) { fail(res, e, "EXTENSION REVOKE"); }
});
router.get("/courses/:courseId/learn/assignments/:assignmentId/rubric", studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await marking.rubricForStudent(req.pool, req.user, cid(req), id); send(res, r, { rubric: r.rubric }); } catch (e) { fail(res, e, "LEARN RUBRIC"); }
});
/* Student: RETURNED grades and comments on their own work (never drafts). */
router.get("/courses/:courseId/learn/assignments/:assignmentId/feedback", studentOnly, studentAccess, async (req, res) => {
  try { const id = asId(req); if (!id) return bad404(res); const r = await marking.feedbackForStudent(req.pool, req.user, cid(req), id, { tenant: tenantOf(req) }); send(res, r, { items: r.items }); } catch (e) { fail(res, e, "FEEDBACK GET"); }
});

/* L4.5a Student planner (studentOnly runs first; the student id comes from the token). */
const plannerFail = (res, r) => res.status(r.forbidden ? 403 : 400).json({ success: false, code: r.forbidden ? "FORBIDDEN" : "VALIDATION_ERROR", errors: r.errors });
router.get("/me/planner", studentOnly, async (req, res) => {
  try { const r = await planner.getPlanner(req.pool, req.user, { from: req.query.from, to: req.query.to }); r.ok ? res.json({ success: true, from: r.from, to: r.to, truncated: r.truncated, items: r.items }) : plannerFail(res, r); } catch (e) { fail(res, e, "ME PLANNER"); }
});
router.get("/me/planner.ics", studentOnly, async (req, res) => {
  try {
    const r = await planner.getPlanner(req.pool, req.user, { from: req.query.from, to: req.query.to });
    if (!r.ok) return plannerFail(res, r);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8"); res.setHeader("Content-Disposition", 'attachment; filename="my-planner.ics"'); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(planner.toIcs(r.items));
  } catch (e) { fail(res, e, "ME PLANNER ICS"); }
});

/* L4.5b Calendar subscription feed management (studentOnly; the student id comes from the token). The PUBLIC feed itself is routes/lmsFeed.js.
   The secret link is returned ONCE by POST and never again. */
router.get("/me/planner/feed", studentOnly, async (req, res) => {
  try { const r = await calFeed.feedStatus(req.pool, req.user); r.ok ? res.json({ success: true, active: r.active, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }) : plannerFail(res, r); } catch (e) { fail(res, e, "ME FEED STATUS"); }
});
router.post("/me/planner/feed", studentOnly, async (req, res) => {
  try {
    const r = await calFeed.createFeed(req.pool, req.user, req.tenant || req.user?.tenant);
    if (!r.ok) return plannerFail(res, r);
    res.setHeader("Cache-Control", "no-store"); res.status(201).json({ success: true, path: r.path });
  } catch (e) { fail(res, e, "ME FEED CREATE"); }
});
router.delete("/me/planner/feed", studentOnly, async (req, res) => {
  try { const r = await calFeed.revokeFeed(req.pool, req.user); r.ok ? res.json({ success: true, revoked: r.revoked }) : plannerFail(res, r); } catch (e) { fail(res, e, "ME FEED REVOKE"); }
});

/* L4.1a Student dashboard (studentOnly runs first; the student id comes from the token). */
router.get("/me/dashboard", studentOnly, async (req, res) => {
  try { const r = await dashboard.getDashboard(req.pool, req.user, new Date(), { tenant: tenantOf(req) }); if (!r.ok) return res.status(403).json({ success: false, code: "FORBIDDEN", errors: r.errors }); const { ok, ...body } = r; res.json({ success: true, ...body }); } catch (e) { fail(res, e, "ME DASHBOARD"); }
});

/* ---- Question bank (L6.1b, D-073) -------------------------------------------------
   Needs the `lms_quizzes` licence flag AND `lms.course.manage` (teachers, LMS administrators; students never). Visibility/ownership rules are in
   utils/lmsQuestionBank.js (private / course / school; "hidden" and "missing" are both 404). /questions/export.csv and /questions/import are
   registered BEFORE /questions/:questionId. */
const quizGate = requireModule("lms", "lms_quizzes"), manageQuestions = requireLmsPermission("lms.course.manage");
const qb = [quizGate, manageQuestions];
const qCtx = (req) => ({ admin: req.lmsPermissions.has("lms.settings.manage") });
const qId = (req) => parts.posInt(req.params.questionId);
const qSend = (res, r, okBody, okStatus = 200) => {
  if (r.ok) return res.status(okStatus).json({ success: true, ...okBody });
  if (r.forbidden) return res.status(403).json({ success: false, code: r.code, message: r.errors[0], errors: r.errors });
  return rejected(res, r);
};
router.get("/questions", ...qb, async (req, res) => {
  try { const r = await qbank.listQuestions(req.pool, req.user, req.query, qCtx(req)); const { ok, ...rest } = r; qSend(res, r, rest); } catch (e) { fail(res, e, "QUESTIONS LIST"); }
});
router.get("/questions/export.csv", ...qb, async (req, res) => {
  try {
    const r = await qbank.exportCsv(req.pool, req.user, req.query, qCtx(req)); if (!r.ok) return qSend(res, r, {});
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="questions.csv"'); res.status(200).send(r.csv);
  } catch (e) { fail(res, e, "QUESTIONS EXPORT"); }
});
router.post("/questions/import", ...qb, async (req, res) => {
  try { const r = await qbank.importCsv(req.pool, req.user, req.body, qCtx(req)); const { ok, ...rest } = r; qSend(res, r, rest, r.dryRun ? 200 : 201); } catch (e) { fail(res, e, "QUESTIONS IMPORT"); }
});
router.post("/questions", ...qb, async (req, res) => {
  try { const r = await qbank.createQuestion(req.pool, req.user, req.body, qCtx(req)); qSend(res, r, { question: r.question }, 201); } catch (e) { fail(res, e, "QUESTION CREATE"); }
});
router.get("/questions/:questionId", ...qb, async (req, res) => {
  try { const id = qId(req); if (!id) return bad404(res); const r = await qbank.getQuestion(req.pool, req.user, id, qCtx(req)); qSend(res, r, { question: r.question }); } catch (e) { fail(res, e, "QUESTION GET"); }
});
router.put("/questions/:questionId", ...qb, async (req, res) => {
  try { const id = qId(req); if (!id) return bad404(res); const r = await qbank.updateQuestion(req.pool, req.user, id, req.body, qCtx(req)); qSend(res, r, { question: r.question }); } catch (e) { fail(res, e, "QUESTION PUT"); }
});
router.delete("/questions/:questionId", ...qb, async (req, res) => {
  try { const id = qId(req); if (!id) return bad404(res); qSend(res, await qbank.deleteQuestion(req.pool, req.user, id, qCtx(req)), {}); } catch (e) { fail(res, e, "QUESTION DELETE"); }
});
router.post("/questions/:questionId/copy", ...qb, async (req, res) => {
  try { const id = qId(req); if (!id) return bad404(res); const r = await qbank.copyQuestion(req.pool, req.user, id, req.body, qCtx(req)); qSend(res, r, { question: r.question }, 201); } catch (e) { fail(res, e, "QUESTION COPY"); }
});
router.get("/questions/:questionId/versions", ...qb, async (req, res) => {
  try { const id = qId(req); if (!id) return bad404(res); const r = await qbank.listVersions(req.pool, req.user, id, qCtx(req)); const { ok, ...rest } = r; qSend(res, r, rest); } catch (e) { fail(res, e, "QUESTION VERSIONS"); }
});
router.post("/questions/:questionId/versions/:version/restore", ...qb, async (req, res) => {
  try { const id = qId(req), v = parts.posInt(req.params.version); if (!id || !v) return bad404(res); const r = await qbank.restoreVersion(req.pool, req.user, id, v, req.body, qCtx(req)); qSend(res, r, { question: r.question }); } catch (e) { fail(res, e, "QUESTION RESTORE"); }
});

/* ---- L6.2a quiz definitions (D-076). Licence flag `lms_quizzes`; read = any course staff, write = `lms.course.manage` + course membership.
   Students get nothing here yet (attempts and delivery are L6.2b). */
const QZ = "/courses/:courseId/quizzes";
const quizId = (req) => parts.posInt(req.params.quizId);
router.get(QZ, quizGate, staffAccess, async (req, res) => {
  try { res.json({ success: true, ...(await quizzes.listQuizzes(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize, status: req.query.status, mode: req.query.mode })) }); } catch (e) { fail(res, e, "QUIZ LIST"); }
});
router.post(QZ, quizGate, manage, staffAccess, async (req, res) => {
  try { const r = await quizzes.createQuiz(req.pool, req.user, cid(req), req.body, { tenant: tenantOf(req) }); send(res, r, { quiz: r.quiz }, 201); } catch (e) { fail(res, e, "QUIZ CREATE"); }
});
router.get(QZ + "/:quizId", quizGate, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizzes.getQuiz(req.pool, cid(req), id); send(res, r, { quiz: r.quiz }); } catch (e) { fail(res, e, "QUIZ GET"); }
});
router.patch(QZ + "/:quizId", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizzes.updateQuiz(req.pool, req.user, cid(req), id, req.body, { tenant: tenantOf(req) }); send(res, r, { quiz: r.quiz }); } catch (e) { fail(res, e, "QUIZ UPDATE"); }
});
router.delete(QZ + "/:quizId", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); send(res, await quizzes.deleteQuiz(req.pool, req.user, cid(req), id), {}); } catch (e) { fail(res, e, "QUIZ DELETE"); }
});
router.post(QZ + "/:quizId/questions", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizzes.addQuestions(req.pool, req.user, cid(req), id, req.body, qCtx(req)); send(res, r, { quiz: r.quiz }, 201); } catch (e) { fail(res, e, "QUIZ ADD QUESTIONS"); }
});
router.put(QZ + "/:quizId/questions/order", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizzes.reorderQuestions(req.pool, req.user, cid(req), id, req.body); send(res, r, { quiz: r.quiz }); } catch (e) { fail(res, e, "QUIZ REORDER"); }
});
router.delete(QZ + "/:quizId/questions/:quizQuestionId", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizzes.removeQuestion(req.pool, req.user, cid(req), id, req.params.quizQuestionId); send(res, r, { quiz: r.quiz }); } catch (e) { fail(res, e, "QUIZ REMOVE QUESTION"); }
});

/* ---- L6.2c random selection rules (D-080). Licence flag `lms_quizzes`; read = any course staff, write = `lms.course.manage` + membership, draft quizzes only.
   Every answer is `{rules:[{id,position,count,pointsEach,type,subject,topic,difficulty,outcomeId,available,enough}]}` (available = questions in the pool now). */
router.get(QZ + "/:quizId/rules", quizGate, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizRules.listRules(req.pool, cid(req), id); send(res, r, { rules: r.rules }); } catch (e) { fail(res, e, "QUIZ RULES LIST"); }
});
router.post(QZ + "/:quizId/rules", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizRules.addRule(req.pool, req.user, cid(req), id, req.body); send(res, r, { rules: r.rules, ruleId: r.ruleId }, 201); } catch (e) { fail(res, e, "QUIZ RULE ADD"); }
});
router.patch(QZ + "/:quizId/rules/:ruleId", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizRules.updateRule(req.pool, req.user, cid(req), id, req.params.ruleId, req.body); send(res, r, { rules: r.rules }); } catch (e) { fail(res, e, "QUIZ RULE UPDATE"); }
});
router.delete(QZ + "/:quizId/rules/:ruleId", quizGate, manage, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizRules.deleteRule(req.pool, req.user, cid(req), id, req.params.ruleId); send(res, r, { rules: r.rules }); } catch (e) { fail(res, e, "QUIZ RULE REMOVE"); }
});

/* ---- L6.2b-2 staff marking of written quiz answers (D-078). Licence flag `lms_quizzes` FIRST, then `lms.submission.grade` + course membership (same as assignment marking).
   Lives under the staff path `/courses/:courseId/quizzes/:quizId/attempts`; students have their own `/learn/quizzes` routes and never reach these. */
router.get(`${QZ}/:quizId/attempts`, quizGate, gradePerm, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizGrading.listAttempts(req.pool, req.user, cid(req), id, { filter: req.query.filter || "all", page: req.query.page, pageSize: req.query.pageSize, tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "QUIZ MARKING QUEUE"); }
});
router.get(`${QZ}/:quizId/attempts/:attemptId`, quizGate, gradePerm, staffAccess, async (req, res) => {
  try { const id = quizId(req), aid = attemptId(req); if (!id || !aid) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await quizGrading.getAttempt(req.pool, cid(req), id, aid, { tenant: tenantOf(req) }); send(res, r, { attempt: r.attempt }); } catch (e) { fail(res, e, "QUIZ MARKING GET"); }
});
router.put(`${QZ}/:quizId/attempts/:attemptId/answers/:quizQuestionId/mark`, quizGate, gradePerm, staffAccess, async (req, res) => {
  try { const id = quizId(req), aid = attemptId(req); if (!id || !aid) return bad404(res); const r = await quizGrading.markAnswer(req.pool, req.user, cid(req), id, aid, req.params.quizQuestionId, req.body, { tenant: tenantOf(req) }); send(res, r, { graded: r.graded, attempt: r.attempt }); } catch (e) { fail(res, e, "QUIZ MARKING SAVE"); }
});

/* ---- L6.4 publish a coursework quiz to formal results (D-083, contract B). Licence flag `lms_quizzes` FIRST, then `lms.gradebook.publish` + course membership.
   Explicit action only; idempotent; body { dryRun?: boolean }. */
const publishPerm = requireLmsPermission("lms.gradebook.publish");
router.post(`${QZ}/:quizId/publish-results`, quizGate, publishPerm, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await resultsAdapter.publishQuizResults(req.pool, req.user, cid(req), id, req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "QUIZ PUBLISH RESULTS"); }
});

/* ---- L6.5 question analytics (D-084). Licence flag `lms_quizzes` FIRST, then `lms.course.manage` OR `lms.submission.grade`, then course membership. Read only, aggregates only.
   Query: ?page, ?pageSize (<= 50), ?questionId (a bank question id). */
const analyticsPerm = requireLmsPermission("lms.course.manage", "lms.submission.grade");
router.get(`${QZ}/:quizId/analytics`, quizGate, analyticsPerm, staffAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await quizAnalytics.quizAnalytics(req.pool, req.user, cid(req), id, { page: req.query.page, pageSize: req.query.pageSize, questionId: req.query.questionId }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "QUIZ ANALYTICS"); }
});

/* ---- L6.2b-1 student quiz attempts (D-077). Licence flag `lms_quizzes` first, then studentOnly + ACTIVE enrolment; the student id always comes from the token.
   Server clock decides time limits; the student never receives the answer key while an attempt is in progress. */
const SQ = "/courses/:courseId/learn/quizzes";
const attemptId = (req) => parts.posInt(req.params.attemptId);
const sqCtx = (req) => ({ tenant: tenantOf(req) });
router.get(SQ, quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const r = await quizAttempts.listForStudent(req.pool, req.user, cid(req), { page: req.query.page, pageSize: req.query.pageSize, mode: req.query.mode }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "STUDENT QUIZ LIST"); }
});
router.get(SQ + "/:quizId", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizAttempts.getForStudent(req.pool, req.user, cid(req), id); send(res, r, { quiz: r.quiz }); } catch (e) { fail(res, e, "STUDENT QUIZ GET"); }
});
router.post(SQ + "/:quizId/attempts", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await quizAttempts.startAttempt(req.pool, req.user, cid(req), id, sqCtx(req)); send(res, r, { attempt: r.attempt }, r.created ? 201 : 200); } catch (e) { fail(res, e, "STUDENT QUIZ START"); }
});
router.get(SQ + "/:quizId/attempts/:attemptId", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req), aid = attemptId(req); if (!id || !aid) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await quizAttempts.getAttempt(req.pool, req.user, cid(req), id, aid, sqCtx(req)); send(res, r, { attempt: r.attempt }); } catch (e) { fail(res, e, "STUDENT QUIZ ATTEMPT"); }
});
router.put(SQ + "/:quizId/attempts/:attemptId/answers", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req), aid = attemptId(req); if (!id || !aid) return bad404(res); const r = await quizAttempts.saveAnswers(req.pool, req.user, cid(req), id, aid, req.body, sqCtx(req)); send(res, r, { saved: r.saved, serverNow: r.serverNow }); } catch (e) { fail(res, e, "STUDENT QUIZ SAVE"); }
});
router.post(SQ + "/:quizId/attempts/:attemptId/submit", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req), aid = attemptId(req); if (!id || !aid) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await quizAttempts.submitAttempt(req.pool, req.user, cid(req), id, aid, req.body, sqCtx(req)); send(res, r, { attempt: r.attempt, alreadySubmitted: !!r.alreadySubmitted, autoSubmitted: !!r.autoSubmitted }); } catch (e) { fail(res, e, "STUDENT QUIZ SUBMIT"); }
});
/* ---- L6.3b flashcards (D-082). Same gate order as the student quiz routes. Only flashcard decks answer here; any other quiz is a 404. */
router.get(SQ + "/:quizId/cards", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await flashcards.getDeck(req.pool, req.user, cid(req), id); send(res, r, { deck: r.deck }); } catch (e) { fail(res, e, "STUDENT CARDS GET"); }
});
router.put(SQ + "/:quizId/cards/:cardId/rating", quizGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = quizId(req); if (!id) return bad404(res); const r = await flashcards.rateCard(req.pool, req.user, cid(req), id, req.params.cardId, req.body); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "STUDENT CARD RATE"); }
});

/* ---- L7.1b gradebook, STAFF (D-086). Licence flag `lms_gradebook` FIRST, then the permission, then course membership (owner / co-teacher / admin).
   Read = `lms.gradebook.view`; categories and items = `lms.course.manage`; entering grades = `lms.submission.grade`. Students never reach these routes. */
const GB = "/courses/:courseId/gradebook";
const gbGate = requireModule("lms", "lms_gradebook"), gbView = requireLmsPermission("lms.gradebook.view"), gbManage = requireLmsPermission("lms.course.manage"), gbGrade = requireLmsPermission("lms.submission.grade");
const gbId = (req, name) => parts.posInt(req.params[name]);
router.get(GB, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await gradebook.listGradebook(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADEBOOK"); }
});
router.post(`${GB}/categories`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const r = await gradebook.createCategory(req.pool, req.user, cid(req), req.body); send(res, r, { category: r.category }, 201); } catch (e) { fail(res, e, "GRADE CATEGORY CREATE"); }
});
router.patch(`${GB}/categories/:categoryId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "categoryId"); if (!id) return bad404(res); const r = await gradebook.updateCategory(req.pool, req.user, cid(req), id, req.body); send(res, r, { category: r.category }); } catch (e) { fail(res, e, "GRADE CATEGORY UPDATE"); }
});
router.delete(`${GB}/categories/:categoryId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "categoryId"); if (!id) return bad404(res); const r = await gradebook.deleteCategory(req.pool, req.user, cid(req), id); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADE CATEGORY DELETE"); }
});
router.post(`${GB}/items`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const r = await gradebook.createItem(req.pool, req.user, cid(req), req.body); send(res, r, { item: r.item }, 201); } catch (e) { fail(res, e, "GRADE ITEM CREATE"); }
});
router.patch(`${GB}/items/:itemId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "itemId"); if (!id) return bad404(res); const r = await gradebook.updateItem(req.pool, req.user, cid(req), id, req.body); send(res, r, { item: r.item }); } catch (e) { fail(res, e, "GRADE ITEM UPDATE"); }
});
router.delete(`${GB}/items/:itemId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "itemId"); if (!id) return bad404(res); const r = await gradebook.deleteItem(req.pool, req.user, cid(req), id); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADE ITEM DELETE"); }
});
router.put(`${GB}/items/:itemId/grades/:studentId`, gbGate, gbGrade, staffAccess, async (req, res) => {
  try { const i = gbId(req, "itemId"), s = gbId(req, "studentId"); if (!i || !s) return bad404(res); const r = await gradebook.setGrade(req.pool, req.user, cid(req), i, s, req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADE SET"); }
});
router.get(`${GB}/export.csv`, gbGate, gbView, staffAccess, async (req, res) => {
  try {
    const r = await gbExport.exportGradebook(req.pool, req.user, cid(req)); if (!r.ok) return rejected(res, r);
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`); res.status(200).send(r.csv);
  } catch (e) { fail(res, e, "GRADEBOOK EXPORT"); }
});
router.post(`${GB}/results`, gbGate, publishPerm, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await gbResults.publishCourseResults(req.pool, req.user, cid(req), req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADEBOOK RESULTS"); }
});
/* ---- L7.5a completion certificates (D-091). Flag `lms_gradebook` first; list = `lms.gradebook.view`, issue/revoke = `lms.gradebook.publish`, then course membership. */
router.get(`${GB}/certificates`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await certs.listCertificates(req.pool, cid(req), { page: req.query.page, pageSize: req.query.pageSize }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "CERTIFICATES LIST"); }
});
router.post(`${GB}/certificates/issue`, gbGate, publishPerm, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await certs.issueCertificates(req.pool, req.user, cid(req), req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "CERTIFICATES ISSUE"); }
});
router.post(`${GB}/certificates/:certId/revoke`, gbGate, publishPerm, staffAccess, async (req, res) => {
  try { const id = gbId(req, "certId"); if (!id) return bad404(res); const r = await certs.revokeCertificate(req.pool, req.user, cid(req), id, req.body); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "CERTIFICATE REVOKE"); }
});
/* ---- L7.5b course badges (D-092). Flag `lms_gradebook` first; list = `lms.gradebook.view`; create/edit/remove/award = `lms.course.manage`; then course membership. */
router.get(`${GB}/badges`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await badges.listBadges(req.pool, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "BADGES LIST"); }
});
router.post(`${GB}/badges`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const r = await badges.createBadge(req.pool, req.user, cid(req), req.body); const { ok, ...rest } = r; send(res, r, rest, 201); } catch (e) { fail(res, e, "BADGE CREATE"); }
});
router.post(`${GB}/badges/award`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await badges.awardBadges(req.pool, req.user, cid(req), req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "BADGE AWARD"); }
});
router.patch(`${GB}/badges/:badgeId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "badgeId"); if (!id) return bad404(res); const r = await badges.updateBadge(req.pool, req.user, cid(req), id, req.body); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "BADGE UPDATE"); }
});
router.delete(`${GB}/badges/:badgeId`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "badgeId"); if (!id) return bad404(res); const r = await badges.removeBadge(req.pool, req.user, cid(req), id); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "BADGE REMOVE"); }
});
/* ---- L8.1a course discussions (D-095). Flag `lms_discussions` FIRST. Staff: any course owner / co-teacher / admin (forum management also needs `lms.course.manage`);
   learners: studentOnly + ACTIVE enrolment. The viewer kind is fixed by the route, never by the client; the learner id always comes from the token. */
const dGate = requireModule("lms", "lms_discussions"), DS = "/courses/:courseId/discussions", DL = "/courses/:courseId/learn/discussions";
const dId = (req, name) => parts.posInt(req.params[name]);
const dRun = (what, fn, status = 200) => async (req, res) => { try { res.setHeader("Cache-Control", "no-store"); const r = await fn(req); const { ok, ...rest } = r; send(res, r, rest, status); } catch (e) { fail(res, e, what); } };
const dTid = (req) => ({ tenant: tenantOf(req) });
for (const [base, staff, pre] of [[DS, true, [staffAccess]], [DL, false, [studentOnly, studentAccess]]]) {
  router.get(`${base}/forums`, dGate, ...pre, dRun("FORUMS LIST", (req) => disc.listForums(req.pool, req.user, cid(req), staff)));
  router.get(`${base}/forums/:forumId/threads`, dGate, ...pre, dRun("THREADS LIST", (req) => disc.listThreads(req.pool, req.user, cid(req), dId(req, "forumId"), req.query, staff)));
  router.post(`${base}/forums/:forumId/threads`, dGate, ...pre, dRun("THREAD CREATE", (req) => disc.createThread(req.pool, req.user, cid(req), dId(req, "forumId"), req.body, staff, dTid(req)), 201));
  router.get(`${base}/threads/:threadId`, dGate, ...pre, dRun("THREAD READ", (req) => disc.getThread(req.pool, req.user, cid(req), dId(req, "threadId"), req.query, staff)));
  router.post(`${base}/threads/:threadId/posts`, dGate, ...pre, dRun("POST CREATE", (req) => disc.createPost(req.pool, req.user, cid(req), dId(req, "threadId"), req.body, staff, dTid(req)), 201));
  router.patch(`${base}/posts/:postId`, dGate, ...pre, dRun("POST EDIT", (req) => disc.editPost(req.pool, req.user, cid(req), dId(req, "postId"), req.body, staff)));
}
router.post(`${DS}/forums`, dGate, gbManage, staffAccess, dRun("FORUM CREATE", (req) => disc.createForum(req.pool, req.user, cid(req), req.body), 201));
router.patch(`${DS}/forums/:forumId`, dGate, gbManage, staffAccess, dRun("FORUM UPDATE", (req) => disc.updateForum(req.pool, req.user, cid(req), dId(req, "forumId"), req.body)));
router.delete(`${DS}/forums/:forumId`, dGate, gbManage, staffAccess, dRun("FORUM REMOVE", (req) => disc.removeForum(req.pool, req.user, cid(req), dId(req, "forumId"))));
/* ---- L8.1b moderation + reports (D-096). Flag `lms_discussions` FIRST; staff = `lms.course.manage` + course membership; learners report as studentOnly + ACTIVE enrolment. */
router.put(`${DS}/threads/:threadId/moderation`, dGate, gbManage, staffAccess, dRun("THREAD MODERATE", (req) => discMod.moderateThread(req.pool, req.user, cid(req), dId(req, "threadId"), req.body)));
router.put(`${DS}/posts/:postId/moderation`, dGate, gbManage, staffAccess, dRun("POST MODERATE", (req) => discMod.moderatePost(req.pool, req.user, cid(req), dId(req, "postId"), req.body)));
router.get(`${DS}/reports`, dGate, gbManage, staffAccess, dRun("REPORTS LIST", (req) => discMod.listReports(req.pool, req.user, cid(req), req.query)));
router.post(`${DS}/reports/:reportId/resolve`, dGate, gbManage, staffAccess, dRun("REPORT RESOLVE", (req) => discMod.resolveReport(req.pool, req.user, cid(req), dId(req, "reportId"), req.body)));
router.post(`${DL}/posts/:postId/report`, dGate, studentOnly, studentAccess, dRun("POST REPORT", (req) => discMod.reportPost(req.pool, req.user, cid(req), dId(req, "postId"), req.body)));
/* ---- L8.2a course groups (D-098). Flag `lms_discussions` FIRST; staff read = any course staff, write = `lms.course.manage` + membership; the learner sees only their OWN group. */
const GRP = "/courses/:courseId/groups";
router.get(GRP, dGate, staffAccess, dRun("GROUPS LIST", (req) => groups.listGroups(req.pool, req.user, cid(req))));
router.post(GRP, dGate, gbManage, staffAccess, dRun("GROUP CREATE", (req) => groups.createGroup(req.pool, req.user, cid(req), req.body), 201));
router.post(`${GRP}/allocate`, dGate, gbManage, staffAccess, dRun("GROUPS ALLOCATE", (req) => groups.allocate(req.pool, req.user, cid(req), req.body)));
router.patch(`${GRP}/:groupId`, dGate, gbManage, staffAccess, dRun("GROUP UPDATE", (req) => groups.updateGroup(req.pool, req.user, cid(req), dId(req, "groupId"), req.body)));
router.delete(`${GRP}/:groupId`, dGate, gbManage, staffAccess, dRun("GROUP REMOVE", (req) => groups.removeGroup(req.pool, req.user, cid(req), dId(req, "groupId"))));
router.get(`${GRP}/:groupId/members`, dGate, staffAccess, dRun("GROUP MEMBERS", (req) => groups.listMembers(req.pool, req.user, cid(req), dId(req, "groupId"), req.query)));
router.put(`${GRP}/:groupId/members`, dGate, gbManage, staffAccess, dRun("GROUP MEMBERS SET", (req) => groups.setMembers(req.pool, req.user, cid(req), dId(req, "groupId"), req.body)));
router.delete(`${GRP}/:groupId/members/:studentId`, dGate, gbManage, staffAccess, dRun("GROUP MEMBER REMOVE", (req) => groups.removeMember(req.pool, req.user, cid(req), dId(req, "groupId"), dId(req, "studentId"))));
router.get(`${DL.replace("/discussions", "")}/groups/mine`, dGate, studentOnly, studentAccess, dRun("GROUP MINE", (req) => groups.myGroup(req.pool, req.user, cid(req))));
/* ---- L8.3a peer review rounds, staff side (D-100). Flag `lms_discussions` FIRST; read = any course staff, write = `lms.course.manage` + membership. */
const PR = "/courses/:courseId/peer-rounds";
router.get(PR, dGate, staffAccess, dRun("PEER ROUNDS LIST", (req) => peer.listRounds(req.pool, req.user, cid(req), req.query)));
router.post(PR, dGate, gbManage, staffAccess, dRun("PEER ROUND CREATE", (req) => peer.createRound(req.pool, req.user, cid(req), req.body), 201));
router.get(`${PR}/:roundId`, dGate, staffAccess, dRun("PEER ROUND READ", (req) => peer.getRound(req.pool, req.user, cid(req), dId(req, "roundId"))));
router.patch(`${PR}/:roundId`, dGate, gbManage, staffAccess, dRun("PEER ROUND UPDATE", (req) => peer.updateRound(req.pool, req.user, cid(req), dId(req, "roundId"), req.body)));
router.delete(`${PR}/:roundId`, dGate, gbManage, staffAccess, dRun("PEER ROUND REMOVE", (req) => peer.removeRound(req.pool, req.user, cid(req), dId(req, "roundId"))));
router.post(`${PR}/:roundId/open`, dGate, gbManage, staffAccess, dRun("PEER ROUND OPEN", (req) => peer.openRound(req.pool, req.user, cid(req), dId(req, "roundId"), req.body)));
router.post(`${PR}/:roundId/close`, dGate, gbManage, staffAccess, dRun("PEER ROUND CLOSE", (req) => peer.closeRound(req.pool, req.user, cid(req), dId(req, "roundId"))));
router.get(`${PR}/:roundId/reviews`, dGate, staffAccess, dRun("PEER REVIEWS LIST", (req) => peer.listReviews(req.pool, req.user, cid(req), dId(req, "roundId"), req.query)));
/* ---- L8.3b peer review, learner side + moderation (D-101). Reviewers see only what is assigned to them; authors see feedback only after the round closes. */
router.get(`${PR}/:roundId/reviews/:reviewId`, dGate, staffAccess, dRun("PEER REVIEW READ", (req) => peerL.staffGetReview(req.pool, req.user, cid(req), dId(req, "roundId"), dId(req, "reviewId"))));
router.put(`${PR}/:roundId/reviews/:reviewId/moderation`, dGate, gbManage, staffAccess, dRun("PEER REVIEW MODERATE", (req) => peerL.moderateReview(req.pool, req.user, cid(req), dId(req, "roundId"), dId(req, "reviewId"), req.body)));
const PRL = "/courses/:courseId/learn/peer-reviews";
router.get(PRL, dGate, studentOnly, studentAccess, dRun("PEER MINE LIST", (req) => peerL.listMine(req.pool, req.user, cid(req), req.query)));
/* ---- L8.5 help requests + office hours (D-104). Flag `lms_discussions` FIRST; learners = studentOnly + ACTIVE enrolment; staff read = any course staff, write = `lms.course.manage` + membership. */
const HL = "/courses/:courseId/learn/help", HS = "/courses/:courseId/help", OHL = "/courses/:courseId/learn/office-hours", OHS = "/courses/:courseId/office-hours";
router.get(HL, dGate, studentOnly, studentAccess, dRun("HELP MINE", (req) => help.listMine(req.pool, req.user, cid(req), req.query)));
router.post(HL, dGate, studentOnly, studentAccess, dRun("HELP CREATE", (req) => help.createRequest(req.pool, req.user, cid(req), req.body, dTid(req)), 201));
router.delete(`${HL}/:requestId`, dGate, studentOnly, studentAccess, dRun("HELP WITHDRAW", (req) => help.withdraw(req.pool, req.user, cid(req), dId(req, "requestId"))));
router.get(OHL, dGate, studentOnly, studentAccess, dRun("OFFICE HOURS MINE", (req) => help.listLines(req.pool, req.user, cid(req), false)));
router.get(HS, dGate, gbManage, staffAccess, dRun("HELP INBOX", (req) => help.listInbox(req.pool, req.user, cid(req), req.query)));
router.put(`${HS}/:requestId/reply`, dGate, gbManage, staffAccess, dRun("HELP ANSWER", (req) => help.answer(req.pool, req.user, cid(req), dId(req, "requestId"), req.body, dTid(req))));
router.get(OHS, dGate, staffAccess, dRun("OFFICE HOURS LIST", (req) => help.listLines(req.pool, req.user, cid(req), true)));
router.post(OHS, dGate, gbManage, staffAccess, dRun("OFFICE HOURS ADD", (req) => help.addLine(req.pool, req.user, cid(req), req.body), 201));
router.delete(`${OHS}/:lineId`, dGate, gbManage, staffAccess, dRun("OFFICE HOURS REMOVE", (req) => help.removeLine(req.pool, req.user, cid(req), dId(req, "lineId"))));
router.get(`${PRL}/received`, dGate, studentOnly, studentAccess, dRun("PEER RECEIVED", (req) => peerL.listReceived(req.pool, req.user, cid(req), req.query)));
router.get(`${PRL}/:reviewId`, dGate, studentOnly, studentAccess, dRun("PEER MINE READ", (req) => peerL.getMine(req.pool, req.user, cid(req), dId(req, "reviewId"))));
router.put(`${PRL}/:reviewId`, dGate, studentOnly, studentAccess, dRun("PEER MINE SAVE", (req) => peerL.saveMine(req.pool, req.user, cid(req), dId(req, "reviewId"), req.body)));
/* ---- L7.6a staff reports (D-093), read only: flag `lms_gradebook`, `lms.gradebook.view`, course membership. */
router.get(`${GB}/reports/progress`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await reports.progressReport(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "REPORT PROGRESS"); }
});
router.get(`${GB}/reports/distribution`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await reports.distributionReport(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "REPORT DISTRIBUTION"); }
});
/* ---- L7.6b staff reports part 2 (D-094): same gates. The CSV is a download and writes one audit row; the other two are read only. */
router.get(`${GB}/reports/progress.csv`, gbGate, gbView, staffAccess, async (req, res) => {
  try {
    const r = await reports.exportProgressCsv(req.pool, req.user, cid(req)); if (!r.ok) return rejected(res, r);
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`); res.status(200).send(r.csv);
  } catch (e) { fail(res, e, "REPORT PROGRESS CSV"); }
});
router.get(`${GB}/reports/submissions`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await reports.submissionStatusReport(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "REPORT SUBMISSIONS"); }
});
router.get(`${GB}/reports/teacher-activity`, gbGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await reports.teacherActivityReport(req.pool, req.user, cid(req), { days: req.query.days }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "REPORT TEACHER ACTIVITY"); }
});
/* ---- L9.1a teacher attention analytics (D-105). Read only. Flag lms_analytics first, then lms.gradebook.view, then course staff. */
const anGate = requireModule("lms", "lms_analytics");
router.get("/courses/:courseId/analytics/attention", anGate, gbView, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await analytics.attentionReport(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "ANALYTICS ATTENTION"); }
});
/* ---- L9.2a HOD / admin dashboards (D-106). Tenant-wide read only: flag lms_analytics, then lms.analytics.department. No course id, so no course membership; learners are never named. */
const deptView = requireLmsPermission("lms.analytics.department");
router.get("/analytics/courses", anGate, deptView, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await dashboards.courseQualityReport(req.pool, req.user, req.query); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "ANALYTICS COURSES"); }
});
router.get("/analytics/staff", anGate, deptView, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await dashboards.staffActivityReport(req.pool, req.user, req.query); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "ANALYTICS STAFF"); }
});
router.get("/analytics/moderation", anGate, deptView, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await dashboards.moderationReport(req.pool, req.user, req.query); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "ANALYTICS MODERATION"); }
});
router.get("/analytics/cohorts", anGate, deptView, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await dashboards.cohortReport(req.pool, req.user, req.query); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "ANALYTICS COHORTS"); }
});
/* ---- L9.3a learning paths, staff side (D-108). Flag `lms_paths` FIRST; read = any course staff, write = `lms.course.manage` + membership. A path is a list of existing lessons; it never hides or unlocks one. */
const pGate = requireModule("lms", "lms_paths"), PT = "/courses/:courseId/paths";
router.get(PT, pGate, staffAccess, dRun("PATHS LIST", (req) => paths.listPaths(req.pool, req.user, cid(req), req.query)));
router.post(PT, pGate, gbManage, staffAccess, dRun("PATH CREATE", (req) => paths.createPath(req.pool, req.user, cid(req), req.body), 201));
router.get(`${PT}/:pathId`, pGate, staffAccess, dRun("PATH READ", (req) => paths.getPath(req.pool, req.user, cid(req), dId(req, "pathId"))));
router.patch(`${PT}/:pathId`, pGate, gbManage, staffAccess, dRun("PATH UPDATE", (req) => paths.updatePath(req.pool, req.user, cid(req), dId(req, "pathId"), req.body)));
router.delete(`${PT}/:pathId`, pGate, gbManage, staffAccess, dRun("PATH REMOVE", (req) => paths.removePath(req.pool, req.user, cid(req), dId(req, "pathId"))));
router.put(`${PT}/:pathId/items`, pGate, gbManage, staffAccess, dRun("PATH ITEMS", (req) => paths.setItems(req.pool, req.user, cid(req), dId(req, "pathId"), req.body)));
/* ---- L9.3b learning paths, learners (D-109). Staff: assign/withdraw/list named learners; learner: only MY paths. Flag `lms_paths` FIRST. */
router.put(`${PT}/:pathId/learners`, pGate, gbManage, staffAccess, dRun("PATH LEARNERS ASSIGN", (req) => pathLearners.assignLearners(req.pool, req.user, cid(req), dId(req, "pathId"), req.body)));
router.delete(`${PT}/:pathId/learners/:studentId`, pGate, gbManage, staffAccess, dRun("PATH LEARNER WITHDRAW", (req) => pathLearners.withdrawLearner(req.pool, req.user, cid(req), dId(req, "pathId"), dId(req, "studentId"))));
router.get(`${PT}/:pathId/learners`, pGate, staffAccess, dRun("PATH LEARNERS LIST", (req) => pathLearners.listLearners(req.pool, req.user, cid(req), dId(req, "pathId"), req.query)));
router.get("/courses/:courseId/learn/paths", pGate, studentOnly, studentAccess, dRun("PATHS MINE", (req) => pathLearners.myPaths(req.pool, req.user, cid(req))));
/* ---- L9.4 competency tracking (D-110). Read only. Flag `lms_competency` FIRST. Staff: lms.gradebook.view + course staff; learner: studentOnly + ACTIVE enrolment, own evidence only. */
const cGate = requireModule("lms", "lms_competency"), CP = "/courses/:courseId/competency";
router.get(CP, cGate, gbView, staffAccess, dRun("COMPETENCY COURSE", (req) => competency.courseCompetency(req.pool, req.user, cid(req), req.query)));
router.get(`${CP}/learners/:studentId`, cGate, gbView, staffAccess, dRun("COMPETENCY LEARNER", (req) => competency.learnerCompetency(req.pool, req.user, cid(req), dId(req, "studentId"))));
router.get("/courses/:courseId/learn/competency", cGate, studentOnly, studentAccess, dRun("COMPETENCY MINE", (req) => competency.myCompetency(req.pool, req.user, cid(req))));
router.get(`${GB}/items/:itemId/grades/:studentId/history`, gbGate, gbView, staffAccess, async (req, res) => {
  try { const i = gbId(req, "itemId"), s = gbId(req, "studentId"); if (!i || !s) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await gradebook.gradeHistory(req.pool, cid(req), i, s); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADE HISTORY"); }
});
router.post(`${GB}/items/link`, gbGate, gbManage, staffAccess, async (req, res) => {
  try { const r = await gbLinks.linkItem(req.pool, req.user, cid(req), req.body); send(res, r, { item: r.item }, 201); } catch (e) { fail(res, e, "GRADE ITEM LINK"); }
});
router.post(`${GB}/items/:itemId/sync`, gbGate, gbGrade, staffAccess, async (req, res) => {
  try { const id = gbId(req, "itemId"); if (!id) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await gbLinks.syncItem(req.pool, req.user, cid(req), id, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GRADE ITEM SYNC"); }
});

/* ---- L7.3 learner grade view (D-088). Licence flag `lms_gradebook`, studentOnly, ACTIVE enrolment; the student id comes from the token. Released items only. */
router.get("/courses/:courseId/learn/grades", gbGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await gradeView.myGrades(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN GRADES"); }
});

router.get("/courses/:courseId/learn/certificate", gbGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await certs.myCertificate(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN CERTIFICATE"); }
});
router.get("/courses/:courseId/learn/badges", gbGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await badges.myBadges(req.pool, req.user, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN BADGES"); }
});

/* ---- L9.5a guardian links, STAFF (D-112). Licence flag `lms_guardian` FIRST, then `lms.settings.manage` (LMS administrator). The guardian's own view is the PUBLIC
   /api/lms-guardian/:school/:secret.json route (routes/lmsGuardian.js); there is no guardian login. The secret is returned ONCE, on creation. */
const gdGate = requireModule("lms", "lms_guardian"), gdAdmin = requireLmsPermission("lms.settings.manage");
router.post("/guardian/students/:studentId/links", gdGate, gdAdmin, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await guardian.createLink(req.pool, req.user, req.params.studentId, req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest, 201); } catch (e) { fail(res, e, "GUARDIAN LINK CREATE"); }
});
router.get("/guardian/students/:studentId/links", gdGate, gdAdmin, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await guardian.listLinks(req.pool, req.params.studentId); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GUARDIAN LINK LIST"); }
});
router.delete("/guardian/links/:linkId", gdGate, gdAdmin, async (req, res) => {
  try { const r = await guardian.revokeLink(req.pool, req.user, req.params.linkId); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "GUARDIAN LINK REVOKE"); }
});


/* ---- L10.1a offline resource packs (D-113). Licence flag `lms_offline` FIRST, then `lms.course.manage` + course membership (staff); learners: studentOnly + enrolment. */
const olGate = requireModule("lms", "lms_offline"), olManage = requireLmsPermission("lms.course.manage");
const OL = "/courses/:courseId/offline/packs";
router.get(OL, olGate, olManage, staffAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await packs.listPacks(req.pool, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "OFFLINE PACKS LIST"); }
});
router.post(OL, olGate, olManage, staffAccess, async (req, res) => {
  try { const r = await packs.createPack(req.pool, req.user, cid(req), req.body); const { ok, ...rest } = r; send(res, r, rest, 201); } catch (e) { fail(res, e, "OFFLINE PACK CREATE"); }
});
router.patch(`${OL}/:packId`, olGate, olManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "packId"); if (!id) return bad404(res); const r = await packs.updatePack(req.pool, req.user, cid(req), id, req.body); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "OFFLINE PACK UPDATE"); }
});
router.post(`${OL}/:packId/publish`, olGate, olManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "packId"); if (!id) return bad404(res); const r = await packs.publishPack(req.pool, req.user, cid(req), id, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "OFFLINE PACK PUBLISH"); }
});
router.post(`${OL}/:packId/retire`, olGate, olManage, staffAccess, async (req, res) => {
  try { const id = gbId(req, "packId"); if (!id) return bad404(res); const r = await packs.retirePack(req.pool, req.user, cid(req), id); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "OFFLINE PACK RETIRE"); }
});
router.get("/courses/:courseId/learn/offline/packs", olGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await packs.learnerPacks(req.pool, cid(req)); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE PACKS"); }
});
router.get("/courses/:courseId/learn/offline/packs/:packId/manifest", olGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = gbId(req, "packId"); if (!id) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await packs.learnerManifest(req.pool, cid(req), id); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE MANIFEST"); }
});
router.get("/courses/:courseId/learn/offline/packs/:packId/lessons/:lessonId", olGate, studentOnly, studentAccess, async (req, res) => {
  try { const id = gbId(req, "packId"), lid = gbId(req, "lessonId"); if (!id || !lid) return bad404(res); res.setHeader("Cache-Control", "no-store"); const r = await packs.learnerLesson(req.pool, cid(req), id, lid); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE LESSON"); }
});
/* L10.1b file bytes (D-114): attachment + nosniff + private, Content-Length, one Range. A broken stream ends the response; it never sends a half file as a success we can hide. */
router.get("/courses/:courseId/learn/offline/packs/:packId/files/:mediaId", olGate, studentOnly, studentAccess, async (req, res) => {
  try {
    const id = gbId(req, "packId"), mid = gbId(req, "mediaId"); if (!id || !mid) return bad404(res);
    const r = await packs.learnerFile(req.pool, cid(req), id, mid, { tenant: tenantOf(req), range: req.headers.range });
    if (r.rangeError) { res.setHeader("Content-Range", `bytes */${r.size}`); res.setHeader("Cache-Control", "no-store"); return res.status(416).json({ success: false, code: "RANGE_NOT_SATISFIABLE", message: r.errors[0] }); }
    if (!r.ok) { res.setHeader("Cache-Control", "no-store"); return rejected(res, r); }
    const f = r.file;
    res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(f.length)); res.setHeader("X-File-Sha256", f.sha256);
    res.setHeader("Content-Disposition", `attachment; filename="pack-file.${String(f.ext || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 10) || "bin"}"; filename*=UTF-8''${encodeURIComponent(f.name || "file")}`);
    if (f.partial) { res.status(206); res.setHeader("Content-Range", `bytes ${f.start}-${f.end}/${f.size}`); } else res.status(200);
    if (!f.stream) { if (f.close) await f.close(); return res.end(); }
    f.stream.on("error", () => { res.destroy(); }); res.on("close", () => { f.stream.destroy(); }); f.stream.pipe(res);
  } catch (e) { fail(res, e, "LEARN OFFLINE FILE"); }
});
/* L10.3a queued progress replay (D-115). studentOnly + ACTIVE enrolment; the student id comes from the token. */
router.post("/courses/:courseId/learn/offline/sync/progress", olGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await offlineSync.replayProgress(req.pool, cid(req), Number(req.user.id), req.body, { tenant: tenantOf(req) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE SYNC PROGRESS"); }
});
/* L10.3b queued DRAFT submissions + L10.4 conflict resolve (D-116). Same gates as progress replay. Never queues a final submit, group work or controlled exams. */
router.post("/courses/:courseId/learn/offline/sync/drafts", olGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await offlineDrafts.replayDrafts(req.pool, cid(req), Number(req.user.id), req.body, { settings: () => getSettings(req.pool) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE SYNC DRAFTS"); }
});
router.post("/courses/:courseId/learn/offline/sync/drafts/resolve", olGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await offlineDrafts.resolveDraft(req.pool, req.user, cid(req), req.body, { settings: () => getSettings(req.pool) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE SYNC RESOLVE"); }
});
/* L10.3c queued QUIZ ANSWERS (D-118). Same gates. Only untimed practice quizzes that do not count to a grade; never starts or submits an attempt. */
router.post("/courses/:courseId/learn/offline/sync/quiz-answers", olGate, studentOnly, studentAccess, async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await offlineQuiz.replayQuizAnswers(req.pool, cid(req), Number(req.user.id), req.body, {}); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "LEARN OFFLINE SYNC QUIZ"); }
});
/* Offline receipts retention (D-119, A165). Licence flag FIRST, then lms.settings.manage (admin). Tenant-wide, not course scoped. Body {dryRun?: boolean}. */
router.post("/offline/retention/purge", olGate, requireLmsPermission("lms.settings.manage"), async (req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); const r = await offlineRetention.purge(req.pool, req.user, req.body, { settings: () => getSettings(req.pool) }); const { ok, ...rest } = r; send(res, r, rest); } catch (e) { fail(res, e, "OFFLINE RETENTION"); }
});
module.exports = router;
