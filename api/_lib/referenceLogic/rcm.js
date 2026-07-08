// RCM (Revenue Cycle Management) — CPT billing-record generation.
//
// Logic ported from the .NET 8 reference (see reference/HANDOFF.md §1.1):
//   - reference/Order_Patient/Services/RCM1Service.cs
//       GenerateAndUpsertRCMAsync / GenerateRCMAsync / MapAdmissionsToRCM
//       (the CPT decision tree + G0182 upgrade + idempotent composite-id upsert)
//   - reference/Order_Patient/Models/RCM.cs (RCMNew shape → payload jsonb)
//
// Adapted from Cosmos + reflection-heavy per-patient docs to POC Neon/Postgres:
// the billing unit here is the (episode, CPO month) pair, sourced from the
// engine's cpo_months table and the eligibility helpers already in
// repositories.js (computeEpisodeAssessment / isOrderSigned) rather than
// re-deriving PgBillable/F2F/485 facts from scratch.
//
// CPT decision tree (Medicare CPO codes, per HANDOFF §1.1):
//   G0181  $120  cpo_min >= 30                      (CPO supervision, 30+ min)
//     └─ G0182 $120 when the episode is ~90 days     (long-episode variant;
//        RCM1Service upgrades G0181→G0182 at 87–91 days. G0182 is the
//        hospice-supervision analogue; POC has no hospice flag so we keep the
//        RCM1Service duration heuristic.)
//   G0180  $60   signed 485 for the episode AND it is the FIRST certification
//                (episode is the admission's first episode)   [SOC == SOE case]
//   G0179  $40   signed 485 for a subsequent episode (recertification)
//
// generateRcm is agency-scoped: it processes every episode belonging to the
// workflow item's HHAH so taskRegistry can call it once per workflow item.

import { getSql } from '../db.js';
import { computeEpisodeAssessment, isOrderSigned } from '../repositories.js';
import {
  carryForwardEpisodeDiagnoses,
  derivePatientStatus,
  deriveFilterStatus,
  isPatientDataComplete,
  evaluateCpoMonthReadiness,
} from './businessRules.js';

// CPT → (charge dollars, amount in cents). Ported from RCM1Service charge
// literals ("120"/"60"/"40") and the $120 supervision rate in HANDOFF §1.1.
const CPT_AMOUNTS_CENTS = {
  G0181: 12000,
  G0182: 12000,
  G0180: 6000,
  G0179: 4000,
};

const G0181_MIN_CPO_MINUTES = 30;

