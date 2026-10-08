# Main Examination — Phase 15 test suite

Run with:

```
npm test
```

(or `node tests/run-all.js` directly).

## What this suite is

39 automated tests covering the scenarios in the original spec's §56
("Testing") for everything built in Phases 2–14: Main Examination CRUD,
subject scheduling + timetable validation, the automatic activation/end
scheduler, the student-facing dashboard/timetable, Excel/PDF report
export, and the Phase 6 backward-compatibility guard on the existing
manual Start/Stop toggle.

**No live SQL Server is reachable from the environment these were
written in.** Every test runs the real controller/utility code —
unmodified, the same files `server.js` loads — against a mocked
`mssql`-shaped pool (`tests/helpers/mockPool.js`) that returns canned
recordsets keyed by a substring of the query text. This verifies real
logic, real query shapes, and real response behavior faithfully. It does
**not** verify actual SQL syntax against a real SQL Server, actual
index usage, actual concurrent-request behavior, or anything visual.

No new test framework was installed — `tests/helpers/tinytest.js` is a
~40-line wrapper around Node's built-in `assert`, in keeping with this
project not having a test runner already. `jszip` (added in Phase
12–13) is the only new dependency touched by this suite.

## Known gap: this suite does not validate raw SQL syntax

Every test here mocks the query *transport*, not the database — a query
string gets matched by substring and handed a canned recordset. That
means a query that is syntactically **invalid T-SQL** but otherwise
well-formed JavaScript will pass every test in this directory and still
fail the moment it hits a real SQL Server.

This isn't hypothetical: `mainExamAnalytics.controller.js`'s median
calculation used `PERCENTILE_CONT(...) WITHIN GROUP (...)` without the
`OVER()` clause SQL Server requires for it (most other databases don't
require this) — 40 passing mocked tests across 15 phases never caught
it, because none of them ever sent real SQL to a real server. It was
found from an actual server error log after Phase 15, fixed in both
places it occurred, and `regression.test.js` now has one cheap static
guard (`SQL guard: every PERCENTILE_CONT call...`) against this *exact*
mistake recurring — but that guard is a source-text regex, not a real
SQL parser, and won't catch a differently-shaped syntax error.

**The only real fix for this category of bug is what §56 always said:**
exercise every endpoint against a real SQL Server at least once. Treat
this suite as a fast first pass that catches logic/branching mistakes
cheaply, not as a substitute for that.

## What still needs a real environment before calling this feature done

Run these against a real staging database + a browser, in roughly this
order:

### 1. Schema
- [ ] Boot the server once against a fresh-ish staging DB and confirm
      `ensureSchema.js` creates `main_examinations`,
      `exam_subject_sessions`, `exam_audit_log` without error.
- [ ] Run `migrations/2026-09-18_add_main_exam_student_indexes.sql`
      manually and confirm all four indexes are created (it's
      guarded/idempotent — safe to run twice).

### 2. Main Examination + scheduling (Phases 3–4)
- [ ] Create a Main Examination via the real API, add 3–4 subjects,
      confirm the overlap/duplicate/date-range validation errors from
      `scheduling.test.js` reproduce with real HTTP requests + real SQL
      Server error handling (mssql sometimes surfaces constraint errors
      differently than plain query results).
- [ ] Publish the timetable; confirm subjects flip `draft → scheduled`
      and the Main Examination flips to `published` in the actual DB
      row, not just in the JSON response.

### 3. Automatic activation (Phase 5–6) — the one most worth doing for real
- [ ] Schedule a subject with `start_time` ~2 minutes in the future and
      `end_time` ~5 minutes after that, with an **approved** assessment
      attached.
- [ ] Watch server logs for `🟢 ... auto-activated` within one scheduler
      tick (up to 60s) of the start time, and confirm in the DB that
      `exam_subject_sessions.status` and `e_assessments.active_status`
      both flipped.
- [ ] Log in as a real student in that class/year and confirm the
      **existing** exam-entry flow now lets them start — this is the
      one seam where the new scheduler meets old, untouched code and
      the mocks in this suite can't prove the two actually agree on
      what `active_status` means at runtime.
