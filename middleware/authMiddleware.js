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

      source: decoded?.source || null,
      iat: decoded?.iat || null,
      exp: decoded?.exp || null,
    };

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

  adminOnly,
  teacherOnly,
  studentOnly,
};