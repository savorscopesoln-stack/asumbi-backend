/* =========================================================================
   MARKING LEADERBOARD
   One endpoint feeding the admin "Marking" tab and the teacher leaderboard
   page: every teacher's load allocation, marking progress and speed, and who
   finished first.

   Work comes in two shapes (see utils/assignmentEngine.js):
     - whole scripts   -> e_assessment_submission_assignments
     - single answers  -> e_assessment_answer_assignments
   Both are counted as "items" so teachers with either kind of allocation can
   be compared on one scale.

   Timestamps (marked_at / marking_completed_at) only exist for work marked
   after this feature shipped. Older work still counts toward progress, but is
   left out of speed figures instead of being guessed.
========================================================================= */
const { sql } = require("../config/db");
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
const { backfillMarkersFromSessions } = require("../utils/markingBackfill");

// Sessions change while teachers work, so re-credit them regularly, but not on every request.
const BACKFILL_EVERY_MS = 60000;
const lastBackfill = new Map(); // tenant -> timestamp
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const ms = (d) => (d ? new Date(d).getTime() : null);

const getMarkingLeaderboard = async (req, res) => {
  try {
    const pool = req.pool;
    const aid = toInt(req.query.assessmentId);
    const filter = aid ? "AND s.e_assessment_id = @aid" : "";
    const bind = (r) => (aid ? r.input("aid", sql.Int, aid) : r);

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    // Credit work recorded only in the teachers' marking sessions (marked before tracking existed).
    const tkey = req.dbTenant || "default";
    if (Date.now() - (lastBackfill.get(tkey) || 0) > BACKFILL_EVERY_MS) {
      lastBackfill.set(tkey, Date.now());
      try { await backfillMarkersFromSessions(pool); } catch (e) { console.warn("marking backfill failed:", e.message); }
    }

    const [scripts, answers, openRows, sessionRows] = await Promise.all([
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
    const [scripts, answers] = await Promise.all([
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      bind(pool.request()).query(`
        SELECT aa.teacher_id, s.e_assessment_id,
               COUNT(*) AS allocated,
               SUM(CASE WHEN s.status IN ('marked','released') THEN 1 ELSE 0 END) AS marked,
               SUM(CASE WHEN s.status IN ('marked','released') AND s.marking_completed_at IS NOT NULL THEN 1 ELSE 0 END) AS timed,
               MIN(aa.assigned_at) AS first_assigned,
               MIN(s.marking_completed_at) AS first_marked_at,
               MAX(s.marking_completed_at) AS last_marked_at
        FROM e_assessment_submission_assignments aa
        INNER JOIN e_assessment_submissions s ON s.id = aa.submission_id
        WHERE 1 = 1 ${filter}
        GROUP BY aa.teacher_id, s.e_assessment_id
      `),
      bind(pool.request()).query(`
        SELECT ax.teacher_id, s.e_assessment_id,
               COUNT(*) AS allocated,
               SUM(CASE WHEN an.marks_awarded IS NOT NULL THEN 1 ELSE 0 END) AS marked,
               SUM(CASE WHEN an.marks_awarded IS NOT NULL AND an.marked_at IS NOT NULL THEN 1 ELSE 0 END) AS timed,
               MIN(ax.assigned_at) AS first_assigned,
               MIN(an.marked_at) AS first_marked_at,
               MAX(an.marked_at) AS last_marked_at
        FROM e_assessment_answer_assignments ax
        INNER JOIN e_assessment_answers an ON an.id = ax.answer_id
        INNER JOIN e_assessment_submissions s ON s.id = an.submission_id
        WHERE 1 = 1 ${filter}
        GROUP BY ax.teacher_id, s.e_assessment_id
      `),
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      // every answer a teacher is recorded as having marked, assigned to them or not
      bind(pool.request()).query(`
        SELECT an.marked_by AS teacher_id, s.e_assessment_id,
               COUNT(*) AS marked,
               SUM(CASE WHEN an.marked_at IS NOT NULL THEN 1 ELSE 0 END) AS timed,
               MIN(an.marked_at) AS first_marked_at, MAX(an.marked_at) AS last_marked_at
        FROM e_assessment_answers an
        INNER JOIN e_assessment_submissions s ON s.id = an.submission_id
        WHERE an.marked_by IS NOT NULL AND an.marks_awarded IS NOT NULL ${filter}
        GROUP BY an.marked_by, s.e_assessment_id
      `).catch(() => ({ recordset: [] })),
      // when each teacher started / last touched an assessment (for an estimated speed on older work)
      bind(pool.request()).query(`
        SELECT teacher_id, e_assessment_id, createdAt, updatedAt
        FROM e_assessment_marking_sessions
        WHERE 1 = 1 ${aid ? "AND e_assessment_id = @aid" : ""}
      `).catch(() => ({ recordset: [] })),
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    ]);

    // ---- merge both shapes into one row per (teacher, assessment) ----
    const cells = new Map(); // "teacher:assessment" -> cell
    const fold = (rows, kind) => {
      for (const r of rows.recordset) {
        const key = `${r.teacher_id}:${r.e_assessment_id}`;
        const c = cells.get(key) || {
          teacher_id: r.teacher_id, e_assessment_id: r.e_assessment_id,
          scripts_allocated: 0, answers_allocated: 0, allocated: 0, marked: 0, timed: 0,
          first_assigned: null, first_marked_at: null, last_marked_at: null,
        };
        c[kind === "script" ? "scripts_allocated" : "answers_allocated"] += r.allocated || 0;
        c.allocated += r.allocated || 0;
        c.marked += r.marked || 0;
        c.timed += r.timed || 0;
        const min = (a, b) => (a == null ? b : b == null ? a : ms(b) < ms(a) ? b : a);
        const max = (a, b) => (a == null ? b : b == null ? a : ms(b) > ms(a) ? b : a);
        c.first_assigned = min(c.first_assigned, r.first_assigned);
        c.first_marked_at = min(c.first_marked_at, r.first_marked_at);
        c.last_marked_at = max(c.last_marked_at, r.last_marked_at);
        cells.set(key, c);
      }
    };
    fold(scripts, "script");
    fold(answers, "answer");

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    // Teachers who marked work that was never assigned to them (e.g. an assessment owner
    // marking everything): "open" work. Their marked answers count even with no allocation.
    for (const r of openRows.recordset) {
      const key = `${r.teacher_id}:${r.e_assessment_id}`;
      let c = cells.get(key);
      if (!c) {
        c = { teacher_id: r.teacher_id, e_assessment_id: r.e_assessment_id, scripts_allocated: 0, answers_allocated: 0,
          allocated: 0, marked: 0, timed: 0, first_assigned: null, first_marked_at: null, last_marked_at: null, open: true };
        cells.set(key, c);
      }
      if (c.open) { // no assignment rows: the recorded marking IS the teacher's work
        c.marked = r.marked || 0;
        c.timed = r.timed || 0;
        c.first_marked_at = r.first_marked_at;
        c.last_marked_at = r.last_marked_at;
      }
    }
    const sessionOf = new Map(sessionRows.recordset.map((r) => [`${r.teacher_id}:${r.e_assessment_id}`, r]));
    // answered essays still waiting for a mark, per assessment — the shared pool open work draws from
    const poolLeft = new Map();
    const openAssessments = [...new Set([...cells.values()].filter((c) => c.open).map((c) => c.e_assessment_id))];
    if (openAssessments.length) {
      try {
        const pr = await pool.request().query(`
          SELECT s.e_assessment_id, COUNT(*) AS n
          FROM e_assessment_answers an
          INNER JOIN e_assessment_questions q ON q.id = an.question_id
          INNER JOIN e_assessment_submissions s ON s.id = an.submission_id
          WHERE s.e_assessment_id IN (${openAssessments.join(",")})
            AND q.question_type = 'essay' AND an.marks_awarded IS NULL AND DATALENGTH(an.essay_answer) > 0
          GROUP BY s.e_assessment_id
        `);
        pr.recordset.forEach((x) => poolLeft.set(x.e_assessment_id, x.n));
      } catch { /* leave the pool size unknown */ }
    }

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    const teacherIds = [...new Set([...cells.values()].map((c) => c.teacher_id))];
    const assessmentIds = [...new Set([...cells.values()].map((c) => c.e_assessment_id))];
    const names = new Map();
    const titles = new Map();
    if (teacherIds.length) {
      const t = await pool.request().query(`SELECT id, name FROM Teachers WHERE id IN (${teacherIds.join(",")})`);
      t.recordset.forEach((x) => names.set(x.id, x.name));
    }
    if (assessmentIds.length) {
      const a = await pool.request().query(`SELECT id, title, subject FROM e_assessments WHERE id IN (${assessmentIds.join(",")})`);
      a.recordset.forEach((x) => titles.set(x.id, { title: x.title, subject: x.subject }));
    }

    // ---- per-cell derived numbers ----
    const perAssessment = new Map(); // assessment id -> cells
    for (const c of cells.values()) {
      c.teacher_name = names.get(c.teacher_id) || `Teacher #${c.teacher_id}`;
      c.assessment_title = titles.get(c.e_assessment_id)?.title || `Assessment #${c.e_assessment_id}`;
      c.subject = titles.get(c.e_assessment_id)?.subject || null;
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      if (c.open) {
        // no fixed allocation: show what they marked, against the shared pool still left
        const left = poolLeft.get(c.e_assessment_id);
        c.allocated = null;
        c.remaining = left ?? null;
        c.percent = null;
        c.finished = false;
        c.finished_at = null;
        c.turnaround_minutes = null;
      } else {
        c.remaining = Math.max(0, c.allocated - c.marked);
        c.percent = c.allocated ? Math.round((c.marked / c.allocated) * 100) : 0;
        c.finished = c.allocated > 0 && c.marked >= c.allocated;
        // finished_at only means something once every allocated item has a timestamp
        c.finished_at = c.finished && c.timed >= c.allocated ? c.last_marked_at : null;
        c.turnaround_minutes = c.finished_at && c.first_assigned
          ? Math.max(0, Math.round((ms(c.finished_at) - ms(c.first_assigned)) / 60000)) : null;
      }
      const span = c.timed >= 2 && c.first_marked_at && c.last_marked_at ? ms(c.last_marked_at) - ms(c.first_marked_at) : 0;
      c.items_per_hour = span > 0 ? Math.round(((c.timed - 1) / (span / 3600000)) * 10) / 10 : null;
      c.avg_minutes_per_item = span > 0 ? Math.round((span / 60000 / (c.timed - 1)) * 10) / 10 : null;
      c.speed_estimated = false;
      // older work has no per-answer times: estimate from the teacher's session (first save -> last save)
      const ses = sessionOf.get(`${c.teacher_id}:${c.e_assessment_id}`);
      if (c.items_per_hour == null && ses && c.marked >= 5) {
        const sspan = ms(ses.updatedAt) - ms(ses.createdAt);
        if (sspan >= 10 * 60000) {
          c.items_per_hour = Math.round((c.marked / (sspan / 3600000)) * 10) / 10;
          c.speed_estimated = true;
        }
      }
      if (ses && !c.last_marked_at) c.last_marked_at = ses.updatedAt; // last activity, even without per-answer times
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
      c.remaining = Math.max(0, c.allocated - c.marked);
      c.percent = c.allocated ? Math.round((c.marked / c.allocated) * 100) : 0;
      c.finished = c.allocated > 0 && c.marked >= c.allocated;
      // finished_at only means something once every allocated item has a timestamp
      c.finished_at = c.finished && c.timed >= c.allocated ? c.last_marked_at : null;
      const span = c.timed >= 2 && c.first_marked_at && c.last_marked_at ? ms(c.last_marked_at) - ms(c.first_marked_at) : 0;
      c.items_per_hour = span > 0 ? Math.round(((c.timed - 1) / (span / 3600000)) * 10) / 10 : null;
      c.avg_minutes_per_item = span > 0 ? Math.round((span / 60000 / (c.timed - 1)) * 10) / 10 : null;
      c.turnaround_minutes = c.finished_at && c.first_assigned
        ? Math.max(0, Math.round((ms(c.finished_at) - ms(c.first_assigned)) / 60000)) : null;
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      if (!perAssessment.has(c.e_assessment_id)) perAssessment.set(c.e_assessment_id, []);
      perAssessment.get(c.e_assessment_id).push(c);
    }

    // ---- per-assessment race: finishers by finish time, then everyone else by progress ----
    const assessments = [];
    for (const [id, list] of perAssessment) {
      const finishers = list.filter((c) => c.finished_at).sort((a, b) => ms(a.finished_at) - ms(b.finished_at));
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      const rest = list.filter((c) => !c.finished_at).sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.marked - a.marked);
      [...finishers, ...rest].forEach((c, i) => { c.rank = i + 1; });
      finishers.forEach((c, i) => { c.finish_place = i + 1; });
      const assignedCells = list.filter((c) => !c.open);
      const assignedAlloc = assignedCells.reduce((n, c) => n + c.allocated, 0);
      const assignedMarked = assignedCells.reduce((n, c) => n + c.marked, 0);
      const openMarked = list.filter((c) => c.open).reduce((n, c) => n + c.marked, 0);
      const pooled = list.some((c) => c.open) ? (poolLeft.get(id) || 0) : 0;
      const totalAllocated = assignedAlloc + openMarked + pooled; // open work counts the shared pool still left
      const totalMarked = assignedMarked + openMarked;
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
      const rest = list.filter((c) => !c.finished_at).sort((a, b) => b.percent - a.percent || b.marked - a.marked);
      [...finishers, ...rest].forEach((c, i) => { c.rank = i + 1; });
      finishers.forEach((c, i) => { c.finish_place = i + 1; });
      const totalAllocated = list.reduce((n, c) => n + c.allocated, 0);
      const totalMarked = list.reduce((n, c) => n + c.marked, 0);
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      assessments.push({
        e_assessment_id: id,
        title: titles.get(id)?.title || `Assessment #${id}`,
        subject: titles.get(id)?.subject || null,
        allocated: totalAllocated,
        marked: totalMarked,
        percent: totalAllocated ? Math.round((totalMarked / totalAllocated) * 100) : 0,
<<<<<<< HEAD
        has_open_pool: list.some((c) => c.open),
=======
<<<<<<< HEAD
        has_open_pool: list.some((c) => c.open),
=======
<<<<<<< HEAD
        has_open_pool: list.some((c) => c.open),
=======
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
        first_finisher: finishers[0]
          ? { teacher_id: finishers[0].teacher_id, teacher_name: finishers[0].teacher_name, finished_at: finishers[0].finished_at }
          : null,
        teachers: [...finishers, ...rest],
      });
    }
    assessments.sort((a, b) => a.percent - b.percent || a.title.localeCompare(b.title)); // least-complete first

    // ---- overall board: one row per teacher across the assessments in scope ----
    const byTeacher = new Map();
    for (const c of cells.values()) {
      const t = byTeacher.get(c.teacher_id) || {
        teacher_id: c.teacher_id, teacher_name: c.teacher_name,
<<<<<<< HEAD
        assessments: 0, allocated: 0, marked: 0, assigned_marked: 0, open_marked: 0, timed: 0,
=======
<<<<<<< HEAD
        assessments: 0, allocated: 0, marked: 0, assigned_marked: 0, open_marked: 0, timed: 0,
=======
<<<<<<< HEAD
        assessments: 0, allocated: 0, marked: 0, assigned_marked: 0, open_marked: 0, timed: 0,
=======
        assessments: 0, allocated: 0, marked: 0, timed: 0,
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
        wins: 0, podiums: 0, finished_assessments: 0,
        speed_weight: 0, speed_sum: 0, last_activity: null,
      };
      t.assessments += 1;
<<<<<<< HEAD
      t.allocated += c.allocated || 0;
      t.marked += c.marked;
      if (c.open) t.open_marked += c.marked; else t.assigned_marked += c.marked;
=======
<<<<<<< HEAD
      t.allocated += c.allocated || 0;
      t.marked += c.marked;
      if (c.open) t.open_marked += c.marked; else t.assigned_marked += c.marked;
=======
<<<<<<< HEAD
      t.allocated += c.allocated || 0;
      t.marked += c.marked;
      if (c.open) t.open_marked += c.marked; else t.assigned_marked += c.marked;
=======
      t.allocated += c.allocated;
      t.marked += c.marked;
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      t.timed += c.timed;
      if (c.finished) t.finished_assessments += 1;
      if (c.finish_place === 1) t.wins += 1;
      if (c.finish_place && c.finish_place <= 3) t.podiums += 1;
<<<<<<< HEAD
      if (c.items_per_hour != null) { const w = c.timed || c.marked; t.speed_sum += c.items_per_hour * w; t.speed_weight += w; }
=======
<<<<<<< HEAD
      if (c.items_per_hour != null) { const w = c.timed || c.marked; t.speed_sum += c.items_per_hour * w; t.speed_weight += w; }
=======
<<<<<<< HEAD
      if (c.items_per_hour != null) { const w = c.timed || c.marked; t.speed_sum += c.items_per_hour * w; t.speed_weight += w; }
=======
      if (c.items_per_hour != null) { t.speed_sum += c.items_per_hour * c.timed; t.speed_weight += c.timed; }
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      if (c.last_marked_at && (!t.last_activity || ms(c.last_marked_at) > ms(t.last_activity))) t.last_activity = c.last_marked_at;
      byTeacher.set(c.teacher_id, t);
    }
    const teachers = [...byTeacher.values()].map((t) => ({
      teacher_id: t.teacher_id, teacher_name: t.teacher_name, assessments: t.assessments,
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      allocated: t.allocated, marked: t.marked, open_marked: t.open_marked,
      remaining: Math.max(0, t.allocated - t.assigned_marked),
      // progress only exists against a fixed allocation; open marking has no "100%"
      percent: t.allocated ? Math.round((t.assigned_marked / t.allocated) * 100) : null,
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
      allocated: t.allocated, marked: t.marked, remaining: Math.max(0, t.allocated - t.marked),
      percent: t.allocated ? Math.round((t.marked / t.allocated) * 100) : 0,
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
      finished_assessments: t.finished_assessments, wins: t.wins, podiums: t.podiums,
      items_per_hour: t.speed_weight ? Math.round((t.speed_sum / t.speed_weight) * 10) / 10 : null,
      last_activity: t.last_activity,
    }));
    // default order: most progress, then most first-place finishes, then most marked
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    teachers.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || b.wins - a.wins || b.marked - a.marked || a.teacher_name.localeCompare(b.teacher_name));
    teachers.forEach((t, i) => { t.rank = i + 1; });

    const allocated = assessments.reduce((n, a) => n + a.allocated, 0);
    const marked = assessments.reduce((n, a) => n + a.marked, 0);
<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
=======
    teachers.sort((a, b) => b.percent - a.percent || b.wins - a.wins || b.marked - a.marked || a.teacher_name.localeCompare(b.teacher_name));
    teachers.forEach((t, i) => { t.rank = i + 1; });

    const allocated = teachers.reduce((n, t) => n + t.allocated, 0);
    const marked = teachers.reduce((n, t) => n + t.marked, 0);
>>>>>>> 1535e4c73fc63f1a2c5d914a1047febc9540573c
>>>>>>> 24026f891fd15230ada7b8077750e39f50a0f297
>>>>>>> 57d8939c8b51b9aec372b01e6772b4ee8ccfb731
    res.json({
      generated_at: new Date().toISOString(),
      me: toInt(req.user?.id),
      summary: {
        teachers: teachers.length, assessments: assessments.length,
        allocated, marked, remaining: Math.max(0, allocated - marked),
        percent: allocated ? Math.round((marked / allocated) * 100) : 0,
      },
      teachers,
      assessments,
    });
  } catch (err) {
    console.error("MARKING LEADERBOARD ERROR:", err);
    res.status(500).json({ message: "Failed to load marking stats", error: err.message });
  }
};

module.exports = { getMarkingLeaderboard };