- [ ] Wait past `end_time`; confirm `🔴 ... auto-ended`, confirm a
      student already mid-attempt is NOT kicked out and their existing
      timer/auto-submit behavior is unaffected.
- [ ] Re-try scheduling a subject whose assessment is still `pending`
      approval; confirm it's correctly held back every tick (watch for
      the `⚠️ ... holding, not activating` log line) until approved.

### 4. Backward compatibility (§54) — do this on a copy of production data if possible
- [ ] Confirm every existing CAT/Assignment still lists, opens, and
      grades exactly as before — this suite's `regression.test.js` only
      checks that the guarded function still exists and branches
      correctly against mocked data, not that nothing else in the
      2,600-line `eAssessment.controller.js` shifted behavior.
- [ ] Confirm the manual Start/Stop toggle still works normally for
      every assessment NOT attached to a Main Examination subject.
- [ ] Confirm existing student results/marks for old submissions are
      byte-for-byte unchanged.

### 5. Reports (Phase 11–13)
- [ ] Download one Excel and one PDF report of each of the 10 types
      against real data, open each in actual Excel/Word/Adobe Reader
      (not just LibreOffice/pypdf, which is all this suite validated
      against) — confirm frozen header rows show as frozen in real
      Excel, and the institution logo/header renders correctly with a
      real uploaded `SchoolSettings.logoUrl`.
