/* =========================================================================
   LMS GRADEBOOK LINKS  (L7.1c, D-087)  grade items that follow an ASSIGNMENT or a QUIZ of the same course, and a re-runnable sync into `lms_grades`.
   Gates (routes/lms.js): flag `lms_gradebook`, then `lms.course.manage` (link) / `lms.submission.grade` (sync), then course membership.

   Rules (documented, simple):
   - Link: the source must be a live assignment or quiz of THIS course (else 404). One item per source per course (unique index; second link = 409 ALREADY_LINKED).
     Assignment item: maxPoints = the assignment's max points, title copied. Quiz item: only a COURSEWORK quiz that counts to the grade (practice, revision, flashcards never
     reach the gradebook: 409 PRACTICE_NOT_GRADED); maxPoints = 100 and points = the best graded attempt's PERCENTAGE (same rule as the results adapter, Q51).
     New linked items start unreleased. Their maximum cannot be edited (lmsGradebook.updateItem refuses it).
   - Sync copies only what the learner could already see: assignment = the learner's latest RETURNED grade (final points after any late penalty, scaled to the item max if the
     assignment max changed); quiz = best GRADED attempt (a learner with an attempt still waiting for marking is skipped as NEEDS_MARKING). Only ACTIVE learners.
   - A grade a teacher entered or changed by hand (graded_by_source not 'System') is NEVER overwritten by a sync; it is counted as `skippedManual`. Sync only creates grades
     and updates grades last written by the system. Excused/hidden flags and comments are kept. Every insert or update writes a `lms_grade_history` row ('System') in the SAME
     batch. Running it twice changes nothing (`unchanged`). A grade that has disappeared from the source (grade returned -> removed) is not deleted.
   - Everything is parameterised; the row list travels as one JSON parameter.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { editable, posInt } = require("./lmsCourseParts");
const GB = require("./lmsGradebook");
const { pickScores, loadAttempts } = require("./lmsResultsAdapter");
const release = require("./lmsRelease");
const events = require("./lmsEvents");

const MAX_ROWS = 20000;
const SOURCES = ["assignment", "quiz"];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const notFound = (what = "Item") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const isDup = (e) => e && (e.number === 2601 || e.number === 2627);

/* Pure. Body: { sourceType, sourceId, categoryId?, weight?, released? } */
function validateLink(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be an object."] };
  const errors = Object.keys(body).filter((k) => !["sourceType", "sourceId", "categoryId", "weight", "released"].includes(k)).map((k) => `Unknown field "${k}".`);
  if (!SOURCES.includes(body.sourceType)) errors.push("sourceType must be assignment or quiz.");
  const sid = posInt(body.sourceId); if (!sid) errors.push("sourceId must be a positive whole number.");
  const rest = GB.validateItem({ title: "x", maxPoints: 1, ...Object.fromEntries(["categoryId", "weight", "released"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) });
  if (!rest.ok) errors.push(...rest.errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { sourceType: body.sourceType, sourceId: sid, categoryId: rest.value.categoryId ?? null, weight: rest.value.weight ?? 1, released: rest.value.released === true } };
}

/* Pure. Latest RETURNED grade per learner from rows [{student_id, final_points, max_points, id}] already ordered newest first, scaled to itemMax. -> [{studentId, points}] */
function pickAssignmentScores(rows, itemMax) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    const sid = Number(r.student_id); if (!Number.isInteger(sid) || sid <= 0 || seen.has(sid)) continue; seen.add(sid);
    const fin = Number(r.final_points), max = Number(r.max_points);
    if (!Number.isFinite(fin) || !(max > 0)) continue;
    out.push({ studentId: sid, points: Math.min(Number(itemMax), Math.max(0, round2((fin / max) * Number(itemMax)))) });
  }
  return out.sort((a, b) => a.studentId - b.studentId);
}

