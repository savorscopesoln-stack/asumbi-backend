/* =========================================================================
   LMS COMPLETION CERTIFICATES  (L7.5a, D-091)  schema step 032 `lms_certificates`.
   Routes: staff (flag `lms_gradebook`; list = `lms.gradebook.view`, issue/revoke = `lms.gradebook.publish`, + course membership), the learner's own certificate
   (studentOnly + ACTIVE enrolment) and a PUBLIC verification route (/api/lms-verify/:school/:code, routes/lmsVerify.js).

   Completion rule (documented, simple, the same for every course):
   - ALL lessons a learner can see (published, not scheduled for later, not deleted) are completed (a course with no visible lessons passes this part), AND
   - the learner-view course total (computeTotal viewer "student": released items + visible grades only) exists and is >= the school's pass mark
     (GradingSystem.passMark, 50 when none is set). No grades = not eligible (NO_GRADES), never a zero.
   - Only ACTIVE learners of a PUBLISHED or ARCHIVED course. At most 2000 learners per run.
   Issuing is an explicit staff action (never automatic, never a job). Re-running is safe: a learner who already has an ACTIVE certificate is not issued another
   (filtered unique index + NOT EXISTS in the same batch). `dryRun: true` reports counts and writes nothing.
   Revoking needs a reason (<= 300), keeps the row, and frees the learner to be issued a new certificate with a NEW code.
   The certificate stores the percent and the grade label AT ISSUE TIME (later grade edits never change an issued certificate).
   Verification code: 12 characters from an alphabet without look-alikes (0/O, 1/I/L), shown XXXX-XXXX-XXXX, 60 bits of randomness, unique.
   PUBLIC verification reveals ONLY: valid yes/no, course title, issue date and the holder's first name + last initial. Never an admission number, marks, percent,
   school contact data or an id. A revoked or unknown code answers `valid: false` with nothing else; every malformed code answers the same.
   Audit: `certificate.issued` (counts), `certificate.revoked` (id + course id; the reason text is kept). Event `lms.certificate.issued` {tenant, courseId, count}.
========================================================================= */
const crypto = require("crypto");
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { computeTotal } = require("./lmsGradeCalc");
const { VISIBLE } = require("./lmsLessons");
const { loadGradingSystem, getGradeForScore } = require("./grading");
const events = require("./lmsEvents");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 characters, no 0 O 1 I L
const CODE_RE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const MAX_LEARNERS = 2000, MAX_CELLS = 100000, MAX_PAGE = 100, DEFAULT_PASS = 50;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const reject = (code, msg) => ({ ok: false, code, errors: [msg] });
const notFound = (what = "Course") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/* Pure. A fresh code. `rand(n)` returns n random bytes (injectable for tests). */
function newCode(rand = (n) => crypto.randomBytes(n)) {
  const out = []; while (out.length < 12) for (const b of rand(16)) { if (b < 248 && out.length < 12) out.push(ALPHABET[b % 31]); } // 248 = 31 * 8: no modulo bias
  const s = out.join(""); return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
/* Pure. Normalises what a person typed (case, spaces, missing dashes) to the stored form, or null. */
function normaliseCode(raw) {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const c = raw.toUpperCase().replace(/[\s-]/g, ""); if (c.length !== 12) return null;
  const f = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`; return CODE_RE.test(f) ? f : null;
}
/* Pure. The completion rule for one learner. */
function evaluate({ lessonsTotal, lessonsDone, percent, passMark }) {
  const reasons = [];
  if (Number(lessonsDone) < Number(lessonsTotal)) reasons.push("LESSONS_INCOMPLETE");
  if (percent === null || percent === undefined) reasons.push("NO_GRADES");
  else if (Number(percent) < Number(passMark ?? DEFAULT_PASS)) reasons.push("BELOW_PASS_MARK");
  return { eligible: reasons.length === 0, reasons };
}
/* Pure. "Amina Kamau" -> "Amina K."; one name -> that name; nothing -> null. */
function holderName(full) {
  const p = String(full || "").replace(/[<>]/g, "").trim().split(/\s+/).filter(Boolean); if (!p.length) return null;
  return p.length === 1 ? p[0].slice(0, 30) : `${p[0].slice(0, 30)} ${[...p[p.length - 1]][0].toUpperCase()}.`;
}

/* ------------------------------ eligibility ------------------------------ */
async function loadEligibility(pool, cid) {
  const c = () => pool.request().input("c", sql.Int, cid);
  const cr = await c().query(`SELECT TOP 1 id, title, status FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const course = cr.recordset && cr.recordset[0]; if (!course) return notFound();
  if (!["published", "archived"].includes(course.status)) return reject("COURSE_NOT_PUBLISHED", "Publish the course before issuing certificates.");
  const [cats, its, lr, ls] = await Promise.all([
    c().query(`SELECT TOP 30 id, weight, drop_lowest FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP 200 id, category_id, max_points, weight FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL AND released = 1 ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_LEARNERS + 1} student_id FROM lms_course_enrolments WHERE course_id = @c AND status = 'active' ORDER BY student_id`),
    c().query(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE}`),
  ]);
  const ids = (lr.recordset || []).map((r) => r.student_id);
  if (ids.length > MAX_LEARNERS) return reject("TOO_MANY_LEARNERS", `At most ${MAX_LEARNERS} learners can be handled at once.`);
  const items = (its.recordset || []).map((i) => ({ id: i.id, categoryId: i.category_id ?? null, maxPoints: Number(i.max_points), weight: Number(i.weight), released: true }));
  if (ids.length * Math.max(1, items.length) > MAX_CELLS) return reject("EXPORT_TOO_LARGE", "This course is too large to handle in one go.");
  const categories = (cats.recordset || []).map((k) => ({ id: k.id, weight: Number(k.weight), dropLowest: Number(k.drop_lowest) }));
  const lessonsTotal = Number(ls.recordset && ls.recordset[0] && ls.recordset[0].n) || 0;
  const done = new Map(), grades = new Map();
  if (ids.length) {
    const json = JSON.stringify(ids);
    const [d, g] = await Promise.all([
      lessonsTotal ? c().input("ids", sql.NVarChar(sql.MAX), json).query(`SELECT TOP ${MAX_LEARNERS} p.student_id, COUNT(*) AS n FROM lms_lesson_progress p
        WHERE p.course_id = @c AND p.status = 'completed' AND p.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))
          AND p.lesson_id IN (SELECT id FROM lms_lessons WHERE course_id = @c AND deleted_at IS NULL AND ${VISIBLE}) GROUP BY p.student_id`) : { recordset: [] },
      items.length ? c().input("ids", sql.NVarChar(sql.MAX), json).query(`SELECT TOP ${MAX_CELLS} g.item_id, g.student_id, g.points, g.excused, g.hidden
        FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL AND i.released = 1
        WHERE g.course_id = @c AND g.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`) : { recordset: [] },
    ]);
    for (const r of d.recordset || []) done.set(r.student_id, Number(r.n) || 0);
    for (const r of g.recordset || []) { if (!grades.has(r.student_id)) grades.set(r.student_id, []); grades.get(r.student_id).push({ itemId: r.item_id, points: numOrNull(r.points), excused: !!r.excused, hidden: !!r.hidden }); }
  }
  const gs = await loadGradingSystem(pool), passMark = gs.passMark ?? DEFAULT_PASS;
  const learners = ids.map((sid) => {
    const t = computeTotal({ categories, items, grades: grades.get(sid) || [], viewer: "student" });
    const ev = evaluate({ lessonsTotal, lessonsDone: done.get(sid) || 0, percent: t.percent, passMark });
    const band = t.percent === null ? null : getGradeForScore(t.percent, gs);
    return { studentId: sid, lessonsDone: done.get(sid) || 0, percent: t.percent, gradeLabel: band && (band.label || band.grade) ? String(band.label || band.grade).slice(0, 50) : null, ...ev };
  });
  return { ok: true, course: { id: course.id, title: course.title }, learners, passMark, lessonsTotal };
}

/* ---------------------------------- issue ---------------------------------- */
async function issueCertificates(pool, user, courseId, body, ctx = {}) {
  const cid = posInt(courseId); if (!cid) return notFound();
  if (body !== undefined && body !== null && !isObj(body)) return { ok: false, errors: ["Send { dryRun? }."] };
  if (body && body.dryRun !== undefined && typeof body.dryRun !== "boolean") return { ok: false, errors: ["dryRun must be true or false."] };
  const dryRun = !!(body && body.dryRun === true);
  const actor = actorOf(user); if (!actor || actor.role === "student") return notFound();
  const el = await loadEligibility(pool, cid); if (!el.ok) return el;
  const have = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP ${MAX_LEARNERS} student_id FROM lms_certificates WHERE course_id = @c AND revoked_at IS NULL`);
  const issued = new Set((have.recordset || []).map((r) => r.student_id));
  const eligible = el.learners.filter((l) => l.eligible), todo = eligible.filter((l) => !issued.has(l.studentId));
  const notEligible = {}; for (const l of el.learners) for (const r of l.reasons) notEligible[r] = (notEligible[r] || 0) + 1;
  const summary = { learners: el.learners.length, eligible: eligible.length, alreadyIssued: eligible.length - todo.length, notEligible, passMark: el.passMark };
  if (dryRun) return { ok: true, dryRun: true, wouldIssue: todo.length, ...summary };
  if (!todo.length) return { ok: true, issued: 0, ...summary };
  let inserted = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = todo.map((l) => ({ s: l.studentId, cd: newCode(), p: l.percent, gl: l.gradeLabel }));
    try {
      const r = await pool.request().input("c", sql.Int, cid).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows))
        .query(`SET XACT_ABORT ON; BEGIN TRAN;
          DECLARE @n INT = 0;
          INSERT INTO lms_certificates (course_id, student_id, code, final_percent, grade_label, issued_by_source, issued_by)
            SELECT @c, j.s, j.cd, j.p, j.gl, @src, @uid FROM OPENJSON(@rows) WITH (s INT '$.s', cd NVARCHAR(20) '$.cd', p DECIMAL(5,2) '$.p', gl NVARCHAR(50) '$.gl') j
             WHERE NOT EXISTS (SELECT 1 FROM lms_certificates x WITH (UPDLOCK, HOLDLOCK) WHERE x.course_id = @c AND x.student_id = j.s AND x.revoked_at IS NULL);
          SET @n = @@ROWCOUNT;
          COMMIT; SELECT @n AS inserted;`);
      inserted = Number(r.recordset && r.recordset[0] && r.recordset[0].inserted) || 0; break;
    } catch (e) { if (!(e && (e.number === 2601 || e.number === 2627)) || attempt === 2) throw e; } // a code collision: draw new codes
  }
  await audit(pool, actor, "certificate.issued", "lms_certificates", null, { courseId: cid, issued: inserted, eligible: eligible.length });
  if (ctx.tenant && inserted) events.emit("lms.certificate.issued", { tenant: ctx.tenant, courseId: cid, count: inserted });
  return { ok: true, issued: inserted, ...summary };
}

