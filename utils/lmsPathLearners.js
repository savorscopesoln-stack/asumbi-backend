/* =========================================================================
   LMS LEARNING PATHS, learners  (L9.3b, D-109)  NO schema step (table `lms_path_learners` exists since step 040). Flag `lms_paths`.
   Staff hand a path to NAMED learners; each learner sees only the paths assigned to them. A path is a teaching aid, never a gate (D-108): nothing here hides,
   unlocks or reorders a lesson, and no lesson rule, progress count or report changes.

   STAFF  /courses/:id/paths/:pathId/learners   (read = any course staff, write = `lms.course.manage` + membership)
   - PUT    { studentIds: [1-100 distinct ids], reason?: <= 300 plain text }  assign. Only ACTIVELY enrolled learners of THIS course are assigned; every other id is
            reported under `skipped` (NOT_ENROLLED) and nothing is written for it. Idempotent: a learner who already holds the path is counted under `alreadyAssigned`
            (their original reason and date stay). ONE transaction; the path is locked (UPDLOCK, HOLDLOCK) so two teachers cannot double-assign (the unique live index is the backstop).
   - DELETE /:studentId   withdraw: sets `withdrawn_at`, the row stays (history); 404 if the learner does not hold it. A withdrawn learner can be assigned again (a NEW row).
   - GET    ?page&pageSize   who holds it (name, assignedAt, reason; NO admission number) + how many of the path's lessons each has COMPLETED (counts only, read from
            `lms_lesson_progress`; no seconds, no dates). Only ACTIVELY enrolled learners are listed.
   - Writes need a draft/pending/published course (archived = 409 COURSE_READ_ONLY). Reason text is stored as plain text (< > and control characters stripped).
   LEARNER  GET /courses/:id/learn/paths   (studentOnly + ACTIVE enrolment; published or archived course)
   - ONLY the paths assigned to ME, live, of this course. Items = the path's lessons that I can ALREADY see (the lesson list the course player uses: published and released,
     so a draft or unreleased lesson is silently left out and never named) with `status` not_started | in_progress | completed and `locked` (an unmet prerequisite, same rule as
     the player). progress = { done, total } over the lessons I can see. Another learner's path is never listed; no other learner is named; the teacher's reason IS shown (it is
     addressed to the learner: Q93).
   Audit: path.learners_assigned (ids and counts, never the reason text) | path.learner_withdrawn.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { posInt } = require("./lmsCourseParts");
const disc = require("./lmsDiscussions");
const { courseStatus, notFound, reject, iso, isObj } = disc._internal;
const { cleanText, viewerOf } = disc;
const prereq = require("./lmsPrerequisites");

const MAX_BATCH = 100, REASON_MAX = 300, MAX_PAGE = 50, MAX_MY_PATHS = 30, MAX_ITEMS = 50;
const paging = (q = {}) => { const p = Math.max(1, parseInt(q.page, 10) || 1), s = Math.min(MAX_PAGE, Math.max(1, parseInt(q.pageSize, 10) || 20)); return { page: p, pageSize: s, offset: (p - 1) * s }; };

/* Pure. { ok, value:{ studentIds, reason } }. */
function validateAssign(body) {
  if (!isObj(body)) return { ok: false, errors: ["Send a JSON object."] };
  const extra = Object.keys(body).filter((k) => !["studentIds", "reason"].includes(k)); if (extra.length) return { ok: false, errors: [`Unknown field: ${extra[0]}.`] };
  const ids = body.studentIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH) return { ok: false, errors: [`studentIds must be a list of 1-${MAX_BATCH} learner ids.`] };
  if (!ids.every((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)) return { ok: false, errors: ["Every learner id must be a positive whole number."] };
  if (new Set(ids).size !== ids.length) return { ok: false, errors: ["A learner can appear only once in the list."] };
  let reason = null;
  if (body.reason !== undefined && body.reason !== null) { const r = cleanText(body.reason); if (r === null || r.length > REASON_MAX) return { ok: false, errors: [`reason must be text up to ${REASON_MAX} characters.`] }; reason = r || null; }
  return { ok: true, value: { studentIds: ids, reason } };
}

const staffCtx = async (pool, user, courseId, write) => {
  const v = viewerOf(user, true), cid = posInt(courseId); if (!v || !cid) return notFound(); const s = await courseStatus(pool, cid); if (!s) return notFound();
  if (write && s === "archived") return reject("COURSE_READ_ONLY", "This course is archived. Learning paths are read only.");
  return { ok: true, v, cid };
};
const loadPath = async (pool, cid, pid) => { const r = await pool.request().input("c", sql.Int, cid).input("p", sql.Int, pid).query(`SELECT TOP 1 id FROM lms_paths WHERE id = @p AND course_id = @c AND deleted_at IS NULL`); return !!(r.recordset && r.recordset[0]); };

