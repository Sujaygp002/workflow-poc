import {
  findHhahByName,
  findOrder,
  findPatient,
  findPatientUnit,
  insertAiExtraction,
  updateItem,
  writeAdmissionBundle,
  writeEpisodeBundle,
  writeOrderBundle,
  writePatientBundle,
} from './repositories.js';
import { extractMissingDataFromPdf } from './gemini.js';
import { GEMINI_MODEL } from './config.js';
import { cleanString, hasValue, normalizeNpi, safeJson } from './normalizers.js';

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
  // Area-onboarding conditions: onboarding_successful is always true for the seeded run;
  // upload_received / upload_missing / notification_sent are driven by actual area state.
  if (condition === 'onboarding_successful') return true;
  if (condition === 'upload_received_within_24h') return item.decisions?.upload_received_within_24h === true;
  if (condition === 'upload_missing_after_24h') return item.decisions?.upload_missing_after_24h === true;
  if (condition === 'notification_sent') return item.decisions?.notification_sent === true;
  if (condition.startsWith('hhah_')) {
    const { decisions } = await markReferenceDecisions(item);
    return decisions[condition] === true;
  }
  if (['document_ready_for_signing', 'document_not_ready_for_signing', 'signed_within_48h', 'signing_overdue'].includes(condition)) {
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
      const referencePatch = {
        practitioner: result.data?.practitioner || {},
        PG: result.data?.PG || {},
        HHAH: result.data?.HHAH || {},
      };
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
          order_signed_date: orderPatch.signed_date,
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
    const { admission, existed } = await writeAdmissionBundle(item, patientId);
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
    const { episode, existed } = await writeEpisodeBundle(item, bundle.admissionId);
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
  // untouched; the row is marked as a skipped duplicate.
  'order.skipDuplicate': async ({ item }) => {
    const existing = await findOrder(item.order_payload?.order_info?.order_number);
    const decisions = setDecisions(item, {
      order_skipped_duplicate: true,
      order_write_success: false,
    });
    await updateItem(item.id, {
      decisions,
      extractionPayload: { ...(item.extraction_payload || {}), orderId: existing?.id || null, orderSkipped: true },
    });
    return { ok: true, output: { skipped: true, existingOrderId: existing?.id || null } };
  },

  'order.create': async ({ item }) => runOrderWrite(item, false),
  'order.retryWrite': async ({ item }) => runOrderWrite(item, true),

  'human.validateExtractedData': async ({ item, payload }) => {
    const decisions = setDecisions(item, { human_data_validated: true });
    await updateItem(item.id, {
      patientPayload: confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {})),
      orderPayload: confidenceConfirmed(mergeDeep(item.order_payload, payload?.order || {})),
      referencePayload: mergeDeep(item.reference_payload, payload?.references || {}),
      decisions,
    });
    return { ok: true, output: { validated: true } };
  },

  'human.fillMissingData': async ({ item, payload }) => {
    const decisions = setDecisions(item, { human_data_validated: true });
    await updateItem(item.id, {
      patientPayload: confidenceConfirmed(mergeDeep(item.patient_payload, payload?.patient || {})),
      orderPayload: confidenceConfirmed(mergeDeep(item.order_payload, payload?.order || {})),
      referencePayload: mergeDeep(item.reference_payload, payload?.references || {}),
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
    const decisions = setDecisions(item, {
      signing_sent_to_physician: true,
      signing_sent_at: new Date().toISOString(),
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { sent: true } };
  },

  'signing.checkSignedWithin48h': async ({ item }) => {
    const signed = Boolean(item.order_payload?.order_status?.order_signed_date || item.order_payload?.order_status?.signed);
    const sentAt = item.decisions?.signing_sent_at ? new Date(item.decisions.signing_sent_at) : new Date();
    const deadlinePassed = Date.now() - sentAt.getTime() >= 48 * 60 * 60 * 1000;
    const decisions = setDecisions(item, {
      signed_within_48h: signed,
      signing_overdue: !signed && deadlinePassed,
    });
    await updateItem(item.id, { decisions });
    if (!signed && !deadlinePassed) {
      return { ok: true, waiting: true, output: { waiting: true, signedWithin48h: false, deadlinePassed } };
    }
    return { ok: true, output: { signedWithin48h: signed, deadlinePassed } };
  },

  'signing.updateOrderSigned': async ({ item }) => {
    const orderPayload = mergeDeep(item.order_payload, {
      order_status: {
        order_status: 'signed',
        signed: true,
        order_signed_date: item.order_payload?.order_status?.order_signed_date || new Date().toISOString().slice(0, 10),
      },
    });
    await updateItem(item.id, { orderPayload, decisions: setDecisions(item, { signing_status_updated: true }) });
    return { ok: true, output: { orderStatus: 'signed' } };
  },

  'signing.emailPhysicianReminder': async ({ item }) => {
    await updateItem(item.id, { decisions: setDecisions(item, { physician_reminder_email_sent: true }) });
    return { ok: true, output: { emailLogged: true } };
  },

  // ── Area Onboarding / Monitor tasks ──────────────────────────────────────
  'area.onboardingSuccess': async () => ({ ok: true, output: { started: true } }),
  'area.monitorExpectedUploads': async () => ({ ok: true, output: { monitoring: true } }),
  'area.continueUploadWorkflow': async () => ({ ok: true, output: { continued: true } }),
  'area.sendMissingUploadNotification': async () => ({ ok: true, output: { notified: true } }),
  'area.recordNotificationStatus': async () => ({ ok: true, output: { recorded: true } }),
  'area.waitForHhahUpload': async () => ({ ok: true, output: { waiting: true } }),
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
