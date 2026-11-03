/* =========================================================================
   LMS OFFLINE QUEUED DRAFT SUBMISSIONS + CONFLICT RESOLUTION  (L10.3b + L10.4, D-116)  flag `lms_offline`, schema step 044.
   A learner wrote assignment text offline. The device replays it here as a DRAFT SAVE. Rules:
   - Student + ACTIVE enrolment (routes). The student id comes from the token. 1-5 actions per request, in order (drafts are big: 20 000 characters each).
   - Action = { clientActionId, type: "submission_draft", assignmentId, queuedAt, text, baseVersion }. `baseVersion` is the draft version the device last saw from the server:
     the `draft.updatedAt` text of `GET .../learn/assignments/:id/submission`, or null when the device had NO server draft. The key is REQUIRED (null is a clear statement).
   - NEVER silently overwrite. The write happens only when the server draft is still at `baseVersion` (one guarded UPDATE). If the server draft moved on AND its text differs from the
     device text, nothing is written and the answer is state `conflict` with BOTH versions (server text + version, device text); the learner then chooses with `resolveDraft`.
     If the texts are equal there is nothing to fight about: `applied` with `unchanged: true` (this also covers a replay after a lost answer, and a file upload that only moved the version).
   - A conflict does NOT claim the action id (the row stays unfinished), so replaying the same action later re-checks against the then current server draft.
   - Same rules as online (`utils/lmsSubmissions.gate`): published + available assignment, open course, window open (SERVER clock, never the device clock: Q106), maxAttempts. A closed window or an
     archived course is `rejected` with the same code the online screen uses and the device keeps its text. Group assignments are NOT queued (GROUP_NOT_SUPPORTED, Q105: a shared draft
     has no single baseVersion). Final SUBMIT is never queued (Q104): the learner presses Submit online. Controlled exams never.
   - Idempotent: (student, clientActionId) is unique, like progress actions. A replay of a finished action is `duplicate` with `firstResult` and the stored `version`.
   - Stored: ids, type, outcome, the resulting version (a timestamp). NO text. Audit only on `resolveDraft` (ids + choice, never text).
   - `resolveDraft` (L10.4): choice keep_server (nothing written), keep_mine (device text wins), keep_both (server text, a divider line, device text). It is guarded by the `serverVersion` the
     learner was shown: if the server draft moved again, the answer is `conflict` again and nothing is written.
========================================================================= */
const sql = require("mssql");
const S = require("./lmsSubmissions");
const { audit } = require("./lmsAudit");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");

const MAX_ACTIONS = 5, MAX_AGE_DAYS = 30, FUTURE_SKEW_MS = 5 * 60 * 1000, ID_RE = /^[A-Za-z0-9_-]{8,64}$/, TYPE = "submission_draft", CHOICES = ["keep_server", "keep_mine", "keep_both"];
const DIVIDER = "\n\n--- Written offline ---\n\n";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isDup = (e) => e && (e.number === 2627 || e.number === 2601);
const KEYS = ["clientActionId", "type", "assignmentId", "queuedAt", "text", "baseVersion"];
const COLS = S.COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ");
const parseVersion = (v) => { if (typeof v !== "string" || v.length > 40) return null; const d = new Date(v); return Number.isNaN(d.getTime()) || d.toISOString() !== v ? null : d; };

