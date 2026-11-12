const express = require("express");
const router = express.Router();
const { sql, getPool, listTenantKeys } = require("../config/db");
const { signReportSession, signProfileToken, verifyProfileToken } = require("../utils/reportLink");
const { isActiveStudent } = require("../utils/examAccess");

/* =========================================================================
   REPORT ACCESS — the public "Download report form" page (/report-download)

   Works like /take-assessment: nobody logs in to the portal and there is no
   password. A student types their username; the server finds them, and then:
     - profile NOT completed yet -> a 20-minute step-up token that can only
       save the profile (POST /profile). The download stays locked until then.
     - profile completed         -> a 2-hour REPORT-ONLY session (the same one
       a report link gives, utils/reportLink.js): it can read the report form's
       data and nothing else, so it cannot open the portal or change anything.

   Because the username is the only thing asked, the page is defended against
   guessing: a per-IP rate limit, and a tighter limit on usernames that do not
   exist (so it cannot be used to scan for enrolled students).
========================================================================= */

const HITS_PER_MINUTE = 30;
const MISSES_PER_10_MIN = 12;

const ipHits = new Map();   // ip -> [timestamps]
const ipMisses = new Map(); // ip -> [timestamps] (usernames that were not found)

const clientIp = (req) => req.ip || req.headers["x-forwarded-for"] || "unknown";
const recentOf = (map, ip, windowMs) => {
  const now = Date.now();
  const recent = (map.get(ip) || []).filter((t) => now - t < windowMs);
  map.set(ip, recent);
  if (map.size > 5000) map.clear();
  return recent;
};
const tooMany = (req) => {
  const ip = clientIp(req);
  const recent = recentOf(ipHits, ip, 60_000);
  recent.push(Date.now());
  return recent.length > HITS_PER_MINUTE;
};
const tooManyMisses = (req) => recentOf(ipMisses, clientIp(req), 10 * 60_000).length >= MISSES_PER_10_MIN;
const noteMiss = (req) => recentOf(ipMisses, clientIp(req), 10 * 60_000).push(Date.now());

const STUDENT_COLS = `id, username, name, status, photoUrl, profileCompleted,
  studentClass, gender, email, phone, assessmentNumber`;

const readyResponse = (student, tenant) => ({
  status: "ready",
  token: signReportSession({ student, tenant }),
  user: {
    id: student.id, username: student.username, name: student.name || "", role: "student",
    source: "Students", tenant, photoUrl: student.photoUrl || null, reportLinkSession: true,
  },
});

const inactiveResponse = (res) => res.status(403).json({
  code: "STUDENT_INACTIVE",
  message: "Your account isn't active, so a report form can't be downloaded. Please contact the school office.",
});

const loadClasses = async (pool) => {
  try {
    const r = await pool.request().query(`SELECT name FROM Classes ORDER BY name ASC`);
    return r.recordset.map((c) => c.name).filter(Boolean);
  } catch { return []; }
};

