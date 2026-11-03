/* =========================================================================
   LMS GRADEBOOK -> FORMAL RESULTS  (L7.4b, D-090; contract B in docs/LMS_INTEGRATION_CONTRACTS.md)
   Publishes each learner's COURSE TOTAL (percent) into the school's legacy `Assessments` + `Marks`. Same pattern as utils/lmsResultsAdapter.js (D-083).

   Rules (documented, simple, all enforced here):
   - Explicit staff action only: route needs `lms.gradebook.publish` + course membership (flag `lms_gradebook` first). Never a job, never an event subscriber.
   - The number published is the LEARNER-VIEW total (`computeTotal`, viewer "student", Q59 default): only RELEASED items and VISIBLE grades count, so formal results
     never contain something a learner could not see. A learner with nothing counted is skipped (NOTHING_COUNTED), never published as 0.
   - Only ACTIVE learners. The course must be published or archived and name one existing subject + one existing class (else 409 NO_RESULTS_MAPPING). Nothing is guessed.
   - Marks are normalised to 100: totalMarks = 100, Marks.score = round(percent), Marks.percentage = 2 decimals, `Marks.grade` NOT written (derived at read time, D-083).
   - Target: ONE `Assessments` row with sourceSystem `lms_grade_item` and sourceRefId = the LMS COURSE id (a separate id space from `lms_quiz`, so rows never collide).
     Only rows of THIS source are touched; no Marks row is ever deleted. One T-SQL batch (XACT_ABORT, UPDLOCK/HOLDLOCK lookup): pressing twice = all `unchanged`.
   - Max 2000 learners and 100000 learner x item cells. Audited (`results.published`, ids + counts) and event `lms.results.published` (ids only). `dryRun: true` writes nothing.
   Every query is parameterised; the learner list travels as ONE JSON parameter read with OPENJSON.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { computeTotal } = require("./lmsGradeCalc");
const { mappingExists, TOTAL_MARKS, MAX_LEARNERS } = require("./lmsResultsAdapter");
const events = require("./lmsEvents");

const SOURCE = "lms_grade_item", MAX_CELLS = 100000, MAX_SKIPPED_SHOWN = 200;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const reject = (code, msg, extra) => ({ ok: false, code, errors: [msg], ...(extra ? { extra } : {}) });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/* Pure. -> { rows:[{studentId, score, percentage}], skipped:[{studentId, reason}] } (student-view totals; null percent = NOTHING_COUNTED) */
function planRows({ categories, items, learnerIds, grades }) {
  const calcItems = items.map((i) => ({ id: i.id, categoryId: i.categoryId, maxPoints: i.maxPoints, weight: i.weight, released: true }));
  const rows = [], skipped = [];
  for (const sid of [...learnerIds].sort((a, b) => a - b)) {
    const t = computeTotal({ categories, items: calcItems, grades: grades.get(sid) || [], viewer: "student" });
    if (t.percent === null) skipped.push({ studentId: sid, reason: "NOTHING_COUNTED" });
    else { const p = Math.min(100, Math.max(0, t.percent)); rows.push({ studentId: sid, score: Math.round(p), percentage: p }); }
  }
  return { rows, skipped };
}

