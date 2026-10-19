/* Submit queue: limits simultaneous submissions, keeps order, dedupes, refuses politely. */
const { suite, test, assert } = require("./helpers/tinytest");
suite("submitQueue.test.js");

const { SubmitQueue, isQueueBusy, queueFor } = require("../utils/submitQueue");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("never runs more than `concurrency` at once, and finishes everything", async () => {
  const q = new SubmitQueue({ concurrency: 3, maxQueue: 1000, maxWaitMs: 5000 });
  let running = 0, peak = 0, done = 0;
  const jobs = Array.from({ length: 40 }, (_, i) =>
    q.run(`a:${i}`, async () => {
      running++; peak = Math.max(peak, running);
      await sleep(5);
      running--; done++;
      return i;
    })
  );
  const out = await Promise.all(jobs);
  assert.strictEqual(peak, 3);
  assert.strictEqual(done, 40);
  assert.deepStrictEqual(out, Array.from({ length: 40 }, (_, i) => i));
});

test("first come, first served", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 100, maxWaitMs: 5000 });
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map((n) => q.run(`k:${n}`, async () => { await sleep(2); order.push(n); })));
  assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
});

test("same student + exam already in the line is not queued twice", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 100, maxWaitMs: 5000 });
  let calls = 0;
  const fn = async () => { calls++; await sleep(10); return "saved"; };
  const [a, b, c] = await Promise.all([q.run("9:1", fn), q.run("9:1", fn), q.run("9:1", fn)]);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual([a, b, c], ["saved", "saved", "saved"]);
  // once finished, the key is free again (a later resit may submit)
  await q.run("9:1", fn);
  assert.strictEqual(calls, 2);
});

test("a caller that waits too long gets QUEUE_BUSY with a retry hint, and the line moves on", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 100, maxWaitMs: 20 });
  const slow = q.run("s:1", () => sleep(80));
  const waiter = q.run("s:2", async () => "never");
  let err;
  try { await waiter; } catch (e) { err = e; }
  assert.ok(isQueueBusy(err));
  assert.strictEqual(err.reason, "timeout");
  assert.ok(err.retryAfterSec >= 3);
  await slow;
  assert.strictEqual(q.depth, 0);
  assert.strictEqual(await q.run("s:3", async () => "ok"), "ok"); // queue still healthy
});

test("a line longer than maxQueue is refused straight away", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 2, maxWaitMs: 5000 });
  const hold = q.run("f:0", () => sleep(30));
  const w1 = q.run("f:1", async () => 1);
  const w2 = q.run("f:2", async () => 2);
  let err;
  try { await q.run("f:3", async () => 3); } catch (e) { err = e; }
  assert.ok(isQueueBusy(err));
  assert.strictEqual(err.reason, "full");
  await Promise.all([hold, w1, w2]);
});

test("background work (maxWaitMs: Infinity) waits its turn and never gives up", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 100, maxWaitMs: 10 });
  const hold = q.run("b:0", () => sleep(60));
  const bg = await q.run("b:1", async () => "swept", { maxWaitMs: Infinity });
  await hold;
  assert.strictEqual(bg, "swept");
});

test("a failing submission frees its slot and does not poison the line", async () => {
  const q = new SubmitQueue({ concurrency: 1, maxQueue: 100, maxWaitMs: 5000 });
  const bad = q.run("e:1", async () => { throw new Error("boom"); });
  const good = q.run("e:2", async () => "fine");
  await assert.rejects(bad, /boom/);
  assert.strictEqual(await good, "fine");
});

test("each database pool gets its own line", () => {
  const poolA = {}, poolB = {};
  assert.strictEqual(queueFor(poolA), queueFor(poolA));
  assert.notStrictEqual(queueFor(poolA), queueFor(poolB));
});