async function assignLearners(pool, user, courseId, pathId, body) {
  const pid = posInt(pathId); const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!pid) return notFound("Path");
  const val = validateAssign(body); if (!val.ok) return val; const { studentIds, reason } = val.value;
  const r = await pool.request().input("c", sql.Int, c.cid).input("p", sql.Int, pid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(studentIds))
    .input("why", sql.NVarChar(300), reason).input("src", sql.NVarChar(20), c.v.source).input("uid", sql.Int, c.v.id)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      IF NOT EXISTS (SELECT 1 FROM lms_paths WITH (UPDLOCK, HOLDLOCK) WHERE id = @p AND course_id = @c AND deleted_at IS NULL) BEGIN ROLLBACK; SELECT CAST(NULL AS INT) AS assigned, CAST(NULL AS INT) AS already, CAST(NULL AS NVARCHAR(MAX)) AS ok_json, N'NOT_FOUND' AS code; RETURN; END
      DECLARE @req TABLE (id INT PRIMARY KEY), @ok TABLE (id INT PRIMARY KEY);
      INSERT INTO @req (id) SELECT CAST(value AS INT) FROM OPENJSON(@ids);
      INSERT INTO @ok (id) SELECT q.id FROM @req q JOIN lms_course_enrolments e ON e.course_id = @c AND e.student_id = q.id AND e.status = 'active';
      DECLARE @already INT = (SELECT COUNT(*) FROM @ok o WHERE EXISTS (SELECT 1 FROM lms_path_learners l WHERE l.path_id = @p AND l.student_id = o.id AND l.withdrawn_at IS NULL));
      INSERT INTO lms_path_learners (path_id, course_id, student_id, reason, assigned_by_source, assigned_by)
        SELECT @p, @c, o.id, @why, @src, @uid FROM @ok o WHERE NOT EXISTS (SELECT 1 FROM lms_path_learners l WHERE l.path_id = @p AND l.student_id = o.id AND l.withdrawn_at IS NULL);
      DECLARE @assigned INT = @@ROWCOUNT;
      COMMIT;
      SELECT @assigned AS assigned, @already AS already, (SELECT id FROM @ok FOR JSON PATH) AS ok_json, CAST(NULL AS NVARCHAR(20)) AS code;`);
  const row = r.recordset && r.recordset[0]; if (!row || row.code === "NOT_FOUND") return notFound("Path");
  let okIds = []; try { okIds = JSON.parse(row.ok_json || "[]").map((x) => Number(x.id)); } catch { okIds = []; }
  const okSet = new Set(okIds); const skipped = studentIds.filter((id) => !okSet.has(id)).map((id) => ({ studentId: id, reason: "NOT_ENROLLED" }));
  const assigned = Number(row.assigned) || 0, already = Number(row.already) || 0;
  await audit(pool, c.v, "path.learners_assigned", "lms_paths", pid, { courseId: c.cid, requested: studentIds.length, assigned, alreadyAssigned: already, skipped: skipped.length });
  return { ok: true, assigned, alreadyAssigned: already, skipped };
}

async function withdrawLearner(pool, user, courseId, pathId, studentId) {
  const pid = posInt(pathId), sid = posInt(studentId); const c = await staffCtx(pool, user, courseId, true); if (!c.ok) return c; if (!pid || !sid) return notFound("Path");
  const r = await pool.request().input("c", sql.Int, c.cid).input("p", sql.Int, pid).input("s", sql.Int, sid)
    .query(`UPDATE l SET withdrawn_at = SYSUTCDATETIME() OUTPUT INSERTED.id FROM lms_path_learners l JOIN lms_paths p ON p.id = l.path_id AND p.course_id = l.course_id AND p.deleted_at IS NULL
      WHERE l.path_id = @p AND l.course_id = @c AND l.student_id = @s AND l.withdrawn_at IS NULL`);
  if (!(r.recordset && r.recordset[0])) return notFound("Learner");
  await audit(pool, c.v, "path.learner_withdrawn", "lms_paths", pid, { courseId: c.cid, studentId: sid });
  return { ok: true, withdrawn: true };
}

async function listLearners(pool, user, courseId, pathId, query = {}) {
  const pid = posInt(pathId); const c = await staffCtx(pool, user, courseId, false); if (!c.ok) return c; if (!pid) return notFound("Path");
  if (!(await loadPath(pool, c.cid, pid))) return notFound("Path");
  const pg = paging(query);
  const r = await pool.request().input("c", sql.Int, c.cid).input("p", sql.Int, pid).input("off", sql.Int, pg.offset).input("lim", sql.Int, pg.pageSize)
    .query(`SELECT l.student_id, s.name AS student_name, l.assigned_at, l.reason, COUNT(*) OVER() AS total_count,
        (SELECT COUNT(*) FROM lms_path_items i JOIN lms_lessons x ON x.id = i.lesson_id AND x.course_id = @c AND x.deleted_at IS NULL WHERE i.path_id = @p) AS lesson_total,
        (SELECT COUNT(*) FROM lms_path_items i JOIN lms_lessons x ON x.id = i.lesson_id AND x.course_id = @c AND x.deleted_at IS NULL
           JOIN lms_lesson_progress g ON g.lesson_id = i.lesson_id AND g.course_id = @c AND g.student_id = l.student_id AND g.status = 'completed' WHERE i.path_id = @p) AS lessons_completed
      FROM lms_path_learners l
      JOIN lms_course_enrolments e ON e.course_id = l.course_id AND e.student_id = l.student_id AND e.status = 'active'
      JOIN Students s ON s.id = l.student_id
      WHERE l.path_id = @p AND l.course_id = @c AND l.withdrawn_at IS NULL ORDER BY s.name, l.student_id OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { ok: true, items: rows.map((x) => ({ studentId: x.student_id, name: x.student_name, assignedAt: iso(x.assigned_at), reason: x.reason || null, lessonsCompleted: Number(x.lessons_completed) || 0, lessonTotal: Number(x.lesson_total) || 0 })),
    total: rows.length ? Number(rows[0].total_count) : 0, page: pg.page, pageSize: pg.pageSize };
}

