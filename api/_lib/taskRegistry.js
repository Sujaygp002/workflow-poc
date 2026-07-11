import {
  findHhahByName,
  findOrder,
  findOrderById,
  findPatient,
  findPatientUnit,
  gateDocumentsExist,
  gatePatientDataComplete,
  gateSignatureExists,
  insertAiExtraction,
  isOrderSigned,
  isRestartRewalk,
  loadEpisodeGateContext,
  makeEpisodeBillableClaimable,
  markOrderSignedByPhysician,
  markOrderSentToPhysician,
  rekeyAdmissionDates,
  rekeyEpisodeDates,
  syncOrderRowFromItem,
  updateItem,
  updateTask,
  updateCpoMinutes,
  writeAdmissionBundle,
  writeEpisodeBundle,
  writeOrderBundle,
  writePatientBundle,
} from './repositories.js';
import { extractMissingDataFromPdf } from './gemini.js';
import { GEMINI_MODEL } from './config.js';
import { sendEmail } from './mailer.js';
import { runHumanActions } from './builderCatalog.js';
import { cleanString, hasValue, normalizeNpi, safeJson } from './normalizers.js';
import { businessToday } from './clock.js';
import { checkUploadedToday } from './referenceLogic/agencyCheck.js';
import { extractWithPatterns } from './referenceLogic/extraction.js';
import { runAiService, runCcnService } from './referenceLogic/aiService.js';
import { generateRcm } from './referenceLogic/rcm.js';
import { auditRcm } from './referenceLogic/audit.js';
import { reworkAudits } from './referenceLogic/rework.js';

const REQUIRED_FIELDS = [
  ['patient.patient_info.name', (item) => item.patient_payload?.patient_info?.name],
  ['patient.patient_info.DOB', (item) => item.patient_payload?.patient_info?.DOB],
  ['patient.admission_details.MRN', (item) => item.patient_payload?.admission_details?.MRN],
  ['patient.patient_info.sex', (item) => item.patient_payload?.patient_info?.sex],
  ['patient.personal_information.address.street', (item) => item.patient_payload?.personal_information?.address?.street],
  ['patient.admission_details.HHAH.name', (item) => item.reference_payload?.HHAH?.name],
  ['patient.admission_details.SOC', (item) => item.patient_payload?.admission_details?.SOC],
  ['patient.admission_details.EOC', (item) => item.patient_payload?.admission_details?.EOC],
  ['patient.admission_details.SOE', (item) => item.patient_payload?.admission_details?.SOE],
  ['patient.admission_details.EOE', (item) => item.patient_payload?.admission_details?.EOE],
  ['order.order_info.order_number', (item) => item.order_payload?.order_info?.order_number],
  ['order.order_info.order_type', (item) => item.order_payload?.order_info?.order_type],
  ['order.order_info.order_date', (item) => item.order_payload?.order_info?.order_date],
];