- [ ] Generate a report for a genuinely large exam (a few hundred
      candidates) and confirm it doesn't time out — `mainExamExports.
      controller.js` builds these synchronously in-request (§57 flags
      async generation for large reports as a nice-to-have, not yet
      built).

### 6. Load (§58)
- [ ] The student dashboard/timetable endpoints (Phase 14) were
      designed to be 2–3 fixed queries per request — confirm that holds
      under a burst of concurrent student logins/dashboard loads, the
      same way the existing exam-login load test already covers.
- [ ] Confirm the scheduler's per-tenant tick doesn't measurably slow
      down under however many tenants + subjects exist in production.

### 7. Frontend
Nothing in Phases 2–15 touched `frontend/`. None of the tabs, charts,
timetable views, or the student's `[ENTER EXAM]` card exist as UI yet —
only the APIs they'll call.

## AI marking tests (added with the Phase 2 fixes)

`aiMarkingLedger.test.js`, `aiMarkingFinance.test.js` and
`aiMarkingSchemaFile.test.js` use `helpers/fakeAiMarkingDb.js` — an
in-memory model of mssql **with** `sql.Transaction` support (real row-lock
queueing, undo-log rollback, unique-index errors, statement interleaving;
it throws if a wallet is updated without its lock). It exists only for
`services/aiMarkingLedger.service.js`; it is not a T-SQL engine. Still
needs a real-SQL-Server pass for: DDL syntax, triggers, real isolation
behaviour. See `../PHASE1_AI_MARKING_AUDIT.md` §8.

## Phase 3 — teacher dashboard / preview (manual checklist)

`aiMarkingTeacher.test.js` asserts the query *text* and the quote logic; it cannot
execute T-SQL. On a disposable copy of one tenant DB, with a teacher who has
assigned submissions:

1. `SELECT DISTINCT question_type FROM e_assessment_questions` — confirm the essay value is in `ESSAY_TYPES` (default `['essay']`).
2. Call `GET /api/e-assessments/ai-marking/dashboard` and compare each tile with hand counts from `e_assessment_answers`.
3. Mark one answer by hand, release one submission, insert a blank (`''`) and a `<p><br></p>` answer: `POST .../preview` must drop all of them from `counts.billable`.
4. Insert an approved row in `ai_marking_scheme_versions` for one question: that question's answers move from `needsScheme` to `billable`.
5. Insert an evaluation with `status='success'` for one answer → it moves to `alreadyEvaluated`; change it to `'failed'` → it becomes billable again.
6. Log in as a teacher with NO assignments → every count is 0. Log in as teacher B → none of teacher A's submissions appear.
7. Time the preview on the largest tenant (target workload: ~312,500 answers). If slow, add an index on `e_assessment_answers(submission_id, question_id)` and re-check the plan.


## Phase 4 — confirm / reserve / cancel / settle (manual checklist)

`aiMarkingJobs.test.js` (38 tests) runs the real services against an in-memory
model with READ COMMITTED visibility, blocking unique indexes, wallet row locks
and rollback (`helpers/fakeAiMarkingJobs.js`). It proves the control flow and the
money arithmetic. It does **not** prove the T-SQL parses, that `HASHBYTES` on
`NVARCHAR(MAX)` is available (needs SQL Server 2016+), or that real locking behaves
like the model. On a **disposable copy of one tenant DB**, with
`AI_MARKING_JOBS_ENABLED=true`, a funded wallet, a price, and an approved row in
`ai_marking_scheme_versions` for at least one essay question:

1. Boot once, then confirm the schema step applied:
   `SELECT is_nullable FROM sys.columns WHERE object_id=OBJECT_ID('ai_marking_evaluations') AND name IN ('suggested_total','model','prompt_version')` -> all 1;
   `SELECT definition FROM sys.check_constraints WHERE name='CK_ai_marking_evaluations_status'` contains `cancelled`;
   `SELECT name, filter_definition FROM sys.indexes WHERE name='UQ_ai_marking_evaluations_live_answer'` exists;
   `SELECT name FROM sys.check_constraints WHERE name='CK_ai_marking_evaluations_marks_bounds'` exists. Any failed statement is logged as "AI marking schema upgrade #N failed".
2. `POST /preview` then `POST /jobs` with the returned `quoteFingerprint`, a fresh `idempotencyKey` and `confirm:true`. Expect 201, `status:"reserved"`, wallet `available` down and `reserved` up by exactly the quote; one `reserve` ledger row; N `pending` evaluation rows with `suggested_total IS NULL` and a 64-char lowercase `answer_content_hash`.
3. Repeat the identical request -> 200, `replayed:true`, no new rows. Fire it 10x in parallel (e.g. `xargs -P10`) -> exactly one job, one `reserve` row.
4. Confirm two *different* keys over the same selection in parallel -> one 201, one 409 `SELECTION_CONFLICT` (or `NOTHING_ELIGIBLE` if it ran second), never two claims on one answer. Check the unique index really fired: `SELECT submission_id, question_id, COUNT(*) FROM ai_marking_evaluations WHERE status IN ('pending','success','needs_review') GROUP BY submission_id, question_id HAVING COUNT(*)>1` returns no rows.
5. Mark one answer by hand between preview and confirm -> 409 `QUOTE_CHANGED` with the new numbers; no job, no evaluation rows, no ledger row left behind.
6. Drain the wallet below the quote -> 409 `INSUFFICIENT_CREDITS`; job `cancelled`, its evaluations `cancelled`; no ledger row; a later confirm under a new key works.
7. `POST /jobs/:id/cancel` on a reserved job -> `cancelled`, ledger shows `reserve`, `consume` (0), `release` (full), wallet back to its starting balance. Repeat the cancel -> no new rows.
8. Simulate a worker by hand: `UPDATE ai_marking_evaluations SET status='success' ...` for some rows, `'failed'` for others, then call `finalizeJob` from a node REPL. Expect charge = unit price x (success + needs_review), the rest released, `actual_total` equal to the ledger's consume amount. Call it twice more -> no new ledger rows.
9. `SELECT SUM(amount_delta), SUM(reserved_delta) FROM ai_marking_ledger WHERE wallet_id=@id` equals `available_balance`, `reserved_balance` after every step above (`reconcileWallet` does this).
10. Kill the process between step 2's commit and the reserve (e.g. attach a debugger/`process.exit` in `completeReservation`), then either replay the request or call `sweepStalledJobs(pool, {olderThanMinutes: 0})`: the job ends `reserved` (if the reserve landed) or `cancelled` with its claims freed.
11. Log in as teacher B and `GET /jobs/<teacher A's job id>` and `POST .../cancel` -> 404.
12. With `AI_MARKING_JOBS_ENABLED` unset, `POST /jobs` -> 503 `FEATURE_DISABLED` and nothing is written.
13. Time `POST /preview` and the pre-count on the largest tenant; a claim of `AI_MARKING_MAX_ANSWERS_PER_JOB` (default 5000) rows should be well under a second. If not, check the plan for the `e_assessment_answers` join.

