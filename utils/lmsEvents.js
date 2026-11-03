/* =========================================================================
   LMS EVENT BUS  (L1.5) — in-process, deliberately tiny and swappable.
   Phase hooks for later analytics/AI: lms.lesson.completed,
   lms.submission.graded, lms.quiz.attempted, ...
   Rules: every event carries a tenant (events never cross schools); handlers
   run asynchronously after emit() returns; a failing handler is logged and
   never affects the emitter or other handlers; payloads must not contain
   personal data beyond ids. Replace the transport (queue/broker) later
   without changing emit()/on().
========================================================================= */
const EVENTS = Object.freeze([
  "lms.course.created", "lms.course.published", "lms.enrolment.changed",
  "lms.lesson.completed", "lms.lesson.published", "lms.submission.submitted", "lms.submission.graded",
  "lms.quiz.attempted", "lms.grade.released", "lms.settings.updated", "lms.announcement.published",
  "lms.assignment.published", "lms.extension.granted", "lms.quiz.published", "lms.quiz.graded", "lms.results.published", "lms.grade.entered", "lms.gradebook.synced",
  "lms.certificate.issued", "lms.badge.awarded", "lms.discussion.posted", "lms.help.answered",
]); 

const handlers = new Map(); // event or "*" -> Set<fn>

function on(event, fn) {
  if (typeof fn !== "function") throw new TypeError("handler must be a function");
  if (event !== "*" && !EVENTS.includes(event)) throw new Error(`Unknown LMS event "${event}"`);
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => off(event, fn);
}
function off(event, fn) { handlers.get(event)?.delete(fn); }

/* Returns true if the event was accepted for delivery; never throws. */
function emit(event, payload = {}) {
  if (!EVENTS.includes(event)) { console.error(`LMS EVENT REJECTED (unknown event "${event}")`); return false; }
  if (!payload || typeof payload.tenant !== "string" || !payload.tenant) { console.error(`LMS EVENT REJECTED (${event}: missing tenant)`); return false; }
  const evt = Object.freeze({ ...payload, event, at: new Date().toISOString() }); // payload can never override event/at
  const targets = [...(handlers.get(event) || []), ...(handlers.get("*") || [])];
  for (const fn of targets) {
    setImmediate(() => {
      Promise.resolve().then(() => fn(evt)).catch((err) => console.error(`LMS EVENT HANDLER ERROR (${event}):`, err.message));
    });
  }
  return true;
}

const _reset = () => handlers.clear(); // tests only
module.exports = { EVENTS, on, off, emit, _reset };
