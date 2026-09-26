/* =========================================================================
   FINANCE AUTH MIDDLEWARE

   authMiddleware.js's authorize() has a baked-in bypass: `userRole ===
   "admin" || userRole === "module_admin"` always passes, REGARDLESS of
   which roles were requested — that's by design for ordinary tenant
   capabilities, but it would be a serious hole here: the spec is
   explicit that "Never allow an ordinary institution administrator to
   access finance issuance endpoints." So `financeOnly` below is its
   own strict check — role must be exactly "finance", no exceptions,
   no admin bypass, ever. This is deliberately NOT built on top of
   authorize("finance") for that reason.

   Finance accounts log in through the existing POST /api/auth/login
   (see routes/auth.js's role-mapping addition) — Doravo has no
   separate "control database" identity system to build a parallel
   login around (Phase 1 audit, Option A). The finance role's tenant
   scoping works exactly like every other role's: the tenant a
   finance username was found in at login is stamped into the JWT and
   resolved back to req.pool by server.js's existing DB middleware —
   a finance officer covering several institutions needs one account
   (one username) per institution they serve, same as any other role
   would.
========================================================================= */
const financeOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  const role = String(req.user.role || "").toLowerCase().trim();
  if (role !== "finance") {
    return res.status(403).json({
      success: false,
      message: "Forbidden: Doravo Finance access only",
      role,
    });
  }
  next();
};

module.exports = { financeOnly };
