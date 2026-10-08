const L = require("./aiMarkingAnalytics.logic");

const { describeError } = require("../utils/safeLog");
/* =========================================================================
   AI MARKING — ANALYTICS SERVICE (Phase 10)

   Read-only. Moves no money, writes no marks, calls no AI provider, returns no
   student data (counts, marks and criterion labels only).

   WHO SEES WHAT — decided here and by which store is used, not by a flag:
     makeOperationalService   teacher (own work) and institution admin (own institution).
                              Built on the operational store, which never reads provider
                              cost, so cost and margin cannot appear in these responses.
     makeFinanceService       Doravo Finance only. Adds provider cost, tokens and margin,
                              for one institution or for the whole platform.

   The scope (whose data) is passed in by the controller from req.user / the
   validated tenant — never from query or body.
========================================================================= */

const toInt = (v) => { if (v == null || v === "") return null; const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new L.AnalyticsError(400, "INVALID_ID", "assessmentId must be a positive whole number"); return n; };

async function buildOperational({ store, scope, range, assessmentId }) {
  const opts = { assessmentId };
  const [position, activityRaw, agreementRaw, criteriaRaw, charges] = await Promise.all([
    store.position(scope, opts),
    store.activity(scope, range, opts),
    store.agreementRows(scope, range, opts),
    store.criteriaRows(scope, range, opts),
    store.charges(scope, range, opts),
  ]);
  const provisional = L.missedCriteria(criteriaRaw.rows);
  const texts = await store.questionTexts(provisional.map((c) => c.questionId));
  return {
    operational: {
      position: L.shapePosition(position),
      activity: L.shapeActivity(activityRaw),
      agreement: L.shapeAgreement(agreementRaw.rows, agreementRaw.truncated),
      missedCriteria: L.missedCriteria(criteriaRaw.rows, texts),
      missedCriteriaBasedOn: { evaluations: criteriaRaw.rows.length, truncated: criteriaRaw.truncated },
    },
    billing: { byCurrency: L.shapeBilling(charges) },
  };
}

const meta = (range) => ({ period: range.label, rules: L.RULES, caveats: [
  "Agreement is not accuracy: suggestions accepted without being read make any scheme look good, and bulk acceptance is not recorded separately.",
  "Answers marked by hand have no timestamp, so manual marking is a current count, not a trend.",
] });

function makeOperationalService({ store, walletSummary = null }) {
  return {
    /** A teacher's own AI activity, billing and permitted wallet information. */
    async forTeacher({ teacherId, from, to, assessmentId }) {
      const id = Number(teacherId);
      if (!Number.isInteger(id) || id < 1) throw new L.AnalyticsError(401, "UNAUTHENTICATED", "Not authenticated");
      const range = L.parseRange({ from, to });
      const scope = { kind: "teacher", teacherId: id };
      const out = await buildOperational({ store, scope, range, assessmentId: toInt(assessmentId) });
      return { scope: "teacher", ...out, wallet: walletSummary ? await walletSummary() : null, ...meta(range) };
    },

    /** An institution administrator's view of their own institution, with usage by teacher. */
    async forInstitution({ from, to, assessmentId }) {
      const range = L.parseRange({ from, to });
      const scope = { kind: "institution" };
      const aId = toInt(assessmentId);
      const [out, teachers, perTeacherCharges] = await Promise.all([
        buildOperational({ store, scope, range, assessmentId: aId }),
        store.byTeacher(range, { assessmentId: aId }),
        store.charges(scope, range, { assessmentId: aId, perTeacher: true }),
      ]);
      const chargeRowsBy = (rows) => { const m = new Map(); for (const r of rows) { const k = Number(r.teacher_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
      const gross = chargeRowsBy(perTeacherCharges.grossRows), refunds = chargeRowsBy(perTeacherCharges.refundRows);
      const byTeacher = teachers.map((t) => ({
        teacherId: Number(t.teacher_id), name: t.teacher_name || null, requests: Number(t.jobs) || 0,
        processed: Number(t.processed) || 0, failed: Number(t.failed) || 0,
        billing: L.shapeBilling({ grossRows: gross.get(Number(t.teacher_id)) || [], refundRows: refunds.get(Number(t.teacher_id)) || [] }),
      }));
      return { scope: "institution", ...out, byTeacher, wallet: walletSummary ? await walletSummary() : null, ...meta(range) };
    },
  };
}

/**
 * Finance only. `openTenant(key)` returns { operational, economics } stores for that tenant database and
 * throws for an unknown key; `listTenants()` returns every tenant key.
 */
function makeFinanceService({ openTenant, listTenants }) {
  async function tenantParts(tenantKey, range) {
    const { operational, economics } = await openTenant(tenantKey);
    const [ops, charges, costs, recon] = await Promise.all([
      buildOperational({ store: operational, scope: { kind: "institution" }, range, assessmentId: null }),
      operational.charges({ kind: "institution" }, range, {}),
      economics.costRows(range),
      economics.reconciliation(range),
    ]);
    return { ops, billing: L.shapeBilling(charges), costs, recon };
  }

  return {
    /** One institution: everything an institution admin sees, plus provider cost, tokens and margin. */
    async forInstitution({ tenantKey, from, to }) {
      const range = L.parseRange({ from, to });
      const t = await tenantParts(tenantKey, range);
      return {
        scope: "finance-institution", tenantKey, ...t.ops,
        economics: { ...L.shapeEconomics({ costRows: t.costs.rows, billing: t.billing, truncated: t.costs.truncated }), statusText: L.MARGIN_STATUS_TEXT },
        reconciliation: { ...t.recon, ok: t.recon.mismatched === 0 },
        ...meta(range),
      };
    },

    /** Whole platform: per institution headline numbers plus ONE combined economics result built with the same rules. */
    async platform({ from, to }) {
      const range = L.parseRange({ from, to });
      const keys = await listTenants();
      const acc = L.newCostAcc();
      const billings = [];
      const institutions = [];
      let truncated = false;
      let jobsChecked = 0, mismatched = 0, unavailable = 0;
      for (const key of keys) {
        try {
          const t = await tenantParts(key, range);
          L.addCostRows(acc, t.costs.rows);
          billings.push(t.billing);
          truncated = truncated || t.costs.truncated;
          jobsChecked += t.recon.jobsChecked; mismatched += t.recon.mismatched;
          const a = t.ops.operational.activity;
          institutions.push({
            tenantKey: key, available: true, requests: a.requests, processed: a.processed, failed: a.failed,
            teacherApproved: a.review.teacherApproved, modifiedByTeacher: a.review.modifiedByTeacher,
            agreementRatePct: t.ops.operational.agreement.agreementRatePct,
            economics: L.shapeEconomics({ costRows: t.costs.rows, billing: t.billing, truncated: t.costs.truncated }).byCurrency,
          });
        } catch (err) {
          // One institution failing must not hide the rest — and must not be reported as zero.
          unavailable += 1;
          console.error("AI MARKING ANALYTICS: tenant unavailable:", key, describeError(err));
          institutions.push({ tenantKey: key, available: false });
        }
      }
      const billing = L.mergeBilling(billings);
      return {
        scope: "finance-platform",
        complete: unavailable === 0 && !truncated,
        institutionsUnavailable: unavailable,
        economics: { ...L.finishEconomics(acc, billing, truncated), statusText: L.MARGIN_STATUS_TEXT },
        reconciliation: { jobsChecked, mismatched, ok: mismatched === 0 },
        institutions, ...meta(range),
      };
    },
  };
}

module.exports = { makeOperationalService, makeFinanceService, AnalyticsError: L.AnalyticsError };