/* Pure. A bad single action does NOT refuse the batch: it comes back as `invalid` so the device learns which. */
function validateBatch(body) {
  if (!isObj(body) || Object.keys(body).some((k) => k !== "actions")) return { ok: false, errors: ["Send {actions: [...]} only."] };
  const a = body.actions; if (!Array.isArray(a) || !a.length || a.length > MAX_ACTIONS) return { ok: false, errors: [`actions must hold 1 to ${MAX_ACTIONS} items.`] };
  const seen = new Set(), out = [];
  for (const x of a) {
    const id = isObj(x) && typeof x.clientActionId === "string" && ID_RE.test(x.clientActionId) ? x.clientActionId : null;
    if (id && seen.has(id)) { out.push({ clientActionId: id, invalid: "Repeated clientActionId in one request." }); continue; }
    if (id) seen.add(id);
    const bad = (m) => out.push({ clientActionId: id, invalid: m });
    if (!id) { bad("clientActionId must be 8-64 characters of A-Z a-z 0-9 _ -."); continue; }
    const extra = Object.keys(x).find((k) => !KEYS.includes(k)); if (extra) { bad(`Unknown field: ${extra}.`); continue; }
    if (x.type !== TYPE) { bad("type must be submission_draft."); continue; }
    if (!Number.isInteger(x.assignmentId) || x.assignmentId < 1) { bad("assignmentId must be a positive whole number."); continue; }
    const q = typeof x.queuedAt === "string" ? new Date(x.queuedAt) : null; if (!q || Number.isNaN(q.getTime())) { bad("queuedAt must be a date and time."); continue; }
    if (typeof x.text !== "string") { bad("text must be a string."); continue; }
    const t = S.cleanText(x.text); if (t.length > S.MAX_TEXT) { bad(`The text is too long: at most ${S.MAX_TEXT} characters.`); continue; }
    if (!("baseVersion" in x)) { bad("baseVersion is required (the version you last saw, or null when you had no draft)."); continue; }
    let base = null; if (x.baseVersion !== null) { base = parseVersion(x.baseVersion); if (!base) { bad("baseVersion must be null or the draft updatedAt text exactly as the server sent it."); continue; } }
    out.push({ clientActionId: id, type: TYPE, assignmentId: x.assignmentId, queuedAt: q, text: t, baseVersion: base ? base.toISOString() : null });
  }
  return { ok: true, actions: out };
}

/* Pure. { ok, choice, serverVersion, text, clientActionId|null, assignmentId } or { ok:false, errors }. */
function validateResolve(body) {
  const RK = ["assignmentId", "choice", "serverVersion", "text", "clientActionId"];
  if (!isObj(body)) return { ok: false, errors: ["Body must be an object."] };
  const extra = Object.keys(body).find((k) => !RK.includes(k)); if (extra) return { ok: false, errors: [`Unknown field: ${extra}.`] };
  if (!Number.isInteger(body.assignmentId) || body.assignmentId < 1) return { ok: false, errors: ["assignmentId must be a positive whole number."] };
  if (!CHOICES.includes(body.choice)) return { ok: false, errors: ["choice must be keep_server, keep_mine or keep_both."] };
  if (!parseVersion(body.serverVersion)) return { ok: false, errors: ["serverVersion must be the version the server sent with the conflict."] };
  if (body.clientActionId !== undefined && !(typeof body.clientActionId === "string" && ID_RE.test(body.clientActionId))) return { ok: false, errors: ["clientActionId must be 8-64 characters of A-Z a-z 0-9 _ -."] };
  let text = null;
  if (body.choice === "keep_server") { if (body.text !== undefined) return { ok: false, errors: ["Do not send text with keep_server."] }; }
  else { if (typeof body.text !== "string") return { ok: false, errors: ["text (your offline text) is required for keep_mine and keep_both."] }; text = S.cleanText(body.text); if (text.length > S.MAX_TEXT) return { ok: false, errors: [`The text is too long: at most ${S.MAX_TEXT} characters.`] }; }
  return { ok: true, assignmentId: body.assignmentId, choice: body.choice, serverVersion: body.serverVersion, text, clientActionId: body.clientActionId || null };
}

const stale = (q, now) => q.getTime() < now.getTime() - MAX_AGE_DAYS * 86400000 || q.getTime() > now.getTime() + FUTURE_SKEW_MS;
const answer = (a, state, code, extra) => ({ clientActionId: a.clientActionId, state, ...(code ? { code } : {}), ...(extra || {}) });
const verOf = (row) => S.iso(row.updated_at);

