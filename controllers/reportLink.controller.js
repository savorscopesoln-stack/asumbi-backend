const { sql } = require("../config/db");
const { sendSms, sendWhatsapp, normalizePhone } = require("../services/notificationChannels");
const { signReportLink, signTranscriptLink, renderMessage } = require("../utils/reportLink");
const { studentIdsWithTranscript } = require("./transcript.controller");

/* =========================================================================
   STUDENT DOWNLOAD LINKS — admin side (see utils/reportLink.js for how a link works).

   Two kinds, same flow:
     kind "report"      (default)  the student's report form      -> https://<site>/r/<token>
     kind "transcript"             the student's transcript PDF   -> https://<site>/t/<token>
                                   (only students with released marks get one)

   POST /api/main-exams/report-links/preview
        { kind?, studentClass?, studentId?, examId? }  -> how many students, how many have a phone number
   POST /api/main-exams/report-links/send
        { kind?, studentClass?, studentId?, examId?, channels?: ["whatsapp","sms"], days?, baseUrl, message? }
        Creates one link per student. With no channels it only creates the links
        (copy / CSV / "open WhatsApp" in the admin screen). With channels it also
        texts each student their own link.
========================================================================= */

const DEFAULT_MESSAGE = {
  report: "Hello {name}, your report form is ready. Download it here: {link} (link valid for {days} days)",
  transcript: "Hello {name}, your transcript is ready. Download it here: {link} (link valid for {days} days)",
};
const MAX_SEND = 500;          // texting: keep one request short — send class by class
const MAX_LINKS = 5000;        // creating links only is cheap

// A number counts only if it normalises to + followed by 9–15 digits (so a typo is skipped, not sent).
const validPhone = (raw) => {
  const p = normalizePhone(raw);
  return p && /^\+\d{9,15}$/.test(p) ? p : null;
};

const cleanClass = (v) => {
  const c = String(v || "").trim();
  return !c || c.toLowerCase() === "all" ? null : c;
};
const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const kindOf = (v) => (v === "transcript" ? "transcript" : "report");

/** The students a selection means: one student, one class, or everyone. */
const loadStudents = async (pool, { kind, studentClass, studentId, examId }) => {
  const rq = pool.request();
  // report forms: current students only (as the report page lists them); transcripts: anyone with released marks
  const where = [kind === "transcript" ? "1 = 1" : "status != 'graduated'"];
  if (studentId) { rq.input("sid", sql.Int, studentId); where.push("id = @sid"); }
  else if (studentClass) { rq.input("cls", sql.NVarChar, studentClass); where.push("studentClass = @cls"); }
  const r = await rq.query(`SELECT id, name, studentClass, Phone AS phone FROM Students WHERE ${where.join(" AND ")} ORDER BY studentClass, name`);
  let rows = r.recordset || [];
  if (kind === "transcript" && rows.length) {
    const has = await studentIdsWithTranscript(pool, rows.map((s) => s.id), examId);
    rows = rows.filter((s) => has.has(s.id));
  }
  return rows;
};

const selection = (body) => ({
  kind: kindOf(body?.kind),
  studentClass: cleanClass(body?.studentClass),
  studentId: toInt(body?.studentId),
  examId: body?.examId && String(body.examId) !== "all" ? toInt(body.examId) : null,
});

const previewReportLinks = async (req, res) => {
  try {
    const students = await loadStudents(req.pool, selection(req.body));
    const withPhone = students.filter((s) => validPhone(s.phone)).length;
    res.json({ success: true, students: students.length, withPhone, withoutPhone: students.length - withPhone });
  } catch (err) {
    console.error("REPORT LINK PREVIEW ERROR:", err);
    res.status(500).json({ success: false, message: "Could not count the students" });
  }
};

const sendReportLinks = async (req, res) => {
  try {
    const pool = req.pool;
    const sel = selection(req.body);
    const channels = [...new Set((Array.isArray(req.body?.channels) ? req.body.channels : []).map(String))]
      .filter((c) => c === "whatsapp" || c === "sms");
    const days = Math.min(60, Math.max(1, parseInt(req.body?.days, 10) || 14));
    const baseUrl = String(req.body?.baseUrl || process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
      return res.status(400).json({ success: false, message: "The site address for the links is missing." });
    }
    let template = String(req.body?.message || "").trim() || DEFAULT_MESSAGE[sel.kind];
    if (!/\{link\}/i.test(template)) template += " {link}";

    const students = await loadStudents(pool, sel);
    if (!students.length) {
      return res.status(404).json({
        success: false,
        message: sel.kind === "transcript"
          ? "No student in this selection has released marks yet, so there is no transcript to send."
          : "No students found for that selection.",
      });
    }
    const cap = channels.length ? MAX_SEND : MAX_LINKS;
    if (students.length > cap) {
      return res.status(400).json({
        success: false,
        message: channels.length
          ? `That is ${students.length} students. Choose one class at a time when sending messages (up to ${MAX_SEND}).`
          : `That is ${students.length} students; up to ${MAX_LINKS} links can be created at once.`,
      });
    }

    const tenant = req.tenant || req.user?.tenant || "default";
    const summary = {
      students: students.length,
      whatsapp: { sent: 0, failed: 0, skipped: 0 },
      sms: { sent: 0, failed: 0, skipped: 0 },
    };

    const links = students.map((s) => {
      const token = sel.kind === "transcript"
        ? signTranscriptLink({ studentId: s.id, tenant, days, examId: sel.examId })
        : signReportLink({ studentId: s.id, tenant, days });
      const url = `${baseUrl}/${sel.kind === "transcript" ? "t" : "r"}/${token}`;
      const phone = validPhone(s.phone);
      const message = renderMessage(template, { name: s.name, link: url, days, class: s.studentClass });
      return {
        id: s.id, name: s.name, class: s.studentClass || "", phone: s.phone || "", url, message,
        waDigits: phone ? String(phone).replace(/\D/g, "") : "",
        whatsapp: channels.includes("whatsapp") ? "pending" : "-",
        sms: channels.includes("sms") ? "pending" : "-",
        error: null,
      };
    });

    // a few at a time: fast enough for a class, gentle on the provider
    const queue = links.filter(() => channels.length);
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const l = queue[next++];
        for (const ch of channels) {
          if (!l.waDigits) { l[ch] = "skipped"; summary[ch].skipped++; l.error = "No valid phone number"; continue; }
          const fn = ch === "whatsapp" ? sendWhatsapp : sendSms;
          try {
            const result = await fn({ to: l.phone, message: l.message }, pool);
            if (result.ok) { l[ch] = "sent"; summary[ch].sent++; }
            else if (result.skipped) { l[ch] = "skipped"; summary[ch].skipped++; l.error = l.error || result.reason || null; }
            else { l[ch] = "failed"; summary[ch].failed++; l.error = result.reason || "Failed"; }
          } catch (e) {
            l[ch] = "failed"; summary[ch].failed++; l.error = e.message;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));

    res.json({ success: true, kind: sel.kind, days, channels, summary, links });
  } catch (err) {
    console.error("REPORT LINK SEND ERROR:", err);
    res.status(500).json({ success: false, message: "Could not create the links" });
  }
};

module.exports = { previewReportLinks, sendReportLinks };
