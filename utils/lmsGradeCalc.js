/* =========================================================================
   LMS GRADE CALCULATION  (L7.1a, D-085)  PURE functions: no database, no clock, no randomness, never throws.
   Used by the gradebook routes (L7.1b), the learner grade view (L7.3), exports and the results hand-off (L7.4).

   Rules (documented, simple, the same for every course):
   - An item's percentage = points / max points * 100. Below 0 counts as 0; above 100 is kept (extra credit; the entry rules decide whether it is allowed).
   - An item is COUNTED only when it has points. Not graded yet (no grade row, or points empty) = left out, NOT a zero; a teacher who wants a zero enters 0.
     Excused items are left out. A max of 0 or less is left out (`NO_MAX`).
   - Learner view (`viewer: "student"`): items that are not released and grades that are hidden are left out too, so the learner sees exactly what the teacher released.
   - Inside a category: the N lowest counted items are dropped (`dropLowest`), but at least ONE item is always kept. Ties: the item with the HIGHER id is dropped first.
     The category percentage is the weighted mean of the kept items (item `weight`, default 1; all weights 0 = equal weights).
   - Course total: the weighted mean of the category percentages, using ONLY categories that have at least one kept item (so an empty category does not pull the total
     down); the weights are re-scaled to add up to 100. If those weights add up to 0, the categories count equally. Items with no / an unknown category behave as a category with weight 0.
   - Rounding: 2 decimals, half-up on the decimal value (0.525 -> 0.53).
   - A learner with nothing counted has `percent: null` (not 0).
   - Grade bands (`bandFor`) come from the tenant's grading scale: [{ min, label }]; the highest `min` that the percentage reaches wins.
========================================================================= */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/* One item's percentage, or the reason it is left out. grade = { points, excused, hidden } | undefined. */
function itemResult(item, grade, viewer) {
  const max = num(item.maxPoints);
  if (viewer === "student" && !item.released) return { excluded: "NOT_RELEASED" };
  if (!(max > 0)) return { excluded: "NO_MAX" };
  if (!grade) return { excluded: "NOT_GRADED" };
  if (grade.excused) return { excluded: "EXCUSED" };
  if (viewer === "student" && grade.hidden) return { excluded: "HIDDEN" };
  const pts = grade.points === null || grade.points === undefined ? null : num(grade.points);
  if (pts === null) return { excluded: "NOT_GRADED" };
  return { percent: Math.max(0, (pts / max) * 100) };
}

const weightedMean = (rows) => {
  const sw = rows.reduce((s, r) => s + r.weight, 0);
  if (sw > 0) return rows.reduce((s, r) => s + r.percent * r.weight, 0) / sw;
  return rows.reduce((s, r) => s + r.percent, 0) / rows.length; // every weight 0 -> equal
};

/* { categories: [{id, weight, dropLowest}], items: [{id, categoryId, maxPoints, weight, released}], grades: [{itemId, points, excused, hidden}] | Map(itemId -> grade), viewer: "staff"|"student" }
   -> { percent, categories: [{id, percent, counted, dropped: [itemId], weightUsed}], items: [{id, percent|null, counted, dropped, excluded|null}], itemsCounted, itemsLeftOut } */
function computeTotal(input) {
  const inp = isObj(input) ? input : {};
  const viewer = inp.viewer === "student" ? "student" : "staff";
  const cats = Array.isArray(inp.categories) ? inp.categories.filter((c) => isObj(c)) : [];
  const items = Array.isArray(inp.items) ? inp.items.filter((i) => isObj(i)) : [];
  const gmap = inp.grades instanceof Map ? inp.grades : new Map((Array.isArray(inp.grades) ? inp.grades : []).filter((g) => isObj(g)).map((g) => [g.itemId, g]));

  const rows = items.map((it) => ({ id: it.id, categoryId: it.categoryId ?? null, weight: Math.max(0, num(it.weight) ?? 1), ...itemResult(it, gmap.get(it.id), viewer), dropped: false }));
  const by = new Map(); // categoryId -> counted rows
  for (const r of rows) if (r.percent !== undefined) { if (!by.has(r.categoryId)) by.set(r.categoryId, []); by.get(r.categoryId).push(r); }

  const catInfo = new Map(cats.map((c) => [c.id, c]));
  const catOut = [];
  for (const [catId, list] of by) {
    const info = catInfo.get(catId);
    const drop = Math.min(Math.max(0, Math.floor(num(info && info.dropLowest) || 0)), list.length - 1);
    const order = [...list].sort((a, b) => a.percent - b.percent || String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
    const dropped = order.slice(0, drop); for (const r of dropped) r.dropped = true;
    const kept = list.filter((r) => !r.dropped);
    catOut.push({ id: catId, percent: weightedMean(kept), counted: kept.length, dropped: dropped.map((r) => r.id), rawWeight: Math.max(0, num(info && info.weight) || 0) });
  }
  const sw = catOut.reduce((s, c) => s + c.rawWeight, 0);
  for (const c of catOut) c.weightUsed = sw > 0 ? c.rawWeight / sw * 100 : 100 / catOut.length;
  const total = catOut.length ? catOut.reduce((s, c) => s + c.percent * c.weightUsed / 100, 0) : null;

  const order = new Map(cats.map((c, i) => [c.id, i]));
  catOut.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
  return {
    percent: total === null ? null : round2(total),
    categories: catOut.map((c) => ({ id: c.id, percent: round2(c.percent), counted: c.counted, dropped: c.dropped, weightUsed: round2(c.weightUsed) })),
    items: rows.map((r) => ({ id: r.id, percent: r.percent === undefined ? null : round2(r.percent), counted: r.percent !== undefined && !r.dropped, dropped: r.dropped, excluded: r.excluded || null })),
    itemsCounted: rows.filter((r) => r.percent !== undefined && !r.dropped).length,
    itemsLeftOut: rows.filter((r) => r.percent === undefined).length,
  };
}

/* bands: [{ min, label }] in any order. Returns the label or null (no bands, no percentage, or below every band). */
function bandFor(percent, bands) {
  const p = num(percent); if (p === null || !Array.isArray(bands)) return null;
  const ok = bands.filter((b) => isObj(b) && num(b.min) !== null && typeof b.label === "string" && b.label.trim() !== "").sort((a, b) => num(b.min) - num(a.min));
  const hit = ok.find((b) => p >= num(b.min)); return hit ? hit.label : null;
}

module.exports = { round2, itemResult, computeTotal, bandFor };