async function linkItem(pool, user, courseId, body) {
  const actor = actorOf(user); if (!actor) return notFound("Course");
  const v = validateLink(body); if (!v.ok) return v;
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  const x = v.value; let title, max;
  if (x.sourceType === "assignment") {
    const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, x.sourceId).query(`SELECT TOP 1 title, max_points FROM lms_assignments WHERE id = @a AND course_id = @c AND deleted_at IS NULL`);
    const a = r.recordset && r.recordset[0]; if (!a) return notFound("Assignment"); title = a.title; max = Number(a.max_points);
  } else {
    const r = await pool.request().input("c", sql.Int, courseId).input("z", sql.Int, x.sourceId).query(`SELECT TOP 1 title, assessment_type, counts_to_grade, quiz_mode FROM lms_quizzes WHERE id = @z AND course_id = @c AND deleted_at IS NULL`);
    const q = r.recordset && r.recordset[0]; if (!q) return notFound("Quiz");
    if (q.assessment_type !== "coursework" || !q.counts_to_grade || (q.quiz_mode && q.quiz_mode !== "quiz" && q.quiz_mode !== "mock")) return { ok: false, code: "PRACTICE_NOT_GRADED", errors: ["Only a coursework quiz that counts to the grade can be added to the gradebook."] };
    title = q.title; max = 100;
  }
  if (x.categoryId && !(await GB.loadCategory(pool, courseId, x.categoryId))) return { ok: false, errors: ["That category does not exist in this course."] };
  let r;
  try {
    r = await pool.request().input("c", sql.Int, courseId).input("k", sql.Int, x.categoryId).input("t", sql.NVarChar(200), String(title).slice(0, 200)).input("st", sql.NVarChar(12), x.sourceType).input("si", sql.Int, x.sourceId)
      .input("m", sql.Decimal(8, 2), max).input("w", sql.Decimal(6, 2), x.weight).input("rel", sql.Bit, x.released ? 1 : 0).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id).input("lim", sql.Int, GB.MAX_ITEMS)
      .query(`INSERT INTO lms_grade_items (course_id, category_id, title, source_type, source_id, max_points, weight, released, position, created_by_source, created_by)
        OUTPUT INSERTED.id, INSERTED.category_id, INSERTED.title, INSERTED.source_type, INSERTED.source_id, INSERTED.max_points, INSERTED.weight, INSERTED.released, INSERTED.position
        SELECT @c, @k, @t, @st, @si, @m, @w, @rel, (SELECT ISNULL(MAX(position), 0) + 1 FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL), @src, @uid
        WHERE (SELECT COUNT(*) FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL) < @lim`);
  } catch (e) { if (isDup(e)) return { ok: false, code: "ALREADY_LINKED", errors: ["This assignment or quiz is already in the gradebook."] }; throw e; }
  const row = r.recordset && r.recordset[0]; if (!row) return { ok: false, code: "ITEM_LIMIT", errors: [`A course can have at most ${GB.MAX_ITEMS} grade items.`] };
  await audit(pool, actor, "gradebook.item_linked", "lms_grade_items", row.id, { courseId, sourceType: x.sourceType, sourceId: x.sourceId });
  return { ok: true, item: GB.itemShape(row) };
}