/* ---------------------------------- read ---------------------------------- */
const shape = (r) => ({ id: r.id, studentId: r.student_id, name: r.student_name || null, admissionNo: r.admission_no || null, code: r.code, percent: numOrNull(r.final_percent), grade: r.grade_label || null,
  issuedAt: iso(r.issued_at), revoked: !!r.revoked_at, revokedAt: iso(r.revoked_at), revokedReason: r.revoked_reason || null });
async function listCertificates(pool, courseId, { page, pageSize } = {}) {
  const cid = posInt(courseId); if (!cid) return notFound();
  const size = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(pageSize, 10) || 30)), pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const cnt = await pool.request().input("c", sql.Int, cid).query(`SELECT COUNT(*) AS n FROM lms_certificates WHERE course_id = @c`);
  const r = await pool.request().input("c", sql.Int, cid).input("off", sql.Int, (pg - 1) * size).input("size", sql.Int, size)
    .query(`SELECT k.id, k.student_id, st.name AS student_name, st.admissionNo AS admission_no, k.code, k.final_percent, k.grade_label, k.issued_at, k.revoked_at, k.revoked_reason
      FROM lms_certificates k LEFT JOIN Students st ON st.id = k.student_id WHERE k.course_id = @c ORDER BY k.id DESC OFFSET @off ROWS FETCH NEXT @size ROWS ONLY`);
  const total = Number(cnt.recordset && cnt.recordset[0] && cnt.recordset[0].n) || 0;
  return { ok: true, items: (r.recordset || []).map(shape), total, page: pg, pageSize: size, hasMore: pg * size < total };
}

