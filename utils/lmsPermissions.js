/* =========================================================================
   LMS PERMISSIONS + COURSE MEMBERSHIP  (L1.3, decision D-003)

   No new DB roles. Effective permissions =
     role defaults  ∪  rows in lms_user_permissions for this actor.
   - admin / module_admin ................ every LMS permission
   - sub_admin / sub_admin_2 ............. every permission IF their account has
                                            the page key "LMS" (= LMS administrator)
   - teacher ............................. teaching permissions (still limited to
                                            courses they are a member of)
   - student ............................. none of the staff permissions (students act
                                            through course enrolment, see below)
   - finance / master / anything else .... NOTHING (platform staff have no routine
                                            access to tenant learning content)
   A head of department is a teacher plus grants (e.g. lms.course.approve).

   Actors are (source, id) because ids collide across Students/Teachers/users
   (docs/LEGACY_SCHEMA.md). Routes must run, in order:
     protect -> requireModule('lms', flag) -> requireLmsPermission(code)
     -> requireCourseAccess({ roles: [...] })        (course-scoped routes)
========================================================================= */
const sql = require("mssql");

const PERMISSIONS = [
  "lms.course.create", "lms.course.manage", "lms.course.delete", "lms.course.approve",
  "lms.lesson.edit", "lms.submission.grade", "lms.gradebook.view",
  "lms.settings.manage", "lms.analytics.department", "lms.enrolment.manage",
  "lms.gradebook.publish", // L6.4 (D-083): send LMS results into formal results. Admins hold it by default; teachers only when granted.
];
const TEACHER_DEFAULTS = ["lms.course.create", "lms.course.manage", "lms.lesson.edit", "lms.submission.grade", "lms.gradebook.view"];
const ADMIN_ROLES = ["admin", "module_admin"];
const SUB_ADMIN_ROLES = ["sub_admin", "sub_admin_2"];
const LMS_PAGE_KEY = "LMS";

const SOURCE_BY_ROLE = { student: "Students", teacher: "Teachers" };
const VALID_SOURCES = ["Students", "Teachers", "Users"];

/* Who is calling? Never trust a missing/odd token claim blindly. */
function actorOf(user) {
  if (!user || user.id == null) return null;
  const role = String(user.role || "").toLowerCase();
  const source = VALID_SOURCES.includes(user.source) ? user.source : (SOURCE_BY_ROLE[role] || "Users");
  const id = Number(user.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { source, id, role };
}

/* Pure: permissions that come from the role alone. */
function roleDefaults(user) {
  const role = String(user?.role || "").toLowerCase();
  if (user?.isMaster) return [];
  if (ADMIN_ROLES.includes(role)) return [...PERMISSIONS];
  if (SUB_ADMIN_ROLES.includes(role)) return Array.isArray(user.permissions) && user.permissions.includes(LMS_PAGE_KEY) ? [...PERMISSIONS] : [];
  if (role === "teacher") return [...TEACHER_DEFAULTS];
  return [];
}

async function loadGrants(pool, actor) {
  const r = await pool.request()
    .input("src", sql.NVarChar(20), actor.source)
    .input("uid", sql.Int, actor.id)
    .query(`SELECT permission_code FROM lms_user_permissions WHERE user_source = @src AND user_id = @uid`);
  return (r.recordset || []).map((x) => x.permission_code).filter((c) => PERMISSIONS.includes(c));
}

/* Grants are ignored for roles that must never have LMS content access. */
const MAY_HOLD_GRANTS = (user) => !user?.isMaster && ["teacher", "sub_admin", "sub_admin_2", "admin", "module_admin"].includes(String(user?.role || "").toLowerCase());

async function getEffectivePermissions(pool, user) {
  const base = roleDefaults(user);
  const actor = actorOf(user);
  if (!actor || !MAY_HOLD_GRANTS(user)) return new Set(base);
  let grants = [];
  try { grants = await loadGrants(pool, actor); } catch (err) { console.error("LMS GRANT READ ERROR (using role defaults only):", err.message); }
  return new Set([...base, ...grants]);
}

const deny = (res, code, message, extra = {}) => res.status(403).json({ success: false, code, message, ...extra });

function requireLmsPermission(...codes) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Not authenticated" });
    const have = await getEffectivePermissions(req.pool, req.user);
    req.lmsPermissions = have;
    if (!codes.some((c) => have.has(c))) return deny(res, "LMS_FORBIDDEN", "You do not have permission to do this in the LMS.", { required: codes });
    next();
  };
}

/* ---- course membership ---------------------------------------------------
   Tables are created in L2.1 (lms_course_staff, lms_course_enrolments). Contract:
     lms_course_staff(course_id, user_source, user_id, staff_role 'teacher'|'co_teacher', is_active)
     lms_course_enrolments(course_id, student_id, status 'active'|...)
   The default lookup below FAILS CLOSED on any error (including "table missing"). */
async function defaultLookup(pool, courseId, actor) {
  if (actor.source === "Students") {
    const r = await pool.request().input("c", sql.Int, courseId).input("u", sql.Int, actor.id)
      .query(`SELECT TOP 1 status FROM lms_course_enrolments WHERE course_id = @c AND student_id = @u AND status = 'active'`);
    return r.recordset && r.recordset.length ? "student" : null;
  }
  const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.NVarChar(20), actor.source).input("u", sql.Int, actor.id)
    .query(`SELECT TOP 1 staff_role FROM lms_course_staff WHERE course_id = @c AND user_source = @s AND user_id = @u AND is_active = 1`);
  const row = r.recordset && r.recordset[0];
  return row ? (row.staff_role === "co_teacher" ? "co_teacher" : "owner") : null;
}

/* Returns "owner" | "co_teacher" | "student" | "admin" | null */
async function courseRole(pool, user, courseId, lookup = defaultLookup) {
  const id = Number(courseId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const actor = actorOf(user);
  if (!actor) return null;
  const perms = await getEffectivePermissions(pool, user);
  if (perms.has("lms.settings.manage")) return "admin"; // LMS administrators work across all courses by design
  try { return await lookup(pool, id, actor); } catch (err) { console.error("LMS MEMBERSHIP READ ERROR (denying):", err.message); return null; }
}

/* roles: any of "owner","co_teacher","student","admin". Course id from req.params[param]. */
function requireCourseAccess({ roles = ["owner", "co_teacher", "admin"], param = "courseId", lookup = defaultLookup } = {}) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Not authenticated" });
    const role = await courseRole(req.pool, req.user, req.params?.[param], lookup);
    // Same answer for "no such course" and "not your course": never reveal other courses exist.
    if (!role || !roles.includes(role)) return deny(res, "COURSE_ACCESS_DENIED", "You do not have access to this course.");
    req.courseRole = role;
    next();
  };
}

module.exports = {
  PERMISSIONS, TEACHER_DEFAULTS, LMS_PAGE_KEY, actorOf, roleDefaults, getEffectivePermissions,
  requireLmsPermission, courseRole, requireCourseAccess, defaultLookup,
};
