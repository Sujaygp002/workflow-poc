// Worker task detail view. Each human task type gets a purpose-built layout:
//   extract & fill    → LHS the order document (PDF), RHS every field to create
//                       the patient + order (incl. CPO min / justification)
//   enter dates       → LHS the order document, RHS the date box
//   review record     → LHS the patient's orders to verify, RHS the full patient
//                       object module, plus a note + Review passed / Review failed
//                       (failed restarts the item from the top of the pipeline)
//   get missing docs  → same agency-outreach layout as the contact-agency task
//   get & fill data   → LHS patient module with missing fields highlighted,
//                       RHS the patient's orders
//   create CCN        → LHS the patient module (episode + existing CC notes),
//                       RHS the CCN form (note title / text / type / CPO min)
// Completing submits payload.actionResults; a 400 keeps the task Processing and
// surfaces per-action inline errors. Done-bucket tasks render read-only with
// plain-language outcome summaries (no raw key:value dumps).
import { useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { formatUiDate, formatUiDateTime } from '../../lib/dateFormat';
import { completeDbWorkItem } from '../../lib/workflowApi';
import PatientHierarchyView from '../../components/PatientHierarchyView';

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

const CCN_NOTE_TYPES = ['Preventive Care', 'Safety', 'Goals', 'Medications'];

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

function RecordSummary({ payload, patientOnly = false }) {
  const patient = payload?.patient || {};
  const order = payload?.order || {};
  const refs = payload?.references || {};
  const missing = new Set(payload?.missingFields || []);

  const valueClass = (field) => (missing.has(field) ? 'text-rose-700 bg-rose-50 rounded px-1 font-bold' : 'text-slate-700');
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <LifecycleStrip decisions={payload?.decisions} />
      <div className={patientOnly ? '' : 'grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100'}>
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
            {patientOnly && (
              <>
                <span className="text-slate-400">SOC/EOC</span><span className={valueClass('patient.admission_details.SOC')}>{compactValue(patient.admission_details?.SOC)} / {compactValue(patient.admission_details?.EOC)}</span>
                <span className="text-slate-400">SOE/EOE</span><span className={valueClass('patient.admission_details.SOE')}>{compactValue(patient.admission_details?.SOE)} / {compactValue(patient.admission_details?.EOE)}</span>
              </>
            )}
          </div>
        </div>
        {!patientOnly && (
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
        )}
      </div>
    </div>
  );
}

// Contact-agency tasks carry no patient/order — the PATIENT/ORDER missing grid
// and lifecycle chips are meaningless there. Show a compact agency context
// (name + contact email + why the task exists) instead.
const AGENCY_CONTACT_ACTION_KEYS = new Set(['call_agency', 'sms_agency', 'email_agency']);

