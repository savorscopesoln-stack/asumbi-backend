const jwt = require("jsonwebtoken");
require("dotenv").config();

/* =========================================================
   TRIAL EXPIRY GATE
   When an institution's trial period (set by Doravo Finance) has ended, its
   staff can still read and sign out, but every change (POST/PUT/PATCH/DELETE)
   is refused with code TRIAL_EXPIRED; the frontend greys the screen out.
   Never blocked: Finance accounts, the master admin, auth, the finance and
   tenant-license endpoints, and students/exam sessions (so a paper in
   progress is never lost when the trial ends mid-exam). Fails OPEN — if the
   license can't be read, the request goes through.
========================================================= */
const TRIAL_EXEMPT_PREFIXES = ["/api/auth", "/api/finance", "/api/tenant"];
const trialGate = async (req, res, next) => {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const role = req.user.role;
    if (role === "finance" || role === "student" || req.user.isMaster || req.user.examOnly) return next();
    const url = req.originalUrl.split("?")[0];
    if (TRIAL_EXEMPT_PREFIXES.some((p) => url === p || url.startsWith(p + "/"))) return next();
    if (!req.pool) return next();
    const { isTrialExpired } = require("../utils/tenantLicense");
    if (await isTrialExpired(req.pool, req.user.tenant)) {
      return res.status(403).json({
        success: false,
        code: "TRIAL_EXPIRED",
        message: "Your trial period has ended. Please contact Doravo to continue.",
      });
    }
  } catch (err) {
    console.error("TRIAL GATE ERROR (allowing request):", err.message);
  }
  next();
};

/* =========================================================
   PROTECT MIDDLEWARE
========================================================= */
const protect = (req, res, next) => {
  try {
    let token = null;

    /* =====================================================
       GET TOKEN
    ===================================================== */
    const authHeader = req.headers.authorization;

    if (
      authHeader &&
      authHeader.startsWith("Bearer ")
    ) {
      token = authHeader.split(" ")[1];
    }

    /* =====================================================
       NO TOKEN
    ===================================================== */
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    /* =====================================================
       VERIFY TOKEN
    ===================================================== */
    const secret =
      process.env.JWT_SECRET || "doravo_core_secret";

    const decoded = jwt.verify(token, secret);

    /* REPORT LINKS (utils/reportLink.js)
       A download-link token only proves "this link was issued for student X" — it is
       exchanged at POST /api/auth/report-link and must never work as a login itself. */
    if (decoded?.typ === "report-link" || decoded?.typ === "transcript-link") {
      return res.status(401).json({ success: false, message: "This is a download link, not a login." });
    }

    /* =====================================================
       ATTACH USER
    ===================================================== */
    req.user = {
      id: decoded?.id || null,

      /*
        VERY IMPORTANT FIX
        prevents undefined role crash
      */
      role: String(decoded?.role || "user")
        .toLowerCase()
        .trim(),

      username: decoded?.username || null,
      email: decoded?.email || null,

      /*
        SUB-ADMIN PAGE ACCESS
        JSON array of page keys (see utils/pages.js) this account is
        allowed to open. Only meaningful when role === "sub_admin" or
        "sub_admin_2"; "admin" always has full access regardless of
        this list.
      */
      permissions: Array.isArray(decoded?.permissions)
        ? decoded.permissions
        : [],

      source: decoded?.source || null,

      /*
        MULTI-TENANT
        Which tenant DB (see config/db.js / DB_TENANTS) this account's
        row actually lives in — "default" for tokens minted before
        multi-tenant support existed, or that never got a tenant
        stamped on them. server.js's DB middleware already uses this
        same claim to pick req.pool before `protect` even runs; this
        just also exposes it on req.user for any controller that
        wants it directly.
      */
      tenant: decoded?.tenant || "default",

      iat: decoded?.iat || null,
      exp: decoded?.exp || null,

      mustChangePassword: !!decoded?.mustChangePassword,
      profileIncomplete: !!decoded?.profileIncomplete,

      /*
        EXAM-ONLY SESSION SCOPING
        These two claims come from /e-assessments/exam-login and scope
        the token to exactly one assessment. Without forwarding them
        here, every check in eAssessment.controller.js that reads
        req.user.examOnly / req.user.examAssessmentId always saw
        `undefined`, so a student could never actually start an exam
        even after a correct exam-password login.
      */
      isMaster: !!decoded?.isMaster, // the protected platform account (utils/masterAdmin.js)
      examOnly: !!decoded?.examOnly,
      examAssessmentId: decoded?.examAssessmentId ?? null,
    };

    /* REPORT-ONLY SESSION
       Opened from a report link: a student session limited to reading what the report
       form needs. Everything else (any write, any other endpoint) is refused. */
    if (decoded?.scope === "report") {
      const { isAllowedForReportSession } = require("../utils/reportLink");
      if (!isAllowedForReportSession(req.method, req.originalUrl)) {
        return res.status(403).json({
          success: false, code: "REPORT_LINK_SCOPE",
          message: "This link only opens your report form.",
        });
      }
    }

    /* =====================================================
       MANDATORY PASSWORD CHANGE
       If this account is flagged (new account, or an admin
       reset it to the default password), every route except
       the change-password endpoint itself is blocked until
       they set their own password. Centralized here so it
       applies to every route protected by `protect`, instead
       of having to be added to each route individually.
    ===================================================== */
    const isChangePasswordRoute =
      req.method === "PUT" &&
      req.originalUrl.split("?")[0].replace(/\/+$/, "").endsWith("/api/auth/change-password");

    if (req.user.mustChangePassword && !isChangePasswordRoute) {
      return res.status(403).json({
        success: false,
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "You must change your password before continuing.",
      });
    }

    /* =====================================================
       MANDATORY PROFILE COMPLETION (students only)
       Right after their first password change, a student must fill
       in their profile details (see PUT /api/student/profile) before
       anything else in the portal opens up. Every route is blocked
       except the profile endpoints themselves (GET to load current
       values, PUT to save, and the photo upload) and change-password
       (in case they still need it).
    ===================================================== */
    const isStudentProfileRoute = req.originalUrl
      .split("?")[0]
      .replace(/\/+$/, "")
      .includes("/api/student/profile");

    if (
      req.user.profileIncomplete &&
      !isChangePasswordRoute &&
      !isStudentProfileRoute
    ) {
      return res.status(403).json({
        success: false,
        code: "PROFILE_INCOMPLETE",
        message: "Please complete your profile before continuing.",
      });
    }

    return trialGate(req, res, next);
  } catch (err) {
    console.log("❌ JWT ERROR:", err.message);

    /* =====================================================
       TOKEN EXPIRED
    ===================================================== */
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        expired: true,
        message: "Token expired. Please login again.",
      });
    }

    /* =====================================================
       INVALID TOKEN
    ===================================================== */
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
};

