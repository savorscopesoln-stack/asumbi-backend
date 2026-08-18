/* =========================================================
   PAGE KEYS
   Canonical list of the pages a "sub_admin" account can be
   granted access to. Kept in one place so registration
   (granting access) and the route middleware (enforcing it)
   can never drift apart.

   NOTE: keep these keys in sync with
   frontend/src/permissions.js — the frontend uses the exact
   same strings so a page granted here shows up in that
   account's sidebar and routes.
========================================================= */
const PAGE_KEYS = [
  "Dashboard",
  "Students",
  "Teachers",
  "Marks",
  "Assessments",
  "E-Assessments",
  "Practicum",
  "Registration",
  "Users",
  "Password Reset",
  "Leave-out",
  "Meals",
  "AttendanceReport",
  "Reports",
  "Graduation",
];

/* Keep only valid, de-duplicated page keys from whatever was submitted. */
const sanitizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const unique = new Set(
    input.filter((p) => typeof p === "string" && PAGE_KEYS.includes(p))
  );
  return Array.from(unique);
};

module.exports = { PAGE_KEYS, sanitizePermissions };
