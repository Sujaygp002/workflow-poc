// Builder palette: triggers, system actions, human (checklist) actions, conditions.
// Every entry maps to EXISTING code — taskRegistry keys, repository fns, mailer.
import { sendEmail } from './mailer.js';
import {
  markOrderSentToPhysician,
  updateCpoMinutes,
  updateItem,
} from './repositories.js';
import { hasValue } from './normalizers.js';

export const TRIGGERS = [
  { key: 'document_upload', label: 'Document upload (HHAH portal)', description: 'Fires when an HHAH uploads a workbook + order PDFs. One item per parsed row.' },
  { key: 'manual', label: 'Manual (Run button)', description: 'Started on demand from the Workflow page.' },
  { key: 'time_interval', label: 'Time interval', description: 'Started on a fixed interval (intervalSeconds).', params: ['intervalSeconds'] },
];

// System actions: run unattended by the engine via the existing taskRegistry.
export const ACTIONS = {
  ai_extract_pdf_fields: { key: 'ai_extract_pdf_fields', kind: 'system', label: 'AI-extract missing PDF fields', taskKey: 'ai.extractMissingDataFromPdf', actor: 'ai' },
  check_required_fields: { key: 'check_required_fields', kind: 'system', label: 'Check required fields', taskKey: 'row.checkCompleteness' },
  resolve_patient: { key: 'resolve_patient', kind: 'system', label: 'Check if patient exists', taskKey: 'patient.resolve' },
  create_patient: { key: 'create_patient', kind: 'system', label: 'Create patient', taskKey: 'patient.create' },
  update_patient: { key: 'update_patient', kind: 'system', label: 'Update patient', taskKey: 'patient.update' },
  create_patient_record: { key: 'create_patient_record', kind: 'system', label: 'Create patient record', taskKey: 'record.create' },
  resolve_admission: { key: 'resolve_admission', kind: 'system', label: 'Check / create admission', taskKey: 'admission.resolve' },
  resolve_episode: { key: 'resolve_episode', kind: 'system', label: 'Check / create episode', taskKey: 'episode.resolve' },
  create_order: { key: 'create_order', kind: 'system', label: 'Create order', taskKey: 'order.create' },
  skip_duplicate_order: { key: 'skip_duplicate_order', kind: 'system', label: 'Skip duplicate order', taskKey: 'order.skipDuplicate' },
  send_order_to_physician_system: { key: 'send_order_to_physician_system', kind: 'system', label: 'Send order to physician (system)', taskKey: 'signing.sendToPhysician' },
  update_order_signed: { key: 'update_order_signed', kind: 'system', label: 'Update order status — signed', taskKey: 'signing.updateOrderSigned' },
  check_patient_eligible: { key: 'check_patient_eligible', kind: 'system', label: 'Check patient eligible', taskKey: 'billing.checkPatientEligible' },
};

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  return typeof value === 'string' && YMD_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function itemOrderId(item) {
  return item?.extraction_payload?.orderId || null;
}

