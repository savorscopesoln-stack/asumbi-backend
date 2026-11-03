/* =========================================================================
   LMS LEARNER GRADE VIEW  (L7.3, D-088)  what ONE learner sees of their own course grades. Read only.
   Route gates: flag `lms_gradebook`, studentOnly, ACTIVE enrolment (the student id always comes from the token).

   Rules (documented, simple):
   - Only items the teacher RELEASED are shown. A grade the teacher HID is shown as "pending" with no points and no comment. An excused item shows "excused".
     An item with no grade yet shows "pending". Staff-only data (who graded, history, other learners) is never returned.
   - The learner total and category percentages use `computeTotal` with viewer "student", so they match exactly what is visible; unreleased and hidden grades never count.
   - The comment of a visible grade is shown to the learner (it is written for them).
   - Grade band: from the school's existing grading system (`GradingSystem` id 1 via utils/grading.js, with its usual default when no row exists), the same scale as
     transcripts and the student portal: `getGradeForScore(percent)` -> {grade, label, remark}. No percentage yet = no band. The lms_settings `gradingSystemId` is NOT used
     (the legacy table holds a single system, A136).
   - Course must be published or archived (a draft/deleted course = 404). Archived courses stay readable.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { computeTotal } = require("./lmsGradeCalc");
const { loadGradingSystem, getGradeForScore } = require("./grading");

const MAX_ITEMS = 200, MAX_CATEGORIES = 30;
const notFound = () => ({ ok: false, notFound: true, errors: ["Course not found."] });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/* Pure. item rows + this learner's grade rows -> the learner's rows.  grade = {points, excused, hidden, comment} | undefined */
function itemView(item, grade, max) {
  const base = { id: item.id, title: item.title, categoryId: item.category_id ?? null, maxPoints: Number(item.max_points), sourceType: item.source_type };
  if (!grade || grade.hidden) return { ...base, status: "pending", points: null, percent: null, comment: null };
  if (grade.excused) return { ...base, status: "excused", points: null, percent: null, comment: grade.comment || null };
  const pts = numOrNull(grade.points);
  if (pts === null) return { ...base, status: "pending", points: null, percent: null, comment: grade.comment || null };
  return { ...base, status: "graded", points: pts, percent: max > 0 ? Math.round(Math.max(0, (pts / max) * 100) * 100) / 100 : null, comment: grade.comment || null };
}

async function myGrades(pool, user, courseId) {
  const actor = actorOf(user); if (!actor || actor.source !== "Students" || actor.role !== "student") return notFound();
  const cid = Number.isInteger(courseId) && courseId > 0 ? courseId : null; if (!cid) return notFound();
  const st = await pool.request().input("c", sql.Int, cid).query(`SELECT TOP 1 status FROM lms_courses WHERE id = @c AND deleted_at IS NULL AND status IN ('published','archived')`);
  if (!(st.recordset && st.recordset[0])) return notFound();
  const c = () => pool.request().input("c", sql.Int, cid);
  const [cats, items] = await Promise.all([
    c().query(`SELECT TOP ${MAX_CATEGORIES} id, name, weight, drop_lowest, position FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_ITEMS} id, category_id, title, source_type, max_points, weight, position FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL AND released = 1 ORDER BY position, id`),
  ]);
  const itemRows = items.recordset || [], catRows = cats.recordset || [];
  let gradeRows = [];
  if (itemRows.length) {
    const g = await c().input("s", sql.Int, actor.id).query(`SELECT TOP ${MAX_ITEMS} g.item_id, g.points, g.excused, g.hidden, g.comment
      FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL AND i.released = 1
      WHERE g.course_id = @c AND g.student_id = @s`);
    gradeRows = g.recordset || [];
  }
  const byItem = new Map(gradeRows.map((g) => [g.item_id, g]));
  const calc = computeTotal({
    viewer: "student",
    categories: catRows.map((x) => ({ id: x.id, weight: Number(x.weight), dropLowest: Number(x.drop_lowest) })),
    items: itemRows.map((i) => ({ id: i.id, categoryId: i.category_id ?? null, maxPoints: Number(i.max_points), weight: Number(i.weight), released: true })),
    grades: gradeRows.map((g) => ({ itemId: g.item_id, points: numOrNull(g.points), excused: !!g.excused, hidden: !!g.hidden })),
  });
  const gs = await loadGradingSystem(pool);
  const band = calc.percent === null ? null : getGradeForScore(calc.percent, gs);
  const catPct = new Map(calc.categories.map((x) => [x.id, x]));
  return {
    ok: true,
    scale: { systemName: gs.systemName || null, passMark: gs.passMark ?? null },
    total: { percent: calc.percent, band: band && (band.grade || band.label) ? band : null, itemsCounted: calc.itemsCounted, passed: calc.percent === null || gs.passMark == null ? null : calc.percent >= Number(gs.passMark) },
    categories: catRows.map((x) => ({ id: x.id, name: x.name, weight: Number(x.weight), percent: catPct.has(x.id) ? catPct.get(x.id).percent : null })),
    items: itemRows.map((i) => itemView(i, byItem.get(i.id), Number(i.max_points))),
  };
}

module.exports = { MAX_ITEMS, itemView, myGrades };