function mergeDeep(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeDeep(out[key], value);
    } else if (value !== undefined && value !== null && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

// Strip HHAH from a references patch when the item carries the authenticated
// upload agency (stamped at bulk-upload start, data_tags.source = 'session_agency')
// — no downstream AI/human patch may reassign the agency.
function guardSessionHhah(item, referencesPatch) {
  const patch = referencesPatch || {};
  if (item.reference_payload?.HHAH?.data_tags?.source !== 'session_agency') return patch;
  const rest = { ...patch };
  delete rest.HHAH;
  return rest;
}

function missingFields(item) {
  return REQUIRED_FIELDS
    .filter(([, getter]) => !hasValue(getter(item)))
    .map(([field]) => field);
}

function setDecisions(item, patch) {
  return { ...(item.decisions || {}), ...patch };
}

function confidenceConfirmed(payload) {
  const next = structuredClone(payload || {});
  if (next.data_tags) {
    next.data_tags.validated_by = 'human';
    next.data_tags.confidence = 'confirmed';
  }
  return next;
}

function admissionDateValues(item) {
  return {
    SOC: item.patient_payload?.admission_details?.SOC,
    EOC: item.patient_payload?.admission_details?.EOC,
    SOE: item.patient_payload?.admission_details?.SOE,
    EOE: item.patient_payload?.admission_details?.EOE,
  };
}

function admissionDateDecisions(item) {
  const dates = admissionDateValues(item);
  const admissionReady = hasValue(dates.SOC);
  const episodeReady = hasValue(dates.SOE) && hasValue(dates.EOE);
  return {
    admission_dates_ready: admissionReady,
    admission_dates_missing: !admissionReady,
    episode_dates_ready: episodeReady,
    episode_dates_missing: !episodeReady,
  };
}

function syncOrderAdmissionDates(orderPayload, patientPayload) {
  const details = patientPayload?.admission_details || {};
  return mergeDeep(orderPayload, {
    order_admission_details: {
      SOC: details.SOC,
      EOC: details.EOC,
      SOE: details.SOE,
      EOE: details.EOE,
    },
  });
}

function orderPdfKey(value) {
  return cleanString(value).replace(/\.pdf$/i, '').toLowerCase();
}

function findPdfForOrder(item, context) {
  const orderNumber = orderPdfKey(item.order_payload?.order_info?.order_number);
  if (!orderNumber) return context?.pdfs?.[0] || null;
  return context?.pdfsByOrderNumber?.[orderNumber]
    || (context?.pdfs || []).find((pdf) => orderPdfKey(pdf.fileName) === orderNumber)
    || null;
}

// Multi-signal PDF ↔ order matching (Milestone A). Decides how confidently the
// attached PDF belongs to THIS workbook row, in priority order:
//   1. filename  — the attached pdf.fileName's order number equals the workbook
//                  order number (the upload's default filename match).
//   2. order_number_text — an order-number token found in the extracted PDF text
//                  cross-checks to the workbook order number.
//   3. patient_date — the patient name AND order date both appear in the PDF text
//                  (heuristic used only when there is no order-number signal).
// No confident signal (and a PDF is present) → 'ambiguous' → the caller stamps
// decisions.pdf_match_ambiguous and routes the human 'Confirm order document'
// action. When no PDF is attached at all we do NOT flag ambiguity (many rows
// legitimately carry no order document).
function matchPdfForItem(item, pdfText) {
  const workbookOrderNo = orderPdfKey(item.order_payload?.order_info?.order_number);
  const pdf = item.extraction_payload?.pdf || {};
  const hasPdf = hasValue(pdf.blobUrl) || hasValue(pdfText);
  if (!hasPdf) return { match: 'none', ambiguous: false };

  // 1. filename match (the bulk-upload default): the attached file's name key
  // equals the workbook order number.
  const fileKey = orderPdfKey(pdf.fileName);
  if (workbookOrderNo && fileKey && fileKey === workbookOrderNo) {
    return { match: 'filename', ambiguous: false };
  }

  const text = String(pdfText || '');
  if (text) {
    // 2. order-number token in the PDF text cross-checked to the workbook order no.
    if (workbookOrderNo) {
      const re = new RegExp(`\\b${workbookOrderNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) return { match: 'order_number_text', ambiguous: false };
    }
    // 3. patient-name + order-date heuristic (no order-number signal available).
    const name = cleanString(item.patient_payload?.patient_info?.name);
    const orderDate = cleanString(item.order_payload?.order_info?.order_date);
    const nameHit = name && text.toLowerCase().includes(name.toLowerCase());
    const dateHit = orderDate && text.includes(orderDate);
    if (nameHit && dateHit) return { match: 'patient_date', ambiguous: false };
  }

  // A PDF is attached but no signal confirms it belongs to this row → ambiguous.
  return { match: 'ambiguous', ambiguous: true };
}

async function checkAllReferences(item) {
  const hhah = await findHhahByName(item.reference_payload?.HHAH?.name);
  return { hhah };
}

async function markReferenceDecisions(item) {
  const refs = await checkAllReferences(item);
  const decisions = setDecisions(item, {
    hhah_exists: !!refs.hhah,
    hhah_not_exists: !refs.hhah,
    upload_context_ready: true,
  });
  await updateItem(item.id, { decisions });
  return { refs, decisions };
}

async function evaluateCompleteness(item) {
  const missing = missingFields(item);
  const decisions = setDecisions(item, {
    excel_row_complete: missing.length === 0,
    excel_row_incomplete: missing.length > 0,
  });
  await updateItem(item.id, { decisions });
  return {
    missing,
    complete: missing.length === 0,
  };
}

// "Patient exists" (per complex.drawio) means the PERSON exists — i.e. the
// stable Patient Unit (name + DOB + MRN) is already in the system. The Record
// context (Unit + HHAH + PG) is evaluated separately to drive con1/con2.
async function evaluatePatientExistence(item) {
  const unit = await findPatientUnit(item.patient_payload);
  const record = await findPatient(item.patient_payload, item.reference_payload);
  const decisions = setDecisions(item, {
    patient_exists: !!unit,
    patient_not_exists: !unit,
    unit_exists: !!unit,
    unit_not_exists: !unit,
    record_exists: !!record,
  });
  await updateItem(item.id, { decisions });
  return { unit, record };
}

// When the patient (unit) exists, decide what changed:
//   con1 — no Record for this HHAH/PG context yet → a NEW record is created.
//   con2 — a Record for this context already exists → only unit fields changed,
//          so the existing unit/record is updated.
async function evaluateRecordChanges(item) {
  if (item.decisions?.patient_exists === false || item.decisions?.patient_not_exists === true) {
    const decisions = setDecisions(item, {
      record_context_changed: false,
      unit_only_changed: false,
    });
    await updateItem(item.id, { decisions });
    return null;
  }
  const record = await findPatient(item.patient_payload, item.reference_payload);
  const decisions = setDecisions(item, {
    record_context_changed: !record,
    unit_only_changed: !!record,
  });
  await updateItem(item.id, { decisions });
  return record;
}

const ORDER_REQUIRED_FIELDS = [
  ['order.order_info.order_number', (item) => item.order_payload?.order_info?.order_number],
  ['order.order_info.order_type', (item) => item.order_payload?.order_info?.order_type],
  ['order.order_info.order_date', (item) => item.order_payload?.order_info?.order_date],
];

function missingOrderFields(item) {
  return ORDER_REQUIRED_FIELDS
    .filter(([, getter]) => !hasValue(getter(item)))
    .map(([field]) => field);
}

// The matched PDF (filename without .pdf == order_number) is required before an
// order can be created.
function orderHasMatchedPdf(item) {
  return hasValue(item.extraction_payload?.pdf?.fileName)
    || hasValue(item.extraction_payload?.pdf?.blobUrl)
    || hasValue(item.extraction_payload?.pdfBlobUrl);
}

async function evaluateOrderExistence(item) {
  const existing = await findOrder(item.order_payload?.order_info?.order_number);
  const decisions = setDecisions(item, {
    order_exists: !!existing,
    order_not_exists: !existing,
  });
  await updateItem(item.id, { decisions });
  return existing;
}

async function runPatientWrite(item, retry) {
  try {
    const recordBefore = await findPatient(item.patient_payload, item.reference_payload);
    const bundle = await writePatientBundle(item);
    const recordCreated = item.decisions?.patient_not_exists === true
      || item.decisions?.record_context_changed === true
      || !recordBefore;
    const recordDecisions = {
      record_created: recordCreated,
      record_updated: !recordCreated,
    };
    const decisions = setDecisions(item, retry
      ? { patient_retry_success: true, patient_retry_fail: false, patient_write_fail: false, ...recordDecisions }
      : { patient_write_success: true, patient_write_fail: false, ...recordDecisions });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        patientBundle: {
          unitId: bundle.unit?.id,
          patientId: bundle.patient?.id,
        },
      },
    });
    return { ok: true, bundle };
  } catch (error) {
    const decisions = setDecisions(item, retry
      ? { patient_retry_success: false, patient_retry_fail: true }
      : { patient_write_success: false, patient_write_fail: true });
    await updateItem(item.id, { decisions, errorMessage: error.message });
    return { ok: false, error: error.message };
  }
}

async function runOrderWrite(item, retry) {
  try {
    const patientBundle = item.extraction_payload?.patientBundle
      ? {
          patient: { id: item.extraction_payload.patientBundle.patientId },
          admission: { id: item.extraction_payload.patientBundle.admissionId },
          episode: { id: item.extraction_payload.patientBundle.episodeId },
        }
      : null;
    const { order, skipped } = await writeOrderBundle(item, patientBundle);
    const decisions = setDecisions(item, retry
      ? { order_retry_success: true, order_retry_fail: false, order_write_fail: false, order_skipped_duplicate: skipped }
      : { order_write_success: true, order_write_fail: false, order_skipped_duplicate: skipped });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        orderId: order?.id,
        orderSkipped: skipped,
      },
    });
    return { ok: true, order, output: { orderId: order?.id, skipped } };
  } catch (error) {
    const decisions = setDecisions(item, retry
      ? { order_retry_success: false, order_retry_fail: true }
      : { order_write_success: false, order_write_fail: true });
    await updateItem(item.id, { decisions, errorMessage: error.message });
    return { ok: false, error: error.message };
  }
}

// Milestone B — the audit-cycle pass target: audit_pass_98 = passRate >= 0.98.
const AUDIT_PASS_THRESHOLD = 0.98;

// Milestone B — ONE bounded audit -> rework -> re-audit cycle. Orchestrated here
// (not inside a referenceLogic module) so the audit.js <-> rework.js circular
// import is avoided — this is the single place that imports both. auditRcm writes
// one audit_records row per rcm_record; reworkAudits fixes fixable findings and
// re-audits internally (its own bounded inner loop, now bounded by `maxCycles`);
// a final auditRcm computes the definitive passRate over the agency's records.
// A run with zero RCM records is a vacuous pass (passRate 1) — nothing to audit
// should not stall the tail.
async function runAuditCycle(item, maxCycles) {
  const initial = await auditRcm({ item });
  if (initial.ok === false) {
    return { passRate: 0, passed: 0, failed: 0, total: 0, cycles: 0, fixed: 0, error: initial.error || 'audit_failed' };
  }
  const rework = await reworkAudits({ item, maxCycles });
  const final = await auditRcm({ item });
  const passed = (final.passed || []).length;
  const failed = (final.failed || []).length;
  const total = passed + failed;
  const passRate = total === 0 ? 1 : passed / total;
  return { passRate, passed, failed, total, cycles: rework.cycles || 0, fixed: rework.fixed || 0, error: null };
}

export async function evaluateCondition(condition, item) {
  if (!condition) return true;
  const known = item.decisions || {};
  if (known[condition] !== undefined) return known[condition] === true;

  if (condition === 'patient_exists' || condition === 'patient_not_exists'
    || condition === 'unit_exists' || condition === 'unit_not_exists') {
    const { unit } = await evaluatePatientExistence(item);
    if (condition === 'patient_exists' || condition === 'unit_exists') return !!unit;
    return !unit;
  }
  if (condition === 'record_context_changed' || condition === 'unit_only_changed') {
    const record = await evaluateRecordChanges(item);
    return condition === 'record_context_changed' ? !record : !!record;
  }
  if (condition === 'order_fields_ready' || condition === 'order_fields_missing') {
    const ready = missingOrderFields(item).length === 0 && orderHasMatchedPdf(item);
    const decisions = setDecisions(item, { order_fields_ready: ready, order_fields_missing: !ready });
    await updateItem(item.id, { decisions });
    return condition === 'order_fields_ready' ? ready : !ready;
  }
  if (condition === 'order_exists' || condition === 'order_not_exists') {
    const existing = await evaluateOrderExistence(item);
    return condition === 'order_exists' ? !!existing : !existing;
  }
  if (condition === 'admission_dates_ready' || condition === 'admission_dates_missing' || condition === 'episode_dates_ready' || condition === 'episode_dates_missing') {
    const decisions = setDecisions(item, admissionDateDecisions(item));
    await updateItem(item.id, { decisions });
    return decisions[condition] === true;
  }
  if (condition === 'upload_context_ready') {
    const decisions = setDecisions(item, { upload_context_ready: true });
    await updateItem(item.id, { decisions });
    return true;
  }
  // Area monitor conditions: upload_received / upload_missing / notification_sent
  // are driven by actual area state.
  if (condition === 'upload_received_within_24h') return item.decisions?.upload_received_within_24h === true;
  if (condition === 'upload_missing_after_24h') return item.decisions?.upload_missing_after_24h === true;
  if (condition === 'notification_sent') return item.decisions?.notification_sent === true;
  if (condition.startsWith('hhah_')) {
    const { decisions } = await markReferenceDecisions(item);
    return decisions[condition] === true;
  }
  if (['document_ready_for_signing', 'document_not_ready_for_signing', 'physician_signed', 'physician_signature_missing', 'signed_within_48h', 'signing_overdue'].includes(condition)) {
    const known = item.decisions || {};
    return known[condition] === true;
  }
  if ([
    'patient_eligible',
    'patient_not_eligible',
    'patient_billable',
    'patient_not_billable',
    'physician_signature_missing',
    'cpo_month_billable',
    'cpo_month_not_billable',
  ].includes(condition)) {
    const known = item.decisions || {};
    return known[condition] === true;
  }

  // Daily Agency Intake -> RCM Pipeline decision-driven conditions. Each is
  // stamped onto item.decisions by its preceding system task (checkUploadedToday,
  // ai.runService, ai.audit) before the condition step evaluates.
  if ([
    'agency_uploaded',
    'agency_not_uploaded',
    'ai_service_failed',
    'ai_service_ok',
    'audit_failed',
    'audit_passed',
  ].includes(condition)) {
    const known = item.decisions || {};
    return known[condition] === true;
  }

  // Post-model billing gates (Milestone A). Each is pre-stamped onto item.decisions
  // by its preceding gate system step (gate.checkEpisodeEligibility, etc.) before
  // the condition step evaluates — same read-only passthrough as the RCM gates.
  if ([
    'episode_eligible',
    'episode_not_eligible',
    'documents_exist',
    'documents_missing',
    'patient_data_complete',
    'patient_data_incomplete',
    'signature_exists',
    'signature_missing',
  ].includes(condition)) {
    const known = item.decisions || {};
    return known[condition] === true;
  }

  // CCN + audit/submit tail (Milestone B). Each is pre-stamped onto item.decisions
  // by its preceding system step (ccn.runService, audit.runCycle / audit.reAudit)
  // before the condition step evaluates — same read-only passthrough.
  if ([
    'ccn_failed',
    'ccn_ok',
    'audit_pass_98',
    'audit_pass_below_98',
  ].includes(condition)) {
    const known = item.decisions || {};
    return known[condition] === true;
  }

  return false;
}

export const taskRegistry = {
  'excel.parseWorkbook': async ({ item }) => ({
    ok: true,
    output: {
      patientKey: item.patient_key,
      orderKey: item.order_key,
      sourceRows: item.extraction_payload?.sourceRows || {},
    },
  }),

  'row.checkCompleteness': async ({ item }) => {
    const result = await evaluateCompleteness(item);
    return { ok: true, output: result };
  },

  'ai.extractMissingDataFromPdf': async ({ item, context }) => {
    const missing = missingFields(item);
    const pdf = findPdfForOrder(item, context);
    try {
      const result = await extractMissingDataFromPdf({
        pdfBuffer: pdf?.buffer || null,
        missingFields: missing,
        currentPayload: {
          patient: item.patient_payload,
          order: item.order_payload,
          references: item.reference_payload,
        },
      });
      if (!result.ok) {
        await insertAiExtraction({
          itemId: item.id,
          documentId: pdf?.document?.id,
          model: result.model,
          status: 'skipped',
          inputSummary: { missing },
          outputData: {},
          errorMessage: result.error,
        });
        const decisions = setDecisions(item, { ai_extraction_success: false, ai_extraction_fail: true });
        await updateItem(item.id, { decisions });
        return { ok: true, output: result };
      }

      const patientPatch = result.data?.patient || {};
      const orderPatch = result.data?.order || {};
      // The authenticated upload agency is authoritative — never let a
      // PDF-extracted agency name overwrite it (see guardSessionHhah).
      const referencePatch = guardSessionHhah(item, {
        practitioner: result.data?.practitioner || {},
        PG: result.data?.PG || {},
        HHAH: result.data?.HHAH || {},
      });
      const patientPayload = mergeDeep(item.patient_payload, {
        patient_info: {
          name: patientPatch.name,
          sex: patientPatch.sex,
          DOB: patientPatch.DOB,
        },
        personal_information: {
          address: { street: patientPatch.address },
        },
        admission_details: {
          MRN: patientPatch.MRN,
          SOC: patientPatch.SOC,
          EOC: patientPatch.EOC,
          SOE: patientPatch.SOE,
          EOE: patientPatch.EOE,
          diagnosis_codes: patientPatch.diagnosis_codes,
        },
      });
      const orderPayload = mergeDeep(item.order_payload, {
        order_info: {
          order_number: orderPatch.order_number,
          order_type: orderPatch.order_type,
          order_date: orderPatch.order_date,
        },
        order_status: {
          SignedByPhyscianDate: orderPatch.signed_date,
          SignedByPhysician_Status: !!orderPatch.signed_date,
        },
        order_admission_details: {
          billing_provider: {
            NPI: orderPatch.NPI,
          },
        },
      });
      const referencePayload = mergeDeep(item.reference_payload, referencePatch);
      const decisions = setDecisions(item, { ai_extraction_success: true, ai_extraction_fail: false });
      await insertAiExtraction({
        itemId: item.id,
        documentId: pdf?.document?.id,
        model: result.model,
        status: 'completed',
        inputSummary: { missing },
        outputData: result.data,
      });
      await updateItem(item.id, {
        patientPayload,
        orderPayload,
        referencePayload,
        extractionPayload: {
          ...(item.extraction_payload || {}),
          ai: result.data,
        },
        decisions,
      });
      return { ok: true, output: result.data };
    } catch (error) {
      const decisions = setDecisions(item, { ai_extraction_success: false, ai_extraction_fail: true });
      await insertAiExtraction({
        itemId: item.id,
        documentId: pdf?.document?.id,
        model: GEMINI_MODEL,
        status: 'failed',
        inputSummary: { missing },
        outputData: {},
        errorMessage: error.message,
      });
      await updateItem(item.id, { decisions });
      return { ok: true, output: { error: error.message } };
    }
  },

  'refs.confirmUploadContext': async ({ item }) => {
    const decisions = setDecisions(item, { upload_context_ready: true });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        hhahName: item.reference_payload?.HHAH?.name || null,
        uploadContextReady: true,
      },
    };
  },

  'dates.checkAdmission': async ({ item }) => {
    const dateDecisions = admissionDateDecisions(item);
    const decisions = setDecisions(item, dateDecisions);
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        SOC: item.patient_payload?.admission_details?.SOC || null,
        EOC: item.patient_payload?.admission_details?.EOC || null,
        ready: dateDecisions.admission_dates_ready,
      },
    };
  },

  'dates.checkEpisode': async ({ item }) => {
    const dateDecisions = admissionDateDecisions(item);
    const decisions = setDecisions(item, dateDecisions);
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        SOE: item.patient_payload?.admission_details?.SOE || null,
        EOE: item.patient_payload?.admission_details?.EOE || null,
        ready: dateDecisions.episode_dates_ready,
      },
    };
  },

  // Check if the patient (the PERSON = Patient Unit by name|DOB|MRN) exists.
  // Also notes whether a Record for this HHAH/PG context already exists, used to
  // drive the con1/con2 sub-decision when the patient is found.
  'patient.resolve': async ({ item }) => {
    const { unit, record } = await evaluatePatientExistence(item);
    return {
      ok: true,
      output: {
        unitId: unit?.id || null,
        recordExists: !!record,
        action: unit ? 'exists' : 'create',
        unitKey: item.patient_key,
      },
    };
  },

  // Patient exists → decide what changed (con1: HHAH/PG/practitioner → new
  // record; con2: only unit fields → update unit).
  'record.checkChanges': async ({ item }) => {
    const record = await evaluateRecordChanges(item);
    return {
      ok: true,
      output: {
        branch: record ? 'con2_unit_only' : 'con1_new_record',
        hhah: item.reference_payload?.HHAH?.name || null,
        pg: item.reference_payload?.PG?.name || null,
      },
    };
  },

  // New patient: writes the stable Patient Unit + a Patient Record.
  'patient.create': async ({ item }) => runPatientWrite(item, false),
  // con1: a NEW Patient Record under the existing Unit (changed HHAH/PG/pract).
  'record.create': async ({ item }) => runPatientWrite(item, false),
  // con2: update the existing Patient Unit/Record (only unit fields changed).
  'patient.update': async ({ item }) => runPatientWrite(item, false),
  'patient.retryWrite': async ({ item }) => runPatientWrite(item, true),

  // Admission: matched by patient + Start of Care. The patient bundle write
  // happens after the admission-date gate so missing dates can be fixed before
  // any admission row is written.
  'admission.resolve': async ({ item }) => {
    const bundle = item.extraction_payload?.patientBundle || {};
    const patientId = bundle.patientId || (await findPatient(item.patient_payload, item.reference_payload))?.id || null;
    // Restart re-walk: corrected dates must RE-KEY the same admission row (a
    // find-or-create with new dates would fork a duplicate and strand the order).
    let admission = null;
    let existed = false;
    if (isRestartRewalk(item) && bundle.admissionId) {
      admission = await rekeyAdmissionDates(item, bundle.admissionId);
      if (admission) existed = true;
    }
    if (!admission) {
      ({ admission, existed } = await writeAdmissionBundle(item, patientId));
    }
    const admissionId = admission?.id || null;
    const decisions = setDecisions(item, {
      admission_ready: !!admissionId,
      admission_exists: !!admissionId && existed,
      admission_created: !!admissionId && !existed,
    });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        patientBundle: {
          ...bundle,
          patientId,
          admissionId,
        },
      },
    });
    return { ok: !!admissionId, output: { admissionId, soc: item.patient_payload?.admission_details?.SOC, action: existed ? 'reused' : 'created' } };
  },

  // Episode: matched within the admission by SOE/EOE — reused if it exists, else
  // a new episode is created and the order will attach to it.
  'episode.resolve': async ({ item }) => {
    const bundle = item.extraction_payload?.patientBundle || {};
    // Restart re-walk: corrected dates re-key the SAME episode row so the
    // existing order stays attached (see admission.resolve).
    let episode = null;
    let existed = false;
    if (isRestartRewalk(item) && bundle.episodeId) {
      episode = await rekeyEpisodeDates(item, bundle.episodeId);
      if (episode) existed = true;
    }
    if (!episode) {
      ({ episode, existed } = await writeEpisodeBundle(item, bundle.admissionId));
    }
    const episodeId = episode?.id || null;
    const decisions = setDecisions(item, {
      episode_ready: !!episodeId,
      episode_exists: !!episodeId && existed,
      episode_created: !!episodeId && !existed,
    });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        patientBundle: {
          ...bundle,
          episodeId,
        },
      },
    });
    return {
      ok: !!episodeId,
      output: {
        episodeId,
        soe: item.patient_payload?.admission_details?.SOE,
        eoe: item.patient_payload?.admission_details?.EOE,
        action: existed ? 'reused' : 'created',
      },
    };
  },

  // Gate before order create: required order fields + the matched PDF must be
  // present. Missing → routes to human.fixOrderFields.
  'order.checkFields': async ({ item }) => {
    const missing = missingOrderFields(item);
    const hasPdf = orderHasMatchedPdf(item);
    const ready = missing.length === 0 && hasPdf;
    const decisions = setDecisions(item, {
      order_fields_ready: ready,
      order_fields_missing: !ready,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { ready, missing, hasPdf } };
  },

  'human.fixOrderFields': async ({ item, payload }) => {
    const orderPayload = payload?.order ? mergeDeep(item.order_payload, payload.order) : item.order_payload;
    const extractionPayload = payload?.pdf
      ? mergeDeep(item.extraction_payload, { pdf: payload.pdf })
      : item.extraction_payload;
    const patched = { ...item, order_payload: orderPayload, extraction_payload: extractionPayload };
    const missing = missingOrderFields(patched);
    const hasPdf = orderHasMatchedPdf(patched);
    const ready = missing.length === 0 && hasPdf;
    const decisions = setDecisions(item, {
      order_fields_ready: ready,
      order_fields_missing: !ready,
    });
    await updateItem(item.id, { orderPayload, extractionPayload, decisions });
    return { ok: ready, output: { ready, missing, hasPdf } };
  },

  // Duplicate order number: do not write anything. The existing order is left
  // untouched; the row is marked as a skipped duplicate. EXCEPTION — on a
  // review-failed restart re-walk the worker's corrections must reach the
  // persisted order row (fields + re-attachment), else the review loops on
  // the same bad order forever.
  'order.skipDuplicate': async ({ item }) => {
    let existing = await findOrder(item.order_payload?.order_info?.order_number);
    let corrected = false;
    if (existing && isRestartRewalk(item)) {
      const synced = await syncOrderRowFromItem(item);
      if (synced) {
        existing = synced;
        corrected = true;
      }
    }
    const decisions = setDecisions(item, {
      order_skipped_duplicate: true,
      order_write_success: false,
    });
    await updateItem(item.id, {
      decisions,
      extractionPayload: { ...(item.extraction_payload || {}), orderId: existing?.id || null, orderSkipped: true },
    });
    return { ok: true, output: { skipped: true, existingOrderId: existing?.id || null, corrected } };
  },

  'order.create': async ({ item }) => runOrderWrite(item, false),
  'order.retryWrite': async ({ item }) => runOrderWrite(item, true),

  'human.validateExtractedData': async ({ item, payload }) => {
    const decisions = setDecisions(item, { human_data_validated: true });
    await updateItem(item.id, {
      patientPayload: confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {})),
      orderPayload: confidenceConfirmed(mergeDeep(item.order_payload, payload?.order || {})),
      referencePayload: mergeDeep(item.reference_payload, guardSessionHhah(item, payload?.references)),
      decisions,
    });
    return { ok: true, output: { validated: true } };
  },

  'human.fillMissingData': async ({ item, payload }) => {
    const decisions = setDecisions(item, { human_data_validated: true });
    await updateItem(item.id, {
      patientPayload: confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {})),
      orderPayload: confidenceConfirmed(mergeDeep(item.order_payload, payload?.order || {})),
      referencePayload: mergeDeep(item.reference_payload, guardSessionHhah(item, payload?.references)),
      decisions,
    });
    return { ok: true, output: { filled: true } };
  },

  'human.fillAdmissionDates': async ({ item, payload }) => {
    const patientPayload = confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {}));
    const orderPayload = syncOrderAdmissionDates(item.order_payload, patientPayload);
    const dateDecisions = admissionDateDecisions({ ...item, patient_payload: patientPayload });
    const decisions = setDecisions(item, dateDecisions);
    await updateItem(item.id, { patientPayload, orderPayload, decisions });
    return { ok: dateDecisions.admission_dates_ready, output: { filled: true, ...dateDecisions } };
  },

  'human.fillEpisodeDates': async ({ item, payload }) => {
    const patientPayload = confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {}));
    const orderPayload = syncOrderAdmissionDates(item.order_payload, patientPayload);
    const dateDecisions = admissionDateDecisions({ ...item, patient_payload: patientPayload });
    const decisions = setDecisions(item, dateDecisions);
    await updateItem(item.id, { patientPayload, orderPayload, decisions });
    return { ok: dateDecisions.episode_dates_ready, output: { filled: true, ...dateDecisions } };
  },

  'human.fixPatientWrite': async ({ item, payload }) => {
    const patched = payload?.patient ? mergeDeep(item.patient_payload, payload.patient) : item.patient_payload;
    await updateItem(item.id, { patientPayload: patched });
    return runPatientWrite({ ...item, patient_payload: patched }, true);
  },

  'human.fixOrderWrite': async ({ item, payload }) => {
    const patched = payload?.order ? mergeDeep(item.order_payload, payload.order) : item.order_payload;
    await updateItem(item.id, { orderPayload: patched });
    return runOrderWrite({ ...item, order_payload: patched }, true);
  },

  'human.reviewRecord': async ({ item }) => {
    await updateItem(item.id, {
      status: 'completed',
      decisions: setDecisions(item, { record_reviewed: true }),
    });
    return { ok: true, output: { reviewed: true } };
  },

  // Builder task node: an employee-assigned checklist of catalog actions.
  // Validates every action's submitted result first; any failure returns a
  // retryable error map (the engine keeps the task active/Processing and the
  // API responds 400 with per-action messages). On success each action's
  // execute() runs (email send, date merge, order stamp — existing fns).
  'human.performActions': async ({ item, task, step, payload }) => {
    const actions = Array.isArray(task?.actions) && task.actions.length
      ? task.actions
      : (step?.actions || []);
    const results = payload?.actionResults || {};
    const { errors, outputs } = await runHumanActions({ actions, results, item });
    if (Object.keys(errors).length) {
      return { ok: false, retry: true, actionErrors: errors, error: 'Action validation failed' };
    }
    if (task?.id) {
      await updateTask(task.id, { actionState: outputs });
    }
    // A failed record review completes THIS task but restarts the whole item
    // from step 1 — the engine (completeHumanTask) resets every task row and
    // clears decisions via restartItemFromTop when restartItem is set.
    const failedReview = Object.values(outputs).find((output) => output && output.review === 'failed');
    return {
      ok: true,
      ...(failedReview ? { restartItem: true, restartNote: failedReview.note || null } : {}),
      output: { actionResults: results, actionOutputs: outputs },
    };
  },

  'signing.reviewReadiness': async ({ item }) => {
    const hasOrderNumber = hasValue(item.order_payload?.order_info?.order_number);
    const hasPdf = hasValue(item.extraction_payload?.pdf?.blobUrl) || hasValue(item.extraction_payload?.pdfBlobUrl);
    const ready = hasOrderNumber && hasPdf;
    const decisions = setDecisions(item, {
      document_ready_for_signing: ready,
      document_not_ready_for_signing: !ready,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { ready, hasOrderNumber, hasPdf } };
  },

  'signing.fixDocument': async ({ item, payload }) => {
    const orderPayload = payload?.order ? mergeDeep(item.order_payload, payload.order) : item.order_payload;
    const extractionPayload = payload?.pdf
      ? mergeDeep(item.extraction_payload, { pdf: payload.pdf })
      : item.extraction_payload;
    const ready = hasValue(orderPayload?.order_info?.order_number)
      && (hasValue(extractionPayload?.pdf?.blobUrl) || hasValue(extractionPayload?.pdfBlobUrl));
    const decisions = setDecisions(item, {
      document_ready_for_signing: ready,
      document_not_ready_for_signing: !ready,
    });
    await updateItem(item.id, { orderPayload, extractionPayload, decisions });
    return { ok: ready, output: { ready } };
  },

  'signing.sendToPhysician': async ({ item }) => {
    const date = await businessToday(); // SIM: send date follows the business clock
    const orderId = item.extraction_payload?.orderId;
    if (orderId) await markOrderSentToPhysician(orderId, date);
    const orderPayload = mergeDeep(item.order_payload, {
      order_status: {
        SentToPhysicianDate: date,
        SendToPhysician_Status: true,
      },
    });
    const decisions = setDecisions(item, {
      signing_sent_to_physician: true,
      signing_sent_at: date,
    });
    await updateItem(item.id, { orderPayload, decisions });
    return { ok: true, output: { sent: true, orderId, SentToPhysicianDate: date } };
  },

  // SYSTEM auto-send for the signature gate: mark EVERY unsigned order on the
  // item's episode 'sent to the physician portal' (SentToPhysicianDate +
  // SendToPhysician_Status), so they appear in the PG portal's Bulk Sign list
  // (/pg-login) for the physician to sign. The signature gate is re-evaluated
  // by the next daily run / auto-resolver once signing happens.
  'signing.sendEpisodeOrdersToPhysician': async ({ item }) => {
    const date = await businessToday(); // SIM: send date follows the business clock
    const ctx = await loadEpisodeGateContext(item);
    const unsigned = ctx ? ctx.episodeOrders.filter((order) => !isOrderSigned(order)) : [];
    const sentOrderNumbers = [];
    for (const order of unsigned) {
      await markOrderSentToPhysician(order.id, date);
      sentOrderNumbers.push(order.order_number || order.id);
    }
    const decisions = setDecisions(item, {
      signing_sent_to_physician: sentOrderNumbers.length > 0,
      signing_sent_at: date,
    });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        sent_to_physician_portal: sentOrderNumbers.length,
        orderNumbers: sentOrderNumbers,
        portal: '/pg-login',
        SentToPhysicianDate: date,
      },
    };
  },

  'signing.checkSigned': async ({ item }) => {
    const persisted = await findOrderById(item.extraction_payload?.orderId);
    const signed = isOrderSigned({ order_status: item.order_payload?.order_status || {} }) || (persisted ? isOrderSigned(persisted) : false);
    const decisions = setDecisions(item, {
      physician_signed: signed,
      physician_signature_missing: !signed,
      signed_within_48h: signed,
      signing_overdue: !signed,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { physicianSigned: signed } };
  },

  'signing.updateOrderSigned': async ({ item }) => {
    const date = await businessToday(); // SIM: signed date fallback follows the business clock
    if (item.extraction_payload?.orderId) {
      await markOrderSignedByPhysician(item.extraction_payload.orderId, item.order_payload?.order_status?.SignedByPhyscianDate || date);
    }
    const orderPayload = mergeDeep(item.order_payload, {
      order_status: {
        SignedByPhyscianDate: item.order_payload?.order_status?.SignedByPhyscianDate || date,
        SignedByPhysician_Status: true,
      },
    });
    await updateItem(item.id, { orderPayload, decisions: setDecisions(item, { signing_status_updated: true }) });
    return { ok: true, output: { orderStatus: 'signed' } };
  },

  'signing.emailPhysicianReminder': async ({ item, payload }) => {
    const recipient = payload?.recipient
      || item.reference_payload?.practitioner?.contact_info?.email
      || item.reference_payload?.practitioner?.email
      || '';
    const orderNumber = item.order_payload?.order_info?.order_number || item.order_key || 'the order document';
    const subject = payload?.subject || 'Signature required for order document';
    const text = payload?.notes || `Please sign ${orderNumber}.`;
    const mail = await sendEmail({ to: recipient, subject, text });
    await updateItem(item.id, { decisions: setDecisions(item, { physician_reminder_email_sent: true }) });
    return {
      ok: true,
      output: {
        email_sent: mail.sent,
        email_skipped: mail.skipped || false,
        email_reason: mail.reason || null,
        recipient,
        orderNumber,
      },
    };
  },

  'billing.checkPatientEligible': async ({ item }) => {
    const eligible = item.extraction_payload?.eligible === true;
    await updateItem(item.id, {
      decisions: setDecisions(item, {
        patient_eligible: eligible,
        patient_not_eligible: !eligible,
      }),
    });
    return { ok: true, output: { eligible } };
  },

  'billing.sendHhahMissingDocumentEmail': async ({ item, payload }) => {
    const hhah = item.reference_payload?.HHAH || {};
    const missing = item.extraction_payload?.missingDocuments || [];
    const recipient = payload?.recipient || hhah.contact_info?.email || hhah.email || '';
    const subject = payload?.subject || 'Missing document required for billing';
    const text = payload?.notes
      || `Please send the missing document(s): ${missing.join(', ') || '485/F2F document'}.`;
    const mail = await sendEmail({ to: recipient, subject, text });
    await updateItem(item.id, {
      decisions: setDecisions(item, { hhah_missing_document_email_sent: true }),
    });
    return {
      ok: true,
      output: {
        email_sent: mail.sent,
        email_skipped: mail.skipped || false,
        email_reason: mail.reason || null,
        recipient,
        missingDocuments: missing,
      },
    };
  },

  'billing.checkPatientBillable': async ({ item }) => {
    const billable = item.extraction_payload?.billable === true;
    await updateItem(item.id, {
      decisions: setDecisions(item, {
        patient_billable: billable,
        patient_not_billable: !billable,
      }),
    });
    return { ok: true, output: { billable } };
  },

  'billing.checkSignatureMissing': async ({ item }) => {
    const missing = Array.isArray(item.extraction_payload?.unsignedOrderNumbers)
      && item.extraction_payload.unsignedOrderNumbers.length > 0;
    await updateItem(item.id, {
      decisions: setDecisions(item, { physician_signature_missing: missing }),
    });
    return { ok: true, output: { physicianSignatureMissing: missing } };
  },

  'billing.sendPhysicianReminder': async ({ item, payload }) => {
    const recipient = payload?.recipient
      || item.reference_payload?.practitioner?.contact_info?.email
      || item.reference_payload?.practitioner?.email
      || '';
    const unsigned = item.extraction_payload?.unsignedOrderNumbers || [];
    const subject = payload?.subject || 'Signature required for CPO billing';
    const text = payload?.notes
      || `Please sign the following order document(s): ${unsigned.join(', ') || 'unsigned orders'}.`;
    const mail = await sendEmail({ to: recipient, subject, text });
    await updateItem(item.id, {
      decisions: setDecisions(item, { physician_reminder_email_sent: true }),
    });
    return {
      ok: true,
      output: {
        email_sent: mail.sent,
        email_skipped: mail.skipped || false,
        email_reason: mail.reason || null,
        recipient,
        unsignedOrderNumbers: unsigned,
      },
    };
  },

  'billing.checkCpoMonthBillable': async ({ item }) => {
    const billable = item.extraction_payload?.cpoMonthBillable === true;
    await updateItem(item.id, {
      decisions: setDecisions(item, {
        cpo_month_billable: billable,
        cpo_month_not_billable: !billable,
      }),
    });
    return { ok: true, output: { cpoMonthBillable: billable } };
  },

  'billing.addCpoMinutes': async ({ item, payload }) => {
    const cpoMonthId = item.extraction_payload?.cpoMonthId;
    if (!cpoMonthId) return { ok: false, error: 'CPO month id is missing' };
    const raw = payload?.cpoMin ?? payload?.cpo_min ?? 30;
    const cpoMin = Math.max(30, Number(raw) || 30);
    const cpoMonth = await updateCpoMinutes({ cpoMonthId, cpoMin });
    await updateItem(item.id, {
      decisions: setDecisions(item, { cpo_minutes_captured: true }),
    });
    return { ok: true, output: { cpoMonthId, cpoMin: cpoMonth.cpo_min, status: cpoMonth.status } };
  },

  // ── Area Upload Monitor tasks ────────────────────────────────────────────
  'area.monitorExpectedUploads': async () => ({ ok: true, output: { monitoring: true } }),
  'area.continueUploadWorkflow': async () => ({ ok: true, output: { continued: true } }),
  // Manual: a person sends the missing-upload email to the HHAH via SMTP, then the
  // system posts the on-page notification (area.recordNotificationStatus) right after.
  'area.sendMissingUploadNotification': async ({ item, payload }) => {
    const recipient = payload?.recipient || item.reference_payload?.HHAH?.contact_info?.email || '';
    const subject = payload?.subject || 'Missing daily intake upload';
    const body = payload?.notes || 'We have not received your daily Excel + PDF ZIP upload within the 24-hour window. Please upload your documents as soon as possible.';

    let mail;
    try {
      mail = await sendEmail({ to: recipient, subject, text: body });
    } catch (error) {
      return { ok: false, error: `Email send failed: ${error.message}`, output: { recipient } };
    }

    const decisions = setDecisions(item, { notification_sent: true });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        email_sent: mail.sent,
        email_skipped: mail.skipped || false,
        email_reason: mail.reason || null,
        message_id: mail.messageId || null,
        recipient,
        subject,
      },
    };
  },
  'area.recordNotificationStatus': async () => ({ ok: true, output: { recorded: true, posted_to_login_page: true } }),
  'area.waitForHhahUpload': async () => ({ ok: true, output: { waiting: true } }),

  // ── Daily Agency Intake -> RCM Pipeline (referenceLogic) ──
  // Every system task here NEVER returns ok:false for a business "no/failed"
  // outcome — instead it stamps decisions the condition nodes read (mirrors
  // signing.checkSigned). ok:false is reserved for hard crashes, which the engine
  // treats as an item failure.

  // n1: has the item's agency uploaded documents for its day bucket?
  'agency.checkUploadedToday': async ({ item, step }) => {
    const tz = step?.input?.trigger?.tz || item?.extraction_payload?.tz || undefined;
    const result = await checkUploadedToday({ item, ...(tz ? { tz } : {}) });
    const decisions = setDecisions(item, {
      agency_uploaded: result.uploaded === true,
      agency_not_uploaded: result.uploaded !== true,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: result };
  },

  // n2: cost-tiered extraction (regex over the real order PDF text fetched from
  // extraction_payload.pdf.blobUrl -> regex over payload text -> Gemini). Merges
  // filled fields into the item payloads and stores the extracted shape on
  // extraction_payload so the audit (Rule 3) + AI service can read it. The
  // extracted PDF text is cached on extraction_payload.pdfText (provenance +
  // re-runs skip the blob refetch). Sets ai_extraction_success/fail.
  'ai.extractWithPatterns': async ({ item }) => {
    const result = await extractWithPatterns({ item, pdfBuffer: null });
    const patientPatch = result.data?.patient || {};
    const orderPatch = result.data?.order || {};
    const patientPayload = mergeDeep(item.patient_payload, {
      patient_info: { name: patientPatch.name, sex: patientPatch.sex, DOB: patientPatch.DOB },
      personal_information: { address: { street: patientPatch.address } },
      admission_details: {
        MRN: patientPatch.MRN,
        SOC: patientPatch.SOC,
        EOC: patientPatch.EOC,
        SOE: patientPatch.SOE,
        EOE: patientPatch.EOE,
        diagnosis_codes: patientPatch.diagnosis_codes,
      },
    });
    const orderPayload = mergeDeep(item.order_payload, {
      order_info: {
        order_number: orderPatch.order_number,
        order_type: orderPatch.order_type,
        order_date: orderPatch.order_date,
      },
      order_admission_details: { billing_provider: { NPI: orderPatch.NPI } },
    });
    // Multi-signal PDF ↔ order matching over the extracted text (filename ->
    // order-number-in-text -> patient+date heuristic). Ambiguous/no-match is NOT
    // guessed silently: it stamps pdf_match_ambiguous and, because the fill task
    // carries the 'Confirm order document' action, we route there by OR-ing the
    // ambiguity into ai_extraction_fail (the fill task's gate).
    const mergedForMatch = { ...item, patient_payload: patientPayload, order_payload: orderPayload };
    const pdfMatch = matchPdfForItem(mergedForMatch, result.pdfText || item.extraction_payload?.pdfText);
    const extractionFailed = result.ok !== true;
    const decisions = setDecisions(item, {
      ai_extraction_success: !extractionFailed && !pdfMatch.ambiguous,
      ai_extraction_fail: extractionFailed || pdfMatch.ambiguous,
      pdf_match: pdfMatch.match,
      pdf_match_ambiguous: pdfMatch.ambiguous,
    });
    await updateItem(item.id, {
      patientPayload,
      orderPayload,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        patient: result.data?.patient || {},
        order: result.data?.order || {},
        tiersUsed: result.tiersUsed,
        missingAfter: result.missingAfter,
        validationErrors: result.validationErrors,
        model: result.model,
        pdfMatch: pdfMatch.match,
        ...(result.pdfText ? { pdfText: result.pdfText } : {}),
      },
      decisions,
    });
    return { ok: true, output: { tiersUsed: result.tiersUsed, missingAfter: result.missingAfter, ok: result.ok, pdfMatch: pdfMatch.match } };
  },

  // n4: AI CC-note / CPO service. Partial success is acceptable; sets
  // ai_service_failed/ai_service_ok from the referenceLogic result.
  'ai.runService': async ({ item }) => {
    const result = await runAiService({ item });
    const failed = result.ok === false || (Array.isArray(result.failures) && result.failures.length > 0);
    const decisions = setDecisions(item, {
      ai_service_failed: failed,
      ai_service_ok: !failed,
    });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        processedMonths: result.processedMonths,
        generatedNotes: result.generatedNotes,
        failures: result.failures || [],
      },
    };
  },

  // n5: generate + upsert RCM billing records for the item's agency.
  'rcm.generate': async ({ item }) => {
    const result = await generateRcm({ item });
    return { ok: true, output: { records: result.records, skipped: result.skipped, error: result.error || null } };
  },

  // n6: audit the agency's RCM records. Sets audit_failed/audit_passed.
  'ai.audit': async ({ item }) => {
    const result = await auditRcm({ item });
    const failed = (result.failed || []).length > 0;
    const decisions = setDecisions(item, {
      audit_failed: failed,
      audit_passed: !failed,
    });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        passed: (result.passed || []).length,
        failed: (result.failed || []).length,
        findings: (result.failed || []).map((f) => ({ rcmRecordId: f.rcmRecordId, findings: f.findings })),
        error: result.error || null,
      },
    };
  },

  // n7: bounded auto-fix + re-audit loop.
  'ai.rework': async ({ item }) => {
    const result = await reworkAudits({ item });
    return { ok: true, output: { cycles: result.cycles, fixed: result.fixed, remaining: result.remaining, error: result.error || null } };
  },

  // ── Post-model billing gates (Milestone A) ──
  // Each re-derives the item's episode state from the REAL DB rows (never returns
  // ok:false for a business "no" — stamps decisions the gate condition nodes read).
  // Runs AFTER the record review, so episode/admission/order rows exist.

  // Gate 1: episode eligibility (signed 485 + valid F2F window). Stamps
  // episode_eligible / episode_not_eligible.
  'gate.checkEpisodeEligibility': async ({ item }) => {
    const ctx = await loadEpisodeGateContext(item);
    const eligible = ctx?.assessment?.eligible === true;
    const decisions = setDecisions(item, {
      episode_eligible: eligible,
      episode_not_eligible: !eligible,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { eligible, status: ctx?.assessment?.status || 'none', reason: ctx?.assessment?.reason || null } };
  },

  // Gate exit: flip the patient toward billable/claimable (denormalized latest
  // episode status). Stamps billable_claimable.
  'gate.makeBillableClaimable': async ({ item }) => {
    const result = await makeEpisodeBillableClaimable(item);
    const decisions = setDecisions(item, { billable_claimable: result.billable === true });
    await updateItem(item.id, { decisions });
    return { ok: true, output: result };
  },

  // Gate 2: 485 + F2F document presence. Stamps documents_exist / documents_missing.
  'gate.checkDocumentsExist': async ({ item }) => {
    const ctx = await loadEpisodeGateContext(item);
    const { documentsExist, has485, hasF2f } = gateDocumentsExist(ctx);
    const decisions = setDecisions(item, {
      documents_exist: documentsExist,
      documents_missing: !documentsExist,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { documentsExist, has485, hasF2f } };
  },

  // Gate 3: required patient demographics complete. Stamps
  // patient_data_complete / patient_data_incomplete.
  'gate.checkPatientDataComplete': async ({ item }) => {
    const ctx = await loadEpisodeGateContext(item);
    const { patientDataComplete } = await gatePatientDataComplete(item, ctx);
    const decisions = setDecisions(item, {
      patient_data_complete: patientDataComplete,
      patient_data_incomplete: !patientDataComplete,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { patientDataComplete } };
  },

  // Gate 4: every episode order physician-signed. Stamps
  // signature_exists / signature_missing.
  'gate.checkSignatureExists': async ({ item }) => {
    const ctx = await loadEpisodeGateContext(item);
    const { signatureExists, unsignedOrderNumbers } = gateSignatureExists(ctx);
    const decisions = setDecisions(item, {
      signature_exists: signatureExists,
      signature_missing: !signatureExists,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { signatureExists, unsignedOrderNumbers } };
  },

  // ── CCN + audit/submit tail (Milestone B) ──
  // Runs AFTER make_billable_claimable. CCN generation for the item's billable
  // months; Gemini-dead => stamps ccn_failed and routes the human 'Create CCN
  // manually' task.
  'ccn.runService': async ({ item }) => {
    const result = await runCcnService({ item });
    const decisions = setDecisions(item, {
      ccn_failed: result.ccnFailed,
      ccn_ok: !result.ccnFailed,
    });
    await updateItem(item.id, { decisions });
    return {
      ok: true,
      output: {
        ccnFailed: result.ccnFailed,
        processedMonths: result.processedMonths,
        generatedNotes: result.generatedNotes,
        failures: result.failures,
      },
    };
  },

  // ONE step: audit -> rework -> re-audit, bounded <= 5 cycles, computes passRate.
  // Stamps audit_pass_98 = passRate >= 0.98.
  'audit.runCycle': async ({ item }) => {
    const result = await runAuditCycle(item, 5);
    const decisions = setDecisions(item, {
      audit_pass_98: result.passRate >= AUDIT_PASS_THRESHOLD,
      audit_pass_below_98: result.passRate < AUDIT_PASS_THRESHOLD,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: result };
  },

  // One more bounded cycle after the human 'Resolve audit failures' task. Re-stamps
  // audit_pass_98 so the Orchestrator reflects the post-resolution pass rate.
  'audit.reAudit': async ({ item }) => {
    const result = await runAuditCycle(item, 1);
    const decisions = setDecisions(item, {
      audit_pass_98: result.passRate >= AUDIT_PASS_THRESHOLD,
      audit_pass_below_98: result.passRate < AUDIT_PASS_THRESHOLD,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: result };
  },
};

// Lisa: the lifecycle view shows object existence/creation status for the
// diagram's workflow objects (Patient, Admission, Episode, Order)
// rather than field-level changes. Derived from the item's decision flags.
export function objectLifecycle(item) {
  const d = item.decisions || {};
  return {
    unit: d.unit_exists ? 'found' : d.unit_not_exists ? 'created' : 'pending',
    patient: d.needs_manual_review ? 'in-review'
      : d.record_created ? 'created'
      : d.record_updated ? 'updated'
      : d.patient_write_success || d.patient_retry_success ? (d.patient_exists ? 'updated' : 'created')
      : d.patient_exists ? 'found'
      : d.patient_not_exists ? 'missing' : 'pending',
    admission: d.admission_created ? 'created' : d.admission_exists ? 'found' : d.admission_ready ? 'created' : 'pending',
    episode: d.episode_created ? 'created' : d.episode_exists ? 'found' : d.episode_ready ? 'created' : 'pending',
    order: d.order_skipped_duplicate ? 'skipped'
      : d.order_write_success || d.order_retry_success ? 'created'
      : d.order_exists ? 'skipped' : d.order_not_exists ? 'missing' : 'pending',
  };
}

export function taskDisplayPayload(item) {
  return {
    patient: safeJson(item.patient_payload),
    order: safeJson(item.order_payload),
    references: safeJson(item.reference_payload),
    extraction: safeJson(item.extraction_payload),
    decisions: safeJson(item.decisions),
    objectLifecycle: objectLifecycle(item),
    missingFields: missingFields(item),
    practitionerNpi: normalizeNpi(item.reference_payload?.practitioner?.NPI),
    pgName: cleanString(item.reference_payload?.PG?.name),
    hhahName: cleanString(item.reference_payload?.HHAH?.name),
  };
}
