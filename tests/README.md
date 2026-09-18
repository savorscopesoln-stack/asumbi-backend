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
