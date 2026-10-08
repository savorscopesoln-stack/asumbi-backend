/* =========================================================================
   AI MARKING — SCHEMA UPGRADES (applied after the base tables created in
   utils/ensureSchema.js, migration 2026-09-30_add_ai_marking_wallet.sql).

   Everything here is additive and idempotent: ADD COLUMN only if absent,
   CREATE TABLE/INDEX only if absent, triggers only if absent. Nothing
   drops or rewrites existing data. Mirrors migrations/
   2026-10-04_ai_marking_phase2_fixes.sql, which is the human-readable
   reference copy (this file is what actually runs on boot).

   WHAT EACH BLOCK FIXES (see PHASE1_AI_MARKING_AUDIT.md §6):

   1. ai_marking_ledger.reserved_delta — every ledger row now records
      BOTH balance movements (available via amount_delta, reserved via
      reserved_delta), so SUM() of each column reconciles to the wallet's
      available_balance / reserved_balance, and a "consume" row carries
      the consumed amount structurally instead of only in free text.
   2. ai_marking_ledger.reverses_ledger_id (+ unique index) — a ledger
      entry can be reversed at most once, enforced by the database.
   3. Append-only triggers on ai_marking_ledger, ai_marking_pricing and
      ai_marking_adjustments — "immutable" was a convention; now UPDATE
      and DELETE are rejected by the database itself.
   4. ai_marking_pricing.plan_code — "applicable tenant or pricing plan".
      (Tenant scoping is inherent: this table lives in the tenant's own
      database.)
   5. Worker/operational columns on jobs and evaluations (attempts, last
      error, lease, cancel flag, provider batch id) so Phase 6 doesn't
      need to alter these tables again.
   6. ai_marking_evaluations.review_state + scheme_version_id, and a
      CHECK that teacher_final_mark is a WHOLE number within
      [0, max_marks] — see Decision D1 in the audit: the authoritative
      e_assessment_answers.marks_awarded column is INT, so a final mark
      that could not be stored there must not be representable here.
   7. ai_marking_scheme_versions — the existing marking_guide is free
      text with no criterion structure (audit §3); AI marking needs
      versioned, teacher-approved structured criteria.
   8. ai_marking_adjustments — append-only log of every teacher action on
      an AI evaluation.

   9. PHASE 4 (job creation + billing) additions:
      a. ai_marking_evaluations.suggested_total / model / prompt_version
         become NULLable. A job CLAIMS answers at confirm time, before any
         model has run; NOT NULL would have forced a fake 0 mark onto an
         unmarked answer ("never silently convert a failed evaluation into
         zero marks"). NULL = "no suggestion yet". The marks-bounds CHECK
         passes for NULL, so a real suggestion is still bounded.
      b. evaluation status gains 'cancelled' (claimed, never processed,
         never charged).
      c. UQ_ai_marking_evaluations_live_answer — at most ONE live
         (pending/success/needs_review, not superseded) evaluation per
         (submission, question) across ALL jobs. The database backstop that
         makes claiming atomic when two teachers or two clicks race; the
         per-job unique index alone could not.

  10. PHASE 8 (marking schemes): ai_marking_scheme_versions.change_note (the
      teacher's reason for a revision) and .approval_notes (JSON: which
      warnings were acknowledged, the lint result and a hash of the question
      at approval). Additive, nullable; criteria_json keeps its documented
      array shape so nothing that reads it changes.

   NOT included on purpose: calibration tables (Phase 9). They are purely
   additive and belong with the workflow that uses them.
========================================================================= */

const APPEND_ONLY_MESSAGE =
  "append-only table: UPDATE and DELETE are not allowed, use a compensating entry instead";

function triggerSql(triggerName, tableName) {
  // CREATE TRIGGER must be the first statement in its batch, hence EXEC().
  const body = `
    CREATE TRIGGER ${triggerName} ON ${tableName}
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
      THROW 51000, '${tableName} is ${APPEND_ONLY_MESSAGE}', 1;
    END
  `;
  return `
    IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = '${triggerName}')
    AND EXISTS (SELECT * FROM sysobjects WHERE name='${tableName}' AND xtype='U')
    EXEC('${body.replace(/'/g, "''")}')
  `;
}