// Human (checklist) actions. Each has a server-side validate(action, result, item)
// returning an error message or null, and an optional execute run at completion.
export const HUMAN_ACTIONS = {
  send_email_to_physician: {
    key: 'send_email_to_physician',
    label: 'Send email to physician',
    inputs: ['to', 'subject', 'body', 'confirmed'],
    validate(action, result) {
      if (!result || !EMAIL_RE.test(String(result.to || ''))) return 'A valid recipient email is required';
      if (result.confirmed !== true) return 'Confirm the email was reviewed before sending';
      return null;
    },
    async execute(action, result, item) {
      const mail = await sendEmail({
        to: result.to,
        subject: result.subject || action?.params?.subjectTemplate || 'Order ready for signature',
        text: result.body || '',
      });
      const orderId = itemOrderId(item);
      if (orderId) await markOrderSentToPhysician(orderId);
      return { email_sent: mail.sent, email_skipped: mail.skipped || false, email_reason: mail.reason || null, orderId };
    },
  },
  send_email_to_hhah: {
    key: 'send_email_to_hhah',
    label: 'Send email to HHAH',
    inputs: ['to', 'subject', 'body', 'confirmed'],
    validate(action, result) {
      if (!result || !EMAIL_RE.test(String(result.to || ''))) return 'A valid recipient email is required';
      if (result.confirmed !== true) return 'Confirm the email was reviewed before sending';
      return null;
    },
    async execute(action, result) {
      const mail = await sendEmail({ to: result.to, subject: result.subject || 'Message from Command Center', text: result.body || '' });
      return { email_sent: mail.sent, email_skipped: mail.skipped || false, email_reason: mail.reason || null };
    },
  },
  enter_admission_dates: {
    key: 'enter_admission_dates',
    label: 'Enter admission dates (SOC/EOC)',
    inputs: ['SOC', 'EOC'],
    validate(action, result) {
      if (!result || !validDate(result.SOC)) return 'SOC must be a valid YYYY-MM-DD date';
      if (result.EOC && !validDate(result.EOC)) return 'EOC must be a valid YYYY-MM-DD date';
      return null;
    },
    async execute(action, result, item) {
      const patientPayload = mergeDeep(item.patient_payload, { admission_details: { SOC: result.SOC, EOC: result.EOC } });
      await updateItem(item.id, { patientPayload });
      return { SOC: result.SOC, EOC: result.EOC || null };
    },
  },
  enter_episode_dates: {
    key: 'enter_episode_dates',
    label: 'Enter episode dates (SOE/EOE)',
    inputs: ['SOE', 'EOE'],
    validate(action, result) {
      if (!result || !validDate(result.SOE) || !validDate(result.EOE)) return 'SOE and EOE must be valid YYYY-MM-DD dates';
      if (Date.parse(result.SOE) > Date.parse(result.EOE)) return 'SOE must be on or before EOE';
      return null;
    },
    async execute(action, result, item) {
      const patientPayload = mergeDeep(item.patient_payload, { admission_details: { SOE: result.SOE, EOE: result.EOE } });
      await updateItem(item.id, { patientPayload });
      return { SOE: result.SOE, EOE: result.EOE };
    },
  },
  fill_missing_fields: {
    key: 'fill_missing_fields',
    label: 'Fill missing fields',
    inputs: ['patient', 'order', 'references'],
    validate(action, result) {
      if (!result || typeof result !== 'object') return 'Provide the missing field values';
      return null;
    },
    async execute(action, result, item) {
      await updateItem(item.id, {
        patientPayload: mergeDeep(item.patient_payload, result.patient || {}),
        orderPayload: mergeDeep(item.order_payload, result.order || {}),
        referencePayload: mergeDeep(item.reference_payload, result.references || {}),
      });
      return { filled: true };
    },
  },
  review_record: {
    key: 'review_record',
    label: 'Review record',
    inputs: ['approved'],
    validate(action, result) {
      if (!result || result.approved !== true) return 'The record must be approved to complete this action';
      return null;
    },
    async execute(action, result, item) {
      await updateItem(item.id, { decisions: { ...(item.decisions || {}), record_reviewed: true } });
      return { reviewed: true };
    },
  },
  add_cpo_minutes: {
    key: 'add_cpo_minutes',
    label: 'Add CPO minutes (≥ 30)',
    inputs: ['minutes'],
    validate(action, result, item) {
      const minutes = Number(result?.minutes);
      if (!Number.isFinite(minutes) || minutes < 30) return 'At least 30 CPO minutes are required';
      if (!item?.extraction_payload?.cpoMonthId) return 'No CPO month is linked to this task';
      return null;
    },
    async execute(action, result, item) {
      const cpoMonth = await updateCpoMinutes({ cpoMonthId: item.extraction_payload.cpoMonthId, cpoMin: Number(result.minutes) });
      return { cpoMonthId: cpoMonth.id, cpoMin: cpoMonth.cpo_min, status: cpoMonth.status };
    },
  },
  mark_order_sent: {
    key: 'mark_order_sent',
    label: 'Mark order as sent',
    inputs: [],
    validate(action, result, item) {
      if (!itemOrderId(item) && !hasValue(item?.order_payload?.order_info?.order_number)) {
        return 'No order is linked to this task';
      }
      return null;
    },
    async execute(action, result, item) {
      const orderId = itemOrderId(item);
      if (orderId) await markOrderSentToPhysician(orderId);
      return { marked: true, orderId };
    },
  },
  confirm_checklist: {
    key: 'confirm_checklist',
    label: 'Confirm checklist item',
    inputs: ['confirmed'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'This item must be confirmed';
      return null;
    },
  },
};

