/* =========================================================================
   COMBINED SUBJECTS — shared helpers (no database, no requires except the
   rounding rule).

   An admin can COMBINE two (or more) different subjects in
   Main Examination -> Reports -> Subject codes & key ("Combine into").
   The combined subjects then appear as ONE subject on every report: one
   column, one code, one key line. That one subject is what the Total and
   the Average / mean are built from.

   Storage: exam_subject_sessions.report_combine_with = the session id of
   the subject it is merged INTO (the "main" subject; it keeps its code and
   its place in the order). A main subject has report_combine_with = NULL.

   Combined mark = (sum of the marks obtained) / (sum of the marks possible)
   x 100, floored like every other percentage. With equal paper totals this
   is the plain average of the two percentages.
     • IF ONE PART IS 0 (scored 0, or a compulsory part not sat once the exam
       is over), THE OTHER PART IS USED ON ITS OWN: the zero part is dropped
       from both the marks and the totals, so it never pulls the subject down.
       If every part is 0 the combined subject is 0 (absent if none was sat).
     • An optional part not sat is left out of the sum.
     • If a compulsory part is still pending (exam not over, no submission)
       the combined subject is not counted yet (percentage null).
     • A part the candidate is not registered for is ignored; if they are
       registered for none of the parts, the combined subject is not
       registered either.
========================================================================= */
const { round2 } = require("./examPercentages");

/** sessions: [{ session_id, report_combine_with }] -> Map(secondaryId -> mainId).
    Only valid links are kept: the target must be in the list, must not be the
    subject itself and must not itself be combined into another subject (so there
    are never chains or loops; an unusable link just leaves the subject alone). */
function buildCombineMap(sessions) {
  const list = sessions || [];
  const link = new Map();
  list.forEach((s) => {
    const to = Number(s.report_combine_with);
    if (to && Number.isFinite(to) && to !== Number(s.session_id)) link.set(Number(s.session_id), to);
  });
  const ids = new Set(list.map((s) => Number(s.session_id)));
  const out = new Map();
  link.forEach((to, from) => {
    if (ids.has(to) && !link.has(to)) out.set(from, to);
  });
  return out;
}

/** The subjects of one list that exist as separate columns after combining.
    ids: ordered session ids -> [{ pid, members: [ids], combined }]
    The combined subject sits where its MAIN subject sits (or where its first
    member sits if the main subject is not in the list). */
function planFold(ids, combineMap) {
  const map = combineMap || new Map();
  const mainIds = new Set(map.values());
  const groups = new Map();
  ids.forEach((id) => {
    const pid = map.has(id) ? map.get(id) : id;
    if (!mainIds.has(pid)) return;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(id);
  });
  const plan = [];
  const done = new Set();
  ids.forEach((id) => {
    const pid = map.has(id) ? map.get(id) : id;
    const members = groups.get(pid);
    if (!members || members.length < 2) { plan.push({ pid: id, members: [id], combined: false }); return; }
    if (done.has(pid)) return;
    const anchor = members.includes(pid) ? pid : members[0];
    if (id !== anchor) return;
    done.add(pid);
    plan.push({ pid, members, combined: true });
  });
  return plan;
}

/** parts: [{ not_registered, score, total_marks, absent, optional }] (one candidate, one
    subject each) -> the single combined cell. `percentage` is null when the combined
    subject must not be counted (nothing sat yet / a compulsory part still pending). */
