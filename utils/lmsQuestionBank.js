/* =========================================================================
   LMS QUESTION BANK  (L6.1b, D-073)  storage + rules around the pure functions in lmsQuizMarking.js / lmsQuestionCsv.js.

   Who sees what (the `scope` of a question; a question never changes scope, COPY it into another scope instead):
   - private  its owner, plus LMS administrators who may read, change and delete it (owner decisions A75 + A78, S31). Reading someone else's
              private question as an administrator is written to the audit log (question.viewed_private); changes are audited as usual.
   - course   staff of that course (owner / co-teacher), and LMS administrators. Creating one needs course membership and a course that is not
              archived or waiting for approval.
   - school   every teacher (read and copy); only the owner and LMS administrators may change or delete it.
   "Not visible" and "does not exist" look identical (404). Visible but not yours to change = 403 QUESTION_NOT_EDITABLE.
   (The master prompt says private/department/tenant; the LMS has no department entity yet, so `course` stands in for it. Owner Q42: show BOTH
   names, so the API returns `scopeLabel` "Course staff / Department" for course sharing; the UI must show that label.)

   Versions: every save raises `version` by 1 and copies the content to lms_question_versions (the last 30 are kept). A save must send the
   `baseVersion` it edited; a stale one is refused (409 QUESTION_CONFLICT) and never overwrites. Restoring an old version is a NEW version.
   Outcome tags (`lms_outcome_tags`, entity 'question') are current-state only: they are not part of a version.
   Limits: 5 000 questions per owner; CSV import max 150 rows / 256 KB and ALL-OR-NOTHING (one error = nothing is created); export max 2 000 rows.
   Deleting is soft. Quizzes (L6.2) will keep their own snapshot of a question, so a later edit or delete never changes a marked attempt.
   Every query is parameterised; user text is never concatenated into SQL (only validated integers are written inline).
========================================================================= */
const sql = require("mssql");
const { audit } = require("./lmsAudit");
const { actorOf, courseRole } = require("./lmsPermissions");
const { posInt, editable } = require("./lmsCourseParts");
const { readCsv } = require("./lmsCsv");
const Q = require("./lmsQuizMarking");
const C = require("./lmsQuestionCsv");

const MAX_PER_OWNER = 5000, MAX_VERSIONS = 30, IMPORT_ROWS = 150, EXPORT_ROWS = 2000;
const SCOPE_LABELS = { private: "Private", course: "Course staff / Department", school: "School" };
const SCOPES = ["private", "course", "school"], SCOPE_FILTERS = ["mine", ...SCOPES];
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const paging = (o) => ({ size: Math.min(100, Math.max(1, Number.parseInt(o?.pageSize, 10) || 20)), pg: Math.max(1, Number.parseInt(o?.page, 10) || 1) });
const cut = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const iso = (d) => (d ? new Date(d).toISOString() : null);

const COLS = "q.id, q.scope, q.course_id, q.owner_source, q.owner_id, q.type, q.stem, q.explanation, q.points, q.difficulty, q.subject, q.topic, q.spec_json, q.version, q.source_system, q.source_ref, q.created_at, q.updated_at";
/* Visibility, in SQL. @src/@uid are the caller. */
const VISIBLE = (admin) => (admin
  ? `q.deleted_at IS NULL`
  : `q.deleted_at IS NULL AND ((q.owner_source = @src AND q.owner_id = @uid) OR q.scope = 'school' OR (q.scope = 'course' AND EXISTS (SELECT 1 FROM lms_course_staff s WHERE s.course_id = q.course_id AND s.user_source = @src AND s.user_id = @uid AND s.is_active = 1)))`);
const who = (pool, actor) => pool.request().input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id);