## Phase 5 — marking engine (manual checklist)

`aiMarkingEngine.test.js` runs entirely offline against a scripted mock provider and a fake `fetch`. It proves
validation, redaction, flagging and error mapping. It cannot prove the live adapter or any model's accuracy.

1. Set `AI_MARKING_PROVIDER`, `AI_MARKING_API_KEY`, `AI_MARKING_MODEL` and the two `AI_MARKING_COST_*_PER_MTOK` prices
   (see the header of `services/aiMarkingEngine.config.js`). Never commit them.
2. Prepare 20-30 **anonymised** answers with criteria and your own marks (format in `scripts/aiMarkingEngineDryRun.js`),
   including short, long, off-topic, partially correct, blank-ish and one hostile ("ignore your instructions...") answer.
3. `node scripts/aiMarkingEngineDryRun.js samples.json`. Check: every answer returns or fails cleanly (no crash); the
   hostile answer is flagged; a wrong model id fails as `PROVIDER_BAD_REQUEST` with `systemic=true`; a wrong key as `PROVIDER_AUTH`.
4. Compare cost per answer with the price you intend to charge (Phase 4 `price_per_answer`). Record average tokens in/out.
5. Read 10 explanations against the answers. If many get `UNSUPPORTED_EVIDENCE`, the quote instruction is not being followed.

## Phase 6 — background worker (manual checklist)

`aiMarkingWorker.test.js` runs the real worker and the real engine against an in-memory store (`helpers/memoryWorkerStore.js`)
and a scripted provider on a fake clock. It proves the worker's logic **given a store that honours the contract**. It cannot
prove the T-SQL in `services/aiMarkingWorker.store.js`, real lock behaviour, or the live provider. Do these in order on a
**copy** of a tenant database, with the engine pointed at a real provider and `AI_MARKING_WORKER_ENABLED` still unset.

1. **Parse/bind every worker statement (safe, changes nothing):** `node scripts/verifyAiMarkingWorkerSql.js <tenant>`.
   Every line must say `ok`. Typical failures: a wrong column name (`Students.name`, `Students.admissionNo`), `OUTPUT`/CTE syntax.
   A `FAIL` here would otherwise make every answer error out.
2. Boot once; confirm the new objects exist: `SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('ai_marking_evaluations') AND name IN ('next_attempt_at','reused_from_evaluation_id')` (2 rows);
   same for `ai_marking_jobs` (`paused_until`, `pause_reason`, `pause_count`); indexes `IX_ai_marking_evaluations_work`, `IX_ai_marking_evaluations_reuse`.
3. **The hash must agree (critical).** Take a pending evaluation whose answer was not edited:
   `SELECT e.answer_content_hash, LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CAST(a.essay_answer AS NVARCHAR(MAX))), 2)) FROM ai_marking_evaluations e JOIN e_assessment_answers a ON a.id=e.answer_id WHERE e.status='pending'`
   — the two columns must be equal on every row. If not, the worker would cancel every answer as `ANSWER_CHANGED` (it fails safe, but nothing would be marked).
4. Create a small job (3-5 answers) through the normal preview -> confirm flow, set `AI_MARKING_WORKER_ENABLED=true` (+ `AI_MARKING_WORKER_CONCURRENCY=2`), start the server. Expect: job `reserved` -> `processing` -> `completed`;
   evaluations `success`/`needs_review`; `processing_cost` and `token_usage_json` filled; `model`/`provider`/`started_at` set on the job; wallet charged exactly `unit_price x delivered`, rest released; `reconcileWallet` ok.