/** Wrap DDL in an explicit transaction with rollback-and-rethrow, so a failure part-way never leaves a half-altered table. */
function wrapTx(body) {
  return `
      BEGIN TRY
        BEGIN TRANSACTION;
        ${body.trim()}
        COMMIT TRANSACTION;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH`;
}

function addColumnSql(table, column, definition) {
  return `
    IF EXISTS (SELECT * FROM sysobjects WHERE name='${table}' AND xtype='U')
    AND NOT EXISTS (
      SELECT * FROM sys.columns WHERE Name = N'${column}' AND Object_ID = Object_ID(N'${table}')
    )
    ALTER TABLE ${table} ADD ${column} ${definition}
  `;
}

function addIndexSql(name, table, createStatement) {
  return `
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = '${name}')
    AND EXISTS (SELECT * FROM sysobjects WHERE name='${table}' AND xtype='U')
    ${createStatement}
  `;
}

/** The ordered list of statements — exported so tests can assert on it and the migration file can't silently drift from it. */
function buildStatements() {
  const stmts = [];

  /* ---- ledger: dual balance movement + at-most-once reversal ---- */
  stmts.push(addColumnSql("ai_marking_ledger", "reserved_delta", "DECIMAL(18,4) NOT NULL DEFAULT 0"));
  stmts.push(addColumnSql("ai_marking_ledger", "reverses_ledger_id", "INT NULL"));
  // One-time backfill for rows written before reserved_delta existed. Only
  // runs while the immutability trigger is not yet installed (afterwards
  // UPDATE is forbidden, and by then every new row sets reserved_delta).
  stmts.push(`
    IF NOT EXISTS (SELECT * FROM sys.triggers WHERE name = 'TR_ai_marking_ledger_append_only')
    AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'reserved_delta' AND Object_ID = Object_ID(N'ai_marking_ledger'))
    EXEC('UPDATE ai_marking_ledger
          SET reserved_delta = CASE WHEN entry_type IN (''reserve'',''release'') THEN -amount_delta ELSE 0 END
          WHERE reserved_delta = 0 AND entry_type IN (''reserve'',''release'') AND amount_delta <> 0')
  `);
  stmts.push(addIndexSql(
    "UQ_ai_marking_ledger_reverses", "ai_marking_ledger",
    `EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_ledger_reverses
           ON ai_marking_ledger(reverses_ledger_id) WHERE reverses_ledger_id IS NOT NULL')`
  ));

  /* ---- pricing: plan scoping ---- */
  stmts.push(addColumnSql("ai_marking_pricing", "plan_code", "NVARCHAR(50) NULL"));

  /* ---- jobs: worker/operational state ---- */
  stmts.push(addColumnSql("ai_marking_jobs", "attempt_count", "INT NOT NULL DEFAULT 0"));
  stmts.push(addColumnSql("ai_marking_jobs", "last_error", "NVARCHAR(1000) NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "locked_by", "NVARCHAR(100) NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "locked_until", "DATETIME NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "provider_batch_id", "NVARCHAR(100) NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "started_at", "DATETIME NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "cancel_requested", "BIT NOT NULL DEFAULT 0"));

  /* ---- scheme versions (before evaluations reference them) ---- */
  stmts.push(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
    CREATE TABLE ai_marking_scheme_versions (
      id INT IDENTITY(1,1) PRIMARY KEY,
      question_id INT NOT NULL,                 -- e_assessment_questions.id (no FK: table not tracked in migrations, see audit §2)
      version_no INT NOT NULL,
      criteria_json NVARCHAR(MAX) NOT NULL,     -- [{criterionId,label,maxMarks,expectedPoints[],acceptableAlternatives[]}]
      max_marks DECIMAL(6,2) NOT NULL,
      source_guide_hash CHAR(64) NULL,          -- SHA-256 of the free-text marking_guide this version was derived from
      status NVARCHAR(20) NOT NULL DEFAULT 'draft',
      created_by INT NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT GETDATE(),
      CONSTRAINT CK_ai_marking_scheme_versions_status CHECK (status IN ('draft','approved','superseded')),
      CONSTRAINT CK_ai_marking_scheme_versions_approved CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
      CONSTRAINT CK_ai_marking_scheme_versions_max CHECK (max_marks > 0)
    )
  `);
  stmts.push(addIndexSql(
    "UQ_ai_marking_scheme_versions_question_version", "ai_marking_scheme_versions",
    `EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_scheme_versions_question_version
           ON ai_marking_scheme_versions(question_id, version_no)')`
  ));
  // At most one APPROVED (i.e. usable) version per question at any time.
  stmts.push(addIndexSql(
    "UQ_ai_marking_scheme_versions_one_approved", "ai_marking_scheme_versions",
    `EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_scheme_versions_one_approved
           ON ai_marking_scheme_versions(question_id) WHERE status = ''approved''')`
  ));

  /* ---- PHASE 8: why a scheme version exists, and what the teacher acknowledged when approving it ---- */
  stmts.push(addColumnSql("ai_marking_scheme_versions", "change_note", "NVARCHAR(500) NULL"));
  stmts.push(addColumnSql("ai_marking_scheme_versions", "approval_notes", "NVARCHAR(MAX) NULL"));

  /* ---- evaluations: review state, scheme link, worker columns, whole-mark rule ---- */
  stmts.push(addColumnSql("ai_marking_evaluations", "scheme_version_id", "INT NULL"));
  stmts.push(addColumnSql("ai_marking_evaluations", "attempt_count", "INT NOT NULL DEFAULT 0"));
  stmts.push(addColumnSql("ai_marking_evaluations", "last_error", "NVARCHAR(1000) NULL"));
  stmts.push(addColumnSql("ai_marking_evaluations", "completed_at", "DATETIME NULL"));
  stmts.push(addColumnSql(
    "ai_marking_evaluations", "review_state",
    `NVARCHAR(20) NOT NULL CONSTRAINT DF_ai_marking_evaluations_review_state DEFAULT 'awaiting_review'`
  ));
  stmts.push(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'review_state' AND Object_ID = Object_ID(N'ai_marking_evaluations'))
    AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_review_state')
    EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_review_state
          CHECK (review_state IN (''awaiting_review'',''approved'',''adjusted'',''rejected'',''superseded''))')
  `);
  stmts.push(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_final_whole')
    EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_final_whole
          CHECK (teacher_final_mark IS NULL OR (teacher_final_mark = ROUND(teacher_final_mark, 0)
                 AND teacher_final_mark >= 0 AND teacher_final_mark <= max_marks))')
  `);
  stmts.push(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_scheme_versions' AND xtype='U')
    AND EXISTS (SELECT * FROM sys.columns WHERE Name = N'scheme_version_id' AND Object_ID = Object_ID(N'ai_marking_evaluations'))
    AND NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE name = 'FK_ai_marking_evaluations_scheme_version')
    EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT FK_ai_marking_evaluations_scheme_version
          FOREIGN KEY (scheme_version_id) REFERENCES ai_marking_scheme_versions(id)')
  `);
  stmts.push(addIndexSql(
    "IX_ai_marking_evaluations_review_state", "ai_marking_evaluations",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_review_state
           ON ai_marking_evaluations(review_state, status)')`
  ));
  stmts.push(addIndexSql(
    "IX_ai_marking_evaluations_answer", "ai_marking_evaluations",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_answer
           ON ai_marking_evaluations(submission_id, question_id)')`
  ));

  /* ---- teacher adjustment log ---- */
  stmts.push(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_adjustments' AND xtype='U')
    AND EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    CREATE TABLE ai_marking_adjustments (
      id INT IDENTITY(1,1) PRIMARY KEY,
      evaluation_id INT NOT NULL,
      action NVARCHAR(30) NOT NULL,
      before_json NVARCHAR(MAX) NULL,
      after_json NVARCHAR(MAX) NULL,
      final_mark DECIMAL(6,2) NULL,
      reason NVARCHAR(500) NULL,
      actor_id INT NOT NULL,
      actor_role NVARCHAR(30) NULL,
      createdAt DATETIME NOT NULL DEFAULT GETDATE(),
      CONSTRAINT CK_ai_marking_adjustments_action CHECK (action IN
        ('accept','adjust','reject','mark_manually','request_reevaluation','flag_scheme')),
      CONSTRAINT FK_ai_marking_adjustments_evaluation FOREIGN KEY (evaluation_id) REFERENCES ai_marking_evaluations(id)
    )
  `);
  stmts.push(addIndexSql(
    "IX_ai_marking_adjustments_evaluation", "ai_marking_adjustments",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_adjustments_evaluation ON ai_marking_adjustments(evaluation_id)')`
  ));

  /* ---- PHASE 4: claimable evaluation rows + cross-job uniqueness ---- */
  // NOT NULL -> NULL for the three columns that only exist after a model has run.
  // The marks-bounds CHECK references suggested_total, so drop it, alter, and
  // re-add it (next statement) inside one transaction; guarded so it runs once.
  stmts.push(`
    IF EXISTS (SELECT * FROM sys.columns WHERE Name = N'suggested_total' AND Object_ID = Object_ID(N'ai_marking_evaluations') AND is_nullable = 0)
    EXEC('${wrapTx(`
      IF EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_marks_bounds')
        ALTER TABLE ai_marking_evaluations DROP CONSTRAINT CK_ai_marking_evaluations_marks_bounds;
      ALTER TABLE ai_marking_evaluations ALTER COLUMN suggested_total DECIMAL(6,2) NULL;
      ALTER TABLE ai_marking_evaluations ALTER COLUMN model NVARCHAR(100) NULL;
      ALTER TABLE ai_marking_evaluations ALTER COLUMN prompt_version NVARCHAR(30) NULL;
    `).replace(/'/g, "''")}')
  `);
  stmts.push(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_marks_bounds')
    EXEC('ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_marks_bounds
          CHECK (suggested_total IS NULL OR (suggested_total >= 0 AND suggested_total <= max_marks))')
  `);
  // Status set gains 'cancelled'. Replace the CHECK only if it does not already allow it.
  stmts.push(`
    IF EXISTS (SELECT * FROM sysobjects WHERE name='ai_marking_evaluations' AND xtype='U')
    AND NOT EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_status' AND definition LIKE '%cancelled%')
    EXEC('${wrapTx(`
      IF EXISTS (SELECT * FROM sys.check_constraints WHERE name = 'CK_ai_marking_evaluations_status')
        ALTER TABLE ai_marking_evaluations DROP CONSTRAINT CK_ai_marking_evaluations_status;
      ALTER TABLE ai_marking_evaluations ADD CONSTRAINT CK_ai_marking_evaluations_status
        CHECK (status IN ('pending','success','failed','needs_review','cancelled'));
    `).replace(/'/g, "''")}')
  `);
  stmts.push(addIndexSql(
    "UQ_ai_marking_evaluations_live_answer", "ai_marking_evaluations",
    `EXEC('CREATE UNIQUE NONCLUSTERED INDEX UQ_ai_marking_evaluations_live_answer
           ON ai_marking_evaluations(submission_id, question_id)
           WHERE status IN (''pending'',''success'',''needs_review'') AND review_state <> ''superseded''')`
  ));
  stmts.push(addIndexSql(
    "IX_ai_marking_jobs_status_created", "ai_marking_jobs",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_jobs_status_created ON ai_marking_jobs(status, createdAt)')`
  ));

  /* ---- PHASE 6: background worker state ---- */
  // Per-answer lease + backoff in ONE column: a claim sets it to "now + lease",
  // a retryable failure sets it to "now + backoff". The claim query only picks
  // rows whose next_attempt_at is NULL or in the past, so an answer whose worker
  // died becomes claimable again by itself when the lease runs out.
  stmts.push(addColumnSql("ai_marking_evaluations", "next_attempt_at", "DATETIME NULL"));
  // Set when an identical answer (same question, answer hash, scheme version,
  // prompt version, model) already has a usable evaluation in this tenant DB and
  // it was copied instead of calling the provider again.
  stmts.push(addColumnSql("ai_marking_evaluations", "reused_from_evaluation_id", "INT NULL"));
  // Time-bound, escalating job pause for systemic provider problems.
  stmts.push(addColumnSql("ai_marking_jobs", "paused_until", "DATETIME NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "pause_reason", "NVARCHAR(200) NULL"));
  stmts.push(addColumnSql("ai_marking_jobs", "pause_count", "INT NOT NULL DEFAULT 0"));
  stmts.push(addIndexSql(
    "IX_ai_marking_evaluations_work", "ai_marking_evaluations",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_work
           ON ai_marking_evaluations(ai_marking_job_id, status, next_attempt_at)')`
  ));
  stmts.push(addIndexSql(
    "IX_ai_marking_evaluations_reuse", "ai_marking_evaluations",
    `EXEC('CREATE NONCLUSTERED INDEX IX_ai_marking_evaluations_reuse
           ON ai_marking_evaluations(question_id, answer_content_hash, scheme_version_id)')`
  ));

  /* ---- append-only enforcement (LAST: the backfill above needs UPDATE) ---- */
  stmts.push(triggerSql("TR_ai_marking_ledger_append_only", "ai_marking_ledger"));
  stmts.push(triggerSql("TR_ai_marking_pricing_append_only", "ai_marking_pricing"));
  stmts.push(triggerSql("TR_ai_marking_adjustments_append_only", "ai_marking_adjustments"));

  return stmts;
}


const MIGRATION_HEADER = `-- AI-assisted marking — Phase 2 fixes + Phase 4 job/billing columns + Phase 6 worker columns (additive; safe on a live database).
-- GENERATED from utils/aiMarkingSchema.js by scripts/generateAiMarkingMigration.js
-- — do not hand-edit; change the JS and regenerate. The JS is what actually
-- runs on server boot (ensureSchema.js); this file is for manual/reference use.
--
-- Fixes (see PHASE1_AI_MARKING_AUDIT.md section 6): ledger reserved_delta +
-- reverses_ledger_id, append-only triggers (ledger, pricing, adjustments),
-- pricing.plan_code, worker columns on jobs/evaluations, evaluations
-- review_state + whole-number final-mark CHECK + scheme-version link,
-- ai_marking_scheme_versions, ai_marking_adjustments.
-- Phase 4: evaluations.suggested_total/model/prompt_version become NULLable,
-- status gains 'cancelled', UQ_ai_marking_evaluations_live_answer (one live
-- evaluation per answer across all jobs), IX_ai_marking_jobs_status_created.
-- Phase 6: evaluations.next_attempt_at (per-answer lease + backoff) and
-- reused_from_evaluation_id; jobs.paused_until / pause_reason / pause_count;
-- IX_ai_marking_evaluations_work and IX_ai_marking_evaluations_reuse.
-- (The file keeps its original name; it is regenerated, not versioned.)
--
-- ROLLBACK (manual, only while the new tables/columns hold no real data —
-- once they do, use compensating entries instead):
--   DROP TRIGGER TR_ai_marking_adjustments_append_only;
--   DROP TRIGGER TR_ai_marking_pricing_append_only;
--   DROP TRIGGER TR_ai_marking_ledger_append_only;
--   -- then drop the new tables/constraints/columns in reverse order of creation.
`;

/** The reference .sql file's exact text (statements separated by GO). */
function buildMigrationText() {
  const body = buildStatements()
    .map((s) => s.split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n").trim())
    .join("\nGO\n\n");
  return `${MIGRATION_HEADER}\n${body}\nGO\n`;
}

/**
 * Apply every upgrade. Each statement runs on its own so one failure is
 * reported precisely (and the rest still run); returns the failures so a
 * caller/test can inspect them. Never throws — same stance as the rest of
 * ensureSchema: a schema hiccup must not stop the server booting.
 */
async function ensureAiMarkingSchemaUpgrades(pool) {
  const failures = [];
  const statements = buildStatements();
  for (let i = 0; i < statements.length; i += 1) {
    try {
      await pool.request().query(statements[i]);
    } catch (err) {
      failures.push({ index: i, message: err.message });
      console.error(`⚠️  AI marking schema upgrade #${i} failed:`, err.message);
    }
  }
  return failures;
}

module.exports = { ensureAiMarkingSchemaUpgrades, buildStatements, buildMigrationText, APPEND_ONLY_MESSAGE };