/* LEARNER: only the paths assigned to ME. Pure helper: shape one path from its item rows, the visible-lesson map and my progress map. */
function shapeMyPath(p, items, visible, progress) {
  const out = [];
  for (const it of items) {
    const les = visible.get(Number(it.lesson_id)); if (!les) continue; // draft / unreleased / deleted: left out, never named
    const st = progress.get(Number(it.lesson_id));
    out.push({ lessonId: les.id, title: les.title, status: st === "completed" ? "completed" : st ? "in_progress" : "not_started", locked: !!les.locked });
  }
  return { id: p.id, title: p.title, description: p.description || null, kind: p.kind, reason: p.reason || null, items: out, progress: { done: out.filter((x) => x.status === "completed").length, total: out.length } };
}

async function myPaths(pool, user, courseId) {
  const v = viewerOf(user, false), cid = posInt(courseId); if (!v || !cid) return notFound(); const s = await courseStatus(pool, cid); if (!s || !["published", "archived"].includes(s)) return notFound();
  const pr = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id)
    .query(`SELECT TOP ${MAX_MY_PATHS} p.id, p.title, p.description, p.kind, l.reason FROM lms_path_learners l JOIN lms_paths p ON p.id = l.path_id AND p.course_id = l.course_id AND p.deleted_at IS NULL
      WHERE l.course_id = @c AND l.student_id = @vid AND l.withdrawn_at IS NULL ORDER BY l.assigned_at DESC, p.id DESC`);
  const paths = pr.recordset || []; if (!paths.length) return { ok: true, paths: [] };
  const ids = paths.map((p) => Number(p.id));
  const ir = await pool.request().input("c", sql.Int, cid).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
    .query(`SELECT TOP ${MAX_MY_PATHS * MAX_ITEMS} i.path_id, i.lesson_id, i.position FROM lms_path_items i WHERE i.course_id = @c AND i.path_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids)) ORDER BY i.path_id, i.position, i.id`);
  const list = await prereq.studentListView(pool, cid, v.id); if (!list.ok) return list;
  const visible = new Map([...list.sections.flatMap((x) => x.lessons), ...list.unsectioned].map((l) => [Number(l.id), l]));
  const gr = await pool.request().input("c", sql.Int, cid).input("vid", sql.Int, v.id).query(`SELECT TOP 5000 lesson_id, status FROM lms_lesson_progress WHERE course_id = @c AND student_id = @vid`);
  const progress = new Map((gr.recordset || []).map((x) => [Number(x.lesson_id), x.status]));
  const by = new Map(); for (const it of ir.recordset || []) { const l = by.get(Number(it.path_id)) || []; l.push(it); by.set(Number(it.path_id), l); }
  return { ok: true, paths: paths.map((p) => shapeMyPath(p, by.get(Number(p.id)) || [], visible, progress)) };
}

module.exports = { MAX_BATCH, REASON_MAX, validateAssign, shapeMyPath, assignLearners, withdrawLearner, listLearners, myPaths };