async function revokeCertificate(pool, user, courseId, certId, body) {
  const cid = posInt(courseId), id = posInt(certId); if (!cid || !id) return notFound("Certificate");
  const actor = actorOf(user); if (!actor || actor.role === "student") return notFound("Certificate");
  if (!isObj(body) || Object.keys(body).some((k) => k !== "reason")) return { ok: false, errors: ["Send { reason }."] };
  const reason = typeof body.reason === "string" ? body.reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").trim() : "";
  if (!reason || reason.length > 300) return { ok: false, errors: ["reason is required (1-300 characters)."] };
  const r = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).input("why", sql.NVarChar(300), reason).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
    .query(`UPDATE lms_certificates SET revoked_at = SYSUTCDATETIME(), revoked_reason = @why, revoked_by_source = @src, revoked_by = @uid
      OUTPUT INSERTED.id WHERE id = @i AND course_id = @c AND revoked_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) {
    const e = await pool.request().input("c", sql.Int, cid).input("i", sql.Int, id).query(`SELECT TOP 1 id FROM lms_certificates WHERE id = @i AND course_id = @c`);
    return e.recordset && e.recordset[0] ? reject("ALREADY_REVOKED", "This certificate is already revoked.") : notFound("Certificate");
  }
  await audit(pool, actor, "certificate.revoked", "lms_certificates", id, { courseId: cid, reason });
  return { ok: true, revoked: true };
}

/* The learner's own ACTIVE certificate (student id from the token). */
async function myCertificate(pool, user, courseId) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student") return notFound();
  const cid = posInt(courseId); if (!cid) return notFound();
  const r = await pool.request().input("c", sql.Int, cid).input("s", sql.Int, actor.id)
    .query(`SELECT TOP 1 k.code, k.final_percent, k.grade_label, k.issued_at, c.title FROM lms_certificates k JOIN lms_courses c ON c.id = k.course_id AND c.deleted_at IS NULL
      WHERE k.course_id = @c AND k.student_id = @s AND k.revoked_at IS NULL`);
  const x = r.recordset && r.recordset[0];
  return { ok: true, certificate: x ? { code: x.code, courseTitle: x.title, percent: numOrNull(x.final_percent), grade: x.grade_label || null, issuedAt: iso(x.issued_at) } : null };
}

/* PUBLIC. Same answer shape for every failure: { ok:true, valid:false }. */
async function verifyCertificate(pool, rawCode) {
  const code = normaliseCode(rawCode); if (!code) return { ok: true, valid: false };
  const r = await pool.request().input("k", sql.NVarChar(20), code)
    .query(`SELECT TOP 1 k.issued_at, k.revoked_at, c.title, st.name AS student_name FROM lms_certificates k
      JOIN lms_courses c ON c.id = k.course_id AND c.deleted_at IS NULL LEFT JOIN Students st ON st.id = k.student_id WHERE k.code = @k`);
  const x = r.recordset && r.recordset[0];
  if (!x || x.revoked_at) return { ok: true, valid: false };
  return { ok: true, valid: true, courseTitle: x.title, issuedAt: iso(x.issued_at), holder: holderName(x.student_name) };
}

module.exports = { ALPHABET, CODE_RE, MAX_LEARNERS, newCode, normaliseCode, evaluate, holderName, loadEligibility, issueCertificates, listCertificates, revokeCertificate, myCertificate, verifyCertificate };
