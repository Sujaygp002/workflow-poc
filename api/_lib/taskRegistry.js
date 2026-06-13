import {
  findAdmission,
  findEpisode,
  findHhahByName,
  findOrder,
  findPatient,
  insertAiExtraction,
  updateItem,
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
    // Did the admission / episode already exist before this write? Used by the
    // object lifecycle view to report found vs created without separate visual
    // admission/episode workflow boxes.
    const patientBefore = await findPatient(item.patient_payload);
    const admissionBefore = patientBefore
      ? await findAdmission(patientBefore.id, item.patient_payload?.admission_details?.SOC)
      : null;
    const episodeBefore = admissionBefore
      ? await findEpisode(admissionBefore.id, item.patient_payload?.admission_details?.SOE, item.patient_payload?.admission_details?.EOE)
      : null;

    const bundle = await writePatientBundle(item);
    const objectDecisions = {
      admission_ready: !!bundle.admission?.id,
      admission_exists: !!bundle.admission?.id && !!admissionBefore,
      admission_created: !!bundle.admission?.id && !admissionBefore,
      episode_ready: !!bundle.episode?.id,
      episode_exists: !!bundle.episode?.id && !!episodeBefore,
      episode_created: !!bundle.episode?.id && !episodeBefore,
      admission_seen_before: !!admissionBefore,
      episode_seen_before: !!episodeBefore,
    };
    const decisions = setDecisions(item, retry
      ? { patient_retry_success: true, patient_retry_fail: false, patient_write_fail: false, ...objectDecisions }
      : { patient_write_success: true, patient_write_fail: false, ...objectDecisions });
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

  'patient.update': async ({ item }) => runPatientWrite(item, false),
  'patient.create': async ({ item }) => runPatientWrite(item, false),
  'patient.retryWrite': async ({ item }) => runPatientWrite(item, true),

  // Admission: matched by patient + Start of Care. The patient bundle write
  // already reused-or-created it; this step reports which happened so the
  // lifecycle shows "found" vs "created".
  'admission.resolve': async ({ item }) => {
    const bundle = item.extraction_payload?.patientBundle || {};
    const admissionId = bundle.admissionId || null;
    // Was the admission pre-existing (created_at well before this run) or new?
    const created = !item.decisions?.admission_seen_before;
    const decisions = setDecisions(item, {
      admission_ready: !!admissionId,
      admission_exists: !!admissionId && !created,
      admission_created: !!admissionId && created,
    });
    await updateItem(item.id, { decisions });
    return { ok: !!admissionId, output: { admissionId, soc: item.patient_payload?.admission_details?.SOC, action: created ? 'created' : 'reused' } };
  },

  // Episode: matched within the admission by SOE/EOE — reused if it exists, else
  // a new episode is created and the order will attach to it.
  'episode.resolve': async ({ item }) => {
    const bundle = item.extraction_payload?.patientBundle || {};
    const episodeId = bundle.episodeId || null;
    const created = !item.decisions?.episode_seen_before;
    const decisions = setDecisions(item, {
      episode_ready: !!episodeId,
      episode_exists: !!episodeId && !created,
      episode_created: !!episodeId && created,
    });
    await updateItem(item.id, { decisions });
    return {
      ok: !!episodeId,
      output: {
        episodeId,
        soe: item.patient_payload?.admission_details?.SOE,
        eoe: item.patient_payload?.admission_details?.EOE,
        action: created ? 'created' : 'reused',
      },
    };
  },

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
};

// Lisa: the lifecycle view shows object existence/creation status for the
// diagram's workflow objects (Patient, Admission, Episode, Order)
// rather than field-level changes. Derived from the item's decision flags.
export function objectLifecycle(item) {
  const d = item.decisions || {};
  return {
    patient: d.needs_manual_review ? 'in-review'
      : d.patient_write_success || d.patient_retry_success ? (d.patient_exists ? 'updated' : 'created')
      : d.patient_exists ? 'found'
      : d.patient_not_exists ? 'missing' : 'pending',
    admission: d.admission_created ? 'created' : d.admission_exists ? 'found' : d.admission_ready ? 'created' : 'pending',
    episode: d.episode_created ? 'created' : d.episode_exists ? 'found' : d.episode_ready ? 'created' : 'pending',
    order: d.order_write_success || d.order_retry_success ? (d.order_exists ? 'updated' : 'created')
      : d.order_exists ? 'found' : d.order_not_exists ? 'missing' : 'pending',
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
