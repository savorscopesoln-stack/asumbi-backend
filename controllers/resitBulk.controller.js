/* =========================================================================
   BULK "ALLOW RESIT"
   POST /admin/resit/bulk
   body: { items: [{ assessment_id, student_id }], score_policy?: "replace" | "keep_best" }

   Does exactly what the single "Allow resit" does (grantResit in
   eAssessment.controller.js — new token, fresh attempt, old attempt archived
   when the resit is submitted) for every student in the list, one after the
   other, and reports who could not be given a resit and why (e.g. "already has
   one waiting", "still sitting the exam"). One student failing never stops the
   rest.
========================================================================= */
const MAX_BULK = 500;

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Runs an existing (req,res) controller in-process and returns what it answered.
async function callController(fn, req, body) {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
  };
  await fn({ pool: req.pool, user: req.user, body }, res);
  return out;
}

const grantResitBulk = async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    // de-duplicate on assessment + student
    const seen = new Set();
    const items = [];
    for (const it of raw) {
      const aid = toInt(it?.assessment_id);
      const sid = toInt(it?.student_id);
      if (!aid || !sid) continue;
      const key = `${aid}:${sid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ assessment_id: aid, student_id: sid });
    }
    if (!items.length) return res.status(400).json({ success: false, message: "Select at least one student." });
    if (items.length > MAX_BULK) return res.status(400).json({ success: false, message: `Too many at once (max ${MAX_BULK}). Select fewer and repeat.` });

    const { grantResit } = require("./eAssessment.controller"); // lazy: avoids a load-order cycle
    const score_policy = req.body?.score_policy === "keep_best" ? "keep_best" : "replace";

    let granted = 0;
    const failed = [];
    for (const it of items) {
      try {
        const out = await callController(grantResit, req, { ...it, score_policy });
        if (out.status < 300 && out.body?.success) granted += 1;
        else failed.push({ ...it, message: out.body?.message || "Could not grant" });
      } catch (e) {
        failed.push({ ...it, message: e.message || "Could not grant" });
      }
    }

    res.json({
      success: granted > 0,
      granted,
      failed,
      message: granted
        ? `Resit granted to ${granted} student${granted === 1 ? "" : "s"}${failed.length ? ` — ${failed.length} could not be granted` : ""}.`
        : (failed[0]?.message || "Nothing was granted."),
    });
  } catch (err) {
    console.error("BULK RESIT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error granting resits" });
  }
};

module.exports = { grantResitBulk };
