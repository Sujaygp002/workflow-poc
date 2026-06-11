import {
  createHhahFromPayload,
  createPgFromPayload,
  createPractitionerFromPayload,
  findHhahByName,
  findOrder,
  findPatient,
  findPgByName,
  findPractitionerByNpi,
  insertAiExtraction,
  updateItem,
  writeOrderBundle,
  writePatientBundle,
} from './repositories.js';
import { extractMissingDataFromPdf } from './gemini.js';
import { cleanString, hasValue, normalizeNpi, safeJson } from './normalizers.js';

const REQUIRED_FIELDS = [
  ['patient.patient_info.name', (item) => item.patient_payload?.patient_info?.name],
  ['patient.patient_info.DOB', (item) => item.patient_payload?.patient_info?.DOB],
  ['patient.admission_details.MRN', (item) => item.patient_payload?.admission_details?.MRN],
  ['patient.patient_info.sex', (item) => item.patient_payload?.patient_info?.sex],
  ['patient.personal_information.address.street', (item) => item.patient_payload?.personal_information?.address?.street],
  ['patient.admission_details.PG.name', (item) => item.reference_payload?.PG?.name],
  ['patient.admission_details.HHAH.name', (item) => item.reference_payload?.HHAH?.name],
  ['patient.admission_details.SOC', (item) => item.patient_payload?.admission_details?.SOC],
  ['patient.admission_details.EOC', (item) => item.patient_payload?.admission_details?.EOC],
  ['patient.admission_details.SOE', (item) => item.patient_payload?.admission_details?.SOE],
  ['patient.admission_details.EOE', (item) => item.patient_payload?.admission_details?.EOE],
  ['order.order_info.order_number', (item) => item.order_payload?.order_info?.order_number],
  ['order.order_info.order_type', (item) => item.order_payload?.order_info?.order_type],
  ['order.order_info.order_date', (item) => item.order_payload?.order_info?.order_date],
  ['order.order_admission_details.billing_provider.NPI', (item) => item.reference_payload?.practitioner?.NPI],
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

async function checkAllReferences(item) {
  const practitioner = await findPractitionerByNpi(item.reference_payload?.practitioner?.NPI);
  const pg = await findPgByName(item.reference_payload?.PG?.name);
  const hhah = await findHhahByName(item.reference_payload?.HHAH?.name);
  return { practitioner, pg, hhah };
}

async function markReferenceDecisions(item) {
  const refs = await checkAllReferences(item);
  const decisions = setDecisions(item, {
    practitioner_exists: !!refs.practitioner,
    practitioner_not_exists: !refs.practitioner,
    pg_exists: !!refs.pg,
    pg_not_exists: !refs.pg,
    hhah_exists: !!refs.hhah,
    hhah_not_exists: !refs.hhah,
    reference_records_ready: !!refs.practitioner && !!refs.pg && !!refs.hhah,
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

async function evaluatePatientExistence(item) {
  const existing = await findPatient(item.patient_payload);
  const decisions = setDecisions(item, {
    patient_exists: !!existing,
    patient_not_exists: !existing,
  });
  await updateItem(item.id, { decisions });
  return existing;
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
    const bundle = await writePatientBundle(item);
    const decisions = setDecisions(item, retry
      ? { patient_retry_success: true, patient_retry_fail: false, patient_write_fail: false }
      : { patient_write_success: true, patient_write_fail: false });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        patientBundle: {
          patientId: bundle.patient?.id,
          admissionId: bundle.admission?.id,
          episodeId: bundle.episode?.id,
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
    const order = await writeOrderBundle(item, patientBundle);
    const decisions = setDecisions(item, retry
      ? { order_retry_success: true, order_retry_fail: false, order_write_fail: false }
      : { order_write_success: true, order_write_fail: false });
    await updateItem(item.id, {
      decisions,
      extractionPayload: {
        ...(item.extraction_payload || {}),
        orderId: order?.id,
      },
    });
    return { ok: true, order };
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

  if (condition === 'patient_exists' || condition === 'patient_not_exists') {
    const existing = await evaluatePatientExistence(item);
    return condition === 'patient_exists' ? !!existing : !existing;
  }
  if (condition === 'order_exists' || condition === 'order_not_exists') {
    const existing = await evaluateOrderExistence(item);
    return condition === 'order_exists' ? !!existing : !existing;
  }
  if (condition.startsWith('practitioner_') || condition.startsWith('pg_') || condition.startsWith('hhah_') || condition === 'reference_records_ready') {
    const { decisions } = await markReferenceDecisions(item);
    return decisions[condition] === true;
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
    const pdf = context?.pdfs?.[0] || null;
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
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        status: 'failed',
        inputSummary: { missing },
        outputData: {},
        errorMessage: error.message,
      });
      await updateItem(item.id, { decisions });
      return { ok: true, output: { error: error.message } };
    }
  },

  'refs.checkPractitionerByNpi': async ({ item }) => {
    const practitioner = await findPractitionerByNpi(item.reference_payload?.practitioner?.NPI);
    const decisions = setDecisions(item, {
      practitioner_exists: !!practitioner,
      practitioner_not_exists: !practitioner,
    });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { exists: !!practitioner, practitioner } };
  },

  'refs.checkPgByName': async ({ item }) => {
    const pg = await findPgByName(item.reference_payload?.PG?.name);
    const decisions = setDecisions(item, { pg_exists: !!pg, pg_not_exists: !pg });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { exists: !!pg, pg } };
  },

  'refs.checkHhahByName': async ({ item }) => {
    const hhah = await findHhahByName(item.reference_payload?.HHAH?.name);
    const decisions = setDecisions(item, { hhah_exists: !!hhah, hhah_not_exists: !hhah });
    await updateItem(item.id, { decisions });
    return { ok: true, output: { exists: !!hhah, hhah } };
  },

  'refs.recheckAll': async ({ item }) => {
    const result = await markReferenceDecisions(item);
    return { ok: result.decisions.reference_records_ready, output: result };
  },

  'patient.update': async ({ item }) => runPatientWrite(item, false),
  'patient.create': async ({ item }) => runPatientWrite(item, false),
  'patient.retryWrite': async ({ item }) => runPatientWrite(item, true),

  'order.update': async ({ item }) => runOrderWrite(item, false),
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

  'human.createPractitioner': async ({ item, payload }) => {
    const referencePayload = mergeDeep(item.reference_payload, { practitioner: payload?.practitioner || {} });
    const practitioner = await createPractitionerFromPayload(referencePayload);
    const decisions = setDecisions(item, { practitioner_exists: true, practitioner_not_exists: false });
    await updateItem(item.id, { referencePayload, decisions });
    return { ok: true, output: { practitioner } };
  },

  'human.createPg': async ({ item, payload }) => {
    const referencePayload = mergeDeep(item.reference_payload, { PG: payload?.PG || {} });
    const pg = await createPgFromPayload(referencePayload);
    const decisions = setDecisions(item, { pg_exists: true, pg_not_exists: false });
    await updateItem(item.id, { referencePayload, decisions });
    return { ok: true, output: { pg } };
  },

  'human.createHhah': async ({ item, payload }) => {
    const referencePayload = mergeDeep(item.reference_payload, { HHAH: payload?.HHAH || {} });
    const hhah = await createHhahFromPayload(referencePayload);
    const decisions = setDecisions(item, { hhah_exists: true, hhah_not_exists: false });
    await updateItem(item.id, { referencePayload, decisions });
    return { ok: true, output: { hhah } };
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
};

export function taskDisplayPayload(item) {
  return {
    patient: safeJson(item.patient_payload),
    order: safeJson(item.order_payload),
    references: safeJson(item.reference_payload),
    extraction: safeJson(item.extraction_payload),
    decisions: safeJson(item.decisions),
    missingFields: missingFields(item),
    practitionerNpi: normalizeNpi(item.reference_payload?.practitioner?.NPI),
    pgName: cleanString(item.reference_payload?.PG?.name),
    hhahName: cleanString(item.reference_payload?.HHAH?.name),
  };
}