5. **Claim under concurrency:** run two server processes against the same database with a job of ~50 answers. `SELECT ai_marking_job_id, answer_id, COUNT(*) FROM ai_marking_evaluations GROUP BY ai_marking_job_id, answer_id HAVING COUNT(*)>1` is empty, and
   the provider-call count in your provider dashboard equals the answer count (no double calls). Watch that both processes did some work (READPAST) rather than one idling.
6. **Hand-marking race:** start a job, and while it runs mark one pending answer by hand in the normal UI. That answer ends `cancelled` (`MANUALLY_MARKED`), keeps the teacher's mark, is not charged.
7. **Cancel:** cancel a running job from the teacher panel -> remaining answers `cancelled`, only delivered ones charged, the in-flight one discarded.
8. **Outage:** set a wrong `AI_MARKING_BASE_URL` (or block egress) mid-job. Expect backoff (`next_attempt_at` moves out), the breaker opens (log line), no flood of calls; restore -> job finishes. **Bad key:** the job pauses (`paused_until`, `pause_reason=PROVIDER_AUTH`), a `finance_audit_log` row with action `ai_marking_job_paused` appears, no answer is marked `failed`; fix the key, wait out the pause (default 10 min; set `AI_MARKING_PAUSE_MINUTES=1` for the test) -> resumes.
9. **Crash:** `kill -9` the server mid-job. Restart -> within `AI_MARKING_JOB_LEASE_SECONDS` (default >= 3 min) the job is picked up and every answer ends marked exactly once.
10. **Throughput:** after a few completed jobs, `POST /preview` shows `estimatedSeconds`; compare with a real run. Tune `AI_MARKING_WORKER_CONCURRENCY` and `AI_MARKING_RATE_LIMIT_RPM` against your provider tier (rate limit is **per process**: divide by the number of processes).
11. Confirm no student text in logs: `grep -i` a distinctive phrase from a test answer in the server log -> no hits.

## Phase 7 — review & approval (manual checklist)

Automated: `aiMarkingReview.test.js` (logic, service, controller, static SQL checks) and `aiReviewHelpers.test.js` (client helpers + client/server parity) run in `run-all.js`
against an in-memory store. `tests/manual/aiReviewPanel.render.js` mounts the real panel in jsdom over the real controller (48 checks; setup in its header).
None of that touches SQL Server or a real browser. Do these on a **copy** of a tenant database, with a few AI evaluations already produced (Phase 6 checklist steps 1-4):

1. **Parse/bind the review SQL (safe, changes nothing):** `node scripts/verifyAiMarkingWorkerSql.js <tenant>` — the "review (Phase 7)" section must be all `ok`.
2. **Accept one:** in the panel open a clean suggestion and Accept. Then check, in SQL:
   `SELECT marks_awarded FROM e_assessment_answers WHERE id=<answerId>` = the mark;
   `SELECT review_state, teacher_final_mark, teacher_approved_by, teacher_approved_at FROM ai_marking_evaluations WHERE id=<evalId>` = `approved`, the mark, you, now;
   one row in `ai_marking_adjustments` (`accept`); the submission's `score` is the sum of its answers and, if it was the last essay, `status='marked'`.
