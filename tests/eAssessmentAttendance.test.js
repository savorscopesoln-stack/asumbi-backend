/* E-assessment attendance register (PDF listing who did / did not do the exam). */
const { suite, test, assert } = require("./helpers/tinytest");
const zlib = require("zlib");
suite("eAssessmentAttendance.test.js");

const att = require("../utils/eAssessmentAttendance");

/* Same text-extraction trick as reportExport.test.js: PDFKit streams are
   Flate-compressed and glyphs are hex strings, so inflate + decode. */
function pdfContainsText(buffer, needle) {
  const raw = buffer.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let decoded = "", m;
  while ((m = streamRe.exec(raw))) {
    let inflated;
    try { inflated = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    const hexRe = /<([0-9A-Fa-f]+)>/g; let h;
    while ((h = hexRe.exec(inflated))) decoded += Buffer.from(h[1], "hex").toString("latin1");
  }
  return decoded.includes(needle);
}

function mkPool(assessment, students) {
  const log = [];
  return { log, request() {
    const inputs = {};
    const r = { input(n, t, v) { inputs[n] = v === undefined ? t : v; return r; },
      async query(q) {
        log.push({ q: q.replace(/\s+/g, " ").trim(), inputs: { ...inputs } });
        if (/FROM e_assessments ea/.test(q)) return { recordset: assessment ? [assessment] : [] };
        if (/FROM Students st/.test(q)) return { recordset: students };
        if (/FROM SchoolSettings/.test(q)) return { recordset: [{ schoolName: "Asumbi Test School", address: "P.O. Box 1, Kisumu" }] };
        return { recordset: [] };
      } };
    return r;
  } };
}

const A = { id: 5, title: "Maths CAT 1", subject: "Mathematics", class_id: 3, year_of_study: null, class_name: "Form 2A" };
const S = [
  { id: 1, name: "Ama Otieno",   username: "ama",  studentClass: "Form 2A", submission_id: 11, submitted_at: "2026-10-12T08:41:00Z", session_id: 21, session_status: "ended", auto_submitted: 0, attempt_no: 1 },
  { id: 2, name: "Brian Odhiambo", username: "brian", studentClass: "Form 2A", submission_id: 12, submitted_at: "2026-10-12T08:50:00Z", session_id: 22, session_status: "ended", auto_submitted: 1, attempt_no: 1 },
  { id: 3, name: "Cynthia Atieno", username: "cyn",  studentClass: "Form 2A", submission_id: null, session_id: null },
  { id: 4, name: "David Onyango", username: "dave", studentClass: "Form 2B", submission_id: null, session_id: 24, session_status: "issued" },
  { id: 5, name: "Eve Akinyi",    username: "eve",  studentClass: "Form 2B", submission_id: null, session_id: 25, session_status: "active" },
  { id: 6, name: "Faith Wanjiku", username: "faith", studentClass: "Form 2B", submission_id: null, session_id: 26, session_status: "ended", auto_submitted: 1 },
  { id: 7, name: "George Ouma",   username: "geo",  studentClass: "Form 2B", submission_id: null, session_id: 27, session_status: "ended", auto_submitted: 0 },
  { id: 8, name: "Hawa Juma",     username: "hawa", studentClass: "Form 2B", submission_id: 18, submitted_at: "2026-10-12T09:00:00Z", session_id: 28, session_status: "ended", attempt_no: 2 },
];

test("classification: submitted vs every way of not having done the exam", () => {
  const c = att.classifyAttendance;
  assert.deepStrictEqual(c(S[0]), { done: true, note: "" });
  assert.strictEqual(c(S[1]).note, "Auto-submitted (time up)");
  assert.strictEqual(c(S[7]).note, "Attempt 2");
  assert.deepStrictEqual([c(S[2]).done, c(S[2]).reason, c(S[2]).label], [false, "not_attended", "Did not attend"]);
  assert.strictEqual(c(S[3]).reason, "signed_in");
  assert.strictEqual(c(S[4]).reason, "in_progress");
  assert.strictEqual(c(S[5]).reason, "timed_out");
  assert.strictEqual(c(S[6]).reason, "ended_no_submission");
  assert.strictEqual(c({ session_id: 1, session_status: "locked" }).reason, "in_progress");
});

test("loadAttendance: roster query uses the class name, the year AND anyone who has a submission/session; all values bound", async () => {
  const pool = mkPool({ ...A, year_of_study: 2 }, S);
  const out = await att.loadAttendance(pool, 5);
  const q = pool.log.find((l) => /FROM Students st/.test(l.q));
  assert.ok(/st\.studentClass = @className/.test(q.q) && /st\.yearOfStudy = @year/.test(q.q));
  assert.ok(/OR sub\.id IS NOT NULL/.test(q.q) && /OR es\.id IS NOT NULL/.test(q.q), "a student who sat the exam is never dropped from the list");
  assert.deepStrictEqual([q.inputs.id, q.inputs.className, q.inputs.year], [5, "Form 2A", 2]);
  assert.deepStrictEqual([out.did.length, out.didNot.length], [3, 5]);
  assert.deepStrictEqual(out.didNot.map((d) => d.status),
    ["Did not attend", "Signed in, did not start", "Started, not submitted", "Timed out, nothing saved", "Session ended, no submission"]);
});

test("loadAttendance: unknown assessment -> null", async () => {
  assert.strictEqual(await att.loadAttendance(mkPool(null, []), 99), null);
});

test("per-class breakdown counts and sorts naturally", () => {
  const did = [{ className: "Form 2A" }, { className: "Form 10A" }];
  const didNot = [{ className: "Form 2A" }, { className: "Form 2B" }];
  const rows = att.byClass(did, didNot);
  assert.deepStrictEqual(rows.map((r) => [r.cls, r.did, r.didNot]), [["Form 2A", 1, 1], ["Form 2B", 0, 1], ["Form 10A", 1, 0]]);
});

test("time formatting honours the browser's time zone and survives a bad one", () => {
  const nairobi = att.fmtWhen("2026-10-12T08:41:00Z", "Africa/Nairobi");
  const utc = att.fmtWhen("2026-10-12T08:41:00Z", "UTC");
  assert.ok(/11:41/.test(nairobi) && /08:41/.test(utc), `${nairobi} / ${utc}`);
  assert.ok(/\d{2}:\d{2}/.test(att.fmtWhen("2026-10-12T08:41:00Z", "Not/AZone")), "an invalid zone falls back instead of throwing");
  assert.strictEqual(att.fmtWhen(null), "-");
  assert.strictEqual(att.fmtWhen("garbage"), "-");
});

/* Real PDF render — runs wherever pdfkit is installed (it is a project dependency). */
let havePdfkit = true;
try { require.resolve("pdfkit"); } catch { havePdfkit = false; }

test("PDF: renders a portrait document with the school header, both lists and the summary", async () => {
  if (!havePdfkit) return; // skipped where pdfkit isn't installed
  const pool = mkPool(A, S);
  const out = await att.generateAttendancePdf(pool, 5, "Africa/Nairobi");
  assert.strictEqual(out.buffer.slice(0, 5).toString(), "%PDF-");
  assert.ok(/MediaBox \[0 0 595\.\d+ 841\.\d+\]/.test(out.buffer.toString("latin1")), "A4 portrait");
  for (const t of ["Asumbi Test School", "Exam Attendance Register", "Maths CAT 1", "Students who did the exam (3)",
    "Students who did not do the exam (5)", "Ama Otieno", "Cynthia Atieno", "Did not attend", "Expected: 8"]) {
    assert.ok(pdfContainsText(out.buffer, t), `PDF should contain "${t}"`);
  }
  assert.strictEqual(out.filename, "Attendance - Maths CAT 1.pdf");
});

test("PDF: a long class list paginates and an empty 'did not' list still renders", async () => {
  if (!havePdfkit) return;
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `Student ${i + 1}`, username: `u${i + 1}`, studentClass: "Form 2A", submission_id: i + 1, submitted_at: "2026-10-12T08:41:00Z", session_id: 1, session_status: "ended" }));
  const out = await att.generateAttendancePdf(mkPool(A, many), 5);
  assert.ok((out.buffer.toString("latin1").match(/\/Type \/Page\b/g) || []).length >= 3, "120 rows span several pages");
  assert.ok(pdfContainsText(out.buffer, "Students who did not do the exam (0)"));
  assert.ok(pdfContainsText(out.buffer, "No data available"));
});

test("PDF: the file name is safe even for awkward titles", async () => {
  if (!havePdfkit) return;
  const out = await att.generateAttendancePdf(mkPool({ ...A, title: 'Term 1 "Mid/Term" <test>' }, S), 5);
  assert.ok(!/["/<>\\]/.test(out.filename.replace(/\.pdf$/, "")), out.filename);
});