function parseSpec(json) { try { const v = JSON.parse(json); return isPlainObject(v) ? v : {}; } catch { return {}; } }
function model(row, actor, admin) {
  const mine = row.owner_source === actor.source && Number(row.owner_id) === actor.id;
  return { id: row.id, scope: row.scope, courseId: row.course_id ?? null, type: row.type, stem: row.stem, explanation: row.explanation || "", points: Number(row.points),
    difficulty: row.difficulty || null, subject: row.subject || "", topic: row.topic || "", spec: parseSpec(row.spec_json), version: row.version, mine,
    canEdit: mine || !!admin, scopeLabel: SCOPE_LABELS[row.scope] || row.scope, source: row.source_system ? { system: row.source_system, ref: row.source_ref ?? null } : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
const notFound = () => ({ ok: false, notFound: true, errors: ["Question not found."] });
const readOnly = () => ({ ok: false, forbidden: true, code: "QUESTION_NOT_EDITABLE", errors: ["Only the owner or an LMS administrator can change this question. You can copy it to make your own."] });

async function loadRow(pool, actor, admin, id) {
  const r = await who(pool, actor).input("id", sql.Int, id).query(`SELECT TOP 1 ${COLS} FROM lms_questions q WHERE q.id = @id AND ${VISIBLE(admin)}`);
  return r.recordset && r.recordset[0] ? r.recordset[0] : null;
}
async function outcomesFor(pool, ids) {
  if (!ids.length) return new Map();
  const q = pool.request(); ids.forEach((id, i) => q.input(`i${i}`, sql.Int, id));
  const r = await q.query(`SELECT t.entity_id, o.id AS outcome_id, o.code, o.title FROM lms_outcome_tags t INNER JOIN lms_learning_outcomes o ON o.id = t.outcome_id
    WHERE t.entity_type = 'question' AND t.entity_id IN (${ids.map((_, i) => `@i${i}`).join(", ")}) AND o.deleted_at IS NULL ORDER BY o.code`);
  const m = new Map();
  for (const x of r.recordset || []) { if (!m.has(x.entity_id)) m.set(x.entity_id, []); m.get(x.entity_id).push({ id: x.outcome_id, code: x.code, title: x.title }); }
  return m;
}
async function outcomesOk(pool, ids) {
  if (!ids.length) return true;
  const q = pool.request(); ids.forEach((id, i) => q.input(`o${i}`, sql.Int, id));
  const r = await q.query(`SELECT id FROM lms_learning_outcomes WHERE deleted_at IS NULL AND id IN (${ids.map((_, i) => `@o${i}`).join(", ")})`);
  const have = new Set((r.recordset || []).map((x) => x.id)); return ids.every((id) => have.has(id));
}
async function ownerCount(pool, actor) {
  const r = await who(pool, actor).query(`SELECT COUNT(*) AS n FROM lms_questions WHERE owner_source = @src AND owner_id = @uid AND deleted_at IS NULL`);
  return Number(r.recordset?.[0]?.n) || 0;
}

/* Where may a NEW question go? private/school: anywhere for a teacher. course: only a member, in a course that can be changed. */
async function checkTarget(pool, user, scope, courseId) {
  if (!SCOPES.includes(scope)) return { ok: false, errors: [`scope must be one of: ${SCOPES.join(", ")}.`] };
  if (scope !== "course") return courseId === undefined || courseId === null ? { ok: true } : { ok: false, errors: ["courseId is only used with scope \"course\"."] };
  const id = posInt(courseId); if (id === null) return { ok: false, errors: ["courseId is required for a course question."] };
  const role = await courseRole(pool, user, id);
  if (!role || role === "student") return { ok: false, notFound: true, errors: ["Course not found."] };
  const e = await editable(pool, id); if (!e.ok) return e;
  return { ok: true, courseId: id };
}

/* One INSERT unit (question + its first version + tags). Params are suffixed by `i` so many fit in one batch; ids/outcomes are validated integers. */
function insertSql(req, i, m, ctx) {
  req.input(`ty${i}`, sql.NVarChar(20), m.type).input(`st${i}`, sql.NVarChar(4000), m.stem).input(`ex${i}`, sql.NVarChar(2000), m.explanation || null)
    .input(`pt${i}`, sql.Decimal(6, 2), m.points).input(`df${i}`, sql.NVarChar(10), m.difficulty).input(`sj${i}`, sql.NVarChar(100), m.subject || null)
    .input(`tp${i}`, sql.NVarChar(100), m.topic || null).input(`sp${i}`, sql.NVarChar(sql.MAX), JSON.stringify(m.spec));
  if (ctx.ref) req.input(`sr${i}`, sql.Int, ctx.ref);
  const tags = m.outcomeIds.map((o) => `(${o}, 'question', @qid, ${ctx.scope === "course" ? "@c" : "0"})`);
  return `INSERT INTO lms_questions (scope, course_id, owner_source, owner_id, type, stem, explanation, points, difficulty, subject, topic, spec_json, version, source_system, source_ref)
      VALUES (@sc, ${ctx.scope === "course" ? "@c" : "NULL"}, @src, @uid, @ty${i}, @st${i}, @ex${i}, @pt${i}, @df${i}, @sj${i}, @tp${i}, @sp${i}, 1, ${ctx.source && /^[a-z]{1,20}$/.test(ctx.source) ? `'${ctx.source}'` : "NULL"}, ${ctx.ref ? `@sr${i}` : "NULL"});
    SET @qid = SCOPE_IDENTITY();
    INSERT INTO lms_question_versions (question_id, version, type, stem, explanation, points, difficulty, subject, topic, spec_json, changed_by_source, changed_by)
      SELECT id, version, type, stem, explanation, points, difficulty, subject, topic, spec_json, @src, @uid FROM lms_questions WHERE id = @qid;
    ${tags.length ? `INSERT INTO lms_outcome_tags (outcome_id, entity_type, entity_id, course_id) VALUES ${tags.join(", ")};` : ""}`;
}
const VERSION_COPY = `INSERT INTO lms_question_versions (question_id, version, type, stem, explanation, points, difficulty, subject, topic, spec_json, changed_by_source, changed_by)
      SELECT id, version, type, stem, explanation, points, difficulty, subject, topic, spec_json, @src, @uid FROM lms_questions WHERE id = @id;
    DELETE FROM lms_question_versions WHERE question_id = @id AND version <= (SELECT version FROM lms_questions WHERE id = @id) - ${MAX_VERSIONS};`;

async function insertMany(pool, actor, target, models, ctx) {
  const req = who(pool, actor).input("sc", sql.NVarChar(10), target.scope); if (target.scope === "course") req.input("c", sql.Int, target.courseId);
  const units = models.map((m, i) => insertSql(req, i, m, { ...ctx, scope: target.scope }));
  const r = await req.query(`SET XACT_ABORT ON; DECLARE @qid INT; DECLARE @first INT; BEGIN TRAN;
    ${units.map((u, i) => `${u}${i === 0 ? "\n    SET @first = @qid;" : ""}`).join("\n    ")}
    COMMIT; SELECT @first AS id;`);
  return r.recordset?.[0]?.id;
}

const TOP_CREATE = ["scope", "courseId"];
function splitCreate(body) {
  if (!isPlainObject(body)) return { errors: ["Body must be an object."] };
  const rest = { ...body }; const head = {}; for (const k of TOP_CREATE) { if (k in rest) { head[k] = rest[k]; delete rest[k]; } }
  return { head, rest };
}

async function createQuestion(pool, user, body, ctx = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  const s = splitCreate(body); if (s.errors) return { ok: false, errors: s.errors };
  const v = Q.validateQuestion(s.rest); if (!v.ok) return { ok: false, errors: v.errors };
  const t = await checkTarget(pool, user, s.head.scope === undefined ? "private" : s.head.scope, s.head.courseId); if (!t.ok) return t;
  if (!(await outcomesOk(pool, v.value.outcomeIds))) return { ok: false, errors: ["Every outcome must exist (it may have been retired)."] };
  if ((await ownerCount(pool, actor)) >= MAX_PER_OWNER) return { ok: false, code: "QUESTION_LIMIT", errors: [`You can keep at most ${MAX_PER_OWNER} questions.`] };
  const target = { scope: s.head.scope === undefined ? "private" : s.head.scope, courseId: t.courseId };
  const id = await insertMany(pool, actor, target, [v.value], { source: ctx.source || null, ref: ctx.ref || null });
  await audit(pool, actor, "question.created", "lms_questions", id, { scope: target.scope, courseId: target.courseId ?? null, type: v.value.type });
  return getQuestion(pool, user, id, ctx);
}

async function getQuestion(pool, user, id, ctx = {}) {
  const actor = actorOf(user); if (!actor || !posInt(id)) return notFound();
  const row = await loadRow(pool, actor, ctx.admin, id); if (!row) return notFound();
  const m = model(row, actor, ctx.admin); m.outcomes = (await outcomesFor(pool, [row.id])).get(row.id) || [];
  if (ctx.admin && row.scope === "private" && !m.mine) await audit(pool, actor, "question.viewed_private", "lms_questions", row.id, { ownerSource: row.owner_source, ownerId: Number(row.owner_id) });
  return { ok: true, question: m };
}

/* Filters shared by list and export. Returns { ok, where } and adds the parameters to `req`. */
function applyFilters(req, query, admin) {
  const q = query || {}; const w = [VISIBLE(admin)]; const errors = [];
  if (q.scope !== undefined && q.scope !== "") { if (!SCOPE_FILTERS.includes(q.scope)) errors.push(`scope must be one of: ${SCOPE_FILTERS.join(", ")}.`); else w.push(q.scope === "mine" ? "(q.owner_source = @src AND q.owner_id = @uid)" : `q.scope = '${q.scope}'`); }
  if (q.courseId !== undefined && q.courseId !== "") { const c = posInt(q.courseId); if (c === null) errors.push("courseId must be a number."); else { req.input("fc", sql.Int, c); w.push("q.course_id = @fc"); } }
  if (q.type !== undefined && q.type !== "") { if (!Q.TYPES.includes(q.type)) errors.push(`type must be one of: ${Q.TYPES.join(", ")}.`); else { req.input("ft", sql.NVarChar(20), q.type); w.push("q.type = @ft"); } }
  if (q.difficulty !== undefined && q.difficulty !== "") { if (!Q.DIFFICULTIES.includes(q.difficulty)) errors.push(`difficulty must be one of: ${Q.DIFFICULTIES.join(", ")}.`); else { req.input("fd", sql.NVarChar(10), q.difficulty); w.push("q.difficulty = @fd"); } }
  for (const [k, col, p] of [["subject", "q.subject", "fs"], ["topic", "q.topic", "fp"]]) if (q[k] !== undefined && q[k] !== "") { const t = String(q[k]).trim(); if (t.length > 100) errors.push(`${k} can be at most 100 characters.`); else { req.input(p, sql.NVarChar(100), t); w.push(`${col} = @${p}`); } }
  if (q.outcomeId !== undefined && q.outcomeId !== "") { const o = posInt(q.outcomeId); if (o === null) errors.push("outcomeId must be a number."); else { req.input("fo", sql.Int, o); w.push("EXISTS (SELECT 1 FROM lms_outcome_tags t WHERE t.entity_type = 'question' AND t.entity_id = q.id AND t.outcome_id = @fo)"); } }
  if (q.q !== undefined && q.q !== "") { const t = String(q.q).trim(); if (t.length > 100) errors.push("q can be at most 100 characters."); else if (t) { req.input("fq", sql.NVarChar(210), `%${t.replace(/[\\%_[]/g, (m) => `\\${m}`)}%`); w.push("q.stem LIKE @fq ESCAPE '\\'"); } }
  return errors.length ? { ok: false, errors } : { ok: true, where: w.join(" AND ") };
}

async function listQuestions(pool, user, query, ctx = {}) {
  const actor = actorOf(user); if (!actor) return { ok: true, items: [], total: 0, page: 1, pageSize: 20 };
  const { size, pg } = paging(query); const req = who(pool, actor).input("off", sql.Int, (pg - 1) * size).input("lim", sql.Int, size);
  const f = applyFilters(req, query, ctx.admin); if (!f.ok) return f;
  const r = await req.query(`SELECT ${COLS}, COUNT(*) OVER() AS total_count FROM lms_questions q WHERE ${f.where} ORDER BY q.updated_at DESC, q.id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
  const rows = r.recordset || [];
  const items = rows.map((x) => { const m = model(x, actor, ctx.admin); return { id: m.id, scope: m.scope, courseId: m.courseId, type: m.type, stem: cut(m.stem, 200), points: m.points, difficulty: m.difficulty, subject: m.subject, topic: m.topic, version: m.version, mine: m.mine, canEdit: m.canEdit, updatedAt: m.updatedAt }; });
  return { ok: true, items, total: rows.length ? Number(rows[0].total_count) : 0, page: pg, pageSize: size };
}

async function updateQuestion(pool, user, id, body, ctx = {}) {
  const actor = actorOf(user); if (!actor || !posInt(id)) return notFound();
  if (!isPlainObject(body)) return { ok: false, errors: ["Body must be an object."] };
  const { baseVersion, ...rest } = body; const bv = posInt(baseVersion);
  if (bv === null) return { ok: false, errors: ["baseVersion is required: the version you were editing."] };
  const v = Q.validateQuestion(rest); if (!v.ok) return { ok: false, errors: v.errors };
  const row = await loadRow(pool, actor, ctx.admin, id); if (!row) return notFound();
  if (!model(row, actor, ctx.admin).canEdit) return readOnly();
  if (row.scope === "course") { const e = await editable(pool, row.course_id); if (!e.ok) return e; }
  if (!(await outcomesOk(pool, v.value.outcomeIds))) return { ok: false, errors: ["Every outcome must exist (it may have been retired)."] };
  const m = v.value; const req = pool.request().input("id", sql.Int, row.id).input("bv", sql.Int, bv).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
    .input("ty", sql.NVarChar(20), m.type).input("st", sql.NVarChar(4000), m.stem).input("ex", sql.NVarChar(2000), m.explanation || null).input("pt", sql.Decimal(6, 2), m.points)
    .input("df", sql.NVarChar(10), m.difficulty).input("sj", sql.NVarChar(100), m.subject || null).input("tp", sql.NVarChar(100), m.topic || null).input("sp", sql.NVarChar(sql.MAX), JSON.stringify(m.spec));
  if (row.scope === "course") req.input("c", sql.Int, row.course_id);
  const tags = m.outcomeIds.map((o) => `(${o}, 'question', @id, ${row.scope === "course" ? "@c" : "0"})`);
  const r = await req.query(`SET XACT_ABORT ON; BEGIN TRAN;
    UPDATE lms_questions SET type = @ty, stem = @st, explanation = @ex, points = @pt, difficulty = @df, subject = @sj, topic = @tp, spec_json = @sp, version = version + 1, updated_at = SYSUTCDATETIME()
      WHERE id = @id AND version = @bv AND deleted_at IS NULL;
    IF @@ROWCOUNT = 0 BEGIN ROLLBACK; SELECT 'CONFLICT' AS outcome; RETURN; END
    ${VERSION_COPY}
    DELETE FROM lms_outcome_tags WHERE entity_type = 'question' AND entity_id = @id;
    ${tags.length ? `INSERT INTO lms_outcome_tags (outcome_id, entity_type, entity_id, course_id) VALUES ${tags.join(", ")};` : ""}
    COMMIT; SELECT 'OK' AS outcome;`);
  if (r.recordset?.[0]?.outcome !== "OK") return { ok: false, code: "QUESTION_CONFLICT", errors: ["This question was changed by someone else. Reload it and apply your edit again."] };
  await audit(pool, actor, "question.updated", "lms_questions", row.id, { type: m.type, fromVersion: bv });
  return getQuestion(pool, user, row.id, ctx);
}

async function deleteQuestion(pool, user, id, ctx = {}) {
  const actor = actorOf(user); if (!actor || !posInt(id)) return notFound();
  const row = await loadRow(pool, actor, ctx.admin, id); if (!row) return notFound();
  if (!model(row, actor, ctx.admin).canEdit) return readOnly();
  await pool.request().input("id", sql.Int, row.id).query(`UPDATE lms_questions SET deleted_at = SYSUTCDATETIME() WHERE id = @id AND deleted_at IS NULL`);
  await audit(pool, actor, "question.deleted", "lms_questions", row.id, { scope: row.scope });
  return { ok: true };
}

async function listVersions(pool, user, id, ctx = {}) {
  const actor = actorOf(user); if (!actor || !posInt(id)) return notFound();
  const row = await loadRow(pool, actor, ctx.admin, id); if (!row) return notFound();
  const r = await pool.request().input("id", sql.Int, row.id).query(`SELECT TOP ${MAX_VERSIONS} version, stem, created_at FROM lms_question_versions WHERE question_id = @id ORDER BY version DESC`);
  return { ok: true, currentVersion: row.version, versions: (r.recordset || []).map((x) => ({ version: x.version, stem: cut(x.stem, 120), createdAt: iso(x.created_at) })) };
}

async function restoreVersion(pool, user, id, version, body, ctx = {}) {
  const actor = actorOf(user); const vn = posInt(version); if (!actor || !posInt(id) || vn === null) return notFound();
  if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "baseVersion")) return { ok: false, errors: ["Send only baseVersion."] };
  const bv = posInt(body.baseVersion); if (bv === null) return { ok: false, errors: ["baseVersion is required: the version you were editing."] };
  const row = await loadRow(pool, actor, ctx.admin, id); if (!row) return notFound();
  if (!model(row, actor, ctx.admin).canEdit) return readOnly();
  if (row.scope === "course") { const e = await editable(pool, row.course_id); if (!e.ok) return e; }
  const have = await pool.request().input("id", sql.Int, row.id).input("v", sql.Int, vn).query(`SELECT TOP 1 version FROM lms_question_versions WHERE question_id = @id AND version = @v`);
  if (!have.recordset?.length) return notFound();
  const r = await pool.request().input("id", sql.Int, row.id).input("v", sql.Int, vn).input("bv", sql.Int, bv).input("src", sql.NVarChar(20), actor.source).input("uid", sql.Int, actor.id)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
    UPDATE q SET q.type = v.type, q.stem = v.stem, q.explanation = v.explanation, q.points = v.points, q.difficulty = v.difficulty, q.subject = v.subject, q.topic = v.topic, q.spec_json = v.spec_json,
      q.version = q.version + 1, q.updated_at = SYSUTCDATETIME()
      FROM lms_questions q INNER JOIN lms_question_versions v ON v.question_id = q.id AND v.version = @v WHERE q.id = @id AND q.version = @bv AND q.deleted_at IS NULL;
    IF @@ROWCOUNT = 0 BEGIN ROLLBACK; SELECT 'CONFLICT' AS outcome; RETURN; END
    ${VERSION_COPY}
    COMMIT; SELECT 'OK' AS outcome;`);
  if (r.recordset?.[0]?.outcome !== "OK") return { ok: false, code: "QUESTION_CONFLICT", errors: ["This question was changed by someone else. Reload it and try again."] };
  await audit(pool, actor, "question.restored", "lms_questions", row.id, { restoredVersion: vn, fromVersion: bv });
  return getQuestion(pool, user, row.id, ctx);
}

/* spec (stored) -> the body fields validateQuestion accepts */
function specToFields(type, spec) {
  const s = spec || {};
  switch (type) {
    case "mcq_single": return { options: (s.options || []).map((o) => ({ text: o.text, correct: !!o.correct, feedback: o.feedback || "" })) };
    case "mcq_multi": return { options: (s.options || []).map((o) => ({ text: o.text, correct: !!o.correct, feedback: o.feedback || "" })), partialCredit: !!s.partialCredit };
    case "true_false": return { correct: !!s.correct };
    case "short_answer": return { accepted: s.accepted || [], caseSensitive: !!s.caseSensitive };
    case "numeric": return { value: s.value, tolerance: s.tolerance || 0, unit: s.unit || "" };
    case "matching": return { pairs: (s.pairs || []).map((p) => ({ left: p.left, right: p.right })), partialCredit: !!s.partialCredit };
    case "ordering": return { items: (s.items || []).map((i) => i.text), partialCredit: !!s.partialCredit };
    default: return { maxWords: s.maxWords ?? null };
  }
}

/* Independent copy into another scope (own it afterwards). Body: { scope, courseId? }. Outcome tags are copied. */
async function copyQuestion(pool, user, id, body, ctx = {}) {
  const actor = actorOf(user); if (!actor || !posInt(id)) return notFound();
  if (!isPlainObject(body) || Object.keys(body).some((k) => !TOP_CREATE.includes(k))) return { ok: false, errors: ["Send only scope and (for a course) courseId."] };
  const got = await getQuestion(pool, user, id, ctx); if (!got.ok) return got;
  const q = got.question;
  return createQuestion(pool, user, { scope: body.scope, courseId: body.courseId, type: q.type, stem: q.stem, explanation: q.explanation, points: q.points, difficulty: q.difficulty || undefined,
    subject: q.subject, topic: q.topic, outcomeIds: q.outcomes.map((o) => o.id), ...specToFields(q.type, q.spec) }, { ...ctx, source: "copy", ref: q.id });
}

async function exportCsv(pool, user, query, ctx = {}) {
  const actor = actorOf(user); if (!actor) return { ok: true, csv: C.toCsv([]), count: 0 };
  const req = who(pool, actor); const f = applyFilters(req, query, ctx.admin); if (!f.ok) return f;
  const r = await req.query(`SELECT TOP ${EXPORT_ROWS} ${COLS} FROM lms_questions q WHERE ${f.where} ORDER BY q.id`);
  const list = (r.recordset || []).map((x) => model(x, actor, ctx.admin));
  await audit(pool, actor, "question.exported", "lms_questions", null, { count: list.length });
  return { ok: true, csv: C.toCsv(list), count: list.length };
}

/* Body { csv, dryRun?, scope?, courseId? }. All or nothing: any bad row = nothing is created and the report lists every bad row (max 50 shown). */
async function importCsv(pool, user, body, ctx = {}) {
  const actor = actorOf(user); if (!actor) return notFound();
  if (!isPlainObject(body) || Object.keys(body).some((k) => !["csv", "dryRun", "scope", "courseId"].includes(k))) return { ok: false, errors: ["Send only csv, dryRun, scope and courseId."] };
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return { ok: false, errors: ["dryRun must be true or false."] };
  const scope = body.scope === undefined ? "private" : body.scope;
  const parsed = readCsv(body.csv, { maxBytes: 256 * 1024, maxRows: IMPORT_ROWS, required: C.REQUIRED, known: C.KNOWN });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const t = await checkTarget(pool, user, scope, body.courseId); if (!t.ok) return t;
  const good = [], failed = [];
  for (const r of C.rowsToBodies(parsed.rows)) {
    if (r.errors) { failed.push({ line: r.line, message: r.errors[0] }); continue; }
    const v = Q.validateQuestion(r.body); if (!v.ok) failed.push({ line: r.line, message: v.errors[0] }); else good.push(v.value);
  }
  const report = { summary: { rows: parsed.rows.length, created: failed.length ? 0 : good.length, failed: failed.length }, failed: failed.slice(0, 50) };
  if (body.dryRun) return { ok: true, dryRun: true, report: { ...report, summary: { ...report.summary, created: good.length } } };
  if (failed.length) return { ok: false, code: "IMPORT_HAS_ERRORS", errors: [`${failed.length} row(s) have errors, so nothing was imported. Fix them and try again.`], extra: { report } };
  if ((await ownerCount(pool, actor)) + good.length > MAX_PER_OWNER) return { ok: false, code: "QUESTION_LIMIT", errors: [`You can keep at most ${MAX_PER_OWNER} questions.`] };
  await insertMany(pool, actor, { scope, courseId: t.courseId }, good, { source: "csv", ref: null });
  await audit(pool, actor, "question.imported", "lms_questions", null, { scope, courseId: t.courseId ?? null, created: good.length });
  return { ok: true, report };
}

/* For quizzes (L6.2a): the visible questions among `ids` (same visibility as everything else), at most 50. Returns rows keyed by id; hidden = absent. */
async function fetchVisible(pool, user, ids, ctx = {}) {
  const actor = actorOf(user); const list = [...new Set((ids || []).map(posInt).filter((n) => n !== null))].slice(0, 50);
  if (!actor || !list.length) return new Map();
  const req = who(pool, actor); list.forEach((id, i) => req.input(`i${i}`, sql.Int, id));
  const r = await req.query(`SELECT ${COLS} FROM lms_questions q WHERE q.id IN (${list.map((_, i) => `@i${i}`).join(", ")}) AND ${VISIBLE(ctx.admin)}`);
  return new Map((r.recordset || []).map((row) => [row.id, row]));
}

module.exports = { fetchVisible, MAX_PER_OWNER, MAX_VERSIONS, IMPORT_ROWS, EXPORT_ROWS, SCOPES, createQuestion, getQuestion, listQuestions, updateQuestion, deleteQuestion, listVersions, restoreVersion, copyQuestion, exportCsv, importCsv, specToFields };
