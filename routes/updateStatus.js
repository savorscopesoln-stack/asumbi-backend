const express = require("express");
const router = express.Router();

router.post("/status", async (req, res) => {
  try {
    const pool = req.pool;
    const { id, status } = req.body;

    await pool.request()
      .input("id", id)
      .input("status", status)
      .query(`
        UPDATE Students
        SET status = @status
        WHERE id = @id
      `);

    res.json({ message: "Status updated" });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;