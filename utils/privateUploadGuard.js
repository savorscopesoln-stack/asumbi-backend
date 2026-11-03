/* Student submissions live in uploads/<school>/lms-private (L5.2b). That folder must NEVER be served as a static file: it is read only through the
   authenticated LMS download route. This middleware sits in front of express.static("/uploads") and answers 404 for any path that names it,
   in any letter case or percent-encoding; a path that cannot be decoded is also refused. */
function denyPrivateUploads(req, res, next) {
  let decoded;
  try { decoded = decodeURIComponent(String(req.path || "")).toLowerCase(); } catch { return res.status(404).end(); }
  if (decoded.includes("lms-private") || decoded.replace(/\\/g, "/").split("/").some((seg) => seg.trim().toLowerCase().startsWith("lms-private"))) return res.status(404).end();
  return next();
}
module.exports = { denyPrivateUploads };
