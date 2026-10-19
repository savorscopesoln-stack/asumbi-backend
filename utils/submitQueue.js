/* =========================================================================
   SUBMIT QUEUE — lets many students submit at once without hammering SQL
   ─────────────────────────────────────────────────────────────────────────
   When an exam ends, every student's browser auto-submits within the same
   few seconds. Each submission is a multi-statement transaction that holds
   a pool connection for its whole life, so ~900 of them at once exhaust the
   pool (tarn "operation timed out") and starve heartbeats/autosaves too.

   This module puts submissions in a first-in-first-out line and lets only
   `concurrency` of them touch the database at a time (default 5 — a tenth
   of the default 50-connection pool, so heartbeats, autosaves and the admin
   portal always keep connections).

   • One line PER POOL (= per tenant database); schools never wait on each
     other.
   • The same student+exam already queued or running is NOT queued again —
     the second caller just waits for the first one's result. This is what
     stops the client's "reconnecting…" retries from stacking duplicates.
   • A caller waits at most `maxWaitMs` for its turn (default 45 s). Past that,
     or when the line is longer than `maxQueue`, it gets a QUEUE_BUSY error
     the controller turns into a 503 the browser retries. Nothing is lost:
     the student's answers are still in their browser and in the autosave.
   • Background work (the server's own auto-submit sweep) can pass
     maxWaitMs: Infinity; it waits its turn but never gives up.

   Env (all optional):
     SUBMIT_CONCURRENCY          simultaneous submissions per tenant   (5)
     SUBMIT_QUEUE_MAX            longest line before refusing           (5000)
     SUBMIT_QUEUE_MAX_WAIT_MS    longest a student waits for a turn     (45000)
========================================================================= */

const intEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

class QueueBusyError extends Error {
  constructor(reason, retryAfterSec) {
    super(
      reason === "full"
        ? "Submission line is full"
        : "Timed out waiting for a submission slot"
    );
    this.name = "QueueBusyError";
    this.code = "QUEUE_BUSY";
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

class SubmitQueue {
  constructor(opts = {}) {
    this.concurrency = opts.concurrency || intEnv("SUBMIT_CONCURRENCY", 5);
    this.maxQueue = opts.maxQueue || intEnv("SUBMIT_QUEUE_MAX", 5000);
    this.maxWaitMs = opts.maxWaitMs || intEnv("SUBMIT_QUEUE_MAX_WAIT_MS", 45000);
    this.running = 0;
    this.waiting = []; // FIFO of { start, timer, cancelled }
    this.inflight = new Map(); // dedupe key -> Promise
    this.avgMs = 400; // moving average of one submission, to suggest a retry delay
  }

  get depth() {
    return this.waiting.length;
  }

  /* A realistic "try again in N seconds" for a refused caller. */
  _retryAfterSec() {
    const estimate = Math.ceil(((this.waiting.length + 1) * this.avgMs) / this.concurrency / 1000);
    return Math.min(30, Math.max(3, estimate));
  }

  _drain() {
    while (this.running < this.concurrency && this.waiting.length) {
      const next = this.waiting.shift();
      if (next.cancelled) continue;
      if (next.timer) clearTimeout(next.timer);
      this.running++;
      next.start();
    }
  }

  /**
   * Run `fn` when a slot is free.
   * @param {string|null} key   dedupe key (e.g. "12:345"); same key in flight → shared result
   * @param {() => Promise<any>} fn
   * @param {{ maxWaitMs?: number }} [o]
   */
  run(key, fn, o = {}) {
    if (key && this.inflight.has(key)) return this.inflight.get(key);

    const maxWaitMs = o.maxWaitMs ?? this.maxWaitMs;
    const p = new Promise((resolve, reject) => {
      const startRunning = () => {
        const t0 = Date.now();
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            // exponential moving average, so the Retry-After hint tracks reality
            this.avgMs = Math.round(this.avgMs * 0.8 + (Date.now() - t0) * 0.2);
            this.running--;
            this._drain();
          });
      };

      // Free slot and nobody ahead of us: go straight in.
      if (this.running < this.concurrency && !this.waiting.length) {
        this.running++;
        startRunning();
        return;
      }

      if (this.waiting.length >= this.maxQueue) {
        reject(new QueueBusyError("full", this._retryAfterSec()));
        return;
      }

      const entry = { start: startRunning, timer: null, cancelled: false };
      if (Number.isFinite(maxWaitMs)) {
        entry.timer = setTimeout(() => {
          entry.cancelled = true; // _drain will skip it
          const i = this.waiting.indexOf(entry);
          if (i !== -1) this.waiting.splice(i, 1);
          reject(new QueueBusyError("timeout", this._retryAfterSec()));
        }, maxWaitMs);
        if (entry.timer.unref) entry.timer.unref();
      }
      this.waiting.push(entry);
    });

    if (key) {
      this.inflight.set(key, p);
      const clear = () => { if (this.inflight.get(key) === p) this.inflight.delete(key); };
      p.then(clear, clear);
    }
    return p;
  }
}

/* One queue per pool object (= per tenant DB). WeakMap so test/mock pools are
   garbage-collected and never share a line. */
const queues = new WeakMap();
function queueFor(pool) {
  const keyObj = pool && typeof pool === "object" ? pool : queueFor;
  let q = queues.get(keyObj);
  if (!q) {
    q = new SubmitQueue();
    queues.set(keyObj, q);
  }
  return q;
}

const isQueueBusy = (err) => !!err && err.code === "QUEUE_BUSY";

module.exports = { SubmitQueue, QueueBusyError, queueFor, isQueueBusy };