// Conditions: each declares its negation so if/else compiles. All keys are
// already implemented in taskRegistry.evaluateCondition.
export const CONDITIONS = {
  patient_exists: { key: 'patient_exists', label: 'Patient exists', negation: 'patient_not_exists', description: 'patient unit found by name + dob + mrn' },
  patient_not_exists: { key: 'patient_not_exists', label: 'Patient does not exist', negation: 'patient_exists', description: 'patient unit not found' },
  order_exists: { key: 'order_exists', label: 'Order exists', negation: 'order_not_exists', description: 'order already exists by order number' },
  order_not_exists: { key: 'order_not_exists', label: 'Order does not exist', negation: 'order_exists', description: 'order not found by order number' },
  excel_row_incomplete: { key: 'excel_row_incomplete', label: 'Row is incomplete', negation: 'excel_row_complete', description: 'one or more required fields are missing' },
  excel_row_complete: { key: 'excel_row_complete', label: 'Row is complete', negation: 'excel_row_incomplete', description: 'all required fields exist' },
  ai_extraction_success: { key: 'ai_extraction_success', label: 'AI extraction succeeded', negation: 'ai_extraction_fail', description: 'Gemini extracted missing values' },
  ai_extraction_fail: { key: 'ai_extraction_fail', label: 'AI extraction failed', negation: 'ai_extraction_success', description: 'Gemini could not extract enough values' },
  admission_dates_missing: { key: 'admission_dates_missing', label: 'Admission dates missing', negation: 'admission_dates_ready', description: 'SOC is missing' },
  admission_dates_ready: { key: 'admission_dates_ready', label: 'Admission dates ready', negation: 'admission_dates_missing', description: 'SOC exists' },
  episode_dates_missing: { key: 'episode_dates_missing', label: 'Episode dates missing', negation: 'episode_dates_ready', description: 'SOE or EOE is missing' },
  episode_dates_ready: { key: 'episode_dates_ready', label: 'Episode dates ready', negation: 'episode_dates_missing', description: 'SOE and EOE exist' },
  order_fields_missing: { key: 'order_fields_missing', label: 'Order fields missing', negation: 'order_fields_ready', description: 'required order fields or matched PDF missing' },
  order_fields_ready: { key: 'order_fields_ready', label: 'Order fields ready', negation: 'order_fields_missing', description: 'required order fields and matched PDF present' },
  physician_signed: { key: 'physician_signed', label: 'Physician signed', negation: 'physician_signature_missing', description: 'physician has signed the document' },
  physician_signature_missing: { key: 'physician_signature_missing', label: 'Signature missing', negation: 'physician_signed', description: 'physician has not signed yet' },
  patient_eligible: { key: 'patient_eligible', label: 'Patient eligible', negation: 'patient_not_eligible', description: 'required 485 and valid F2F documents exist' },
  patient_not_eligible: { key: 'patient_not_eligible', label: 'Patient not eligible', negation: 'patient_eligible', description: 'required 485 or F2F document missing' },
};

// Validate a task's actionResults, then run each action's execute. Used by
// taskRegistry['human.performActions'].
export async function runHumanActions({ actions = [], results = {}, item }) {
  const errors = {};
  for (const action of actions) {
    const spec = HUMAN_ACTIONS[action.actionKey];
    if (!spec) {
      errors[action.id] = `Unknown action "${action.actionKey}"`;
      continue;
    }
    const message = spec.validate ? spec.validate(action, results[action.id], item) : null;
    if (message) errors[action.id] = message;
  }
  if (Object.keys(errors).length) return { errors, outputs: {} };

  const outputs = {};
  for (const action of actions) {
    const spec = HUMAN_ACTIONS[action.actionKey];
    if (spec?.execute) {
      outputs[action.id] = await spec.execute(action, results[action.id] || {}, item);
    } else {
      outputs[action.id] = { done: true };
    }
  }
  return { errors: {}, outputs };
}

export function builderCatalog() {
  return {
    triggers: TRIGGERS,
    actions: {
      system: Object.values(ACTIONS).map(({ key, label, kind }) => ({ key, label, kind })),
      human: Object.values(HUMAN_ACTIONS).map(({ key, label, inputs }) => ({ key, label, kind: 'human', inputs })),
    },
    conditions: Object.values(CONDITIONS).map(({ key, label, negation, description }) => ({ key, label, negation, description })),
  };
}