3. **It must behave exactly like a manual save.** Mark a *second, identical* submission by hand through the normal page and compare the two submissions' `score`, `status`, `remark_completed`, `remark_requested`, `remark_status` — identical. Then release both through the normal admin flow and confirm `Marks` gets the same kind of row for each.
4. **Fractional total:** find (or create via a scheme with half marks) a 3.5 suggestion: Accept must be disabled, "Give 3 / 4" must work, and the adjustment's `after_json` must contain `"roundedFromSuggestion":true`.
5. **The CHECK constraint** `CK_ai_marking_evaluations_final_whole` must not reject a normal approval (if step 2 or 4 fails with a constraint error, that is it).
6. **Guards, for real:** (a) open a suggestion, then hand-mark that answer in another tab, then Accept in the first -> refused with "already been marked", your mark untouched, evaluation still `awaiting_review`. (b) same, but release the submission. (c) same, but edit the answer text in the database.
7. **Not yours:** log in as a different teacher and request `GET .../review/<id>` for the first teacher's evaluation -> 404, and it does not appear in their queue.
8. **Double click:** Accept twice quickly (or `curl` the same approve twice) -> one `ai_marking_adjustments` row, mark written once.
9. **Atomicity:** (needs a scratch DB) make the log insert fail, e.g. temporarily `DENY INSERT ON ai_marking_adjustments TO <app user>`, then Accept -> error shown, and `marks_awarded` is still NULL and the evaluation still `awaiting_review`. Undo the DENY.
10. **Reject / flag / new evaluation:** reject with a reason (no mark written; leaves the queue); flag a scheme (nothing else changes; a second teacher's flag shows "2 teachers"); **request a new evaluation**, then in the AI-assisted panel select that answer again -> it is billable again (new quote, new charge), the old evaluation is `superseded`, and the new job's evaluation row inserts without a unique-index error (`UQ_ai_marking_evaluations_live_answer` excludes `superseded`).
11. **Bulk accept:** tick two clean rows -> both accepted, two `adjustments` rows with reason `Bulk accept`; a flagged or fractional row cannot be ticked.
12. **Look at it.** In a real browser, light and dark mode, a phone-width window, and with a long answer: nothing overlaps, the evidence highlight is readable, the Accept/Save buttons are reachable by keyboard.
13. **Hostile answer:** put `<img src=x onerror=alert(1)>` and `<script>alert(1)</script>` in a test student's essay, AI-mark it, open it in the panel -> shown as plain text, no alert.
14. **What the student sees:** after a mark with a remark is released, check whether/where the student sees the remark (the field is the existing `e_assessment_answers.remarks`; this was not verified from the code).

## Phase 8 — marking schemes (checklist; the T-SQL has never been run)

`aiMarkingScheme.test.js` (48 tests) proves the lint, drafting, versioning and approval rules over an in-memory store, and pins the SQL *text*.
It cannot prove the SQL itself. Do these on a disposable copy of one tenant database:

1. `node scripts/verifyAiMarkingWorkerSql.js <tenant>` — the "schemes (Phase 8)" block must say ALL STATEMENTS RAN. (`createDraft` is deliberately not in it: it writes.)
2. Boot once so the two new columns appear: `ai_marking_scheme_versions.change_note`, `.approval_notes`. Check `migrations/2026-10-04_ai_marking_phase2_fixes.sql` matches.
3. **Who counts as authorised.** `e_assessment_question_setters.teacher_id` and `e_assessment_submission_assignments.teacher_id` are assumed to hold the logged-in user's id (`req.user.id`). Confirm with one real teacher of each kind: they see the checklist; a teacher who is neither sees an empty list.
4. Pick an essay question with a free-text guide. "Draft from the guide" -> edit -> Check -> Save -> Approve. Confirm one `approved` row, `approved_by` = you, and `approval_notes` JSON lists the acknowledged warnings.
5. Edit the same scheme and approve again: the old row is `superseded`, the new one `approved`, and there was never a moment with two `approved` rows (watch with a second query window).
6. Open a question with an attached image: you must see the IMAGE_DEPENDENT warning and be unable to approve until you tick it.
7. Change the question's marks AFTER approving. The question must show "Marks changed — needs a new scheme", and the Phase 3 preview must move its answers from "billable" to "needs scheme". (`sv.max_marks = q.marks` was added to the eligibility predicate and to the job-claim INSERT.)
8. With a job already claimed on the old version, approve a new version: the in-flight evaluations must still show the OLD version's criteria on the review screen.
9. Two browser tabs: approve the same draft from both. One succeeds; the other is told it is already done.
10. Look at the screen: layout, dark mode, phone width, keyboard use (never seen in a browser). `npx tsx backend/tests/manual/aiSchemePanel.ssr.js` only proves it renders its first screen.

## Phase 9 checklist — calibration (agreement report)

Needs a real SQL Server with at least one assessment whose AI-marked answers have been approved / rejected in the Phase 7 review.

1. `node scripts/verifyAiMarkingWorkerSql.js <tenant>` — the "calibration (Phase 9)" block must say ALL STATEMENTS RAN. A failure here is almost certainly a column-name assumption (see the header of `services/aiMarkingCalibration.store.js`): fix the name in the store, not the test.
2. Pick an assessment you know. Compare the screen with
   `SELECT sv.version_no, ev.review_state, COUNT(*) n, AVG(ev.suggested_total - ev.teacher_final_mark) avg_diff FROM ai_marking_evaluations ev JOIN ai_marking_scheme_versions sv ON sv.id = ev.scheme_version_id JOIN e_assessment_questions q ON q.id = ev.question_id WHERE q.e_assessment_id = <id> AND ev.review_state IN ('approved','rejected') AND ev.status IN ('success','needs_review') GROUP BY sv.version_no, ev.review_state`
   — "reviewed" must equal approved + rejected, and the bias (as % of marks) must have the same sign as `avg_diff`.
3. **Who can read it:** log in as a setter, as a marker assigned to the assessment, and as an unrelated teacher. The first two see the report; the third gets "not found". Try `?assessmentId=` of another assessment you do not belong to -> "not found".
4. **No student data:** open the browser network tab on `/scheme/calibration`; the JSON must contain only marks, counts and question text snippets.
5. **Versions:** approve a second scheme version on a question that already has reviewed answers. The new version shows "Not enough data" with the old one listed under "Versions" — the old record must not colour the new scheme.
6. **Row meaning:** do one reject and one "Mark manually" in the review screen; only the reject should change the counts. If "Mark manually" is counted, `review_state` uses a value I did not expect — tell me what it is.
7. **Screen:** never opened in a browser by the author. Check it with light and dark themes, a phone width, and 0 / 3 / 12+ reviewed answers.

## Phase 10 — AI marking analytics: what still needs a real environment
1. `node scripts/verifyAiMarkingWorkerSql.js <tenant>` — the "analytics (Phase 10)" block must show ALL STATEMENTS RAN (11 read-only queries; nothing is changed).
2. After at least one finished AI job on staging: as the **teacher**, `GET /api/ai-marking-analytics/teacher` — counts match the Marking dashboard; `charges.byCurrency[0].net` equals the job's consumed amount in the ledger.
3. As an **admin**: `…/institution` — `byTeacher` lists teachers; the response has no key containing cost/token/margin. As a **teacher**, the same URL is 403; as an admin, `…/teacher` is 403.
4. As **finance**: `/api/finance/institutions/<tenant>/ai-marking/analytics` — `reconciliation.ok` is true; margin = net charged − provider cost; with `AI_MARKING_COST_*` unset the status is NO_COST_DATA, not a margin.
5. As an admin or teacher, `/api/finance/ai-marking/analytics` is 403.
6. Platform view with one tenant's DB stopped: that tenant shows "Unavailable", the banner says the total is incomplete.
7. Confirm Phase 9: after a teacher adjusts a mark, the calibration report's "teacher changed the mark" count rises.
8. Open Finance → an institution → "AI Marking Analytics", and the "AI marking — all institutions" entry, in light and dark theme.

## Phase 11 — security and privacy: what still needs a real environment
1. On the production host: with `JWT_SECRET` unset and `NODE_ENV=production`, `node server.js` must **exit with "Refusing to start"**. Then set a 52-char secret and confirm it starts with no `[security] WARNING` lines (DB_ENCRYPT=true, DB_TRUST_CERT=false).
2. `curl` an AI route with no token (401), then with a token for a student (403) — against the deployed URL, not just the test harness.
3. Set `AI_MARKING_BASE_URL=http://example.com` and confirm `/api/…` reports the engine as not configured with the reason; remove it.
4. Fire 40 rapid `POST /api/e-assessments/ai-marking/preview` as a teacher: expect 429 with `Retry-After` after 30.
5. Grep your real log output after a deliberate DB error (e.g. an over-long value) for any fragment of the value: there should be none.
6. Confirm `git ls-files | grep '\.env$'` prints nothing.