async function syncItem(pool, user, courseId, itemId, { tenant, now = new Date() } = {}) {
  const actor = actorOf(user); if (!actor) return notFound("Course");
  const iid = posInt(itemId); if (!iid) return notFound();
  const item = await GB.loadItem(pool, courseId, iid); if (!item) return notFound();
  if (item.source_type === "manual" || !SOURCES.includes(item.source_type) || !item.source_id) return { ok: false, code: "NOT_LINKED", errors: ["This item is entered by hand; there is nothing to sync."] };
  const ed = await editable(pool, courseId); if (!ed.ok) return ed;
  let rows, pending = 0;
  if (item.source_type === "assignment") {
    await release.releaseDue(pool, { courseId, assignmentId: item.source_id }, { tenant, now });
    const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, item.source_id)
      .query(`SELECT TOP ${MAX_ROWS} student_id, final_points, max_points, id FROM lms_submission_grades WHERE assignment_id = @a AND course_id = @c AND status = 'returned' ORDER BY returned_at DESC, id DESC`);
    rows = pickAssignmentScores(r.recordset, item.max_points);
  } else {
    const { rows: picked, skipped } = pickScores(await loadAttempts(pool, courseId, item.source_id));
    pending = skipped.filter((s) => s.reason === "NEEDS_MARKING").length;
    rows = picked.map((p) => ({ studentId: p.studentId, points: round2((p.percentage / 100) * Number(item.max_points)) }));
  }
  const eligible = rows.length;
  let inserted = 0, updated = 0, skippedManual = 0;
  if (eligible) {
    const res = await pool.request().input("c", sql.Int, courseId).input("i", sql.Int, iid).input("now", sql.DateTime2, now).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows.map((r) => ({ s: r.studentId, p: r.points }))))
      .query(`SET XACT_ABORT ON; BEGIN TRAN;
        DECLARE @inserted INT = 0, @updated INT = 0, @manual INT = 0;
        DECLARE @r TABLE (s INT PRIMARY KEY, p DECIMAL(8,2));
        INSERT INTO @r (s, p) SELECT j.s, j.p FROM OPENJSON(@rows) WITH (s INT '$.s', p DECIMAL(8,2) '$.p') j
          JOIN lms_course_enrolments e ON e.course_id = @c AND e.student_id = j.s AND e.status = 'active';
        DECLARE @h TABLE (gid INT, s INT, op DECIMAL(8,2), np DECIMAL(8,2), oe BIT, ne BIT);
        UPDATE g SET points = r.p, updated_at = @now
          OUTPUT INSERTED.id, INSERTED.student_id, DELETED.points, INSERTED.points, DELETED.excused, INSERTED.excused INTO @h
          FROM lms_grades g JOIN @r r ON r.s = g.student_id
          WHERE g.item_id = @i AND g.course_id = @c AND g.graded_by_source = 'System' AND ISNULL(g.points, -1) <> r.p;
        SET @updated = @@ROWCOUNT;
        INSERT INTO lms_grades (item_id, course_id, student_id, points, excused, hidden, graded_by_source, graded_by, created_at, updated_at)
          OUTPUT INSERTED.id, INSERTED.student_id, NULL, INSERTED.points, NULL, INSERTED.excused INTO @h
          SELECT @i, @c, r.s, r.p, 0, 0, 'System', NULL, @now, @now FROM @r r WHERE NOT EXISTS (SELECT 1 FROM lms_grades g WHERE g.item_id = @i AND g.student_id = r.s);
        SET @inserted = @@ROWCOUNT;
        SELECT @manual = COUNT(*) FROM lms_grades g JOIN @r r ON r.s = g.student_id WHERE g.item_id = @i AND g.course_id = @c AND ISNULL(g.graded_by_source, N'') <> 'System' AND ISNULL(g.points, -1) <> r.p;
        INSERT INTO lms_grade_history (grade_id, item_id, course_id, student_id, old_points, new_points, old_excused, new_excused, reason, changed_by_source, changed_by, changed_at)
          SELECT gid, @i, @c, s, op, np, oe, ne, N'Synced from source', 'System', NULL, @now FROM @h;
        COMMIT; SELECT @inserted AS inserted, @updated AS updated, @manual AS manual;`);
    const o = (res.recordset && res.recordset[0]) || {};
    inserted = Number(o.inserted) || 0; updated = Number(o.updated) || 0; skippedManual = Number(o.manual) || 0;
  }
  const unchanged = Math.max(0, eligible - inserted - updated - skippedManual);
  await audit(pool, actor, "gradebook.item_synced", "lms_grade_items", iid, { courseId, sourceType: item.source_type, sourceId: item.source_id, inserted, updated, skippedManual });
  if (tenant && (inserted || updated)) events.emit("lms.gradebook.synced", { tenant, courseId, itemId: iid });
  return { ok: true, eligible, inserted, updated, unchanged, skippedManual, waitingForMarking: pending };
}

module.exports = { MAX_ROWS, validateLink, pickAssignmentScores, linkItem, syncItem };
