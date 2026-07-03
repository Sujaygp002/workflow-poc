// Worker task detail view: context panel (taskDisplayPayload: patient/order/pdf)
// + per-action checklist with the right input per actionKey. Builder tasks render
// one input row per catalog action; legacy single-action system-workflow tasks
// ('legacy' actionKey) reuse the input panels the old WorkBucket page used.
// Completing submits payload.actionResults; a 400 keeps the task Processing and
// surfaces per-action inline errors. Done-bucket tasks render read-only.
import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
} from 'lucide-react';
import { formatUiDate, formatUiDateTime } from '../../lib/dateFormat';
import { completeDbWorkItem } from '../../lib/workflowApi';

// ── Ported from src/pages/workbucket/WorkBucket.jsx (legacy input panels) ─────

const FIELD_DEFS = {
  'patient.patient_info.name': { label: 'Patient name', section: 'patient', path: ['patient_info', 'name'] },
  'patient.patient_info.DOB': { label: 'DOB', section: 'patient', path: ['patient_info', 'DOB'] },
  'patient.admission_details.MRN': { label: 'MRN', section: 'patient', path: ['admission_details', 'MRN'] },
  'patient.patient_info.sex': { label: 'Sex', section: 'patient', path: ['patient_info', 'sex'] },
  'patient.personal_information.address.street': { label: 'Address', section: 'patient', path: ['personal_information', 'address', 'street'] },
  'patient.admission_details.PG.name': { label: 'Physician group', section: 'references', path: ['PG', 'name'] },
  'patient.admission_details.HHAH.name': { label: 'HHAH', section: 'references', path: ['HHAH', 'name'] },
  'patient.admission_details.SOC': { label: 'SOC', section: 'patient', path: ['admission_details', 'SOC'] },
  'patient.admission_details.EOC': { label: 'EOC', section: 'patient', path: ['admission_details', 'EOC'] },
  'patient.admission_details.SOE': { label: 'SOE', section: 'patient', path: ['admission_details', 'SOE'] },
  'patient.admission_details.EOE': { label: 'EOE', section: 'patient', path: ['admission_details', 'EOE'] },
  'order.order_info.order_number': { label: 'Order number', section: 'order', path: ['order_info', 'order_number'] },
  'order.order_info.order_type': { label: 'Order type', section: 'order', path: ['order_info', 'order_type'] },
  'order.order_info.order_date': { label: 'Order date', section: 'order', path: ['order_info', 'order_date'] },
  'order.order_admission_details.billing_provider.NPI': { label: 'Billing NPI', section: 'references', path: ['practitioner', 'NPI'] },
};

