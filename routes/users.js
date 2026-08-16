const express = require("express");
const router = express.Router();
const multer = require("multer");
const xlsx = require("xlsx");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage });

/* ================= UPLOAD ROUTE ================= */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    console.log("UPLOAD TYPE:", req.body.type);
    console.log("DATA:", data);

    // 👉 HERE you will later insert into DB
    // await db.insertStudents(data)

    return res.json({
      message: "Upload successful",
      type: req.body.type,
      rows: data.length,
      preview: data.slice(0, 5),
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

module.exports = router;