const sql = require("mssql");
const { notifyOne } = require("../utils/notify");
const assignmentEngine = require("../utils/assignmentEngine");
const split = require("../utils/questionSplit");

const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// GET /admin/assessments/:id/split
const getSplit = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment" });
    const questions = await split.getSplitInfo(req.pool, id);
    res.json({ success: true, questions });
  } catch (err) {
    console.error("GET SPLIT ERROR:", err);
    res.status(500).json({ message: "Could not load the questions" });
  }
};

// POST /admin/assessments/:id/split   { parts: [{ teacher_id, question_ids: [] }, ...] }
const saveSplit = async (req, res) => {
  try {
    const pool = req.pool;
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment" });
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
    if (!parts.length) return res.status(400).json({ message: "Pick a teacher for at least one question." });

    const out = await split.applySplit(pool, id, parts);
    if (!out.saved) {
      return res.status(400).json({ message: "None of the chosen questions can be split (only essay / descriptive questions are marked by teachers)." });
    }
    let batchId = null;
    if (out.changes.length) {
      try {
        batchId = await assignmentEngine.recordBatch(pool, {
          kind: "question",
          summary: `Split marking: ${out.saved} question(s) shared out among ${Object.keys(out.perTeacher).length || parts.length} teacher(s), ${out.allocated} answer(s) allocated`,
          userId: req.user?.id, changes: out.changes,
        });
      } catch (e) { console.error("ASSIGNMENT HISTORY ERROR:", e.message); }
    }
    for (const [tid, count] of Object.entries(out.perTeacher)) {
      if (!count) continue;
      try {
        await notifyOne(pool, Number(tid), "Teachers", {
          title: "New Marking Allocation",
          message: `You've been allocated ${count} answered question${count === 1 ? "" : "s"} to mark.`,
          type: "allocation",
        });
      } catch (_) { /* never undo the split over a notification */ }
    }
    res.json({
      success: true, batch_id: batchId, questions: out.saved, allocated: out.allocated, per_teacher: out.perTeacher,
      message: `Split saved: ${out.saved} question${out.saved === 1 ? "" : "s"} assigned, ${out.allocated} answer${out.allocated === 1 ? "" : "s"} handed to the chosen teachers. Papers submitted later follow the same split.`
        + (out.skipped ? ` (${out.skipped} skipped — not a teacher-marked question or listed twice)` : ""),
    });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ message: err.message });
    console.error("SAVE SPLIT ERROR:", err);
    res.status(500).json({ message: "Could not save the split" });
  }
};

// DELETE /admin/assessments/:id/split
const clearSplitRules = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid assessment" });
    await split.clearSplit(req.pool, id);
    res.json({ success: true, message: "Split removed. Answers a teacher already marked stay with them." });
  } catch (err) {
    console.error("CLEAR SPLIT ERROR:", err);
    res.status(500).json({ message: "Could not remove the split" });
  }
};

module.exports = { getSplit, saveSplit, clearSplitRules };