function getIn(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

function setIn(object, path, value) {
  const next = { ...(object || {}) };
  let cursor = next;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    cursor[key] = { ...(cursor[key] || {}) };
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
  return next;
}

function compactValue(value) {
  return value || <span className="text-rose-500 font-semibold">Missing</span>;
}

function buildInitialPatch(payload) {
  const refs = payload?.references || {};
  return {
    patient: {},
    order: {},
    references: {},
    practitioner: { ...(refs.practitioner || {}) },
    PG: { ...(refs.PG || {}) },
    HHAH: { ...(refs.HHAH || {}) },
  };
}

function payloadForSubmit(patch) {
  return {
    patient: patch.patient,
    order: patch.order,
    references: {
      ...patch.references,
      practitioner: patch.practitioner,
      PG: patch.PG,
      HHAH: patch.HHAH,
    },
    practitioner: patch.practitioner,
    PG: patch.PG,
    HHAH: patch.HHAH,
  };
}

// Object lifecycle chips (found/missing/created/updated/in-review), mirrors
// objectLifecycle() on the server.
function lifecycleFromDecisions(d = {}) {
  return {
    'Patient Unit': d.unit_exists ? 'found' : d.unit_not_exists ? 'created' : 'pending',
    'Patient Record': d.needs_manual_review ? 'in-review'
      : d.record_created ? 'created'
      : d.record_updated ? 'updated'
      : (d.patient_write_success || d.patient_retry_success) ? (d.patient_exists ? 'updated' : 'created')
      : d.patient_exists ? 'found' : d.patient_not_exists ? 'missing' : 'pending',
    'Admission Object': d.admission_created ? 'created' : d.admission_exists ? 'found' : d.admission_ready ? 'created' : 'pending',
    'Episode Object': d.episode_created ? 'created' : d.episode_exists ? 'found' : d.episode_ready ? 'created' : 'pending',
    Order: d.order_skipped_duplicate ? 'skipped'
      : (d.order_write_success || d.order_retry_success) ? 'created'
      : d.order_exists ? 'skipped' : d.order_not_exists ? 'missing' : 'pending',
  };
}

const LIFECYCLE_TONE = {
  found: 'bg-sky-50 text-sky-700 border-sky-200',
  created: 'bg-green-50 text-green-700 border-green-200',
  updated: 'bg-violet-50 text-violet-700 border-violet-200',
  missing: 'bg-rose-50 text-rose-700 border-rose-200',
  skipped: 'bg-slate-100 text-slate-500 border-slate-300',
  'in-review': 'bg-amber-50 text-amber-700 border-amber-200',
  pending: 'bg-slate-50 text-slate-400 border-slate-200',
};

function LifecycleStrip({ decisions }) {
  const lc = lifecycleFromDecisions(decisions);
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2.5 border-b border-slate-100 bg-slate-50/50">
      {Object.entries(lc).map(([obj, state]) => (
        <span key={obj} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${LIFECYCLE_TONE[state] || LIFECYCLE_TONE.pending}`}>
          {obj}: {state}
        </span>
      ))}
    </div>
  );
}

function RecordSummary({ payload }) {
  const patient = payload?.patient || {};
  const order = payload?.order || {};
  const refs = payload?.references || {};
  const missing = new Set(payload?.missingFields || []);

  const valueClass = (field) => (missing.has(field) ? 'text-rose-700 bg-rose-50 rounded px-1 font-bold' : 'text-slate-700');
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <LifecycleStrip decisions={payload?.decisions} />
      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <div className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-violet-600 mb-2">Patient</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <span className="text-slate-400">Name</span><span className={valueClass('patient.patient_info.name')}>{compactValue(patient.patient_info?.name)}</span>
            <span className="text-slate-400">DOB</span><span className={valueClass('patient.patient_info.DOB')}>{compactValue(patient.patient_info?.DOB)}</span>
            <span className="text-slate-400">MRN</span><span className={valueClass('patient.admission_details.MRN')}>{compactValue(patient.admission_details?.MRN)}</span>
            <span className="text-slate-400">Sex</span><span className={valueClass('patient.patient_info.sex')}>{compactValue(patient.patient_info?.sex)}</span>
            <span className="text-slate-400">Address</span><span className={valueClass('patient.personal_information.address.street')}>{compactValue(patient.personal_information?.address?.street)}</span>
            <span className="text-slate-400">PG</span><span className={valueClass('patient.admission_details.PG.name')}>{compactValue(refs.PG?.name)}</span>
            <span className="text-slate-400">HHAH</span><span className={valueClass('patient.admission_details.HHAH.name')}>{compactValue(refs.HHAH?.name)}</span>
          </div>
        </div>
        <div className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-rose-600 mb-2">Order</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <span className="text-slate-400">Order</span><span className={valueClass('order.order_info.order_number')}>{compactValue(order.order_info?.order_number)}</span>
            <span className="text-slate-400">Type</span><span className={valueClass('order.order_info.order_type')}>{compactValue(order.order_info?.order_type)}</span>
            <span className="text-slate-400">Date</span><span className={valueClass('order.order_info.order_date')}>{compactValue(order.order_info?.order_date)}</span>
            <span className="text-slate-400">SOC/EOC</span><span>{compactValue(order.order_admission_details?.SOC)} / {compactValue(order.order_admission_details?.EOC)}</span>
            <span className="text-slate-400">SOE/EOE</span><span>{compactValue(order.order_admission_details?.SOE)} / {compactValue(order.order_admission_details?.EOE)}</span>
            <span className="text-slate-400">NPI</span><span className={valueClass('order.order_admission_details.billing_provider.NPI')}>{compactValue(refs.practitioner?.NPI)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PdfPanel({ pdf }) {
  const pdfUrl = pdf?.blobUrl || pdf?.url;
  const isSigned = pdf?.signed === true;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden min-h-[620px]">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center gap-2">
        <FileText size={15} className="text-slate-400" />
        <span className="text-sm font-semibold text-slate-700">{pdf?.fileName || 'Order PDF'}</span>
        {(pdf?.fileName || pdfUrl) && (
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${isSigned ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            {isSigned ? 'signed' : 'unsigned'}
          </span>
        )}
      </div>
      {pdfUrl ? (
        <iframe title="Order PDF" src={pdfUrl} className="w-full h-[580px] bg-slate-50" />
      ) : (
        <div className="h-[580px] flex items-center justify-center text-center text-sm text-slate-400 p-6">
          No matched PDF URL was found. The PDF filename must match the order number.
        </div>
      )}
    </div>
  );
}

function MissingFieldsEditor({ patch, setPatch, missingFields }) {
  const fields = (missingFields || [])
    .map((field) => ({ field, def: FIELD_DEFS[field] }))
    .filter((entry) => entry.def);

  function updateMissing(def, value) {
    setPatch((current) => ({
      ...current,
      [def.section]: setIn(current[def.section], def.path, value),
    }));
  }

  if (!fields.length) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-500">
        No missing fields were reported for this task. Add notes or confirm the record after reviewing the PDF.
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wide text-rose-600 mb-2">Missing fields</div>
      <div className="grid md:grid-cols-2 gap-2">
        {fields.map(({ field, def }) => (
          <label key={field} className="block rounded-xl border border-rose-200 bg-rose-50/60 p-2">
            <span className="text-[11px] font-bold text-rose-700">{def.label}</span>
            <input
              value={getIn(patch[def.section], def.path) || ''}
              onChange={(event) => updateMissing(def, event.target.value)}
              className="mt-1 w-full rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-300"
              placeholder={field}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Legacy panel defaults (port of the WorkBucket per-taskKey panels) ────────

const LEGACY_EMAIL_TASKS = {
  'area.sendMissingUploadNotification': {
    tone: 'amber',
    banner: (payload) => {
      const name = payload?.references?.HHAH?.name || 'The HHAH';
      return `${name} has not uploaded within 24 hours. Send the missing-upload email below. The system will also post a notification to the HHAH login page.`;
    },
    defaults: (payload) => {
      const hhah = payload?.references?.HHAH || {};
      const name = hhah.name || 'the HHAH';
      return {
        to: hhah.contact_info?.email || '',
        subject: 'Missing daily intake upload',
        body: `Hi ${name},\n\nWe have not received your daily Excel + PDF ZIP upload within the 24-hour window. Please upload your documents as soon as possible.\n\nThank you.`,
      };
    },
    sendLabel: 'Send email & continue',
  },
  'billing.sendHhahMissingDocumentEmail': {
    tone: 'rose',
    banner: () => 'Patient is not eligible because required billing documents are missing or invalid.',
    defaults: (payload) => {
      const hhah = payload?.references?.HHAH || {};
      const missing = payload?.extraction?.missingDocuments || [];
      return {
        to: hhah.contact_info?.email || hhah.email || '',
        subject: 'Missing document required for billing',
        body: `Hi ${hhah.name || ''},\n\nPlease send the missing document(s): ${missing.join(', ') || '485/F2F document'}.\n\nThank you.`,
      };
    },
    sendLabel: 'Send email & continue',
  },
  'billing.sendPhysicianReminder': {
    tone: 'amber',
    banner: () => 'This episode is eligible, but it is not billable because physician signature is missing.',
    defaults: (payload) => {
      const practitioner = payload?.references?.practitioner || {};
      const unsigned = payload?.extraction?.unsignedOrderNumbers || [];
      return {
        to: practitioner.contact_info?.email || practitioner.email || '',
        subject: 'Signature required for CPO billing',
        body: `Hi,\n\nPlease sign the following order document(s): ${unsigned.join(', ') || 'unsigned orders'}.\n\nThank you.`,
      };
    },
    sendLabel: 'Send reminder & continue',
  },
};
// Signing overdue reminder reuses the physician-reminder panel (same as WorkBucket).
LEGACY_EMAIL_TASKS['signing.emailPhysicianReminder'] = LEGACY_EMAIL_TASKS['billing.sendPhysicianReminder'];

const EMAIL_TONE = {
  amber: { banner: 'border-amber-200 bg-amber-50 text-amber-800', ring: 'focus:ring-amber-300', button: 'bg-amber-600 hover:bg-amber-700' },
  rose: { banner: 'border-rose-200 bg-rose-50 text-rose-800', ring: 'focus:ring-rose-300', button: 'bg-rose-600 hover:bg-rose-700' },
  violet: { banner: 'border-violet-200 bg-violet-50 text-violet-800', ring: 'focus:ring-violet-300', button: 'bg-violet-600 hover:bg-violet-700' },
};

function EmailFields({ value, onChange, tone = 'violet' }) {
  const t = EMAIL_TONE[tone] || EMAIL_TONE.violet;
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">To</span>
        <input
          value={value.to || ''}
          onChange={(e) => onChange({ to: e.target.value })}
          placeholder="recipient email address"
          className={`mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 ${t.ring}`}
        />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Subject</span>
        <input
          value={value.subject || ''}
          onChange={(e) => onChange({ subject: e.target.value })}
          className={`mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 ${t.ring}`}
        />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Message</span>
        <textarea
          rows={6}
          value={value.body || ''}
          onChange={(e) => onChange({ body: e.target.value })}
          className={`mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 ${t.ring}`}
        />
      </label>
    </div>
  );
}

function CheckboxField({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked === true}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded accent-violet-600"
      />
      <span className="text-sm text-slate-700">{label}</span>
    </label>
  );
}

// ── Builder action inputs (one control set per catalog actionKey) ────────────

function interpolate(template, ctx) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (ctx[key] ? String(ctx[key]) : match));
}

function templateContext(payload) {
  return {
    orderNumber: payload?.order?.order_info?.order_number || '',
    patientName: payload?.patient?.patient_info?.name || '',
    pgName: payload?.pgName || payload?.references?.PG?.name || '',
    hhahName: payload?.hhahName || payload?.references?.HHAH?.name || '',
  };
}

function ymd(value) {
  const str = typeof value === 'string' ? value : '';
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : '';
}

function initialActionResult(action, payload) {
  const ctx = templateContext(payload);
  const refs = payload?.references || {};
  switch (action.actionKey) {
    case 'send_email_to_physician':
      return {
        to: refs.practitioner?.contact_info?.email || refs.practitioner?.email || '',
        subject: (action.params?.subjectTemplate && interpolate(action.params.subjectTemplate, ctx))
          || (ctx.orderNumber ? `Order ${ctx.orderNumber} ready for signature` : 'Order ready for signature'),
        body: `Hi,\n\nOrder ${ctx.orderNumber || ''} for ${ctx.patientName || 'the patient'} is ready for your signature.\n\nThank you.`,
        confirmed: false,
      };
    case 'send_email_to_hhah':
      return {
        to: refs.HHAH?.contact_info?.email || refs.HHAH?.email || '',
        subject: (action.params?.subjectTemplate && interpolate(action.params.subjectTemplate, ctx)) || 'Message from Command Center',
        body: `Hi ${ctx.hhahName || ''},\n\n\n\nThank you.`,
        confirmed: false,
      };
    case 'enter_admission_dates':
      return {
        SOC: ymd(payload?.patient?.admission_details?.SOC),
        EOC: ymd(payload?.patient?.admission_details?.EOC),
      };
    case 'enter_episode_dates':
      return {
        SOE: ymd(payload?.patient?.admission_details?.SOE),
        EOE: ymd(payload?.patient?.admission_details?.EOE),
      };
    case 'fill_missing_fields':
      return { patient: {}, order: {}, references: {} };
    case 'review_record':
      return { approved: false };
    case 'add_cpo_minutes':
      return { minutes: '30' };
    case 'confirm_checklist':
      return { confirmed: false };
    default:
      return {};
  }
}

function DateFields({ value, onChange, fields }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {fields.map((field) => (
        <label key={field.key} className="block rounded-xl border border-slate-200 bg-white p-2">
          <span className="text-[11px] font-bold text-slate-600">
            {field.label}
            {field.required && <span className="text-rose-500"> *</span>}
          </span>
          <input
            type="date"
            value={value[field.key] || ''}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-300"
          />
        </label>
      ))}
    </div>
  );
}

function BuilderActionInput({ action, value, onChange, payload }) {
  const merge = (patch) => onChange({ ...value, ...patch });
  switch (action.actionKey) {
    case 'send_email_to_physician':
    case 'send_email_to_hhah':
      return (
        <div className="space-y-3">
          <EmailFields value={value} onChange={merge} tone="violet" />
          <CheckboxField
            checked={value.confirmed}
            onChange={(checked) => merge({ confirmed: checked })}
            label="I reviewed this email — send it when the task completes"
          />
        </div>
      );
    case 'enter_admission_dates':
      return (
        <DateFields
          value={value}
          onChange={merge}
          fields={[
            { key: 'SOC', label: 'SOC (start of care)', required: true },
            { key: 'EOC', label: 'EOC (end of care)' },
          ]}
        />
      );
    case 'enter_episode_dates':
      return (
        <DateFields
          value={value}
          onChange={merge}
          fields={[
            { key: 'SOE', label: 'SOE (start of episode)', required: true },
            { key: 'EOE', label: 'EOE (end of episode)', required: true },
          ]}
        />
      );
    case 'fill_missing_fields':
      return (
        <MissingFieldsEditor
          patch={value}
          setPatch={(updater) => onChange(typeof updater === 'function' ? updater(value) : updater)}
          missingFields={payload?.missingFields || []}
        />
      );
    case 'review_record':
      return (
        <CheckboxField
          checked={value.approved}
          onChange={(checked) => merge({ approved: checked })}
          label="I reviewed this record and approve it"
        />
      );
    case 'add_cpo_minutes': {
      const cpoMonth = payload?.extraction?.cpoMonth;
      return (
        <div className="grid gap-2 md:grid-cols-2">
          {cpoMonth && (
            <div className="rounded-xl border border-slate-200 bg-white p-2">
              <div className="text-[11px] font-bold text-slate-600">CPO Month</div>
              <div className="mt-1 text-sm font-bold text-slate-800">{formatUiDate(cpoMonth)}</div>
            </div>
          )}
          <label className="block rounded-xl border border-slate-200 bg-white p-2">
            <span className="text-[11px] font-bold text-slate-600">CPO minutes (min 30)</span>
            <input
              type="number"
              min="30"
              value={value.minutes ?? ''}
              onChange={(e) => merge({ minutes: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-300"
            />
          </label>
        </div>
      );
    }
    case 'mark_order_sent': {
      const orderNumber = payload?.order?.order_info?.order_number;
      return (
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600">
          Marks order <span className="font-semibold text-slate-800">{orderNumber || '(linked order)'}</span> as sent to the physician when the task completes. No input needed.
        </div>
      );
    }
    default:
      return (
        <CheckboxField
          checked={value.confirmed}
          onChange={(checked) => merge({ confirmed: checked })}
          label="Done"
        />
      );
  }
}

// ── Read-only (Done bucket) rendering ────────────────────────────────────────

function OutputChips({ output }) {
  if (!output || typeof output !== 'object') return null;
  const entries = Object.entries(output).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v));
  if (!entries.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => (
        <span key={key} className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-slate-50 text-slate-500 border-slate-200">
          {key}: {Array.isArray(value) ? value.join(', ') || '—' : String(value ?? '—')}
        </span>
      ))}
    </div>
  );
}

function ReadOnlyActionRow({ action, index, state }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0">
          <CheckCircle2 size={13} />
        </span>
        <span className="text-sm font-semibold text-slate-700">{action.label || action.actionKey}</span>
        <span className="ml-auto text-[10px] font-bold uppercase tracking-wide text-slate-400">
          {action.actionKey === 'legacy' ? action.taskKey : action.actionKey} · #{index + 1}
        </span>
      </div>
      <OutputChips output={state} />
    </div>
  );
}

// ── Main detail view ─────────────────────────────────────────────────────────

export default function WorkerTaskDetail({ detail, onBack, onCompleted, onAuthExpired }) {
  const { task, payload, pdf } = detail;
  const actions = Array.isArray(detail.actions) ? detail.actions : [];
  const readOnly = detail.readOnly === true;
  const isLegacy = actions.length === 1 && actions[0]?.actionKey === 'legacy';
  const legacyEmailSpec = isLegacy ? LEGACY_EMAIL_TASKS[task.task_key] : null;
  const isLegacyCpo = isLegacy && task.task_key === 'billing.addCpoMinutes';

  const [results, setResults] = useState(() => Object.fromEntries(
    actions.map((action) => [action.id, initialActionResult(action, payload)]),
  ));
  const [legacyEmail, setLegacyEmail] = useState(() => (legacyEmailSpec ? legacyEmailSpec.defaults(payload) : { to: '', subject: '', body: '' }));
  const [legacyCpoMin, setLegacyCpoMin] = useState(() => {
    const captured = payload?.extraction?.cpoMin;
    return String(captured && captured >= 30 ? captured : 30);
  });
  const [patch, setPatch] = useState(() => buildInitialPatch(payload));
  const [notes, setNotes] = useState('');
  const [actionErrors, setActionErrors] = useState({});
  const [topError, setTopError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const hasRecordContext = !!(
    payload?.patient?.patient_info
    || payload?.order?.order_info
    || payload?.references?.PG
    || payload?.references?.HHAH
  );
  const hasPdf = !!(pdf && (pdf.fileName || pdf.blobUrl || pdf.url));
  // Legacy email/CPO panels render standalone (as WorkBucket did); everything
  // else shows the record context + PDF beside the checklist.
  const showRecordContext = hasRecordContext && !legacyEmailSpec && !isLegacyCpo;
  const showPdf = hasPdf && !legacyEmailSpec && !isLegacyCpo;

  function buildSubmit() {
    if (legacyEmailSpec) {
      return {
        notes: legacyEmail.body,
        payload: { recipient: legacyEmail.to, subject: legacyEmail.subject, notes: legacyEmail.body },
      };
    }
    if (isLegacyCpo) {
      return { notes, payload: { cpoMin: Number(legacyCpoMin) || 30 } };
    }
    if (isLegacy) {
      return { notes, payload: payloadForSubmit(patch) };
    }
    return { notes, payload: { actionResults: results } };
  }

  async function submit() {
    setSubmitting(true);
    setTopError('');
    setActionErrors({});
    try {
      const body = buildSubmit();
      const response = await completeDbWorkItem({
        runId: task.run_id,
        taskRunId: task.id,
        notes: body.notes || '',
        payload: body.payload,
      });
      onCompleted(response);
    } catch (error) {
      if (error.status === 401) {
        onAuthExpired?.();
        return;
      }
      if (error.status === 400 && error.actionErrors && Object.keys(error.actionErrors).length) {
        setActionErrors(error.actionErrors);
        setTopError('Some actions need attention — fix the highlighted items and try again.');
      } else {
        setTopError(error.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = readOnly
    ? <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-green-100 text-green-700">Done</span>
    : <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-sky-100 text-sky-700">Processing</span>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
          title="Back to buckets"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800 leading-tight">{task.name}</span>
            {statusBadge}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            {task.workflow_name || task.workflow_id}
            {readOnly
              ? (task.completed_at ? ` · completed ${formatUiDateTime(task.completed_at)}` : '')
              : (task.opened_at ? ` · opened ${formatUiDateTime(task.opened_at)}` : '')}
          </div>
        </div>
      </div>

      {topError && (
        <div className="flex items-start gap-2 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{topError}</span>
        </div>
      )}

      <div className={showPdf ? 'grid xl:grid-cols-[minmax(0,1fr)_520px] gap-4' : ''}>
        <div className="space-y-3">
          {showRecordContext && <RecordSummary payload={payload} />}

          {readOnly ? (
            <div className="space-y-2">
              {actions.map((action, index) => (
                <ReadOnlyActionRow
                  key={action.id}
                  action={action}
                  index={index}
                  state={detail.actionState?.[action.id] || (isLegacy ? task.output : null)}
                />
              ))}
              {task.notes && (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1">Notes</div>
                  <div className="text-sm text-slate-600 whitespace-pre-wrap">{task.notes}</div>
                </div>
              )}
            </div>
          ) : legacyEmailSpec ? (
            <div className="space-y-3">
              <div className={`rounded-xl border p-3 text-sm ${EMAIL_TONE[legacyEmailSpec.tone].banner}`}>
                {legacyEmailSpec.banner(payload)}
              </div>
              <EmailFields
                value={legacyEmail}
                onChange={(patchValue) => setLegacyEmail((current) => ({ ...current, ...patchValue }))}
                tone={legacyEmailSpec.tone}
              />
            </div>
          ) : isLegacyCpo ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
                Episode is billable, but this CPO month needs at least 30 captured minutes.
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400">CPO Month</div>
                  <div className="mt-1 font-bold text-slate-800">{formatUiDate(payload?.extraction?.cpoMonth)}</div>
                </div>
                <label className="block rounded-xl border border-slate-200 bg-white p-3">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">CPO minutes</span>
                  <input
                    type="number"
                    min="30"
                    value={legacyCpoMin}
                    onChange={(event) => setLegacyCpoMin(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-300"
                  />
                </label>
              </div>
            </div>
          ) : isLegacy ? (
            <MissingFieldsEditor patch={patch} setPatch={setPatch} missingFields={payload?.missingFields || []} />
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Actions to perform ({actions.length})
              </div>
              {actions.map((action, index) => (
                <div
                  key={action.id}
                  className={`rounded-xl border bg-white p-3 ${actionErrors[action.id] ? 'border-rose-300' : 'border-slate-200'}`}
                >
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="w-6 h-6 rounded-full bg-pink-100 text-pink-600 text-xs font-bold flex items-center justify-center shrink-0">
                      {index + 1}
                    </span>
                    <span className="text-sm font-semibold text-slate-700">{action.label || action.actionKey}</span>
                    <span className="ml-auto text-[10px] font-bold uppercase tracking-wide text-slate-400">{action.actionKey}</span>
                  </div>
                  <BuilderActionInput
                    action={action}
                    value={results[action.id] || {}}
                    onChange={(next) => setResults((current) => ({ ...current, [action.id]: next }))}
                    payload={payload}
                  />
                  {actionErrors[action.id] && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-rose-600">
                      <AlertCircle size={13} className="shrink-0" />
                      {actionErrors[action.id]}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!readOnly && !legacyEmailSpec && (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Notes</span>
              <textarea
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-white"
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Add review notes or values found in the PDF."
              />
            </label>
          )}

          {!readOnly && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={submit}
                disabled={submitting}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 transition-colors ${legacyEmailSpec ? EMAIL_TONE[legacyEmailSpec.tone].button : 'bg-green-600 hover:bg-green-700'}`}
              >
                {submitting
                  ? <Loader2 size={16} className="animate-spin" />
                  : legacyEmailSpec ? <Mail size={16} /> : <CheckCircle2 size={16} />}
                {submitting ? 'Saving...' : legacyEmailSpec ? legacyEmailSpec.sendLabel : 'Complete task'}
              </button>
              <button
                onClick={onBack}
                disabled={submitting}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Back to buckets
              </button>
              <span className="text-xs text-slate-400">Going back keeps this task in Processing.</span>
            </div>
          )}
        </div>

        {showPdf && <PdfPanel pdf={pdf} />}
      </div>
    </div>
  );
}