function combineParts(parts) {
  const all = parts || [];
  const totalAll = all.reduce((a, p) => a + (Number(p.total_marks) || 0), 0);
  const live = all.filter((p) => !p.not_registered);
  if (!live.length) return { not_registered: true, score: null, total_marks: totalAll, percentage: null, absent: false, optional: false, sat: false };
  let pending = false;
  const entries = []; // { got, tm, sat } for every part that has a result
  live.forEach((p) => {
    const tm = Number(p.total_marks) || 0;
    if (p.score != null) entries.push({ got: Number(p.score), tm, sat: true });
    else if (p.absent) entries.push({ got: 0, tm, sat: false }); // compulsory, not sat, exam over: 0
    else if (!p.optional) pending = true;                        // compulsory, exam not over yet
    // optional + not sat: left out
  });
  // A part that is 0 is ignored when the other part scored something: use the other one.
  const hasScore = entries.some((e) => e.got > 0);
  const used = hasScore ? entries.filter((e) => e.got > 0) : entries;
  const got = used.reduce((a, e) => a + e.got, 0);
  const out = used.reduce((a, e) => a + e.tm, 0);
  const anySat = used.some((e) => e.sat);
  const optional = live.every((p) => p.optional);
  if (pending || out <= 0) {
    return { not_registered: false, score: null, total_marks: out || totalAll, percentage: null, absent: false, optional, sat: false };
  }
  return {
    not_registered: false,
    score: anySat ? got : null,
    total_marks: out,
    percentage: round2((got / out) * 100),
    absent: !anySat,
    optional,
    sat: anySat,
  };
}

/** cells: one candidate's per-subject cells [{ session_id, not_registered, score, total_marks,
    absent, optional, ... }] in list order -> the same list with combined subjects folded into
    one cell each: { ...combineParts(), session_id: mainId, combined: true, members: [ids] }.
    Cells of subjects that are not combined are returned untouched (same object). */
function foldCells(cells, combineMap) {
  if (!combineMap || !combineMap.size) return cells;
  const byId = new Map(cells.map((c) => [c.session_id, c]));
  return planFold(cells.map((c) => c.session_id), combineMap).map((p) => {
    if (!p.combined) return byId.get(p.pid);
    return { ...combineParts(p.members.map((id) => byId.get(id))), session_id: p.pid, combined: true, members: p.members };
  });
}

/** The percentage a cell counts as: a combined cell carries its own; a plain cell is
    score/total (floored), an absent compulsory paper is 0, anything else is null. */
function cellPercentage(c) {
  if (c.percentage !== undefined) return c.percentage;
  if (c.not_registered) return null;
  if (c.score != null && Number(c.total_marks) > 0) return round2((Number(c.score) / Number(c.total_marks)) * 100);
  return c.absent ? 0 : null;
}

/** Column label of a combined subject: the admin's key wording if set on the main subject,
    else the names joined with " + ". */
function combinedLabel(memberSubjects, mainSubject) {
  const custom = String((mainSubject && mainSubject.report_key) || "").trim();
  if (custom) return custom;
  return memberSubjects.map((s) => s.subject).filter(Boolean).join(" + ");
}

/** Checks the "combine into" choices an admin is saving.
    existing: [{ session_id, report_combine_with, has_paper }]   (every subject of the exam)
    changes:  Map(session_id -> new combine target id or null)
    Returns an error message, or null when the final state is valid. */
function validateCombineChanges(existing, changes) {
  const final = new Map();
  const byId = new Map();
  existing.forEach((s) => {
    byId.set(Number(s.session_id), s);
    final.set(Number(s.session_id), s.report_combine_with ? Number(s.report_combine_with) : null);
  });
  changes.forEach((to, id) => { if (byId.has(id)) final.set(id, to ? Number(to) : null); });
  const name = (id) => (byId.get(id) && byId.get(id).subject) || `#${id}`;
  for (const [id, to] of final) {
    if (!to) continue;
    if (!changes.has(id) && !changes.has(to)) continue; // only judge links touched by this save
    if (to === id) return `"${name(id)}" cannot be combined with itself.`;
    const target = byId.get(to);
    if (!target) return `"${name(id)}" is set to combine with a subject that is not in this examination.`;
    if (!target.has_paper) return `"${name(to)}" has no paper attached yet, so "${name(id)}" cannot be combined into it.`;
    if (final.get(to)) return `"${name(to)}" is itself combined into another subject, so "${name(id)}" cannot be combined into it. Combine both into the same main subject instead.`;
  }
  return null;
}

module.exports = { buildCombineMap, planFold, combineParts, foldCells, cellPercentage, combinedLabel, validateCombineChanges };