/* =========================================================
   ROLE AUTHORIZATION
========================================================= */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    try {
      /* ===================================================
         USER NOT FOUND
      =================================================== */
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated",
        });
      }

      /* ===================================================
         USER ROLE
      =================================================== */
      const userRole = String(
        req.user.role || ""
      )
        .toLowerCase()
        .trim();

      /* ===================================================
         ALLOWED ROLES
      =================================================== */
      const roles = allowedRoles.map((r) =>
        String(r || "")
          .toLowerCase()
          .trim()
      );

      /* ===================================================
         NO ROLE RESTRICTION
      =================================================== */
      if (roles.length === 0) {
        return next();
      }

      /* ===================================================
         ADMIN BYPASS FIX
         ADMIN CAN ACCESS EVERYTHING. "module_admin" is a second
         full-privilege tier (see requirePage() below for the part
         that's actually restricted for them — which pages they can
         reach) and gets the exact same bypass here, so every
         authorize("admin")/adminOnly-gated action (creating other
         accounts, raw records, notification settings, etc.) works
         identically for both roles.
      =================================================== */
      if (userRole === "admin" || userRole === "module_admin") {
        return next();
      }

      /* ===================================================
         ROLE CHECK
      =================================================== */
      if (!roles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: insufficient permissions",
          role: userRole,
          allowed: roles,
        });
      }

      next();
    } catch (err) {
      console.log("❌ AUTH ERROR:", err.message);

      return res.status(500).json({
        success: false,
        message: "Authorization error",
      });
    }
  };
};

/* =========================================================
   PAGE-LEVEL AUTHORIZATION (sub-admins + module admins)
   Unlike `authorize`, which only checks a role name, this
   checks whether the specific page was granted at setup time.
   "admin" always passes, exactly like the admin bypass in
   `authorize` above. "sub_admin" / "sub_admin_2" / "module_admin"
   all go through the same permissions-array check — a
   "module_admin" has every admin CAPABILITY (see the authorize()
   bypass above) but, like a sub-admin, can only open the specific
   pages granted to their account.
========================================================= */
const requirePage = (pageKey) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Not authenticated",
        });
      }

      const userRole = String(req.user.role || "")
        .toLowerCase()
        .trim();

      if (userRole === "admin") {
        return next();
      }

      const permissions = Array.isArray(req.user.permissions)
        ? req.user.permissions
        : [];

      if (
        (userRole === "sub_admin" || userRole === "sub_admin_2" || userRole === "module_admin") &&
        permissions.includes(pageKey)
      ) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: `Forbidden: no access to "${pageKey}"`,
        role: userRole,
      });
    } catch (err) {
      console.log("❌ PAGE AUTH ERROR:", err.message);

      return res.status(500).json({
        success: false,
        message: "Authorization error",
      });
    }
  };
};

/* =========================================================
   OPTIONAL ADMIN ONLY
========================================================= */
const adminOnly = authorize("admin");

/* =========================================================
   OPTIONAL TEACHER ONLY
========================================================= */
const teacherOnly = authorize("teacher");

/* =========================================================
   OPTIONAL STUDENT ONLY
========================================================= */
const studentOnly = authorize("student");

/* =========================================================
   EXPORTS
========================================================= */
module.exports = {
  protect,
  authorize,
  requirePage,

  adminOnly,
  teacherOnly,
  studentOnly,
};