function AgencyContactSummary({ payload, readOnly, reason }) {
  const hhah = payload?.references?.HHAH || {};
  const email = hhah.contact?.email || hhah.contact_info?.email || hhah.email || '';
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-1">Agency</div>
      <div className="text-sm font-bold text-slate-800">{hhah.name || 'Unknown agency'}</div>
      <div className="mt-0.5 text-xs text-slate-600">
        Contact email: {email ? <span className="font-semibold text-slate-800">{email}</span> : <span className="font-semibold text-rose-600">none on file</span>}
      </div>
      <div className="mt-1.5 text-xs font-semibold text-amber-800">
        {readOnly
          ? 'This contact task is settled — see the outreach results below.'
          : reason || 'No upload received today — reach out using the actions below.'}
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

// One of the patient's REAL DB orders (payload.patientOrders), incl. the new
// order-level CPO minutes + justification fields (order_status jsonb).
function DbOrderCard({ order }) {
  const status = order.order_status || {};
  const signed = status.SignedByPhysician_Status === true || status.SignedByPhysician_Status === 'true';
  const sent = status.SendToPhysician_Status === true || status.SendToPhysician_Status === 'true';
  return (
    <div className={`rounded-xl border p-3 ${signed ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-800">{order.order_number || 'No order number'}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${signed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {signed ? 'signed' : 'unsigned'}
        </span>
        {!signed && sent && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase bg-sky-100 text-sky-700">at physician portal</span>
        )}
        {order.pdf_blob_url && (
          <a
            href={order.pdf_blob_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            <FileText size={12} /> PDF
          </a>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {(order.document_type || order.order_type || 'No document type')} · {formatUiDate(order.order_date)}
        {signed && status.SignedByPhyscianDate ? ` · signed ${formatUiDate(status.SignedByPhyscianDate)}` : ''}
      </div>
      {(status.cpo_min || status.justification_title || status.justification_note) && (
        <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
          {status.cpo_min != null && status.cpo_min !== '' && (
            <div><span className="font-semibold">CPO minutes:</span> {status.cpo_min}</div>
          )}
          {status.justification_title && (
            <div><span className="font-semibold">Justification:</span> {status.justification_title}</div>
          )}
          {status.justification_note && (
            <div className="text-slate-500">{status.justification_note}</div>
          )}
        </div>
      )}
    </div>
  );
}

// "The order/s of that patient" — real DB orders when available, else the
// item's own order payload as a fallback card.
function OrdersPanel({ payload, title = 'Orders of this patient' }) {
  const orders = Array.isArray(payload?.patientOrders) ? payload.patientOrders : [];
  const itemOrder = payload?.order?.order_info || {};
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-rose-600 mb-2">
        {title} {orders.length ? `(${orders.length})` : ''}
      </div>
      {orders.length ? (
        <div className="space-y-2">
          {orders.map((order) => <DbOrderCard key={order.id} order={order} />)}
        </div>
      ) : itemOrder.order_number ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="text-sm font-bold text-slate-800">{itemOrder.order_number}</div>
          <div className="mt-0.5">{itemOrder.order_type || 'No order type'} · {itemOrder.order_date || 'no date'}</div>
          <div className="mt-1 text-slate-400">This row's order — it has not been written to the database yet.</div>
        </div>
      ) : (
        <div className="text-xs text-slate-400">No orders found for this patient yet.</div>
      )}
    </div>
  );
}

// "The total patient object module" — the same hierarchy module the portals
// use (unit → record → admission → episode → orders + CC notes), fed from the
// task's patientTree context.
function PatientModulePanel({ payload, hint }) {
  const tree = payload?.patientTree;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-violet-600 mb-2">Patient object module</div>
      {hint && <div className="mb-2 text-xs text-slate-500">{hint}</div>}
      {tree ? (
        <PatientHierarchyView tree={tree} />
      ) : (
        <div className="text-xs text-slate-400">
          The patient module is not available yet — the patient has not been written to the database.
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

// ── Full create-patient/order form (extract & fill task, RHS) ────────────────

const FULL_FORM_SECTIONS = [
  {
    title: 'Patient',
    tone: 'text-violet-600',
    fields: [
      { label: 'Patient name', section: 'patient', path: ['patient_info', 'name'], missKey: 'patient.patient_info.name' },
      { label: 'DOB', type: 'date', section: 'patient', path: ['patient_info', 'DOB'], missKey: 'patient.patient_info.DOB' },
      { label: 'MRN', section: 'patient', path: ['admission_details', 'MRN'], missKey: 'patient.admission_details.MRN' },
      { label: 'Sex', type: 'select', options: ['', 'M', 'F'], section: 'patient', path: ['patient_info', 'sex'], missKey: 'patient.patient_info.sex' },
      { label: 'Address', section: 'patient', path: ['personal_information', 'address', 'street'], missKey: 'patient.personal_information.address.street', span: true },
      { label: 'Physician group (PG)', section: 'references', path: ['PG', 'name'], missKey: 'patient.admission_details.PG.name' },
      { label: 'Agency (HHAH)', section: 'references', path: ['HHAH', 'name'], missKey: 'patient.admission_details.HHAH.name', sessionLock: true },
    ],
  },
  {
    title: 'Admission & episode dates',
    tone: 'text-sky-600',
    fields: [
      { label: 'SOC (start of care)', type: 'date', section: 'patient', path: ['admission_details', 'SOC'], missKey: 'patient.admission_details.SOC' },
      { label: 'EOC (end of care)', type: 'date', section: 'patient', path: ['admission_details', 'EOC'], missKey: 'patient.admission_details.EOC' },
      { label: 'SOE (start of episode)', type: 'date', section: 'patient', path: ['admission_details', 'SOE'], missKey: 'patient.admission_details.SOE' },
      { label: 'EOE (end of episode)', type: 'date', section: 'patient', path: ['admission_details', 'EOE'], missKey: 'patient.admission_details.EOE' },
    ],
  },
  {
    title: 'Order',
    tone: 'text-rose-600',
    fields: [
      { label: 'Order number', section: 'order', path: ['order_info', 'order_number'], missKey: 'order.order_info.order_number' },
      { label: 'Order type', section: 'order', path: ['order_info', 'order_type'], missKey: 'order.order_info.order_type' },
      { label: 'Order date', type: 'date', section: 'order', path: ['order_info', 'order_date'], missKey: 'order.order_info.order_date' },
      { label: 'Billing NPI', section: 'references', path: ['practitioner', 'NPI'], missKey: 'order.order_admission_details.billing_provider.NPI' },
      { label: 'CPO minutes', type: 'number', section: 'order', path: ['order_status', 'cpo_min'] },
      { label: 'Justification title', section: 'order', path: ['order_status', 'justification_title'] },
      { label: 'Justification note', type: 'textarea', section: 'order', path: ['order_status', 'justification_note'], span: true },
    ],
  },
];

function initFullForm(payload) {
  const source = {
    patient: payload?.patient || {},
    order: payload?.order || {},
    references: payload?.references || {},
  };
  let form = { patient: {}, order: {}, references: {} };
  for (const section of FULL_FORM_SECTIONS) {
    for (const field of section.fields) {
      const raw = getIn(source[field.section], field.path);
      const value = field.type === 'date' ? ymd(raw) : (raw ?? '');
      form = { ...form, [field.section]: setIn(form[field.section], field.path, value) };
    }
  }
  return form;
}

function FullPatientOrderForm({ value, onChange, payload }) {
  const missing = new Set(payload?.missingFields || []);
  function update(field, nextValue) {
    onChange({ ...value, [field.section]: setIn(value[field.section], field.path, nextValue) });
  }
  return (
    <div className="space-y-3">
      {FULL_FORM_SECTIONS.map((section) => (
        <div key={section.title} className="rounded-xl border border-slate-200 bg-white p-3">
          <div className={`text-[11px] font-bold uppercase tracking-wide mb-2 ${section.tone}`}>{section.title}</div>
          <div className="grid gap-2 md:grid-cols-2">
            {section.fields.map((field) => {
              // The upload session's agency is authoritative (session_agency
              // invariant) — never editable from a worker task.
              const locked = field.sessionLock
                && payload?.references?.HHAH?.data_tags?.source === 'session_agency';
              const isMissing = !locked && field.missKey && missing.has(field.missKey);
              const current = getIn(value[field.section], field.path) ?? '';
              const wrapperClass = `block rounded-xl border p-2 ${field.span ? 'md:col-span-2' : ''} ${isMissing ? 'border-rose-300 bg-rose-50/60' : 'border-slate-200 bg-white'}`;
              const inputClass = `mt-1 w-full rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2 ${isMissing ? 'border-rose-200 focus:ring-rose-300' : 'border-slate-200 focus:ring-violet-300'}`;
              if (locked) {
                return (
                  <div key={field.label} className={`rounded-xl border border-slate-200 bg-slate-50 p-2 ${field.span ? 'md:col-span-2' : ''}`}>
                    <span className="text-[11px] font-bold text-slate-500">{field.label}</span>
                    <div className="mt-1 px-2 py-1.5 text-sm text-slate-700">{current || '—'}</div>
                    <span className="text-[10px] text-slate-400">Set by the uploading agency's login — not editable.</span>
                  </div>
                );
              }
              return (
                <label key={field.label} className={wrapperClass}>
                  <span className={`text-[11px] font-bold ${isMissing ? 'text-rose-700' : 'text-slate-600'}`}>
                    {field.label}{isMissing && <span className="ml-1 text-rose-500">(missing)</span>}
                  </span>
                  {field.type === 'select' ? (
                    <select value={current} onChange={(e) => update(field, e.target.value)} className={inputClass}>
                      {field.options.map((option) => <option key={option} value={option}>{option || '—'}</option>)}
                    </select>
                  ) : field.type === 'textarea' ? (
                    <textarea rows={2} value={current} onChange={(e) => update(field, e.target.value)} className={`${inputClass} resize-none`} />
                  ) : (
                    <input
                      type={field.type || 'text'}
                      value={current}
                      onChange={(e) => update(field, e.target.value)}
                      className={inputClass}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── CCN form (Create CCN task) ────────────────────────────────────────────────

function CcnFormFields({ value, onChange }) {
  const merge = (patch) => onChange({ ...value, ...patch });
  const inputClass = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-300';
  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block rounded-xl border border-slate-200 bg-white p-2 md:col-span-2">
          <span className="text-[11px] font-bold text-slate-600">Note title <span className="text-rose-500">*</span></span>
          <input value={value.noteTitle || ''} onChange={(e) => merge({ noteTitle: e.target.value })} className={inputClass} placeholder="5–10 words summarizing the clinical focus" />
        </label>
        <label className="block rounded-xl border border-slate-200 bg-white p-2">
          <span className="text-[11px] font-bold text-slate-600">Note type <span className="text-rose-500">*</span></span>
          <select value={value.noteType || CCN_NOTE_TYPES[0]} onChange={(e) => merge({ noteType: e.target.value })} className={inputClass}>
            {CCN_NOTE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="block rounded-xl border border-slate-200 bg-white p-2">
          <span className="text-[11px] font-bold text-slate-600">CPO minutes <span className="text-rose-500">*</span></span>
          <input type="number" min="1" value={value.cpoMin ?? ''} onChange={(e) => merge({ cpoMin: e.target.value })} className={inputClass} />
        </label>
        <label className="block rounded-xl border border-slate-200 bg-white p-2 md:col-span-2">
          <span className="text-[11px] font-bold text-slate-600">CPO month</span>
          <input type="month" value={value.month || ''} onChange={(e) => merge({ month: e.target.value })} className={inputClass} />
          <span className="mt-1 block text-[11px] text-slate-400">Leave empty to use the episode's start month.</span>
        </label>
      </div>
      <label className="block rounded-xl border border-slate-200 bg-white p-2">
        <span className="text-[11px] font-bold text-slate-600">Note text <span className="text-rose-500">*</span></span>
        <textarea
          rows={6}
          value={value.noteText || ''}
          onChange={(e) => merge({ noteText: e.target.value })}
          className={`${inputClass} resize-none`}
          placeholder="Single-paragraph physician chart note (max ~1100 chars). No PII."
        />
      </label>
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
        body: `Hi ${hhah.name || ''},\n\nPlease send the missing document(s): ${missing.join(', ') || '485 document'}.\n\nThank you.`,
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

function initialActionResult(action, payload, taskKind) {
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
    case 'email_agency':
      return {
        to: refs.HHAH?.contact?.email || refs.HHAH?.contact_info?.email || refs.HHAH?.email || '',
        subject: 'Please upload your daily documents',
        body: `Hi ${ctx.hhahName || 'team'},\n\nWe have not received your document upload for today. Please upload your workbook and order PDFs as soon as possible.\n\nThank you.`,
        confirmed: false,
      };
    case 'call_agency':
    case 'sms_agency':
      return { confirmed: false };
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
      return taskKind === 'extract' ? initFullForm(payload) : { patient: {}, order: {}, references: {} };
    case 'review_record':
      return { outcome: null, note: '' };
    case 'create_ccn_manually':
      return {
        noteTitle: '',
        noteText: '',
        noteType: CCN_NOTE_TYPES[0],
        cpoMin: '30',
        month: String(payload?.extraction?.dayBucket || '').slice(0, 7),
      };
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

function BuilderActionInput({ action, value, onChange, payload, taskKind }) {
  const merge = (patch) => onChange({ ...value, ...patch });
  switch (action.actionKey) {
    case 'send_email_to_physician':
    case 'send_email_to_hhah':
    case 'email_agency':
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
    case 'call_agency':
    case 'sms_agency': {
      const channel = action.actionKey === 'call_agency' ? 'Calling' : 'Texting';
      return (
        <div className="space-y-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {channel} from Command Center is <span className="font-bold">coming soon</span> — no live integration yet. Reach out manually and confirm below.
          </div>
          <CheckboxField
            checked={value.confirmed}
            onChange={(checked) => merge({ confirmed: checked })}
            label={action.actionKey === 'call_agency' ? 'I called the agency' : 'I texted the agency'}
          />
        </div>
      );
    }
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
      if (taskKind === 'extract') {
        return <FullPatientOrderForm value={value} onChange={onChange} payload={payload} />;
      }
      return (
        <MissingFieldsEditor
          patch={value}
          setPatch={(updater) => onChange(typeof updater === 'function' ? updater(value) : updater)}
          missingFields={payload?.missingFields || []}
        />
      );
    case 'create_ccn_manually':
      return <CcnFormFields value={value} onChange={onChange} />;
    case 'confirm_order_document':
      return (
        <CheckboxField
          checked={value.confirmed}
          onChange={(checked) => merge({ confirmed: checked })}
          label="I confirmed this document belongs to this order"
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

// ── Read-only (Done bucket) rendering — plain-language outcomes ──────────────

function friendlyReason(reason) {
  const map = {
    twilio_not_configured: 'phone/SMS integration is not configured',
    smtp_not_configured: 'email (SMTP) is not configured',
    smtp_failed: 'the email server rejected the send',
    no_recipient: 'no phone number is on file for the agency',
  };
  return map[reason] || String(reason).replaceAll('_', ' ');
}

function humanizeKey(key) {
  return String(key).replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

// Turn an action's raw output object into plain sentences a coordinator can
// read — never a raw key:value / JSON dump.
function describeActionOutput(output) {
  if (!output || typeof output !== 'object') return [];
  const lines = [];
  if (output.review === 'passed') lines.push({ tone: 'ok', text: 'Review passed — record approved.' });
  if (output.review === 'failed') lines.push({ tone: 'warn', text: 'Review failed — the item restarted from the top of the pipeline.' });
  if (output.reviewed === true && !output.review) lines.push({ tone: 'ok', text: 'Record reviewed and approved.' });
  if (output.ccn_created) {
    lines.push({
      tone: 'ok',
      text: `CC note "${output.noteTitle}" (${output.noteType}) saved — ${output.cpoMinutes} CPO min in ${formatUiDate(output.cpo_month)}; month now has ${output.cpo_month_total_min} min (${String(output.cpo_month_status || '').replaceAll('_', ' ')}).`,
    });
  }
  if (output.ccn_created_manually) lines.push({ tone: 'ok', text: 'CCN notes confirmed as manually handled.' });
  if (output.submitted) {
    const dollars = output.claim_amount_cents != null ? `$${(output.claim_amount_cents / 100).toFixed(2)}` : 'the claim amount';
    lines.push({ tone: 'ok', text: `Claim submitted — ${dollars} across ${output.record_count ?? '?'} record(s). Nothing was transmitted externally.` });
  }
  if (output.email_sent === true) lines.push({ tone: 'ok', text: 'Email sent successfully.' });
  if (output.email_sent === false) lines.push({ tone: 'warn', text: `Email was NOT sent — ${friendlyReason(output.email_reason || 'send failed')}.` });
  if (output.channel === 'call' || output.channel === 'sms') {
    const verb = output.channel === 'call' ? 'Call' : 'Text';
    if (output.channel_sent) lines.push({ tone: 'ok', text: `${verb} placed to the agency.` });
    else lines.push({ tone: 'warn', text: `${verb} confirmed manually — ${friendlyReason(output.channel_reason || 'not sent automatically')}.` });
  }
  if (output.SOC) lines.push({ tone: 'ok', text: `Admission dates saved — SOC ${formatUiDate(output.SOC)}${output.EOC ? `, EOC ${formatUiDate(output.EOC)}` : ''}.` });
  if (output.SOE) lines.push({ tone: 'ok', text: `Episode dates saved — SOE ${formatUiDate(output.SOE)} to EOE ${formatUiDate(output.EOE)}.` });
  if (output.filled) lines.push({ tone: 'ok', text: 'The entered values were saved onto the record.' });
  if (output.marked || output.marked_sent_to_physician_portal) lines.push({ tone: 'ok', text: 'Order marked sent to the physician portal — it can be signed at /pg-login.' });
  if (typeof output.sent_to_physician_portal === 'number') {
    lines.push({ tone: 'ok', text: `${output.sent_to_physician_portal} order(s) sent to the physician portal (${(output.orderNumbers || []).join(', ') || 'none unsigned'}).` });
  }
  if (output.confirmed === true && !lines.length) lines.push({ tone: 'ok', text: 'Confirmed.' });
  if (output.done === true && !lines.length) lines.push({ tone: 'ok', text: 'Done.' });
  if (output.note) lines.push({ tone: 'muted', text: `Note: ${output.note}` });
  if (!lines.length) {
    for (const [key, value] of Object.entries(output)) {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        lines.push({ tone: 'muted', text: `${humanizeKey(key)}: ${String(value ?? '—')}` });
      }
    }
  }
  return lines;
}

const OUTCOME_TONE = {
  ok: 'text-slate-600',
  warn: 'text-amber-700',
  muted: 'text-slate-400',
};

function ActionOutcome({ output }) {
  const lines = describeActionOutput(output);
  if (!lines.length) return null;
  return (
    <div className="mt-2 space-y-1">
      {lines.map((line, index) => (
        <div key={index} className={`flex items-start gap-1.5 text-xs ${OUTCOME_TONE[line.tone] || OUTCOME_TONE.ok}`}>
          {line.tone === 'warn'
            ? <AlertCircle size={13} className="mt-0.5 shrink-0 text-amber-500" />
            : <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />}
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function ReadOnlyActionRow({ action, state }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center shrink-0">
          <CheckCircle2 size={13} />
        </span>
        <span className="text-sm font-semibold text-slate-700">{action.label || humanizeKey(action.actionKey)}</span>
      </div>
      <ActionOutcome output={state} />
    </div>
  );
}

// ── Task-kind detection (drives the per-type layout) ─────────────────────────

function detectTaskKind(task, actions) {
  const keys = new Set(actions.map((action) => action.actionKey));
  if (actions.length && actions.every((action) => AGENCY_CONTACT_ACTION_KEYS.has(action.actionKey))) return 'contact';
  if (keys.has('review_record')) return 'review';
  if (keys.has('create_ccn_manually')) return 'ccn';
  if (keys.has('submit_claim')) return 'claim';
  if (keys.has('enter_admission_dates')) return 'admission_dates';
  if (keys.has('enter_episode_dates')) return 'episode_dates';
  if (keys.has('fill_missing_fields') && task?.condition === 'patient_data_incomplete') return 'getfill';
  if (keys.has('fill_missing_fields')) return 'extract';
  return 'generic';
}

// ── Main detail view ─────────────────────────────────────────────────────────

export default function WorkerTaskDetail({ detail, onBack, onCompleted, onAuthExpired }) {
  const { task, payload, pdf } = detail;
  const actions = Array.isArray(detail.actions) ? detail.actions : [];
  const readOnly = detail.readOnly === true;
  const isLegacy = actions.length === 1 && actions[0]?.actionKey === 'legacy';
  const legacyEmailSpec = isLegacy ? LEGACY_EMAIL_TASKS[task.task_key] : null;
  const isLegacyCpo = isLegacy && task.task_key === 'billing.addCpoMinutes';
  const taskKind = isLegacy ? 'generic' : detectTaskKind(task, actions);

  const [results, setResults] = useState(() => Object.fromEntries(
    actions.map((action) => [action.id, initialActionResult(action, payload, taskKind)]),
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
  const isAgencyContact = taskKind === 'contact';
  const contactReason = task?.condition === 'documents_missing'
    ? 'The 485 document is missing for this patient — ask the agency to upload it.'
    : null;
  // Legacy email/CPO panels render standalone (as WorkBucket did).
  const showRecordContext = hasRecordContext && !legacyEmailSpec && !isLegacyCpo && !isAgencyContact;
  const showPdf = hasPdf && !legacyEmailSpec && !isLegacyCpo && !isAgencyContact;

  function buildSubmit(resultsOverride = null) {
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
    const finalResults = { ...(resultsOverride || results) };
    // Order-level CPO minutes travel as a number.
    for (const action of actions) {
      if (action.actionKey === 'fill_missing_fields' && taskKind === 'extract') {
        const entry = finalResults[action.id] || {};
        const cpoMin = entry.order?.order_status?.cpo_min;
        if (cpoMin !== undefined && cpoMin !== '' && cpoMin !== null) {
          finalResults[action.id] = {
            ...entry,
            order: setIn(entry.order, ['order_status', 'cpo_min'], Number(cpoMin)),
          };
        }
      }
    }
    return { notes, payload: { actionResults: finalResults } };
  }

  async function submit(resultsOverride = null) {
    setSubmitting(true);
    setTopError('');
    setActionErrors({});
    try {
      const body = buildSubmit(resultsOverride);
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

  // Review passed / failed buttons: fill the review action outcome (plus any
  // confirm-style companions) and submit in one click.
  async function submitReview(outcome) {
    if (outcome === 'failed' && !notes.trim()) {
      setTopError('Add a note explaining what failed before failing the review.');
      return;
    }
    const nextResults = { ...results };
    for (const action of actions) {
      if (action.actionKey === 'review_record') nextResults[action.id] = { outcome, note: notes.trim() };
      else if (action.actionKey === 'confirm_checklist') nextResults[action.id] = { confirmed: true };
    }
    setResults(nextResults);
    await submit(nextResults);
  }

  const statusBadge = readOnly
    ? <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-green-100 text-green-700">Done</span>
    : <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-sky-100 text-sky-700">Processing</span>;

  const notesField = !readOnly && !legacyEmailSpec && (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Notes{taskKind === 'review' ? ' (required when the review fails)' : ''}</span>
      <textarea
        className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-white"
        rows={3}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder={taskKind === 'review' ? 'What did you verify? If the review fails, explain what is wrong.' : 'Add review notes or values found in the PDF.'}
      />
    </label>
  );

  const completeButtons = !readOnly && taskKind !== 'review' && (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => submit()}
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
  );

  const reviewButtons = !readOnly && taskKind === 'review' && (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => submitReview('passed')}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-green-600 hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <ThumbsUp size={16} />}
        Review passed
      </button>
      <button
        onClick={() => submitReview('failed')}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <ThumbsDown size={16} />}
        Review failed
      </button>
      <button
        onClick={onBack}
        disabled={submitting}
        className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        Back to buckets
      </button>
      <span className="text-xs text-slate-400">Review failed restarts this record from the top of the pipeline.</span>
    </div>
  );

  // The generic numbered action checklist (used standalone and inside the
  // per-kind right-hand columns).
  function renderChecklist(filterFn = null) {
    const visible = filterFn ? actions.filter(filterFn) : actions;
    if (!visible.length) return null;
    return (
      <div className="space-y-2">
        {visible.map((action, index) => (
          <div
            key={action.id}
            className={`rounded-xl border bg-white p-3 ${actionErrors[action.id] ? 'border-rose-300' : 'border-slate-200'}`}
          >
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="w-6 h-6 rounded-full bg-pink-100 text-pink-600 text-xs font-bold flex items-center justify-center shrink-0">
                {index + 1}
              </span>
              <span className="text-sm font-semibold text-slate-700">{action.label || humanizeKey(action.actionKey)}</span>
            </div>
            <BuilderActionInput
              action={action}
              value={results[action.id] || {}}
              onChange={(next) => setResults((current) => ({ ...current, [action.id]: next }))}
              payload={payload}
              taskKind={taskKind}
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
    );
  }

  function renderBody() {
    if (readOnly) {
      return (
        <div className="space-y-2">
          {actions.map((action) => (
            <ReadOnlyActionRow
              key={action.id}
              action={action}
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
      );
    }

    if (legacyEmailSpec) {
      return (
        <div className="space-y-3">
          <div className={`rounded-xl border p-3 text-sm ${EMAIL_TONE[legacyEmailSpec.tone].banner}`}>
            {legacyEmailSpec.banner(payload)}
          </div>
          <EmailFields
            value={legacyEmail}
            onChange={(patchValue) => setLegacyEmail((current) => ({ ...current, ...patchValue }))}
            tone={legacyEmailSpec.tone}
          />
          {completeButtons}
        </div>
      );
    }

    if (isLegacyCpo) {
      return (
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
          {notesField}
          {completeButtons}
        </div>
      );
    }

    if (isLegacy) {
      return (
        <div className={showPdf ? 'grid xl:grid-cols-[minmax(0,1fr)_520px] gap-4' : 'space-y-3'}>
          <div className="space-y-3">
            {showRecordContext && <RecordSummary payload={payload} />}
            <MissingFieldsEditor patch={patch} setPatch={setPatch} missingFields={payload?.missingFields || []} />
            {notesField}
            {completeButtons}
          </div>
          {showPdf && <PdfPanel pdf={pdf} />}
        </div>
      );
    }

    switch (taskKind) {
      case 'extract':
        // LHS: the order document. RHS: every field to create the patient + order.
        return (
          <div className="grid xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] gap-4 items-start">
            <div className="space-y-3">
              <PdfPanel pdf={pdf} />
              {renderChecklist((action) => action.actionKey === 'confirm_order_document')}
            </div>
            <div className="space-y-3">
              {showRecordContext && <LifecycleWrapper payload={payload} />}
              {renderChecklist((action) => action.actionKey !== 'confirm_order_document')}
              {notesField}
              {completeButtons}
            </div>
          </div>
        );

      case 'admission_dates':
      case 'episode_dates':
        // LHS: the order document. RHS: the date box.
        return (
          <div className="grid xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] gap-4 items-start">
            {hasPdf ? <PdfPanel pdf={pdf} /> : <OrdersPanel payload={payload} />}
            <div className="space-y-3">
              {showRecordContext && <RecordSummary payload={payload} />}
              {renderChecklist()}
              {notesField}
              {completeButtons}
            </div>
          </div>
        );

      case 'review':
        // LHS: the patient's orders to verify. RHS: the full patient object module.
        return (
          <div className="space-y-4">
            <div className="grid xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4 items-start">
              <div className="space-y-3">
                <OrdersPanel payload={payload} title="Verify against these orders" />
                {hasPdf && <PdfPanel pdf={pdf} />}
              </div>
              <PatientModulePanel
                payload={payload}
                hint="Verify every level of this record against the orders on the left, then pass or fail the review below."
              />
            </div>
            <div className="space-y-3">
              {notesField}
              {reviewButtons}
              {Object.values(actionErrors).length > 0 && (
                <div className="text-xs font-semibold text-rose-600">{Object.values(actionErrors).join(' · ')}</div>
              )}
            </div>
          </div>
        );

      case 'getfill':
        // LHS: patient module with missing fields highlighted. RHS: the patient's orders.
        return (
          <div className="grid xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-4 items-start">
            <div className="space-y-3">
              <RecordSummary payload={payload} patientOnly />
              {renderChecklist()}
              {notesField}
              {completeButtons}
            </div>
            <OrdersPanel payload={payload} />
          </div>
        );

      case 'ccn':
        // LHS: the patient module (episode + existing CC notes). RHS: the CCN form.
        return (
          <div className="grid xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4 items-start">
            <PatientModulePanel
              payload={payload}
              hint="The CCN is saved inside this episode's CPO month — existing CC notes appear in the module below."
            />
            <div className="space-y-3">
              {renderChecklist()}
              {notesField}
              {completeButtons}
            </div>
          </div>
        );

      default:
        return (
          <div className={showPdf ? 'grid xl:grid-cols-[minmax(0,1fr)_520px] gap-4' : 'space-y-3'}>
            <div className="space-y-3">
              {isAgencyContact && <AgencyContactSummary payload={payload} readOnly={readOnly} reason={contactReason} />}
              {showRecordContext && <RecordSummary payload={payload} />}
              {renderChecklist()}
              {notesField}
              {completeButtons}
            </div>
            {showPdf && <PdfPanel pdf={pdf} />}
          </div>
        );
    }
  }

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
            {task.group_name && (
              <span className="font-semibold text-slate-400 leading-tight">TASK-{task.group_name} ›</span>
            )}
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

      {renderBody()}
    </div>
  );
}

// Small wrapper so the extract layout can show lifecycle chips without the
// full patient/order summary grid (the form itself replaces it).
function LifecycleWrapper({ payload }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <LifecycleStrip decisions={payload?.decisions} />
    </div>
  );
}