// RCM1Service upgrades a G0181 to G0182 when the episode spans ~90 days
// (days >= 87 && days <= 91). Kept verbatim as the only distinguishing signal
// available in the POC (no hospice service-type flag).
const G0182_MIN_DAYS = 87;
const G0182_MAX_DAYS = 91;

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function dateMs(value) {
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const time = new Date(`${ymd}T00:00:00.000Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

function daysBetween(fromValue, toValue) {
  const from = dateMs(fromValue);
  const to = dateMs(toValue);
  if (from === null || to === null) return null;
  return Math.floor((to - from) / (1000 * 60 * 60 * 24));
}

// A CPO month is stored as a `date` (first-of-month) in cpo_months; RCM records
// carry it as a human-readable "Month YYYY" string, matching the reference
// RCMNew.CpoMonth format ("August 2025").
function formatCpoMonth(value) {
  const ymd = dateOnly(value);
  if (!ymd) return null;
  const [y, m] = ymd.split('-');
  const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${month} ${y}`;
}

// RCM1Service.CreateRCMNew BLOCKS an RCM record when no diagnosis codes exist
// on the episode. diagnosis_codes is a jsonb array on patient_episodes.
function hasDiagnosis(episode) {
  const codes = episode.diagnosis_codes;
  if (Array.isArray(codes)) return codes.some((c) => c && String(c).trim());
  if (codes && typeof codes === 'object') {
    return Object.values(codes).some((c) => c && String(c).trim());
  }
  return false;
}

function isSigned485(order) {
  const docType = String(order.document_type || order.order_type || '').toLowerCase();
  const is485 = docType.includes('485') || docType.includes('plan of care');
  return is485 && isOrderSigned(order);
}

// Resolve the agency id for the workflow item. referencePayload.HHAH = {id,...}.
function agencyIdFromItem(item) {
  return item?.reference_payload?.HHAH?.id || null;
}

/**
 * Decide the CPT code for one (episode, CPO month).
 *
 * Ported from RCM1Service.MapAdmissionsToRCM's decision tree, collapsed to the
 * signals the POC engine actually persists:
 *   - cpoMin (cpo_months.cpo_min) drives the G0181/G0182 supervision path.
 *   - a signed 485 on the episode + episode ordinality (first vs subsequent)
 *     drives the certification (G0180) / recertification (G0179) path.
 * Returns null when nothing is billable for this month.
 */
function decideCpt({ cpoMin, episodeDays, hasSigned485, isFirstCertification }) {
  // A) CPO supervision: 30+ minutes → G0181 (upgrade to G0182 for ~90-day episodes).
  if (cpoMin >= G0181_MIN_CPO_MINUTES) {
    if (episodeDays !== null && episodeDays >= G0182_MIN_DAYS && episodeDays <= G0182_MAX_DAYS) {
      return 'G0182';
    }
    return 'G0181';
  }

  // B) Certification / recertification: requires a physician-signed 485.
  if (hasSigned485) {
    // G0180 = first certification for the admission; G0179 = recertification.
    return isFirstCertification ? 'G0180' : 'G0179';
  }

  return null;
}

/**
 * Generate + idempotently upsert RCM billing records for the item's agency.
 *
 * Item/agency-scoped so taskRegistry can invoke it per workflow item:
 *   generateRcm({ item }) -> { ok, records: [{id, episodeId, cpoMonth, cptCode, amountCents}], skipped }
 *
 * `skipped` counts (episode, month) pairs that were eligible to look at but
 * produced no billable line (no CPT, no diagnosis codes, or unparsable month) —
 * mirroring the "[RCM SKIP]" branches in RCM1Service.
 */
export async function generateRcm({ item }) {
  const sql = getSql();
  const agencyId = agencyIdFromItem(item);

  if (!agencyId) {
    return { ok: false, records: [], skipped: 0, error: 'no_agency_on_item' };
  }

  // Pull every (episode, CPO month) for this agency's patients in one pass,
  // plus the episode/admission facts the decision tree needs. Ordering episodes
  // by SOE within an admission lets us flag the first certification.
  const rows = await sql`
    SELECT
      cm.id           AS cpo_id,
      cm.cpo_month    AS cpo_month,
      cm.cpo_min      AS cpo_min,
      cm.reason       AS cpo_reason,
      e.id            AS episode_id,
      e.soe           AS soe,
      e.eoe           AS eoe,
      e.diagnosis_codes AS diagnosis_codes,
      a.id            AS admission_id,
      a.soc           AS soc,
      p.id            AS patient_id,
      p.name          AS patient_name,
      p.dob           AS patient_dob,
      p.sex           AS patient_sex,
      p.personal_information AS personal_information,
      p.insurance_details    AS insurance_details,
      h.name          AS agency_name,
      h.npi           AS agency_npi
    FROM cpo_months cm
    JOIN patient_episodes e   ON e.id = cm.episode_id
    JOIN patient_admissions a ON a.id = e.admission_id
    JOIN patients p           ON p.id = a.patient_id
    LEFT JOIN home_health_agencies h ON h.id = p.agency_id
    WHERE p.agency_id = ${agencyId}
    ORDER BY a.id, e.soe NULLS LAST, e.id, cm.cpo_month
  `;

  if (!rows.length) {
    return { ok: true, records: [], skipped: 0 };
  }

  // Determine the first episode (by SOE) per admission → first certification.
  const firstEpisodeByAdmission = new Map();
  for (const row of rows) {
    if (!firstEpisodeByAdmission.has(row.admission_id)) {
      firstEpisodeByAdmission.set(row.admission_id, row.episode_id);
    }
  }

  // ── Diagnosis carry-forward (BusinessRequirementsService.CarryForwardEpisodeDiagnoses) ──
  // The rows above are (episode, CPO month) pairs; collapse to distinct episodes
  // per admission, then run forward+backward carry within each admission over
  // episodes ordered by (admission_id, SOE) — exactly the row ordering — so a
  // blank-Dx episode inherits sibling codes BEFORE the hasDiagnosis() gate below
  // drops it. The mutated diagnosis_codes are propagated back onto every row that
  // shares that episode_id so decideCpt/payload see the carried codes.
  const episodesByAdmission = new Map();
  const distinctEpisodes = new Map();
  for (const row of rows) {
    if (!distinctEpisodes.has(row.episode_id)) {
      const ep = {
        id: row.episode_id,
        admission_id: row.admission_id,
        soe: row.soe,
        eoe: row.eoe,
        diagnosis_codes: row.diagnosis_codes,
      };
      distinctEpisodes.set(row.episode_id, ep);
      if (!episodesByAdmission.has(row.admission_id)) episodesByAdmission.set(row.admission_id, []);
      episodesByAdmission.get(row.admission_id).push(ep);
    }
  }
  for (const epList of episodesByAdmission.values()) {
    carryForwardEpisodeDiagnoses(epList);
  }
  // Propagate carried codes back to every (episode, month) row.
  for (const row of rows) {
    const ep = distinctEpisodes.get(row.episode_id);
    if (ep) row.diagnosis_codes = ep.diagnosis_codes;
  }

  // Per-patient episode + patient-demographic maps for the R2 status machine.
  // derivePatientStatus keys off ALL the patient's episodes (latest EOE); the
  // patient row (name/dob/sex/personal_information) feeds isPatientDataComplete.
  const episodesByPatient = new Map();
  const patientRowByPatient = new Map();
  for (const row of rows) {
    if (!episodesByPatient.has(row.patient_id)) episodesByPatient.set(row.patient_id, []);
    const list = episodesByPatient.get(row.patient_id);
    if (!list.some((e) => e.id === row.episode_id)) {
      list.push({
        id: row.episode_id,
        admission_id: row.admission_id,
        soc: row.soc,
        soe: row.soe,
        eoe: row.eoe,
        diagnosis_codes: distinctEpisodes.get(row.episode_id)?.diagnosis_codes ?? row.diagnosis_codes,
      });
    }
    if (!patientRowByPatient.has(row.patient_id)) {
      patientRowByPatient.set(row.patient_id, {
        name: row.patient_name,
        dob: row.patient_dob,
        sex: row.patient_sex,
        personal_information: row.personal_information || {},
      });
    }
  }

  // Load this agency's orders once so we can find signed 485s per episode and
  // compute per-episode eligibility (reusing computeEpisodeAssessment).
  const orderRows = await sql`
    SELECT o.*
    FROM orders o
    JOIN patients p ON p.id = o.patient_id
    WHERE p.agency_id = ${agencyId}
  `;
  const ordersByEpisode = new Map();
  const ordersByAdmission = new Map();
  for (const order of orderRows) {
    if (order.episode_id) {
      if (!ordersByEpisode.has(order.episode_id)) ordersByEpisode.set(order.episode_id, []);
      ordersByEpisode.get(order.episode_id).push(order);
    }
    if (order.admission_id) {
      if (!ordersByAdmission.has(order.admission_id)) ordersByAdmission.set(order.admission_id, []);
      ordersByAdmission.get(order.admission_id).push(order);
    }
  }

  const records = [];
  let skipped = 0;

  for (const row of rows) {
    const cpoMonthLabel = formatCpoMonth(row.cpo_month);
    if (!cpoMonthLabel) {
      skipped += 1;
      continue;
    }

    // RCM1Service refuses to create a record without diagnosis codes.
    if (!hasDiagnosis(row)) {
      skipped += 1;
      continue;
    }

    const episodeOrders = ordersByEpisode.get(row.episode_id) || [];
    const admissionOrders = ordersByAdmission.get(row.admission_id) || episodeOrders;
    const hasSigned485 = episodeOrders.some(isSigned485);
    const episodeDays = daysBetween(row.soe, row.eoe);
    const isFirstCertification = firstEpisodeByAdmission.get(row.admission_id) === row.episode_id;

    const cpt = decideCpt({
      cpoMin: Number(row.cpo_min) || 0,
      episodeDays,
      hasSigned485,
      isFirstCertification,
    });

    if (!cpt) {
      skipped += 1;
      continue;
    }

    const amountCents = CPT_AMOUNTS_CENTS[cpt] ?? 0;
    // Eligibility snapshot for downstream audit (structured, not prose).
    const assessment = computeEpisodeAssessment(
      { eoe: row.eoe },
      episodeOrders,
      admissionOrders,
    );

    // Normalize the diagnosis-code list (jsonb array or object) for the audit.
    const diagnosisList = Array.isArray(row.diagnosis_codes)
      ? row.diagnosis_codes.filter((c) => c && String(c).trim())
      : row.diagnosis_codes && typeof row.diagnosis_codes === 'object'
        ? Object.values(row.diagnosis_codes).filter((c) => c && String(c).trim())
        : [];

    // Billing/supervising provider from the signed 485 order (if the extraction
    // captured it) — the audit's R1 checks these fields.
    const primaryOrder = episodeOrders.find(isSigned485) || episodeOrders[0] || {};
    const orderAdmin = primaryOrder.order_admission_details || {};
    const billingProvider = orderAdmin.billing_provider || {};
    const supervisingProvider = orderAdmin.supervising_provider || billingProvider;

    // CC notes generated by the AI service live on cpo_months.reason.ccNotes,
    // tagged data_tags.generated_by='ai_service' (never physician-signed). Carry
    // them onto the RCM payload so the audit's Rule 4 (CC-note QA) can read them.
    const cpoReason = row.cpo_reason || {};
    const ccNotes = Array.isArray(cpoReason.ccNotes)
      ? cpoReason.ccNotes.map((n, i) => ({
          id: n.id || `ccn-${i}`,
          noteType: n.noteType,
          noteText: n.noteText,
          minutes: Number(n.cpoMinutes ?? n.minutes ?? 0),
          data_tags: n.data_tags || { generated_by: 'ai_service' },
        }))
      : [];

    const personal = row.personal_information || {};
    const address = personal.address || {};

    // ── R2 patient/filter status + single-sourced completeness verdict ──
    // patient_status from ALL of this patient's episodes (latest EOE >= today).
    const patientEpisodes = episodesByPatient.get(row.patient_id) || [];
    const patientStatus = derivePatientStatus(patientEpisodes);
    // filter_status tier Billable > Pgbillable > Eligible > null, Active-gated.
    // POC has no separate PG-billable signal at this seam, so it mirrors the
    // 30-min CPO capture on this month (eligible episode + minutes >= 30).
    const isPgBillable = assessment.eligible && (Number(row.cpo_min) || 0) >= 30;
    const filterStatus = deriveFilterStatus({
      isBillable: assessment.billable,
      isPgBillable,
      isEligible: assessment.eligible,
      patientStatus,
    });
    // Single-sourced demographics completeness (fed to audit R1 instead of
    // re-deriving field-by-field) + CPO-month readiness surfaced for audit.
    const patientRow = patientRowByPatient.get(row.patient_id) || {};
    const dataComplete = isPatientDataComplete(patientRow);
    const cpoReadiness = evaluateCpoMonthReadiness({
      patient: patientRow,
      episodes: patientEpisodes,
      orders: admissionOrders,
      cpoMonth: cpoMonthLabel,
    });

    const payload = {
      cpt_code: cpt,
      cptCode: cpt,
      charge_dollars: amountCents / 100,
      dos_from: dateOnly(row.soe),
      dos_to: dateOnly(row.eoe),
      pos: '11',
      units: '1',
      cpo_min: Number(row.cpo_min) || 0,
      is_first_certification: isFirstCertification,
      has_signed_485: hasSigned485,
      episode_days: episodeDays,
      diagnosis_codes: diagnosisList,
      eligibility: assessment,
      // ── R2 status machine (BusinessRequirementsService ports) ──
      patient_status: patientStatus,
      filter_status: filterStatus,
      data_complete: dataComplete,
      cpo_month_readiness: cpoReadiness,
      // ── audit-compatible sub-objects (audit.normalizeRcmRow reads these) ──
      patient: {
        name: row.patient_name || null,
        dob: dateOnly(row.patient_dob),
        sex: row.patient_sex || null,
        address: address.street || address.line1 || null,
        state: address.state || null,
        zip: address.zip || address.postal_code || null,
        insurance_company: (row.insurance_details || {}).company || (row.insurance_details || {}).insurance_company || 'Medicare',
      },
      episode: {
        soc: dateOnly(row.soc),
        soe: dateOnly(row.soe),
        eoe: dateOnly(row.eoe),
      },
      agency: { name: row.agency_name || null, npi: row.agency_npi || null },
      providers: {
        billing_name: billingProvider.name || billingProvider.physician_name || null,
        billing_npi: billingProvider.NPI || billingProvider.npi || null,
        supervising_name: supervisingProvider.name || supervisingProvider.physician_name || null,
        supervising_npi: supervisingProvider.NPI || supervisingProvider.npi || null,
      },
      diagnoses: diagnosisList,
      ccNotes,
    };

    // Idempotent upsert keyed (episode_id, cpo_month, cpt_code) — matches the
    // UNIQUE index in db/migrations/004_rcm_pipeline.sql and RCM1Service's
    // replace-or-create composite-id upsert.
    const upserted = await sql`
      INSERT INTO rcm_records (agency_id, patient_id, episode_id, cpo_month, cpt_code, amount_cents, status, payload)
      VALUES (
        ${agencyId},
        ${row.patient_id},
        ${row.episode_id},
        ${cpoMonthLabel},
        ${cpt},
        ${amountCents},
        'generated',
        ${JSON.stringify(payload)}
      )
      ON CONFLICT (episode_id, cpo_month, cpt_code) DO UPDATE SET
        agency_id = EXCLUDED.agency_id,
        patient_id = EXCLUDED.patient_id,
        amount_cents = EXCLUDED.amount_cents,
        status = 'generated',
        payload = EXCLUDED.payload
      RETURNING id
    `;

    records.push({
      id: upserted[0].id,
      episodeId: row.episode_id,
      cpoMonth: cpoMonthLabel,
      cptCode: cpt,
      amountCents,
    });
  }

  return { ok: true, records, skipped };
}
