/* =========================================================================
   LMS RUBRICS  (L5.3a)  criteria x levels, weights, a reusable library, outcome tags per criterion.
   NO scoring yet: marking with a rubric is L5.4. This unit only defines, stores, copies and attaches rubrics.

   Rules (documented, simple):
   - A rubric belongs to one course, or to the SCHOOL library (course_id NULL). Course staff with `lms.course.manage` write course rubrics;
     LMS administrators (`lms.settings.manage`) write the school library; any teacher can READ the library and COPY a rubric into a course.
     A library rubric is never attached directly: the copy belongs to the course, so editing the library later cannot change marked work.
   - Shape: title (1-200), description (plain text, <=1000), 1-20 criteria. A criterion has a title, a description (<=500), a WEIGHT and 2-8 levels.
     weight = the points available for that criterion (0.01-1000, 2 decimals). The rubric total (sum of weights) is at most 1000.
     A level has a label (1-100), a description (<=500) and points 0..weight (2 decimals); points are distinct inside a criterion and the best
     level is worth exactly the weight, so a perfect mark can be reached. Levels are stored best first.
   - Saving is a full replace in ONE transaction (PUT sends the whole rubric). Criterion ids change on every save, so a rubric whose assignment has
     SUBMITTED work is frozen (409 RUBRIC_IN_USE): marks must keep meaning what they meant.
   - Each criterion may carry up to 5 learning-outcome tags (`lms_outcome_tags`, entity 'rubric_criterion'; course_id 0 = school library).
   - One rubric per assignment (`lms_assignment_rubrics`). Attach / change / remove is refused once the assignment has submitted work (HAS_SUBMISSIONS).
   - A rubric attached to a live assignment cannot be deleted (409 RUBRIC_ATTACHED). Delete = soft delete. Max 100 rubrics per course, 200 in the library.
   Every query is parameterised and every course query also matches course_id.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");

const MAX_PER_COURSE = 100, MAX_LIBRARY = 200, MAX_CRITERIA = 20, MIN_LEVELS = 2, MAX_LEVELS = 8, MAX_TAGS = 5, MAX_TOTAL = 1000;
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
const multiLine = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });
const money = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && Math.round(n * 100) / 100 === n ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;

const TOP = ["title", "description", "criteria"], CRIT = ["title", "description", "weight", "levels", "outcomeIds"], LEVEL = ["label", "description", "points"];

/* Pure. Whole-rubric validation. Returns { ok, value:{title, description, criteria:[{title, description, weight, outcomeIds, levels:[{label, description, points}]}]} }. */
function validate(body) {
  const errors = [];
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  for (const k of Object.keys(body)) if (!TOP.includes(k)) errors.push(`Unknown field "${k}".`);
  const title = oneLine(body.title); if (title.length < 1 || title.length > 200) errors.push("title is required: 1-200 characters.");
  const description = multiLine(body.description); if (description.length > 1000) errors.push("description can be at most 1000 characters.");
  if (!Array.isArray(body.criteria) || body.criteria.length < 1 || body.criteria.length > MAX_CRITERIA) { errors.push(`criteria must be a list of 1-${MAX_CRITERIA} criteria.`); return { ok: false, errors }; }
  const criteria = []; let total = 0;
  body.criteria.forEach((c, i) => {
    const at = `Criterion ${i + 1}`;
    if (!isPlainObject(c)) { errors.push(`${at} must be an object.`); return; }
    for (const k of Object.keys(c)) if (!CRIT.includes(k)) errors.push(`${at}: unknown field "${k}".`);
    const t = oneLine(c.title); if (t.length < 1 || t.length > 200) errors.push(`${at}: title is required, 1-200 characters.`);
    const d = multiLine(c.description); if (d.length > 500) errors.push(`${at}: description can be at most 500 characters.`);
    const w = money(c.weight); if (w === null || w < 0.01 || w > MAX_TOTAL) errors.push(`${at}: weight must be a number 0.01-${MAX_TOTAL} with at most 2 decimals.`);
    let outcomeIds = [];
    if (c.outcomeIds !== undefined) {
      const ids = Array.isArray(c.outcomeIds) ? c.outcomeIds.map(posInt) : null;
      if (!ids || ids.length > MAX_TAGS || ids.some((x) => x === null)) errors.push(`${at}: outcomeIds must be a list of at most ${MAX_TAGS} outcome ids.`); else outcomeIds = [...new Set(ids)];
    }
    const levels = [];
    if (!Array.isArray(c.levels) || c.levels.length < MIN_LEVELS || c.levels.length > MAX_LEVELS) errors.push(`${at}: levels must be a list of ${MIN_LEVELS}-${MAX_LEVELS} levels.`);
    else {
      c.levels.forEach((l, j) => {
        const lat = `${at}, level ${j + 1}`;
        if (!isPlainObject(l)) { errors.push(`${lat} must be an object.`); return; }
        for (const k of Object.keys(l)) if (!LEVEL.includes(k)) errors.push(`${lat}: unknown field "${k}".`);
        const label = oneLine(l.label); if (label.length < 1 || label.length > 100) errors.push(`${lat}: label is required, 1-100 characters.`);
        const ld = multiLine(l.description); if (ld.length > 500) errors.push(`${lat}: description can be at most 500 characters.`);
        const p = money(l.points); if (p === null || p < 0 || (w !== null && p > w)) errors.push(`${lat}: points must be a number from 0 to the criterion weight, at most 2 decimals.`);
        levels.push({ label, description: ld, points: p });
      });
      if (levels.every((l) => l.points !== null)) {
        const pts = levels.map((l) => l.points);
        if (new Set(pts).size !== pts.length) errors.push(`${at}: two levels have the same points.`);
        else if (w !== null && Math.max(...pts) !== w) errors.push(`${at}: the best level must be worth exactly the weight (${w}).`);
      }
    }
    if (w !== null) total += w;
    levels.sort((a, b) => b.points - a.points);
    criteria.push({ title: t, description: d, weight: w, outcomeIds, levels });
  });
  if (round2(total) > MAX_TOTAL) errors.push(`The criteria weights add up to more than ${MAX_TOTAL}.`);
  return errors.length ? { ok: false, errors } : { ok: true, value: { title, description, criteria } };
}

