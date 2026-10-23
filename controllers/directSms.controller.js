const sql = require("mssql");
const { sendSms, normalizePhone, pickSmsProvider } = require("../services/notificationChannels");

/* =========================================================================
   DIRECT SMS + CONTACTS
   Backs the "Direct SMS" tab on the admin Notifications page:
     - send an SMS straight from the system to one or more typed numbers
       and/or saved contacts (no student/teacher record needed)
     - a small address book (NotificationContacts) for numbers that don't
       belong to any Student / Teacher / User account

   Every send goes through services/notificationChannels.sendSms, so it uses
   whichever provider (Africa's Talking / Twilio) is configured under
   Notification Settings.
========================================================================= */

const MAX_RECIPIENTS = 100;
const MAX_MESSAGE_LEN = 1000;

const toInt = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};

// normalizePhone() is deliberately forgiving (it's used on stored data);
// for numbers typed in by hand we additionally require a plausible E.164
// shape so a typo is rejected up front instead of costing an SMS attempt.
const cleanPhone = (raw) => {
  const p = normalizePhone(raw);
  if (!p || !/^\+\d{8,15}$/.test(p)) return null;
  return p;
};

const senderName = (req) => req.user?.username || req.user?.email || null;

/* ---------------------------------------------------------------- contacts */

// GET /contacts?search=
const listContacts = async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const r = req.pool.request();
    let q = `SELECT id, name, phone, note, createdAt FROM NotificationContacts`;
    if (search) {
      r.input("like", sql.NVarChar, `%${search}%`);
      q += ` WHERE name LIKE @like OR phone LIKE @like OR note LIKE @like`;
    }
    q += ` ORDER BY name`;
    const out = await r.query(q);
    res.json(out.recordset || []);
  } catch (err) {
    console.error("LIST CONTACTS ERROR:", err);
    res.status(500).json({ message: "Failed to load contacts", error: err.message });
  }
};

const readContactBody = (body) => {
  const name = String(body?.name || "").trim();
  const note = String(body?.note || "").trim();
  const phone = cleanPhone(body?.phone);
  if (!name) return { error: "Contact name is required" };
  if (name.length > 150) return { error: "Contact name is too long (max 150 characters)" };
  if (!phone) return { error: "Enter a valid phone number, e.g. 0712345678 or +254712345678" };
  if (note.length > 300) return { error: "Note is too long (max 300 characters)" };
  return { name, phone, note: note || null };
};

// POST /contacts   { name, phone, note? }
const createContact = async (req, res) => {
  try {
    const parsed = readContactBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const dup = await req.pool.request()
      .input("phone", sql.NVarChar, parsed.phone)
      .query(`SELECT TOP 1 name FROM NotificationContacts WHERE phone = @phone`);
    if (dup.recordset.length) {
      return res.status(409).json({ message: `That number is already saved as "${dup.recordset[0].name}"` });
    }

    const out = await req.pool.request()
      .input("name", sql.NVarChar, parsed.name)
      .input("phone", sql.NVarChar, parsed.phone)
      .input("note", sql.NVarChar, parsed.note)
      .input("createdBy", sql.Int, req.user?.id || null)
      .input("createdByName", sql.NVarChar, senderName(req))
      .query(`
        INSERT INTO NotificationContacts (name, phone, note, createdBy, createdByName, createdAt)
        OUTPUT INSERTED.id, INSERTED.name, INSERTED.phone, INSERTED.note, INSERTED.createdAt
        VALUES (@name, @phone, @note, @createdBy, @createdByName, GETDATE())
      `);
    res.status(201).json(out.recordset[0]);
  } catch (err) {
    console.error("CREATE CONTACT ERROR:", err);
    res.status(500).json({ message: "Failed to save contact", error: err.message });
  }
};

// PUT /contacts/:id   { name, phone, note? }
const updateContact = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    const parsed = readContactBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const dup = await req.pool.request()
      .input("phone", sql.NVarChar, parsed.phone)
      .input("id", sql.Int, id)
      .query(`SELECT TOP 1 name FROM NotificationContacts WHERE phone = @phone AND id <> @id`);
    if (dup.recordset.length) {
      return res.status(409).json({ message: `That number is already saved as "${dup.recordset[0].name}"` });
    }

    const out = await req.pool.request()
      .input("id", sql.Int, id)
      .input("name", sql.NVarChar, parsed.name)
      .input("phone", sql.NVarChar, parsed.phone)
      .input("note", sql.NVarChar, parsed.note)
      .query(`
        UPDATE NotificationContacts SET name = @name, phone = @phone, note = @note
        OUTPUT INSERTED.id, INSERTED.name, INSERTED.phone, INSERTED.note, INSERTED.createdAt
        WHERE id = @id
      `);
    if (!out.recordset.length) return res.status(404).json({ message: "Contact not found" });
    res.json(out.recordset[0]);
  } catch (err) {
    console.error("UPDATE CONTACT ERROR:", err);
    res.status(500).json({ message: "Failed to update contact", error: err.message });
  }
};

