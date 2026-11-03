/* =========================================================================
   LMS FLASHCARDS  (L6.3b, D-082)  a quiz in mode `flashcards` is a DECK: front = the question stem, back = the answer + explanation.
   No marking, no score, no attempts: the learner rates each card `known` or `unknown` and can change it any time (one rating per learner per card).
   Rules:
   - Student only, ACTIVE enrolment (checked in the routes). Only PUBLISHED, already-available flashcard decks of a published or archived course;
     any other quiz (including a normal quiz) is "not found", so this route can never show the answer key of a quiz that is being marked.
   - The deck is the quiz's FIXED questions (attempt_id IS NULL), in teacher order, max 100. Random rules are refused on a flashcard deck (lmsQuizRules).
   - Ratings are refused while the course is archived (409 COURSE_READ_ONLY). Ratings never feed grades, results or the gradebook.
   - The back of a card is built from the stored question snapshot (`backOf`, pure). Essays have no model answer: the back shows the explanation only.
   Every query is parameterised and matches course_id; the learner id always comes from the token.
========================================================================= */
const sql = require("mssql");
const { actorOf } = require("./lmsPermissions");
const { posInt } = require("./lmsCourseParts");
const { revealQuestion } = require("./lmsQuizAttempts");

const RATINGS = ["known", "unknown"];
const MAX_CARDS = 100;
const studentIdOf = (user) => { const a = actorOf(user); return a && a.source === "Students" && a.role === "student" ? a.id : null; };
const notFound = (what = "Deck") => ({ ok: false, notFound: true, errors: [`${what} not found.`] });
const parseSpec = (json) => { try { const v = JSON.parse(json); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const plain = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();

/* Pure. The back of a card: the answer as a few plain lines. */
function backOf(q) {
  const k = revealQuestion({ type: q.type, spec: q.spec || {} }); const lines = [];
  switch (q.type) {
    case "mcq_single": case "mcq_multi": for (const o of k.options || []) if (o.correct) lines.push(plain(o.text)); break;
    case "true_false": lines.push(k.correct ? "True" : "False"); break;
    case "short_answer": for (const a of k.accepted || []) lines.push(plain(a)); break;
    case "numeric": lines.push(`${k.value}${k.tolerance ? ` (± ${k.tolerance})` : ""}${k.unit ? ` ${plain(k.unit)}` : ""}`); break;
    case "matching": for (const p of k.pairs || []) lines.push(`${plain(p.left)} → ${plain(p.right)}`); break;
    case "ordering": (k.items || []).forEach((it, i) => lines.push(`${i + 1}. ${plain(it.text)}`)); break;
    default: break; // essay: no model answer
  }
  return { answer: lines.filter(Boolean), explanation: plain(q.explanation) };
}
/* Pure. Counts over the deck's live cards only (a rating of a removed card is ignored). */
function progressOf(cardIds, ratingMap) {
  let known = 0, unknown = 0;
  for (const id of cardIds) { const r = ratingMap.get(id); if (r === "known") known++; else if (r === "unknown") unknown++; }
  return { total: cardIds.length, known, unknown, unrated: cardIds.length - known - unknown };
}

async function loadDeck(pool, courseId, quizId, now) {
  const qid = posInt(quizId); if (qid === null) return null;
  const r = await pool.request().input("c", sql.Int, courseId).input("id", sql.Int, qid).input("now", sql.DateTime2, now)
    .query(`SELECT TOP 1 z.id, z.title, z.instructions, c.status AS course_status FROM lms_quizzes z JOIN lms_courses c ON c.id = z.course_id AND c.deleted_at IS NULL AND c.status IN ('published','archived')
      WHERE z.id = @id AND z.course_id = @c AND z.deleted_at IS NULL AND z.status = 'published' AND z.quiz_mode = 'flashcards' AND (z.available_from IS NULL OR z.available_from <= @now)`);
  const row = r.recordset && r.recordset[0]; return row ? { id: row.id, title: row.title, instructions: row.instructions || "", readOnly: row.course_status === "archived" } : null;
}
async function loadRatings(pool, courseId, quizId, sid) {
  const r = await pool.request().input("z", sql.Int, quizId).input("c", sql.Int, courseId).input("s", sql.Int, sid)
    .query(`SELECT quiz_question_id, rating FROM lms_flashcard_ratings WHERE quiz_id = @z AND course_id = @c AND student_id = @s`);
  return new Map((r.recordset || []).map((x) => [x.quiz_question_id, x.rating]));
}

async function getDeck(pool, user, courseId, quizId, { now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  const deck = await loadDeck(pool, courseId, quizId, now); if (!deck) return notFound();
  const k = await pool.request().input("z", sql.Int, deck.id).input("c", sql.Int, courseId)
    .query(`SELECT TOP ${MAX_CARDS} id, position, type, stem, explanation, spec_json FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL ORDER BY position, id`);
  const rows = k.recordset || []; const ratings = await loadRatings(pool, courseId, deck.id, sid);
  const cards = rows.map((q, i) => ({ id: q.id, number: i + 1, type: q.type, front: plain(q.stem), back: backOf({ type: q.type, explanation: q.explanation, spec: parseSpec(q.spec_json) }), rating: ratings.get(q.id) || null }));
  return { ok: true, deck: { id: deck.id, title: deck.title, instructions: deck.instructions, readOnly: deck.readOnly, cards, progress: progressOf(rows.map((q) => q.id), ratings) } };
}

/* rating: "known" | "unknown" | null (clears the rating). */
async function rateCard(pool, user, courseId, quizId, cardId, body, { now = new Date() } = {}) {
  const sid = studentIdOf(user); if (!sid) return notFound();
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "rating") || !("rating" in body) || (body.rating !== null && !RATINGS.includes(body.rating))) return { ok: false, errors: ['Body must be {rating: "known" | "unknown" | null}.'] };
  const kid = posInt(cardId); if (kid === null) return notFound("Card");
  const deck = await loadDeck(pool, courseId, quizId, now); if (!deck) return notFound();
  if (deck.readOnly) return { ok: false, code: "COURSE_READ_ONLY", errors: ["This course is archived, so cards can no longer be rated."] };
  const own = await pool.request().input("k", sql.Int, kid).input("z", sql.Int, deck.id).input("c", sql.Int, courseId)
    .query(`SELECT TOP 1 id FROM lms_quiz_questions WHERE id = @k AND quiz_id = @z AND course_id = @c AND attempt_id IS NULL`);
  if (!(own.recordset && own.recordset.length)) return notFound("Card");
  const req = pool.request().input("k", sql.Int, kid).input("z", sql.Int, deck.id).input("c", sql.Int, courseId).input("s", sql.Int, sid);
  if (body.rating === null) await req.query(`DELETE FROM lms_flashcard_ratings WHERE quiz_question_id = @k AND quiz_id = @z AND course_id = @c AND student_id = @s`);
  else await req.input("r", sql.NVarChar(10), body.rating).query(`SET XACT_ABORT ON; BEGIN TRAN;
    UPDATE lms_flashcard_ratings WITH (UPDLOCK, HOLDLOCK) SET rating = @r, rated_at = SYSUTCDATETIME() WHERE quiz_question_id = @k AND quiz_id = @z AND course_id = @c AND student_id = @s;
    IF @@ROWCOUNT = 0 INSERT INTO lms_flashcard_ratings (quiz_id, course_id, student_id, quiz_question_id, rating) VALUES (@z, @c, @s, @k, @r);
    COMMIT;`);
  const all = await pool.request().input("z", sql.Int, deck.id).input("c", sql.Int, courseId).query(`SELECT TOP ${MAX_CARDS} id FROM lms_quiz_questions WHERE quiz_id = @z AND course_id = @c AND attempt_id IS NULL ORDER BY position, id`);
  const ratings = await loadRatings(pool, courseId, deck.id, sid);
  return { ok: true, rating: body.rating, progress: progressOf((all.recordset || []).map((x) => x.id), ratings) };
}

module.exports = { RATINGS, MAX_CARDS, backOf, progressOf, getDeck, rateCard };