async function publishCourseResults(pool, user, courseId, body, ctx = {}) {
  const cid = posInt(courseId); if (!cid) return { ok: false, notFound: true, errors: ["Course not found."] };
  if (body !== undefined && body !== null && !isObj(body)) return { ok: false, errors: ["Send { dryRun? }."] };
  if (body && body.dryRun !== undefined && typeof body.dryRun !== "boolean") return { ok: false, errors: ["dryRun must be true or false."] };
  const dryRun = !!(body && body.dryRun === true);
  const actor = actorOf(user); if (!actor || actor.role === "student") return { ok: false, notFound: true, errors: ["Course not found."] };
  const c = () => pool.request().input("c", sql.Int, cid);
  const cr = await c().query(`SELECT TOP 1 id, title, status, academic_year, semester, class_name, subject_id FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  const x = cr.recordset && cr.recordset[0]; if (!x) return { ok: false, notFound: true, errors: ["Course not found."] };
  if (!["published", "archived"].includes(x.status)) return reject("COURSE_NOT_PUBLISHED", "Publish the course before sending its results.");
  const course = { id: x.id, title: x.title, academicYear: x.academic_year, semester: x.semester, className: x.class_name, subjectId: x.subject_id };
  if (!posInt(course.subjectId) || !String(course.className || "").trim()) return reject("NO_RESULTS_MAPPING", "This course is not linked to one subject and one class. Ask the LMS administrator to set them on the course first.");
  if (!(await mappingExists(pool, course))) return reject("NO_RESULTS_MAPPING", "The subject or class set on this course was not found in the school records. Ask the LMS administrator to correct it.");

  const [cats, its, lr] = await Promise.all([
    c().query(`SELECT TOP 30 id, weight, drop_lowest FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP 200 id, category_id, max_points, weight FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL AND released = 1 ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_LEARNERS + 1} student_id FROM lms_course_enrolments WHERE course_id = @c AND status = 'active' ORDER BY student_id`),
  ]);
  const ids = (lr.recordset || []).map((r) => r.student_id);
  if (ids.length > MAX_LEARNERS) return reject("TOO_MANY_LEARNERS", `At most ${MAX_LEARNERS} learners can be published at once.`);
  const items = (its.recordset || []).map((i) => ({ id: i.id, categoryId: i.category_id ?? null, maxPoints: Number(i.max_points), weight: Number(i.weight) }));
  if (!items.length) return reject("NOTHING_TO_PUBLISH", "No grade item is released yet.");
  if (ids.length * items.length > MAX_CELLS) return reject("EXPORT_TOO_LARGE", "This gradebook is too large to publish in one go.");
  const categories = (cats.recordset || []).map((k) => ({ id: k.id, weight: Number(k.weight), dropLowest: Number(k.drop_lowest) }));
  const grades = new Map();
  if (ids.length) {
    const g = await c().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(`SELECT TOP ${MAX_CELLS} g.item_id, g.student_id, g.points, g.excused, g.hidden
      FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL AND i.released = 1
      WHERE g.course_id = @c AND g.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`);
    for (const r of g.recordset || []) { if (!grades.has(r.student_id)) grades.set(r.student_id, []); grades.get(r.student_id).push({ itemId: r.item_id, points: numOrNull(r.points), excused: !!r.excused, hidden: !!r.hidden }); }
  }
  const { rows, skipped } = planRows({ categories, items, learnerIds: ids, grades });
  const shown = skipped.slice(0, MAX_SKIPPED_SHOWN);
  if (!rows.length) return reject("NOTHING_TO_PUBLISH", "No learner has a released, graded item to publish yet.", { skipped: shown, skippedCount: skipped.length });
  if (dryRun) return { ok: true, dryRun: true, eligible: rows.length, skipped: shown, skippedCount: skipped.length, totalMarks: TOTAL_MARKS };

  const json = JSON.stringify(rows.map((r) => ({ s: r.studentId, sc: r.score, p: r.percentage })));
  const res = await pool.request()
    .input("q", sql.Int, cid).input("src", sql.NVarChar(20), SOURCE)
    .input("name", sql.NVarChar(200), `${String(course.title || "LMS course").slice(0, 180)} - course total`).input("atype", sql.NVarChar(50), "LMS Course")
    .input("cls", sql.NVarChar(50), String(course.className).trim()).input("term", sql.NVarChar(30), String(course.semester || "").slice(0, 30))
    .input("yr", sql.NVarChar(10), String(course.academicYear || "")).input("tm", sql.Int, TOTAL_MARKS).input("subj", sql.Int, course.subjectId)
    .input("rows", sql.NVarChar(sql.MAX), json)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @aid INT, @inserted INT = 0, @updated INT = 0;
      SELECT TOP 1 @aid = id FROM Assessments WITH (UPDLOCK, HOLDLOCK) WHERE sourceSystem = @src AND sourceRefId = @q;
      IF @aid IS NULL
      BEGIN
        INSERT INTO Assessments (name, assessmentType, targetClass, term, year, totalMarks, status, examScope, sourceSystem, sourceRefId)
        VALUES (@name, @atype, @cls, @term, @yr, @tm, 'Active', 'subject', @src, @q);
        SET @aid = SCOPE_IDENTITY();
      END
      IF NOT EXISTS (SELECT 1 FROM AssessmentSubjects WHERE assessmentId = @aid AND subjectId = @subj)
        INSERT INTO AssessmentSubjects (assessmentId, subjectId) VALUES (@aid, @subj);
      DECLARE @r TABLE (studentId INT PRIMARY KEY, score INT, pct FLOAT);
      INSERT INTO @r (studentId, score, pct) SELECT s, sc, p FROM OPENJSON(@rows) WITH (s INT '$.s', sc INT '$.sc', p FLOAT '$.p');
      UPDATE m SET score = r.score, percentage = r.pct, createdAt = GETDATE()
        FROM Marks m JOIN @r r ON r.studentId = m.studentId
       WHERE m.assessmentId = @aid AND (m.score IS NULL OR m.percentage IS NULL OR m.score <> r.score OR ABS(m.percentage - r.pct) > 0.001);
      SET @updated = @@ROWCOUNT;
      INSERT INTO Marks (studentId, subjectId, assessmentId, score, percentage, createdAt)
        SELECT r.studentId, @subj, @aid, r.score, r.pct, GETDATE() FROM @r r
         WHERE NOT EXISTS (SELECT 1 FROM Marks m WHERE m.assessmentId = @aid AND m.studentId = r.studentId);
      SET @inserted = @@ROWCOUNT;
      COMMIT;
      SELECT @aid AS assessment_id, @inserted AS inserted, @updated AS updated;`);
  const out = res.recordset && res.recordset[0];
  if (!out || !posInt(out.assessment_id)) return reject("RESULTS_INTEGRATION_UNAVAILABLE", "The results could not be written. Nothing was changed.");
  const inserted = Number(out.inserted) || 0, updated = Number(out.updated) || 0, unchanged = Math.max(0, rows.length - inserted - updated);
  await audit(pool, actor, "results.published", "Assessments", out.assessment_id, { courseId: cid, source: SOURCE, assessmentId: out.assessment_id, inserted, updated, unchanged, skipped: skipped.length });
  if (ctx.tenant) events.emit("lms.results.published", { tenant: ctx.tenant, courseId: cid, assessmentId: out.assessment_id, source: SOURCE, inserted, updated, unchanged });
  return { ok: true, assessmentId: out.assessment_id, totalMarks: TOTAL_MARKS, inserted, updated, unchanged, skipped: shown, skippedCount: skipped.length };
}

module.exports = { SOURCE, planRows, publishCourseResults };