// DELETE /contacts/:id
const deleteContact = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid id" });
    const out = await req.pool.request()
      .input("id", sql.Int, id)
      .query(`DELETE FROM NotificationContacts OUTPUT DELETED.id WHERE id = @id`);
    if (!out.recordset.length) return res.status(404).json({ message: "Contact not found" });
    res.json({ message: "Contact deleted" });
  } catch (err) {
    console.error("DELETE CONTACT ERROR:", err);
    res.status(500).json({ message: "Failed to delete contact", error: err.message });
  }
};

/* ------------------------------------------------------------- direct send */

/* POST /sms
   body: { message, numbers?: string[], contactIds?: number[] }
   Typed numbers and saved contacts are merged and de-duplicated by
   normalized number. Each recipient is sent independently so one bad number
   never blocks the rest. Responds with a per-recipient result list. */
const sendDirectSms = async (req, res) => {
  try {
    const pool = req.pool;
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ message: "Message is required" });
    if (message.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ message: `Message is too long (max ${MAX_MESSAGE_LEN} characters)` });
    }

    const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    const contactIds = (Array.isArray(req.body?.contactIds) ? req.body.contactIds : [])
      .map(toInt).filter(Boolean);

    const byPhone = new Map(); // phone -> { phone, name }
    const invalid = [];

    // Saved contacts first so their names win over a typed duplicate.
    if (contactIds.length) {
      const r = pool.request();
      const ph = contactIds.slice(0, MAX_RECIPIENTS).map((id, i) => {
        r.input(`c${i}`, sql.Int, id);
        return `@c${i}`;
      });
      const out = await r.query(`SELECT name, phone FROM NotificationContacts WHERE id IN (${ph.join(",")})`);
      for (const c of out.recordset || []) {
        if (!byPhone.has(c.phone)) byPhone.set(c.phone, { phone: c.phone, name: c.name });
      }
    }

    for (const raw of numbers) {
      const phone = cleanPhone(raw);
      if (!phone) {
        invalid.push(String(raw));
        continue;
      }
      if (!byPhone.has(phone)) byPhone.set(phone, { phone, name: null });
    }

    if (invalid.length) {
      return res.status(400).json({
        message: `Invalid phone number${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`,
      });
    }

    const recipients = [...byPhone.values()];
    if (!recipients.length) return res.status(400).json({ message: "Add at least one phone number or contact" });
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ message: `Too many recipients (max ${MAX_RECIPIENTS} per send)` });
    }

    const by = senderName(req);
    const results = [];
    for (const rec of recipients) {
      let result;
      try {
        result = await sendSms({ to: rec.phone, message }, pool);
      } catch (err) {
        result = { ok: false, reason: err.message };
      }

      const status = result.ok ? "sent" : "failed";
      const reason = result.ok ? null : (result.reason || "Unknown error");
      results.push({ phone: rec.phone, name: rec.name, status, reason, skipped: !!result.skipped });

      try {
        await pool.request()
          .input("name", sql.NVarChar, rec.name)
          .input("phone", sql.NVarChar, rec.phone)
          .input("message", sql.NVarChar, message)
          .input("status", sql.NVarChar, status)
          .input("reason", sql.NVarChar, reason ? String(reason).slice(0, 500) : null)
          .input("createdBy", sql.Int, req.user?.id || null)
          .input("createdByName", sql.NVarChar, by)
          .query(`
            INSERT INTO DirectSmsLog (recipientName, phone, message, status, reason, createdBy, createdByName, createdAt)
            VALUES (@name, @phone, @message, @status, @reason, @createdBy, @createdByName, GETDATE())
          `);
      } catch (logErr) {
        console.error("DIRECT SMS LOG ERROR:", logErr.message); // never fail a send over logging
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    res.json({
      message: sent === results.length ? `SMS sent to ${sent} recipient(s)` : `${sent} of ${results.length} SMS sent`,
      sent,
      failed: results.length - sent,
      results,
    });
  } catch (err) {
    console.error("DIRECT SMS ERROR:", err);
    res.status(500).json({ message: "Failed to send SMS", error: err.message });
  }
};

// GET /sms  — most recent direct messages, newest first
const listDirectSms = async (req, res) => {
  try {
    const out = await req.pool.request().query(`
      SELECT TOP 100 id, recipientName, phone, message, status, reason, createdByName, createdAt
      FROM DirectSmsLog ORDER BY id DESC
    `);
    res.json(out.recordset || []);
  } catch (err) {
    console.error("LIST DIRECT SMS ERROR:", err);
    res.status(500).json([]);
  }
};

module.exports = {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  sendDirectSms,
  listDirectSms,
};
