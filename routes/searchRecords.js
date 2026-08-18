const express = require("express");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const pool = req.pool;
    const { type, q } = req.query;
    const safeQ = q ? `%${q}%` : "%%"; // matches everything when no search term is given

    let query = "";
    let request = pool.request();

    if (type === "students") {
      query = `
        SELECT id, name, admissionNo, studentClass, gender, status, yearOfStudy, Phone
        FROM Students
        WHERE name LIKE @q
        OR admissionNo LIKE @q
        OR studentClass LIKE @q
        OR gender LIKE @q
        OR status LIKE @q
      `;
    }

    if (type === "teachers") {
      query = `
        SELECT id, name, subject, phone, staffId, email, status, regionId, researchDay
        FROM Teachers
        WHERE name LIKE @q
        OR subject LIKE @q
        OR phone LIKE @q
        OR staffId LIKE @q
      `;
    }

    if (type === "users") {
      query = `
        SELECT id, username, email, role
        FROM Users
        WHERE username LIKE @q
        OR email LIKE @q
        OR role LIKE @q
      `;
    }

    if (!query) {
      return res.status(400).json({ message: "Invalid or missing 'type' query param" });
    }

    request.input("q", safeQ);

    const result = await request.query(query);

    res.json({ records: result.recordset });
  } catch (err) {
    console.log("SEARCH ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;