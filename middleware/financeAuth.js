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

   The Finance account is defined in the server ENVIRONMENT (utils/financeAccount.js),
   like the master admin: it logs in through the existing POST /api/auth/login, which
   answers its reserved username from the env and never from a database. Its token
   carries role "finance" and a home tenant (only used for req.pool); every finance
   route then reaches institutions explicitly through :tenantKey.
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