const totalOf = (criteria) => round2(criteria.reduce((s, c) => s + Number(c.weight), 0));

/* ------------------------------ reading ---------------------------------- */
const scopeSql = (courseId) => (courseId == null ? "course_id IS NULL" : "course_id = @c");
const scoped = (pool, courseId) => { const r = pool.request(); if (courseId != null) r.input("c", sql.Int, courseId); return r; };

async function loadRow(pool, courseId, id) {
  const r = await scoped(pool, courseId).input("id", sql.Int, id).query(`SELECT TOP 1 id, course_id, title, description, created_at, updated_at FROM lms_rubrics WHERE id = @id AND ${scopeSql(courseId)} AND deleted_at IS NULL`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}

/* Full shape: criteria, levels, outcome tags. Three bounded queries (<=20 criteria, <=160 levels, <=100 tags). */
async function readFull(pool, row) {
  const cr = await pool.request().input("rid", sql.Int, row.id).query(`SELECT id, position, title, description, weight FROM lms_rubric_criteria WHERE rubric_id = @rid ORDER BY position`);
  const lv = await pool.request().input("rid", sql.Int, row.id).query(`SELECT l.criterion_id, l.position, l.label, l.description, l.points FROM lms_rubric_levels l
    INNER JOIN lms_rubric_criteria c ON c.id = l.criterion_id WHERE c.rubric_id = @rid ORDER BY l.criterion_id, l.position`);
  const tg = await pool.request().input("rid", sql.Int, row.id).query(`SELECT t.entity_id, o.id AS outcome_id, o.code, o.title FROM lms_outcome_tags t
    INNER JOIN lms_learning_outcomes o ON o.id = t.outcome_id AND o.deleted_at IS NULL
    INNER JOIN lms_rubric_criteria c ON c.id = t.entity_id WHERE t.entity_type = 'rubric_criterion' AND c.rubric_id = @rid ORDER BY t.entity_id, o.code`);
  const criteria = (cr.recordset || []).map((c) => ({
    id: c.id, position: c.position, title: c.title, description: c.description || "", weight: Number(c.weight),
    levels: (lv.recordset || []).filter((l) => l.criterion_id === c.id).map((l) => ({ position: l.position, label: l.label, description: l.description || "", points: Number(l.points) })),
    outcomes: (tg.recordset || []).filter((t) => t.entity_id === c.id).map((t) => ({ id: t.outcome_id, code: t.code, title: t.title })),
  }));
  return { id: row.id, courseId: row.course_id ?? null, title: row.title, description: row.description || "", maxPoints: totalOf(criteria), criteria, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function getRubric(pool, courseId, id) {
  const row = await loadRow(pool, courseId, id);
  return row ? { ok: true, rubric: await readFull(pool, row) } : { ok: false, notFound: true, errors: ["Rubric not found."] };
}

async function listRubrics(pool, courseId, opts = {}) {
  const { size, pg } = paging(opts);
  const r = await scoped(pool, courseId).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size).query(`SELECT r.id, r.course_id, r.title, r.description, r.updated_at,
      (SELECT COUNT(*) FROM lms_rubric_criteria c WHERE c.rubric_id = r.id) AS criteria_count,
      (SELECT COALESCE(SUM(c.weight), 0) FROM lms_rubric_criteria c WHERE c.rubric_id = r.id) AS max_points,
      (SELECT COUNT(*) FROM lms_assignment_rubrics ar INNER JOIN lms_assignments a ON a.id = ar.assignment_id AND a.deleted_at IS NULL WHERE ar.rubric_id = r.id) AS attached_count,
      COUNT(*) OVER() AS total_count
    FROM lms_rubrics r WHERE ${scopeSql(courseId).replace("course_id", "r.course_id")} AND r.deleted_at IS NULL ORDER BY r.title, r.id OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  return { items: rows.map((x) => ({ id: x.id, courseId: x.course_id ?? null, title: x.title, description: x.description || "", criteriaCount: x.criteria_count, maxPoints: Number(x.max_points), attachedCount: x.attached_count, updatedAt: x.updated_at })),
    total: rows.length ? rows[0].total_count : 0, page: pg, pageSize: size };
}

/* ------------------------------ writing ---------------------------------- */
/* Outcome ids must exist and not be retired. One query for the whole rubric. */
async function outcomesOk(pool, criteria) {
  const ids = [...new Set(criteria.flatMap((c) => c.outcomeIds))];
  if (!ids.length) return true;
  const q = pool.request(); ids.forEach((id, i) => q.input(`o${i}`, sql.Int, id));
  const r = await q.query(`SELECT id FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN (${ids.map((_, i) => `@o${i}`).join(", ")})`);
  const have = new Set((r.recordset || []).map((x) => x.id));
  return ids.every((id) => have.has(id));
}

/* The child-row batch. Criteria are matched back by (rubric_id, position), so no generated id has to travel through the batch.
   Positions and ids are validated integers written inline; every text and number is a parameter. */
function childrenSql(req, criteria, tagCourse) {
  const cv = [], lv = [], tv = [];
  criteria.forEach((c, i) => {
    cv.push(`(@rid, ${i + 1}, @ct${i}, @cd${i}, @cw${i})`);
    req.input(`ct${i}`, sql.NVarChar(200), c.title).input(`cd${i}`, sql.NVarChar(500), c.description || null).input(`cw${i}`, sql.Decimal(7, 2), c.weight);
    c.levels.forEach((l, j) => {
      lv.push(`(${i + 1}, ${j + 1}, @ll${i}_${j}, @ld${i}_${j}, @lp${i}_${j})`);
      req.input(`ll${i}_${j}`, sql.NVarChar(100), l.label).input(`ld${i}_${j}`, sql.NVarChar(500), l.description || null).input(`lp${i}_${j}`, sql.Decimal(7, 2), l.points);
    });
    c.outcomeIds.forEach((o) => tv.push(`(${i + 1}, ${o})`));
  });
  return `INSERT INTO lms_rubric_criteria (rubric_id, position, title, description, weight) VALUES ${cv.join(", ")};
    INSERT INTO lms_rubric_levels (criterion_id, position, label, description, points)
      SELECT c.id, v.lpos, v.label, v.description, v.points FROM (VALUES ${lv.join(", ")}) AS v(cpos, lpos, label, description, points)
      INNER JOIN lms_rubric_criteria c ON c.rubric_id = @rid AND c.position = v.cpos;
    ${tv.length ? `INSERT INTO lms_outcome_tags (outcome_id, entity_type, entity_id, course_id)
      SELECT v.oid, 'rubric_criterion', c.id, ${tagCourse} FROM (VALUES ${tv.join(", ")}) AS v(cpos, oid)
      INNER JOIN lms_rubric_criteria c ON c.rubric_id = @rid AND c.position = v.cpos;` : ""}`;
}

async function createRubric(pool, user, courseId, body) {
  const v = validate(body); if (!v.ok) return { ok: false, errors: v.errors };
  if (courseId != null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  if (!(await outcomesOk(pool, v.value.criteria))) return { ok: false, errors: ["Every outcome must exist (it may have been retired)."] };
  const cap = courseId == null ? MAX_LIBRARY : MAX_PER_COURSE;
  const n = await scoped(pool, courseId).query(`SELECT COUNT(*) AS n FROM lms_rubrics WHERE ${scopeSql(courseId)} AND deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= cap) return { ok: false, code: "RUBRIC_LIMIT", errors: [`${courseId == null ? "The school library" : "A course"} can hold at most ${cap} rubrics.`] };
  const actor = actorOf(user), m = v.value;
  const req = scoped(pool, courseId).input("t", sql.NVarChar(200), m.title).input("d", sql.NVarChar(1000), m.description || null)
    .input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null);
  const kids = childrenSql(req, m.criteria, courseId == null ? "0" : "@c");
  const r = await req.query(`SET XACT_ABORT ON; DECLARE @new TABLE (id INT); BEGIN TRAN;
    INSERT INTO lms_rubrics (course_id, title, description, created_by_source, created_by) OUTPUT INSERTED.id INTO @new VALUES (${courseId == null ? "NULL" : "@c"}, @t, @d, @src, @uid);
    DECLARE @rid INT = (SELECT TOP 1 id FROM @new);
    ${kids}
    COMMIT; SELECT id FROM @new;`);
  const id = r.recordset?.[0]?.id;
  await audit(pool, actor, "rubric.created", "lms_rubrics", id, { courseId, criteria: m.criteria.length });
  return getRubric(pool, courseId, id);
}

/* Is submitted work already attached to this rubric through an assignment? */
const IN_USE = `EXISTS (SELECT 1 FROM lms_assignment_rubrics ar INNER JOIN lms_submissions s ON s.assignment_id = ar.assignment_id AND s.status = 'submitted' WHERE ar.rubric_id = @id)`;

async function replaceRubric(pool, user, courseId, id, body) {
  const v = validate(body); if (!v.ok) return { ok: false, errors: v.errors };
  if (courseId != null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  if (!(await loadRow(pool, courseId, id))) return { ok: false, notFound: true, errors: ["Rubric not found."] };
  if (!(await outcomesOk(pool, v.value.criteria))) return { ok: false, errors: ["Every outcome must exist (it may have been retired)."] };
  const m = v.value;
  const req = scoped(pool, courseId).input("id", sql.Int, id).input("t", sql.NVarChar(200), m.title).input("d", sql.NVarChar(1000), m.description || null);
  const kids = childrenSql(req, m.criteria, courseId == null ? "0" : "@c").replace(/@rid/g, "@id");
  // Guard and write in ONE batch (no gap for a submission to slip in). The guard answers first and returns.
  const r = await req.query(`SET XACT_ABORT ON;
    IF ${IN_USE} BEGIN SELECT 'IN_USE' AS outcome; RETURN; END
    BEGIN TRAN;
      UPDATE lms_rubrics SET title = @t, description = @d, updated_at = SYSUTCDATETIME() WHERE id = @id AND ${scopeSql(courseId)} AND deleted_at IS NULL;
      IF @@ROWCOUNT = 0 BEGIN ROLLBACK; SELECT 'MISSING' AS outcome; RETURN; END
      DELETE FROM lms_outcome_tags WHERE entity_type = 'rubric_criterion' AND entity_id IN (SELECT id FROM lms_rubric_criteria WHERE rubric_id = @id);
      DELETE FROM lms_rubric_levels WHERE criterion_id IN (SELECT id FROM lms_rubric_criteria WHERE rubric_id = @id);
      DELETE FROM lms_rubric_criteria WHERE rubric_id = @id;
      ${kids}
    COMMIT; SELECT 'OK' AS outcome;`);
  const outcome = r.recordset?.[0]?.outcome;
  if (outcome === "IN_USE") return { ok: false, code: "RUBRIC_IN_USE", errors: ["Students have handed in work for an assignment that uses this rubric, so it can no longer be changed. Copy it and attach the copy instead."] };
  if (outcome !== "OK") return { ok: false, notFound: true, errors: ["Rubric not found."] };
  await audit(pool, actorOf(user), "rubric.updated", "lms_rubrics", id, { courseId, criteria: m.criteria.length });
  return getRubric(pool, courseId, id);
}

async function deleteRubric(pool, user, courseId, id) {
  if (courseId != null) { const e = await editable(pool, courseId); if (!e.ok) return e; }
  if (!(await loadRow(pool, courseId, id))) return { ok: false, notFound: true, errors: ["Rubric not found."] };
  const r = await scoped(pool, courseId).input("id", sql.Int, id).query(`UPDATE lms_rubrics SET deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id
    WHERE id = @id AND ${scopeSql(courseId)} AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM lms_assignment_rubrics ar INNER JOIN lms_assignments a ON a.id = ar.assignment_id AND a.deleted_at IS NULL WHERE ar.rubric_id = @id)`);
  if (!(r.recordset && r.recordset.length)) return { ok: false, code: "RUBRIC_ATTACHED", errors: ["This rubric is attached to an assignment. Detach it first."] };
  await audit(pool, actorOf(user), "rubric.deleted", "lms_rubrics", id, { courseId });
  return { ok: true };
}

/* Copy a rubric (from the school library or from this same course) into this course. The copy is independent. */
async function copyRubric(pool, user, courseId, body) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["fromRubricId", "title"].includes(k))) return { ok: false, errors: ["Send fromRubricId (and optionally title)."] };
  const from = posInt(body.fromRubricId); if (from === null) return { ok: false, errors: ["fromRubricId must be a rubric id."] };
  let title = null; if (body.title !== undefined) { title = oneLine(body.title); if (title.length < 1 || title.length > 200) return { ok: false, errors: ["title must be 1-200 characters."] }; }
  const e = await editable(pool, courseId); if (!e.ok) return e;
  const src = await pool.request().input("f", sql.Int, from).input("c", sql.Int, courseId).query(`SELECT TOP 1 id, title FROM lms_rubrics WHERE id = @f AND deleted_at IS NULL AND (course_id IS NULL OR course_id = @c)`);
  const srcRow = src.recordset && src.recordset[0]; if (!srcRow) return { ok: false, notFound: true, errors: ["Rubric not found."] };
  const n = await scoped(pool, courseId).query(`SELECT COUNT(*) AS n FROM lms_rubrics WHERE ${scopeSql(courseId)} AND deleted_at IS NULL`);
  if (Number(n.recordset?.[0]?.n) >= MAX_PER_COURSE) return { ok: false, code: "RUBRIC_LIMIT", errors: [`A course can have at most ${MAX_PER_COURSE} rubrics.`] };
  const actor = actorOf(user), newTitle = title || `${srcRow.title}`.slice(0, 190) + " (copy)";
  const r = await pool.request().input("f", sql.Int, from).input("c", sql.Int, courseId).input("t", sql.NVarChar(200), newTitle)
    .input("src", sql.NVarChar(20), actor ? actor.source : null).input("uid", sql.Int, actor ? actor.id : null)
    .query(`SET XACT_ABORT ON; DECLARE @new TABLE (id INT); BEGIN TRAN;
      INSERT INTO lms_rubrics (course_id, title, description, created_by_source, created_by) OUTPUT INSERTED.id INTO @new
        SELECT @c, @t, s.description, @src, @uid FROM lms_rubrics s WHERE s.id = @f AND s.deleted_at IS NULL AND (s.course_id IS NULL OR s.course_id = @c);
      DECLARE @rid INT = (SELECT TOP 1 id FROM @new);
      INSERT INTO lms_rubric_criteria (rubric_id, position, title, description, weight) SELECT @rid, c.position, c.title, c.description, c.weight FROM lms_rubric_criteria c WHERE c.rubric_id = @f;
      INSERT INTO lms_rubric_levels (criterion_id, position, label, description, points)
        SELECT nc.id, l.position, l.label, l.description, l.points FROM lms_rubric_levels l
        INNER JOIN lms_rubric_criteria oc ON oc.id = l.criterion_id AND oc.rubric_id = @f
        INNER JOIN lms_rubric_criteria nc ON nc.rubric_id = @rid AND nc.position = oc.position;
      INSERT INTO lms_outcome_tags (outcome_id, entity_type, entity_id, course_id)
        SELECT t.outcome_id, 'rubric_criterion', nc.id, @c FROM lms_outcome_tags t
        INNER JOIN lms_rubric_criteria oc ON oc.id = t.entity_id AND oc.rubric_id = @f
        INNER JOIN lms_rubric_criteria nc ON nc.rubric_id = @rid AND nc.position = oc.position
        INNER JOIN lms_learning_outcomes o ON o.id = t.outcome_id AND o.deleted_at IS NULL
        WHERE t.entity_type = 'rubric_criterion';
      COMMIT; SELECT id FROM @new;`);
  const id = r.recordset?.[0]?.id; if (!id) return { ok: false, notFound: true, errors: ["Rubric not found."] };
  await audit(pool, actor, "rubric.copied", "lms_rubrics", id, { courseId, fromRubricId: from });
  return getRubric(pool, courseId, id);
}

