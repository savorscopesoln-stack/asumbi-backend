/* =========================================================================
   CREDIT REQUEST MESSAGE BUILDER

   Institutions request credits exclusively via EMAIL or WHATSAPP
   (spec) — there is deliberately no internal request queue/ticketing
   table anywhere in this feature. This module only builds the TEXT
   and the mailto:/wa.me URL; the institution admin's own browser is
   what actually opens their email client or WhatsApp. Nothing here
   ever calls out to a mail or WhatsApp API, and no record of "a
   request was made" is written anywhere — Doravo Finance verifies the
   real payment and deposits credits entirely by hand, in their own
   time, through the finance dashboard (routes/finance.js).

   Contact details are Doravo's OWN (DORAVO_FINANCE_EMAIL /
   DORAVO_FINANCE_WHATSAPP env vars — see .env.example) — never
   hardcoded, per spec ("Never invent or hardcode contact details").
   If either isn't configured, that channel is reported as
   unconfigured so the wallet page can disable the button with a
   useful message instead of opening a broken link.

   Prefill content is deliberately limited to what the spec allows:
   institution name, tenant slug, institution's own contact, requested
   quantity, current wallet balance, and a generated reference — NEVER
   student personal information, passwords, or payment credentials.
========================================================================= */

function buildRequestReference(tenantKey) {
  // Not stored anywhere (no request-queue table, per spec) — purely a
  // human-friendly token in the message so Finance and the institution
  // can refer to "this particular ask" in conversation, distinct on
  // every render by including the current minute.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // YYYYMMDDTHHmm
  return `WLT-${String(tenantKey || "inst").toUpperCase()}-${stamp}`;
}

function buildMessageBody({
  institutionName,
  tenantKey,
  institutionContact,
  requestedQuantity,
  currentAvailableCredits,
  reference,
}) {
  const lines = [
    `Doravo Examination Wallet — Credit Request`,
    ``,
    `Institution: ${institutionName || tenantKey}`,
    `Tenant: ${tenantKey}`,
  ];
  if (institutionContact) lines.push(`Institution contact: ${institutionContact}`);
  lines.push(`Current available credits: ${currentAvailableCredits ?? "unknown"}`);
  if (requestedQuantity) lines.push(`Requested credits: ${requestedQuantity}`);
  lines.push(`Reference: ${reference}`);
  lines.push(``, `(Please confirm once payment has been verified and credits issued.)`);
  return lines.join("\n");
}

/**
 * Build both channels' prefilled request data. `requestedQuantity` is
 * optional — the institution admin can leave it blank on the wallet
 * page and just state a need, or fill in a number they want.
 */
function buildCreditRequest({ institutionName, tenantKey, institutionContact, requestedQuantity, currentAvailableCredits }) {
  const reference = buildRequestReference(tenantKey);
  const body = buildMessageBody({ institutionName, tenantKey, institutionContact, requestedQuantity, currentAvailableCredits, reference });

  const financeEmail = (process.env.DORAVO_FINANCE_EMAIL || "").trim();
  const financeWhatsapp = (process.env.DORAVO_FINANCE_WHATSAPP || "").trim();

  const subject = `Credit request — ${institutionName || tenantKey} (${reference})`;

  const email = financeEmail
    ? {
        configured: true,
        address: financeEmail,
        mailtoUrl: `mailto:${encodeURIComponent(financeEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      }
    : { configured: false, message: "Doravo Finance email is not configured yet. Contact Doravo directly to set this up." };

  const whatsapp = financeWhatsapp
    ? {
        configured: true,
        number: financeWhatsapp,
        waUrl: `https://wa.me/${financeWhatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(body)}`,
      }
    : { configured: false, message: "Doravo Finance WhatsApp number is not configured yet. Contact Doravo directly to set this up." };

  return { reference, email, whatsapp };
}

module.exports = { buildCreditRequest };
