// Builder palette: triggers, system actions, human (checklist) actions, conditions.
// Every entry maps to EXISTING code — taskRegistry keys, repository fns, mailer.
import { sendEmail } from './mailer.js';
import {
  findOrder,
  findOrderById,
  markOrderSentToPhysician,
  recordClaimSubmission,
  updateCpoMinutes,
  updateItem,
} from './repositories.js';
import { placeCall, sendSms } from './twilio.js';
import { hasValue } from './normalizers.js';

export const TRIGGERS = [
  { key: 'document_upload', label: 'Document upload (HHAH portal)', description: 'Fires when an HHAH uploads a workbook + order PDFs. One item per parsed row.' },
  { key: 'manual', label: 'Manual (Run button)', description: 'Started on demand from the Workflow page.' },
  { key: 'time_interval', label: 'Time interval', description: 'Started on a fixed interval (intervalSeconds).', params: ['intervalSeconds'] },
  { key: 'daily_time', label: 'Daily at time (per agency)', description: 'Fires once per day at hour:minute in tz; one item per active agency.', params: ['hour', 'minute', 'tz'] },
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

  // ── Daily Agency Intake -> RCM Pipeline (referenceLogic) ──
  check_agency_upload: { key: 'check_agency_upload', kind: 'system', label: 'Check agency uploaded today', taskKey: 'agency.checkUploadedToday' },
  ai_extract_with_patterns: { key: 'ai_extract_with_patterns', kind: 'system', label: 'AI extract (regex + Gemini)', taskKey: 'ai.extractWithPatterns', actor: 'ai' },
  run_ai_service: { key: 'run_ai_service', kind: 'system', label: 'Run AI service (CC notes / CPO)', taskKey: 'ai.runService', actor: 'ai' },
  generate_rcm: { key: 'generate_rcm', kind: 'system', label: 'Generate RCM billing records', taskKey: 'rcm.generate' },
  run_ai_audit: { key: 'run_ai_audit', kind: 'system', label: 'Run AI audit', taskKey: 'ai.audit', actor: 'ai' },
  run_ai_rework: { key: 'run_ai_rework', kind: 'system', label: 'Run AI rework', taskKey: 'ai.rework', actor: 'ai' },

  // ── Post-model billing gates (Milestone A) ──
  // Appended AFTER the record review, these re-derive the item's episode
  // eligibility/billability from the REAL DB rows (repositories + businessRules)
  // and stamp the decisions the gate condition nodes read. No external calls.
  check_episode_eligibility: { key: 'check_episode_eligibility', kind: 'system', label: 'Check episode eligibility', taskKey: 'gate.checkEpisodeEligibility' },
  make_billable_claimable: { key: 'make_billable_claimable', kind: 'system', label: 'Make billable / claimable', taskKey: 'gate.makeBillableClaimable' },
  check_documents_exist: { key: 'check_documents_exist', kind: 'system', label: 'Check 485 + F2F documents exist', taskKey: 'gate.checkDocumentsExist' },
  check_patient_data_complete: { key: 'check_patient_data_complete', kind: 'system', label: 'Check patient data complete', taskKey: 'gate.checkPatientDataComplete' },
  check_signature_exists: { key: 'check_signature_exists', kind: 'system', label: 'Check physician signature exists', taskKey: 'gate.checkSignatureExists' },

  // ── CCN + audit/submit tail (Milestone B) ──
  // Appended AFTER make_billable_claimable. CCN generation (Gemini-dead => stamps
  // ccn_failed and routes a human 'Create CCN manually'); a single bounded
  // audit->rework->re-audit cycle step that computes passRate and stamps
  // audit_pass_98 (>=0.98); one more bounded cycle on the human-resolution arm;
  // then a human 'Submit claim' gate (confirm-only, records submitted_at +
  // amounts — NO external call).
  run_ccn_service: { key: 'run_ccn_service', kind: 'system', label: 'Run CCN service', taskKey: 'ccn.runService', actor: 'ai' },
  run_audit_cycle: { key: 'run_audit_cycle', kind: 'system', label: 'Run audit cycle (audit -> rework -> re-audit)', taskKey: 'audit.runCycle' },
  re_audit: { key: 're_audit', kind: 'system', label: 'Re-audit (one more bounded cycle)', taskKey: 'audit.reAudit' },
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

// The agency phone for call/sms — reads the session-stamped HHAH contact. Returns
// null when absent (twilio then skips with reason 'no_recipient').
function agencyPhone(item) {
  const contact = item?.reference_payload?.HHAH?.contact || {};
  return contact.phone || contact.phone_number || contact.tel || null;
}

const NO_LINKED_ORDER_MESSAGE = "No created order is linked to this task — add a 'Create order' step before this task, or upload an order that exists.";

// Resolve the REAL order row for an item: the id stamped by a prior
// 'Create order' step first, else lookup by the workbook's order number.
// Returns null when neither maps to a DB row.
async function resolveOrderForItem(item) {
  const orderId = itemOrderId(item);
  if (orderId) {
    const order = await findOrderById(orderId);
    if (order) return order;
  }
  const orderNumber = item?.order_payload?.order_info?.order_number;
  if (hasValue(orderNumber)) return findOrder(orderNumber);
  return null;
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
    async validate(action, result, item) {
      const order = await resolveOrderForItem(item);
      if (!order) return NO_LINKED_ORDER_MESSAGE;
      return null;
    },
    async execute(action, result, item) {
      const order = await resolveOrderForItem(item);
      if (!order) throw new Error(NO_LINKED_ORDER_MESSAGE);
      await markOrderSentToPhysician(order.id);
      return { marked: true, orderId: order.id };
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

  // ── Agency outreach (missing-upload branch) ──
  // Call / SMS route through api/_lib/twilio.js. Twilio is env-only and unset in
  // this repo, so the module degrades to {sent:false,skipped:true,reason:
  // 'twilio_not_configured'} and NEVER throws — the worker still confirms the
  // outreach and the task completes. The twilio outcome is surfaced on the output
  // (channel_sent / channel_skipped / channel_reason) exactly like email_agency's
  // SMTP outcome, so the worker portal can show whether the real send happened.
  call_agency: {
    key: 'call_agency',
    label: 'Call agency',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the agency was called';
      return null;
    },
    async execute(action, result, item) {
      const to = agencyPhone(item);
      const call = await placeCall({
        to,
        message: result?.note || 'This is an automated reminder from your intake team: please upload your daily documents.',
      });
      return {
        channel: 'call',
        confirmed: true,
        note: result?.note || null,
        channel_sent: call.sent,
        channel_skipped: call.skipped || false,
        channel_reason: call.reason || null,
      };
    },
  },
  sms_agency: {
    key: 'sms_agency',
    label: 'Text agency',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the agency was texted';
      return null;
    },
    async execute(action, result, item) {
      const to = agencyPhone(item);
      const sms = await sendSms({
        to,
        body: result?.note || 'Reminder from your intake team: please upload your daily documents.',
      });
      return {
        channel: 'sms',
        confirmed: true,
        note: result?.note || null,
        channel_sent: sms.sent,
        channel_skipped: sms.skipped || false,
        channel_reason: sms.reason || null,
      };
    },
  },
  // Real email send. Recipient prefills from the agency's contact_info.email
  // (referencePayload.HHAH.contact.email) so the worker portal shows it pre-filled.
  email_agency: {
    key: 'email_agency',
    label: 'Email agency (missing upload)',
    inputs: ['to', 'subject', 'body', 'confirmed'],
    validate(action, result) {
      if (!result || !EMAIL_RE.test(String(result.to || ''))) return 'A valid recipient email is required';
      if (result.confirmed !== true) return 'Confirm the email was reviewed before sending';
      return null;
    },
    async execute(action, result) {
      const mail = await sendEmail({
        to: result.to,
        subject: result.subject || 'Please upload your daily documents',
        text: result.body || 'We have not received your document upload for today. Please upload as soon as possible.',
      });
      return { channel: 'email', email_sent: mail.sent, email_skipped: mail.skipped || false, email_reason: mail.reason || null };
    },
  },

  // ── PDF ↔ order confirmation (multi-signal matching fallback) ──
  // Reached on the fill task when the PDF could not be matched to the workbook
  // order confidently (decisions.pdf_match_ambiguous). The worker confirms which
  // uploaded PDF belongs to this order rather than the system guessing silently.
  // Supplying a blobUrl restamps extraction_payload.pdf so a re-run of
  // ai.extractWithPatterns reads the correct document; confirming with no blobUrl
  // just clears the ambiguity flag (accepts the current best match / no doc).
  confirm_order_document: {
    key: 'confirm_order_document',
    label: 'Confirm order document',
    inputs: ['confirmed', 'blobUrl', 'fileName'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm which PDF belongs to this order';
      return null;
    },
    async execute(action, result, item) {
      const decisions = { ...(item.decisions || {}), pdf_match_ambiguous: false, pdf_match_confirmed: true };
      const patch = { decisions };
      if (hasValue(result.blobUrl)) {
        patch.extractionPayload = {
          ...(item.extraction_payload || {}),
          pdf: {
            ...(item.extraction_payload?.pdf || {}),
            blobUrl: result.blobUrl,
            fileName: result.fileName || item.extraction_payload?.pdf?.fileName || null,
            match: 'human_confirmed',
          },
          // Drop cached text so a re-extract reads the newly-confirmed PDF.
          pdfText: undefined,
        };
      }
      await updateItem(item.id, patch);
      return { confirmed: true, blobUrl: result.blobUrl || null };
    },
  },

  // ── Post-model remediation (missing-document gate) ──
  // Contact agency / RPA placeholder / manual EHR confirm. No auto-send; the RPA
  // channel is a documented placeholder (no external integration). Completing it
  // is a branch terminal — the next daily run re-evaluates the gate fresh, and the
  // generalized auto-resolver settles it once the gate passes.
  get_missing_documents: {
    key: 'get_missing_documents',
    label: 'Get missing documents',
    inputs: ['channel', 'confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the missing documents were requested';
      const channel = result.channel || 'manual';
      if (!['contact_agency', 'rpa', 'manual'].includes(channel)) return 'Choose a valid channel (contact_agency / rpa / manual)';
      return null;
    },
    async execute(action, result) {
      const channel = result.channel || 'manual';
      // RPA is a documented placeholder — no external system is called here.
      return { channel, placeholder: channel === 'rpa', confirmed: true, note: result?.note || null };
    },
  },

  // ── Post-model remediation (missing-signature gate) ──
  // Mark the item's order 'sent to physician portal' (records SentToPhysician via
  // markOrderSentToPhysician — HUMAN action, NO auto-send to any external portal).
  // The worker is reminded to verify / bulk-sign at /pg-login.
  send_for_signature: {
    key: 'send_for_signature',
    label: 'Send for signature to physician',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the order was marked sent to the physician portal';
      return null;
    },
    async execute(action, result, item) {
      const order = await resolveOrderForItem(item);
      const orderId = order?.id || null;
      if (orderId) await markOrderSentToPhysician(orderId);
      return {
        marked_sent_to_physician_portal: !!orderId,
        orderId,
        note: result?.note || null,
        verify_at: '/pg-login',
        reminder: 'Verify or bulk-sign this order at the PG portal (/pg-login). No document was auto-sent.',
      };
    },
  },

  // ── CCN manual fallback (Milestone B) ──
  // Reached when run_ccn_service stamps ccn_failed (Gemini unavailable, or a month
  // returned no notes). A coordinator writes / confirms the clinical notes off-line.
  // Confirm-only (no auto-generation here) — the next run's CCN service re-evaluates
  // the months; this task documents that the notes were handled manually.
  create_ccn_manually: {
    key: 'create_ccn_manually',
    label: 'Create CCN manually',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the CCN notes were created / confirmed manually';
      return null;
    },
    async execute(action, result) {
      return { ccn_created_manually: true, confirmed: true, note: result?.note || null };
    },
  },

  // ── Audit failure resolution (Milestone B) ──
  // Reached when run_audit_cycle leaves passRate < 0.98. A coordinator confirms /
  // fixes the flagged RCM records off-line; the following re_audit system step runs
  // one more bounded cycle over the (now hopefully corrected) records.
  resolve_audit_failures: {
    key: 'resolve_audit_failures',
    label: 'Resolve audit failures',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the flagged audit failures were resolved';
      return null;
    },
    async execute(action, result) {
      return { audit_failures_resolved: true, confirmed: true, note: result?.note || null };
    },
  },

  // ── Submit claim (Milestone B — HUMAN GATE, NO external call) ──
  // Confirm-only. Records submitted_at + the summed claim amount (from the agency's
  // rcm_records) onto the item and flips those rcm_records to status='submitted'.
  // Nothing is transmitted to any payer/clearinghouse — this is the human gate that
  // records the decision to submit.
  submit_claim: {
    key: 'submit_claim',
    label: 'Submit claim',
    inputs: ['confirmed', 'note'],
    validate(action, result) {
      if (!result || result.confirmed !== true) return 'Confirm the claim is reviewed and ready to submit';
      return null;
    },
    async execute(action, result, item) {
      const summary = await recordClaimSubmission(item);
      return {
        submitted: true,
        submitted_at: summary.submittedAt,
        claim_amount_cents: summary.amountCents,
        claim_amount_dollars: summary.amountCents != null ? summary.amountCents / 100 : null,
        record_count: summary.recordCount,
        note: result?.note || null,
        external_call: false,
      };
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

  // ── Daily Agency Intake -> RCM Pipeline ──
  agency_uploaded: { key: 'agency_uploaded', label: 'Agency uploaded today', negation: 'agency_not_uploaded', description: 'the agency uploaded documents for the day bucket' },
  agency_not_uploaded: { key: 'agency_not_uploaded', label: 'Agency has not uploaded', negation: 'agency_uploaded', description: 'no documents uploaded for the day bucket' },
  ai_service_failed: { key: 'ai_service_failed', label: 'AI service failed', negation: 'ai_service_ok', description: 'the AI CC-note / CPO service reported failures' },
  ai_service_ok: { key: 'ai_service_ok', label: 'AI service ok', negation: 'ai_service_failed', description: 'the AI service completed without failures' },
  audit_failed: { key: 'audit_failed', label: 'Audit failed', negation: 'audit_passed', description: 'one or more RCM records failed the audit rules' },
  audit_passed: { key: 'audit_passed', label: 'Audit passed', negation: 'audit_failed', description: 'all RCM records passed the audit rules' },

  // ── Post-model billing gates (Milestone A) ──
  episode_eligible: { key: 'episode_eligible', label: 'Episode eligible', negation: 'episode_not_eligible', description: 'signed 485 + valid F2F window (computeEpisodeAssessment)' },
  episode_not_eligible: { key: 'episode_not_eligible', label: 'Episode not eligible', negation: 'episode_eligible', description: 'missing 485 or a valid F2F window' },
  documents_exist: { key: 'documents_exist', label: '485 + F2F documents exist', negation: 'documents_missing', description: 'both a 485 and an F2F document are present on the episode' },
  documents_missing: { key: 'documents_missing', label: '485 / F2F documents missing', negation: 'documents_exist', description: 'a 485 or F2F document is missing' },
  patient_data_complete: { key: 'patient_data_complete', label: 'Patient data complete', negation: 'patient_data_incomplete', description: 'all required patient demographics are filled' },
  patient_data_incomplete: { key: 'patient_data_incomplete', label: 'Patient data incomplete', negation: 'patient_data_complete', description: 'one or more required patient demographics are missing' },
  signature_exists: { key: 'signature_exists', label: 'Physician signature exists', negation: 'signature_missing', description: 'every episode order is physician-signed' },
  signature_missing: { key: 'signature_missing', label: 'Physician signature missing', negation: 'signature_exists', description: 'one or more episode orders are unsigned' },

  // ── CCN + audit/submit tail (Milestone B) ──
  ccn_failed: { key: 'ccn_failed', label: 'CCN generation failed', negation: 'ccn_ok', description: 'the CCN service could not generate notes for one or more billable months (e.g. Gemini unavailable)' },
  ccn_ok: { key: 'ccn_ok', label: 'CCN generation ok', negation: 'ccn_failed', description: 'the CCN service generated notes (or had no billable months to generate)' },
  audit_pass_98: { key: 'audit_pass_98', label: 'Audit pass rate >= 98%', negation: 'audit_pass_below_98', description: 'the bounded audit/rework cycle reached passRate >= 0.98' },
  audit_pass_below_98: { key: 'audit_pass_below_98', label: 'Audit pass rate < 98%', negation: 'audit_pass_98', description: 'the bounded audit/rework cycle left passRate below 0.98' },
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
    const message = spec.validate ? await spec.validate(action, results[action.id], item) : null;
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