/* ------------------------- rubric <-> assignment -------------------------- */
const liveAssignment = async (pool, courseId, assignmentId) => {
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
  return !!(r.recordset && r.recordset.length);
};

async function getAssignmentRubric(pool, courseId, assignmentId) {
  if (!(await liveAssignment(pool, courseId, assignmentId))) return { ok: false, notFound: true, errors: ["Assignment not found."] };
  const r = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).query(`SELECT TOP 1 r.id, r.course_id, r.title, r.description, r.created_at, r.updated_at FROM lms_assignment_rubrics ar
    INNER JOIN lms_rubrics r ON r.id = ar.rubric_id AND r.course_id = @c AND r.deleted_at IS NULL WHERE ar.assignment_id = @a AND ar.course_id = @c`);
  const row = r.recordset && r.recordset[0];
  return { ok: true, rubric: row ? await readFull(pool, row) : null };
}

/* body: { rubricId: <id of a rubric in THIS course> | null }. */
async function setAssignmentRubric(pool, user, courseId, assignmentId, body) {
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "rubricId") || !("rubricId" in body)) return { ok: false, errors: ["Send { rubricId } (a rubric id, or null to remove)."] };
  const rid = body.rubricId === null ? null : posInt(body.rubricId);
  if (body.rubricId !== null && rid === null) return { ok: false, errors: ["rubricId must be a rubric id or null."] };
  const e = await editable(pool, courseId); if (!e.ok) return e;
  if (!(await liveAssignment(pool, courseId, assignmentId))) return { ok: false, notFound: true, errors: ["Assignment not found."] };
  if (rid !== null && !(await loadRow(pool, courseId, rid))) return { ok: false, notFound: true, errors: ["Rubric not found in this course. Copy it from the library first."] };
  const used = await pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId).query(`SELECT TOP 1 id FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND status = 'submitted'`);
  if (used.recordset && used.recordset.length) return { ok: false, code: "HAS_SUBMISSIONS", errors: ["Students have already handed in work for this assignment, so its rubric can no longer be changed."] };
  const q = pool.request().input("a", sql.Int, assignmentId).input("c", sql.Int, courseId);
  if (rid === null) await q.query(`DELETE FROM lms_assignment_rubrics WHERE assignment_id = @a AND course_id = @c`);
  else await q.input("r", sql.Int, rid).query(`SET XACT_ABORT ON; BEGIN TRAN;
    UPDATE lms_assignment_rubrics SET rubric_id = @r, attached_at = SYSUTCDATETIME() WHERE assignment_id = @a AND course_id = @c;
    IF @@ROWCOUNT = 0 INSERT INTO lms_assignment_rubrics (assignment_id, rubric_id, course_id) VALUES (@a, @r, @c);
    COMMIT;`);
  await audit(pool, actorOf(user), rid === null ? "rubric.detached" : "rubric.attached", "lms_assignments", assignmentId, { courseId, rubricId: rid });
  return getAssignmentRubric(pool, courseId, assignmentId);
}

module.exports = { MAX_PER_COURSE, MAX_LIBRARY, MAX_CRITERIA, MAX_LEVELS, MAX_TAGS, MAX_TOTAL, validate, totalOf, listRubrics, getRubric, createRubric, replaceRubric, deleteRubric, copyRubric, getAssignmentRubric, setAssignmentRubric };
