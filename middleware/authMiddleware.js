const jwt = require("jsonwebtoken");
require("dotenv").config();

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
      process.env.JWT_SECRET || "asumbi_secret";

    const decoded = jwt.verify(token, secret);

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
      examOnly: !!decoded?.examOnly,
      examAssessmentId: decoded?.examAssessmentId ?? null,
    };

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

    next();
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
         ADMIN CAN ACCESS EVERYTHING
      =================================================== */
      if (userRole === "admin") {
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
   PAGE-LEVEL AUTHORIZATION (sub-admins)
   Unlike `authorize`, which only checks a role name, this
   checks whether the specific page was granted to a
   "sub_admin" or "sub_admin_2" account at setup time. "admin"
   always passes, exactly like the admin bypass in `authorize`
   above.
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
        (userRole === "sub_admin" || userRole === "sub_admin_2") &&
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