async function loadDraft(pool, courseId, assignmentId, sid) {
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid)
    .query(`SELECT TOP 1 ${S.COLS} FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft'`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
/* One guarded write: only while the draft is STILL at `base`. The new version is always later than `base`, so a second device can never see the same version twice. */
async function guardedUpdate(pool, courseId, assignmentId, sid, text, base, now) {
  const when = new Date(Math.max(now.getTime(), new Date(base).getTime() + 1));
  const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("t", sql.NVarChar(sql.MAX), text).input("base", sql.DateTime2, new Date(base)).input("now", sql.DateTime2, when)
    .query(`UPDATE lms_submissions SET body_text = @t, updated_at = @now OUTPUT ${COLS} WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'draft' AND updated_at = @base`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
/* The very first draft (the device had none): only while attempts remain, in the same statement. */
async function guardedInsert(pool, courseId, assignmentId, sid, text, maxAttempts, now) {
  try {
    const r = await pool.request().input("c", sql.Int, courseId).input("a", sql.Int, assignmentId).input("s", sql.Int, sid).input("t", sql.NVarChar(sql.MAX), text).input("max", sql.Int, maxAttempts).input("now", sql.DateTime2, now)
      .query(`INSERT INTO lms_submissions (assignment_id, course_id, student_id, attempt_no, status, body_text, created_at, updated_at)
              OUTPUT ${COLS}
              SELECT @a, @c, @s, x.n + 1, 'draft', @t, @now, @now
              FROM (SELECT COUNT(*) AS n FROM lms_submissions WHERE assignment_id = @a AND course_id = @c AND student_id = @s AND status = 'submitted') x
              WHERE x.n < @max AND NOT EXISTS (SELECT 1 FROM lms_submissions d WHERE d.assignment_id = @a AND d.course_id = @c AND d.student_id = @s AND d.status = 'draft')`);
    return { row: r.recordset && r.recordset[0] ? r.recordset[0] : null };
  } catch (e) { if (!isDup(e)) throw e; return { row: null, raced: true }; }
}

const conflictOf = (server, deviceText, queuedAt) => ({ serverVersion: verOf(server), serverText: server.body_text ?? "", deviceText, ...(queuedAt ? { deviceQueuedAt: queuedAt.toISOString() } : {}) });

/* Decide one draft write against the server draft. Returns { state:'applied', version, unchanged? } | { state:'conflict', conflict } | { state:'rejected', code, message }. Max two passes (a race can create/move the draft once). */
async function decide(pool, courseId, sid, a, found, now) {
  for (let pass = 0; pass < 2; pass++) {
    const d = await loadDraft(pool, courseId, a.assignmentId, sid);
    if (!d) {
      if (a.baseVersion !== null) return { state: "rejected", code: "DRAFT_GONE", message: "Your draft is no longer on the server (it may have been handed in). Your offline text is still on your device." };
      const w = await guardedInsert(pool, courseId, a.assignmentId, sid, a.text, found.model.maxAttempts, now);
      if (w.row) return { state: "applied", version: verOf(w.row) };
      if (w.raced) continue;
      return { state: "rejected", code: "ATTEMPTS_USED", message: "You have used all your attempts." };
    }
    if ((d.body_text ?? "") === a.text) return { state: "applied", version: verOf(d), unchanged: true }; // nothing to fight about
    if (a.baseVersion === null || verOf(d) !== a.baseVersion) return { state: "conflict", conflict: conflictOf(d, a.text, a.queuedAt) };
    const row = await guardedUpdate(pool, courseId, a.assignmentId, sid, a.text, a.baseVersion, now);
    if (row) return { state: "applied", version: verOf(row) };
    // the draft moved between the read and the write: look again (never overwrite)
  }
  const d = await loadDraft(pool, courseId, a.assignmentId, sid);
  return d ? { state: "conflict", conflict: conflictOf(d, a.text, a.queuedAt) } : { state: "rejected", code: "DRAFT_GONE", message: "Your draft is no longer on the server." };
}

async function finish(pool, rowId, sid, state, code, version) {
  await pool.request().input("id", sql.Int, rowId).input("s", sql.Int, sid).input("st", sql.NVarChar(12), state).input("cd", sql.NVarChar(40), code || null).input("v", sql.NVarChar(40), version || null)
    .query(`UPDATE lms_offline_actions SET result_state = @st, result_code = @cd, result_version = @v, processed_at = SYSUTCDATETIME() WHERE id = @id AND student_id = @s`);
}

async function processOne(pool, courseId, sid, a, ctx) {
  const now = ctx.now || new Date();
  if (a.invalid) return { clientActionId: a.clientActionId || null, state: "rejected", code: "INVALID", message: a.invalid };
  if (stale(a.queuedAt, now)) return answer(a, "rejected", "STALE_ACTION"); // nothing stored: a stale action never claims its id
  let rowId = null;
  try {
    const r = await pool.request().input("c", sql.Int, courseId).input("s", sql.Int, sid).input("a", sql.NVarChar(64), a.clientActionId).input("t", sql.NVarChar(30), TYPE).input("as", sql.Int, a.assignmentId).input("q", sql.DateTime2, a.queuedAt)
      .query(`INSERT INTO lms_offline_actions (course_id, student_id, client_action_id, action_type, assignment_id, queued_at) OUTPUT INSERTED.id VALUES (@c, @s, @a, @t, @as, @q)`);
    rowId = r.recordset && r.recordset[0] ? r.recordset[0].id : null;
  } catch (e) { if (!isDup(e)) throw e; }
  if (rowId === null) {
    const q = await pool.request().input("s", sql.Int, sid).input("a", sql.NVarChar(64), a.clientActionId)
      .query(`SELECT TOP 1 id, course_id, action_type, assignment_id, result_state, result_code, result_version FROM lms_offline_actions WHERE student_id = @s AND client_action_id = @a`);
    const old = q.recordset && q.recordset[0]; if (!old) return answer(a, "rejected", "INVALID");
    if (old.course_id !== courseId || old.action_type !== TYPE || old.assignment_id !== a.assignmentId) return answer(a, "rejected", "ACTION_ID_REUSED");
    if (old.result_state) return answer(a, "duplicate", old.result_code || null, { firstResult: old.result_state, ...(old.result_version ? { version: old.result_version } : {}) });
    rowId = old.id; // received earlier but never finished (a crash, or an earlier conflict): evaluate it again against the server as it is now
  }
  const g = await (ctx.gate || S.gate)(pool, courseId, a.assignmentId, sid, ctx.settings, now); // `ctx.gate`: per-call injection for tests, never a shared global
  if (!g.ok) { const code = g.notFound ? "NOT_FOUND" : g.code || "INVALID"; await finish(pool, rowId, sid, "rejected", code, null); return answer(a, "rejected", code, g.errors && g.errors[0] ? { message: g.errors[0] } : {}); }
  if (g.found.model.workMode === "group") { await finish(pool, rowId, sid, "rejected", "GROUP_NOT_SUPPORTED", null); return answer(a, "rejected", "GROUP_NOT_SUPPORTED", { message: "Group work cannot be saved offline. Open it online." }); }
  const d = await decide(pool, courseId, sid, a, g.found, now);
  if (d.state === "conflict") return answer(a, "conflict", "DRAFT_CHANGED", { conflict: d.conflict }); // the row stays unfinished on purpose: the id is not used up
  if (d.state === "rejected") { await finish(pool, rowId, sid, "rejected", d.code, null); return answer(a, "rejected", d.code, { message: d.message }); }
  await finish(pool, rowId, sid, "applied", null, d.version);
  return answer(a, "applied", null, { version: d.version, ...(d.unchanged ? { unchanged: true } : {}) });
}

async function replayDrafts(pool, courseId, studentId, body, ctx = {}) {
  const cid = posInt(courseId), sid = posInt(studentId); if (!cid || !sid) return { ok: false, notFound: true, errors: ["Course not found."] };
  const v = validateBatch(body); if (!v.ok) return { ok: false, errors: v.errors };
  ctx = { ...ctx, settings: typeof ctx.settings === "function" ? await ctx.settings() : ctx.settings }; // settings are read only for a body that passed validation
  const results = []; for (const a of v.actions) results.push(await processOne(pool, cid, sid, a, ctx));
  const count = (s) => results.filter((x) => x.state === s).length;
  return { ok: true, results, summary: { applied: count("applied"), duplicate: count("duplicate"), conflict: count("conflict"), rejected: count("rejected") } };
}

/* L10.4: the learner's choice after a conflict. */
async function resolveDraft(pool, user, courseId, body, ctx = {}) {
  const now = ctx.now || new Date(), cid = posInt(courseId), sid = S.studentIdOf(user); if (!cid || !sid) return { ok: false, notFound: true, errors: ["Course not found."] };
  const v = validateResolve(body); if (!v.ok) return { ok: false, errors: v.errors };
  ctx = { ...ctx, settings: typeof ctx.settings === "function" ? await ctx.settings() : ctx.settings };
  const g = await (ctx.gate || S.gate)(pool, cid, v.assignmentId, sid, ctx.settings, now);
  // keep_server writes nothing, so it only needs to show the learner's own draft; the other choices need the same open window as any draft save
  if (!g.ok && (v.choice !== "keep_server" || g.notFound)) return g.notFound ? { ok: false, notFound: true, errors: ["Assignment not found."] } : g;
  if (g.ok && g.found.model.workMode === "group") return { ok: false, code: "GROUP_NOT_SUPPORTED", errors: ["Group work cannot be saved offline. Open it online."] };
  const d = await loadDraft(pool, cid, v.assignmentId, sid);
  if (!d) return { ok: false, code: "DRAFT_GONE", errors: ["Your draft is no longer on the server (it may have been handed in)."] };
  const closeAction = async (version) => { if (v.clientActionId) await pool.request().input("c", sql.Int, cid).input("s", sql.Int, sid).input("a", sql.NVarChar(64), v.clientActionId).input("as", sql.Int, v.assignmentId).input("cd", sql.NVarChar(40), v.choice).input("v", sql.NVarChar(40), version || null)
    .query(`UPDATE lms_offline_actions SET result_state = 'resolved', result_code = @cd, result_version = @v, processed_at = SYSUTCDATETIME() WHERE student_id = @s AND client_action_id = @a AND course_id = @c AND assignment_id = @as AND action_type = 'submission_draft' AND result_state IS NULL`); };
  const done = async (row, unchanged) => { await closeAction(verOf(row)); await audit(pool, actorOf(user), "submission.offline_resolved", "lms_submissions", row.id, { courseId: cid, assignmentId: v.assignmentId, choice: v.choice }); return { ok: true, choice: v.choice, draft: { text: row.body_text ?? "", version: verOf(row) }, ...(unchanged ? { unchanged: true } : {}) }; };
  if (v.choice === "keep_server") return done(d, true);
  const serverText = d.body_text ?? "", target = v.choice === "keep_mine" ? v.text : serverText === v.text ? serverText : `${serverText}${DIVIDER}${v.text}`.trim();
  if (serverText === target || (v.choice === "keep_both" && serverText.endsWith(DIVIDER + v.text))) return done(d, true); // already what the learner chose (a replay of this very request, or the same text)
  if (verOf(d) !== v.serverVersion) return { ok: true, conflict: true, ...conflictOf(d, v.text, null) }; // the server draft moved again: show both again, write nothing
  if (target.length > S.MAX_TEXT) return { ok: false, code: "TOO_LONG", errors: [`Both versions together are longer than ${S.MAX_TEXT} characters. Keep one, or shorten your text first.`] };
  const row = await guardedUpdate(pool, cid, v.assignmentId, sid, target, v.serverVersion, now);
  if (!row) { const again = await loadDraft(pool, cid, v.assignmentId, sid); return again ? { ok: true, conflict: true, ...conflictOf(again, v.text, null) } : { ok: false, code: "DRAFT_GONE", errors: ["Your draft is no longer on the server."] }; }
  return done(row, false);
}

module.exports = { MAX_ACTIONS, TYPE, CHOICES, DIVIDER, validateBatch, validateResolve, replayDrafts, resolveDraft };
