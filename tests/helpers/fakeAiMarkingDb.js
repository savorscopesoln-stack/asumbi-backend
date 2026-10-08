/* =========================================================================
   FAKE mssql FOR THE AI-MARKING LEDGER

   Closes the harness gap documented in HANDOFF_NOTES_PHASE5_WALLET_AUDIT.md
   §3 (tests/helpers/mockPool.js can't fake `new sql.Transaction(pool)`),
   but ONLY for services/aiMarkingLedger.service.js — it is a purpose-built
   in-memory model of the five statements-shapes that service issues, not a
   general T-SQL engine.

   WHAT IT FAITHFULLY MODELS (so tests mean something):
   - Row lock: a `WITH (UPDLOCK, HOLDLOCK)` wallet read blocks until the
     holding transaction commits or rolls back (per-wallet FIFO mutex).
   - Lock discipline: UPDATE on a wallet WITHOUT holding its lock throws —
     so a code path that forgot to lock fails loudly in tests.
   - Rollback: every write is recorded in an undo log and reversed.
   - Unique filtered indexes on ledger.idempotency_key and
     ledger.reverses_ledger_id, raising SQL Server error 2627.
   - Interleaving: every statement yields to the event loop, so concurrent
     requests genuinely interleave instead of running back-to-back.

   WHAT IT DOES NOT PROVE: that the SQL text is valid T-SQL, that real
   locking/isolation behaves identically, or anything about triggers. Those
   still need one run against a real (disposable) SQL Server — see
   PHASE1_AI_MARKING_AUDIT.md §8.
========================================================================= */

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createFakeDb() {
  const state = {
    wallets: new Map(),   // id -> row
    ledger: [],           // rows, append-only
    nextLedgerId: 1,
    skipNextKeyLookup: false, // simulate the multi-process race window (see test)
    queryLog: [],
    audit: [],            // finance_audit_log rows
    pricing: null,        // row returned by getActivePricing (null = none configured)
    extra: [],            // extra query handlers (Phase 4 jobs/evaluations), tried first
  };
  const locks = new Map(); // walletId -> { holder, queue: [] }

  function addWallet(row) {
    const wallet = {
      id: row.id, owner_type: row.owner_type || "institution", owner_id: row.owner_id ?? null,
      available_balance: row.available_balance ?? 0, reserved_balance: row.reserved_balance ?? 0,
      currency: "KES", updatedAt: new Date(),
    };
    state.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async function acquire(walletId, tx) {
    let l = locks.get(walletId);
    if (!l) { l = { holder: null, queue: [] }; locks.set(walletId, l); }
    if (l.holder === tx) return;
    if (!l.holder) { l.holder = tx; tx.held.add(walletId); return; }
    await new Promise((resolve) => l.queue.push(() => { l.holder = tx; tx.held.add(walletId); resolve(); }));
  }
  function releaseAll(tx) {
    for (const walletId of tx.held) {
      const l = locks.get(walletId);
      l.holder = null;
      const next = l.queue.shift();
      if (next) next();
    }
    tx.held.clear();
  }

  function uniqueError(index) {
    const err = new Error(`Violation of UNIQUE KEY constraint ${index}. Cannot insert duplicate key.`);
    err.number = 2627;
    return err;
  }

  const sql = {
    Int: "Int", Bit: "Bit", DateTime: "DateTime", MAX: "MAX",
    NVarChar: () => "NVarChar", Decimal: () => "Decimal",
    Transaction: class {
      constructor(pool) { this.pool = pool; this.held = new Set(); this.undo = []; this.active = false; this.after = []; }
      async begin() { await tick(); this.active = true; }
      async commit() { await tick(); if (!this.active) throw new Error("Transaction has not begun"); this.active = false; this.undo = []; releaseAll(this); this.after.splice(0).forEach((f) => f()); }
      async rollback() {
        await tick();
        if (!this.active) { const e = new Error("Transaction has not begun"); e.code = "ENOTBEGUN"; throw e; }
        this.active = false;
        while (this.undo.length) this.undo.pop()();
        releaseAll(this);
        this.after.splice(0).forEach((f) => f());
      }
    },
    Request: class {
      constructor(parent) { this.tx = parent instanceof sql.Transaction ? parent : null; this.inputs = {}; }
      input(name, _type, value) { this.inputs[name] = value; return this; }
      async query(text) {
        await tick();
        const q = text.replace(/\s+/g, " ").trim();
        state.queryLog.push(q);
        const i = this.inputs;
        const tx = this.tx;

        // --- extension handlers (e.g. jobs/evaluations); first non-undefined result wins
        for (const handler of state.extra) {
          const out = await handler(q, i, tx, state);
          if (out !== undefined) return out;
        }

        // --- wallet lock read
        if (q.includes("FROM ai_marking_wallets WITH (UPDLOCK, HOLDLOCK)")) {
          if (!tx) throw new Error("UPDLOCK read outside a transaction");
          await acquire(i.id, tx);
          const w = state.wallets.get(i.id);
          return { recordset: w ? [{ ...w }] : [] };
        }
        // --- the institution singleton (controller path)
        if (q.includes("FROM ai_marking_wallets WHERE owner_type = 'institution'")) {
          const w = [...state.wallets.values()].find((x) => x.owner_type === "institution");
          return { recordset: w ? [{ ...w }] : [] };
        }
        // --- finance audit log (best-effort writer used by the controller)
        if (q.startsWith("INSERT INTO finance_audit_log")) {
          state.audit.push({ action: i.action, actorId: i.actorId, actorRole: i.actorRole, details: i.details ? JSON.parse(i.details) : null });
          return { recordset: [] };
        }
        // --- active pricing (null unless a test sets state.pricing)
        if (q.includes("FROM ai_marking_pricing")) return { recordset: state.pricing ? [{ ...state.pricing }] : [] };
        // --- wallet snapshot (display)
        if (q.includes("FROM ai_marking_wallets WHERE id = @id")) {
          const w = state.wallets.get(i.id);
          return { recordset: w ? [{ ...w }] : [] };
        }
        // --- wallet update
        if (q.startsWith("UPDATE ai_marking_wallets SET")) {
          const l = locks.get(i.id);
          if (!tx || !l || l.holder !== tx) throw new Error(`LOCK DISCIPLINE VIOLATION: wallet ${i.id} updated without holding its row lock`);
          const w = state.wallets.get(i.id);
          const prev = { available_balance: w.available_balance, reserved_balance: w.reserved_balance };
          if ("available" in i) w.available_balance = Number(i.available);
          if ("reserved" in i) w.reserved_balance = Number(i.reserved);
          tx.undo.push(() => Object.assign(w, prev));
          return { recordset: [] };
        }
        // --- ledger: lookup by idempotency key
        if (q.includes("FROM ai_marking_ledger WHERE idempotency_key = @key")) {
          if (state.skipNextKeyLookup) { state.skipNextKeyLookup = false; return { recordset: [] }; }
          const r = state.ledger.find((x) => x.idempotency_key === i.key);
          return { recordset: r ? [{ ...r }] : [] };
        }
        // --- ledger: insert
        if (q.startsWith("INSERT INTO ai_marking_ledger")) {
          if (!tx) throw new Error("ledger INSERT outside a transaction");
          if (i.idempotencyKey != null && state.ledger.some((x) => x.idempotency_key === i.idempotencyKey)) throw uniqueError("UQ_ai_marking_ledger_idempotency_key");
          if (i.reversesLedgerId != null && state.ledger.some((x) => x.reverses_ledger_id === i.reversesLedgerId)) throw uniqueError("UQ_ai_marking_ledger_reverses");
          if (!["topup", "reserve", "release", "consume", "reverse"].includes(i.entryType)) throw new Error("CHECK constraint entry_type violated");
          const row = {
            id: state.nextLedgerId++, wallet_id: i.walletId, entry_type: i.entryType,
            amount_delta: Number(i.amountDelta), reserved_delta: Number(i.reservedDelta),
            available_after: Number(i.availableAfter), reserved_after: Number(i.reservedAfter),
            ai_marking_job_id: i.aiMarkingJobId, finance_reference: i.financeReference,
            reverses_ledger_id: i.reversesLedgerId, actor_id: i.actorId, actor_role: i.actorRole,
            reason: i.reason, idempotency_key: i.idempotencyKey, createdAt: new Date(),
          };
          state.ledger.push(row);
          tx.undo.push(() => { state.ledger.splice(state.ledger.indexOf(row), 1); });
          return { recordset: [{ ...row }] };
        }
        // --- ledger: per-job outstanding
        if (q.includes("FROM ai_marking_ledger WHERE ai_marking_job_id = @jobId AND wallet_id = @walletId")) {
          const rows = state.ledger.filter((x) => x.ai_marking_job_id === i.jobId && x.wallet_id === i.walletId);
          return { recordset: [{
            reserve_rows: rows.filter((x) => x.entry_type === "reserve").length,
            outstanding: rows.reduce((s, x) => s + x.reserved_delta, 0),
          }] };
        }
        // --- ledger: by id / reversal lookup
        if (q.includes("FROM ai_marking_ledger WHERE id = @id")) {
          const r = state.ledger.find((x) => x.id === i.id);
          return { recordset: r ? [{ ...r }] : [] };
        }
        if (q.includes("FROM ai_marking_ledger WHERE reverses_ledger_id = @id")) {
          const r = state.ledger.find((x) => x.reverses_ledger_id === i.id);
          return { recordset: r ? [{ id: r.id }] : [] };
        }
        // --- reconciliation sums
        if (q.includes("SUM(amount_delta)") && q.includes("FROM ai_marking_ledger WHERE wallet_id = @walletId")) {
          const rows = state.ledger.filter((x) => x.wallet_id === i.walletId);
          return { recordset: [{
            available_sum: rows.reduce((s, x) => s + x.amount_delta, 0),
            reserved_sum: rows.reduce((s, x) => s + x.reserved_delta, 0),
          }] };
        }
        throw new Error(`fakeAiMarkingDb: unhandled query shape: ${q.slice(0, 120)}`);
      }
    },
  };

  const pool = { request: () => new sql.Request(pool) };
  return { sql, pool, state, addWallet };
}

/**
 * Load services/aiMarkingLedger.service.js with `require("mssql")` bound to
 * a fresh fake. The service's own code is unmodified.
 */
function loadLedgerService() {
  const Module = require("module");
  const path = require("path");
  const servicePath = path.resolve(__dirname, "../../services/aiMarkingLedger.service.js");
  const fake = createFakeDb();

  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, ...rest) {
    if (request === "mssql" && parent && parent.filename === servicePath) return fake.sql;
    return originalLoad.call(this, request, parent, ...rest);
  };
  let service;
  try { service = require(servicePath); } finally { Module._load = originalLoad; }
  return { service, ...fake };
}

module.exports = { createFakeDb, loadLedgerService };
