/* =========================================================================
   LMS GRADEBOOK CSV EXPORT  (L7.4a, D-089)  STAFF only, read only (plus one audit row).
   Route gates (routes/lms.js): flag `lms_gradebook` FIRST, then `lms.gradebook.view`, then course membership (owner / co-teacher / admin).

   Rules (documented, simple):
   - One row per ACTIVE learner of THIS course (name order), at most 2000 learners (409 TOO_MANY_LEARNERS) and at most 100 000 learner x item cells (409 EXPORT_TOO_LARGE),
     so the export is always bounded. Nothing is paged: it is one file.
   - Columns: Admission no, Name, one column per grade item ("<title> (/<max>)", in grid order), one "<category> %" column per category, "Total %", "Grade", "Items counted".
   - It is the STAFF view (same numbers as the grid, `computeTotal` viewer "staff"): unreleased items and hidden grades ARE included. Cells: points as a number, `EX` = excused,
     blank = not graded yet. A learner with nothing counted has a blank Total and Grade (never 0).
   - Grade = the school's existing grading system (utils/grading, same as D-088). Percentages have 2 decimals.
   - Spreadsheet safety: every text cell goes through the formula guard of lmsQuestionCsv (`cell`): a name or title that starts with = + - @ is exported with a leading '.
     Cells with commas, quotes or line breaks are quoted. Lines end with CRLF; the file starts with no BOM (the route sets UTF-8).
   - Audited (`gradebook.exported`: course id and counts only, never names or marks). The query list is parameterised; the learner ids travel as ONE JSON parameter.
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { computeTotal } = require("./lmsGradeCalc");
const { cell } = require("./lmsQuestionCsv");
const { loadGradingSystem, getGradeForScore } = require("./grading");

const MAX_LEARNERS = 2000, MAX_CELLS = 100000, MAX_ITEMS = 200, MAX_CATEGORIES = 30;
const notFound = () => ({ ok: false, notFound: true, errors: ["Course not found."] });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const fmt = (n) => (n === null || n === undefined ? "" : String(Math.round(n * 100) / 100));

/* Pure. categories [{id,name,weight,dropLowest}], items [{id,categoryId,title,maxPoints,weight,released}], learners [{studentId,name,admissionNo}],
   grades Map(studentId -> [{itemId, points, excused, hidden}]), bandOf(percent) -> string|null  =>  CSV text. */
function buildCsv({ categories, items, learners, grades, bandOf }) {
  const head = ["Admission no", "Name", ...items.map((i) => `${i.title} (/${fmt(i.maxPoints)})`), ...categories.map((c) => `${c.name} %`), "Total %", "Grade", "Items counted"];
  const lines = [head.map(cell).join(",")];
  const calcItems = items.map((i) => ({ id: i.id, categoryId: i.categoryId, maxPoints: i.maxPoints, weight: i.weight, released: i.released }));
  for (const l of learners) {
    const gl = grades.get(l.studentId) || [], by = new Map(gl.map((g) => [g.itemId, g]));
    const t = computeTotal({ categories, items: calcItems, grades: gl, viewer: "staff" });
    const cp = new Map(t.categories.map((c) => [c.id, c.percent]));
    const cells = [l.admissionNo ?? "", l.name ?? "",
      ...items.map((i) => { const g = by.get(i.id); if (!g) return ""; if (g.excused) return "EX"; return g.points === null || g.points === undefined ? "" : fmt(g.points); }),
      ...categories.map((c) => (cp.has(c.id) ? fmt(cp.get(c.id)) : "")),
      fmt(t.percent), t.percent === null ? "" : (bandOf(t.percent) ?? ""), String(t.itemsCounted)];
    lines.push(cells.map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

async function exportGradebook(pool, user, courseId) {
  const actor = actorOf(user); if (!actor || actor.role === "student") return notFound();
  const cid = posInt(courseId); if (!cid) return notFound();
  const c = () => pool.request().input("c", sql.Int, cid);
  const course = await c().query(`SELECT TOP 1 id FROM lms_courses WHERE id = @c AND deleted_at IS NULL`);
  if (!(course.recordset && course.recordset[0])) return notFound();
  const [cats, its, lr] = await Promise.all([
    c().query(`SELECT TOP ${MAX_CATEGORIES} id, name, weight, drop_lowest FROM lms_grade_categories WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_ITEMS} id, category_id, title, max_points, weight, released FROM lms_grade_items WHERE course_id = @c AND deleted_at IS NULL ORDER BY position, id`),
    c().query(`SELECT TOP ${MAX_LEARNERS + 1} e.student_id, st.name AS student_name, st.admissionNo AS admission_no
      FROM lms_course_enrolments e LEFT JOIN Students st ON st.id = e.student_id WHERE e.course_id = @c AND e.status = 'active' ORDER BY st.name, e.student_id`),
  ]);
  const lrows = lr.recordset || [];
  if (lrows.length > MAX_LEARNERS) return { ok: false, code: "TOO_MANY_LEARNERS", errors: [`A gradebook export holds at most ${MAX_LEARNERS} learners.`] };
  const categories = (cats.recordset || []).map((x) => ({ id: x.id, name: x.name, weight: Number(x.weight), dropLowest: Number(x.drop_lowest) }));
  const items = (its.recordset || []).map((x) => ({ id: x.id, categoryId: x.category_id ?? null, title: x.title, maxPoints: Number(x.max_points), weight: Number(x.weight), released: !!x.released }));
  if (lrows.length * items.length > MAX_CELLS) return { ok: false, code: "EXPORT_TOO_LARGE", errors: ["This gradebook is too large to export in one file. Export fewer items or a smaller class."] };
  const grades = new Map();
  if (lrows.length && items.length) {
    const g = await c().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(lrows.map((l) => l.student_id)))
      .query(`SELECT TOP ${MAX_CELLS} g.item_id, g.student_id, g.points, g.excused, g.hidden
        FROM lms_grades g JOIN lms_grade_items i ON i.id = g.item_id AND i.course_id = g.course_id AND i.deleted_at IS NULL
        WHERE g.course_id = @c AND g.student_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@ids))`);
    for (const r of g.recordset || []) { if (!grades.has(r.student_id)) grades.set(r.student_id, []); grades.get(r.student_id).push({ itemId: r.item_id, points: numOrNull(r.points), excused: !!r.excused, hidden: !!r.hidden }); }
  }
  const gs = await loadGradingSystem(pool);
  const bandOf = (p) => { const b = getGradeForScore(p, gs); return b && (b.grade || b.label) ? (b.grade || b.label) : null; };
  const learners = lrows.map((l) => ({ studentId: l.student_id, name: l.student_name || "", admissionNo: l.admission_no || "" }));
  const csv = buildCsv({ categories, items, learners, grades, bandOf });
  await audit(pool, actor, "gradebook.exported", "lms_courses", cid, { courseId: cid, learners: learners.length, items: items.length });
  return { ok: true, csv, filename: `gradebook-course-${cid}.csv`, learners: learners.length, items: items.length };
}

module.exports = { MAX_LEARNERS, MAX_CELLS, buildCsv, exportGradebook };
