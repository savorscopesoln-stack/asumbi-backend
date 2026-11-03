/* Wait for LMS event-bus delivery in tests.
   Two traps this avoids (both seen in the full suite, S9):
   1) scheduler.test.js swaps global.setTimeout for a stub while tests run concurrently -> use timers.setTimeout.
   2) a heavy synchronous test (PDF render, SEB) can make a timer fire BEFORE the bus's setImmediate delivery -> after the timer, drain several setImmediate turns. */
const { setTimeout: realSetTimeout } = require("timers");
async function tick(ms = 30) {
  await new Promise((r) => realSetTimeout(r, ms));
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}
module.exports = { tick, realSetTimeout };