/* ---------------------------------------------------------------- verify */
router.post("/verify", async (req, res) => {
  try {
    if (tooMany(req)) return res.status(429).json({ message: "Too many attempts. Please wait a minute and try again." });
    if (tooManyMisses(req)) return res.status(429).json({ message: "Too many usernames that were not found. Please wait a few minutes and try again." });
    const username = String(req.body?.username || "").trim();
    if (!username) return res.status(400).json({ message: "Enter your username." });
    if (username.length > 60) return res.status(404).json({ message: "We couldn't find that username. Check it and try again." });

    // Look the username up in every school database (same as the take-assessment picker).
    const found = [];
    for (const tenantKey of listTenantKeys()) {
      try {
        const pool = await getPool(tenantKey);
        const r = await pool.request().input("u", sql.NVarChar, username)
          .query(`SELECT TOP 1 ${STUDENT_COLS} FROM Students WHERE username = @u`);
        if (r.recordset[0]) found.push({ student: r.recordset[0], tenant: tenantKey, pool });
      } catch (e) { /* a school DB that is down must not block the others */ }
    }
    if (!found.length) {
      noteMiss(req);
      return res.status(404).json({ message: "We couldn't find that username. Check it and try again." });
    }
    if (found.length > 1) {
      return res.status(409).json({ message: "This username exists in more than one school. Please contact the school office." });
    }

    const { student, tenant, pool } = found[0];
    if (!isActiveStudent(student.status)) return inactiveResponse(res);

    if (!student.profileCompleted) {
      return res.json({
        status: "profile_required",
        token: signProfileToken({ studentId: student.id, tenant }),
        student: { name: student.name || "", username: student.username },
        profile: {
          studentClass: student.studentClass || "", gender: student.gender || "",
          email: student.email || "", phone: student.phone || "", assessmentNumber: student.assessmentNumber || "",
        },
        classes: await loadClasses(pool),
      });
    }
    return res.json(readyResponse(student, tenant));
  } catch (err) {
    console.log("REPORT ACCESS VERIFY ERROR:", err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

/* --------------------------------------------------------------- profile */
// Same rules as the portal's first-time profile save (PUT /api/student/profile in server.js).
router.post("/profile", async (req, res) => {
  try {
    if (tooMany(req)) return res.status(429).json({ message: "Too many attempts. Please wait a minute and try again." });
    const header = req.headers.authorization || "";
    let link;
    try { link = verifyProfileToken(header.startsWith("Bearer ") ? header.slice(7) : ""); }
    catch (e) {
      return res.status(401).json({
        expired: e.name === "TokenExpiredError",
        message: e.name === "TokenExpiredError"
          ? "This step timed out. Please enter your username again."
          : "Please enter your username again.",
      });
    }

    const tenant = link.tenant || "default";
    const pool = await getPool(tenant);
    const r = await pool.request().input("id", sql.Int, Number(link.sid))
      .query(`SELECT ${STUDENT_COLS} FROM Students WHERE id = @id`);
    const student = r.recordset[0];
    if (!student) return res.status(404).json({ message: "This student record could not be found." });
    if (!isActiveStudent(student.status)) return inactiveResponse(res);

    // Already filled in (another tab / device): nothing to save, the download is simply available.
    if (student.profileCompleted) return res.json(readyResponse(student, tenant));

    const clean = (v) => (v == null ? "" : String(v)).trim();
    const studentClass = clean(req.body?.studentClass);
    const gender = clean(req.body?.gender);
    const email = clean(req.body?.email);
    let phone = clean(req.body?.phone).replace(/[\s-]/g, "");
    const assessmentNumber = clean(req.body?.assessmentNumber);

    if (!studentClass || !gender || !email || !phone || !assessmentNumber) {
      return res.status(400).json({ message: "Class, gender, email, phone and assessment number are required." });
    }
    if (!["Male", "Female"].includes(gender)) return res.status(400).json({ message: "Please select a valid gender." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    if (phone.startsWith("0")) phone = "+254" + phone.substring(1);
    if (!/^\+?\d{9,15}$/.test(phone)) return res.status(400).json({ message: "Please enter a valid phone number." });

    const classes = await loadClasses(pool);
    if (classes.length > 0 && !classes.includes(studentClass)) {
      return res.status(400).json({ message: "Please select a class from the list." });
    }

    await pool.request()
      .input("id", sql.Int, student.id)
      .input("studentClass", sql.NVarChar, studentClass)
      .input("gender", sql.NVarChar, gender)
      .input("email", sql.NVarChar, email)
      .input("phone", sql.NVarChar, phone)
      .input("assessmentNumber", sql.NVarChar, assessmentNumber)
      .query(`UPDATE Students SET studentClass = @studentClass, gender = @gender, email = @email,
                phone = @phone, assessmentNumber = @assessmentNumber, profileCompleted = 1
              WHERE id = @id AND ISNULL(profileCompleted, 0) = 0`);

    const fresh = await pool.request().input("id", sql.Int, student.id)
      .query(`SELECT ${STUDENT_COLS} FROM Students WHERE id = @id`);
    return res.json(readyResponse(fresh.recordset[0] || student, tenant));
  } catch (err) {
    console.log("REPORT ACCESS PROFILE ERROR:", err);
    res.status(500).json({ message: "Could not save your details. Please try again." });
  }
});

module.exports = router;
